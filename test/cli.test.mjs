/**
 * The binary as a subprocess. Every run gets a temp DIAL_HOME and, where the
 * stored path matters, a temp HOME so `~` collapses against a directory the
 * test owns.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BIN, makeGitDir, makeHome, readJson, runCli, snapshotTree, tmp, writeJson } from './helpers.mjs'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const VERSION = readJson(join(dirname(BIN), '..', 'package.json')).version
const COMMANDS = ['version', 'limits', 'doctor', 'register', 'unregister', 'repos', 'help']

/** A home with a registry declaring two vaults, plus a fake user home to hold repos. */
function setup({ limits, repos = [] } = {}) {
  const vaults = { personal: tmp('vault-personal-'), work: tmp('vault-work-') }
  const registry = { dial_schema: 'dial.registry/1', vaults, repos, limits: limits || {} }
  const home = makeHome({ registry })
  const userHome = tmp('user-home-')
  return { home, userHome, vaults, env: { DIAL_HOME: home, HOME: userHome }, file: join(home, 'registry.json') }
}

function repoIn(userHome, ...segments) {
  return makeGitDir(join(userHome, ...segments))
}

/** stderr is exactly one `dial: ` line, newline-terminated, no stack trace. */
function assertOneLine(stderr) {
  assert.ok(stderr.endsWith('\n'), `stderr should end with a newline: ${JSON.stringify(stderr)}`)
  assert.equal(stderr.slice(0, -1).split('\n').length, 1, `stderr should be one line: ${JSON.stringify(stderr)}`)
  assert.match(stderr, /^dial: /)
  assert.ok(!/\n\s+at /.test(stderr) && !/^\s+at /m.test(stderr), 'no stack trace')
}

// --- usage ------------------------------------------------------------------

test('bare invocation prints usage to stdout, nothing to stderr, exit 0', async () => {
  const r = await runCli([], { DIAL_HOME: makeHome() })
  assert.equal(r.code, 0)
  assert.equal(r.stderr, '')
  assert.match(r.stdout, /^dial — \S/)
})

test('help prints usage and exits 0', async () => {
  const bare = await runCli([], { DIAL_HOME: makeHome() })
  const r = await runCli(['help'], { DIAL_HOME: makeHome() })
  assert.equal(r.code, 0)
  assert.equal(r.stderr, '')
  assert.equal(r.stdout, bare.stdout)
})

test('--help after a command prints usage and exits 0', async () => {
  const bare = await runCli([], { DIAL_HOME: makeHome() })
  const r = await runCli(['repos', '--help'], { DIAL_HOME: makeHome() })
  assert.equal(r.code, 0)
  assert.equal(r.stderr, '')
  assert.equal(r.stdout, bare.stdout)
})

test('usage lists every command on its own line and names DIAL_HOME on the Environment line', async () => {
  const r = await runCli(['help'], { DIAL_HOME: makeHome() })
  const lines = r.stdout.split('\n')
  for (const cmd of COMMANDS) {
    assert.ok(
      lines.some(l => new RegExp(`^\\s*(dial\\s+)?${cmd}\\b`).test(l)),
      `usage has a line for ${cmd}`
    )
  }
  const nonEmpty = lines.filter(l => l.trim())
  const last = nonEmpty[nonEmpty.length - 1]
  assert.ok(last.includes('Environment:'), `usage ends with the Environment line, got ${JSON.stringify(last)}`)
  assert.ok(last.includes('DIAL_HOME'))
})

// --- version ----------------------------------------------------------------

test('version as text is the manifest version and one newline', async () => {
  const r = await runCli(['version'], { DIAL_HOME: makeHome() })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, `${VERSION}\n`)
  assert.equal(r.stderr, '')
})

test('--version behaves like version', async () => {
  const r = await runCli(['--version'], { DIAL_HOME: makeHome() })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, `${VERSION}\n`)
})

test('version --json is a single-key pretty-printed object', async () => {
  const r = await runCli(['version', '--json'], { DIAL_HOME: makeHome() })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, JSON.stringify({ version: VERSION }, null, 2) + '\n')
})

// --- refusals ---------------------------------------------------------------

test('an unknown command prints usage to stdout, one line to stderr, exit 1', async () => {
  const r = await runCli(['frobnicate'], { DIAL_HOME: makeHome() })
  assert.equal(r.code, 1)
  assert.equal(r.stderr, 'dial: unknown command: frobnicate\n')
  assert.match(r.stdout, /^dial — \S/)
})

