#!/usr/bin/env node
/**
 * The `dial` shell. Owns argument parsing, the `--json` switch, the single
 * stderr writer and the exit code; everything else is in `lib/`, which never
 * touches the process.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatResult, install, status, uninstall } from '../lib/agent.mjs'
import { brief, formatBrief, hookEnvelope } from '../lib/brief.mjs'
import { diagnose, formatDoctor } from '../lib/doctor.mjs'
import { ensureHome, HomeUnwritable, resolveHome } from '../lib/home.mjs'
import { effectiveLimits, formatLimits } from '../lib/limits.mjs'
import { DEFAULT_SOURCE, handoff } from '../lib/handoff.mjs'
import { evalSet, narrate } from '../lib/narrate.mjs'
import { formatNext, nextItems } from '../lib/next.mjs'
import { BAD_EVENT, parsePayload, record, RECORD_EVENTS } from '../lib/record.mjs'
import {
  expandHome, listRepos, loadRegistry, register, registryPath, repoName, resolveRepo, unregister, writeRegistry,
} from '../lib/registry.mjs'
import { formatReport, report, reviewWeek } from '../lib/report.mjs'
import { syncAll, syncRepo } from '../lib/sync.mjs'
import { dropNote, vaultInit } from '../lib/vault.mjs'
import { watch } from '../lib/watch.mjs'

const USAGE = `dial — a ledger of every repo's changes in Obsidian, one vault per repo, the work/personal boundary kept sound

Usage: dial <command> [options]

Commands:
  version                      print the version (--json)
  limits                       print the published caps (--json)
  doctor                       check preconditions, the vault boundary and the permission rule (--json)
  register <path> --vault <name> --host github|gitlab
                               register a git work tree against exactly one vault
  unregister <path-or-name>    remove a registered repo
  repos                        list registered repos (--json)
  vault init <name> [--force]  scaffold a registered vault's folders and templates (--json)
  sync [<repo>] [--all] [--remote] [--due-remote] [--dry-run]
                               collect, derive and write the notes of one repo or every repo (--json)
  next [--vault <name>]        every item that needs you, across repos, offline (--json)
  brief [<repo>] [--hook] [--session <id>]
                               the short orientation for one repo, offline (--json)
  handoff <repo> [<change>] (--stdin | --text <t>) [--source <label>] [--next <text>]...
                               prepend a dated narrative entry to a note (--json)
  narrate <repo> [<change>] --transcript <path> [--turns <n>] [--dry-run], or narrate --eval <dir>
                               ask a local model for the five narrative lines (--json)
  record --event SessionEnd|PreCompact
                               the hook side: sync, then narrate when no handoff was written (--json)
  drop <repo> <change>         mark a change note dropped (--json)
  agent install|uninstall|status
                               the background sync LaunchAgent (status: --json)
  watch                        sync a repo whenever its ship or OpenSpec state moves
  report                       what the ledger shows over time (--json)
  review --week                write the weekly review of stale items into each vault (--json)
  help                         print this text (also --help after any command)

Environment: DIAL_HOME (state directory, default ~/.config/dial), DIAL_NOW (ISO-8601 clock override with Z or an offset), DIAL_LAUNCHCTL_BIN (launchctl path), ESCAPEMENT_HOME (default ~/.escapement), ESCAPEMENT_CHECKPOINT_URL (appended to checkpoint evidence)
`

/**
 * Per-command option table: `flag` takes no value, `value` requires one, `list`
 * requires one and may repeat. A command with `subcommands` takes one as its
 * first positional; its options are checked against the subcommand's table.
 */
const COMMANDS = {
  version: { options: { json: 'flag' }, args: 0 },
  limits: { options: { json: 'flag' }, args: 0 },
  doctor: { options: { json: 'flag' }, args: 0 },
  register: { options: { vault: 'value', host: 'value' }, args: 1 },
  unregister: { options: {}, args: 1 },
  repos: { options: { json: 'flag' }, args: 0 },
  vault: { subcommands: { init: { options: { force: 'flag', json: 'flag' }, args: 1 } } },
  sync: { options: { all: 'flag', remote: 'flag', 'due-remote': 'flag', 'dry-run': 'flag', json: 'flag' }, args: 1 },
  next: { options: { vault: 'value', json: 'flag' }, args: 0 },
  brief: { options: { hook: 'flag', session: 'value', json: 'flag' }, args: 1 },
  handoff: { options: { stdin: 'flag', text: 'value', source: 'value', next: 'list', json: 'flag' }, args: 2 },
  narrate: { options: { transcript: 'value', turns: 'value', 'dry-run': 'flag', eval: 'value', json: 'flag' }, args: 2 },
  record: { options: { event: 'value', json: 'flag' }, args: 0 },
  drop: { options: { json: 'flag' }, args: 2 },
  agent: {
    subcommands: {
      install: { options: {}, args: 0 },
      uninstall: { options: {}, args: 0 },
      status: { options: { json: 'flag' }, args: 0 },
    },
  },
  watch: { options: {}, args: 0 },
  report: { options: { json: 'flag' }, args: 0 },
  review: { options: { week: 'flag', json: 'flag' }, args: 0 },
  help: { options: {}, args: 0 },
}


