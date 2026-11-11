/**
 * `dial handoff` (specs/handoff-and-narrative, handoff requirements; specs/cli-shell,
 * "handoff collects every --next in order" and "Local dates and times follow the
 * process time zone"): the lib in-process, the command as a subprocess.
 */
// Local times in these in-process tests are read in UTC, as the harness runs the CLI.
process.env.TZ = 'UTC'

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendEntry, appendNext, formatEntry, handoff } from '../lib/handoff.mjs'
import { splitNote } from '../lib/note.mjs'
import { BIN, makeHome, makeRepo, makeVault, runCli, snapshotTree, tmp } from './helpers.mjs'

/** A registry with vault `personal` and repo `katipon` (one change `add-login`), plus the notes given. */
function setup({ notes = [], changes = { 'add-login': { tasks: { done: 0, total: 1 } } } } = {}) {
  const root = tmp('handoff-')
  const vault = makeVault(join(root, 'personal'), notes)
  const repo = makeRepo(join(root, 'code', 'katipon'), { changes })
  const registry = { dial_schema: 'dial.registry/1', vaults: { personal: vault }, repos: [{ path: repo, vault: 'personal', host: 'github' }], limits: {} }
  const home = makeHome({ registry })
  return { root, vault, repo, registry, home, env: { DIAL_HOME: home, HOME: tmp('user-home-') } }
}

const CHANGE_NOTE = {
  path: 'Changes/katipon--add-login.md',
  frontmatter: 'title: katipon — add-login\ntype: change\nrepo: katipon\nchange: add-login\nupdated: 2026-11-09\nsource: hand-written',
  body: '\n## Next\n\n- [x] write tests\n\n## Narrative\n\n### 2026-11-08 10:00 · dial handoff\nDone: the start\n\n## State  <!-- dial:generated, do not edit -->\n\n| fact | value | evidence |\n',
}

const read = (s, rel) => readFileSync(join(s.vault, rel), 'utf8')
const section = (text, name) => splitNote(text).sections.find(x => x.heading.startsWith(name))?.body

/** Run the CLI with `input` piped to stdin. */
function runWithInput(args, env, input) {
  return new Promise(resolve => {
    const child = execFile(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: tmp('cli-home-'), TZ: 'UTC', ...env },
      timeout: 30_000,
    }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }))
    child.stdin.end(input)
  })
}

// --- the pure edits -------------------------------------------------------------

test('formatEntry is the heading, the trimmed text and one empty line', () => {
  assert.equal(formatEntry('### 2026-11-10 14:05 · dial handoff', 'Done: x  \n\n'), '### 2026-11-10 14:05 · dial handoff\nDone: x\n\n')
})

test('appendEntry puts the entry first under Narrative and keeps the older bytes', () => {
  const before = '---\ntype: change\n---\n\n## Next\n\n## Narrative\n\n### 2026-11-08 10:00 · dial handoff\nDone: old\n\n## State\n\nx\n'
  const after = appendEntry(before, formatEntry('### 2026-11-10 14:05 · dial handoff', 'Done: new'))
  assert.equal(after, before.replace('## Narrative\n\n', '## Narrative\n\n### 2026-11-10 14:05 · dial handoff\nDone: new\n\n'))
})

test('appendEntry adds the missing sections to a note that has none', () => {
  const after = appendEntry('---\ntitle: x\n---\nhello\n', formatEntry('### h · s', 'b'))
  assert.equal(after, '---\ntitle: x\n---\nhello\n## Next\n\n## Narrative\n\n### h · s\nb\n\n')
})

test('appendNext appends after the last line of Next and leaves the rest alone', () => {
  const before = '## Next\n\n- [x] write tests\n\n## Narrative\n\n'
  assert.equal(appendNext(before, ['run the plan', 'open the PR']), '## Next\n\n- [x] write tests\n- [ ] run the plan\n- [ ] open the PR\n\n## Narrative\n\n')
  assert.equal(appendNext('## Next\n\n## Narrative\n', ['a']), '## Next\n\n- [ ] a\n\n## Narrative\n')
  assert.equal(appendNext(before, []), before)
})

// --- the lib --------------------------------------------------------------------

