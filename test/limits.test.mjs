import test from 'node:test'
import assert from 'node:assert/strict'
import { DESCRIPTIONS, LIMITS, effectiveLimits, formatLimits } from '../lib/limits.mjs'

const REG = '/tmp/home/registry.json'

// Pins specs/limits/spec.md, "Every cap is published with a default and a description":
// ten caps in this order with these defaults.
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

test('ten caps are published with the stated defaults in the published order, frozen (limits: Every cap is published with a default and a description)', () => {
  assert.deepEqual({ ...LIMITS }, TEN)
  assert.deepEqual(Object.keys(LIMITS), Object.keys(TEN))
  assert.ok(Object.isFrozen(LIMITS))
  assert.ok(Object.isFrozen(DESCRIPTIONS))
})

test('every cap has a one-line lowercase description and no other cap exists', () => {
  assert.deepEqual(Object.keys(DESCRIPTIONS), Object.keys(LIMITS))
  assert.equal(Object.keys(LIMITS).length, 10)
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
    assert.deepEqual({ ...out.limits }, TEN)
  }
})

test('an override replaces only the key it names', () => {
  const out = effectiveLimits({ staleDays: 7 }, REG)
  assert.equal(out.ok, true)
  assert.deepEqual({ ...out.limits }, { ...TEN, staleDays: 7 })
  assert.equal(LIMITS.staleDays, 14)
})

test('the seven new caps can be overridden and a bad value for one is refused naming it (limits: The registry overrides a cap)', () => {
  const out = effectiveLimits({ nextRows: 10, syncIntervalMinutes: 5 }, REG)
  assert.equal(out.ok, true)
  assert.deepEqual({ ...out.limits }, { ...TEN, nextRows: 10, syncIntervalMinutes: 5 })
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
  assert.equal(lines.length, 10)
  const width = Math.max(...Object.keys(LIMITS).map(n => n.length))
  Object.keys(LIMITS).forEach((name, i) => {
    assert.match(lines[i], /^\S+\s+=\s+\d+  \S/)
    assert.equal(lines[i], `${name.padEnd(width)} = ${String(LIMITS[name]).padStart(9)}  ${DESCRIPTIONS[name]}`)
  })
})

test('formatLimits prints the values it is given', () => {
  const text = formatLimits({ ...TEN, staleDays: 7 })
  assert.match(text.split('\n')[0], /^staleDays\s+=\s+7  \S/)
})
