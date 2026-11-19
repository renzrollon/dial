/**
 * Shared body of the three hook scripts (specs/claude-plugin). A hook never blocks a session: one top-level
 * guard, exit 0 on every path, and a failure is the single stderr line `dial <hook> hook error (ignored): <message>`.
 * The repo is resolved in-process before any subprocess; the CLI run is the plugin's own `bin/dial.mjs`. A hook
 * either waits for that run or, when its plan says `detach`, starts it and leaves it running: Claude Code gives
 * SessionEnd hooks a shared budget of about 1.5 seconds, which a plugin's own timeout does not raise.
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHome } from '../lib/home.mjs'
import { loadRegistry, resolveRepo } from '../lib/registry.mjs'

/** The plugin root, from this file's own location (`<root>/hooks/common.mjs`). */
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The payload from stdin: `{}` for a TTY, empty, malformed or non-object input. */
export function readPayload(stdin = process.stdin) {
  try {
    if (stdin.isTTY) return { raw: '', payload: {} }
    const raw = readFileSync(0, 'utf8')
    const parsed = JSON.parse(raw)
    return { raw, payload: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {} }
  } catch {
    return { raw: '', payload: {} }
  }
}

/** One line from a failure message: newlines collapsed, trimmed. */
function oneLine(text) {
  return String(text ?? '').replace(/\s*\n\s*/g, ' ').trim()
}

/** The hook's one failure line; a closed stderr must not change the exit code. */
function report(name, error) {
  try {
    process.stderr.write(`dial ${name} hook error (ignored): ${oneLine(error && error.message ? error.message : error)}\n`)
  } catch {
    // nothing left to tell
  }
}

/**
 * Start the CLI in its own session with `input` on its stdin, and return without waiting. It holds none of the hook's
 * stdio: stdout is discarded and stderr appends to `<home>/logs/<name>.err.log`, or is discarded when that cannot be
 * opened. `logs/` is made without `recursive`, so a missing home stays missing.
 */
function startDetached(name, argv, input) {
  const logs = join(resolveHome(process.env), 'logs')
  try {
    mkdirSync(logs)
  } catch {
    // it exists, or the open below fails
  }
  let stderr = 'ignore'
  try {
    stderr = openSync(join(logs, `${name}.err.log`), 'a')
  } catch {
    // the run's outcome log still records the result
  }
  try {
    const child = spawn(process.execPath, argv, { detached: true, stdio: ['pipe', 'ignore', stderr] })
    child.on('error', error => report(name, error))
    // A child that fails to start has no stdin, or one that breaks on the write.
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
    child.unref()
  } finally {
    if (stderr !== 'ignore') closeSync(stderr)
  }
}

/**
 * Run one hook. `plan({ payload, entry })` returns `{ args, stdin?, relay?, detach? }` or null for nothing to do;
 * `relay` is false except for SessionStart, and `detach` starts the CLI without waiting for it (nothing is relayed and
 * `timeoutMs` does not apply). `gate(payload)` may return false before the registry is read.
 * `deadlineMs`, when given, is passed to the CLI as `DIAL_DEADLINE_MS`, below `timeoutMs`, so every subprocess
 * the CLI runs ends (and its writes start) before this hook's kill can land on it.
 */
export function runHook(name, { gate = () => true, plan, timeoutMs, deadlineMs }) {
  try {
    const { raw, payload } = readPayload()
    if (!gate(payload)) return
    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd()
    const loaded = loadRegistry(resolveHome(process.env))
    if (!loaded.ok) throw new Error(loaded.reason)
    const entry = resolveRepo(loaded.registry, cwd)
    if (!entry) return
    const step = plan({ payload, entry })
    if (!step) return
    const argv = [join(PLUGIN_ROOT, 'bin', 'dial.mjs'), ...step.args]
    const input = step.stdin === 'payload' ? raw : ''
    if (step.detach) {
      startDetached(name, argv, input)
      return
    }
    const result = spawnSync(process.execPath, argv, {
      input,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: Number.isInteger(deadlineMs) ? { ...process.env, DIAL_DEADLINE_MS: String(deadlineMs) } : process.env,
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(oneLine(result.stderr) || `dial exited ${result.status}`)
    // `dial record` reports its failure as one stderr line with exit 0, so a non-relay hook surfaces that line too.
    const said = String(result.stderr ?? '').split('\n').map(l => l.trim()).find(Boolean)
    if (!step.relay && said) throw new Error(said)
    if (step.relay) {
      const text = String(result.stdout ?? '').trim()
      if (!text) return
      let envelope
      try {
        envelope = JSON.parse(text)
      } catch {
        return
      }
      if (envelope && typeof envelope === 'object' && envelope.hookSpecificOutput) process.stdout.write(`${text}\n`)
    }
  } catch (error) {
    report(name, error)
  }
}

/**
 * Exit 0 whatever happened. Only the exit code is set: the process ends when the event loop drains, after piped
 * stdout (asynchronous on darwin) and a detached child's stdin have been flushed. `process.exit`
 * here would cut a large SessionStart envelope at the pipe buffer.
 */
export function finish() {
  process.exitCode = 0
}
