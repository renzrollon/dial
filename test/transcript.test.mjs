import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { tailTurns } from '../lib/transcript.mjs'
import { FIXTURES, tmp } from './helpers.mjs'
import { writeFileSync } from 'node:fs'

const FIXTURE = join(FIXTURES, 'transcripts', 'session.jsonl')

test('keeps user and assistant text only, grouping assistant blocks by message id', () => {
  const r = tailTurns(FIXTURE, 50)
  assert.equal(r.ok, true)
  assert.deepEqual(r.turns, [
    { role: 'user', text: 'Add a login route' },
    { role: 'assistant', text: 'I will start with the route.\n\nThe route lives in lib/auth.mjs.' },
    { role: 'user', text: 'Now add tests\n\nfor the 401 case' },
    { role: 'assistant', text: 'Tests added; two pass.' },
  ])
})

test('thinking, tool_use, tool_result, isMeta and isSidechain never appear', () => {
  const all = JSON.stringify(tailTurns(FIXTURE, 50).turns)
  for (const banned of ['secret plan', 'Bash', 'lib bin', 'system-reminder', 'subagent chatter', 'summary']) {
    assert.equal(all.includes(banned), false, banned)
  }
})

test('n keeps the last turns', () => {
  assert.deepEqual(tailTurns(FIXTURE, 2).turns.map(t => t.role), ['user', 'assistant'])
  assert.equal(tailTurns(FIXTURE, 2).turns[1].text, 'Tests added; two pass.')
  assert.equal(tailTurns(FIXTURE, 0).turns.length, 0)
  assert.equal(tailTurns(FIXTURE).turns.length, 4)
})

test('50 text turns with n 20 returns the last 20', () => {
  const file = join(tmp(), 't.jsonl')
  const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ type: 'user', message: { content: `turn ${i}` } }))
  writeFileSync(file, lines.join('\n') + '\n')
  const { turns } = tailTurns(file, 20)
  assert.equal(turns.length, 20)
  assert.equal(turns[0].text, 'turn 30')
  assert.equal(turns[19].text, 'turn 49')
})

test('reports the first timestamp', () => {
  assert.equal(tailTurns(FIXTURE, 5).firstTimestamp, '2026-11-10T14:00:00.000Z')
})

test('a missing transcript is a result naming the path', () => {
  assert.deepEqual(tailTurns('/nope.jsonl', 5), { ok: false, reason: 'no transcript at /nope.jsonl' })
})

test('a transcript with no text turns is ok with none', () => {
  const file = join(tmp(), 't.jsonl')
  writeFileSync(file, JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', name: 'x' }] } }) + '\n')
  assert.deepEqual(tailTurns(file, 5).turns, [])
})
