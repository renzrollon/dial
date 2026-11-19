/**
 * `dial record --event SessionEnd|PreCompact` (design.md §Handoff, narrate, record;
 * specs/handoff-and-narrative, the record requirements): the hook side of the
 * ledger. Read the hook payload, sync the repo its `cwd` is in, then narrate the
 * attributed note from the transcript only when it holds work no entry covers: no
 * handoff was written since the session began, and no earlier narration of this
 * one (a PreCompact, or the end before a resume) is as new as its last turn, all inside a 55-second deadline. That
 * deadline keeps a PreCompact run inside its 60-second hook and is the only bound on a SessionEnd run, which the hook
 * starts detached (D45, D80): the sync's subprocesses are bounded by the
 * time left, the sync's derived view is reused rather than collected again, and
 * the model calls get what remains.
 *
 * Nothing here throws or exits: the result names at most one `error`, which the
 * CLI writes as its one stderr line before exiting 0. Every run for a registered
 * repo appends one line to `<home>/logs/record.jsonl`, whose `miss` says whether
 * the session went uncaptured. A `cwd` outside every registered repo is silent and
 * touches nothing, not even the Dial home.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { noteName } from './facts.mjs'
import { resolveHome } from './home.mjs'
import { LIMITS } from './limits.mjs'
import { narrate, NO_TEXT_TURNS } from './narrate.mjs'
import { repoView } from './next.mjs'
import { expandHome, resolveRepo } from './registry.mjs'
import { homeOf, realOr } from './sources/paths.mjs'
import { slugOf } from './sources/sessions.mjs'
import { exec as realExec } from './subprocess.mjs'
import { syncRepo } from './sync.mjs'
import { tailTurns } from './transcript.mjs'
import { readNotes } from './vault.mjs'

export const RECORD_EVENTS = Object.freeze(['SessionEnd', 'PreCompact'])
export const BAD_EVENT = 'record needs --event SessionEnd or PreCompact'
export const DEADLINE_MS = 55_000
const MARGIN_MS = 2_000
const MIN_CALL_MS = 5_000
const NO_TRANSCRIPT = 'no transcript_path or session_id in the payload'

const str = v => (typeof v === 'string' && v.trim() !== '' ? v : null)

/** The hook payload: a JSON object, or `{}` for empty, malformed or non-object input. */
export function parsePayload(text) {
  if (typeof text !== 'string' || !text.trim()) return {}
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/**
 * Each model call's bound under the deadline: the smaller of `narrateTimeoutSeconds` and the time left minus
 * two seconds, or null (no call) when under five seconds are left.
 * @param {{ clock: () => number, deadline: number, limits?: object }} opts `clock` is milliseconds
 */
export function callBudget({ clock, deadline, limits }) {
  const cap = (Number.isInteger(limits?.narrateTimeoutSeconds) ? limits.narrateTimeoutSeconds : LIMITS.narrateTimeoutSeconds) * 1000
  return () => {
    const left = deadline - clock()
    if (left < MIN_CALL_MS) return null
    return Math.min(cap, left - MARGIN_MS)
  }
}

/** `transcript_path`, else `~/.claude/projects/<slug of cwd>/<session_id>.jsonl` (the real path's slug when only that exists). */
export function transcriptPath(payload, cwd, env) {
  const given = str(payload.transcript_path)
  if (given) return given
  const id = str(payload.session_id)
  if (!id) return null
  const projects = join(homeOf(env), '.claude', 'projects')
  const candidates = [...new Set([cwd, realOr(cwd)])].map(p => join(projects, slugOf(p), `${id}.jsonl`))
  return candidates.find(p => existsSync(p)) ?? candidates[0]
}

/**
 * `exec` bounded by the deadline: every subprocess the sync runs gets at most the time left before the deadline
 * minus the margin, and none starts once that is gone (it reports a timeout, so its facts are unobserved). The
 * sync's writes therefore start before the deadline, and the hook's kill never lands on a git or interlock child.
 */
export function boundedExec({ exec = realExec, clock, deadline }) {
  return (file, args, o = {}) => {
    const left = deadline - clock() - MARGIN_MS
    if (left <= 0) return { ok: false, code: null, stdout: '', stderr: '', missing: false, timedOut: true }
    const cap = Number.isFinite(o.timeoutMs) ? Math.min(o.timeoutMs, left) : left
    return exec(file, args, { ...o, timeoutMs: cap })
  }
}

/** The change the checked-out branch is attributed to, as derive records it on the repo item's rows, or null. */
function attributedChange(derived) {
  for (const r of derived?.repo?.rows ?? []) {
    const m = /^attributed to (.+)$/.exec(r.evidence ?? '')
    if (m && m[1] !== 'null') return m[1]
  }
  return null
}

/** The repo's notes as they are on disk now, or `{}`. */
function notesOf(registry, entry) {
  const vaultPath = registry?.vaults?.[entry.vault]
  if (typeof vaultPath !== 'string') return {}
  try {
    return readNotes(expandHome(vaultPath), entry.name)
  } catch {
    return {}
  }
}

/** The newest narrative entry of a note view as `{ at (ms), source }`, or null. */
function newestEntry(note) {
  let best = null
  for (const e of note?.narrative ?? []) {
    const t = Date.parse(e.at)
    if (!Number.isNaN(t) && (best === null || t > best.at)) best = { at: t, source: String(e.source ?? '') }
  }
  return best
}

/** The source narrate writes its entries under (`local model (<model>)`). */
const NARRATED = /^local model \(/
/** A heading holds the minute only, so a turn counts as after an entry once it is past that minute. */
const HEADING_MS = 60_000

/**
 * Why the transcript needs no narration, or null when it does (D45). A handoff (any entry not narrate's own)
 * written since the session began covers the session. An entry narrate wrote covers the turns up to it, so a
 * PreCompact narration, or a SessionEnd before a `--resume`, leaves the later turns to the next event.
 */
export function narrationSkip(newest, tail) {
  if (newest === null) return null
  if (NARRATED.test(newest.source)) {
    const last = Date.parse(tail.lastTurnAt ?? '')
    return Number.isNaN(last) || last < newest.at + HEADING_MS ? 'no turn is newer than the last narration' : null
  }
  const started = Date.parse(tail.firstTimestamp ?? '')
  return Number.isNaN(started) || newest.at >= started ? 'a narrative entry is newer than the session start' : null
}

const payloadOf = opts => (opts.payload && typeof opts.payload === 'object' ? opts.payload : {})

/**
 * Whether the run lost a session that had something to capture (D5). The reasons are free text, so this is decided
 * here, where they are made, and readers take `miss` from the log. A transcript file that does not exist means there
 * was no conversation, which is not a loss; one that exists and cannot be read is.
 */
function isMiss(result, transcriptAbsent) {
  if (result.narrated === true) return false
  if (result.error) return true
  if (result.unobserved) return result.unobserved !== NO_TEXT_TURNS && !transcriptAbsent
  return result.skipped === NO_TRANSCRIPT
}

/**
 * One line appended to `<home>/logs/record.jsonl`; `{ ok: false, reason }` on failure, which the run ignores so an
 * unwritable home still gives one stderr line. `logs/` is made without `recursive`, so a missing home stays missing.
 */
function appendRecordLog(opts, repo, result, transcriptAbsent) {
  try {
    const { event, env = process.env, now = new Date() } = opts
    const logs = join(opts.home ?? resolveHome(env), 'logs')
    try {
      mkdirSync(logs)
    } catch {
      // it exists, or the home does not and the append below fails
    }
    const line = {
      ts: now.toISOString(),
      event,
      repo,
      session: str(payloadOf(opts).session_id),
      synced: result.synced === true,
      narrated: result.narrated === true,
      miss: isMiss(result, transcriptAbsent),
    }
    for (const key of ['skipped', 'unobserved', 'error']) if (result[key]) line[key] = result[key]
    const file = join(logs, 'record.jsonl')
    appendFileSync(file, `${JSON.stringify(line)}\n`)
    return { ok: true, path: file }
  } catch (err) {
    return { ok: false, reason: `cannot append to the record log: ${err?.code ?? err?.message ?? err}` }
  }
}

/**
 * Run one hook event.
 * @param {{ event: string, payload: object, registry: object, cwd?: string, env?: object, home?: string,
 *   limits?: object, now?: Date, clock?: () => number, fetch?: Function, exec?: Function, sync?: Function,
 *   setTimer?: Function, clearTimer?: Function, deadlineMs?: number, warn?: Function }} opts
 *   `now` is the time written into notes (DIAL_NOW); `clock` is the elapsed-time source for the deadline.
 * @returns {Promise<{ ok: boolean, silent?: true, error?: string, repo?: string, synced?: boolean,
 *   narrated?: boolean, skipped?: string, unobserved?: string, wikilink?: string }>}
 */
export async function record(opts) {
  let repo = null
  let result
  const seen = { transcriptAbsent: false }
  try {
    if (!RECORD_EVENTS.includes(opts.event)) return { ok: false, error: BAD_EVENT }
    const payload = payloadOf(opts)
    const cwd = str(payload.cwd) ?? opts.cwd ?? process.cwd()
    const entry = resolveRepo(opts.registry, cwd)
    if (!entry) return { ok: true, silent: true }
    repo = entry.name
    result = await run(opts, { entry, payload, cwd }, seen)
  } catch (err) {
    result = { ok: false, error: err?.message ?? String(err) }
  }
  if (repo !== null) appendRecordLog(opts, repo, result, seen.transcriptAbsent)
  return result
}

/** The run for a resolved repo. `seen.transcriptAbsent` carries what the log needs and the result does not hold. */
async function run(opts, { entry, payload, cwd }, seen) {
  const { registry, env = process.env, home, limits, now = new Date(), exec } = opts
  const clock = opts.clock ?? Date.now
  const deadline = clock() + (opts.deadlineMs ?? DEADLINE_MS)

  const sync = opts.sync ?? syncRepo
  const bounded = boundedExec({ exec, clock, deadline })
  const synced = sync({ registry, repo: entry.name, env, home, now, limits, exec: bounded, warn: opts.warn })
  if (!synced.ok) return { ok: false, repo: entry.name, synced: false, error: synced.reason }
  const done = extra => ({ ok: true, repo: entry.name, synced: true, narrated: false, ...extra })

  const transcript = transcriptPath(payload, cwd, env)
  if (!transcript) return done({ skipped: NO_TRANSCRIPT })
  const tail = tailTurns(transcript, 1)
  if (!tail.ok) {
    seen.transcriptAbsent = !existsSync(transcript)
    return done({ unobserved: tail.reason })
  }

  // The sync already derived the attribution; only the notes are read again, as the sync left them. A sync that
  // reports no view (an injected one) falls back to collecting, under the same deadline.
  const { derived, notes } = synced.derived
    ? { derived: synced.derived, notes: notesOf(registry, entry) }
    : repoView({ repo: entry, registry, limits, env, now, home, exec: bounded })
  const attributed = attributedChange(derived)
  const change = attributed && notes[noteName(entry.name, attributed)] ? attributed : null
  const target = notes[noteName(entry.name, change ?? undefined)]
  const skip = narrationSkip(newestEntry(target), tail)
  if (skip) return done({ skipped: skip })

  const result = await narrate({
    registry, repo: entry.name, change, transcript, limits, env, fetch: opts.fetch, now,
    timeoutFor: callBudget({ clock, deadline, limits }), setTimer: opts.setTimer, clearTimer: opts.clearTimer, warn: opts.warn,
  })
  if (!result.ok) return { ok: false, repo: entry.name, synced: true, narrated: false, error: result.reason }
  if (!result.written) return done({ unobserved: result.unobserved })
  return { ok: true, repo: entry.name, synced: true, narrated: true, wikilink: result.wikilink }
}
