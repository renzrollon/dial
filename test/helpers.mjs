/**
 * Shared test harness. Every helper is process-local: nothing here touches the
 * real `~/.config/dial` or `~/.claude/settings.json`.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
 */
export function runCli(args, env = {}) {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      [BIN, ...args],
      {
        env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: tmp('cli-home-'), ...env },
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
