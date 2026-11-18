import test from 'node:test'
import assert from 'node:assert/strict'
import { FRAME_MS, createStage, paint } from '../lib/voice/stage.mjs'
import { cadence, reduce, restModel, scene } from '../lib/voice/scene.mjs'
import { fakeTimers } from './helpers.mjs'

// The frame scheduler and the painter of the voice stage (voice-stage delta, design §3, §5, §14). lib/voice/stage.mjs
// does not exist yet: every case here fails until task 2.4 adds it. Frames are counted with fakeTimers, a fake
// requestAnimationFrame pair defined here and a counting draw; paint runs against a recording context that throws
// on text drawing.

const TICK = 16 // a fake display refreshes every 16 ms

/** A stage on a fake clock, a fake raf and a counting draw. `run(ms)` moves time in display ticks. */
function rig() {
  const clock = fakeTimers()
  const live = new Set()
  const timers = {
    setTimeout(fn, ms, ...args) {
      const handle = clock.timers.setTimeout(
        (...a) => {
          live.delete(handle)
          fn(...a)
        },
        ms,
        ...args
      )
      live.add(handle)
      return handle
    },
    clearTimeout(handle) {
      live.delete(handle)
      clock.timers.clearTimeout(handle)
    },
    setInterval(fn, ms, ...args) {
      const handle = clock.timers.setInterval(fn, ms, ...args)
      live.add(handle)
      return handle
    },
    clearInterval(handle) {
      live.delete(handle)
      clock.timers.clearInterval(handle)
    }
  }
  const frames = new Map()
  let next = 1
  const raf = fn => {
    const handle = next++
    frames.set(handle, fn)
    return handle
  }
  const cancelRaf = handle => {
    frames.delete(handle)
  }
  const draws = []
  const draw = parts => {
    draws.push({ at: clock.now(), parts })
  }
  const stage = createStage({ draw, raf, cancelRaf, timers, now: clock.now })
  const display = () => {
    const due = [...frames.entries()]
    frames.clear()
    for (const [, fn] of due) fn(clock.now())
  }
  /** Moves the clock by `ms`: timers first, then the frame callbacks queued so far, once per display tick. */
  const run = ms => {
    for (let left = ms; left > 0; left -= TICK) {
      clock.advance(Math.min(TICK, left))
      display()
    }
  }
  return {
    stage,
    clock,
    draws,
    run,
    timers: () => live.size,
    frames: () => frames.size,
    count: () => draws.length
  }
}

// ---------------------------------------------------------------- the frame budget
test('the frame interval is 33 ms', () => {
  assert.equal(FRAME_MS, 33)
})

test('a stage created and left alone draws nothing and holds nothing pending', () => {
  const r = rig()
  r.run(5000)
  assert.equal(r.count(), 0)
  assert.equal(r.timers(), 0)
  assert.equal(r.frames(), 0)
})

test('every frame is drawn with the parts of the model at that moment', () => {
  const r = rig()
  r.stage.tell({ listening: true })
  r.run(100)
  assert.equal(r.count(), 1)
  assert.deepEqual(r.draws[0].parts, scene(r.stage.model, r.draws[0].at))
  assert.ok(r.draws[0].parts.some(p => p.id === 'balance'))
})

// voice-stage: "Idle and listening".
test('idle and listening for ten seconds with no other change draws ten or eleven frames', () => {
  const r = rig()
  r.stage.tell({ listening: true })
  r.run(10000)
  assert.ok(r.count() >= 10 && r.count() <= 11, `${r.count()} frames`)
})

test('while a stepped part is live there is one timeout and no animation loop', () => {
  const r = rig()
  r.stage.tell({ listening: true })
  r.run(100)
  assert.equal(r.frames(), 0, 'no frame request is pending between beats')
  assert.equal(r.timers(), 1, 'one timeout waits for the next beat')
  r.run(2000)
  assert.equal(r.frames(), 0)
  assert.equal(r.timers(), 1)
})

// voice-stage: "Thinking".
test('a second of thinking draws at most 30 frames and does draw', () => {
  const r = rig()
  r.stage.tell({ state: 'thinking' })
  r.run(1000)
  assert.ok(r.count() <= 30, `${r.count()} frames`)
  assert.ok(r.count() >= 10, `${r.count()} frames: the train is drawn as it turns`)
})

test('no two frames are less than 33 ms apart while the train runs', () => {
  const r = rig()
  r.stage.tell({ state: 'thinking' })
  r.run(3000)
  for (let i = 1; i < r.draws.length; i++) {
    assert.ok(r.draws[i].at - r.draws[i - 1].at >= FRAME_MS, `frames ${i - 1} and ${i}`)
  }
})

