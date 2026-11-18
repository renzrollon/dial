/**
 * `lib/capture.mjs` (specs/capture, add-voice-stage-and-capture): the pure cleaning, title, file-name and
 * note-bytes functions, and `capture()` against a temp vault and a registry object. The command through the real
 * binary is in test/cli.test.mjs.
 */
// Local dates and times are read in UTC here, as the harness runs the CLI; the times below are built as local times.
process.env.TZ = 'UTC'

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TITLE_CHARS, capture, cleanText, noteFile, noteTitle, renderCapture } from '../lib/capture.mjs'
import { readFrontmatter } from '../lib/frontmatter.mjs'
import { makeVault, snapshotTree, tmp } from './helpers.mjs'

const TOKEN = 'ghp_0123456789abcdefghijABCDEFGHIJ012345'
const MORNING = new Date(2026, 10, 17, 9, 5, 0)
const EVENING = new Date(2026, 10, 17, 21, 45, 0)
const FILE = 'Inbox/Buy oat milk 2026-11-17 0905.md'

/** A registry object naming the vaults `personal` and `work`, both existing directories. */
function setup(notes = []) {
  const root = tmp('capture-')
  const personal = makeVault(join(root, 'personal'), notes)
  const work = makeVault(join(root, 'work'))
  const registry = { dial_schema: 'dial.registry/1', vaults: { personal, work }, repos: [], limits: {} }
  return { root, personal, work, registry }
}

const run = (s, text, extra = {}) => capture({ registry: s.registry, vault: 'personal', text, now: MORNING, maxChars: 2000, ...extra })

// --- cleanText (capture: "The text is cleaned and redacted before it is written") ---------------------------

test('cleanText makes every line ending a line feed, drops control characters but not tab, and trims the ends', () => {
  // Pins specs/capture/spec.md, "The text is cleaned and redacted before it is written" (scenario "Line endings and control characters").
  assert.equal(cleanText('  first\r\nsecond\u001b[1m\u0000  '), 'first\nsecond[1m')
  assert.equal(cleanText('a\rb'), 'a\nb')
  assert.equal(cleanText('a\r\nb\rc\nd'), 'a\nb\nc\nd')
  assert.equal(cleanText('a\u0007\u0008b'), 'ab')
  assert.equal(cleanText('a\tb'), 'a\tb')
  assert.equal(cleanText('\n\n  keep\n inner\n\n'), 'keep\n inner')
  assert.equal(cleanText('   '), '')
})

// --- noteTitle (capture: "The title is the note's first line, made safe for a file name") -------------------

test('TITLE_CHARS is 60', () => {
  assert.equal(TITLE_CHARS, 60)
})

test('noteTitle is the first line with the characters a file name cannot hold made spaces and runs of space made one', () => {
  // Pins specs/capture/spec.md, "The title is the note's first line, made safe for a file name" (scenario "Characters a file name cannot hold").
  assert.equal(noteTitle('Fix: parser/lexer [urgent]?'), 'Fix parser lexer urgent')
  assert.equal(noteTitle('Buy oat milk'), 'Buy oat milk')
  assert.equal(noteTitle('a\t\t b   c'), 'a b c')
})

test('each of the thirteen forbidden characters is replaced by a space', () => {
  // Pins specs/capture/spec.md, "The title is the note's first line, made safe for a file name": : / \ ? * " < > | # ^ [ ].
  const forbidden = [':', '/', '\\', '?', '*', '"', '<', '>', '|', '#', '^', '[', ']']
  assert.equal(forbidden.length, 13)
  for (const c of forbidden) {
    assert.equal(noteTitle(`a${c}b`), 'a b', JSON.stringify(c))
    assert.equal(noteTitle(`a${c}${c}b`), 'a b', JSON.stringify(c))
  }
})

test('noteTitle drops a leading dot and trailing dots and spaces', () => {
  // Pins specs/capture/spec.md, "The title is the note's first line, made safe for a file name": a leading `.` and trailing `.` and spaces dropped.
  assert.equal(noteTitle('.hidden'), 'hidden')
  assert.equal(noteTitle('end. . '), 'end')
  assert.equal(noteTitle('trailing...'), 'trailing')
})

test('noteTitle is Note when nothing is left', () => {
  // Pins specs/capture/spec.md, "The title is the note's first line, made safe for a file name" (scenario "Nothing left").
  for (const text of ['...', '###', '[[ ]]', '', '   ']) assert.equal(noteTitle(text), 'Note', JSON.stringify(text))
})

