/**
 * `dial doctor`: the precondition report. Twelve checks (the last six never fail), each a record
 * `{ id, status, detail, evidence, fix? }` with status ok | warn | fail | skip,
 * gathered into `{ ok, home, counts, checks, failures, warnings }`.
 *
 * Pure with respect to the process: `env`, `cwd` and `pathDirs` are arguments.
 * Nothing here writes, except the home probe file, which is removed at once.
 */
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, relative, resolve, isAbsolute, sep } from 'node:path'
import { readFrontmatter } from './frontmatter.mjs'
import { HomeUnwritable, resolveHome } from './home.mjs'
import { status as agentStatus } from './agent.mjs'
import { resolveEndpoint } from './narrate.mjs'
import { CHANGE_KEYS, REPO_KEYS } from './render.mjs'
import { collapseHome, expandHome, listRepos, loadRegistry, registryPath, rootVault } from './registry.mjs'
import { collectPermissions, coverage, parseRule, ruleCovers, settingsSources } from './settings.mjs'

const MIN_NODE_MAJOR = 22
const DIAL_RULE = 'Bash(dial:*)'
const SNIPPET_TARGET = '~/.claude/settings.json'

const oneLine = text => String(text).replace(/\s*\n\s*/g, ' ').trim()

/** Build a check record. `extra` may carry `evidence` (string[]) and `fix` (string). */
export function check(id, status, detail, extra = {}) {
  const record = { id, status, detail: oneLine(detail), evidence: (extra.evidence ?? []).map(String) }
  if (typeof extra.fix === 'string' && extra.fix) record.fix = extra.fix
  return record
}

/** Run one check; a throw becomes a `fail` record so the rest of the report still runs. */
export function run(id, fn) {
  try {
    return fn()
  } catch (err) {
    return check(id, 'fail', `check could not run: ${err && err.message ? err.message : String(err)}`)
  }
}

/** The six advisory checks never fail: a throw is a skip that says the check could not run. */
function advise(id, fn) {
  try {
    return fn()
  } catch (err) {
    return check(id, 'skip', `check could not run: ${err && err.message ? err.message : String(err)}`)
  }
}

// ----------------------------------------------------------------------- node

function checkNode() {
  const version = process.versions.node
  const major = Number(version.split('.')[0])
  if (major >= MIN_NODE_MAJOR) return check('node', 'ok', `node ${version}`)
  return check('node', 'fail', `node ${version} is older than ${MIN_NODE_MAJOR}`, {
    evidence: [process.execPath],
    fix: `install Node ${MIN_NODE_MAJOR} or newer`,
  })
}

// ----------------------------------------------------------------------- home

function nearestExisting(path) {
  let dir = path
  while (!existsSync(dir)) {
    const parent = dirname(dir)
    if (parent === dir) return dir
    dir = parent
  }
  return dir
}

/** Probe the home without creating it. */
function checkHome(home) {
  const evidence = [home]
  try {
    if (existsSync(home)) {
      // A regular file fails here with the OS error (ENOTDIR), which is the reason we want.
      const probe = join(home, `.probe-${process.pid}-${Date.now()}`)
      try {
        writeFileSync(probe, '')
        unlinkSync(probe)
      } catch (err) {
        throw new HomeUnwritable(home, err)
      }
      return check('home', 'ok', 'writable', { evidence })
    }
    const ancestor = nearestExisting(home)
    evidence.push(`nearest existing ancestor: ${ancestor}`)
    try {
      if (!statSync(ancestor).isDirectory()) {
        const err = new Error(`not a directory: ${ancestor}`)
        err.code = 'ENOTDIR'
        throw err
      }
      accessSync(ancestor, constants.W_OK)
    } catch (err) {
      throw new HomeUnwritable(home, err)
    }
    return check('home', 'ok', 'will be created on first register', { evidence })
  } catch (err) {
    if (!(err instanceof HomeUnwritable)) throw err
    return check('home', 'fail', err.message, {
      evidence,
      fix: 'set DIAL_HOME to a directory you can write, or fix the permissions on this one',
    })
  }
}

// ------------------------------------------------------------------- registry

