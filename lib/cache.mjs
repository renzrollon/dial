/**
 * The remote cache: `$DIAL_HOME/cache/remote/<repo>.json`, the last PR and CI
 * reply per repository. The directory is created by the first write, never by
 * `ensureHome`. Neither function throws.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeName } from './facts.mjs'

export const CACHE_SCHEMA = 'dial.cache/1'

/** `<home>/cache/remote/<repo>.json`; the repo name is sanitised like a note name. */
export function cachePath(home, repo) {
  return join(home, 'cache', 'remote', `${sanitizeName(repo)}.json`)
}

/**
 * Read a repo's cache. `{ ok: true, data }` when it parses and carries the
 * marker; otherwise `{ ok: false, absent: true }` for no file, or
 * `{ ok: false, absent: false, reason }` naming the file and the problem.
 */
export function readCache(home, repo) {
  const file = cachePath(home, repo)
  const label = `cache/remote/${sanitizeName(repo)}.json`
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, absent: true, reason: `${label}: absent` }
    return { ok: false, absent: false, reason: `${label}: ${err.code ?? err.message}` }
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, absent: false, reason: `${label} not valid JSON` }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, absent: false, reason: `${label} not valid JSON` }
  }
  if (data.dial_schema !== CACHE_SCHEMA) {
    return { ok: false, absent: false, reason: `${label} schema ${data.dial_schema} not understood` }
  }
  return { ok: true, data }
}

/**
 * Write a repo's cache atomically (temp file in the same directory, then
 * rename), creating `cache/remote/` on first use. `dial_schema` is set here and
 * written first. Returns `{ ok: true, path }` or `{ ok: false, reason }`.
 */
export function writeCache(home, repo, data) {
  const file = cachePath(home, repo)
  const { dial_schema: _ignored, ...rest } = data
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    mkdirSync(join(home, 'cache', 'remote'), { recursive: true })
    writeFileSync(tmpFile, JSON.stringify({ dial_schema: CACHE_SCHEMA, ...rest }, null, 2) + '\n')
    renameSync(tmpFile, file)
    return { ok: true, path: file }
  } catch (err) {
    try {
      unlinkSync(tmpFile)
    } catch {
      /* nothing to clean */
    }
    return { ok: false, reason: `${file}: ${err.code ?? err.message}` }
  }
}
