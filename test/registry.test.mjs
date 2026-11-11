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
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
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
  resolveRepo,
  rootVault,
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

// --- narrate block (registry: The narrate block is validated on every load) -----

const withBlock = extra => ({ dial_schema: SCHEMA, vaults: { personal: '/v/p', work: '/v/w' }, repos: [], ...extra })

test('a full narrate block loads and is kept on the loaded registry', () => {
  const narrate = {
    provider: 'mtplx',
    url: 'http://127.0.0.1:8000/v1',
    model: 'mtplx-qwen38-27b-optimized-speed',
    apiKeyEnv: 'MTPLX_API_KEY',
    fallbackUrl: 'https://127.0.0.1:11434/v1',
    fallbackModel: 'qwen3.6'
  }
  const out = validateRegistry(withBlock({ narrate }), PATH)
  assert.equal(out.ok, true)
  assert.deepEqual(out.registry.narrate, narrate)
  assert.equal(validateRegistry(withBlock({ narrate: {} }), PATH).ok, true)
})

test('a narrate that is not an object is refused: string, null, array', () => {
  for (const narrate of ['http://127.0.0.1:8000/v1', null, []]) {
    const out = validateRegistry(withBlock({ narrate }), PATH)
    assert.equal(out.ok, false, JSON.stringify(narrate))
    assert.equal(out.reason, 'registry narrate must be an object')
  }
})

test('an unknown narrate key is refused naming it', () => {
  const out = validateRegistry(withBlock({ narrate: { temperature: '0.2' } }), PATH)
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'unknown narrate key: temperature')
})

test('a narrate url without an http(s) scheme is refused quoting the value, for url and fallbackUrl', () => {
  const url = validateRegistry(withBlock({ narrate: { url: '127.0.0.1:8000/v1' } }), PATH)
  assert.equal(url.ok, false)
  assert.equal(url.reason, 'narrate url must start with http:// or https://: 127.0.0.1:8000/v1')
  const fallback = validateRegistry(withBlock({ narrate: { fallbackUrl: 'ftp://127.0.0.1:11434/v1' } }), PATH)
  assert.equal(fallback.ok, false)
  assert.equal(fallback.reason, 'narrate url must start with http:// or https://: ftp://127.0.0.1:11434/v1')
})

test('a non-string narrate value is refused naming the key', () => {
  const out = validateRegistry(withBlock({ narrate: { model: 27 } }), PATH)
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'narrate model must be a string')
})

test('a write keeps the narrate block and the schema marker', () => {
  const home = makeHome()
  const narrate = { provider: 'mtplx', url: 'http://127.0.0.1:8000/v1' }
  const reg = emptyReg()
  reg.narrate = narrate
  assert.equal(register(reg, { path: repoDir('IdeaProjects', 'narr-a'), vault: 'personal', host: 'github' }).ok, true)
  writeRegistry(home, reg)
  const back = readJson(join(home, 'registry.json'))
  assert.deepEqual(back.narrate, narrate)
  assert.equal(back.dial_schema, 'dial.registry/1')
})

test('listRepos is the same with and without a valid narrate or roots block', () => {
  const repos = [{ path: '~/a/one', vault: 'personal', host: 'github' }]
  const plain = validateRegistry(withBlock({ repos }), PATH).registry
  const rich = validateRegistry(withBlock({ repos, narrate: { model: 'm' }, roots: { '~/a': 'personal' } }), PATH).registry
  assert.deepEqual(listRepos(rich), listRepos(plain))
})

// --- roots map (registry: The roots map is validated on every load) -------------

test('a roots map loads under the same marker', () => {
  const out = validateRegistry(withBlock({ roots: { '~/VSCodeProjects': 'work' } }), PATH)
  assert.equal(out.ok, true)
  assert.deepEqual(out.registry.roots, { '~/VSCodeProjects': 'work' })
})

test('a roots value that is not an object is refused naming the file: array, string, null', () => {
  for (const roots of [['~/VSCodeProjects'], '~/VSCodeProjects', null]) {
    const out = validateRegistry(withBlock({ roots }), PATH)
    assert.equal(out.ok, false, JSON.stringify(roots))
    assert.equal(out.reason, `registry roots must be an object of directory to vault name: ${PATH}`)
  }
})

test('a root naming a vault that is not in vaults is refused quoting the JSON value', () => {
  const out = validateRegistry(withBlock({ roots: { '~/VSCodeProjects': 'clients' } }), PATH)
  assert.equal(out.ok, false)
  assert.equal(out.reason, `registry root ~/VSCodeProjects: vault "clients" is not in vaults (${PATH})`)
})

test('a root whose value is not a string is refused the same way', () => {
  const out = validateRegistry(withBlock({ roots: { '~/VSCodeProjects': 3 } }), PATH)
  assert.equal(out.ok, false)
  assert.equal(out.reason, `registry root ~/VSCodeProjects: vault 3 is not in vaults (${PATH})`)
})

