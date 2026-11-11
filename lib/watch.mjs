/**
 * `dial watch` (specs/launch-agent, watch requirements): poll the newest mtime under `.claude/ship/` and
 * `openspec/changes/` of every registered repo and sync a repo whose newest mtime moved since the previous
 * poll. The first poll only records. No external watcher: `lstat` and `readdir` on a timer. Everything that
 * touches the world is injectable (`sync`, `now`, `sleep`, `mtimeOf`, `stdout`, `stderr`) so a test drives
 * ticks without waiting.
 */
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { localTime } from './note.mjs'
import { listRepos } from './registry.mjs'
import { syncRepo } from './sync.mjs'

/** The directories under a repo whose mtimes say its Interlock or OpenSpec state moved. */
export const WATCHED = Object.freeze([join('.claude', 'ship'), join('openspec', 'changes')])

/** Newest mtime (ms) of `dir` and everything below it; null when it is not a directory. Symlinks are not followed. */
function newestUnder(dir) {
  let st
  try {
    st = lstatSync(dir)
  } catch {
    return null
  }
  if (!st.isDirectory()) return null
  let newest = st.mtimeMs
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return newest
  }
  for (const name of names) {
    const path = join(dir, name)
    let child
    try {
      child = lstatSync(path)
    } catch {
      continue
    }
    const at = child.isDirectory() ? newestUnder(path) : child.mtimeMs
    if (at !== null && at > newest) newest = at
  }
  return newest
}

/** The newest mtime across both watched directories of `repoPath`, or null when it has neither. */
export function newestMtime(repoPath) {
  const found = WATCHED.map(rel => newestUnder(join(repoPath, rel))).filter(v => v !== null)
  return found.length ? Math.max(...found) : null
}

/** Resolve after `ms`, or at once when `signal` aborts. */
export function sleepUntil(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Poll until `signal` aborts. `opts = { registry, pollMs, signal, onTick?, sync?, syncOpts?, now?, sleep?, mtimeOf?,
 * stdout?, stderr? }`. Each tick compares every repo's newest mtime with the previous poll (the first poll records
 * and syncs nothing); a repo whose value differs is synced through `sync({ ...syncOpts, registry, repo, now })`, one
 * `HH:mm synced <repo> (needs me <n>)` line to `stdout`; a failed sync is one `dial: <repo>: <reason>` line to
 * `stderr` and the loop goes on. `onTick({ tick, synced, failed })` runs after each tick, before the sleep.
 * Resolves to `{ ticks, synced, failed }` (counts) once aborted.
 */
export async function watch(opts) {
  const {
    registry, pollMs, signal, onTick, sync = syncRepo, syncOpts = {}, now = () => new Date(), sleep = sleepUntil,
    mtimeOf = newestMtime, stdout = line => process.stdout.write(`${line}\n`), stderr = line => process.stderr.write(`${line}\n`),
  } = opts
  const seen = new Map()
  const total = { ticks: 0, synced: 0, failed: 0 }
  while (!signal?.aborted) {
    total.ticks++
    const synced = []
    const failed = []
    for (const repo of listRepos(registry)) {
      const mtime = mtimeOf(repo.path)
      const first = !seen.has(repo.name)
      const moved = !first && seen.get(repo.name) !== mtime
      seen.set(repo.name, mtime)
      if (!moved) continue
      let result
      try {
        result = await sync({ ...syncOpts, registry, repo: repo.name, now: now() })
      } catch (err) {
        result = { ok: false, reason: err?.message ?? String(err) }
      }
      if (result?.ok) {
        synced.push(repo.name)
        stdout(`${localTime(now())} synced ${repo.name} (needs me ${result.needsMe ?? 0})`)
      } else {
        failed.push(repo.name)
        stderr(`dial: ${repo.name}: ${result?.reason ?? 'sync failed'}`)
      }
    }
    total.synced += synced.length
    total.failed += failed.length
    if (onTick) await onTick({ tick: total.ticks, synced, failed })
    if (signal?.aborted) break
    await sleep(pollMs, signal)
  }
  return total
}
