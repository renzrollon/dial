// lib/vault.mjs against specs/vault-writes/spec.md: the boundary, atomic and re-read writes, the daily log,
// the archive move, drop and vault init. Every test builds its own vault and repo in a temp directory.
process.env.TZ = 'UTC'

import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendDaily, applyWrites, archiveNotes, dropNote, planWrites, readNotes, setFrontmatter, vaultInit,
} from '../lib/vault.mjs'
import { readFrontmatter } from '../lib/frontmatter.mjs'
import { FIXTURES, makeGitDir, makeVault, snapshotTree, tmp } from './helpers.mjs'

const NOTE = 'Changes/katipon--add-login.md'
const FIXTURE_NOTE = readFileSync(join(FIXTURES, 'vault', NOTE), 'utf8')
const NOW = new Date('2026-11-10T09:00:00Z')

/** Two vaults and one repo registered to `personal`; `roots` and extra registry keys through `extra`. */
function setup(extra = {}) {
  const base = tmp('vault-')
  const personal = makeVault(join(base, 'personal'), [
    { path: '.obsidian/app.json', body: '{}' },
    { path: 'AGENTS.md', body: '# Agents\n' },
  ])
  const work = makeVault(join(base, 'work'), [{ path: 'AGENTS.md', body: '# Work agents\n' }])
  const repo = makeGitDir(join(base, 'repos', 'katipon'))
  const registry = {
    dial_schema: 'dial.registry/1',
    vaults: { personal, work },
    repos: [{ path: repo, vault: 'personal', host: 'github' }],
    limits: {},
    ...extra,
  }
  return { base, personal, work, repo, registry }
}

const fileCount = dir => {
  let n = 0
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.md')) n++
  return n
}
const tmpFiles = dir => readdirSync(dir, { recursive: true }).filter(p => /(^|\/)\.[^/]*\.tmp$/.test(p))
const put = (vault, rel, text) => {
  mkdirSync(join(vault, rel, '..'), { recursive: true })
  writeFileSync(join(vault, rel), text)
}
const warnings = () => {
  const lines = []
  const warn = line => lines.push(line)
  warn.lines = lines
  return warn
}

// --- readNotes ---------------------------------------------------------------

test('readNotes returns the NoteView of one repo: frontmatter, ticked boxes and narrative entries', () => {
  const { personal } = setup()
  cpSync(join(FIXTURES, 'vault', 'Changes'), join(personal, 'Changes'), { recursive: true })
  put(personal, 'Changes/other--thing.md', '---\nrepo: other\n---\n')
  put(personal, 'Projects/katipon.md', '---\nrepo: katipon\nstate: idle\n---\n\n## Next\n\n- [ ] one\n')
  const view = readNotes(personal, 'katipon')
  assert.deepEqual(Object.keys(view).sort(), ['katipon', 'katipon--add-login'])
  const n = view['katipon--add-login']
  assert.equal(n.path, NOTE)
  assert.equal(n.frontmatter.state, 'pr-open')
  assert.deepEqual(n.next, [
    { checked: false, text: 'Ask Maya about the session timeout' },
    { checked: true, text: 'Squash the fixup commits' },
    { checked: false, text: 'Merge once CI is green' },
  ])
  assert.equal(n.narrative.length, 1)
  assert.equal(n.narrative[0].source, 'dial handoff')
  assert.match(n.narrative[0].body, /magic-link endpoint/)
  assert.deepEqual(view.katipon.next, [{ checked: false, text: 'one' }])
})

test('readNotes on a vault with no Changes folder is empty and reads nothing under .obsidian', () => {
  const { personal } = setup()
  assert.deepEqual(readNotes(personal, 'katipon'), {})
})

// --- the boundary -------------------------------------------------------------

