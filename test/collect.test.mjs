import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { collectRepo } from '../lib/collect.mjs'
import { isUnobserved } from '../lib/facts.mjs'
import { LIMITS } from '../lib/limits.mjs'
import { FIXTURES, fakeExec, makeRepo, tmp } from './helpers.mjs'

const NOW = new Date('2026-11-10T09:00:00Z')

/** The bundle's skeleton: every plain object kept, every fact leaf (an object with `evidence` or `unobserved`) replaced by 'leaf'. */
function shape(o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return 'leaf'
  if ('evidence' in o || 'unobserved' in o) return 'leaf'
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)]))
}
const fixtureShape = name => shape(JSON.parse(readFileSync(join(FIXTURES, 'facts', name), 'utf8')).facts)

function bare() {
  const userHome = tmp('collect-user-')
  const repoPath = makeRepo(tmp('collect-repo-'), {})
  const home = tmp('collect-home-')
  const exec = fakeExec({ 'git rev-parse --abbrev-ref HEAD': { code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' } })
  const repo = { name: 'bare', path: repoPath, vault: 'personal', host: 'github' }
  return { userHome, repoPath, home, exec, repo, env: { HOME: userHome } }
}

test('a repo with no git, no OpenSpec, no Escapement home and no cache is unobserved facts in the fixtures\' shape', () => {
  const { repo, home, exec, env } = bare()
  const facts = collectRepo({ repo, limits: LIMITS, env, now: NOW, home, exec })
  assert.deepEqual(shape(facts), fixtureShape('repo-only.json'))
  assert.equal(facts.repo.name, 'bare')
  assert.equal(facts.repo.vault, 'personal')
  for (const k of Object.keys(facts.git)) assert.equal(facts.git[k].unobserved, 'git: not a work tree', k)
  assert.equal(facts.openspec.active.unobserved, 'no openspec dir')
  assert.equal(facts.openspec.archived.unobserved, 'no openspec dir')
  assert.equal(facts.interlock.run.value, 'absent')
  assert.equal(isUnobserved(facts.interlock.drift), true)
  assert.deepEqual(facts.escapement, { entries: {} })
  assert.equal(facts.sessions.lastSession.unobserved.startsWith('no sessions under ~/.claude/projects/'), true)
  for (const k of ['pr', 'ci', 'remote']) assert.equal(isUnobserved(facts.remote[k]), true, k)
})

test('every fixture bundle has the same top-level shape as collectRepo\'s', () => {
  const { repo, home, exec, env } = bare()
  const mine = shape(collectRepo({ repo, limits: LIMITS, env, now: NOW, home, exec }))
  for (const f of readdirSync(join(FIXTURES, 'facts'))) {
    const theirs = fixtureShape(f)
    assert.deepEqual(Object.keys(theirs), Object.keys(mine), f)
    for (const k of Object.keys(mine)) assert.deepEqual(Object.keys(theirs[k]).sort(), Object.keys(mine[k]).sort(), `${f} ${k}`)
  }
})

test('a source that throws is reported as unobserved and collectRepo still returns', () => {
  const { repo, home, env } = bare()
  const exec = () => {
    throw new Error('spawn exploded')
  }
  const facts = collectRepo({ repo, limits: LIMITS, env, now: NOW, home, exec, runDrift: true })
  assert.equal(facts.git.branch.unobserved, 'git: spawn exploded')
  assert.equal(facts.remote.pr.unobserved, 'git: spawn exploded')
  assert.equal(facts.openspec.active.unobserved, 'no openspec dir')
})

test('a populated repo: every source contributes and active changes get per-change leaves', () => {
  const userHome = tmp('collect-user-')
  const repoPath = makeRepo(tmp('collect-repo-'), {
    git: true,
    changes: { 'add-login': { tasks: { done: 2, total: 5 } } },
    ship: { 'run.json': { schema: 'interlock.run/1', change: 'add-login', runId: 'r1' } },
  })
  const exec = fakeExec({
    'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-login\n' },
    'git status --porcelain=v2 --branch': { stdout: '# branch.head feat/add-login\n' },
    'git stash list': { stdout: '' },
    'git rev-parse --git-dir': { stdout: '.git\n' },
    'git worktree list --porcelain': { stdout: `worktree ${repoPath}\nHEAD abc\nbranch refs/heads/feat/add-login\n\n` },
    'git log -1 --format=%H%x09%cI': { stdout: '3f50683c1e0000000000000000000000000000aa\t2026-11-10T09:12:00+08:00\n' },
  })
  const facts = collectRepo({
    repo: { name: 'katipon', path: repoPath, vault: 'personal', host: 'github' }, limits: LIMITS, env: { HOME: userHome },
    now: NOW, home: tmp('collect-home-'), exec,
  })
  assert.equal(facts.git.branch.value, 'feat/add-login')
  assert.deepEqual(facts.openspec.changes['add-login'].tasks.value, { done: 2, total: 5 })
  assert.equal(facts.interlock.run.value.runId, 'r1')
  assert.equal(facts.escapement.entries['add-login'].unobserved, '~/.escapement: absent')
  assert.equal(facts.interlock.outcomes['add-login'].value, 'absent')
  assert.equal(facts.remote.pr.unobserved, 'no remote cache, run dial sync --remote')
  // offline: neither forge CLI and no fetch-like git command ran
  for (const c of exec.calls) assert.equal(['gh', 'glab', 'interlock'].includes(c.file), false)
})

test('drift runs only when asked, and remote only when asked', () => {
  const { repo, home, env } = bare()
  const exec = fakeExec({ 'git rev-parse --abbrev-ref HEAD': { code: 128, stderr: 'fatal: not a git repository\n' }, 'interlock drift --json': 'missing' })
  collectRepo({ repo, limits: LIMITS, env, now: NOW, home, exec })
  assert.equal(exec.calls.some(c => c.file === 'interlock'), false)
  const withDrift = collectRepo({ repo, limits: LIMITS, env, now: NOW, home, exec, runDrift: true })
  assert.equal(withDrift.interlock.drift.unobserved, 'interlock: not on PATH')
})
