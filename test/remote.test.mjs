import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { cachePath, readCache, writeCache } from '../lib/cache.mjs'
import { fact, unobserved } from '../lib/facts.mjs'
import { dueRemote, remoteFacts } from '../lib/remote.mjs'
import { FIXTURES, fakeExec, frozenNow, tmp } from './helpers.mjs'

const fx = name => readFileSync(join(FIXTURES, 'remote', name), 'utf8')
const NOW = frozenNow('2026-11-10T08:00:00Z')
const BRANCH = 'feat/add-login'
const git = (branch = BRANCH, detached = false) => ({
  branch: fact(branch, `git rev-parse --abbrev-ref HEAD: ${branch}`),
  detached: fact(detached, 'git rev-parse --abbrev-ref HEAD'),
})
const limits = { subprocessTimeoutSeconds: 10, remoteIntervalMinutes: 30 }
const GH_VIEW = `gh pr view ${BRANCH} --json number,state,url,mergeable,mergeStateStatus,reviewDecision,isDraft,mergedAt,updatedAt,headRefName`
const GH_CHECKS = `gh pr checks ${BRANCH} --json name,bucket,state,link`
const GL_VIEW = `glab mr view ${BRANCH} -F json`
const GL_CI = `glab ci status -b ${BRANCH} -F json`
const run = (table, over = {}) => {
  const home = over.home ?? tmp('remote-home-')
  const exec = fakeExec(table)
  const repo = over.repo ?? { name: 'katipon', path: '/repos/katipon', host: 'github' }
  const out = remoteFacts({ repo, git: git(), home, limits, now: NOW(), remote: true, exec, ...over.opts })
  return { out, exec, home }
}
const open = { [GH_VIEW]: { stdout: fx('gh-pr.json') }, [GH_CHECKS]: { stdout: fx('gh-checks-fail.json') } }

test('without remote neither CLI runs and a missing cache is unobserved', () => {
  const { out, exec } = run({}, { opts: { remote: false } })
  assert.equal(exec.calls.length, 0)
  for (const k of ['pr', 'ci', 'remote']) assert.equal(out[k].unobserved, 'no remote cache, run dial sync --remote')
})

test('github: open PR and a failing check, cache written', () => {
  const { out, exec, home } = run(open)
  assert.deepEqual(exec.calls.map(c => [c.file, c.opts.cwd]), [['gh', '/repos/katipon'], ['gh', '/repos/katipon']])
  assert.deepEqual(out.pr, {
    value: { number: 38, state: 'open', url: 'https://github.com/renzrollon/katipon/pull/38', conflicting: false, mergedAt: null, updatedAt: '2026-11-09T22:10:00Z' },
    evidence: 'gh pr view 38: OPEN',
  })
  assert.deepEqual(out.ci, { value: { value: 'fail', failing: ['lint'] }, evidence: `gh pr checks ${BRANCH}: fail (lint)` })
  assert.equal(out.remote.value, 'ok')
  const cached = readCache(home, 'katipon')
  assert.equal(cached.data.dial_schema, 'dial.cache/1')
  assert.equal(cached.data.fetchedAt, '2026-11-10T08:00:00.000Z')
  assert.equal(cached.data.host, 'github')
  assert.equal(cached.data.branch, BRANCH)
  assert.equal(cached.data.pr.number, 38)
  assert.deepEqual(cached.data.checks, [{ name: 'lint', bucket: 'fail' }, { name: 'unit', bucket: 'pass' }])
})

test('github: conflicting and merged pull requests', () => {
  const conflicting = run({ [GH_VIEW]: { stdout: fx('gh-pr-conflicting.json') }, [GH_CHECKS]: { stdout: '[]' } }).out
  assert.equal(conflicting.pr.value.conflicting, true)
  assert.equal(conflicting.pr.evidence, 'gh pr view 38 mergeable: CONFLICTING')
  const merged = run({ [GH_VIEW]: { stdout: fx('gh-pr-merged.json') }, [GH_CHECKS]: { stdout: '[]' } }).out
  assert.equal(merged.pr.value.state, 'merged')
  assert.equal(merged.pr.value.mergedAt, '2026-11-09T10:00:00Z')
  assert.equal(merged.pr.evidence, 'gh pr view 38: MERGED 2026-11-09T10:00:00Z')
})

