/**
 * The renderers (design.md §Notes, specs/note-rendering). Pure: every function
 * takes data and returns text; the date is `ctx.today`, never a clock read.
 * Every string Dial authors passes `redact`; bytes a human wrote into a
 * preserved section are copied as they are; repo and change names are never
 * redacted (D57, D63, D84).
 */
import { STATES, isUnobserved, noteName, sanitizeName } from './facts.mjs'
import { readFrontmatter } from './frontmatter.mjs'
import {
  formatValue, frontmatterEntries, headingName, localDate, localTime, splitNote,
} from './note.mjs'

export { noteName, sanitizeName }

export const STATE_HEADING = 'State  <!-- dial:generated, do not edit -->'
const DASH = '—'

/** `Changes/<repo>--<change>.md`, or `Projects/<repo>.md` without a change. */
export function notePath(repo, change) {
  return change === undefined || change === null
    ? `Projects/${noteName(repo)}.md`
    : `Changes/${noteName(repo, change)}.md`
}

// --- redaction ----------------------------------------------------------------

const WORD_END = "[^\\s,;'\"()<>\\[\\]{}|`]*"
const PREFIX = new RegExp(`(^|[^A-Za-z0-9_-])(?:ghp_|glpat-|sk-|AKIA)${WORD_END}`, 'g')
const BEARER = /(^|[^A-Za-z0-9_-])Bearer\s+\S+/g
const EXPORT = /(^|[^A-Za-z0-9_-])export\s+[A-Za-z_][A-Za-z0-9_]*=\S*/g
const ASSIGN = /\S*(?:password=|token=)\S*/gi
const LINE = /^.*(?:-----BEGIN|diff --git).*$/gm
const R = '[redacted]'

/**
 * Replace every secret-shaped string with `[redacted]`. Occurrences of the names in `keep`
 * (the repo and change names) are left alone so a note's name always matches its change.
 */
export function redact(text, keep = []) {
  if (text === undefined || text === null) return text
  let s = String(text)
  const names = [...new Set(keep.filter(n => typeof n === 'string' && n.length))].sort((a, b) => b.length - a.length)
  names.forEach((name, i) => { s = s.split(name).join(`\u0000${i}\u0000`) })
  s = s
    .replace(LINE, R)
    .replace(BEARER, (_, lead) => `${lead}${R}`)
    .replace(EXPORT, (_, lead) => `${lead}${R}`)
    .replace(ASSIGN, R)
    .replace(PREFIX, (_, lead) => `${lead}${R}`)
  names.forEach((name, i) => { s = s.split(`\u0000${i}\u0000`).join(name) })
  return s
}

// --- shared note machinery ------------------------------------------------------

/** A table cell: one line, pipes escaped, empty as an em dash. */
function cell(v) {
  if (v === undefined || v === null || v === '') return DASH
  return String(v).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
}

/** A frontmatter value for a fact leaf: `unobserved`, `none` for an observed absence or null, else the value. */
function leafValue(f) {
  if (f === undefined || isUnobserved(f)) return 'unobserved'
  const v = f.value
  if (v === null || v === undefined || v === 'absent' || v === '') return 'none'
  return v
}

function dateOrDash(iso) {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? DASH : localDate(new Date(t))
}

const stateIndex = s => {
  const i = STATES.indexOf(s)
  return i === -1 ? STATES.length : i
}
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function stateTable(state, evidence, rows, keep) {
  const lines = ['| fact | value | evidence |', '| --- | --- | --- |', `| state | ${cell(state)} | ${cell(redact(evidence, keep))} |`]
  for (const r of rows ?? []) lines.push(`| ${cell(r.fact)} | ${cell(redact(r.value, keep))} | ${cell(redact(r.evidence, keep))} |`)
  return `\n${lines.join('\n')}\n`
}

