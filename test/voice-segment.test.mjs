import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SENTENCE_CHARS, createSegmenter, speakable } from '../lib/voice/segment.mjs'

/** Feed the pieces in order, then flush: everything the segmenter emits. */
function cut(pieces) {
  const seg = createSegmenter()
  const out = []
  for (const piece of pieces) out.push(...seg.push(piece))
  out.push(...seg.flush())
  return out
}

const collapse = text => text.replace(/\s+/g, ' ').trim()

// voice: "A reply is cut into sentences as it arrives".
test('two sentences in one piece of text are cut and the turn end flushes the last', () => {
  assert.deepEqual(cut(['You have two open pull requests. Number 41 can merge.']), [
    'You have two open pull requests.',
    'Number 41 can merge.'
  ])
})

test('a sentence is emitted before the reply is complete, the unfinished tail waits', () => {
  const seg = createSegmenter()
  assert.deepEqual(seg.push('Number 41 can merge. Number 38'), ['Number 41 can merge.'])
  assert.deepEqual(seg.flush(), ['Number 38'])
})

test('a full stop inside a number does not end a sentence, across two pieces', () => {
  const seg = createSegmenter()
  assert.deepEqual(seg.push('Dial is at 0.'), [])
  assert.deepEqual(seg.push('2.0 today. Done.'), ['Dial is at 0.2.0 today.'])
  assert.deepEqual(seg.flush(), ['Done.'])
})

test('closing marks stay with their sentence', () => {
  assert.deepEqual(cut(['It says "wait." Then (maybe?) it merges.']), ['It says "wait."', 'Then (maybe?) it merges.'])
})

test('each closing mark stays with the sentence it closes', () => {
  for (const mark of ['"', "'", ')', ']', '”', '’']) {
    assert.deepEqual(cut([`Okay.${mark} Next.`]), [`Okay.${mark}`, 'Next.'], mark)
    const seg = createSegmenter()
    assert.deepEqual(seg.push(`Okay.${mark}`), [], `${mark} at the end of the buffer waits`)
    assert.deepEqual(seg.push(' Next.'), [`Okay.${mark}`], mark)
  }
})

test('line breaks and blank lines end a sentence', () => {
  assert.deepEqual(cut(['First line\n\nSecond line']), ['First line', 'Second line'])
  const seg = createSegmenter()
  assert.deepEqual(seg.push('First line\nSecond'), ['First line'])
  assert.deepEqual(seg.flush(), ['Second'])
})

test('a list number stays with its line', () => {
  assert.deepEqual(cut(['1. review and merge\n2. archive the change']), ['1. review and merge', '2. archive the change'])
})

test('several marks end one sentence', () => {
  assert.deepEqual(cut(['Really?! Yes... it merged.']), ['Really?!', 'Yes...', 'it merged.'])
})

test('the end of a text block flushes what waits, before anything that follows', () => {
  const seg = createSegmenter()
  assert.deepEqual(seg.push('Let me check'), [])
  assert.deepEqual(seg.flush(), ['Let me check'])
  assert.deepEqual(seg.flush(), [])
})

test('a terminator at the end of the buffer waits for what follows', () => {
  const seg = createSegmenter()
  assert.deepEqual(seg.push('Done.'), [])
  assert.deepEqual(seg.push(' '), ['Done.'])
  const other = createSegmenter()
  assert.deepEqual(other.push('Done.'), [])
  assert.deepEqual(other.flush(), ['Done.'])
})

test('flush on an empty segmenter gives nothing, and blank text is never a sentence', () => {
  assert.deepEqual(createSegmenter().flush(), [])
  const seg = createSegmenter()
  assert.deepEqual(seg.push('  \n\n \n'), [])
  assert.deepEqual(seg.flush(), [])
})

test('reset discards what waits and the segmenter is usable afterwards', () => {
  const seg = createSegmenter()
  assert.deepEqual(seg.push('Half a sentence'), [])
  seg.reset()
  assert.deepEqual(seg.flush(), [])
  assert.deepEqual(seg.push('Fresh start. '), ['Fresh start.'])
})

// "Nothing is lost or reordered": the same sentences however the text is split.
const TABLE = [
  ['You have two open pull requests. Number 41 can merge.', ['You have two open pull requests.', 'Number 41 can merge.']],
  ['Dial is at 0.2.0 today. Done.', ['Dial is at 0.2.0 today.', 'Done.']],
  ['It says "wait." Then (maybe?) it merges.', ['It says "wait."', 'Then (maybe?) it merges.']],
  ['First line\n\nSecond line', ['First line', 'Second line']],
  ['1. review and merge\n2. archive the change', ['1. review and merge', '2. archive the change']],
  ['Really?! Yes... it merged.', ['Really?!', 'Yes...', 'it merged.']],
  ["He said 'stop.' Then he left.", ["He said 'stop.'", 'Then he left.']],
  ['See the list [done.] Then go on.', ['See the list [done.]', 'Then go on.']],
  ['She said “fine.” Then ‘ok.’ Next.', ['She said “fine.”', 'Then ‘ok.’', 'Next.']],
  ['No end to this one', ['No end to this one']],
  ['  Padded text.   Second one.  ', ['Padded text.', 'Second one.']]
]