test('an entry that contradicts its root still loads, and unregister repairs it', () => {
  const entry = { path: '~/VSCodeProjects/agentbase', vault: 'personal', host: 'github' }
  const out = validateRegistry(withBlock({ repos: [entry], roots: { '~/VSCodeProjects': 'work' } }), PATH)
  assert.equal(out.ok, true)
  assert.deepEqual(unregister(out.registry, 'agentbase'), { ok: true, name: 'agentbase' })
})

test('rootVault: the longest containing root wins, nested roots', () => {
  const reg = withBlock({ roots: { '~/VSCodeProjects': 'work', '~/VSCodeProjects/oss': 'personal' } })
  assert.deepEqual(rootVault(reg, join(USER_HOME, 'VSCodeProjects', 'oss', 'tool')), { root: '~/VSCodeProjects/oss', vault: 'personal' })
  assert.deepEqual(rootVault(reg, join(USER_HOME, 'VSCodeProjects', 'agentbase')), { root: '~/VSCodeProjects', vault: 'work' })
  assert.deepEqual(rootVault(reg, join(USER_HOME, 'VSCodeProjects')), { root: '~/VSCodeProjects', vault: 'work' })
})

test('rootVault: a sibling sharing a prefix, a path outside, and a registry without roots have no root', () => {
  const reg = withBlock({ roots: { '~/VSCodeProjects': 'work' } })
  assert.equal(rootVault(reg, join(USER_HOME, 'VSCodeProjects-old', 'tool')), null)
  assert.equal(rootVault(reg, join(USER_HOME, 'IdeaProjects', 'x')), null)
  assert.equal(rootVault(withBlock({}), join(USER_HOME, 'VSCodeProjects', 'x')), null)
})

test('rootVault compares real paths: a root declared through a symlink matches the physical path', () => {
  const physical = join(USER_HOME, 'physical-root')
  mkdirSync(join(physical, 'proj'), { recursive: true })
  const link = join(USER_HOME, 'linked-root')
  symlinkSync(physical, link)
  const reg = withBlock({ roots: { [link]: 'work' } })
  assert.equal(rootVault(reg, join(physical, 'proj'))?.vault, 'work')
  assert.equal(rootVault(reg, join(link, 'proj'))?.vault, 'work')
})

// --- register against roots (registry: A path under a declared root ...) --------

function rootedReg(roots) {
  const reg = emptyReg()
  reg.roots = roots
  return reg
}

test('a work path given the personal vault is refused and the registry is byte-identical', () => {
  const home = makeHome()
  const dir = repoDir('VSCodeProjects', 'agentbase')
  const reg = rootedReg({ '~/VSCodeProjects': 'work' })
  writeRegistry(home, reg)
  const before = readFileSync(join(home, 'registry.json'), 'utf8')
  const out = register(reg, { path: dir, vault: 'personal', host: 'gitlab' })
  assert.equal(out.ok, false)
  assert.equal(
    out.reason,
    '~/VSCodeProjects/agentbase is under ~/VSCodeProjects, which belongs to vault work; a repo belongs to exactly one vault'
  )
  assert.deepEqual(reg.repos, [])
  writeRegistry(home, reg)
  assert.equal(readFileSync(join(home, 'registry.json'), 'utf8'), before)
})

test('the root refusal does not depend on the path existing', () => {
  const reg = rootedReg({ '~/VSCodeProjects': 'work' })
  const out = register(reg, { path: join(USER_HOME, 'VSCodeProjects', 'never-made'), vault: 'personal', host: 'github' })
  assert.equal(out.ok, false)
  assert.match(out.reason, /^~\/VSCodeProjects\/never-made is under ~\/VSCodeProjects, which belongs to vault work;/)
})

test('the same path given its root vault is accepted', () => {
  const reg = rootedReg({ '~/VSCodeProjects': 'work' })
  const out = register(reg, { path: repoDir('VSCodeProjects', 'agentbase'), vault: 'work', host: 'gitlab' })
  assert.equal(out.ok, true)
  assert.deepEqual(reg.repos, [{ path: '~/VSCodeProjects/agentbase', vault: 'work', host: 'gitlab' }])
})

test('with nested roots the longest wins on register', () => {
  const reg = rootedReg({ '~/VSCodeProjects': 'work', '~/VSCodeProjects/oss': 'personal' })
  assert.equal(register(reg, { path: repoDir('VSCodeProjects', 'oss', 'katipon-fork'), vault: 'personal', host: 'github' }).ok, true)
  assert.equal(register(reg, { path: repoDir('VSCodeProjects', 'oss', 'other-fork'), vault: 'work', host: 'github' }).ok, false)
})

test('a sibling sharing the root prefix is under no root', () => {
  const reg = rootedReg({ '~/VSCodeProjects': 'work' })
  const out = register(reg, { path: repoDir('VSCodeProjects-old', 'tool'), vault: 'personal', host: 'github' })
  assert.equal(out.ok, true)
})

