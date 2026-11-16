import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { collectOpenspec } from '../lib/sources/openspec.mjs'
import { makeHome, makeRepo, makeVault, runCli, tmp, writeJson } from './helpers.mjs'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

const repo = spec => makeRepo(tmp('os-'), spec)
const change = (spec, name = 'add-login') => collectOpenspec({ repoPath: repo(spec) }).changes[name]

test('no openspec directory: every fact is unobserved, no throw', () => {
  const r = collectOpenspec({ repoPath: repo({ git: true }) })
  assert.equal(r.active.unobserved, 'no openspec dir')
  assert.equal(r.archived.unobserved, 'no openspec dir')
  assert.equal(r.specs.unobserved, 'no openspec dir')
  assert.deepEqual(r.changes, {})
})

test('active and archived changes, with archive dates', () => {
  const r = collectOpenspec({
    repoPath: repo({
      changes: { 'add-login': { tasks: { done: 1, total: 2 } }, 'fix-cache': {} },
      archive: { '2026-11-10-scaffold-cli-and-registry': {}, 'old-thing': {} },
    }),
  })
  assert.deepEqual(r.active, { value: ['add-login', 'fix-cache'], evidence: 'openspec/changes/: 2 active' })
  assert.deepEqual(r.archived.value, [{ name: 'scaffold-cli-and-registry', date: '2026-11-10' }])
  assert.equal(r.archived.evidence, 'openspec/changes/archive/2026-11-10-scaffold-cli-and-registry/')
  assert.deepEqual(Object.keys(r.changes), ['add-login', 'fix-cache'])
})

test('an openspec dir with no changes dir observes empty lists', () => {
  const r = collectOpenspec({ repoPath: repo({ files: { 'openspec/config.yaml': 'x' } }) })
  assert.deepEqual(r.active.value, [])
  assert.deepEqual(r.archived.value, [])
})

test('ticked of total counts one-character markers; done only on x or X', () => {
  const tasks = '- [x] 1.1\n- [X] 1.2\n- [ ] 1.3\n- [~] 1.4\n- [human] H1\n'
  const t = change({ changes: { 'add-login': { tasks } } }).tasks
  assert.deepEqual(t, { value: { done: 2, total: 4 }, evidence: 'openspec/changes/add-login/tasks.md: 2/4' })
})

test('no tasks file is 0/0 observed', () => {
  const t = change({ changes: { 'add-login': { files: { 'proposal.md': 'x' } } } }).tasks
  assert.deepEqual(t, { value: { done: 0, total: 0 }, evidence: 'openspec/changes/add-login/tasks.md: absent' })
})

test('manual test plan: absent, no result, last result wins', () => {
  const plan = body => change({ changes: { 'add-login': { files: body === null ? {} : { 'manual-test-plan.md': body } } } }).manualTest
  assert.deepEqual(plan(null), { value: 'absent', evidence: 'openspec/changes/add-login/manual-test-plan.md: absent' })
  assert.deepEqual(plan('# Plan\n1. do it\n'), {
    value: 'present, no result',
    evidence: 'openspec/changes/add-login/manual-test-plan.md: no Result: line',
  })
  assert.deepEqual(plan('Result: fail\n...\nResult: pass\n'), {
    value: 'pass',
    evidence: 'openspec/changes/add-login/manual-test-plan.md: Result: pass',
  })
  assert.equal(plan('  Result: pass\n').value, 'present, no result')
})

test('decisions: only needs_human rows, by id', () => {
  const decisions = [
    '| id | question | class | agent | evidence |',
    '|----|----------|-------|-------|----------|',
    '| D1 | Pin zod? | needs_human | — | — |',
    '| D2 | Reuse helper | agent_resolved | yes | lib/a.mjs:4 |',
  ].join('\n')
  const d = change({ changes: { 'add-login': { files: { 'decisions.md': decisions } } } }).needsHuman
  assert.deepEqual(d, { value: ['D1'], evidence: 'openspec/changes/add-login/decisions.md: needs_human D1' })
  assert.deepEqual(change({ changes: { 'add-login': {} } }).needsHuman.value, [])
})

