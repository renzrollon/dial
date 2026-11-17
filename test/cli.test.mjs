/**
 * The binary as a subprocess. Every run gets a temp DIAL_HOME and, where the
 * stored path matters, a temp HOME so `~` collapses against a directory the
 * test owns.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { main } from '../bin/dial.mjs'
import {
  BIN, FIXTURES, fakeBinary, fakeSpawn, makeGitDir, makeHome, makeRepo, makeVault, readJson, runCli, snapshotTree, tmp, writeJson,
} from './helpers.mjs'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const VERSION = readJson(join(dirname(BIN), '..', 'package.json')).version
// Pins specs/cli-shell/spec.md, "Usage is printed on request and never as an error" (scenario
// "Usage names every command and environment variable"): the twenty-one commands, `context` (add-dial-ask) after
// `brief` and `voice` (add-voice-ui) after `watch`.
const COMMANDS = [
  'version', 'limits', 'doctor', 'register', 'unregister', 'repos', 'help', 'vault', 'sync', 'next', 'brief', 'context',
  'handoff', 'narrate', 'record', 'drop', 'agent', 'watch', 'voice', 'report', 'review',
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

test('the context line directly follows the brief entry and names [<repo>] and --json', async () => {
  // Pins specs/cli-shell/spec.md, "Usage is printed on request and never as an error" (scenario "The context line
  // follows the brief line").
  const r = await runCli(['help'], { DIAL_HOME: makeHome() })
  const lines = r.stdout.split('\n')
  const entryAt = name => lines.findIndex(l => new RegExp(`^ {2}${name}\\b`).test(l))
  const brief = entryAt('brief')
  const context = entryAt('context')
  assert.ok(brief >= 0 && context > brief, 'usage has a brief entry and a context entry after it')
  const nextCommand = lines.findIndex((l, i) => i > brief && /^ {2}\S/.test(l))
  assert.equal(nextCommand, context, `the first entry after brief is context, got ${JSON.stringify(lines[nextCommand])}`)
  const after = lines.findIndex((l, i) => i > context && /^ {2}\S/.test(l))
  const block = lines.slice(context, after).join('\n')
  assert.ok(block.includes('[<repo>]'), block)
  assert.ok(block.includes('--json'), block)
})

test('the voice line directly follows the watch entry, names the five options and does not name --json', async () => {
  // Pins specs/cli-shell/spec.md, "Usage is printed on request and never as an error" (scenario "The voice line
  // follows the watch line").
  const r = await runCli(['help'], { DIAL_HOME: makeHome() })
  const lines = r.stdout.split('\n')
  const entryAt = name => lines.findIndex(l => new RegExp(`^ {2}${name}\\b`).test(l))
  const watch = entryAt('watch')
  const voice = entryAt('voice')
  assert.ok(watch >= 0 && voice > watch, 'usage has a watch entry and a voice entry after it')
  const nextEntry = lines.findIndex((l, i) => i > watch && /^ {2}\S/.test(l))
  assert.equal(nextEntry, voice, `the first entry after watch is voice, got ${JSON.stringify(lines[nextEntry])}`)
  const after = lines.findIndex((l, i) => i > voice && /^ {2}\S/.test(l))
  const block = lines.slice(voice, after).join('\n')
  for (const option of ['--port', '--model', '--say-voice', '--lang', '--no-open']) assert.ok(block.includes(option), `${option} in ${block}`)
  assert.ok(!block.includes('--json'), block)
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

// Re-pinned for add-voice-ui, limits: "Caps are available as JSON" (the sixteen keys, in the published order).
test('limits --json is pretty-printed', async () => {
  const r = await runCli(['limits', '--json'], { DIAL_HOME: makeHome() })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, JSON.stringify(SIXTEEN_CAPS, null, 2) + '\n')
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

// Pins specs/limits/spec.md, "Every cap is published with a default and a description"
// (add-voice-ui delta, scenarios "Defaults with no registry" and "Every cap has a description"): sixteen caps,
// the three voice caps last (thirteen before add-voice-ui).
const SIXTEEN_CAPS = {
  staleDays: 14,
  archivedKeepDays: 30,
  briefLines: 40,
  subprocessTimeoutSeconds: 10,
  remoteIntervalMinutes: 30,
  syncIntervalMinutes: 15,
  narrateTurns: 20,
  narrateTimeoutSeconds: 30,
  nextRows: 50,
  watchPollSeconds: 30,
  remotePullRequests: 20,
  contextNarrative: 5,
  contextLines: 200,
  voiceTurnSeconds: 120,
  voiceCloseSeconds: 10,
  voiceTurnChars: 2000
}

// Re-pinned for add-voice-ui, limits: "Every cap is published with a default and a description" (thirteen lines became sixteen).
test('limits with no registry file prints exactly sixteen caps in the published order and exits 0', async () => {
  const r = await runCli(['limits'], { DIAL_HOME: makeHome() })
  assert.equal(r.code, 0)
  assert.ok(r.stdout.endsWith('\n'))
  const lines = r.stdout.slice(0, -1).split('\n')
  assert.equal(lines.length, 16)
  for (const line of lines) assert.match(line, /^\S+\s+=\s+\d+  [a-z]/)
  Object.entries(SIXTEEN_CAPS).forEach(([name, value], i) => assert.match(lines[i], new RegExp(`^${name}\\s+=\\s+${value}  `)))
})

// Re-pinned for add-voice-ui, limits: "Caps are available as JSON" (scenario "JSON caps": sixteen keys).
test('limits --json prints the defaults as an object', async () => {
  const r = await runCli(['limits', '--json'], { DIAL_HOME: makeHome() })
  assert.deepEqual(JSON.parse(r.stdout), SIXTEEN_CAPS)
  assert.deepEqual(Object.keys(JSON.parse(r.stdout)), Object.keys(SIXTEEN_CAPS))
})

// Re-pinned for add-voice-ui, limits: "The registry overrides a cap" (scenario "Override is reflected": the other fifteen keep their defaults).
test('a registry limits override is reflected and the other caps keep their defaults', async () => {
  const s = setup({ limits: { staleDays: 7 } })
  const r = await runCli(['limits', '--json'], s.env)
  assert.equal(r.code, 0)
  assert.deepEqual(JSON.parse(r.stdout), { ...SIXTEEN_CAPS, staleDays: 7 })
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

// --- dial context (add-dial-ask: specs/context, specs/cli-shell, specs/registry) ------------------------------

const AT = '2026-11-10T09:00:00Z'
const PR_LIST = [
  { number: 38, title: 'Add login', branch: 'feat/add-login', base: 'main', url: 'https://github.com/renzrollon/katipon/pull/38', author: 'renzrollon', draft: false, review: 'approved', mergeState: 'clean', conflicting: false, checks: [{ name: 'unit', bucket: 'pass' }], updatedAt: '2026-11-09T22:10:00Z' },
  { number: 41, title: 'Fix typo', branch: 'fix/add-login-typo', base: 'main', url: 'https://github.com/renzrollon/katipon/pull/41', author: 'caro', draft: false, review: 'none', mergeState: 'clean', conflicting: false, checks: [], updatedAt: '2026-11-08T10:00:00Z' },
]

/** `dial` run with `cwd` as the working directory (runCli cannot set one). Never rejects. */
function runIn(cwd, args, env = {}) {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { cwd, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: tmp('cli-home-'), TZ: 'UTC', ...env }, timeout: 30_000 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })
    )
  })
}

