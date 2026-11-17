// The Claude Code background sessions of `dial voice`: the list mapping, the announcements, the screen
// cleaning, the attach script and the reasons, all pure; and the manager that runs the four short `claude`
// calls (`--bg`, `agents`, `logs`, `stop`) and the terminal opener through `runChild`. Dial keeps no state
// of its own about sessions: the list is what `claude agents --json --all` prints, filtered by name.

import { join } from 'node:path'
import { SESSION_PREFIX, sessionName } from '../propose.mjs'
import { redact } from '../render.mjs'
import { runChild } from '../spawn.mjs'

/** How many characters of one screen line are kept. */
export const LOG_LINE_CHARS = 400

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const RUNNING = new Set(['working', 'blocked'])
const AGENTS_ARGS = ['agents', '--json', '--all']
const NOT_A_LIST = 'claude agents did not print a session list'

const firstLine = text =>
  String(text ?? '')
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '') ?? null

/**
 * The entries of what `claude agents --json` printed.
 * @param {string} stdout
 * @returns {{ ok: true, entries: object[] } | { ok: false, reason: string }}
 */
export function parseAgents(stdout) {
  let parsed
  try {
    parsed = JSON.parse(String(stdout ?? ''))
  } catch {
    return { ok: false, reason: NOT_A_LIST }
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: NOT_A_LIST }
  return { ok: true, entries: parsed }
}

// The repo whose path equals or contains `cwd`, the longest match; null for none.
function repoOf(cwd, repos) {
  if (typeof cwd !== 'string' || cwd === '') return null
  let best = null
  for (const repo of repos ?? []) {
    if (!repo || typeof repo.path !== 'string' || repo.path === '') continue
    const path = repo.path.length > 1 ? repo.path.replace(/\/+$/, '') : repo.path
    const inside = cwd === path || cwd.startsWith(path.endsWith('/') ? path : `${path}/`)
    if (inside && (best === null || path.length > best.length)) best = { name: repo.name, length: path.length }
  }
  return best ? best.name : null
}

const isoTime = value => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * The sessions Dial named, newest first, cut to `rows` (every one when `rows` is not given).
 * @param {unknown[]} entries
 * @param {{ repos: { name: string, path: string }[], rows: number }} opts
 * @returns {{ id: string, repo: string|null, cwd: string|null, state: string, waitingFor: string|null, startedAt: string|null, prompt: string, sessionId: string|null }[]}
 */
export function listSessions(entries, { repos, rows }) {
  const out = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.kind !== 'background') continue
    if (typeof entry.id !== 'string' || !SAFE_ID.test(entry.id)) continue
    if (typeof entry.name !== 'string' || !entry.name.startsWith(SESSION_PREFIX)) continue
    const cwd = typeof entry.cwd === 'string' ? entry.cwd : null
    out.push({
      id: entry.id,
      repo: repoOf(cwd, repos),
      cwd,
      state: typeof entry.state === 'string' && entry.state !== '' ? entry.state : 'unknown',
      waitingFor: typeof entry.waitingFor === 'string' && entry.waitingFor !== '' ? redact(entry.waitingFor) : null,
      startedAt: isoTime(entry.startedAt),
      prompt: redact(entry.name.slice(SESSION_PREFIX.length)),
      sessionId: typeof entry.sessionId === 'string' && entry.sessionId !== '' ? entry.sessionId : null,
      at: typeof entry.startedAt === 'number' && Number.isFinite(entry.startedAt) ? entry.startedAt : null
    })
  }
  // Newest first, a session with no start time last; the sort is stable for equal times.
  out.sort((a, b) => (a.at === null ? (b.at === null ? 0 : 1) : b.at === null ? -1 : b.at - a.at))
  const limit = Number.isInteger(rows) && rows >= 0 ? rows : out.length
  return out.slice(0, limit).map(({ at, ...session }) => session)
}

