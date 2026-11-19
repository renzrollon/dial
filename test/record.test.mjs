/**
 * `dial record` (specs/handoff-and-narrative, the record requirements; specs/dial-home,
 * "A writing command ensures the home before it writes anything else"): the hook
 * payload, sync then a conditional narrate, the 55-second deadline driven by an
 * injected clock, and exit 0 on every path.
 */
// Local times in these in-process tests are read in UTC, as the harness runs the CLI.
process.env.TZ = 'UTC'

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as narrateModule from '../lib/narrate.mjs'
import { NO_TIME } from '../lib/narrate.mjs'
import { callBudget, parsePayload, record, transcriptPath } from '../lib/record.mjs'
import { slugOf } from '../lib/sources/sessions.mjs'
import { BIN, fakeExec, fakeFetch, makeHome, makeRepo, makeVault, snapshotTree, tmp } from './helpers.mjs'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const FIVE = 'Done: a\nDecided: b\nNext: c\nBlocked: none\nOpen: none'
const reply = content => ({ status: 200, body: { choices: [{ message: { content } }] } })

/** A vault, a repo `katipon` with one active change `add-login`, a registry, a home, and a transcript starting 14:00Z. */
function setup({ notes = [] } = {}) {
  const root = tmp('record-')
  const vault = makeVault(join(root, 'personal'), notes)
  const repo = makeRepo(join(root, 'code', 'katipon'), { changes: { 'add-login': { tasks: { done: 0, total: 1 } } } })
  const registry = { dial_schema: 'dial.registry/1', vaults: { personal: vault }, repos: [{ path: repo, vault: 'personal', host: 'github' }], limits: {} }
  const home = makeHome({ registry })
  const userHome = join(root, 'user')
  mkdirSync(userHome)
  const transcript = join(root, 'session.jsonl')
  writeTranscript(transcript, '2026-11-10T14:00:00.000Z')
  return { root, vault, repo, registry, home, userHome, transcript, env: { HOME: userHome, DIAL_HOME: home } }
}

function writeTranscript(path, start) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, [
    { type: 'user', timestamp: start, message: { content: 'please wire the form' } },
    { type: 'assistant', timestamp: start, message: { id: 'm1', content: [{ type: 'text', text: 'wired' }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n')
}

const changeNote = entryHeading => ({
  path: 'Changes/katipon--add-login.md',
  frontmatter: 'type: change\nrepo: katipon\nchange: add-login\nstate: spec-draft',
  body: `\n## Next\n\n## Narrative\n\n${entryHeading}\nDone: earlier\n\n`,
})

/** A clock in milliseconds and a timer that fires at once, moving the clock by the bound it was given. */
function virtualTime(startMs = Date.parse('2026-11-10T16:00:00Z')) {
  let ms = startMs
  const bounds = []
  return {
    start: startMs,
    clock: () => ms,
    advance: by => { ms += by },
    bounds,
    setTimer: (fn, bound) => {
      bounds.push(bound)
      ms += bound
      return setTimeout(fn, 0)
    },
    clearTimer: clearTimeout,
  }
}

function runRecord(s, payload, extra = {}) {
  return record({
    event: 'SessionEnd', payload, registry: s.registry, env: s.env, home: s.home, now: new Date('2026-11-10T16:50:00Z'),
    exec: fakeExec({}), ...extra,
  })
}

/** Run the CLI with `input` piped to stdin. */
function runWithInput(args, env, input) {
  return new Promise(resolve => {
    const child = execFile(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: tmp('cli-home-'), TZ: 'UTC', ...env },
      timeout: 30_000,
    }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }))
    child.stdin.end(input)
  })
}

// --- the pieces -------------------------------------------------------------------

test('a payload is a JSON object; empty, malformed or non-object input is {}', () => {
  assert.deepEqual(parsePayload('{"cwd":"/x"}'), { cwd: '/x' })
  for (const bad of ['', '  ', '{nope', '[1]', 'null', '42']) assert.deepEqual(parsePayload(bad), {})
})

test('each call is bounded by the smaller of the timeout and the time left minus two seconds; none under five', () => {
  let now = 0
  const budget = callBudget({ clock: () => now, deadline: 55_000, limits: { narrateTimeoutSeconds: 30 } })
  assert.equal(budget(), 30_000)
  now = 40_000
  assert.equal(budget(), 13_000)
  now = 50_001
  assert.equal(budget(), null)
})

