import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { exec } from '../lib/subprocess.mjs'
import { fakeBinary, tmp } from './helpers.mjs'

test('a successful command returns its stdout', () => {
  const dir = tmp()
  const bin = fakeBinary(dir, 'hello', 'echo hi; echo "$PWD" >&2')
  const r = exec(bin, [], { cwd: dir })
  assert.equal(r.ok, true)
  assert.equal(r.code, 0)
  assert.equal(r.stdout, 'hi\n')
  assert.equal(r.missing, false)
})

test('a binary that sleeps past the timeout is ok: false and timedOut', () => {
  const dir = tmp()
  const bin = fakeBinary(dir, 'slow', 'exec sleep 5')
  const started = Date.now()
  const r = exec(bin, [], { timeoutMs: 200 })
  assert.equal(r.ok, false)
  assert.equal(r.timedOut, true)
  assert.equal(r.missing, false)
  assert.ok(Date.now() - started < 4000)
})

test('a non-zero exit is ok: false with its code and stderr', () => {
  const dir = tmp()
  const bin = fakeBinary(dir, 'bad', 'echo "fatal: nope" >&2; echo partial; exit 2')
  const r = exec(bin, [])
  assert.equal(r.ok, false)
  assert.equal(r.code, 2)
  assert.equal(r.stderr, 'fatal: nope\n')
  assert.equal(r.stdout, 'partial\n')
  assert.equal(r.missing, false)
  assert.equal(r.timedOut, false)
})

test('a missing binary is missing, not a throw', () => {
  const r = exec(join(tmp(), 'no-such-binary'), [])
  assert.equal(r.ok, false)
  assert.equal(r.missing, true)
  assert.equal(r.code, null)
})

test('env and args reach the child', () => {
  const dir = tmp()
  const bin = fakeBinary(dir, 'echoer', 'echo "$FOO $1"')
  const r = exec(bin, ['x'], { env: { PATH: process.env.PATH, FOO: 'bar' } })
  assert.equal(r.stdout, 'bar x\n')
})