/** How many sessions are `working` or `blocked`. */
export function countRunning(sessions) {
  return (sessions ?? []).filter(s => RUNNING.has(s?.state)).length
}

/** Whether a session in `repo` is `working` or `blocked`. */
export function runningIn(sessions, repo) {
  return (sessions ?? []).some(s => s?.repo === repo && RUNNING.has(s?.state))
}

/**
 * The notices for the sessions that became `blocked`, `done` or `failed` since `before`. The first list of
 * a run (`before` null) announces nothing.
 * @returns {string[]}
 */
export function announcements(before, after) {
  if (before === null || before === undefined) return []
  const was = new Map(before.map(s => [s.id, s.state]))
  const out = []
  for (const s of after ?? []) {
    if (was.get(s.id) === s.state) continue
    const who = s.repo ? `The session in ${s.repo}` : 'A Dial session'
    if (s.state === 'blocked') out.push(s.waitingFor ? `${who} needs you: ${s.waitingFor}.` : `${who} needs you.`)
    else if (s.state === 'done') out.push(`${who} has finished its turn.`)
    else if (s.state === 'failed') out.push(`${who} failed.`)
  }
  return out
}

// Terminal escape sequences, each also when it is cut off at the end: OSC (ended by BEL or ESC \), DCS, SOS,
// PM and APC strings, CSI (7-bit and the C1 form), and the two-character escapes.
const ESCAPES = new RegExp(
  [
    '\\u001b\\][^\\u0007\\u001b\\n]*(?:\\u0007|\\u001b\\\\)?',
    '\\u001b[PX^_][^\\u0007\\u001b\\n]*(?:\\u0007|\\u001b\\\\)?',
    '\\u001b\\[[\\u0030-\\u003f]*[\\u0020-\\u002f]*[\\u0040-\\u007e]?',
    '\\u009b[\\u0030-\\u003f]*[\\u0020-\\u002f]*[\\u0040-\\u007e]?',
    '\\u001b[\\u0020-\\u002f]*[\\u0030-\\u007e]?'
  ].join('|'),
  'g'
)
// Every control character but the tab (the line feed is split on first).
const CONTROLS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g

/**
 * A screen snapshot as text lines: escape sequences and control characters removed, each line redacted and
 * cut to LOG_LINE_CHARS, trailing blank lines dropped, and only the last `lines` kept.
 * @param {string} text
 * @param {{ lines: number }} opts
 * @returns {string[]}
 */
export function screenLines(text, { lines }) {
  const out = String(text ?? '')
    .replace(ESCAPES, '')
    .split('\n')
    .map(line => Array.from(redact(line.replace(CONTROLS, ''))).slice(0, LOG_LINE_CHARS).join(''))
  while (out.length > 0 && out.at(-1).trim() === '') out.pop()
  const keep = Number.isInteger(lines) && lines >= 0 ? lines : out.length
  return keep === 0 ? [] : out.slice(-keep)
}

const shellQuote = text => `'${String(text).replace(/'/g, "'\\''")}'`

/** The `.command` file that opens a terminal on `claude attach <id>`: two lines and a trailing newline. */
export function attachScript(claudePath, id) {
  return `#!/bin/sh\nexec ${shellQuote(claudePath)} attach ${id}\n`
}

/** The text of `dial sessions`: one line per session in the order given, or `no dial sessions`. */
export function formatSessions(sessions) {
  if (!sessions || sessions.length === 0) return 'no dial sessions\n'
  return sessions
    .map(s => {
      const state = s.waitingFor ? `${s.state} (${s.waitingFor})` : s.state
      return `${s.id}  ${s.repo ?? '-'}  ${state}  ${s.startedAt ?? '-'}  ${s.prompt}\n`
    })
    .join('')
}