test('the transcript is transcript_path, else ~/.claude/projects/<slug>/<session_id>.jsonl', () => {
  assert.equal(transcriptPath({ transcript_path: '/t.jsonl', session_id: 'abc' }, '/r', { HOME: '/h' }), '/t.jsonl')
  assert.equal(transcriptPath({ session_id: 'abc' }, '/Users/caro/IdeaProjects/katipon', { HOME: '/h' }), '/h/.claude/projects/-Users-caro-IdeaProjects-katipon/abc.jsonl')
  assert.equal(transcriptPath({}, '/r', { HOME: '/h' }), null)
})

// --- the deadline -----------------------------------------------------------------

test('a slow primary leaves the fallback only the time left, and record ends inside the deadline', async () => {
  const s = setup()
  mkdirSync(join(s.userHome, '.pi', 'agent'), { recursive: true })
  writeFileSync(join(s.userHome, '.pi', 'agent', 'models.json'), JSON.stringify({ providers: { mtplx: { baseUrl: 'http://127.0.0.1:8000/v1', models: [{ id: 'm' }] } } }))
  const time = virtualTime()
  const sync = () => {
    time.advance(10_000)
    return { ok: true }
  }
  const fetch = fakeFetch(['hang', 'hang'])
  const r = await runRecord(s, { cwd: s.repo, transcript_path: s.transcript }, {
    sync, fetch, clock: time.clock, setTimer: time.setTimer, clearTimer: time.clearTimer, limits: { narrateTimeoutSeconds: 30, narrateTurns: 20 },
  })
  assert.equal(r.ok, true)
  assert.equal(r.narrated, false)
  assert.equal(fetch.calls.length, 2)
  assert.deepEqual(time.bounds, [30_000, 13_000])
  assert.ok(time.clock() - time.start <= 55_000, `ended ${time.clock() - time.start}ms after the start`)
  assert.equal(r.unobserved, 'http://127.0.0.1:11434/v1 timed out after 13s')
})

test('no model call when under five seconds remain, nothing written, no error', async () => {
  const s = setup()
  const time = virtualTime()
  const sync = () => {
    time.advance(52_000)
    return { ok: true }
  }
  const before = snapshotTree(s.vault)
  const fetch = fakeFetch([])
  const r = await runRecord(s, { cwd: s.repo, transcript_path: s.transcript }, { sync, fetch, clock: time.clock, setTimer: time.setTimer })
  assert.equal(fetch.calls.length, 0)
  assert.deepEqual(r, { ok: true, repo: 'katipon', synced: true, narrated: false, unobserved: NO_TIME })
  assert.deepEqual(snapshotTree(s.vault), before)
})

// --- sync, then narrate only when no handoff was written --------------------------

test('a session already handed off is synced and not narrated', async () => {
  const s = setup({ notes: [changeNote('### 2026-11-10 16:40 · /dial:handoff (claude)')] })
  const fetch = fakeFetch([])
  const r = await runRecord(s, { cwd: s.repo, transcript_path: s.transcript }, { fetch })
  assert.equal(r.ok, true)
  assert.equal(r.synced, true)
  assert.equal(r.narrated, false)
  assert.equal(fetch.calls.length, 0)
  assert.ok(existsSync(join(s.vault, 'Projects', 'katipon.md')), 'the sync wrote the repo note')
})

