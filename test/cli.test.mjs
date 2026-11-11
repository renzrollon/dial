/**
 * The binary as a subprocess. Every run gets a temp DIAL_HOME and, where the
 * stored path matters, a temp HOME so `~` collapses against a directory the
 * test owns.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  BIN, FIXTURES, fakeBinary, makeGitDir, makeHome, makeRepo, makeVault, readJson, runCli, snapshotTree, tmp, writeJson,
} from './helpers.mjs'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const VERSION = readJson(join(dirname(BIN), '..', 'package.json')).version
// Pins specs/cli-shell/spec.md, "Usage is printed on request and never as an error" (scenario
// "Usage names every command and environment variable"): the nineteen commands.
const COMMANDS = [
  'version', 'limits', 'doctor', 'register', 'unregister', 'repos', 'help', 'vault', 'sync', 'next', 'brief',
  'handoff', 'narrate', 'record', 'drop', 'agent', 'watch', 'report', 'review',
]
const ENV_VARS = ['DIAL_HOME', 'DIAL_NOW', 'DIAL_LAUNCHCTL_BIN', 'ESCAPEMENT_HOME', 'ESCAPEMENT_CHECKPOINT_URL']

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

test('usage lists every command on its own line and ends with the Environment line naming the five variables', async () => {
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
  // Pins specs/cli-shell/spec.md, "Usage is printed on request and never as an error": the last line is the
  // one Environment: line, naming every Dial-specific variable the binary reads.
  assert.ok(last.startsWith('Environment:'), `usage ends with the Environment line, got ${JSON.stringify(last)}`)
  for (const name of ENV_VARS) assert.ok(last.includes(name), `the Environment line names ${name}`)
})

test('usage names the vault and agent subcommands', async () => {
  const r = await runCli(['help'], { DIAL_HOME: makeHome() })
  const lines = r.stdout.split('\n')
  assert.ok(lines.some(l => /^\s*vault\b.*\binit\b/.test(l)))
  assert.ok(lines.some(l => /^\s*agent\b.*\binstall\b.*\buninstall\b.*\bstatus\b/.test(l)))
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
  assert.equal(r.stdout, JSON.stringify(TEN_CAPS, null, 2) + '\n')
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

// Pins specs/limits/spec.md, "Every cap is published with a default and a description".
const TEN_CAPS = {
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

test('limits with no registry file prints exactly ten caps in the published order and exits 0', async () => {
  const r = await runCli(['limits'], { DIAL_HOME: makeHome() })
  assert.equal(r.code, 0)
  assert.ok(r.stdout.endsWith('\n'))
  const lines = r.stdout.slice(0, -1).split('\n')
  assert.equal(lines.length, 10)
  for (const line of lines) assert.match(line, /^\S+\s+=\s+\d+  [a-z]/)
  Object.entries(TEN_CAPS).forEach(([name, value], i) => assert.match(lines[i], new RegExp(`^${name}\\s+=\\s+${value}  `)))
})

test('limits --json prints the defaults as an object', async () => {
  const r = await runCli(['limits', '--json'], { DIAL_HOME: makeHome() })
  assert.deepEqual(JSON.parse(r.stdout), TEN_CAPS)
  assert.deepEqual(Object.keys(JSON.parse(r.stdout)), Object.keys(TEN_CAPS))
})

test('a registry limits override is reflected and the other caps keep their defaults', async () => {
  const s = setup({ limits: { staleDays: 7 } })
  const r = await runCli(['limits', '--json'], s.env)
  assert.equal(r.code, 0)
  assert.deepEqual(JSON.parse(r.stdout), { ...TEN_CAPS, staleDays: 7 })
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

// --- the ledger commands (task 4.5) -------------------------------------------

const realGit = (() => {
  try {
    return execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
})()
const noGit = realGit ? false : 'git is not on PATH'
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

/** A real git work tree on `branch` with one empty commit. */
function gitRepo(dir, branch = 'main') {
  mkdirSync(dir, { recursive: true })
  const git = (...args) => execFileSync(realGit, args, { cwd: dir, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', branch)
  git('-c', 'user.email=dial@example.invalid', '-c', 'user.name=dial', 'commit', '-q', '--allow-empty', '-m', 'init')
  return dir
}

/** Set every file and directory under `dir` (and `dir`) to the instant `iso`. */
function touchTree(dir, iso) {
  const t = new Date(iso)
  for (const rel of Object.keys(snapshotTree(dir))) utimesSync(join(dir, rel), t, t)
  utimesSync(dir, t, t)
}

/**
 * A home whose registry declares `personal` (and `work`) vaults and the given repos. `repos` is
 * `[{ name, host?, vault?, spec? (makeRepo), git? (a branch for a real git repo) }]`.
 */
function ledger({ repos = [{ name: 'katipon' }], limits = {} } = {}) {
  const root = tmp('ledger-')
  const vaults = { personal: makeVault(join(root, 'personal')), work: makeVault(join(root, 'work')) }
  const entries = []
  const paths = {}
  for (const r of repos) {
    const dir = join(root, 'code', r.name)
    if (r.git) gitRepo(dir, r.git)
    makeRepo(dir, r.spec ?? { changes: { 'add-login': { tasks: { done: 0, total: 2 } } } })
    paths[r.name] = dir
    entries.push({ path: dir, vault: r.vault ?? 'personal', host: r.host ?? 'github' })
  }
  const home = makeHome({ registry: { dial_schema: 'dial.registry/1', vaults, repos: entries, limits } })
  const userHome = tmp('user-home-')
  return { root, home, vaults, paths, userHome, env: { DIAL_HOME: home, HOME: userHome } }
}

/** Recording stand-ins for the binaries `next`, `brief` and an offline `sync` must never run. */
function recorders(root, { gitWrapper = false } = {}) {
  const dir = join(root, 'fake-bin')
  const log = join(root, 'calls.log')
  writeFileSync(log, '')
  const record = name => `echo "$(pwd -P) ${name} $*" >> '${log}'`
  fakeBinary(dir, 'gh', `${record('gh')}\necho 'no pull requests found for branch "main"' >&2\nexit 1`)
  fakeBinary(dir, 'glab', `${record('glab')}\necho 'no open merge request available for "main"' >&2\nexit 1`)
  fakeBinary(dir, 'interlock', `${record('interlock')}\ncat '${join(FIXTURES, 'interlock', 'drift.json')}'`)
  fakeBinary(dir, 'escapement', `${record('escapement')}\nexit 0`)
  if (gitWrapper && realGit) fakeBinary(dir, 'git', `${record('git')}\nexec '${realGit}' "$@"`)
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean)
  return { PATH: `${dir}:${process.env.PATH}`, calls }
}

const callsOf = (calls, name) => calls().filter(l => l.split(' ')[1] === name)

test('vault without a subcommand, an unknown one and an option checked against it', async () => {
  const s = ledger()
  const bare = await runCli(['vault'], s.env)
  assert.equal(bare.code, 1)
  assert.equal(bare.stdout, '')
  assert.equal(bare.stderr, 'dial: vault needs one of init\n')
  const unknown = await runCli(['vault', 'create', 'personal'], s.env)
  assert.equal(unknown.code, 1)
  assert.equal(unknown.stdout, '')
  assert.equal(unknown.stderr, 'dial: unknown vault subcommand: create\n')
  const help = await runCli(['vault', 'init', '--help'], s.env)
  assert.equal(help.code, 0)
  assert.match(help.stdout, /^dial — /)
  const noName = await runCli(['vault', 'init'], s.env)
  assert.equal(noName.stderr, 'dial: vault init needs <name>\n')
  const clients = await runCli(['vault', 'init', 'clients'], s.env)
  assert.equal(clients.code, 1)
  assert.equal(clients.stderr, 'dial: no vault named clients in the registry\n')
  const forced = await runCli(['vault', 'init', 'personal', '--force'], s.env)
  assert.equal(forced.code, 0, forced.stderr)
  const sync = await runCli(['sync', 'katipon', '--force'], s.env)
  assert.equal(sync.stderr, 'dial: unknown option: --force\n')
})

test('vault init twice is byte-identical and the second run says unchanged for every path', async () => {
  const s = ledger()
  const first = await runCli(['vault', 'init', 'personal'], s.env)
  assert.equal(first.code, 0, first.stderr)
  assert.deepEqual(first.stdout.split('\n').slice(0, 7), [
    'created Projects/', 'created Changes/', 'created Templates/', 'created Dial.base',
    'created Templates/Dial Change.md', 'created Dial Queries.md', 'created Templates/Daily.md',
  ])
  assert.match(first.stdout.split('\n')[7], /^append .*AGENTS-dial-section\.md to .*AGENTS\.md by hand$/)
  const after = snapshotTree(s.vaults.personal)
  const second = await runCli(['vault', 'init', 'personal'], s.env)
  assert.equal(second.code, 0)
  assert.ok(second.stdout.split('\n').slice(0, 7).every(l => l.startsWith('unchanged ')), second.stdout)
  assert.deepEqual(snapshotTree(s.vaults.personal), after)
  const js = await runCli(['vault', 'init', 'personal', '--json'], s.env)
  const parsed = JSON.parse(js.stdout)
  assert.equal(js.stdout, JSON.stringify(parsed, null, 2) + '\n')
})

test('sync refuses neither a repo nor --all, both, and an unknown repo', async () => {
  const s = ledger()
  const neither = await runCli(['sync'], s.env)
  assert.equal(neither.code, 1)
  assert.equal(neither.stderr, 'dial: sync needs <repo> or --all\n')
  const both = await runCli(['sync', 'katipon', '--all'], s.env)
  assert.equal(both.code, 1)
  assert.equal(both.stderr, 'dial: sync takes <repo> or --all, not both\n')
  const miss = await runCli(['sync', 'nothing-here'], s.env)
  assert.equal(miss.code, 1)
  assert.equal(miss.stderr, 'dial: no registered repo matches nothing-here\n')
})

test('sync --dry-run on a fixture repo lists its paths and writes nothing', async () => {
  const s = ledger()
  const before = { vault: snapshotTree(s.vaults.personal), home: snapshotTree(s.home) }
  const r = await runCli(['sync', 'katipon', '--dry-run'], { ...s.env, DIAL_NOW: '2026-11-10T09:00:00Z' })
  assert.equal(r.code, 0, r.stderr)
  const v = s.vaults.personal
  assert.deepEqual(r.stdout.split('\n').filter(Boolean), [
    `create ${join(v, 'Changes', 'katipon--add-login.md')}`,
    `create ${join(v, 'Projects', 'katipon.md')}`,
    `create ${join(v, 'Dial Summary.md')}`,
  ])
  assert.deepEqual({ vault: snapshotTree(s.vaults.personal), home: snapshotTree(s.home) }, before)
  const js = await runCli(['sync', '--all', '--dry-run', '--json'], { ...s.env, DIAL_NOW: '2026-11-10T09:00:00Z' })
  assert.equal(js.code, 0, js.stderr)
  const rows = JSON.parse(js.stdout)
  assert.equal(js.stdout, JSON.stringify(rows, null, 2) + '\n')
  assert.deepEqual(rows.map(x => x.repo), ['katipon'])
})

test('sync writes the notes, prints the repo line, and a dry run afterwards plans only unchanged', async () => {
  const s = ledger()
  const env = { ...s.env, DIAL_NOW: '2026-11-10T09:00:00Z' }
  assert.ok(!existsSync(join(s.home, 'logs')))
  const r = await runCli(['sync', 'katipon'], env)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, 'katipon: 1 items, 1 need me, 2 written\n')
  assert.ok(existsSync(join(s.home, 'logs', 'sync.jsonl')), 'the first sync creates logs/sync.jsonl')
  assert.ok(existsSync(join(s.vaults.personal, 'Changes', 'katipon--add-login.md')))
  const dry = await runCli(['sync', 'katipon', '--dry-run'], env)
  assert.equal(dry.code, 0)
  assert.ok(dry.stdout.split('\n').filter(Boolean).every(l => l.startsWith('unchanged ')), dry.stdout)
})

