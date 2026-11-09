/**
 * The registry: the one file Dial maintains. Maps each registered repository to
 * exactly one vault and one forge host. Lib functions return data or
 * `{ ok: false, reason }` (bare reasons); only `writeRegistry` and an
 * unexpected read error throw.
 */
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { effectiveLimits } from './limits.mjs'

export const SCHEMA = 'dial.registry/1'
const HOSTS = ['github', 'gitlab']

export function registryPath(home) {
  return join(home, 'registry.json')
}

export function repoName(path) {
  return basename(path)
}

export function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

export function collapseHome(path) {
  const home = homedir()
  if (path === home) return '~'
  if (path.startsWith(home + '/')) return '~' + path.slice(home.length)
  return path
}

function emptyRegistry() {
  return { dial_schema: SCHEMA, vaults: {}, repos: [], limits: {} }
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Check a parsed registry; every command that reads the file goes through this one verdict. */
export function validateRegistry(raw, path) {
  const bad = reason => ({ ok: false, reason })
  if (!isObject(raw)) return bad(`registry is not a JSON object: ${path}`)
  if (raw.dial_schema !== SCHEMA) {
    const found = raw.dial_schema === undefined ? 'missing' : JSON.stringify(raw.dial_schema)
    return bad(`registry schema is not recognised: ${path} (dial_schema: ${found}, expected ${SCHEMA})`)
  }
  if (!isObject(raw.vaults)) return bad(`registry vaults must be an object of vault name to path: ${path}`)
  for (const [name, dir] of Object.entries(raw.vaults)) {
    if (typeof dir !== 'string' || !dir) return bad(`registry vault ${name} must be a path string: ${path}`)
  }
  if (!Array.isArray(raw.repos)) return bad(`registry repos must be an array: ${path}`)
  const limits = effectiveLimits(raw.limits, path)
  if (!limits.ok) return limits

  const byPath = new Map()
  const byName = new Map()
  for (const entry of raw.repos) {
    if (!isObject(entry) || typeof entry.path !== 'string' || !entry.path) {
      return bad(`registry repo entry needs a path: ${path}`)
    }
    if (typeof entry.vault !== 'string' || !Object.hasOwn(raw.vaults, entry.vault)) {
      return bad(`registry repo ${entry.path}: vault ${JSON.stringify(entry.vault)} is not in vaults (${path})`)
    }
    if (!HOSTS.includes(entry.host)) {
      return bad(`registry repo ${entry.path}: host must be github or gitlab, not ${entry.host} (${path})`)
    }
    const abs = expandHome(entry.path)
    const name = repoName(abs)
    if (byPath.has(abs)) return bad(`registry repos: ${byPath.get(abs)} and ${entry.path} are the same path (${path})`)
    if (byName.has(name)) {
      return bad(`registry repos: two repos are named ${name}: ${byName.get(name)} and ${entry.path} (${path})`)
    }
    byPath.set(abs, entry.path)
    byName.set(name, entry.path)
  }
  return { ok: true, registry: { ...raw, limits: raw.limits ?? {} } }
}

/** Load `<home>/registry.json`. A missing file is the empty registry and is not created. */
export function loadRegistry(home) {
  const file = registryPath(home)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, registry: emptyRegistry() }
    throw err
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { ok: false, reason: `registry is not valid json: ${file} (${err.message})` }
  }
  return validateRegistry(raw, file)
}

/** Add or update a repo. Mutates `reg` on success only. */
export function register(reg, { path, vault, host }) {
  if (!HOSTS.includes(host)) return { ok: false, reason: `--host must be github or gitlab, not ${host}` }
  if (!Object.hasOwn(reg.vaults, vault)) {
    return {
      ok: false,
      reason: `unknown vault ${vault}; add it under "vaults" in the registry file, for example "${vault}": "/absolute/path/to/${vault}-vault"`
    }
  }
  const abs = resolve(expandHome(path))
  const name = repoName(abs)

  const existing = reg.repos.find(e => resolve(expandHome(e.path)) === abs || repoName(expandHome(e.path)) === name)
  if (existing) {
    if (existing.vault !== vault) {
      return {
        ok: false,
        reason: `${repoName(expandHome(existing.path))} is registered to vault ${existing.vault} (${existing.path}); a repo belongs to exactly one vault`
      }
    }
    if (resolve(expandHome(existing.path)) !== abs) {
      return { ok: false, reason: `${name} is already registered at ${existing.path}; repo names must be unique` }
    }
  }

  if (!existsSync(abs)) return { ok: false, reason: `path does not exist: ${abs}` }
  if (!statSync(abs).isDirectory()) return { ok: false, reason: `path is not a directory: ${abs}` }
  if (!existsSync(join(abs, '.git'))) return { ok: false, reason: `${abs} is not a git work tree (no .git entry)` }

  if (existing) {
    existing.host = host
    return { ok: true, updated: true }
  }
  reg.repos.push({ path: collapseHome(abs), vault, host })
  return { ok: true }
}

/** Remove the first repo matching the stored path, the expanded path, or the name. */
export function unregister(reg, arg) {
  const matchers = [
    e => e.path === arg,
    e => expandHome(e.path) === resolve(expandHome(arg)),
    e => repoName(expandHome(e.path)) === arg
  ]
  for (const matches of matchers) {
    const i = reg.repos.findIndex(matches)
    if (i !== -1) {
      const [removed] = reg.repos.splice(i, 1)
      return { ok: true, name: repoName(expandHome(removed.path)) }
    }
  }
  return { ok: false, reason: `no registered repo matches ${arg}` }
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** `[{ name, path (expanded), vault, host }]` sorted by name. */
export function listRepos(reg) {
  return reg.repos
    .map(e => {
      const path = expandHome(e.path)
      return { name: repoName(path), path, vault: e.vault, host: e.host }
    })
    .sort((a, b) => byText(a.name, b.name) || byText(a.path, b.path))
}

/**
 * Write `<home>/registry.json` atomically: temp file in the home, then rename.
 * Fixed key order and repos sorted by name, so an unchanged registry is
 * byte-identical. Throws on failure; does not create the home.
 */
export function writeRegistry(home, reg) {
  const { dial_schema, vaults, repos, limits, ...rest } = reg
  const ordered = {
    dial_schema,
    vaults,
    repos: [...repos]
      .map(({ path, vault, host, ...more }) => ({ path, vault, host, ...more }))
      .sort((a, b) => byText(repoName(expandHome(a.path)), repoName(expandHome(b.path))) || byText(a.path, b.path)),
    limits: limits ?? {},
    ...rest
  }
  const file = registryPath(home)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(ordered, null, 2) + '\n')
    renameSync(tmp, file)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {}
    throw err
  }
}
