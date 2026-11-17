#!/usr/bin/env node
/**
 * The one-time machine setup for Dial, asking one question at a time:
 * the CLI on PATH, the vaults in the registry, each vault's scaffold and
 * AGENTS.md section, the Claude Code plugin and settings, the optional
 * LaunchAgent, then any repos to register, and `dial doctor` at the end.
 *
 *   node ~/IdeaProjects/dial/scripts/setup.mjs
 *
 * Safe to re-run: every step checks what is already there and asks before it
 * changes anything. ~/.claude/settings.json is backed up before it is written.
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { ensureHome, resolveHome } from '../lib/home.mjs'
import { collapseHome, expandHome, loadRegistry, registryPath, validateRegistry, writeRegistry } from '../lib/registry.mjs'
import { addRepo } from './add-repo.mjs'
import { CHECKOUT, ask, askValid, capture, choose, confirm, dial, heading, run, runMain } from './prompt.mjs'

const AGENTS_SECTION = join(CHECKOUT, 'templates', 'AGENTS-dial-section.md')
const AGENTS_MARKER = '## Dial notes'
const PERMISSION = 'Bash(dial:*)'

const inside = (base, abs) => abs !== base && abs.startsWith(base.endsWith(sep) ? base : base + sep)

function checkPrereqs() {
  heading('Prerequisites')
  const major = Number(process.versions.node.split('.')[0])
  if (major < 22) {
    console.log(`Node ${process.versions.node} is too old; Dial needs Node >= 22.`)
    return false
  }
  console.log(`  node ${process.versions.node}  ok`)
  const git = capture('git', ['--version'])
  if (!git) {
    console.log('git is not on PATH; install it first.')
    return false
  }
  console.log(`  ${git}  ok`)
  return true
}

async function installCli() {
  heading('1. The dial CLI')
  const onPath = capture('sh', ['-c', 'command -v dial'])
  if (onPath) {
    console.log(`  dial is on PATH: ${onPath}`)
    if (!(await confirm('Re-link this checkout with npm i -g . (needed after a Node switch)?', false))) return
  } else if (!(await confirm(`dial is not on PATH. Run npm i -g . in ${collapseHome(CHECKOUT)}?`, true))) {
    console.log('  Skipped. The skills and hooks call dial by name, so run it later.')
    return
  }
  run('npm', ['i', '-g', '.'], { cwd: CHECKOUT })
}

/** Ask for vaults to add; returns the names added. Mutates `reg`. */
async function addVaults(reg) {
  heading('2. Obsidian vaults')
  console.log('  One vault per boundary, for example "personal" and "work".')
  console.log('  Create each vault in Obsidian first (Create new vault, or Open folder as vault),')
  console.log('  and turn on Settings > Core plugins > Bases.')
  const existing = Object.entries(reg.vaults)
  if (existing.length) {
    console.log('  Already registered:')
    for (const [name, path] of existing) console.log(`    ${name}: ${path}`)
  }

  const added = []
  for (;;) {
    const first = existing.length === 0 && added.length === 0
    const name = await askValid(first ? 'Vault name (e.g. personal)' : 'Another vault name (blank to finish)', '', a => {
      if (!a) return first ? 'at least one vault is needed' : null
      if (!/^[A-Za-z0-9._-]+$/.test(a)) return 'use letters, digits, dot, dash or underscore'
      if (Object.hasOwn(reg.vaults, a)) return `${a} is already registered`
      return null
    })
    if (!name) break

    const path = await askValid(`Folder of vault ${name} (the one holding .obsidian/)`, `~/Obsidian/${name}`, a =>
      a.startsWith('/') || a.startsWith('~/') ? null : 'give an absolute path or one starting with ~/'
    )
    const abs = resolve(expandHome(path))
    if (!existsSync(abs)) {
      if (!(await confirm(`${abs} does not exist. Create the folder (then open it in Obsidian as a vault)?`, true))) continue
      mkdirSync(abs, { recursive: true })
    } else if (!statSync(abs).isDirectory()) {
      console.log(`  ${abs} is not a directory; skipped.`)
      continue
    } else if (!existsSync(join(abs, '.obsidian'))) {
      console.log('  note: no .obsidian/ here yet. Open this folder as a vault in Obsidian.')
    }

    const repoRoot = capture('git', ['-C', abs, 'rev-parse', '--show-toplevel'])
    if (repoRoot) console.log(`  warning: this folder is inside the git repo ${repoRoot}. Keep a vault out of repos Dial tracks.`)
    for (const [other, otherPath] of Object.entries(reg.vaults)) {
      const otherAbs = resolve(expandHome(otherPath))
      if (inside(otherAbs, abs) || inside(abs, otherAbs)) console.log(`  warning: this vault and ${other} are nested. Keep vaults apart.`)
    }

    reg.vaults[name] = collapseHome(abs)
    added.push(name)
  }
  return added
}

/** Optionally pin whole directories to one vault. Mutates `reg`. */
async function addRoots(reg) {
  const vaults = Object.keys(reg.vaults)
  if (vaults.length < 2) return
  console.log('\n  Optional: pin a whole directory to one vault, e.g. ~/VSCodeProjects -> work.')
  console.log('  Then a repo under it can only be registered to that vault.')
  for (;;) {
    const dir = await ask('Directory to pin (blank to skip)', '')
    if (!dir) return
    const abs = resolve(expandHome(dir))
    if (!existsSync(abs)) {
      console.log(`  ${abs} does not exist; skipped.`)
      continue
    }
    const vault = await choose(`Vault for ${collapseHome(abs)}`, vaults)
    reg.roots = { ...(reg.roots ?? {}), [collapseHome(abs)]: vault }
  }
}

