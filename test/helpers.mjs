/**
 * Shared test harness. Every helper is process-local: nothing here touches the
 * real `~/.config/dial` or `~/.claude/settings.json`.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Absolute path of the binary under test. */
export const BIN = join(ROOT, 'bin', 'dial.mjs')

/** Absolute path of `test/fixtures/`. */
export const FIXTURES = join(ROOT, 'test', 'fixtures')

/** A fresh empty directory under `TMPDIR`. */
export function tmp(prefix = 'dial-') {
  return mkdtempSync(join(process.env.TMPDIR || tmpdir(), prefix))
}

/**
 * A fresh dial home directory that already exists. `registry` may be an
 * object (written as registry.json, two-space JSON) or a string (written
 * verbatim, for malformed-file tests). Returns the home path.
 */
export function makeHome({ registry } = {}) {
  const home = tmp('dial-home-')
  if (registry !== undefined) {
    if (typeof registry === 'string') writeFileSync(join(home, 'registry.json'), registry)
    else writeJson(join(home, 'registry.json'), registry)
  }
  return home
}

/**
 * Run the CLI as a subprocess. Never rejects: a non-zero exit is a result.
 * The child env is an allowlist (`PATH`, `TMPDIR`, a throwaway `HOME`) plus the
 * caller's overrides, so no test can see the real home or Claude settings.
 * `TZ` defaults to `UTC` so local-time rendering is the same on every machine;
 * a test overrides it with `env.TZ`.
 */
export function runCli(args, env = {}) {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      [BIN, ...args],
      {
        env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: tmp('cli-home-'), TZ: 'UTC', ...env },
        timeout: 30_000,
      },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })
    )
  })
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Two-space JSON with a trailing newline; creates missing parent directories. */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

/**
 * A sorted map of relative path to content hash for everything under `dir`.
 * Directories appear as `<dir>` so an empty one still counts; symlinks are not
 * followed. A missing `dir` is an empty map. Compare two snapshots with
 * `assert.deepEqual` for every byte-identical scenario.
 */
export function snapshotTree(dir) {
  const out = {}
  const walk = rel => {
    let names
    try {
      names = readdirSync(join(dir, rel)).sort()
    } catch (err) {
      if (err.code === 'ENOENT' && rel === '') return
      throw err
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name
      const st = lstatSync(join(dir, r))
      if (st.isDirectory()) {
        out[r] = '<dir>'
        walk(r)
      } else if (st.isSymbolicLink()) {
        out[r] = '<symlink>'
      } else {
        out[r] = createHash('sha256').update(readFileSync(join(dir, r))).digest('hex')
      }
    }
  }
  walk('')
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/**
 * Make `root` look like a git work tree: a `.git` directory, or with
 * `{ worktree: true }` a `.git` file as a linked worktree has. Creates `root`
 * if missing and returns it.
 */
export function makeGitDir(root, { worktree = false } = {}) {
  mkdirSync(root, { recursive: true })
  if (worktree) writeFileSync(join(root, '.git'), 'gitdir: /nonexistent/.git/worktrees/x\n')
  else mkdirSync(join(root, '.git'), { recursive: true })
  return root
}

/**
 * Write notes into a vault at `root`. Each note is `{ path, frontmatter, body }`:
 * `path` is relative to the vault (e.g. `Projects/katipon.md`), `frontmatter`
 * an object of flat scalars (or a raw string, or omitted for none), `body` text.
 * Only the folders the notes need are created. Returns `root`.
 */
export function makeVault(root, notes = []) {
  mkdirSync(root, { recursive: true })
  for (const { path, frontmatter, body = '' } of notes) {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    let head = ''
    if (typeof frontmatter === 'string') head = `---\n${frontmatter}\n---\n`
    else if (frontmatter) head = `---\n${Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n`
    writeFileSync(file, head + body)
  }
  return root
}

/**
 * Serialise one fixture file body. A string is written verbatim; an array for a
 * `.jsonl` path is one JSON value per line; any other value is two-space JSON
 * with a trailing newline.
 */
function fileBody(path, content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content) && path.endsWith('.jsonl')) return content.map(line => JSON.stringify(line)).join('\n') + '\n'
  return JSON.stringify(content, null, 2) + '\n'
}

/** Write `{ relativePath: content }` under `root`, creating parent directories. Returns `root`. */
function writeTree(root, tree = {}) {
  for (const [rel, content] of Object.entries(tree)) {
    const file = join(root, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, fileBody(rel, content))
  }
  return root
}

/** A `tasks.md` body: a string verbatim, or `{ done, total }` as `total` checkbox lines. */
function tasksBody(tasks) {
  if (typeof tasks === 'string') return tasks
  return `# Tasks\n\n${Array.from({ length: tasks.total }, (_, i) => `- [${i < tasks.done ? 'x' : ' '}] 1.${i + 1} Task ${i + 1}`).join('\n')}\n`
}

/**
 * A fixture repository built from a declarative object; every key is optional.
 *
 *   git        `true` (a `.git` directory), `{ worktree: true }` (a `.git` file)
 *              or `false`/omitted (not a work tree)
 *   changes    `{ <name>: { tasks, files } }` written to `openspec/changes/<name>/`;
 *              `tasks` is `tasks.md` text or `{ done, total }`; `files` is
 *              `{ <relative path>: content }` inside the change directory
 *   archive    `{ '<YYYY-MM-DD>-<name>': { files } }` under `openspec/changes/archive/`
 *   ship       `{ <path>: content }` under `.claude/ship/` (`run.json`,
 *              `<change>/stage.json`, `runs/<id>.jsonl`, `interrupted/<id>.json`, ...)
 *   outcomes   an array of records written as `.claude/learning/outcomes.jsonl`
 *   files      `{ <path>: content }` anywhere else under `root`
 *
 * Content is a string (verbatim), an array for a `.jsonl` path (one JSON value
 * per line) or any other value (two-space JSON). An empty `{}` still creates
 * `root`, which is returned.
 */
