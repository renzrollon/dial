import test from 'node:test'
import assert from 'node:assert/strict'
import { readFrontmatter } from '../lib/frontmatter.mjs'

test('flat key: value pairs between the --- fences are returned as strings', () => {
  const text = '---\ndial_schema: dial.change/1\nrepo: katipon\nstatus: open\n---\n# Body\n'
  assert.deepEqual(readFrontmatter(text), { dial_schema: 'dial.change/1', repo: 'katipon', status: 'open' })
})

test('one pair of surrounding quotes is stripped, double or single', () => {
  const text = `---\ntitle: "Hello world"\nname: 'katipon'\nplain: x\n---\n`
  assert.deepEqual(readFrontmatter(text), { title: 'Hello world', name: 'katipon', plain: 'x' })
})

test('only one pair of quotes is stripped and inner quotes survive', () => {
  assert.deepEqual(readFrontmatter(`---\nk: "'x'"\n---\n`), { k: "'x'" })
})

test('values are trimmed and may contain colons', () => {
  const text = '---\nrepo:    katipon   \nurl: https://example.com/a\n---\n'
  assert.deepEqual(readFrontmatter(text), { repo: 'katipon', url: 'https://example.com/a' })
})

test('text with no frontmatter returns null', () => {
  assert.equal(readFrontmatter('# Just a note\n'), null)
  assert.equal(readFrontmatter(''), null)
  assert.equal(readFrontmatter('some text\n---\nrepo: x\n---\n'), null)
})

test('an empty frontmatter block is an empty object, not null', () => {
  assert.deepEqual(readFrontmatter('---\n---\nbody\n'), {})
})

test('keys after the closing fence are not read', () => {
  assert.deepEqual(readFrontmatter('---\na: 1\n---\nb: 2\n'), { a: '1' })
})

test('nested YAML is ignored: indented children and list items are not keys', () => {
  const text = '---\nrepo: katipon\nmeta:\n  child: nope\n  other: nope\ntags:\n  - one\n  - two\ndial_schema: dial.change/1\n---\n'
  const out = readFrontmatter(text)
  assert.equal(out.repo, 'katipon')
  assert.equal(out.dial_schema, 'dial.change/1')
  assert.ok(!('child' in out))
  assert.ok(!('other' in out))
  assert.ok(!('- one' in out))
})
