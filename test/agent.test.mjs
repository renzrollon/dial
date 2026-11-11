// lib/agent.mjs against specs/launch-agent: the plist, install, uninstall and status on a fake launchctl.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { exec } from '../lib/subprocess.mjs'
import { install, parsePlist, plist, plistPath, status, uninstall } from '../lib/agent.mjs'
import { fakeBinary, snapshotTree, tmp } from './helpers.mjs'

const UID = 501
const TARGET = `gui/${UID}/com.dial.sync`

/** A user home, a Dial home (not yet created), a fake launchctl logging its arguments, and the env for them. */
function setup({ launchctl = 'exit 0', extraEnv = {} } = {}) {
  const base = tmp('agent-')
  const userHome = join(base, 'user')
  const home = join(base, 'dial-home')
  mkdirSync(userHome, { recursive: true })
  const log = join(base, 'launchctl.log')
  const bin = fakeBinary(join(base, 'bin'), 'launchctl', `echo "$@" >> '${log}'\n${launchctl}`)
  const env = { HOME: userHome, DIAL_HOME: home, PATH: '/opt/homebrew/bin:/usr/bin', DIAL_LAUNCHCTL_BIN: bin, ...extraEnv }
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])
  const opts = (over = {}) => ({ env, uid: UID, platform: 'darwin', exec, ...over })
  return { base, userHome, home, env, calls, opts, plist: plistPath(userHome) }
}

test('plist: label, interval, run at load, the sync command and the log paths', () => {
  const text = plist({ node: '/usr/local/bin/node', dial: '/x/bin/dial.mjs', home: '/Users/caro/.config/dial', path: '/usr/bin', intervalMinutes: 15 })
  const p = parsePlist(text)
  assert.equal(p.label, 'com.dial.sync')
  assert.equal(p.startInterval, 900)
  assert.equal(p.runAtLoad, true)
  assert.deepEqual(p.program.slice(0, 2), ['/bin/sh', '-c'])
  assert.ok(p.program[2].endsWith('sync --all --due-remote'))
  assert.equal(p.program[2], "exec '/usr/local/bin/node' '/x/bin/dial.mjs' sync --all --due-remote")
  assert.equal(p.stdout, '/Users/caro/.config/dial/logs/agent.out.log')
  assert.equal(p.stderr, '/Users/caro/.config/dial/logs/agent.err.log')
})

test('plist: a five minute interval is 300 seconds', () => {
  assert.equal(parsePlist(plist({ home: '/h', intervalMinutes: 5 })).startInterval, 300)
})

test('plist: only DIAL_HOME and PATH are in the environment', () => {
  const s = setup({ extraEnv: { GH_TOKEN: 'x' } })
  assert.equal(install(s.opts()).ok, true)
  const text = readFileSync(s.plist, 'utf8')
  assert.deepEqual(Object.keys(parsePlist(text).env), ['DIAL_HOME', 'PATH'])
  assert.equal(parsePlist(text).env.DIAL_HOME, s.home)
  assert.equal(parsePlist(text).env.PATH, '/opt/homebrew/bin:/usr/bin')
  assert.ok(!text.includes('GH_TOKEN'))
})

test('plist: a path with & and < round-trips and is escaped', () => {
  const text = plist({ node: "/a&b/no'de", dial: '/c<d/dial.mjs', home: '/h&h', path: '/a&b<c', intervalMinutes: 15 })
  assert.ok(text.includes('/a&amp;b&lt;c'))
  const p = parsePlist(text)
  assert.equal(p.env.PATH, '/a&b<c')
  assert.equal(p.env.DIAL_HOME, '/h&h')
  assert.equal(p.node, "/a&b/no'de")
  assert.equal(p.dial, '/c<d/dial.mjs')
  const lint = spawnSync('/usr/bin/plutil', ['-lint', '-'], { input: text, encoding: 'utf8' })
  if (!lint.error) assert.equal(lint.status, 0, lint.stdout + lint.stderr)
})

test('install: creates the home and logs, writes the plist, boots out then bootstraps', () => {
  const s = setup()
  const r = install(s.opts())
  assert.equal(r.ok, true)
  assert.equal(r.plistPath, s.plist)
  assert.ok(existsSync(join(s.home, 'logs')))
  assert.ok(existsSync(s.plist))
  assert.deepEqual(s.calls(), [`bootout ${TARGET}`, `bootstrap gui/${UID} ${s.plist}`])
})

test('install: the interval comes from the caller', () => {
  const s = setup()
  install(s.opts({ intervalMinutes: 5 }))
  assert.equal(parsePlist(readFileSync(s.plist, 'utf8')).startInterval, 300)
})

test('install: a reinstall rewrites the plist and boots out first', () => {
  const s = setup()
  install(s.opts())
  writeFileSync(s.plist, 'stale')
  assert.equal(install(s.opts()).ok, true)
  assert.equal(parsePlist(readFileSync(s.plist, 'utf8')).label, 'com.dial.sync')
  assert.deepEqual(s.calls().map(c => c.split(' ')[0]), ['bootout', 'bootstrap', 'bootout', 'bootstrap'])
})

test('install: a failing bootout is ignored', () => {
  const s = setup({ launchctl: 'case "$1" in bootout) exit 5;; esac' })
  assert.equal(install(s.opts()).ok, true)
})

test('install: a refused bootstrap removes the plist and names the first stderr line', () => {
  const s = setup({ launchctl: 'case "$1" in bootstrap) echo "Bootstrap failed: 5: Input/output error" >&2; echo more >&2; exit 5;; esac' })
  const r = install(s.opts())
  assert.deepEqual(r, { ok: false, reason: 'launchctl bootstrap failed: Bootstrap failed: 5: Input/output error' })
  assert.equal(existsSync(s.plist), false)
})

