#!/usr/bin/env node
/**
 * The `dial` shell. Owns argument parsing, the `--json` switch, the single
 * stderr writer and the exit code; everything else is in `lib/`, which never
 * touches the process.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { diagnose, formatDoctor } from '../lib/doctor.mjs'
import { ensureHome, HomeUnwritable, resolveHome } from '../lib/home.mjs'
import { effectiveLimits, formatLimits } from '../lib/limits.mjs'
import { expandHome, listRepos, loadRegistry, register, registryPath, repoName, unregister, writeRegistry } from '../lib/registry.mjs'

const USAGE = `dial — one Obsidian vault per repo, and the work/personal boundary kept sound

Usage: dial <command> [options]

Commands:
  version                      print the version (--json)
  limits                       print the published caps (--json)
  doctor                       check preconditions, the vault boundary and the permission rule (--json)
  register <path> --vault <name> --host github|gitlab
                               register a git work tree against exactly one vault
  unregister <path-or-name>    remove a registered repo
  repos                        list registered repos (--json)
  help                         print this text (also --help after any command)

Environment: DIAL_HOME (dial's state directory, default ~/.config/dial)
`

/** Per-command option table: `flag` takes no value, `value` requires one. */
const COMMANDS = {
  version: { options: { json: 'flag' }, args: 0 },
  limits: { options: { json: 'flag' }, args: 0 },
  doctor: { options: { json: 'flag' }, args: 0 },
  register: { options: { vault: 'value', host: 'value' }, args: 1 },
  unregister: { options: {}, args: 1 },
  repos: { options: { json: 'flag' }, args: 0 },
  help: { options: {}, args: 0 },
}

const REGISTER_NEEDS = 'register needs --vault <name> and --host github|gitlab'

/** A refusal raised while parsing or dispatching; its message is the bare reason. */
class Refusal extends Error {}

/** Parse the arguments after the command against its option table. */
function parseArgs(command, args) {
  const table = COMMANDS[command].options
  const options = {}
  const positionals = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg)
      continue
    }
    if (!arg.startsWith('--')) throw new Refusal(`unknown option: ${arg}`)
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    const kind = Object.hasOwn(table, name) ? table[name] : undefined
    if (!kind) throw new Refusal(`unknown option: --${name}`)
    if (kind === 'flag') {
      if (eq !== -1) throw new Refusal(`--${name} takes no value`)
      options[name] = true
      continue
    }
    let value
    if (eq !== -1) value = arg.slice(eq + 1)
    else if (i + 1 < args.length && !args[i + 1].startsWith('--')) value = args[++i]
    if (value === undefined || value === '') throw new Refusal(`--${name} needs a value`)
    options[name] = value
  }
  return { options, positionals }
}

const json = value => JSON.stringify(value, null, 2) + '\n'

function loadOrRefuse(home) {
  const loaded = loadRegistry(home)
  if (!loaded.ok) throw new Refusal(loaded.reason)
  return loaded.registry
}

/** A writing command's load: a home that cannot be read as a directory is the home's fault. */
function loadForWrite(home) {
  try {
    return loadOrRefuse(home)
  } catch (err) {
    if (err && (err.code === 'ENOTDIR' || err.code === 'EACCES')) throw new HomeUnwritable(home, err)
    throw err
  }
}

function save(env, home, reg) {
  ensureHome(env)
  writeRegistry(home, reg)
}

function formatRepos(repos) {
  if (repos.length === 0) return 'no repos registered\n'
  const width = key => Math.max(...repos.map(r => r[key].length))
  const w = { name: width('name'), vault: width('vault'), host: width('host') }
  return repos.map(r => `${r.name.padEnd(w.name)}  ${r.vault.padEnd(w.vault)}  ${r.host.padEnd(w.host)}  ${r.path}`).join('\n') + '\n'
}

function readVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
}

/** Run one command; returns the exit code. Throws `Refusal` for a known failure. */
function dispatch(command, { options, positionals }, { env, cwd, out }) {
  const spec = COMMANDS[command]
  if (positionals.length > spec.args) throw new Refusal(`unexpected argument: ${positionals[spec.args]}`)
  const home = resolveHome(env)

  switch (command) {
    case 'help':
      out(USAGE)
      return 0

    case 'version': {
      const version = readVersion()
      out(options.json ? json({ version }) : `${version}\n`)
      return 0
    }

    case 'limits': {
      const reg = loadOrRefuse(home)
      const limits = effectiveLimits(reg.limits, registryPath(home))
      if (!limits.ok) throw new Refusal(limits.reason)
      out(options.json ? json({ ...limits.limits }) : formatLimits(limits.limits))
      return 0
    }

    case 'repos': {
      const repos = listRepos(loadOrRefuse(home))
      out(options.json ? json(repos) : formatRepos(repos))
      return 0
    }

    case 'doctor': {
      const report = diagnose({ env, cwd })
      out(options.json ? json(report) : formatDoctor(report))
      return report.ok ? 0 : 1
    }

    case 'register': {
      const [path] = positionals
      if (!options.vault || !options.host) throw new Refusal(REGISTER_NEEDS)
      if (path === undefined) throw new Refusal('register needs a path: dial register <path> --vault <name> --host github|gitlab')
      const reg = loadForWrite(home)
      const abs = resolve(cwd, expandHome(path))
      const result = register(reg, { path: abs, vault: options.vault, host: options.host })
      if (!result.ok) throw new Refusal(result.reason)
      save(env, home, reg)
      out(`${repoName(abs)}\n`)
      return 0
    }

    case 'unregister': {
      const [arg] = positionals
      if (arg === undefined) throw new Refusal('unregister needs a path or a repo name')
      const reg = loadForWrite(home)
      const result = unregister(reg, arg)
      if (!result.ok) throw new Refusal(result.reason)
      save(env, home, reg)
      out(`${result.name}\n`)
      return 0
    }
  }
  throw new Refusal(`unknown command: ${command}`)
}

/**
 * Entry point. Returns the exit code; never throws and never calls
 * `process.exit`. `env`, `cwd`, `stdout` and `stderr` are injectable for tests.
 */
export function main(argv, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  const out = text => stdout.write(text)
  const fail = (reason, code = 1) => {
    stderr.write(`dial: ${String(reason).replace(/\s*\n\s*/g, ' ').trim()}\n`)
    return code
  }

  try {
    if (argv.includes('--help')) {
      out(USAGE)
      return 0
    }
    if (argv.length === 0) {
      out(USAGE)
      return 0
    }
    let [command, ...rest] = argv
    if (command === '--version') command = 'version'
    else if (command.startsWith('-')) return fail(`unknown option: ${command.split('=')[0]}`)
    if (!Object.hasOwn(COMMANDS, command)) {
      out(USAGE)
      return fail(`unknown command: ${command}`)
    }
    return dispatch(command, parseArgs(command, rest), { env, cwd, out })
  } catch (err) {
    return fail(err && err.message ? err.message : String(err))
  }
}

/** True when this file is the process entry, including through an npm bin symlink. */
function invokedDirectly() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2))
