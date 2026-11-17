import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SESSION_NAME_CHARS, SESSION_PREFIX, checkPrompt, checkProposal, formatProposal, sessionName } from '../lib/propose.mjs'

// The pure core of `dial propose` and of the session name (voice-sessions delta). lib/propose.mjs does not exist
// yet: every case here fails until task 2.3 adds it.

const MAX = 2000
const prompt = text => checkPrompt(text, { maxChars: MAX })
const registry = {
  dial_schema: 'dial.registry/1',
  vaults: { work: '/vaults/work' },
  repos: [
    { path: '/repos/katipon', vault: 'work', host: 'github' },
    { path: '/repos/dial', vault: 'work', host: 'github' }
  ],
  limits: {}
}

test('the constants are the prefix and the cut the delta gives', () => {
  assert.equal(SESSION_PREFIX, 'dial: ')
  assert.equal(SESSION_NAME_CHARS, 60)
})

// voice-sessions: "propose refuses what cannot become a session".
test('checkPrompt: the result is the trimmed prompt', () => {
  assert.deepEqual(prompt('  /interlock:ship add-parser  '), { ok: true, prompt: '/interlock:ship add-parser' })
})

test('checkPrompt: an empty or blank prompt is refused as empty', () => {
  for (const text of ['', '   ', '\n\t ']) assert.deepEqual(prompt(text), { ok: false, reason: 'prompt is empty' }, JSON.stringify(text))
})

test('checkPrompt: a prompt of exactly maxChars is accepted and one more is refused', () => {
  assert.equal(prompt('a'.repeat(MAX)).ok, true)
  assert.deepEqual(prompt('a'.repeat(MAX + 1)), { ok: false, reason: 'prompt longer than 2000 characters' })
  assert.deepEqual(checkPrompt('a'.repeat(31), { maxChars: 30 }), { ok: false, reason: 'prompt longer than 30 characters' })
})

test('checkPrompt: a prompt that starts with a dash is refused, however it is padded', () => {
  for (const text of ['--dangerously-skip-permissions', '-p', '  -x']) {
    assert.deepEqual(prompt(text), { ok: false, reason: 'prompt cannot start with -' }, text)
  }
  assert.equal(prompt('run -x').ok, true, 'a dash that does not start the prompt is fine')
})

test('checkPrompt: a line feed and a tab inside the prompt are accepted', () => {
  const result = prompt('fix the parser\n\tand its test')
  assert.equal(result.ok, true)
  assert.equal(result.prompt, 'fix the parser\n\tand its test')
})

test('checkPrompt: U+0000, U+000D, U+001B and U+007F are refused as control characters', () => {
  for (const ch of ['\u0000', '\u000d', '\u001b', '\u007f']) {
    assert.deepEqual(prompt(`run${ch}tests`), { ok: false, reason: 'prompt holds a control character' }, JSON.stringify(ch))
  }
})

// voice-sessions: "propose checks a repo and a prompt and prints the proposal".
test('checkProposal: a registered name gives the proposal and the registered path', () => {
  assert.deepEqual(checkProposal(registry, { repo: 'katipon', prompt: '  /interlock:ship add-parser  ' }, { maxChars: MAX }), {
    ok: true,
    proposal: { repo: 'katipon', prompt: '/interlock:ship add-parser' },
    path: '/repos/katipon'
  })
})

test('checkProposal: a path inside the repo names the repo when cwd is given', () => {
  const result = checkProposal(registry, { repo: '/repos/katipon/lib', prompt: 'run the tests', cwd: '/somewhere/else' }, { maxChars: MAX })
  assert.deepEqual(result, { ok: true, proposal: { repo: 'katipon', prompt: 'run the tests' }, path: '/repos/katipon' })
})

test('checkProposal: an unknown name is not a registered repo', () => {
  assert.deepEqual(checkProposal(registry, { repo: 'nowhere', prompt: 'x' }, { maxChars: MAX }), { ok: false, reason: 'nowhere is not a registered repo' })
  assert.deepEqual(checkProposal({ ...registry, repos: [] }, { repo: 'katipon', prompt: 'x' }, { maxChars: MAX }), {
    ok: false,
    reason: 'katipon is not a registered repo'
  })
})

test('checkProposal: a good repo with a bad prompt gives the prompt reason', () => {
  assert.deepEqual(checkProposal(registry, { repo: 'katipon', prompt: '   ' }, { maxChars: MAX }), { ok: false, reason: 'prompt is empty' })
  assert.deepEqual(checkProposal(registry, { repo: 'katipon', prompt: '-p' }, { maxChars: MAX }), { ok: false, reason: 'prompt cannot start with -' })
})

// voice-sessions: "A confirmed proposal starts one claude background session".
test('sessionName: the prefix and the prompt', () => {
  assert.equal(sessionName('/interlock:ship add-parser'), 'dial: /interlock:ship add-parser')
})

test('sessionName: every run of whitespace is one space', () => {
  assert.equal(sessionName('fix the parser\n\tand   its\r\ntest'), 'dial: fix the parser and its test')
})

test('sessionName: the prompt part is cut to 60 characters', () => {
  const name = sessionName('x'.repeat(300))
  assert.equal(name, `dial: ${'x'.repeat(60)}`)
  const lines = sessionName(`${'a'.repeat(40)}\n${'b'.repeat(40)}\n${'c'.repeat(40)}`)
  assert.equal(lines, `dial: ${'a'.repeat(40)} ${'b'.repeat(19)}`)
})

test('sessionName: a cut never leaves half a surrogate pair', () => {
  const name = sessionName(`${'a'.repeat(59)}\u{1F600}${'b'.repeat(10)}`)
  assert.ok(name.startsWith(`dial: ${'a'.repeat(59)}`))
  assert.doesNotMatch(name, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'no lone surrogate')
  assert.ok(name.length <= 'dial: '.length + 61)
})

// voice-sessions: "The text form".
test('formatProposal: two lines with the prompt on one line, and a trailing newline', () => {
  assert.equal(
    formatProposal({ repo: 'katipon', prompt: 'fix the parser\nand its test' }),
    'proposal for katipon: fix the parser and its test\nnothing is started until it is confirmed in the dial voice window\n'
  )
})
