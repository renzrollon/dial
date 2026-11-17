import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { KILL_GRACE_MS, findOnPath, spawnChild } from '../lib/spawn.mjs'
import { fakeBinary, tmp } from './helpers.mjs'

const SH = '/bin/sh'
const ENV = { PATH: process.env.PATH }
const T = { timeout: 15_000 }

// Every pid a test learns of is killed at the end, so a failing run leaves nothing behind.
const stray = new Set()
after(() => {
  for (const pid of stray) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function until(fn, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await sleep(10)
  }
  assert.fail('timed out waiting for a condition')
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

const groupAlive = pgid => alive(-pgid)

/** Start a child and gather what it reports. `exited` settles with the one `onExit` result. */
function run(file, args = [], opts = {}) {
  const r = { lines: [], events: [], exits: [], t: {} }
  r.exited = new Promise(resolve => {
    r.child = spawnChild(file, args, {
      env: ENV,
      ...opts,
      onLine: line => {
        r.lines.push(line)
        r.events.push(`line:${line}`)
      },
      onExit: result => {
        r.t.exit = performance.now()
        r.exits.push(result)
        r.events.push('exit')
        r.atExit = { group: r.child?.pid ? groupAlive(r.child.pid) : false }
        resolve(result)
      },
    })
    stray.add(r.child.pid)
  })
  return r
}

const sh = (script, opts) => run(SH, ['-c', script], opts)

test('KILL_GRACE_MS is 2000', () => {
  assert.equal(KILL_GRACE_MS, 2000)
})

test('lines arrive in order without their newline', T, async () => {
  const r = sh('printf "a\\nb\\n\\nc\\n"')
  await r.exited
  assert.deepEqual(r.lines, ['a', 'b', '', 'c'])
})

test('a line split across two writes arrives once', T, async () => {
  const r = sh('printf "he"; sleep 0.2; printf "llo\\n"')
  await r.exited
  assert.deepEqual(r.lines, ['hello'])
})

test('a last line with no newline arrives before onExit', T, async () => {
  const r = sh('printf "a\\nlast"')
  await r.exited
  assert.deepEqual(r.events, ['line:a', 'line:last', 'exit'])
})

test('write reaches the stdin of the child and end closes it', T, async () => {
  const r = run('cat')
  assert.equal(r.child.write('one\n'), true)
  assert.equal(r.child.write('two\nthr'), true)
  await until(() => r.lines.length === 2)
  assert.deepEqual(r.lines, ['one', 'two'])
  assert.equal(r.exits.length, 0)
  r.child.end()
  const exit = await r.exited
  assert.deepEqual(r.lines, ['one', 'two', 'thr'])
  assert.equal(exit.code, 0)
  assert.equal(r.child.write('late'), false)
})

test('onExit fires once with the exit code and the stderr text', T, async () => {
  const r = sh('echo oops >&2; echo more >&2; exit 3')
  const exit = await r.exited
  await sleep(100)
  assert.equal(r.exits.length, 1)
  assert.equal(exit.code, 3)
  assert.equal(exit.signal, null)
  assert.equal(exit.stderr, 'oops\nmore\n')
  assert.equal(exit.error, null)
})

test('onExit carries the signal of a killed child', T, async () => {
  const r = run('sleep', ['30'])
  r.child.kill()
  const exit = await r.exited
  assert.equal(exit.signal, 'SIGTERM')
  assert.equal(exit.code, null)
  await sleep(100)
  assert.equal(r.exits.length, 1)
})

test('a missing program gives error.code ENOENT, no code, no signal, and throws nothing', T, async () => {
  let r
  assert.doesNotThrow(() => {
    r = run('/nonexistent/dial-no-such-program', ['x'])
  })
  const exit = await r.exited
  assert.equal(exit.error.code, 'ENOENT')
  assert.equal(typeof exit.error.message, 'string')
  assert.equal(exit.code, null)
  assert.equal(exit.signal, null)
  assert.equal(r.exits.length, 1)
  assert.equal(r.child.write('x'), false)
  assert.doesNotThrow(() => {
    r.child.end()
    r.child.kill()
    r.child.kill()
  })
  await sleep(50)
  assert.equal(r.exits.length, 1)
})

test('kill on a child that exits on SIGTERM does not wait for the grace period', T, async () => {
  const r = run('sleep', ['30'], { killGraceMs: 5000 })
  const t0 = performance.now()
  r.child.kill()
  const exit = await r.exited
  assert.ok(performance.now() - t0 < 2000, 'returned before the grace period')
  assert.equal(exit.signal, 'SIGTERM')
})

test('kill on a child that ignores SIGTERM ends it by SIGKILL no sooner than killGraceMs', T, async () => {
  const r = sh("trap '' TERM; echo ready; while :; do sleep 0.05; done", { killGraceMs: 200 })
  await until(() => r.lines.includes('ready'))
  const t0 = performance.now()
  r.child.kill()
  const exit = await r.exited
  assert.equal(exit.signal, 'SIGKILL')
  assert.ok(r.t.exit - t0 >= 199, `ended ${r.t.exit - t0} ms after kill`)
  assert.ok(r.t.exit - t0 < 5000)
})

test('kill twice is safe and onExit still fires once', T, async () => {
  const r = run('sleep', ['30'])
  assert.doesNotThrow(() => {
    r.child.kill()
    r.child.kill()
  })
  await r.exited
  assert.doesNotThrow(() => r.child.kill())
  await sleep(100)
  assert.equal(r.exits.length, 1)
})

test('write returns false after exit, after end and after kill', T, async () => {
  const done = sh('exit 0')
  await done.exited
  assert.equal(done.child.write('x'), false)

  const ended = run('cat')
  assert.equal(ended.child.write('a\n'), true)
  ended.child.end()
  assert.equal(ended.child.write('b\n'), false)
  await ended.exited
  assert.deepEqual(ended.lines, ['a'])

  const killed = run('sleep', ['30'])
  killed.child.kill()
  assert.equal(killed.child.write('x'), false)
  await killed.exited
})

test('cwd and env reach the child', T, async () => {
  const dir = realpathSync(tmp('spawn-cwd-'))
  const r = sh('pwd; echo "$DIAL_SPAWN_X"', { cwd: dir, env: { ...ENV, DIAL_SPAWN_X: 'from-env' } })
  await r.exited
  assert.deepEqual(r.lines, [dir, 'from-env'])
})

test('the child leads its own process group', T, async () => {
  const r = sh('echo ready; sleep 30')
  await until(() => r.lines.includes('ready'))
  assert.ok(r.child.pid > 0)
  // A group whose id is the child's pid exists only if the child leads one.
  assert.equal(groupAlive(r.child.pid), true)
  assert.notEqual(r.child.pid, process.pid)
  r.child.kill()
  await r.exited
})

test('kill on a child that started a grandchild ends the grandchild too', T, async () => {
  const r = sh('sleep 30 & echo $!; wait')
  await until(() => r.lines.length === 1)
  const grandchild = Number(r.lines[0])
  stray.add(grandchild)
  assert.equal(alive(grandchild), true)
  r.child.kill()
  await r.exited
  // onExit after kill() comes only once the group is empty or was sent SIGKILL; here SIGTERM sufficed.
  assert.equal(r.atExit.group, false)
  await until(() => !alive(grandchild), 2000)
})

test('kill sends the group SIGKILL after killGraceMs to a grandchild that ignores SIGTERM', T, async () => {
  const dir = tmp('spawn-bin-')
  const stubborn = fakeBinary(dir, 'stubborn', "trap '' TERM\necho $$\nwhile :; do sleep 0.05; done")
  const parent = fakeBinary(dir, 'parent', `${stubborn} &\nwait`)
  const r = run(parent, [], { killGraceMs: 200 })
  await until(() => r.lines.length === 1)
  const grandchild = Number(r.lines[0])
  stray.add(grandchild)
  await sleep(100)
  const t0 = performance.now()
  r.child.kill()
  await r.exited
  // The parent died of SIGTERM at once, but onExit waits for the group: not before the SIGKILL at 200 ms.
  assert.ok(r.t.exit - t0 >= 199, `onExit ${r.t.exit - t0} ms after kill`)
  await until(() => !alive(grandchild), 2000)
})

test('kill after the child exited by itself ends a grandchild it left behind', T, async () => {
  const r = sh('sleep 30 </dev/null >/dev/null 2>&1 &\necho $!\nexit 0')
  const exit = await r.exited
  assert.equal(exit.code, 0)
  const grandchild = Number(r.lines[0])
  stray.add(grandchild)
  assert.equal(alive(grandchild), true)
  r.child.kill()
  await until(() => !alive(grandchild), 3000)
  assert.equal(r.exits.length, 1)
})

test('onExit after kill comes only once the group is empty', T, async () => {
  const r = sh('sleep 30 & sleep 30 & echo ready; wait')
  await until(() => r.lines.includes('ready'))
  r.child.kill()
  await r.exited
  assert.equal(r.atExit.group, false)
})

function bin(dir, name, mode = 0o755) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, mode)
  return file
}