/**
 * A registered katipon (a real git work tree on feat/add-login with one change and a `lib/` directory), registered by its
 * real path so a child's working directory resolves against it, with a cache holding a list of two pull requests, a note
 * with narrative and Next items, and a `sync.jsonl` for the byte-for-byte checks.
 */
function contextLedger({ limits = {} } = {}) {
  const s = ledger({
    repos: [{ name: 'katipon', git: 'feat/add-login', spec: { changes: { 'add-login': { tasks: { done: 1, total: 5 } } }, files: { 'lib/index.mjs': '' } } }],
    limits,
  })
  const root = realpathSync(s.paths.katipon)
  writeJson(join(s.home, 'registry.json'), {
    dial_schema: 'dial.registry/1', vaults: s.vaults, repos: [{ path: root, vault: 'personal', host: 'github' }], limits,
  })
  writeJson(join(s.home, 'cache', 'remote', 'katipon.json'), {
    dial_schema: 'dial.cache/1', fetchedAt: '2026-11-10T08:55:00.000Z', host: 'github', branch: 'feat/add-login',
    pr: { number: 38, state: 'open', url: PR_LIST[0].url, conflicting: false, mergedAt: null, updatedAt: '2026-11-09T22:10:00Z' },
    checks: [{ name: 'unit', bucket: 'pass' }],
    prs: { fetchedAt: '2026-11-10T08:50:00.000Z', items: PR_LIST, more: false },
  })
  writeFileSync(join(s.home, 'sync.jsonl'), '{"at":"2026-11-09T09:00:00.000Z","repo":"katipon"}\n')
  const entries = [1, 2, 3, 4].map(n => `### 2026-11-0${n} 10:00 · dial handoff\nDone: step ${n}\nNext: step ${n + 1}\n`).join('\n')
  makeVault(s.vaults.personal, [{
    path: 'Projects/katipon.md',
    body: `\n## Narrative\n\n${entries}\n## Next\n\n- [x] merge\n- [ ] archive\n`,
  }])
  return { ...s, repo: root, env: { ...s.env, DIAL_NOW: AT } }
}