test('noteTitle skips blank lines to the first line that is not blank', () => {
  // Pins specs/capture/spec.md, "The title is the note's first line, made safe for a file name" (scenario "A blank first line").
  assert.equal(noteTitle('\nSecond line'), 'Second line')
  assert.equal(noteTitle('  \n\t\nSecond line\nThird'), 'Second line')
})

test('a title of exactly 60 characters is kept whole', () => {
  // Pins specs/capture/spec.md, "The title is the note's first line, made safe for a file name": cut to 60 characters.
  const line = `${'abcd '.repeat(11)}abcde`
  assert.equal(line.length, 60)
  assert.equal(noteTitle(line), line)
})

test('a long first line is cut at the end of a word', () => {
  // Pins specs/capture/spec.md, "The title is the note's first line, made safe for a file name" (scenario "A long first line").
  const line = `${'abcdefg '.repeat(11)}ab`
  assert.equal(line.length, 90)
  const title = noteTitle(line)
  assert.ok(title.length <= 60, title)
  assert.ok(line.startsWith(title), title)
  assert.equal(line[title.length], ' ', 'the cut falls at a space')
  assert.equal(title, 'abcdefg abcdefg abcdefg abcdefg abcdefg abcdefg abcdefg')
})

test('one unbroken run is cut at the sixtieth character', () => {
  // Pins specs/capture/spec.md, "The title is the note's first line, made safe for a file name" (scenario "One unbroken run").
  assert.equal(noteTitle('a'.repeat(80)), 'a'.repeat(60))
})

test('a cut never leaves half of a surrogate pair', () => {
  // Pins specs/capture/spec.md, "The title is the note's first line, made safe for a file name" (scenario "An emoji at the cut").
  const line = `${'a'.repeat(59)}\u{1F600}bbb`
  assert.equal(line.charCodeAt(59) >= 0xd800 && line.charCodeAt(59) <= 0xdbff, true)
  assert.equal(line.charCodeAt(60) >= 0xdc00 && line.charCodeAt(60) <= 0xdfff, true)
  const title = noteTitle(line)
  assert.ok(title.length <= 60, title)
  assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(title), false, 'no lone half of a pair')
  assert.ok(line.startsWith(title))
  assert.equal(title, 'a'.repeat(59))
})

// --- noteFile ----------------------------------------------------------------------------------------------

test('noteFile is Inbox/<title> <date> <HHmm>.md in local time, 24-hour, with no colon', () => {
  // Pins specs/capture/spec.md, "capture writes one new note into a vault's Inbox" (file name `Inbox/<title> <YYYY-MM-DD HHmm>.md`).
  assert.equal(noteFile('Buy oat milk', MORNING), 'Inbox/Buy oat milk 2026-11-17 0905.md')
  assert.equal(noteFile('Buy oat milk', EVENING), 'Inbox/Buy oat milk 2026-11-17 2145.md')
  assert.equal(noteFile('Note', new Date(2026, 0, 2, 0, 0, 0)), 'Inbox/Note 2026-01-02 0000.md')
})

// --- renderCapture -----------------------------------------------------------------------------------------

test('renderCapture writes the frontmatter in order, a blank line, the text and one line feed', () => {
  // Pins specs/capture/spec.md, "A captured note holds frontmatter and the text" (scenario "The bytes of a note").
  const bytes = renderCapture({ title: 'Buy oat milk', text: 'Buy oat milk', created: '2026-11-17' })
  assert.equal(
    bytes,
    [
      '---', 'title: Buy oat milk', 'created: 2026-11-17', 'type: note', 'status: inbox', 'tags: [capture]',
      'dial_schema: dial.capture/1', '---', '', 'Buy oat milk', '',
    ].join('\n'),
  )
  assert.ok(bytes.endsWith('milk\n') && !bytes.endsWith('\n\n'))
})

test('renderCapture quotes a title YAML would misread and the frontmatter reads it back as that string', () => {
  // Pins specs/capture/spec.md, "A captured note holds frontmatter and the text" (scenario "A title YAML would misread").
  for (const text of ['no', '2026', '- call Ana']) {
    const bytes = renderCapture({ title: noteTitle(text), text, created: '2026-11-17' })
    assert.ok(bytes.includes(`title: "${text}"\n`), `${text}: ${bytes}`)
    const fm = readFrontmatter(bytes)
    assert.equal(fm.title, text)
    assert.equal(fm.status, 'inbox')
  }
})

