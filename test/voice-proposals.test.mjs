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
    now: clock.now,
    on: proposal => events.push({ ...proposal })
  })
  const statuses = () => events.map(e => `${e.id}:${e.status}`)
  return { proposals, events, statuses, advance: clock.advance }
}
const P = { repo: 'katipon', prompt: '/interlock:ship add-parser' }
const NOT_READ = 'the proposal was not read aloud; confirm it on screen'

// voice-sessions: "An open proposal's event says how long it has left". An open proposal now also holds `seconds` and
// `secondsLeft`, so the whole-object comparison of the event is re-pinned, and what `offer` returns is read by its own fields.
test('offer opens a pending proposal with the id newId returned, and sends it once with its time', () => {
  const { proposals, events } = make()
  const proposal = proposals.offer(P)
  assert.deepEqual(events, [{ id: 'id1', repo: 'katipon', prompt: '/interlock:ship add-parser', status: 'pending', seconds: 120, secondsLeft: 120 }])
  assert.deepEqual(
    { id: proposal.id, repo: proposal.repo, prompt: proposal.prompt, status: proposal.status },
    { id: 'id1', repo: 'katipon', prompt: '/interlock:ship add-parser', status: 'pending' }
  )
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

// voice-sessions: "An open proposal's event says how long it has left". `now` comes from `fakeTimers`.
const timeOf = o => ({ seconds: o.seconds, secondsLeft: o.secondsLeft })
const KEYS = ['seconds', 'secondsLeft']

test('a new proposal: pending with seconds 120 and secondsLeft 120', () => {
  const { proposals, events } = make({ seconds: 120 })
  proposals.offer(P)
  assert.equal(events[0].status, 'pending')
  assert.deepEqual(timeOf(events[0]), { seconds: 120, secondsLeft: 120 })
  assert.deepEqual(timeOf(proposals.open), { seconds: 120, secondsLeft: 120 })
})

test('seconds is the number the proposals were made with, not a fixed one', () => {
  const { proposals, events } = make({ seconds: 30 })
  proposals.offer(P)
  assert.deepEqual(timeOf(events[0]), { seconds: 30, secondsLeft: 30 })
})

test('read aloud later: the read event says 120 and 30 when the proposal became open 90 seconds ago', () => {
  const { proposals, events, advance } = make({ seconds: 120 })
  proposals.offer(P)
  advance(90_000)
  proposals.markRead('id1')
  assert.equal(events.at(-1).status, 'read')
  assert.deepEqual(timeOf(events.at(-1)), { seconds: 120, secondsLeft: 30 })
})

test('open gives the time left at the moment it is read, and the event already sent keeps its number', () => {
  const { proposals, events, advance } = make({ seconds: 120 })
  proposals.offer(P)
  advance(100_000)
  assert.deepEqual(timeOf(proposals.open), { seconds: 120, secondsLeft: 20 })
  assert.equal(events[0].secondsLeft, 120)
  advance(5_000)
  assert.deepEqual(timeOf(proposals.open), { seconds: 120, secondsLeft: 15 })
})

test('part of a second is rounded up: 99.5 seconds after it became open it has 21 seconds left', () => {
  const { proposals, advance } = make({ seconds: 120 })
  proposals.offer(P)
  advance(99_500)
  assert.equal(proposals.open.secondsLeft, 21)
  advance(500)
  assert.equal(proposals.open.secondsLeft, 20)
  advance(1)
  assert.equal(proposals.open.secondsLeft, 20)
  advance(999)
  assert.equal(proposals.open.secondsLeft, 19)
})

test('markRead does not extend the time that open reports', () => {
  const { proposals, advance } = make({ seconds: 120 })
  proposals.offer(P)
  advance(100_000)
  proposals.markRead('id1')
  advance(10_000)
  assert.deepEqual(timeOf(proposals.open), { seconds: 120, secondsLeft: 10 })
})

test('a closed proposal holds neither number, whichever status closed it', () => {
  for (const [name, close] of [
    ['starting', p => p.begin('id1')],
    ['started', p => { p.begin('id1'); p.settle('id1', 'started') }],
    ['failed', p => { p.begin('id1'); p.settle('id1', 'failed', 'why') }],
    ['cancelled', p => p.cancel('id1')],
    ['replaced', p => p.offer({ repo: 'dial', prompt: 'x' })],
    ['expired', (p, advance) => advance(120_000)]
  ]) {
    const { proposals, events, advance } = make({ seconds: 120 })
    proposals.offer(P)
    proposals.markRead('id1')
    close(proposals, advance)
    const closed = events.find(e => e.id === 'id1' && e.status === name)
    assert.ok(closed, name)
    for (const key of KEYS) assert.equal(Object.hasOwn(closed, key), false, `${name} holds ${key}`)
  }
})

test('every pending or read event holds both numbers and every other holds neither', () => {
  const { proposals, events, advance } = make({ seconds: 120 })
  proposals.offer(P)
  advance(10_000)
  proposals.markRead('id1')
  proposals.begin('id1')
  proposals.settle('id1', 'started')
  proposals.offer({ repo: 'dial', prompt: 'x' })
  proposals.offer({ repo: 'dial', prompt: 'y' })
  for (const e of events) {
    const open = e.status === 'pending' || e.status === 'read'
    for (const key of KEYS) assert.equal(Object.hasOwn(e, key), open, `${e.id}:${e.status} ${key}`)
  }
})
