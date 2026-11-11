/**
 * The shared vocabulary (design.md §The fact, D55): the fact leaf, the state
 * priority table, and the note name every module derives from a repo and a
 * change. Pure; no I/O.
 */

/**
 * A fact leaf: `{ value, evidence }` when observed, `{ value: null, unobserved, evidence? }`
 * when not. An observed absence is the value `absent` or `none`, never `unobserved`.
 * @template T
 * @typedef {{ value: T, evidence: string } | { value: null, unobserved: string, evidence?: string }} Fact
 */

/**
 * The per-repository bundle the collectors build and `derive` reads; every leaf is a Fact.
 * @typedef {object} RepoFacts
 * @property {{ name: string, path: string, realPath: string, vault: string, host: string }} repo
 * @property {{
 *   branch: Fact<string>, detached: Fact<boolean>, dirty: Fact<number>, ahead: Fact<number>, behind: Fact<number>,
 *   stash: Fact<number>, inProgress: Fact<'rebase'|'merge'|'none'>, unmerged: Fact<string[]>,
 *   worktrees: Fact<{ path: string, branch: string }[]>, lastCommit: Fact<{ sha7: string, head: string, date: string }>
 * }} git
 * @property {{
 *   active: Fact<string[]>, archived: Fact<{ name: string, date: string }[]>,
 *   changes: Object<string, {
 *     tasks: Fact<{ done: number, total: number }>,
 *     manualTest: Fact<'absent'|'present, no result'|'pass'|'fail'>,
 *     needsHuman: Fact<string[]>, checkpoint: Fact<'absent'|'approved'|'returned'>, lastMtime: Fact<string>
 *   }>
 * }} openspec
 * @property {{
 *   run: Fact<{ runId: string, change: string, ended: string|null, halted: string|null, closedAt: string|null, stateHome: string|null }|'absent'>,
 *   stages: Object<string, Fact<{ pid: number, alive: boolean }|'absent'>>,
 *   waves: Fact<{ done: number, total: number }|'absent'>,
 *   terminal: Fact<{ type: string, reason: string, ts: string }|'none'>,
 *   interrupted: Fact<{ runId: string, change: string, at: string, file: string, spokenAt?: string }[]>,
 *   merge: Fact<{ change: string, verdict: 'MERGE'|'HUMAN'|'BLOCK' }|'absent'>,
 *   outcomes: Object<string, Fact<{ commit: string|null, mergeVerdict: string|null, ts: string }|'absent'>>,
 *   settle: Fact<{ surviving: number, head: string, file: string }|'absent'>,
 *   reviewArtifacts: Object<string, Fact<{ blockers: number, file: string }|'absent'>>,
 *   resumeCards: Object<string, Fact<string>>,
 *   trajectoryTs: Object<string, Fact<string>>,
 *   drift: Fact<{ unarchived: string[], broken: Fact<number>, aging: Fact<number> }>
 * }} interlock
 * @property {{ entries: Object<string, Fact<{ id: string, state: string, lastTs: string, observation: object|null }|'absent'>> }} escapement
 * @property {{ lastSession: Fact<{ file: string, mtime: string }> }} sessions
 * @property {{
 *   pr: Fact<{ number: number, state: string, url: string, conflicting: boolean, mergedAt: string|null, updatedAt: string }|'none'>,
 *   ci: Fact<{ value: string, failing: string[] }>, remote: Fact<'ok'>
 * }} remote
 */

/**
 * What the vault already holds, keyed by note name, parsed by lib/note.mjs.
 * @typedef {Object<string, {
 *   frontmatter: Object<string, string>,
 *   next: { checked: boolean, text: string }[],
 *   narrative: { at: string, source: string, body?: string }[]
 * }>} NoteView
 */

/** An observed fact. */
export function fact(value, evidence) {
  return { value, evidence }
}

/** An unobserved fact: the value is null and `reason` says why. */
export function unobserved(reason, evidence) {
  const out = { value: null, unobserved: reason }
  if (evidence !== undefined) out.evidence = evidence
  return out
}

/** True for an unobserved leaf (and for a missing one, which no signal may read). */
export function isUnobserved(f) {
  return f === undefined || f === null || typeof f.unobserved === 'string'
}

/**
 * The one priority list (design.md §The state machine). `signal` names the
 * evidence row whose match decides the state; `needsMe` is a boolean, or
 * `'verdict'` for pr-open (true unless the merge verdict is MERGE, D31);
 * `suggested` may hold `<change>`. The first entry whose signal matches wins.
 */
export const STATE_TABLE = Object.freeze([
  { state: 'archived', signal: 'archive', needsMe: false, suggested: null },
  { state: 'dropped', signal: 'dropped', needsMe: false, suggested: null },
  { state: 'archive-pending', signal: 'tasks', needsMe: true, suggested: 'openspec archive <change>' },
  { state: 'conflict', signal: 'conflict', needsMe: true, suggested: 'resolve, then git rebase --continue' },
  { state: 'ci-red', signal: 'ci', needsMe: true, suggested: '/interlock:fix-tests' },
  { state: 'needs-fix', signal: 'settle', needsMe: true, suggested: '/interlock:settle --review' },
  { state: 'manual-test', signal: 'manual test', needsMe: true, suggested: 'run the plan, add Result:' },
  { state: 'pr-open', signal: 'pr', needsMe: 'verdict', suggested: 'review and merge' },
  { state: 'shipped', signal: 'outcome', needsMe: true, suggested: '/interlock:settle --create' },
  { state: 'halted', signal: 'ship', needsMe: true, suggested: '/interlock-handoff, re-run ship' },
  { state: 'shipping', signal: 'stage', needsMe: false, suggested: 'wait' },
  { state: 'queued', signal: 'queue', needsMe: false, suggested: 'wait or escapement list' },
  { state: 'checkpoint', signal: 'decisions', needsMe: true, suggested: 'read the spec; answer on the phone' },
  { state: 'spec-draft', signal: 'tasks', needsMe: true, suggested: '/interlock:review-artifacts' },
].map(row => Object.freeze(row)))

/** The state names in priority order; drives derive, `dial next` and the Dial.base groupOrder. */
export const STATES = Object.freeze(STATE_TABLE.map(row => row.state))

/** `needs_me` per state (`'verdict'` for pr-open). */
export const NEEDS_ME = Object.freeze(Object.fromEntries(STATE_TABLE.map(r => [r.state, r.needsMe])))

/** The suggested action per state, `<change>` substituted by the caller. */
export const SUGGESTED = Object.freeze(Object.fromEntries(STATE_TABLE.map(r => [r.state, r.suggested])))

/** A spec-draft whose checkpoint.json is approved suggests ship instead (D82). */
export const APPROVED_SUGGESTED = '/interlock:ship <change>'

/** Stale keeps the state and overrides the suggestion (D36). */
export const STALE_SUGGESTED = 'archive, drop, or re-spec'

/** The repo-level item's states (D29), in priority order, then `idle`. */
export const REPO_STATES = Object.freeze(['conflict', 'ci-red', 'pr-open', 'merged', 'idle'])

const FORBIDDEN = /[:/\\?*"<>|#^[\]]/g

/** A repo or change name with every character in `: / \ ? * " < > | # ^ [ ]` replaced by `-` (D20). */
export function sanitizeName(name) {
  return String(name).replace(FORBIDDEN, '-')
}

/** The note name (no folder, no `.md`): `<repo>--<change>`, or `<repo>` for the repo note. */
export function noteName(repo, change) {
  return change === undefined || change === null ? sanitizeName(repo) : `${sanitizeName(repo)}--${sanitizeName(change)}`
}
