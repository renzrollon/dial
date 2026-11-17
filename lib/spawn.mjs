/**
 * The asynchronous sibling of lib/subprocess.mjs: a long-lived child whose
 * output arrives line by line, whose input can be written to, and which can be
 * ended together with everything it started. Never throws: a program that
 * cannot start is an exit result with `error` set.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/** How long a group has to leave after SIGTERM before it is sent SIGKILL. */
export const KILL_GRACE_MS = 2000

const STDERR_BYTES = 64 * 1024
const POLL_MS = 10

/** Whether any process is left in the group `pgid`. */
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal)
  } catch {}
}

/**
 * Start `file` as the leader of its own process group, stdio piped.
 * `onLine(line)` gets each stdout line without its newline, in order, and a last
 * unterminated line before `onExit`. `onExit({ code, signal, stderr, error })`
 * fires exactly once when the child has exited (after `kill()`, not before its
 * group is empty or was sent SIGKILL); `stderr` is the last 64 KiB; `error` is
 * null, or `{ code, message }` when the child could not be started.
 * @param {string} file
 * @param {string[]} [args]
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, onLine?: (line: string) => void, onExit?: (result: object) => void, killGraceMs?: number }} [opts]
 * @returns {{ pid: number|undefined, write: (text: string) => boolean, end: () => void, kill: () => void }}
 */
export function spawnChild(file, args = [], { cwd, env, onLine, onExit, killGraceMs = KILL_GRACE_MS } = {}) {
  let child = null
  let pgid = 0
  let closed = false // stdio ended: the exit result is known
  let result = null
  let stdinOpen = true
  let reported = false
  let groupGone = false // nothing of the group is left to signal
  let killing = false
  let killDone = true // false while a kill() waits for the group to empty
  let stderrBuf = Buffer.alloc(0)
  let tail = ''
  const decoder = new StringDecoder('utf8')

  const report = () => {
    if (reported || !result || !closed || !killDone) return
    reported = true
    onExit?.(result)
  }

  const finish = (code, signal, error) => {
    if (result) return
    tail += decoder.end()
    if (tail !== '') onLine?.(tail)
    tail = ''
    result = { code, signal, stderr: stderrBuf.toString('utf8'), error }
    stdinOpen = false
    if (pgid && !groupAlive(pgid)) groupGone = true
    report()
  }

  try {
    child = spawn(file, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    queueMicrotask(() => {
      closed = true
      finish(null, null, { code: err.code ?? 'ERR_SPAWN', message: String(err.message ?? err) })
    })
    return { pid: undefined, write: () => false, end() {}, kill() {} }
  }
  pgid = child.pid ?? 0

  child.stdin.on('error', () => {})
  child.stdout.on('error', () => {})
  child.stderr.on('error', () => {})
  child.stdout.on('data', chunk => {
    tail += decoder.write(chunk)
    let at
    while ((at = tail.indexOf('\n')) !== -1) {
      const line = tail.slice(0, at)
      tail = tail.slice(at + 1)
      onLine?.(line)
    }
  })
  child.stderr.on('data', chunk => {
    stderrBuf = Buffer.concat([stderrBuf, chunk])
    if (stderrBuf.length > STDERR_BYTES) stderrBuf = stderrBuf.subarray(stderrBuf.length - STDERR_BYTES)
  })

  let exitCode = null
  let exitSignal = null
  child.on('error', err => {
    // No process exists when it could not start; later errors leave the exit event to speak.
    if (child.pid === undefined) {
      closed = true
      finish(null, null, { code: err.code ?? 'ERR_SPAWN', message: String(err.message ?? err) })
    }
  })
  child.on('exit', (code, signal) => {
    exitCode = code
    exitSignal = signal
  })
  child.on('close', (code, signal) => {
    closed = true
    finish(exitCode ?? code ?? null, exitSignal ?? signal ?? null, null)
  })

  function endStdin() {
    if (!stdinOpen) return
    stdinOpen = false
    try {
      child.stdin.end()
    } catch {}
  }

  return {
    pid: child.pid,
    write(text) {
      if (!stdinOpen || child.pid === undefined) return false
      try {
        child.stdin.write(text)
        return true
      } catch {
        return false
      }
    },
    end: endStdin,
    kill() {
      endStdin()
      if (killing || !pgid || groupGone) return
      killing = true
      killDone = false
      signalGroup(pgid, 'SIGTERM')
      const started = Date.now()
      const settle = () => {
        killDone = true
        groupGone = true
        report()
      }
      const poll = () => {
        if (!groupAlive(pgid)) return settle()
        if (Date.now() - started >= killGraceMs) {
          signalGroup(pgid, 'SIGKILL')
          return settle()
        }
        setTimeout(poll, Math.min(POLL_MS, Math.max(1, killGraceMs - (Date.now() - started)))).unref?.()
      }
      // The poll is not unref'd while the exit result waits on it; it ends within killGraceMs.
      const first = setTimeout(poll, POLL_MS)
      if (reported) first.unref?.()
    },
  }
}

/**
 * The first executable regular file called `name` in a directory of `env.PATH`,
 * as an absolute path, else null.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @returns {string|null}
 */
export function findOnPath(env, name) {
  for (const dir of String(env?.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = resolve(join(dir, name))
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
    } catch {
      continue
    }
    return candidate
  }
  return null
}