const REGISTER_NEEDS = 'register needs --vault <name> and --host github|gitlab'

/** A refusal raised while parsing or dispatching; its message is the bare reason. */
class Refusal extends Error {}

/**
 * Split off the subcommand of a command that takes one, refusing a missing or
 * unknown one. Returns `{ sub, spec, rest }`; `sub` is null for a plain command.
 */
function selectSpec(command, args) {
  const entry = COMMANDS[command]
  if (!entry.subcommands) return { sub: null, spec: entry, rest: args }
  const names = Object.keys(entry.subcommands)
  const [first, ...rest] = args
  if (first === undefined || first.startsWith('-')) throw new Refusal(`${command} needs one of ${names.join(', ')}`)
  if (!Object.hasOwn(entry.subcommands, first)) throw new Refusal(`unknown ${command} subcommand: ${first}`)
  return { sub: first, spec: entry.subcommands[first], rest }
}

/** Parse the arguments after the command (and subcommand) against its option table. */
function parseArgs(spec, args) {
  const table = spec.options
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
    if (kind === 'list') (options[name] ??= []).push(value)
    else options[name] = value
  }
  return { options, positionals }
}

const json = value => JSON.stringify(value, null, 2) + '\n'

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * The current time: `DIAL_NOW` when set and not blank (an ISO-8601 date-time
 * with `Z` or a `±HH:mm` offset, anything else refused), else the system clock.
 * Only commands that read the clock call this, so `version` ignores a bad value.
 */
function clockOf(env) {
  const raw = typeof env.DIAL_NOW === 'string' ? env.DIAL_NOW : ''
  const value = raw.trim()
  if (!value) return new Date()
  if (!ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) throw new Refusal(`DIAL_NOW is not an ISO-8601 timestamp: ${raw}`)
  return new Date(value)
}

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

function limitsOrRefuse(registry, home) {
  const limits = effectiveLimits(registry.limits, registryPath(home))
  if (!limits.ok) throw new Refusal(limits.reason)
  return limits.limits
}

/**
 * The registry entry a repo argument names: a name, or a path (relative to the
 * shell's `cwd`, `~` allowed) equal to or inside a registered repo. Null for none.
 */