/** loadRegistry, with an unexpected read error turned into a load failure. */
function loadSafely(home) {
  try {
    return loadRegistry(home)
  } catch (err) {
    return { ok: false, reason: `registry could not be read: ${registryPath(home)} (${err.message})` }
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function checkRegistry(home, loaded) {
  const file = registryPath(home)
  if (!existsSync(file) && loaded.ok) return check('registry', 'ok', 'no registry yet', { evidence: [file] })
  if (!loaded.ok) {
    return check('registry', 'fail', loaded.reason, { evidence: [file], fix: `fix ${file} by hand` })
  }
  const reg = loaded.registry
  const badVaults = []
  for (const [name, path] of Object.entries(reg.vaults)) {
    const abs = expandHome(path)
    if (!existsSync(abs)) badVaults.push(`vault ${name} does not exist: ${abs}`)
    else if (!isDir(abs)) badVaults.push(`vault ${name} is not a directory: ${abs}`)
  }
  const badRepos = []
  for (const repo of listRepos(reg)) {
    if (!existsSync(repo.path)) badRepos.push(`repo ${repo.name} path does not exist: ${repo.path}`)
    else if (!isDir(repo.path)) badRepos.push(`repo ${repo.name} path is not a directory: ${repo.path}`)
    else if (!existsSync(join(repo.path, '.git'))) badRepos.push(`repo ${repo.name} is not a git work tree: ${repo.path}`)
  }
  const evidence = [file, ...badVaults, ...badRepos]
  if (badVaults.length) {
    const more = badVaults.length > 1 ? ` (and ${badVaults.length - 1} more)` : ''
    return check('registry', 'fail', `${badVaults[0]}${more}`, {
      evidence,
      fix: `create the vault directory or correct its path under "vaults" in ${file}`,
    })
  }
  if (badRepos.length) {
    const more = badRepos.length > 1 ? ` (and ${badRepos.length - 1} more)` : ''
    return check('registry', 'warn', `${badRepos[0]}${more}`, {
      evidence,
      fix: 'move the repo back, or dial unregister it and register its new path',
    })
  }
  const vaults = Object.keys(reg.vaults).length
  return check('registry', 'ok', `${vaults} vault(s), ${reg.repos.length} repo(s)`, { evidence })
}

// --------------------------------------------------------------- obsidian-cli

function defaultPathDirs(env) {
  return String(env.PATH ?? '').split(delimiter).filter(Boolean)
}

function checkObsidian(pathDirs) {
  for (const dir of pathDirs) {
    const candidate = join(dir, 'obsidian')
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
    } catch {
      continue
    }
    return check('obsidian-cli', 'ok', `obsidian at ${candidate}`, { evidence: [candidate] })
  }
  return check('obsidian-cli', 'skip', 'obsidian not on PATH; direct file writes are the primary path')
}

// ------------------------------------------------------------------- boundary

const FOLDERS = ['Projects', 'Changes']

function listNotes(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name)
      .sort()
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return []
    throw err
  }
}

function noteRepo(folder, name, frontmatter) {
  if (frontmatter.repo) return frontmatter.repo
  const stem = name.slice(0, -'.md'.length)
  if (folder === 'Changes') {
    const at = stem.indexOf('--')
    return at === -1 ? stem : stem.slice(0, at)
  }
  return stem
}

/** Read-only audit: a Dial note must sit in the vault its repo is registered to. */
function checkBoundary(loaded) {
  if (!loaded.ok) return check('boundary', 'skip', 'registry not loaded')
  const reg = loaded.registry
  const vaultOf = new Map(listRepos(reg).map(r => [r.name, r.vault]))
  const violations = []
  const evidence = []
  let notes = 0
  for (const [vault, path] of Object.entries(reg.vaults)) {
    const root = expandHome(path)
    let inVault = 0
    for (const folder of FOLDERS) {
      for (const name of listNotes(join(root, folder))) {
        const file = join(root, folder, name)
        const frontmatter = readFrontmatter(readFileSync(file, 'utf8'))
        if (!frontmatter || !Object.hasOwn(frontmatter, 'dial_schema')) continue
        inVault++
        const repo = noteRepo(folder, name, frontmatter)
        const registered = vaultOf.get(repo)
        if (registered !== undefined && registered !== vault) {
          violations.push(`${file} is in vault ${vault} but ${repo} is registered to vault ${registered}`)
        }
      }
    }
    notes += inVault
    evidence.push(`${vault}: ${root} (${inVault} dial note(s))`)
  }
  const rootFixes = []
  for (const repo of listRepos(reg)) {
    const root = rootVault(reg, repo.path)
    if (!root || root.vault === repo.vault) continue
    const shown = collapseHome(repo.path)
    violations.push(`${shown} is registered to vault ${repo.vault} but lies under root ${root.root}, which belongs to vault ${root.vault}`)
    rootFixes.push(`dial unregister ${repo.name}, then dial register ${shown} --vault ${root.vault} --host ${repo.host}`)
  }
  if (violations.length) {
    const more = violations.length > 1 ? ` (and ${violations.length - 1} more)` : ''
    return check('boundary', 'fail', `${violations[0]}${more}`, {
      evidence: violations,
      fix: rootFixes.length ? rootFixes.join('\n') : 'fix the registry entry or move the note',
    })
  }
  if (notes === 0) return check('boundary', 'ok', 'no dial notes', { evidence })
  return check('boundary', 'ok', `${notes} dial note(s), each in its repo's vault`, { evidence })
}

