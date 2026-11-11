// Red wave for specs/state-model/spec.md. Written before lib/derive.mjs and
// lib/facts.mjs exist: `node --test test/derive.test.mjs` fails on the import.
//
// Contract these tests pin (design.md §The fact, §The state machine):
//   derive(facts, { now: Date, limits, notes }) -> { items, repo }
//   item = { change, state, needsMe, stale, idleDays (number|null), lastActivity (iso|null),
//            suggested (string|null), evidence (string|null), rows: [{ fact, value, evidence }],
//            and the facts the change note's frontmatter prints, each a fact leaf (RepoFacts shape):
//            branch, pr, prState, ci, mergeVerdict, tasksDone, tasksTotal, lastCommit, lastSession }
//   repo = { state, needsMe, stale, suggested, evidence, ... }
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { derive } from '../lib/derive.mjs'
import { STATES, fact, unobserved, isUnobserved } from '../lib/facts.mjs'

const DIR = new URL('./fixtures/facts/', import.meta.url)
const load = name => JSON.parse(readFileSync(new URL(`${name}.json`, DIR), 'utf8'))
const clone = x => structuredClone(x)

/** Derive an envelope (or a mutated clone of one); `now` overrides the envelope's. */
function run(env, now = env.now) {
  return derive(clone(env.facts), { now: new Date(now), limits: env.limits, notes: clone(env.notes) })
}
const item = (out, change = 'add-login') => out.items.find(i => i.change === change)
const row = (it, name) => it.rows.find(r => r.fact === name)
const ok = (value, evidence) => ({ value, evidence })
const fix = name => load(name)

const ROW_ORDER = [
  'archive', 'dropped', 'tasks', 'pr', 'conflict', 'ci', 'settle', 'merge_verdict', 'manual test',
  'outcome', 'ship', 'stage', 'queue', 'decisions', 'review-artifacts', 'checkpoint', 'resume card', 'last activity',
]

const PER_CHANGE = ['stages', 'outcomes', 'reviewArtifacts', 'resumeCards', 'trajectoryTs']

/** Make `names` the active changes, each carrying a copy of add-login's per-change facts. */
function withChanges(env, names, { archived = [] } = {}) {
  const f = env.facts
  const base = f.openspec.changes['add-login']
  f.openspec.active = ok(names, `openspec/changes: ${names.join(', ')}`)
  f.openspec.archived = ok(archived, 'openspec/changes/archive')
  const changes = {}
  for (const n of names) changes[n] = clone(base)
  f.openspec.changes = changes
  for (const key of PER_CHANGE) {
    const src = f.interlock[key]['add-login']
    f.interlock[key] = Object.fromEntries(names.map(n => [n, clone(src)]))
  }
  f.escapement.entries = Object.fromEntries(names.map(n => [n, clone(f.escapement.entries['add-login'])]))
  return env
}

/** Every activity source for add-login set to `iso` or unobserved when `iso` is null. */
function quiet(env, iso = '2026-10-01T00:00:00Z') {
  const f = env.facts
  const at = (v, ev) => (v === null ? { value: null, unobserved: 'no source' } : ok(v, ev))
  f.git.lastCommit = at(iso && { sha7: '3f50683', head: '3f50683a1b2c3d4e5f60718293a4b5c6d7e8f901', date: iso }, 'git log -1')
  f.sessions.lastSession = at(iso && { file: '/s.jsonl', mtime: iso }, 'session')
  if (f.openspec.changes['add-login']) f.openspec.changes['add-login'].lastMtime = at(iso, 'mtime')
  f.interlock.trajectoryTs['add-login'] = at(iso, 'trajectory')
  f.interlock.outcomes['add-login'] = iso
    ? ok({ commit: null, mergeVerdict: null, ts: iso }, 'outcome')
    : { value: null, unobserved: 'no source' }
  f.escapement.entries['add-login'] = at(iso && { id: 'q-1', state: 'pending', lastTs: iso, observation: null }, 'queue')
  f.remote.pr = ok('none', 'gh pr view: none')
  env.notes = {}
  return env
}

// --- facts.mjs ---------------------------------------------------------------

test('STATES is the one frozen priority list, archived first and spec-draft last', () => {
  assert.deepEqual([...STATES], load('all-signals').expect.walk)
  assert.ok(Object.isFrozen(STATES))
})

test('fact and unobserved build the two leaf shapes and isUnobserved tells them apart', () => {
  assert.deepEqual(fact(3, 'a: 3'), { value: 3, evidence: 'a: 3' })
  const u = unobserved('no openspec dir')
  assert.equal(u.value, null)
  assert.equal(u.unobserved, 'no openspec dir')
  assert.equal(isUnobserved(u), true)
  assert.equal(isUnobserved(fact(null, 'observed null')), false)
  assert.equal(isUnobserved(fact('absent', 'x: absent')), false)
})