test('sync by a path inside the repo resolves the registered repo', async () => {
  const s = ledger()
  mkdirSync(join(s.paths.katipon, 'lib'))
  const r = await runCli(['sync', join(s.paths.katipon, 'lib'), '--dry-run'], s.env)
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /Projects\/katipon\.md/)
})

test('sync --all reports a repo whose vault is gone as skipped and exits 1 naming the count', async () => {
  const s = ledger({ repos: [{ name: 'alpha' }, { name: 'katipon' }, { name: 'zeta', vault: 'work' }] })
  rmSync(s.vaults.work, { recursive: true })
  const r = await runCli(['sync', '--all'], s.env)
  assert.equal(r.code, 1)
  const lines = r.stdout.split('\n').filter(Boolean)
  assert.equal(lines.length, 3)
  assert.match(lines[0], /^alpha: \d+ items, /)
  assert.match(lines[1], /^katipon: \d+ items, /)
  assert.equal(lines[2], `zeta: skipped, vault work for zeta does not exist: ${s.vaults.work}`)
  assert.equal(r.stderr, 'dial: 1 of 3 repos not synced\n')
})

test('a written timestamp has the toISOString form whatever offset DIAL_NOW carries', async () => {
  const s = ledger()
  const r = await runCli(['sync', 'katipon'], { ...s.env, DIAL_NOW: '2026-11-10T17:00:00+08:00' })
  assert.equal(r.code, 0, r.stderr)
  const lines = readFileSync(join(s.home, 'logs', 'sync.jsonl'), 'utf8').trim().split('\n')
  assert.deepEqual(JSON.parse(lines.at(-1)), { ts: '2026-11-10T09:00:00.000Z', vault: 'personal', repo: 'katipon', needsMe: 1, items: 1 })
})

