import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSpeaker } from '../lib/voice/speech.mjs'
import { fakeSpawn } from './helpers.mjs'

// Requirements "Sentences are spoken by say, one at a time and in order" and
// "Without say, or after say fails, replies are only shown" of the `voice` delta.

function setup(opts = {}) {
  const { spawn, children } = fakeSpawn()
  const events = []
  const speaker = createSpeaker({ spawn, voice: undefined, enabled: true, on: e => events.push(e), ...opts })
  const errors = () => events.filter(e => e.type === 'error')
  const busy = () => events.filter(e => e.type === 'busy').map(e => e.busy)
  return { speaker, children, events, errors, busy }
}

test('a sentence runs say with no argument and the text on stdin, then ends stdin', () => {
  const { speaker, children } = setup()
  speaker.say('Two repos need you.')
  assert.equal(children.length, 1)
  assert.equal(children[0].file, 'say')
  assert.deepEqual(children[0].args, [])
  assert.equal(children[0].written.join(''), 'Two repos need you.')
  assert.equal(children[0].ended, true)
})

test('a named voice is passed as -v and the name, and nothing else', () => {
  const { speaker, children } = setup({ voice: 'Zoe (Premium)' })
  speaker.say('Hello there.')
  assert.deepEqual(children[0].args, ['-v', 'Zoe (Premium)'])
  assert.equal(children[0].written.join(''), 'Hello there.')
})

test('text is never an argument, even when it looks like an option', () => {
  const text = '-v Bad News is the title.'
  for (const voice of [undefined, 'Zoe (Premium)']) {
    const { speaker, children } = setup({ voice })
    speaker.say(text)
    assert.equal(children.length, 1)
    for (const arg of children[0].args) assert.ok(!arg.includes('Bad News'), `argument ${arg}`)
    assert.equal(children[0].written.join(''), text)
  }
})

test('the next child starts only after the one before has exited', () => {
  const { speaker, children } = setup()
  speaker.say('One.')
  speaker.say('Two.')
  assert.equal(children.length, 1)
  children[0].exit()
  assert.equal(children.length, 2)
  assert.equal(children[1].written.join(''), 'Two.')
})

test('three queued sentences are spoken in the order given, one process each', () => {
  const { speaker, children } = setup()
  speaker.say('First.')
  speaker.say('Second.')
  speaker.say('Third.')
  assert.equal(children.length, 1)
  children[0].exit()
  assert.equal(children.length, 2)
  children[1].exit()
  assert.equal(children.length, 3)
  children[2].exit()
  assert.equal(children.length, 3)
  assert.deepEqual(
    children.map(c => c.written.join('')),
    ['First.', 'Second.', 'Third.']
  )
  for (const c of children) assert.equal(c.ended, true)
})

test('stop() kills the running child and drops every sentence waiting', () => {
  const { speaker, children } = setup()
  speaker.say('One.')
  speaker.say('Two.')
  speaker.say('Three.')
  speaker.stop()
  assert.equal(children[0].killed, true)
  children[0].exit({ code: null, signal: 'SIGTERM' })
  assert.equal(children.length, 1)
})

test('a say() after stop() is spoken', () => {
  const { speaker, children } = setup()
  speaker.say('One.')
  speaker.say('Two.')
  speaker.stop()
  children[0].exit({ code: null, signal: 'SIGTERM' })
  speaker.say('Again.')
  assert.equal(children.length, 2)
  assert.equal(children[1].written.join(''), 'Again.')
  assert.equal(children[1].killed, false)
})

test('stop() with nothing running starts nothing and kills nothing', () => {
  const { speaker, children, events } = setup()
  speaker.stop()
  assert.equal(children.length, 0)
  assert.equal(speaker.busy, false)
  assert.deepEqual(events, [])
})