test('findOnPath finds an executable file and returns its absolute path', () => {
  const dir = tmp('path-')
  const file = bin(dir, 'tool')
  assert.equal(findOnPath({ PATH: dir }, 'tool'), file)
})

test('findOnPath skips a directory of that name', () => {
  const a = tmp('path-a-')
  const b = tmp('path-b-')
  mkdirSync(join(a, 'tool'))
  const file = bin(b, 'tool')
  assert.equal(findOnPath({ PATH: `${a}:${b}` }, 'tool'), file)
  assert.equal(findOnPath({ PATH: a }, 'tool'), null)
})

test('findOnPath skips a file without the execute bit', () => {
  const a = tmp('path-a-')
  const b = tmp('path-b-')
  bin(a, 'tool', 0o644)
  const file = bin(b, 'tool')
  assert.equal(findOnPath({ PATH: `${a}:${b}` }, 'tool'), file)
  assert.equal(findOnPath({ PATH: a }, 'tool'), null)
})

test('findOnPath returns the first of two matches', () => {
  const a = tmp('path-a-')
  const b = tmp('path-b-')
  const first = bin(a, 'tool')
  bin(b, 'tool')
  assert.equal(findOnPath({ PATH: `${a}:${b}` }, 'tool'), first)
})

test('findOnPath returns null for no match, an empty PATH and a missing PATH', () => {
  const dir = tmp('path-')
  bin(dir, 'other')
  assert.equal(findOnPath({ PATH: dir }, 'tool'), null)
  assert.equal(findOnPath({ PATH: '' }, 'tool'), null)
  assert.equal(findOnPath({}, 'tool'), null)
})
