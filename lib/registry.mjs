/**
 * The registry: the one file Dial maintains. Maps each registered repository to
 * exactly one vault and one forge host. Lib functions return data or
 * `{ ok: false, reason }` (bare reasons); only `writeRegistry` and an
 * unexpected read error throw.
 */
import { existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { effectiveLimits } from './limits.mjs'

export const SCHEMA = 'dial.registry/1'
const HOSTS = ['github', 'gitlab']
const NARRATE_KEYS = ['provider', 'url', 'model', 'apiKeyEnv', 'fallbackUrl', 'fallbackModel']
const NARRATE_URL_KEYS = ['url', 'fallbackUrl']

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

/** The optional `narrate` block: an object of the six published string keys; urls are http(s). Null when valid. */
function validateNarrate(narrate) {
  if (!isObject(narrate)) return { ok: false, reason: 'registry narrate must be an object' }
  for (const [key, value] of Object.entries(narrate)) {
    if (!NARRATE_KEYS.includes(key)) return { ok: false, reason: `unknown narrate key: ${key}` }
    if (typeof value !== 'string') return { ok: false, reason: `narrate ${key} must be a string` }
    if (NARRATE_URL_KEYS.includes(key) && !/^https?:\/\//.test(value)) {
      return { ok: false, reason: `narrate url must start with http:// or https://: ${value}` }
    }
  }
  return null
}

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
  if (raw.narrate !== undefined) {
    const narrate = validateNarrate(raw.narrate)
    if (narrate) return narrate
  }
  if (raw.roots !== undefined) {
    if (!isObject(raw.roots)) return bad(`registry roots must be an object of directory to vault name: ${path}`)
    for (const [dir, vault] of Object.entries(raw.roots)) {
      if (typeof vault !== 'string' || !Object.hasOwn(raw.vaults, vault)) {
        return bad(`registry root ${dir}: vault ${JSON.stringify(vault)} is not in vaults (${path})`)
      }
    }
  }

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

/** The real path of an absolute path, or the path itself when it cannot be resolved. */
function realOrSelf(abs) {
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/** The lexical and real forms of a path (`~` expanded, made absolute), without duplicates. */
function pathForms(path) {
  const lexical = resolve(expandHome(path))
  const real = realOrSelf(lexical)
  return real === lexical ? [lexical] : [lexical, real]
}

/** `abs` equals `base` or lies inside it, segment by segment. */
function contains(base, abs) {
  if (abs === base) return true
  return abs.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * The shared containment helper: how long is the longest of `bases`'s forms
 * that equals or contains one of `path`'s forms, or -1 for none. Compares real
 * and lexical forms on both sides, so a symlinked registration matches a
 * physical path and a deleted directory still matches its stored form.
 */
function containment(bases, path) {
  const forms = pathForms(path)
  let best = -1
  for (const base of pathForms(bases)) {
    if (forms.some(form => contains(base, form))) best = Math.max(best, base.length)
  }
  return best
}

/**
 * The registered repo a name, path, or path inside a repo names: `{ name, path
 * (expanded), vault, host }` or null. A name match wins; otherwise the longest
 * registered path equal to or containing the argument wins.
 */
export function resolveRepo(reg, arg) {
  if (typeof arg !== 'string' || !arg) return null
  const repos = listRepos(reg)
  const named = repos.find(r => r.name === arg)
  if (named) return named
  let best = null
  let bestLength = -1
  for (const repo of repos) {
    const length = containment(repo.path, arg)
    if (length > bestLength) {
      best = repo
      bestLength = length
    }
  }
  return best
}

/**
 * The vault a `roots` entry assigns to a path: `{ root (as written), vault }`
 * for the longest root equal to or containing it, or null for a path under no
 * root or a registry without `roots`.
 */
export function rootVault(reg, path) {
  let best = null
  let bestLength = -1
  for (const [root, vault] of Object.entries(reg.roots ?? {})) {
    const length = containment(root, path)
    if (length > bestLength) {
      best = { root, vault }
      bestLength = length
    }
  }
  return best
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

  const root = rootVault(reg, abs)
  if (root && root.vault !== vault) {
    return {
      ok: false,
      reason: `${collapseHome(abs)} is under ${root.root}, which belongs to vault ${root.vault}; a repo belongs to exactly one vault`
    }
  }

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