// --- one fixture per state ---------------------------------------------------

const STATE_FIXTURES = readdirSync(DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace(/\.json$/, ''))
  .filter(n => load(n).expect.state)
  .filter(n => n !== 'all-signals')

test('there is a fixture for every state in the priority list', () => {
  const covered = new Set(STATE_FIXTURES.map(n => load(n).expect.state))
  for (const s of STATES) assert.ok(covered.has(s), `no fixture yields ${s}`)
})

for (const name of STATE_FIXTURES) {
  test(`fixture ${name} yields exactly its state, needs_me, suggested action and evidence`, () => {
    const env = load(name)
    const it = item(run(env))
    assert.ok(it, 'no item for add-login')
    const want = env.expect
    assert.equal(it.state, want.state)
    assert.equal(it.needsMe, want.needsMe)
    assert.equal(it.suggested, want.suggested)
    if (want.evidence !== undefined) assert.equal(it.evidence, want.evidence)
    for (const [fname, ev] of Object.entries(want.rows ?? {})) assert.equal(row(it, fname)?.evidence, ev, `row ${fname}`)
    if (want.stale !== undefined) assert.equal(it.stale, want.stale)
    if (want.idleDays !== undefined) assert.equal(it.idleDays, want.idleDays)
    if (want.lastActivity !== undefined) assert.equal(Date.parse(it.lastActivity), Date.parse(want.lastActivity))
  })
}

// --- the frontmatter facts every item carries (read by lib/render.mjs) -------

test('an item carries the facts its note frontmatter prints', () => {
  const it = item(run(fix('pr-open')))
  assert.equal(it.branch.value, 'feat/add-login')
  assert.equal(it.pr.value, 38)
  assert.equal(it.prState.value, 'open')
  assert.equal(it.ci.value, 'pass')
  assert.equal(it.tasksDone.value, 2)
  assert.equal(it.tasksTotal.value, 5)
  assert.equal(it.lastCommit.value, '3f50683')
  assert.equal(Date.parse(it.lastSession.value), Date.parse('2026-11-09T17:00:00Z'))
  assert.equal(isUnobserved(it.mergeVerdict), false)
})

test('an item the branch is not attributed to reads pr and prState as none, an observed absence', () => {
  const env = withChanges(fix('pr-open'), ['add-login', 'fix-cache'])
  env.facts.git.branch = ok('main', 'git rev-parse --abbrev-ref HEAD: main')
  const it = item(run(env))
  assert.equal(it.pr.value, 'none')
  assert.equal(it.prState.value, 'none')
})

// --- items -------------------------------------------------------------------

test('active changes and recently archived changes become items, ordered by change name', () => {
  const env = withChanges(fix('spec-draft'), ['add-login', 'fix-cache'], {
    archived: [{ name: 'old-auth', date: '2026-10-11' }, { name: 'older-auth', date: '2026-10-10' }],
  })
  const out = run(env)
  assert.deepEqual(out.items.map(i => i.change), ['add-login', 'fix-cache', 'old-auth'])
  assert.equal(item(out, 'old-auth').state, 'archived')
})

test('no OpenSpec means no change items and only the repo-level item', () => {
  const env = load('repo-only')
  const out = run(env)
  assert.deepEqual(out.items, [])
  assert.equal(out.repo.state, env.expect.repo.state)
  assert.equal(out.repo.needsMe, false)
})

// --- the priority walk -------------------------------------------------------

/** Each step removes the top signal of all-signals and names the state it should yield. */
const WALK = [
  ['archived', env => env],
  ['dropped', env => { env.facts.openspec.archived = ok([], 'openspec/changes/archive') }],
  ['archive-pending', env => { delete env.notes['katipon--add-login'].frontmatter.dropped }],
  ['conflict', env => {
    env.facts.openspec.changes['add-login'].tasks = ok({ done: 2, total: 3 }, 'tasks.md: 2/3')
    env.facts.remote.pr.value.state = 'open'
    env.facts.remote.pr.value.mergedAt = null
  }],
  ['ci-red', env => {
    env.facts.git.inProgress = ok('none', '.git/rebase-merge: absent')
    env.facts.remote.pr.value.conflicting = false
  }],
  ['needs-fix', env => { env.facts.remote.ci = ok({ value: 'pass', failing: [] }, 'gh pr checks: pass') }],
  ['manual-test', env => { env.facts.interlock.settle = ok('absent', '.claude/ship/settle: absent') }],
  ['pr-open', env => { env.facts.openspec.changes['add-login'].manualTest = ok('pass', 'manual-test-plan.md: Result: pass') }],
  ['shipped', env => { env.facts.remote.pr = ok('none', 'gh pr view: none') }],
  ['halted', env => { env.facts.interlock.outcomes['add-login'].value.commit = null }],
  ['shipping', env => { env.facts.interlock.run.value.halted = null }],
  ['queued', env => {
    env.facts.interlock.run = ok('absent', '.claude/ship/run.json: absent')
    env.facts.interlock.stages['add-login'] = ok('absent', '.claude/ship/add-login/stage.json: absent')
  }],
  ['checkpoint', env => { env.facts.escapement.entries['add-login'] = ok('absent', '~/.escapement/queue: no entry') }],
  ['spec-draft', env => { env.facts.openspec.changes['add-login'].needsHuman = ok([], 'decisions.md: none') }],
]