export function makeRepo(root, spec = {}) {
  mkdirSync(root, { recursive: true })
  if (spec.git) makeGitDir(root, spec.git === true ? {} : spec.git)
  if (spec.changes || spec.archive) mkdirSync(join(root, 'openspec', 'changes'), { recursive: true })
  for (const [name, { tasks, files = {} } = {}] of Object.entries(spec.changes ?? {})) {
    const dir = join('openspec', 'changes', name)
    writeTree(root, tasks === undefined ? {} : { [join(dir, 'tasks.md')]: tasksBody(tasks) })
    mkdirSync(join(root, dir), { recursive: true })
    writeTree(join(root, dir), files)
  }
  for (const [name, { files = {} } = {}] of Object.entries(spec.archive ?? {})) {
    const dir = join(root, 'openspec', 'changes', 'archive', name)
    mkdirSync(dir, { recursive: true })
    writeTree(dir, files)
  }
  if (spec.ship) writeTree(join(root, '.claude', 'ship'), spec.ship)
  if (spec.outcomes) writeTree(root, { '.claude/learning/outcomes.jsonl': spec.outcomes })
  if (spec.files) writeTree(root, spec.files)
  return root
}

/**
 * A synchronous stand-in for `lib/subprocess.mjs` `exec(file, args, opts)`.
 * `table` maps `'<file> <arg> <arg>'` (words joined by one space) to a reply:
 * a partial `{ ok, code, stdout, stderr, missing }` (`code` defaults to 0 and
 * `ok` to `code === 0`), the string `'missing'` (binary not on PATH), or a
 * function `(file, args, opts) => reply`. A command not in the table is a
 * failure whose stderr names the key, so an unexpected call is visible rather
 * than silent. Every call is recorded on `exec.calls` as `{ file, args, opts }`.
 */
export function fakeExec(table = {}) {
  const exec = (file, args = [], opts = {}) => {
    exec.calls.push({ file, args, opts })
    const key = [file, ...args].join(' ')
    let reply = Object.hasOwn(table, key) ? table[key] : { code: 1, stderr: `fakeExec: no canned reply for: ${key}` }
    if (typeof reply === 'function') reply = reply(file, args, opts)
    if (reply === 'missing') reply = { missing: true }
    const { code = reply.missing ? null : 0, stdout = '', stderr = '', missing = false } = reply
    return { ok: !missing && (reply.ok ?? code === 0), code, stdout, stderr, missing }
  }
  exec.calls = []
  return exec
}

/**
 * Write an executable `/bin/sh` script `name` into `dir` (created if missing)
 * whose body is `body`, and return its path. Put `dir` first on a child's PATH
 * to stand in for `gh`, `glab`, `interlock`, `escapement` or `launchctl`; a body
 * that appends `"$@"` to a file records its invocations.
 */
export function fakeBinary(dir, name, body = 'exit 0') {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

/**
 * A `fetch` stand-in. `replies` is an array consumed in order (a call past the
 * end rejects), or a function `(url, init) => reply`. A reply is one of
 * `{ status = 200, body, headers }` (`body` an object is sent as JSON, a string
 * verbatim), an `Error` (the call rejects with it), or `'hang'` (never settles
 * until `init.signal` aborts, then rejects with an `AbortError`). Resolves a
 * real `Response`. Every call is recorded on `fetch.calls` as `{ url, init }`.
 */
export function fakeFetch(replies = []) {
  const queue = Array.isArray(replies) ? [...replies] : null
  const fetch = (url, init = {}) => {
    fetch.calls.push({ url: String(url), init })
    const reply = queue ? queue.shift() : replies(String(url), init)
    if (reply === undefined) return Promise.reject(new Error(`fakeFetch: no reply left for ${url}`))
    if (reply instanceof Error) return Promise.reject(reply)
    if (reply === 'hang') {
      return new Promise((_, reject) => {
        const abort = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
        if (init.signal?.aborted) abort()
        else init.signal?.addEventListener('abort', abort, { once: true })
      })
    }
    const { status = 200, body = '', headers = {} } = reply
    const isJson = body !== null && typeof body === 'object'
    return Promise.resolve(
      new Response(isJson ? JSON.stringify(body) : body, {
        status,
        headers: { ...(isJson ? { 'content-type': 'application/json' } : {}), ...headers },
      })
    )
  }
  fetch.calls = []
  return fetch
}

/**
 * A frozen clock. `now()` returns a new `Date` at the frozen instant; `iso` is
 * the instant as `toISOString()`; `advance(ms)` moves it forward and returns
 * the clock, so a test can drive a deadline. `iso` must carry an offset or `Z`,
 * as `DIAL_NOW` does.
 */
export function frozenNow(iso) {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)) throw new TypeError(`frozenNow: ${iso} has no offset`)
  let ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new TypeError(`frozenNow: ${iso} is not a date`)
  const now = () => new Date(ms)
  Object.defineProperty(now, 'iso', { get: () => new Date(ms).toISOString() })
  now.advance = by => {
    ms += by
    return now
  }
  return now
}
