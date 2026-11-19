import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEngine, engineArgs } from '../lib/voice/engine.mjs'
import { fakeSpawn, fakeTimers } from './helpers.mjs'

// The session manager of lib/voice/engine.mjs, run against fakeSpawn and fakeTimers (design §13, §14).
// Nothing here starts a process or waits on a real clock.

const PROMPT = 'You are Dial, speaking.\nAnswer in short sentences.'
const ENV = { PATH: '/usr/bin', DIAL_HOME: '/tmp/h', DIAL_NOW: '2026-11-10T09:00:00Z' }
const CWD = '/tmp/h/voice'

const uuidSource = () => {
  let n = 0
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
}

function make({ turnMs = 30_000, uuid = uuidSource() } = {}) {
  const { spawn, children } = fakeSpawn()
  const clock = fakeTimers()
  const events = []
  const engine = createEngine({
    spawn,
    cwd: CWD,
    env: { ...ENV },
    model: 'sonnet',
    prompt: PROMPT,
    turnMs,
    uuid,
    timers: clock.timers,
    on: e => events.push(e)
  })
  return { engine, children, events, advance: clock.advance, spawn, clock }
}

const send = (child, event) => child.line(JSON.stringify(event))
const report = (id, extra = {}) => ({ type: 'system', subtype: 'init', session_id: id, tools: ['Bash'], mcp_servers: [], permissionMode: 'dontAsk', ...extra })
const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, ...extra })
const assistant = content => ({ type: 'assistant', message: { role: 'assistant', content } })
const argAfter = (args, flag) => {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}
const idOf = child => argAfter(child.args, '--session-id')
const turnLine = text => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })}\n`
// The turn texts a child received, whatever the write boundaries were.
const sent = child =>
  child.written
    .join('')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l).message.content)
const types = events => events.map(e => e.type)
const ofType = (events, type) => events.filter(e => e.type === type)
const errors = events => ofType(events, 'error').map(e => e.message)
const live = children => children.filter(c => !c.exited)

const within = (promise, ms = 1000) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms))])
async function pending(promise) {
  let done = false
  promise.then(() => {
    done = true
  })
  await new Promise(resolve => setImmediate(resolve))
  return !done
}

// A started session with a turn running and the start report in.
function running(options) {
  const t = make(options)
  t.engine.start()
  const first = t.children[0]
  assert.deepEqual(t.engine.turn('first question'), { ok: true })
  send(first, report(idOf(first)))
  return { ...t, first, sid: idOf(first) }
}

// voice-engine: "A conversation is one claude process fed over a stream".
test('start spawns claude once, in the voice directory, with the whole argument list and the same environment', () => {
  const { engine, children } = make()
  engine.start()
  assert.equal(children.length, 1)
  const [child] = children
  assert.equal(child.file, 'claude')
  assert.equal(child.cwd, CWD)
  assert.deepEqual(child.env, ENV)
  assert.match(idOf(child), /^[0-9a-f-]{36}$/)
  assert.deepEqual(child.args.slice(-4), ['--model', 'sonnet', '--session-id', idOf(child)])
  assert.deepEqual(child.args, engineArgs({ model: 'sonnet', prompt: PROMPT, sessionId: idOf(child) }))
  assert.equal(child.args.includes('--resume'), false)
})

test('the session id is the uuid the source gave', () => {
  const { engine, children } = make({ uuid: () => 'fixed-id-1' })
  engine.start()
  assert.equal(idOf(children[0]), 'fixed-id-1')
})

test('start has no event of its own and the engine is neither busy nor refused', () => {
  const { engine, events } = make()
  engine.start()
  assert.deepEqual(events, [])
  assert.equal(engine.busy, false)
  assert.equal(engine.refused, false)
})

test('a second start does not make a second process', () => {
  const { engine, children } = make()
  engine.start()
  engine.start()
  assert.equal(children.length, 1)
})

test('two engines made with the same uuid source start with different ids and neither resumes', () => {
  const uuid = uuidSource()
  const a = make({ uuid })
  const b = make({ uuid })
  a.engine.start()
  b.engine.start()
  const ids = [idOf(a.children[0]), idOf(b.children[0])]
  assert.ok(ids[0] && ids[1])
  assert.notEqual(ids[0], ids[1])
  for (const child of [a.children[0], b.children[0]]) assert.equal(child.args.includes('--resume'), false)
})

test('there is never more than one live process, through a stop, a crash and a resume', () => {
  const { engine, children, first } = running()
  assert.equal(live(children).length, 1)
  engine.stop()
  assert.equal(live(children).length, 1, 'the stopped process has not exited, so nothing else is started')
  assert.equal(children.length, 1)
  first.exit({ code: null, signal: 'SIGTERM' })
  assert.equal(live(children).length, 1)
  assert.equal(children.length, 2)
  send(children[1], report(idOf(first)))
  children[1].exit({ code: 1 })
  assert.equal(live(children).length, 0)
  engine.turn('again')
  assert.equal(live(children).length, 1)
  assert.equal(children.length, 3)
})

// voice-engine: "The start report is checked before anything is answered", the refusals a report can carry.
const REFUSALS = [
  ['more tools than Bash', { tools: ['Bash', 'Read', 'Edit'] }, 'it has tools other than Bash: Read, Edit'],
  ['no Bash tool', { tools: [] }, 'it does not have the Bash tool'],
  ['an MCP server', { mcp_servers: [{ name: 'github', status: 'connected' }] }, 'it has MCP servers: github'],
  ['another permission mode', { permissionMode: 'default' }, 'its permission mode is default, not dontAsk'],
  ['no tools field', { tools: undefined }, 'it did not report its tools'],
  ['no mcp_servers field', { mcp_servers: undefined }, 'it did not report its MCP servers'],
  ['no permissionMode field', { permissionMode: undefined }, 'it did not report its permission mode']
]
for (const [name, extra, reason] of REFUSALS) {
  test(`a start report with ${name} ends the child and gives one refused event`, () => {
    const { engine, children, events } = make()
    engine.start()
    send(children[0], report(idOf(children[0]), extra))
    assert.deepEqual(events, [{ type: 'refused', reason }])
    assert.equal(children[0].killed, true)
    assert.equal(engine.refused, true)
    assert.equal(engine.busy, false)
  })
}

test('a session as asked for is not refused, whatever else the report holds', () => {
  const { engine, children, events } = make()
  engine.start()
  send(children[0], report(idOf(children[0]), { model: 'sonnet', plugins: [{ name: 'p' }], skills: ['a'], cwd: CWD }))
  assert.deepEqual(events, [])
  assert.equal(engine.refused, false)
  assert.equal(children[0].killed, false)
})

test('the start report is checked again on a resumed start', () => {
  const { engine, children, events, first, sid } = running()
  engine.stop()
  first.exit({ code: null, signal: 'SIGTERM' })
  send(children[1], report(sid, { tools: ['Bash', 'Write'] }))
  assert.equal(engine.refused, true)
  assert.equal(children[1].killed, true)
  assert.deepEqual(ofType(events, 'refused'), [{ type: 'refused', reason: 'it has tools other than Bash: Write' }])
})

// voice-engine: "An answer before the report".
const EARLY = [
  ['a text delta', delta('Two are open.')],
  ['an assistant event with text', assistant([{ type: 'text', text: 'Two are open.' }])],
  ['an assistant event with a command', assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'dial next --json' } }])],
  ['a result', result()]
]
for (const [name, event] of EARLY) {
  test(`${name} before the start report refuses the session and shows nothing`, () => {
    const { engine, children, events } = make()
    engine.start()
    engine.turn('can I merge katipon?')
    send(children[0], event)
    assert.deepEqual(ofType(events, 'refused'), [{ type: 'refused', reason: 'it answered before it reported how it started' }])
    assert.equal(ofType(events, 'text').length, 0)
    assert.equal(ofType(events, 'tool').length, 0)
    assert.equal(children[0].killed, true)
    assert.equal(engine.refused, true)
    // What the child still writes after the refusal reaches no one, and the report that follows changes nothing.
    const count = events.length
    send(children[0], delta('more'))
    send(children[0], report(idOf(children[0])))
    send(children[0], result())
    assert.equal(events.length, count)
  })
}

// voice-engine: "A refused session is ended and reported, and no other is started".
test('after a refusal turn answers the session was refused, and nothing is spawned again', () => {
  const { engine, children, events } = make()
  engine.start()
  send(children[0], report(idOf(children[0]), { tools: ['Bash', 'Read'] }))
  assert.deepEqual(engine.turn('hello'), { ok: false, reason: 'the session was refused' })
  assert.equal(sent(children[0]).includes('hello'), false)
  children[0].exit({ code: null, signal: 'SIGTERM' })
  assert.equal(children.length, 1)
  assert.deepEqual(engine.turn('hello again'), { ok: false, reason: 'the session was refused' })
  assert.equal(children.length, 1)
  engine.start()
  assert.equal(children.length, 1)
  assert.equal(ofType(events, 'refused').length, 1)
  assert.deepEqual(errors(events), [], 'the exit of the process Dial ended is not reported as a crash')
})

test('a refused session answers stop with false and the engine is not busy', () => {
  const { engine, children } = make()
  engine.start()
  engine.turn('hello')
  send(children[0], report(idOf(children[0]), { permissionMode: 'default' }))
  assert.equal(engine.busy, false)
  assert.equal(engine.stop(), false)
})

// voice-engine: "A session that ends before its start report is refused".
const EARLY_EXITS = [
  ['not logged in', { code: 1, stderr: 'Invalid API key · Please run /login\n' }, 'claude exited before it started (exit 1): Invalid API key · Please run /login'],
  ['a flag this claude does not know', { code: 1, stderr: "error: unknown option '--restricted'\n" }, "claude exited before it started (exit 1): error: unknown option '--restricted'"],
  ['nothing on stderr', { code: 2, stderr: '' }, 'claude exited before it started (exit 2)'],
  ['only blank stderr lines', { code: 3, stderr: '\n  \n\n' }, 'claude exited before it started (exit 3)'],
  ['a signal', { code: null, signal: 'SIGKILL', stderr: '' }, 'claude exited before it started (signal SIGKILL)'],
  ['a signal and a message', { code: null, signal: 'SIGABRT', stderr: 'boom\n' }, 'claude exited before it started (signal SIGABRT): boom'],
  ['blank lines before the first message and a second message after', { code: 1, stderr: '\n\nfirst line\nsecond line\n' }, 'claude exited before it started (exit 1): first line']
]
for (const [name, exit, reason] of EARLY_EXITS) {
  test(`an exit before the start report with ${name} is refused with its reason`, () => {
    const { engine, children, events } = make()
    engine.start()
    children[0].exit(exit)
    assert.deepEqual(events, [{ type: 'refused', reason }])
    assert.equal(engine.refused, true)
    assert.equal(children.length, 1, 'no other session is started')
  })
}

test('a child that exited by itself before its report is then sent kill, so its group is ended', () => {
  const { engine, children } = make()
  engine.start()
  children[0].exit({ code: 1, stderr: 'Invalid API key\n' })
  assert.equal(children[0].killed, true)
  assert.equal(engine.refused, true)
})

test('a claude that could not be started is refused with its code and message', () => {
  const { engine, children, events } = make()
  engine.start()
  children[0].exit({ code: null, signal: null, stderr: '', error: { code: 'ENOENT', message: 'spawn claude ENOENT' } })
  assert.deepEqual(events, [{ type: 'refused', reason: 'claude could not be started (ENOENT: spawn claude ENOENT)' }])
  assert.equal(children.length, 1)
})

test('a turn written before an early exit is not written to any other process', () => {
  const { engine, children } = make()
  engine.start()
  engine.turn('hello')
  children[0].exit({ code: 1, stderr: 'Invalid API key\n' })
  assert.equal(children.length, 1)
  assert.deepEqual(engine.turn('hello again'), { ok: false, reason: 'the session was refused' })
})

// voice-engine: "A turn is one line written to the session".
test('a turn is one JSON line and a newline, exactly', () => {
  const { engine, children } = make()
  engine.start()
  assert.deepEqual(engine.turn('can I merge katipon?'), { ok: true })
  assert.equal(
    children[0].written.join(''),
    '{"type":"user","message":{"role":"user","content":"can I merge katipon?"},"parent_tool_use_id":null}\n'
  )
  assert.equal(children[0].written.join(''), turnLine('can I merge katipon?'))
})

test('a turn with quotes and a line break is still one line and parses back to the same text', () => {
  const { engine, children } = make()
  engine.start()
  const text = 'say "hello"\nthen stop'
  assert.deepEqual(engine.turn(text), { ok: true })
  const wire = children[0].written.join('')
  assert.equal(wire.endsWith('\n'), true)
  assert.equal(wire.slice(0, -1).includes('\n'), false)
  const parsed = JSON.parse(wire)
  assert.equal(parsed.message.content, text)
  assert.equal(parsed.type, 'user')
  assert.equal(parsed.message.role, 'user')
  assert.equal(parsed.parent_tool_use_id, null)
})

test('a turn accepted before the start report is written at once', () => {
  const { engine, children, events } = make()
  engine.start()
  assert.deepEqual(engine.turn('hello'), { ok: true })
  assert.deepEqual(sent(children[0]), ['hello'])
  assert.equal(engine.busy, true)
  send(children[0], report(idOf(children[0])))
  assert.deepEqual(sent(children[0]), ['hello'], 'the report does not write it again')
  assert.deepEqual(events, [])
})

test('a turn is accepted, written, and ends with the result, and the next one is accepted', () => {
  const { engine, children, events } = running()
  assert.equal(engine.busy, true)
  send(children[0], result())
  assert.equal(engine.busy, false)
  assert.deepEqual(engine.turn('second'), { ok: true })
  assert.deepEqual(sent(children[0]), ['first question', 'second'])
  assert.equal(children.length, 1)
  assert.equal(ofType(events, 'end').length, 1)
})

// A turn during a turn.
test('a turn during a turn answers a turn is running and writes nothing', () => {
  const { engine, children } = running()
  assert.deepEqual(engine.turn('and another'), { ok: false, reason: 'a turn is running' })
  assert.deepEqual(sent(children[0]), ['first question'])
  assert.equal(engine.busy, true)
  assert.equal(children.length, 1)
})

// Events of an ordinary turn.
test('a turn gives text, a flush and one end with stopped false, in that order', () => {
  const { children, events } = running()
  send(children[0], delta('Two are open. '))
  send(children[0], delta('One can merge.'))
  send(children[0], result())
  assert.deepEqual(events, [
    { type: 'text', text: 'Two are open. ' },
    { type: 'text', text: 'One can merge.' },
    { type: 'flush' },
    { type: 'end', stopped: false }
  ])
})

test('a command is a tool event and its output is not an event', () => {
  const { children, events } = running()
  send(children[0], assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'dial context katipon --json' } }]))
  send(children[0], { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'secret output' }] } })
  assert.deepEqual(events, [{ type: 'tool', command: 'dial context katipon --json' }])
})

// voice-engine: "A proposal is read from the result of dial propose" - createEngine passes the two effects to on.
const PROPOSE_CMD = 'dial propose katipon --prompt "/interlock:ship add-parser" --json'
const toolResult = (id, content, extra = {}) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] } })

test('a propose command gives a tool event and then a proposal event with the repo and the prompt', () => {
  const { children, events } = running()
  send(children[0], assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: PROPOSE_CMD } }]))
  send(children[0], toolResult('toolu_1', '{"proposal":{"repo":"katipon","prompt":"/interlock:ship add-parser"}}'))
  assert.deepEqual(events, [
    { type: 'tool', command: PROPOSE_CMD },
    { type: 'proposal', repo: 'katipon', prompt: '/interlock:ship add-parser' }
  ])
})

test('a propose result that cannot be read gives a proposal-unread event', () => {
  const { children, events } = running()
  send(children[0], assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'dial propose katipon --prompt "x"' } }]))
  send(children[0], toolResult('toolu_1', 'proposal for katipon: x'))
  assert.deepEqual(events.slice(1), [{ type: 'proposal-unread' }])
})

test('a refused propose gives the tool event and nothing more', () => {
  const { children, events } = running()
  send(children[0], assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: PROPOSE_CMD } }]))
  send(children[0], toolResult('toolu_1', 'dial: katipon is not a registered repo', { is_error: true }))
  assert.deepEqual(types(events), ['tool'])
})

test('lines that are not understood change nothing and the turn goes on', () => {
  const { engine, children, events } = running()
  children[0].line('Warning: something')
  children[0].line('')
  send(children[0], { type: 'rate_limit_event' })
  send(children[0], { type: 'system', subtype: 'hook_started' })
  assert.deepEqual(events, [])
  assert.equal(engine.busy, true)
  assert.equal(engine.refused, false)
  send(children[0], delta('Still here.'))
  assert.deepEqual(events, [{ type: 'text', text: 'Still here.' }])
})

test('a failed result flushes, gives one error with the subtype, and a new turn is accepted', () => {
  const { engine, children, events } = running()
  send(children[0], result({ subtype: 'error_during_execution', is_error: true }))
  assert.deepEqual(errors(events), ['the turn failed: error_during_execution'])
  assert.equal(ofType(events, 'flush').length, 1)
  assert.ok(types(events).indexOf('flush') < types(events).indexOf('error'), 'the waiting text is emitted first')
  assert.deepEqual(ofType(events, 'end'), [{ type: 'end', stopped: false }])
  assert.equal(engine.busy, false)
  assert.deepEqual(engine.turn('again'), { ok: true })
})

test('a failed result with its own text gives that text in the error', () => {
  const { children, events } = running()
  send(children[0], result({ is_error: true, result: 'Credit balance is too low' }))
  assert.deepEqual(errors(events), ['the turn failed: Credit balance is too low'])
})

test('each turn starts the reducer anew, so an assistant text is reply text when the turn had no deltas', () => {
  const { engine, children, events } = running()
  send(children[0], delta('Hello.'))
  send(children[0], assistant([{ type: 'text', text: 'Hello.' }]))
  send(children[0], result())
  assert.deepEqual(ofType(events, 'text'), [{ type: 'text', text: 'Hello.' }])
  engine.turn('second')
  send(children[0], assistant([{ type: 'text', text: 'Again.' }]))
  assert.deepEqual(ofType(events, 'text'), [{ type: 'text', text: 'Hello.' }, { type: 'text', text: 'Again.' }])
})

// voice-engine: "A turn is stopped after voiceTurnSeconds".
test('a turn that hangs is stopped at turnMs with the error and an end with stopped true', () => {
  const { engine, children, events, advance, first } = running({ turnMs: 30_000 })
  advance(29_999)
  assert.deepEqual(errors(events), [])
  assert.equal(engine.busy, true)
  advance(1)
  assert.deepEqual(errors(events), ['the turn was stopped after 30 seconds'])
  assert.deepEqual(ofType(events, 'end'), [{ type: 'end', stopped: true }])
  assert.equal(first.killed, true)
  assert.equal(engine.busy, false, 'the state becomes idle at once')
  assert.equal(children.length, 1, 'the next process waits for the exit')
})

test('the error names the cap in seconds', () => {
  const { events, advance } = running({ turnMs: 120_000 })
  advance(119_999)
  assert.deepEqual(errors(events), [])
  advance(1)
  assert.deepEqual(errors(events), ['the turn was stopped after 120 seconds'])
})

test('a result clears the turn timer', () => {
  const { engine, children, events, advance } = running({ turnMs: 30_000 })
  advance(5000)
  send(children[0], result())
  advance(200_000)
  assert.deepEqual(errors(events), [])
  assert.equal(children[0].killed, false)
  assert.equal(engine.busy, false)
})

test('every turn is counted anew', () => {
  const { engine, children, events, advance } = running({ turnMs: 30_000 })
  advance(5000)
  send(children[0], result())
  advance(5000)
  engine.turn('second')
  advance(29_999)
  assert.deepEqual(errors(events), [])
  advance(1)
  assert.deepEqual(errors(events), ['the turn was stopped after 30 seconds'])
})

test('an interrupt clears the turn timer too', () => {
  const { engine, events, advance } = running({ turnMs: 30_000 })
  assert.equal(engine.stop(), true)
  advance(200_000)
  assert.deepEqual(errors(events), [])
})

test('a turn that timed out is resumed like an interrupted one', () => {
  const { children, advance, first, sid } = running({ turnMs: 30_000 })
  advance(30_000)
  first.exit({ code: null, signal: 'SIGTERM' })
  assert.equal(children.length, 2)
  assert.deepEqual(children[1].args, engineArgs({ model: 'sonnet', prompt: PROMPT, sessionId: sid, resume: true }))
})

// voice-engine: "A stopped turn ends the process and the conversation is resumed".
test('stop during a turn ends the process, and after its exit claude is started with --resume and the reported id', () => {
  const { engine, children, events, first, sid } = running()
  assert.equal(engine.stop(), true)
  assert.equal(first.killed, true)
  assert.equal(children.length, 1, 'no process is started before the exit')
  first.exit({ code: null, signal: 'SIGTERM' })
  assert.equal(children.length, 2)
  const resumed = children[1]
  assert.equal(resumed.file, 'claude')
  assert.equal(resumed.cwd, CWD)
  assert.deepEqual(resumed.env, ENV)
  assert.deepEqual(resumed.args, engineArgs({ model: 'sonnet', prompt: PROMPT, sessionId: sid, resume: true }))
  assert.equal(resumed.args.includes('--session-id'), false)
  assert.equal(argAfter(resumed.args, '--resume'), sid)
  assert.deepEqual(ofType(events, 'end'), [{ type: 'end', stopped: true }])
  assert.deepEqual(errors(events), [], 'an interrupt is not an error')
  assert.equal(engine.refused, false)
  assert.equal(engine.busy, false)
})

test('the id for --resume is the one the last result carried when it differs from the start report', () => {
  const { engine, children, first } = running()
  send(first, result({ session_id: 'renewed-id' }))
  engine.turn('second')
  engine.stop()
  first.exit({ code: null, signal: 'SIGTERM' })
  assert.equal(argAfter(children[1].args, '--resume'), 'renewed-id')
  assert.equal(children[1].args.includes('--session-id'), false)
})

test('the id from the start report is used when no result carried another', () => {
  const t = make()
  t.engine.start()
  t.engine.turn('q')
  send(t.children[0], report('reported-id'))
  send(t.children[0], result())
  t.engine.turn('q2')
  t.engine.stop()
  t.children[0].exit({ code: null, signal: 'SIGTERM' })
  assert.equal(argAfter(t.children[1].args, '--resume'), 'reported-id')
})

test('what the stopped process still writes before it exits is ignored, a late result included', () => {
  const { engine, children, events, first } = running()
  send(first, delta('Early. '))
  const before = events.length
  engine.stop()
  const afterStop = events.length
  send(first, delta('Late one. '))
  send(first, delta('Late two.'))
  send(first, assistant([{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'dial next --json' } }]))
  assert.equal(events.length, afterStop)
  assert.ok(before <= afterStop)
  engine.turn('next question')
  send(first, result())
  assert.equal(engine.busy, true, 'a late result of the stopped process does not end the new turn')
  assert.equal(ofType(events, 'end').filter(e => e.stopped === false).length, 0)
  first.exit({ code: null, signal: 'SIGTERM' })
  assert.equal(children.length, 2)
})

test('a turn accepted before the stopped process has exited is written to the process started with --resume', () => {
  const { engine, children, first } = running()
  engine.stop()
  assert.deepEqual(engine.turn('right after'), { ok: true })
  assert.equal(engine.busy, true)
  assert.deepEqual(sent(first), ['first question'], 'nothing is written to the stopped process')
  first.exit({ code: null, signal: 'SIGTERM' })
  assert.equal(children.length, 2)
  assert.deepEqual(sent(children[1]), ['right after'])
  assert.ok(children[1].args.includes('--resume'))
})

test('a turn accepted after the resumed process started is written to it', () => {
  const { engine, children, first, sid } = running()
  engine.stop()
  first.exit({ code: null, signal: 'SIGTERM' })
  send(children[1], report(sid))
  assert.deepEqual(engine.turn('after the resume'), { ok: true })
  assert.deepEqual(sent(children[1]), ['after the resume'])
  assert.equal(children.length, 2)
})

test('stop after the result of the turn does not end the process or start another', () => {
  const { engine, children, first } = running()
  send(first, result())
  assert.equal(engine.stop(), false)
  assert.equal(first.killed, false)
  assert.equal(children.length, 1)
})

test('stop with no turn running answers false', () => {
  const { engine, children } = make()
  assert.equal(engine.stop(), false)
  engine.start()
  assert.equal(engine.stop(), false)
  assert.equal(children[0].killed, false)
})

test('a second stop on the same turn does nothing more', () => {
  const { engine, first, children } = running()
  assert.equal(engine.stop(), true)
  assert.equal(engine.stop(), false)
  first.exit({ code: null, signal: 'SIGTERM' })
  assert.equal(children.length, 2)
})

test('the resumed process answers the next turn like the first', () => {
  const { engine, children, events, first, sid } = running()
  engine.stop()
  first.exit({ code: null, signal: 'SIGTERM' })
  send(children[1], report(sid))
  engine.turn('and now?')
  send(children[1], delta('Fine.'))
  send(children[1], result())
  assert.deepEqual(ofType(events, 'text'), [{ type: 'text', text: 'Fine.' }])
  assert.deepEqual(ofType(events, 'end'), [{ type: 'end', stopped: true }, { type: 'end', stopped: false }])
})

// voice-engine: "A conversation that cannot be resumed starts again as a new one".
test('a resume that ends before its report starts a new conversation, says so once, and writes the waiting turn again', () => {
  const { engine, children, events, first, sid } = running()
  engine.stop()
  first.exit({ code: null, signal: 'SIGTERM' })
  engine.turn('waiting turn')
  assert.deepEqual(sent(children[1]), ['waiting turn'])
  children[1].exit({ code: 1, stderr: 'No conversation found\n' })
  assert.equal(children.length, 3)
  const fresh = children[2]
  assert.equal(fresh.args.includes('--resume'), false)
  assert.ok(idOf(fresh))
  assert.notEqual(idOf(fresh), sid, 'a new uuid')
  assert.deepEqual(fresh.args, engineArgs({ model: 'sonnet', prompt: PROMPT, sessionId: idOf(fresh) }))
  assert.deepEqual(errors(events), ['the earlier conversation could not be resumed; this is a new one'])
  assert.equal(engine.refused, false)
  assert.deepEqual(sent(fresh), ['waiting turn'])
  assert.equal(engine.busy, true)
  assert.equal(children[1].killed, true, 'the exited process group is ended')
})

test('a resume that ends before its report with no turn waiting starts a new conversation and writes nothing', () => {
  const { engine, children, events, first } = running()
  engine.stop()
  first.exit({ code: null, signal: 'SIGTERM' })
  children[1].exit({ code: 1, stderr: 'No conversation found\n' })
  assert.equal(children.length, 3)
  assert.equal(children[2].args.includes('--resume'), false)
  assert.deepEqual(children[2].written, [])
  assert.deepEqual(errors(events), ['the earlier conversation could not be resumed; this is a new one'])
  assert.equal(engine.refused, false)
})

test('the new conversation failing too refuses the session with its own reason', () => {
  const { engine, children, events, first } = running()
  engine.stop()
  first.exit({ code: null, signal: 'SIGTERM' })
  children[1].exit({ code: 1, stderr: 'No conversation found\n' })
  children[2].exit({ code: 3, stderr: 'Invalid API key\n' })
  assert.deepEqual(ofType(events, 'refused'), [{ type: 'refused', reason: 'claude exited before it started (exit 3): Invalid API key' }])
  assert.equal(children.length, 3, 'no fourth attempt')
  assert.equal(errors(events).length, 1, 'the resume message was sent once')
  assert.equal(engine.refused, true)
  assert.deepEqual(engine.turn('hello'), { ok: false, reason: 'the session was refused' })
})

test('a resume that gets its report is not started again as a new conversation', () => {
  const { engine, children, events, first, sid } = running()
  engine.stop()
  first.exit({ code: null, signal: 'SIGTERM' })
  send(children[1], report(sid))
  assert.deepEqual(errors(events), [])
  assert.equal(children.length, 2)
  assert.equal(engine.refused, false)
})

// voice-engine: "A process that ends by itself is started again by the next turn".
test('a crash during a turn gives one error with the exit code and stderr, ends the turn, and starts nothing', () => {
  const { engine, children, events, first } = running()
  first.exit({ code: 1, stderr: 'Killed\n' })
  assert.deepEqual(errors(events), ['the session stopped (exit 1): Killed'])
  assert.deepEqual(ofType(events, 'end'), [{ type: 'end', stopped: true }])
  assert.equal(engine.busy, false)
  assert.equal(engine.refused, false)
  assert.equal(children.length, 1, 'not started again yet')
})

test('a crash by a signal names the signal, and with nothing on stderr there is no trailing text', () => {
  const { events, first } = running()
  first.exit({ code: null, signal: 'SIGSEGV', stderr: '' })
  assert.deepEqual(errors(events), ['the session stopped (signal SIGSEGV)'])
})

test('a crash with a signal and a message gives both, using the first non-blank line', () => {
  const { events, first } = running()
  first.exit({ code: null, signal: 'SIGABRT', stderr: '\nout of memory\nsecond\n' })
  assert.deepEqual(errors(events), ['the session stopped (signal SIGABRT): out of memory'])
})

test('a process that exits by itself is then sent kill so what remains of its group is ended', () => {
  const { first } = running()
  assert.equal(first.killed, false)
  first.exit({ code: 1, stderr: 'Killed\n' })
  assert.equal(first.killed, true)
})

test('a crash between turns sends no event and starts nothing', () => {
  const { engine, children, events, first } = running()
  send(first, result())
  const count = events.length
  first.exit({ code: 1, stderr: 'Killed\n' })
  assert.equal(events.length, count)
  assert.equal(children.length, 1)
  assert.equal(first.killed, true)
  assert.equal(engine.busy, false)
  assert.equal(engine.refused, false)
})

test('the next turn after a crash starts claude with --resume and writes the turn to it', () => {
  const { engine, children, first, sid } = running()
  send(first, result())
  first.exit({ code: 1, stderr: 'Killed\n' })
  assert.deepEqual(engine.turn('are you there?'), { ok: true })
  assert.equal(children.length, 2)
  assert.deepEqual(children[1].args, engineArgs({ model: 'sonnet', prompt: PROMPT, sessionId: sid, resume: true }))
  assert.deepEqual(sent(children[1]), ['are you there?'])
  assert.equal(children[1].cwd, CWD)
  assert.deepEqual(children[1].env, ENV)
  assert.equal(engine.busy, true)
})

test('after a crash during a turn the next turn resumes too, and the crashed turn is not written again', () => {
  const { engine, children, first } = running()
  first.exit({ code: 1, stderr: 'Killed\n' })
  engine.turn('second try')
  assert.deepEqual(sent(children[1]), ['second try'])
})

test('the turn timer of a crashed turn does not fire later', () => {
  const { events, advance, first } = running({ turnMs: 30_000 })
  first.exit({ code: 1, stderr: 'Killed\n' })
  advance(200_000)
  assert.deepEqual(errors(events), ['the session stopped (exit 1): Killed'])
})

// voice-engine: "No process outlives the command" (the manager's part).
test('shutdown kills the live child and resolves after its exit, not before', async () => {
  const { engine, children } = running()
  const done = engine.shutdown()
  assert.equal(children[0].killed, true)
  assert.equal(await pending(done), true, 'not resolved while the child lives')
  children[0].exit({ code: null, signal: 'SIGTERM' })
  await within(done)
  assert.equal(children.length, 1, 'nothing is started on the way out')
})

test('shutdown resolves at once when no child was ever started', async () => {
  const { engine, children } = make()
  await within(engine.shutdown())
  assert.equal(children.length, 0)
})

test('shutdown resolves at once when the child already exited by itself', async () => {
  const { engine, children, first } = running()
  first.exit({ code: 1, stderr: 'Killed\n' })
  await within(engine.shutdown())
  assert.equal(children.length, 1)
})

test('shutdown resolves at once after a refusal whose child has exited', async () => {
  const { engine, children } = make()
  engine.start()
  children[0].exit({ code: 1, stderr: 'Invalid API key\n' })
  await within(engine.shutdown())
})

test('shutdown while a stopped process has not exited does not resume, and waits for the exit', async () => {
  const { engine, children, events, first } = running()
  engine.stop()
  const done = engine.shutdown()
  assert.equal(await pending(done), true)
  first.exit({ code: null, signal: 'SIGTERM' })
  await within(done)
  assert.equal(children.length, 1)
  assert.deepEqual(errors(events), [])
})

test('the exit of the process shutdown ended is not reported as a crash or a refusal', async () => {
  const { engine, children, events } = running()
  const done = engine.shutdown()
  children[0].exit({ code: null, signal: 'SIGTERM', stderr: 'Terminated\n' })
  await within(done)
  assert.deepEqual(errors(events), [])
  assert.deepEqual(ofType(events, 'refused'), [])
  assert.equal(engine.refused, false)
})

test('shutdown before the start report ends the child and does not refuse the session', async () => {
  const { engine, children, events } = make()
  engine.start()
  const done = engine.shutdown()
  assert.equal(children[0].killed, true)
  children[0].exit({ code: null, signal: 'SIGTERM' })
  await within(done)
  assert.deepEqual(events, [])
  assert.equal(engine.refused, false)
  assert.equal(children.length, 1)
})

test('shutdown clears a running turn timer', async () => {
  const { engine, children, events, advance } = running({ turnMs: 30_000 })
  const done = engine.shutdown()
  children[0].exit({ code: null, signal: 'SIGTERM' })
  await within(done)
  advance(200_000)
  assert.deepEqual(errors(events), [])
  assert.equal(children.length, 1)
})
