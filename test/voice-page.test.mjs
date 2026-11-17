import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkRecognition, createController } from '../lib/voice/page-logic.mjs'
import { fakeTimers } from './helpers.mjs'

// The page (voice delta, design §9 and §13). The controller is exercised with a
// fake recognizer class, a fake `connect`, `fakeTimers`, and a recording `view`
// and `post`; the four page files are read as text for the rules a browser
// would otherwise have to enforce. The contract the fakes follow, from design
// §13 Interfaces:
//   connect({ onEvent, onError }) -> { close() }; onEvent(name, data) takes the
//   parsed JSON of the event; onError() is a failed stream.
//   post(path, body) -> Promise<{ status, body }>, rejecting with no answer.
//   The recognizer is a plain class whose onresult, onend and onerror the
//   controller sets; `available` and `install` are static, as in Chrome.
// The stream counts below follow the spec: the stream that fails, then the
// streams opened 500, 1000 and 2000 ms after each failure, so four connects in
// all and no retry after the third.

const flush = () => new Promise(resolve => setImmediate(resolve))

const NOT_OFFERED = lang => `on-device speech recognition is not offered for ${lang}`
const RECONNECTED = 'Reconnected; anything said while the page was away is not shown'

// ---------------------------------------------------------------- fakes

/**
 * A recognizer class. `availability` is what `available` resolves ('available',
 * 'downloadable', 'downloading', 'unavailable') or 'throw'; `install` is what
 * `install` resolves (true or false) or 'throw'. `noAvailable` leaves the
 * static `available` off. start() throws while the instance runs, as Chrome's
 * does; stop() and abort() end the run at once and leave onend to `end()`, so a
 * test decides when the end arrives.
 */
function fakeRecognition({ availability = 'available', install = true, noAvailable = false } = {}) {
  const R = { instances: [], availableCalls: [], installCalls: [], starts: 0 }
  class Recognition {
    constructor() {
      this.running = false
      this.processLocallySets = []
      this.startedWith = []
      this.interimResults = undefined
      this.lang = undefined
      this.onresult = null
      this.onend = null
      this.onerror = null
      R.instances.push(this)
    }
    set processLocally(value) {
      this.processLocallySets.push(value)
      this.value = value
    }
    get processLocally() {
      return this.value
    }
    start() {
      if (this.running) throw new Error('InvalidStateError: already started')
      this.running = true
      R.starts += 1
      this.startedWith.push({ lang: this.lang, interimResults: this.interimResults, processLocally: this.processLocally })
    }
    stop() {
      this.running = false
    }
    abort() {
      this.running = false
    }
    hear(transcript, isFinal) {
      const result = Object.assign([{ transcript, confidence: 0.9 }], { isFinal })
      this.onresult?.({ resultIndex: 0, results: [result] })
    }
    fail(code) {
      this.onerror?.({ error: code, message: '' })
    }
    end() {
      this.running = false
      this.onend?.({})
    }
  }
  if (!noAvailable) {
    Recognition.available = async options => {
      R.availableCalls.push(options)
      if (availability === 'throw') throw new Error('available failed')
      return availability
    }
    Recognition.install = async options => {
      R.installCalls.push(options)
      if (install === 'throw') throw new Error('install failed')
      return install
    }
  }
  R.Recognition = Recognition
  R.live = () => R.instances.find(instance => instance.running)
  return R
}

/** `connect` that records every stream it opened. */
function fakeConnect() {
  const streams = []
  const connect = ({ onEvent, onError }) => {
    const stream = {
      closed: false,
      event: (name, data = {}) => onEvent(name, data),
      fail: () => onError(new Error('stream lost')),
      close() {
        stream.closed = true
      },
    }
    streams.push(stream)
    return stream
  }
  connect.streams = streams
  return connect
}

/** `post` that waits: `answer(status, body)` settles the oldest open call, `fail()` rejects it. */
function fakePost() {
  const calls = []
  const post = (path, body) =>
    new Promise((resolve, reject) => {
      calls.push({ path, body, settled: false, resolve, reject })
    })
  const oldest = () => {
    const call = calls.find(c => !c.settled)
    assert.ok(call, 'a post is waiting for an answer')
    call.settled = true
    return call
  }
  post.calls = calls
  post.turns = () => calls.filter(c => c.path === '/turn')
  post.answer = (status = 202, body = status === 202 ? { ok: true } : { ok: false, reason: 'refused' }) => {
    oldest().resolve({ status, body })
  }
  post.fail = () => {
    oldest().reject(new Error('no answer'))
  }
  return post
}

/** A recording `view`; `log` holds every call in order. */
function fakeView() {
  const log = { statuses: [], errors: [], lines: [], notices: [], interims: [], inputsCleared: 0, focused: 0, closed: 0 }
  const view = {
    status: text => log.statuses.push(text),
    error: text => log.errors.push(text),
    line: (kind, text) => log.lines.push([kind, text]),
    notice: text => log.notices.push(text),
    interim: text => log.interims.push(text),
    clearInput: () => {
      log.inputsCleared += 1
    },
    focusStatus: () => {
      log.focused += 1
    },
    closed: () => {
      log.closed += 1
    },
  }
  return { view, log }
}