test('the train goes on drawing for as long as it runs', () => {
  const r = rig()
  r.stage.tell({ state: 'speaking' })
  r.run(30000)
  assert.ok(r.count() <= 30 * 30, `${r.count()} frames`)
  assert.ok(r.count() >= 300, `${r.count()} frames`)
  assert.equal(r.frames(), 1, 'one frame request is pending after each frame')
})

test('the train stops drawing when the state leaves thinking', () => {
  const r = rig()
  r.stage.tell({ state: 'thinking' })
  r.run(500)
  r.stage.tell({ state: 'idle' })
  r.run(100)
  const settled = r.count()
  r.run(10000)
  assert.equal(r.count(), settled)
  assert.equal(r.frames(), 0)
  assert.equal(r.timers(), 0)
})

// voice-stage: "Nothing is live".
test('with listening muted, no session working and no proposal open no frame is drawn and nothing is pending', () => {
  const r = rig()
  r.stage.tell({ listening: true })
  r.run(2500)
  r.stage.tell({ listening: false })
  r.run(100)
  const settled = r.count()
  assert.equal(r.timers(), 0, 'no timer is pending')
  assert.equal(r.frames(), 0, 'no frame request is pending')
  r.run(60000)
  assert.equal(r.count(), settled, 'no frame is drawn until something changes')
  r.stage.tell({ words: 3 })
  r.run(100)
  assert.equal(r.count(), settled + 1, 'a change draws one frame')
})

// voice-stage: "A working session while muted".
test('while muted with one working session one frame a second is drawn', () => {
  const r = rig()
  r.stage.tell({ sessions: ['working'] })
  r.run(10000)
  assert.ok(r.count() >= 10 && r.count() <= 11, `${r.count()} frames`)
})

test('an open proposal draws one frame a second and none after it closes', () => {
  const r = rig()
  r.stage.tell({ proposal: { seconds: 120, secondsLeft: 120 } })
  r.run(10000)
  assert.ok(r.count() >= 10 && r.count() <= 11, `${r.count()} frames`)
  r.stage.tell({ proposal: null })
  r.run(100)
  const settled = r.count()
  r.run(20000)
  assert.equal(r.count(), settled)
})

// voice-stage: "Several changes at once".
test('three changes before the next frame draw one frame', () => {
  const r = rig()
  r.stage.tell({ heard: true })
  r.stage.tell({ words: 2 })
  r.stage.tell({ words: 4 })
  r.run(500)
  assert.equal(r.count(), 1)
  assert.deepEqual(r.stage.model, reduce(reduce(reduce(restModel(), { heard: true }, 0), { words: 2 }, 0), { words: 4 }, 0))
})

test('a change draws exactly one frame and none on a timer', () => {
  const r = rig()
  r.stage.tell({ sentence: true })
  r.run(100)
  assert.equal(r.count(), 1)
  r.run(20000)
  assert.equal(r.count(), 1)
  r.stage.tell({ sentence: true })
  r.run(100)
  assert.equal(r.count(), 2)
})

// voice-stage: "A hidden window".
test('while hidden nothing is drawn and nothing is pending, and showing the window draws one frame at once', () => {
  const r = rig()
  r.stage.tell({ state: 'thinking' })
  r.run(500)
  r.stage.hidden(true)
  assert.equal(r.frames(), 0)
  assert.equal(r.timers(), 0)
  const hiddenAt = r.count()
  r.run(5000)
  assert.equal(r.count(), hiddenAt, 'no frame while hidden')
  assert.equal(r.frames(), 0)
  assert.equal(r.timers(), 0)
  r.stage.hidden(false)
  r.run(TICK)
  assert.equal(r.count(), hiddenAt + 1, 'one frame as soon as the window shows')
  r.run(1000)
  assert.ok(r.count() > hiddenAt + 10, 'and the train goes on drawing')
})

test('a change while hidden is kept in the model and draws nothing until the window shows', () => {
  const r = rig()
  r.stage.tell({ listening: true })
  r.run(200)
  r.stage.hidden(true)
  const hiddenAt = r.count()
  r.stage.tell({ sessions: ['blocked'] })
  r.run(3000)
  assert.equal(r.count(), hiddenAt)
  assert.equal(r.frames(), 0)
  assert.equal(r.timers(), 0)
  r.stage.hidden(false)
  r.run(TICK)
  assert.equal(r.count(), hiddenAt + 1)
  assert.ok(r.draws.at(-1).parts.some(p => p.id === 'sub-0-hand'), 'the frame shows the change')
})