function entryFor(registry, arg, cwd) {
  return resolveRepo(registry, arg) ?? resolveRepo(registry, resolve(cwd, expandHome(arg)))
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

/** All of stdin as text; a TTY or an unreadable stdin is empty. */
function readProcessStdin() {
  if (process.stdin.isTTY) return ''
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function readVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
}

/** The printed lines of one synced repo: its plan under a dry run, else its one summary line. */
function syncLines(result) {
  if (!result.ok) return [`${result.repo}: skipped, ${result.reason}`]
  return result.dryRun ? result.plan.map(p => p.line) : [result.line]
}

/** The JSON row of one synced repo. */
function syncRow(result) {
  if (!result.ok) return { repo: result.repo, skipped: result.reason }
  return { repo: result.repo, vault: result.vault, items: result.items, needsMe: result.needsMe, writes: result.writes }
}

/** A summary that failed to build is the run's failure; a dry run prints its planned line. */
function summaryLines(summary) {
  if (!summary.ok) throw new Refusal(summary.reason)
  return summary.line ? [summary.line] : []
}

function runSync({ options, positionals }, { env, cwd, out, err, home }) {
  const [arg] = positionals
  if (arg === undefined && !options.all) throw new Refusal('sync needs <repo> or --all')
  if (arg !== undefined && options.all) throw new Refusal('sync takes <repo> or --all, not both')
  const now = clockOf(env)
  const registry = loadForWrite(home)
  const limits = limitsOrRefuse(registry, home)
  const shared = {
    registry, limits, env, home, now,
    remote: !!options.remote, dueRemote: !!options['due-remote'], dryRun: !!options['dry-run'],
    warn: line => err(`${line}\n`),
  }

  if (!options.all) {
    const entry = entryFor(registry, arg, cwd)
    const result = syncRepo({ ...shared, repo: entry ? entry.name : arg })
    if (!result.ok) throw new Refusal(result.reason)
    const lines = syncLines(result)
    const summary = summaryLines(result.summary)
    if (result.dryRun) lines.push(...summary)
    out(options.json ? json([syncRow(result)]) : `${lines.join('\n')}\n`)
    return 0
  }

  const all = syncAll(shared)
  if (!all.ok) throw new Refusal(all.reason)
  const lines = all.results.flatMap(syncLines)
  for (const summary of all.summaries) lines.push(...summaryLines(summary))
  if (options.json) out(json(all.results.map(syncRow)))
  else if (lines.length) out(`${lines.join('\n')}\n`)
  if (all.failed) throw new Refusal(`${all.failed} of ${all.total} repos not synced`)
  return 0
}

/** Run one command; returns the exit code. Throws `Refusal` for a known failure. */
/** The text of a narrate result: the wikilink, the `unobserved:` line, or the dry run's prompt, endpoints and turns. */
function narrateText(result) {
  if (result.dryRun) {
    const lines = [result.prompt, '', ...result.endpoints.map(e => `${e.role}: ${e.url} model ${e.model}`), '']
    if (result.unobserved) lines.push(`unobserved: ${result.unobserved}`)
    for (const t of result.turns) lines.push(`${t.role}: ${t.text}`)
    return `${lines.join('\n')}\n`
  }
  return result.written ? `${result.wikilink}\n` : `unobserved: ${result.unobserved}\n`
}

function narrateJson(result) {
  if (result.dryRun) return { dryRun: true, prompt: result.prompt, endpoints: result.endpoints, turns: result.turns, ...(result.unobserved ? { unobserved: result.unobserved } : {}) }
  if (!result.written) return { written: false, unobserved: result.unobserved }
  return { written: true, note: result.note, wikilink: result.wikilink, heading: result.heading, model: result.model }
}

async function runNarrate({ options, positionals }, { env, cwd, out, err, home, fetch }) {
  let turns
  if (options.turns !== undefined) {
    if (!/^\d+$/.test(options.turns) || Number(options.turns) < 1) throw new Refusal('--turns must be a positive integer')
    turns = Number(options.turns)
  }
  const registry = loadOrRefuse(home)
  const limits = limitsOrRefuse(registry, home)
  if (options.eval !== undefined) {
    const result = await evalSet({ dir: resolve(cwd, expandHome(options.eval)), registry, limits, env, fetch, turns })
    if (!result.ok) throw new Refusal(`${options.eval.replace(/\/+$/, '')}/items is not a directory`)
    out(options.json ? json({ items: result.items, score: result.score }) : `${result.lines.join('\n')}\n`)
    return 0
  }
  const [arg, change = null] = positionals
  if (arg === undefined || options.transcript === undefined) throw new Refusal('narrate needs <repo> and --transcript <path>')
  const now = clockOf(env)
  const entry = entryFor(registry, arg, cwd)
  if (!entry) throw new Refusal(`no registered repo matches ${arg}`)
  const result = await narrate({
    registry, repo: entry.name, change, transcript: resolve(cwd, expandHome(options.transcript)), turns, limits, env, fetch, now,
    dryRun: !!options['dry-run'], warn: line => err(`${line}\n`),
  })
  if (!result.ok) throw new Refusal(result.reason)
  out(options.json ? json(narrateJson(result)) : narrateText(result))
  return 0
}

/**
 * `record`: the hook side. Every path exits 0; a failure is one stderr line. Text mode prints nothing on
 * stdout, so a hook that relays stdout relays nothing.
 */
async function runRecord({ options }, { env, cwd, out, err, home, fetch, readStdin }) {
  if (!RECORD_EVENTS.includes(options.event)) throw new Refusal(BAD_EVENT)
  const payload = parsePayload(readStdin())
  const now = clockOf(env)
  const registry = loadForWrite(home)
  const limits = limitsOrRefuse(registry, home)
  const result = await record({ event: options.event, payload, registry, cwd, env, home, limits, now, fetch, warn: line => err(`${line}\n`) })
  if (result.error) throw new Refusal(result.error)
  if (options.json) {
    const { ok: _ok, silent, ...rest } = result
    out(json(silent ? { repo: null, synced: false, narrated: false } : rest))
  }
  return 0
}

/** `agent install|uninstall|status`: the LaunchAgent. A refusal is the lib's reason; `status` exits with its own code. */
function runAgent(sub, { options }, { env, out, home }) {
  if (sub === 'status') {
    const result = status({ env })
    if (!result.ok) throw new Refusal(result.reason)
    if (options.json) {
      const { ok: _ok, text: _text, ...rest } = result
      out(json(rest))
    } else out(`${result.text}\n`)
    return result.exitCode
  }
  if (sub === 'install') {
    const registry = loadForWrite(home)
    const limits = limitsOrRefuse(registry, home)
    const result = install({ env, intervalMinutes: limits.syncIntervalMinutes })
    if (!result.ok) throw new Refusal(result.reason)
    out(`${formatResult('install', result)}\n`)
    return 0
  }
  const result = uninstall({ env })
  if (!result.ok) throw new Refusal(result.reason)
  out(`${formatResult('uninstall', result)}\n`)
  return 0
}

/** `watch`: poll until SIGINT (or the injected `signal`), then exit 0. */
async function runWatch({ env, out, err, home, signal }) {
  const registry = loadForWrite(home)
  const limits = limitsOrRefuse(registry, home)
  ensureHome(env)
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal) signal.aborted ? abort() : signal.addEventListener('abort', abort, { once: true })
  else process.once('SIGINT', abort)
  try {
    // Each tick re-reads the registry, so an unregister or a vault move while watch runs takes effect at once.
    const reload = () => {
      try {
        const loaded = loadRegistry(home)
        if (!loaded.ok) return loaded
        const lim = effectiveLimits(loaded.registry.limits, registryPath(home))
        return lim.ok ? { ok: true, registry: loaded.registry, limits: lim.limits } : lim
      } catch (err) {
        return { ok: false, reason: err?.message ?? String(err) }
      }
    }
    await watch({
      registry, reload, pollMs: limits.watchPollSeconds * 1000, signal: controller.signal,
      stdout: line => out(`${line}\n`), stderr: line => err(`${line}\n`),
      syncOpts: { limits, env, home, dueRemote: true, warn: line => err(`${line}\n`) },
    })
  } finally {
    process.removeListener('SIGINT', abort)
  }
  return 0
}

