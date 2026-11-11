// Red wave for specs/note-rendering/spec.md (the pure renderers). Written before
// lib/render.mjs exists: `node --test test/render.test.mjs` fails on the import.
// test/note.test.mjs covers lib/note.mjs; the two files read the same fixtures.
//
// Contract these tests pin (design.md §The fact, §Notes). Every renderer is pure
// and returns text; `ctx.today` is the local date YYYY-MM-DD, never a clock read.
//
//   renderChangeNote(item, existing, ctx) -> text    existing: the file's text or null
//     item  = a derive item: { change, state, needsMe, stale, lastActivity (iso|null), evidence, rows,
//             branch, pr, prState, ci, mergeVerdict, tasksDone, tasksTotal, lastCommit, lastSession }
//             where the last nine are fact leaves ({ value, evidence } | { value: null, unobserved })
//     ctx   = { repo, scope, today }
//     The result is final: updated is decided inside (render with the old `updated`; if the bytes equal
//     `existing` return them, else render again with updated = ctx.today).
//   renderRepoNote(view, existing, ctx) -> text
//     view  = derive's repo item: { state, needsMe, stale, suggested, evidence, lastActivity, rows,
//             items: [{ change, state, needsMe, lastActivity }] }
//     ctx   = { repo, scope, today, facts (RepoFacts), recentNarrative: [{ change, at, source, body }] }
//   renderSummary(notes, ctx) -> text   notes: [{ name, frontmatter }] (every Changes/ and Projects/ note,
//     frontmatter as the flat reader returns it); ctx = { registered: string[], nextRows }
//   renderDailyLine(event, ctx) -> '- HH:mm dial · …' (no newline); event = { kind: 'transition' | 'handoff',
//     repo, change?, from?, to?, detail?, source?, at (Date|iso) }
//   renderReview(view, ctx) -> text     view = { stale: [{ repo, change, state, idleDays }],
//     drift: { unarchived|broken|aging: { total, observed }, repos } }; ctx = { today }
//   renderBase() -> the Dial.base text, groupOrder generated from STATES
//   redact(text) -> text; sanitizeName(name) -> string; noteName(repo, change?) -> string;
//   notePath(repo, change?) -> 'Changes/<repo>--<change>.md' | 'Projects/<repo>.md'
process.env.TZ = 'UTC'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readFrontmatter } from '../lib/frontmatter.mjs'
import { splitNote } from '../lib/note.mjs'
import { STATES } from '../lib/facts.mjs'
import {
  renderChangeNote, renderRepoNote, renderSummary, renderDailyLine, renderReview, renderBase,
  redact, sanitizeName, noteName, notePath,
} from '../lib/render.mjs'

const VAULT = new URL('./fixtures/vault/', import.meta.url)
const CHANGE_FIXTURE = readFileSync(new URL('Changes/katipon--add-login.md', VAULT), 'utf8')
const REPO_ONLY = JSON.parse(readFileSync(new URL('./fixtures/facts/repo-only.json', import.meta.url), 'utf8'))

const STATE_HEADING = 'State  <!-- dial:generated, do not edit -->'
const CHANGE_KEYS = [
  'title', 'type', 'repo', 'change', 'scope', 'state', 'needs_me', 'stale', 'branch', 'pr', 'pr_state', 'ci',
  'merge_verdict', 'tasks_done', 'tasks_total', 'last_commit', 'last_session', 'last_activity', 'created',
  'updated', 'status', 'tags', 'aliases', 'dial_schema',
]
const REPO_KEYS = [
  'title', 'type', 'repo', 'scope', 'state', 'needs_me', 'stale', 'branch', 'dirty', 'stash', 'ahead', 'behind',
  'worktrees', 'last_commit', 'last_session', 'last_activity', 'active_changes', 'created', 'updated', 'status',
  'tags', 'aliases', 'dial_schema',
]

const F = (value, evidence = 'test') => ({ value, evidence })
const U = unobserved => ({ value: null, unobserved })

const ROWS = [
  { fact: 'archive', value: 'none', evidence: 'openspec/changes/archive: none' },
  { fact: 'tasks', value: '2/5', evidence: 'openspec/changes/add-login/tasks.md: 2/5' },
  { fact: 'pr', value: '38 open', evidence: 'gh pr view 38: OPEN' },
  { fact: 'ci', value: 'pass', evidence: 'gh pr checks feat/add-login: pass' },
  { fact: 'last activity', value: '2026-11-09T18:30:00.000Z', evidence: 'gh pr view 38: updatedAt 2026-11-09T18:30:00Z' },
]

function changeItem(over = {}) {
  return {
    change: 'add-login',
    state: 'pr-open',
    needsMe: true,
    stale: false,
    idleDays: 1,
    suggested: 'review and merge',
    lastActivity: '2026-11-09T18:30:00.000Z',
    evidence: 'gh pr view 38: OPEN',
    rows: ROWS,
    branch: F('feat/add-login'),
    pr: F(38),
    prState: F('open'),
    ci: F('pass'),
    mergeVerdict: F('none'),
    tasksDone: F(2),
    tasksTotal: F(5),
    lastCommit: F('3f50683'),
    lastSession: F('2026-11-09T17:00:00.000Z'),
    ...over,
  }
}

