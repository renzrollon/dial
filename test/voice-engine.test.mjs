import test from 'node:test'
import assert from 'node:assert/strict'
import { ALLOWED_TOOLS, checkStart, createReducer, engineArgs } from '../lib/voice/engine.mjs'

const ID = '3f2b8c1e-9d4a-4c7e-8a51-0b6d2e9f7a10'
const PROMPT = 'You are Dial, speaking.\nAnswer in short sentences.'

// voice-engine: "The session may run five dial commands and nothing else".
test('ALLOWED_TOOLS is the one command list, character for character', () => {
  assert.equal(ALLOWED_TOOLS, 'Bash(dial next:*),Bash(dial context:*),Bash(dial brief:*),Bash(dial sync:*),Bash(dial repos:*)')
  for (const name of ['handoff', 'record', 'drop', 'register', 'unregister', 'agent', 'vault', 'narrate', 'voice']) {
    assert.equal(ALLOWED_TOOLS.includes(`dial ${name}`), false, name)
  }
})

// voice-engine: "The whole argument list, in order".
test('the whole argument list for a first start, in order', () => {
  assert.deepEqual(engineArgs({ model: 'opus', prompt: PROMPT, sessionId: ID }), [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--safe-mode', '--restricted', '--strict-mcp-config',
    '--tools', 'Bash',
    '--allowedTools', ALLOWED_TOOLS,
    '--permission-mode', 'dontAsk',
    '--append-system-prompt', PROMPT,
    '--model', 'opus',
    '--session-id', ID
  ])
})

test('resume: true puts --resume in place of --session-id and changes nothing else', () => {
  const first = engineArgs({ model: 'sonnet', prompt: PROMPT, sessionId: ID })
  const resumed = engineArgs({ model: 'sonnet', prompt: PROMPT, sessionId: ID, resume: true })
  assert.deepEqual(resumed.slice(0, -2), first.slice(0, -2))
  assert.deepEqual(resumed.slice(-2), ['--resume', ID])
  assert.equal(resumed.includes('--session-id'), false)
  assert.equal(first.includes('--resume'), false)
  assert.equal(engineArgs({ model: 'sonnet', prompt: PROMPT, sessionId: ID, resume: false }).includes('--resume'), false)
})

// voice-engine: "The session loads none of the owner's Claude Code setup".
test('the three isolation flags appear once each and the six added-back flags never', () => {
  for (const resume of [false, true]) {
    const args = engineArgs({ model: 'sonnet', prompt: PROMPT, sessionId: ID, resume })
    for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config']) {
      assert.equal(args.filter(a => a === flag).length, 1, flag)
    }
    for (const flag of ['--settings', '--mcp-config', '--plugin-dir', '--add-dir', '--setting-sources', '--bare']) {
      assert.equal(args.includes(flag), false, flag)
    }
  }
})

test('the command list is one argument followed by --permission-mode, and the prompt is passed as written', () => {
  const args = engineArgs({ model: 'sonnet', prompt: PROMPT, sessionId: ID })
  const i = args.indexOf('--allowedTools')
  assert.equal(args[i + 1], ALLOWED_TOOLS)
  assert.equal(args[i + 2], '--permission-mode')
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], PROMPT)
  assert.equal(args[args.indexOf('--tools') + 1], 'Bash')
})

// voice-engine: "The start report is checked before anything is answered".
const report = (extra = {}) => ({ type: 'system', subtype: 'init', tools: ['Bash'], mcp_servers: [], permissionMode: 'dontAsk', ...extra })

test('a start report as asked for is not refused, whatever other fields it holds', () => {
  assert.deepEqual(checkStart(report()), { ok: true })
  assert.deepEqual(checkStart(report({ session_id: ID, model: 'sonnet', cwd: '/x', plugins: [{ name: 'p' }], skills: ['a'], extra: { deep: [1] } })), { ok: true })
})

test('more tools than Bash is refused naming the others', () => {
  assert.deepEqual(checkStart(report({ tools: ['Bash', 'Read', 'Edit'] })), { ok: false, reason: 'it has tools other than Bash: Read, Edit' })
})

test('no Bash tool is refused', () => {
  assert.deepEqual(checkStart(report({ tools: [] })), { ok: false, reason: 'it does not have the Bash tool' })
})

