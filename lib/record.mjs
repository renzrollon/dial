/**
 * `dial record --event SessionEnd|PreCompact` (design.md §Handoff, narrate, record;
 * specs/handoff-and-narrative, the record requirements): the hook side of the
 * ledger. Read the hook payload, sync the repo its `cwd` is in, then narrate the
 * attributed note from the transcript only when no narrative entry was written
 * since the session began, all inside a 55-second deadline so the 60-second hook
 * is never killed mid-write (D45, D80): the sync's subprocesses are bounded by the
 * time left, the sync's derived view is reused rather than collected again, and
 * the model calls get what remains.
 *
 * Nothing here throws or exits: the result names at most one `error`, which the
 * CLI writes as its one stderr line before exiting 0. A `cwd` outside every
 * registered repo is silent and touches nothing, not even the Dial home.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { noteName } from './facts.mjs'
import { LIMITS } from './limits.mjs'
import { narrate } from './narrate.mjs'
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

/** The newest narrative entry time (ms) of a note view, or null. */
function newestEntry(note) {
  let best = null
  for (const e of note?.narrative ?? []) {
    const t = Date.parse(e.at)
    if (!Number.isNaN(t) && (best === null || t > best)) best = t
  }
  return best
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
  try {
    return await run(opts)
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) }
  }
}

async function run(opts) {
  const { event, registry, env = process.env, home, limits, now = new Date(), exec } = opts
  if (!RECORD_EVENTS.includes(event)) return { ok: false, error: BAD_EVENT }
  const clock = opts.clock ?? Date.now
  const deadline = clock() + (opts.deadlineMs ?? DEADLINE_MS)
  const payload = opts.payload && typeof opts.payload === 'object' ? opts.payload : {}
  const cwd = str(payload.cwd) ?? opts.cwd ?? process.cwd()

  const entry = resolveRepo(registry, cwd)
  if (!entry) return { ok: true, silent: true }

  const sync = opts.sync ?? syncRepo
  const bounded = boundedExec({ exec, clock, deadline })
  const synced = sync({ registry, repo: entry.name, env, home, now, limits, exec: bounded, warn: opts.warn })
  if (!synced.ok) return { ok: false, repo: entry.name, synced: false, error: synced.reason }
  const done = extra => ({ ok: true, repo: entry.name, synced: true, narrated: false, ...extra })

  const transcript = transcriptPath(payload, cwd, env)
  if (!transcript) return done({ skipped: 'no transcript_path or session_id in the payload' })
  const tail = tailTurns(transcript, 1)
  if (!tail.ok) return done({ unobserved: tail.reason })

  // The sync already derived the attribution; only the notes are read again, as the sync left them. A sync that
  // reports no view (an injected one) falls back to collecting, under the same deadline.
  const { derived, notes } = synced.derived
    ? { derived: synced.derived, notes: notesOf(registry, entry) }
    : repoView({ repo: entry, registry, limits, env, now, home, exec: bounded })
  const attributed = attributedChange(derived)
  const change = attributed && notes[noteName(entry.name, attributed)] ? attributed : null
  const target = notes[noteName(entry.name, change ?? undefined)]
  const newest = newestEntry(target)
  const started = Date.parse(tail.firstTimestamp ?? '')
  if (newest !== null && (Number.isNaN(started) || newest >= started)) return done({ skipped: 'a narrative entry is newer than the session start' })

  const result = await narrate({
    registry, repo: entry.name, change, transcript, limits, env, fetch: opts.fetch, now,
    timeoutFor: callBudget({ clock, deadline, limits }), setTimer: opts.setTimer, clearTimer: opts.clearTimer, warn: opts.warn,
  })
  if (!result.ok) return { ok: false, repo: entry.name, synced: true, narrated: false, error: result.reason }
  if (!result.written) return done({ unobserved: result.unobserved })
  return { ok: true, repo: entry.name, synced: true, narrated: true, wikilink: result.wikilink }
}