async function dispatch(command, sub, spec, { options, positionals }, { env, cwd, out, err, readStdin, fetch, signal }) {
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
      const limits = limitsOrRefuse(loadOrRefuse(home), home)
      out(options.json ? json({ ...limits }) : formatLimits(limits))
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

    case 'vault': {
      // The only subcommand is `init`; selectSpec has refused anything else.
      const [name] = positionals
      if (name === undefined) throw new Refusal('vault init needs <name>')
      const result = vaultInit(name, { registry: loadOrRefuse(home), force: !!options.force, warn: line => err(`${line}\n`) })
      if (!result.ok) throw new Refusal(result.reason)
      out(options.json ? json({ vault: name, entries: result.entries, lines: result.lines }) : `${result.lines.join('\n')}\n`)
      return 0
    }

    case 'sync':
      return runSync({ options, positionals }, { env, cwd, out, err, home })

    case 'next': {
      const now = clockOf(env)
      const registry = loadOrRefuse(home)
      const limits = limitsOrRefuse(registry, home)
      const result = nextItems({ registry, vault: options.vault ?? null, limits, env, now, home })
      if (!result.ok) throw new Refusal(result.reason)
      out(options.json ? json(result.rows) : `${formatNext(result.rows, { nextRows: limits.nextRows })}\n`)
      return 0
    }

    case 'brief': {
      if (options.hook && options.json) throw new Refusal('--hook and --json cannot be combined')
      const now = clockOf(env)
      const [arg = cwd] = positionals
      const registry = loadOrRefuse(home)
      const limits = limitsOrRefuse(registry, home)
      const entry = entryFor(registry, arg, cwd)
      if (!entry) {
        if (options.hook) return 0
        throw new Refusal(`${arg} is not a registered repo`)
      }
      const result = brief({ registry, arg: entry.name, limits, env, now, home, session: options.session ?? null })
      if (!result.ok) {
        if (options.hook) return 0
        throw new Refusal(result.reason)
      }
      if (options.hook) out(`${hookEnvelope(result.lines)}\n`)
      else if (options.json) out(json({ repo: result.repo, lines: result.lines, dropped: result.dropped }))
      else out(`${formatBrief(result)}\n`)
      return 0
    }

    case 'handoff': {
      const [arg, change = null] = positionals
      if (!!options.stdin === (options.text !== undefined)) throw new Refusal('handoff needs exactly one of --stdin or --text')
      if (arg === undefined) throw new Refusal('handoff needs <repo>')
      const text = options.stdin ? readStdin() : options.text
      if (String(text ?? '').trim() === '') throw new Refusal('handoff text is empty')
      const now = clockOf(env)
      const registry = loadOrRefuse(home)
      const entry = entryFor(registry, arg, cwd)
      if (!entry) throw new Refusal(`no registered repo matches ${arg}`)
      const result = handoff({
        registry, repo: entry.name, change, text, source: options.source ?? DEFAULT_SOURCE, next: options.next ?? [], now,
        warn: line => err(`${line}\n`),
      })
      if (!result.ok) throw new Refusal(result.reason)
      out(options.json
        ? json({ note: result.note, wikilink: result.wikilink, heading: result.heading, nextAdded: result.nextAdded })
        : `${result.wikilink}\n`)
      return 0
    }

    case 'agent':
      return runAgent(sub, { options }, { env, out, home })

    case 'watch':
      return runWatch({ env, out, err, home, signal })

    case 'report': {
      const now = clockOf(env)
      const result = report({ registry: loadOrRefuse(home), home, env, now })
      if (!result.ok) throw new Refusal(result.reason)
      out(options.json ? json(result.report) : `${formatReport(result.report)}\n`)
      return 0
    }

    case 'review': {
      if (!options.week) throw new Refusal('review needs --week')
      const now = clockOf(env)
      const result = reviewWeek({ registry: loadOrRefuse(home), now, warn: line => err(`${line}\n`) })
      if (options.json) out(json(result.results.map(({ vault, path, verb, reason }) => ({ vault, path: path ?? null, verb, ...(reason ? { reason } : {}) }))))
      else {
        const lines = result.results.filter(r => r.verb !== 'failed').map(r => r.line)
        if (lines.length) out(`${lines.join('\n')}\n`)
      }
      // Every failed vault folds into the one reason line; the per-vault reasons stay in --json.
      const failed = result.results.filter(r => r.verb === 'failed')
      if (failed.length) throw new Refusal(`${failed.length} of ${result.results.length} vaults not reviewed: ${failed[0].reason}`)
      return 0
    }

    case 'narrate':
      return runNarrate({ options, positionals }, { env, cwd, out, err, home, fetch })

    case 'record':
      return runRecord({ options, positionals }, { env, cwd, out, err, home, fetch, readStdin })

    case 'drop': {
      const [arg, change] = positionals
      if (arg === undefined || change === undefined) throw new Refusal('drop needs <repo> <change>')
      const now = clockOf(env)
      const registry = loadOrRefuse(home)
      const entry = entryFor(registry, arg, cwd)
      if (!entry) throw new Refusal(`no registered repo matches ${arg}`)
      const vaultPath = resolve(expandHome(registry.vaults[entry.vault]))
      const result = dropNote(vaultPath, entry.name, change, { registry, now, warn: line => err(`${line}\n`) })
      if (!result.ok) throw new Refusal(result.reason)
      out(options.json ? json({ note: `Changes/${result.link.slice(2, -2)}.md`, wikilink: result.link, dropped: result.dropped }) : `dropped ${result.link}\n`)
      return 0
    }
  }
  throw new Refusal(`unknown command: ${sub ? `${command} ${sub}` : command}`)
}

/**
 * Entry point. Resolves to the exit code; never rejects and never calls
 * `process.exit`. `env`, `cwd`, `stdout`, `stderr`, `stdin` (a function
 * returning all of stdin as text) and `fetch` and `signal` (aborts `watch`) are injectable for tests.
 */
export async function main(argv, {
  env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, stdin = readProcessStdin,
  fetch = globalThis.fetch, signal,
} = {}) {
  const out = text => stdout.write(text)
  const err = text => stderr.write(text)
  const fail = (reason, code = 1) => {
    err(`dial: ${String(reason).replace(/\s*\n\s*/g, ' ').trim()}\n`)
    return code
  }

  // `record` runs from a hook: once its command line is parsed it exits 0 on every path, its failure being the one stderr line.
  let failCode = 1
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
    const { sub, spec, rest: args } = selectSpec(command, rest)
    const parsed = parseArgs(spec, args)
    // A command line the parser refuses exits 1 for record too; only a failure of the run itself exits 0.
    if (command === 'record') failCode = 0
    return await dispatch(command, sub, spec, parsed, { env, cwd, out, err, readStdin: stdin, fetch, signal })
  } catch (error) {
    return fail(error && error.message ? error.message : String(error), failCode)
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

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code
  })
}
