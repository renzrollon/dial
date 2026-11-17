/**
 * `dial context` (specs/context, add-dial-ask delta): one document holding what Dial knows about one repo — git
 * facts, the open pull requests each with its readiness verdict, the derived items, the unticked Next items and the
 * newest narrative — so a person or a session can answer a status question without recalling anything.
 * Offline and read-only, like `brief`: `repoView` runs `git` and reads the notes, `openPullRequests` and `readCache`
 * read the remote cache, and nothing here writes a file or runs a subprocess of its own. Every string of the
 * document, and every line of the text form, passes the vault writers' redaction with the repo and change names kept.
 */
import { ago } from './brief.mjs'
import { readCache } from './cache.mjs'
import { resolveHome } from './home.mjs'
import { LIMITS } from './limits.mjs'
import { compareItems, registryLimits, repoView } from './next.mjs'
import { narrativeHeading } from './note.mjs'
import { readiness } from './readiness.mjs'
import { resolveRepo } from './registry.mjs'
import { openPullRequests } from './remote.mjs'
import { notePath, redact } from './render.mjs'
import { noteName } from './facts.mjs'
import { rollup } from './sources/forge.mjs'

const GIT_KEYS = ['branch', 'detached', 'dirty', 'stash', 'ahead', 'behind']

/** A fact's value, or null when it was not observed. */
const valueOf = f => (f && typeof f === 'object' && typeof f.unobserved !== 'string' && f.value !== undefined ? f.value : null)

const positive = (n, fallback) => (Number.isInteger(n) && n > 0 ? n : fallback)

/** Every string in `value`, at any depth, passed through `redact(…, keep)`. */
function redactDeep(value, keep) {
  if (typeof value === 'string') return redact(value, keep)
  if (Array.isArray(value)) return value.map(v => redactDeep(v, keep))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, keep)]))
  }
  return value
}

/** The cache's own pull request number for `branch`, or null: what makes a listed pull request `current`. */
function currentNumber({ home, repo, branch, detached }) {
  if (typeof branch !== 'string' || detached === true) return null
  const cached = readCache(home, repo.name)
  if (!cached.ok) return null
  const { data } = cached
  if (data.host !== repo.host || data.branch !== branch) return null
  return Number.isInteger(data.pr?.number) ? data.pr.number : null
}

/** One derived item as the document shows it, each leaf fact flattened to its value or null. */
function itemEntry(repoName, item, change) {
  return {
    change,
    state: item.state,
    needsMe: item.needsMe === true,
    stale: item.stale === true,
    idleDays: typeof item.idleDays === 'number' ? item.idleDays : null,
    evidence: item.evidence ?? null,
    suggested: item.suggested ?? null,
    tasksDone: change === null ? null : valueOf(item.tasksDone),
    tasksTotal: change === null ? null : valueOf(item.tasksTotal),
    mergeVerdict: change === null ? null : valueOf(item.mergeVerdict),
    note: notePath(repoName, change),
    rows: (item.rows ?? []).map(r => ({ fact: r.fact, value: r.value ?? null, evidence: r.evidence ?? null })),
  }
}

