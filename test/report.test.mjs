// lib/report.mjs against specs/report: the indicators with denominators on a fixture vault and sync.jsonl,
// the read-only guarantee, and the weekly review note (drift totals, stale checkboxes, idempotent per day).
process.env.TZ = 'UTC'

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatReport, report, reviewWeek } from '../lib/report.mjs'
import { makeVault, snapshotTree, tmp } from './helpers.mjs'

const NOW = new Date('2026-11-10T09:00:00Z')
const dayOffset = n => new Date(NOW.getTime() - n * 86_400_000).toISOString()

const change = (repo, change, fm = {}, body = '') => ({
  path: `Changes/${repo}--${change}.md`,
  frontmatter: { title: `${repo} — ${change}`, type: 'change', repo, change, state: 'spec-draft', stale: false, last_activity: dayOffset(1), dial_schema: 'dial.change/1', ...fm },
  body,
})
const repoNote = (repo, drift, fm = {}) => ({
  path: `Projects/${repo}.md`,
  frontmatter: { title: repo, type: 'repo', repo, dial_schema: 'dial.repo/1', ...fm },
  body: `## Drift\n\n${drift}\n\n`,
})
const narrative = (source, at = '2026-11-09 10:00') => `## Narrative\n\n### ${at} · ${source}\n\nDone: x\n\n`

function setup({ notes = [], daily = [], extraVault = false } = {}) {
  const base = tmp('report-')
  const vault = makeVault(join(base, 'personal'), notes)
  const vaults = { personal: vault }
  if (extraVault) vaults.work = makeVault(join(base, 'work'), [])
  const registry = { dial_schema: 'dial.registry/1', vaults, repos: [], limits: {} }
  for (const [date, lines] of daily) {
    makeVault(vault, [{ path: `Daily/${date}.md`, frontmatter: 'type: daily', body: `\n## Log\n\n${lines.join('\n')}\n` }])
  }
  return { base, vault, registry, home: join(base, 'home') }
}

const run = (s, over = {}) => report({ registry: s.registry, home: s.home, now: NOW, ...over }).report
const text = (s, over) => formatReport(run(s, over))

test('items by state: a count per state present, in the state table order, over the change notes read', () => {
  const notes = [
    ...['a', 'b', 'c'].map(n => change('k', n, { state: 'pr-open' })),
    ...['d', 'e'].map(n => change('k', n, { state: 'halted' })),
    change('k', 'f', { state: 'unobserved' }),
    { path: 'Changes/hand.md', frontmatter: { type: 'change', state: 'ci-red' } },
    repoNote('k', '- broken: 1'),
  ]
  const s = setup({ notes })
  const r = run(s)
  assert.deepEqual(r.itemsByState, { total: 6, counts: { halted: 2, 'pr-open': 3, unobserved: 1 } })
  const t = text(s)
  assert.ok(t.includes('pr-open 3 of 6') && t.includes('halted 2 of 6'))
  assert.ok(t.indexOf('pr-open') < t.indexOf('halted'))
  assert.ok(!t.includes('ci-red'))
})

test('items by state: no change notes names the vault count', () => {
  const s = setup({ extraVault: true })
  assert.equal(run(s).itemsByState.unobserved, 'no Dial change notes (0 of 2 vaults)')
  assert.ok(text(s).includes('items by state: unobserved: no Dial change notes (0 of 2 vaults)'))
})

test('median idle days: over live items only, k of N notes', () => {
  const notes = [1, 2, 4, 9, 30].map((d, i) => change('k', `live${i}`, { last_activity: dayOffset(d) }))
  notes.push(change('k', 'old1', { state: 'archived', last_activity: dayOffset(90) }), change('k', 'old2', { state: 'dropped', last_activity: dayOffset(90) }))
  const s = setup({ notes })
  assert.deepEqual(run(s).medianIdleDays, { median: 4, observed: 5, total: 7 })
  assert.ok(text(s).includes('median idle days: 4 (5 of 7 items)'))
})

test('median idle days: no observed last_activity', () => {
  const s = setup({ notes: [change('k', 'a', { last_activity: 'unobserved' })] })
  assert.ok(text(s).includes('median idle days: unobserved: no last_activity in change notes (0 of 1 items)'))
})

test('needs me per day: the last line of the day wins per repo, summed across repos; gaps are unobserved', () => {
  const s = setup()
  mkdirSync(join(s.home, 'logs'), { recursive: true })
  const line = (ts, repo, needsMe, vault = 'personal') => JSON.stringify({ ts, vault, repo, needsMe, items: 5 })
  writeFileSync(join(s.home, 'logs', 'sync.jsonl'), [
    line('2026-11-09T09:00:00Z', 'katipon', 3),
    line('2026-11-09T17:00:00Z', 'katipon', 1),
    line('2026-11-09T12:00:00Z', 'dial', 2),
    'not json',
    line('2026-11-02T09:00:00Z', 'dial', 0),
    line('2026-09-01T09:00:00Z', 'dial', 9),
  ].join('\n') + '\n')
  const r = run(s).needsMePerDay
  assert.equal(r.total, 28)
  assert.equal(r.observed, 2)
  assert.equal(r.days.length, 28)
  assert.equal(r.days.at(-1).date, '2026-11-10')
  assert.equal(r.days[0].date, '2026-10-14')
  assert.equal(r.days.find(d => d.date === '2026-11-09').needsMe, 3)
  const t = text(s)
  assert.ok(t.includes('needs me per day (2 of 28 days observed)'))
  assert.ok(t.includes('  2026-11-09 3\n'))
  assert.ok(t.includes('  2026-11-10 unobserved: no sync that day'))
})

