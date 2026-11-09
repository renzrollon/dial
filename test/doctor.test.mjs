/**
 * Doctor, in-process: `diagnose({ env, cwd, pathDirs })` and `formatDoctor(report)`.
 * Pins specs/doctor/spec.md and the doctor scenarios of specs/dial-home/spec.md.
 *
 * Harness assumptions (not pinned by a spec, stated here so 2.x can honour them):
 * - the user home for `~/.claude/settings.json` is `env.HOME`;
 * - `diagnose` may be sync or async, so every call is awaited;
 * - the managed settings path is fixed by the spec and is not injectable, so
 *   these tests assume none exists on the machine running them.
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { diagnose, formatDoctor } from '../lib/doctor.mjs'
import { FIXTURES, makeGitDir, makeHome, makeVault, readJson, snapshotTree, tmp, writeJson } from './helpers.mjs'

const STATUSES = ['ok', 'warn', 'fail', 'skip']
const IDS = ['node', 'home', 'registry', 'obsidian-cli', 'boundary', 'permissions']
const SNIPPET_HEAD = 'Add to ~/.claude/settings.json → permissions.allow:'

const fixture = name => readFileSync(join(FIXTURES, name), 'utf8')

/**
 * A complete, all-green machine unless overridden: existing writable home, a
 * registry with two real vault directories and one real git repo, user settings
 * that allow `Bash(dial:*)`, and no `obsidian` on the path.
 *
 * `registry`: false = no file, string = raw file, object = registry body
 * (default: the green one). `userSettings` / `projectSettings` / `localSettings`:
 * false = no file, string = raw file text, object = JSON.
 */