test('a registry without roots registers a path under ~/VSCodeProjects to any vault, as before', () => {
  const reg = emptyReg()
  assert.equal(register(reg, { path: repoDir('VSCodeProjects', 'plain'), vault: 'personal', host: 'github' }).ok, true)
})

test('a write keeps the roots map with the same keys and values', () => {
  const home = makeHome()
  const roots = { '~/VSCodeProjects': 'work', '~/VSCodeProjects/oss': 'personal' }
  const reg = rootedReg(roots)
  assert.equal(register(reg, { path: repoDir('VSCodeProjects', 'kept'), vault: 'work', host: 'gitlab' }).ok, true)
  writeRegistry(home, reg)
  assert.deepEqual(readJson(join(home, 'registry.json')).roots, roots)
  assert.equal(loadRegistry(home).ok, true)
})

// --- resolveRepo (registry: A repo argument or a working directory resolves ...) --

function resolveFixture() {
  const reg = emptyReg()
  const katipon = repoDir('IdeaProjects', 'katipon')
  assert.equal(register(reg, { path: katipon, vault: 'personal', host: 'github' }).ok, true)
  return { reg, katipon }
}

test('resolveRepo: a name resolves, and wins over a path reading', () => {
  const { reg, katipon } = resolveFixture()
  assert.deepEqual(resolveRepo(reg, 'katipon'), { name: 'katipon', path: katipon, vault: 'personal', host: 'github' })
  assert.equal(resolveRepo(reg, 'nope'), null)
})

test('resolveRepo: the path itself, with ~, and a subdirectory resolve', () => {
  const { reg } = resolveFixture()
  assert.equal(resolveRepo(reg, join(USER_HOME, 'IdeaProjects', 'katipon'))?.name, 'katipon')
  assert.equal(resolveRepo(reg, '~/IdeaProjects/katipon')?.name, 'katipon')
  assert.equal(resolveRepo(reg, join(USER_HOME, 'IdeaProjects', 'katipon', 'lib', 'deep'))?.name, 'katipon')
})

test('resolveRepo: a sibling sharing a prefix, the parent directory and an empty argument resolve to nothing', () => {
  const { reg } = resolveFixture()
  assert.equal(resolveRepo(reg, join(USER_HOME, 'IdeaProjects', 'katipon-old')), null)
  assert.equal(resolveRepo(reg, join(USER_HOME, 'IdeaProjects')), null)
  assert.equal(resolveRepo(reg, ''), null)
  assert.equal(resolveRepo(reg, undefined), null)
})

test('resolveRepo: the longest containing registered path wins', () => {
  const { reg, katipon } = resolveFixture()
  const inner = repoDir('IdeaProjects', 'katipon', 'packages', 'inner')
  assert.equal(register(reg, { path: inner, vault: 'personal', host: 'github' }).ok, true)
  assert.equal(resolveRepo(reg, join(inner, 'src'))?.name, 'inner')
  assert.equal(resolveRepo(reg, join(katipon, 'src'))?.name, 'katipon')
})

test('resolveRepo: a repo registered under a symlinked directory resolves from its physical path', () => {
  const physical = join(USER_HOME, 'IdeaProjects', 'real-home', 'sym')
  makeGitDir(physical)
  const link = join(USER_HOME, 'code')
  symlinkSync(join(USER_HOME, 'IdeaProjects', 'real-home'), link)
  const reg = emptyReg()
  assert.equal(register(reg, { path: join(link, 'sym'), vault: 'personal', host: 'github' }).ok, true)
  assert.deepEqual(reg.repos[0].path, '~/code/sym')
  assert.equal(resolveRepo(reg, join(realpathSync(physical), 'lib'))?.name, 'sym')
  assert.equal(resolveRepo(reg, join(link, 'sym', 'lib'))?.name, 'sym')
})

test('resolveRepo: a tmp() repo resolves from the realpathSync of itself', () => {
  const dir = makeGitDir(tmp('dial-resolve-'))
  const reg = emptyReg()
  assert.equal(register(reg, { path: dir, vault: 'personal', host: 'github' }).ok, true)
  const real = realpathSync(dir)
  assert.equal(resolveRepo(reg, real)?.name, repoName(dir))
  assert.equal(resolveRepo(reg, join(real, 'sub'))?.name, repoName(dir))
})

test('resolveRepo: a registered path that no longer exists still resolves by name and by its stored form', () => {
  const reg = emptyReg()
  const gone = join(USER_HOME, 'IdeaProjects', 'gone-repo')
  reg.repos.push({ path: '~/IdeaProjects/gone-repo', vault: 'personal', host: 'github' })
  assert.equal(resolveRepo(reg, 'gone-repo')?.path, gone)
  assert.equal(resolveRepo(reg, join(gone, 'lib'))?.name, 'gone-repo')
})
