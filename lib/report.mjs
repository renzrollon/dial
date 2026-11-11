/**
 * `dial report` and `dial review --week` (specs/report). `report` is read-only: change and repo notes of every
 * registered vault, `<home>/logs/sync.jsonl`, the daily `## Log` lines and `<home>/eval/labels.jsonl`, each
 * indicator printed with its denominator or `{ unobserved: <reason> }`. `reviewWeek` writes one
 * `Inbox/Dial Review YYYY-MM-DD.md` per vault through the vault boundary and never rewrites an existing one.
 *
 * Lib functions return data or `{ ok: false, reason }` with a bare reason (the CLI prefixes `dial: `).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { STATES } from './facts.mjs'
import { readFrontmatter } from './frontmatter.mjs'
import { resolveHome } from './home.mjs'
import { headingName, localDate, narrativeEntries, splitNote } from './note.mjs'
import { expandHome } from './registry.mjs'
import { renderReview } from './render.mjs'
import { applyWrites } from './vault.mjs'

const DAY = 86_400_000
const WINDOW = 28
const SOURCES = Object.freeze(['/dial:handoff', 'local model', 'other', 'none'])
const BASELINE = /^- (\d{2}):(\d{2}) baseline · reorient (\d+)m · lookups (\d+)\s*$/

const asDate = now => (now instanceof Date ? now : now ? new Date(now) : new Date())
const vaultPathOf = (registry, name) => resolve(expandHome(registry.vaults[name]))

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR') return null
    throw err
  }
}

function listMd(dir) {
  try {
    return readdirSync(dir).filter(n => n.endsWith('.md') && !n.startsWith('.')).sort()
  } catch {
    return []
  }
}

/** The local date `n` days after `date` (YYYY-MM-DD), by calendar arithmetic. */
function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number)
  return localDate(new Date(y, m - 1, d + n))
}

// --- reading the vaults -----------------------------------------------------------

/**
 * Every Dial note of the registry's vaults: `{ changes, repos, daily, vaults }`. A change or repo note is
 * `{ vault, rel, name, frontmatter, narrative }` when its `dial_schema` is `dial.change/1` or `dial.repo/1`; `daily`
 * is `[{ date, lines }]` of each `Daily/YYYY-MM-DD.md`'s `## Log` section.
 */
export function readVaults(registry) {
  const out = { changes: [], repos: [], daily: [], vaults: Object.keys(registry.vaults ?? {}).sort() }
  for (const vault of out.vaults) {
    const root = vaultPathOf(registry, vault)
    for (const [dir, schema, into] of [['Changes', 'dial.change/1', out.changes], ['Projects', 'dial.repo/1', out.repos]]) {
      for (const n of listMd(join(root, dir))) {
        const text = readText(join(root, dir, n))
        if (text === null) continue
        const parts = splitNote(text)
        const frontmatter = readFrontmatter(parts.frontmatter) ?? {}
        if (frontmatter.dial_schema !== schema) continue
        const section = name => parts.sections.find(s => headingName(s.heading) === name)
        into.push({
          vault, rel: `${dir}/${n}`, name: n.slice(0, -3), frontmatter,
          narrative: narrativeEntries(section('Narrative')), drift: String(section('Drift')?.body ?? ''),
        })
      }
    }
    for (const n of listMd(join(root, 'Daily'))) {
      const date = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(n)?.[1]
      const text = date ? readText(join(root, 'Daily', n)) : null
      if (text === null) continue
      const log = splitNote(text).sections.find(s => headingName(s.heading) === 'Log')
      out.daily.push({ date, lines: String(log?.body ?? '').split('\n') })
    }
  }
  return out
}

const noNotes = vaults => `no Dial change notes (0 of ${vaults} vaults)`

// --- indicators ---------------------------------------------------------------------

function itemsByState(changes, vaults) {
  if (!changes.length) return { unobserved: noNotes(vaults) }
  const counts = {}
  for (const c of changes) {
    const state = c.frontmatter.state || 'unobserved'
    counts[state] = (counts[state] ?? 0) + 1
  }
  const order = [...STATES, 'unobserved']
  const keys = Object.keys(counts).sort((a, b) => {
    const ai = order.indexOf(a)
    const bi = order.indexOf(b)
    return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi) || (a < b ? -1 : 1)
  })
  return { total: changes.length, counts: Object.fromEntries(keys.map(k => [k, counts[k]])) }
}

/** Whole days from an ISO `last_activity` to `now`, or null when it is not observed. */
export function idleDays(lastActivity, now) {
  const t = Date.parse(lastActivity ?? '')
  return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / DAY)
}