function world(opts = {}) {
  const root = tmp('dial-doctor-')
  const personal = makeVault(join(root, 'personal'))
  const work = makeVault(join(root, 'work'))
  const repo = makeGitDir(join(root, 'repos', 'katipon'))
  const greenRegistry = {
    dial_schema: 'dial.registry/1',
    vaults: { personal, work },
    repos: [{ path: repo, vault: 'personal', host: 'github' }],
    limits: {},
  }
  const { registry = greenRegistry, userSettings = fixture('settings-allow-dial.json') } = opts
  const home = opts.home ?? makeHome({ registry: registry === false ? undefined : registry })
  const userHome = join(root, 'userhome')
  const cwd = join(root, 'cwd')
  mkdirSync(userHome, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const put = (file, value) => {
    if (value === false || value === undefined) return
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  }
  put(join(userHome, '.claude', 'settings.json'), userSettings)
  put(join(cwd, '.claude', 'settings.json'), opts.projectSettings)
  put(join(cwd, '.claude', 'settings.local.json'), opts.localSettings)

  const binDir = join(root, 'bin')
  mkdirSync(binDir, { recursive: true })
  if (opts.obsidian) {
    writeFileSync(join(binDir, 'obsidian'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(binDir, 'obsidian'), 0o755)
  }
  return {
    root, personal, work, repo, home, userHome, cwd,
    env: { DIAL_HOME: home, HOME: userHome, PATH: '' },
    pathDirs: [binDir],
    registryFile: join(home, 'registry.json'),
  }
}

const run = async (w, overrides = {}) => diagnose({ env: w.env, cwd: w.cwd, pathDirs: w.pathDirs, ...overrides })
const byId = (report, id) => report.checks.find(c => c.id === id)
const lines = text => text.split('\n')
const text = report => formatDoctor(report)

/** A registry body naming `personal`, `work` and the given repos (`{ name, vault }`). */
function registryWith(w, repos) {
  return {
    dial_schema: 'dial.registry/1',
    vaults: { personal: w.personal, work: w.work },
    repos: repos.map(({ name, vault, host = 'github' }) => ({
      path: makeGitDir(join(w.root, 'repos', name)),
      vault,
      host,
    })),
    limits: {},
  }
}

// ---------------------------------------------------------------- record shape

test('record shape: every check has id, status, detail and evidence', async () => {
  const report = await run(world())
  assert.deepEqual(report.checks.map(c => c.id), IDS)
  for (const c of report.checks) {
    assert.equal(typeof c.id, 'string')
    assert.ok(STATUSES.includes(c.status), `${c.id}: bad status ${c.status}`)
    assert.equal(typeof c.detail, 'string', `${c.id}: detail`)
    assert.ok(!c.detail.includes('\n'), `${c.id}: detail is one line`)
    assert.ok(Array.isArray(c.evidence), `${c.id}: evidence`)
    for (const e of c.evidence) assert.equal(typeof e, 'string')
    if ('fix' in c) assert.equal(typeof c.fix, 'string')
  }
})

test('record shape: the report carries ok, home, counts, checks, failures and warnings and survives JSON', async () => {
  const w = world()
  const report = await run(w)
  assert.deepEqual(Object.keys(report).sort(), ['checks', 'counts', 'failures', 'home', 'ok', 'warnings'])
  assert.equal(report.home, w.home)
  assert.equal(report.ok, true)
  assert.deepEqual(report.failures, [])
  assert.deepEqual(report.warnings, [])
  for (const s of STATUSES) assert.equal(typeof report.counts[s], 'number', `counts.${s}`)
  assert.equal(report.counts.ok + report.counts.warn + report.counts.fail + report.counts.skip, IDS.length)
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report)
})

test('a throwing check becomes a fail record and the others still report', async () => {
  // A pathDirs that cannot be iterated makes only the obsidian-cli scan throw.
  const report = await run(world(), { pathDirs: 42 })
  const broken = byId(report, 'obsidian-cli')
  assert.equal(broken.status, 'fail')
  assert.match(broken.detail, /^check could not run: ./)
  assert.deepEqual(report.checks.map(c => c.id), IDS)
  for (const id of IDS.filter(i => i !== 'obsidian-cli')) assert.notEqual(byId(report, id).status, 'fail', id)
  assert.equal(report.ok, false)
  assert.deepEqual(report.failures, ['obsidian-cli'])
})

// ------------------------------------------------------------- header and exit

test('all green: DIAL OK with 5 passed, the skip is not counted, home line follows', async () => {
  const w = world()
  const report = await run(w)
  assert.equal(byId(report, 'obsidian-cli').status, 'skip')
  for (const id of ['node', 'home', 'registry', 'boundary', 'permissions']) {
    assert.equal(byId(report, id).status, 'ok', `${id}: ${byId(report, id).detail}`)
  }
  assert.equal(report.counts.ok, 5)
  assert.equal(report.counts.skip, 1)
  assert.equal(report.ok, true)
  const out = lines(text(report))
  assert.equal(out[0], 'DIAL OK — 5 passed')
  assert.equal(out[1], `  home: ${w.home}`)
})

test('warnings only: header ends with the warning count and the run is still ok', async () => {
  const w = world()
  // A registered repo whose path is gone is a warn, nothing else changes.
  const reg = readJson(w.registryFile)
  reg.repos.push({ path: join(w.root, 'repos', 'moved'), vault: 'personal', host: 'github' })
  writeJson(w.registryFile, reg)
  const report = await run(w)
  assert.equal(report.counts.warn, 1)
  assert.equal(report.counts.fail, 0)
  assert.equal(report.ok, true)
  assert.deepEqual(report.warnings, ['registry'])
  const first = lines(text(report))[0]
  assert.ok(first.startsWith('DIAL OK — '), first)
  assert.ok(first.endsWith(', 1 warning(s)'), first)
  assert.equal(first, `DIAL OK — ${report.counts.ok} passed, 1 warning(s)`)
})

test('one failure: DIAL BLOCKED, failures holds the id, ok is false', async () => {
  const w = world()
  const reg = readJson(w.registryFile)
  reg.vaults.work = join(w.root, 'no-such-vault')
  writeJson(w.registryFile, reg)
  const report = await run(w)
  assert.equal(report.counts.fail, 1)
  assert.deepEqual(report.failures, ['registry'])
  assert.deepEqual(report.warnings, [])
  assert.equal(report.ok, false)
  assert.equal(lines(text(report))[0], 'DIAL BLOCKED — 1 failing check(s)')
})

test('a failure and a warning together: BLOCKED header with the warning suffix', async () => {
  const w = world({ userSettings: false }) // permissions warns
  const reg = readJson(w.registryFile)
  reg.vaults.work = join(w.root, 'no-such-vault') // registry fails
  writeJson(w.registryFile, reg)
  const report = await run(w)
  assert.deepEqual(report.failures, ['registry'])
  assert.deepEqual(report.warnings, ['permissions'])
  assert.equal(lines(text(report))[0], 'DIAL BLOCKED — 1 failing check(s), 1 warning(s)')
})

// ------------------------------------------------------------------ rendering

/** A hand-built report, so rendering is tested apart from the checks. */
function reportOf(checks, home = '/h') {
  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 }
  for (const c of checks) counts[c.status]++
  return {
    ok: counts.fail === 0,
    home,
    counts,
    checks,
    failures: checks.filter(c => c.status === 'fail').map(c => c.id),
    warnings: checks.filter(c => c.status === 'warn').map(c => c.id),
  }
}

