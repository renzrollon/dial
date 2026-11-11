import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { collectInterlock, pidAlive } from '../lib/sources/interlock.mjs'
import { FIXTURES, fakeExec, makeRepo, tmp } from './helpers.mjs'

const fx = name => readFileSync(join(FIXTURES, 'interlock', name), 'utf8')
const never = () => assert.fail('exec must not run')

/** A repo with the named Interlock fixtures laid out where Interlock writes them. */
function repo(layout, extra = {}) {
  const spec = { ship: {}, files: {}, ...extra }
  for (const [path, name] of Object.entries(layout)) {
    const text = fx(name)
    if (path.startsWith('.claude/ship/')) spec.ship[path.slice('.claude/ship/'.length)] = text
    else spec.files[path] = text
  }
  return makeRepo(tmp('il-'), spec)
}
const collect = (root, over = {}) => collectInterlock({ repoPath: root, exec: never, changes: ['add-login'], isAlive: () => false, ...over })

test('run.json is read and gated on its schema', () => {
  const f = collect(repo({ '.claude/ship/run.json': 'run.json' })).run
  assert.deepEqual(f.value, { runId: '7a587a81', change: 'add-login', ended: null, halted: null, closedAt: null, stateHome: null })
  assert.equal(f.evidence, '.claude/ship/run.json: run 7a587a81')
  const halted = collect(repo({ '.claude/ship/run.json': 'run-halted-statehome.json' }, {})).run
  assert.equal(halted.value.halted, 'verify red')
  assert.equal(halted.value.ended, 'run-halt')
})

test('an unknown run schema leaves run facts unobserved and the other files are still read', () => {
  const root = repo({ '.claude/ship/run.json': 'run-schema-2.json', '.claude/ship/merge-confidence.json': 'merge-confidence.json' })
  const f = collect(root)
  const reason = '.claude/ship/run.json schema interlock.run/2 not understood'
  assert.equal(f.run.unobserved, reason)
  assert.equal(f.terminal.unobserved, reason)
  assert.equal(f.merge.value.verdict, 'HUMAN')
})

test('no run.json is an observed absence', () => {
  const f = collect(makeRepo(tmp('il-'), {}))
  assert.deepEqual(f.run, { value: 'absent', evidence: '.claude/ship/run.json: absent' })
  assert.equal(f.terminal.value, 'none')
  assert.equal(f.merge.value, 'absent')
  assert.equal(f.settle.value, 'absent')
  assert.deepEqual(f.interrupted.value, [])
  assert.equal(f.waves.value, 'absent')
  assert.equal(f.outcomes['add-login'].value, 'absent')
})

test('stage liveness goes through the injected isAlive', () => {
  const stage = { 'add-login/stage.json': { stage: 'implement', change: 'add-login', index: 5, pid: 4242 } }
  const root = makeRepo(tmp('il-'), { ship: stage })
  const seen = []
  const alive = collect(root, { isAlive: pid => (seen.push(pid), true) }).stages['add-login']
  assert.deepEqual(alive, { value: { pid: 4242, alive: true }, evidence: '.claude/ship/add-login/stage.json pid 4242: alive' })
  assert.deepEqual(seen, [4242])
  const dead = collect(root).stages['add-login']
  assert.equal(dead.value.alive, false)
  assert.equal(dead.evidence, '.claude/ship/add-login/stage.json pid 4242: dead')
  assert.equal(collect(makeRepo(tmp('il-'), {})).stages['add-login'].value, 'absent')
})

test('pidAlive: this process is alive, an unused pid is not', () => {
  assert.equal(pidAlive(process.pid), true)
  assert.equal(pidAlive(2 ** 22 + 12345), false)
})

test('waves are the cursor of the plan', () => {
  const f = collect(repo({ '.claude/ship/state.json': 'state.json', '.claude/ship/plan.json': 'plan.json' })).waves
  assert.deepEqual(f.value, { done: 2, total: 4 })
  assert.equal(f.evidence, '.claude/ship/state.json cursor.waveIndex 2 of 4')
})

test('a halted trajectory: terminal run-halt, other schemas and unknown types skipped', () => {
  const f = collect(repo({ '.claude/ship/run.json': 'run.json', '.claude/ship/runs/7a587a81.jsonl': 'trajectory-halt.jsonl' }))
  assert.deepEqual(f.terminal.value, { type: 'run-halt', reason: 'verify red', ts: '2026-11-09T16:22:00Z' })
  assert.equal(f.terminal.evidence, '.claude/ship/runs/7a587a81.jsonl run-halt 2026-11-09T16:22:00Z')
  assert.equal(f.trajectoryTs['add-login'].value, '2026-11-09T16:22:05Z')
})

test('a completed trajectory ends in run-complete even when the last type is unknown', () => {
  const f = collect(repo({ '.claude/ship/run.json': 'run.json', '.claude/ship/runs/7a587a81.jsonl': 'trajectory-complete.jsonl' }))
  assert.equal(f.terminal.value.type, 'run-complete')
  assert.equal(f.terminal.value.reason, null)
})