/**
 * Render a note from Dial's keys and generated sections over the existing text (or null).
 * `build({ created, updated, prior })` returns `{ keys: [[key, value]], generated: [{ heading, body }] }`;
 * `owned` is every key Dial rewrites; `generatedNames` the section names Dial replaces.
 * `updated` is decided here (D79): render with the existing value, keep those bytes when they
 * equal the file, else render again with `today`.
 */
function renderNote(existing, today, owned, generatedNames, build) {
  const parts = typeof existing === 'string' ? splitNote(existing) : null
  const prior = parts ? readFrontmatter(parts.frontmatter) ?? {} : {}
  const entries = parts ? frontmatterEntries(parts.frontmatter) : []
  const priorRaw = new Map(entries.filter(e => e.key).map(e => [e.key, e.lines]))
  const created = prior.created || today

  const once = updated => {
    const { keys, generated } = build({ created, updated, prior })
    const fm = []
    for (const [key, value] of keys) {
      if (value === undefined || value === null) continue
      if (key === 'aliases' && priorRaw.has('aliases')) fm.push(...priorRaw.get('aliases'))
      else fm.push(`${key}: ${formatValue(value)}`)
    }
    for (const e of entries) if (e.key === null || !owned.has(e.key)) fm.push(...e.lines)

    let next = '\n'
    let narrative = '\n'
    const human = []
    let sawNext = false
    let sawNarrative = false
    for (const s of parts?.sections ?? []) {
      const name = headingName(s.heading)
      if (name === 'Next' && !sawNext) { sawNext = true; next = s.body }
      else if (name === 'Narrative' && !sawNarrative) { sawNarrative = true; narrative = s.body }
      else if (!generatedNames.has(name)) human.push(s)
    }
    const sections = [{ heading: 'Next', body: next }, { heading: 'Narrative', body: narrative }, ...human, ...generated]
    let out = `---\n${fm.join('\n')}\n---\n${parts ? parts.preamble : '\n'}`
    if (!out.endsWith('\n')) out += '\n'
    for (const s of sections) {
      out += `## ${s.heading}\n${s.body}`
      if (!out.endsWith('\n')) out += '\n'
    }
    return out
  }

  if (parts && prior.updated) {
    const same = once(prior.updated)
    if (same === existing) return same
  }
  return once(today)
}

// --- change note ----------------------------------------------------------------

const CHANGE_KEYS = [
  'title', 'type', 'repo', 'change', 'scope', 'state', 'needs_me', 'stale', 'branch', 'pr', 'pr_state', 'ci',
  'merge_verdict', 'tasks_done', 'tasks_total', 'last_commit', 'last_session', 'last_activity', 'created',
  'updated', 'status', 'tags', 'aliases', 'dial_schema', 'dropped', 'archived',
]
const CHANGE_OWNED = new Set(CHANGE_KEYS)
const CHANGE_GENERATED = new Set(['State'])

/**
 * The change note's final text. `item` is a derive item; `existing` the file's text or null;
 * `ctx = { repo, scope, today, dropped?, archived? }` (the last two set by drop and the archive move).
 */
export function renderChangeNote(item, existing, ctx) {
  const { repo, scope, today } = ctx
  const keep = [repo, item.change]
  const fv = f => {
    const v = leafValue(f)
    return typeof v === 'string' ? redact(v, keep) : v
  }
  return renderNote(existing, today, CHANGE_OWNED, CHANGE_GENERATED, ({ created, updated, prior }) => {
    const dropped = prior.dropped || ctx.dropped || undefined
    const archived = prior.archived || ctx.archived || undefined
    return {
      keys: [
        ['title', `${repo} — ${item.change}`],
        ['type', 'change'],
        ['repo', repo],
        ['change', item.change],
        ['scope', scope],
        ['state', item.state],
        ['needs_me', !!item.needsMe],
        ['stale', !!item.stale],
        ['branch', fv(item.branch)],
        ['pr', fv(item.pr)],
        ['pr_state', fv(item.prState)],
        ['ci', fv(item.ci)],
        ['merge_verdict', fv(item.mergeVerdict)],
        ['tasks_done', fv(item.tasksDone)],
        ['tasks_total', fv(item.tasksTotal)],
        ['last_commit', fv(item.lastCommit)],
        ['last_session', fv(item.lastSession)],
        ['last_activity', item.lastActivity ?? 'unobserved'],
        ['created', created],
        ['updated', updated],
        ['status', archived ? 'archived' : 'active'],
        ['tags', ['dial']],
        ['aliases', []],
        ['dial_schema', 'dial.change/1'],
        ['dropped', dropped],
        ['archived', archived],
      ],
      generated: [{ heading: STATE_HEADING, body: stateTable(item.state, item.evidence, item.rows, keep) }],
    }
  })
}