test('install: an unwritable home fails before any plist write or launchctl call', () => {
  const s = setup()
  writeFileSync(s.home, 'a file where the home should be')
  const r = install(s.opts())
  assert.equal(r.ok, false)
  assert.match(r.reason, /^dial home is not writable: /)
  assert.equal(existsSync(s.plist), false)
  assert.deepEqual(s.calls(), [])
})

test('every subcommand refuses off darwin without touching a file', () => {
  const s = setup()
  const before = snapshotTree(s.base)
  for (const [name, fn] of [['install', install], ['uninstall', uninstall], ['status', status]]) {
    assert.deepEqual(fn(s.opts({ platform: 'linux' })), { ok: false, reason: `agent ${name} is macOS only` })
  }
  assert.deepEqual(snapshotTree(s.base), before)
  assert.equal(existsSync(s.home), false)
})

test('DIAL_LAUNCHCTL_BIN is run, and blank falls back to /bin/launchctl', () => {
  const s = setup()
  mkdirSync(join(s.userHome, 'Library', 'LaunchAgents'), { recursive: true })
  writeFileSync(s.plist, plist({ home: s.home, node: process.execPath, dial: process.execPath }))
  status(s.opts())
  assert.deepEqual(s.calls(), [`print ${TARGET}`])
  const seen = []
  status(s.opts({ env: { ...s.env, DIAL_LAUNCHCTL_BIN: '  ' }, exec: (file, args) => (seen.push(file), { ok: false, code: 113, stdout: '', stderr: '' }) }))
  assert.deepEqual(seen, ['/bin/launchctl'])
})

function installed(s) {
  mkdirSync(join(s.userHome, 'Library', 'LaunchAgents'), { recursive: true })
  writeFileSync(s.plist, plist({ home: s.home, node: process.execPath, dial: process.execPath, path: '/usr/bin' }))
}

test('uninstall: boots out, removes the plist, keeps the logs', () => {
  const s = setup()
  install(s.opts())
  writeFileSync(join(s.home, 'logs', 'agent.out.log'), 'keep')
  const r = uninstall(s.opts())
  assert.deepEqual(r, { ok: true, removed: true, plistPath: s.plist })
  assert.equal(existsSync(s.plist), false)
  assert.equal(readFileSync(join(s.home, 'logs', 'agent.out.log'), 'utf8'), 'keep')
})

test('uninstall: exit 113 is success and the plist is removed', () => {
  const s = setup({ launchctl: 'exit 113' })
  installed(s)
  const r = uninstall(s.opts())
  assert.equal(r.ok, true)
  assert.equal(r.removed, true)
  assert.equal(existsSync(s.plist), false)
})

test('uninstall: exit 3 with nothing installed is not installed', () => {
  const s = setup({ launchctl: 'exit 3' })
  assert.deepEqual(uninstall(s.opts()), { ok: true, removed: false, plistPath: s.plist })
})

test('uninstall: another bootout failure is refused and the plist stays', () => {
  const s = setup({ launchctl: 'echo "boom" >&2; exit 1' })
  installed(s)
  assert.deepEqual(uninstall(s.opts()), { ok: false, reason: 'launchctl bootout failed: boom' })
  assert.ok(existsSync(s.plist))
})

test('status: not-installed without a plist', () => {
  const s = setup()
  const r = status(s.opts())
  assert.equal(r.outcome, 'not-installed')
  assert.equal(r.exitCode, 1)
  assert.ok(r.text.includes('fix: dial agent install'))
  assert.deepEqual(s.calls(), [])
})

test('status: running with the pid', () => {
  const s = setup({ launchctl: 'echo "\tstate = running"; echo "\tpid = 4242"' })
  installed(s)
  const r = status(s.opts())
  assert.equal(r.outcome, 'running')
  assert.equal(r.pid, 4242)
  assert.equal(r.exitCode, 0)
  assert.ok(r.text.startsWith('agent: running (pid 4242)'))
})

test('status: loaded but not running suggests a kickstart', () => {
  const s = setup({ launchctl: 'echo "\tstate = not running"' })
  installed(s)
  const r = status(s.opts())
  assert.equal(r.outcome, 'loaded-not-running')
  assert.equal(r.exitCode, 1)
  assert.ok(r.text.includes(`fix: launchctl kickstart -k ${TARGET}`))
})

test('status: not-loaded when print fails', () => {
  const s = setup({ launchctl: 'exit 113' })
  installed(s)
  const r = status(s.opts())
  assert.equal(r.outcome, 'not-loaded')
  assert.equal(r.exitCode, 1)
  assert.ok(r.text.includes('fix: dial agent install'))
})

test('status: paths-missing names the moved node binary and does not ask launchctl', () => {
  const s = setup()
  mkdirSync(join(s.userHome, 'Library', 'LaunchAgents'), { recursive: true })
  writeFileSync(s.plist, plist({ home: s.home, node: '/gone/bin/node', dial: process.execPath }))
  const r = status(s.opts())
  assert.equal(r.outcome, 'paths-missing')
  assert.equal(r.exitCode, 1)
  assert.deepEqual(r.missing, ['/gone/bin/node'])
  assert.ok(r.text.includes('/gone/bin/node'))
  assert.ok(r.text.includes('fix: dial agent install'))
  assert.deepEqual(s.calls(), [])
})

test('status: the fields the JSON form needs are present', () => {
  const s = setup({ launchctl: 'echo "state = running"; echo "pid = 7"' })
  installed(s)
  const r = status(s.opts())
  assert.equal(r.label, 'com.dial.sync')
  assert.equal(r.plistPath, s.plist)
  assert.equal(r.pid, 7)
})
