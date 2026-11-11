/**
 * `dial brief` (specs/next-and-brief): the capped orientation text for one repo, which the
 * SessionStart hook injects. Offline and read-only, like `next`: `git` is the only subprocess.
 */
import { noteName } from './facts.mjs'
import { LIMITS } from './limits.mjs'
import { compareItems, registryLimits, repoView } from './next.mjs'
import { resolveRepo } from './registry.mjs'
import { notePath } from './render.mjs'
import { narrativeHeading } from './note.mjs'

const MIN_MS = 60_000

/** `40m`, `5h` or `3d`: the whole units elapsed, minutes under an hour, hours under a day. */
export function ago(fromIso, now) {
  const ms = Math.max(0, now.getTime() - Date.parse(fromIso))
  const minutes = Math.floor(ms / MIN_MS)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

const observed = f => f && typeof f.unobserved !== 'string' && f.value !== null && f.value !== undefined
const show = f => (observed(f) ? String(f.value) : 'unobserved')

function headerLine(repo, facts, now) {
  const git = facts.git ?? {}
  let branch = show(git.branch)
  if (observed(git.branch) && git.detached?.value === true) branch = `detached ${git.branch.value}`
  const mtime = facts.sessions?.lastSession?.value?.mtime
  const session = typeof mtime === 'string' && !Number.isNaN(Date.parse(mtime)) ? `${ago(mtime, now)} ago` : 'unobserved'
  return `${repo} · ${branch} · dirty ${show(git.dirty)} · stash ${show(git.stash)} · last session ${session}`
}

/** The change an unattributed-branch rule did not claim: derive notes it on the repo item's rows. */
function attributedChange(derived) {
  for (const r of derived.repo?.rows ?? []) {
    const m = /^attributed to (.+)$/.exec(r.evidence ?? '')
    if (m) return m[1]
  }
  return null
}

function newestNarrative(notes) {
  let best = null
  for (const [key, n] of Object.entries(notes)) {
    for (const e of n.narrative ?? []) {
      const t = Date.parse(e.at)
      if (Number.isNaN(t)) continue
      if (!best || t > best.t || (t === best.t && key < best.key)) best = { t, key, e }
    }
  }
  if (!best) return null
  const { e } = best
  const body = String(e.body ?? '').split('\n').map(l => l.trimEnd()).filter(l => l.trim() !== '')
  return { heading: narrativeHeading(e.at, e.source), body }
}

/**
 * Cut the parts to `cap` lines (the final line included) in the fixed drop order: the end of
 * the Next items, the end of the narrative body then its heading, then the change lines of the
 * items idle longest. The header is never dropped. Returns `{ lines, dropped }`.
 * @param {{ header: string, changes: { line: string, idleDays: number|null }[], heading: string|null, body: string[], next: string[], final: string, link: string }} parts
 */
export function capLines(parts, cap) {
  const changes = parts.changes.map((c, i) => ({ ...c, i, keep: true }))
  let body = [...parts.body]
  let heading = parts.heading
  let next = [...parts.next]
  const count = () => 1 + changes.filter(c => c.keep).length + (heading === null ? 0 : 1) + body.length + next.length + 1
  if (count() <= cap) return { lines: assemble(), dropped: 0 }
  let dropped = 0
  while (count() > cap) {
    if (next.length) next.pop()
    else if (body.length) body.pop()
    else if (heading !== null) heading = null
    else {
      const live = changes.filter(c => c.keep)
      if (!live.length) break
      const idleRank = c => (c.idleDays === null ? Infinity : c.idleDays)
      const victim = live.reduce((a, b) => (idleRank(b) > idleRank(a) || (idleRank(b) === idleRank(a) && b.i > a.i) ? b : a))
      victim.keep = false
    }
    dropped++
  }
  return { lines: assemble(dropped), dropped }

  function assemble(n = 0) {
    return [
      parts.header,
      ...changes.filter(c => c.keep).map(c => c.line),
      ...(heading === null ? [] : [heading]),
      ...body,
      ...next,
      n ? `… ${n} more lines, see ${parts.link}` : parts.final,
    ]
  }
}

/**
 * The brief for one repo.
 * @param {{ registry: object, arg: string, limits?: object, env?: object, now?: Date, home?: string, exec?: Function, session?: string|null }} opts
 * @returns {{ ok: true, repo: string, lines: string[], dropped: number } | { ok: false, unregistered: true, reason: string }}
 */
export function brief({ registry, arg, limits, env, now = new Date(), home, exec, session = null }) {
  const repo = resolveRepo(registry, arg)
  if (!repo) return { ok: false, unregistered: true, reason: `${arg} is not a registered repo` }
  const lim = limits ?? registryLimits(registry)
  const { facts, derived, notes } = repoView({ repo, registry, limits: lim, env, now, home, exec, excludeSession: session })

  const items = derived.items.map(i => ({ ...i, repo: repo.name, label: i.change }))
  if (derived.repo?.needsMe) items.push({ ...derived.repo, repo: repo.name, change: null, label: repo.name })
  const changes = items
    .filter(i => i.state !== 'archived' && i.state !== 'dropped')
    .sort(compareItems)
    .map(i => ({
      idleDays: typeof i.idleDays === 'number' ? i.idleDays : null,
      line: `${i.state}${i.stale ? ' [stale]' : ''} ${i.label} — ${i.evidence ?? '—'} → ${i.suggested ?? '—'}`,
    }))

  const narrative = newestNarrative(notes)
  const attributed = attributedChange(derived)
  const source = (attributed && notes[noteName(repo.name, attributed)]) || notes[noteName(repo.name)]
  const next = (source?.next ?? []).filter(n => !n.checked).map(n => `- [ ] ${n.text}`)

  const cap = Number.isInteger(lim.briefLines) && lim.briefLines > 0 ? lim.briefLines : LIMITS.briefLines
  const { lines, dropped } = capLines({
    header: headerLine(repo.name, facts, now),
    changes,
    heading: narrative ? narrative.heading : null,
    body: narrative ? narrative.body : [],
    next,
    final: 'dial next for everything else',
    link: notePath(repo.name),
  }, cap)
  return { ok: true, repo: repo.name, lines, dropped }
}

/** The brief as text, no trailing newline. */
export function formatBrief(result) {
  return result.lines.join('\n')
}

/** The one-line SessionStart envelope around the brief's lines. */
export function hookEnvelope(lines) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } })
}