test('rendering: failing row with two evidence lines and a two-line fix', () => {
  const out = lines(
    formatDoctor(
      reportOf([
        { id: 'alpha', status: 'fail', detail: 'it broke', evidence: ['first evidence', 'second evidence'], fix: 'do this\nthen that' },
        { id: 'beta', status: 'ok', detail: 'fine', evidence: [] },
      ])
    )
  )
  const at = out.indexOf('  [FAIL] alpha: it broke')
  assert.ok(at >= 0, `row missing in:\n${out.join('\n')}`)
  assert.equal(out[at + 1], '         first evidence')
  assert.equal(out[at + 2], '         second evidence')
  assert.equal(out[at + 3], '      fix: do this')
  assert.equal(out[at + 4], '           then that')
  assert.equal(out[at + 5], '  [ok  ] beta: fine')
})

test('rendering: warn rows print evidence and fix like fail rows', () => {
  const out = lines(formatDoctor(reportOf([{ id: 'w', status: 'warn', detail: 'hmm', evidence: ['e1'], fix: 'f1' }])))
  const at = out.indexOf('  [warn] w: hmm')
  assert.ok(at >= 0)
  assert.equal(out[at + 1], '         e1')
  assert.equal(out[at + 2], '      fix: f1')
})

test('rendering: a passing row with evidence is one line', () => {
  const out = lines(
    formatDoctor(
      reportOf([
        { id: 'good', status: 'ok', detail: 'all fine', evidence: ['should not print'], fix: 'nor this' },
        { id: 'next', status: 'ok', detail: 'also fine', evidence: [] },
      ])
    )
  )
  const at = out.indexOf('  [ok  ] good: all fine')
  assert.ok(at >= 0)
  assert.equal(out[at + 1], '  [ok  ] next: also fine')
  assert.ok(!out.join('\n').includes('should not print'))
  assert.ok(!out.join('\n').includes('nor this'))
})

test('rendering: a skip row is one line', () => {
  const out = lines(
    formatDoctor(
      reportOf([
        { id: 'opt', status: 'skip', detail: 'not installed', evidence: ['hidden'] },
        { id: 'next', status: 'ok', detail: 'fine', evidence: [] },
      ])
    )
  )
  const at = out.indexOf('  [skip] opt: not installed')
  assert.ok(at >= 0)
  assert.equal(out[at + 1], '  [ok  ] next: fine')
  assert.ok(!out.join('\n').includes('hidden'))
})

// -------------------------------------------------------------- node and home

test('node: ok on the running interpreter, which is major 22 or newer', async () => {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22)
  const report = await run(world())
  assert.equal(byId(report, 'node').status, 'ok')
})