test('a non-zero exit gives one error with the first stderr line and speaks nothing more', () => {
  const { speaker, children, errors } = setup({ voice: 'Nobody' })
  speaker.say('One.')
  speaker.say('Two.')
  children[0].exit({ code: 1, stderr: "Voice `Nobody' not found.\nSecond line.\n" })
  assert.deepEqual(errors(), [{ type: 'error', message: "Voice `Nobody' not found." }])
  assert.equal(children.length, 1)
  speaker.say('Three.')
  assert.equal(children.length, 1)
  assert.equal(errors().length, 1)
  assert.equal(speaker.busy, false)
})

test('a failure not caused by stop() is the only one that is reported', () => {
  const { speaker, children, errors } = setup()
  speaker.say('One.')
  children[0].exit({ code: 1, stderr: 'boom\n' })
  speaker.say('Two.')
  speaker.say('Three.')
  assert.equal(children.length, 1)
  assert.equal(errors().length, 1)
})

test('a zero exit is not an error even when it wrote to stderr', () => {
  const { speaker, children, errors } = setup()
  speaker.say('One.')
  children[0].exit({ code: 0, stderr: 'a warning\n' })
  assert.deepEqual(errors(), [])
  speaker.say('Two.')
  assert.equal(children.length, 2)
})

test('the exit of a stopped child gives no error, for a signal or a non-zero code', () => {
  for (const exit of [{ code: null, signal: 'SIGTERM' }, { code: 1, stderr: 'killed\n' }, { code: 143 }]) {
    const { speaker, children, errors } = setup()
    speaker.say('One.')
    speaker.stop()
    children[0].exit(exit)
    assert.deepEqual(errors(), [])
    speaker.say('Next.')
    assert.equal(children.length, 2)
  }
})

test('enabled: false starts nothing, is never busy and sends no event', () => {
  const { speaker, children, events } = setup({ enabled: false })
  speaker.say('One.')
  speaker.say('Two.')
  assert.equal(children.length, 0)
  assert.equal(speaker.busy, false)
  speaker.stop()
  assert.equal(speaker.busy, false)
  assert.deepEqual(events, [])
})

test('busy is false at first, true while speaking or queued, false when the queue is empty', () => {
  const { speaker, children } = setup()
  assert.equal(speaker.busy, false)
  speaker.say('One.')
  speaker.say('Two.')
  assert.equal(speaker.busy, true)
  children[0].exit()
  assert.equal(speaker.busy, true)
  children[1].exit()
  assert.equal(speaker.busy, false)
})

test('one busy event per change: true at the first sentence, false when all are done', () => {
  const { speaker, children, busy } = setup()
  speaker.say('One.')
  speaker.say('Two.')
  speaker.say('Three.')
  assert.deepEqual(busy(), [true])
  children[0].exit()
  children[1].exit()
  assert.deepEqual(busy(), [true])
  children[2].exit()
  assert.deepEqual(busy(), [true, false])
})

test('stop() sends one busy false, and a later sentence sends busy true again', () => {
  const { speaker, children, busy } = setup()
  speaker.say('One.')
  speaker.say('Two.')
  speaker.stop()
  assert.equal(speaker.busy, false)
  assert.deepEqual(busy(), [true, false])
  children[0].exit({ code: null, signal: 'SIGTERM' })
  assert.deepEqual(busy(), [true, false])
  speaker.say('Again.')
  assert.deepEqual(busy(), [true, false, true])
})

test('a failed say ends busy with one change', () => {
  const { speaker, children, busy } = setup()
  speaker.say('One.')
  children[0].exit({ code: 1, stderr: 'no\n' })
  assert.deepEqual(busy(), [true, false])
  assert.equal(speaker.busy, false)
})

test('shutdown() kills the running child, resolves, and later sentences start nothing', async () => {
  const { speaker, children } = setup()
  speaker.say('One.')
  speaker.say('Two.')
  const done = speaker.shutdown()
  assert.equal(children[0].killed, true)
  children[0].exit({ code: null, signal: 'SIGTERM' })
  await done
  speaker.say('Three.')
  assert.equal(children.length, 1)
})