test('twice gives two entries, newest first, the older entry byte for byte', () => {
  const s = setup({ notes: [CHANGE_NOTE] })
  const first = handoff({ registry: s.registry, repo: 'katipon', change: 'add-login', text: 'Done: first', now: new Date('2026-11-10T14:05:00Z') })
  assert.equal(first.ok, true, first.reason)
  const afterFirst = section(read(s, CHANGE_NOTE.path), 'Narrative')
  const second = handoff({ registry: s.registry, repo: 'katipon', change: 'add-login', text: 'Done: second', now: new Date('2026-11-10T14:20:00Z') })
  assert.equal(second.ok, true)
  const narrative = section(read(s, CHANGE_NOTE.path), 'Narrative')
  assert.ok(narrative.startsWith('\n### 2026-11-10 14:20 · dial handoff\nDone: second\n\n### 2026-11-10 14:05 · dial handoff\nDone: first\n\n'))
  assert.ok(narrative.endsWith(afterFirst.slice(1)), 'the 14:05 entry and everything older are unchanged')
  assert.match(narrative, /### 2026-11-08 10:00 · dial handoff\nDone: the start\n/)
})

test('Next grows by one box per --next and the frontmatter bytes do not change', () => {
  const s = setup({ notes: [CHANGE_NOTE] })
  const fm = splitNote(read(s, CHANGE_NOTE.path)).frontmatter
  const r = handoff({ registry: s.registry, repo: 'katipon', change: 'add-login', text: 'x', next: ['run the plan', 'open the PR'] })
  assert.equal(r.ok, true)
  assert.equal(r.nextAdded, 2)
  const text = read(s, CHANGE_NOTE.path)
  assert.equal(splitNote(text).frontmatter, fm)
  assert.deepEqual(section(text, 'Next').split('\n').filter(Boolean), ['- [x] write tests', '- [ ] run the plan', '- [ ] open the PR'])
  const again = handoff({ registry: s.registry, repo: 'katipon', change: 'add-login', text: 'y', next: ['third'] })
  assert.equal(again.ok, true)
  assert.equal(section(read(s, CHANGE_NOTE.path), 'Next').split('\n').filter(Boolean).length, 4)
  assert.equal(splitNote(read(s, CHANGE_NOTE.path)).frontmatter, fm)
})

test('the repo note gets the entry when no change is given, and no change note is written', () => {
  const s = setup()
  const r = handoff({ registry: s.registry, repo: 'katipon', text: 'Done: tidied', source: '/dial:handoff (claude)', now: new Date('2026-11-10T09:30:00Z') })
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.note, 'Projects/katipon.md')
  assert.equal(r.wikilink, '[[katipon]]')
  assert.ok(section(read(s, 'Projects/katipon.md'), 'Narrative').startsWith('\n### 2026-11-10 09:30 · /dial:handoff (claude)\nDone: tidied\n'))
  assert.ok(!existsSync(join(s.vault, 'Changes')))
  const log = read(s, 'Daily/2026-11-10.md').trimEnd().split('\n')
  assert.equal(log.at(-1), '- 09:30 dial · katipon: handoff (/dial:handoff (claude)) [[katipon]]')
})

test('the daily line for a change handoff names the change and its source', () => {
  const s = setup({ notes: [CHANGE_NOTE] })
  const r = handoff({ registry: s.registry, repo: 'katipon', change: 'add-login', text: 'x', source: '/dial:handoff (claude)', now: new Date('2026-11-10T14:05:00Z') })
  assert.equal(r.ok, true)
  const log = read(s, 'Daily/2026-11-10.md').trimEnd().split('\n')
  assert.equal(log.at(-1), '- 14:05 dial · katipon/add-login: handoff (/dial:handoff (claude)) [[katipon--add-login]]')
})