test('home: an absent home is not created and reports it will be created on first register', async () => {
  const parent = tmp('dial-doctor-parent-')
  const home = join(parent, 'not-yet')
  const w = world({ home, registry: false })
  const before = snapshotTree(parent)
  const report = await run(w)
  const check = byId(report, 'home')
  assert.equal(check.status, 'ok')
  assert.equal(check.detail, 'will be created on first register')
  assert.equal(existsSync(home), false)
  assert.deepEqual(snapshotTree(parent), before)
  assert.equal(report.home, home)
})

test('home: an existing writable home is ok and leaves no probe file', async () => {
  const w = world()
  const before = snapshotTree(w.home)
  const report = await run(w)
  assert.equal(byId(report, 'home').status, 'ok')
  assert.notEqual(byId(report, 'home').detail, 'will be created on first register')
  assert.deepEqual(snapshotTree(w.home), before)
})

test('home: an unusable home is fail with the reason and doctor keeps running', async () => {
  const dir = tmp('dial-doctor-file-')
  const home = join(dir, 'a-file')
  writeFileSync(home, 'not a directory')
  const w = world({ home, registry: false })
  const report = await run(w)
  const check = byId(report, 'home')
  assert.equal(check.status, 'fail')
  assert.ok(check.detail.includes(home), check.detail)
  assert.match(check.detail, /not writable/)
  assert.deepEqual(report.checks.map(c => c.id), IDS)
  assert.equal(report.ok, false)
  assert.ok(report.failures.includes('home'))
  assert.ok(lines(text(report))[0].startsWith('DIAL BLOCKED — '))
})

// ------------------------------------------------------------------- registry

test('registry: no file yet is ok with the file path as evidence', async () => {
  const w = world({ registry: false })
  const check = byId(await run(w), 'registry')
  assert.equal(check.status, 'ok')
  assert.equal(check.detail, 'no registry yet')
  assert.ok(check.evidence.includes(w.registryFile), check.evidence.join('|'))
})

test('registry: a valid registry with real vaults and a real repo is ok', async () => {
  const check = byId(await run(world()), 'registry')
  assert.equal(check.status, 'ok', check.detail)
})

test('registry: a file that is not JSON is fail', async () => {
  const w = world({ registry: fixture('registry-not-json.txt') })
  const report = await run(w)
  assert.equal(byId(report, 'registry').status, 'fail')
  assert.equal(report.ok, false)
  assert.ok(report.failures.includes('registry'))
})

test('registry: a wrong schema marker is fail', async () => {
  const w = world({ registry: fixture('registry-wrong-schema.json') })
  assert.equal(byId(await run(w), 'registry').status, 'fail')
})

test('registry: a vault path that does not exist is fail naming the vault and its path, exit-failing', async () => {
  const w = world()
  const gone = join(w.root, 'vanished-vault')
  const reg = readJson(w.registryFile)
  reg.vaults.work = gone
  writeJson(w.registryFile, reg)
  const report = await run(w)
  const check = byId(report, 'registry')
  assert.equal(check.status, 'fail')
  const said = [check.detail, ...check.evidence].join('\n')
  assert.ok(said.includes('work'), said)
  assert.ok(said.includes(gone), said)
  assert.equal(report.ok, false)
})

test('registry: a vault path that is a file, not a directory, is fail', async () => {
  const w = world()
  const file = join(w.root, 'vault-is-a-file')
  writeFileSync(file, 'x')
  const reg = readJson(w.registryFile)
  reg.vaults.work = file
  writeJson(w.registryFile, reg)
  assert.equal(byId(await run(w), 'registry').status, 'fail')
})