test('text that looks like frontmatter stays in the body and the note keeps its own frontmatter', () => {
  // Pins specs/capture/spec.md, "A captured note holds frontmatter and the text" (scenario "Text that looks like frontmatter").
  const text = '---\nstatus: done\n---'
  const bytes = renderCapture({ title: noteTitle(text), text, created: '2026-11-17' })
  const fm = readFrontmatter(bytes)
  assert.equal(fm.status, 'inbox')
  assert.equal(fm.type, 'note')
  assert.equal(fm.dial_schema, 'dial.capture/1')
  assert.ok(bytes.endsWith('dial_schema: dial.capture/1\n---\n' + '\n' + text + '\n'), bytes)
})

// --- capture(): the write ----------------------------------------------------------------------------------

test('capture writes one new note into Inbox of the named vault and returns what it wrote', () => {
  // Pins specs/capture/spec.md, "capture writes one new note into a vault's Inbox" (scenarios "A note from --text" and "A vault without an Inbox").
  const s = setup()
  assert.equal(existsSync(join(s.personal, 'Inbox')), false)
  const result = run(s, 'Buy oat milk')
  const path = join(s.personal, FILE)
  assert.deepEqual(result, {
    ok: true, vault: 'personal', path, note: FILE, wikilink: '[[Buy oat milk 2026-11-17 0905]]', title: 'Buy oat milk',
    text: 'Buy oat milk', written: true,
  })
  assert.equal(readFileSync(path, 'utf8'), renderCapture({ title: 'Buy oat milk', text: 'Buy oat milk', created: '2026-11-17' }))
  assert.deepEqual(readdirSync(join(s.personal, 'Inbox')), ['Buy oat milk 2026-11-17 0905.md'])
  assert.deepEqual(readdirSync(s.work), [], 'no other vault is touched')
})

test('capture writes the cleaned text, with line endings and control characters handled before the title is cut', () => {
  // Pins specs/capture/spec.md, "The text is cleaned and redacted before it is written" (scenario "Line endings and control characters").
  const s = setup()
  const result = run(s, '  first\r\nsecond\u001b[1m\u0000  ')
  assert.equal(result.ok, true)
  assert.equal(result.text, 'first\nsecond[1m')
  assert.equal(result.title, 'first')
  assert.ok(readFileSync(result.path, 'utf8').endsWith('---\n\nfirst\nsecond[1m\n'))
})

test('capture redacts a token in the text and returns the redacted text', () => {
  // Pins specs/capture/spec.md, "The text is cleaned and redacted before it is written" (scenario "A token in the text") and
  // "capture prints what it wrote as JSON on request" (scenario "The text is what was written").
  const s = setup()
  const result = run(s, `rotate the key ${TOKEN} today`)
  assert.equal(result.ok, true)
  assert.equal(result.text, 'rotate the key [redacted] today')
  const bytes = readFileSync(result.path, 'utf8')
  assert.ok(bytes.endsWith('\n\nrotate the key [redacted] today\n'), bytes)
  assert.equal(bytes.includes(TOKEN), false)
})

test('a secret on the first line reaches neither the file name, the title nor the text', () => {
  // Pins specs/capture/spec.md, "The text is cleaned and redacted before it is written" (scenario "A secret never reaches the file name").
  const s = setup()
  const result = run(s, `export GITHUB_TOKEN=${TOKEN}`)
  assert.equal(result.ok, true)
  for (const field of [result.path, result.note, result.wikilink, result.title, result.text, readFileSync(result.path, 'utf8')]) {
    assert.equal(field.includes(TOKEN), false, field)
    assert.equal(field.includes('ghp_0123'), false, field)
  }
  assert.deepEqual(readdirSync(join(s.personal, 'Inbox')).filter(n => n.includes('ghp_')), [])
})

test('the length is counted on the cleaned text before redaction, and a text of exactly the cap is written', () => {
  // Pins specs/capture/spec.md, "capture refuses what it cannot write" (scenario "Text that is too long").
  const s = setup()
  const text = `rotate the key ${TOKEN} today`
  const refused = run(s, text, { maxChars: text.length - 1 })
  assert.deepEqual(refused, { ok: false, reason: `note longer than ${text.length - 1} characters` })
  const exact = run(s, 'a'.repeat(2000))
  assert.equal(exact.ok, true)
  assert.equal(exact.text.length, 2000)
  const over = run(s, 'b'.repeat(2001))
  assert.deepEqual(over, { ok: false, reason: 'note longer than 2000 characters' })
  assert.equal(readdirSync(join(s.personal, 'Inbox')).some(n => n.startsWith('bbb')), false)
})