const ctx = (over = {}) => ({ repo: 'katipon', scope: 'personal', today: '2026-11-10', ...over })
const fm = text => readFrontmatter(text)
const keys = text => Object.keys(fm(text))
const sections = text => splitNote(text).sections
const sectionBody = (text, heading) => sections(text).find(s => s.heading === heading)?.body
const tableLines = text => text.split('\n').filter(l => l.startsWith('|'))
const render = (item = changeItem(), existing = null, c = ctx()) => renderChangeNote(item, existing, c)

// --- change note frontmatter -------------------------------------------------

test('a new change note: key order and values', () => {
  const out = render()
  assert.deepEqual(keys(out), CHANGE_KEYS)
  const f = fm(out)
  assert.equal(f.title, 'katipon — add-login')
  assert.equal(f.type, 'change')
  assert.equal(f.repo, 'katipon')
  assert.equal(f.change, 'add-login')
  assert.equal(f.scope, 'personal')
  assert.equal(f.state, 'pr-open')
  assert.equal(f.needs_me, 'true')
  assert.equal(f.stale, 'false')
  assert.equal(f.branch, 'feat/add-login')
  assert.equal(f.pr, '38')
  assert.equal(f.pr_state, 'open')
  assert.equal(f.ci, 'pass')
  assert.equal(f.tasks_done, '2')
  assert.equal(f.tasks_total, '5')
  assert.equal(f.last_commit, '3f50683')
  assert.equal(f.created, '2026-11-10')
  assert.equal(f.updated, '2026-11-10')
  assert.equal(f.status, 'active')
  assert.equal(f.tags, '[dial]')
  assert.equal(f.aliases, '[]')
  assert.equal(f.dial_schema, 'dial.change/1')
  assert.ok(!('dropped' in f) && !('archived' in f))
})

test('booleans and integers are written bare and last_session stays an unquoted timestamp', () => {
  const out = render()
  assert.match(out, /^needs_me: true$/m)
  assert.match(out, /^tasks_done: 2$/m)
  assert.match(out, /^last_session: 2026-11-09T17:00:00(\.000)?Z$/m)
  assert.match(out, /^last_activity: 2026-11-09T18:30:00(\.000)?Z$/m)
})

test('a branch with a colon-space and a change with a hash are quoted', () => {
  const out = render(changeItem({ change: 'fix#12', branch: F('fix: login') }))
  assert.match(out, /^branch: "fix: login"$/m)
  assert.match(out, /^change: "fix#12"$/m)
})

test('a numeric-looking branch is quoted while tasks_done stays bare', () => {
  const out = render(changeItem({ branch: F('1234'), tasksDone: F(9) }))
  assert.match(out, /^branch: "1234"$/m)
  assert.match(out, /^tasks_done: 9$/m)
})

test('a dropped and archived note ends its Dial keys with dial_schema, dropped, archived and has status archived', () => {
  const existing = render(changeItem(), null, ctx({ today: '2026-11-01' }))
    .replace('dial_schema: dial.change/1\n', 'dial_schema: dial.change/1\ndropped: 2026-11-08\narchived: 2026-12-20\n')
  const out = render(changeItem({ state: 'archived', needsMe: false }), existing, ctx({ today: '2026-12-20' }))
  const k = keys(out)
  assert.deepEqual(k.slice(-3), ['dial_schema', 'dropped', 'archived'])
  assert.equal(fm(out).dropped, '2026-11-08')
  assert.equal(fm(out).archived, '2026-12-20')
  assert.equal(fm(out).status, 'archived')
})

test('an archived-state note not yet moved keeps status active', () => {
  const f = fm(render(changeItem({ state: 'archived', needsMe: false })))
  assert.equal(f.state, 'archived')
  assert.equal(f.status, 'active')
})

test('no PR is an observed absence: pr, pr_state and ci print none, never unobserved or empty', () => {
  const f = fm(render(changeItem({ pr: F('none'), prState: F('none'), ci: F('none'), mergeVerdict: F('absent') })))
  assert.equal(f.pr, 'none')
  assert.equal(f.pr_state, 'none')
  assert.equal(f.ci, 'none')
  assert.equal(f.merge_verdict, 'none')
})

test('an observed null prints none', () => {
  assert.equal(fm(render(changeItem({ ci: F(null) }))).ci, 'none')
})

test('an unobserved fact prints as the bare value unobserved in frontmatter and with its reason in the State table', () => {
  const rows = [...ROWS.filter(r => r.fact !== 'ci'), { fact: 'ci', value: 'unobserved: gh: not on PATH' }]
  const out = render(changeItem({ ci: U('gh: not on PATH'), rows }))
  assert.match(out, /^ci: unobserved$/m)
  assert.ok(tableLines(out).includes('| ci | unobserved: gh: not on PATH | — |'))
})