const shown = log => log.statuses.at(-1)
const sequence = list => list.filter((text, i) => i === 0 || text !== list[i - 1])

/**
 * A controller, its stream open, `hello` and the first `state` delivered.
 * `recognition: false` is a browser with no SpeechRecognition.
 */
async function sitting({ recognition = {}, lang = 'en-US', state = 'idle' } = {}) {
  const R = fakeRecognition(recognition || {})
  const connect = fakeConnect()
  const post = fakePost()
  const { timers, advance } = fakeTimers()
  const { view, log } = fakeView()
  const c = createController({ Recognition: recognition === false ? undefined : R.Recognition, post, connect, timers, view })
  c.open()
  const s = {
    c,
    R,
    connect,
    post,
    advance,
    log,
    emit: async (name, data = {}) => {
      connect.streams.at(-1).event(name, data)
      await flush()
    },
    /** The running recognizer hears `text`. */
    hear: async (text, isFinal) => {
      const rec = R.live()
      assert.ok(rec, 'a recognizer is running')
      rec.hear(text, isFinal)
      await flush()
    },
    /** Type `text`, wait for the post, answer it. */
    typed: async (text, status = 202, body) => {
      const done = c.submit(text)
      await flush()
      post.answer(status, body)
      await done
      await flush()
    },
    /** The owner speaks `text`; the post is left unanswered. */
    speak: async text => {
      await s.hear(text, true)
      assert.equal(post.turns().length >= 1, true, 'the final transcript was posted')
    },
    answer: async (status, body) => {
      post.answer(status, body)
      await flush()
    },
  }
  await s.emit('hello', { lang, model: 'opus', speech: true })
  await s.emit('state', { state })
  return s
}

/** `sitting` after the owner clicked Start and recognition is running. */
async function listening(options) {
  const s = await sitting(options)
  await s.c.start()
  await flush()
  assert.ok(s.R.live(), 'recognition is running after Start')
  return s
}

// ---------------------------------------------------------------- checkRecognition

// voice: "Speech is recognized on the device or not at all"
test('checkRecognition: an installed language pack is ready, asked on the device for the hello language', async () => {
  const R = fakeRecognition({ availability: 'available' })
  assert.equal(await checkRecognition(R.Recognition, 'en-GB'), 'ready')
  assert.equal(R.availableCalls.length, 1)
  assert.equal(R.availableCalls[0].processLocally, true)
  assert.ok(JSON.stringify(R.availableCalls[0]).includes('en-GB'), JSON.stringify(R.availableCalls[0]))
  assert.equal(R.installCalls.length, 0)
  assert.equal(R.instances.length, 0, 'checking creates no recognizer and so no microphone prompt')
})

test('checkRecognition: downloadable and downloading call install with the same options and are ready when it resolves true', async () => {
  for (const availability of ['downloadable', 'downloading']) {
    const R = fakeRecognition({ availability, install: true })
    assert.equal(await checkRecognition(R.Recognition, 'en-US'), 'ready', availability)
    assert.equal(R.installCalls.length, 1, availability)
    assert.deepEqual(R.installCalls[0], R.availableCalls[0], availability)
    assert.equal(R.installCalls[0].processLocally, true)
  }
})

test('checkRecognition: install resolving false or rejecting is unavailable', async () => {
  for (const install of [false, 'throw']) {
    const R = fakeRecognition({ availability: 'downloadable', install })
    assert.equal(await checkRecognition(R.Recognition, 'en-US'), 'unavailable', String(install))
  }
})

test('checkRecognition: no class, no available function, unavailable and a failing available are all unavailable', async () => {
  assert.equal(await checkRecognition(undefined, 'en-US'), 'unavailable')
  assert.equal(await checkRecognition(fakeRecognition({ noAvailable: true }).Recognition, 'en-US'), 'unavailable')
  assert.equal(await checkRecognition(fakeRecognition({ availability: 'unavailable' }).Recognition, 'en-US'), 'unavailable')
  assert.equal(await checkRecognition(fakeRecognition({ availability: 'throw' }).Recognition, 'en-US'), 'unavailable')
})

// ---------------------------------------------------------------- Start and the recognizer

// voice: "Speech is recognized on the device or not at all" / "Before the first click"
test('before Start no recognizer is created, no microphone is asked for, and the status says Not started', async () => {
  const s = await sitting()
  assert.equal(s.R.instances.length, 0)
  assert.equal(s.R.availableCalls.length, 0)
  assert.equal(shown(s.log), 'Not started')
  await s.emit('state', { state: 'thinking' })
  await s.emit('state', { state: 'idle' })
  assert.equal(s.R.instances.length, 0, 'states alone never start recognition')
})