/**
 * Why a `claude <what>` call failed, in claude's own words where it gave some.
 * @param {string} what  `--bg`, `agents`, `logs` or `stop`
 * @param {{ code: number|null, signal: string|null, stdout: string, stderr: string, missing: boolean, timedOut: boolean, error: object|null }} result
 * @param {number} seconds  the bound that applied
 */
export function callReason(what, result, seconds) {
  if (result?.timedOut) return `claude ${what} did not answer in ${seconds} seconds`
  if (result?.error) return `claude could not be started (${result.error.code ?? 'error'}: ${result.error.message ?? ''})`
  if (result?.missing) return 'claude could not be started (ENOENT: not found)'
  const how = Number.isInteger(result?.code) ? `exit ${result.code}` : result?.signal ? `signal ${result.signal}` : 'no exit code'
  const line = firstLine(result?.stderr) ?? firstLine(result?.stdout)
  return line === null ? `claude ${what} failed (${how})` : `claude ${what} failed (${how}): ${redact(line)}`
}

const refuse = (status, reason) => ({ status, body: { ok: false, reason } })

/**
 * The session manager. `repos()` gives `[{ name, path }]` and is asked at every read; `limits` holds
 * `voiceSessionPollSeconds`, `voiceSessionRows`, `voiceLogLines` and `subprocessTimeoutSeconds`;
 * `writeFile(path, text, { mode })` writes the attach file; `on(event)` gets `{ type: 'sessions', sessions }`,
 * `{ type: 'notice', text }` and `{ type: 'error', message }`.
 */