test('a write into another vault is refused and no file in either vault changed', () => {
  const { personal, work, registry } = setup()
  const before = [snapshotTree(personal), snapshotTree(work)]
  const result = applyWrites(work, [{ path: NOTE, content: 'x\n' }], { registry, repo: 'katipon' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, `katipon is registered to vault personal; refusing to write into ${join(work, NOTE)}`)
  assert.deepEqual([snapshotTree(personal), snapshotTree(work)], before)
})

test('a path outside the allowed folders and root files is refused: .obsidian, AGENTS.md, .. and an unknown folder', () => {
  const { personal, registry } = setup()
  const before = snapshotTree(personal)
  for (const path of ['.obsidian/app.json', 'AGENTS.md', '../escape.md', 'Notes/x.md', 'Archive/x.md', 'Daily/../AGENTS.md']) {
    const result = applyWrites(personal, [{ path, content: 'x\n' }], { registry, repo: 'katipon' })
    assert.equal(result.ok, false, path)
    assert.match(result.reason, /^katipon is registered to vault personal; refusing to write into /, path)
  }
  assert.deepEqual(snapshotTree(personal), before)
})

test('every allowed folder and root file is writable', () => {
  const { personal, registry } = setup()
  const paths = [
    'Projects/katipon.md', NOTE, 'Archive/Changes/katipon--add-login.md', 'Daily/2026-11-10.md', 'Templates/Daily.md',
    'Inbox/Dial Review 2026-11-10.md', 'Dial.base', 'Dial Summary.md', 'Dial Queries.md',
  ]
  const result = applyWrites(personal, paths.map(path => ({ path, content: 'x\n' })), { registry, repo: 'katipon' })
  assert.equal(result.ok, true)
  for (const p of paths) assert.equal(readFileSync(join(personal, p), 'utf8'), 'x\n')
})

test('a symlink inside the vault that leaves it is refused', () => {
  const { personal, work, registry } = setup()
  symlinkSync(work, join(personal, 'Projects'))
  const result = applyWrites(personal, [{ path: 'Projects/katipon.md', content: 'x\n' }], { registry, repo: 'katipon' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /refusing to write into/)
  assert.equal(existsSync(join(work, 'katipon.md')), false)
})

test('a vault path that does not exist is refused and not created', () => {
  const { base, registry } = setup()
  const gone = join(base, 'gone')
  registry.vaults.personal = gone
  const result = applyWrites(gone, [{ path: NOTE, content: 'x\n' }], { registry, repo: 'katipon' })
  assert.equal(result.reason, `vault personal for katipon does not exist: ${gone}`)
  assert.equal(existsSync(gone), false)
})

test('a repo the registry does not know is refused', () => {
  const { personal, registry } = setup()
  const result = applyWrites(personal, [{ path: NOTE, content: 'x\n' }], { registry, repo: 'nothing-here' })
  assert.equal(result.reason, 'no registered repo matches nothing-here')
})

test('an entry registered before its root was declared is refused for every write, naming the root as written', () => {
  const { base, personal, work } = setup()
  const parent = join(base, 'VSCodeProjects')
  const agentbase = makeGitDir(join(parent, 'agentbase'))
  const registry = {
    dial_schema: 'dial.registry/1',
    vaults: { personal, work },
    repos: [{ path: agentbase, vault: 'personal', host: 'github' }],
    roots: { [parent]: 'work' },
    limits: {},
  }
  const before = [snapshotTree(personal), snapshotTree(work)]
  const result = applyWrites(personal, [{ path: 'Projects/agentbase.md', content: 'x\n' }], { registry, repo: 'agentbase' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, `agentbase is under ${parent}, which belongs to vault work; refusing to write into vault personal`)
  assert.deepEqual([snapshotTree(personal), snapshotTree(work)], before)
  assert.equal(planWrites(personal, [{ path: 'Projects/agentbase.md', content: 'x\n' }], { registry, repo: 'agentbase' }).ok, false)
})

test('a root that agrees with the registered vault does not refuse', () => {
  const { base, personal, work } = setup()
  const parent = join(base, 'VSCodeProjects')
  const agentbase = makeGitDir(join(parent, 'agentbase'))
  const registry = {
    dial_schema: 'dial.registry/1', vaults: { personal, work },
    repos: [{ path: agentbase, vault: 'work', host: 'github' }], roots: { [parent]: 'work' }, limits: {},
  }
  assert.equal(applyWrites(work, [{ path: 'Projects/agentbase.md', content: 'x\n' }], { registry, repo: 'agentbase' }).ok, true)
})

test('without a repo only a vault named in the registry may be written', () => {
  const { base, personal, registry } = setup()
  assert.equal(applyWrites(personal, [{ path: 'Dial Summary.md', content: 'x\n' }], { registry }).ok, true)
  const stray = makeVault(join(base, 'stray'))
  const refused = applyWrites(stray, [{ path: 'Dial Summary.md', content: 'x\n' }], { registry })
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /not a vault named in the registry/)
})

// --- plans and dry runs -------------------------------------------------------

test('planWrites names create, update, unchanged, append and move, and writes nothing', () => {
  const { personal, registry } = setup()
  put(personal, 'Projects/katipon.md', 'old\n')
  put(personal, 'Projects/same.md', 'same\n')
  put(personal, 'Daily/2026-11-10.md', '## Log\n\n- a\n')
  put(personal, NOTE, FIXTURE_NOTE)
  const before = snapshotTree(personal)
  const result = planWrites(personal, [
    { path: 'Changes/new.md', content: 'new\n' },
    { path: 'Projects/katipon.md', content: 'new\n' },
    { path: 'Projects/same.md', content: 'same\n' },
    { path: 'Daily/2026-11-10.md', verb: 'append', render: t => `${t}- b\n` },
    { from: NOTE, to: 'Archive/Changes/katipon--add-login.md' },
  ], { registry, repo: 'katipon' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.plan.map(p => p.line), [
    `create ${join(personal, 'Changes/new.md')}`,
    `update ${join(personal, 'Projects/katipon.md')}`,
    `unchanged ${join(personal, 'Projects/same.md')}`,
    `append ${join(personal, 'Daily/2026-11-10.md')}`,
    `move ${join(personal, NOTE)} → ${join(personal, 'Archive/Changes/katipon--add-login.md')}`,
  ])
  assert.deepEqual(snapshotTree(personal), before)
})

test('a move whose target exists is planned unchanged', () => {
  const { personal, registry } = setup()
  put(personal, NOTE, 'a\n')
  put(personal, 'Archive/Changes/katipon--add-login.md', 'b\n')
  const { plan } = planWrites(personal, [{ from: NOTE, to: 'Archive/Changes/katipon--add-login.md' }], { registry, repo: 'katipon' })
  assert.equal(plan[0].verb, 'unchanged')
})

// --- atomic and idempotent writes ---------------------------------------------

test('an unchanged file is not rewritten: bytes and modification time stay', () => {
  const { personal, registry } = setup()
  const ctx = { registry, repo: 'katipon' }
  assert.equal(applyWrites(personal, [{ path: 'Projects/katipon.md', content: 'x\n' }], ctx).results[0].verb, 'create')
  const file = join(personal, 'Projects/katipon.md')
  utimesSync(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
  const mtime = statSync(file).mtimeMs
  const again = applyWrites(personal, [{ path: 'Projects/katipon.md', content: 'x\n' }], ctx)
  assert.equal(again.results[0].verb, 'unchanged')
  assert.equal(statSync(file).mtimeMs, mtime)
})

test('folders are created on demand and no temp file remains after five writes', () => {
  const { personal, registry } = setup()
  const writes = ['Projects/katipon.md', 'Changes/a.md', 'Changes/b.md', 'Archive/Changes/c.md', 'Daily/d.md']
    .map(path => ({ path, content: `${path}\n` }))
  const result = applyWrites(personal, writes, { registry, repo: 'katipon' })
  assert.deepEqual(result.results.map(r => r.verb), ['create', 'create', 'create', 'create', 'create'])
  assert.deepEqual(tmpFiles(personal), [])
  assert.equal(existsSync(join(personal, 'Templates')), false)
  assert.equal(existsSync(join(personal, 'Dial.base')), false)
})

test('a failed rename leaves the note with its previous bytes and removes the temp file', () => {
  const { personal, registry } = setup()
  put(personal, NOTE, FIXTURE_NOTE)
  const before = snapshotTree(personal)
  const result = applyWrites(personal, [{ path: NOTE, content: 'new\n' }], {
    registry,
    repo: 'katipon',
    rename: () => { throw new Error('EXDEV: cross-device link') },
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /EXDEV/)
  assert.deepEqual(snapshotTree(personal), before)
  assert.deepEqual(tmpFiles(personal), [])
})

test('the temp file is the hidden .<name>.<pid>.tmp in the target directory', () => {
  const { personal, registry } = setup()
  const seen = []
  applyWrites(personal, [{ path: 'Projects/katipon.md', content: 'x\n' }], {
    registry,
    repo: 'katipon',
    pid: 4242,
    beforeRename: path => seen.push(readdirSync(join(path, '..')).filter(n => n.endsWith('.tmp'))),
  })
  assert.deepEqual(seen, [['.katipon.md.4242.tmp']])
})

// --- a note changed during the write ------------------------------------------

test('a narrative entry landing between plan and apply survives and the new State is written', () => {
  const { personal, registry } = setup()
  put(personal, NOTE, '---\nstate: pr-open\n---\n\n## Next\n\n## Narrative\n\n## State\n\nold\n')
  const render = text => text.replace(/## State\n[\s\S]*$/, '## State\n\nnew\n')
  let landed = false
  const result = applyWrites(personal, [{ path: NOTE, render }], {
    registry,
    repo: 'katipon',
    beforeRename: path => {
      if (landed) return
      landed = true
      writeFileSync(path, readFileSync(path, 'utf8').replace('## Narrative\n', '## Narrative\n\n### 2026-11-10 09:00 · dial handoff\n\nkept\n'))
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.results[0].verb, 'update')
  const out = readFileSync(join(personal, NOTE), 'utf8')
  assert.match(out, /### 2026-11-10 09:00 · dial handoff\n\nkept\n/)
  assert.match(out, /## State\n\nnew\n$/)
  assert.deepEqual(tmpFiles(personal), [])
})

test('a file that keeps changing is skipped with one stderr line and keeps the other writer\'s bytes', () => {
  const { personal, registry } = setup()
  put(personal, NOTE, 'v0\n')
  const warn = warnings()
  let n = 0
  const result = applyWrites(personal, [{ path: NOTE, render: t => `${t}mine\n` }], {
    registry,
    repo: 'katipon',
    warn,
    beforeRename: path => writeFileSync(path, `theirs ${++n}\n`),
  })
  assert.equal(result.ok, true)
  assert.equal(result.results[0].verb, 'skipped')
  assert.equal(readFileSync(join(personal, NOTE), 'utf8'), 'theirs 2\n')
  assert.deepEqual(warn.lines, [`dial: ${join(personal, NOTE)} changed during the write; skipped`])
  assert.deepEqual(tmpFiles(personal), [])
})

test('a fixed-content write cannot be planned again, so a changed file is skipped, not overwritten', () => {
  const { personal, registry } = setup()
  put(personal, NOTE, 'v0\n')
  const warn = warnings()
  const result = applyWrites(personal, [{ path: NOTE, content: 'mine\n' }], {
    registry, repo: 'katipon', warn, beforeRename: path => writeFileSync(path, 'theirs\n'),
  })
  assert.equal(result.results[0].verb, 'skipped')
  assert.equal(readFileSync(join(personal, NOTE), 'utf8'), 'theirs\n')
  assert.equal(warn.lines.length, 1)
})

test('a file created by another writer between plan and apply is replanned from its bytes', () => {
  const { personal, registry } = setup()
  const result = applyWrites(personal, [{ path: 'Projects/katipon.md', render: t => `${t ?? ''}mine\n` }], {
    registry,
    repo: 'katipon',
    beforeRename: (path, attempt) => { if (attempt === 0) writeFileSync(path, 'theirs\n') },
  })
  assert.equal(result.results[0].verb, 'update')
  assert.equal(readFileSync(join(personal, 'Projects/katipon.md'), 'utf8'), 'theirs\nmine\n')
})

// --- the daily log ------------------------------------------------------------

const LINE_A = '- 09:00 dial · katipon/add-login: shipping → pr-open (PR 38 open) [[katipon--add-login]]'
const LINE_B = '- 09:05 dial · katipon/add-login: handoff (dial handoff) [[katipon--add-login]]'
const daily = personal => readFileSync(join(personal, 'Daily/2026-11-10.md'), 'utf8')

test('a daily note is created from the vault template byte for byte and ends with the new line under Log', () => {
  const { personal, registry } = setup()
  const template = '---\ntype: daily\ncreated: <% date %>\nupdated: <% date %>\n---\n\n## Plan\n\nx\n\n## Log\n\n'
  put(personal, 'Templates/Daily.md', template)
  assert.equal(appendDaily(personal, LINE_A, { registry, repo: 'katipon', now: NOW }).ok, true)
  assert.equal(daily(personal), `${template}${LINE_A}\n`)
})

test('a daily note is created from the skeleton when the vault has no template', () => {
  const { personal, registry } = setup()
  appendDaily(personal, LINE_A, { registry, repo: 'katipon', now: NOW })
  const out = daily(personal)
  assert.equal(readFrontmatter(out).type, 'daily')
  assert.match(out, /\n## Log\n\n- 09:00 dial/)
  assert.equal(existsSync(join(personal, 'Templates')), false)
})

test('a missing Log heading is appended at the end and the earlier section is byte-identical', () => {
  const { personal, registry } = setup()
  const before = '---\ntype: daily\n---\n\n## Notes\n\nmy notes\n'
  put(personal, 'Daily/2026-11-10.md', before)
  appendDaily(personal, LINE_A, { registry, repo: 'katipon', now: NOW })
  assert.equal(daily(personal), `${before}\n## Log\n\n${LINE_A}\n`)
})

test('a line goes at the end of Log, before the next section, and earlier lines are unchanged', () => {
  const { personal, registry } = setup()
  put(personal, 'Daily/2026-11-10.md', '---\ntype: daily\n---\n\n## Log\n\n- one\n- two\n\n## Reading\n\nbook\n')
  appendDaily(personal, LINE_A, { registry, repo: 'katipon', now: NOW })
  assert.equal(daily(personal), `---\ntype: daily\n---\n\n## Log\n\n- one\n- two\n${LINE_A}\n\n## Reading\n\nbook\n`)
})

test('lines append in call order and an existing updated key becomes today', () => {
  const { personal, registry } = setup()
  put(personal, 'Daily/2026-11-10.md', '---\ntype: daily\ncreated: 2026-11-10\nupdated: 2026-11-09\n---\n\n## Log\n\n')
  appendDaily(personal, LINE_A, { registry, repo: 'katipon', now: NOW })
  appendDaily(personal, [LINE_B], { registry, repo: 'katipon', now: NOW })
  const out = daily(personal)
  assert.equal(out, `---\ntype: daily\ncreated: 2026-11-10\nupdated: 2026-11-10\n---\n\n## Log\n\n${LINE_A}\n${LINE_B}\n`)
})

test('without an updated key none is added', () => {
  const { personal, registry } = setup()
  appendDaily(personal, LINE_A, { registry, repo: 'katipon', now: NOW })
  assert.ok(!('updated' in readFrontmatter(daily(personal))))
})

test('a heading at the end of the file without a newline still gets its line', () => {
  const { personal, registry } = setup()
  put(personal, 'Daily/2026-11-10.md', '---\ntype: daily\n---\n\n## Log')
  appendDaily(personal, LINE_A, { registry, repo: 'katipon', now: NOW })
  assert.equal(daily(personal), `---\ntype: daily\n---\n\n## Log\n\n${LINE_A}\n`)
})

test('the date is the local date of now', () => {
  const { personal, registry } = setup()
  appendDaily(personal, LINE_A, { registry, repo: 'katipon', now: new Date('2026-11-10T23:30:00Z') })
  assert.equal(existsSync(join(personal, 'Daily/2026-11-10.md')), true)
})

test('two appends whose reads interleave both land under Log', () => {
  const { personal, registry } = setup()
  put(personal, 'Daily/2026-11-10.md', '---\ntype: daily\n---\n\n## Log\n\n- one\n')
  let landed = false
  appendDaily(personal, LINE_A, {
    registry,
    repo: 'katipon',
    now: NOW,
    beforeRename: path => {
      if (landed) return
      landed = true
      writeFileSync(path, `${readFileSync(path, 'utf8')}${LINE_B}\n`)
    },
  })
  assert.equal(daily(personal), `---\ntype: daily\n---\n\n## Log\n\n- one\n${LINE_B}\n${LINE_A}\n`)
})

test('a daily append refused by the boundary writes nothing', () => {
  const { work, registry } = setup()
  const before = snapshotTree(work)
  const result = appendDaily(work, LINE_A, { registry, repo: 'katipon', now: NOW })
  assert.equal(result.ok, false)
  assert.deepEqual(snapshotTree(work), before)
  assert.equal(existsSync(join(work, 'Daily')), false)
})

// --- archive ------------------------------------------------------------------

const archivedNote = FIXTURE_NOTE.replace('state: pr-open', 'state: archived')
const MOVED = 'Archive/Changes/katipon--add-login.md'

test('an archived note moves to Archive/Changes after the keep period with status and date set', () => {
  const { personal, registry } = setup()
  put(personal, NOTE, archivedNote)
  const writes = archiveNotes(personal, {
    repo: 'katipon', archived: [{ name: 'add-login', date: '2026-10-01' }], archivedKeepDays: 30, now: NOW,
  })
  assert.equal(writes.length, 1)
  const before = fileCount(personal)
  const result = applyWrites(personal, writes, { registry, repo: 'katipon' })
  assert.deepEqual(result.results.map(r => r.verb), ['move'])
  assert.equal(existsSync(join(personal, NOTE)), false)
  const out = readFileSync(join(personal, MOVED), 'utf8')
  assert.equal(readFrontmatter(out).status, 'archived')
  assert.equal(readFrontmatter(out).archived, '2026-11-10')
  assert.equal(readFrontmatter(out).updated, '2026-11-09')
  assert.equal(out, setFrontmatter(archivedNote, { status: 'archived', archived: '2026-11-10' }))
  assert.equal(fileCount(personal), before)
  assert.deepEqual(tmpFiles(personal), [])
})

test('a note stays within the keep period, at exactly the cap, and when its state is not archived', () => {
  const { personal } = setup()
  put(personal, NOTE, archivedNote)
  const plan = date => archiveNotes(personal, { repo: 'katipon', archived: [{ name: 'add-login', date }], archivedKeepDays: 30, now: NOW })
  assert.equal(plan('2026-11-01').length, 0)
  assert.equal(plan('2026-10-11').length, 0)
  assert.equal(plan('2026-10-10').length, 1)
  put(personal, NOTE, FIXTURE_NOTE)
  assert.equal(plan('2026-10-01').length, 0)
  assert.equal(archiveNotes(personal, { repo: 'katipon', archived: { value: null, unobserved: 'no openspec dir' }, archivedKeepDays: 30, now: NOW }).length, 0)
})

test('an existing target leaves both files unchanged', () => {
  const { personal, registry } = setup()
  put(personal, NOTE, archivedNote)
  put(personal, MOVED, 'already here\n')
  const before = snapshotTree(personal)
  const writes = archiveNotes(personal, { repo: 'katipon', archived: [{ name: 'add-login', date: '2026-10-01' }], archivedKeepDays: 30, now: NOW })
  const result = applyWrites(personal, writes, { registry, repo: 'katipon' })
  assert.equal(result.results[0].verb, 'unchanged')
  assert.deepEqual(snapshotTree(personal), before)
})

test('the archive plan names the move and both paths are as they were', () => {
  const { personal, registry } = setup()
  put(personal, NOTE, archivedNote)
  const before = snapshotTree(personal)
  const writes = archiveNotes(personal, { repo: 'katipon', archived: [{ name: 'add-login', date: '2026-10-01' }], archivedKeepDays: 30, now: NOW })
  const { plan } = planWrites(personal, writes, { registry, repo: 'katipon' })
  assert.equal(plan[0].line, `move ${join(personal, NOTE)} → ${join(personal, MOVED)}`)
  assert.deepEqual(snapshotTree(personal), before)
})

// --- drop ---------------------------------------------------------------------

test('drop sets the four keys, keeps every other byte and prints the wikilink', () => {
  const { personal, registry } = setup()
  put(personal, NOTE, FIXTURE_NOTE)
  const result = dropNote(personal, 'katipon', 'add-login', { registry, now: NOW })
  assert.equal(result.ok, true)
  assert.equal(result.link, '[[katipon--add-login]]')
  const out = readFileSync(join(personal, NOTE), 'utf8')
  const f = readFrontmatter(out)
  assert.equal(f.dropped, '2026-11-10')
  assert.equal(f.state, 'dropped')
  assert.equal(f.needs_me, 'false')
  assert.equal(f.updated, '2026-11-10')
  assert.equal(f.source, 'pi session 2026-11-08')
  const body = text => text.slice(text.indexOf('\n---\n', 4))
  assert.equal(body(out), body(FIXTURE_NOTE))
  assert.equal(out, FIXTURE_NOTE
    .replace('state: pr-open', 'state: dropped').replace('needs_me: true', 'needs_me: false')
    .replace('updated: 2026-11-09', 'updated: 2026-11-10').replace('source: pi session 2026-11-08\n', 'source: pi session 2026-11-08\ndropped: 2026-11-10\n'))
})

test('dropping twice keeps the first date and the second run changes no byte', () => {
  const { personal, registry } = setup()
  put(personal, NOTE, FIXTURE_NOTE)
  dropNote(personal, 'katipon', 'add-login', { registry, now: NOW })
  const once = snapshotTree(personal)
  const again = dropNote(personal, 'katipon', 'add-login', { registry, now: new Date('2026-11-12T09:00:00Z') })
  assert.equal(again.ok, true)
  assert.equal(again.dropped, false)
  assert.equal(readFrontmatter(readFileSync(join(personal, NOTE), 'utf8')).dropped, '2026-11-10')
  assert.deepEqual(snapshotTree(personal), once)
})

test('dropping a missing note names the repo, change and vault', () => {
  const { personal, registry } = setup()
  const before = snapshotTree(personal)
  const result = dropNote(personal, 'katipon', 'nothing-here', { registry, now: NOW })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no note for katipon/nothing-here in vault personal')
  assert.deepEqual(snapshotTree(personal), before)
  assert.equal(existsSync(join(personal, 'Changes')), false)
})

test('drop is refused for a vault that is not the repo\'s', () => {
  const { work, registry } = setup()
  put(work, NOTE, FIXTURE_NOTE)
  const before = snapshotTree(work)
  assert.equal(dropNote(work, 'katipon', 'add-login', { registry, now: NOW }).ok, false)
  assert.deepEqual(snapshotTree(work), before)
})

test('setFrontmatter replaces a key in place, appends a new one last and adds a block to a bare note', () => {
  assert.equal(setFrontmatter('---\na: 1\nb: 2\n---\nbody\n', { b: 3, c: 'x' }), '---\na: 1\nb: 3\nc: x\n---\nbody\n')
  assert.equal(setFrontmatter('body\n', { a: true }), '---\na: true\n---\nbody\n')
})

// --- vault init ---------------------------------------------------------------

const INIT_PATHS = ['Projects/', 'Changes/', 'Templates/', 'Dial.base', 'Templates/Dial Change.md', 'Dial Queries.md', 'Templates/Daily.md']

test('a first init creates the three folders and four files in order, then prints the AGENTS instruction', () => {
  const { personal, registry } = setup()
  const result = vaultInit('personal', { registry })
  assert.equal(result.ok, true)
  assert.deepEqual(result.lines.slice(0, 7), INIT_PATHS.map(p => `created ${p}`))
  assert.match(result.lines[7], new RegExp(`^append .*templates/AGENTS-dial-section\\.md to ${personal}/AGENTS\\.md by hand$`))
  assert.equal(result.lines.length, 8)
  for (const p of INIT_PATHS) assert.equal(existsSync(join(personal, p)), true, p)
})

test('a second init says unchanged for every path and the vault is byte-identical', () => {
  const { personal, registry } = setup()
  vaultInit('personal', { registry })
  const first = snapshotTree(personal)
  const second = vaultInit('personal', { registry })
  assert.deepEqual(second.lines.slice(0, 7), INIT_PATHS.map(p => `unchanged ${p}`))
  assert.deepEqual(snapshotTree(personal), first)
})

test('an edited template is kept without force and rewritten with it', () => {
  const { personal, registry } = setup()
  vaultInit('personal', { registry })
  const shipped = readFileSync(join(personal, 'Dial.base'), 'utf8')
  put(personal, 'Templates/Dial Change.md', 'my edit\n')
  put(personal, 'Dial.base', 'my base\n')
  const kept = vaultInit('personal', { registry })
  assert.ok(kept.lines.includes('unchanged Templates/Dial Change.md'))
  assert.equal(readFileSync(join(personal, 'Templates/Dial Change.md'), 'utf8'), 'my edit\n')
  const forced = vaultInit('personal', { registry, force: true })
  assert.ok(forced.lines.includes('rewritten Dial.base'))
  assert.ok(forced.lines.includes('rewritten Templates/Dial Change.md'))
  assert.ok(forced.lines.includes('unchanged Dial Queries.md'))
  assert.equal(readFileSync(join(personal, 'Dial.base'), 'utf8'), shipped)
})

test('init never touches AGENTS.md or .obsidian, even with force', () => {
  const { personal, registry } = setup()
  const guarded = () => ({ agents: readFileSync(join(personal, 'AGENTS.md'), 'utf8'), obsidian: snapshotTree(join(personal, '.obsidian')) })
  const before = guarded()
  vaultInit('personal', { registry, force: true })
  vaultInit('personal', { registry, force: true })
  assert.deepEqual(guarded(), before)
})

test('init refuses an unknown vault and a missing path and creates nothing', () => {
  const { base, registry } = setup()
  assert.equal(vaultInit('clients', { registry }).reason, 'no vault named clients in the registry')
  const gone = join(base, 'gone')
  registry.vaults.personal = gone
  assert.equal(vaultInit('personal', { registry }).reason, `vault personal does not exist: ${gone}`)
  assert.equal(existsSync(gone), false)
})

test('init copies the shipped templates byte for byte', () => {
  const { personal, registry } = setup()
  vaultInit('personal', { registry })
  const shipped = name => readFileSync(new URL(`../templates/${name}`, import.meta.url), 'utf8')
  assert.equal(readFileSync(join(personal, 'Dial.base'), 'utf8'), shipped('Dial.base'))
  assert.equal(readFileSync(join(personal, 'Templates/Dial Change.md'), 'utf8'), shipped('Dial Change.md'))
  assert.equal(readFileSync(join(personal, 'Dial Queries.md'), 'utf8'), shipped('Dial Queries.md'))
  assert.equal(readFileSync(join(personal, 'Templates/Daily.md'), 'utf8'), shipped('Daily.md'))
})

// --- no note is ever deleted --------------------------------------------------

test('the number of .md files never decreases across init, writes, drop and archive', () => {
  const { personal, registry } = setup()
  const counts = [fileCount(personal)]
  const track = () => counts.push(fileCount(personal))
  vaultInit('personal', { registry }); track()
  applyWrites(personal, [{ path: NOTE, content: FIXTURE_NOTE }], { registry, repo: 'katipon' }); track()
  dropNote(personal, 'katipon', 'add-login', { registry, now: NOW }); track()
  put(personal, NOTE, archivedNote)
  const writes = archiveNotes(personal, { repo: 'katipon', archived: [{ name: 'add-login', date: '2026-10-01' }], archivedKeepDays: 30, now: NOW })
  counts.push(fileCount(personal))
  applyWrites(personal, writes, { registry, repo: 'katipon' }); track()
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] >= counts[i - 1], counts.join(','))
  assert.equal(existsSync(join(personal, MOVED)), true)
})

test('lib/vault.mjs unlinks nothing but its own temp file', () => {
  const src = readFileSync(new URL('../lib/vault.mjs', import.meta.url), 'utf8')
  const uses = src.split('\n').filter(l => /\bunlinkSync\(|\brmSync\(|\brmdirSync\(|\bunlink\(/.test(l) && !l.trim().startsWith('//') && !l.trim().startsWith('*'))
  assert.deepEqual(uses.map(l => l.trim()), ['unlinkSync(path)'])
})