test('checkpoint: absent, returned, wrong schema, bad JSON, undecided', () => {
  const cp = content => change({ changes: { 'add-login': { files: content === undefined ? {} : { 'checkpoint.json': content } } } }).checkpoint
  assert.deepEqual(cp(), { value: 'absent', evidence: 'openspec/changes/add-login/checkpoint.json: absent' })
  assert.deepEqual(cp({ schema: 'interlock.checkpoint/1', decision: { state: 'returned' } }), {
    value: 'returned',
    evidence: 'openspec/changes/add-login/checkpoint.json decision.state: returned',
  })
  assert.equal(cp({ schema: 'interlock.checkpoint/1', decision: { state: 'approved' } }).value, 'approved')
  assert.equal(cp({ schema: 'interlock.checkpoint/2', decision: { state: 'approved' } }).unobserved,
    'openspec/changes/add-login/checkpoint.json schema interlock.checkpoint/2 not understood')
  assert.equal(cp('{ nope').unobserved, 'openspec/changes/add-login/checkpoint.json not valid JSON')
  assert.equal(cp({ schema: 'interlock.checkpoint/1' }).value, 'absent')
})

test('last mtime is the newest file under the change, with that file as evidence', () => {
  const root = repo({ changes: { 'add-login': { tasks: { done: 0, total: 1 }, files: { 'design.md': 'd', 'specs/a/spec.md': 's' } } } })
  const base = join(root, 'openspec/changes/add-login')
  utimesSync(join(base, 'tasks.md'), new Date('2026-11-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'))
  utimesSync(join(base, 'specs/a/spec.md'), new Date('2026-11-02T00:00:00Z'), new Date('2026-11-02T00:00:00Z'))
  utimesSync(join(base, 'design.md'), new Date('2026-11-08T10:00:00Z'), new Date('2026-11-08T10:00:00Z'))
  const m = collectOpenspec({ repoPath: root }).changes['add-login'].lastMtime
  assert.deepEqual(m, { value: '2026-11-08T10:00:00Z', evidence: 'openspec/changes/add-login/design.md' })
})

test('an empty change directory has an unobserved mtime', () => {
  const m = change({ changes: { 'add-login': {} } }).lastMtime
  assert.equal(m.unobserved, 'no files under openspec/changes/add-login')
})

// --- the living specs (specs/local-sources: OpenSpec reports the living specs) ----------------------------