// --- capture(): the refusals, in order ---------------------------------------------------------------------

test('capture refuses empty text and writes nothing', () => {
  // Pins specs/capture/spec.md, "capture refuses what it cannot write" (scenario "Empty text").
  const s = setup()
  for (const text of ['', '   ', '\r\n\t \u0000\n']) {
    assert.deepEqual(run(s, text), { ok: false, reason: 'capture text is empty' }, JSON.stringify(text))
  }
  assert.equal(existsSync(join(s.personal, 'Inbox')), false)
})

test('capture refuses a vault the registry does not name and lists the known ones', () => {
  // Pins specs/capture/spec.md, "capture refuses what it cannot write" (scenario "A vault the registry does not name").
  const s = setup()
  assert.deepEqual(run(s, 'x', { vault: 'nowhere' }), { ok: false, reason: 'no vault named nowhere in the registry; vaults: personal, work' })
  const none = { ...s.registry, vaults: {} }
  assert.deepEqual(capture({ registry: none, vault: 'nowhere', text: 'x', now: MORNING, maxChars: 2000 }), { ok: false, reason: 'no vault named nowhere in the registry' })
})

test('capture refuses a vault whose directory is gone and does not create it', () => {
  // Pins specs/capture/spec.md, "capture refuses what it cannot write" (scenario "A vault whose directory is gone").
  const s = setup()
  const gone = join(s.root, 'gone')
  const registry = { ...s.registry, vaults: { ...s.registry.vaults, personal: gone } }
  const result = capture({ registry, vault: 'personal', text: 'x', now: MORNING, maxChars: 2000 })
  assert.deepEqual(result, { ok: false, reason: `vault personal does not exist: ${gone}` })
  assert.equal(existsSync(gone), false)
})

test('when two refusals apply, the first in the order of the spec is given', () => {
  // Pins specs/capture/spec.md, "capture refuses what it cannot write": checked in the order empty text, length, vault name, vault directory, note name.
  const s = setup()
  assert.equal(run(s, '  ', { vault: 'nowhere' }).reason, 'capture text is empty')
  assert.equal(run(s, 'a'.repeat(11), { vault: 'nowhere', maxChars: 10 }).reason, 'note longer than 10 characters')
  assert.equal(run(s, 'x', { vault: 'nowhere' }).reason, 'no vault named nowhere in the registry; vaults: personal, work')
  const gone = join(s.root, 'gone')
  const registry = { ...s.registry, vaults: { ...s.registry.vaults, personal: gone } }
  assert.equal(capture({ registry, vault: 'personal', text: 'a'.repeat(11), now: MORNING, maxChars: 10 }).reason, 'note longer than 10 characters')
})

// --- capture(): never overwrites, appends or deletes ---------------------------------------------------------

test('a second capture of the same words in the same minute is refused and the first note keeps its bytes', () => {
  // Pins specs/capture/spec.md, "capture never overwrites, appends or deletes" (scenario "The same words in the same minute").
  const s = setup()
  const first = run(s, 'Buy oat milk')
  assert.equal(first.ok, true)
  const before = readFileSync(first.path, 'utf8')
  const second = run(s, 'Buy oat milk')
  assert.deepEqual(second, { ok: false, reason: `${FILE} already exists in vault personal` })
  assert.equal(readFileSync(first.path, 'utf8'), before)
  assert.deepEqual(readdirSync(join(s.personal, 'Inbox')), ['Buy oat milk 2026-11-17 0905.md'])
})

test('a note that appears during the write is kept, the capture is refused and no temporary file remains', () => {
  // Pins specs/capture/spec.md, "capture never overwrites, appends or deletes" (scenario "A note that appears during the write").
  const s = setup()
  const path = join(s.personal, FILE)
  let landed = 0
  const result = run(s, 'Buy oat milk', {
    beforeRename: target => {
      landed += 1
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, 'theirs\n')
    },
  })
  assert.ok(landed >= 1, 'the write reached the point before the rename')
  assert.deepEqual(result, { ok: false, reason: `${FILE} already exists in vault personal` })
  assert.equal(readFileSync(path, 'utf8'), 'theirs\n')
  assert.deepEqual(readdirSync(join(s.personal, 'Inbox')).filter(n => n.endsWith('.tmp')), [])
  assert.deepEqual(readdirSync(join(s.personal, 'Inbox')), ['Buy oat milk 2026-11-17 0905.md'])
})