// ---------------------------------------------------------------- permissions

/** The paste-ready allow snippet: one double-quoted rule per line, no trailing comma. */
export function allowSnippet(rules = [DIAL_RULE]) {
  const body = rules.map((r, i) => JSON.stringify(r) + (i < rules.length - 1 ? ',' : ''))
  return [`Add to ${SNIPPET_TARGET} → permissions.allow:`, ...body].join('\n')
}

function checkPermissions(env, cwd) {
  const userHome = env.HOME || homedir()
  const permissions = collectPermissions(settingsSources(cwd, userHome))
  const verdict = coverage(permissions, 'dial')
  const evidence = [
    ...verdict.read.map(({ scope, path }) => `${scope}: ${path}`),
    ...verdict.errors.map(({ scope, path, reason }) => `${scope}: ${path} (unreadable: ${oneLine(reason)})`),
  ]
  if (!verdict.covered) {
    const detail = verdict.narrower
      ? `only a narrower rule allows dial; ${DIAL_RULE} is not covered`
      : `${DIAL_RULE} is not allowed in any settings file`
    return check('permissions', 'warn', detail, { evidence, fix: allowSnippet() })
  }
  if (verdict.denied) {
    const req = parseRule(DIAL_RULE)
    const rules = permissions.rules.deny.filter(r => ruleCovers(r, req)).map(r => `${r.rule} (${r.scope})`)
    return check('permissions', 'warn', `${DIAL_RULE} is allowed but denied by ${rules.join(', ')}`, {
      evidence,
      fix: 'remove the matching rule from permissions.deny',
    })
  }
  if (verdict.errors.length) {
    const first = verdict.errors[0]
    return check('permissions', 'warn', `settings file could not be read: ${first.path}`, {
      evidence,
      fix: `fix the JSON in ${first.path}`,
    })
  }
  return check('permissions', 'ok', `${DIAL_RULE} is allowed`, { evidence })
}

// ------------------------------------------------------------ the six advisory

const NOT_LOADED = 'registry not loaded'

/** Warn when a registered vault lacks `Projects/`, `Changes/` or `Dial.base`; never writes. */
function checkVaultScaffold(loaded) {
  if (!loaded.ok) return check('vault-scaffold', 'skip', NOT_LOADED)
  const evidence = []
  const fixes = []
  for (const [name, path] of Object.entries(loaded.registry.vaults).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const root = expandHome(path)
    const missing = [['Projects', 'Projects/'], ['Changes', 'Changes/'], ['Dial.base', 'Dial.base']]
      .filter(([entry]) => !existsSync(join(root, entry)))
      .map(([, label]) => label)
    if (!missing.length) continue
    evidence.push(`${name}: missing ${missing.join(', ')}`)
    fixes.push(`dial vault init ${name}`)
  }
  if (!evidence.length) return check('vault-scaffold', 'ok', 'every vault has the Dial layout')
  return check('vault-scaffold', 'warn', `${evidence.length} vault(s) without the full Dial layout`, { evidence, fix: fixes.join('\n') })
}

/** True when `inner` equals or lies inside `outer`, compared segment by segment. */
function lies(inner, outer) {
  const rel = relative(outer, inner)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Warn when one registered vault is equal to or inside another. */
function checkVaultNesting(loaded) {
  if (!loaded.ok) return check('vault-nesting', 'skip', NOT_LOADED)
  const vaults = Object.entries(loaded.registry.vaults)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, path]) => ({ name, path: resolve(expandHome(path)) }))
  const found = []
  for (let i = 0; i < vaults.length; i++) {
    for (let j = i + 1; j < vaults.length; j++) {
      const a = vaults[i]
      const b = vaults[j]
      if (lies(b.path, a.path)) found.push({ inner: b, outer: a })
      else if (lies(a.path, b.path)) found.push({ inner: a, outer: b })
    }
  }
  if (!found.length) return check('vault-nesting', 'ok', 'no nested vaults')
  const first = found[0]
  const more = found.length > 1 ? ` (and ${found.length - 1} more)` : ''
  return check('vault-nesting', 'warn', `vault ${first.inner.name} lies inside vault ${first.outer.name}${more}`, {
    evidence: found.flatMap(f => [`${f.outer.name}: ${f.outer.path}`, `${f.inner.name}: ${f.inner.path}`]),
    fix: 'register vaults that do not contain one another, so a note cannot cross the work/personal boundary',
  })
}