test('an open run has no terminal line; a missing trajectory is none', () => {
  const open = collect(repo({ '.claude/ship/run.json': 'run.json', '.claude/ship/runs/7a587a81.jsonl': 'trajectory-open.jsonl' }))
  assert.deepEqual(open.terminal, { value: 'none', evidence: '.claude/ship/runs/7a587a81.jsonl: no terminal line' })
  const missing = collect(repo({ '.claude/ship/run.json': 'run.json' }))
  assert.equal(missing.terminal.value, 'none')
  assert.equal(missing.terminal.evidence, '.claude/ship/runs/7a587a81.jsonl: absent')
})

test('an open run with a dead stage pid reads as dead beside the open run', () => {
  const root = repo(
    { '.claude/ship/run.json': 'run.json', '.claude/ship/runs/7a587a81.jsonl': 'trajectory-open.jsonl' },
    { ship: { 'add-login/stage.json': { pid: 999999 } } }
  )
  const f = collect(root)
  assert.equal(f.run.value.closedAt, null)
  assert.equal(f.stages['add-login'].value.alive, false)
  assert.equal(f.terminal.value, 'none')
})

test('interrupted notes are listed with run, change and time', () => {
  const f = collect(repo({ '.claude/ship/interrupted/7a587a81.json': 'interrupted-7a587a81.json' })).interrupted
  assert.deepEqual(f.value, [
    { runId: '7a587a81', change: 'add-login', at: '2026-11-09T16:30:00.000Z', file: '.claude/ship/interrupted/7a587a81.json', spokenAt: '2026-11-09T17:00:00.000Z' },
  ])
  assert.equal(f.evidence, '.claude/ship/interrupted/7a587a81.json: add-login')
})

test('merge verdict, and an invalid file is unobserved', () => {
  const f = collect(repo({ '.claude/ship/merge-confidence.json': 'merge-confidence.json' })).merge
  assert.deepEqual(f, { value: { change: 'add-login', verdict: 'HUMAN' }, evidence: '.claude/ship/merge-confidence.json result.verdict: HUMAN' })
  const broken = makeRepo(tmp('il-'), { ship: { 'merge-confidence.json': '{not json' } })
  assert.equal(collect(broken).merge.unobserved, '.claude/ship/merge-confidence.json not valid JSON')
})

test('outcomes: the last line per change, null commit observed, bad lines skipped', () => {
  const f = collect(repo({ '.claude/learning/outcomes.jsonl': 'outcomes.jsonl' }), { changes: ['add-login', 'fix-cache', 'other'] }).outcomes
  assert.deepEqual(f['add-login'], {
    value: { commit: '3f50683', mergeVerdict: 'MERGE', ts: '2026-11-10T08:00:00Z' },
    evidence: '.claude/learning/outcomes.jsonl: add-login commit 3f50683 verdict MERGE',
  })
  assert.equal(f['fix-cache'].value.commit, null)
  assert.equal(f['other'].value, 'absent')
})

test('settle takes the highest round numerically', () => {
  const f = collect(repo({ '.claude/ship/settle/review-r2.json': 'settle-r2.json', '.claude/ship/settle/review-r10.json': 'settle-r10.json' })).settle
  assert.deepEqual(f.value, { surviving: 2, head: '3f50683c1e0000000000000000000000000000aa', file: '.claude/ship/settle/review-r10.json' })
  assert.equal(f.evidence, '.claude/ship/settle/review-r10.json: 2 surviving')
})

test('review-artifacts: newest file, blocker count', () => {
  const root = repo({
    '.claude/metrics/review-artifacts-add-login-20261110-091200.json': 'review-artifacts-add-login-20261110-091200.json',
    '.claude/metrics/review-artifacts-add-login-20261108-080000.json': 'review-artifacts-add-login-20261108-080000.json',
  })
  const f = collect(root).reviewArtifacts['add-login']
  assert.equal(f.value.blockers, 1)
  assert.equal(f.evidence, '.claude/metrics/review-artifacts-add-login-20261110-091200.json: 1 blocker')
  assert.equal(collect(makeRepo(tmp('il-'), {})).reviewArtifacts['add-login'].value, 'absent')
})

test('resume card exists only for the run run.json names', () => {
  const root = repo({ '.claude/ship/run.json': 'run.json', '.claude/handoff/ship-add-login-7a587a81.md': 'ship-add-login-7a587a81.md' })
  const f = collect(root, { changes: ['add-login', 'fix-cache'] }).resumeCards
  assert.deepEqual(f['add-login'], { value: '.claude/handoff/ship-add-login-7a587a81.md', evidence: '.claude/handoff/ship-add-login-7a587a81.md: present' })
  assert.equal(f['fix-cache'].value, 'absent')
})