test('Start on an installed language: recognition runs with processLocally, interimResults and the hello language', async () => {
  const s = await sitting({ lang: 'en-GB' })
  await s.c.start()
  await flush()
  assert.equal(s.R.availableCalls.length, 1)
  assert.equal(s.R.availableCalls[0].processLocally, true)
  assert.ok(JSON.stringify(s.R.availableCalls[0]).includes('en-GB'))
  assert.equal(s.R.instances.length >= 1, true)
  const rec = s.R.live()
  assert.ok(rec, 'recognition is running')
  assert.deepEqual(rec.startedWith.at(-1), { lang: 'en-GB', interimResults: true, processLocally: true })
  assert.equal(shown(s.log), 'Listening')
  assert.deepEqual(s.log.notices, [])
})

test('Start on a downloadable language installs it, then listens; a failed install does not listen', async () => {
  const ok = await sitting({ recognition: { availability: 'downloadable', install: true } })
  await ok.c.start()
  await flush()
  assert.equal(ok.R.installCalls.length, 1)
  assert.deepEqual(ok.R.installCalls[0], ok.R.availableCalls[0])
  assert.ok(ok.R.live())

  for (const install of [false, 'throw']) {
    const s = await sitting({ recognition: { availability: 'downloadable', install }, lang: 'fr-FR' })
    await s.c.start()
    await flush()
    assert.equal(s.R.live(), undefined, String(install))
    assert.equal(s.R.instances.length, 0, 'no recognizer is created')
    assert.equal(shown(s.log), 'Typed turns only')
    assert.deepEqual(s.log.notices, [NOT_OFFERED('fr-FR')])
  }
})

test('a browser without on-device recognition says Typed turns only and still posts typed turns', async () => {
  const cases = [{ recognition: false }, { recognition: { noAvailable: true } }, { recognition: { availability: 'unavailable' } }]
  for (const options of cases) {
    const s = await sitting(options)
    await s.c.start()
    await flush()
    assert.equal(shown(s.log), 'Typed turns only', JSON.stringify(options))
    assert.deepEqual(s.log.notices, [NOT_OFFERED('en-US')], JSON.stringify(options))
    assert.equal(s.R.instances.length, 0, 'no recognizer is created')

    await s.typed('what needs me')
    assert.deepEqual(s.post.turns().map(call => call.body), [{ text: 'what needs me' }])
  }
})

test('every recognizer the controller creates has processLocally true, interimResults and the hello language', async () => {
  const s = await listening({ lang: 'en-AU' })
  for (let round = 0; round < 3; round += 1) {
    s.R.live().end()
    await flush()
    s.advance(50)
    await flush()
    assert.ok(s.R.live(), `restarted after end ${round}`)
  }
  await s.emit('state', { state: 'thinking' })
  await s.emit('state', { state: 'idle' })
  for (const rec of s.R.instances) {
    assert.ok(rec.processLocallySets.length >= 1 || rec.startedWith.length === 0, 'processLocally is set before start')
    assert.deepEqual(
      rec.processLocallySets.filter(value => value !== true),
      [],
      'processLocally is never set to anything but true'
    )
    for (const started of rec.startedWith) {
      assert.deepEqual(started, { lang: 'en-AU', interimResults: true, processLocally: true })
    }
  }
})

// ---------------------------------------------------------------- microphone errors

// voice: "A microphone that cannot be used leaves typed turns"
test('a recognizer error other than no-speech or aborted stops listening, with its notice and the code in brackets', async () => {
  const cases = [
    ['not-allowed', 'the microphone was not allowed (not-allowed)'],
    ['service-not-allowed', 'the microphone was not allowed (service-not-allowed)'],
    ['audio-capture', 'no microphone could be used (audio-capture)'],
    ['language-not-supported', 'speech recognition failed (language-not-supported)'],
    ['network', 'speech recognition failed (network)'],
  ]
  for (const [code, notice] of cases) {
    const s = await listening()
    const rec = s.R.live()
    rec.fail(code)
    rec.end()
    await flush()
    s.advance(50)
    await flush()
    assert.equal(s.R.live(), undefined, `${code}: recognition is not started again`)
    assert.equal(shown(s.log), 'Typed turns only', code)
    assert.deepEqual(s.log.notices, [notice], code)
    assert.equal(s.R.availableCalls.length, 1, `${code}: available is not called again`)
  }
})

test('after an error nothing is retried through a whole turn, and Start asks available again', async () => {
  const s = await listening()
  const rec = s.R.live()
  rec.fail('not-allowed')
  rec.end()
  await flush()
  const starts = s.R.starts
  for (const state of ['thinking', 'speaking', 'idle']) await s.emit('state', { state })
  s.advance(5000)
  await flush()
  assert.equal(s.R.starts, starts, 'no start without a click')
  assert.equal(s.R.availableCalls.length, 1)
  assert.equal(shown(s.log), 'Typed turns only')

  await s.c.start()
  await flush()
  assert.equal(s.R.availableCalls.length, 2, 'Start asks again')
  assert.ok(s.R.live(), 'and listens when it is available')
  assert.equal(shown(s.log), 'Listening')
})