function medianIdle(changes, now) {
  const idle = changes
    .filter(c => c.frontmatter.state !== 'archived' && c.frontmatter.state !== 'dropped')
    .map(c => idleDays(c.frontmatter.last_activity, now))
    .filter(v => v !== null)
    .sort((a, b) => a - b)
  if (!idle.length) return { unobserved: `no last_activity in change notes (0 of ${changes.length} items)` }
  const mid = idle.length >> 1
  const median = idle.length % 2 ? idle[mid] : (idle[mid - 1] + idle[mid]) / 2
  return { median, observed: idle.length, total: changes.length }
}

function needsMePerDay(home, now) {
  const path = join(home, 'logs', 'sync.jsonl')
  const text = readText(path)
  if (text === null) return { unobserved: `no sync log at ${path}`, total: WINDOW }
  const today = localDate(now)
  const days = Array.from({ length: WINDOW }, (_, i) => addDays(today, i - (WINDOW - 1)))
  const last = new Map()
  const entries = text.split('\n').flatMap(line => {
    try {
      const v = JSON.parse(line)
      return v && typeof v === 'object' && !Number.isNaN(Date.parse(v.ts)) && Number.isInteger(v.needsMe) ? [v] : []
    } catch {
      return []
    }
  })
  entries.map((v, i) => ({ v, i })).sort((a, b) => Date.parse(a.v.ts) - Date.parse(b.v.ts) || a.i - b.i).forEach(({ v }) => {
    last.set(`${localDate(new Date(v.ts))}\0${v.vault}\0${v.repo}`, v.needsMe)
  })
  const sums = new Map()
  for (const [key, n] of last) {
    const day = key.slice(0, key.indexOf('\0'))
    sums.set(day, (sums.get(day) ?? 0) + n)
  }
  const list = days.map(date => ({ date, needsMe: sums.has(date) ? sums.get(date) : null }))
  return { days: list, observed: list.filter(d => d.needsMe !== null).length, total: WINDOW }
}

function baselineWeeks(daily, now) {
  const rows = []
  for (const { date, lines } of daily) {
    for (const line of lines) {
      const m = BASELINE.exec(line)
      if (m) rows.push({ date, reorient: Number(m[3]), lookups: Number(m[4]) })
    }
  }
  const week = (from, to) => {
    const within = rows.filter(r => r.date >= from && r.date <= to)
    const base = { from, to, total: 7 }
    if (!within.length) return { ...base, unobserved: 'no baseline lines', observed: 0 }
    return {
      ...base,
      reorientMinutes: Math.round(within.reduce((s, r) => s + r.reorient, 0) / within.length),
      lookups: within.reduce((s, r) => s + r.lookups, 0),
      observed: new Set(within.map(r => r.date)).size,
    }
  }
  const today = localDate(now)
  const start = rows.map(r => r.date).sort()[0]
  return {
    baseline: start ? week(start, addDays(start, 6)) : { unobserved: 'no baseline lines', observed: 0, total: 7 },
    current: week(addDays(today, -6), today),
  }
}

/** The class of a change note's newest narrative entry. */
export function sourceClass(entry) {
  if (!entry) return 'none'
  if (entry.source.startsWith('/dial:handoff')) return '/dial:handoff'
  if (entry.source.startsWith('local model')) return 'local model'
  return 'other'
}

function narrativeSources(changes, vaults) {
  if (!changes.length) return { unobserved: noNotes(vaults) }
  const counts = Object.fromEntries(SOURCES.map(s => [s, 0]))
  for (const c of changes) {
    let newest = null
    for (const e of c.narrative) if (!newest || Date.parse(e.at) >= Date.parse(newest.at)) newest = e
    counts[sourceClass(newest)]++
  }
  return { total: changes.length, counts }
}

function narrativeQuality(home) {
  const path = join(home, 'eval', 'labels.jsonl')
  const text = readText(path)
  if (text === null) return { unobserved: `no labels at ${path}` }
  const rows = text.split('\n').flatMap(line => {
    try {
      const v = JSON.parse(line)
      return v && typeof v === 'object' ? [v] : []
    } catch {
      return []
    }
  })
  if (!rows.length) return { unobserved: `no label rows in ${path}` }
  return {
    total: rows.length,
    nextCorrect: rows.filter(r => r.nextCorrect === true).length,
    nothingInvented: rows.filter(r => r.nothingInvented === true).length,
  }
}

/**
 * The indicators. `opts = { registry, home?, env?, now? }`. Returns `{ ok: true, report: { itemsByState, medianIdleDays,
 * needsMePerDay, baseline, narrativeSources, narrativeQuality } }`; every value holds its counts and denominator or
 * `{ unobserved }`. Creates, modifies and deletes nothing, the home included.
 */
export function report({ registry, home, env = process.env, now = new Date() }) {
  const at = asDate(now)
  const root = home ?? resolveHome(env)
  const data = readVaults(registry)
  const vaults = data.vaults.length
  return {
    ok: true,
    report: {
      itemsByState: itemsByState(data.changes, vaults),
      medianIdleDays: medianIdle(data.changes, at),
      needsMePerDay: needsMePerDay(root, at),
      baseline: baselineWeeks(data.daily, at),
      narrativeSources: narrativeSources(data.changes, vaults),
      narrativeQuality: narrativeQuality(root),
    },
  }
}