test('an unknown option is refused with nothing on stdout', async () => {
  const r = await runCli(['repos', '--colour'], { DIAL_HOME: makeHome() })
  assert.equal(r.code, 1)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, 'dial: unknown option: --colour\n')
})

test('a value flag with no value is refused', async () => {
  const s = setup()
  const dir = repoIn(s.userHome, 'IdeaProjects', 'katipon')
  const r = await runCli(['register', dir, '--vault'], s.env)
  assert.equal(r.code, 1)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, 'dial: --vault needs a value\n')
})

test('--name=value and --name value are equivalent', async () => {
  const a = setup()
  const b = setup()
  const dirA = repoIn(a.userHome, 'IdeaProjects', 'katipon')
  const dirB = repoIn(b.userHome, 'IdeaProjects', 'katipon')
  const ra = await runCli(['register', dirA, '--vault=personal', '--host=github'], a.env)
  const rb = await runCli(['register', dirB, '--vault', 'personal', '--host', 'github'], b.env)
  assert.equal(ra.code, 0)
  assert.equal(rb.code, 0)
  assert.equal(ra.stdout, rb.stdout)
  assert.deepEqual(readJson(a.file).repos, readJson(b.file).repos)
  assert.deepEqual(readJson(a.file).repos, [{ path: '~/IdeaProjects/katipon', vault: 'personal', host: 'github' }])
})

test('options may appear before the positional argument', async () => {
  const s = setup()
  const dir = repoIn(s.userHome, 'IdeaProjects', 'katipon')
  const r = await runCli(['register', '--vault', 'personal', '--host', 'github', dir], s.env)
  assert.equal(r.code, 0)
  assert.equal(r.stdout, 'katipon\n')
})

test('every known failure is exit 1 with exactly one dial: line on stderr', async () => {
  const s = setup()
  const failures = [
    await runCli(['frobnicate'], s.env),
    await runCli(['repos', '--colour'], s.env),
    await runCli(['unregister', 'nothing-here'], s.env),
    await runCli(['register', join(s.userHome, 'missing'), '--vault', 'personal', '--host', 'github'], s.env)
  ]
  for (const r of failures) {
    assert.equal(r.code, 1)
    assertOneLine(r.stderr)
  }
})

test('an unexpected exception is reported as dial: <message> with no stack trace', async () => {
  const home = tmp('dial-home-')
  mkdirSync(join(home, 'registry.json'))
  const r = await runCli(['repos'], { DIAL_HOME: home })
  assert.equal(r.code, 1)
  assert.equal(r.stdout, '')
  assertOneLine(r.stderr)
  assert.match(r.stderr, /EISDIR/)
})

test('success output goes to stdout only', async () => {
  const s = setup()
  for (const args of [['repos'], ['limits'], ['version']]) {
    const r = await runCli(args, s.env)
    assert.equal(r.code, 0)
    assert.equal(r.stderr, '', args.join(' '))
    assert.ok(r.stdout.length > 0)
  }
})

// --- --json -----------------------------------------------------------------

test('repos --json is pretty-printed, parseable, newline-terminated, and nothing else is written', async () => {
  const s = setup()
  const dir = repoIn(s.userHome, 'IdeaProjects', 'katipon')
  assert.equal((await runCli(['register', dir, '--vault', 'personal', '--host', 'github'], s.env)).code, 0)
  const r = await runCli(['repos', '--json'], s.env)
  assert.equal(r.code, 0)
  assert.equal(r.stderr, '')
  const parsed = JSON.parse(r.stdout)
  assert.equal(r.stdout, JSON.stringify(parsed, null, 2) + '\n')
  assert.deepEqual(parsed, [{ name: 'katipon', path: dir, vault: 'personal', host: 'github' }])
})

test('limits --json is pretty-printed', async () => {
  const r = await runCli(['limits', '--json'], { DIAL_HOME: makeHome() })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, JSON.stringify({ staleDays: 14, archivedKeepDays: 30, briefLines: 40 }, null, 2) + '\n')
})

