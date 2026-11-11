// lib/sync.mjs against specs/vault-writes (sync, dry run, sync log, daily transitions, archive, boundary),
// specs/note-rendering (the summary rebuilt once per vault, nothing written for a quiet day) and
// specs/remote-sources (--remote and --due-remote). Every test builds its own vaults, repos and home.
process.env.TZ = 'UTC'

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readCache } from '../lib/cache.mjs'
import { readFrontmatter } from '../lib/frontmatter.mjs'
import { splitNote } from '../lib/note.mjs'
import { appendSyncLog, syncAll, syncRepo, syncSummary, transitions } from '../lib/sync.mjs'
import { FIXTURES, fakeExec, makeRepo, makeVault, snapshotTree, tmp } from './helpers.mjs'

const NOW = new Date('2026-11-10T09:00:00Z')
const BRANCH = 'feat/add-login'
const fx = name => readFileSync(join(FIXTURES, 'remote', name), 'utf8')
const GH_VIEW = `gh pr view ${BRANCH} --json number,state,url,mergeable,mergeStateStatus,reviewDecision,isDraft,mergedAt,updatedAt,headRefName`
const GH_CHECKS = `gh pr checks ${BRANCH} --json name,bucket,state,link`

const gitTable = (branch = BRANCH) => ({
  'git rev-parse --abbrev-ref HEAD': { stdout: `${branch}\n` },
  'git status --porcelain=v2 --branch': { stdout: `# branch.head ${branch}\n` },
  'git stash list': { stdout: '' },
  'git rev-parse --git-dir': { stdout: '.git\n' },
  'git worktree list --porcelain': { stdout: '' },
  'git log -1 --format=%H%x09%cI': { stdout: '3f50683c1e0000000000000000000000000000aa\t2026-11-08T09:12:00+00:00\n' },
})
const ghTable = { [GH_VIEW]: { stdout: fx('gh-pr.json') }, [GH_CHECKS]: { stdout: fx('gh-checks.json') } }

/**
 * A vault `personal`, a Dial home that does not exist yet, and the repos in `repos`
 * (`{ name: makeRepo spec }`) registered to it. `vaultNotes` are written into the vault first.
 */
function setup({ repos = { katipon: { changes: { 'add-login': { tasks: { done: 1, total: 2 } } } } }, vaultNotes = [], table = {}, extra = {} } = {}) {
  const base = tmp('sync-')
  const vault = makeVault(join(base, 'personal'), [{ path: '.obsidian/app.json', body: '{}' }, { path: 'AGENTS.md', body: '# Agents\n' }, ...vaultNotes])
  const paths = {}
  for (const [name, spec] of Object.entries(repos)) paths[name] = makeRepo(join(base, 'repos', name), { git: true, ...spec })
  const registry = {
    dial_schema: 'dial.registry/1',
    vaults: { personal: vault },
    repos: Object.entries(paths).map(([, path]) => ({ path, vault: 'personal', host: 'github' })),
    limits: {},
    ...extra,
  }
  const home = join(base, 'home')
  const userHome = tmp('sync-user-')
  const env = { HOME: userHome, DIAL_HOME: home, ESCAPEMENT_HOME: join(userHome, '.escapement') }
  const exec = fakeExec({ ...gitTable(), ...table })
  const run = (over = {}) => syncRepo({ registry, repo: 'katipon', env, home, now: NOW, exec, ...over })
  const runAll = (over = {}) => syncAll({ registry, env, home, now: NOW, exec, ...over })
  return { base, vault, paths, registry, home, env, exec, run, runAll }
}

const read = (vault, rel) => readFileSync(join(vault, rel), 'utf8')
const fm = (vault, rel) => readFrontmatter(splitNote(read(vault, rel)).frontmatter)
const lines = file => readFileSync(file, 'utf8').split('\n').filter(Boolean)
const tmpFiles = dir => readdirSync(dir, { recursive: true }).filter(p => /(^|\/)\.[^/]*\.tmp$/.test(p))
const tasksOf = (repo, change, done, total) => writeFileSync(
  join(repo, 'openspec', 'changes', change, 'tasks.md'),
  `# Tasks\n\n${Array.from({ length: total }, (_, i) => `- [${i < done ? 'x' : ' '}] 1.${i + 1} Task ${i + 1}`).join('\n')}\n`
)