for (const [reply, expected] of TABLE) {
  test(`the same sentences whole, one character at a time and split at every position: ${JSON.stringify(reply)}`, () => {
    assert.deepEqual(cut([reply]), expected, 'whole')
    assert.deepEqual(cut([...reply]), expected, 'one character at a time')
    for (let i = 0; i <= reply.length; i++) {
      assert.deepEqual(cut([reply.slice(0, i), reply.slice(i)]), expected, `split at ${i}`)
    }
    assert.equal(expected.join(' '), collapse(reply), 'joined with spaces it is the reply with whitespace collapsed')
    for (const sentence of expected) assert.equal(sentence, sentence.trim())
  })
}

// voice: "A long run without a sentence end is cut at 300 characters".
test('the cut length is 300', () => {
  assert.equal(MAX_SENTENCE_CHARS, 300)
})

test('a long run without a boundary is cut on spaces, none over 300, no word split', () => {
  const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
  let text = ''
  for (let i = 0; text.length < 700; i++) text += (i ? ' ' : '') + words[i % words.length]
  text = text.slice(0, 700).replace(/\s\S*$/, '')
  const seg = createSegmenter()
  const early = seg.push(text)
  assert.ok(early.length >= 2, 'sentences are emitted without waiting for more text')
  const all = [...early, ...seg.flush()]
  for (const sentence of all) {
    assert.ok(sentence.length <= MAX_SENTENCE_CHARS, `at most 300: ${sentence.length}`)
    assert.equal(sentence, sentence.trim())
    for (const word of sentence.split(' ')) assert.ok(words.includes(word), `no word split: ${word}`)
  }
  assert.equal(all.join(' '), text)
})

test('one unbroken token is cut at 300 characters at once and the rest waits', () => {
  const seg = createSegmenter()
  const early = seg.push('x'.repeat(650))
  assert.deepEqual(early, ['x'.repeat(300), 'x'.repeat(300)])
  assert.deepEqual(seg.flush(), ['x'.repeat(50)])
})

test('a hard cut never splits a surrogate pair', () => {
  const seg = createSegmenter()
  const text = 'x'.repeat(299) + '\u{1F600}' + 'y'.repeat(10)
  const early = seg.push(text)
  assert.deepEqual(early, ['x'.repeat(299)])
  const all = [...early, ...seg.flush()]
  assert.deepEqual(all, ['x'.repeat(299), '\u{1F600}' + 'y'.repeat(10)])
  for (const sentence of all) assert.ok(sentence.isWellFormed(), sentence)
})

test('a long run is cut however it arrives, and nothing is lost', () => {
  const text = Array.from({ length: 90 }, (_, i) => `word${i}`).join(' ')
  for (const pieces of [[text], [...text]]) {
    const all = cut(pieces)
    assert.ok(all.every(s => s.length <= MAX_SENTENCE_CHARS))
    assert.equal(all.join(' '), text)
  }
})

// voice: "A sentence is shown as written and spoken in a plain form".
test('emphasis and code marks are dropped and an underscore becomes a space', () => {
  assert.equal(speakable('**Number 41** is `ready`, needs_me is false.'), 'Number 41 is ready, needs me is false.')
})

test('a link is replaced by its label and a bare address by the word link', () => {
  assert.equal(speakable('See [the pull request](https://github.com/x/y/pull/41) or https://example.com/a.'), 'See the pull request or link')
  assert.equal(speakable('https://example.com/a'), 'link')
  assert.equal(speakable('http://example.com'), 'link')
})

test('a leading heading, quote, bullet or number mark is dropped with its space', () => {
  const cases = {
    '# Heading': 'Heading',
    '## Heading': 'Heading',
    '> quote': 'quote',
    '- review and merge': 'review and merge',
    '+ item': 'item',
    '2. archive the change': 'archive the change',
    '10. item': 'item'
  }
  for (const [input, spoken] of Object.entries(cases)) assert.equal(speakable(input), spoken, input)
})

test('underline and strike-through marks are dropped and whitespace is collapsed', () => {
  assert.equal(speakable('__bold__'), 'bold')
  assert.equal(speakable('~~gone~~'), 'gone')
  assert.equal(speakable('a   b\t c'), 'a b c')
})

test('a sentence with no letter and no digit has no spoken form', () => {
  for (const input of ['---', '```', "''", '']) assert.equal(speakable(input), '', JSON.stringify(input))
})