test('context <name> --json prints one two-space-indented document and exits 0', { skip: noGit }, async () => {
  const s = contextLedger()
  const r = await runCli(['context', 'katipon', '--json'], s.env)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stderr, '')
  const doc = JSON.parse(r.stdout)
  assert.equal(r.stdout, JSON.stringify(doc, null, 2) + '\n')
  assert.deepEqual(Object.keys(doc), ['repo', 'vault', 'host', 'at', 'git', 'pullRequests', 'items', 'next', 'narrative'])
  assert.deepEqual([doc.repo, doc.vault, doc.host, doc.at], ['katipon', 'personal', 'github', '2026-11-10T09:00:00.000Z'])
  assert.equal(doc.git.branch, 'feat/add-login')
  assert.equal(doc.pullRequests.observed, true)
  assert.deepEqual(doc.pullRequests.items.map(i => i.number), [38, 41])
  assert.deepEqual(doc.next, [{ note: 'Projects/katipon.md', text: 'archive' }])
})

test('context without --json prints the text form: the header, then the sections', { skip: noGit }, async () => {
  const s = contextLedger()
  const r = await runCli(['context', 'katipon'], s.env)
  assert.equal(r.code, 0, r.stderr)
  assert.ok(r.stdout.endsWith('\n'))
  const lines = r.stdout.slice(0, -1).split('\n')
  assert.match(lines[0], /^katipon · feat\/add-login · dirty \d+ · stash 0 · ahead unobserved · behind unobserved$/)
  assert.ok(lines.includes('pull requests: 2 open, fetched 10m ago'), r.stdout)
  assert.ok(lines.includes('  #38 Add login · feat/add-login → main · ready yes · add-login'), r.stdout)
  assert.ok(lines.includes('  - [ ] archive'), r.stdout)
  for (const name of ['items', 'next', 'narrative']) assert.equal(lines.filter(l => l.startsWith(`${name}:`)).length, 1, name)
})

test('context from a subdirectory of the repo resolves the repo', { skip: noGit }, async () => {
  const s = contextLedger()
  const r = await runIn(join(s.repo, 'lib'), ['context', '--json'], s.env)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).repo, 'katipon')
})

test('context <subdirectory path> --json has repo set', { skip: noGit }, async () => {
  const s = contextLedger()
  const r = await runCli(['context', join(s.repo, 'lib'), '--json'], s.env)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).repo, 'katipon')
})

test('context on an unregistered path or directory is refused with one line and exit 1', { skip: noGit }, async () => {
  const s = contextLedger()
  const scratch = realpathSync(tmp('scratch-'))
  const byArg = await runCli(['context', scratch], s.env)
  assert.equal(byArg.code, 1)
  assert.equal(byArg.stdout, '')
  assert.equal(byArg.stderr, `dial: ${scratch} is not a registered repo\n`)
  const byCwd = await runIn(scratch, ['context'], s.env)
  assert.equal(byCwd.code, 1)
  assert.equal(byCwd.stdout, '')
  assert.equal(byCwd.stderr, `dial: ${scratch} is not a registered repo\n`)
  const json = await runCli(['context', scratch, '--json'], s.env)
  assert.equal(json.code, 1)
  assert.equal(json.stdout, '')
})

test('context accepts --json and no other option: --hook and --session are unknown', async () => {
  const s = ledger()
  const hook = await runCli(['context', 'katipon', '--hook'], s.env)
  assert.equal(hook.code, 1)
  assert.equal(hook.stdout, '')
  assert.equal(hook.stderr, 'dial: unknown option: --hook\n')
  const session = await runCli(['context', 'katipon', '--session', 'abc'], s.env)
  assert.equal(session.code, 1)
  assert.equal(session.stderr, 'dial: unknown option: --session\n')
})

test('context runs none of gh, glab, interlock or escapement and leaves the cache, the vault and sync.jsonl byte for byte', { skip: noGit }, async () => {
  const s = contextLedger()
  const fakes = recorders(s.root)
  const env = { ...s.env, PATH: fakes.PATH }
  const before = { vault: snapshotTree(s.vaults.personal), work: snapshotTree(s.vaults.work), home: snapshotTree(s.home) }
  assert.ok(before.home['cache/remote/katipon.json'] && before.home['sync.jsonl'], 'the cache and the log exist beforehand')
  for (const args of [['context', 'katipon'], ['context', 'katipon', '--json']]) {
    const r = await runCli(args, env)
    assert.equal(r.code, 0, r.stderr)
  }
  assert.deepEqual(fakes.calls(), [])
  assert.deepEqual({ vault: snapshotTree(s.vaults.personal), work: snapshotTree(s.vaults.work), home: snapshotTree(s.home) }, before)
})

test('context does not create a missing Dial home', async () => {
  const home = join(tmp(), 'never-created')
  const r = await runCli(['context', 'katipon'], { DIAL_HOME: home })
  assert.equal(r.code, 1)
  assert.equal(r.stderr, 'dial: katipon is not a registered repo\n')
  assert.ok(!existsSync(home))
})