export function createSessions({ spawn, timers, env, limits, repos, claudePath, platform, tmpdir, writeFile, on = () => {} }) {
  const seconds = limits.subprocessTimeoutSeconds
  const timeoutMs = seconds * 1000
  const calls = new Set() // runs in flight: { kill, done }
  let list = []
  let all = [] // the list last read, not cut to voiceSessionRows: what the running-session guards count
  // Starts accepted and not yet seen by a list read that began after their `claude --bg` returned:
  // { repo, after } where `after` is the number of reads begun when it returned (null while it runs).
  const launches = new Set()
  let readsBegun = 0
  let lastSent = JSON.stringify([])
  let previous = null // the last list read, null before the first
  let failReported = false
  let reading = null
  let again = false // a fresh read was asked for while one ran
  let poll = null
  let shut = false

  const emit = event => {
    if (!shut) on(event)
  }

  const run = (file, args, cwd) => {
    const call = runChild(spawn, file, args, { cwd, env, timeoutMs, timers })
    calls.add(call)
    return call.done.then(result => {
      calls.delete(call)
      return result
    })
  }

  const readOnce = async () => {
    const number = ++readsBegun
    const result = await run(claudePath, AGENTS_ARGS)
    if (shut) return
    let reason = null
    let entries = null
    if (!result.ok) reason = callReason('agents', result, seconds)
    else {
      const parsed = parseAgents(result.stdout)
      if (parsed.ok) entries = parsed.entries
      else reason = parsed.reason
    }
    if (reason !== null) {
      if (!failReported) emit({ type: 'error', message: `could not list sessions: ${reason}` })
      failReported = true
      return
    }
    failReported = false
    let known = []
    try {
      known = repos?.() ?? []
    } catch {
      known = []
    }
    all = listSessions(entries, { repos: known })
    const rows = limits.voiceSessionRows
    const sessions = Number.isInteger(rows) && rows >= 0 ? all.slice(0, rows) : all
    // A start this read began after is in `all` now (or has ended): it no longer counts as a launch.
    for (const launch of launches) if (launch.after !== null && launch.after < number) launches.delete(launch)
    const notices = announcements(previous, sessions)
    previous = sessions
    list = sessions
    const text = JSON.stringify(sessions)
    if (text !== lastSent) {
      lastSent = text
      emit({ type: 'sessions', sessions })
    }
    for (const notice of notices) emit({ type: 'notice', text: notice })
  }

  // One read at a time: a read asked for while one runs is that read.
  const read = () => {
    if (shut) return Promise.resolve()
    if (reading) return reading
    reading = readOnce()
      .catch(() => {})
      .finally(() => {
        reading = null
        if (again && !shut) {
          again = false
          read()
        }
      })
    return reading
  }

  // A read that sees what a start or a stop just did: after the running one, when one runs.
  const refresh = () => {
    if (shut) return
    if (reading) again = true
    else read()
  }

  const watch = on => {
    if (shut) return
    if (on) {
      if (poll !== null) return
      poll = timers.setInterval(() => {
        if (!reading) read()
      }, limits.voiceSessionPollSeconds * 1000)
      poll?.unref?.()
      read()
    } else if (poll !== null) {
      timers.clearInterval(poll)
      poll = null
    }
  }

  const listed = id => typeof id === 'string' && list.some(s => s.id === id)

  const start = async ({ repo, path, prompt }) => {
    if (shut) return { ok: false, reason: 'dial voice is closing' }
    // Counted as running in `repo` from now until a list read shows it, so a second confirmation in the
    // meantime cannot pass the cap or the one-per-repo rule.
    const launch = { repo, after: null }
    launches.add(launch)
    const result = await run(claudePath, ['--bg', '--name', sessionName(prompt), prompt], path)
    if (!result.ok) {
      launches.delete(launch)
      return { ok: false, reason: callReason('--bg', result, seconds) }
    }
    launch.after = readsBegun
    // The caller settles the proposal and raises `Started in <repo>.`; the list is read at once.
    refresh()
    return { ok: true }
  }

  const log = async id => {
    if (!listed(id)) return refuse(404, 'no such session')
    const result = await run(claudePath, ['logs', id])
    if (!result.ok) return refuse(502, callReason('logs', result, seconds))
    return { status: 200, body: { ok: true, id, lines: screenLines(result.stdout, { lines: limits.voiceLogLines }) } }
  }

  const stop = async id => {
    if (!listed(id)) return refuse(409, 'no such session')
    const result = await run(claudePath, ['stop', id])
    if (!result.ok) return refuse(502, callReason('stop', result, seconds))
    refresh()
    return { status: 200, body: { ok: true } }
  }

  const attach = async id => {
    if (!listed(id)) return refuse(409, 'no such session')
    if (platform !== 'darwin') return refuse(409, `run this in a terminal: claude attach ${id}`)
    const file = join(tmpdir, `dial-attach-${id}.command`)
    try {
      await writeFile(file, attachScript(claudePath, id), { mode: 0o700 })
    } catch (err) {
      return refuse(502, `could not write ${file} (${err?.code ?? 'error'}: ${err?.message ?? err})`)
    }
    const result = await run('open', [file])
    if (result.ok) return { status: 200, body: { ok: true } }
    let why
    if (result.timedOut) why = `open did not answer in ${seconds} seconds`
    else if (result.error) why = `${result.error.code ?? 'error'}: ${result.error.message ?? ''}`
    else why = firstLine(result.stderr) ?? (Number.isInteger(result.code) ? `exit ${result.code}` : `signal ${result.signal}`)
    return refuse(502, `could not open a terminal: ${why}`)
  }

  // End every call in flight and wait for it; a started session is never stopped.
  const shutdown = () => {
    if (!shut) {
      shut = true
      if (poll !== null) timers.clearInterval(poll)
      poll = null
    }
    const waits = [...calls].map(call => {
      call.kill()
      return call.done
    })
    return Promise.all(waits).then(() => {})
  }

  return {
    watch,
    read,
    start,
    log,
    stop,
    attach,
    shutdown,
    get list() {
      return list
    },
    /** What the running-session guards count: every session last read, uncut, and each start not yet listed as working. */
    get guarded() {
      return [...all, ...[...launches].map(launch => ({ id: null, repo: launch.repo, state: 'working' }))]
    }
  }
}