test('stateHome redirects the corpora and their evidence is ~-collapsed', () => {
  const userHome = tmp('il-user-')
  const main = join(userHome, 'IdeaProjects', 'katipon')
  makeRepo(main, {
    files: {
      '.claude/ship/runs/7a587a81.jsonl': fx('trajectory-halt.jsonl'),
      '.claude/learning/outcomes.jsonl': fx('outcomes.jsonl'),
      '.claude/handoff/ship-add-login-7a587a81.md': fx('ship-add-login-7a587a81.md'),
      '.claude/metrics/review-artifacts-add-login-20261110-091200.json': fx('review-artifacts-add-login-20261110-091200.json'),
    },
  })
  const wt = makeRepo(join(userHome, 'IdeaProjects', 'katipon', '.claude', 'worktrees', 'fix-a'), {
    ship: { 'run.json': fx('run-halted-statehome.json').replace('__STATEHOME__', main) },
  })
  const f = collect(wt, { env: { HOME: userHome } })
  assert.equal(f.terminal.evidence, '~/IdeaProjects/katipon/.claude/ship/runs/7a587a81.jsonl run-halt 2026-11-09T16:22:00Z')
  assert.equal(f.outcomes['add-login'].evidence.startsWith('~/IdeaProjects/katipon/.claude/learning/outcomes.jsonl'), true)
  assert.equal(f.resumeCards['add-login'].value, '~/IdeaProjects/katipon/.claude/handoff/ship-add-login-7a587a81.md')
  assert.equal(f.reviewArtifacts['add-login'].evidence.startsWith('~/IdeaProjects/katipon/.claude/metrics/'), true)
})

test('drift is not run unless asked, and then runs interlock drift --json in the repository', () => {
  const root = makeRepo(tmp('il-'), {})
  assert.equal(collectInterlock({ repoPath: root, exec: never }).drift.unobserved, 'interlock drift: not run (sync only)')
  const exec = fakeExec({ 'interlock drift --json': { stdout: fx('drift.json') } })
  const d = collectInterlock({ repoPath: root, exec, runDrift: true, timeoutMs: 4000 }).drift
  assert.equal(exec.calls.length, 1)
  assert.equal(exec.calls[0].opts.cwd, root)
  assert.deepEqual(d.value.unarchived, ['add-login'])
  assert.equal(d.value.broken.value, 0)
  assert.equal(d.value.aging.value, 0)
  assert.equal(d.evidence, 'interlock drift --json: 1 unarchived, 0 broken, 0 aging')
})

test('drift counts the lengths of broken and aging and never reads orphans', () => {
  const reply = {
    root: '.',
    unarchived: [{ change: 'add-login', tasks: 9, path: 'openspec/changes/add-login' }],
    stale: { skipped: false, reason: null, broken: [{ spec: 's', file: 'f' }], aging: [{ spec: 'a' }, { spec: 'b' }] },
    orphans: { skipped: false, reason: null, orphans: [{ file: 'x' }], considered: 9 },
  }
  const d = collectInterlock({ repoPath: tmp('il-'), exec: fakeExec({ 'interlock drift --json': { stdout: JSON.stringify(reply) } }), runDrift: true }).drift
  assert.equal(d.value.broken.value, 1)
  assert.equal(d.value.aging.value, 2)
  assert.equal(d.evidence, 'interlock drift --json: 1 unarchived, 1 broken, 2 aging')
  assert.equal('orphans' in d.value, false)
})

test('drift without a graph: unarchived observed, broken and aging unobserved with the reason', () => {
  const exec = fakeExec({ 'interlock drift --json': { stdout: fx('drift-no-graph.json') } })
  const d = collectInterlock({ repoPath: tmp('il-'), exec, runDrift: true }).drift
  const reason = 'interlock drift: no graph has been built — run /interlock:bootstrap once'
  assert.deepEqual(d.value.unarchived, [])
  assert.equal(d.value.broken.unobserved, reason)
  assert.equal(d.value.aging.unobserved, reason)
  assert.equal(d.value.broken.value, null)
})

test('drift: interlock missing, failing, timing out and unparseable', () => {
  const run = reply => collectInterlock({ repoPath: tmp('il-'), exec: fakeExec({ 'interlock drift --json': reply }), runDrift: true, timeoutMs: 2000 }).drift
  assert.equal(run('missing').unobserved, 'interlock: not on PATH')
  assert.equal(run({ code: 2, stderr: 'boom\nmore\n' }).unobserved, 'interlock: boom')
  assert.equal(run({ stdout: 'not json' }).unobserved, 'interlock drift: output not valid JSON')
  const timedOut = collectInterlock({
    repoPath: tmp('il-'),
    exec: () => ({ ok: false, code: null, stdout: '', stderr: '', missing: false, timedOut: true }),
    runDrift: true,
    timeoutMs: 2000,
  }).drift
  assert.equal(timedOut.unobserved, 'interlock: timed out after 2s')
})
