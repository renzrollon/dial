// design.md §Metadata only (D57, D63, D84): secret-shaped strings planted in facts, evidence, narrative and daily
// lines never reach a written file. Renders a fixture vault through the real renderers and `applyWrites`, then
// greps every file the vault holds. The prefixes are matched at a word start only, so `risk-model` passes.
process.env.TZ = 'UTC'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { appendDaily, applyWrites } from '../lib/vault.mjs'
import {
  renderChangeNote, renderDailyLine, renderRepoNote, renderSummary,
} from '../lib/render.mjs'
import { readFrontmatter } from '../lib/frontmatter.mjs'
import { makeGitDir, makeVault, tmp } from './helpers.mjs'

const F = (value, evidence = 'test') => ({ value, evidence })

const PLANTED = [
  'ghp_abc123SECRETtoken9',
  'glpat-xyzSECRET99',
  'sk-live-SECRET12345',
  'AKIAIOSFODNN7EXAMPLE',
  'Bearer eyJhbGciOiJIUzI1NiJ9',
  'password=hunter2',
  'db_token=t0k3nSECRET',
  'export API_KEY=SECRETVALUE',
  '-----BEGIN PRIVATE KEY-----',
  'diff --git a/secret.txt b/secret.txt',
]

/** The patterns no written file may contain (word-start prefixes, the marker lines, the assignments). */
const FORBIDDEN = [
  /-----BEGIN/,
  /diff --git/,
  /Bearer /,
  /password=/,
  /token=/,
  /export [A-Z_]+=/,
  /(^|[^A-Za-z0-9_-])(ghp_|glpat-|sk-|AKIA)/m,
]

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => join(e.parentPath ?? e.path, e.name))
}

function build() {
  const base = tmp('secrets-')
  const vault = makeVault(join(base, 'vault'))
  const repo = makeGitDir(join(base, 'repos', 'risk-model'))
  const registry = {
    dial_schema: 'dial.registry/1',
    vaults: { personal: vault },
    repos: [{ path: repo, vault: 'personal', host: 'github' }],
    limits: {},
  }
  return { vault, registry }
}

const rows = PLANTED.map((p, i) => ({ fact: `row ${i}`, value: `value ${p}`, evidence: `evidence ${p}` }))

function item(over = {}) {
  return {
    change: 'risk-model',
    state: 'pr-open',
    needsMe: true,
    stale: false,
    idleDays: 1,
    suggested: 'review and merge',
    lastActivity: '2026-11-09T18:30:00.000Z',
    evidence: `gh pr view 38: ${PLANTED[0]}`,
    rows,
    branch: F(`feat/risk-model/${PLANTED[0]}`),
    pr: F(38),
    prState: F('open'),
    ci: F(`fail ${PLANTED[5]}`),
    mergeVerdict: F(PLANTED[4]),
    tasksDone: F(2),
    tasksTotal: F(5),
    lastCommit: F(`fix ${PLANTED[2]} ${PLANTED[9]}`),
    lastSession: F('2026-11-09T17:00:00.000Z'),
    ...over,
  }
}

test('planted secrets in facts, evidence, narrative and daily lines never reach a written file', () => {
  const { vault, registry } = build()
  const view = {
    state: 'pr-open', needsMe: true, stale: false, lastActivity: '2026-11-09T18:30:00.000Z', evidence: PLANTED[1], rows,
    items: [{ change: 'risk-model', state: 'pr-open', needsMe: true, lastActivity: '2026-11-09T18:30:00.000Z' }],
  }
  const facts = {
    git: {
      branch: F(`${PLANTED[0]}-branch`), dirty: F(0), stash: F(0), ahead: F(0), behind: F(0),
      worktrees: F([{ path: '/r', branch: PLANTED[6] }]), lastCommit: F({ sha7: '3f50683', head: PLANTED[2], date: '2026-11-09T18:00:00Z' }),
    },
    sessions: { lastSession: F({ file: PLANTED[8], mtime: '2026-11-09T17:00:00Z' }) },
    interlock: { drift: F({ unarchived: [], broken: F(0), aging: F(0) }) },
  }
  const recentNarrative = PLANTED.map((p, i) => ({ change: 'risk-model', at: `2026-11-0${i % 9 + 1}T09:00:00Z`, source: PLANTED[7], body: `entry ${p}\nmore\n` }))
  const ctx = { repo: 'risk-model', scope: 'personal', today: '2026-11-10' }
  const changeText = renderChangeNote(item(), null, ctx)
  const repoText = renderRepoNote(view, null, { ...ctx, facts, recentNarrative })
  const summaryText = renderSummary(
    [{ name: 'risk-model--risk-model', frontmatter: { ...readFrontmatter(changeText), state: PLANTED[1] } }],
    { registered: ['risk-model'], nextRows: 50 },
  )
  const result = applyWrites(vault, [
    { path: 'Changes/risk-model--risk-model.md', content: changeText },
    { path: 'Projects/risk-model.md', content: repoText },
    { path: 'Dial Summary.md', content: summaryText },
  ], { registry, repo: 'risk-model' })
  assert.equal(result.ok, true)
  const lines = PLANTED.map(detail => renderDailyLine({
    kind: 'transition', repo: 'risk-model', change: 'risk-model', from: 'queued', to: 'pr-open', detail, at: '2026-11-10T09:00:00Z',
  }))
  lines.push(renderDailyLine({ kind: 'handoff', repo: 'risk-model', change: 'risk-model', source: PLANTED[7], at: '2026-11-10T09:05:00Z' }))
  assert.equal(appendDaily(vault, lines, { registry, repo: 'risk-model', now: new Date('2026-11-10T09:00:00Z') }).ok, true)

  const files = filesUnder(vault)
  assert.ok(files.length >= 4)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern, `${file} matches ${pattern}`)
  }
})

test('a name containing risk-model survives: the prefixes are matched at a word start only', () => {
  const { vault, registry } = build()
  const ctx = { repo: 'risk-model', scope: 'personal', today: '2026-11-10' }
  const text = renderChangeNote(item({
    branch: F('feat/risk-model'), ci: F('pass'), mergeVerdict: F('none'), lastCommit: F('desk-ghp_x ask-sk-1'), evidence: 'risk-model: ok', rows: [],
  }), null, ctx)
  applyWrites(vault, [{ path: 'Changes/risk-model--risk-model.md', content: text }], { registry, repo: 'risk-model' })
  const out = readFileSync(join(vault, 'Changes/risk-model--risk-model.md'), 'utf8')
  assert.match(out, /^change: risk-model$/m)
  assert.match(out, /^branch: feat\/risk-model$/m)
  assert.match(out, /desk-ghp_x ask-sk-1/)
  assert.doesNotMatch(out, /\[redacted\]/)
})

test('the planted strings are replaced, not dropped: the notes carry [redacted] where they were', () => {
  const ctx = { repo: 'risk-model', scope: 'personal', today: '2026-11-10' }
  const text = renderChangeNote(item(), null, ctx)
  assert.match(text, /\[redacted\]/)
  assert.equal(readFrontmatter(text).repo, 'risk-model')
})
