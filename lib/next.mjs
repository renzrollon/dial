/**
 * `dial next` (specs/next-and-brief): every item that needs the human, over every
 * registered repo, offline. The remote cache is read, never written, `git` is the only
 * subprocess, and nothing here writes a vault file, a cache file or a log line.
 */
import { collectRepo } from './collect.mjs'
import { derive } from './derive.mjs'
import { STATES } from './facts.mjs'
import { resolveHome } from './home.mjs'
import { LIMITS, effectiveLimits } from './limits.mjs'
import { expandHome, listRepos } from './registry.mjs'
import { notePath } from './render.mjs'
import { readNotes } from './vault.mjs'

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const stateIndex = state => {
  const i = STATES.indexOf(state)
  return i < 0 ? STATES.length : i
}

/**
 * Priority order shared by `next` and `brief`: the state table, then idle days descending
 * (an item with no observed activity after every observed one), then repo, then change.
 * Works on `{ state, idleDays, repo, change }`.
 */
export function compareItems(a, b) {
  const s = stateIndex(a.state) - stateIndex(b.state)
  if (s) return s
  const an = a.idleDays === null || a.idleDays === undefined
  const bn = b.idleDays === null || b.idleDays === undefined
  if (an !== bn) return an ? 1 : -1
  if (!an && a.idleDays !== b.idleDays) return b.idleDays - a.idleDays
  return byText(a.repo, b.repo) || byText(a.change ?? '', b.change ?? '')
}

/** The limits a registry resolves to; a registry that fails the check falls back to the defaults. */
export function registryLimits(registry) {
  const r = effectiveLimits(registry?.limits, '')
  return r.ok ? r.limits : LIMITS
}

/**
 * Facts, derived items and vault notes for one registered repo, offline.
 * @returns {{ facts: object, derived: { items: object[], repo: object }, notes: object }}
 */
export function repoView({ repo, registry, limits, env = process.env, now = new Date(), home, exec, excludeSession = null }) {
  const lim = limits ?? registryLimits(registry)
  const facts = collectRepo({
    repo, limits: lim, env, now, home: home ?? resolveHome(env), ...(exec ? { exec } : {}),
    remote: false, writeCache: false, runDrift: false, excludeSession,
  })
  let notes = {}
  const vaultPath = registry?.vaults?.[repo.vault]
  if (typeof vaultPath === 'string') {
    try {
      notes = readNotes(expandHome(vaultPath), repo.name)
    } catch {
      notes = {}
    }
  }
  return { facts, derived: derive(facts, { now, limits: lim, notes }), notes }
}

/**
 * Every needs-me item, ordered by vault name then priority, uncapped.
 * @param {{ registry: object, vault?: string|null, limits?: object, env?: object, now?: Date, home?: string, exec?: Function }} opts
 * @returns {{ ok: true, rows: object[] } | { ok: false, reason: string }}
 */
export function nextItems({ registry, vault = null, limits, env, now = new Date(), home, exec }) {
  if (vault !== null && vault !== undefined && !Object.hasOwn(registry?.vaults ?? {}, vault)) {
    return { ok: false, reason: `no vault named ${vault} in the registry` }
  }
  const rows = []
  for (const repo of listRepos(registry ?? { repos: [] })) {
    if (vault && repo.vault !== vault) continue
    const { derived } = repoView({ repo, registry, limits, env, now, home, exec })
    const take = (item, change) => {
      if (!item.needsMe) return
      rows.push({
        vault: repo.vault,
        repo: repo.name,
        change,
        state: item.state,
        stale: item.stale === true,
        idleDays: typeof item.idleDays === 'number' ? item.idleDays : null,
        evidence: item.evidence ?? null,
        suggested: item.suggested ?? null,
        note: notePath(repo.name, change),
      })
    }
    for (const item of derived.items) take(item, item.change)
    take(derived.repo, null)
  }
  rows.sort((a, b) => byText(a.vault, b.vault) || compareItems(a, b))
  return { ok: true, rows }
}

/**
 * The text of `dial next`, no trailing newline: a vault-name line per group, groups
 * separated by a blank line, at most `nextRows` rows, then `… and <n> more`.
 */
export function formatNext(rows, { nextRows = LIMITS.nextRows } = {}) {
  if (!rows.length) return 'nothing needs you'
  const shown = rows.slice(0, nextRows)
  const cell = r => `${r.state}${r.stale ? ' [stale]' : ''}`
  const width = Math.max(...shown.map(r => cell(r).length))
  const out = []
  let current = null
  for (const r of shown) {
    if (r.vault !== current) {
      if (current !== null) out.push('')
      out.push(r.vault)
      current = r.vault
    }
    const item = r.change === null ? r.repo : `${r.repo}/${r.change}`
    const idle = r.idleDays === null ? '—' : `${r.idleDays}d`
    out.push(`${cell(r).padEnd(width)} ${item}  ${idle}  ${r.evidence ?? '—'}  → ${r.suggested ?? '—'}`)
  }
  if (rows.length > shown.length) out.push(`… and ${rows.length - shown.length} more`)
  return out.join('\n')
}