test('a window that is hidden and shown while nothing is live draws one frame and nothing more', () => {
  const r = rig()
  r.stage.tell({ sentence: true })
  r.run(100)
  r.stage.hidden(true)
  r.stage.hidden(false)
  r.run(100)
  assert.equal(r.count(), 2)
  r.run(10000)
  assert.equal(r.count(), 2)
})

// voice-stage: "The setting turns on".
test('reduced motion turning on while the train runs draws one frame and leaves nothing pending', () => {
  const r = rig()
  r.stage.tell({ state: 'thinking' })
  r.run(300)
  const before = r.count()
  r.stage.tell({ reduced: true })
  r.run(2000)
  assert.equal(r.count(), before + 1)
  assert.equal(r.frames(), 0)
  assert.equal(r.timers(), 0)
  r.run(30000)
  assert.equal(r.count(), before + 1)
})

test('with reduced motion on every change draws one frame and none on a timer, whatever is live', () => {
  const r = rig()
  r.stage.tell({ reduced: true })
  r.run(100)
  assert.equal(r.count(), 1)
  r.stage.tell({ listening: true })
  r.run(5000)
  assert.equal(r.count(), 2)
  r.stage.tell({ sessions: ['working'] })
  r.stage.tell({ proposal: { seconds: 120, secondsLeft: 100 } })
  r.run(5000)
  assert.equal(r.count(), 3)
  assert.equal(r.frames(), 0)
  assert.equal(r.timers(), 0)
})

// voice-stage: "The setting turns off".
test('reduced motion turning off while the state is thinking runs the train again', () => {
  const r = rig()
  r.stage.tell({ reduced: true })
  r.stage.tell({ state: 'thinking' })
  r.run(1000)
  const still = r.count()
  assert.ok(still <= 2, `${still} frames while reduced`)
  assert.equal(r.frames(), 0)
  r.stage.tell({ reduced: false })
  r.run(1000)
  assert.equal(cadence(r.stage.model), 'run')
  const drawn = r.count() - still
  assert.ok(drawn >= 10 && drawn <= 30, `${drawn} frames in a second of the train running`)
  assert.equal(r.frames(), 1)
})

// ---------------------------------------------------------------- stop
test('stop cancels everything for good', () => {
  const r = rig()
  r.stage.tell({ state: 'thinking' })
  r.stage.tell({ sessions: ['working'] })
  r.run(500)
  r.stage.stop()
  assert.equal(r.frames(), 0)
  assert.equal(r.timers(), 0)
  const stopped = r.count()
  r.run(5000)
  assert.equal(r.count(), stopped)
  r.stage.tell({ sentence: true })
  r.stage.hidden(false)
  r.run(5000)
  assert.equal(r.count(), stopped, 'a stopped stage draws nothing more')
  assert.equal(r.frames(), 0)
  assert.equal(r.timers(), 0)
})

test('stop on a stage that ticks leaves nothing pending', () => {
  const r = rig()
  r.stage.tell({ listening: true })
  r.run(2500)
  r.stage.stop()
  assert.equal(r.timers(), 0)
  assert.equal(r.frames(), 0)
})

// ---------------------------------------------------------------- paint
const TONES = {
  ground: 'tone:ground',
  live: 'tone:live',
  rest: 'tone:rest',
  accent: 'tone:accent',
  ok: 'tone:ok',
  fail: 'tone:fail'
}
const STYLES = new Set(Object.values(TONES))
const METHODS = [
  'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'ellipse', 'rect', 'bezierCurveTo',
  'quadraticCurveTo', 'fill', 'stroke', 'clip', 'translate', 'rotate', 'scale', 'transform', 'setTransform',
  'resetTransform', 'setLineDash', 'clearRect', 'fillRect', 'strokeRect'
]

/**
 * A recording 2D context. It has the path, fill, stroke and transform calls and no gradient, no text and no
 * `Path2D`: a call to anything else is a TypeError, and `fillText` and `strokeText` throw by name.
 */
function recordingContext() {
  const calls = []
  const sets = []
  const target = {
    fillText() {
      throw new Error('paint drew text with fillText')
    },
    strokeText() {
      throw new Error('paint drew text with strokeText')
    }
  }
  for (const name of METHODS) {
    target[name] = (...args) => {
      calls.push([name, ...args])
    }
  }
  const ctx = new Proxy(target, {
    set(object, prop, value) {
      sets.push([prop, value])
      object[prop] = value
      return true
    }
  })
  return { ctx, calls, sets }
}