test('a capture adds exactly one file to a vault that holds other notes and changes none of them', () => {
  // Pins specs/capture/spec.md, "capture never overwrites, appends or deletes" (scenario "Nothing else changes").
  const s = setup([
    { path: 'Projects/katipon.md', frontmatter: { type: 'project' }, body: 'p\n' },
    { path: 'Changes/katipon--add-login.md', frontmatter: { type: 'change' }, body: 'c\n' },
    { path: 'Daily/2026-11-17.md', frontmatter: { type: 'daily' }, body: '## Log\n\n- one\n' },
    { path: 'Inbox/Older 2026-11-10 0800.md', body: 'older\n' },
    { path: '.obsidian/app.json', body: '{}\n' },
  ])
  const before = snapshotTree(s.personal)
  const work = snapshotTree(s.work)
  const result = run(s, 'Buy oat milk')
  assert.equal(result.ok, true)
  const after = snapshotTree(s.personal)
  assert.deepEqual(Object.keys(after).filter(k => !(k in before)), [FILE])
  for (const [k, v] of Object.entries(before)) assert.equal(after[k], v, k)
  assert.deepEqual(Object.keys(after).filter(k => k.startsWith('Daily/') || k.startsWith('.obsidian/')), Object.keys(before).filter(k => k.startsWith('Daily/') || k.startsWith('.obsidian/')))
  assert.deepEqual(snapshotTree(s.work), work)
})

test('an Inbox that is a symbolic link out of the vault is refused and nothing is written there', () => {
  // Pins specs/capture/spec.md, "capture never overwrites, appends or deletes" (scenario "An Inbox that leads out of the vault").
  const s = setup()
  const outside = tmp('capture-outside-')
  symlinkSync(outside, join(s.personal, 'Inbox'))
  const result = run(s, 'Buy oat milk')
  assert.equal(result.ok, false)
  assert.match(result.reason, /^refusing to write into /)
  assert.deepEqual(readdirSync(outside), [])
})

// --- capture(): the dry run ----------------------------------------------------------------------------------

test('a dry run returns the plan with written false and writes nothing, not even Inbox', () => {
  // Pins specs/capture/spec.md, "A dry run prints the plan and writes nothing" (scenario "A planned note").
  const s = setup()
  const before = snapshotTree(s.personal)
  const result = run(s, 'Buy oat milk', { dryRun: true })
  assert.deepEqual(result, {
    ok: true, vault: 'personal', path: join(s.personal, FILE), note: FILE, wikilink: '[[Buy oat milk 2026-11-17 0905]]',
    title: 'Buy oat milk', text: 'Buy oat milk', written: false,
  })
  assert.equal(existsSync(join(s.personal, 'Inbox')), false)
  assert.deepEqual(snapshotTree(s.personal), before)
})

test('a dry run of a note that exists is refused as without it, and every other refusal applies', () => {
  // Pins specs/capture/spec.md, "A dry run prints the plan and writes nothing" (scenario "A dry run of a name that exists").
  const s = setup()
  assert.equal(run(s, 'Buy oat milk').ok, true)
  assert.deepEqual(run(s, 'Buy oat milk', { dryRun: true }), { ok: false, reason: `${FILE} already exists in vault personal` })
  assert.equal(run(s, '  ', { dryRun: true }).reason, 'capture text is empty')
  assert.equal(run(s, 'x', { dryRun: true, vault: 'nowhere' }).reason, 'no vault named nowhere in the registry; vaults: personal, work')
})

test('a capture in the evening is named with the 24-hour time', () => {
  // Pins specs/capture/spec.md, "capture writes one new note into a vault's Inbox" (file name `<YYYY-MM-DD HHmm>`, local time).
  const s = setup()
  const result = run(s, 'Buy oat milk', { now: EVENING })
  assert.equal(result.note, 'Inbox/Buy oat milk 2026-11-17 2145.md')
  assert.equal(result.wikilink, '[[Buy oat milk 2026-11-17 2145]]')
  assert.equal(readFrontmatter(readFileSync(result.path, 'utf8')).created, '2026-11-17')
})