test('registry: a repo path that no longer exists is warn naming that path and does not fail the run', async () => {
  const w = world()
  const moved = join(w.root, 'repos', 'moved')
  const reg = readJson(w.registryFile)
  reg.repos.push({ path: moved, vault: 'work', host: 'gitlab' })
  writeJson(w.registryFile, reg)
  const report = await run(w)
  const check = byId(report, 'registry')
  assert.equal(check.status, 'warn')
  assert.ok([check.detail, ...check.evidence].join('\n').includes(moved))
  assert.equal(report.ok, true)
})

test('registry: a repo path that is not a git work tree is warn', async () => {
  const w = world()
  const plain = join(w.root, 'repos', 'plain')
  mkdirSync(plain, { recursive: true })
  const reg = readJson(w.registryFile)
  reg.repos.push({ path: plain, vault: 'work', host: 'gitlab' })
  writeJson(w.registryFile, reg)
  const check = byId(await run(w), 'registry')
  assert.equal(check.status, 'warn')
  assert.ok([check.detail, ...check.evidence].join('\n').includes(plain))
})

test('registry: a linked worktree whose .git is a file counts as a git work tree', async () => {
  const w = world()
  const linked = makeGitDir(join(w.root, 'repos', 'linked'), { worktree: true })
  const reg = readJson(w.registryFile)
  reg.repos.push({ path: linked, vault: 'work', host: 'gitlab' })
  writeJson(w.registryFile, reg)
  assert.equal(byId(await run(w), 'registry').status, 'ok')
})

// ---------------------------------------------------------------- obsidian-cli

test('obsidian-cli: no obsidian on the path is skip that names direct file writes, exit unaffected', async () => {
  const report = await run(world())
  const check = byId(report, 'obsidian-cli')
  assert.equal(check.status, 'skip')
  assert.match(check.detail, /direct file writes/i)
  assert.equal(report.ok, true)
})

test('obsidian-cli: an executable obsidian on a path directory is ok', async () => {
  const check = byId(await run(world({ obsidian: true })), 'obsidian-cli')
  assert.equal(check.status, 'ok')
})

// -------------------------------------------------------------------- boundary

const dialNote = (path, extra = {}) => ({ path, frontmatter: { dial_schema: 'dial.note/1', ...extra } })

test('boundary: vaults without Projects or Changes are ok with no dial notes and one evidence line per vault', async () => {
  const check = byId(await run(world()), 'boundary')
  assert.equal(check.status, 'ok')
  assert.equal(check.detail, 'no dial notes')
  assert.equal(check.evidence.length, 2)
})

test('boundary: folders holding only hand-written notes are ok with no dial notes', async () => {
  const w = world()
  makeVault(w.personal, [{ path: 'Projects/Holiday.md', frontmatter: { title: 'Holiday' } }, { path: 'Changes/plain.md', body: 'no frontmatter' }])
  const check = byId(await run(w), 'boundary')
  assert.equal(check.status, 'ok')
  assert.equal(check.detail, 'no dial notes')
})

test('boundary: a note whose repo is registered to another vault fails naming the file and both vaults', async () => {
  const w = world()
  writeJson(w.registryFile, registryWith(w, [{ name: 'katipon', vault: 'work' }]))
  makeVault(w.personal, [dialNote('Changes/katipon--uat-readiness.md', { repo: 'katipon' })])
  const report = await run(w)
  const check = byId(report, 'boundary')
  assert.equal(check.status, 'fail')
  assert.ok(check.detail.includes('Changes/katipon--uat-readiness.md'), check.detail)
  assert.ok(check.detail.includes('personal'), check.detail)
  assert.ok(check.detail.includes('work'), check.detail)
  assert.equal(report.ok, false)
  assert.ok(report.failures.includes('boundary'))
})

test('boundary: a note in the vault its repo is registered to passes', async () => {
  const w = world()
  writeJson(w.registryFile, registryWith(w, [{ name: 'katipon', vault: 'personal' }]))
  makeVault(w.personal, [dialNote('Changes/katipon--uat-readiness.md', { repo: 'katipon' })])
  assert.equal(byId(await run(w), 'boundary').status, 'ok')
})

