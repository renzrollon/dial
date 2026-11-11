import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ago, brief, capLines, formatBrief, hookEnvelope } from '../lib/brief.mjs'
import { slugOf } from '../lib/sources/sessions.mjs'
import { fakeExec, makeHome, makeRepo, makeVault, snapshotTree, tmp } from './helpers.mjs'

const NOW = new Date(Date.now() + 40 * 86_400_000)
const hoursAgo = h => new Date(NOW.getTime() - h * 3_600_000)

function gitExec({ branch = 'feat/add-login', dirty = 2, sha = '7682fbf' } = {}) {
  const status = `# branch.head ${branch}\n${Array.from({ length: dirty }, (_, i) => `1 .M N... 100644 100644 100644 a b f${i}.mjs`).join('\n')}\n`
  return fakeExec({
    'git rev-parse --abbrev-ref HEAD': { stdout: `${branch === 'DETACHED' ? 'HEAD' : branch}\n` },
    'git rev-parse --short HEAD': { stdout: `${sha}\n` },
    'git status --porcelain=v2 --branch': { stdout: status },
    'git stash list': { stdout: '' },
    'git rev-parse --git-dir': { stdout: '.git\n' },
    'git worktree list --porcelain': { stdout: '' },
    'git log -1 --format=%H%x09%cI': { stdout: `${sha}c1e0000000000000000000000000000000aa\t${hoursAgo(24 * 200).toISOString()}\n` },
  })
}

const narrativeEntry = (stamp, source, lines) => `### ${stamp} · ${source}\n${lines.join('\n')}\n\n`

function noteBody({ narrative = '', next = '' } = {}) {
  return `\n## Narrative\n\n${narrative}\n## Next\n\n${next}`
}

/** A registered katipon with one change, a vault with its notes, a Dial home and a user home. */
function world({ changes = { 'add-login': { tasks: { done: 1, total: 5 } } }, notes = [], exec = gitExec(), limits = {}, layout } = {}) {
  const root = makeRepo(join(tmp('brief-repos-'), 'katipon'), { git: true, changes })
  const vault = makeVault(tmp('brief-vault-'), notes)
  const home = makeHome()
  const userHome = tmp('brief-user-')
  const registry = { dial_schema: 'dial.registry/1', vaults: { personal: vault }, repos: [{ path: layout ?? root, vault: 'personal', host: 'github' }], limits }
  return { root, vault, home, userHome, registry, exec, env: { HOME: userHome } }
}

const run = (w, arg = 'katipon', extra = {}) => brief({ registry: w.registry, arg, env: w.env, now: NOW, home: w.home, exec: w.exec, ...extra })