const count = (calls, name) => calls.filter(c => c[0] === name).length

/** The model of each of the twelve boards of .claude/handoff/design-prompt-voice-stage.md, with the time to read it at. */
const BOARDS = [
  ['1 not started', restModel(), 0],
  ['2 listening', reduce(restModel(), { listening: true }, 0), 1500],
  ['3 listening, muted', reduce(reduce(restModel(), { listening: true }, 0), { listening: false }, 1500), 4000],
  ['4 thinking', reduce(restModel(), { state: 'thinking' }, 0), 2300],
  [
    '5 speaking',
    [{ state: 'speaking' }, { sentence: true }, { sentence: true }].reduce((m, c) => reduce(m, c, 0), restModel()),
    2300
  ],
  ['6 refused', reduce(restModel(), { state: 'refused' }, 0), 100],
  ['7 typed only', reduce(restModel(), { state: 'idle' }, 0), 100],
  ['8 closed', reduce(restModel(), { closed: true }, 0), 100],
  ['9 proposal open, not read', reduce(restModel(), { proposal: { seconds: 120, secondsLeft: 120 } }, 0), 30000],
  ['10 proposal open and read', reduce(restModel(), { proposal: { seconds: 120, secondsLeft: 75 } }, 0), 10000],
  [
    '11 four sessions',
    [{ listening: true }, { sessions: ['working', 'working', 'blocked', 'done'] }].reduce((m, c) => reduce(m, c, 0), restModel()),
    7000
  ],
  [
    '12 a log panel open over four sessions',
    [{ heard: true }, { words: 6 }, { sessions: ['working', 'working', 'blocked', 'done'] }, { sessions: ['working', 'working', 'blocked', 'done', 'failed'] }].reduce((m, c) => reduce(m, c, 0), restModel()),
    7000
  ]
]

for (const [name, model, at] of BOARDS) {
  // voice-stage: "The mechanism holds no text" (the painter's part: it calls neither fillText nor strokeText).
  test(`paint draws board ${name} without throwing, without text and with save and restore balanced`, () => {
    const parts = scene(model, at)
    const snapshot = structuredClone(parts)
    const { ctx, calls } = recordingContext()
    paint(ctx, parts, { width: 1440, height: 900, tones: TONES })
    assert.ok(count(calls, 'fill') + count(calls, 'stroke') > 0, 'something is drawn')
    assert.equal(count(calls, 'save'), count(calls, 'restore'), 'save and restore are balanced')
    let depth = 0
    for (const [call] of calls) {
      if (call === 'save') depth++
      if (call === 'restore') depth--
      assert.ok(depth >= 0, 'restore never comes before its save')
    }
    assert.deepEqual(parts, snapshot, 'paint does not change the parts')
  })

  test(`paint sets a style on board ${name} only to one of the given tones`, () => {
    const { ctx, sets } = recordingContext()
    paint(ctx, scene(model, at), { width: 2560, height: 1600, tones: TONES })
    const styles = sets.filter(([prop]) => prop === 'fillStyle' || prop === 'strokeStyle')
    assert.ok(styles.length > 0, 'paint sets colours')
    for (const [prop, value] of styles) assert.ok(STYLES.has(value), `${prop} was set to ${String(value)}`)
  })
}

test('paint draws the same parts the same way twice', () => {
  const [, model, at] = BOARDS[10]
  const parts = scene(model, at)
  const first = recordingContext()
  const second = recordingContext()
  paint(first.ctx, parts, { width: 1440, height: 900, tones: TONES })
  paint(second.ctx, parts, { width: 1440, height: 900, tones: TONES })
  assert.deepEqual(second.calls, first.calls)
  assert.deepEqual(second.sets, first.sets)
})

test('paint draws a different picture when a session is blocked and when it is done', () => {
  const draw = states => {
    const { ctx, calls, sets } = recordingContext()
    paint(ctx, scene(reduce(restModel(), { sessions: states }, 0), 0), { width: 1440, height: 900, tones: TONES })
    return JSON.stringify([calls, sets])
  }
  assert.notEqual(draw(['blocked']), draw(['done']))
  assert.notEqual(draw(['blocked']), draw([]))
})

test('the recording context really throws on text, so the check above would catch it', () => {
  const { ctx } = recordingContext()
  assert.throws(() => ctx.fillText('x', 0, 0), /fillText/)
  assert.throws(() => ctx.strokeText('x', 0, 0), /strokeText/)
})
