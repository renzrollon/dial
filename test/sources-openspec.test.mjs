import assert from 'node:assert/strict'
import { utimesSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { collectOpenspec } from '../lib/sources/openspec.mjs'
import { makeRepo, tmp } from './helpers.mjs'

const repo = spec => makeRepo(tmp('os-'), spec)
const change = (spec, name = 'add-login') => collectOpenspec({ repoPath: repo(spec) }).changes[name]

test('no openspec directory: every fact is unobserved, no throw', () => {
  const r = collectOpenspec({ repoPath: repo({ git: true }) })
  assert.equal(r.active.unobserved, 'no openspec dir')
  assert.equal(r.archived.unobserved, 'no openspec dir')
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