test('context text is cut at contextLines with the pointer line; --json is not', { skip: noGit }, async () => {
  const full = contextLedger()
  const all = (await runCli(['context', 'katipon'], full.env)).stdout.slice(0, -1).split('\n')
  assert.ok(all.length > 12, `the fixture's text is long enough: ${all.length} lines`)
  const capped = contextLedger({ limits: { contextLines: 10 } })
  const text = await runCli(['context', 'katipon'], capped.env)
  assert.equal(text.code, 0, text.stderr)
  const cut = text.stdout.slice(0, -1).split('\n')
  assert.equal(cut.length, 10)
  assert.deepEqual(cut.slice(0, 9), all.slice(0, 9))
  assert.equal(cut[9], `… ${all.length - 9} more lines, see dial context --json`)
  const json = JSON.parse((await runCli(['context', 'katipon', '--json'], capped.env)).stdout)
  assert.equal(json.narrative.length, 4)
  assert.equal(json.pullRequests.items.length, 2)
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

// --- voice (specs/voice, specs/cli-shell, specs/dial-home, specs/limits) ----------------------------

const VOICE_PROMPT_FILE = join(dirname(BIN), '..', 'lib', 'voice', 'prompt.md')

/** A PATH directory holding fake programs; each one records its own name and arguments in `ran`. */
function voiceBin({ claude = true, dial = true, extra = [] } = {}) {
  const dir = tmp('voice-bin-')
  const ran = join(dir, 'ran.txt')
  const body = `echo "$0 $*" >> '${ran}'`
  for (const name of [claude && 'claude', dial && 'dial', ...extra].filter(Boolean)) fakeBinary(dir, name, body)
  return { dir, ran }
}

/** A DIAL_HOME path that does not exist yet, so a test can see whether a command created it. */
const absentHome = () => join(tmp('voice-absent-'), 'home')

/** Waits, in real time, for `check()`; fails with `what` after about two seconds. */
async function until(check, what) {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${what}`)
}

const ADDRESS_LINE = /^dial voice: http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]{32})$/

/**
 * `dial voice` in this process: `main` with a fake `listen` and `fakeSpawn`. `listen` defaults to one that answers
 * ok and records `{ handler, port }`; `finish()` aborts the injected signal, exits any child the command ended (a
 * fake child never exits by itself) and resolves to the exit code.
 */
function launchVoice(args, { listen, platform = 'linux', home = absentHome(), env = {}, bin = voiceBin() } = {}) {
  const { spawn: fake, children } = fakeSpawn()
  const listens = []
  const closed = []
  const controller = new AbortController()
  const out = []
  const err = []
  const listener = listen || (async (handler, { port }) => {
    listens.push({ handler, port })
    return { ok: true, close: async () => { closed.push(port) } }
  })
  const recording = listen ? async (handler, opts) => { listens.push({ handler, ...opts }); return listen(handler, opts) } : listener
  const run = main(['voice', ...args], {
    env: { DIAL_HOME: home, HOME: tmp('voice-user-'), PATH: bin.dir, DIAL_NOW: '2026-11-17T10:00:00Z', ...env },
    stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) },
    spawn: fake, listen: recording, platform, signal: controller.signal,
  })
  let code
  run.then(c => { code = c })
  const named = name => children.filter(c => basename(c.file) === name)
  return {
    home, children, listens, closed, run,
    stdout: () => out.join(''), stderr: () => err.join(''),
    claude: () => named('claude')[0], opener: () => named('open')[0],
    started: () => until(() => named('claude').length > 0, 'the claude child to start'),
    async finish() {
      controller.abort()
      await until(() => {
        for (const c of children) if (!c.exited && (c.killed || basename(c.file) === 'open')) c.exit(c.killed ? { signal: 'SIGTERM' } : {})
        return code !== undefined
      }, 'dial voice to exit')
      return code
    },
    async exited() { await until(() => code !== undefined, 'dial voice to exit'); return code },
  }
}

const startReport = (extra = {}) => JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1', tools: ['Bash'], mcp_servers: [], permissionMode: 'dontAsk', ...extra })

// --- voice: options are checked before anything starts --------------------------------------------------

for (const value of ['80', '70000', 'abc', '1023', '65536', '3425.5']) {
  test(`voice --port ${value} is refused before the home is created or anything starts`, async () => {
    // Pins specs/voice/spec.md, "voice takes five options and checks them before it starts anything" (scenario
    // "A port out of range"); the PATH holds no claude, so a PATH check first would give another reason.
    const home = absentHome()
    const r = await runCli(['voice', '--port', value], { DIAL_HOME: home, PATH: tmp('voice-empty-') })
    assert.equal(r.code, 1)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, `dial: --port must be a number from 1024 to 65535: ${value}\n`)
    assert.equal(existsSync(home), false)
  })
}

test('voice --lang "en US" is refused, and en, en-US and zh-Hant-TW are accepted', async () => {
  // Pins specs/voice/spec.md, "voice takes five options and checks them before it starts anything" (scenario
  // "A language that is not a tag").
  const home = absentHome()
  const bad = await runCli(['voice', '--lang', 'en US'], { DIAL_HOME: home, PATH: tmp('voice-empty-') })
  assert.equal(bad.code, 1)
  assert.equal(bad.stdout, '')
  assert.equal(bad.stderr, 'dial: --lang is not a language tag: en US\n')
  assert.equal(existsSync(home), false)
  for (const tag of ['en', 'en-US', 'zh-Hant-TW']) {
    // An accepted option gets as far as the listener, which answers that the port is taken.
    const v = launchVoice(['--lang', tag], { listen: async () => ({ ok: false, code: 'EADDRINUSE', message: 'in use' }) })
    assert.equal(await v.exited(), 1, tag)
    assert.equal(v.stderr(), 'dial: port 3425 is in use; another dial voice may be running\n', tag)
  }
})

test('voice --model=-p and --say-voice=-o are refused as names that could be read as options', async () => {
  // Pins specs/voice/spec.md, scenario "A model or voice name that could be read as an option".
  const home = absentHome()
  const env = { DIAL_HOME: home, PATH: tmp('voice-empty-') }
  const model = await runCli(['voice', '--model=-p'], env)
  assert.equal(model.code, 1)
  assert.equal(model.stdout, '')
  assert.equal(model.stderr, 'dial: --model is not a model name: -p\n')
  const voice = await runCli(['voice', '--say-voice=-o'], env)
  assert.equal(voice.code, 1)
  assert.equal(voice.stdout, '')
  assert.equal(voice.stderr, 'dial: --say-voice is not a voice name: -o\n')
  assert.equal(existsSync(home), false)
})

test('voice --model " " is refused as a name and --model= by the option parser', async () => {
  // Pins specs/voice/spec.md, scenario "A name made of spaces".
  const env = { DIAL_HOME: absentHome(), PATH: tmp('voice-empty-') }
  const spaces = await runCli(['voice', '--model', ' '], env)
  assert.equal(spaces.code, 1)
  assert.equal(spaces.stdout, '')
  assert.ok(spaces.stderr.startsWith('dial: --model is not a model name: '), spaces.stderr)
  assertOneLine(spaces.stderr)
  const empty = await runCli(['voice', '--model='], env)
  assert.equal(empty.code, 1)
  assert.equal(empty.stderr, 'dial: --model needs a value\n')
})

test('voice --json and a positional argument are refused', async () => {
  // Pins specs/voice/spec.md, scenario "JSON output and positionals are refused".
  const env = { DIAL_HOME: absentHome(), PATH: tmp('voice-empty-') }
  const json = await runCli(['voice', '--json'], env)
  assert.equal(json.code, 1)
  assert.equal(json.stdout, '')
  assert.equal(json.stderr, 'dial: unknown option: --json\n')
  const positional = await runCli(['voice', 'katipon'], env)
  assert.equal(positional.code, 1)
  assert.equal(positional.stdout, '')
  assert.equal(positional.stderr, 'dial: unexpected argument: katipon\n')
  assert.equal(existsSync(env.DIAL_HOME), false)
})

// --- voice: claude and dial on PATH -------------------------------------------------------------------

test('voice with no claude on PATH is refused and creates nothing', async () => {
  // Pins specs/voice/spec.md, "voice needs claude and dial on PATH" (scenario "claude is missing"), and
  // specs/dial-home/spec.md, scenario "A voice start that is refused creates nothing".
  const bin = voiceBin({ claude: false })
  const home = absentHome()
  const r = await runCli(['voice'], { DIAL_HOME: home, PATH: bin.dir })
  assert.equal(r.code, 1)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, 'dial: claude is not on PATH\n')
  assert.equal(existsSync(home), false)
  assert.equal(existsSync(bin.ran), false)
  const neither = await runCli(['voice'], { DIAL_HOME: home, PATH: tmp('voice-empty-') })
  assert.equal(neither.stderr, 'dial: claude is not on PATH\n', 'claude is named first when both are missing')
})

test('voice with no dial on PATH is refused and claude is not started', async () => {
  // Pins specs/voice/spec.md, scenario "dial is missing".
  const bin = voiceBin({ dial: false })
  const home = absentHome()
  const r = await runCli(['voice'], { DIAL_HOME: home, PATH: bin.dir })
  assert.equal(r.code, 1)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, 'dial: dial is not on PATH\n')
  assert.equal(existsSync(home), false)
  assert.equal(existsSync(bin.ran), false, 'claude was not started')
})

test('a claude without the execute bit does not count', async () => {
  // Pins specs/voice/spec.md, scenario "A file that cannot be executed does not count".
  const bin = voiceBin()
  chmodSync(join(bin.dir, 'claude'), 0o644)
  const r = await runCli(['voice'], { DIAL_HOME: absentHome(), PATH: bin.dir })
  assert.equal(r.code, 1)
  assert.equal(r.stderr, 'dial: claude is not on PATH\n')
  assert.equal(existsSync(bin.ran), false)
})

// --- voice: the home and the caps ---------------------------------------------------------------------

test('voice with a home that is a regular file is refused with the home reason, binding nothing and running nothing', async () => {
  // Pins specs/dial-home/spec.md, "A writing command ensures the home before it writes anything else" (scenario
  // "Voice with an unwritable home"). The fakes record any run and must not have run.
  const bin = voiceBin({ extra: ['open'] })
  const file = join(tmp('voice-file-'), 'not-a-dir')
  writeFileSync(file, 'x')
  const r = await runCli(['voice'], { DIAL_HOME: file, PATH: bin.dir })
  assert.equal(r.code, 1)
  assert.equal(r.stdout, '')
  assertOneLine(r.stderr)
  assert.match(r.stderr, /^dial: dial home is not writable: .+ \(\w+: .+\)\n$/)
  assert.ok(r.stderr.includes(file), r.stderr)
  assert.equal(existsSync(bin.ran), false, 'neither claude nor open ran')
  const v = launchVoice([], { home: file, platform: 'darwin' })
  assert.equal(await v.exited(), 1)
  assert.match(v.stderr(), /^dial: dial home is not writable: /)
  assert.equal(v.listens.length, 0, 'no port was bound')
  assert.equal(v.children.length, 0, 'nothing was started')
})

test('voice with a bad cap in the registry gives the reason limits gives, before it listens or runs anything', async () => {
  // Pins specs/limits/spec.md, "The registry overrides a cap" (scenario "Voice cap with a bad value").
  const s = setup({ limits: { voiceCloseSeconds: 0 } })
  const bin = voiceBin({ extra: ['open'] })
  const env = { ...s.env, PATH: bin.dir }
  const limits = await runCli(['limits'], env)
  assert.equal(limits.code, 1)
  assert.ok(limits.stderr.includes('voiceCloseSeconds'), limits.stderr)
  const r = await runCli(['voice'], env)
  assert.equal(r.code, 1)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, limits.stderr)
  assert.equal(existsSync(bin.ran), false, 'neither claude nor open ran')
  const v = launchVoice([], { home: s.home })
  assert.equal(await v.exited(), 1)
  assert.equal(v.stderr(), limits.stderr)
  assert.equal(v.listens.length, 0, 'the listener was not asked for a port')
  assert.equal(v.children.length, 0)
})

// --- voice: in this process, with a fake listener and fake children --------------------------------------

test('voice prints one address line with a new token for every launch, on the port asked for', async () => {
  // Pins specs/voice/spec.md, "voice prints its address and opens one window" (scenario "The address line").
  const tokens = []
  for (let i = 0; i < 2; i += 1) {
    const v = launchVoice(['--port', '4000', '--no-open'])
    await v.started()
    assert.equal(v.listens[0].port, 4000)
    const lines = v.stdout().split('\n')
    assert.equal(lines.length, 2, v.stdout())
    assert.equal(lines[1], '')
    const m = ADDRESS_LINE.exec(lines[0])
    assert.ok(m, lines[0])
    assert.equal(m[1], '4000')
    tokens.push(m[2])
    assert.equal(await v.finish(), 0)
  }
  assert.notEqual(tokens[0], tokens[1])
})

test('voice asks the listener for port 3425 by default', async () => {
  // Pins specs/voice/spec.md, "voice takes five options..." (the default of --port) and "The listener binds loopback on one port".
  const v = launchVoice(['--no-open'])
  await v.started()
  assert.equal(v.listens.length, 1)
  assert.equal(v.listens[0].port, 3425)
  assert.match(v.stdout(), /^dial voice: http:\/\/127\.0\.0\.1:3425\/\?t=[0-9a-f]{32}\n$/)
  assert.equal(await v.finish(), 0)
})

test('a port in use is refused with its own line and nothing is started', async () => {
  // Pins specs/voice/spec.md, "The listener binds loopback on one port" (scenario "The port is taken").
  const v = launchVoice([], { listen: async () => ({ ok: false, code: 'EADDRINUSE', message: 'address already in use' }), platform: 'darwin' })
  assert.equal(await v.exited(), 1)
  assert.equal(v.stdout(), '')
  assert.equal(v.stderr(), 'dial: port 3425 is in use; another dial voice may be running\n')
  assert.equal(v.children.length, 0, 'no claude and no opener')
})

test('a listener that is not permitted is refused with the code and message, and nothing is started', async () => {
  // Pins specs/voice/spec.md, scenario "Listening is not permitted".
  const v = launchVoice(['--port', '4001'], { listen: async () => ({ ok: false, code: 'EPERM', message: 'operation not permitted' }), platform: 'darwin' })
  assert.equal(await v.exited(), 1)
  assert.equal(v.stdout(), '')
  assert.equal(v.stderr(), 'dial: cannot listen on 127.0.0.1:4001 (EPERM: operation not permitted)\n')
  assert.equal(v.children.length, 0)
})

test('voice creates the home, logs and an empty voice directory', async () => {
  // Pins specs/dial-home/spec.md, "The home is created on first write and left alone afterwards" (scenario
  // "Voice creates the layout").
  const v = launchVoice(['--no-open'])
  await v.started()
  assert.ok(existsSync(join(v.home, 'logs')))
  assert.ok(statSync(join(v.home, 'voice')).isDirectory())
  assert.deepEqual(readdirSync(join(v.home, 'voice')), [])
  assert.equal(await v.finish(), 0)
})

test('the session starts in the voice directory with the same home and clock, the packaged prompt and the default model', async () => {
  // Pins specs/voice-engine/spec.md, "A conversation is one claude process fed over a stream" (cwd and
  // environment) and the prompt rule: the prompt argument is the file lib/voice/prompt.md.
  const v = launchVoice(['--no-open'])
  await v.started()
  const child = v.claude()
  assert.equal(child.cwd, join(v.home, 'voice'))
  assert.equal(child.env.DIAL_HOME, v.home)
  assert.equal(child.env.DIAL_NOW, '2026-11-17T10:00:00Z')
  const prompt = readFileSync(VOICE_PROMPT_FILE, 'utf8')
  assert.equal(child.args[child.args.indexOf('--append-system-prompt') + 1], prompt)
  assert.equal(child.args[child.args.indexOf('--model') + 1], 'sonnet')
  assert.equal(child.args.includes('--session-id'), true)
  assert.equal(await v.finish(), 0)
})

test('--model reaches the session', async () => {
  const v = launchVoice(['--no-open', '--model', 'opus'])
  await v.started()
  const args = v.claude().args
  assert.equal(args[args.indexOf('--model') + 1], 'opus')
  assert.equal(await v.finish(), 0)
})

test('an abort ends the session and the listener and the exit code is 0 with nothing on stderr', async () => {
  // Pins specs/voice/spec.md, "voice runs in the foreground until it is closed" (scenario "An interrupt ends the command").
  const v = launchVoice(['--no-open'])
  await v.started()
  assert.equal(await v.finish(), 0)
  assert.equal(v.claude().killed, true, 'the claude child was ended')
  assert.equal(v.closed.length, 1, 'the listener was closed')
  assert.equal(v.stderr(), '')
})

test('on macOS the window is opened once with Chrome in app mode at the printed address', async () => {
  // Pins specs/voice/spec.md, "voice prints its address and opens one window" (scenario "The window is opened on macOS").
  const v = launchVoice([], { platform: 'darwin' })
  await until(() => v.opener(), 'the opener to start')
  const address = v.stdout().trim().replace(/^dial voice: /, '')
  assert.match(address, /^http:\/\/127\.0\.0\.1:3425\/\?t=[0-9a-f]{32}$/)
  assert.deepEqual(v.opener().args, ['-na', 'Google Chrome', '--args', `--app=${address}`])
  assert.equal(v.children.filter(c => basename(c.file) === 'open').length, 1)
  assert.equal(await v.finish(), 0)
})

test('no opener runs with --no-open or off macOS', async () => {
  // Pins specs/voice/spec.md, scenario "No opener on request or off macOS".
  for (const [args, platform] of [[['--no-open'], 'darwin'], [[], 'linux']]) {
    const v = launchVoice(args, { platform })
    await v.started()
    assert.equal(v.opener(), undefined, `${args.join(' ')} on ${platform}`)
    assert.equal(await v.finish(), 0)
  }
})

test('a refused session is reported once and the exit code after an abort is 1', async () => {
  // Pins specs/voice-engine/spec.md, "A refused session is ended and reported, and no other is started"
  // (scenarios "The refusal reaches the terminal and the page" and "The exit code"); cli-shell: exactly one `dial: ` line.
  const v = launchVoice(['--no-open'])
  await v.started()
  v.claude().line(startReport({ tools: ['Bash', 'Read'] }))
  await until(() => v.stderr() !== '', 'the refusal line')
  assert.equal(v.claude().killed, true, 'the refused session was ended')
  assert.equal(await v.finish(), 1)
  assert.equal(v.stderr(), 'dial: voice session refused: it has tools other than Bash: Read\n')
  assert.equal(v.children.filter(c => basename(c.file) === 'claude').length, 1, 'no second session')
})

test('a failed opener is one warning and the command goes on to exit 0', async () => {
  // Pins specs/cli-shell/spec.md, "Every failure is one reason line on stderr" (scenario "A voice warning is not
  // the failure line") and specs/voice/spec.md, scenario "The opener fails".
  const v = launchVoice([], { platform: 'darwin' })
  await until(() => v.opener(), 'the opener to start')
  v.opener().exit({ code: 1, stderr: 'Unable to find application named "Google Chrome"\nsecond line\n' })
  await until(() => v.stderr() !== '', 'the warning')
  assert.equal(v.claude().killed, false, 'the command keeps running')
  assert.equal(await v.finish(), 0)
  assert.equal(v.stderr(), 'dial: could not open Chrome (Unable to find application named "Google Chrome"); open the address above in Chrome\n')
})

test('a failed opener and then a refused session are two lines and the exit code is 1', async () => {
  // Pins specs/cli-shell/spec.md, scenario "A voice warning beside the failure line".
  const v = launchVoice([], { platform: 'darwin' })
  await until(() => v.opener(), 'the opener to start')
  v.opener().exit({ code: 1, stderr: 'Unable to find application named "Google Chrome"\n' })
  await until(() => v.stderr() !== '', 'the warning')
  v.claude().line(startReport({ mcp_servers: [{ name: 'github', status: 'connected' }] }))
  await until(() => v.stderr().split('\n').length > 2, 'the refusal line')
  assert.equal(await v.finish(), 1)
  assert.equal(
    v.stderr(),
    'dial: could not open Chrome (Unable to find application named "Google Chrome"); open the address above in Chrome\n' +
    'dial: voice session refused: it has MCP servers: github\n'
  )
})

// --- voice: one real process with fake programs ----------------------------------------------------------

/** A free loopback port, or null where the bind is refused with EPERM. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', e => (e.code === 'EPERM' ? resolve(null) : reject(e)))
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** One request to the child on 127.0.0.1:port; resolves { status, headers, body } and never rejects on a status. */
function httpTo(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('dial voice serves the page, takes a turn to a fake claude, streams a sentence and ends on SIGINT', { timeout: 30_000 }, async t => {
  // One subprocess case (tasks 1.8): `dial voice --no-open` with fake claude, dial and say on PATH. Skipped where
  // the bind is refused, as the sandbox does.
  const port = await freePort()
  if (port === null) return t.skip('loopback bind refused (EPERM)')
  const state = tmp('voice-e2e-')
  const bin = tmp('voice-e2e-bin-')
  const delta = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Two are open. ' } } })
  fakeBinary(bin, 'claude', [
    `echo $$ > '${state}/claude.pid'`,
    `printf '%s\\n' '${startReport()}'`,
    'while IFS= read -r line; do',
    `  printf '%s\\n' "$line" >> '${state}/turns.txt'`,
    `  printf '%s\\n' '${delta}'`,
    `  printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"Two are open."}'`,
    'done',
  ].join('\n'))
  fakeBinary(bin, 'dial', 'exit 0')
  fakeBinary(bin, 'say', `cat >> '${state}/say.txt'`)
  const child = spawnCli(['voice', '--no-open', '--port', String(port)], {
    DIAL_HOME: join(state, 'home'), HOME: tmp('voice-user-'), PATH: `${bin}:/usr/bin:/bin`,
  })
  let stdout = ''
  child.stdout.on('data', c => { stdout += c })
  let stderr = ''
  child.stderr.on('data', c => { stderr += c })
  const exit = new Promise(resolve => child.on('close', (c, sig) => resolve(sig ? `signal ${sig}` : c)))
  try {
    await until(() => ADDRESS_LINE.test(stdout.split('\n')[0]), 'the address line')
    const [, linePort, token] = ADDRESS_LINE.exec(stdout.split('\n')[0])
    assert.equal(linePort, String(port))
    const origin = `http://127.0.0.1:${port}`

    const page = await httpTo(port, { path: `/?t=${token}` })
    assert.equal(page.status, 200)
    assert.match(page.headers['content-type'], /^text\/html/)
    assert.ok(page.body.includes('/page.js'), 'the page refers to its script')

    // The event stream stays open until the command ends, so SIGINT has an open stream to close.
    let events = ''
    const stream = httpRequest({ host: '127.0.0.1', port, path: `/events?t=${token}` }, res => res.on('data', c => { events += c }))
    stream.on('error', () => {})
    stream.end()
    await until(() => events.includes('event: state'), 'hello and the first state on the event stream')

    const post = headers => httpTo(port, {
      method: 'POST', path: '/turn', body: JSON.stringify({ text: 'what needs me' }),
      headers: { 'content-type': 'application/json', 'x-dial-token': token, origin, ...headers },
    })
    const foreign = await post({ origin: 'https://example.com' })
    assert.equal(foreign.status, 403)
    assert.equal(existsSync(join(state, 'turns.txt')), false, 'a refused request reached nothing')

    const accepted = await post({})
    assert.equal(accepted.status, 202)
    assert.deepEqual(JSON.parse(accepted.body), { ok: true })
    await until(() => existsSync(join(state, 'turns.txt')), 'the turn to reach claude')
    assert.ok(readFileSync(join(state, 'turns.txt'), 'utf8').includes('what needs me'))
    await until(() => events.includes('event: sentence'), 'a sentence on the event stream')
    assert.ok(events.includes('data: {"text":"Two are open."}'), events)

    const claudePid = Number(readFileSync(join(state, 'claude.pid'), 'utf8'))
    child.kill('SIGINT')
    assert.equal(await exit, 0, stderr)
    stream.destroy()
    await until(() => {
      try { process.kill(claudePid, 0); return false } catch { return true }
    }, 'the fake claude to be gone')
  } finally {
    child.kill('SIGKILL')
  }
})
