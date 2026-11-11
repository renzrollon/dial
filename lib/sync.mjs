/**
 * `sync` (design.md §Vault writes, specs/vault-writes, specs/note-rendering): one
 * repo or every registered repo, collect -> read notes -> derive -> render ->
 * plan -> apply, the daily lines for state transitions, the archive moves, the
 * `$DIAL_HOME/logs/sync.jsonl` line, and `Dial Summary.md` rebuilt from the
 * vault's own notes once per vault after the last repo.
 *
 * Lib functions return data or `{ ok: false, reason }` with a bare reason (the
 * CLI prefixes `dial: `). A `--dry-run` plans and writes nothing: no vault file,
 * no folder, no cache file, no log line, no home.
 */
import { appendFileSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { collectRepo } from './collect.mjs'
import { derive } from './derive.mjs'
import { noteName } from './facts.mjs'
import { readFrontmatter } from './frontmatter.mjs'
import { HomeUnwritable, ensureHome, resolveHome } from './home.mjs'
import { effectiveLimits } from './limits.mjs'
import { localDate, splitNote } from './note.mjs'
import { expandHome, listRepos, resolveRepo } from './registry.mjs'
import { dueRemote } from './remote.mjs'
import { notePath, renderChangeNote, renderDailyLine, renderRepoNote, renderSummary } from './render.mjs'
import { appendDaily, applyWrites, archiveNotes, planWrites, readNotes, setFrontmatter } from './vault.mjs'

const SUMMARY_PATH = 'Dial Summary.md'
const CHANGED = new Set(['create', 'update', 'append', 'move'])

const asDate = now => (now instanceof Date ? now : now ? new Date(now) : new Date())

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

const vaultPathOf = (registry, name) => resolve(expandHome(registry.vaults[name]))

/** The effective limits: the caller's, else the registry's over the defaults. */
function limitsOf(registry, given) {
  if (given) return { ok: true, limits: given }
  return effectiveLimits(registry.limits, 'registry.json')
}

/**
 * The state transitions a sync would log: a change whose note already exists, whose previous `state` and
 * new state are both observed and differ. A first creation (no note), a previous `unobserved` state and
 * a missing one are not transitions; the repo note's state is not looked at.
 * @param {import('./facts.mjs').NoteView} notes what the vault held before the sync
 * @param {{ change: string, state: string, evidence?: string|null }[]} items derive's change items
 * @param {string} repo the repo name
 * @returns {{ change: string, from: string, to: string, detail: string|null }[]}
 */
export function transitions(notes, items, repo) {
  const out = []
  for (const item of items) {
    const prior = notes?.[noteName(repo, item.change)]
    if (!prior) continue
    const from = prior.frontmatter?.state
    if (typeof from !== 'string' || from === '' || from === 'unobserved') continue
    if (typeof item.state !== 'string' || item.state === 'unobserved' || item.state === from) continue
    out.push({ change: item.change, from, to: item.state, detail: item.evidence ?? null })
  }
  return out
}

/** One `{ ts, vault, repo, needsMe, items }` line appended to `<home>/logs/sync.jsonl`; `{ ok: false, reason }` on failure. */
export function appendSyncLog(home, entry) {
  const file = join(home, 'logs', 'sync.jsonl')
  const line = JSON.stringify({ ts: entry.ts, vault: entry.vault, repo: entry.repo, needsMe: entry.needsMe, items: entry.items })
  try {
    appendFileSync(file, `${line}\n`)
    return { ok: true, path: file }
  } catch (err) {
    return { ok: false, reason: `cannot append to ${file}: ${err.code ?? err.message}` }
  }
}

// --- the summary ---------------------------------------------------------------

/** Every `Changes/*.md` and `Projects/*.md` of the vault as `{ rel, name, frontmatter }`, an `overlay` (rel -> text | null) laid over the disk. */
function summaryNotes(vaultPath, overlay) {
  const rels = new Set()
  for (const dir of ['Changes', 'Projects']) {
    let names = []
    try {
      names = readdirSync(join(vaultPath, dir))
    } catch {
      names = []
    }
    for (const n of names) if (n.endsWith('.md')) rels.add(`${dir}/${n}`)
  }
  for (const rel of overlay?.keys() ?? []) rels.add(rel)
  const out = []
  for (const rel of [...rels].sort()) {
    const text = overlay?.has(rel) ? overlay.get(rel) : readText(join(vaultPath, rel))
    if (text === null || text === undefined) continue
    out.push({ rel, name: rel.slice(rel.indexOf('/') + 1, -3), frontmatter: readFrontmatter(splitNote(text).frontmatter) ?? {} })
  }
  return out
}

/**
 * Rebuild `Dial Summary.md` for one vault from the frontmatter of its notes whose `repo` is registered to it.
 * With `dryRun`, `overlay` (the planned note texts of this run, `null` for a note moved away) stands in for what
 * the writes would have left on disk, so the printed verb is the one a real sync would use.
 * Returns `{ ok: true, vault, verb, path, line? }` or `{ ok: false, vault, reason }`.
 * @param {{ registry: object, vault: string, limits: object, dryRun?: boolean, overlay?: Map<string, string|null>, warn?: Function }} opts
 */
export function syncSummary({ registry, vault, limits, dryRun = false, overlay, warn }) {
  const vaultPath = vaultPathOf(registry, vault)
  const registered = listRepos(registry).filter(r => r.vault === vault).map(r => r.name)
  const text = renderSummary(summaryNotes(vaultPath, dryRun ? overlay : undefined), { registered, nextRows: limits.nextRows })
  const write = { path: SUMMARY_PATH, render: () => text }
  const ctx = { registry, vault, warn }
  if (dryRun) {
    const planned = planWrites(vaultPath, [write], ctx)
    if (!planned.ok) return { ok: false, vault, reason: planned.reason }
    const [p] = planned.plan
    return { ok: true, vault, verb: p.verb, path: p.path, line: p.line }
  }
  const applied = applyWrites(vaultPath, [write], ctx)
  if (!applied.ok) return { ok: false, vault, reason: applied.reason }
  return { ok: true, vault, verb: applied.results[0].verb, path: applied.results[0].path }
}

// --- one repo ------------------------------------------------------------------

/** The note writes of one repo: every change note (by name), then the repo note. */
function noteWrites({ repo, items, view, facts, today }) {
  const writes = items.map(item => ({
    path: notePath(repo.name, item.change),
    render: existing => renderChangeNote(item, existing, { repo: repo.name, scope: repo.vault, today }),
  }))
  writes.push({
    path: notePath(repo.name),
    render: existing => renderRepoNote(view, existing, { repo: repo.name, scope: repo.vault, today, facts, recentNarrative: view.recentNarrative }),
  })
  return writes
}

/**
 * The notes of changes archived outside the keep window that derive no longer makes an item for, while their
 * frontmatter still says otherwise (`archive-pending`, `needs_me: true`): left alone they would stay in `Changes/`
 * and in the summary for good. Each gets `state: archived` and `needs_me: false` (and `stale: false` when it has
 * the key), every other byte kept; `notes` comes back with that state, so the archive move takes the note this run.
 * Returns `{ writes, notes }`.
 */
function lapsedArchives({ repo, archived, items, notes }) {
  const derived = new Set(items.map(i => i.change))
  const writes = []
  const view = { ...notes }
  for (const a of archived) {
    if (!a || typeof a.name !== 'string' || derived.has(a.name)) continue
    const key = noteName(repo.name, a.name)
    const fm = notes[key]?.frontmatter
    if (!fm || fm.state === 'archived' || fm.state === 'dropped') continue
    const pairs = { state: 'archived', needs_me: false, ...(fm.stale !== undefined ? { stale: false } : {}) }
    writes.push({ path: notePath(repo.name, a.name), render: existing => (existing === null ? null : setFrontmatter(existing, pairs)) })
    view[key] = { ...notes[key], frontmatter: { ...fm, state: 'archived' } }
  }
  return { writes, notes: view }
}

/** Lay the planned note texts and moves of a dry run over `overlay`. */
function recordOverlay(overlay, vaultPath, writes, plan) {
  writes.forEach((w, i) => {
    if (w.from !== undefined) {
      if (plan[i].verb === 'move') overlay.set(w.from, null)
      return
    }
    const text = w.render(readText(join(vaultPath, w.path)))
    if (text !== null && text !== undefined) overlay.set(w.path, text)
  })
}

/**
 * Sync one registered repo without the summary. `run` carries the shared options.
 * @returns {object} `{ ok: true, repo, vault, items, needsMe, written, writes, plan?, daily, dryRun, line }` or `{ ok: false, repo, reason }`
 */
function runRepo(run, repo, overlays) {
  const { registry, limits, env, now, home, exec, dryRun, warn } = run
  const fail = reason => ({ ok: false, repo: repo.name, reason })

  // The boundary before any work: the vault the registry names exists and no root contradicts it.
  const vaultPath = vaultPathOf(registry, repo.vault)
  const gate = planWrites(vaultPath, [], { registry, repo: repo.name })
  if (!gate.ok) return fail(gate.reason)

  const remote = run.remote || (run.dueRemote && dueRemote({ home, repo: repo.name, limits, now }))
  const facts = collectRepo({ repo, limits, env, now, home, exec, remote, writeCache: !dryRun, runDrift: true })
  const notes = readNotes(vaultPath, repo.name)
  const { items, repo: view } = derive(facts, { now, limits, notes })
  const today = localDate(now)
  const archived = Array.isArray(facts.openspec.archived?.value) ? facts.openspec.archived.value : []
  const lapsed = lapsedArchives({ repo, archived, items, notes })
  const writes = [...noteWrites({ repo, items, view, facts, today }), ...lapsed.writes]
  const moved = () => archiveNotes(vaultPath, {
    repo: repo.name,
    archived,
    archivedKeepDays: limits.archivedKeepDays,
    now,
    notes: lapsed.notes,
  })
  const changes = transitions(notes, items, repo.name)
  const needsMe = items.filter(i => i.needsMe).length + (view.needsMe ? 1 : 0)
  const ctx = { registry, repo: repo.name, now, warn }
  const result = { ok: true, repo: repo.name, vault: repo.vault, items: items.length, needsMe, dryRun }
  const finish = (writesDone, extra) => {
    const written = dryRun ? 0 : writesDone.filter(w => CHANGED.has(w.verb)).length
    const out = { ...result, written, writes: writesDone.map(w => ({ verb: w.verb, path: w.path })), ...extra, line: `${repo.name}: ${items.length} items, ${needsMe} need me, ${written} written` }
    return withDerived(out, { items, repo: view })
  }

  if (dryRun) {
    const planned = planWrites(vaultPath, writes, ctx)
    if (!planned.ok) return fail(planned.reason)
    const moves = moved()
    const movePlan = planWrites(vaultPath, moves, ctx)
    if (!movePlan.ok) return fail(movePlan.reason)
    const plan = [...planned.plan]
    const daily = changes.map(t => renderDailyLine({ kind: 'transition', repo: repo.name, change: t.change, from: t.from, to: t.to, detail: t.detail, at: now }))
    if (daily.length) {
      const path = join(vaultPath, 'Daily', `${today}.md`)
      const verb = readText(path) === null ? 'create' : 'append'
      plan.push({ verb, path, line: `${verb} ${path}` })
    }
    plan.push(...movePlan.plan)
    if (!overlays.has(repo.vault)) overlays.set(repo.vault, new Map())
    recordOverlay(overlays.get(repo.vault), vaultPath, [...writes, ...moves], [...planned.plan, ...movePlan.plan])
    return finish(plan, { plan, daily })
  }

  const applied = applyWrites(vaultPath, writes, ctx)
  if (!applied.ok) return fail(applied.reason)
  const done = [...applied.results]

  // A transition is logged only when its note was actually rewritten.
  const rewritten = new Set(applied.results.filter(r => CHANGED.has(r.verb)).map(r => r.path))
  const logged = changes.filter(t => rewritten.has(join(vaultPath, notePath(repo.name, t.change))))
  const daily = logged.map(t => renderDailyLine({ kind: 'transition', repo: repo.name, change: t.change, from: t.from, to: t.to, detail: t.detail, at: now }))
  if (daily.length) {
    const appended = appendDaily(vaultPath, daily, ctx)
    if (!appended.ok) return fail(appended.reason)
    done.push(...appended.results)
  }

  const moves = moved()
  if (moves.length) {
    const movedAll = applyWrites(vaultPath, moves, ctx)
    if (!movedAll.ok) return fail(movedAll.reason)
    done.push(...movedAll.results)
  }

  const logWritten = appendSyncLog(home, { ts: now.toISOString(), vault: repo.vault, repo: repo.name, needsMe, items: items.length })
  if (!logWritten.ok) return fail(logWritten.reason)
  return finish(done, { daily })
}

/** Set up what every sync shares: the limits, the clock, the home (created unless a dry run). */
function prepare(opts) {
  const { registry } = opts
  if (!registry || !Array.isArray(registry.repos)) return { ok: false, reason: 'sync needs a loaded registry' }
  const env = opts.env ?? process.env
  const l = limitsOf(registry, opts.limits)
  if (!l.ok) return l
  const home = opts.home ?? resolveHome(env)
  if (!opts.dryRun) {
    try {
      ensureHome({ ...env, DIAL_HOME: home })
    } catch (err) {
      if (err instanceof HomeUnwritable) return { ok: false, reason: err.message }
      throw err
    }
  }
  return {
    ok: true,
    run: {
      registry,
      limits: l.limits,
      env,
      now: asDate(opts.now),
      home,
      exec: opts.exec,
      remote: !!opts.remote,
      dueRemote: !!opts.dueRemote,
      dryRun: !!opts.dryRun,
      warn: opts.warn,
    },
  }
}

/**
 * Attach the run's derived view (`{ items, repo }`) as a non-enumerable `derived`, so a caller that syncs and then
 * needs the attribution (`record`) reuses it instead of collecting the repo a second time, while the result's
 * printed and compared shape is unchanged.
 */
function withDerived(result, derived) {
  return Object.defineProperty(result, 'derived', { value: derived, enumerable: false })
}

function safely(run, repo, overlays) {
  try {
    return runRepo(run, repo, overlays)
  } catch (err) {
    return { ok: false, repo: repo.name, reason: err?.message ?? String(err) }
  }
}

/**
 * Sync one registered repo and rebuild its vault's summary.
 * `opts = { registry, repo (a name, `~` path or a path inside the repo), env?, home?, now?, limits?, exec?,
 * remote?, dueRemote?, dryRun?, warn? }`. `remote` fetches from `gh` or `glab`; `dueRemote` does when the repo's
 * cache is absent or older than `remoteIntervalMinutes`; neither reads the cache only. `dryRun` writes nothing.
 * Returns `{ ok: true, repo, vault, items, needsMe, written, writes: [{ verb, path }], daily, dryRun, line, summary,
 * plan? }` (`plan` and a dry run's `written` 0 only under `dryRun`; `plan[]` is `{ verb, path, line }`) or
 * `{ ok: false, reason }` (no matching repo, an unwritable home, a refused or failed write).
 */
export function syncRepo(opts) {
  const prepared = prepare(opts)
  if (!prepared.ok) return prepared
  const { run } = prepared
  const entry = typeof opts.repo === 'string' ? resolveRepo(run.registry, opts.repo) : resolveRepo(run.registry, opts.repo?.name)
  if (!entry) return { ok: false, reason: `no registered repo matches ${typeof opts.repo === 'string' ? opts.repo : opts.repo?.name}` }
  const overlays = new Map()
  const result = safely(run, entry, overlays)
  if (!result.ok) return result
  const summary = syncSummary({ registry: run.registry, vault: entry.vault, limits: run.limits, dryRun: run.dryRun, overlay: overlays.get(entry.vault), warn: run.warn })
  return withDerived({ ...result, summary }, result.derived)
}

/**
 * Sync every registered repo, then rebuild the summary once per vault that had a repo synced. A repo that fails
 * is reported and the run continues. Options as for `syncRepo`, with no `repo`.
 * Returns `{ ok: true, results: [syncRepo-shaped | { ok: false, repo, reason }], summaries: [{ ok, vault, verb?, path?, reason? }],
 * failed, total, dryRun }` or `{ ok: false, reason }` for a failure before any repo (an unwritable home).
 */
export function syncAll(opts) {
  const prepared = prepare(opts)
  if (!prepared.ok) return prepared
  const { run } = prepared
  const overlays = new Map()
  const results = listRepos(run.registry).map(repo => safely(run, repo, overlays))
  const vaults = [...new Set(results.filter(r => r.ok).map(r => r.vault))].sort()
  const summaries = vaults.map(vault => syncSummary({ registry: run.registry, vault, limits: run.limits, dryRun: run.dryRun, overlay: overlays.get(vault), warn: run.warn }))
  const failed = results.filter(r => !r.ok).length
  return { ok: true, results, summaries, failed, total: results.length, dryRun: run.dryRun }
}