test('an MCP server is refused naming each', () => {
  assert.deepEqual(checkStart(report({ mcp_servers: [{ name: 'github', status: 'connected' }] })), { ok: false, reason: 'it has MCP servers: github' })
  assert.deepEqual(checkStart(report({ mcp_servers: [{ name: 'github' }, { name: 'slack' }] })), { ok: false, reason: 'it has MCP servers: github, slack' })
})

test('another permission mode is refused naming it', () => {
  assert.deepEqual(checkStart(report({ permissionMode: 'default' })), { ok: false, reason: 'its permission mode is default, not dontAsk' })
})

test('a missing field, or one of the wrong kind, is refused as not reported', () => {
  const without = key => { const r = report(); delete r[key]; return r }
  assert.deepEqual(checkStart(without('tools')), { ok: false, reason: 'it did not report its tools' })
  assert.deepEqual(checkStart(report({ tools: 'Bash' })), { ok: false, reason: 'it did not report its tools' })
  assert.deepEqual(checkStart(without('mcp_servers')), { ok: false, reason: 'it did not report its MCP servers' })
  assert.deepEqual(checkStart(report({ mcp_servers: null })), { ok: false, reason: 'it did not report its MCP servers' })
  assert.deepEqual(checkStart(without('permissionMode')), { ok: false, reason: 'it did not report its permission mode' })
})

test('the check is the same for a resumed start: nothing depends on the arguments', () => {
  assert.equal(checkStart(report({ session_id: ID })).ok, true)
  assert.equal(checkStart(report({ session_id: ID, tools: ['Bash', 'Write'] })).ok, false)
})

// The reducer: one stdout line in, effects out.
const line = event => JSON.stringify(event)
const delta = (text, extra = {}) => line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, ...extra })
const stop = () => line({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
const assistant = (content, extra = {}) => line({ type: 'assistant', message: { role: 'assistant', content }, ...extra })
const types = effects => effects.map(e => e.type)
const textOf = effects => effects.filter(e => e.type === 'text').map(e => e.text)

test('the start report is one start effect carrying the event', () => {
  const r = createReducer()
  const event = report({ session_id: ID })
  assert.deepEqual(r.feed(line(event)), [{ type: 'start', event }])
})

test('text deltas become text effects in order, and a block stop is a flush', () => {
  const r = createReducer()
  assert.deepEqual(r.feed(delta('Two are open. ')), [{ type: 'text', text: 'Two are open. ' }])
  assert.deepEqual(r.feed(delta('One can merge.')), [{ type: 'text', text: 'One can merge.' }])
  assert.deepEqual(r.feed(stop()), [{ type: 'flush' }])
})

test('the whole message after deltas does not repeat them', () => {
  const r = createReducer()
  r.feed(delta('Two are open.'))
  assert.deepEqual(textOf(r.feed(assistant([{ type: 'text', text: 'Two are open.' }]))), [])
})

test('a claude that sends no deltas has its assistant text blocks used as reply text', () => {
  const r = createReducer()
  assert.deepEqual(textOf(r.feed(assistant([{ type: 'text', text: 'Two are open. One can merge.' }]))), ['Two are open. One can merge.'])
})

test('newTurn clears the saw-a-delta mark', () => {
  const r = createReducer()
  r.feed(delta('Hello.'))
  r.newTurn()
  assert.deepEqual(textOf(r.feed(assistant([{ type: 'text', text: 'Again.' }]))), ['Again.'])
})

test('thinking and tool input deltas are not reply text', () => {
  const r = createReducer()
  const think = line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } })
  const input = line({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"com' } } })
  assert.deepEqual(r.feed(think), [])
  assert.deepEqual(r.feed(input), [])
})

test('a nested event is ignored', () => {
  const r = createReducer()
  assert.deepEqual(r.feed(delta('Nested.', { parent_tool_use_id: 'toolu_1' })), [])
  assert.deepEqual(r.feed(assistant([{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'dial next --json' } }], { parent_tool_use_id: 'toolu_1' })), [])
  assert.deepEqual(textOf(r.feed(assistant([{ type: 'text', text: 'x' }]))), ['x'], 'the nested delta did not count as a delta')
})

test('a Bash tool_use is a tool effect with its command', () => {
  const r = createReducer()
  assert.deepEqual(r.feed(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'dial context katipon --json' } }])), [
    { type: 'tool', command: 'dial context katipon --json' }
  ])
})