test('priority walk: all-signals yields archived and removing the top signal in turn walks the table', () => {
  const env = load('all-signals')
  assert.deepEqual(WALK.map(([s]) => s), env.expect.walk)
  for (const [state, mutate] of WALK) {
    mutate(env)
    assert.equal(item(run(env)).state, state)
  }
})

test('the walk fixture itself pins archived with needs_me false and no suggestion', () => {
  const env = load('all-signals')
  const it = item(run(env))
  assert.equal(it.state, env.expect.state)
  assert.equal(it.needsMe, false)
  assert.equal(it.suggested, null)
})

test('an unobserved ci never makes ci-red', () => {
  const env = fix('spec-draft')
  env.facts.remote.ci = { value: null, unobserved: 'no remote cache, run dial sync --remote' }
  assert.equal(item(run(env)).state, 'spec-draft')
})

test('unobserved facts never match a signal, even with every signal present in the bundle', () => {
  const env = load('all-signals')
  delete env.notes['katipon--add-login'].frontmatter.dropped
  const u = reason => ({ value: null, unobserved: reason })
  const f = env.facts
  f.openspec.archived = u('no openspec dir')
  f.openspec.changes['add-login'].tasks = u('no tasks')
  f.openspec.changes['add-login'].manualTest = u('no plan')
  f.openspec.changes['add-login'].needsHuman = u('no decisions')
  f.openspec.changes['add-login'].checkpoint = u('no checkpoint')
  f.git.inProgress = u('git: not on PATH')
  f.git.unmerged = u('git: not on PATH')
  f.remote.pr = u('gh: not authenticated')
  f.remote.ci = u('gh: not authenticated')
  f.interlock.run = u('no ship dir')
  f.interlock.terminal = u('no ship dir')
  f.interlock.interrupted = u('no ship dir')
  f.interlock.merge = u('no ship dir')
  f.interlock.settle = u('no ship dir')
  f.interlock.stages['add-login'] = u('no ship dir')
  f.interlock.outcomes['add-login'] = u('no outcomes')
  f.interlock.reviewArtifacts['add-login'] = u('no metrics')
  f.escapement.entries['add-login'] = u('~/.escapement: absent')
  assert.equal(item(run(env)).state, 'spec-draft')
})

// --- archived and dropped ----------------------------------------------------

test('archived beats a merged PR and is never archive-pending', () => {
  const env = fix('archived')
  env.facts.remote.pr = ok({ number: 38, state: 'merged', url: 'u', conflicting: false, mergedAt: '2026-11-09T10:00:00Z', updatedAt: '2026-11-09T10:00:00Z' }, 'gh pr view 38: MERGED')
  assert.equal(item(run(env)).state, 'archived')
})

test('a dropped change that is later archived reads archived', () => {
  const env = fix('dropped')
  env.facts.openspec.archived = ok([{ name: 'add-login', date: '2026-11-09' }], 'archive/2026-11-09-add-login')
  env.facts.openspec.active = ok([], 'openspec/changes: none')
  assert.equal(item(run(env)).state, 'archived')
})

test('a dropped key with any value counts, whatever the change facts say', () => {
  const env = fix('halted')
  env.notes['katipon--add-login'] = { frontmatter: { type: 'change', dropped: 'later' }, next: [], narrative: [] }
  assert.equal(item(run(env)).state, 'dropped')
})

// --- branch and pull request signals -----------------------------------------