// --- the first sync and idempotence -------------------------------------------

test('a first sync writes the change note, the repo note and the summary, and reports the outcome line', () => {
  const s = setup()
  const r = s.run()
  assert.equal(r.ok, true)
  assert.equal(r.repo, 'katipon')
  assert.equal(r.vault, 'personal')
  assert.equal(r.items, 1)
  assert.equal(r.needsMe, 1)
  assert.equal(r.written, 2)
  assert.equal(r.line, 'katipon: 1 items, 1 need me, 2 written')
  assert.deepEqual(r.writes.map(w => w.verb), ['create', 'create'])
  assert.deepEqual(r.writes.map(w => w.path), [join(s.vault, 'Changes/katipon--add-login.md'), join(s.vault, 'Projects/katipon.md')])
  assert.equal(r.summary.verb, 'create')
  assert.equal(r.summary.path, join(s.vault, 'Dial Summary.md'))
  assert.deepEqual(fm(s.vault, 'Changes/katipon--add-login.md').state, 'spec-draft')
  assert.equal(fm(s.vault, 'Changes/katipon--add-login.md').scope, 'personal')
  assert.equal(fm(s.vault, 'Projects/katipon.md').type, 'repo')
  assert.match(read(s.vault, 'Dial Summary.md'), /^Needs me: 1$/m)
  assert.deepEqual(tmpFiles(s.vault), [])
})

test('a second sync writes nothing: the vault is byte-identical and every verb is unchanged', () => {
  const s = setup()
  s.run()
  const before = snapshotTree(s.vault)
  const again = s.run()
  assert.equal(again.written, 0)
  assert.equal(again.line, 'katipon: 1 items, 1 need me, 0 written')
  assert.deepEqual(again.writes.map(w => w.verb), ['unchanged', 'unchanged'])
  assert.equal(again.summary.verb, 'unchanged')
  assert.deepEqual(snapshotTree(s.vault), before)
})

test('a sync on the next day with the same facts writes nothing', () => {
  const s = setup()
  s.run()
  const before = snapshotTree(s.vault)
  const next = s.run({ now: new Date('2026-11-11T09:00:00Z') })
  assert.equal(next.written, 0)
  assert.equal(next.summary.verb, 'unchanged')
  assert.deepEqual(snapshotTree(s.vault), before)
})