/** The resolved narrate endpoint, read from files only; the built-in fallback does not count and no key is printed. */
function checkNarrateEndpoint(loaded, env) {
  const registry = loaded.ok ? loaded.registry : undefined
  const { primary } = resolveEndpoint({ registry, env })
  if (!primary) return check('narrate-endpoint', 'skip', 'no narrate endpoint configured')
  return check('narrate-endpoint', 'ok', `${primary.url} (${primary.model})`, { evidence: [`from: ${primary.from || 'unknown'}`] })
}

/** The LaunchAgent status, as `dial agent status` reads it. */
function checkLaunchAgent(env, platform) {
  const result = agentStatus({ env, ...(platform ? { platform } : {}) })
  if (!result.ok) return check('launch-agent', 'skip', result.reason)
  if (result.outcome === 'running') return check('launch-agent', 'ok', `running${result.pid ? ` (pid ${result.pid})` : ''}`, { evidence: [result.plistPath] })
  if (result.outcome === 'idle') return check('launch-agent', 'ok', `idle (last exit ${result.lastExit})`, { evidence: [result.plistPath] })
  if (result.outcome === 'not-installed') return check('launch-agent', 'skip', 'not installed', { evidence: [result.plistPath] })
  return check('launch-agent', 'warn', result.outcome, {
    evidence: [result.plistPath, ...(result.missing ?? [])],
    fix: result.fix,
  })
}

/** An executable `dial` in a PATH directory, else a warning. */
function checkOnPath(pathDirs) {
  for (const dir of pathDirs) {
    const candidate = join(dir, 'dial')
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
    } catch {
      continue
    }
    return check('on-path', 'ok', `dial at ${candidate}`, { evidence: [candidate] })
  }
  return check('on-path', 'warn', 'dial is not on PATH', { fix: 'npm i -g .' })
}

const FIELD_LINES = [
  // Built from the renderers' own key lists, so the disclosure cannot drift from what is written.
  `change note: ${CHANGE_KEYS.join(', ')}`,
  `repo note: ${REPO_KEYS.join(', ')}`,
  'summary note: type, tags, dial_schema',
  'daily note: type, updated',
  'review note: title, created, updated, type, status, tags, dial_schema',
  'body sections: ## State (fact, value, evidence: repository-relative file paths, commands run, PR and pipeline URLs, check names, run ids), ## Changes, ## Drift (counts), ## Recent narrative (narrative text), daily log lines',
]

/** What leaves a repository, listed; reads nothing. */
function checkFields() {
  return check('fields', 'ok', 'frontmatter keys dial writes into a vault (listed in --json evidence)', { evidence: FIELD_LINES })
}

// --------------------------------------------------------------------- report

/** Run every check and assemble the report. Never throws for a check's sake. */
export function diagnose({ env = process.env, cwd = process.cwd(), pathDirs, platform } = {}) {
  const home = resolveHome(env)
  const loaded = loadSafely(home)
  const dirs = pathDirs === undefined ? defaultPathDirs(env) : pathDirs
  const checks = [
    run('node', () => checkNode()),
    run('home', () => checkHome(home)),
    run('registry', () => checkRegistry(home, loaded)),
    run('obsidian-cli', () => checkObsidian(dirs)),
    run('boundary', () => checkBoundary(loaded)),
    run('permissions', () => checkPermissions(env, cwd)),
    advise('vault-scaffold', () => checkVaultScaffold(loaded)),
    advise('vault-nesting', () => checkVaultNesting(loaded)),
    advise('narrate-endpoint', () => checkNarrateEndpoint(loaded, env)),
    advise('launch-agent', () => checkLaunchAgent(env, platform)),
    advise('on-path', () => checkOnPath(dirs)),
    advise('fields', () => checkFields()),
  ]
  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 }
  for (const c of checks) counts[c.status]++
  return {
    ok: counts.fail === 0,
    home,
    counts,
    checks,
    failures: checks.filter(c => c.status === 'fail').map(c => c.id),
    warnings: checks.filter(c => c.status === 'warn').map(c => c.id),
  }
}

const MARKS = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' }

/** The text report: header, home line, one row per check; evidence and fix only on warn and fail. */
export function formatDoctor(report) {
  const { counts } = report
  let header = counts.fail > 0 ? `DIAL BLOCKED — ${counts.fail} failing check(s)` : `DIAL OK — ${counts.ok} passed`
  if (counts.warn > 0) header += `, ${counts.warn} warning(s)`
  const out = [header, `  home: ${report.home}`]
  for (const c of report.checks) {
    out.push(`  [${MARKS[c.status] ?? c.status}] ${c.id}: ${c.detail}`)
    if (c.status !== 'warn' && c.status !== 'fail') continue
    for (const e of c.evidence) out.push(`         ${e}`)
    if (c.fix) {
      const [first, ...rest] = c.fix.split('\n')
      out.push(`      fix: ${first}`)
      for (const line of rest) out.push(`           ${line}`)
    }
  }
  return out.join('\n') + '\n'
}