test('archive-pending from a merged PR with 7 of 9 tasks ticked', () => {
  const env = fix('spec-draft')
  env.facts.openspec.changes['add-login'].tasks = ok({ done: 7, total: 9 }, 'tasks.md: 7/9')
  env.facts.remote.pr = ok({ number: 38, state: 'merged', url: 'u', conflicting: false, mergedAt: '2026-11-09T10:00:00Z', updatedAt: '2026-11-09T10:00:00Z' }, 'gh pr view 38: MERGED 2026-11-09T10:00:00Z')
  const it = item(run(env))
  assert.equal(it.state, 'archive-pending')
  assert.equal(it.evidence, 'gh pr view 38: MERGED 2026-11-09T10:00:00Z')
})

test('zero of zero tasks is not archive-pending', () => {
  const env = fix('spec-draft')
  env.facts.openspec.changes['add-login'].tasks = ok({ done: 0, total: 0 }, 'openspec/changes/add-login/tasks.md: 0/0')
  assert.equal(item(run(env)).state, 'spec-draft')
})

test('conflict from the PR reading CONFLICTING', () => {
  const env = fix('spec-draft')
  env.facts.remote.pr = ok({ number: 38, state: 'open', url: 'u', conflicting: true, mergedAt: null, updatedAt: '2026-11-09T18:30:00Z' }, 'gh pr view 38 mergeable: CONFLICTING')
  const it = item(run(env))
  assert.equal(it.state, 'conflict')
  assert.equal(it.evidence, 'gh pr view 38 mergeable: CONFLICTING')
})

test('conflict from unmerged files', () => {
  const env = fix('spec-draft')
  env.facts.git.unmerged = ok(['src/a.mjs'], 'git status --porcelain=v2: 1 unmerged file')
  assert.equal(item(run(env)).state, 'conflict')
})

test('git and PR facts count only for the change they are attributed to', () => {
  const env = withChanges(fix('conflict'), ['add-login', 'fix-cache'])
  env.facts.git.branch = ok('feat/add-login', 'git rev-parse --abbrev-ref HEAD: feat/add-login')
  const out = run(env)
  assert.equal(item(out, 'add-login').state, 'conflict')
  assert.equal(item(out, 'fix-cache').state, 'spec-draft')
})

// --- review and test signals -------------------------------------------------

test('needs-fix from a BLOCK verdict in merge-confidence.json', () => {
  const env = fix('spec-draft')
  env.facts.interlock.merge = ok({ change: 'add-login', verdict: 'BLOCK' }, '.claude/ship/merge-confidence.json result.verdict: BLOCK')
  const it = item(run(env))
  assert.equal(it.state, 'needs-fix')
  assert.equal(it.evidence, '.claude/ship/merge-confidence.json result.verdict: BLOCK')
})

test('a BLOCK verdict for another change does not count', () => {
  const env = fix('spec-draft')
  env.facts.interlock.merge = ok({ change: 'fix-cache', verdict: 'BLOCK' }, '.claude/ship/merge-confidence.json result.verdict: BLOCK')
  assert.equal(item(run(env)).state, 'spec-draft')
})

test('a settle record counts only for the change the branch is attributed to', () => {
  const env = withChanges(fix('needs-fix'), ['add-login', 'fix-cache'])
  const out = run(env)
  assert.equal(item(out, 'add-login').state, 'needs-fix')
  assert.equal(item(out, 'fix-cache').state, 'spec-draft')
})

test('a ticked Next box naming the manual test clears manual-test, case-insensitively', () => {
  const env = fix('manual-test')
  env.notes['katipon--add-login'] = {
    frontmatter: { type: 'change' },
    next: [{ checked: true, text: 'Run the Manual Test plan on staging' }],
    narrative: [],
  }
  assert.notEqual(item(run(env)).state, 'manual-test')
})

test('an unticked Next box naming the manual test does not clear manual-test', () => {
  const env = fix('manual-test')
  env.notes['katipon--add-login'] = {
    frontmatter: { type: 'change' },
    next: [{ checked: false, text: 'manual test the login form' }],
    narrative: [],
  }
  assert.equal(item(run(env)).state, 'manual-test')
})

// --- ship run signals --------------------------------------------------------

test('halted names the resume card in its resume card row when one exists', () => {
  const r = row(item(run(fix('halted'))), 'resume card')
  assert.ok(r.value.includes('.claude/handoff/ship-add-login-7a587a81.md') || r.evidence.includes('.claude/handoff/ship-add-login-7a587a81.md'))
})

test('a killed run reads as halted: interrupted with the dead stage pid as evidence', () => {
  const env = fix('spec-draft')
  env.facts.interlock.run = ok({ runId: '7a587a81', change: 'add-login', ended: null, halted: null, closedAt: null, stateHome: null }, '.claude/ship/run.json: run 7a587a81')
  env.facts.interlock.stages['add-login'] = ok({ pid: 48211, alive: false }, '.claude/ship/add-login/stage.json pid 48211: dead')
  const it = item(run(env))
  assert.equal(it.state, 'halted')
  assert.equal(row(it, 'ship').value, 'halted: interrupted')
  assert.equal(it.evidence, '.claude/ship/add-login/stage.json pid 48211: dead')
})