test('typing still works after the microphone was refused', async () => {
  const s = await listening()
  const rec = s.R.live()
  rec.fail('not-allowed')
  rec.end()
  await flush()
  await s.typed('what needs me')
  assert.deepEqual(s.post.calls.map(call => [call.path, call.body]), [['/turn', { text: 'what needs me' }]])
})

test('no-speech and aborted are ends with no notice, and recognition starts again while idle and not muted', async () => {
  for (const code of ['no-speech', 'aborted']) {
    const s = await listening()
    const rec = s.R.live()
    const starts = s.R.starts
    rec.fail(code)
    rec.end()
    await flush()
    s.advance(50)
    await flush()
    assert.deepEqual(s.log.notices, [], code)
    assert.ok(s.R.live(), `${code}: running again`)
    assert.equal(s.R.starts, starts + 1, code)
    assert.equal(shown(s.log), 'Listening', code)
    assert.equal(s.R.availableCalls.length, 1, code)
  }
})

// ---------------------------------------------------------------- listening only while idle

// voice: "The page listens only while Dial is idle"
test('a final transcript is stopped on and posted as a turn with the interim text cleared', async () => {
  const s = await listening()
  await s.hear('what needs me', true)
  assert.deepEqual(s.post.calls.map(call => [call.path, call.body]), [['/turn', { text: 'what needs me' }]])
  assert.equal(s.R.live(), undefined, 'recognition stopped at once, before the post is answered')
  assert.equal(s.log.interims.at(-1), '')
})

test('a blank final transcript and a non-final one are not posted', async () => {
  const s = await listening()
  await s.hear('   ', true)
  await s.hear('what', false)
  assert.equal(s.post.calls.length, 0)
  assert.ok(s.R.live(), 'still listening')
})

test('Dial does not hear itself: recognition stops on thinking and speaking and starts again on idle', async () => {
  const s = await listening()
  await s.emit('state', { state: 'thinking' })
  assert.equal(s.R.live(), undefined)
  await s.emit('state', { state: 'speaking' })
  assert.equal(s.R.live(), undefined)
  s.advance(5000)
  await flush()
  assert.equal(s.R.live(), undefined, 'nothing listens until idle')
  await s.emit('state', { state: 'idle' })
  assert.ok(s.R.live(), 'listening again')
  assert.equal(shown(s.log), 'Listening')
})

test('silence ends recognition and it starts again while idle and not muted', async () => {
  const s = await listening()
  const starts = s.R.starts
  s.R.live().end()
  await flush()
  s.advance(50)
  await flush()
  assert.ok(s.R.live())
  assert.equal(s.R.starts, starts + 1)
})

test('Mute stops recognition and keeps it stopped, even when it ends; unmute listens again', async () => {
  const s = await listening()
  const rec = s.R.live()
  await s.c.mute(true)
  await flush()
  assert.equal(s.R.live(), undefined)
  assert.equal(shown(s.log), 'Muted')
  rec.end()
  await flush()
  s.advance(5000)
  await flush()
  assert.equal(s.R.live(), undefined, 'it does not start again while muted')

  await s.c.mute(false)
  await flush()
  assert.ok(s.R.live())
  assert.equal(shown(s.log), 'Listening')
})

test('muting before Start leaves the status Not started and Start then does not listen', async () => {
  const s = await sitting()
  await s.c.mute(true)
  await flush()
  assert.equal(shown(s.log), 'Not started')
  await s.c.start()
  await flush()
  assert.equal(s.R.live(), undefined)
  assert.equal(shown(s.log), 'Muted')
  await s.c.mute(false)
  await flush()
  assert.ok(s.R.live())
})

// ---------------------------------------------------------------- a posted turn holds the microphone

// voice: "A posted turn holds the microphone"
test('after a 202 the microphone stays off until a state other than idle has arrived since the post', async () => {
  const s = await listening()
  await s.speak('what needs me')
  await s.answer(202)
  assert.equal(shown(s.log), 'Thinking', 'the owner sees the turn was taken')

  await s.emit('state', { state: 'idle' })
  assert.equal(s.R.live(), undefined, 'the earlier idle does not give the microphone back')
  s.R.instances.at(-1).end()
  await flush()
  s.advance(5000)
  await flush()
  assert.equal(s.R.live(), undefined, 'nor does the end of recognition')

  await s.c.submit('a second turn')
  assert.equal(s.post.turns().length, 1, 'no second turn is posted while one is in flight')
  s.R.instances.at(-1).hear('a spoken second turn', true)
  await flush()
  assert.equal(s.post.turns().length, 1, 'a spoken one is not posted either')

  await s.emit('state', { state: 'thinking' })
  assert.equal(s.R.live(), undefined)
  await s.emit('state', { state: 'idle' })
  assert.ok(s.R.live(), 'listening again once the turn is over')
  await s.hear('and another', true)
  assert.equal(s.post.turns().length, 2)
})

test('thinking, speaking or refused releases the turn when it arrives before the 202', async () => {
  const s = await listening()
  await s.speak('what needs me')
  await s.emit('state', { state: 'thinking' })
  await s.answer(202)
  await s.emit('state', { state: 'idle' })
  assert.ok(s.R.live(), 'the turn was over before the answer was read')
})

