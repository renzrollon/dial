/**
 * The readiness verdict (specs/context, add-dial-ask delta): `readiness(item)` is pure and returns
 * `{ ready, blockers }` with the blockers in a fixed order, each at most once. Never `yes` from silence.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readiness } from '../lib/readiness.mjs'

const pr = over => ({ number: 1, title: 't', branch: 'b', base: 'main', url: '', author: 'a', draft: false, review: null, mergeState: null, conflicting: false, checks: null, updatedAt: null, ...over })
const chk = (name, bucket) => ({ name, bucket })
const verdict = over => readiness(pr(over))

test('draft: a draft flag or a draft merge state', () => {
  assert.deepEqual(verdict({ draft: true, mergeState: 'draft' }), { ready: 'no', blockers: ['draft'] })
  assert.deepEqual(verdict({ mergeState: 'draft_status' }).blockers, ['draft'])
  assert.deepEqual(verdict({ draft: true, mergeState: 'clean' }).blockers, ['draft'])
})

test('conflict: a conflicting flag or a dirty or conflict merge state', () => {
  assert.deepEqual(verdict({ conflicting: true, mergeState: 'dirty' }).blockers, ['conflict'])
  assert.deepEqual(verdict({ mergeState: 'conflict' }).blockers, ['conflict'])
  assert.deepEqual(verdict({ conflicting: true }).blockers, ['conflict'])
})

test('behind base: behind on GitHub, need_rebase on GitLab', () => {
  assert.deepEqual(verdict({ mergeState: 'behind' }), { ready: 'no', blockers: ['behind base'] })
  assert.deepEqual(verdict({ mergeState: 'need_rebase' }).blockers, ['behind base'])
})

test('review blockers', () => {
  assert.deepEqual(verdict({ review: 'changes_requested', mergeState: 'blocked' }).blockers, ['changes requested'])
  assert.deepEqual(verdict({ mergeState: 'requested_changes' }).blockers, ['changes requested'])
  assert.deepEqual(verdict({ review: 'review_required' }).blockers, ['review required'])
  assert.deepEqual(verdict({ mergeState: 'not_approved' }).blockers, ['review required'])
  assert.deepEqual(verdict({ mergeState: 'discussions_not_resolved' }).blockers, ['unresolved discussions'])
  assert.deepEqual(verdict({ review: 'none', mergeState: 'clean' }).blockers, [])
  assert.deepEqual(verdict({ review: 'approved', mergeState: 'clean' }), { ready: 'yes', blockers: [] })
})

test('checks that are not passing are blockers whether or not the forge would merge', () => {
  assert.deepEqual(verdict({ mergeState: 'unstable', checks: [chk('lint', 'fail'), chk('unit', 'pass')] }), { ready: 'no', blockers: ['ci failing: lint'] })
  assert.deepEqual(verdict({ mergeState: 'clean', checks: [chk('unit', 'pass'), chk('e2e', 'pending')] }).blockers, ['checks pending: e2e'])
  assert.deepEqual(verdict({ mergeState: 'clean', checks: [chk('unit', 'cancel')] }).blockers, ['ci cancelled: unit'])
  const five = ['a', 'b', 'c', 'd', 'e'].map(n => chk(n, 'fail'))
  assert.deepEqual(verdict({ checks: five }).blockers, ['ci failing: 5 checks'])
  assert.deepEqual(verdict({ checks: five.slice(0, 3) }).blockers, ['ci failing: a, b, c'])
  assert.deepEqual(verdict({ mergeState: 'clean', checks: [chk('a', 'pass'), chk('b', 'skipping')] }), { ready: 'yes', blockers: [] })
})

test('GitLab pipeline states', () => {
  assert.deepEqual(verdict({ mergeState: 'ci_must_pass' }).blockers, ['ci must pass'])
  assert.deepEqual(verdict({ mergeState: 'ci_still_running' }).blockers, ['checks pending'])
  assert.deepEqual(verdict({ mergeState: 'status_checks_must_pass' }).blockers, ['merge state: status checks must pass'])
})

test('null checks name no check blocker', () => {
  assert.deepEqual(verdict({ mergeState: 'clean', checks: null }), { ready: 'yes', blockers: [] })
  assert.deepEqual(verdict({ mergeState: 'clean', checks: [] }), { ready: 'yes', blockers: [] })
})

test('blocked is named only when nothing else is', () => {
  assert.deepEqual(verdict({ mergeState: 'blocked', review: 'approved', checks: [chk('unit', 'pass')] }), { ready: 'no', blockers: ['blocked by branch protection'] })
  assert.deepEqual(verdict({ mergeState: 'blocked', review: 'review_required' }).blockers, ['review required'])
  assert.deepEqual(verdict({ mergeState: 'blocked', draft: true }).blockers, ['draft'])
  assert.deepEqual(verdict({ mergeState: 'blocked', checks: [chk('lint', 'fail')] }).blockers, ['ci failing: lint'])
})

test('a state with no rule is a blocker, spelled with spaces', () => {
  assert.deepEqual(verdict({ mergeState: 'some_new_state' }), { ready: 'no', blockers: ['merge state: some new state'] })
})

test('blockers come in a fixed order, each once', () => {
  const all = verdict({ draft: true, mergeState: 'draft', conflicting: true, review: 'review_required', checks: [chk('lint', 'fail')] })
  assert.deepEqual(all.blockers, ['draft', 'conflict', 'review required', 'ci failing: lint'])
  assert.equal(all.ready, 'no')
  const both = verdict({ draft: true, mergeState: 'draft_status' })
  assert.deepEqual(both.blockers, ['draft'])
  const dup = verdict({ review: 'review_required', mergeState: 'not_approved' })
  assert.deepEqual(dup.blockers, ['review required'])
  assert.deepEqual(verdict({ mergeState: 'behind', review: 'changes_requested', checks: [chk('e2e', 'pending')] }).blockers, ['behind base', 'changes requested', 'checks pending: e2e'])
})

test('pass-through states name no blocker', () => {
  for (const state of ['clean', 'has_hooks', 'mergeable', 'unstable', 'unknown', 'unchecked', 'checking', 'preparing', 'approvals_syncing']) {
    assert.deepEqual(verdict({ mergeState: state }).blockers, [], state)
  }
})

test('ready is yes only for clean, has_hooks and mergeable', () => {
  for (const state of ['clean', 'has_hooks', 'mergeable']) assert.equal(verdict({ mergeState: state }).ready, 'yes', state)
  for (const state of ['unstable', 'unknown', 'unchecked', 'checking', 'preparing', 'approvals_syncing']) assert.equal(verdict({ mergeState: state }).ready, 'unknown', state)
  assert.equal(verdict({ mergeState: null }).ready, 'unknown')
  assert.deepEqual(verdict({ mergeState: 'unknown' }), { ready: 'unknown', blockers: [] })
  assert.equal(verdict({ mergeState: 'unknown', draft: true }).ready, 'no')
})

test('a malformed item never throws', () => {
  for (const bad of [null, undefined, {}, 5, 'x', { checks: 'nope' }, { checks: [null, 3] }, { mergeState: 7 }]) {
    assert.doesNotThrow(() => readiness(bad))
    const r = readiness(bad)
    assert.ok(['yes', 'no', 'unknown'].includes(r.ready))
    assert.ok(Array.isArray(r.blockers))
  }
  assert.equal(readiness({}).ready, 'unknown')
})