test('shipping from an Escapement running entry when no run names the change', () => {
  const env = fix('queued')
  env.facts.escapement.entries['add-login'] = ok({ id: 'q-123', state: 'running', lastTs: '2026-11-09T19:00:00Z', observation: null }, '~/.escapement/queue/running/q-123.json: running')
  const it = item(run(env))
  assert.equal(it.state, 'shipping')
  assert.equal(it.evidence, '~/.escapement/queue/running/q-123.json: running')
})

// --- the interrupted-note latest-run rule ------------------------------------

const NOTE = { runId: '7a587a81', change: 'add-login', at: '2026-11-09T16:30:00.000Z', file: '.claude/ship/interrupted/7a587a81.json' }

test('halted from an interrupted note when run.json names another change and nothing is newer', () => {
  const env = fix('spec-draft')
  env.facts.interlock.interrupted = ok([NOTE], '.claude/ship/interrupted: 1 note')
  env.facts.interlock.run = ok({ runId: '5d3e9a10', change: 'fix-cache', ended: 'run-complete', halted: null, closedAt: '2026-11-08T12:00:00Z', stateHome: null }, '.claude/ship/run.json: run 5d3e9a10')
  const it = item(run(env))
  assert.equal(it.state, 'halted')
  assert.equal(it.evidence, '.claude/ship/interrupted/7a587a81.json: add-login')
})

test('an old interrupted note does not halt a live re-run (fixture) and says why', () => {
  const env = load('interrupted-old-run')
  const it = item(run(env))
  assert.equal(it.state, 'shipping')
  assert.equal(row(it, 'ship').evidence, '.claude/ship/interrupted/7a587a81.json: run 7a587a81, not the latest run')
})

test('a later closed run supersedes an interrupted note (fixture)', () => {
  assert.equal(item(run(load('interrupted-superseded'))).state, 'shipped')
})

test('a spoken note for the latest run still halts: spokenAt is ignored', () => {
  const env = fix('spec-draft')
  env.facts.interlock.interrupted = ok([{ ...NOTE, spokenAt: '2026-11-09T16:31:00.000Z' }], '.claude/ship/interrupted: 1 note')
  env.facts.interlock.run = ok({ runId: '5d3e9a10', change: 'fix-cache', ended: 'run-complete', halted: null, closedAt: '2026-11-08T12:00:00Z', stateHome: null }, '.claude/ship/run.json: run 5d3e9a10')
  assert.equal(item(run(env)).state, 'halted')
})

test('an interrupted note for another change never halts this one', () => {
  const env = fix('spec-draft')
  env.facts.interlock.interrupted = ok([{ ...NOTE, change: 'fix-cache' }], '.claude/ship/interrupted: 1 note')
  assert.equal(item(run(env)).state, 'spec-draft')
})

// --- settle for another head -------------------------------------------------

test('a settle record for another head does not match needs-fix and the settle row says so', () => {
  const env = load('settle-other-head')
  const it = item(run(env))
  assert.notEqual(it.state, 'needs-fix')
  assert.equal(row(it, 'settle').evidence, env.expect.rows.settle)
})

// --- queue, checkpoint and draft ---------------------------------------------

test('checkpoint from a review-artifacts findings file while checkpoint.json is absent or returned', () => {
  for (const cp of ['absent', 'returned']) {
    const env = fix('spec-draft')
    env.facts.interlock.reviewArtifacts['add-login'] = ok({ blockers: 1, file: '.claude/metrics/review-artifacts-add-login-20261110-091200.json' }, '.claude/metrics/review-artifacts-add-login-20261110-091200.json: 1 blockers')
    env.facts.openspec.changes['add-login'].checkpoint = ok(cp, `checkpoint.json: ${cp}`)
    assert.equal(item(run(env)).state, 'checkpoint', cp)
  }
})

test('an approved checkpoint with no needs_human row is a spec-draft that suggests ship', () => {
  const env = load('spec-approved')
  const it = item(run(env))
  assert.equal(it.state, 'spec-draft')
  assert.equal(it.needsMe, true)
  assert.equal(it.suggested, '/interlock:ship add-login')
})

test('a spec-draft that is not approved suggests review-artifacts', () => {
  assert.equal(item(run(fix('spec-draft'))).suggested, '/interlock:review-artifacts')
})

