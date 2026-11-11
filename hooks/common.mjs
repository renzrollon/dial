/**
 * Shared body of the three hook scripts (specs/claude-plugin). A hook never blocks a session: one top-level
 * guard, exit 0 on every path, and a failure is the single stderr line `dial <hook> hook error (ignored): <message>`.
 * The repo is resolved in-process before any subprocess; the CLI run is the plugin's own `bin/dial.mjs`.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

/**
 * Run one hook. `plan({ payload, entry })` returns `{ args, stdin?, relay? }` or null for nothing to do;
 * `relay` is false except for SessionStart. `gate(payload)` may return false before the registry is read.
 */
export function runHook(name, { gate = () => true, plan, timeoutMs }) {
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
    const result = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'bin', 'dial.mjs'), ...step.args], {
      input: step.stdin === 'payload' ? raw : '',
      encoding: 'utf8',
      timeout: timeoutMs,
      env: process.env,
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
    try {
      process.stderr.write(`dial ${name} hook error (ignored): ${oneLine(error && error.message ? error.message : error)}\n`)
    } catch {
      // a closed stderr must not change the exit code
    }
  }
}

/**
 * Exit 0 whatever happened. Only the exit code is set: every hook path is synchronous, so the process ends
 * when the event loop drains, after piped stdout (asynchronous on darwin) has been flushed. `process.exit`
 * here would cut a large SessionStart envelope at the pipe buffer.
 */
export function finish() {
  process.exitCode = 0
}
