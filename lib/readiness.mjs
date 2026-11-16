/**
 * The merge-readiness verdict (specs/context, add-dial-ask delta). `readiness(pr)` takes one normalised pull request
 * item and nothing else — no clock, no host, no I/O — and returns `{ ready, blockers }`. The blockers come in a fixed
 * order, each at most once: draft, conflict, behind base, the review blockers, the check blockers, then a fallback
 * for a merge state no rule names. `ready` is `no` with any blocker, `yes` only for a clean merge state, and
 * `unknown` otherwise: never `yes` from silence. The two forge vocabularies do not collide, so one table serves both.
 * Nothing here throws on any input.
 */
import { cutWord, listed, rollup } from './sources/forge.mjs'

/** Merge states that name no blocker. */
const PASS_THROUGH = new Set(['clean', 'has_hooks', 'mergeable', 'unstable', 'unknown', 'unchecked', 'checking', 'preparing', 'approvals_syncing'])

/** Merge states that alone make `ready` `yes`. */
const READY = new Set(['clean', 'has_hooks', 'mergeable'])

/** Merge states a rule below names, by blocker. */
const STATE_BLOCKERS = {
  draft: 'draft',
  draft_status: 'draft',
  dirty: 'conflict',
  conflict: 'conflict',
  behind: 'behind base',
  need_rebase: 'behind base',
  requested_changes: 'changes requested',
  not_approved: 'review required',
  discussions_not_resolved: 'unresolved discussions',
  ci_must_pass: 'ci must pass',
  ci_still_running: 'checks pending',
}

const CHECK_BLOCKERS = { fail: 'ci failing', pending: 'checks pending', cancel: 'ci cancelled' }

/**
 * @param {object} pr a normalised item `{ draft, review, mergeState, conflicting, checks, … }`
 * @returns {{ ready: 'yes' | 'no' | 'unknown', blockers: string[] }}
 */
export function readiness(pr) {
  const item = pr !== null && typeof pr === 'object' ? pr : {}
  const state = cutWord(item.mergeState)
  const review = cutWord(item.review)
  const blockers = []
  const add = b => { if (!blockers.includes(b)) blockers.push(b) }
  const named = STATE_BLOCKERS[state]

  if (item.draft === true || named === 'draft') add('draft')
  if (item.conflicting === true || named === 'conflict') add('conflict')
  if (named === 'behind base') add('behind base')
  if (review === 'changes_requested' || named === 'changes requested') add('changes requested')
  if (review === 'review_required' || named === 'review required') add('review required')
  if (named === 'unresolved discussions') add('unresolved discussions')

  const roll = Array.isArray(item.checks) ? rollup(item.checks) : { value: 'none', names: [] }
  const checkBlocker = CHECK_BLOCKERS[roll.value]
  if (checkBlocker) add(`${checkBlocker}: ${listed(roll.names)}`)
  else if (named === 'ci must pass' || named === 'checks pending') add(named)

  if (state === 'blocked') {
    if (blockers.length === 0) add('blocked by branch protection')
  } else if (state !== null && !named && !PASS_THROUGH.has(state)) {
    add(`merge state: ${state.replace(/_/g, ' ')}`)
  }

  if (blockers.length > 0) return { ready: 'no', blockers }
  return { ready: READY.has(state) ? 'yes' : 'unknown', blockers }
}
