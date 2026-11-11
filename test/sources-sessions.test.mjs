import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { collectSessions, slugOf } from '../lib/sources/sessions.mjs'
import { makeRepo, snapshotTree, tmp } from './helpers.mjs'

/** Write `<projects>/<slug>/<rel>` with an mtime. */
function transcript(userHome, slug, rel, iso) {
  const file = join(userHome, '.claude', 'projects', slug, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, '{}\n')
  utimesSync(file, new Date(iso), new Date(iso))
  return file
}
const newHome = () => realpathSync(tmp('sess-user-'))

test('slug rule: every character outside [A-Za-z0-9-] becomes a dash', () => {
  assert.equal(slugOf('/Users/caro/IdeaProjects/dial'), '-Users-caro-IdeaProjects-dial')
  assert.equal(slugOf('/Users/caro/My Repo.v2'), '-Users-caro-My-Repo-v2')
  assert.equal(slugOf('/a/.claude/worktrees/x'), '-a--claude-worktrees-x')
})

test('the newest depth-1 transcript sets last_session, evidence ~-collapsed', () => {
  const u = newHome()
  transcript(u, '-Users-caro-IdeaProjects-dial', 's1.jsonl', '2026-11-08T10:00:00Z')
  const newest = transcript(u, '-Users-caro-IdeaProjects-dial', 's2.jsonl', '2026-11-09T10:00:00Z')
  const { lastSession } = collectSessions({ repoPath: '/Users/caro/IdeaProjects/dial', env: { HOME: u } })
  assert.deepEqual(lastSession, {
    value: { file: newest, mtime: '2026-11-09T10:00:00Z' },
    evidence: '~/.claude/projects/-Users-caro-IdeaProjects-dial/s2.jsonl',
  })
})

test('worktree session directories roll up', () => {
  const u = newHome()
  transcript(u, '-Users-caro-IdeaProjects-dial', 's1.jsonl', '2026-11-08T10:00:00Z')
  transcript(u, '-Users-caro-IdeaProjects-dial--claude-worktrees-fix-a', 's2.jsonl', '2026-11-09T10:00:00Z')
  transcript(u, '-Users-caro-IdeaProjects-dial-old', 's3.jsonl', '2026-11-10T10:00:00Z')
  const { lastSession } = collectSessions({ repoPath: '/Users/caro/IdeaProjects/dial', env: { HOME: u } })
  assert.equal(lastSession.evidence, '~/.claude/projects/-Users-caro-IdeaProjects-dial--claude-worktrees-fix-a/s2.jsonl')
})

test('a linked worktree elsewhere is found by its own slug', () => {
  const u = newHome()
  transcript(u, '-elsewhere-wt', 'w1.jsonl', '2026-11-09T10:00:00Z')
  const { lastSession } = collectSessions({
    repoPath: '/Users/caro/IdeaProjects/dial',
    worktrees: [{ path: '/elsewhere/wt', branch: 'x' }],
    env: { HOME: u },
  })
  assert.equal(lastSession.value.mtime, '2026-11-09T10:00:00Z')
})

test('only depth-1 transcripts count', () => {
  const u = newHome()
  transcript(u, '-r-dial', 's1.jsonl', '2026-11-08T10:00:00Z')
  transcript(u, '-r-dial', 's1/subagents/a.jsonl', '2026-11-10T10:00:00Z')
  transcript(u, '-r-dial', 'notes.txt', '2026-11-10T11:00:00Z')
  const { lastSession } = collectSessions({ repoPath: '/r/dial', env: { HOME: u } })
  assert.equal(lastSession.value.mtime, '2026-11-08T10:00:00Z')
})

test('excludeSession skips the live transcript', () => {
  const u = newHome()
  transcript(u, '-r-dial', 'older.jsonl', '2026-11-08T10:00:00Z')
  transcript(u, '-r-dial', 's9.jsonl', '2026-11-10T10:00:00Z')
  assert.equal(collectSessions({ repoPath: '/r/dial', env: { HOME: u } }).lastSession.value.mtime, '2026-11-10T10:00:00Z')
  const { lastSession } = collectSessions({ repoPath: '/r/dial', env: { HOME: u }, excludeSession: 's9' })
  assert.equal(lastSession.value.mtime, '2026-11-08T10:00:00Z')
})

test('a symlinked registration also reads the physical slug', () => {
  const u = newHome()
  const real = realpathSync(makeRepo(tmp('sess-real-'), {}))
  const link = join(tmp('sess-link-'), 'alias')
  symlinkSync(real, link)
  transcript(u, slugOf(real), 's1.jsonl', '2026-11-09T10:00:00Z')
  const { lastSession } = collectSessions({ repoPath: link, env: { HOME: u } })
  assert.equal(lastSession.value.mtime, '2026-11-09T10:00:00Z')
})

test('no transcripts: unobserved naming the primary slug directory; nothing created', () => {
  const u = newHome()
  const before = snapshotTree(u)
  const { lastSession } = collectSessions({ repoPath: '/Users/caro/IdeaProjects/dial', env: { HOME: u } })
  assert.deepEqual(lastSession, {
    value: null,
    unobserved: 'no sessions under ~/.claude/projects/-Users-caro-IdeaProjects-dial',
  })
  assert.deepEqual(snapshotTree(u), before)
})

test('excluding the only transcript leaves no sessions', () => {
  const u = newHome()
  transcript(u, '-r-dial', 's9.jsonl', '2026-11-10T10:00:00Z')
  const { lastSession } = collectSessions({ repoPath: '/r/dial', env: { HOME: u }, excludeSession: 's9' })
  assert.match(lastSession.unobserved, /^no sessions under ~\/\.claude\/projects\/-r-dial$/)
})