/** A spec file body: a Purpose paragraph, `n` requirement lines each with a scenario, as a living spec has. */
const reqs = n =>
  `# x Specification\n\n## Purpose\nSecret prose that must not leave the file.\n\n## Requirements\n\n${Array.from(
    { length: n },
    (_, i) => `### Requirement: R${i}\nThe system SHALL do ${i}.\n\n#### Scenario: S${i}\n- **WHEN** a\n- **THEN** b\n`
  ).join('\n')}`
/** `{ 'doctor': 2, 'ui/button': 3 }` as `openspec/specs/<name>/spec.md` files. */
const specFiles = counts => Object.fromEntries(Object.entries(counts).map(([name, n]) => [`openspec/specs/${name}/spec.md`, reqs(n)]))
const specsOf = (spec, over = {}) => {
  const root = repo(spec)
  return { root, ...collectOpenspec({ repoPath: root, ...over }) }
}
const entries = r => r.specs?.value
const observed = (r, value, evidence) => {
  assert.ok(r.specs, 'the openspec facts have no specs leaf')
  assert.deepEqual(r.specs, { value, evidence })
}
const unobservedReason = (r, reason) => {
  assert.ok(r.specs, 'the openspec facts have no specs leaf')
  assert.equal(r.specs.unobserved, reason)
  assert.equal(r.specs.value, null)
}

test('living specs: names and requirement counts in code-unit order, with the count as evidence', () => {
  const r = specsOf({ files: specFiles({ registry: 3, doctor: 2 }) })
  observed(r, [{ name: 'doctor', requirements: 2 }, { name: 'registry', requirements: 3 }], 'openspec/specs/: 2 living')
})

test('living specs: an entry is exactly { name, requirements }, nothing from the spec file', () => {
  const r = specsOf({ files: specFiles({ registry: 1 }) })
  assert.deepEqual(Object.keys(entries(r)[0]), ['name', 'requirements'])
  assert.equal(JSON.stringify(r.specs).includes('Secret prose'), false)
})

test('living specs: the order is by code unit, not by locale', () => {
  // Z (U+005A) sorts before a in code-unit order, after it in locale order. Names differ by more
  // than case so the fixture survives a case-insensitive filesystem (macOS APFS).
  const r = specsOf({ files: specFiles({ b: 1, Z: 1, a: 1 }) })
  assert.deepEqual(entries(r).map(e => e.name), ['Z', 'a', 'b'])
})

test('a nested capability is named by its path, and a directory holding a spec.md is still walked', () => {
  const r = specsOf({ files: specFiles({ doctor: 1, ui: 2, 'ui/button': 3 }) })
  observed(
    r,
    [{ name: 'doctor', requirements: 1 }, { name: 'ui', requirements: 2 }, { name: 'ui/button', requirements: 3 }],
    'openspec/specs/: 3 living'
  )
})

test('a directory with no spec.md is not an entry', () => {
  const r = specsOf({ files: { ...specFiles({ doctor: 1 }), 'openspec/specs/drafts/notes.md': reqs(4) } })
  observed(r, [{ name: 'doctor', requirements: 1 }], 'openspec/specs/: 1 living')
})

test('a specs directory with no living spec is an observed empty list', () => {
  const r = specsOf({ files: { 'openspec/specs/drafts/notes.md': reqs(4) } })
  observed(r, [], 'openspec/specs/: 0 living')
})

test('an openspec directory with no specs directory is an observed empty list, absent', () => {
  const r = specsOf({ files: { 'openspec/config.yaml': 'x' } })
  observed(r, [], 'openspec/specs/: absent')
})

test('a dot-directory is not walked, and neither is anything under it', () => {
  const r = specsOf({ files: { ...specFiles({ doctor: 1, '.drafts': 4, '.drafts/secret': 2 }) } })
  observed(r, [{ name: 'doctor', requirements: 1 }], 'openspec/specs/: 1 living')
})

test('a spec.md directly in openspec/specs is not a capability and leaves no empty path', () => {
  const r = specsOf({ files: { ...specFiles({ doctor: 1 }), 'openspec/specs/spec.md': reqs(4) } })
  observed(r, [{ name: 'doctor', requirements: 1 }], 'openspec/specs/: 1 living')
  assert.equal(entries(r).some(e => e.name === ''), false)
})

test('a symlinked directory is not entered', () => {
  const root = repo({ files: { ...specFiles({ doctor: 1 }), 'openspec/shared/spec.md': reqs(2) } })
  symlinkSync(join(root, 'openspec/shared'), join(root, 'openspec/specs/linked'))
  const r = collectOpenspec({ repoPath: root })
  observed(r, [{ name: 'doctor', requirements: 1 }], 'openspec/specs/: 1 living')
})

test('a spec.md symlink to a file inside the repository is read', () => {
  const root = repo({ files: { ...specFiles({ doctor: 1 }), 'openspec/shared/registry.md': reqs(2) } })
  mkdirSync(join(root, 'openspec/specs/registry'), { recursive: true })
  symlinkSync(join(root, 'openspec/shared/registry.md'), join(root, 'openspec/specs/registry/spec.md'))
  const r = collectOpenspec({ repoPath: root })
  assert.deepEqual(entries(r), [{ name: 'doctor', requirements: 1 }, { name: 'registry', requirements: 2 }])
})

test('a spec.md symlink to a file outside the repository unobserves the whole fact', () => {
  const outside = join(tmp('os-outside-'), 'elsewhere.md')
  writeFileSync(outside, reqs(2))
  const root = repo({ files: specFiles({ doctor: 1 }) })
  mkdirSync(join(root, 'openspec/specs/registry'), { recursive: true })
  symlinkSync(outside, join(root, 'openspec/specs/registry/spec.md'))
  const r = collectOpenspec({ repoPath: root })
  unobservedReason(r, 'openspec/specs/registry/spec.md: outside the repository')
})

test('a spec.md symlink to a directory is skipped and the fact stays observed', () => {
  const root = repo({ files: { ...specFiles({ doctor: 1 }), 'openspec/shared/keep.txt': 'x' } })
  mkdirSync(join(root, 'openspec/specs/registry'), { recursive: true })
  symlinkSync(join(root, 'openspec/shared'), join(root, 'openspec/specs/registry/spec.md'))
  observed(collectOpenspec({ repoPath: root }), [{ name: 'doctor', requirements: 1 }], 'openspec/specs/: 1 living')
})

test('a dangling spec.md symlink is skipped and the fact stays observed', () => {
  const root = repo({ files: specFiles({ doctor: 1 }) })
  mkdirSync(join(root, 'openspec/specs/registry'), { recursive: true })
  symlinkSync(join(root, 'openspec/missing.md'), join(root, 'openspec/specs/registry/spec.md'))
  observed(collectOpenspec({ repoPath: root }), [{ name: 'doctor', requirements: 1 }], 'openspec/specs/: 1 living')
})

test('a directory named spec.md is walked, not read', () => {
  const root = repo({ files: specFiles({ doctor: 1 }) })
  mkdirSync(join(root, 'openspec/specs/registry/spec.md'), { recursive: true })
  const r = collectOpenspec({ repoPath: root })
  assert.ok(r.specs, 'the openspec facts have no specs leaf')
  assert.equal(r.specs.unobserved, undefined)
  assert.equal(String(r.specs.evidence).includes('EISDIR'), false)
  observed(r, [{ name: 'doctor', requirements: 1 }], 'openspec/specs/: 1 living')
})

/** A registered fixture repo `katipon` and a vault, to run `dial sync katipon` over `root`. */
function syncWorld(root) {
  const base = tmp('os-sync-')
  const vault = makeVault(join(base, 'personal'))
  const home = makeHome()
  writeJson(join(home, 'registry.json'), {
    dial_schema: 'dial.registry/1',
    vaults: { personal: vault },
    repos: [{ path: root, vault: 'personal', host: 'github' }],
    limits: {},
  })
  return { env: { DIAL_HOME: home, HOME: tmp('os-sync-home-') } }
}
const katipon = spec => makeRepo(join(tmp('os-katipon-'), 'katipon'), spec)
const syncOk = async root => {
  const r = await runCli(['sync', 'katipon'], syncWorld(root).env)
  assert.equal(r.code, 0, r.stderr)
}

test('an openspec/specs that is a file is unobserved with ENOTDIR, the changes stay observed, and sync exits 0', async () => {
  const root = katipon({ changes: { active: {} }, files: { 'openspec/specs': 'not a directory' } })
  const r = collectOpenspec({ repoPath: root })
  unobservedReason(r, 'openspec/specs/: ENOTDIR')
  assert.deepEqual(r.active.value, ['active'])
  await syncOk(root)
})

test('a directory the walk cannot list unobserves the whole fact, names it, and sync exits 0', { skip: isRoot ? 'root ignores mode bits' : false }, async () => {
  const root = katipon({ changes: { active: {} }, files: { ...specFiles({ doctor: 1 }), 'openspec/specs/ui/button/spec.md': reqs(3) } })
  const dir = join(root, 'openspec/specs/ui/button')
  chmodSync(dir, 0o000)
  try {
    const r = collectOpenspec({ repoPath: root })
    unobservedReason(r, 'openspec/specs/ui/button: EACCES')
    assert.deepEqual(r.active.value, ['active'])
    await syncOk(root)
  } finally {
    chmodSync(dir, 0o755)
  }
})

test('a spec.md that cannot be read unobserves the whole fact, names it, and sync exits 0', { skip: isRoot ? 'root ignores mode bits' : false }, async () => {
  const root = katipon({ changes: { active: {} }, files: specFiles({ doctor: 1, registry: 2 }) })
  const file = join(root, 'openspec/specs/registry/spec.md')
  chmodSync(file, 0o000)
  try {
    const r = collectOpenspec({ repoPath: root })
    unobservedReason(r, 'openspec/specs/registry/spec.md: EACCES')
    assert.deepEqual(r.active.value, ['active'])
    await syncOk(root)
  } finally {
    chmodSync(file, 0o644)
  }
})
