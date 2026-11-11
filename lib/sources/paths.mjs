/** Path helpers shared by the file-reading sources. Pure except `realOr`. */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The user's home as `env` sees it, falling back to the OS. */
export function homeOf(env = process.env) {
  return (typeof env.HOME === 'string' && env.HOME.trim()) || homedir()
}

/** Expand a leading `~` or `~/` against `home`. */
export function expandTilde(raw, home) {
  if (raw === '~') return home
  if (raw.startsWith('~/')) return join(home, raw.slice(2))
  return raw
}

/** Show `path` with a leading `home` as `~` (evidence outside the repository is `~`-collapsed). */
export function collapseHome(path, home) {
  if (path === home) return '~'
  const prefix = home.endsWith('/') ? home : `${home}/`
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path
}

/** `realpathSync(path)`, or the lexical absolute form when it does not exist. */
export function realOr(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** An mtime in the facts' timestamp form: UTC ISO without milliseconds. */
export function isoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}
