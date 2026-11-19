/**
 * `dial brief` (specs/next-and-brief): the capped orientation text for one repo, which the
 * SessionStart hook injects. Offline and read-only, like `next`: `git` is the only subprocess.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { noteName } from './facts.mjs'
import { resolveHome } from './home.mjs'
import { LIMITS } from './limits.mjs'
import { compareItems, registryLimits, repoView } from './next.mjs'
import { resolveRepo } from './registry.mjs'
import { notePath, redact } from './render.mjs'
import { narrativeHeading } from './note.mjs'

const MIN_MS = 60_000
/** How much of the end of the record log is read: at about 200 bytes a line, some 300 runs across all repos. */
const RECORD_LOG_WINDOW = 64 * 1024
const REASON_CHARS = 120

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

/** The whole lines in the last `RECORD_LOG_WINDOW` bytes of the record log; none when it cannot be read. */
function recordLogTail(home) {
  let fd = null
  try {
    fd = openSync(join(home, 'logs', 'record.jsonl'), 'r')
    const { size } = fstatSync(fd)
    const length = Math.min(size, RECORD_LOG_WINDOW)
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, size - length)
    const lines = buffer.toString('utf8', 0, read).split('\n')
    // A read that starts mid-file starts mid-line.
    return size > length ? lines.slice(1) : lines
  } catch {
    return []
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // nothing was written, so nothing is lost
      }
    }
  }
}

function parseLogLine(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Number.isNaN(Date.parse(value.ts)) ? value : null
  } catch {
    return null
  }
}

/**
 * The `last session not captured` line, or null. The previous session is the newest usable `SessionEnd` line of this
 * repo from another session (D6): a PreCompact miss is retried by that session's own end, and a resumed session must
 * not report on itself.
 */
function missedSessionLine(home, repo, session, now) {
  const lines = recordLogTail(home)
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseLogLine(lines[i])
    if (!entry || entry.repo !== repo || entry.event !== 'SessionEnd') continue
    if (session !== null && entry.session === session) continue
    if (entry.miss !== true) return null
    const reason = [entry.error, entry.unobserved, entry.skipped].find(r => typeof r === 'string' && r.trim())
    if (!reason) return null
    const short = reason.replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, REASON_CHARS)
    return `last session not captured — ${short} · ${ago(entry.ts, now)} ago → dial doctor`
  }
  return null
}

/**
 * Cut the parts to `cap` lines (the final line included) in the fixed drop order: the end of
 * the Next items, the end of the narrative body then its heading, the change lines of the
 * items idle longest, then the missed-session line. The header is never dropped. Returns `{ lines, dropped }`.
 * @param {{ header: string, missed?: string|null, changes: { line: string, idleDays: number|null }[], heading: string|null, body: string[], next: string[], final: string, link: string }} parts
 */
export function capLines(parts, cap) {
  const changes = parts.changes.map((c, i) => ({ ...c, i, keep: true }))
  let body = [...parts.body]
  let heading = parts.heading
  let next = [...parts.next]
  let missed = parts.missed ?? null
  const count = () => 1 + (missed === null ? 0 : 1) + changes.filter(c => c.keep).length + (heading === null ? 0 : 1) + body.length + next.length + 1
  if (count() <= cap) return { lines: assemble(), dropped: 0 }
  let dropped = 0
  while (count() > cap) {
    if (next.length) next.pop()
    else if (body.length) body.pop()
    else if (heading !== null) heading = null
    else {
      const live = changes.filter(c => c.keep)
      if (live.length) {
        const idleRank = c => (c.idleDays === null ? Infinity : c.idleDays)
        const victim = live.reduce((a, b) => (idleRank(b) > idleRank(a) || (idleRank(b) === idleRank(a) && b.i > a.i) ? b : a))
        victim.keep = false
      } else if (missed !== null) missed = null
      else break
    }
    dropped++
  }
  return { lines: assemble(dropped), dropped }

  function assemble(n = 0) {
    return [
      parts.header,
      ...(missed === null ? [] : [missed]),
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
    missed: missedSessionLine(home ?? resolveHome(env), repo.name, session, now),
    changes,
    heading: narrative ? narrative.heading : null,
    body: narrative ? narrative.body : [],
    next,
    final: 'dial next for everything else',
    link: notePath(repo.name),
  }, cap)
  // The brief reaches a session as orientation, so every line passes the same redaction as a vault write.
  const keep = [repo.name, ...items.map(i => i.change).filter(c => typeof c === 'string')]
  return { ok: true, repo: repo.name, lines: lines.map(l => redact(l, keep)), dropped }
}

/** The brief as text, no trailing newline. */
export function formatBrief(result) {
  return result.lines.join('\n')
}

/** The one-line SessionStart envelope around the brief's lines. */
export function hookEnvelope(lines) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } })
}