test('github: exit 8 with pending checks is still a result', () => {
  const { out, home } = run({ [GH_VIEW]: { stdout: fx('gh-pr.json') }, [GH_CHECKS]: { code: 8, stdout: fx('gh-checks.json') } })
  assert.deepEqual(out.ci, { value: { value: 'pending', failing: [] }, evidence: `gh pr checks ${BRANCH}: pending (e2e)` })
  assert.equal(existsSync(cachePath(home, 'katipon')), true)
})

test('github: all checks passing is pass; an empty array is none, not pass', () => {
  const pass = run({ [GH_VIEW]: { stdout: fx('gh-pr.json') }, [GH_CHECKS]: { stdout: '[{"name":"unit","bucket":"pass"}]' } }).out
  assert.equal(pass.ci.value.value, 'pass')
  const none = run({ [GH_VIEW]: { stdout: fx('gh-pr.json') }, [GH_CHECKS]: { stdout: '[]' } }).out
  assert.deepEqual(none.ci, { value: { value: 'none', failing: [] }, evidence: `gh pr checks ${BRANCH}: no checks` })
  const cancel = run({ [GH_VIEW]: { stdout: fx('gh-pr.json') }, [GH_CHECKS]: { stdout: '[{"name":"a","bucket":"cancel"},{"name":"b","bucket":"pass"}]' } }).out
  assert.equal(cancel.ci.value.value, 'cancel')
})

test('github: no checks reported is ci none and the cache is written', () => {
  const { out, home } = run({ [GH_VIEW]: { stdout: fx('gh-pr.json') }, [GH_CHECKS]: { code: 1, stderr: fx('gh-checks-none.stderr.txt') } })
  assert.equal(out.ci.evidence, `gh pr checks ${BRANCH}: no checks`)
  assert.equal(out.ci.value.value, 'none')
  assert.deepEqual(readCache(home, 'katipon').data.checks, [])
})

test('github: no pull request is observed none, checks not run, cache written', () => {
  const { out, exec, home } = run({ [GH_VIEW]: { code: 1, stderr: fx('gh-pr-none.stderr.txt') } })
  assert.deepEqual(out.pr, { value: 'none', evidence: `gh pr view ${BRANCH}: no pull request` })
  assert.equal(out.ci.value.value, 'none')
  assert.equal(out.ci.unobserved, undefined)
  assert.equal(exec.calls.length, 1)
  assert.equal(readCache(home, 'katipon').data.pr, null)
  const again = run({}, { home, opts: { remote: false } }).out
  assert.equal(again.pr.evidence, `gh pr view ${BRANCH}: no pull request as of 2026-11-10T08:00:00.000Z`)
})

test('github: an auth failure and a rate limit are unobserved with the first stderr line', () => {
  const auth = run({ [GH_VIEW]: { code: 4, stderr: fx('gh-auth.stderr.txt') } }).out
  assert.equal(auth.pr.unobserved, 'gh: To get started with GitHub CLI, please run:  gh auth login')
  assert.equal(auth.ci.unobserved, auth.pr.unobserved)
  assert.equal(auth.remote.unobserved, auth.pr.unobserved)
  const limited = run({ [GH_VIEW]: { code: 1, stderr: 'GraphQL: API rate limit exceeded for user ID 1.\n' } })
  assert.equal(limited.out.pr.unobserved, 'gh: GraphQL: API rate limit exceeded for user ID 1.')
  assert.equal(existsSync(cachePath(limited.home, 'katipon')), false)
})

test('gh missing from PATH and timeouts', () => {
  assert.equal(run({ [GH_VIEW]: 'missing' }).out.pr.unobserved, 'gh: not on PATH')
  const timing = (view, checks) => (file, args) => {
    const key = [file, ...args].join(' ')
    const r = key === GH_VIEW ? view : checks
    return { ok: false, code: null, stdout: '', stderr: '', missing: false, timedOut: false, ...r }
  }
  const home = tmp('remote-home-')
  const t = remoteFacts({ repo: { name: 'katipon', path: '/r', host: 'github' }, git: git(), home, limits: { ...limits, subprocessTimeoutSeconds: 3 }, now: NOW(), remote: true, exec: timing({ timedOut: true }) })
  assert.equal(t.pr.unobserved, 'gh: timed out after 3s')
  // checks time out after the PR read: ci unobserved, no cache
  const c = remoteFacts({
    repo: { name: 'katipon', path: '/r', host: 'github' }, git: git(), home, limits, now: NOW(), remote: true,
    exec: timing({ ok: true, code: 0, stdout: fx('gh-pr.json') }, { timedOut: true }),
  })
  assert.equal(c.ci.unobserved, 'gh: timed out after 10s')
  assert.equal(existsSync(cachePath(home, 'katipon')), false)
})