test('--json does not change the exit code: doctor --json exits 1 when a check fails, same as text', async () => {
  const s = setup()
  const missing = join(tmp(), 'gone')
  writeJson(s.file, { dial_schema: 'dial.registry/1', vaults: { personal: missing }, repos: [], limits: {} })
  const json = await runCli(['doctor', '--json'], s.env)
  const text = await runCli(['doctor'], s.env)
  assert.equal(json.code, 1)
  assert.equal(text.code, 1)
  const report = JSON.parse(json.stdout)
  assert.equal(json.stdout, JSON.stringify(report, null, 2) + '\n')
  assert.equal(report.ok, false)
  assert.ok(report.checks.some(c => c.status === 'fail'))
  const registry = report.checks.find(c => c.id === 'registry')
  assert.equal(registry.status, 'fail')
  assert.ok(registry.detail.includes(missing) || JSON.stringify(registry).includes(missing))
})

// --- limits -----------------------------------------------------------------

test('limits with no registry file prints exactly three caps and exits 0', async () => {
  const r = await runCli(['limits'], { DIAL_HOME: makeHome() })
  assert.equal(r.code, 0)
  assert.ok(r.stdout.endsWith('\n'))
  const lines = r.stdout.slice(0, -1).split('\n')
  assert.equal(lines.length, 3)
  for (const line of lines) assert.match(line, /^\S+\s+=\s+\d+  \S/)
  assert.match(lines[0], /^staleDays\s+=\s+14  /)
  assert.match(lines[1], /^archivedKeepDays\s+=\s+30  /)
  assert.match(lines[2], /^briefLines\s+=\s+40  /)
})

test('limits --json prints the defaults as an object', async () => {
  const r = await runCli(['limits', '--json'], { DIAL_HOME: makeHome() })
  assert.deepEqual(JSON.parse(r.stdout), { staleDays: 14, archivedKeepDays: 30, briefLines: 40 })
})

test('a registry limits override is reflected and the other caps keep their defaults', async () => {
  const s = setup({ limits: { staleDays: 7 } })
  const r = await runCli(['limits', '--json'], s.env)
  assert.equal(r.code, 0)
  assert.deepEqual(JSON.parse(r.stdout), { staleDays: 7, archivedKeepDays: 30, briefLines: 40 })
  const text = await runCli(['limits'], s.env)
  assert.match(text.stdout.split('\n')[0], /^staleDays\s+=\s+7  /)
})

test('an unknown cap key in the registry is refused quoting it as written', async () => {
  const s = setup({ limits: { coffeeBreaks: 3 } })
  const r = await runCli(['limits'], s.env)
  assert.equal(r.code, 1)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, `dial: registry limits: unknown cap coffeeBreaks in ${s.file}\n`)
})

test('a non-positive or non-integer cap is refused naming the key', async () => {
  for (const bad of [0, '40']) {
    const s = setup({ limits: { briefLines: bad } })
    const r = await runCli(['limits'], s.env)
    assert.equal(r.code, 1, String(bad))
    assertOneLine(r.stderr)
    assert.match(r.stderr, /briefLines/)
    assert.match(r.stderr, /positive integer/)
  }
})

// --- registry through the shell ----------------------------------------------

test('repos with no registry file says so, exits 0 and creates nothing', async () => {
  const home = join(tmp(), 'never-created')
  const r = await runCli(['repos'], { DIAL_HOME: home })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, 'no repos registered\n')
  assert.equal(r.stderr, '')
  assert.ok(!existsSync(home))
})

test('repos --json with no registry file is an empty array', async () => {
  const home = join(tmp(), 'never-created')
  const r = await runCli(['repos', '--json'], { DIAL_HOME: home })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '[]\n')
  assert.ok(!existsSync(home))
})

test('repos with an existing home but no registry file does not create the file', async () => {
  const home = makeHome()
  const r = await runCli(['repos'], { DIAL_HOME: home })
  assert.equal(r.code, 0)
  assert.deepEqual(snapshotTree(home), {})
})

test('a wrong schema marker is refused naming the file and the value', async () => {
  const home = makeHome({ registry: { dial_schema: 'dial.registry/0', vaults: {}, repos: [] } })
  const r = await runCli(['repos'], { DIAL_HOME: home })
  assert.equal(r.code, 1)
  assertOneLine(r.stderr)
  assert.ok(r.stderr.includes(join(home, 'registry.json')))
  assert.ok(r.stderr.includes('dial.registry/0'))
})