test('a session with no handoff since it began is synced, then narrated onto the attributed note', async () => {
  const s = setup({ notes: [changeNote('### 2026-11-09 10:00 · dial handoff')] })
  const fetch = fakeFetch([reply(FIVE)])
  const r = await runRecord(s, { cwd: join(s.repo), transcript_path: s.transcript }, { fetch })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.narrated, true)
  assert.equal(r.wikilink, '[[katipon--add-login]]')
  assert.equal(fetch.calls.length, 1)
  const text = readFileSync(join(s.vault, 'Changes', 'katipon--add-login.md'), 'utf8')
  assert.match(text, /## Narrative\n\n### 2026-11-10 16:50 · local model \(qwen3\.6\)\nDone: a\n/)
  assert.match(text, /### 2026-11-09 10:00 · dial handoff\nDone: earlier\n/)
})

test('without transcript_path the transcript is found from session_id under the cwd slug', async () => {
  const s = setup()
  writeTranscript(join(s.userHome, '.claude', 'projects', slugOf(s.repo), 'abc.jsonl'), '2026-11-10T14:00:00.000Z')
  const fetch = fakeFetch([reply(FIVE)])
  const r = await runRecord(s, { cwd: s.repo, session_id: 'abc' }, { fetch })
  assert.equal(r.narrated, true, JSON.stringify(r))
  assert.equal(fetch.calls.length, 1)
})

test('an unregistered cwd is silent and touches nothing', async () => {
  const s = setup()
  const before = { vault: snapshotTree(s.vault), home: snapshotTree(s.home) }
  const sync = () => assert.fail('no sync for an unregistered cwd')
  const r = await runRecord(s, { cwd: tmp('scratch-') }, { sync, fetch: fakeFetch([]) })
  assert.deepEqual(r, { ok: true, silent: true })
  assert.deepEqual({ vault: snapshotTree(s.vault), home: snapshotTree(s.home) }, before)
})

test('a failed sync is the one error and narrate is not run', async () => {
  const s = setup()
  s.registry.vaults.personal = join(s.root, 'gone')
  const fetch = fakeFetch([])
  const r = await runRecord(s, { cwd: s.repo, transcript_path: s.transcript }, { fetch })
  assert.equal(r.ok, false)
  assert.equal(r.error, `vault personal for katipon does not exist: ${join(s.root, 'gone')}`)
  assert.equal(fetch.calls.length, 0)
})

test('a bad event is refused in the result', async () => {
  const s = setup()
  assert.deepEqual(await record({ event: 'Stop', payload: {}, registry: s.registry }), { ok: false, error: 'record needs --event SessionEnd or PreCompact' })
})

// --- the command ------------------------------------------------------------------

test('record from an unregistered cwd prints nothing, exits 0 and creates no home', async () => {
  const home = join(tmp(), 'never-created')
  const r = await runWithInput(['record', '--event', 'SessionEnd'], { DIAL_HOME: home }, JSON.stringify({ cwd: tmp('scratch-') }))
  assert.deepEqual(r, { code: 0, stdout: '', stderr: '' })
  assert.ok(!existsSync(home))
})

test('record --event Stop is one stderr line and exit 0; so is empty stdin from a missing vault', async () => {
  const s = setup()
  const bad = await runWithInput(['record', '--event', 'Stop'], s.env, '')
  assert.deepEqual(bad, { code: 0, stdout: '', stderr: 'dial: record needs --event SessionEnd or PreCompact\n' })
  const registry = { ...s.registry, vaults: { personal: join(s.root, 'gone') } }
  writeFileSync(join(s.home, 'registry.json'), JSON.stringify(registry))
  const failed = await runWithInput(['record', '--event', 'PreCompact'], s.env, JSON.stringify({ cwd: s.repo }))
  assert.equal(failed.code, 0)
  assert.equal(failed.stdout, '')
  assert.equal(failed.stderr, `dial: vault personal for katipon does not exist: ${join(s.root, 'gone')}\n`)
})

test('record syncs a registered repo from the payload cwd and exits 0', async () => {
  const s = setup()
  const r = await runWithInput(['record', '--event', 'SessionEnd'], { ...s.env, DIAL_NOW: '2026-11-10T16:50:00Z' }, JSON.stringify({ cwd: s.repo }))
  assert.deepEqual(r, { code: 0, stdout: '', stderr: '' })
  assert.ok(existsSync(join(s.vault, 'Projects', 'katipon.md')))
  assert.ok(existsSync(join(s.home, 'logs', 'sync.jsonl')))
})

test('record with an unwritable home names the home on one stderr line, exits 0 and changes no vault file', { skip: isRoot ? 'root ignores mode bits' : false }, async () => {
  const s = setup()
  const before = snapshotTree(s.vault)
  chmodSync(s.home, 0o555)
  try {
    const r = await runWithInput(['record', '--event', 'SessionEnd'], s.env, JSON.stringify({ cwd: s.repo }))
    assert.equal(r.code, 0)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr.split('\n').length, 2, 'one line and its newline')
    assert.ok(r.stderr.startsWith('dial: dial home is not writable: '), r.stderr)
    assert.ok(r.stderr.includes(s.home))
  } finally {
    chmodSync(s.home, 0o755)
  }
  assert.deepEqual(snapshotTree(s.vault), before)
})

