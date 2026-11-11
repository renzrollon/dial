/**
 * The one way Dial runs a program. Synchronous, bounded, never throws: a
 * missing binary, a timeout and a non-zero exit are all results. Sources take
 * `exec` as an argument so tests substitute canned replies (test/helpers.mjs
 * `fakeExec`).
 */
import { execFileSync } from 'node:child_process'

/** Default bound, matching the `subprocessTimeoutSeconds` cap. */
export const DEFAULT_TIMEOUT_MS = 10_000

const MAX_BUFFER = 16 * 1024 * 1024

/**
 * Run `file` with `args`. Resolves to `{ ok, code, stdout, stderr, missing, timedOut }`:
 * `ENOENT` is `missing` (`ok` false, `code` null); a timeout is `ok: false` with
 * `timedOut` true; a non-zero exit is `ok: false` with its `code`.
 * @param {string} file
 * @param {string[]} [args]
 * @param {{ cwd?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ ok: boolean, code: number|null, stdout: string, stderr: string, missing: boolean, timedOut: boolean }}
 */
export function exec(file, args = [], { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env } = {}) {
  try {
    const stdout = execFileSync(file, args, {
      cwd,
      env: env ?? process.env,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, code: 0, stdout, stderr: '', missing: false, timedOut: false }
  } catch (err) {
    const stdout = bufferText(err.stdout)
    const stderr = bufferText(err.stderr)
    if (err.code === 'ENOENT') return { ok: false, code: null, stdout, stderr, missing: true, timedOut: false }
    if (err.code === 'ETIMEDOUT') return { ok: false, code: null, stdout, stderr, missing: false, timedOut: true }
    const code = typeof err.status === 'number' ? err.status : null
    return { ok: false, code, stdout, stderr: stderr || (code === null ? String(err.message ?? err) : ''), missing: false, timedOut: false }
  }
}

function bufferText(value) {
  if (value === undefined || value === null) return ''
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
}