function transcript(w, name, at) {
  const dir = join(w.userHome, '.claude', 'projects', slugOf(w.root))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.jsonl`)
  writeFileSync(file, '{}\n')
  utimesSync(file, at, at)
}

test('the full brief: header, change line, newest narrative, unticked Next items, the closing line', () => {
  const w = world({
    notes: [
      { path: 'Projects/katipon.md', body: noteBody({ next: '- [ ] repo level thing\n' }) },
      {
        path: 'Changes/katipon--add-login.md',
        frontmatter: { repo: 'katipon', change: 'add-login' },
        body: noteBody({
          narrative: narrativeEntry('2026-11-09 22:20', '/dial:handoff (claude)', ['Done: login form', 'Next: wire the API']) + narrativeEntry('2026-11-08 10:00', 'older', ['old body']),
          next: '- [x] merge\n- [ ] write tests\n- [ ] archive\n',
        }),
      },
    ],
  })
  transcript(w, 'live', hoursAgo(3))
  const out = run(w)
  assert.equal(out.ok, true)
  assert.equal(out.dropped, 0)
  const [header, change, heading, b1, b2, n1, n2, last, ...rest] = out.lines
  assert.equal(header, 'katipon · feat/add-login · dirty 2 · stash 0 · last session 3h ago')
  assert.match(change, /^spec-draft add-login — .+ → \/interlock:review-artifacts$/)
  assert.equal(heading, '### 2026-11-09 22:20 · /dial:handoff (claude)')
  assert.deepEqual([b1, b2], ['Done: login form', 'Next: wire the API'])
  assert.deepEqual([n1, n2], ['- [ ] write tests', '- [ ] archive'])
  assert.equal(last, 'dial next for everything else')
  assert.deepEqual(rest, [])
})

test('ago units are minutes, hours and days', () => {
  const at = ms => ago(new Date(NOW.getTime() - ms).toISOString(), NOW)
  assert.equal(at(40 * 60_000), '40m')
  assert.equal(at(5 * 3_600_000), '5h')
  assert.equal(at(3 * 86_400_000), '3d')
  assert.equal(at(0), '0m')
})

test('git missing and no transcript make every header value unobserved', () => {
  const w = world({ exec: fakeExec({ 'git rev-parse --abbrev-ref HEAD': 'missing' }), changes: {} })
  assert.deepEqual(run(w).lines, ['katipon · unobserved · dirty unobserved · stash unobserved · last session unobserved', 'dial next for everything else'])
})

test('a detached head names its short sha', () => {
  const w = world({ exec: gitExec({ branch: 'DETACHED', sha: '7682fbf' }), changes: {} })
  assert.match(run(w).lines[0], /^katipon · detached 7682fbf · /)
})

test('no items and no narrative: the header then the closing line', () => {
  const w = world({ changes: {} })
  assert.equal(run(w).lines.length, 2)
})

test('archived and dropped items have no line', () => {
  const w = world({ changes: { 'add-login': { tasks: { done: 1, total: 5 } } } })
  makeRepo(w.root, { archive: { '2026-11-05-old-one': {} } })
  const lines = run(w).lines
  assert.ok(!lines.some(l => l.includes('old-one')))
  assert.ok(lines.some(l => l.includes('add-login')))
})

test('--session excludes the live transcript from last session', () => {
  const w = world({ changes: {} })
  transcript(w, 'abc', NOW)
  transcript(w, 'older', new Date(NOW.getTime() - 2 * 86_400_000))
  assert.match(run(w, 'katipon', { session: 'abc' }).lines[0], /last session 2d ago$/)
  assert.match(run(w).lines[0], /last session 0m ago$/)
})

// the capped shapes, spelled out as parts so every count is visible
const parts = {
  header: 'katipon · main · dirty 0 · stash 0 · last session 1h ago',
  changes: [{ line: 'c1', idleDays: 1 }, { line: 'c2', idleDays: 9 }, { line: 'c3', idleDays: 4 }],
  heading: '### H',
  body: ['b1', 'b2', 'b3'],
  next: ['n1', 'n2', 'n3'],
  final: 'dial next for everything else',
  link: 'Projects/katipon.md',
}

test('under the cap everything prints', () => {
  const { lines, dropped } = capLines(parts, 40)
  assert.equal(lines.length, 12)
  assert.equal(dropped, 0)
  assert.equal(lines.at(-1), 'dial next for everything else')
})

test('Next items are dropped first, from the end', () => {
  const { lines, dropped } = capLines(parts, 10)
  assert.equal(lines.length, 10)
  assert.deepEqual(lines.slice(1), ['c1', 'c2', 'c3', '### H', 'b1', 'b2', 'b3', 'n1', '… 2 more lines, see Projects/katipon.md'])
  assert.equal(dropped, 2)
})

test('the narrative body is dropped after every Next item', () => {
  const { lines, dropped } = capLines(parts, 7)
  assert.deepEqual(lines.slice(1), ['c1', 'c2', 'c3', '### H', 'b1', '… 5 more lines, see Projects/katipon.md'])
  assert.equal(dropped, 5)
})

test('then the narrative heading, then the change lines of the items idle longest; the header stays', () => {
  const { lines } = capLines(parts, 3)
  assert.deepEqual(lines, [parts.header, 'c1', '… 9 more lines, see Projects/katipon.md'])
  const floor = capLines(parts, 1)
  assert.equal(floor.lines[0], parts.header)
  assert.equal(floor.lines.length, 2)
})

test('a sixty-line input is cut to briefLines', () => {
  const next = Array.from({ length: 56 }, (_, i) => `- [ ] step ${i}`)
  const notes = [{ path: 'Projects/katipon.md', body: noteBody({ next: next.map(l => `${l}\n`).join('') }) }]
  const w = world({ notes, changes: {} })
  const uncapped = run(w, 'katipon', { limits: { briefLines: 1000 } })
  assert.equal(uncapped.lines.length, 58)
  const out = run(w)
  assert.equal(out.lines.length, 40)
  assert.equal(out.lines.at(-1), '… 18 more lines, see Projects/katipon.md')
  assert.equal(out.dropped, 18)
  const small = run(w, 'katipon', { limits: { briefLines: 5 } })
  assert.equal(small.lines.length, 5)
})

test('hook envelope is one JSON line whose additionalContext is the text', () => {
  const w = world({ changes: {} })
  const out = run(w)
  const env = hookEnvelope(out.lines)
  assert.ok(!env.includes('\n'))
  const parsed = JSON.parse(env)
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.equal(parsed.hookSpecificOutput.additionalContext, formatBrief(out))
})

test('a registered path, a path inside it and a symlink to it resolve; anything else is unregistered', () => {
  const w = world({ changes: {} })
  assert.equal(run(w, w.root).ok, true)
  const inside = join(w.root, 'lib')
  mkdirSync(inside)
  assert.equal(run(w, inside).repo, 'katipon')
  const link = join(tmp('brief-link-'), 'katipon')
  symlinkSync(w.root, link)
  assert.equal(run(w, link).repo, 'katipon')
  const nope = run(w, '/Users/caro/tmp/scratch')
  assert.deepEqual(nope, { ok: false, unregistered: true, reason: '/Users/caro/tmp/scratch is not a registered repo' })
})

test('brief writes nothing and spawns only git', () => {
  const w = world()
  const before = [snapshotTree(w.home), snapshotTree(w.vault)]
  run(w)
  assert.deepEqual([snapshotTree(w.home), snapshotTree(w.vault)], before)
  assert.ok(w.exec.calls.length > 0)
  assert.ok(w.exec.calls.every(c => c.file === 'git'))
})