test('boundary: a dial note for a repo that is not registered is not a violation', async () => {
  const w = world()
  makeVault(w.personal, [dialNote('Projects/ghost.md', { repo: 'ghost' })])
  assert.equal(byId(await run(w), 'boundary').status, 'ok')
})

test('boundary: a hand-written note without dial_schema is ignored', async () => {
  const w = world()
  writeJson(w.registryFile, registryWith(w, [{ name: 'katipon', vault: 'work' }]))
  makeVault(w.personal, [{ path: 'Projects/Holiday.md', frontmatter: { title: 'Holiday', repo: 'katipon' } }])
  assert.equal(byId(await run(w), 'boundary').status, 'ok')
})

test('boundary: under Changes/ the repo is the filename stem before the first double dash', async () => {
  const w = world()
  writeJson(w.registryFile, registryWith(w, [{ name: 'specflow', vault: 'work' }]))
  makeVault(w.personal, [dialNote('Changes/specflow--clear-findings.md')])
  const check = byId(await run(w), 'boundary')
  assert.equal(check.status, 'fail')
  assert.ok(check.detail.includes('specflow'), check.detail)
  assert.ok(check.detail.includes('personal') && check.detail.includes('work'), check.detail)
})

test('boundary: under Projects/ the repo is the whole filename stem', async () => {
  const w = world()
  writeJson(w.registryFile, registryWith(w, [{ name: 'katipon', vault: 'work' }]))
  makeVault(w.personal, [dialNote('Projects/katipon.md')])
  assert.equal(byId(await run(w), 'boundary').status, 'fail')
})

test('boundary: frontmatter repo wins over the filename', async () => {
  const w = world()
  writeJson(w.registryFile, registryWith(w, [{ name: 'katipon', vault: 'work' }, { name: 'other', vault: 'personal' }]))
  makeVault(w.personal, [dialNote('Changes/katipon--x.md', { repo: 'other' })])
  assert.equal(byId(await run(w), 'boundary').status, 'ok')
})

test('boundary: doctor never writes to a vault', async () => {
  const w = world()
  writeJson(w.registryFile, registryWith(w, [{ name: 'katipon', vault: 'work' }]))
  makeVault(w.personal, [
    dialNote('Changes/katipon--uat-readiness.md', { repo: 'katipon' }),
    dialNote('Projects/other.md'),
    { path: 'Projects/Holiday.md', frontmatter: { title: 'Holiday' } },
  ])
  makeVault(w.work, [dialNote('Projects/katipon.md', { repo: 'katipon' })])
  const before = { personal: snapshotTree(w.personal), work: snapshotTree(w.work) }
  assert.ok(Object.keys(before.personal).length >= 5)
  await run(w)
  assert.deepEqual({ personal: snapshotTree(w.personal), work: snapshotTree(w.work) }, before)
})

test('boundary: a registry that fails to load skips the check with registry not loaded', async () => {
  const w = world({ registry: fixture('registry-not-json.txt') })
  const check = byId(await run(w), 'boundary')
  assert.equal(check.status, 'skip')
  assert.equal(check.detail, 'registry not loaded')
})

test('boundary: a missing registry file is an empty load, not a skip', async () => {
  const check = byId(await run(world({ registry: false })), 'boundary')
  assert.equal(check.status, 'ok')
})

// ----------------------------------------------------------------- permissions

test('permissions: a rule in the user settings is ok and the file is evidence', async () => {
  const w = world()
  const check = byId(await run(w), 'permissions')
  assert.equal(check.status, 'ok')
  assert.ok(check.evidence.includes(`user: ${join(w.userHome, '.claude', 'settings.json')}`), check.evidence.join('|'))
})

test('permissions: settings.local.json under cwd is read and listed as local', async () => {
  const w = world({ userSettings: false, localSettings: fixture('settings-allow-dial.json') })
  const check = byId(await run(w), 'permissions')
  assert.equal(check.status, 'ok')
  assert.ok(check.evidence.includes(`local: ${join(w.cwd, '.claude', 'settings.local.json')}`), check.evidence.join('|'))
})