test('gitlab: open merge request with conflicts and a failed pipeline', () => {
  const repo = { name: 'work-api', path: '/repos/work-api', host: 'gitlab' }
  const { out, exec, home } = run({ [GL_VIEW]: { stdout: fx('glab-mr.json') }, [GL_CI]: { stdout: fx('glab-ci.json') } }, { repo })
  assert.deepEqual(exec.calls.map(c => c.file), ['glab', 'glab'])
  assert.deepEqual(out.pr.value, { number: 12, state: 'open', url: 'https://gitlab.example/team/api/-/merge_requests/12', conflicting: true, mergedAt: null, updatedAt: '2026-11-09T22:10:00.000Z' })
  assert.equal(out.pr.evidence, 'glab mr view 12: opened, has_conflicts')
  assert.deepEqual(out.ci, { value: { value: 'fail', failing: ['pipeline'] }, evidence: `glab ci status -b ${BRANCH}: failed` })
  assert.deepEqual(readCache(home, 'work-api').data.checks, [{ name: 'pipeline', bucket: 'fail' }])
})

test('gitlab: status mapping, running is pending', () => {
  const repo = { name: 'work-api', path: '/r', host: 'gitlab' }
  const status = s => run({ [GL_VIEW]: { stdout: fx('glab-mr.json') }, [GL_CI]: { stdout: JSON.stringify({ status: s }) } }, { repo }).out.ci.value.value
  assert.deepEqual(['failed', 'success', 'canceled', 'skipped', 'running', 'created'].map(status), ['fail', 'pass', 'cancel', 'skipping', 'pending', 'pending'])
  const locked = run({ [GL_VIEW]: { stdout: JSON.stringify({ iid: 3, state: 'locked' }) }, [GL_CI]: { stdout: '{"status":"success"}' } }, { repo }).out
  assert.equal(locked.pr.value.state, 'closed')
})

test('gitlab: no merge request, and no pipeline', () => {
  const repo = { name: 'work-api', path: '/r', host: 'gitlab' }
  const none = run({ [GL_VIEW]: { code: 1, stderr: fx('glab-mr-none.stderr.txt') } }, { repo })
  assert.deepEqual(none.out.pr, { value: 'none', evidence: `glab mr view ${BRANCH}: no pull request` })
  assert.equal(none.exec.calls.length, 1)
  const noPipe = run({ [GL_VIEW]: { stdout: fx('glab-mr.json') }, [GL_CI]: { code: 1, stderr: fx('glab-ci-none.txt') } }, { repo })
  assert.equal(noPipe.out.ci.evidence, `glab ci status -b ${BRANCH}: no pipeline`)
  assert.equal(noPipe.out.ci.value.value, 'none')
  assert.deepEqual(readCache(noPipe.home, 'work-api').data.checks, [])
})

test('the registry host picks the CLI: a gitlab repo never calls gh', () => {
  const { exec } = run({ [GL_VIEW]: { stdout: fx('glab-mr.json') }, [GL_CI]: { stdout: fx('glab-ci.json') } }, { repo: { name: 'w', path: '/r', host: 'gitlab' } })
  assert.equal(exec.calls.every(c => c.file === 'glab'), true)
})

test('detached HEAD is not looked up', () => {
  const { out, exec } = run({}, { opts: { git: git('3f50683', true) } })
  assert.equal(exec.calls.length, 0)
  assert.equal(out.pr.unobserved, 'detached HEAD, no branch to look up')
  assert.equal(out.ci.unobserved, 'detached HEAD, no branch to look up')
})

test('an unobserved branch carries its reason; a host with no CLI is unobserved', () => {
  const g = { branch: unobserved('git: not a work tree'), detached: unobserved('git: not a work tree') }
  assert.equal(run({}, { opts: { git: g } }).out.pr.unobserved, 'git: not a work tree')
  assert.match(run({}, { repo: { name: 'x', path: '/r', host: 'bitbucket' } }).out.pr.unobserved, /no remote CLI/)
})

function seeded(over = {}) {
  const home = tmp('remote-home-')
  writeCache(home, 'katipon', {
    fetchedAt: '2026-11-10T08:00:00.000Z', host: 'github', branch: BRANCH,
    pr: { number: 38, state: 'open', url: 'https://github.com/renzrollon/katipon/pull/38', conflicting: false, mergedAt: null, updatedAt: '2026-11-09T22:10:00Z' },
    checks: [{ name: 'unit', bucket: 'pass' }], ...over,
  })
  return home
}

