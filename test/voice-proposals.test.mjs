import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProposals } from '../lib/voice/proposals.mjs'
import { fakeTimers } from './helpers.mjs'

// The one open proposal and its statuses (voice-sessions: "A proposal from the voice session becomes the one open
// proposal", "Confirm starts the open proposal", "Cancel and time close a proposal"). lib/voice/proposals.mjs does
// not exist yet: every case fails until task 2.4 adds it.

function make({ seconds = 120 } = {}) {
  const clock = fakeTimers()
  const events = []
  let n = 0
  const proposals = createProposals({
    timers: clock.timers,
    seconds,
    newId: () => `id${++n}`,
    on: proposal => events.push({ ...proposal })
  })
  const statuses = () => events.map(e => `${e.id}:${e.status}`)
  return { proposals, events, statuses, advance: clock.advance }
}
const P = { repo: 'katipon', prompt: '/interlock:ship add-parser' }
const NOT_READ = 'the proposal was not read aloud; confirm it on screen'

test('offer opens a pending proposal with the id newId returned, and sends it once', () => {
  const { proposals, events } = make()
  const proposal = proposals.offer(P)
  assert.deepEqual(proposal, { id: 'id1', repo: 'katipon', prompt: '/interlock:ship add-parser', status: 'pending' })
  assert.deepEqual(events, [proposal])
  assert.equal(proposals.open.id, 'id1')
})

test('a second offer replaces the first, then the second is pending', () => {
  const { proposals, statuses } = make()
  proposals.offer(P)
  const second = proposals.offer({ repo: 'dial', prompt: 'run the tests' })
  assert.deepEqual(statuses(), ['id1:pending', 'id1:replaced', 'id2:pending'])
  assert.equal(proposals.open.id, 'id2')
  assert.equal(second.status, 'pending')
})

test('markRead gives read once, and false for a closed or unknown id', () => {
  const { proposals, statuses } = make()
  proposals.offer(P)
  assert.equal(proposals.markRead('id1'), true)
  assert.equal(proposals.open.status, 'read')
  assert.deepEqual(statuses(), ['id1:pending', 'id1:read'])
  assert.equal(proposals.markRead('nope'), false)
  proposals.cancel('id1')
  assert.equal(proposals.markRead('id1'), false)
})

test('check: an unknown id, a closed one and one that is starting answer no such proposal', () => {
  const { proposals } = make()
  const none = { ok: false, reason: 'no such proposal' }
  assert.deepEqual(proposals.check('zzz', { spoken: false }), none)
  proposals.offer(P)
  assert.deepEqual(proposals.check('zzz', { spoken: false }), none)
  proposals.begin('id1')
  assert.deepEqual(proposals.check('id1', { spoken: false }), none, 'starting')
  proposals.settle('id1', 'started')
  assert.deepEqual(proposals.check('id1', { spoken: false }), none, 'started')
  proposals.offer(P)
  proposals.cancel('id2')
  assert.deepEqual(proposals.check('id2', { spoken: false }), none, 'cancelled')
})

test('check: a spoken confirmation of a pending proposal says it was not read aloud', () => {
  const { proposals } = make()
  proposals.offer(P)
  assert.deepEqual(proposals.check('id1', { spoken: true }), { ok: false, reason: NOT_READ })
})

test('check: a click passes while pending, and a spoken word passes once read', () => {
  const { proposals } = make()
  proposals.offer(P)
  const clicked = proposals.check('id1', { spoken: false })
  assert.equal(clicked.ok, true)
  assert.equal(clicked.proposal.id, 'id1')
  proposals.markRead('id1')
  assert.equal(proposals.check('id1', { spoken: true }).ok, true)
  assert.equal(proposals.check('id1', { spoken: false }).ok, true)
})

test('begin gives starting and stops the clock', () => {
  const { proposals, statuses, advance } = make({ seconds: 30 })
  proposals.offer(P)
  proposals.begin('id1')
  assert.equal(proposals.open, null, 'a starting proposal is not open')
  advance(60_000)
  assert.deepEqual(statuses(), ['id1:pending', 'id1:starting'], 'no expiry after begin')
})

test('settle gives started, or failed with its reason', () => {
  const a = make()
  a.proposals.offer(P)
  a.proposals.begin('id1')
  a.proposals.settle('id1', 'started')
  assert.equal(a.events.at(-1).status, 'started')
  const b = make()
  b.proposals.offer(P)
  b.proposals.begin('id1')
  b.proposals.settle('id1', 'failed', 'claude --bg failed (exit 1): Workspace not trusted.')
  assert.equal(b.events.at(-1).status, 'failed')
  assert.equal(b.events.at(-1).reason, 'claude --bg failed (exit 1): Workspace not trusted.')
})

test('cancel closes the open proposal, and another id is no such proposal', () => {
  const { proposals, statuses } = make()
  proposals.offer(P)
  assert.deepEqual(proposals.cancel('zzz'), { ok: false, reason: 'no such proposal' })
  assert.deepEqual(proposals.cancel('id1'), { ok: true })
  assert.deepEqual(statuses(), ['id1:pending', 'id1:cancelled'])
  assert.deepEqual(proposals.cancel('id1'), { ok: false, reason: 'no such proposal' })
})

test('a proposal expires seconds after it was offered, and nothing is open after', () => {
  const { proposals, statuses, advance } = make({ seconds: 120 })
  proposals.offer(P)
  advance(119_000)
  assert.equal(proposals.open.id, 'id1')
  advance(1000)
  assert.deepEqual(statuses(), ['id1:pending', 'id1:expired'])
  assert.equal(proposals.open, null)
})

test('markRead does not extend the time', () => {
  const { proposals, statuses, advance } = make({ seconds: 120 })
  proposals.offer(P)
  advance(100_000)
  proposals.markRead('id1')
  advance(10_000)
  assert.equal(proposals.open.status, 'read')
  advance(20_000)
  assert.deepEqual(statuses(), ['id1:pending', 'id1:read', 'id1:expired'])
})

test('a replaced proposal does not expire later, and the new one has its own clock', () => {
  const { proposals, statuses, advance } = make({ seconds: 100 })
  proposals.offer(P)
  advance(60_000)
  proposals.offer({ repo: 'dial', prompt: 'x' })
  advance(60_000)
  assert.deepEqual(statuses(), ['id1:pending', 'id1:replaced', 'id2:pending'])
  advance(40_000)
  assert.equal(statuses().at(-1), 'id2:expired')
})

test('open is null after every closing status', () => {
  for (const close of [
    p => p.cancel('id1'),
    p => { p.begin('id1'); p.settle('id1', 'started') },
    p => { p.begin('id1'); p.settle('id1', 'failed', 'why') }
  ]) {
    const { proposals } = make()
    proposals.offer(P)
    assert.notEqual(proposals.open, null)
    close(proposals)
    assert.equal(proposals.open, null)
  }
})

test('clear drops the open proposal with no event and no later expiry', () => {
  const { proposals, events, advance } = make({ seconds: 10 })
  proposals.offer(P)
  const before = events.length
  proposals.clear()
  assert.equal(proposals.open, null)
  advance(60_000)
  assert.equal(events.length, before)
})