async function scaffoldVaults(reg, added) {
  heading('3. Scaffold each vault')
  for (const name of Object.keys(reg.vaults)) {
    const abs = resolve(expandHome(reg.vaults[name]))
    const isNew = added.includes(name)
    if (isNew || (await confirm(`Run dial vault init ${name} (idempotent)?`, false))) dial('vault', 'init', name)

    const agents = join(abs, 'AGENTS.md')
    const has = existsSync(agents) && readFileSync(agents, 'utf8').includes(AGENTS_MARKER)
    if (has) {
      console.log(`  ${collapseHome(agents)} already has the Dial section.`)
    } else if (await confirm(`Append the Dial section to ${collapseHome(agents)}?`, true)) {
      const prior = existsSync(agents) ? readFileSync(agents, 'utf8') : ''
      const sep = prior && !prior.endsWith('\n\n') ? (prior.endsWith('\n') ? '\n' : '\n\n') : ''
      appendFileSync(agents, sep + readFileSync(AGENTS_SECTION, 'utf8'))
      console.log(`  appended to ${collapseHome(agents)}`)
    }
  }
}

async function installPlugin() {
  heading('4. Claude Code plugin')
  if (!capture('sh', ['-c', 'command -v claude'])) {
    console.log('  claude is not on PATH. Inside Claude Code, run:')
    console.log('    /plugin marketplace add renzrollon/dial')
    console.log('    /plugin install dial@dial')
    return
  }
  const listed = capture('claude', ['plugin', 'list']) ?? ''
  if (/\bdial@dial\b/.test(listed)) {
    console.log('  dial@dial is already installed. To update: claude plugin marketplace update dial')
    return
  }
  if (!(await confirm('Install the dial plugin into Claude Code?', true))) return
  run('claude', ['plugin', 'marketplace', 'add', 'renzrollon/dial'])
  if (run('claude', ['plugin', 'install', 'dial@dial']) === 0) console.log('  Restart Claude Code to load it.')
}

/** Add the permission rule and the sandbox write paths to ~/.claude/settings.json. */
async function updateSettings(reg, home) {
  heading('5. Claude Code settings')
  const file = join(homedir(), '.claude', 'settings.json')
  let settings = {}
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      console.log(`  ${file} is not valid JSON (${err.message}). Fix it, then re-run this script.`)
      return
    }
  }

  let changed = false
  const allow = settings.permissions?.allow ?? []
  if (allow.includes(PERMISSION)) {
    console.log(`  ${PERMISSION} is already allowed.`)
  } else if (await confirm(`Allow ${PERMISSION} so /dial:handoff, /dial:next and /dial:ask don't prompt?`, true)) {
    settings.permissions = { ...(settings.permissions ?? {}), allow: [...allow, PERMISSION] }
    changed = true
  }

  const wanted = [collapseHome(home), ...Object.values(reg.vaults).map(p => collapseHome(resolve(expandHome(p))))]
  const current = settings.sandbox?.filesystem?.allowWrite ?? []
  const have = new Set(current.map(p => resolve(expandHome(p))))
  const missing = wanted.filter(p => !have.has(resolve(expandHome(p))))
  if (missing.length === 0) {
    console.log('  The sandbox can already write to the Dial home and every vault.')
  } else if (await confirm(`Do you run Claude Code with the sandbox? If so, let it write to: ${missing.join(', ')}`, true)) {
    settings.sandbox = {
      ...(settings.sandbox ?? {}),
      filesystem: { ...(settings.sandbox?.filesystem ?? {}), allowWrite: [...current, ...missing] }
    }
    changed = true
  }

  if (!changed) return
  mkdirSync(join(homedir(), '.claude'), { recursive: true })
  if (existsSync(file)) {
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(file, backup)
    console.log(`  backup: ${backup}`)
  }
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
  console.log(`  updated ${file}`)
}

async function main() {
  console.log('Dial setup. Press Enter to take the [default]; answer n to skip a step.')
  if (!checkPrereqs()) return 1
  await installCli()

  const home = resolveHome()
  const loaded = loadRegistry(home)
  if (!loaded.ok) {
    console.log(`\ndial: ${loaded.reason}\nFix ${registryPath(home)} by hand, then re-run this script.`)
    return 1
  }
  const reg = loaded.registry
  const added = await addVaults(reg)
  await addRoots(reg)

  const verdict = validateRegistry(JSON.parse(JSON.stringify(reg)), registryPath(home))
  if (!verdict.ok) {
    console.log(`\nNot writing the registry: ${verdict.reason}`)
    return 1
  }
  ensureHome()
  writeRegistry(home, reg)
  console.log(`\n  wrote ${collapseHome(registryPath(home))}`)

  await scaffoldVaults(reg, added)
  await installPlugin()
  await updateSettings(reg, home)

  heading('6. Optional: background sync')
  console.log('  A LaunchAgent runs dial sync --all every 15 minutes and at login.')
  if (await confirm('Install it?', false)) dial('agent', 'install')

  heading('7. Repositories')
  let asked = reg.repos.length > 0
  while ((await confirm(asked ? 'Register another repository?' : 'Register a repository?', true))) {
    await addRepo()
    asked = true
  }

  heading('Check')
  dial('doctor')
  console.log('\nTo add a repo later: node ' + collapseHome(join(CHECKOUT, 'scripts', 'add-repo.mjs')) + ' [<path>]')
  return 0
}

await runMain(main)
