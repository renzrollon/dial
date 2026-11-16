// scripts/add-repo.mjs against specs/dial-home and the bootstrap question (design §The bootstrap step; D12).
// Each case spawns the script with piped answers, a scratch home and vault, and a `gh` that fails so the
// remote question is not asked.
process.env.TZ = 'UTC'

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeBinary, makeGitDir, makeHome, makeVault, tmp, writeJson } from './helpers.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/add-repo.mjs', import.meta.url))
const QUESTION = 'One line about this project, for its vault page'
const SENTENCE = 'A ledger of what is in flight'

/** Run the script against a fresh registry (one vault, no repos); `answers` follow path, host, preview, write. */
function runAddRepo(answers) {
  const base = tmp('add-repo-')
  const vault = makeVault(join(base, 'personal'), [{ path: '.obsidian/app.json', body: '{}' }, { path: 'AGENTS.md', body: '# Agents\n' }])
  const repo = makeGitDir(join(base, 'repos', 'katipon'))
  const home = makeHome()
  writeJson(join(home, 'registry.json'), { dial_schema: 'dial.registry/1', vaults: { personal: vault }, repos: [], limits: {} })
  const bin = join(base, 'bin')
  fakeBinary(bin, 'gh', 'exit 1')
  const env = { PATH: `${bin}:${process.env.PATH}`, TMPDIR: process.env.TMPDIR, TZ: 'UTC', HOME: tmp('add-repo-home-'), DIAL_HOME: home }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, repo], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`add-repo.mjs still running after 20s\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 20_000)
    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, note: join(vault, 'Projects', 'katipon.md') })
    })
    child.stdin.end(answers.map(a => a + '\n').join(''))
  })
}

const ANSWERS = ['', '', 'n', 'y']

test('bootstrap: an answered question leaves a bootstrap entry on the repo note', async () => {
  const r = await runAddRepo([...ANSWERS, SENTENCE])
  assert.ok(r.stdout.includes(QUESTION), `question not printed:\n${r.stdout}\n${r.stderr}`)
  const note = readFileSync(r.note, 'utf8')
  assert.ok(note.includes('· bootstrap'), note)
  assert.ok(note.includes(SENTENCE), note)
})

test('bootstrap: a blank answer asks the question and leaves no bootstrap entry', async () => {
  const r = await runAddRepo([...ANSWERS, ''])
  assert.ok(r.stdout.includes(QUESTION), `question not printed:\n${r.stdout}\n${r.stderr}`)
  const note = readFileSync(r.note, 'utf8')
  assert.ok(!note.includes('· bootstrap'), note)
})