// ---------------------------------------------------------------- say(text, done)
// design §4 and §11: `done(spoken)` is called once, true when that sentence's say process exited 0 and was not
// stopped, false when it was stopped, failed, was dropped from the queue, or speech is off. The server uses it to
// decide when a proposal has been read in full (voice-sessions: "Dial reads an open proposal aloud in its own words").

function counted() {
  const calls = []
  const done = label => spoken => calls.push([label, spoken])
  return { calls, done }
}

test('done(true) is called after the say process exits 0, and not before', () => {
  const { speaker, children } = setup()
  const { calls, done } = counted()
  speaker.say('One.', done('one'))
  assert.deepEqual(calls, [])
  children[0].exit({ code: 0 })
  assert.deepEqual(calls, [['one', true]])
})

test('each queued sentence has its own done, called in order as each is spoken', () => {
  const { speaker, children } = setup()
  const { calls, done } = counted()
  speaker.say('One.', done('one'))
  speaker.say('Two.', done('two'))
  children[0].exit()
  assert.deepEqual(calls, [['one', true]])
  children[1].exit()
  assert.deepEqual(calls, [['one', true], ['two', true]])
})

test('stop() calls done(false) for the running sentence and for each queued one, once', () => {
  const { speaker, children } = setup()
  const { calls, done } = counted()
  speaker.say('One.', done('one'))
  speaker.say('Two.', done('two'))
  speaker.say('Three.', done('three'))
  speaker.stop()
  children[0].exit({ code: null, signal: 'SIGTERM' })
  assert.deepEqual(calls.map(c => c[0]).sort(), ['one', 'three', 'two'])
  assert.ok(calls.every(c => c[1] === false))
  assert.equal(calls.length, 3, 'each done exactly once')
})

test('a sentence that exits 0 after stop() is still reported false', () => {
  const { speaker, children } = setup()
  const { calls, done } = counted()
  speaker.say('One.', done('one'))
  speaker.stop()
  children[0].exit({ code: 0 })
  assert.deepEqual(calls, [['one', false]])
})

test('done(false) at once when speech is not enabled, and no process starts', () => {
  const { speaker, children } = setup({ enabled: false })
  const { calls, done } = counted()
  speaker.say('One.', done('one'))
  assert.deepEqual(calls, [['one', false]])
  assert.equal(children.length, 0)
})

test('done(false) at once for a sentence given after speech went quiet', () => {
  const { speaker, children } = setup()
  speaker.say('One.')
  children[0].exit({ code: 1, stderr: 'no voice\n' })
  const { calls, done } = counted()
  speaker.say('Two.', done('two'))
  assert.deepEqual(calls, [['two', false]])
  assert.equal(children.length, 1)
})

test('a failing process reports false for its sentence and for each sentence it dropped', () => {
  const { speaker, children } = setup()
  const { calls, done } = counted()
  speaker.say('One.', done('one'))
  speaker.say('Two.', done('two'))
  children[0].exit({ code: 1, stderr: 'boom\n' })
  assert.deepEqual(calls.map(c => c[0]).sort(), ['one', 'two'])
  assert.ok(calls.every(c => c[1] === false))
  assert.equal(calls.length, 2)
})

test('a process that could not be started reports false', () => {
  const { speaker, children } = setup()
  const { calls, done } = counted()
  speaker.say('One.', done('one'))
  children[0].exit({ code: null, error: { code: 'ENOENT', message: 'spawn say ENOENT' } })
  assert.deepEqual(calls, [['one', false]])
})

test('say with no callback behaves as before', () => {
  const { speaker, children } = setup()
  speaker.say('One.')
  speaker.say('Two.')
  children[0].exit()
  children[1].exit()
  assert.equal(children.length, 2)
  assert.equal(speaker.busy, false)
})