/** The newest `cap` narrative entries across the repo's notes, newest first. */
function newestNarrative(notes, cap) {
  const all = []
  for (const key of Object.keys(notes).sort()) {
    const n = notes[key]
    for (const e of n?.narrative ?? []) {
      const t = Date.parse(e?.at)
      if (Number.isNaN(t)) continue
      all.push({ t, key, entry: { at: e.at, source: e.source ?? null, note: n.path, body: e.body ?? '' } })
    }
  }
  all.sort((a, b) => b.t - a.t || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return all.slice(0, cap).map(x => x.entry)
}

/**
 * The context document for one repo.
 * @param {{ registry: object, arg: string, limits?: object, env?: object, now?: Date, home?: string, exec?: Function }} opts
 * @returns {{ ok: true, doc: object } | { ok: false, unregistered: true, reason: string }}
 */
export function context({ registry, arg, limits, env = process.env, now = new Date(), home, exec }) {
  const repo = resolveRepo(registry, arg)
  if (!repo) return { ok: false, unregistered: true, reason: `${arg} is not a registered repo` }
  const lim = limits ?? registryLimits(registry)
  const dialHome = home ?? resolveHome(env)
  const { facts, derived, notes } = repoView({ repo, registry, limits: lim, env, now, home: dialHome, exec })

  const gitFacts = facts.git ?? {}
  const git = Object.fromEntries(GIT_KEYS.map(k => [k, valueOf(gitFacts[k])]))

  const listed = derived.items.filter(i => i.state !== 'archived' && i.state !== 'dropped')
  const ordered = [
    ...listed.map(i => ({ item: i, change: i.change })),
    { item: derived.repo, change: null },
  ].sort((a, b) => compareItems(
    { ...a.item, repo: repo.name, change: a.change },
    { ...b.item, repo: repo.name, change: b.change }
  ))
  const items = ordered.map(({ item, change }) => itemEntry(repo.name, item, change))

  const prs = openPullRequests({ repo, home: dialHome, limits: lim, now })
  let pullRequests = prs
  if (prs.observed) {
    const current = currentNumber({ home: dialHome, repo, branch: git.branch, detached: git.detached })
    const owner = number => derived.items.find(i => typeof i.pr?.unobserved !== 'string' && i.pr?.value === number)?.change ?? null
    pullRequests = {
      ...prs,
      items: prs.items.map(pr => {
        const verdict = readiness(pr)
        return {
          number: pr.number,
          title: pr.title,
          branch: pr.branch,
          base: pr.base,
          url: pr.url,
          author: pr.author,
          draft: pr.draft,
          review: pr.review,
          mergeState: pr.mergeState,
          conflicting: pr.conflicting,
          ci: Array.isArray(pr.checks) ? rollup(pr.checks).value : null,
          updatedAt: pr.updatedAt,
          current: current !== null && current === pr.number,
          change: owner(pr.number),
          ready: verdict.ready,
          blockers: verdict.blockers,
        }
      }),
    }
  }

  const repoNote = notes[noteName(repo.name)]
  const next = []
  const takeNext = n => {
    for (const x of n?.next ?? []) if (!x.checked) next.push({ note: n.path, text: x.text })
  }
  takeNext(repoNote)
  for (const i of listed) takeNext(notes[noteName(repo.name, i.change)])

  const narrative = newestNarrative(notes, positive(lim.contextNarrative, LIMITS.contextNarrative))

  const doc = {
    repo: repo.name,
    vault: repo.vault,
    host: repo.host,
    at: now.toISOString(),
    git,
    pullRequests,
    items,
    next,
    narrative,
  }
  const keep = [repo.name, ...derived.items.map(i => i.change).filter(c => typeof c === 'string')]
  return { ok: true, doc: redactDeep(doc, keep) }
}

const shown = v => (v === null || v === undefined ? 'unobserved' : String(v))
const oneLine = v => String(v ?? '').replace(/\s+/g, ' ').trim()

function headerLine(doc) {
  const g = doc.git ?? {}
  let branch = shown(g.branch)
  if (g.branch !== null && g.branch !== undefined && g.detached === true) branch = `detached ${g.branch}`
  return `${doc.repo} · ${branch} · dirty ${shown(g.dirty)} · stash ${shown(g.stash)} · ahead ${shown(g.ahead)} · behind ${shown(g.behind)}`
}

function pullRequestLines(p, now) {
  const out = []
  if (p?.observed) {
    const items = p.items ?? []
    out.push(`pull requests: ${items.length}${p.more ? '+' : ''} open, fetched ${ago(p.fetchedAt, now)} ago${p.stale ? ' (stale)' : ''}`)
  } else {
    out.push(`pull requests: unobserved: ${oneLine(p?.reason)}`)
  }
  if (p?.error) out.push(`  last list failed: ${oneLine(p.error.reason)}`)
  for (const pr of p?.observed ? p.items ?? [] : []) {
    let line = `  #${pr.number} ${pr.title} · ${pr.branch} → ${pr.base} · ready ${pr.ready}`
    if (pr.blockers?.length) line += ` · ${pr.blockers.join(', ')}`
    if (pr.change) line += ` · ${pr.change}`
    out.push(line)
  }
  return out
}

/**
 * The text form, no trailing newline, cut to `contextLines`: past the cap, the first `contextLines - 1` lines and
 * then one line saying how many more and where to find them.
 * @param {object} doc the document `context` returns
 * @param {{ contextLines?: number }} [opts]
 */
export function formatContext(doc, { contextLines } = {}) {
  const now = new Date(doc.at)
  const lines = [headerLine(doc), ...pullRequestLines(doc.pullRequests, now)]

  if (doc.items?.length) {
    lines.push('items:')
    for (const i of doc.items) {
      lines.push(`  ${i.state}${i.stale ? ' [stale]' : ''} ${i.change ?? doc.repo} — ${i.evidence ?? '—'} → ${i.suggested ?? '—'}`)
    }
  } else lines.push('items: none')

  if (doc.next?.length) {
    lines.push('next:')
    for (const n of doc.next) lines.push(`  - [ ] ${oneLine(n.text)}`)
  } else lines.push('next: none')

  if (doc.narrative?.length) {
    lines.push('narrative:')
    for (const e of doc.narrative) {
      lines.push(`  ${narrativeHeading(e.at, e.source)} · ${e.note}`)
      for (const l of String(e.body ?? '').split('\n')) if (l.trim() !== '') lines.push(`  ${l.trimEnd()}`)
    }
  } else lines.push('narrative: none')

  const keep = [
    doc.repo,
    ...(doc.items ?? []).map(i => i.change),
    ...(doc.pullRequests?.items ?? []).map(p => p.change),
  ].filter(c => typeof c === 'string')
  const safe = lines.map(l => redact(l, keep))
  const cap = positive(contextLines, LIMITS.contextLines)
  if (safe.length <= cap) return safe.join('\n')
  const kept = safe.slice(0, cap - 1)
  return [...kept, `… ${safe.length - kept.length} more lines, see dial context --json`].join('\n')
}