/** The printed form of `report().report`, no trailing newline. */
export function formatReport(r) {
  const out = []
  const items = r.itemsByState
  if (items.unobserved) out.push(`items by state: unobserved: ${items.unobserved}`)
  else {
    out.push('items by state:')
    for (const [state, n] of Object.entries(items.counts)) out.push(`  ${state} ${n} of ${items.total}`)
  }
  const idle = r.medianIdleDays
  out.push(idle.unobserved ? `median idle days: unobserved: ${idle.unobserved}` : `median idle days: ${idle.median} (${idle.observed} of ${idle.total} items)`)
  const nm = r.needsMePerDay
  if (nm.unobserved) out.push(`needs me per day: unobserved: ${nm.unobserved} (0 of ${nm.total} days)`)
  else {
    out.push(`needs me per day (${nm.observed} of ${nm.total} days observed)`)
    for (const d of nm.days) out.push(`  ${d.date} ${d.needsMe === null ? 'unobserved: no sync that day' : d.needsMe}`)
  }
  const week = (label, w) => {
    const range = w.from ? ` ${w.from}..${w.to}` : ''
    const body = w.unobserved ? `unobserved: ${w.unobserved}` : `reorient ${w.reorientMinutes}m · lookups ${w.lookups}`
    return `${label}${range}: ${body} (${w.observed} of ${w.total} days)`
  }
  out.push(week('baseline week', r.baseline.baseline), week('current week', r.baseline.current))
  const src = r.narrativeSources
  if (src.unobserved) out.push(`narrative sources: unobserved: ${src.unobserved}`)
  else {
    out.push('narrative sources:')
    for (const [name, n] of Object.entries(src.counts)) out.push(`  ${name} ${n} of ${src.total}`)
  }
  const q = r.narrativeQuality
  out.push(q.unobserved
    ? `narrative quality: unobserved: ${q.unobserved}`
    : `narrative quality: nextCorrect ${q.nextCorrect} of ${q.total} · nothingInvented ${q.nothingInvented} of ${q.total}`)
  return out.join('\n')
}

// --- review -------------------------------------------------------------------------

/** The `## Drift` totals of a vault's repo notes: `{ unarchived|broken|aging: { total, observed }, repos }`. */
function driftTotals(repos) {
  const out = { repos: repos.length }
  for (const key of ['unarchived', 'broken', 'aging']) {
    let total = 0
    let observed = 0
    for (const r of repos) {
      const m = new RegExp(`^- ${key}: (\\d+)\\s*$`, 'm').exec(r.drift)
      if (m) {
        total += Number(m[1])
        observed++
      }
    }
    out[key] = observed ? { total, observed } : { observed }
  }
  return out
}

const isTrue = v => v === 'true' || v === true

/**
 * Write `Inbox/Dial Review YYYY-MM-DD.md` (local date) into each registered vault that holds `Projects/` or `Changes/`;
 * an existing one for the day is left byte for byte. `opts = { registry, now?, limits? }`.
 * Returns `{ ok, failed, results: [{ vault, path?, verb, line, reason? }] }`, `verb` one of `create`, `unchanged`, `skipped`, `failed`
 * and `line` the printed form (`created <path>`, `unchanged <path>`, `skipped <vault>: no Dial notes`).
 */
export function reviewWeek({ registry, now = new Date(), warn }) {
  const at = asDate(now)
  const today = localDate(at)
  const data = readVaults(registry)
  const results = []
  for (const vault of data.vaults) {
    const root = vaultPathOf(registry, vault)
    if (!existsSync(join(root, 'Projects')) && !existsSync(join(root, 'Changes'))) {
      results.push({ vault, verb: 'skipped', line: `skipped ${root}: no Dial notes` })
      continue
    }
    const stale = data.changes
      .filter(c => c.vault === vault && isTrue(c.frontmatter.stale))
      .map(c => ({ repo: c.frontmatter.repo, change: c.frontmatter.change, state: c.frontmatter.state || 'unobserved', idleDays: idleDays(c.frontmatter.last_activity, at) }))
    const text = renderReview({ stale, drift: driftTotals(data.repos.filter(r => r.vault === vault)) }, { today })
    const rel = `Inbox/Dial Review ${today}.md`
    const applied = applyWrites(root, [{ path: rel, render: existing => (existing === null ? text : existing) }], { registry, vault, warn })
    if (!applied.ok) {
      results.push({ vault, verb: 'failed', reason: applied.reason, line: `${root}: ${applied.reason}` })
      continue
    }
    const [{ verb, path }] = applied.results
    results.push({ vault, path, verb, line: verb === 'create' ? `created ${path}` : `${verb} ${path}` })
  }
  const failed = results.filter(r => r.verb === 'failed').length
  return { ok: failed === 0, failed, results }
}