test('cache read: evidence ends as of fetchedAt, and next and brief paths write nothing', () => {
  const home = seeded()
  const before = readFileSync(cachePath(home, 'katipon'), 'utf8')
  const { out, exec } = run({}, { home, opts: { remote: false } })
  assert.equal(exec.calls.length, 0)
  assert.equal(out.pr.evidence, 'gh pr view 38: OPEN as of 2026-11-10T08:00:00.000Z')
  assert.equal(out.ci.evidence, `gh pr checks ${BRANCH}: pass as of 2026-11-10T08:00:00.000Z`)
  assert.equal(out.remote.value, 'ok')
  assert.equal(readFileSync(cachePath(home, 'katipon'), 'utf8'), before)
})

test('cache for another branch, another schema and malformed content are unobserved', () => {
  const home = seeded()
  const other = remoteFacts({ repo: { name: 'katipon', path: '/r', host: 'github' }, git: git('main'), home, limits, now: NOW(), exec: fakeExec({}) })
  assert.equal(other.pr.unobserved, `remote cache is for github branch ${BRANCH}`)
  const h2 = seeded()
  writeFileSync(cachePath(h2, 'katipon'), JSON.stringify({ dial_schema: 'dial.cache/9' }))
  assert.equal(run({}, { home: h2, opts: { remote: false } }).out.pr.unobserved, 'cache/remote/katipon.json schema dial.cache/9 not understood')
  const h3 = seeded({ checks: 'nope' })
  assert.equal(run({}, { home: h3, opts: { remote: false } }).out.pr.unobserved, 'cache/remote/katipon.json malformed')
})

test('a failed fetch keeps the cache byte for byte and serves the last-seen state', () => {
  const home = seeded()
  const before = readFileSync(cachePath(home, 'katipon'), 'utf8')
  const { out } = run({ [GH_VIEW]: { code: 1, stderr: 'error connecting to api.github.com\n' } }, { home })
  assert.equal(readFileSync(cachePath(home, 'katipon'), 'utf8'), before)
  assert.equal(out.pr.value.number, 38)
  assert.equal(out.pr.evidence, 'gh pr view 38: OPEN as of 2026-11-10T08:00:00.000Z')
  assert.equal(out.remote.unobserved, 'gh: error connecting to api.github.com')
})

test('checks failing after the PR read keep the previous cache', () => {
  const home = seeded()
  const before = readFileSync(cachePath(home, 'katipon'), 'utf8')
  const { out } = run({ [GH_VIEW]: { stdout: fx('gh-pr.json') }, [GH_CHECKS]: { code: 1, stderr: 'HTTP 502\n' } }, { home })
  assert.equal(readFileSync(cachePath(home, 'katipon'), 'utf8'), before)
  assert.equal(out.ci.evidence.endsWith('as of 2026-11-10T08:00:00.000Z'), true)
  assert.equal(out.remote.unobserved, 'gh: HTTP 502')
})

test('a failed fetch beside a cache for another branch is unobserved with the failure', () => {
  const home = seeded({ branch: 'other' })
  const { out } = run({ [GH_VIEW]: { code: 1, stderr: 'boom\n' } }, { home })
  assert.equal(out.pr.unobserved, 'gh: boom')
})

test('a dry run fetches but writes no cache', () => {
  const { out, home } = run(open, { opts: { writeCache: false } })
  assert.equal(out.pr.value.number, 38)
  assert.equal(existsSync(cachePath(home, 'katipon')), false)
})

test('dueRemote compares fetchedAt with remoteIntervalMinutes', () => {
  const now = new Date('2026-11-10T09:00:00Z')
  const lim = { remoteIntervalMinutes: 30 }
  assert.equal(dueRemote({ home: tmp('remote-home-'), repo: 'katipon', limits: lim, now }), true)
  assert.equal(dueRemote({ home: seeded({ fetchedAt: '2026-11-10T08:50:00.000Z' }), repo: 'katipon', limits: lim, now }), false)
  assert.equal(dueRemote({ home: seeded({ fetchedAt: '2026-11-10T08:15:00.000Z' }), repo: 'katipon', limits: lim, now }), true)
  const bad = seeded()
  writeFileSync(cachePath(bad, 'katipon'), 'garbage')
  assert.equal(dueRemote({ home: bad, repo: 'katipon', limits: lim, now }), true)
})
