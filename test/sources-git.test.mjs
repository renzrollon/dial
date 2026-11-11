import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { collectGit } from '../lib/sources/git.mjs'
import { exec as realExec } from '../lib/subprocess.mjs'
import { FIXTURES, fakeExec, makeGitDir, tmp } from './helpers.mjs'

const fx = name => readFileSync(join(FIXTURES, 'git', name), 'utf8')
const gitOnPath = spawnSync('git', ['--version']).status === 0

/** A canned table for a repo whose git dir is `gitDir` (a real temp dir, so in-progress files can exist). */
function table(over = {}, gitDir = '.git') {
  return {
    'git rev-parse --abbrev-ref HEAD': { stdout: 'feat/add-login\n' },
    'git status --porcelain=v2 --branch': { stdout: fx('status-dirty-ab.txt') },
    'git stash list': { stdout: 'stash@{0}: WIP on a\nstash@{1}: WIP on b\n' },
    'git rev-parse --git-dir': { stdout: `${gitDir}\n` },
    'git worktree list --porcelain': { stdout: fx('worktree-list.txt') },
    'git log -1 --format=%H%x09%cI': { stdout: fx('log-last.txt') },
    ...over,
  }
}
const repo = () => makeGitDir(tmp('git-src-'))

test('branch, dirty, ahead/behind and stash carry their evidence', () => {
  const root = repo()
  const g = collectGit({ repoPath: root, exec: fakeExec(table()) })
  assert.deepEqual(g.branch, { value: 'feat/add-login', evidence: 'git rev-parse --abbrev-ref HEAD: feat/add-login' })
  assert.equal(g.detached.value, false)
  assert.deepEqual(g.dirty, { value: 2, evidence: 'git status --porcelain=v2 --branch: 2 entries' })
  assert.deepEqual(g.ahead, { value: 1, evidence: 'git status --porcelain=v2 --branch: branch.ab +1 -3' })
  assert.equal(g.behind.value, 3)
  assert.deepEqual(g.stash, { value: 2, evidence: 'git stash list: 2' })
})

test('detached HEAD reads the short sha', () => {
  const exec = fakeExec(table({
    'git rev-parse --abbrev-ref HEAD': { stdout: 'HEAD\n' },
    'git rev-parse --short HEAD': { stdout: '3f50683\n' },
  }))
  const g = collectGit({ repoPath: repo(), exec })
  assert.equal(g.detached.value, true)
  assert.deepEqual(g.branch, { value: '3f50683', evidence: 'git rev-parse --short HEAD: 3f50683 (detached)' })
})

test('no upstream leaves ahead and behind unobserved, never 0', () => {
  const g = collectGit({ repoPath: repo(), exec: fakeExec(table({ 'git status --porcelain=v2 --branch': { stdout: fx('status-no-upstream.txt') } })) })
  assert.equal(g.ahead.unobserved, 'git: no upstream for feat/add-login')
  assert.equal(g.behind.unobserved, 'git: no upstream for feat/add-login')
  assert.equal(g.ahead.value, null)
  assert.equal(g.dirty.value, 1)
})

test('unmerged entries come from u lines', () => {
  const g = collectGit({ repoPath: repo(), exec: fakeExec(table({ 'git status --porcelain=v2 --branch': { stdout: fx('status-unmerged.txt') } })) })
  assert.deepEqual(g.unmerged, { value: ['lib/auth.mjs'], evidence: 'git status --porcelain=v2 --branch: unmerged lib/auth.mjs' })
  assert.equal(g.dirty.value, 1)
  const clean = collectGit({ repoPath: repo(), exec: fakeExec(table()) })
  assert.deepEqual(clean.unmerged.value, [])
})

test('linked worktrees exclude the main checkout', () => {
  const g = collectGit({ repoPath: repo(), exec: fakeExec(table()) })
  assert.deepEqual(g.worktrees.value, [{ path: '/Users/caro/IdeaProjects/katipon/.claude/worktrees/fix-a', branch: 'fix-a' }])
  assert.equal(g.worktrees.evidence, 'git worktree list --porcelain: 1 linked (fix-a)')
})

test('last commit keeps the full sha and the committer date', () => {
  const g = collectGit({ repoPath: repo(), exec: fakeExec(table()) })
  assert.equal(g.lastCommit.value.sha7, '3f50683')
  assert.equal(g.lastCommit.value.head, '3f50683c1e0000000000000000000000000000aa')
  assert.equal(g.lastCommit.value.date, '2026-11-10T09:12:00+08:00')
  assert.equal(g.lastCommit.evidence, 'git log -1: 3f50683 2026-11-10T09:12:00+08:00')
})