test('needs me per day: no sync log', () => {
  const s = setup()
  assert.ok(text(s).includes(`needs me per day: unobserved: no sync log at ${join(s.home, 'logs', 'sync.jsonl')} (0 of 28 days)`))
  assert.equal(run(s).needsMePerDay.unobserved, `no sync log at ${join(s.home, 'logs', 'sync.jsonl')}`)
})

test('baseline: both weeks, the mean rounded to a minute and the lookups summed', () => {
  const b = (t, m, l) => `- ${t} baseline · reorient ${m}m · lookups ${l}`
  const s = setup({
    daily: [
      ['2026-10-01', [b('09:00', 10, 3)]],
      ['2026-10-03', [b('09:00', 14, 4)]],
      ['2026-10-07', [b('09:00', 12, 2)]],
      ['2026-11-05', [b('09:00', 4, 1)]],
      ['2026-11-08', [b('09:00', 6, 0), '- 14:05 dial · katipon/add-login: pr-open → ci-red (checks) [[katipon--add-login]]']],
    ],
  })
  const t = text(s)
  assert.ok(t.includes('baseline week 2026-10-01..2026-10-07: reorient 12m · lookups 9 (3 of 7 days)'), t)
  assert.ok(t.includes('current week 2026-11-04..2026-11-10: reorient 5m · lookups 1 (2 of 7 days)'), t)
})

test('baseline: no current-week lines, and no lines at all', () => {
  const b = '- 09:00 baseline · reorient 10m · lookups 3'
  const t = text(setup({ daily: [['2026-10-01', [b]]] }))
  assert.ok(t.includes('current week 2026-11-04..2026-11-10: unobserved: no baseline lines (0 of 7 days)'))
  const none = text(setup())
  assert.ok(none.includes('baseline week: unobserved: no baseline lines (0 of 7 days)'))
})

test('narrative sources: the newest entry decides, none when there is no entry', () => {
  const notes = [
    change('k', 'a', {}, narrative('/dial:handoff (claude)')),
    change('k', 'b', {}, narrative('/dial:handoff (claude)')),
    change('k', 'c', {}, narrative('local model (qwen3.6)')),
    change('k', 'd', {}, narrative('dial handoff')),
    change('k', 'e'),
    change('k', 'f', {}, `## Narrative\n\n### 2026-11-08 10:00 · dial handoff\n\nx\n\n### 2026-11-09 10:00 · local model (q)\n\ny\n\n`),
  ]
  const r = run(setup({ notes })).narrativeSources
  assert.deepEqual(r, { total: 6, counts: { '/dial:handoff': 2, 'local model': 2, other: 1, none: 1 } })
  const t = text(setup({ notes }))
  assert.ok(t.includes('/dial:handoff 2 of 6') && t.includes('local model 2 of 6') && t.includes('other 1 of 6') && t.includes('none 1 of 6'))
})

test('narrative quality: counts over the label rows, or unobserved without the file', () => {
  const s = setup()
  assert.ok(text(s).includes(`narrative quality: unobserved: no labels at ${join(s.home, 'eval', 'labels.jsonl')}`))
  mkdirSync(join(s.home, 'eval'), { recursive: true })
  const rows = Array.from({ length: 20 }, (_, i) => JSON.stringify({ id: `i${i}`, nextCorrect: i < 14, nothingInvented: i < 18 }))
  writeFileSync(join(s.home, 'eval', 'labels.jsonl'), rows.join('\n') + '\n')
  assert.ok(text(s).includes('narrative quality: nextCorrect 14 of 20 · nothingInvented 18 of 20'))
  assert.deepEqual(run(s).narrativeQuality, { total: 20, nextCorrect: 14, nothingInvented: 18 })
})

test('JSON form: the six keys, each with its counts or an unobserved reason', () => {
  const s = setup({ notes: [change('k', 'a', { state: 'pr-open' })] })
  const r = run(s)
  assert.deepEqual(Object.keys(r), ['itemsByState', 'medianIdleDays', 'needsMePerDay', 'baseline', 'narrativeSources', 'narrativeQuality'])
  assert.equal(r.itemsByState.total, 1)
  assert.match(r.needsMePerDay.unobserved, /^no sync log at /)
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(r)))
})