test('a missing change note is created from the vault template, else from the packaged skeleton', () => {
  const withTemplate = setup({ notes: [{ path: 'Templates/Dial Change.md', body: '---\ntype: change\nfrom: vault-template\n---\n\n## Next\n\n## Narrative\n' }] })
  const a = handoff({ registry: withTemplate.registry, repo: 'katipon', change: 'add-login', text: 'Done: a', now: new Date('2026-11-10T14:05:00Z') })
  assert.equal(a.ok, true, a.reason)
  const made = read(withTemplate, 'Changes/katipon--add-login.md')
  assert.match(made, /^from: vault-template$/m)
  assert.ok(section(made, 'Narrative').startsWith('\n### 2026-11-10 14:05 · dial handoff\nDone: a\n'))

  const bare = setup()
  const b = handoff({ registry: bare.registry, repo: 'katipon', change: 'add-login', text: 'Done: b' })
  assert.equal(b.ok, true)
  const skeleton = read(bare, 'Changes/katipon--add-login.md')
  assert.match(skeleton, /^## Next$/m)
  assert.match(skeleton, /^## Narrative$/m)
  assert.ok(!existsSync(join(bare.vault, 'Templates')), 'the vault template folder is not created')
})

test('an archived change still takes a handoff; a typo in the change name is refused and creates nothing', () => {
  const s = setup({ changes: {} })
  makeRepo(s.repo, { archive: { '2026-11-01-old-idea': {} } })
  assert.equal(handoff({ registry: s.registry, repo: 'katipon', change: 'old-idea', text: 'x' }).ok, true)
  const before = snapshotTree(s.vault)
  const r = handoff({ registry: s.registry, repo: 'katipon', change: 'add-logn', text: 'x' })
  assert.deepEqual(r, { ok: false, reason: 'katipon has no change add-logn' })
  assert.deepEqual(snapshotTree(s.vault), before)
})

test('an unknown repo and an empty body are refused and nothing is written', () => {
  const s = setup()
  const before = snapshotTree(s.vault)
  assert.deepEqual(handoff({ registry: s.registry, repo: 'nothing-here', text: 'x' }), { ok: false, reason: 'no registered repo matches nothing-here' })
  assert.deepEqual(handoff({ registry: s.registry, repo: 'katipon', text: ' \n\t' }), { ok: false, reason: 'handoff text is empty' })
  assert.deepEqual(snapshotTree(s.vault), before)
})

test('a secret-shaped string in the text is redacted, the repo and change names are not', () => {
  const s = setup({ notes: [CHANGE_NOTE] })
  handoff({ registry: s.registry, repo: 'katipon', change: 'add-login', text: 'Done: used ghp_abc123 for add-login' })
  const text = read(s, CHANGE_NOTE.path)
  assert.ok(!text.includes('ghp_abc123'))
  assert.match(text, /Done: used \[redacted\] for add-login/)
})

test('a write outside the registered vault is refused by the boundary', () => {
  const s = setup()
  const other = makeVault(join(s.root, 'work'))
  const registry = { ...s.registry, vaults: { ...s.registry.vaults, work: other }, roots: { [join(s.root, 'code')]: 'work' } }
  const r = handoff({ registry, repo: 'katipon', text: 'x' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /which belongs to vault work; refusing to write into vault personal$/)
  assert.deepEqual(snapshotTree(s.vault), {})
})

// --- the command ------------------------------------------------------------------

test('handoff prints the wikilink and one newline; --json carries note, wikilink, heading and nextAdded', async () => {
  const s = setup({ notes: [CHANGE_NOTE] })
  const r = await runCli(['handoff', 'katipon', 'add-login', '--text', 'x'], s.env)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, '[[katipon--add-login]]\n')
  assert.equal(r.stderr, '')
  const js = await runCli(['handoff', 'katipon', 'add-login', '--text', 'x', '--next', 'y', '--json'], s.env)
  const parsed = JSON.parse(js.stdout)
  assert.equal(js.stdout, JSON.stringify(parsed, null, 2) + '\n')
  assert.equal(parsed.note, 'Changes/katipon--add-login.md')
  assert.equal(parsed.wikilink, '[[katipon--add-login]]')
  assert.match(parsed.heading, /^### /)
  assert.equal(parsed.nextAdded, 1)
})

test('every --next is kept in order, in the space and the equals form', async () => {
  const s = setup({ notes: [CHANGE_NOTE] })
  const r = await runCli(['handoff', 'katipon', 'add-login', '--text', 'Done: plan written', '--next', 'run the plan', '--next=open the PR'], s.env)
  assert.equal(r.code, 0, r.stderr)
  const lines = section(read(s, CHANGE_NOTE.path), 'Next').split('\n').filter(Boolean)
  assert.deepEqual(lines.slice(-2), ['- [ ] run the plan', '- [ ] open the PR'])
})

test('without --next the Next section of the repo note is byte-identical', async () => {
  const s = setup({ notes: [{ path: 'Projects/katipon.md', frontmatter: 'repo: katipon', body: '\n## Next\n\n- [ ] keep me\n\n## Narrative\n\n' }] })
  const before = section(read(s, 'Projects/katipon.md'), 'Next')
  const r = await runCli(['handoff', 'katipon', '--text', 'Done: plan written'], s.env)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(section(read(s, 'Projects/katipon.md'), 'Next'), before)
})

test('--next without a value is refused and no note changes', async () => {
  const s = setup({ notes: [CHANGE_NOTE] })
  const before = snapshotTree(s.vault)
  const r = await runCli(['handoff', 'katipon', '--text', 'Done: x', '--next'], s.env)
  assert.equal(r.code, 1)
  assert.equal(r.stderr, 'dial: --next needs a value\n')
  assert.deepEqual(snapshotTree(s.vault), before)
})

test('the body comes from stdin under --stdin, five lines in order', async () => {
  const s = setup({ notes: [CHANGE_NOTE] })
  const body = 'Done: a\nDecided: b\nNext: c\nBlocked: none\nOpen: none\n'
  const r = await runWithInput(['handoff', 'katipon', 'add-login', '--stdin'], { ...s.env, DIAL_NOW: '2026-11-10T14:05:00Z' }, body)
  assert.equal(r.code, 0, r.stderr)
  assert.ok(section(read(s, CHANGE_NOTE.path), 'Narrative').startsWith(`\n### 2026-11-10 14:05 · dial handoff\n${body}\n`))
})

test('neither, both, an empty body and an unknown repo are refused with nothing written', async () => {
  const s = setup({ notes: [CHANGE_NOTE] })
  const before = snapshotTree(s.vault)
  const neither = await runCli(['handoff', 'katipon', 'add-login'], s.env)
  assert.equal(neither.code, 1)
  assert.equal(neither.stderr, 'dial: handoff needs exactly one of --stdin or --text\n')
  const both = await runWithInput(['handoff', 'katipon', '--stdin', '--text', 'x'], s.env, 'y')
  assert.equal(both.code, 1)
  assert.equal(both.stderr, 'dial: handoff needs exactly one of --stdin or --text\n')
  const empty = await runWithInput(['handoff', 'katipon', '--stdin'], s.env, '  \n\t\n')
  assert.equal(empty.code, 1)
  assert.equal(empty.stderr, 'dial: handoff text is empty\n')
  const unknown = await runCli(['handoff', 'nothing-here', '--text', 'x'], s.env)
  assert.equal(unknown.code, 1)
  assert.equal(unknown.stderr, 'dial: no registered repo matches nothing-here\n')
  const typo = await runCli(['handoff', 'katipon', 'add-logn', '--text', 'x'], s.env)
  assert.equal(typo.code, 1)
  assert.equal(typo.stderr, 'dial: katipon has no change add-logn\n')
  assert.deepEqual(snapshotTree(s.vault), before)
})

test('local time follows TZ: Asia/Manila puts 06:05Z at 14:05 on the same date', async () => {
  const s = setup({ notes: [CHANGE_NOTE] })
  const r = await runCli(['handoff', 'katipon', 'add-login', '--text', 'x'], { ...s.env, TZ: 'Asia/Manila', DIAL_NOW: '2026-11-10T06:05:00Z' })
  assert.equal(r.code, 0, r.stderr)
  assert.ok(section(read(s, CHANGE_NOTE.path), 'Narrative').startsWith('\n### 2026-11-10 14:05 · dial handoff\n'))
  assert.ok(existsSync(join(s.vault, 'Daily', '2026-11-10.md')))
})

test('handoff never creates the Dial home', async () => {
  const s = setup({ notes: [CHANGE_NOTE] })
  const home = join(tmp(), 'home')
  mkdirSync(home)
  writeFileSync(join(home, 'registry.json'), JSON.stringify(s.registry))
  const before = snapshotTree(home)
  const r = await runCli(['handoff', 'katipon', '--text', 'x'], { ...s.env, DIAL_HOME: home })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(snapshotTree(home), before)
})
