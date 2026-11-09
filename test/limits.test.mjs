import test from 'node:test'
import assert from 'node:assert/strict'
import { DESCRIPTIONS, LIMITS, effectiveLimits, formatLimits } from '../lib/limits.mjs'

const REG = '/tmp/home/registry.json'

test('three caps are published with the stated defaults, frozen', () => {
  assert.deepEqual({ ...LIMITS }, { staleDays: 14, archivedKeepDays: 30, briefLines: 40 })
  assert.ok(Object.isFrozen(LIMITS))
  assert.ok(Object.isFrozen(DESCRIPTIONS))
})

test('every cap has a one-line lowercase description and no other cap exists', () => {
  assert.deepEqual(Object.keys(DESCRIPTIONS), Object.keys(LIMITS))
  assert.equal(Object.keys(LIMITS).length, 3)
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
    assert.deepEqual({ ...out.limits }, { staleDays: 14, archivedKeepDays: 30, briefLines: 40 })
  }
})

test('an override replaces only the key it names', () => {
  const out = effectiveLimits({ staleDays: 7 }, REG)
  assert.equal(out.ok, true)
  assert.deepEqual({ ...out.limits }, { staleDays: 7, archivedKeepDays: 30, briefLines: 40 })
  assert.equal(LIMITS.staleDays, 14)
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
  assert.equal(lines.length, 3)
  const width = Math.max(...Object.keys(LIMITS).map(n => n.length))
  Object.keys(LIMITS).forEach((name, i) => {
    assert.match(lines[i], /^\S+\s+=\s+\d+  \S/)
    assert.equal(lines[i], `${name.padEnd(width)} = ${String(LIMITS[name]).padStart(9)}  ${DESCRIPTIONS[name]}`)
  })
})

test('formatLimits prints the values it is given', () => {
  const text = formatLimits({ staleDays: 7, archivedKeepDays: 30, briefLines: 40 })
  assert.match(text.split('\n')[0], /^staleDays\s+=\s+7  \S/)
})