test('report is read-only, creates no home, and ignores notes without the Dial schema', () => {
  const s = setup({
    notes: [change('k', 'a'), { path: 'Changes/hand.md', frontmatter: { type: 'change', state: 'halted' } }],
    extraVault: true,
  })
  const before = { vault: snapshotTree(s.vault), work: snapshotTree(s.registry.vaults.work) }
  const r = run(s)
  assert.equal(r.itemsByState.total, 1)
  assert.deepEqual({ vault: snapshotTree(s.vault), work: snapshotTree(s.registry.vaults.work) }, before)
  assert.equal(existsSync(s.home), false)
})

// --- review ---------------------------------------------------------------------------

const REVIEW_NOW = new Date('2026-11-15T10:00:00Z')
const reviewPath = (s, date = '2026-11-15') => join(s.vault, 'Inbox', `Dial Review ${date}.md`)

function reviewSetup() {
  return setup({
    notes: [
      change('katipon', 'add-login', { state: 'spec-draft', stale: true, last_activity: '2026-10-25T10:00:00Z' }),
      change('katipon', 'fresh', { stale: false }),
      repoNote('katipon', '- unarchived: 2\n- broken: 1\n- aging: 0'),
      repoNote('dial', '- unarchived: 1\n- broken: 1\n- aging: 3'),
      repoNote('bare', '- unarchived: 0\n- broken: unobserved: interlock drift: no graph has been built — run /interlock:bootstrap once\n- aging: 1'),
    ],
  })
}

test('review: writes the weekly note with the embed, drift totals and three checkboxes per stale item', () => {
  const s = reviewSetup()
  const r = reviewWeek({ registry: s.registry, now: REVIEW_NOW })
  assert.equal(r.ok, true)
  assert.deepEqual(r.results.map(x => x.line), [`created ${reviewPath(s)}`])
  const body = readFileSync(reviewPath(s), 'utf8')
  assert.ok(body.includes('dial_schema: dial.review/1'))
  assert.ok(body.includes('![[Dial.base#Stale]]'))
  assert.ok(body.includes('## Drift'))
  assert.ok(body.includes('- unarchived: 3 (3 of 3 repos)'))
  assert.ok(body.includes('- broken: 2 (2 of 3 repos)'))
  assert.ok(body.includes('- aging: 4 (3 of 3 repos)'))
  assert.ok(body.includes('### [[katipon--add-login]] · spec-draft · 21d'))
  assert.ok(body.includes('- [ ] archive: `openspec archive add-login` in katipon'))
  assert.ok(body.includes('- [ ] drop: `dial drop katipon add-login`'))
  assert.ok(body.includes('- [ ] re-spec: `/interlock:spec add-login`'))
  assert.equal((body.match(/- \[ \]/g) ?? []).length, 3)
})

test('review: nothing stale says so and has no checkbox', () => {
  const s = setup({ notes: [change('k', 'a')] })
  reviewWeek({ registry: s.registry, now: REVIEW_NOW })
  const body = readFileSync(reviewPath(s), 'utf8')
  assert.ok(body.includes('No stale items.'))
  assert.ok(!body.includes('- [ ]'))
})

test('review: a second run the same day leaves a ticked checkbox and prints unchanged', () => {
  const s = reviewSetup()
  reviewWeek({ registry: s.registry, now: REVIEW_NOW })
  const ticked = readFileSync(reviewPath(s), 'utf8').replace('- [ ] archive', '- [x] archive')
  writeFileSync(reviewPath(s), ticked)
  const r = reviewWeek({ registry: s.registry, now: REVIEW_NOW })
  assert.deepEqual(r.results.map(x => x.line), [`unchanged ${reviewPath(s)}`])
  assert.equal(readFileSync(reviewPath(s), 'utf8'), ticked)
})

test('review: a new week keeps the old note unchanged', () => {
  const s = reviewSetup()
  reviewWeek({ registry: s.registry, now: REVIEW_NOW })
  const first = readFileSync(reviewPath(s), 'utf8')
  reviewWeek({ registry: s.registry, now: new Date('2026-11-22T10:00:00Z') })
  assert.ok(existsSync(reviewPath(s, '2026-11-22')))
  assert.equal(readFileSync(reviewPath(s), 'utf8'), first)
})

test('review: a vault without Projects or Changes is skipped and nothing is written into it', () => {
  const s = setup({ notes: [change('k', 'a')], extraVault: true })
  const work = s.registry.vaults.work
  const before = snapshotTree(work)
  const r = reviewWeek({ registry: s.registry, now: REVIEW_NOW })
  assert.ok(r.results.some(x => x.line === `skipped ${work}: no Dial notes`))
  assert.deepEqual(snapshotTree(work), before)
})

test('review: writes only the review note, nothing else in the vault changes', () => {
  const s = reviewSetup()
  const before = snapshotTree(s.vault)
  reviewWeek({ registry: s.registry, now: REVIEW_NOW })
  const after = snapshotTree(s.vault)
  const added = Object.keys(after).filter(k => !(k in before))
  assert.deepEqual(added.sort(), ['Inbox', 'Inbox/Dial Review 2026-11-15.md'])
  for (const k of Object.keys(before)) assert.equal(after[k], before[k])
})
