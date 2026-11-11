import assert from 'node:assert/strict'
import { utimesSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { writeCache } from '../lib/cache.mjs'
import { compareItems, formatNext, nextItems } from '../lib/next.mjs'
import { fakeExec, makeHome, makeRepo, makeVault, snapshotTree, tmp } from './helpers.mjs'

const DAY = 86_400_000
const NOW = new Date(Date.now() + 40 * DAY)
const ago = days => new Date(NOW.getTime() - days * DAY)

/** A git stand-in answering by working directory: `{ [cwd]: { branch, status, commitDaysAgo } }`. */
function gitExec(byCwd) {
  return fakeExec(Object.fromEntries(
    [
      ['git rev-parse --abbrev-ref HEAD', g => ({ stdout: `${g.branch}\n` })],
      ['git status --porcelain=v2 --branch', g => ({ stdout: `# branch.head ${g.branch}\n${g.status ?? ''}` })],
      ['git stash list', () => ({ stdout: '' })],
      ['git rev-parse --git-dir', () => ({ stdout: '.git\n' })],
      ['git worktree list --porcelain', () => ({ stdout: '' })],
      ['git log -1 --format=%H%x09%cI', g => ({ stdout: `3f50683c1e0000000000000000000000000000aa\t${ago(g.commitDaysAgo ?? 300).toISOString()}\n` })],
    ].map(([key, answer]) => [key, (_file, _args, opts) => answer(byCwd[opts.cwd] ?? { branch: 'main' })])
  ))
}

/** Set a change's idle days by aging every file in it. */
function age(root, change, days) {
  const t = ago(days)
  for (const f of ['tasks.md']) utimesSync(join(root, 'openspec', 'changes', change, f), t, t)
}

/**
 * A registry over fixture repos. `repos`: `{ name: { vault, branch?, status?, changes: { name: { tasks, idle } }, archive? } }`.
 */
function world(repos, { limits = {}, vaults = ['personal', 'work'] } = {}) {
  const home = makeHome()
  const vaultPaths = Object.fromEntries(vaults.map(v => [v, makeVault(tmp(`next-vault-${v}-`))]))
  const byCwd = {}
  const entries = []
  for (const [name, spec] of Object.entries(repos)) {
    const root = makeRepo(join(tmp('next-repos-'), name), {
      git: true,
      changes: Object.fromEntries(Object.entries(spec.changes ?? {}).map(([c, v]) => [c, { tasks: v.tasks }])),
      archive: spec.archive,
    })
    for (const [c, v] of Object.entries(spec.changes ?? {})) age(root, c, v.idle ?? 1)
    byCwd[root] = { branch: spec.branch ?? 'main', status: spec.status, commitDaysAgo: spec.commitDaysAgo }
    entries.push({ path: root, vault: spec.vault ?? 'personal', host: 'github' })
  }
  const registry = { dial_schema: 'dial.registry/1', vaults: vaultPaths, repos: entries, limits }
  const env = { HOME: tmp('next-user-') }
  return { registry, home, env, exec: gitExec(byCwd), vaultPaths }
}

const run = (w, extra = {}) => nextItems({ registry: w.registry, env: w.env, now: NOW, home: w.home, exec: w.exec, ...extra })
const OPEN = { total: 5, done: 1 }

test('priority beats idle days and idle days break a tie', () => {
  const w = world({
    katipon: { changes: { 'add-a': { tasks: OPEN, idle: 9 }, 'add-b': { tasks: OPEN, idle: 3 }, 'add-c': { tasks: { total: 2, done: 2 }, idle: 1 } } },
  })
  const { rows } = run(w)
  // archive-pending is before spec-draft in the table; the two spec-drafts are 9d before 3d
  assert.deepEqual(rows.map(r => `${r.state} ${r.change} ${r.idleDays}`), ['archive-pending add-c 1', 'spec-draft add-a 9', 'spec-draft add-b 3'])
})

test('grouped by vault in vault-name order, one blank line between groups', () => {
  const w = world({
    zeta: { vault: 'work', changes: { 'add-z': { tasks: OPEN, idle: 2 } } },
    alpha: { vault: 'personal', changes: { 'add-a': { tasks: OPEN, idle: 2 } } },
  })
  const { rows } = run(w)
  assert.deepEqual(rows.map(r => r.vault), ['personal', 'work'])
  const lines = formatNext(rows).split('\n')
  assert.equal(lines[0], 'personal')
  assert.match(lines[1], /^spec-draft alpha\/add-a {2}2d /)
  assert.equal(lines[2], '')
  assert.equal(lines[3], 'work')
  assert.match(lines[4], /^spec-draft zeta\/add-z/)
})

test('--vault limits the list and an unknown vault is refused', () => {
  const w = world({
    zeta: { vault: 'work', changes: { 'add-z': { tasks: OPEN } } },
    alpha: { vault: 'personal', changes: { 'add-a': { tasks: OPEN } } },
  })
  assert.deepEqual(run(w, { vault: 'work' }).rows.map(r => r.repo), ['zeta'])
  assert.deepEqual(run(w, { vault: 'clients' }), { ok: false, reason: 'no vault named clients in the registry' })
})

test('items that do not need the human have no row', () => {
  const w = world({ katipon: { changes: { 'add-a': { tasks: OPEN } }, archive: { '2026-11-01-old-one': {} } } })
  const { rows } = run(w)
  assert.deepEqual(rows.map(r => r.change), ['add-a'])
})

test('a stale item keeps its state, is marked and suggests archive, drop, or re-spec', () => {
  const w = world({ katipon: { changes: { 'old-idea': { tasks: OPEN, idle: 20 } } } })
  const [row] = run(w).rows
  assert.equal(row.state, 'spec-draft')
  assert.equal(row.stale, true)
  assert.equal(row.suggested, 'archive, drop, or re-spec')
  const line = formatNext([row]).split('\n')[1]
  assert.match(line, /^spec-draft \[stale\] katipon\/old-idea {2}20d /)
  assert.match(line, /→ archive, drop, or re-spec$/)
})

test('a repo-level item has change null, the project note and prints the bare repo', () => {
  const w = world({
    katipon: {
      branch: 'main',
      status: 'u UU N... 100644 100644 100644 100644 aaa bbb ccc lib/auth.mjs\n',
      commitDaysAgo: 2,
      changes: { 'add-a': { tasks: OPEN }, 'add-b': { tasks: OPEN } },
    },
  })
  const rows = run(w).rows
  const repoRow = rows.find(r => r.change === null)
  assert.equal(repoRow.state, 'conflict')
  assert.equal(repoRow.note, 'Projects/katipon.md')
  assert.match(formatNext(rows), /^conflict {3}katipon {2}\d+d /m)
})

test('no observed activity prints a dash and sorts after observed idle days in its state', () => {
  const rows = [
    { vault: 'v', repo: 'r', change: 'a', state: 'halted', stale: false, idleDays: null, evidence: 'e', suggested: 's', note: 'Changes/r--a.md' },
    { vault: 'v', repo: 'r', change: 'b', state: 'halted', stale: false, idleDays: 7, evidence: 'e', suggested: 's', note: 'Changes/r--b.md' },
  ]
  assert.deepEqual([...rows].sort(compareItems).map(r => r.change), ['b', 'a'])
  assert.match(formatNext(rows).split('\n')[1], /r\/a {2}— {2}e/)
})

test('a row is state cell, item, idle, evidence and the suggested action', () => {
  const w = world({ katipon: { branch: 'feat/add-login', changes: { 'add-login': { tasks: OPEN, idle: 2 } } } })
  writeCache(w.home, 'katipon', {
    fetchedAt: '2026-11-10T08:00:00.000Z', host: 'github', branch: 'feat/add-login',
    pr: { number: 38, state: 'open', url: 'https://x/pull/38', conflicting: false, mergedAt: null, updatedAt: '2026-11-09T22:10:00Z' },
    checks: [{ name: 'unit', bucket: 'pass' }],
  })
  const [row] = run(w).rows
  assert.equal(row.state, 'pr-open')
  assert.equal(row.suggested, 'review and merge')
  assert.equal(row.note, 'Changes/katipon--add-login.md')
  assert.match(row.evidence, /as of 2026-11-10T08:00:00\.000Z$/)
  assert.equal(formatNext([row]).split('\n')[1], `pr-open katipon/add-login  2d  ${row.evidence}  → review and merge`)
})

test('padding aligns the item column to the widest state cell printed', () => {
  const rows = [
    { vault: 'v', repo: 'r', change: 'a', state: 'ci-red', stale: false, idleDays: 1, evidence: 'e', suggested: 's', note: 'n' },
    { vault: 'v', repo: 'r', change: 'b', state: 'archive-pending', stale: false, idleDays: 1, evidence: 'e', suggested: 's', note: 'n' },
  ]
  const [, a, b] = formatNext(rows).split('\n')
  assert.equal(a.indexOf('r/a'), b.indexOf('r/b'))
  assert.equal(b.indexOf('r/b'), 'archive-pending '.length)
})

const synthetic = n => Array.from({ length: n }, (_, i) => ({
  vault: 'v', repo: 'r', change: `c${String(i).padStart(2, '0')}`, state: 'halted', stale: false, idleDays: 1, evidence: 'e', suggested: 's', note: 'n',
}))

test('the nextRows cap prints that many rows then "… and <n> more"; at the cap there is no such line', () => {
  const over = formatNext(synthetic(53), { nextRows: 50 }).split('\n')
  assert.equal(over.length, 1 + 50 + 1)
  assert.equal(over.at(-1), '… and 3 more')
  const at = formatNext(synthetic(50), { nextRows: 50 }).split('\n')
  assert.equal(at.length, 51)
  assert.ok(!at.some(l => l.startsWith('… and')))
})

test('nextItems is not capped: the JSON rows are every item', () => {
  const changes = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`c${i}`, { tasks: OPEN }]))
  const w = world({ katipon: { changes } }, { limits: { nextRows: 3 } })
  assert.equal(run(w).rows.length, 8)
})

test('an empty list prints nothing needs you, and no registry gives no rows', () => {
  assert.equal(formatNext([]), 'nothing needs you')
  assert.deepEqual(nextItems({ registry: { vaults: {}, repos: [], limits: {} }, now: NOW }), { ok: true, rows: [] })
})

test('next writes nothing and spawns only git', () => {
  const w = world({ katipon: { branch: 'feat/add-login', changes: { 'add-login': { tasks: OPEN } } } })
  const before = [snapshotTree(w.home), ...Object.values(w.vaultPaths).map(snapshotTree)]
  run(w)
  assert.deepEqual([snapshotTree(w.home), ...Object.values(w.vaultPaths).map(snapshotTree)], before)
  assert.ok(w.exec.calls.length > 0)
  assert.ok(w.exec.calls.every(c => c.file === 'git'))
  assert.ok(w.exec.calls.every(c => c.opts.cwd))
})
