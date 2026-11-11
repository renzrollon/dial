/**
 * The macOS LaunchAgent (specs/launch-agent): `plist` builds the property list, `install`, `uninstall`
 * and `status` run an injectable launchctl (`exec`, or the binary `DIAL_LAUNCHCTL_BIN` names, else
 * `/bin/launchctl`). Lib functions return data or `{ ok: false, reason }` with a bare reason (the CLI
 * prefixes `dial: `). Off darwin every function refuses before touching a file.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HomeUnwritable, ensureHome } from './home.mjs'
import { LIMITS } from './limits.mjs'
import { exec as realExec } from './subprocess.mjs'

export const LABEL = 'com.dial.sync'
export const SUBCOMMANDS = Object.freeze(['install', 'uninstall', 'status'])
const DIAL_BIN = fileURLToPath(new URL('../bin/dial.mjs', import.meta.url))
const NOT_LOADED = new Set([3, 113])

const escapeXml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
const unescapeXml = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const shellQuote = text => `'${String(text).replace(/'/g, `'\\''`)}'`
const firstLine = text => String(text ?? '').split('\n').find(l => l.trim() !== '')?.trim() ?? ''

/** `$HOME/Library/LaunchAgents/com.dial.sync.plist`. */
export function plistPath(userHome) {
  return join(userHome, 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

/**
 * The property list text. `opts = { node, dial, home, path, intervalMinutes }`; only `DIAL_HOME` and `PATH`
 * enter `EnvironmentVariables`, every value is XML-escaped.
 */
export function plist({ node = process.execPath, dial = DIAL_BIN, home, path = '', intervalMinutes = LIMITS.syncIntervalMinutes }) {
  const s = v => `<string>${escapeXml(v)}</string>`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>\n  ${s(LABEL)}`,
    `  <key>ProgramArguments</key>\n  <array>\n    ${s('/bin/sh')}\n    ${s('-c')}\n    ${s(`exec ${shellQuote(node)} ${shellQuote(dial)} sync --all --due-remote`)}\n  </array>`,
    `  <key>StartInterval</key>\n  <integer>${intervalMinutes * 60}</integer>`,
    '  <key>RunAtLoad</key>\n  <true/>',
    `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>DIAL_HOME</key>\n    ${s(home)}\n    <key>PATH</key>\n    ${s(path)}\n  </dict>`,
    `  <key>StandardOutPath</key>\n  ${s(join(home, 'logs', 'agent.out.log'))}`,
    `  <key>StandardErrorPath</key>\n  ${s(join(home, 'logs', 'agent.err.log'))}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

/** Read back a plist this module wrote: `{ label, startInterval, runAtLoad, program, env, stdout, stderr, node, dial }`. */
export function parsePlist(text) {
  const tokens = [...text.matchAll(/<(\/?)(dict|array)>|<key>([\s\S]*?)<\/key>|<string>([\s\S]*?)<\/string>|<integer>(\d+)<\/integer>|<(true|false)\/>/g)]
  let at = 0
  const value = () => {
    const t = tokens[at++]
    if (!t) return undefined
    if (t[4] !== undefined) return unescapeXml(t[4])
    if (t[5] !== undefined) return Number(t[5])
    if (t[6] !== undefined) return t[6] === 'true'
    if (t[2] === 'array') {
      const out = []
      while (tokens[at] && !(tokens[at][1] === '/' && tokens[at][2] === 'array')) out.push(value())
      at++
      return out
    }
    const out = {}
    while (tokens[at] && !(tokens[at][1] === '/' && tokens[at][2] === 'dict')) {
      const key = unescapeXml(tokens[at++][3] ?? '')
      out[key] = value()
    }
    at++
    return out
  }
  while (tokens[at] && tokens[at][2] !== 'dict') at++
  const root = value() ?? {}
  const program = Array.isArray(root.ProgramArguments) ? root.ProgramArguments : []
  const quoted = /^exec '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)' /.exec(program[2] ?? '')
  const plain = s => s?.replace(/'\\''/g, "'")
  return {
    label: root.Label,
    startInterval: root.StartInterval,
    runAtLoad: root.RunAtLoad,
    program,
    env: root.EnvironmentVariables ?? {},
    stdout: root.StandardOutPath,
    stderr: root.StandardErrorPath,
    node: plain(quoted?.[1]),
    dial: plain(quoted?.[2]),
  }
}

/** The launchctl runner and the context shared by the three subcommands, or a refusal. */
function context(sub, opts) {
  const platform = opts.platform ?? process.platform
  if (platform !== 'darwin') return { ok: false, reason: `agent ${sub} is macOS only` }
  const env = opts.env ?? process.env
  const userHome = opts.userHome ?? env.HOME
  if (!userHome) return { ok: false, reason: 'HOME is not set' }
  const uid = opts.uid ?? process.getuid?.() ?? 0
  const bin = typeof env.DIAL_LAUNCHCTL_BIN === 'string' && env.DIAL_LAUNCHCTL_BIN.trim() ? env.DIAL_LAUNCHCTL_BIN.trim() : '/bin/launchctl'
  const run = args => (opts.exec ?? realExec)(bin, args)
  return { ok: true, env, userHome, uid, domain: `gui/${uid}`, target: `gui/${uid}/${LABEL}`, plist: plistPath(userHome), run }
}

/**
 * Create the home and `logs/`, write the plist, boot out any loaded agent (result ignored), bootstrap.
 * `opts = { env, userHome?, uid?, platform?, exec?, node?, dial?, intervalMinutes? }`.
 * Returns `{ ok: true, label, plistPath, home }` or `{ ok: false, reason }`; a failed bootstrap removes the plist.
 */
export function install(opts = {}) {
  const ctx = context('install', opts)
  if (!ctx.ok) return ctx
  let home
  try {
    home = ensureHome(ctx.env).root
  } catch (err) {
    if (err instanceof HomeUnwritable) return { ok: false, reason: err.message }
    throw err
  }
  const text = plist({
    node: opts.node ?? process.execPath,
    dial: opts.dial ?? DIAL_BIN,
    home,
    path: ctx.env.PATH ?? '',
    intervalMinutes: opts.intervalMinutes ?? LIMITS.syncIntervalMinutes,
  })
  try {
    mkdirSync(dirname(ctx.plist), { recursive: true })
    writeFileSync(ctx.plist, text)
  } catch (err) {
    return { ok: false, reason: `cannot write ${ctx.plist}: ${err.code ?? err.message}` }
  }
  ctx.run(['bootout', ctx.target])
  const boot = ctx.run(['bootstrap', ctx.domain, ctx.plist])
  if (!boot.ok) {
    try {
      unlinkSync(ctx.plist)
    } catch {
      // never written, or already gone
    }
    const why = boot.missing ? 'launchctl not found' : firstLine(boot.stderr) || (boot.timedOut ? 'timed out' : `exit ${boot.code}`)
    return { ok: false, reason: `launchctl bootstrap failed: ${why}` }
  }
  return { ok: true, label: LABEL, plistPath: ctx.plist, home }
}

/**
 * Boot the agent out (exit 3 or 113 is not loaded) and remove the plist, leaving the logs.
 * Returns `{ ok: true, removed, plistPath }` (`removed` is true when the plist existed or the agent was loaded) or `{ ok: false, reason }`.
 */
export function uninstall(opts = {}) {
  const ctx = context('uninstall', opts)
  if (!ctx.ok) return ctx
  const out = ctx.run(['bootout', ctx.target])
  const loaded = out.ok
  if (!out.ok && !NOT_LOADED.has(out.code)) {
    const why = out.missing ? 'launchctl not found' : firstLine(out.stderr) || (out.timedOut ? 'timed out' : `exit ${out.code}`)
    return { ok: false, reason: `launchctl bootout failed: ${why}` }
  }
  const had = existsSync(ctx.plist)
  if (had) {
    try {
      unlinkSync(ctx.plist)
    } catch (err) {
      return { ok: false, reason: `cannot remove ${ctx.plist}: ${err.code ?? err.message}` }
    }
  }
  return { ok: true, removed: had || loaded, plistPath: ctx.plist }
}

/** The text form of an install or uninstall result. */
export function formatResult(kind, r) {
  if (kind === 'install') return `installed ${r.label}\n  plist: ${r.plistPath}`
  return r.removed ? `uninstalled ${r.plistPath}` : 'not installed'
}

/**
 * What launchd says. Returns `{ ok: true, outcome, label, plistPath, pid?, missing?, fix?, exitCode, text }` with
 * `outcome` one of `not-installed`, `paths-missing`, `running`, `loaded-not-running`, `not-loaded`; `exitCode` is 0 only for `running`.
 */
export function status(opts = {}) {
  const ctx = context('status', opts)
  if (!ctx.ok) return ctx
  const base = { ok: true, label: LABEL, plistPath: ctx.plist }
  const reinstall = 'dial agent install'
  const done = (outcome, extra = {}) => {
    const r = { ...base, outcome, ...extra, exitCode: outcome === 'running' ? 0 : 1 }
    const head = outcome === 'running' ? `agent: running (pid ${r.pid ?? 'unknown'})` : `agent: ${outcome}`
    const rows = [head, `  plist: ${ctx.plist}`]
    if (r.missing) rows.push(`  missing: ${r.missing.join(', ')}`)
    if (r.fix) rows.push(`  fix: ${r.fix}`)
    r.text = rows.join('\n')
    return r
  }
  let text
  try {
    text = readFileSync(ctx.plist, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return done('not-installed', { fix: reinstall })
    return { ok: false, reason: `cannot read ${ctx.plist}: ${err.code ?? err.message}` }
  }
  const parsed = parsePlist(text)
  const gone = [parsed.node, parsed.dial].filter(p => typeof p === 'string' && p !== '' && !existsSync(p))
  if (gone.length) return done('paths-missing', { missing: gone, fix: reinstall })
  const print = ctx.run(['print', ctx.target])
  if (!print.ok) return done('not-loaded', { fix: reinstall })
  const state = /^\s*state = (.+)$/m.exec(print.stdout)?.[1]?.trim()
  const pid = /^\s*pid = (\d+)$/m.exec(print.stdout)?.[1]
  if (state === 'running') return done('running', { pid: pid === undefined ? null : Number(pid) })
  return done('loaded-not-running', { fix: `launchctl kickstart -k ${ctx.target}` })
}
