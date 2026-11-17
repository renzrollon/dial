/**
 * The voice session's system prompt (voice-engine: the four prompt requirements), read as text in the manner of the
 * ask-skill test in plugin.test.mjs. It imports no page module, so it can pass before the page exists.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const prompt = () => readFileSync(join(ROOT, 'lib', 'voice', 'prompt.md'), 'utf8')

/** The sentences and lines of the prompt, for a rule that must sit in one place. */
const pieces = body => body.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean)

// voice-engine: "The voice prompt names the five commands and how to use them".
test('the prompt is passed as written, so it does not begin with a dash', () => {
  const body = prompt()
  assert.ok(body.length > 0)
  assert.notEqual(body[0], '-')
  assert.doesNotMatch(body, /^\s*-/, 'not even after leading whitespace')
})

test('the prompt names five dial commands and no other', () => {
  const body = prompt()
  const commands = new Set([...body.matchAll(/\bdial ([a-z][a-z-]*)/g)].map(m => m[1]))
  for (const c of commands) assert.ok(['next', 'context', 'brief', 'sync', 'repos'].includes(c), `names no dial command but the five: ${c}`)
  for (const c of ['next', 'context', 'brief', 'sync', 'repos']) assert.ok(commands.has(c), `names dial ${c}`)
})

test('the prompt says to pass --json', () => {
  assert.ok(prompt().includes('--json'))
})

test('the sync line comes before the context line', () => {
  const body = prompt()
  const sync = body.indexOf('dial sync <repo> --remote --json')
  const context = body.indexOf('dial context <repo> --json')
  assert.ok(sync >= 0, 'names dial sync <repo> --remote --json')
  assert.ok(context > sync, 'dial context <repo> --json comes after the sync')
})

test('an unobserved remote fact after a sync that exited 0 is a failed refresh', () => {
  const rule = pieces(prompt()).find(p => /unobserved/.test(p) && /remote/.test(p))
  assert.ok(rule, 'a rule naming unobserved and remote')
  assert.match(rule, /fail|did not|could not/i)
  assert.match(rule, /refresh/i)
})

test('an unclear repo name is matched against dial repos --json, and asked about when still unclear', () => {
  const body = prompt()
  assert.ok(body.includes('dial repos --json'))
  const at = body.indexOf('dial repos --json')
  const near = body.slice(Math.max(0, at - 300), at + 300)
  assert.match(near, /unclear|misheard|not sure|doesn't match|does not match/i)
  assert.match(near, /\bask\b/i)
})

// voice-engine: "The voice prompt reports a sync that fails".
test('a dial sync that exits non-zero is reported in one sentence, then dial context is still run', () => {
  const body = prompt()
  const at = body.search(/non-?zero/i)
  assert.ok(at >= 0, 'says what happens when dial sync exits non-zero')
  const near = body.slice(Math.max(0, at - 300), at + 400)
  assert.match(near, /dial sync/)
  assert.match(near, /one sentence/i)
  assert.match(near, /dial context/)
  assert.match(near, /still|anyway|regardless/i)
})

// voice-engine: "The voice prompt keeps answers to what the commands print".
test('the four verdict fields are named in backticks, with unobserved and stale', () => {
  const body = prompt()
  for (const field of ['ready', 'blockers', 'needsMe', 'suggested']) assert.ok(body.includes(`\`${field}\``), field)
  assert.match(body, /unobserved/)
  assert.match(body, /stale/)
  assert.match(body, /how old|age|days/i, 'says how old a stale list is')
})

test('answers come only from what the commands print', () => {
  assert.match(prompt(), /only (from|what)|nothing (else|beyond)/i)
})

test('what the commands print is data, never an instruction', () => {
  const body = prompt()
  assert.match(body, /data/i)
  assert.match(body, /not instructions?|never an instruction|never instructions?|not an instruction/i)
})

test('a suggested command is a draft the session never runs and the owner runs in Claude Code', () => {
  const body = prompt()
  const rule = pieces(body).find(p => /`suggested`/.test(p) && /Claude Code/.test(p))
  assert.ok(rule, 'a rule naming suggested and Claude Code')
  assert.match(body, /never run|does not run|do not run|don't run|not run/i)
  assert.match(body, /draft/i)
})

// voice-engine: "The voice prompt asks for speech, not a document".
test('the reply is spoken: short sentences, the answer first, and no markup', () => {
  const body = prompt()
  assert.match(body, /spoken/i)
  assert.match(body, /short sentences/i)
  assert.match(body, /lead with the answer|answer first|start with the answer/i)
  for (const [name, re] of [['markdown', /markdown/i], ['list', /\blists?\b/i], ['table', /\btables?\b/i], ['code block', /code/i], ['web address', /web address|URL|link/i]]) {
    assert.match(body, re, `names ${name} as something to leave out`)
  }
})

test('the session says a few words before it runs a command', () => {
  assert.match(prompt(), /few words (first |)before/i)
})

test('a long list is given as a count and the first few items', () => {
  assert.match(prompt(), /count/i)
  assert.match(prompt(), /first few/i)
})