test('local dates follow TZ: the same instant is the next day in Asia/Manila', async () => {
  const utc = ledger()
  const manila = ledger()
  const at = '2026-11-10T20:00:00Z'
  assert.equal((await runCli(['sync', 'katipon'], { ...utc.env, DIAL_NOW: at })).code, 0)
  assert.equal((await runCli(['sync', 'katipon'], { ...manila.env, DIAL_NOW: at, TZ: 'Asia/Manila' })).code, 0)
  const note = v => readFileSync(join(v, 'Projects', 'katipon.md'), 'utf8')
  assert.match(note(utc.vaults.personal), /^updated: 2026-11-10$/m)
  assert.match(note(manila.vaults.personal), /^updated: 2026-11-11$/m)
})

test('DIAL_NOW without an offset, unparseable, blank, and ignored by version', async () => {
  const s = ledger()
  const bare = await runCli(['next'], { ...s.env, DIAL_NOW: '2026-11-10T14:05:00' })
  assert.equal(bare.code, 1)
  assert.equal(bare.stdout, '')
  assert.equal(bare.stderr, 'dial: DIAL_NOW is not an ISO-8601 timestamp: 2026-11-10T14:05:00\n')
  const word = await runCli(['next'], { ...s.env, DIAL_NOW: 'yesterday' })
  assert.equal(word.code, 1)
  assert.equal(word.stdout, '')
  assert.equal(word.stderr, 'dial: DIAL_NOW is not an ISO-8601 timestamp: yesterday\n')
  const blank = await runCli(['next', '--json'], { ...s.env, DIAL_NOW: '   ' })
  assert.equal(blank.code, 0, blank.stderr)
  const version = await runCli(['version'], { ...s.env, DIAL_NOW: 'yesterday' })
  assert.equal(version.code, 0)
  assert.equal(version.stdout, `${VERSION}\n`)
})