// --- needs_me for pr-open ----------------------------------------------------

test('pr-open with a MERGE verdict from merge-confidence.json needs nobody', () => {
  const env = fix('pr-open')
  env.facts.interlock.merge = ok({ change: 'add-login', verdict: 'MERGE' }, '.claude/ship/merge-confidence.json result.verdict: MERGE')
  const it = item(run(env))
  assert.equal(it.state, 'pr-open')
  assert.equal(it.needsMe, false)
})

test('pr-open with a HUMAN verdict from the last outcome needs me when merge-confidence does not name the change', () => {
  const env = fix('pr-open')
  env.facts.interlock.merge = ok({ change: 'fix-cache', verdict: 'MERGE' }, '.claude/ship/merge-confidence.json')
  env.facts.interlock.outcomes['add-login'] = ok({ commit: '3f50683', mergeVerdict: 'HUMAN', ts: '2026-11-09T20:00:00Z' }, '.claude/learning/outcomes.jsonl: add-login commit 3f50683 verdict HUMAN')
  const it = item(run(env))
  assert.equal(it.state, 'pr-open')
  assert.equal(it.needsMe, true)
})

test('pr-open with a MERGE verdict only on the last outcome needs nobody', () => {
  const env = fix('pr-open')
  env.facts.interlock.outcomes['add-login'] = ok({ commit: '3f50683', mergeVerdict: 'MERGE', ts: '2026-11-09T20:00:00Z' }, '.claude/learning/outcomes.jsonl: add-login commit 3f50683 verdict MERGE')
  assert.equal(item(run(env)).needsMe, false)
})

test('pr-open with no verdict observed needs me', () => {
  assert.equal(item(run(fix('pr-open'))).needsMe, true)
})

// --- evidence rows -----------------------------------------------------------

test('every item carries one row per signal in the fixed order, matched or not', () => {
  const out = run(withChanges(fix('pr-open'), ['add-login', 'fix-cache']))
  for (const it of out.items) assert.deepEqual(it.rows.map(r => r.fact), ROW_ORDER)
})

test('unmatched signals still appear: a pr-open item has ci pass and a tasks row', () => {
  const env = fix('pr-open')
  env.facts.remote.ci = ok({ value: 'pass', failing: [] }, 'gh pr checks feat/add-login: pass')
  const it = item(run(env))
  assert.equal(it.state, 'pr-open')
  assert.equal(row(it, 'ci').value, 'pass')
  assert.ok(row(it, 'tasks'))
  assert.equal(it.evidence, 'gh pr view 38: OPEN')
})

test('an unobserved fact prints as unobserved: <reason> in its row, e.g. an absent Escapement home', () => {
  const env = fix('spec-draft')
  env.facts.escapement.entries['add-login'] = { value: null, unobserved: '~/.escapement: absent' }
  assert.equal(row(item(run(env)), 'queue').value, 'unobserved: ~/.escapement: absent')
})

// --- stale -------------------------------------------------------------------

test('fifteen idle days is stale: the state stays, needs_me and the suggestion are overridden', () => {
  const env = load('stale')
  const it = item(run(env))
  assert.equal(it.idleDays, 15)
  assert.equal(it.stale, true)
  assert.equal(it.state, 'queued')
  assert.equal(it.needsMe, true)
  assert.equal(it.suggested, 'archive, drop, or re-spec')
})

test('exactly staleDays idle days is not stale', () => {
  const env = quiet(fix('spec-draft'), '2026-10-27T09:00:00Z')
  const it = item(run(env, '2026-11-10T09:00:00Z'))
  assert.equal(it.idleDays, 14)
  assert.equal(it.stale, false)
})

test('idle days is floor((now - lastActivity) / 86400 s)', () => {
  const env = quiet(fix('spec-draft'), '2026-10-27T10:00:00Z')
  assert.equal(item(run(env, '2026-11-10T09:00:00Z')).idleDays, 13)
})

const SOURCES = {
  'last commit': (env, iso) => { env.facts.git.lastCommit = ok({ sha7: 'abc1234', head: 'abc1234'.padEnd(40, '0'), date: iso }, 'git log -1') },
  'last session': (env, iso) => { env.facts.sessions.lastSession = ok({ file: '/s.jsonl', mtime: iso }, 'session') },
  'PR updatedAt': (env, iso) => {
    env.facts.remote.pr = ok({ number: 38, state: 'open', url: 'u', conflicting: false, mergedAt: null, updatedAt: iso }, 'gh pr view 38: OPEN')
  },
  'trajectory ts': (env, iso) => { env.facts.interlock.trajectoryTs['add-login'] = ok(iso, 'trajectory') },
  'last outcome ts': (env, iso) => { env.facts.interlock.outcomes['add-login'] = ok({ commit: null, mergeVerdict: null, ts: iso }, 'outcome') },
  'queue transition ts': (env, iso) => { env.facts.escapement.entries['add-login'] = ok({ id: 'q-1', state: 'pending', lastTs: iso, observation: null }, 'queue') },
  'change dir mtime': (env, iso) => { env.facts.openspec.changes['add-login'].lastMtime = ok(iso, 'mtime') },
}

