import test from 'node:test'
import assert from 'node:assert/strict'
import { DESCRIPTIONS, LIMITS, effectiveLimits, formatLimits } from '../lib/limits.mjs'

const REG = '/tmp/home/registry.json'

// Pins specs/limits/spec.md, "Every cap is published with a default and a description"
// (add-dial-ask delta): thirteen caps in this order with these defaults.
const TEN = {
  staleDays: 14,
  archivedKeepDays: 30,
  briefLines: 40,
  subprocessTimeoutSeconds: 10,
  remoteIntervalMinutes: 30,
  syncIntervalMinutes: 15,
  narrateTurns: 20,
  narrateTimeoutSeconds: 30,
  nextRows: 50,
  watchPollSeconds: 30
}
const NEW_CAPS = { remotePullRequests: 20, contextNarrative: 5, contextLines: 200 }
const THIRTEEN = { ...TEN, ...NEW_CAPS }

test('thirteen caps are published with the stated defaults in the published order, frozen (limits: Every cap is published with a default and a description)', () => {
  assert.deepEqual({ ...LIMITS }, THIRTEEN)
  assert.deepEqual(Object.keys(LIMITS), Object.keys(THIRTEEN))
  assert.ok(Object.isFrozen(LIMITS))
  assert.ok(Object.isFrozen(DESCRIPTIONS))
})

test('every cap has a one-line lowercase description and no other cap exists', () => {
  assert.deepEqual(Object.keys(DESCRIPTIONS), Object.keys(LIMITS))
  assert.equal(Object.keys(LIMITS).length, 13)
  for (const [name, text] of Object.entries(DESCRIPTIONS)) {
    assert.equal(typeof text, 'string', name)
    assert.match(text, /^[a-z]/, name)
    assert.ok(!text.includes('\n'), name)
  }
})

test('effectiveLimits with no overrides returns the defaults', () => {
  for (const overrides of [undefined, null, {}]) {
    const out = effectiveLimits(overrides, REG)
    assert.equal(out.ok, true)
    assert.deepEqual({ ...out.limits }, THIRTEEN)
  }
})

test('an override replaces only the key it names, the other twelve keep their defaults (limits: Override is reflected)', () => {
  const out = effectiveLimits({ staleDays: 7 }, REG)
  assert.equal(out.ok, true)
  assert.deepEqual({ ...out.limits }, { ...THIRTEEN, staleDays: 7 })
  assert.equal(LIMITS.staleDays, 14)
})

test('the seven new caps can be overridden and a bad value for one is refused naming it (limits: The registry overrides a cap)', () => {
  const out = effectiveLimits({ nextRows: 10, syncIntervalMinutes: 5 }, REG)
  assert.equal(out.ok, true)
  assert.deepEqual({ ...out.limits }, { ...THIRTEEN, nextRows: 10, syncIntervalMinutes: 5 })
  const bad = effectiveLimits({ watchPollSeconds: -30 }, REG)
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /watchPollSeconds/)
  assert.match(bad.reason, /positive integer/)
})

test('an unknown cap key is refused, quoted as written, naming the file', () => {
  const out = effectiveLimits({ coffeeBreaks: 3 }, REG)
  assert.equal(out.ok, false)
  assert.equal(out.reason, `registry limits: unknown cap coffeeBreaks in ${REG}`)
})

test('a non-positive or non-integer value is refused naming the key and requiring a positive integer', () => {
  for (const bad of [0, -1, 1.5, '40', null, NaN, true]) {
    const out = effectiveLimits({ briefLines: bad }, REG)
    assert.equal(out.ok, false, String(bad))
    assert.match(out.reason, /briefLines/, String(bad))
    assert.match(out.reason, /positive integer/, String(bad))
    assert.ok(out.reason.includes(REG), String(bad))
  }
})

test('formatLimits prints one aligned line per cap with a trailing newline', () => {
  const text = formatLimits(LIMITS)
  assert.ok(text.endsWith('\n'))
  const lines = text.slice(0, -1).split('\n')
  assert.equal(lines.length, 13)
  const width = Math.max(...Object.keys(LIMITS).map(n => n.length))
  Object.keys(LIMITS).forEach((name, i) => {
    assert.match(lines[i], /^\S+\s+=\s+\d+  \S/)
    assert.equal(lines[i], `${name.padEnd(width)} = ${String(LIMITS[name]).padStart(9)}  ${DESCRIPTIONS[name]}`)
  })
})

test('formatLimits prints the values it is given', () => {
  const text = formatLimits({ ...THIRTEEN, staleDays: 7 })
  assert.match(text.split('\n')[0], /^staleDays\s+=\s+7  \S/)
})

// limits: "The new caps say what they bound" (add-dial-ask delta).
test('the three new caps are appended last, with their defaults and the descriptions the spec words', () => {
  assert.deepEqual(Object.keys(LIMITS).slice(-3), ['remotePullRequests', 'contextNarrative', 'contextLines'])
  assert.equal(LIMITS.remotePullRequests, 20)
  assert.equal(LIMITS.contextNarrative, 5)
  assert.equal(LIMITS.contextLines, 200)
  assert.equal(DESCRIPTIONS.remotePullRequests, 'open pull requests kept per repo by a remote sync')
  assert.equal(DESCRIPTIONS.contextNarrative, 'narrative entries dial context prints')
  assert.equal(DESCRIPTIONS.contextLines, 'maximum lines dial context prints as text')
})

test('formatLimits ends the three new lines with their descriptions', () => {
  const lines = formatLimits(LIMITS).slice(0, -1).split('\n')
  assert.ok(lines[10].startsWith('remotePullRequests') && lines[10].endsWith('open pull requests kept per repo by a remote sync'))
  assert.ok(lines[11].startsWith('contextNarrative') && lines[11].endsWith('narrative entries dial context prints'))
  assert.ok(lines[12].startsWith('contextLines') && lines[12].endsWith('maximum lines dial context prints as text'))
})

test('the context caps can be overridden and every other cap keeps its default (limits: Override of a context cap)', () => {
  const out = effectiveLimits({ remotePullRequests: 5, contextLines: 80 }, REG)
  assert.equal(out.ok, true)
  assert.deepEqual({ ...out.limits }, { ...THIRTEEN, remotePullRequests: 5, contextLines: 80 })
  assert.deepEqual(Object.keys(out.limits), Object.keys(THIRTEEN))
  const bad = effectiveLimits({ contextNarrative: 0 }, REG)
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /contextNarrative/)
  assert.match(bad.reason, /positive integer/)
})
