/**
 * `$DIAL_HOME` resolution and layout. Everything Dial owns lives under one
 * directory; nothing is ever written to a fallback location. Pure with respect
 * to the process: it takes `env` and returns data or throws `HomeUnwritable`.
 */
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Thrown when the home cannot be created or written. Carries the path and the OS error. */
export class HomeUnwritable extends Error {
  constructor(path, cause) {
    const code = cause && cause.code ? `${cause.code}: ` : ''
    const message = cause && cause.message ? cause.message : String(cause)
    super(`dial home is not writable: ${path} (${code}${message})`)
    this.name = 'HomeUnwritable'
    this.path = path
    this.cause = cause
    this.code = cause && cause.code ? cause.code : null
  }
}

/** Resolve the home root from the environment; `~` and `~/x` expand to the user's home. */
export function resolveHome(env = process.env) {
  const raw = typeof env.DIAL_HOME === 'string' ? env.DIAL_HOME.trim() : ''
  if (!raw) return join(homedir(), '.config', 'dial')
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  return resolve(raw)
}

/**
 * Resolve the home, create `root` and `root/logs` on first use, and prove the
 * root is writable with a probe file. Throws `HomeUnwritable`, the only error
 * this module raises, when it is not.
 */
export function ensureHome(env = process.env) {
  const root = resolveHome(env)
  const logs = join(root, 'logs')
  for (const dir of [root, logs]) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (err) {
      throw new HomeUnwritable(dir, err)
    }
  }
  const probe = join(root, `.probe-${process.pid}-${Date.now()}`)
  try {
    writeFileSync(probe, '')
    unlinkSync(probe)
  } catch (err) {
    throw new HomeUnwritable(root, err)
  }
  return { root, logs }
}