for (const [label, set] of Object.entries(SOURCES)) {
  test(`lastActivity reads the ${label} when it is the newest source`, () => {
    const env = quiet(fix('spec-draft'))
    const newest = '2026-11-03T12:00:00Z'
    set(env, newest)
    const it = item(run(env))
    assert.equal(Date.parse(it.lastActivity), Date.parse(newest))
    assert.equal(it.idleDays, 6)
  })
}

test('a narrative entry counts as activity', () => {
  const env = quiet(fix('spec-draft'))
  env.notes = {
    'katipon--add-login': {
      frontmatter: { type: 'change' },
      next: [],
      narrative: [{ at: '2026-11-09T22:20:00Z', source: 'dial handoff' }],
    },
  }
  assert.equal(Date.parse(item(run(env)).lastActivity), Date.parse('2026-11-09T22:20:00Z'))
})

test("the note's own updated date never counts as activity", () => {
  const env = quiet(fix('spec-draft'), '2026-10-21T09:00:00Z')
  env.notes = { 'katipon--add-login': { frontmatter: { type: 'change', updated: '2026-11-10' }, next: [], narrative: [] } }
  const it = item(run(env, '2026-11-10T09:00:00Z'))
  assert.equal(it.idleDays, 20)
  assert.equal(it.stale, true)
})

test('archived and dropped are never stale and never need me', () => {
  for (const name of ['archived', 'dropped']) {
    const env = quiet(fix(name), '2026-09-11T09:00:00Z')
    if (name === 'dropped') env.notes = fix('dropped').notes
    const it = item(run(env, '2026-11-10T09:00:00Z'))
    assert.equal(it.state, name)
    assert.equal(it.stale, false, name)
    assert.equal(it.needsMe, false, name)
  }
})

test('no observed activity: idle days is null and the item is not stale', () => {
  const env = quiet(fix('spec-draft'), null)
  const it = item(run(env))
  assert.equal(it.idleDays, null)
  assert.equal(it.stale, false)
  assert.equal(it.lastActivity, null)
  assert.equal(row(it, 'last activity').value, 'unobserved: no activity observed')
})

// --- attribution -------------------------------------------------------------

/** The change names whose item is pr-open after attributing a branch. */
function attributed(branch, active, { run: runChange, detached = false } = {}) {
  const env = withChanges(quiet(fix('spec-draft')), active)
  env.facts.git.branch = ok(branch, `git rev-parse --abbrev-ref HEAD: ${branch}`)
  env.facts.git.detached = ok(detached, 'git rev-parse --abbrev-ref HEAD')
  env.facts.remote.pr = ok({ number: 38, state: 'open', url: 'u', conflicting: false, mergedAt: null, updatedAt: '2026-11-09T18:30:00Z' }, 'gh pr view 38: OPEN')
  if (runChange) {
    env.facts.interlock.run = ok({ runId: '5d3e9a10', change: runChange, ended: 'run-complete', halted: null, closedAt: '2026-11-08T12:00:00Z', stateHome: null }, '.claude/ship/run.json: run 5d3e9a10')
  }
  const out = run(env)
  return { names: out.items.filter(i => i.state === 'pr-open').map(i => i.change), out }
}

test('attribution: a name that is a path segment of the branch', () => {
  assert.deepEqual(attributed('feat/scaffold-cli-and-registry', ['scaffold-cli-and-registry']).names, ['scaffold-cli-and-registry'])
})

test('attribution: a name that ends the branch after a dash', () => {
  assert.deepEqual(attributed('carl/123-add-login', ['add-login']).names, ['add-login'])
})

test('attribution: the longest matching name wins', () => {
  assert.deepEqual(attributed('feat/add-login', ['login', 'add-login']).names, ['add-login'])
})

test('attribution: fall back to the run.json change when it is active', () => {
  assert.deepEqual(attributed('main', ['add-login', 'fix-cache'], { run: 'fix-cache' }).names, ['fix-cache'])
})

test('attribution: fall back to the only active change', () => {
  assert.deepEqual(attributed('main', ['add-login']).names, ['add-login'])
})