test('permissions: settings.json under cwd is read and listed as project', async () => {
  const w = world({ userSettings: false, projectSettings: fixture('settings-allow-dial.json') })
  const check = byId(await run(w), 'permissions')
  assert.equal(check.status, 'ok')
  assert.ok(check.evidence.includes(`project: ${join(w.cwd, '.claude', 'settings.json')}`), check.evidence.join('|'))
})

test('permissions: only files that exist appear in evidence', async () => {
  const w = world({ userSettings: false, localSettings: fixture('settings-allow-dial.json') })
  const check = byId(await run(w), 'permissions')
  assert.equal(check.evidence.filter(e => e.startsWith('user:')).length, 0)
  assert.equal(check.evidence.filter(e => e.startsWith('project:')).length, 0)
})

for (const rule of ['Bash', 'Bash(*)']) {
  test(`permissions: the broad rule ${rule} covers dial`, async () => {
    const w = world({ userSettings: { permissions: { allow: [rule] } } })
    assert.equal(byId(await run(w), 'permissions').status, 'ok')
  })
}

test('permissions: Bash(dial doctor:*) is narrower and does not cover dial', async () => {
  const w = world({ userSettings: fixture('settings-allow-narrow.json') })
  const report = await run(w)
  const check = byId(report, 'permissions')
  assert.equal(check.status, 'warn')
  assert.ok(lines(check.fix).includes('"Bash(dial:*)"'), check.fix)
  assert.equal(report.ok, true)
})

test('permissions: no settings file at all is warn with the snippet', async () => {
  const check = byId(await run(world({ userSettings: false })), 'permissions')
  assert.equal(check.status, 'warn')
  assert.ok(check.fix.includes('"Bash(dial:*)"'))
})

test('permissions: a deny rule that matches dial is warn even when allow covers it', async () => {
  const w = world({ userSettings: { permissions: { allow: ['Bash(dial:*)'], deny: ['Bash(dial:*)'] } } })
  assert.equal(byId(await run(w), 'permissions').status, 'warn')
})

test('permissions: an unreadable settings file is warn naming it and doctor does not crash', async () => {
  const w = world({ userSettings: fixture('settings-broken.json') })
  const report = await run(w)
  const file = join(w.userHome, '.claude', 'settings.json')
  const check = byId(report, 'permissions')
  assert.equal(check.status, 'warn')
  assert.ok(check.evidence.some(e => e.includes(file)), check.evidence.join('|'))
  assert.deepEqual(report.checks.map(c => c.id), IDS)
})

test('permissions: the verdict does not depend on the registry', async () => {
  const w = world({ registry: fixture('registry-not-json.txt') })
  assert.equal(byId(await run(w), 'permissions').status, 'ok')
})

test('snippet: first line is the instruction and the last is the rule with no trailing comma', async () => {
  const check = byId(await run(world({ userSettings: fixture('settings-allow-narrow.json') })), 'permissions')
  const fix = lines(check.fix)
  assert.equal(fix[0], SNIPPET_HEAD)
  assert.equal(fix.at(-1), '"Bash(dial:*)"')
  assert.ok(!fix.at(-1).endsWith(','))
  // one double-quoted rule per line after the heading
  for (const l of fix.slice(1)) assert.match(l.trim(), /^"[^"]+",?$/)
})

test('snippet: a rendered uncovered permissions row carries the snippet under fix', async () => {
  const out = text(await run(world({ userSettings: false })))
  const rows = lines(out)
  const at = rows.findIndex(l => l.startsWith('  [warn] permissions:'))
  assert.ok(at >= 0, out)
  const fixAt = rows.findIndex((l, i) => i > at && l === `      fix: ${SNIPPET_HEAD}`)
  assert.ok(fixAt > at, out)
  assert.ok(rows.some(l => l === '           "Bash(dial:*)"'), out)
})
