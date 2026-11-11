// Red wave for the note-parsing half of specs/note-rendering/spec.md. Written
// before lib/note.mjs exists: `node --test test/note.test.mjs` fails on the import.
//
// Contract these tests pin (design.md §Notes):
//   splitNote(text)            -> { frontmatter, sections: [{ heading, body }] }
//                                 heading is the text after `## ` on the heading line; body is the exact
//                                 text after that line up to the next `## ` line, so joinNote is lossless
//   joinNote(parts)            -> text, byte-identical to what splitNote read
//   writeFrontmatter(obj)      -> '---\nkey: value\n---\n' in insertion order, one quoting rule
//   nextItems(section)         -> [{ checked, text }]
//   narrativeEntries(section)  -> [{ heading, at (ISO), source, body }] newest first as written
//   narrativeHeading(at, src)  -> '### YYYY-MM-DD HH:mm · <source>' in local time
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readFrontmatter } from '../lib/frontmatter.mjs'
import { splitNote, joinNote, writeFrontmatter, nextItems, narrativeEntries, narrativeHeading } from '../lib/note.mjs'

const VAULT = new URL('./fixtures/vault/', import.meta.url)
const read = rel => readFileSync(new URL(rel, VAULT), 'utf8')
const CHANGE = read('Changes/katipon--add-login.md')
const STATE_HEADING = 'State  <!-- dial:generated, do not edit -->'

const section = (parts, name) => parts.sections.find(s => s.heading === name)

// --- splitNote / joinNote ----------------------------------------------------

test('splitNote cuts a change note at its ## headings, in order', () => {
  const parts = splitNote(CHANGE)
  assert.deepEqual(parts.sections.map(s => s.heading), ['Next', 'Narrative', 'Scratch', STATE_HEADING])
})

test('a section body is the exact text after its heading line up to the next heading', () => {
  const next = section(splitNote(CHANGE), 'Next')
  assert.equal(next.body, '\n- [ ] Ask Maya about the session timeout\n- [x] Squash the fixup commits\n- [ ] Merge once CI is green\n\n')
})

test('joinNote(splitNote(text)) is byte-identical for a Dial note and a hand-written note', () => {
  assert.equal(joinNote(splitNote(CHANGE)), CHANGE)
  const hand = read('Notes/Login ideas.md')
  assert.equal(joinNote(splitNote(hand)), hand)
})

test('joinNote writes a section edit back and leaves every other byte alone', () => {
  const parts = splitNote(CHANGE)
  section(parts, 'Scratch').body = '\nchanged\n\n'
  const out = joinNote(parts)
  assert.equal(out, CHANGE.replace(/Typed by hand in Obsidian[^\n]*\n/, 'changed\n'))
})

test('a note with no ## heading has no sections and still round-trips', () => {
  const text = '---\ntitle: x\n---\nJust a paragraph.\n'
  assert.deepEqual(splitNote(text).sections, [])
  assert.equal(joinNote(splitNote(text)), text)
})

test('a note with no frontmatter round-trips', () => {
  const text = '## Next\n\n- [ ] a\n'
  assert.equal(joinNote(splitNote(text)), text)
})

