/**
 * The Escapement source (specs/local-sources): queue entries and journal
 * observations read from files only. This module imports nothing that can
 * spawn a process, and it never creates the Escapement home.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fact, unobserved } from '../facts.mjs'
import { collapseHome, expandTilde, homeOf, isoSeconds, realOr } from './paths.mjs'

/** Queue directories, in Escapement's order. */
export const QUEUE_STATES = Object.freeze(['pending', 'running', 'done', 'halted', 'failed'])

/** Escapement's own rule: `ESCAPEMENT_HOME` trimmed and tilde-expanded, else `~/.escapement`. */
export function escapementHome(env = process.env) {
  const userHome = homeOf(env)
  const raw = typeof env.ESCAPEMENT_HOME === 'string' ? env.ESCAPEMENT_HOME.trim() : ''
  return raw ? resolve(expandTilde(raw, userHome)) : join(userHome, '.escapement')
}

/**
 * Collect `RepoFacts.escapement` for the repository at `repoPath`.
 *
 * Returns `{ home, entries }`. `entries` maps change name to a Fact whose
 * value is `{ id, state, lastTs, observation, observationEvidence }` where
 * `observation` is `{ class, category, reason, runId }` or null. A change in
 * `changes` with no matching entry is the observed value `absent`; with the
 * home absent every such change is `unobserved: <home>: absent`.
 * @param {{ repoPath: string, env?: NodeJS.ProcessEnv, now?: Date, changes?: string[] }} opts
 */
export function collectEscapement({ repoPath, env = process.env, now = new Date(), changes = [] }) {
  const userHome = homeOf(env)
  const home = escapementHome(env)
  const shown = collapseHome(home, userHome)
  if (!isDir(home)) {
    const reason = `${shown}: absent`
    return { home: unobserved(reason), entries: Object.fromEntries(changes.map(c => [c, unobserved(reason)])) }
  }

  const want = resolve(repoPath)
  const wantReal = realOr(repoPath)
  const matched = new Map() // change -> candidate
  for (const e of resolveDuplicates(readQueue(home))) {
    if (typeof e.data.change !== 'string' || typeof e.data.repo !== 'string') continue
    const repo = resolve(e.data.repo)
    if (repo !== want && realOr(e.data.repo) !== wantReal) continue
    const prev = matched.get(e.data.change)
    if (!prev || e.lastTs > prev.lastTs) matched.set(e.data.change, e)
  }

  const days = journalDays(now)
  const entries = {}
  for (const change of new Set([...changes, ...matched.keys()])) {
    const e = matched.get(change)
    if (!e) {
      entries[change] = fact('absent', `${shown}/queue: no entry for ${change}`)
      continue
    }
    const obs = newestObservation(home, shown, days, e.id)
    entries[change] = fact(
      {
        id: e.id,
        state: e.state,
        lastTs: e.lastTs,
        observation: obs.observation,
        observationEvidence: obs.evidence,
      },
      `${shown}/queue/${e.state}/${e.file}: ${e.state}`
    )
  }
  return { home: fact(shown, `${shown}: present`), entries }
}

function readQueue(home) {
  const out = []
  for (const state of QUEUE_STATES) {
    let files
    try {
      files = readdirSync(join(home, 'queue', state)).filter(f => f.endsWith('.json')).sort()
    } catch {
      continue
    }
    for (const file of files) {
      const path = join(home, 'queue', state, file)
      let data
      try {
        data = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        continue
      }
      if (data === null || typeof data !== 'object' || Array.isArray(data)) continue
      const id = typeof data.id === 'string' ? data.id : basename(file, '.json')
      out.push({ id, state, file, data, lastTs: lastTs(data, path) })
    }
  }
  return out
}

function lastTs(data, path) {
  const stamps = (Array.isArray(data.transitions) ? data.transitions : []).map(t => t?.ts).filter(t => typeof t === 'string').sort()
  if (stamps.length) return stamps[stamps.length - 1]
  if (typeof data.enqueuedAt === 'string') return data.enqueuedAt
  try {
    return isoSeconds(statSync(path).mtimeMs)
  } catch {
    return ''
  }
}

/** An id in two directories (a crash mid-move) keeps the copy whose directory matches its last transition. */
function resolveDuplicates(entries) {
  const byId = new Map()
  for (const e of entries) byId.set(e.id, [...(byId.get(e.id) ?? []), e])
  const out = []
  for (const copies of byId.values()) {
    if (copies.length === 1) {
      out.push(copies[0])
      continue
    }
    const transitions = copies.flatMap(c => (Array.isArray(c.data.transitions) ? c.data.transitions : []))
    const last = transitions.filter(t => typeof t?.ts === 'string').sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)).at(-1)
    const byDir = last && copies.find(c => c.state === last.to)
    out.push(byDir ?? copies.reduce((a, b) => (b.lastTs > a.lastTs ? b : a)))
  }
  return out
}

/** Yesterday's then today's UTC date, oldest first. */
function journalDays(now) {
  const day = d => d.toISOString().slice(0, 10)
  return [day(new Date(now.getTime() - 86_400_000)), day(now)]
}

function newestObservation(home, shown, days, id) {
  let found = null
  for (const day of days) {
    let text
    try {
      text = readFileSync(join(home, 'journal', `${day}.jsonl`), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      if (rec?.event !== 'observation' || rec.entry !== id) continue
      const d = rec.detail ?? {}
      found = {
        day,
        observation: { class: d.class ?? null, category: d.category ?? null, reason: d.reason ?? null, runId: d.runId ?? null },
      }
    }
  }
  if (!found) return { observation: null, evidence: `${shown}/journal: no observation for ${id}` }
  const o = found.observation
  return { observation: o, evidence: `${shown}/journal/${found.day}.jsonl observation ${id}: ${o.class} ${o.category}` }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