test('no second turn is posted while a post is waiting for its answer', async () => {
  const s = await listening()
  await s.speak('what needs me')
  await s.c.submit('again')
  s.R.instances.at(-1).hear('and again', true)
  await flush()
  assert.equal(s.post.turns().length, 1)
})

test('a post answered 409, 400 or 413 gives the microphone back at once, with the reason shown', async () => {
  const cases = [
    [409, 'a turn is running'],
    [400, 'empty turn'],
    [413, 'turn longer than 2000 characters'],
  ]
  for (const [status, reason] of cases) {
    const s = await listening()
    await s.speak('what needs me')
    assert.equal(s.R.live(), undefined)
    await s.answer(status, { ok: false, reason })
    assert.ok(s.R.live(), `${status}: listening again with no timer needed`)
    assert.equal(s.log.errors.at(-1), reason, String(status))
    assert.equal(s.log.inputsCleared, 0, String(status))
  }
})

test('a post that fails with no answer gives the microphone back at once', async () => {
  const s = await listening()
  await s.speak('what needs me')
  s.post.fail()
  await flush()
  assert.ok(s.R.live())
  await s.hear('what needs me', true)
  assert.equal(s.post.turns().length, 2, 'the turn can be posted again')
})

// ---------------------------------------------------------------- interim speech

// voice: "Interim speech is shown while the owner speaks"
test('interim words are shown as they are heard and never posted', async () => {
  const s = await listening()
  await s.hear('what', false)
  assert.equal(s.log.interims.at(-1), 'what')
  await s.hear('what needs', false)
  assert.equal(s.log.interims.at(-1), 'what needs')
  assert.equal(s.post.calls.length, 0)
})

test('the final transcript clears the interim text and is posted', async () => {
  const s = await listening()
  await s.hear('what needs', false)
  await s.hear('what needs me', true)
  assert.equal(s.log.interims.at(-1), '')
  assert.deepEqual(s.post.turns().map(call => call.body), [{ text: 'what needs me' }])
})

test('interim text is dropped when the state leaves idle and when the owner mutes, and nothing is posted', async () => {
  const left = await listening()
  await left.hear('what needs', false)
  await left.emit('state', { state: 'speaking' })
  assert.equal(left.log.interims.at(-1), '')
  assert.equal(left.post.calls.length, 0)

  const muted = await listening()
  await muted.hear('what needs', false)
  await muted.c.mute(true)
  await flush()
  assert.equal(muted.log.interims.at(-1), '')
  assert.equal(muted.post.calls.length, 0)
})

// ---------------------------------------------------------------- status line

// voice: "The status line says what Dial is doing"
test('the status line goes through the nine texts of one sitting in order', async () => {
  const s = await sitting()
  await s.c.start()
  await flush()
  await s.c.mute(true)
  await flush()
  await s.c.mute(false)
  await flush()
  await s.speak('what needs me')
  await s.answer(202)
  await s.emit('user', { text: 'what needs me' })
  await s.emit('state', { state: 'thinking' })
  await s.emit('tool', { command: 'dial sync katipon --remote --json' })
  await s.emit('sentence', { text: 'Two things need you.' })
  await s.emit('state', { state: 'speaking' })
  await s.emit('state', { state: 'idle' })
  const quit = s.c.quit()
  await flush()
  s.post.answer(200, { ok: true })
  await quit
  await s.emit('bye', {})
  assert.deepEqual(sequence(s.log.statuses), [
    'Not started',
    'Listening',
    'Muted',
    'Listening',
    'Thinking',
    'Thinking: running dial sync katipon --remote --json',
    'Speaking',
    'Listening',
    'Closed',
  ])
})

test('a refused session shows Refused with the reason and moves focus to the status line', async () => {
  const s = await sitting()
  assert.equal(s.log.focused, 0)
  await s.emit('state', { state: 'refused', reason: 'it has tools other than Bash: Read' })
  assert.equal(shown(s.log), 'Refused: it has tools other than Bash: Read')
  assert.equal(s.log.focused, 1)
})

test('focus moves only on a refusal', async () => {
  const s = await listening()
  for (const state of ['thinking', 'speaking', 'idle']) await s.emit('state', { state })
  await s.emit('bye', {})
  assert.equal(s.log.focused, 0)
})

test('Typed turns only gives way to Thinking and Speaking and comes back on idle', async () => {
  const s = await sitting({ recognition: { availability: 'unavailable' } })
  await s.c.start()
  await flush()
  assert.equal(shown(s.log), 'Typed turns only')
  await s.emit('state', { state: 'thinking' })
  assert.equal(shown(s.log), 'Thinking')
  await s.emit('state', { state: 'speaking' })
  assert.equal(shown(s.log), 'Speaking')
  await s.emit('state', { state: 'idle' })
  assert.equal(shown(s.log), 'Typed turns only')
})