test('a registry that is not JSON is refused with the registry is not valid json reason', async () => {
  const home = makeHome({ registry: 'this is not json {\n' })
  const r = await runCli(['repos'], { DIAL_HOME: home })
  assert.equal(r.code, 1)
  assertOneLine(r.stderr)
  assert.ok(r.stderr.startsWith(`dial: registry is not valid json: ${join(home, 'registry.json')} (`))
})

test('first register leaves the home with registry.json and logs/', async () => {
  const s = setup()
  const dir = repoIn(s.userHome, 'IdeaProjects', 'katipon')
  assert.ok(!existsSync(join(s.home, 'logs')))
  const r = await runCli(['register', dir, '--vault', 'personal', '--host', 'github'], s.env)
  assert.equal(r.code, 0)
  assert.ok(existsSync(join(s.home, 'logs')))
  assert.ok(existsSync(s.file))
})

test('register: missing --host', async () => {
  const s = setup()
  const dir = repoIn(s.userHome, 'IdeaProjects', 'katipon')
  const before = snapshotTree(s.home)
  const r = await runCli(['register', dir, '--vault', 'personal'], s.env)
  assert.equal(r.code, 1)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, 'dial: register needs --vault <name> and --host github|gitlab\n')
  assert.deepEqual(snapshotTree(s.home), before)
})

test('register: missing --vault', async () => {
  const s = setup()
  const dir = repoIn(s.userHome, 'IdeaProjects', 'katipon')
  const r = await runCli(['register', dir, '--host', 'github'], s.env)
  assert.equal(r.code, 1)
  assert.equal(r.stderr, 'dial: register needs --vault <name> and --host github|gitlab\n')
})

test('register: an invalid host value', async () => {
  const s = setup()
  const dir = repoIn(s.userHome, 'IdeaProjects', 'katipon')
  const r = await runCli(['register', dir, '--vault', 'personal', '--host', 'bitbucket'], s.env)
  assert.equal(r.code, 1)
  assert.equal(r.stderr, 'dial: --host must be github or gitlab, not bitbucket\n')
})