test('attribution: no attribution feeds the repo-level item', () => {
  const { names, out } = attributed('main', ['add-login', 'fix-cache'])
  assert.deepEqual(names, [])
  assert.equal(out.repo.state, 'pr-open')
})

test('attribution: a detached HEAD skips the name match', () => {
  const { names } = attributed('feat/add-login', ['add-login', 'fix-cache'], { detached: true })
  assert.deepEqual(names, [])
})

// --- the repo-level item -----------------------------------------------------

const openPr = updatedAt => ok({ number: 38, state: 'open', url: 'u', conflicting: false, mergedAt: null, updatedAt }, 'gh pr view 38: OPEN')

test('repo-level: a repo without OpenSpec or PR is idle and needs nobody', () => {
  const out = run(load('repo-only'))
  assert.equal(out.repo.state, 'idle')
  assert.equal(out.repo.needsMe, false)
  assert.equal(out.repo.suggested, null)
})

test('repo-level: an unattributed merge in progress is conflict and no change item is', () => {
  const env = load('repo-only')
  env.facts.git.inProgress = ok('merge', '.git/MERGE_HEAD: present')
  const out = run(env)
  assert.equal(out.repo.state, 'conflict')
  assert.equal(out.repo.needsMe, true)
  assert.equal(out.repo.suggested, 'resolve, then git rebase --continue')
  assert.ok(out.items.every(i => i.state !== 'conflict'))
})

test('repo-level: an unattributed failing check is ci-red', () => {
  const env = load('repo-only')
  env.facts.remote.pr = openPr('2026-11-09T18:30:00Z')
  env.facts.remote.ci = ok({ value: 'fail', failing: ['lint'] }, 'gh pr checks main: fail (lint)')
  const out = run(env)
  assert.equal(out.repo.state, 'ci-red')
  assert.equal(out.repo.needsMe, true)
  assert.equal(out.repo.suggested, '/interlock:fix-tests')
})

test('repo-level: a merged PR with no change is merged and needs nobody', () => {
  const env = load('repo-only')
  env.facts.remote.pr = ok({ number: 38, state: 'merged', url: 'u', conflicting: false, mergedAt: '2026-11-09T10:00:00Z', updatedAt: '2026-11-09T10:00:00Z' }, 'gh pr view 38: MERGED')
  const out = run(env)
  assert.equal(out.repo.state, 'merged')
  assert.equal(out.repo.needsMe, false)
  assert.equal(out.repo.suggested, null)
})

test('repo-level: attributed facts leave the repo idle', () => {
  const env = withChanges(fix('pr-open'), ['add-login'])
  const out = run(env)
  assert.equal(out.repo.state, 'idle')
  assert.equal(item(out).state, 'pr-open')
})

test('repo-level: a stale open PR is stale with the archive, drop, or re-spec action', () => {
  const env = load('repo-only')
  const old = '2026-10-21T09:00:00Z'
  env.facts.git.lastCommit.value.date = old
  env.facts.sessions.lastSession.value.mtime = old
  env.facts.remote.pr = openPr(old)
  const out = run(env)
  assert.equal(out.repo.state, 'pr-open')
  assert.equal(out.repo.stale, true)
  assert.equal(out.repo.suggested, 'archive, drop, or re-spec')
})

test('repo-level: idle and merged are never stale', () => {
  const env = load('repo-only')
  const old = '2026-08-01T09:00:00Z'
  env.facts.git.lastCommit.value.date = old
  env.facts.sessions.lastSession.value.mtime = old
  assert.equal(run(env).repo.stale, false)
})

// --- determinism and the clock -----------------------------------------------

test('derive is deterministic: two calls over the same input are deep-equal', () => {
  for (const name of ['all-signals', 'halted', 'stale', 'repo-only']) {
    const env = load(name)
    assert.deepEqual(run(env), run(env), name)
  }
})

test('derive does not mutate its input', () => {
  const env = load('halted')
  const facts = clone(env.facts)
  derive(facts, { now: new Date(env.now), limits: env.limits, notes: env.notes })
  assert.deepEqual(facts, env.facts)
})

test('the clock moves the overlay only: same state, idle days 5 to 25, stale false to true', () => {
  const env = quiet(fix('queued'), '2026-11-05T09:00:00Z')
  const early = item(run(env, '2026-11-10T09:00:00Z'))
  const late = item(run(env, '2026-11-30T09:00:00Z'))
  assert.equal(early.state, 'queued')
  assert.equal(late.state, 'queued')
  assert.equal(early.idleDays, 5)
  assert.equal(late.idleDays, 25)
  assert.equal(early.stale, false)
  assert.equal(late.stale, true)
})