test('a human\'s ## Next and ## Narrative survive the next sync', () => {
  const s = setup()
  s.run()
  const file = join(s.vault, 'Changes/katipon--add-login.md')
  writeFileSync(file, read(s.vault, 'Changes/katipon--add-login.md').replace('## Next\n', '## Next\n\n- [ ] ask Sam about the token\n').replace('## Narrative\n', '## Narrative\n\n### 2026-11-09 22:20 · /dial:handoff (claude)\n\nDone: login form.\n'))
  tasksOf(s.paths.katipon, 'add-login', 2, 2)
  const r = s.run()
  assert.equal(r.written, 3)
  const text = read(s.vault, 'Changes/katipon--add-login.md')
  assert.match(text, /- \[ \] ask Sam about the token/)
  assert.match(text, /### 2026-11-09 22:20 · \/dial:handoff \(claude\)\n\nDone: login form\./)
  assert.equal(fm(s.vault, 'Changes/katipon--add-login.md').state, 'archive-pending')
})

// --- the dry run ----------------------------------------------------------------

test('a dry run writes nothing, creates no home and no folder, and prints every planned path', () => {
  const s = setup()
  const vaultBefore = snapshotTree(s.vault)
  const r = s.run({ dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.dryRun, true)
  assert.equal(r.written, 0)
  assert.deepEqual(r.plan.map(p => p.line), [
    `create ${join(s.vault, 'Changes/katipon--add-login.md')}`,
    `create ${join(s.vault, 'Projects/katipon.md')}`,
  ])
  assert.equal(r.summary.line, `create ${join(s.vault, 'Dial Summary.md')}`)
  assert.deepEqual(snapshotTree(s.vault), vaultBefore)
  assert.equal(existsSync(s.home), false)
})

test('a dry run after a sync prints unchanged for every path', () => {
  const s = setup()
  s.run()
  const before = snapshotTree(s.vault)
  const r = s.run({ dryRun: true })
  assert.deepEqual(r.plan.map(p => p.verb), ['unchanged', 'unchanged'])
  assert.equal(r.summary.verb, 'unchanged')
  assert.deepEqual(snapshotTree(s.vault), before)
})

test('a dry run does not append to the sync log and leaves an existing home as it was', () => {
  const s = setup()
  s.run()
  const home = snapshotTree(s.home)
  s.run({ dryRun: true })
  assert.deepEqual(snapshotTree(s.home), home)
})

test('a dry run lists the summary from the planned notes, a transition as a daily append and a move as from → to', () => {
  const s = setup({
    repos: { katipon: { changes: { 'add-login': { tasks: { done: 1, total: 2 } } }, archive: { '2026-10-01-old-thing': {} } } },
  })
  s.run()
  writeFileSync(join(s.vault, 'Changes/katipon--old-thing.md'), '---\nrepo: katipon\nstate: archived\nneeds_me: false\n---\n## Next\n\n## Narrative\n')
  tasksOf(s.paths.katipon, 'add-login', 2, 2)
  const before = snapshotTree(s.vault)
  const r = s.run({ dryRun: true })
  const verbs = r.plan.map(p => p.verb)
  assert.deepEqual(verbs.slice(0, 2), ['update', 'update'])
  assert.ok(verbs.includes('create'), 'a daily note would be created')
  assert.ok(r.plan.some(p => p.line === `create ${join(s.vault, 'Daily/2026-11-10.md')}`))
  assert.ok(r.plan.some(p => p.line.startsWith('move ') && p.line.includes(' → ')))
  assert.deepEqual(snapshotTree(s.vault), before)
})

// --- transitions and the daily log ----------------------------------------------

test('a first creation appends no daily line and creates no Daily folder', () => {
  const s = setup()
  s.run()
  assert.equal(existsSync(join(s.vault, 'Daily')), false)
})

test('a state change appends one daily line under Log, and a repeat sync adds none', () => {
  const s = setup()
  s.run()
  tasksOf(s.paths.katipon, 'add-login', 2, 2)
  const r = s.run()
  assert.equal(r.daily.length, 1)
  const daily = read(s.vault, 'Daily/2026-11-10.md')
  assert.match(daily, /^type: daily$/m)
  const log = daily.split('## Log')[1].split('\n').filter(l => l.startsWith('- '))
  assert.equal(log.length, 1)
  assert.match(log[0], /^- 09:00 dial · katipon\/add-login: spec-draft → archive-pending \(.+\) \[\[katipon--add-login\]\]$/)
  s.run()
  assert.equal(read(s.vault, 'Daily/2026-11-10.md'), daily)
})

test('a transition is counted among the written files', () => {
  const s = setup()
  s.run()
  tasksOf(s.paths.katipon, 'add-login', 2, 2)
  const r = s.run()
  // the change note, the repo note (its Changes table names the state) and the new daily note
  assert.deepEqual(r.writes.map(w => w.verb), ['update', 'update', 'create'])
  assert.equal(r.written, 3)
})

test('a previous state of unobserved is not a transition', () => {
  const s = setup({ vaultNotes: [{ path: 'Changes/katipon--add-login.md', frontmatter: { repo: 'katipon', change: 'add-login', state: 'unobserved', needs_me: 'true' }, body: '## Next\n\n## Narrative\n' }] })
  const r = s.run()
  assert.deepEqual(r.daily, [])
  assert.equal(existsSync(join(s.vault, 'Daily')), false)
  assert.equal(fm(s.vault, 'Changes/katipon--add-login.md').state, 'spec-draft')
})

test('transitions: both states observed and different, an existing note, change items only', () => {
  const notes = {
    'k--a': { frontmatter: { state: 'shipping' } },
    'k--b': { frontmatter: { state: 'halted' } },
    'k--c': { frontmatter: { state: 'unobserved' } },
    'k--d': { frontmatter: {} },
  }
  const items = [
    { change: 'a', state: 'pr-open', evidence: 'gh pr view 38: OPEN' },
    { change: 'b', state: 'halted', evidence: 'x' },
    { change: 'c', state: 'queued', evidence: 'x' },
    { change: 'd', state: 'queued', evidence: 'x' },
    { change: 'e', state: 'spec-draft', evidence: 'x' },
  ]
  assert.deepEqual(transitions(notes, items, 'k'), [{ change: 'a', from: 'shipping', to: 'pr-open', detail: 'gh pr view 38: OPEN' }])
})

test('a vanished change leaves its note untouched and logs nothing', () => {
  const gone = { path: 'Changes/katipon--gone.md', frontmatter: { repo: 'katipon', change: 'gone', state: 'halted', needs_me: 'true' }, body: '## Next\n\n- [ ] one thing\n\n## Narrative\n' }
  const s = setup({ vaultNotes: [gone] })
  const before = read(s.vault, 'Changes/katipon--gone.md')
  const r = s.run()
  assert.equal(r.items, 1)
  assert.equal(read(s.vault, 'Changes/katipon--gone.md'), before)
  assert.equal(existsSync(join(s.vault, 'Daily')), false)
})

// --- archive --------------------------------------------------------------------

const archivedNote = { path: 'Changes/katipon--old-thing.md', frontmatter: { repo: 'katipon', change: 'old-thing', state: 'archived', status: 'active', needs_me: 'false' }, body: '## Next\n\n- [ ] keep me\n\n## Narrative\n' }

test('an archived note moves to Archive/Changes after archivedKeepDays, keeping its sections', () => {
  const s = setup({ repos: { katipon: { changes: { 'add-login': { tasks: { done: 0, total: 1 } } }, archive: { '2026-10-01-old-thing': {} } } }, vaultNotes: [archivedNote] })
  const r = s.run()
  assert.equal(existsSync(join(s.vault, 'Changes/katipon--old-thing.md')), false)
  const moved = fm(s.vault, 'Archive/Changes/katipon--old-thing.md')
  assert.equal(moved.status, 'archived')
  assert.equal(moved.archived, '2026-11-10')
  assert.match(read(s.vault, 'Archive/Changes/katipon--old-thing.md'), /- \[ \] keep me/)
  assert.ok(r.writes.some(w => w.verb === 'move' && w.path === join(s.vault, 'Archive/Changes/katipon--old-thing.md')))
})

test('an archived note within the keep period stays in Changes with state archived and status active', () => {
  const s = setup({ repos: { katipon: { changes: { 'add-login': { tasks: { done: 0, total: 1 } } }, archive: { '2026-11-01-old-thing': {} } } }, vaultNotes: [archivedNote] })
  s.run()
  assert.equal(existsSync(join(s.vault, 'Archive')), false)
  const kept = fm(s.vault, 'Changes/katipon--old-thing.md')
  assert.equal(kept.state, 'archived')
  assert.equal(kept.status, 'active')
})

test('an archive move whose target exists leaves both files unchanged', () => {
  const s = setup({
    repos: { katipon: { changes: { 'add-login': { tasks: { done: 0, total: 1 } } }, archive: { '2026-10-01-old-thing': {} } } },
    vaultNotes: [archivedNote, { path: 'Archive/Changes/katipon--old-thing.md', body: 'already here\n' }],
  })
  const a = read(s.vault, 'Changes/katipon--old-thing.md')
  s.run()
  assert.equal(read(s.vault, 'Changes/katipon--old-thing.md'), a)
  assert.equal(read(s.vault, 'Archive/Changes/katipon--old-thing.md'), 'already here\n')
})

// --- the summary ----------------------------------------------------------------

test('a sync of one repo keeps a second repo\'s items in the summary', () => {
  const s = setup({ repos: { katipon: { changes: { 'add-login': { tasks: { done: 1, total: 2 } } } }, specflow: { changes: { 'fix-docs': { tasks: { done: 0, total: 3 } } } } } })
  const all = s.runAll()
  assert.equal(all.ok, true)
  assert.match(read(s.vault, 'Dial Summary.md'), /\[\[specflow--fix-docs\]\]/)
  tasksOf(s.paths.katipon, 'add-login', 2, 2)
  s.run()
  const summary = read(s.vault, 'Dial Summary.md')
  assert.match(summary, /^Needs me: 2$/m)
  assert.match(summary, /\[\[specflow--fix-docs\]\] · spec-draft · /)
  assert.match(summary, /\[\[katipon--add-login\]\] · archive-pending · /)
  assert.ok(!summary.split('\n').some(l => l.startsWith('|')))
})

test('an unregistered repo\'s notes are not counted in the summary', () => {
  const s = setup({ vaultNotes: [{ path: 'Changes/old-repo--x.md', frontmatter: { repo: 'old-repo', change: 'x', state: 'halted', needs_me: 'true', last_activity: '2026-11-01T00:00:00.000Z' }, body: '## Next\n' }] })
  s.run()
  const summary = read(s.vault, 'Dial Summary.md')
  assert.match(summary, /^Needs me: 1$/m)
  assert.ok(!summary.includes('old-repo'))
})

test('the summary write counts toward no repo\'s written total and is written once per vault by syncAll', () => {
  const s = setup({ repos: { katipon: { changes: { 'add-login': { tasks: { done: 1, total: 2 } } } }, specflow: { changes: { 'fix-docs': { tasks: { done: 0, total: 3 } } } } } })
  const all = s.runAll()
  assert.deepEqual(all.results.map(r => r.written), [2, 2])
  assert.equal(all.summaries.length, 1)
  assert.equal(all.summaries[0].vault, 'personal')
  assert.equal(all.summaries[0].verb, 'create')
  assert.equal(all.failed, 0)
  assert.equal(all.total, 2)
})

test('a dry run of syncAll plans the summary from every repo\'s planned notes', () => {
  const s = setup({ repos: { katipon: { changes: { 'add-login': { tasks: { done: 1, total: 2 } } } }, specflow: { changes: { 'fix-docs': { tasks: { done: 0, total: 3 } } } } } })
  const before = snapshotTree(s.vault)
  const all = s.runAll({ dryRun: true })
  assert.equal(all.summaries[0].line, `create ${join(s.vault, 'Dial Summary.md')}`)
  assert.deepEqual(snapshotTree(s.vault), before)
  assert.equal(existsSync(s.home), false)
})

test('syncSummary caps the bullets at nextRows', () => {
  const notes = [1, 2, 3].map(n => ({ path: `Changes/katipon--c${n}.md`, frontmatter: { repo: 'katipon', state: 'halted', needs_me: 'true', last_activity: `2026-11-0${n}T00:00:00.000Z` }, body: '' }))
  const s = setup({ vaultNotes: notes })
  const r = syncSummary({ registry: s.registry, vault: 'personal', limits: { nextRows: 2 } })
  assert.equal(r.ok, true)
  const body = read(s.vault, 'Dial Summary.md')
  assert.match(body, /^Needs me: 3$/m)
  assert.equal(body.split('\n').filter(l => l.startsWith('- [[')).length, 2)
  assert.match(body, /- … and 1 more/)
})

// --- the sync log ---------------------------------------------------------------

test('each synced repo appends one line to sync.jsonl with the clock\'s ISO time', () => {
  const s = setup({ repos: { katipon: { changes: { 'add-login': { tasks: { done: 1, total: 2 } } } }, specflow: {} } })
  s.runAll({ now: new Date('2026-11-10T17:00:00+08:00') })
  const log = lines(join(s.home, 'logs', 'sync.jsonl')).map(l => JSON.parse(l))
  assert.deepEqual(log, [
    { ts: '2026-11-10T09:00:00.000Z', vault: 'personal', repo: 'katipon', needsMe: 1, items: 1 },
    { ts: '2026-11-10T09:00:00.000Z', vault: 'personal', repo: 'specflow', needsMe: 0, items: 0 },
  ])
})

test('earlier sync.jsonl lines are kept', () => {
  const s = setup()
  mkdirSync(join(s.home, 'logs'), { recursive: true })
  const old = Array.from({ length: 10 }, (_, i) => JSON.stringify({ ts: `2026-11-0${i % 9 + 1}T00:00:00.000Z`, vault: 'personal', repo: 'katipon', needsMe: 1, items: 1 }))
  writeFileSync(join(s.home, 'logs', 'sync.jsonl'), `${old.join('\n')}\n`)
  s.run()
  const now = lines(join(s.home, 'logs', 'sync.jsonl'))
  assert.equal(now.length, 11)
  assert.deepEqual(now.slice(0, 10), old)
})

test('the first sync creates the home, logs/ and sync.jsonl; a dry run creates none of them', () => {
  const s = setup()
  s.run({ dryRun: true })
  assert.equal(existsSync(s.home), false)
  s.run()
  assert.ok(existsSync(join(s.home, 'logs', 'sync.jsonl')))
  assert.equal(existsSync(join(s.home, 'cache')), false)
})

test('appendSyncLog writes the five keys in order and reports a failure as a reason', () => {
  const home = tmp('sync-log-')
  mkdirSync(join(home, 'logs'))
  const ok = appendSyncLog(home, { ts: 't', vault: 'v', repo: 'r', needsMe: 2, items: 3, extra: 'dropped' })
  assert.equal(ok.ok, true)
  assert.equal(readFileSync(join(home, 'logs', 'sync.jsonl'), 'utf8'), '{"ts":"t","vault":"v","repo":"r","needsMe":2,"items":3}\n')
  const bad = appendSyncLog(join(home, 'nope'), { ts: 't', vault: 'v', repo: 'r', needsMe: 0, items: 0 })
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /^cannot append to /)
})

// --- refusals -------------------------------------------------------------------

test('a home that cannot be written fails before any vault write', () => {
  const s = setup()
  const file = join(s.base, 'a-file')
  writeFileSync(file, 'x')
  const home = join(file, 'home')
  const before = snapshotTree(s.vault)
  const r = s.run({ home })
  assert.equal(r.ok, false)
  assert.match(r.reason, /^dial home is not writable: .*home \(ENOTDIR: /)
  assert.deepEqual(snapshotTree(s.vault), before)
  const all = s.runAll({ home })
  assert.equal(all.ok, false)
  assert.match(all.reason, /^dial home is not writable: /)
})

test('an unknown repo is refused', () => {
  const s = setup()
  const r = s.run({ repo: 'nothing-here' })
  assert.deepEqual(r, { ok: false, reason: 'no registered repo matches nothing-here' })
})

test('a repo resolves from a path inside it', () => {
  const s = setup()
  const r = s.run({ repo: join(s.paths.katipon, 'openspec') })
  assert.equal(r.ok, true)
  assert.equal(r.repo, 'katipon')
})

test('a vault path that does not exist is refused and not created', () => {
  const s = setup()
  const gone = join(s.base, 'gone')
  s.registry.vaults.personal = gone
  const r = s.run()
  assert.deepEqual(r, { ok: false, repo: 'katipon', reason: `vault personal for katipon does not exist: ${gone}` })
  assert.equal(existsSync(gone), false)
  assert.equal(s.exec.calls.length, 0, 'nothing was collected for a refused repo')
})

test('under all, a repo whose vault is missing is skipped, the others sync, and nothing is logged for it', () => {
  const s = setup({ repos: { katipon: { changes: { 'add-login': { tasks: { done: 1, total: 2 } } } }, specflow: {}, stray: {} } })
  s.registry.vaults.lost = join(s.base, 'lost')
  s.registry.repos.find(r => r.path === s.paths.stray).vault = 'lost'
  const all = s.runAll()
  assert.equal(all.ok, true)
  assert.equal(all.failed, 1)
  assert.equal(all.total, 3)
  const skipped = all.results.find(r => !r.ok)
  assert.equal(skipped.repo, 'stray')
  assert.equal(skipped.reason, `vault lost for stray does not exist: ${join(s.base, 'lost')}`)
  assert.deepEqual(all.results.filter(r => r.ok).map(r => r.repo), ['katipon', 'specflow'])
  assert.deepEqual(all.summaries.map(x => x.vault), ['personal'])
  assert.equal(lines(join(s.home, 'logs', 'sync.jsonl')).length, 2)
})

test('a repo under a root that belongs to another vault is refused before anything is collected', () => {
  const s = setup()
  s.registry.vaults.work = join(s.base, 'work')
  mkdirSync(s.registry.vaults.work)
  s.registry.roots = { [join(s.base, 'repos')]: 'work' }
  const before = snapshotTree(s.vault)
  const r = s.run()
  assert.equal(r.ok, false)
  assert.match(r.reason, /^katipon is under .*, which belongs to vault work; refusing to write into vault personal$/)
  assert.deepEqual(snapshotTree(s.vault), before)
  assert.equal(s.exec.calls.length, 0)
})

test('a registry whose limits are invalid is refused', () => {
  const s = setup()
  s.registry.limits = { staleDays: 'soon' }
  const r = s.run()
  assert.equal(r.ok, false)
  assert.match(r.reason, /staleDays/)
})

// --- remote flags ---------------------------------------------------------------

const ghCalls = exec => exec.calls.filter(c => c.file === 'gh')
const cacheFile = s => join(s.home, 'cache', 'remote', 'katipon.json')

test('without --remote neither gh nor glab runs and no cache is written', () => {
  const s = setup({ table: ghTable })
  s.run()
  assert.equal(s.exec.calls.filter(c => c.file === 'gh' || c.file === 'glab').length, 0)
  assert.equal(existsSync(join(s.home, 'cache')), false)
})

test('--remote fetches the PR and its checks once each and writes the cache', () => {
  const s = setup({ table: ghTable })
  const r = s.run({ remote: true })
  assert.equal(r.ok, true)
  assert.deepEqual(ghCalls(s.exec).map(c => c.args.slice(0, 2).join(' ')), ['pr view', 'pr checks'])
  assert.ok(ghCalls(s.exec).every(c => c.opts.cwd === s.paths.katipon))
  const cached = readCache(s.home, 'katipon')
  assert.equal(cached.data.fetchedAt, '2026-11-10T09:00:00.000Z')
  assert.equal(fm(s.vault, 'Changes/katipon--add-login.md').pr, '38')
})

test('--remote with --dry-run fetches but writes no cache and no home', () => {
  const s = setup({ table: ghTable })
  const r = s.run({ remote: true, dryRun: true })
  assert.equal(ghCalls(s.exec).length, 2)
  assert.equal(r.written, 0)
  assert.equal(existsSync(s.home), false)
})

test('--due-remote fetches when there is no cache, skips a fresh one and fetches a stale one', () => {
  const s = setup({ table: ghTable })
  s.run({ dueRemote: true })
  assert.equal(ghCalls(s.exec).length, 2, 'no cache: fetch')
  assert.ok(existsSync(cacheFile(s)))

  s.run({ dueRemote: true, now: new Date('2026-11-10T09:10:00Z') })
  assert.equal(ghCalls(s.exec).length, 2, 'fetched 10 minutes ago with a 30 minute interval: cache only')

  s.run({ dueRemote: true, now: new Date('2026-11-10T09:45:00Z') })
  assert.equal(ghCalls(s.exec).length, 4, 'fetched 45 minutes ago: fetch')
  assert.equal(readCache(s.home, 'katipon').data.fetchedAt, '2026-11-10T09:45:00.000Z')
})

test('a gitlab repo is fetched with glab only', () => {
  const s = setup({ table: { [`glab mr view ${BRANCH} -F json`]: { stdout: fx('glab-mr.json') }, [`glab ci status -b ${BRANCH} -F json`]: { stdout: fx('glab-ci.json') } } })
  s.registry.repos[0].host = 'gitlab'
  s.run({ remote: true })
  assert.equal(ghCalls(s.exec).length, 0)
  assert.equal(s.exec.calls.filter(c => c.file === 'glab').length, 2)
})

test('a failed fetch keeps the sync at ok and the note on the cached facts', () => {
  const s = setup({ table: ghTable })
  s.run({ remote: true })
  const exec = fakeExec({ ...gitTable(), [GH_VIEW]: { code: 1, stderr: 'error connecting to api.github.com\n' } })
  const r = s.run({ remote: true, exec, now: new Date('2026-11-10T10:00:00Z') })
  assert.equal(r.ok, true)
  assert.equal(readCache(s.home, 'katipon').data.fetchedAt, '2026-11-10T09:00:00.000Z')
  assert.equal(fm(s.vault, 'Changes/katipon--add-login.md').pr, '38')
})

test('interlock drift runs once per repo and only from sync', () => {
  const s = setup()
  s.run()
  assert.equal(s.exec.calls.filter(c => c.file === 'interlock' && c.args.join(' ') === 'drift --json').length, 1)
})

// --- the repo-level item --------------------------------------------------------

test('the needs-me count includes a repo-level item that needs the human', () => {
  const s = setup({
    repos: { katipon: {} },
    table: { 'git status --porcelain=v2 --branch': { stdout: `# branch.head main\nu UU N... 100644 100644 100644 100644 a b c file.txt\n` } },
  })
  const r = s.run()
  assert.equal(r.items, 0)
  assert.equal(r.needsMe, 1)
  assert.equal(fm(s.vault, 'Projects/katipon.md').state, 'conflict')
  assert.match(read(s.vault, 'Dial Summary.md'), /- \[\[katipon\]\] · conflict · /)
})