test('register: an unknown vault names it, quotes the JSON to add, and leaves the file byte-identical', async () => {
  const s = setup()
  const dir = repoIn(s.userHome, 'IdeaProjects', 'katipon')
  const before = snapshotTree(s.home)
  const r = await runCli(['register', dir, '--vault', 'clients', '--host', 'github'], s.env)
  assert.equal(r.code, 1)
  assertOneLine(r.stderr)
  assert.ok(r.stderr.includes('clients'))
  assert.match(r.stderr, /"clients": "/)
  assert.deepEqual(readJson(s.file).repos, [])
  assert.equal(snapshotTree(s.home)['registry.json'], before['registry.json'])
})

test('register: a path with no .git entry names the path', async () => {
  const s = setup()
  const dir = join(s.userHome, 'plain')
  mkdirSync(dir, { recursive: true })
  const r = await runCli(['register', dir, '--vault', 'personal', '--host', 'github'], s.env)
  assert.equal(r.code, 1)
  assertOneLine(r.stderr)
  assert.ok(r.stderr.includes(dir))
  assert.match(r.stderr, /not a git work tree/)
})

test('register: a linked worktree, whose .git is a file, is accepted', async () => {
  const s = setup()
  const dir = makeGitDir(join(s.userHome, 'wt', 'gamma'), { worktree: true })
  const r = await runCli(['register', dir, '--vault', 'personal', '--host', 'github'], s.env)
  assert.equal(r.code, 0)
  assert.equal(r.stdout, 'gamma\n')
})

test('register: a path that does not exist names the path', async () => {
  const s = setup()
  const dir = join(s.userHome, 'missing')
  const r = await runCli(['register', dir, '--vault', 'personal', '--host', 'github'], s.env)
  assert.equal(r.code, 1)
  assertOneLine(r.stderr)
  assert.ok(r.stderr.includes(dir))
})

test('register: a repo already registered to another vault is refused and the file is byte-identical', async () => {
  const s = setup()
  const dir = repoIn(s.userHome, 'VSCodeProjects', 'beta-rabbitdeploy')
  assert.equal((await runCli(['register', dir, '--vault', 'work', '--host', 'gitlab'], s.env)).code, 0)
  const before = snapshotTree(s.home)
  const r = await runCli(['register', dir, '--vault', 'personal', '--host', 'github'], s.env)
  assert.equal(r.code, 1)
  assert.equal(r.stdout, '')
  assert.equal(
    r.stderr,
    'dial: beta-rabbitdeploy is registered to vault work (~/VSCodeProjects/beta-rabbitdeploy); a repo belongs to exactly one vault\n'
  )
  assert.deepEqual(snapshotTree(s.home), before)
})

test('register: the same name under another path and vault is refused naming it and the existing path', async () => {
  const s = setup()
  assert.equal((await runCli(['register', repoIn(s.userHome, 'IdeaProjects', 'katipon'), '--vault', 'personal', '--host', 'github'], s.env)).code, 0)
  const before = snapshotTree(s.home)
  const r = await runCli(['register', repoIn(s.userHome, 'elsewhere', 'katipon'), '--vault', 'work', '--host', 'gitlab'], s.env)
  assert.equal(r.code, 1)
  assertOneLine(r.stderr)
  assert.ok(r.stderr.includes('katipon'))
  assert.ok(r.stderr.includes('~/IdeaProjects/katipon'))
  assert.deepEqual(snapshotTree(s.home), before)
})

test('register: the same path and vault updates the host and leaves one entry', async () => {
  const s = setup()
  const dir = repoIn(s.userHome, 'IdeaProjects', 'delta')
  assert.equal((await runCli(['register', dir, '--vault', 'personal', '--host', 'github'], s.env)).code, 0)
  const r = await runCli(['register', dir, '--vault', 'personal', '--host', 'gitlab'], s.env)
  assert.equal(r.code, 0)
  assert.deepEqual(readJson(s.file).repos, [{ path: '~/IdeaProjects/delta', vault: 'personal', host: 'gitlab' }])
})

test('unregister: by name, by absolute path, and a miss', async () => {
  const s = setup()
  const k = repoIn(s.userHome, 'IdeaProjects', 'katipon')
  const a = repoIn(s.userHome, 'VSCodeProjects', 'alpha')
  assert.equal((await runCli(['register', k, '--vault', 'personal', '--host', 'github'], s.env)).code, 0)
  assert.equal((await runCli(['register', a, '--vault', 'work', '--host', 'gitlab'], s.env)).code, 0)

  const before = snapshotTree(s.home)
  const miss = await runCli(['unregister', 'nothing-here'], s.env)
  assert.equal(miss.code, 1)
  assert.equal(miss.stdout, '')
  assert.equal(miss.stderr, 'dial: no registered repo matches nothing-here\n')
  assert.deepEqual(snapshotTree(s.home), before)

  const byName = await runCli(['unregister', 'katipon'], s.env)
  assert.equal(byName.code, 0)
  assert.equal(byName.stdout, 'katipon\n')
  assert.deepEqual(readJson(s.file).repos.map(r => r.path), ['~/VSCodeProjects/alpha'])

  const byPath = await runCli(['unregister', a], s.env)
  assert.equal(byPath.code, 0)
  assert.equal(byPath.stdout, 'alpha\n')
  assert.deepEqual(readJson(s.file).repos, [])
})

test('repos lists one aligned line per entry, sorted by name', async () => {
  const s = setup()
  const k = repoIn(s.userHome, 'IdeaProjects', 'katipon')
  const a = repoIn(s.userHome, 'VSCodeProjects', 'alpha')
  assert.equal((await runCli(['register', k, '--vault', 'personal', '--host', 'github'], s.env)).code, 0)
  assert.equal((await runCli(['register', a, '--vault', 'work', '--host', 'gitlab'], s.env)).code, 0)
  const r = await runCli(['repos'], s.env)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.endsWith('\n'))
  const lines = r.stdout.slice(0, -1).split('\n')
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map(l => l.split(/\s+/)), [
    ['alpha', 'work', 'gitlab', a],
    ['katipon', 'personal', 'github', k]
  ])
  const prefix = (line, n) => line.match(new RegExp(`^(\\S+\\s+){${n}}`))[0].length
  assert.equal(prefix(lines[0], 1), prefix(lines[1], 1))
  assert.equal(prefix(lines[0], 3), prefix(lines[1], 3))
})

