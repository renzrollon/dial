import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { realpathSync } from 'node:fs'
import { collectEscapement, escapementHome } from '../lib/sources/escapement.mjs'
import { FIXTURES, makeRepo, snapshotTree, tmp } from './helpers.mjs'

const fx = name => readFileSync(join(FIXTURES, 'escapement', name), 'utf8')
const NOW = new Date('2026-11-10T12:00:00Z')

/** A user home holding `.escapement` with the given `{ relativePath: text }` files, `__REPO__` substituted. */
function setup(files, repo) {
  const userHome = realpathSync(tmp('esc-user-'))
  for (const [rel, text] of Object.entries(files)) {
    const file = join(userHome, '.escapement', rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text.replaceAll('__REPO__', repo))
  }
  mkdirSync(join(userHome, '.escapement'), { recursive: true })
  return { userHome, env: { HOME: userHome } }
}
const repoPath = () => realpathSync(makeRepo(tmp('esc-repo-'), {}))

test('home resolution: ESCAPEMENT_HOME trimmed and tilde-expanded, else ~/.escapement', () => {
  assert.equal(escapementHome({ HOME: '/u' }), '/u/.escapement')
  assert.equal(escapementHome({ HOME: '/u', ESCAPEMENT_HOME: '  ' }), '/u/.escapement')
  assert.equal(escapementHome({ HOME: '/u', ESCAPEMENT_HOME: ' ~/esc ' }), '/u/esc')
  assert.equal(escapementHome({ HOME: '/u', ESCAPEMENT_HOME: '/srv/esc' }), '/srv/esc')
})

test('home absent: every fact is unobserved and nothing is created', () => {
  const userHome = tmp('esc-user-')
  const before = snapshotTree(userHome)
  const r = collectEscapement({ repoPath: repoPath(), env: { HOME: userHome }, now: NOW, changes: ['add-login'] })
  assert.equal(r.entries['add-login'].unobserved, '~/.escapement: absent')
  assert.equal(r.home.unobserved, '~/.escapement: absent')
  assert.deepEqual(snapshotTree(userHome), before)
  assert.equal(existsSync(join(userHome, '.escapement')), false)
})

test('a pending entry is matched by repo and change', () => {
  const repo = repoPath()
  const { env } = setup({ 'queue/pending/q-123.json': fx('entry-pending.json') }, repo)
  const r = collectEscapement({ repoPath: repo, env, now: NOW, changes: ['add-login'] })
  const f = r.entries['add-login']
  assert.equal(f.evidence, '~/.escapement/queue/pending/q-123.json: pending')
  assert.equal(f.value.id, 'q-123')
  assert.equal(f.value.state, 'pending')
  assert.equal(f.value.lastTs, '2026-11-09T18:00:00Z')
  assert.equal(f.value.observation, null)
  assert.equal(f.value.observationEvidence, '~/.escapement/journal: no observation for q-123')
})

test('an entry for another repo does not match; a requested change is observed absent', () => {
  const repo = repoPath()
  const { env } = setup({ 'queue/pending/q-123.json': fx('entry-pending.json') }, repoPath())
  const r = collectEscapement({ repoPath: repo, env, now: NOW, changes: ['add-login'] })
  assert.deepEqual(r.entries['add-login'], { value: 'absent', evidence: '~/.escapement/queue: no entry for add-login' })
})

test('a duplicate id takes the copy matching its last transition', () => {
  const repo = repoPath()
  const { env } = setup(
    { 'queue/running/q-123.json': fx('entry-crashed.json'), 'queue/done/q-123.json': fx('entry-crashed.json') },
    repo
  )
  const f = collectEscapement({ repoPath: repo, env, now: NOW }).entries['add-login']
  assert.equal(f.value.state, 'done')
  assert.equal(f.value.lastTs, '2026-11-09T19:00:00Z')
  assert.equal(f.evidence, '~/.escapement/queue/done/q-123.json: done')
  const flipped = setup(
    { 'queue/pending/q-123.json': fx('entry-crashed.json'), 'queue/done/q-123.json': fx('entry-crashed.json') },
    repo
  )
  assert.equal(collectEscapement({ repoPath: repo, env: flipped.env, now: NOW }).entries['add-login'].value.state, 'done')
})

test('a symlinked repo path in the entry still belongs to the repo', () => {
  const repo = repoPath()
  const link = join(tmp('esc-link-'), 'alias')
  symlinkSync(repo, link)
  const { env } = setup({ 'queue/pending/q-123.json': fx('entry-pending.json') }, link)
  const r = collectEscapement({ repoPath: repo, env, now: NOW })
  assert.equal(r.entries['add-login'].value.id, 'q-123')
  // and the other direction: the registered path is the symlink
  const r2 = collectEscapement({ repoPath: link, env, now: NOW })
  assert.equal(r2.entries['add-login'].value.id, 'q-123')
})

test('the newest observation in today journal is reported; malformed lines are skipped', () => {
  const repo = repoPath()
  const { env } = setup(
    { 'queue/halted/q-123.json': fx('entry-pending.json'), 'journal/2026-11-10.jsonl': fx('journal-2026-11-10.jsonl') },
    repo
  )
  const f = collectEscapement({ repoPath: repo, env, now: NOW }).entries['add-login']
  assert.deepEqual(f.value.observation, { class: 'halt', category: 'verify-red', reason: 'tests failed', runId: '7a587a81' })
  assert.equal(f.value.observationEvidence, '~/.escapement/journal/2026-11-10.jsonl observation q-123: halt verify-red')
})

test('only yesterday UTC holds it: still reported', () => {
  const repo = repoPath()
  const { env } = setup(
    { 'queue/halted/q-123.json': fx('entry-pending.json'), 'journal/2026-11-09.jsonl': fx('journal-2026-11-10.jsonl') },
    repo
  )
  const f = collectEscapement({ repoPath: repo, env, now: new Date('2026-11-10T01:00:00Z') }).entries['add-login']
  assert.equal(f.value.observation.class, 'halt')
  assert.match(f.value.observationEvidence, /journal\/2026-11-09\.jsonl/)
})

test('a journal older than yesterday is not read', () => {
  const repo = repoPath()
  const { env } = setup(
    { 'queue/halted/q-123.json': fx('entry-pending.json'), 'journal/2026-11-08.jsonl': fx('journal-2026-11-10.jsonl') },
    repo
  )
  assert.equal(collectEscapement({ repoPath: repo, env, now: NOW }).entries['add-login'].value.observation, null)
})

test('ESCAPEMENT_HOME redirects the read', () => {
  const repo = repoPath()
  const { userHome } = setup({}, repo)
  const other = join(userHome, 'elsewhere')
  mkdirSync(join(other, 'queue', 'pending'), { recursive: true })
  writeFileSync(join(other, 'queue', 'pending', 'q-123.json'), fx('entry-pending.json').replaceAll('__REPO__', repo))
  const r = collectEscapement({ repoPath: repo, env: { HOME: userHome, ESCAPEMENT_HOME: '~/elsewhere' }, now: NOW })
  assert.equal(r.entries['add-login'].evidence, '~/elsewhere/queue/pending/q-123.json: pending')
})

test('the module imports no way to spawn a process', () => {
  const src = readFileSync(new URL('../lib/sources/escapement.mjs', import.meta.url), 'utf8')
  assert.equal(/child_process|subprocess\.mjs/.test(src), false)
})