test('an unobserved last activity prints last_activity: unobserved', () => {
  assert.match(render(changeItem({ lastActivity: null })), /^last_activity: unobserved$/m)
})

// --- change note sections ----------------------------------------------------

test('a new change note is Next, Narrative, then State, with Next and Narrative empty', () => {
  const out = render()
  assert.deepEqual(sections(out).map(s => s.heading), ['Next', 'Narrative', STATE_HEADING])
  assert.equal(sectionBody(out, 'Next').trim(), '')
  assert.equal(sectionBody(out, 'Narrative').trim(), '')
  assert.match(out, /^## State {2}<!-- dial:generated, do not edit -->$/m)
})

test('the State table is the fixed header, a state row, then one row per evidence row', () => {
  const lines = tableLines(render())
  assert.equal(lines[0], '| fact | value | evidence |')
  assert.match(lines[1], /^\| ?-+ ?\| ?-+ ?\| ?-+ ?\|$/)
  assert.equal(lines[2], '| state | pr-open | gh pr view 38: OPEN |')
  assert.deepEqual(lines.slice(3), ROWS.map(r => `| ${r.fact} | ${r.value} | ${r.evidence} |`))
})

test('a pipe inside a cell is escaped and the table keeps three columns', () => {
  const rows = [{ fact: 'ci', value: 'fail', evidence: 'gh pr checks: a|b' }]
  const lines = tableLines(render(changeItem({ rows })))
  const line = lines.find(l => l.startsWith('| ci '))
  assert.equal(line, '| ci | fail | gh pr checks: a\\|b |')
  assert.equal(line.split(/(?<!\\)\|/).length, 5)
})

test('an evidence row with no evidence prints an em dash', () => {
  const lines = tableLines(render(changeItem({ rows: [{ fact: 'queue', value: 'absent' }] })))
  assert.ok(lines.includes('| queue | absent | — |'))
})

test('rendering twice from the same facts is byte-identical', () => {
  assert.equal(render(), render())
  const first = render()
  assert.equal(render(changeItem(), first), first)
})

test('an edited Next, Narrative and a human-added section survive byte for byte', () => {
  const out = render(changeItem(), CHANGE_FIXTURE)
  const was = splitNote(CHANGE_FIXTURE).sections
  const now = splitNote(out).sections
  for (const name of ['Next', 'Narrative', 'Scratch']) {
    assert.equal(now.find(s => s.heading === name).body, was.find(s => s.heading === name).body, name)
  }
})

test('a human section stays between Narrative and State', () => {
  assert.deepEqual(sections(render(changeItem(), CHANGE_FIXTURE)).map(s => s.heading), ['Next', 'Narrative', 'Scratch', STATE_HEADING])
})

test('a human-added section keeps its original order when there are two', () => {
  const first = render()
  const withTwo = first.replace('## State', '## Links\n\n- [[x]]\n\n## Ideas\n\nthought\n\n## State')
  assert.deepEqual(sections(render(changeItem(), withTwo)).map(s => s.heading), ['Next', 'Narrative', 'Links', 'Ideas', STATE_HEADING])
})

test('an edited State table is overwritten by the one derived from the facts', () => {
  const first = render()
  const edited = first.replace('| state | pr-open | gh pr view 38: OPEN |', '| state | whatever | typed by a human |')
  assert.equal(render(changeItem(), edited), first)
})

test('a deleted State section is rebuilt identically on the same day', () => {
  const first = render()
  const cut = first.slice(0, first.indexOf('## State'))
  assert.equal(render(changeItem(), cut), first)
})

test('a deleted State section on a later day is rebuilt the same way with updated bumped', () => {
  const first = render()
  const cut = first.slice(0, first.indexOf('## State'))
  const later = render(changeItem(), cut, ctx({ today: '2026-11-12' }))
  assert.equal(later, first.replace('updated: 2026-11-10', 'updated: 2026-11-12'))
})

test('unknown frontmatter keys survive after the Dial keys, and a user aliases edit survives as written', () => {
  const first = render()
  const edited = first
    .replace('aliases: []', 'aliases: [login work]')
    .replace('dial_schema: dial.change/1\n', 'dial_schema: dial.change/1\nsource: meeting\n')
  const out = render(changeItem(), edited)
  const f = fm(out)
  assert.equal(f.source, 'meeting')
  assert.match(out, /^aliases: \[login work\]$/m)
  const k = keys(out)
  assert.ok(k.indexOf('source') > k.indexOf('dial_schema'))
})

test('the fixture note keeps its source key through a render', () => {
  assert.equal(fm(render(changeItem(), CHANGE_FIXTURE)).source, 'pi session 2026-11-08')
})

test('created is written once: a later render keeps the first value', () => {
  const first = render(changeItem(), null, ctx({ today: '2026-11-01' }))
  const out = render(changeItem({ state: 'shipping', needsMe: false }), first, ctx({ today: '2026-11-12' }))
  assert.equal(fm(out).created, '2026-11-01')
})

// --- updated -----------------------------------------------------------------

test('nothing changed on a later day: the bytes equal the existing file and updated stays', () => {
  const first = render(changeItem(), null, ctx({ today: '2026-11-10' }))
  const again = render(changeItem(), first, ctx({ today: '2026-11-12' }))
  assert.equal(again, first)
  assert.equal(fm(again).updated, '2026-11-10')
})

test('a state change bumps updated to today and keeps created', () => {
  const first = render(changeItem({ state: 'shipping', needsMe: false }), null, ctx({ today: '2026-11-10' }))
  const out = render(changeItem({ state: 'pr-open' }), first, ctx({ today: '2026-11-12' }))
  assert.equal(fm(out).state, 'pr-open')
  assert.equal(fm(out).updated, '2026-11-12')
  assert.equal(fm(out).created, '2026-11-10')
})

test('a quiet day writes nothing: the idle days moving changes no byte', () => {
  const first = render(changeItem({ idleDays: 3 }), null, ctx({ today: '2026-11-10' }))
  assert.equal(render(changeItem({ idleDays: 4 }), first, ctx({ today: '2026-11-11' })), first)
})

test('crossing staleDays is a real change: stale true and updated set to the second day', () => {
  const first = render(changeItem({ stale: false }), null, ctx({ today: '2026-11-10' }))
  const out = render(changeItem({ stale: true, needsMe: true }), first, ctx({ today: '2026-11-11' }))
  assert.equal(fm(out).stale, 'true')
  assert.equal(fm(out).updated, '2026-11-11')
})

test('no note carries idle days: neither a key nor an <n>d value', () => {
  const out = render(changeItem({ idleDays: 21, stale: true }))
  assert.doesNotMatch(out, /idle/i)
  assert.doesNotMatch(out, /\b21d\b/)
  assert.doesNotMatch(renderRepoNote(repoView(), null, repoCtx()), /\b\d+d\b|idle_days/)
})

// --- repo note ---------------------------------------------------------------

const repoView = (over = {}) => ({
  state: 'idle', needsMe: false, stale: false, suggested: null, evidence: null,
  lastActivity: '2026-11-09T18:00:00.000Z', rows: [], items: [], ...over,
})
const repoCtx = (over = {}) => ({ ...ctx(), facts: structuredClone(REPO_ONLY.facts), recentNarrative: [], ...over })
const renderRepo = (view = repoView(), existing = null, c = repoCtx()) => renderRepoNote(view, existing, c)

test('a repo note: key order and values', () => {
  const out = renderRepo()
  assert.deepEqual(keys(out), REPO_KEYS)
  const f = fm(out)
  assert.equal(f.title, 'katipon')
  assert.equal(f.type, 'repo')
  assert.equal(f.repo, 'katipon')
  assert.equal(f.scope, 'personal')
  assert.equal(f.branch, 'main')
  assert.equal(f.dirty, '0')
  assert.equal(f.stash, '0')
  assert.equal(f.ahead, '0')
  assert.equal(f.behind, '0')
  assert.equal(f.worktrees, '1')
  assert.equal(f.last_commit, '3f50683')
  assert.equal(f.active_changes, '0')
  assert.equal(f.dial_schema, 'dial.repo/1')
  assert.equal(f.tags, '[dial]')
})

test('repo-level state: no openspec and no PR is idle with needs_me false', () => {
  const f = fm(renderRepo())
  assert.equal(f.state, 'idle')
  assert.equal(f.needs_me, 'false')
})

test('a repo note holds Next, Narrative, then the generated Changes, Drift, Recent narrative and State', () => {
  assert.deepEqual(sections(renderRepo()).map(s => s.heading), ['Next', 'Narrative', 'Changes', 'Drift', 'Recent narrative', STATE_HEADING])
})

test('git missing: branch, dirty, stash, ahead, behind and last_commit are unobserved, not 0 or empty', () => {
  const c = repoCtx()
  for (const k of ['branch', 'detached', 'dirty', 'ahead', 'behind', 'stash', 'inProgress', 'unmerged', 'worktrees', 'lastCommit']) {
    c.facts.git[k] = U('git: not on PATH')
  }
  const f = fm(renderRepo(repoView(), null, c))
  for (const k of ['branch', 'dirty', 'stash', 'ahead', 'behind', 'last_commit']) assert.equal(f[k], 'unobserved', k)
})

test('the Changes table links every item, ordered by the state priority list, with the last activity date', () => {
  const view = repoView({
    items: [
      { change: 'fix-cache', state: 'shipping', needsMe: false, lastActivity: '2026-11-10T08:00:00.000Z' },
      { change: 'add-login', state: 'pr-open', needsMe: true, lastActivity: '2026-11-08T21:00:00.000Z' },
    ],
  })
  const body = sectionBody(renderRepo(view), 'Changes')
  const lines = body.split('\n').filter(l => l.startsWith('|'))
  assert.equal(lines[0], '| change | state | needs_me | last activity |')
  assert.deepEqual(lines.slice(2), [
    '| [[katipon--add-login]] | pr-open | true | 2026-11-08 |',
    '| [[katipon--fix-cache]] | shipping | false | 2026-11-10 |',
  ])
})

test('an item with no observed activity shows an em dash in the Changes table', () => {
  const view = repoView({ items: [{ change: 'add-login', state: 'queued', needsMe: false, lastActivity: null }] })
  assert.ok(sectionBody(renderRepo(view), 'Changes').includes('| [[katipon--add-login]] | queued | false | — |'))
})

test('active_changes counts the items that are not archived', () => {
  const view = repoView({
    items: [
      { change: 'a', state: 'queued', needsMe: false, lastActivity: null },
      { change: 'b', state: 'archived', needsMe: false, lastActivity: null },
    ],
  })
  assert.equal(fm(renderRepo(view)).active_changes, '1')
})

test('Drift is unobserved without interlock', () => {
  const c = repoCtx()
  c.facts.interlock.drift = U('interlock: not on PATH')
  assert.equal(sectionBody(renderRepo(repoView(), null, c), 'Drift').trim(), 'unobserved: interlock: not on PATH')
})

test('Drift counts: two unarchived changes, broken 1, aging 3', () => {
  const c = repoCtx()
  c.facts.interlock.drift = F({ unarchived: ['a', 'b'], broken: F(1), aging: F(3) }, 'interlock drift --json: ok')
  const lines = sectionBody(renderRepo(repoView(), null, c), 'Drift').split('\n').map(l => l.trim()).filter(Boolean)
  assert.deepEqual(lines, ['- unarchived: 2', '- broken: 1', '- aging: 3'])
})

test('Drift with no graph: unarchived 0 and the reason on broken and aging', () => {
  const reason = 'interlock drift: no graph has been built — run /interlock:bootstrap once'
  const c = repoCtx()
  c.facts.interlock.drift = F({ unarchived: [], broken: U(reason), aging: U(reason) }, 'interlock drift --json: skipped')
  const lines = sectionBody(renderRepo(repoView(), null, c), 'Drift').split('\n').map(l => l.trim()).filter(Boolean)
  assert.deepEqual(lines, ['- unarchived: 0', `- broken: unobserved: ${reason}`, `- aging: unobserved: ${reason}`])
})

test('Recent narrative holds the three newest of five entries, newest first, each tagged with its change note', () => {
  const entry = (change, at, body) => ({ change, at, source: 'dial handoff', body })
  const c = repoCtx({
    recentNarrative: [
      entry('add-login', '2026-11-05T09:00:00.000Z', 'e1'),
      entry('add-login', '2026-11-09T22:20:00.000Z', 'e4'),
      entry('fix-cache', '2026-11-07T10:00:00.000Z', 'e3'),
      entry('fix-cache', '2026-11-06T10:00:00.000Z', 'e2'),
      entry('add-login', '2026-11-10T09:05:00.000Z', 'e5'),
    ],
  })
  const body = sectionBody(renderRepo(repoView(), null, c), 'Recent narrative')
  const headings = body.split('\n').filter(l => l.startsWith('### '))
  assert.deepEqual(headings, [
    '### 2026-11-10 09:05 · dial handoff · [[katipon--add-login]]',
    '### 2026-11-09 22:20 · dial handoff · [[katipon--add-login]]',
    '### 2026-11-07 10:00 · dial handoff · [[katipon--fix-cache]]',
  ])
  assert.match(body, /e5/)
  assert.doesNotMatch(body, /e1|e2/)
})

test('a repo note keeps its Next, Narrative and human sections and unknown keys like a change note', () => {
  const first = renderRepo()
  const edited = first
    .replace('## Narrative\n', '## Narrative\n\nmy own paragraph\n')
    .replace('dial_schema: dial.repo/1\n', 'dial_schema: dial.repo/1\nsource: me\n')
  const out = renderRepo(repoView(), edited)
  assert.match(sectionBody(out, 'Narrative'), /my own paragraph/)
  assert.equal(fm(out).source, 'me')
})

test('a repo note is byte-identical on a later day when nothing changed', () => {
  const first = renderRepo(repoView(), null, repoCtx({ today: '2026-11-10' }))
  assert.equal(renderRepo(repoView(), first, repoCtx({ today: '2026-11-12' })), first)
})

// --- narrative / daily lines -------------------------------------------------

test('the daily transition line', () => {
  const line = renderDailyLine({
    kind: 'transition', repo: 'specflow', change: 'clear-the-directory-validation-findings',
    from: 'shipping', to: 'pr-open', detail: 'verdict HUMAN', at: '2026-11-10T22:20:00Z',
  }, ctx())
  assert.equal(
    line,
    '- 22:20 dial · specflow/clear-the-directory-validation-findings: shipping → pr-open (verdict HUMAN) [[specflow--clear-the-directory-validation-findings]]'
  )
})

test('the daily handoff line, with a change and with the repo note only', () => {
  assert.equal(
    renderDailyLine({ kind: 'handoff', repo: 'katipon', change: 'add-login', source: '/dial:handoff (claude)', at: '2026-11-10T09:05:00Z' }, ctx()),
    '- 09:05 dial · katipon/add-login: handoff (/dial:handoff (claude)) [[katipon--add-login]]'
  )
  assert.equal(
    renderDailyLine({ kind: 'handoff', repo: 'katipon', source: 'dial handoff', at: '2026-11-10T18:00:00Z' }, ctx()),
    '- 18:00 dial · katipon: handoff (dial handoff) [[katipon]]'
  )
})

test('the daily line time is local time', () => {
  const tz = process.env.TZ
  process.env.TZ = 'Asia/Singapore'
  try {
    const line = renderDailyLine({ kind: 'handoff', repo: 'katipon', source: 'dial handoff', at: '2026-11-10T01:05:00Z' }, ctx())
    assert.match(line, /^- 09:05 dial · /)
  } finally {
    process.env.TZ = tz
  }
})

// --- Dial Summary.md ---------------------------------------------------------

const note = (name, repo, state, last, over = {}) => ({
  name,
  frontmatter: {
    type: name.includes('--') ? 'change' : 'repo', repo, state, needs_me: 'true', stale: 'false', last_activity: last, ...over,
  },
})
const summaryBody = text => text.slice(text.indexOf('\n---\n', 4) + 5).split('\n').filter(Boolean)
const sctx = (over = {}) => ({ registered: ['katipon', 'specflow'], nextRows: 10, ...over })

test('the summary frontmatter is type note, tags and the schema marker, in that order', () => {
  const out = renderSummary([], sctx())
  assert.deepEqual(keys(out), ['type', 'tags', 'dial_schema'])
  assert.equal(fm(out).type, 'note')
  assert.equal(fm(out).tags, '[dial]')
  assert.equal(fm(out).dial_schema, 'dial.summary/1')
})

test('the summary lists two needs-me items as short bullets, in state priority order', () => {
  const out = renderSummary([
    note('specflow--fix-docs', 'specflow', 'halted', '2026-11-05T09:00:00.000Z'),
    note('katipon--add-login', 'katipon', 'pr-open', '2026-11-08T21:00:00.000Z'),
  ], sctx())
  assert.deepEqual(summaryBody(out), [
    'Needs me: 2',
    '- [[katipon--add-login]] · pr-open · 2026-11-08',
    '- [[specflow--fix-docs]] · halted · 2026-11-05',
  ])
})

test('items in one state are ordered oldest last activity first, then by note name', () => {
  const out = renderSummary([
    note('katipon--b', 'katipon', 'queued', '2026-11-08T00:00:00.000Z'),
    note('katipon--a', 'katipon', 'queued', '2026-11-08T00:00:00.000Z'),
    note('katipon--c', 'katipon', 'queued', '2026-11-01T00:00:00.000Z'),
  ], sctx())
  assert.deepEqual(summaryBody(out).slice(1).map(l => l.match(/\[\[(.*?)\]\]/)[1]), ['katipon--c', 'katipon--a', 'katipon--b'])
})

test('a repo-level item links the repo note', () => {
  const out = renderSummary([note('katipon', 'katipon', 'conflict', '2026-11-09T12:00:00.000Z')], sctx())
  assert.ok(summaryBody(out).includes('- [[katipon]] · conflict · 2026-11-09'))
})

test('an unobserved last activity prints an em dash', () => {
  const out = renderSummary([note('katipon--a', 'katipon', 'queued', 'unobserved')], sctx())
  assert.ok(summaryBody(out).includes('- [[katipon--a]] · queued · —'))
})

test('the summary is capped at nextRows with an "and n more" line', () => {
  const notes = Array.from({ length: 5 }, (_, i) => note(`katipon--c${i}`, 'katipon', 'queued', `2026-11-0${i + 1}T00:00:00.000Z`))
  const body = summaryBody(renderSummary(notes, sctx({ nextRows: 2 })))
  assert.equal(body[0], 'Needs me: 5')
  assert.equal(body.length, 4)
  assert.equal(body[3], '- … and 3 more')
})

test('the summary has no table, whatever the number of items', () => {
  for (const n of [0, 1, 7]) {
    const notes = Array.from({ length: n }, (_, i) => note(`katipon--c${i}`, 'katipon', 'queued', '2026-11-01T00:00:00.000Z'))
    assert.ok(renderSummary(notes, sctx()).split('\n').every(l => !l.startsWith('|')))
  }
})

test('nothing needs me: the body is the single line Needs me: 0', () => {
  const out = renderSummary([note('katipon--a', 'katipon', 'shipping', '2026-11-01T00:00:00.000Z', { needs_me: 'false' })], sctx())
  assert.deepEqual(summaryBody(out), ['Needs me: 0'])
})

test('a one-repo render keeps another repo\'s items: every registered repo\'s notes are read', () => {
  const out = renderSummary([
    note('katipon--add-login', 'katipon', 'pr-open', '2026-11-08T21:00:00.000Z'),
    note('specflow--fix-docs', 'specflow', 'halted', '2026-11-05T09:00:00.000Z'),
  ], sctx())
  assert.match(out, /\[\[specflow--fix-docs\]\]/)
})

test('an unregistered repo\'s notes are neither listed nor counted', () => {
  const out = renderSummary([
    note('old-repo--x', 'old-repo', 'halted', '2026-11-01T00:00:00.000Z'),
    note('katipon--add-login', 'katipon', 'pr-open', '2026-11-08T21:00:00.000Z'),
  ], sctx())
  assert.deepEqual(summaryBody(out), ['Needs me: 1', '- [[katipon--add-login]] · pr-open · 2026-11-08'])
})

test('a note without needs_me true is never listed', () => {
  const out = renderSummary([note('katipon--a', 'katipon', 'queued', '2026-11-01T00:00:00.000Z', { needs_me: 'false' })], sctx())
  assert.doesNotMatch(out, /\[\[/)
})

// --- Dial.base ---------------------------------------------------------------

test('Dial.base has four named views of the right types and a groupOrder equal to the state priority list', () => {
  const base = renderBase()
  const names = [...base.matchAll(/^\s*(?:-\s*)?name:\s*(.+?)\s*$/gm)].map(m => m[1].replace(/^["']|["']$/g, ''))
  assert.deepEqual(names.filter(n => ['Needs me', 'In flight', 'Stale', 'By repo'].includes(n)), ['Needs me', 'In flight', 'Stale', 'By repo'])
  assert.deepEqual([...base.matchAll(/^\s*type:\s*(kanban|table)\s*$/gm)].map(m => m[1]), ['kanban', 'table', 'table', 'table'])
  assert.match(base, /type == "change"/)
  const flow = base.match(/groupOrder:\s*\[([^\]]*)\]/)
  const order = flow
    ? flow[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''))
    : [...base.slice(base.indexOf('groupOrder:')).split('\n').slice(1).join('\n').matchAll(/^\s*-\s*(\S+)\s*$/gm)].map(m => m[1]).slice(0, STATES.length)
  assert.deepEqual(order, [...STATES])
})

// --- filenames ---------------------------------------------------------------

test('forbidden characters in a name are replaced by a dash in the filename and the wikilink', () => {
  assert.equal(sanitizeName('fix#12:cache'), 'fix-12-cache')
  assert.equal(noteName('katipon', 'fix#12:cache'), 'katipon--fix-12-cache')
  assert.equal(notePath('katipon', 'fix#12:cache'), 'Changes/katipon--fix-12-cache.md')
  for (const ch of ': / \\ ? * " < > | # ^ [ ]'.split(' ')) assert.equal(sanitizeName(`a${ch}b`), 'a-b', ch)
})

test('the repo note path is Projects/<repo>.md and case is kept', () => {
  assert.equal(notePath('beta-rabbitdeploy'), 'Projects/beta-rabbitdeploy.md')
  assert.equal(noteName('beta-rabbitdeploy'), 'beta-rabbitdeploy')
})

// --- redaction ---------------------------------------------------------------

test('redact replaces each secret-shaped string with [redacted]', () => {
  assert.equal(redact('ghp_abc123'), '[redacted]')
  assert.equal(redact('see glpat-xyz now'), 'see [redacted] now')
  assert.equal(redact('key sk-live1 end'), 'key [redacted] end')
  assert.equal(redact('AKIAEXAMPLE'), '[redacted]')
  assert.equal(redact('auth Bearer abc ok'), 'auth [redacted] ok')
  assert.equal(redact('password=hunter2'), '[redacted]')
  assert.equal(redact('db_token=t0k end'), '[redacted] end')
  assert.equal(redact('export API_KEY=v'), '[redacted]')
  assert.equal(redact('fix a\n-----BEGIN PRIVATE KEY-----\nb'), 'fix a\n[redacted]\nb')
  assert.equal(redact('x\ndiff --git a/x b/x\ny'), 'x\n[redacted]\ny')
})

test('a prefix redacts only at a word start: risk-model survives', () => {
  assert.equal(redact('risk-model'), 'risk-model')
  assert.equal(redact('ask-sk-1 and desk-ghp_x'), 'ask-sk-1 and desk-ghp_x')
  assert.equal(redact('feat/ghp_abc123'), 'feat/[redacted]')
})

test('redact leaves ordinary text alone', () => {
  const text = 'gh pr view 38: OPEN\nopenspec/changes/add-login/tasks.md: 2/5'
  assert.equal(redact(text), text)
})

const SECRET_PATTERNS = [/-----BEGIN/, /diff --git/, /Bearer /, /password=/, /token=/, /export [A-Z_]+=/, /(^|[^A-Za-z0-9_-])(ghp_|glpat-|sk-|AKIA)/m]

test('planted strings in branch names, commit subjects and evidence never reach a rendered note', () => {
  const planted = ['ghp_abc123', 'glpat-xyz', 'sk-live1', 'AKIAEXAMPLE', 'Bearer abc', 'password=hunter2', 'token=t0k', 'export API_KEY=v']
  const rows = [
    ...planted.map((p, i) => ({ fact: `planted${i}`, value: `x ${p}`, evidence: `git log -1: fix ${p}` })),
    { fact: 'subject', value: 'ok', evidence: 'git log -1: diff --git a/x b/x' },
  ]
  const out = render(changeItem({ rows, branch: F('feat/ghp_abc123') }))
  for (const re of SECRET_PATTERNS) assert.doesNotMatch(out, re, String(re))
  assert.match(out, /\[redacted\]/)
})

test('planted strings never reach a rendered repo note either', () => {
  const view = repoView({ rows: [{ fact: 'subject', value: 'password=hunter2', evidence: 'git log -1: sk-live1' }] })
  const out = renderRepo(view)
  for (const re of SECRET_PATTERNS) assert.doesNotMatch(out, re, String(re))
})

test('repo and change names are never redacted, even when they look like a secret', () => {
  const out = render(changeItem({ change: 'sk-live1' }), null, ctx({ repo: 'ghp_repo' }))
  assert.match(out, /^title: ghp_repo — sk-live1$/m)
  assert.equal(fm(out).change, 'sk-live1')
  assert.equal(fm(out).repo, 'ghp_repo')
  assert.equal(notePath('ghp_repo', 'sk-live1'), 'Changes/ghp_repo--sk-live1.md')
  const view = repoView({ items: [{ change: 'sk-live1', state: 'queued', needsMe: false, lastActivity: null }] })
  assert.ok(sectionBody(renderRepo(view, null, repoCtx({ repo: 'ghp_repo' })), 'Changes').includes('[[ghp_repo--sk-live1]]'))
})

test('a change named risk-model renders to Changes/<repo>--risk-model.md unredacted', () => {
  assert.equal(notePath('katipon', 'risk-model'), 'Changes/katipon--risk-model.md')
  assert.equal(fm(render(changeItem({ change: 'risk-model' }))).change, 'risk-model')
})

test('bytes a human wrote into a preserved section are copied as they are, not redacted', () => {
  const first = render()
  const typed = first.replace('## Next\n', '## Next\n\n- [ ] rotate ghp_abc123 today\n')
  const out = render(changeItem(), typed)
  assert.equal(sectionBody(out, 'Next'), sectionBody(typed, 'Next'))
  assert.match(sectionBody(out, 'Next'), /ghp_abc123/)
})

// --- review note -------------------------------------------------------------

const reviewView = (over = {}) => ({
  stale: [{ repo: 'katipon', change: 'add-login', state: 'spec-draft', idleDays: 21 }],
  drift: { unarchived: { total: 2, observed: 3 }, broken: { total: 2, observed: 2 }, aging: { total: 5, observed: 3 }, repos: 3 },
  ...over,
})

test('the review note: frontmatter in order, the Stale embed, then a Drift section', () => {
  const out = renderReview(reviewView(), { today: '2026-11-15' })
  assert.deepEqual(keys(out), ['title', 'created', 'updated', 'type', 'status', 'tags', 'dial_schema'])
  const f = fm(out)
  assert.equal(f.title, 'Dial Review 2026-11-15')
  assert.equal(f.created, '2026-11-15')
  assert.equal(f.updated, '2026-11-15')
  assert.equal(f.type, 'note')
  assert.equal(f.status, 'inbox')
  assert.equal(f.tags, '[dial]')
  assert.equal(f.dial_schema, 'dial.review/1')
  assert.ok(out.indexOf('![[Dial.base#Stale]]') > 0)
  assert.ok(out.indexOf('![[Dial.base#Stale]]') < out.indexOf('## Drift'))
})

test('each stale item gets a heading and exactly three unticked checkboxes', () => {
  const out = renderReview(reviewView(), { today: '2026-11-15' })
  const lines = out.split('\n')
  const at = lines.indexOf('### [[katipon--add-login]] · spec-draft · 21d')
  assert.ok(at > 0)
  const boxes = []
  for (let i = at + 1; i < lines.length && !lines[i].startsWith('#'); i++) if (lines[i].startsWith('- [')) boxes.push(lines[i])
  assert.deepEqual(boxes, [
    '- [ ] archive: `openspec archive add-login` in katipon',
    '- [ ] drop: `dial drop katipon add-login`',
    '- [ ] re-spec: `/interlock:spec add-login`',
  ])
})

test('a vault with no stale item says so and has no checkbox', () => {
  const out = renderReview(reviewView({ stale: [] }), { today: '2026-11-15' })
  assert.match(out, /^No stale items\.$/m)
  assert.doesNotMatch(out, /- \[ \]/)
})

test('the review drift totals carry their denominator', () => {
  const drift = out => out.slice(out.indexOf('## Drift')).split('\n').map(l => l.trim()).filter(l => l.startsWith('- '))
  assert.deepEqual(drift(renderReview(reviewView(), { today: '2026-11-15' })), [
    '- unarchived: 2 (3 of 3 repos)',
    '- broken: 2 (2 of 3 repos)',
    '- aging: 5 (3 of 3 repos)',
  ])
})