test('the running command belongs to its turn: the next turn starts at plain Thinking', async () => {
  const s = await listening()
  await s.emit('state', { state: 'thinking' })
  await s.emit('tool', { command: 'dial next --json' })
  assert.equal(shown(s.log), 'Thinking: running dial next --json')
  await s.emit('state', { state: 'idle' })
  await s.emit('state', { state: 'thinking' })
  assert.equal(shown(s.log), 'Thinking')
  await s.emit('tool', { command: 'dial repos --json' })
  assert.equal(shown(s.log), 'Thinking: running dial repos --json', 'the last command is named')
})

test('Closed beats every other text', async () => {
  const s = await sitting()
  await s.emit('state', { state: 'refused', reason: 'it has MCP servers: github' })
  await s.emit('bye', {})
  assert.equal(shown(s.log), 'Closed')
  await s.emit('state', { state: 'idle' })
  assert.equal(shown(s.log), 'Closed')
})

// ---------------------------------------------------------------- errors

// voice: "An error stays on the page until the next turn"
test('an error stays on the error line through idle and 60 seconds, and a 202 clears it', async () => {
  const s = await listening()
  await s.emit('state', { state: 'thinking' })
  await s.emit('error', { message: 'the turn was stopped after 120 seconds' })
  await s.emit('state', { state: 'idle' })
  s.advance(60_000)
  await flush()
  assert.equal(s.log.errors.at(-1), 'the turn was stopped after 120 seconds')
  assert.deepEqual(s.log.errors, ['the turn was stopped after 120 seconds'], 'never cleared meanwhile')

  await s.typed('what needs me', 202)
  assert.equal(s.log.errors.at(-1), '')
})

test('a newer error replaces an older one', async () => {
  const s = await sitting()
  await s.emit('error', { message: 'the first failure' })
  await s.emit('error', { message: 'the second failure' })
  assert.deepEqual(s.log.errors, ['the first failure', 'the second failure'])
})

test('a refused post puts its reason on the error line, the next refusal replaces it, and a 202 clears it', async () => {
  const s = await sitting()
  await s.typed('what needs me', 409, { ok: false, reason: 'a turn is running' })
  assert.equal(s.log.errors.at(-1), 'a turn is running')
  await s.typed('what needs me', 400, { ok: false, reason: 'empty turn' })
  assert.equal(s.log.errors.at(-1), 'empty turn')
  await s.typed('what needs me', 202)
  assert.equal(s.log.errors.at(-1), '')
})

// ---------------------------------------------------------------- transcript

// voice: "The transcript tells who said what"
test('each user, tool, sentence and error event becomes one line of its kind', async () => {
  const s = await sitting()
  await s.emit('user', { text: 'what needs me' })
  await s.emit('tool', { command: 'dial next --json' })
  await s.emit('sentence', { text: 'Two things need you.' })
  await s.emit('error', { message: 'the turn failed: error_during_execution' })
  assert.deepEqual(s.log.lines, [
    ['user', 'what needs me'],
    ['tool', 'dial next --json'],
    ['sentence', 'Two things need you.'],
    ['error', 'the turn failed: error_during_execution'],
  ])
})

// voice: "The page shows every string as text"
test('a sentence that looks like markup reaches the view unchanged', async () => {
  const s = await sitting()
  const title = '<img src=x onerror=alert(1)> is the title.'
  await s.emit('sentence', { text: title })
  assert.deepEqual(s.log.lines, [['sentence', title]])
})

// ---------------------------------------------------------------- typed turns, stop, quit

// voice: "The page offers typed turns, stop and quit"
test('a typed turn is posted, and a 202 clears the field', async () => {
  const s = await sitting()
  await s.typed('what needs me', 202)
  assert.deepEqual(s.post.calls.map(call => [call.path, call.body]), [['/turn', { text: 'what needs me' }]])
  assert.equal(s.log.inputsCleared, 1)
})

test('a 409, 400 or 413 shows its reason on the error line and keeps the field', async () => {
  const cases = [
    [409, 'a turn is running'],
    [400, 'empty turn'],
    [413, 'turn longer than 2000 characters'],
  ]
  for (const [status, reason] of cases) {
    const s = await sitting()
    await s.typed('what needs me', status, { ok: false, reason })
    assert.equal(s.log.errors.at(-1), reason, String(status))
    assert.equal(s.log.inputsCleared, 0, `${status}: the typed text stays`)
  }
})

test('Stop and Quit post an empty object, and Escape posts /interrupt without touching the field', async () => {
  const s = await sitting()
  const stop = s.c.stop()
  await flush()
  s.post.answer(200, { ok: true })
  await stop

  const quit = s.c.quit()
  await flush()
  s.post.answer(200, { ok: true })
  await quit

  await s.emit('state', { state: 'speaking' })
  s.c.key('Escape')
  await flush()
  s.post.answer(200, { ok: true })
  await flush()

  assert.deepEqual(s.post.calls.map(call => [call.path, call.body]), [
    ['/interrupt', {}],
    ['/quit', {}],
    ['/interrupt', {}],
  ])
  assert.equal(s.log.inputsCleared, 0, 'the field still holds what was typed')
})