// --- repo note ------------------------------------------------------------------

const REPO_KEYS = [
  'title', 'type', 'repo', 'scope', 'state', 'needs_me', 'stale', 'branch', 'dirty', 'stash', 'ahead', 'behind',
  'worktrees', 'last_commit', 'last_session', 'last_activity', 'active_changes', 'created', 'updated', 'status',
  'tags', 'aliases', 'dial_schema', 'archived',
]
const REPO_OWNED = new Set(REPO_KEYS)
const REPO_GENERATED = new Set(['Changes', 'Drift', 'Recent narrative', 'State'])

function changesBody(repo, items) {
  if (!items?.length) return '\nNo changes.\n\n'
  const sorted = [...items].sort((a, b) => stateIndex(a.state) - stateIndex(b.state) || byName(a.change, b.change))
  const lines = ['| change | state | needs_me | last activity |', '| --- | --- | --- | --- |']
  for (const i of sorted) {
    lines.push(`| [[${noteName(repo, i.change)}]] | ${cell(i.state)} | ${!!i.needsMe} | ${dateOrDash(i.lastActivity)} |`)
  }
  return `\n${lines.join('\n')}\n\n`
}

function driftBody(drift, keep) {
  if (drift === undefined || isUnobserved(drift)) return `\n${redact(`unobserved: ${drift?.unobserved ?? 'no drift fact'}`, keep)}\n\n`
  const v = drift.value ?? {}
  const count = f => (f === undefined || isUnobserved(f) ? `unobserved: ${f?.unobserved ?? 'no fact'}` : String(f.value))
  const unarchived = Array.isArray(v.unarchived) ? v.unarchived.length : 'unobserved: no unarchived list'
  return `\n${[`- unarchived: ${unarchived}`, `- broken: ${count(v.broken)}`, `- aging: ${count(v.aging)}`].map(l => redact(l, keep)).join('\n')}\n\n`
}