test('a frozen clock drives idle days: 21 days idle is stale with the default staleDays', async () => {
  const s = ledger()
  touchTree(join(s.paths.katipon, 'openspec', 'changes', 'add-login'), '2026-10-20T09:00:00Z')
  const r = await runCli(['next', '--json'], { ...s.env, DIAL_NOW: '2026-11-10T09:00:00Z' })
  assert.equal(r.code, 0, r.stderr)
  const rows = JSON.parse(r.stdout)
  assert.equal(r.stdout, JSON.stringify(rows, null, 2) + '\n')
  const row = rows.find(x => x.change === 'add-login')
  assert.equal(row.idleDays, 21)
  assert.equal(row.stale, true)
})

test('the same clock gives the same bytes over two copies of one repository and vault', async () => {
  const at = '2026-11-10T09:00:00Z'
  const copies = [ledger(), ledger()]
  for (const c of copies) {
    touchTree(join(c.paths.katipon, 'openspec'), '2026-11-08T09:00:00Z')
    const r = await runCli(['sync', 'katipon'], { ...c.env, DIAL_NOW: at })
    assert.equal(r.code, 0, r.stderr)
  }
  const read = c => Object.fromEntries(Object.keys(snapshotTree(c.vaults.personal)).filter(k => k.endsWith('.md'))
    .map(k => [k, readFileSync(join(c.vaults.personal, k), 'utf8').split(c.root).join('<root>')]))
  assert.deepEqual(read(copies[0]), read(copies[1]))
})