test('a ### heading inside a section does not start a new section', () => {
  const parts = splitNote(CHANGE)
  assert.match(section(parts, 'Narrative').body, /### 2026-11-09 22:20 · dial handoff/)
})

// --- writeFrontmatter --------------------------------------------------------

const written = obj => writeFrontmatter(obj)

test('writeFrontmatter wraps flat key: value lines in --- fences in insertion order', () => {
  assert.equal(written({ b: 'one', a: 'two' }), '---\nb: one\na: two\n---\n')
})

test('booleans and integers are bare', () => {
  assert.equal(written({ needs_me: true, stale: false, tasks_done: 9 }), '---\nneeds_me: true\nstale: false\ntasks_done: 9\n---\n')
})

test('flow lists: tags [dial] and empty aliases []', () => {
  assert.equal(written({ tags: ['dial'], aliases: [] }), '---\ntags: [dial]\naliases: []\n---\n')
})

test('a branch with a colon-space is quoted', () => {
  assert.match(written({ branch: 'fix: login' }), /^branch: "fix: login"$/m)
})

test('a hash is quoted', () => {
  assert.match(written({ change: 'fix#12' }), /^change: "fix#12"$/m)
})

test('a URL and a timestamp stay bare', () => {
  const out = written({ pr: 'https://github.com/renzrollon/interlock/pull/38', last_session: '2026-11-09T22:17:00+08:00' })
  assert.match(out, /^pr: https:\/\/github\.com\/renzrollon\/interlock\/pull\/38$/m)
  assert.match(out, /^last_session: 2026-11-09T22:17:00\+08:00$/m)
})

test('a numeric-looking or boolean-looking string is quoted while a real integer is bare', () => {
  const out = written({ branch: '1234', other: 'true', tasks_done: 9 })
  assert.match(out, /^branch: "1234"$/m)
  assert.match(out, /^other: "true"$/m)
  assert.match(out, /^tasks_done: 9$/m)
})

test('a string starting with a YAML indicator is quoted', () => {
  for (const lead of ['- ', '? ', '[', ']', '{', '}', ',', '&', '*', '!', '|', '>', "'", '"', '%', '@', '`']) {
    const out = written({ k: `${lead}x` })
    assert.match(out, /^k: "/m, `value starting with ${lead}`)
  }
})

test('backslash and double quote are escaped inside a quoted string', () => {
  assert.match(written({ k: 'say "hi": now' }), /^k: "say \\"hi\\": now"$/m)
  assert.match(written({ k: 'a\\b: c' }), /^k: "a\\\\b: c"$/m)
})

test('an ordinary string, a path and the word unobserved are bare', () => {
  const out = written({ branch: 'feat/add-login', ci: 'unobserved', last_commit: '3f50683', title: 'katipon — add-login' })
  assert.match(out, /^branch: feat\/add-login$/m)
  assert.match(out, /^ci: unobserved$/m)
  assert.match(out, /^last_commit: 3f50683$/m)
  assert.match(out, /^title: katipon — add-login$/m)
})

test('every value is one line: the flat reader reads back what was written', () => {
  const obj = { title: 'katipon — add-login', branch: 'fix: login', change: 'fix#12', n: 'x', tasks_done: 9 }
  const back = readFrontmatter(written(obj))
  assert.deepEqual(back, { title: 'katipon — add-login', branch: 'fix: login', change: 'fix#12', n: 'x', tasks_done: '9' })
})

// --- nextItems ---------------------------------------------------------------

test('nextItems reads the checkboxes of a ## Next section', () => {
  assert.deepEqual(nextItems(section(splitNote(CHANGE), 'Next')), [
    { checked: false, text: 'Ask Maya about the session timeout' },
    { checked: true, text: 'Squash the fixup commits' },
    { checked: false, text: 'Merge once CI is green' },
  ])
})

test('nextItems accepts an upper-case X and ignores lines that are not checkboxes', () => {
  const sec = { heading: 'Next', body: '\n- [X] Done thing\nplain prose\n- bullet without box\n- [ ] Open thing\n' }
  assert.deepEqual(nextItems(sec), [
    { checked: true, text: 'Done thing' },
    { checked: false, text: 'Open thing' },
  ])
})

test('nextItems of an empty section is an empty list', () => {
  assert.deepEqual(nextItems({ heading: 'Next', body: '\n' }), [])
})

// --- narrative ---------------------------------------------------------------

test('narrativeEntries reads the heading source, the time and the body as written', () => {
  const [entry, ...rest] = narrativeEntries(section(splitNote(CHANGE), 'Narrative'))
  assert.equal(rest.length, 0)
  assert.equal(entry.heading, '### 2026-11-09 22:20 · dial handoff')
  assert.equal(entry.source, 'dial handoff')
  assert.equal(typeof entry.at, 'string')
  assert.ok(!Number.isNaN(Date.parse(entry.at)))
  assert.equal(entry.body.trim(), 'Login form and the magic-link endpoint are in; the PR is open and CI is green.\nLeft: the session timeout question and the squash before merge.')
})

test('narrativeEntries keeps the entries in the order written, newest first', () => {
  const body = '\n### 2026-11-10 09:05 · local model (mtplx-qwen38-27b-optimized-speed)\n\nnewer\n\n### 2026-11-09 22:20 · /dial:handoff (claude)\n\nolder\n'
  const entries = narrativeEntries({ heading: 'Narrative', body })
  assert.deepEqual(entries.map(e => e.source), ['local model (mtplx-qwen38-27b-optimized-speed)', '/dial:handoff (claude)'])
  assert.ok(Date.parse(entries[0].at) > Date.parse(entries[1].at))
  assert.equal(entries[0].body.trim(), 'newer')
})

test('an empty ## Narrative has no entries', () => {
  assert.deepEqual(narrativeEntries({ heading: 'Narrative', body: '\n' }), [])
})

test('the entry heading is ### YYYY-MM-DD HH:mm · <source> for each of the three source labels', () => {
  const at = new Date('2026-11-09T22:20:00Z')
  const tz = process.env.TZ
  process.env.TZ = 'UTC'
  try {
    assert.equal(narrativeHeading(at, 'dial handoff'), '### 2026-11-09 22:20 · dial handoff')
    assert.equal(narrativeHeading(at, '/dial:handoff (claude)'), '### 2026-11-09 22:20 · /dial:handoff (claude)')
    assert.equal(
      narrativeHeading(at, 'local model (mtplx-qwen38-27b-optimized-speed)'),
      '### 2026-11-09 22:20 · local model (mtplx-qwen38-27b-optimized-speed)'
    )
  } finally {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  }
})

test('the entry heading is in local time, and narrativeEntries reads it back in local time', () => {
  const tz = process.env.TZ
  process.env.TZ = 'Asia/Singapore'
  try {
    assert.equal(narrativeHeading(new Date('2026-11-09T14:20:00Z'), 'dial handoff'), '### 2026-11-09 22:20 · dial handoff')
    const [entry] = narrativeEntries({ heading: 'Narrative', body: '\n### 2026-11-09 22:20 · dial handoff\n\nx\n' })
    assert.equal(Date.parse(entry.at), Date.parse('2026-11-09T14:20:00Z'))
  } finally {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  }
})