test('other keys post nothing', async () => {
  const s = await sitting()
  for (const key of ['Enter', 'a', 'Tab', 'Shift']) s.c.key(key)
  await flush()
  assert.equal(s.post.calls.length, 0)
})

test('bye stops recognition, shows Closed, and nothing is posted afterwards', async () => {
  const s = await listening()
  await s.emit('bye', {})
  assert.equal(s.R.live(), undefined)
  assert.equal(shown(s.log), 'Closed')
  assert.ok(s.log.closed >= 1, 'the view is told the page is closed')

  await s.emit('state', { state: 'idle' })
  assert.equal(s.R.live(), undefined, 'a late state does not start recognition')
  const before = s.post.calls.length
  await s.c.submit('what needs me')
  await s.c.stop()
  await s.c.quit()
  s.c.key('Escape')
  await flush()
  assert.equal(s.post.calls.length, before)
})

// ---------------------------------------------------------------- reconnecting

// voice: "The page reconnects to a lost event stream"
test('the stream is opened again at 500, 1000 and 2000 ms, then the page says Closed and stops', async () => {
  const s = await listening()
  const { streams } = s.connect
  assert.equal(streams.length, 1)

  streams[0].fail()
  await flush()
  assert.equal(s.R.live(), undefined, 'recognition stops when the stream fails')
  s.advance(499)
  assert.equal(streams.length, 1)
  s.advance(1)
  assert.equal(streams.length, 2)

  streams[1].fail()
  s.advance(999)
  assert.equal(streams.length, 2)
  s.advance(1)
  assert.equal(streams.length, 3)

  streams[2].fail()
  s.advance(1999)
  assert.equal(streams.length, 3)
  s.advance(1)
  assert.equal(streams.length, 4)

  streams[3].fail()
  await flush()
  s.advance(60_000)
  await flush()
  assert.equal(streams.length, 4, 'no further stream is opened')
  assert.equal(shown(s.log), 'Closed')
  assert.ok(s.log.closed >= 1)
  assert.equal(s.R.live(), undefined)
  await s.c.submit('what needs me')
  assert.equal(s.post.calls.length, 0, 'nothing is posted')
})

test('a stream that delivers hello is a reconnect: the notice, the state, and listening again', async () => {
  const s = await listening()
  await s.emit('state', { state: 'speaking' })
  s.connect.streams[0].fail()
  s.advance(500)
  assert.equal(s.connect.streams.length, 2)
  assert.deepEqual(s.log.notices, [], 'no notice before hello')

  await s.emit('hello', { lang: 'en-US', model: 'opus', speech: true })
  assert.deepEqual(s.log.notices, [RECONNECTED])
  assert.equal(s.R.live(), undefined, 'not listening before the state arrives')
  await s.emit('state', { state: 'idle' })
  assert.ok(s.R.live(), 'listening again')
  assert.deepEqual(s.log.lines, [], 'nothing is replayed')
})

test('the first hello of a page is not a reconnect', async () => {
  const s = await sitting()
  assert.deepEqual(s.log.notices, [])
})

test('hello resets the count: a later drop is retried after 500 ms again', async () => {
  const s = await sitting()
  const { streams } = s.connect
  streams[0].fail()
  s.advance(500)
  streams[1].fail()
  s.advance(999)
  assert.equal(streams.length, 2)
  s.advance(1)
  assert.equal(streams.length, 3)

  streams[2].event('hello', { lang: 'en-US', model: 'opus', speech: true })
  streams[2].event('state', { state: 'idle' })
  streams[2].fail()
  s.advance(499)
  assert.equal(streams.length, 3)
  s.advance(1)
  assert.equal(streams.length, 4)
})

test('a stream that ends after bye is not reopened', async () => {
  const s = await sitting()
  await s.emit('bye', {})
  s.connect.streams.at(-1).fail()
  s.advance(10_000)
  await flush()
  assert.equal(s.connect.streams.length, 1)
  assert.equal(shown(s.log), 'Closed')
})

// ---------------------------------------------------------------- the page files as text

const PAGE_FILES = ['page.html', 'page.js', 'page-logic.mjs', 'page.css']
const read = name => readFileSync(new URL(`../lib/voice/${name}`, import.meta.url), 'utf8')

