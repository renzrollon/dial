import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { HomeUnwritable, ensureHome, resolveHome } from '../lib/home.mjs'
import { snapshotTree, tmp } from './helpers.mjs'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

test('default home is <user home>/.config/dial when DIAL_HOME is unset', () => {
  assert.equal(resolveHome({}), join(homedir(), '.config', 'dial'))
})

test('tilde expansion: ~/x and a bare ~ resolve against the user home', () => {
  assert.equal(resolveHome({ DIAL_HOME: '~/dial-state' }), join(homedir(), 'dial-state'))
  assert.equal(resolveHome({ DIAL_HOME: '~' }), homedir())
})

test('blank DIAL_HOME is the same as unset', () => {
  assert.equal(resolveHome({ DIAL_HOME: '   ' }), join(homedir(), '.config', 'dial'))
  assert.equal(resolveHome({ DIAL_HOME: '' }), join(homedir(), '.config', 'dial'))
})

test('an absolute value is used as written, a relative one resolves against the cwd', () => {
  assert.equal(resolveHome({ DIAL_HOME: '/x/y' }), '/x/y')
  assert.equal(resolveHome({ DIAL_HOME: '  /x/y  ' }), '/x/y')
  assert.equal(resolveHome({ DIAL_HOME: 'rel/home' }), resolve('rel/home'))
})

test('first ensureHome creates the home and logs/', () => {
  const root = join(tmp(), 'home')
  const layout = ensureHome({ DIAL_HOME: root })
  assert.equal(layout.root, root)
  assert.equal(layout.logs, join(root, 'logs'))
  assert.ok(statSync(root).isDirectory())
  assert.ok(statSync(join(root, 'logs')).isDirectory())
})

test('ensureHome leaves no probe file behind', () => {
  const root = join(tmp(), 'home')
  ensureHome({ DIAL_HOME: root })
  assert.deepEqual(readdirSync(root).sort(), ['logs'])
  assert.deepEqual(readdirSync(join(root, 'logs')), [])
})

test('ensuring twice is byte-identical', () => {
  const root = join(tmp(), 'home')
  ensureHome({ DIAL_HOME: root })
  writeFileSync(join(root, 'registry.json'), '{}\n')
  const before = snapshotTree(root)
  const again = ensureHome({ DIAL_HOME: root })
  assert.equal(again.root, root)
  assert.deepEqual(snapshotTree(root), before)
})

test('a home under a read-only directory throws HomeUnwritable naming the path and the OS code', { skip: isRoot ? 'root ignores mode bits' : false }, () => {
  const parent = tmp()
  chmodSync(parent, 0o555)
  const root = join(parent, 'home')
  try {
    assert.throws(
      () => ensureHome({ DIAL_HOME: root }),
      err => {
        assert.ok(err instanceof HomeUnwritable)
        assert.equal(err.name, 'HomeUnwritable')
        assert.equal(err.path, root)
        assert.equal(err.code, 'EACCES')
        assert.equal(err.message, `dial home is not writable: ${root} (EACCES: ${err.cause.message})`)
        return true
      }
    )
    assert.ok(!existsSync(root))
  } finally {
    chmodSync(parent, 0o755)
  }
})

test('an existing home that cannot be written fails the probe with the OS code', { skip: isRoot ? 'root ignores mode bits' : false }, () => {
  const root = tmp()
  mkdirSync(join(root, 'logs'))
  chmodSync(root, 0o555)
  try {
    assert.throws(
      () => ensureHome({ DIAL_HOME: root }),
      err => {
        assert.ok(err instanceof HomeUnwritable)
        assert.equal(err.path, root)
        assert.equal(err.code, 'EACCES')
        assert.match(err.message, /EACCES/)
        return true
      }
    )
    assert.deepEqual(readdirSync(root), ['logs'])
  } finally {
    chmodSync(root, 0o755)
  }
})

test('a home that is a regular file throws HomeUnwritable naming that path', () => {
  const file = join(tmp(), 'not-a-dir')
  writeFileSync(file, 'x')
  assert.throws(
    () => ensureHome({ DIAL_HOME: file }),
    err => {
      assert.ok(err instanceof HomeUnwritable)
      assert.equal(err.path, file)
      assert.ok(err.message.includes(file))
      assert.match(err.message, /^dial home is not writable: /)
      return true
    }
  )
})

test('no fallback: an unusable home is never replaced by a second location', () => {
  const file = join(tmp(), 'not-a-dir')
  writeFileSync(file, 'x')
  const env = { DIAL_HOME: file }
  assert.equal(resolveHome(env), file)
  assert.throws(() => ensureHome(env), HomeUnwritable)
  assert.equal(resolveHome(env), file)
})