test('two tool_use blocks give two tool effects in order', () => {
  const r = createReducer()
  const effects = r.feed(assistant([
    { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'dial sync katipon --remote --json' } },
    { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'dial context katipon --json' } }
  ]))
  assert.deepEqual(effects.filter(e => e.type === 'tool'), [
    { type: 'tool', command: 'dial sync katipon --remote --json' },
    { type: 'tool', command: 'dial context katipon --json' }
  ])
})

test('a tool_use not named Bash, or with no string command, gives no tool effect', () => {
  const r = createReducer()
  for (const block of [
    { type: 'tool_use', id: 'a', name: 'Read', input: { command: 'dial next' } },
    { type: 'tool_use', id: 'b', name: 'bash', input: { command: 'dial next' } },
    { type: 'tool_use', id: 'c', name: 'Bash', input: {} },
    { type: 'tool_use', id: 'd', name: 'Bash', input: { command: 5 } },
    { type: 'tool_use', id: 'e', name: 'Bash' },
    { type: 'tool_use', id: 'f', name: 'Bash', input: null }
  ]) {
    assert.deepEqual(r.feed(assistant([block])).filter(e => e.type === 'tool'), [], JSON.stringify(block))
  }
})

test('a tool result is not shown or spoken', () => {
  const r = createReducer()
  const result = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'secret output' }] } })
  assert.deepEqual(r.feed(result), [])
})

test('a successful result flushes and ends the turn', () => {
  const r = createReducer()
  assert.deepEqual(types(r.feed(line({ type: 'result', subtype: 'success', is_error: false }))), ['flush', 'done'])
})

test('a failed result flushes first and then fails with the subtype', () => {
  const r = createReducer()
  const effects = r.feed(line({ type: 'result', subtype: 'error_during_execution', is_error: true }))
  assert.equal(effects[0].type, 'flush')
  const failed = effects.find(e => e.type === 'failed')
  assert.ok(failed, 'a failed effect')
  assert.ok(effects.indexOf(failed) > 0)
  assert.match(failed.reason, /error_during_execution/)
})

test('a failed result with its own text fails with that text, not the subtype', () => {
  const r = createReducer()
  const failed = r.feed(line({ type: 'result', subtype: 'success', is_error: true, result: 'Credit balance is too low' })).find(e => e.type === 'failed')
  assert.ok(failed)
  assert.match(failed.reason, /Credit balance is too low/)
  assert.doesNotMatch(failed.reason, /success/)
  const empty = r.feed(line({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' })).find(e => e.type === 'failed')
  assert.match(empty.reason, /error_max_turns/)
})

test('a result that is an error with subtype success still fails', () => {
  const r = createReducer()
  assert.ok(r.feed(line({ type: 'result', subtype: 'success', is_error: true })).some(e => e.type === 'failed'))
  assert.equal(r.feed(line({ type: 'result', subtype: 'success' })).some(e => e.type === 'failed'), false)
})

test('a line that is not JSON is skipped and the events on either side are handled', () => {
  const r = createReducer()
  assert.deepEqual(r.feed(delta('Before. ')), [{ type: 'text', text: 'Before. ' }])
  assert.deepEqual(r.feed('Warning: something'), [])
  assert.deepEqual(r.feed(delta('After.')), [{ type: 'text', text: 'After.' }])
})

test('events of another type or shape give no effect', () => {
  const r = createReducer()
  for (const event of [
    { type: 'rate_limit_event' },
    { type: 'system', subtype: 'hook_started' },
    { type: 'stream_event' },
    { type: 'stream_event', event: null },
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: null } },
    { type: 'assistant' },
    { type: 'assistant', message: { content: 'text' } },
    { type: 'weird', payload: 1 }
  ]) assert.deepEqual(r.feed(line(event)), [], JSON.stringify(event))
})

test('feed returns nothing and does not throw for hostile lines', () => {
  const r = createReducer()
  for (const input of ['', 'null', '[]', '42', '{', '"text"', 'true', '   ', 'x'.repeat(1024 * 1024), `{"type":"${'a'.repeat(1024 * 1024)}"}`]) {
    let out
    assert.doesNotThrow(() => { out = r.feed(input) }, input.slice(0, 20))
    assert.deepEqual(out, [], input.slice(0, 20))
  }
})