// voice: "The page shows every string as text"
test('page.js and page-logic.mjs hold no markup sink, eval or webkit recognizer', () => {
  const banned = [
    ['innerHTML', /innerHTML/],
    ['outerHTML', /outerHTML/],
    ['insertAdjacentHTML', /insertAdjacentHTML/],
    ['document.write', /document\s*\.\s*write/],
    ['eval(', /\beval\s*\(/],
    ['webkitSpeechRecognition', /webkitSpeechRecognition/],
  ]
  for (const name of ['page.js', 'page-logic.mjs']) {
    const source = read(name)
    for (const [label, pattern] of banned) assert.doesNotMatch(source, pattern, `${name} holds ${label}`)
  }
})

// voice: "The scripts never ask for a server recognizer"
test('every processLocally in the scripts is set to true', () => {
  let seen = 0
  for (const name of ['page.js', 'page-logic.mjs']) {
    const source = read(name)
    for (const found of source.matchAll(/processLocally/g)) {
      seen += 1
      const rest = source.slice(found.index + found[0].length)
      assert.match(rest, /^\s*(?::|={1,3})\s*true\b/, `${name}: processLocally at ${found.index} is not set to true`)
    }
  }
  assert.ok(seen >= 1, 'the scripts set processLocally')
})

// voice: "The page can be used from the keyboard and a screen reader"
test('page.js adds one keydown listener, on the document', () => {
  const source = read('page.js')
  const listeners = [...source.matchAll(/addEventListener\(\s*['"`]keydown['"`]/g)]
  assert.equal(listeners.length, 1, 'one keydown listener')
  assert.match(source, /document\s*\.\s*addEventListener\(\s*['"`]keydown['"`]/)
})

test('page.js is a module that passes the token header, the stream and the keys to the controller, and sets text only', () => {
  const source = read('page.js')
  assert.match(source, /from\s+['"]\.?\/page-logic\.mjs['"]/)
  assert.match(source, /X-Dial-Token/)
  assert.match(source, /EventSource/)
  assert.match(source, /textContent/)
  assert.match(source, /aria-pressed/, 'the Mute control carries aria-pressed')
})

test('none of the four page files holds an http:// or https:// address', () => {
  for (const name of PAGE_FILES) assert.doesNotMatch(read(name), /https?:\/\//, name)
})

test('page.html has no inline script, no style element and no style attribute, and links /page.js and /page.css', () => {
  const html = read('page.html')
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(script[1], /\bsrc\s*=/, 'every script has a src')
    assert.equal(script[2].trim(), '', 'a script with a src holds no code')
  }
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc\s*=)[^>]*>/i, 'no script without a src')
  assert.doesNotMatch(html, /<style\b/i)
  assert.doesNotMatch(html, /\sstyle\s*=/i)
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handler')
  assert.match(html, /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*\bsrc\s*=\s*["']\/page\.js["']|<script\b[^>]*\bsrc\s*=\s*["']\/page\.js["'][^>]*\btype\s*=\s*["']module["']/)
  assert.match(html, /<link\b[^>]*\bhref\s*=\s*["']\/page\.css["']/)
})

/** The opening tag of the element with `id`, as `{ tag, attrs, rest }` where rest follows the tag. */
function element(html, id) {
  const found = new RegExp(`<(\\w+)\\b([^>]*\\bid\\s*=\\s*["']${id}["'][^>]*)>`, 'i').exec(html)
  assert.ok(found, `page.html has an element with id ${id}`)
  return { tag: found[1].toLowerCase(), attrs: found[2], rest: html.slice(found.index + found[0].length) }
}
const textOf = markup => markup.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()

test('page.html holds the four buttons, the labelled field, the status and error lines and the transcript', () => {
  const html = read('page.html')
  for (const [id, name] of [
    ['start', 'Start'],
    ['mute', 'Mute'],
    ['stop', 'Stop'],
    ['quit', 'Quit'],
  ]) {
    const control = element(html, id)
    assert.equal(control.tag, 'button', `${id} is a button`)
    assert.equal(textOf(control.rest.slice(0, control.rest.search(/<\/button>/i))), name, `${id} reads ${name}`)
  }
  assert.match(element(html, 'mute').attrs, /aria-pressed\s*=\s*["']false["']/)

  assert.equal(element(html, 'turn').tag, 'input')
  const labelled =
    /<label\b[^>]*\bfor\s*=\s*["']turn["'][^>]*>\s*Ask Dial\s*<\/label>/i.test(html) ||
    /<label\b[^>]*>\s*Ask Dial\s*<input\b[^>]*\bid\s*=\s*["']turn["']/i.test(html)
  assert.ok(labelled, 'a label reading Ask Dial belongs to the field')

  assert.match(element(html, 'status').attrs, /role\s*=\s*["']status["']/)
  assert.match(element(html, 'error').attrs, /role\s*=\s*["']alert["']/)
  element(html, 'transcript')
})

// voice: "The transcript tells who said what"
test('page.html says what Dial voice is for and suggests a first question in the empty transcript', () => {
  const html = read('page.html')
    .replace(/&quot;|&#34;|&#x22;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
  const purpose = 'Ask Dial aloud while you work: it checks your repos and answers in a sentence.'
  const suggestion = 'Ask what needs you, or whether a pull request can merge. Try: "what needs me?"'
  assert.ok(html.includes(purpose), 'the purpose line')
  assert.ok(html.includes(suggestion), 'the first question')
  assert.ok(html.indexOf(purpose) < html.search(/\bid\s*=\s*["']transcript["']/), 'the purpose sits above the transcript')
  assert.ok(html.indexOf(suggestion) > html.search(/\bid\s*=\s*["']transcript["']/), 'the suggestion sits in the transcript')
})