test('next with no registry prints [] under --json and nothing needs you as text; an unknown vault is refused', async () => {
  const home = join(tmp(), 'never-created')
  const js = await runCli(['next', '--json'], { DIAL_HOME: home })
  assert.equal(js.code, 0)
  assert.equal(js.stdout, '[]\n')
  const text = await runCli(['next'], { DIAL_HOME: home })
  assert.equal(text.stdout, 'nothing needs you\n')
  assert.ok(!existsSync(home))
  const s = ledger()
  const bad = await runCli(['next', '--vault', 'clients'], s.env)
  assert.equal(bad.code, 1)
  assert.equal(bad.stderr, 'dial: no vault named clients in the registry\n')
})

test('brief --hook on an unregistered repo prints nothing and exits 0; without --hook it exits 1', async () => {
  const s = ledger()
  const scratch = tmp('scratch-')
  const hook = await runCli(['brief', scratch, '--hook'], s.env)
  assert.equal(hook.code, 0)
  assert.equal(hook.stdout, '')
  assert.equal(hook.stderr, '')
  const plain = await runCli(['brief', scratch], s.env)
  assert.equal(plain.code, 1)
  assert.equal(plain.stdout, '')
  assert.equal(plain.stderr, `dial: ${scratch} is not a registered repo\n`)
  const both = await runCli(['brief', 'katipon', '--hook', '--json'], s.env)
  assert.equal(both.code, 1)
  assert.equal(both.stderr, 'dial: --hook and --json cannot be combined\n')
})

test('brief --hook wraps exactly the text output in the SessionStart envelope', async () => {
  const s = ledger()
  const env = { ...s.env, DIAL_NOW: '2026-11-10T09:00:00Z' }
  const text = await runCli(['brief', 'katipon'], env)
  assert.equal(text.code, 0, text.stderr)
  assert.match(text.stdout, /^katipon · /)
  assert.ok(text.stdout.endsWith('dial next for everything else\n'))
  const hook = await runCli(['brief', 'katipon', '--hook'], env)
  assert.equal(hook.code, 0)
  assert.equal(hook.stdout.split('\n').length, 2, 'one line and its newline')
  const envelope = JSON.parse(hook.stdout)
  assert.equal(envelope.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.equal(envelope.hookSpecificOutput.additionalContext, text.stdout.slice(0, -1))
  const js = JSON.parse((await runCli(['brief', 'katipon', '--json'], env)).stdout)
  assert.equal(js.repo, 'katipon')
  assert.equal(js.dropped, 0)
  assert.deepEqual(js.lines, text.stdout.slice(0, -1).split('\n'))
})

test('drop needs a repo and a change, marks the note and says so', async () => {
  const s = ledger()
  const env = { ...s.env, DIAL_NOW: '2026-11-10T09:00:00Z' }
  const missing = await runCli(['drop', 'katipon'], env)
  assert.equal(missing.code, 1)
  assert.equal(missing.stderr, 'dial: drop needs <repo> <change>\n')
  assert.equal((await runCli(['sync', 'katipon'], env)).code, 0)
  const repoBefore = snapshotTree(s.paths.katipon)
  const r = await runCli(['drop', 'katipon', 'add-login'], env)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, 'dropped [[katipon--add-login]]\n')
  const note = readFileSync(join(s.vaults.personal, 'Changes', 'katipon--add-login.md'), 'utf8')
  assert.match(note, /^dropped: 2026-11-10$/m)
  assert.match(note, /^state: dropped$/m)
  assert.match(note, /^needs_me: false$/m)
  assert.deepEqual(snapshotTree(s.paths.katipon), repoBefore)
  const none = await runCli(['drop', 'katipon', 'nothing-here'], env)
  assert.equal(none.code, 1)
  assert.equal(none.stderr, 'dial: no note for katipon/nothing-here in vault personal\n')
})

