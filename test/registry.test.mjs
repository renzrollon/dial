/**
 * Contract pinned here for the lib (design.md, The registry):
 *   loadRegistry(home)            -> { ok: true, registry } | { ok: false, reason }
 *   validateRegistry(raw, path)   -> same shape
 *   register(reg, args)           -> { ok: false, reason } | { ok: true, updated? }; mutates `reg` on success
 *   unregister(reg, arg)          -> { ok: false, reason } | { ok: true, name }; mutates `reg` on success
 *   listRepos(reg)                -> [{ name, path (expanded), vault, host }] sorted by name
 *   writeRegistry(home, reg)      -> writes <home>/registry.json atomically; throws on failure
 * Reasons are bare (no `dial:` prefix). The user's home is faked through $HOME,
 * which os.homedir() honours, so no test touches a real home directory.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tmp, FIXTURES, makeGitDir, makeHome, readJson, snapshotTree } from './helpers.mjs'

const USER_HOME = tmp('dial-userhome-')
process.env.HOME = USER_HOME

const {
  SCHEMA,
  collapseHome,
  expandHome,
  listRepos,
  loadRegistry,
  register,
  registryPath,
  repoName,
  unregister,
  validateRegistry,
  writeRegistry
} = await import('../lib/registry.mjs')

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const PATH = '/h/registry.json'

function emptyReg(vaults = { personal: tmp('v-personal-'), work: tmp('v-work-') }) {
  return { dial_schema: SCHEMA, vaults, repos: [], limits: {} }
}

function repoDir(...segments) {
  return makeGitDir(join(USER_HOME, ...segments))
}

test('SCHEMA is dial.registry/1 and the file lives at <home>/registry.json', () => {
  assert.equal(SCHEMA, 'dial.registry/1')
  assert.equal(registryPath('/h'), '/h/registry.json')
})

test('homedir faking works: the user home is the temp directory', () => {
  assert.equal(homedir(), USER_HOME)
})

// --- shape and load ---------------------------------------------------------

test('a well-formed file loads and lists its repo', () => {
  const home = makeHome()
  copyFileSync(join(FIXTURES, 'registry-valid.json'), join(home, 'registry.json'))
  const out = loadRegistry(home)
  assert.equal(out.ok, true)
  assert.deepEqual(out.registry.vaults, { personal: '/vaults/personal', work: '/vaults/work' })
  assert.deepEqual(out.registry.repos, [{ path: '/repos/katipon', vault: 'personal', host: 'github' }])
  assert.deepEqual(listRepos(out.registry), [{ name: 'katipon', path: '/repos/katipon', vault: 'personal', host: 'github' }])
})

test('a wrong schema marker is refused naming the file and the value found', () => {
  const home = makeHome()
  copyFileSync(join(FIXTURES, 'registry-wrong-schema.json'), join(home, 'registry.json'))
  const out = loadRegistry(home)
  assert.equal(out.ok, false)
  assert.ok(out.reason.includes(join(home, 'registry.json')))
  assert.ok(out.reason.includes('dial.registry/0'))
})

test('a missing schema marker is refused naming the file', () => {
  const out = validateRegistry({ vaults: {}, repos: [] }, PATH)
  assert.equal(out.ok, false)
  assert.ok(out.reason.includes(PATH))
})

test('a file that is not JSON is refused with the parser message', () => {
  const home = makeHome()
  copyFileSync(join(FIXTURES, 'registry-not-json.txt'), join(home, 'registry.json'))
  const file = join(home, 'registry.json')
  let parserMessage
  try {
    JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    parserMessage = err.message
  }
  const out = loadRegistry(home)
  assert.equal(out.ok, false)
  assert.equal(out.reason, `registry is not valid json: ${file} (${parserMessage})`)
})

test('a missing file is the empty registry and is not created', () => {
  const home = makeHome()
  const out = loadRegistry(home)
  assert.equal(out.ok, true)
  assert.deepEqual(out.registry, { dial_schema: SCHEMA, vaults: {}, repos: [], limits: {} })
  assert.deepEqual(snapshotTree(home), {})
  assert.deepEqual(listRepos(out.registry), [])
})

test('a missing home is also the empty registry and is not created', () => {
  const home = join(tmp(), 'nope')
  const out = loadRegistry(home)
  assert.equal(out.ok, true)
  assert.deepEqual(out.registry.repos, [])
  assert.deepEqual(snapshotTree(home), {})
})

// --- validation -------------------------------------------------------------

test('an entry naming an unknown vault is refused naming the path and the vault', () => {
  const raw = { dial_schema: SCHEMA, vaults: { personal: '/v/p' }, repos: [{ path: '/r/alpha', vault: 'clients', host: 'github' }] }
  const out = validateRegistry(raw, PATH)
  assert.equal(out.ok, false)
  assert.ok(out.reason.includes('/r/alpha'))
  assert.ok(out.reason.includes('clients'))
})

test('an entry with an unknown host is refused naming the path and listing the allowed values', () => {
  const raw = { dial_schema: SCHEMA, vaults: { personal: '/v/p' }, repos: [{ path: '/r/alpha', vault: 'personal', host: 'bitbucket' }] }
  const out = validateRegistry(raw, PATH)
  assert.equal(out.ok, false)
  assert.ok(out.reason.includes('/r/alpha'))
  assert.ok(out.reason.includes('github'))
  assert.ok(out.reason.includes('gitlab'))
})

test('two entries sharing a repo name are refused naming both paths', () => {
  const raw = {
    dial_schema: SCHEMA,
    vaults: { personal: '/v/p', work: '/v/w' },
    repos: [
      { path: '/a/katipon', vault: 'personal', host: 'github' },
      { path: '/b/katipon', vault: 'personal', host: 'github' }
    ]
  }
  const out = validateRegistry(raw, PATH)
  assert.equal(out.ok, false)
  assert.ok(out.reason.includes('/a/katipon'))
  assert.ok(out.reason.includes('/b/katipon'))
})

test('two entries sharing an expanded path are refused, even when one is stored with ~', () => {
  const raw = {
    dial_schema: SCHEMA,
    vaults: { personal: '/v/p' },
    repos: [
      { path: '~/x/katipon', vault: 'personal', host: 'github' },
      { path: join(USER_HOME, 'x', 'katipon'), vault: 'personal', host: 'gitlab' }
    ]
  }
  const out = validateRegistry(raw, PATH)
  assert.equal(out.ok, false)
  assert.ok(out.reason.includes('katipon'))
})

test('limits are validated on load through effectiveLimits', () => {
  const raw = { dial_schema: SCHEMA, vaults: {}, repos: [], limits: { coffeeBreaks: 3 } }
  const out = validateRegistry(raw, PATH)
  assert.equal(out.ok, false)
  assert.equal(out.reason, `registry limits: unknown cap coffeeBreaks in ${PATH}`)
  const bad = validateRegistry({ ...raw, limits: { briefLines: 0 } }, PATH)
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /briefLines/)
})

test('vaults must be an object of string paths', () => {
  assert.equal(validateRegistry({ dial_schema: SCHEMA, vaults: { personal: 3 }, repos: [] }, PATH).ok, false)
  assert.equal(validateRegistry({ dial_schema: SCHEMA, vaults: [], repos: [] }, PATH).ok, false)
})

// --- register ---------------------------------------------------------------

test('successful registration stores the path with the home collapsed to ~', () => {
  const reg = emptyReg()
  const dir = repoDir('IdeaProjects', 'katipon')
  const out = register(reg, { path: dir, vault: 'personal', host: 'github' })
  assert.equal(out.ok, true)
  assert.ok(!out.updated)
  assert.equal(repoName(dir), 'katipon')
  assert.deepEqual(reg.repos, [{ path: '~/IdeaProjects/katipon', vault: 'personal', host: 'github' }])
})

test('an unknown vault is refused naming it and quoting the JSON line to add under vaults', () => {
  const reg = emptyReg()
  const before = structuredClone(reg)
  const out = register(reg, { path: repoDir('r', 'alpha'), vault: 'clients', host: 'github' })
  assert.equal(out.ok, false)
  assert.ok(out.reason.includes('clients'))
  assert.ok(out.reason.includes('vaults'))
  assert.match(out.reason, /"clients": "/)
  assert.deepEqual(reg, before)
})

test('an invalid host is refused', () => {
  const reg = emptyReg()
  const before = structuredClone(reg)
  const out = register(reg, { path: repoDir('r', 'beta'), vault: 'personal', host: 'bitbucket' })
  assert.equal(out.ok, false)
  assert.equal(out.reason, '--host must be github or gitlab, not bitbucket')
  assert.deepEqual(reg, before)
})

test('a path with no .git entry is refused as not a git work tree', () => {
  const reg = emptyReg()
  const dir = join(USER_HOME, 'plain')
  mkdirSync(dir, { recursive: true })
  const out = register(reg, { path: dir, vault: 'personal', host: 'github' })
  assert.equal(out.ok, false)
  assert.ok(out.reason.includes(dir))
  assert.match(out.reason, /not a git work tree/)
  assert.deepEqual(reg.repos, [])
})

test('a linked worktree, whose .git is a file, is accepted', () => {
  const reg = emptyReg()
  const dir = makeGitDir(join(USER_HOME, 'wt', 'gamma'), { worktree: true })
  const out = register(reg, { path: dir, vault: 'personal', host: 'github' })
  assert.equal(out.ok, true)
  assert.equal(reg.repos.length, 1)
})

test('a path that does not exist is refused naming it', () => {
  const reg = emptyReg()
  const dir = join(USER_HOME, 'does', 'not', 'exist')
  const out = register(reg, { path: dir, vault: 'personal', host: 'github' })
  assert.equal(out.ok, false)
  assert.ok(out.reason.includes(dir))
  assert.deepEqual(reg.repos, [])
})

test('a path that is a regular file is refused naming it', () => {
  const reg = emptyReg()
  const file = join(USER_HOME, 'a-file')
  writeFileSync(file, 'x')
  const out = register(reg, { path: file, vault: 'personal', host: 'github' })
  assert.equal(out.ok, false)
  assert.ok(out.reason.includes(file))
})

// --- one vault per repo -----------------------------------------------------

test('re-registering a path to another vault is refused and the registry is unchanged', () => {
  const reg = emptyReg()
  const dir = repoDir('VSCodeProjects', 'beta-rabbitdeploy')
  assert.equal(register(reg, { path: dir, vault: 'work', host: 'gitlab' }).ok, true)
  const before = structuredClone(reg)
  const out = register(reg, { path: dir, vault: 'personal', host: 'github' })
  assert.equal(out.ok, false)
  assert.equal(
    out.reason,
    'beta-rabbitdeploy is registered to vault work (~/VSCodeProjects/beta-rabbitdeploy); a repo belongs to exactly one vault'
  )
  assert.deepEqual(reg, before)
})

test('the same name under another path and vault is refused naming the name and the existing path', () => {
  const reg = emptyReg()
  assert.equal(register(reg, { path: repoDir('IdeaProjects', 'katipon'), vault: 'personal', host: 'github' }).ok, true)
  const before = structuredClone(reg)
  const out = register(reg, { path: repoDir('elsewhere', 'katipon'), vault: 'work', host: 'gitlab' })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'katipon is registered to vault personal (~/IdeaProjects/katipon); a repo belongs to exactly one vault')
  assert.deepEqual(reg, before)
})

test('the same path and vault updates the host in place and leaves one entry', () => {
  const reg = emptyReg()
  const dir = repoDir('IdeaProjects', 'delta')
  assert.equal(register(reg, { path: dir, vault: 'personal', host: 'github' }).ok, true)
  const out = register(reg, { path: dir, vault: 'personal', host: 'gitlab' })
  assert.equal(out.ok, true)
  assert.equal(out.updated, true)
  assert.deepEqual(reg.repos, [{ path: '~/IdeaProjects/delta', vault: 'personal', host: 'gitlab' }])
})

// --- unregister -------------------------------------------------------------

function twoRepoReg() {
  const reg = emptyReg()
  register(reg, { path: repoDir('IdeaProjects', 'katipon'), vault: 'personal', host: 'github' })
  register(reg, { path: repoDir('VSCodeProjects', 'alpha'), vault: 'work', host: 'gitlab' })
  return reg
}

test('unregister by name removes the entry and returns the name', () => {
  const reg = twoRepoReg()
  const out = unregister(reg, 'katipon')
  assert.equal(out.ok, true)
  assert.equal(out.name, 'katipon')
  assert.deepEqual(reg.repos.map(r => r.path), ['~/VSCodeProjects/alpha'])
})

test('unregister by absolute path matches an entry stored with ~', () => {
  const reg = twoRepoReg()
  const out = unregister(reg, join(USER_HOME, 'IdeaProjects', 'katipon'))
  assert.equal(out.ok, true)
  assert.equal(out.name, 'katipon')
  assert.equal(reg.repos.length, 1)
})

test('unregister by the stored path matches', () => {
  const reg = twoRepoReg()
  const out = unregister(reg, '~/VSCodeProjects/alpha')
  assert.equal(out.ok, true)
  assert.equal(out.name, 'alpha')
})

test('unregister with no match is refused and changes nothing', () => {
  const reg = twoRepoReg()
  const before = structuredClone(reg)
  const out = unregister(reg, 'nothing-here')
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'no registered repo matches nothing-here')
  assert.deepEqual(reg, before)
})

// --- listing ----------------------------------------------------------------

test('listRepos is sorted by name with expanded absolute paths', () => {
  const reg = twoRepoReg()
  assert.deepEqual(listRepos(reg), [
    { name: 'alpha', path: join(USER_HOME, 'VSCodeProjects', 'alpha'), vault: 'work', host: 'gitlab' },
    { name: 'katipon', path: join(USER_HOME, 'IdeaProjects', 'katipon'), vault: 'personal', host: 'github' }
  ])
})

// --- paths ------------------------------------------------------------------

test('collapseHome, expandHome and repoName', () => {
  assert.equal(collapseHome(join(USER_HOME, 'x', 'y')), '~/x/y')
  assert.equal(collapseHome(USER_HOME), '~')
  assert.equal(collapseHome('/elsewhere/x'), '/elsewhere/x')
  assert.equal(expandHome('~/x/y'), join(USER_HOME, 'x', 'y'))
  assert.equal(expandHome('~'), USER_HOME)
  assert.equal(expandHome('/abs/x'), '/abs/x')
  assert.equal(repoName('/a/b/katipon'), 'katipon')
  assert.equal(repoName('~/IdeaProjects/katipon'), 'katipon')
})

// --- writes -----------------------------------------------------------------

test('round trip: a registered repo loads back equal', () => {
  const home = makeHome()
  const reg = emptyReg()
  assert.equal(register(reg, { path: repoDir('IdeaProjects', 'katipon'), vault: 'personal', host: 'github' }).ok, true)
  writeRegistry(home, reg)
  const out = loadRegistry(home)
  assert.equal(out.ok, true)
  assert.deepEqual(out.registry.repos, [{ path: '~/IdeaProjects/katipon', vault: 'personal', host: 'github' }])
  assert.deepEqual(out.registry.vaults, reg.vaults)
})

test('writes are two-space JSON, trailing newline, fixed key order, repos sorted by name', () => {
  const home = makeHome()
  const reg = {
    limits: { staleDays: 7 },
    repos: [
      { host: 'gitlab', vault: 'work', path: '/r/zeta' },
      { host: 'github', vault: 'personal', path: '/r/alpha' }
    ],
    vaults: { personal: '/v/p', work: '/v/w' },
    dial_schema: SCHEMA
  }
  writeRegistry(home, reg)
  const text = readFileSync(join(home, 'registry.json'), 'utf8')
  const parsed = JSON.parse(text)
  assert.deepEqual(Object.keys(parsed), ['dial_schema', 'vaults', 'repos', 'limits'])
  assert.deepEqual(parsed.repos.map(r => r.path), ['/r/alpha', '/r/zeta'])
  assert.equal(text, JSON.stringify(parsed, null, 2) + '\n')
})

test('writing an unchanged registry twice is byte-identical', () => {
  const home = makeHome()
  const reg = twoRepoReg()
  writeRegistry(home, reg)
  const first = readFileSync(join(home, 'registry.json'))
  writeRegistry(home, reg)
  assert.ok(first.equals(readFileSync(join(home, 'registry.json'))))
  const loaded = loadRegistry(home)
  writeRegistry(home, loaded.registry)
  assert.ok(first.equals(readFileSync(join(home, 'registry.json'))))
})

test('a successful write leaves only registry.json behind, no temp file', () => {
  const home = makeHome()
  writeRegistry(home, twoRepoReg())
  assert.deepEqual(readdirSync(home), ['registry.json'])
})

test('a failed write on a read-only home leaves registry.json byte-identical', { skip: isRoot ? 'root ignores mode bits' : false }, () => {
  const home = makeHome({ registry: readJson(join(FIXTURES, 'registry-valid.json')) })
  const before = snapshotTree(home)
  const bytes = readFileSync(join(home, 'registry.json'))
  chmodSync(home, 0o555)
  try {
    assert.throws(() => writeRegistry(home, twoRepoReg()))
  } finally {
    chmodSync(home, 0o755)
  }
  assert.deepEqual(snapshotTree(home), before)
  assert.ok(bytes.equals(readFileSync(join(home, 'registry.json'))))
})

test('writeRegistry output validates', () => {
  const home = makeHome()
  writeRegistry(home, twoRepoReg())
  assert.equal(loadRegistry(home).ok, true)
})