function recentBody(repo, entries, keep) {
  const list = [...(entries ?? [])]
    .filter(e => !Number.isNaN(Date.parse(e.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || byName(a.change, b.change))
    .slice(0, 3)
  if (!list.length) return '\nNo narrative yet.\n\n'
  let out = '\n'
  for (const e of list) {
    const at = new Date(Date.parse(e.at))
    out += `### ${localDate(at)} ${localTime(at)} · ${redact(e.source ?? 'unknown', keep)} · [[${noteName(repo, e.change)}]]\n\n`
    const body = redact(String(e.body ?? '').trim(), keep)
    if (body) out += `${body}\n\n`
  }
  return out
}

/**
 * The repo note's final text. `view` is derive's repo item; `ctx = { repo, scope, today, facts, recentNarrative }`.
 */
export function renderRepoNote(view, existing, ctx) {
  const { repo, scope, today, facts = {} } = ctx
  const keep = [repo, ...(view.items ?? []).map(i => i.change)]
  const git = facts.git ?? {}
  const fv = f => {
    const v = leafValue(f)
    return typeof v === 'string' ? redact(v, keep) : v
  }
  const mapLeaf = (f, fn) => (f === undefined || isUnobserved(f) || f.value === null ? f : { value: fn(f.value), evidence: f.evidence })
  const worktrees = mapLeaf(git.worktrees, v => (Array.isArray(v) ? v.length : v))
  const lastCommit = mapLeaf(git.lastCommit, v => (v && typeof v === 'object' ? v.sha7 : v))
  const lastSession = mapLeaf(facts.sessions?.lastSession, v => (v && typeof v === 'object' ? v.mtime : v))
  const active = (view.items ?? []).filter(i => i.state !== 'archived').length
  const recent = ctx.recentNarrative ?? view.recentNarrative ?? []

  return renderNote(existing, today, REPO_OWNED, REPO_GENERATED, ({ created, updated, prior }) => {
    const archived = prior.archived || ctx.archived || undefined
    return {
      keys: [
        ['title', repo],
        ['type', 'repo'],
        ['repo', repo],
        ['scope', scope],
        ['state', view.state],
        ['needs_me', !!view.needsMe],
        ['stale', !!view.stale],
        ['branch', fv(git.branch)],
        ['dirty', fv(git.dirty)],
        ['stash', fv(git.stash)],
        ['ahead', fv(git.ahead)],
        ['behind', fv(git.behind)],
        ['worktrees', fv(worktrees)],
        ['last_commit', fv(lastCommit)],
        ['last_session', fv(lastSession)],
        ['last_activity', view.lastActivity ?? 'unobserved'],
        ['active_changes', active],
        ['created', created],
        ['updated', updated],
        ['status', archived ? 'archived' : 'active'],
        ['tags', ['dial']],
        ['aliases', []],
        ['dial_schema', 'dial.repo/1'],
        ['archived', archived],
      ],
      generated: [
        { heading: 'Changes', body: changesBody(repo, view.items) },
        { heading: 'Drift', body: driftBody(facts.interlock?.drift, keep) },
        { heading: 'Recent narrative', body: recentBody(repo, recent, keep) },
        { heading: STATE_HEADING, body: stateTable(view.state, view.evidence, view.rows, keep) },
      ],
    }
  })
}

// --- summary, daily line, review, base -----------------------------------------------

/**
 * `Dial Summary.md`: the needs-me items of every registered repo's note, as short bullets.
 * `notes = [{ name, frontmatter }]`; `ctx = { registered: string[], nextRows }`.
 */
export function renderSummary(notes, ctx) {
  const registered = new Set(ctx.registered ?? [])
  const cap = Number.isInteger(ctx.nextRows) && ctx.nextRows > 0 ? ctx.nextRows : Infinity
  const items = (notes ?? [])
    .filter(n => n?.frontmatter && registered.has(n.frontmatter.repo))
    .filter(n => n.frontmatter.needs_me === 'true' || n.frontmatter.needs_me === true)
    .map(n => ({ name: n.name, state: n.frontmatter.state, t: Date.parse(n.frontmatter.last_activity), last: n.frontmatter.last_activity }))
    .sort((a, b) => {
      const s = stateIndex(a.state) - stateIndex(b.state)
      if (s) return s
      const an = Number.isNaN(a.t)
      const bn = Number.isNaN(b.t)
      if (an !== bn) return an ? 1 : -1
      if (!an && a.t !== b.t) return a.t - b.t
      return byName(a.name, b.name)
    })
  const lines = [`Needs me: ${items.length}`]
  const shown = items.slice(0, cap)
  if (shown.length) lines.push('')
  for (const i of shown) lines.push(`- [[${i.name}]] · ${redact(i.state ?? 'unobserved')} · ${dateOrDash(i.last)}`)
  if (items.length > shown.length) lines.push(`- … and ${items.length - shown.length} more`)
  return `---\ntype: note\ntags: [dial]\ndial_schema: dial.summary/1\n---\n\n${lines.join('\n')}\n`
}

/**
 * One daily `## Log` line, no newline. `event = { kind: 'transition' | 'handoff', repo, change?,
 * from?, to?, detail?, source?, at }`; times are local (D37).
 */
export function renderDailyLine(event, _ctx) {
  const at = event.at instanceof Date ? event.at : new Date(event.at)
  const keep = [event.repo, event.change]
  const hasChange = event.change !== undefined && event.change !== null
  const who = hasChange ? `${event.repo}/${event.change}` : event.repo
  const link = `[[${noteName(event.repo, hasChange ? event.change : undefined)}]]`
  const head = `- ${localTime(at)} dial · ${who}:`
  if (event.kind === 'handoff') return `${head} handoff (${redact(event.source ?? 'dial handoff', keep)}) ${link}`
  const detail = event.detail === undefined || event.detail === null || event.detail === '' ? '' : ` (${redact(event.detail, keep)})`
  return `${head} ${event.from} → ${event.to}${detail} ${link}`
}

/**
 * The weekly review note (specs/report). `view = { stale: [{ repo, change, state, idleDays }],
 * drift: { unarchived|broken|aging: { total, observed }, repos } }`; `ctx = { today }`.
 */
export function renderReview(view, ctx) {
  const { today } = ctx
  const fm = [
    ['title', `Dial Review ${today}`], ['created', today], ['updated', today], ['type', 'note'],
    ['status', 'inbox'], ['tags', ['dial']], ['dial_schema', 'dial.review/1'],
  ].map(([k, v]) => `${k}: ${formatValue(v)}`)
  const out = [`---\n${fm.join('\n')}\n---\n`, '![[Dial.base#Stale]]', '', '## Stale items', '']
  const stale = [...(view.stale ?? [])].sort((a, b) => byName(a.repo, b.repo) || byName(a.change, b.change))
  if (!stale.length) out.push('No stale items.', '')
  for (const s of stale) {
    const idle = Number.isInteger(s.idleDays) ? `${s.idleDays}d` : DASH
    out.push(
      `### [[${noteName(s.repo, s.change)}]] · ${s.state} · ${idle}`,
      '',
      `- [ ] archive: \`openspec archive ${s.change}\` in ${s.repo}`,
      `- [ ] drop: \`dial drop ${s.repo} ${s.change}\``,
      `- [ ] re-spec: \`/interlock:spec ${s.change}\``,
      '',
    )
  }
  out.push('## Drift', '')
  const d = view.drift ?? {}
  const repos = Number.isInteger(d.repos) ? d.repos : 0
  for (const key of ['unarchived', 'broken', 'aging']) {
    const t = d[key] ?? {}
    const total = Number.isInteger(t.total) ? t.total : 'unobserved'
    const observedCount = Number.isInteger(t.observed) ? t.observed : 0
    out.push(`- ${key}: ${total} (${observedCount} of ${repos} repos)`)
  }
  return `${out.join('\n')}\n`
}

/** `Dial.base`: four views over `type == "change"`, the kanban's groupOrder generated from STATES. */
export function renderBase() {
  return [
    'filters:',
    '  and:',
    '    - type == "change"',
    'views:',
    '  - name: Needs me',
    '    type: kanban',
    '    filters:',
    '      and:',
    '        - needs_me == true',
    '        - state != "archived"',
    '    groupBy:',
    '      property: note.state',
    '      direction: ASC',
    `    groupOrder: [${STATES.join(', ')}]`,
    '    order:',
    '      - file.name',
    '      - repo',
    '      - state',
    '      - last_activity',
    '  - name: In flight',
    '    type: table',
    `    filters: 'state == "queued" || state == "shipping"'`,
    '    order:',
    '      - file.name',
    '      - repo',
    '      - state',
    '      - last_activity',
    '  - name: Stale',
    '    type: table',
    '    filters:',
    '      and:',
    '        - stale == true',
    '    order:',
    '      - file.name',
    '      - repo',
    '      - state',
    '      - last_activity',
    '  - name: By repo',
    '    type: table',
    '    groupBy:',
    '      property: note.repo',
    '      direction: ASC',
    '    order:',
    '      - file.name',
    '      - state',
    '      - needs_me',
    '      - last_activity',
    '',
  ].join('\n')
}