test('sync with an unwritable home names the home and the OS code and changes no vault file', { skip: isRoot ? 'root ignores mode bits' : false }, async () => {
  const s = ledger()
  const before = snapshotTree(s.vaults.personal)
  chmodSync(s.home, 0o555)
  try {
    const r = await runCli(['sync', 'katipon'], s.env)
    assert.equal(r.code, 1)
    assert.equal(r.stdout, '')
    assertOneLine(r.stderr)
    assert.ok(r.stderr.startsWith('dial: dial home is not writable: '), r.stderr)
    assert.ok(r.stderr.includes(s.home))
    assert.match(r.stderr, /\(EACCES: /)
  } finally {
    chmodSync(s.home, 0o755)
  }
  assert.deepEqual(snapshotTree(s.vaults.personal), before)
})

// --- the offline guarantees -----------------------------------------------------

test('next and brief run none of gh, glab, interlock or escapement and write nothing', async () => {
  const s = ledger()
  const fakes = recorders(s.root)
  const env = { ...s.env, PATH: fakes.PATH }
  const before = { vault: snapshotTree(s.vaults.personal), home: snapshotTree(s.home) }
  const next = await runCli(['next'], env)
  assert.equal(next.code, 0, next.stderr)
  const briefRun = await runCli(['brief', 'katipon'], env)
  assert.equal(briefRun.code, 0, briefRun.stderr)
  assert.deepEqual(fakes.calls(), [])
  assert.deepEqual({ vault: snapshotTree(s.vaults.personal), home: snapshotTree(s.home) }, before)
})

test('sync without --remote runs no gh or glab and no network git command', { skip: noGit }, async () => {
  const s = ledger({ repos: [{ name: 'katipon', git: 'feat/add-login' }, { name: 'work-api', host: 'gitlab', git: 'main' }] })
  const fakes = recorders(s.root, { gitWrapper: true })
  const r = await runCli(['sync', '--all'], { ...s.env, PATH: fakes.PATH })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(callsOf(fakes.calls, 'gh'), [])
  assert.deepEqual(callsOf(fakes.calls, 'glab'), [])
  const git = callsOf(fakes.calls, 'git')
  assert.ok(git.length > 0, 'git was run through the wrapper')
  for (const line of git) assert.ok(!/ git (fetch|pull|push|ls-remote|clone|remote update)\b/.test(line), line)
  assert.ok(!existsSync(join(s.home, 'cache')))
})

test('sync --due-remote runs gh only for the repo whose cache is stale', { skip: noGit }, async () => {
  const s = ledger({ repos: [{ name: 'fresh', git: 'main' }, { name: 'stale', git: 'main' }] })
  const now = Date.parse('2026-11-10T09:00:00Z')
  const cache = (name, minutes) => writeJson(join(s.home, 'cache', 'remote', `${name}.json`), {
    dial_schema: 'dial.cache/1', fetchedAt: new Date(now - minutes * 60_000).toISOString(), host: 'github', branch: 'main', pr: null, checks: [],
  })
  cache('fresh', 10)
  cache('stale', 45)
  const fakes = recorders(s.root)
  const r = await runCli(['sync', '--all', '--due-remote'], { ...s.env, PATH: fakes.PATH, DIAL_NOW: '2026-11-10T09:00:00Z' })
  assert.equal(r.code, 0, r.stderr)
  const gh = callsOf(fakes.calls, 'gh')
  assert.ok(gh.length > 0, 'gh ran for the stale repo')
  const stalePath = realpathSync(s.paths.stale)
  for (const line of gh) assert.ok(line.startsWith(`${stalePath} gh `), line)
  assert.equal(readJson(join(s.home, 'cache', 'remote', 'stale.json')).fetchedAt, '2026-11-10T09:00:00.000Z')
})

test('a gitlab repo never runs gh, even under --remote', { skip: noGit }, async () => {
  const s = ledger({ repos: [{ name: 'work-api', host: 'gitlab', git: 'main' }] })
  const fakes = recorders(s.root)
  const r = await runCli(['sync', 'work-api', '--remote'], { ...s.env, PATH: fakes.PATH })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(callsOf(fakes.calls, 'gh'), [])
  assert.ok(callsOf(fakes.calls, 'glab').length > 0, 'glab ran')
})

test('sync runs interlock drift --json exactly once per repo', async () => {
  const s = ledger()
  const fakes = recorders(s.root)
  const r = await runCli(['sync', 'katipon'], { ...s.env, PATH: fakes.PATH })
  assert.equal(r.code, 0, r.stderr)
  const calls = callsOf(fakes.calls, 'interlock')
  assert.equal(calls.length, 1)
  assert.equal(calls[0], `${realpathSync(s.paths.katipon)} interlock drift --json`)
})

// --- agent, watch, report, review (specs/cli-shell, launch-agent, report) -----------------------

const isDarwin = process.platform === 'darwin'

/** One real command, spawned so a test can signal it. */
function spawnCli(args, env) {
  return spawn(process.execPath, [BIN, ...args], {
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, TZ: 'UTC', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('agent without or with an unknown subcommand is refused', async () => {
  const s = setup()
  const none = await runCli(['agent'], s.env)
  assert.equal(none.code, 1)
  assert.equal(none.stdout, '')
  assert.equal(none.stderr, 'dial: agent needs one of install, uninstall, status\n')
  const bad = await runCli(['agent', 'restart'], s.env)
  assert.equal(bad.code, 1)
  assert.equal(bad.stderr, 'dial: unknown agent subcommand: restart\n')
  const help = await runCli(['agent', '--help'], s.env)
  assert.equal(help.code, 0)
  assert.ok(help.stdout.startsWith('dial'))
})

test('agent options are checked against the subcommand; install and uninstall refuse --json', async () => {
  const s = setup()
  for (const args of [['agent', 'status', '--force'], ['agent', 'install', '--json'], ['agent', 'uninstall', '--json']]) {
    const r = await runCli(args, s.env)
    assert.equal(r.code, 1, args.join(' '))
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, `dial: unknown option: --${args[2].slice(2)}\n`)
  }
})

test('watch refuses --json and any argument', async () => {
  const s = setup()
  const json = await runCli(['watch', '--json'], s.env)
  assert.equal(json.code, 1)
  assert.equal(json.stdout, '')
  assert.equal(json.stderr, 'dial: unknown option: --json\n')
  const extra = await runCli(['watch', 'katipon'], s.env)
  assert.equal(extra.code, 1)
  assert.equal(extra.stderr, 'dial: unexpected argument: katipon\n')
})

test('review without --week is refused and writes nothing', async () => {
  const s = setup()
  const r = await runCli(['review'], s.env)
  assert.equal(r.code, 1)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, 'dial: review needs --week\n')
})

test('agent status prints launchctl state, exits 1 unless running, and --json drops the text', { skip: isDarwin ? false : 'macOS only' }, async () => {
  const s = setup()
  const bin = fakeBinary(join(tmp('fake-launchctl-'), 'bin'), 'launchctl', 'echo "state = running"; echo "pid = 4242"')
  const env = { ...s.env, DIAL_LAUNCHCTL_BIN: bin }
  const none = await runCli(['agent', 'status'], env)
  assert.equal(none.code, 1)
  assert.match(none.stdout, /^agent: not-installed\n/)
  assert.match(none.stdout, /fix: dial agent install/)
  const inst = await runCli(['agent', 'install'], env)
  assert.equal(inst.code, 0, inst.stderr)
  assert.match(inst.stdout, /^installed com\.dial\.sync\n  plist: .*com\.dial\.sync\.plist\n$/)
  const up = await runCli(['agent', 'status'], env)
  assert.equal(up.code, 0)
  assert.match(up.stdout, /^agent: running \(pid 4242\)\n/)
  const asJson = await runCli(['agent', 'status', '--json'], env)
  assert.equal(asJson.code, 0)
  const doc = JSON.parse(asJson.stdout)
  assert.equal(doc.outcome, 'running')
  assert.ok(!('text' in doc))
  assert.ok(asJson.stdout.endsWith('}\n'))
  const gone = await runCli(['agent', 'uninstall'], env)
  assert.equal(gone.code, 0)
  assert.match(gone.stdout, /^uninstalled .*com\.dial\.sync\.plist\n$/)
})

test('agent install with an unwritable home names the home and writes no plist', { skip: !isDarwin || isRoot ? 'macOS, non-root only' : false }, async () => {
  const s = setup()
  const bin = fakeBinary(join(tmp('fake-launchctl-'), 'bin'), 'launchctl', 'exit 0')
  chmodSync(s.home, 0o555)
  try {
    const r = await runCli(['agent', 'install'], { ...s.env, DIAL_LAUNCHCTL_BIN: bin })
    assert.equal(r.code, 1)
    assert.equal(r.stdout, '')
    assertOneLine(r.stderr)
    assert.ok(r.stderr.startsWith('dial: dial home is not writable: '), r.stderr)
    assert.ok(r.stderr.includes(s.home))
  } finally {
    chmodSync(s.home, 0o755)
  }
  assert.ok(!existsSync(join(s.userHome, 'Library', 'LaunchAgents', 'com.dial.sync.plist')))
})

test('watch with an unwritable home is refused before the first poll', { skip: isRoot ? 'root ignores mode bits' : false }, async () => {
  const s = setup()
  chmodSync(s.home, 0o555)
  try {
    const r = await runCli(['watch'], s.env)
    assert.equal(r.code, 1)
    assert.equal(r.stdout, '')
    assertOneLine(r.stderr)
    assert.ok(r.stderr.startsWith('dial: dial home is not writable: '), r.stderr)
    assert.ok(r.stderr.includes(s.home))
  } finally {
    chmodSync(s.home, 0o755)
  }
})

test('watch exits 0 on SIGINT', async () => {
  const s = setup()
  const child = spawnCli(['watch'], s.env)
  await new Promise(r => setTimeout(r, 600))
  child.kill('SIGINT')
  const code = await new Promise(resolve => child.on('close', (c, sig) => resolve(sig ? `signal ${sig}` : c)))
  assert.equal(code, 0)
})

test('report prints the indicators read-only and --json parses', async () => {
  const s = ledger()
  const before = snapshotTree(s.home)
  const r = await runCli(['report'], s.env)
  assert.equal(r.code, 0, r.stderr)
  assert.ok(r.stdout.endsWith('\n'))
  assert.match(r.stdout, /unobserved: no sync log at /)
  const j = await runCli(['report', '--json'], s.env)
  assert.equal(j.code, 0, j.stderr)
  assert.ok(j.stdout.endsWith('}\n'))
  assert.ok('itemsByState' in JSON.parse(j.stdout))
  assert.deepEqual(snapshotTree(s.home), before)
})

test('review --week writes one note per vault, then leaves it unchanged', async () => {
  const s = ledger()
  const env = { ...s.env, DIAL_NOW: '2026-11-15T10:00:00Z' }
  await runCli(['sync', 'katipon'], env)
  const first = await runCli(['review', '--week'], env)
  assert.equal(first.code, 0, first.stderr)
  assert.ok(first.stdout.includes(`created ${join(s.vaults.personal, 'Inbox', 'Dial Review 2026-11-15.md')}`), first.stdout)
  assert.ok(existsSync(join(s.vaults.personal, 'Inbox', 'Dial Review 2026-11-15.md')))
  const again = await runCli(['review', '--week', '--json'], env)
  assert.equal(again.code, 0, again.stderr)
  assert.ok(JSON.parse(again.stdout).some(row => row.verb === 'unchanged'))
})