test('happy path: register -> repos -> unregister', async () => {
  const s = setup()
  const dir = repoIn(s.userHome, 'IdeaProjects', 'katipon')

  const reg = await runCli(['register', dir, '--vault', 'personal', '--host', 'github'], s.env)
  assert.equal(reg.code, 0)
  assert.equal(reg.stdout, 'katipon\n')
  assert.equal(reg.stderr, '')
  assert.deepEqual(readJson(s.file).repos, [{ path: '~/IdeaProjects/katipon', vault: 'personal', host: 'github' }])

  const listed = await runCli(['repos', '--json'], s.env)
  assert.equal(listed.code, 0)
  assert.deepEqual(JSON.parse(listed.stdout), [{ name: 'katipon', path: dir, vault: 'personal', host: 'github' }])

  const gone = await runCli(['unregister', 'katipon'], s.env)
  assert.equal(gone.code, 0)
  assert.equal(gone.stdout, 'katipon\n')

  const after = await runCli(['repos'], s.env)
  assert.equal(after.code, 0)
  assert.equal(after.stdout, 'no repos registered\n')
})

test('an unchanged registry is byte-identical across a register that changes nothing', async () => {
  const s = setup()
  const dir = repoIn(s.userHome, 'IdeaProjects', 'katipon')
  assert.equal((await runCli(['register', dir, '--vault', 'personal', '--host', 'github'], s.env)).code, 0)
  const first = readFileSync(s.file)
  assert.equal(readJson(s.file).repos.length, 1)
  assert.equal((await runCli(['register', dir, '--vault', 'personal', '--host', 'github'], s.env)).code, 0)
  assert.ok(first.equals(readFileSync(s.file)))
})

// --- the home ----------------------------------------------------------------

test('repos does not create a missing home', async () => {
  const home = join(tmp(), 'missing-home')
  const r = await runCli(['repos'], { DIAL_HOME: home })
  assert.equal(r.code, 0)
  assert.ok(!existsSync(home))
})

test('doctor does not create a missing home and reports home as ok with the first-register detail', async () => {
  const home = join(tmp(), 'missing-home')
  const r = await runCli(['doctor', '--json'], { DIAL_HOME: home })
  assert.ok(!existsSync(home))
  const report = JSON.parse(r.stdout)
  const check = report.checks.find(c => c.id === 'home')
  assert.equal(check.status, 'ok')
  assert.equal(check.detail, 'will be created on first register')
})

test('version, limits and help do not create a missing home', async () => {
  const home = join(tmp(), 'missing-home')
  for (const args of [['version'], ['limits'], ['help']]) {
    const r = await runCli(args, { DIAL_HOME: home })
    assert.equal(r.code, 0, args.join(' '))
  }
  assert.ok(!existsSync(home))
})

test('register against a home that cannot be written names the home and the OS code, and writes nothing', { skip: isRoot ? 'root ignores mode bits' : false }, async () => {
  const s = setup()
  const dir = repoIn(s.userHome, 'IdeaProjects', 'katipon')
  const before = snapshotTree(s.home)
  chmodSync(s.home, 0o555)
  try {
    const r = await runCli(['register', dir, '--vault', 'personal', '--host', 'github'], s.env)
    assert.equal(r.code, 1)
    assert.equal(r.stdout, '')
    assertOneLine(r.stderr)
    assert.match(r.stderr, /dial home is not writable: /)
    assert.ok(r.stderr.includes(s.home))
    assert.match(r.stderr, /EACCES/)
  } finally {
    chmodSync(s.home, 0o755)
  }
  assert.deepEqual(snapshotTree(s.home), before)
})

test('a writing command with DIAL_HOME naming a regular file exits 1 naming that path', async () => {
  const s = setup()
  const dir = repoIn(s.userHome, 'IdeaProjects', 'katipon')
  const file = join(tmp(), 'a-file')
  writeFileSync(file, 'x')
  const r = await runCli(['register', dir, '--vault', 'personal', '--host', 'github'], { DIAL_HOME: file, HOME: s.userHome })
  assert.equal(r.code, 1)
  assertOneLine(r.stderr)
  assert.ok(r.stderr.includes(file))
})

test('doctor --json exits 1 when a registered vault path is missing', async () => {
  const s = setup()
  writeJson(s.file, {
    dial_schema: 'dial.registry/1',
    vaults: { personal: join(tmp(), 'gone') },
    repos: [],
    limits: {}
  })
  const r = await runCli(['doctor', '--json'], s.env)
  assert.equal(r.code, 1)
  assert.equal(JSON.parse(r.stdout).ok, false)
})