// --- the record log: one line per run (specs/handoff-and-narrative, "Record logs one line per run") -----------------

const logFile = s => join(s.home, 'logs', 'record.jsonl')
/** The record log's lines, parsed; `[]` when there is no log. */
const logLines = s => (existsSync(logFile(s)) ? readFileSync(logFile(s), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
const readLog = s => (existsSync(logFile(s)) ? readFileSync(logFile(s), 'utf8') : '')
const NOW_ISO = '2026-11-10T16:50:00.000Z'
const stubSync = () => ({ ok: true })

test('NO_TEXT_TURNS is the reason narrate gives for a transcript without text turns', () => {
  assert.equal(narrateModule.NO_TEXT_TURNS, 'transcript has no text turns')
})

test('a narrated session appends one line with the run, and leaves every earlier line as it was', async () => {
  const s = setup({ notes: [changeNote('### 2026-11-09 10:00 · dial handoff')] })
  mkdirSync(join(s.home, 'logs'))
  const earlier = '{"ts":"2026-11-09T09:00:00.000Z","event":"SessionEnd","repo":"katipon","session":"s0","synced":true,"narrated":false,"miss":false}\n'
  writeFileSync(logFile(s), earlier)
  const r = await runRecord(s, { cwd: s.repo, session_id: 's1', transcript_path: s.transcript }, { fetch: fakeFetch([reply(FIVE)]) })
  assert.equal(r.narrated, true, JSON.stringify(r))
  const text = readLog(s)
  assert.ok(text.startsWith(earlier), 'the earlier line is untouched')
  assert.deepEqual(logLines(s).slice(1), [{ ts: NOW_ISO, event: 'SessionEnd', repo: 'katipon', session: 's1', synced: true, narrated: true, miss: false }])
})

test('two runs from a registered repo add exactly two lines', async () => {
  const s = setup()
  mkdirSync(join(s.home, 'logs'))
  await runRecord(s, { cwd: s.repo, session_id: 's1' }, { sync: stubSync })
  const first = readLog(s)
  await runRecord(s, { cwd: s.repo, session_id: 's2' }, { sync: stubSync })
  assert.equal(logLines(s).length, 2)
  assert.ok(readLog(s).startsWith(first), 'the first line did not change')
  assert.deepEqual(logLines(s).map(l => l.session), ['s1', 's2'])
})

test('with no model listening the line says unobserved and miss, and the run reports no error', async () => {
  const s = setup()
  const r = await runRecord(s, { cwd: s.repo, session_id: 's1', transcript_path: s.transcript }, { fetch: fakeFetch([new Error('ECONNREFUSED')]) })
  assert.equal(r.unobserved, 'http://127.0.0.1:11434/v1 unreachable')
  assert.deepEqual(logLines(s), [{
    ts: NOW_ISO, event: 'SessionEnd', repo: 'katipon', session: 's1', synced: true, narrated: false, miss: true,
    unobserved: 'http://127.0.0.1:11434/v1 unreachable',
  }])
})

test('record from the CLI with no model listening is silent, exits 0 and logs the miss at DIAL_NOW', async () => {
  const s = setup()
  // Nothing listens on port 1, whatever runs on the machine that runs the tests.
  s.registry.narrate = { fallbackUrl: 'http://127.0.0.1:1/v1' }
  writeFileSync(join(s.home, 'registry.json'), JSON.stringify(s.registry))
  const r = await runWithInput(['record', '--event', 'SessionEnd'], { ...s.env, DIAL_NOW: '2026-11-10T16:50:00Z' }, JSON.stringify({ cwd: s.repo, session_id: 's1', transcript_path: s.transcript }))
  assert.deepEqual(r, { code: 0, stdout: '', stderr: '' })
  assert.deepEqual(logLines(s), [{
    ts: NOW_ISO, event: 'SessionEnd', repo: 'katipon', session: 's1', synced: true, narrated: false, miss: true,
    unobserved: 'http://127.0.0.1:1/v1 unreachable',
  }])
})

test('a failed sync is logged with its reason, and stderr stays the one line', async () => {
  const s = setup()
  const gone = join(s.root, 'gone')
  s.registry.vaults.personal = gone
  const r = await runRecord(s, { cwd: s.repo, session_id: 's1', transcript_path: s.transcript })
  assert.equal(r.ok, false)
  assert.deepEqual(logLines(s), [{
    ts: NOW_ISO, event: 'SessionEnd', repo: 'katipon', session: 's1', synced: false, narrated: false, miss: true,
    error: `vault personal for katipon does not exist: ${gone}`,
  }])
  writeFileSync(join(s.home, 'registry.json'), JSON.stringify(s.registry))
  const cli = await runWithInput(['record', '--event', 'SessionEnd'], s.env, JSON.stringify({ cwd: s.repo }))
  assert.equal(cli.code, 0)
  assert.equal(cli.stdout, '')
  assert.equal(cli.stderr, `dial: vault personal for katipon does not exist: ${gone}\n`)
  assert.equal(logLines(s).length, 2)
})

test('an exception inside the run is logged with the repo, synced and narrated false, and the result is unchanged', async () => {
  const s = setup()
  const sync = () => {
    throw new Error('kaboom')
  }
  const r = await runRecord(s, { cwd: s.repo, session_id: 's1' }, { sync })
  assert.deepEqual(r, { ok: false, error: 'kaboom' })
  assert.deepEqual(logLines(s), [{
    ts: NOW_ISO, event: 'SessionEnd', repo: 'katipon', session: 's1', synced: false, narrated: false, miss: true, error: 'kaboom',
  }])
})

test('a home without logs/ gets the folder and the line, and a missing home is never created', async () => {
  const s = setup()
  assert.equal(existsSync(join(s.home, 'logs')), false)
  await runRecord(s, { cwd: s.repo }, { sync: stubSync })
  assert.equal(logLines(s).length, 1)

  const gone = join(s.root, 'no-such-home')
  const r = await runRecord(s, { cwd: s.repo }, { sync: stubSync, home: gone })
  assert.equal(r.ok, true)
  assert.equal(existsSync(gone), false)
})

test('without an injected home the line goes to the DIAL_HOME of the environment', async () => {
  const s = setup()
  await runRecord(s, { cwd: s.repo }, { sync: stubSync, home: undefined })
  assert.equal(logLines(s).length, 1)
})

test('no line, and nothing created, for an unregistered cwd or a bad event', async () => {
  const s = setup()
  const before = snapshotTree(s.home)
  const elsewhere = await runRecord(s, { cwd: tmp('scratch-') }, { sync: stubSync })
  assert.deepEqual(elsewhere, { ok: true, silent: true })
  const bad = await runRecord(s, { cwd: s.repo }, { event: 'Stop', sync: stubSync })
  assert.deepEqual(bad, { ok: false, error: 'record needs --event SessionEnd or PreCompact' })
  assert.equal(existsSync(logFile(s)), false)
  assert.deepEqual(snapshotTree(s.home), before)
})

test('an unwritable home with a failing sync is still one stderr line and exit 0', { skip: isRoot ? 'root ignores mode bits' : false }, async () => {
  const s = setup()
  s.registry.vaults.personal = join(s.root, 'gone')
  writeFileSync(join(s.home, 'registry.json'), JSON.stringify(s.registry))
  chmodSync(s.home, 0o555)
  try {
    const r = await runWithInput(['record', '--event', 'SessionEnd'], s.env, JSON.stringify({ cwd: s.repo }))
    assert.equal(r.code, 0)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr.split('\n').length, 2, 'one line and its newline')
    assert.ok(r.stderr.startsWith('dial: '), r.stderr)
    assert.equal(existsSync(logFile(s)), false)
  } finally {
    chmodSync(s.home, 0o755)
  }
})

test('the API key reaches neither the narrate result nor the log', async () => {
  const s = setup()
  mkdirSync(join(s.userHome, '.pi', 'agent'), { recursive: true })
  writeFileSync(join(s.userHome, '.pi', 'agent', 'models.json'), JSON.stringify({ providers: { mtplx: { baseUrl: 'http://127.0.0.1:8000/v1', apiKey: 'sk-local-123', models: [{ id: 'm' }] } } }))
  const fetch = fakeFetch([{ status: 401, body: 'bad key sk-local-123' }, new Error('sk-local-123 refused')])
  const r = await runRecord(s, { cwd: s.repo, session_id: 's1', transcript_path: s.transcript }, { fetch })
  assert.equal(fetch.calls.length, 2)
  assert.ok(!JSON.stringify(r).includes('sk-local-123'))
  assert.ok(!readLog(s).includes('sk-local-123'))
})

// --- the log line marks a missed session -----------------------------------------------------------------------------

test('miss: a handoff that covers the session is not a miss and says why it was skipped', async () => {
  const s = setup({ notes: [changeNote('### 2026-11-10 16:40 · /dial:handoff (claude)')] })
  await runRecord(s, { cwd: s.repo, session_id: 's1', transcript_path: s.transcript }, { fetch: fakeFetch([]) })
  assert.deepEqual(logLines(s), [{
    ts: NOW_ISO, event: 'SessionEnd', repo: 'katipon', session: 's1', synced: true, narrated: false, miss: false,
    skipped: 'a narrative entry is newer than the session start',
  }])
})

test('miss: a transcript path that exists but cannot be read as a file is a miss, an absent file is not', async () => {
  const s = setup()
  const unreadable = join(s.root, 'a-directory.jsonl')
  mkdirSync(unreadable)
  await runRecord(s, { cwd: s.repo, session_id: 's1', transcript_path: unreadable }, { fetch: fakeFetch([]) })
  const absent = join(s.root, 'never-written.jsonl')
  await runRecord(s, { cwd: s.repo, session_id: 's2', transcript_path: absent }, { fetch: fakeFetch([]) })
  assert.equal(logLines(s).length, 2)
  const [bad, none] = logLines(s)
  assert.deepEqual([bad.miss, bad.unobserved], [true, `no transcript at ${unreadable}`])
  assert.deepEqual([none.miss, none.unobserved], [false, `no transcript at ${absent}`])
  assert.deepEqual([bad.error, none.error], [undefined, undefined])
})

test('miss: a payload that names no transcript is a miss with session null', async () => {
  const s = setup()
  await runRecord(s, { cwd: s.repo }, { fetch: fakeFetch([]) })
  assert.deepEqual(logLines(s), [{
    ts: NOW_ISO, event: 'SessionEnd', repo: 'katipon', session: null, synced: true, narrated: false, miss: true,
    skipped: 'no transcript_path or session_id in the payload',
  }])
})

test('miss: a transcript with no text turns is not a miss', async () => {
  const s = setup()
  const empty = join(s.root, 'empty.jsonl')
  writeFileSync(empty, '')
  const fetch = fakeFetch([])
  await runRecord(s, { cwd: s.repo, session_id: 's1', transcript_path: empty }, { fetch })
  assert.equal(fetch.calls.length, 0)
  assert.deepEqual(logLines(s), [{
    ts: NOW_ISO, event: 'SessionEnd', repo: 'katipon', session: 's1', synced: true, narrated: false, miss: false,
    unobserved: 'transcript has no text turns',
  }])
})

test('miss: running out of time before the model call is a miss', async () => {
  const s = setup()
  const time = virtualTime()
  const sync = () => {
    time.advance(52_000)
    return { ok: true }
  }
  await runRecord(s, { cwd: s.repo, session_id: 's1', transcript_path: s.transcript }, { sync, fetch: fakeFetch([]), clock: time.clock, setTimer: time.setTimer })
  assert.equal(logLines(s).length, 1)
  const [line] = logLines(s)
  assert.deepEqual([line.miss, line.unobserved], [true, NO_TIME])
})

test('a PreCompact run is logged under its own event', async () => {
  const s = setup({ notes: [changeNote('### 2026-11-10 16:40 · /dial:handoff (claude)')] })
  await runRecord(s, { cwd: s.repo, session_id: 's1', transcript_path: s.transcript }, { event: 'PreCompact', fetch: fakeFetch([]) })
  assert.equal(logLines(s)[0].event, 'PreCompact')
})
