#!/usr/bin/env node
/**
 * Register one repository with Dial and write its first notes, asking one
 * question at a time. Run from anywhere:
 *
 *   node ~/IdeaProjects/dial/scripts/add-repo.mjs [<path>]
 *
 * The path defaults to the git work tree you are in. Run scripts/setup.mjs
 * first: a repo needs a vault in the registry to belong to.
 */
import { existsSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHome } from '../lib/home.mjs'
import { collapseHome, expandHome, listRepos, loadRegistry, rootVault } from '../lib/registry.mjs'
import { ask, askValid, capture, choose, confirm, dial, heading, runMain } from './prompt.mjs'

function checkRepo(answer) {
  const abs = resolve(expandHome(answer))
  if (!existsSync(abs)) return `does not exist: ${abs}`
  if (!statSync(abs).isDirectory()) return `not a directory: ${abs}`
  if (!existsSync(join(abs, '.git'))) return `not a git work tree (no .git): ${abs}`
  return null
}

function guessHost(abs) {
  const url = capture('git', ['-C', abs, 'remote', 'get-url', 'origin']) ?? ''
  return /gitlab/i.test(url) ? 'gitlab' : 'github'
}

/** The interactive flow; returns true when the repo was registered. Shared with setup.mjs. */
export async function addRepo(pathArg) {
  const home = resolveHome()
  const loaded = loadRegistry(home)
  if (!loaded.ok) {
    console.log(`dial: ${loaded.reason}`)
    return false
  }
  const reg = loaded.registry
  const vaults = Object.keys(reg.vaults)
  if (vaults.length === 0) {
    console.log('No vaults in the registry yet. Run scripts/setup.mjs first.')
    return false
  }

  heading('Register a repository')
  const def = pathArg ?? capture('git', ['rev-parse', '--show-toplevel']) ?? ''
  const abs = resolve(expandHome(await askValid('Repository path', def && collapseHome(def), checkRepo)))
  const name = basename(abs)

  const existing = listRepos(reg).find(r => r.path === abs || r.name === name)
  if (existing) {
    console.log(`  ${name} is already registered to vault ${existing.vault} (host ${existing.host}).`)
    if (!(await confirm('Register it again (only the host can change)?', false))) return false
  }

  let vault
  const root = rootVault(reg, abs)
  if (root) {
    vault = root.vault
    console.log(`  ${collapseHome(abs)} is under ${root.root}, so it goes in vault ${vault}.`)
  } else if (existing) {
    vault = existing.vault
  } else if (vaults.length === 1) {
    vault = vaults[0]
    console.log(`  Vault: ${vault} (the only one registered)`)
  } else {
    vault = await choose('Which vault does it belong to?', vaults)
  }

  const host = await choose('Forge host', ['github', 'gitlab'], existing?.host ?? guessHost(abs))

  if (dial('register', abs, '--vault', vault, '--host', host) !== 0) return false

  if (await confirm('Preview the notes Dial would write (writes nothing)?', true)) dial('sync', name, '--dry-run')
  if (await confirm(`Write the notes into vault ${vault} now?`, true)) {
    const cli = host === 'gitlab' ? 'glab' : 'gh'
    const remote = capture(cli, ['auth', 'status']) !== null && (await confirm(`Also fetch PR and CI state with ${cli}?`, false))
    if (dial('sync', name, ...(remote ? ['--remote'] : [])) === 0) {
      const line = (await ask('One line about this project, for its vault page (Enter to skip)')).trim()
      if (line) dial('handoff', name, '--text', line, '--source', 'bootstrap')
    }
  }
  console.log(`\nDone. Later: dial brief ${name}, dial next, dial sync ${name}`)
  return true
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runMain(async () => ((await addRepo(process.argv[2])) ? 0 : 1))
}
