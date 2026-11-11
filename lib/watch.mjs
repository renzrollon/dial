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
 * Poll until `signal` aborts. `opts = { registry, pollMs, signal, onTick?, reload?, sync?, syncOpts?, now?, sleep?, mtimeOf?,
 * stdout?, stderr? }`. `reload()`, when given, runs at the start of every tick and returns `{ ok: true, registry,
 * limits? }` (which replace the registry, `syncOpts.limits` and the poll interval) or `{ ok: false, reason }`
 * (one `dial: <reason>` line and a tick that syncs nothing); repos no longer listed are forgotten. Each tick compares every repo's newest mtime with the previous poll (the first poll records
 * and syncs nothing); a repo whose value differs is synced through `sync({ ...syncOpts, registry, repo, now })`, one
 * `HH:mm synced <repo> (needs me <n>)` line to `stdout`; a failed sync is one `dial: <repo>: <reason>` line to
 * `stderr` and the loop goes on. `onTick({ tick, synced, failed })` runs after each tick, before the sleep.
 * Resolves to `{ ticks, synced, failed }` (counts) once aborted.
 */
export async function watch(opts) {
  const {
    pollMs, signal, onTick, reload, sync = syncRepo, syncOpts = {}, now = () => new Date(), sleep = sleepUntil,
    mtimeOf = newestMtime, stdout = line => process.stdout.write(`${line}\n`), stderr = line => process.stderr.write(`${line}\n`),
  } = opts
  let registry = opts.registry
  let syncOptions = syncOpts
  let poll = pollMs
  const seen = new Map()
  const total = { ticks: 0, synced: 0, failed: 0 }
  while (!signal?.aborted) {
    total.ticks++
    const synced = []
    const failed = []
    // The registry is read again each tick, so a repo unregistered (or moved to another vault) since the start is
    // never written into its old vault, and one registered since is watched. A tick whose registry cannot be read
    // syncs nothing.
    let repos = null
    let reloaded = false
    if (reload) {
      const loaded = reload()
      if (loaded?.ok) {
        reloaded = true
        registry = loaded.registry
        if (loaded.limits) {
          syncOptions = { ...syncOptions, limits: loaded.limits }
          if (Number.isInteger(loaded.limits.watchPollSeconds)) poll = loaded.limits.watchPollSeconds * 1000
        }
      } else {
        stderr(`dial: ${loaded?.reason ?? 'registry could not be read'}`)
        repos = []
      }
    }
    repos ??= listRepos(registry)
    if (reloaded) {
      const listed = new Set(repos.map(r => r.name))
      for (const name of [...seen.keys()]) if (!listed.has(name)) seen.delete(name)
    }
    for (const repo of repos) {
      const mtime = mtimeOf(repo.path)
      const first = !seen.has(repo.name)
      const moved = !first && seen.get(repo.name) !== mtime
      seen.set(repo.name, mtime)
      if (!moved) continue
      let result
      try {
        result = await sync({ ...syncOptions, registry, repo: repo.name, now: now() })
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
    await sleep(poll, signal)
  }
  return total
}