test('in-progress: rebase, merge, none', () => {
  const root = repo()
  const exec = () => fakeExec(table())
  assert.deepEqual(collectGit({ repoPath: root, exec: exec() }).inProgress.value, 'none')
  mkdirSync(join(root, '.git', 'rebase-merge'))
  const r = collectGit({ repoPath: root, exec: exec() }).inProgress
  assert.deepEqual(r, { value: 'rebase', evidence: '.git/rebase-merge: present' })
  const root2 = repo()
  writeFileSync(join(root2, '.git', 'MERGE_HEAD'), 'abc\n')
  assert.deepEqual(collectGit({ repoPath: root2, exec: exec() }).inProgress, { value: 'merge', evidence: '.git/MERGE_HEAD: present' })
  const root3 = repo()
  mkdirSync(join(root3, '.git', 'rebase-apply'))
  writeFileSync(join(root3, '.git', 'MERGE_HEAD'), 'abc\n')
  assert.equal(collectGit({ repoPath: root3, exec: exec() }).inProgress.value, 'rebase')
})

test('git missing from PATH makes every fact unobserved', () => {
  const g = collectGit({ repoPath: repo(), exec: fakeExec({ 'git rev-parse --abbrev-ref HEAD': 'missing' }) })
  for (const leaf of Object.values(g)) assert.equal(leaf.unobserved, 'git: not on PATH')
  assert.equal(Object.keys(g).length, 10)
})

test('not a work tree makes every fact unobserved and stops after one call', () => {
  const exec = fakeExec({ 'git rev-parse --abbrev-ref HEAD': { code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' } })
  const g = collectGit({ repoPath: repo(), exec })
  for (const leaf of Object.values(g)) assert.equal(leaf.unobserved, 'git: not a work tree')
  assert.equal(exec.calls.length, 1)
})

test('a failing command reports its first stderr line and spares the others', () => {
  const g = collectGit({
    repoPath: repo(),
    exec: fakeExec(table({ 'git stash list': { code: 128, stderr: 'fatal: bad object refs/stash\nmore\n' } })),
  })
  assert.equal(g.stash.unobserved, 'git: fatal: bad object refs/stash')
  assert.equal(g.dirty.value, 2)
})

test('a timeout names the cap in seconds', () => {
  // fakeExec drops timedOut, so wrap it to keep the flag
  const exec = (file, args, opts) => {
    const key = [file, ...args].join(' ')
    if (key === 'git status --porcelain=v2 --branch') return { ok: false, code: null, stdout: '', stderr: '', missing: false, timedOut: true }
    return fakeExec(table())(file, args, opts)
  }
  const t = collectGit({ repoPath: repo(), timeoutMs: 2000, exec })
  assert.equal(t.dirty.unobserved, 'git: timed out after 2s')
  assert.equal(t.ahead.unobserved, 'git: timed out after 2s')
  assert.equal(t.branch.value, 'feat/add-login')
})

test('only read-only git commands run, each in the repository with the cap', () => {
  const root = repo()
  const exec = fakeExec(table())
  collectGit({ repoPath: root, exec, timeoutMs: 3000 })
  for (const c of exec.calls) {
    assert.equal(c.file, 'git')
    assert.equal(c.opts.cwd, root)
    assert.equal(c.opts.timeoutMs, 3000)
    assert.equal(['fetch', 'pull', 'push', 'ls-remote'].includes(c.args[0]), false)
  }
})

test('real git: a fresh repository, a commit and a dirty file', { skip: !gitOnPath }, () => {
  const root = tmp('git-real-')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  const git = (...a) => assert.equal(spawnSync('git', a, { cwd: root, env, encoding: 'utf8' }).status, 0, a.join(' '))
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'a.txt'), 'a\n')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'one')
  writeFileSync(join(root, 'b.txt'), 'b\n')
  const g = collectGit({ repoPath: root, exec: (f, a, o) => realExec(f, a, { ...o, env }) })
  assert.equal(g.branch.value, 'main')
  assert.equal(g.detached.value, false)
  assert.equal(g.dirty.value, 1)
  assert.equal(g.stash.value, 0)
  assert.equal(g.inProgress.value, 'none')
  assert.deepEqual(g.worktrees.value, [])
  assert.equal(g.lastCommit.value.sha7.length, 7)
  assert.equal(g.ahead.unobserved, 'git: no upstream for main')
  const notTree = collectGit({ repoPath: tmp('git-none-'), exec: (f, a, o) => realExec(f, a, { ...o, env: { ...env, GIT_CEILING_DIRECTORIES: '/' } }) })
  assert.equal(notTree.branch.unobserved, 'git: not a work tree')
})
