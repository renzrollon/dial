import test from 'node:test'
import assert from 'node:assert/strict'
import { balanceSide, escapeAngle, gear, meshAngle } from '../lib/voice/gears.mjs'
import {
  BEAT_MS,
  MARK,
  MOVEMENT,
  NOTCH,
  SUB_DIALS,
  SUB_MARKS,
  TRAIN_RATE,
  WORDS_PER_NOTCH,
  cadence,
  reduce,
  restModel,
  scene
} from '../lib/voice/scene.mjs'

// The movement of the voice stage (voice-stage delta, design §4, §5, §14). lib/voice/scene.mjs does not exist yet:
// every case here fails until task 2.3 adds it. Models are built only through `reduce`; parts are read by id.
//
// The end of an utterance is not one change in design §14, so a test that needs one sends both ways the page can say
// it, `{ heard: false }` and `{ words: 0 }`, and a test that starts one sends `{ heard: true }`.

const TAU = 2 * Math.PI
const deg = x => (x * Math.PI) / 180
const wrap = a => {
  let d = a % TAU
  if (d > Math.PI) d -= TAU
  if (d <= -Math.PI) d += TAU
  return d
}
const near = (actual, expected, eps, what = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what} ${actual} is not within ${eps} of ${expected}`)
const nearAngle = (actual, expected, eps, what = '') => near(wrap(actual - expected), 0, eps, what)

/** A model built through reduce from `[change, atMs]` pairs. */
const build = (steps, from = restModel()) => steps.reduce((model, [change, at]) => reduce(model, change, at), from)
const partsOf = (model, atMs) => scene(model, atMs)
const find = (parts, id) => parts.find(p => p.id === id)
const get = (model, atMs, id) => find(scene(model, atMs), id)
const angleAt = (model, atMs, id) => get(model, atMs, id).angle
/** Where the balance, the lever and the escape wheel stand. */
const escapement = (model, atMs) => ['escape', 'lever', 'balance'].map(id => get(model, atMs, id).angle)
const endUtterance = at => [[{ heard: false }, at], [{ words: 0 }, at]]
const train = ['train-1', 'train-2', 'train-3', 'train-4']
const gearOf = i => gear(MOVEMENT.train[i].teeth, MOVEMENT.module)
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

// ---------------------------------------------------------------- the constants
test('the constants of the movement', () => {
  assert.equal(BEAT_MS, 1000)
  assert.equal(WORDS_PER_NOTCH, 3)
  near(NOTCH, deg(15), 1e-12)
  near(MARK, deg(6), 1e-12)
  assert.equal(SUB_DIALS, 12)
  assert.ok(Number.isFinite(TRAIN_RATE) && TRAIN_RATE > 0, 'the first wheel of the train turns forwards at a fixed rate')
})

test('the four marks of a sub-dial are four different angles', () => {
  assert.deepEqual(Object.keys(SUB_MARKS).sort(), ['blocked', 'done', 'failed', 'working'])
  const marks = Object.values(SUB_MARKS)
  assert.ok(marks.every(Number.isFinite))
  assert.equal(new Set(marks).size, 4)
})

// ---------------------------------------------------------------- the layout
// voice-stage: "Every pair of the train sits at its centre distance".
test('the train is four wheels of one module and every meshing pair sits at its centre distance', () => {
  assert.equal(MOVEMENT.train.length, 4)
  assert.deepEqual(
    MOVEMENT.train.map(w => w.id),
    train
  )
  assert.ok(Number.isFinite(MOVEMENT.module) && MOVEMENT.module > 0)
  for (let i = 0; i + 1 < 4; i++) {
    const [a, b] = [MOVEMENT.train[i], MOVEMENT.train[i + 1]]
    const distance = Math.hypot(b.x - a.x, b.y - a.y)
    near(distance, gearOf(i).pitch + gearOf(i + 1).pitch, 1e-9, `${a.id} meshes ${b.id}`)
  }
})

test('two wheels of the train that do not mesh are farther apart than the sum of their tip radii', () => {
  for (const [i, j] of [[0, 2], [0, 3], [1, 3]]) {
    const [a, b] = [MOVEMENT.train[i], MOVEMENT.train[j]]
    const distance = Math.hypot(b.x - a.x, b.y - a.y)
    assert.ok(distance > gearOf(i).tip + gearOf(j).tip, `${a.id} and ${b.id} clear each other`)
  }
})

test('the same holds for the parts scene gives, read by id', () => {
  const parts = partsOf(restModel(), 0)
  for (let i = 0; i + 1 < 4; i++) {
    const [a, b] = [find(parts, train[i]), find(parts, train[i + 1])]
    near(Math.hypot(b.x - a.x, b.y - a.y), gearOf(i).pitch + gearOf(i + 1).pitch, 1e-9, `${a.id} meshes ${b.id}`)
    assert.equal(a.teeth, MOVEMENT.train[i].teeth)
    assert.equal(a.module, MOVEMENT.module)
  }
})

test('the movement holds one escape wheel of 15 teeth, a lever, a balance, a barrel, a hand, a reserve and twelve sub-dials', () => {
  assert.equal(MOVEMENT.escape.teeth, 15)
  assert.ok(MOVEMENT.balance.amplitude > 0)
  assert.equal(MOVEMENT.subs.length, 12)
  for (const key of ['lever', 'balance', 'barrel', 'hand', 'reserve']) {
    assert.ok(Number.isFinite(MOVEMENT[key].x) && Number.isFinite(MOVEMENT[key].y), key)
  }
  assert.ok(Number.isInteger(MOVEMENT.barrel.teeth))
})

test('the movement fits a box 1000 wide and 1000 high', () => {
  const inside = (id, x, y, r) => {
    assert.ok(x - r >= 0 && x + r <= 1000 && y - r >= 0 && y + r <= 1000, `${id} lies inside the box`)
  }
  for (const [i, w] of MOVEMENT.train.entries()) inside(w.id, w.x, w.y, gearOf(i).tip)
  inside('barrel', MOVEMENT.barrel.x, MOVEMENT.barrel.y, gear(MOVEMENT.barrel.teeth, MOVEMENT.module).tip)
  for (const key of ['escape', 'balance', 'hand', 'reserve']) inside(key, MOVEMENT[key].x, MOVEMENT[key].y, MOVEMENT[key].r)
  for (const [i, sub] of MOVEMENT.subs.entries()) inside(`sub-${i}`, sub.x, sub.y, sub.r)
})

// ---------------------------------------------------------------- the parts
const PART_KEYS = new Set(['id', 'kind', 'x', 'y', 'r', 'angle', 'tone', 'teeth', 'module', 'share'])
const KINDS = new Set(['gear', 'escape', 'lever', 'balance', 'hand', 'arc', 'dial'])
const TONES = new Set(['live', 'rest', 'accent', 'ok', 'fail'])
const ID = /^(barrel|train-[1-4]|escape|lever|balance|hand|reserve|sub-(?:[0-9]|1[01])|sub-(?:[0-9]|1[01])-hand)$/

// voice-stage design §14: "A part holds numbers and these fixed strings only."
test('every part holds numbers and the fixed ids, kinds and tones only, in every state', () => {
  const models = [
    restModel(),
    build([[{ listening: true }, 0]]),
    build([[{ state: 'thinking' }, 0], [{ words: 5 }, 0], [{ sentence: true }, 10]]),
    build([[{ sessions: ['working', 'blocked', 'done', 'failed', 'stopped', '<img src=x>'] }, 0], [{ proposal: { seconds: 120, secondsLeft: 90 } }, 5]]),
    build([[{ closed: true }, 0]]),
    build([[{ reduced: true }, 0], [{ state: 'speaking' }, 0], [{ sessions: ['working'] }, 0]])
  ]
  for (const model of models) {
    for (const atMs of [0, 1500, 61234]) {
      const parts = partsOf(model, atMs)
      assert.ok(Array.isArray(parts))
      for (const part of parts) {
        for (const [key, value] of Object.entries(part)) {
          assert.ok(PART_KEYS.has(key), `${part.id} has the unexpected key ${key}`)
          if (key === 'id') assert.match(value, ID)
          else if (key === 'kind') assert.ok(KINDS.has(value), `${part.id}: kind ${value}`)
          else if (key === 'tone') assert.ok(TONES.has(value), `${part.id}: tone ${value}`)
          else assert.ok(typeof value === 'number' && Number.isFinite(value), `${part.id}.${key} is a finite number`)
        }
        for (const key of ['id', 'kind', 'x', 'y', 'r', 'angle', 'tone']) assert.ok(key in part, `${part.id} has ${key}`)
        if ('share' in part) {
          assert.equal(part.id, 'reserve')
          assert.ok(part.share >= 0 && part.share <= 1)
        }
      }
    }
  }
})

test('the part ids are unique and the ones of a rest model are the movement and the twelve sub-dials', () => {
  const parts = partsOf(restModel(), 0)
  const ids = parts.map(p => p.id)
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
  const expected = ['barrel', ...train, 'escape', 'lever', 'balance', 'hand', 'reserve', ...Array.from({ length: 12 }, (_, i) => `sub-${i}`)]
  assert.deepEqual([...ids].sort(), [...expected].sort())
  const kinds = Object.fromEntries(parts.map(p => [p.id, p.kind]))
  assert.equal(kinds.barrel, 'gear')
  for (const id of train) assert.equal(kinds[id], 'gear')
  assert.equal(kinds.escape, 'escape')
  assert.equal(kinds.lever, 'lever')
  assert.equal(kinds.balance, 'balance')
  assert.equal(kinds.hand, 'hand')
  assert.equal(kinds.reserve, 'arc')
  for (let i = 0; i < 12; i++) assert.equal(kinds[`sub-${i}`], 'dial')
  assert.equal(find(parts, 'escape').teeth, 15)
})

test('ids stay unique when sub-dials carry hands', () => {
  const model = build([[{ sessions: Array(15).fill('working') }, 0]])
  const ids = partsOf(model, 3000).map(p => p.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('scene is a pure function of the model and the time', () => {
  const model = build([[{ listening: true }, 0], [{ sessions: ['working', 'blocked'] }, 0]])
  assert.deepEqual(scene(model, 4321), scene(model, 4321))
})

// ---------------------------------------------------------------- reduce
test('reduce leaves the given model as it is, frozen or not', () => {
  const model = deepFreeze(build([[{ listening: true }, 0], [{ state: 'thinking' }, 100], [{ sessions: ['working'] }, 100]]))
  const changes = [
    { state: 'speaking' },
    { listening: false },
    { heard: true },
    { words: 9 },
    { sentence: true },
    { turn: true },
    { sessions: ['done', 'failed'] },
    { proposal: { seconds: 120, secondsLeft: 100 } },
    { proposal: null },
    { closed: true },
    { reduced: true }
  ]
  for (const change of changes) {
    // a frozen model throws in strict mode if reduce writes to it
    assert.ok(reduce(model, change, 5000), `${JSON.stringify(change)} gives a model`)
  }
})

test('reduce returns the model for a change it does not know', () => {
  const model = build([[{ listening: true }, 0]])
  assert.equal(reduce(model, { nonsense: 1 }, 10), model)
  assert.equal(reduce(model, {}, 10), model)
})

// ---------------------------------------------------------------- the escapement
// voice-stage: "The balance beats while Dial can hear the owner" / "Listening".
test('while recognition runs the escape wheel advances half a tooth at each beat and the balance changes side', () => {
  const model = build([[{ listening: true }, 0]])
  const escape0 = angleAt(model, 0, 'escape')
  for (const beats of [1, 2, 3, 7]) {
    nearAngle(angleAt(model, beats * BEAT_MS, 'escape') - escape0, escapeAngle(15, beats), 1e-9, `${beats} beats`)
  }
  for (const beats of [0, 1, 2, 3, 4]) {
    near(angleAt(model, beats * BEAT_MS + 300, 'balance'), balanceSide(beats) * MOVEMENT.balance.amplitude, 1e-9, `beat ${beats}`)
  }
})

// voice-stage: "Two beats pass one tooth".
test('two beats advance the escape wheel by 24 degrees', () => {
  const model = build([[{ listening: true }, 2000]])
  nearAngle(angleAt(model, 4000, 'escape') - angleAt(model, 2000, 'escape'), deg(24), 1e-9)
})

// voice-stage: "The balance changes side".
test('three beats put the balance on plus, minus and plus its amplitude with the lever on the same side each time', () => {
  const model = build([[{ listening: true }, 0]])
  const amplitude = MOVEMENT.balance.amplitude
  const sides = [0, 1, 2].map(beat => angleAt(model, beat * BEAT_MS + 100, 'balance'))
  near(sides[0], amplitude, 1e-9)
  near(sides[1], -amplitude, 1e-9)
  near(sides[2], amplitude, 1e-9)
  const lever = [0, 1, 2].map(beat => angleAt(model, beat * BEAT_MS + 100, 'lever'))
  assert.equal(lever[0], lever[2])
  assert.notEqual(lever[0], lever[1])
})

// voice-stage: "Still between beats".
test('the escape wheel, the lever and the balance stand at the same angles 0.2 and 0.9 seconds after a beat', () => {
  const model = build([[{ listening: true }, 5000]])
  for (const beat of [5000, 6000, 8000]) {
    assert.deepEqual(escapement(model, beat + 200), escapement(model, beat + 900), `after the beat at ${beat}`)
  }
  // and the beat itself moves them
  assert.notDeepEqual(escapement(model, 5900), escapement(model, 6100))
})

// voice-stage: "Muted".
test('muting stands the balance, the lever and the escape wheel still from that moment', () => {
  const running = build([[{ listening: true }, 0]])
  const muted = reduce(running, { listening: false }, 2500)
  const at = escapement(running, 2500)
  assert.deepEqual(escapement(muted, 2500), at)
  assert.deepEqual(escapement(muted, 2600), at)
  assert.deepEqual(escapement(muted, 9000), at)
  assert.deepEqual(escapement(muted, 600000), at)
})

// voice-stage: "Dial is speaking".
test('the balance stands still while Dial speaks with recognition stopped and moves when recognition runs again', () => {
  const model = build([
    [{ listening: true }, 0],
    [{ listening: false }, 2200],
    [{ state: 'speaking' }, 2200]
  ])
  const standing = escapement(model, 2200)
  assert.deepEqual(escapement(model, 9000), standing)
  const again = build([[{ state: 'idle' }, 10000], [{ listening: true }, 10000]], model)
  assert.notDeepEqual(escapement(again, 12000), escapement(again, 10000))
})

// voice-stage: "Typed turns only" and "Before the first click".
test('a page that was not started, or has no recognition, never moves the balance', () => {
  for (const model of [restModel(), build([[{ state: 'idle' }, 0]])]) {
    assert.deepEqual(escapement(model, 0), escapement(model, 1000))
    assert.deepEqual(escapement(model, 0), escapement(model, 987654))
  }
})

test('a page that has closed stands the balance still even if recognition was running', () => {
  const model = build([[{ listening: true }, 0], [{ closed: true }, 2500]])
  assert.deepEqual(escapement(model, 2500), escapement(model, 80000))
})

// voice-stage: "A part that stops keeps its place" / "The escape wheel after a pause".
test('the escape wheel stands where it stood after a pause and goes on from there', () => {
  const stopped = build([[{ listening: true }, 0], [{ listening: false }, 5500]])
  const before = angleAt(stopped, 5500, 'escape')
  const resumed = reduce(stopped, { listening: true }, 65500)
  nearAngle(angleAt(resumed, 65500, 'escape'), before, 1e-9, 'at the moment it runs again')
  nearAngle(angleAt(resumed, 65500 + 1000, 'escape'), before + escapeAngle(15, 1), 1e-9, 'a beat later')
  nearAngle(angleAt(resumed, 65500 + 3000, 'escape'), before + escapeAngle(15, 3), 1e-9, 'three beats later')
  assert.deepEqual(escapement(stopped, 60000), escapement(stopped, 5500), 'and stood there for the minute')
})

// ---------------------------------------------------------------- the barrel
const barrel = (model, at = 0) => angleAt(model, at, 'barrel')

// voice-stage: "Seven words".
test('a transcript of seven words winds the barrel two notches', () => {
  const rest = restModel()
  const model = build([[{ heard: true }, 0], [{ words: 7 }, 10]])
  nearAngle(barrel(model) - barrel(rest), 2 * NOTCH, 1e-9)
  nearAngle(barrel(model) - barrel(rest), deg(30), 1e-9)
})

test('the barrel advances one notch for each three words as the transcript grows', () => {
  const rest = barrel(restModel())
  let model = build([[{ heard: true }, 0]])
  for (const [words, notches] of [[1, 0], [2, 0], [3, 1], [5, 1], [6, 2], [9, 3]]) {
    model = reduce(model, { words }, 100 + words)
    nearAngle(barrel(model) - rest, notches * NOTCH, 1e-9, `${words} words`)
  }
})

// voice-stage: "A second utterance".
test('a second utterance counts from its start: seven words, then four, wind three notches in all', () => {
  const rest = barrel(restModel())
  let model = build([[{ heard: true }, 0], [{ words: 7 }, 10], ...endUtterance(20)])
  nearAngle(barrel(model) - rest, 2 * NOTCH, 1e-9, 'the end of an utterance does not unwind')
  model = build([[{ heard: true }, 30], [{ words: 4 }, 40]], model)
  nearAngle(barrel(model) - rest, 3 * NOTCH, 1e-9)
})

// voice-stage: "A revised transcript does not unwind".
test('a transcript revised from seven words to five leaves the barrel where it was', () => {
  const rest = barrel(restModel())
  const seven = build([[{ heard: true }, 0], [{ words: 7 }, 10]])
  const five = reduce(seven, { words: 5 }, 20)
  nearAngle(barrel(five) - rest, 2 * NOTCH, 1e-9)
  const three = reduce(five, { words: 3 }, 30)
  nearAngle(barrel(three) - rest, 2 * NOTCH, 1e-9)
})

test('the barrel does not depend on the time it is read at', () => {
  const model = build([[{ heard: true }, 0], [{ words: 7 }, 10]])
  assert.equal(barrel(model, 0), barrel(model, 77777))
})

// ---------------------------------------------------------------- the going train
const trainAngles = (model, at) => train.map(id => angleAt(model, at, id))

// voice-stage: "The train follows its first wheel".
test('each later wheel of the train stands in mesh with the wheel that drives it, whatever the first wheel stands at', () => {
  const model = build([[{ state: 'thinking' }, 0]])
  for (const at of [0, 333, 777, 1500, 3333, 10000]) {
    const angles = trainAngles(model, at)
    for (let i = 1; i < 4; i++) {
      const [a, b] = [MOVEMENT.train[i - 1], MOVEMENT.train[i]]
      const line = Math.atan2(b.y - a.y, b.x - a.x)
      nearAngle(angles[i], meshAngle(gearOf(i - 1), gearOf(i), angles[i - 1], line), 1e-9, `${train[i]} at ${at} ms`)
    }
  }
})

test('the train is in mesh at a standstill too', () => {
  const model = restModel()
  const angles = trainAngles(model, 0)
  for (let i = 1; i < 4; i++) {
    const [a, b] = [MOVEMENT.train[i - 1], MOVEMENT.train[i]]
    const line = Math.atan2(b.y - a.y, b.x - a.x)
    nearAngle(angles[i], meshAngle(gearOf(i - 1), gearOf(i), angles[i - 1], line), 1e-9, train[i])
  }
})

// voice-stage: "Thinking".
test('the first wheel has turned twice as far after four seconds of thinking as after two', () => {
  const model = build([[{ state: 'thinking' }, 1000]])
  const start = angleAt(model, 1000, 'train-1')
  nearAngle(angleAt(model, 3000, 'train-1') - start, 2 * TRAIN_RATE, 1e-9, 'after two seconds')
  nearAngle(angleAt(model, 5000, 'train-1') - start, 4 * TRAIN_RATE, 1e-9, 'after four seconds')
})

// voice-stage: "Speaking".
test('the train keeps turning at the same rate when the state goes from thinking to speaking', () => {
  const model = build([[{ state: 'thinking' }, 0], [{ state: 'speaking' }, 2000]])
  const start = angleAt(model, 0, 'train-1')
  nearAngle(angleAt(model, 2000, 'train-1') - start, 2 * TRAIN_RATE, 1e-9)
  nearAngle(angleAt(model, 4000, 'train-1') - start, 4 * TRAIN_RATE, 1e-9)
  nearAngle(angleAt(model, 7000, 'train-1') - start, 7 * TRAIN_RATE, 1e-9)
})

// voice-stage: "Idle".
test('no wheel of the train turns when the state is idle, refused or closed', () => {
  const idle = build([[{ state: 'thinking' }, 0], [{ state: 'idle' }, 3000]])
  const refused = build([[{ state: 'thinking' }, 0], [{ state: 'refused' }, 3000]])
  const closed = build([[{ state: 'thinking' }, 0], [{ closed: true }, 3000]])
  for (const [name, model] of [['idle', idle], ['refused', refused], ['closed', closed], ['rest', restModel()]]) {
    assert.deepEqual(trainAngles(model, 3000), trainAngles(model, 90000), name)
  }
})

// voice-stage: "The train after a pause".
test('every wheel of the train goes on from the angle it had after a pause of 30 seconds', () => {
  const paused = build([[{ state: 'thinking' }, 0], [{ state: 'idle' }, 3000]])
  const at = trainAngles(paused, 3000)
  const resumed = reduce(paused, { state: 'thinking' }, 33000)
  const now = trainAngles(resumed, 33000)
  for (let i = 0; i < 4; i++) nearAngle(now[i], at[i], 1e-9, `${train[i]} at the moment it runs again`)
  nearAngle(angleAt(resumed, 34000, 'train-1') - at[0], TRAIN_RATE, 1e-9, 'a second later')
  const later = trainAngles(resumed, 34000)
  for (let i = 1; i < 4; i++) {
    const [a, b] = [MOVEMENT.train[i - 1], MOVEMENT.train[i]]
    const line = Math.atan2(b.y - a.y, b.x - a.x)
    nearAngle(later[i], meshAngle(gearOf(i - 1), gearOf(i), later[i - 1], line), 1e-9, `${train[i]} stays in mesh`)
  }
})

// ---------------------------------------------------------------- the hand
const hand = (model, at = 0) => angleAt(model, at, 'hand')
const top = () => hand(restModel())

// voice-stage: "Three sentences".
test('three sentences put the hand 18 degrees past its top mark', () => {
  const model = build([[{ sentence: true }, 1], [{ sentence: true }, 2], [{ sentence: true }, 3]])
  nearAngle(hand(model) - top(), deg(18), 1e-9)
  nearAngle(hand(model) - top(), 3 * MARK, 1e-9)
})

test('the hand advances one mark for each sentence', () => {
  let model = restModel()
  for (let n = 1; n <= 6; n++) {
    model = reduce(model, { sentence: true }, n)
    nearAngle(hand(model) - top(), n * MARK, 1e-9, `${n} sentences`)
  }
})

// voice-stage: "The next turn".
test('a turn returns the hand to its top mark', () => {
  const model = build([[{ sentence: true }, 1], [{ sentence: true }, 2], [{ turn: true }, 3]])
  nearAngle(hand(model), top(), 1e-9)
})

// voice-stage: "Parked".
test('after a refusal or a close the hand is at its top mark and the balance stands still', () => {
  const sentences = [[{ sentence: true }, 1], [{ sentence: true }, 2]]
  const refused = build([...sentences, [{ state: 'refused' }, 3]])
  nearAngle(hand(refused, 3), top(), 1e-9, 'refused')
  const closed = build([[{ listening: true }, 0], ...sentences, [{ closed: true }, 2500]])
  nearAngle(hand(closed, 2500), top(), 1e-9, 'closed')
  assert.deepEqual(escapement(closed, 2500), escapement(closed, 70000), 'closed: the balance stands still')
})

test('the hand does not depend on the time it is read at', () => {
  const model = build([[{ sentence: true }, 1], [{ sentence: true }, 2]])
  assert.equal(hand(model, 0), hand(model, 54321))
})

// ---------------------------------------------------------------- the sub-dials
const subHand = (model, at, n) => find(scene(model, at), `sub-${n}-hand`)
const hands = (model, at) => scene(model, at).filter(p => /^sub-\d+-hand$/.test(p.id)).map(p => p.id)

// voice-stage: "Four sessions".
test('two working sessions, a blocked one and a done one show on the first four sub-dials in that order', () => {
  const model = build([[{ sessions: ['working', 'working', 'blocked', 'done'] }, 5000]])
  assert.deepEqual(hands(model, 5000), ['sub-0-hand', 'sub-1-hand', 'sub-2-hand', 'sub-3-hand'])
  assert.equal(subHand(model, 5000, 0).angle, subHand(model, 5000, 1).angle, 'working hands share one position')
  assert.equal(subHand(model, 5000, 2).angle, SUB_MARKS.blocked)
  assert.equal(subHand(model, 5000, 3).angle, SUB_MARKS.done)
  for (let n = 4; n < 12; n++) assert.equal(subHand(model, 5000, n), undefined, `sub-${n} is empty`)
  // all twelve sub-dials are still there
  assert.equal(scene(model, 5000).filter(p => p.kind === 'dial').length, 12)
})

test('the sub-dials follow the order of the list', () => {
  const model = build([[{ sessions: ['failed', 'done', 'working', 'blocked'] }, 5000]])
  assert.equal(subHand(model, 5000, 0).angle, SUB_MARKS.failed)
  assert.equal(subHand(model, 5000, 1).angle, SUB_MARKS.done)
  assert.equal(subHand(model, 5000, 3).angle, SUB_MARKS.blocked)
  assert.ok(subHand(model, 5000, 2))
})

// voice-stage: "Working".
test('the hand of a working session stands at a different angle one second later and steps once a second', () => {
  const model = build([[{ sessions: ['working'] }, 5000]])
  const angle = t => subHand(model, t, 0).angle
  assert.notEqual(angle(5000), angle(6000))
  assert.notEqual(angle(6000), angle(7000))
  // a step, not a sweep: it stands still within a second
  assert.equal(angle(5200), angle(5900))
  assert.equal(angle(6100), angle(6800))
})

test('working hands of different sessions share one position', () => {
  const model = build([[{ sessions: ['working', 'done', 'working'] }, 5000]])
  for (const t of [5000, 6000, 8300]) assert.equal(subHand(model, t, 0).angle, subHand(model, t, 2).angle, `at ${t}`)
})

// voice-stage: "Blocked needs the owner".
test('a blocked session rests at the blocked mark at any time and its sub-dial carries the accent tone', () => {
  const model = build([[{ sessions: ['working', 'blocked'] }, 5000]])
  for (const t of [5000, 5400, 9999, 123456]) assert.equal(subHand(model, t, 1).angle, SUB_MARKS.blocked, `at ${t}`)
  assert.equal(get(model, 5000, 'sub-1').tone, 'accent')
  assert.notEqual(get(model, 5000, 'sub-0').tone, 'accent')
})

// voice-stage: "Done and failed rest apart".
test('done and failed rest at two different marks and each mark is the same for every session in that state', () => {
  const model = build([[{ sessions: ['done', 'failed', 'done', 'failed'] }, 5000]])
  for (const t of [5000, 7777]) {
    assert.equal(subHand(model, t, 0).angle, SUB_MARKS.done)
    assert.equal(subHand(model, t, 2).angle, SUB_MARKS.done)
    assert.equal(subHand(model, t, 1).angle, SUB_MARKS.failed)
    assert.equal(subHand(model, t, 3).angle, SUB_MARKS.failed)
  }
  assert.notEqual(SUB_MARKS.done, SUB_MARKS.failed)
})

// voice-stage: "A state the stage does not know" and "A state name that looks like markup".
test('a session in a state the stage does not know has a sub-dial with no hand', () => {
  for (const state of ['stopped', 'unknown', 'paused']) {
    const model = build([[{ sessions: [state, 'working'] }, 5000]])
    assert.equal(subHand(model, 5000, 0), undefined, state)
    assert.ok(get(model, 5000, 'sub-0'), `${state} still has its sub-dial`)
    assert.ok(subHand(model, 5000, 1), 'the session after it is not shifted')
  }
})

test('a state name that looks like markup draws nothing of its characters and has no hand', () => {
  const model = build([[{ sessions: ['<img src=x>', '"><script>x</script>', 'working'] }, 5000]])
  const parts = scene(model, 5000)
  const text = JSON.stringify(parts)
  assert.doesNotMatch(text, /[<>=]/)
  assert.doesNotMatch(text, /img|script/)
  assert.equal(subHand(model, 5000, 0), undefined)
  assert.equal(subHand(model, 5000, 1), undefined)
  assert.ok(subHand(model, 5000, 2))
})

// voice-stage: "More sessions than sub-dials".
test('fifteen sessions fill the twelve sub-dials with the first twelve', () => {
  const states = Array.from({ length: 15 }, (_, i) => (i === 11 ? 'blocked' : i >= 12 ? 'failed' : 'done'))
  const model = build([[{ sessions: states }, 5000]])
  assert.equal(scene(model, 5000).filter(p => p.kind === 'dial').length, 12)
  assert.equal(hands(model, 5000).length, 12)
  assert.equal(subHand(model, 5000, 11).angle, SUB_MARKS.blocked, 'the twelfth is the twelfth of the list')
  assert.equal(find(scene(model, 5000), 'sub-12'), undefined)
  assert.equal(find(scene(model, 5000), 'sub-13-hand'), undefined)
})

test('no session leaves every sub-dial without a hand', () => {
  const model = build([[{ sessions: ['working'] }, 0], [{ sessions: [] }, 100]])
  assert.deepEqual(hands(model, 200), [])
})

// ---------------------------------------------------------------- the reserve
const share = (model, at) => get(model, at, 'reserve').share

// voice-stage: "A new proposal".
test('a new proposal of 120 seconds fills the arc and 30 seconds later it shows three quarters', () => {
  const model = build([[{ proposal: { seconds: 120, secondsLeft: 120 } }, 10000]])
  assert.equal(share(model, 10000), 1)
  near(share(model, 40000), 0.75, 1e-12)
  near(share(model, 70000), 0.5, 1e-12)
})

test('the arc drains by whole seconds', () => {
  const model = build([[{ proposal: { seconds: 120, secondsLeft: 120 } }, 10000]])
  assert.equal(share(model, 40000), share(model, 40999))
  assert.ok(share(model, 41000) < share(model, 40999))
})

// voice-stage: "A page that connected late".
test('a proposal that arrives with 20 seconds left of 120 shows one sixth', () => {
  const model = build([[{ proposal: { seconds: 120, secondsLeft: 20 } }, 3000]])
  near(share(model, 3000), 1 / 6, 1e-12)
  near(share(model, 13000), 10 / 120, 1e-12)
})

// voice-stage: "The proposal closes".
test('with no open proposal the arc is empty, and it empties when the proposal closes', () => {
  assert.equal(share(restModel(), 0), 0)
  const open = build([[{ proposal: { seconds: 120, secondsLeft: 60 } }, 0]])
  assert.ok(share(open, 0) > 0)
  assert.equal(share(reduce(open, { proposal: null }, 1000), 1000), 0)
  assert.equal(share(reduce(open, { proposal: null }, 1000), 90000), 0)
})

// voice-stage: "Time runs out before the event".
test('when more seconds have passed than the event carried the arc is empty and never negative', () => {
  const model = build([[{ proposal: { seconds: 120, secondsLeft: 20 } }, 0]])
  assert.equal(share(model, 20000), 0)
  assert.equal(share(model, 25000), 0)
  assert.equal(share(model, 9999999), 0)
})

test('the share of the reserve is always between 0 and 1', () => {
  const model = build([[{ proposal: { seconds: 120, secondsLeft: 120 } }, 0]])
  for (let t = 0; t < 200000; t += 7919) {
    const s = share(model, t)
    assert.ok(s >= 0 && s <= 1, `at ${t}: ${s}`)
  }
})

// ---------------------------------------------------------------- cadence
// voice-stage: "The stage draws only as often as its motion needs".
test('cadence is still for a page that was not started and for one with every motion stopped', () => {
  assert.equal(cadence(restModel()), 'still')
  assert.equal(cadence(build([[{ listening: true }, 0], [{ listening: false }, 100]])), 'still')
  assert.equal(cadence(build([[{ words: 4 }, 0], [{ sentence: true }, 0], [{ state: 'refused' }, 0]])), 'still')
  assert.equal(cadence(build([[{ sessions: ['blocked', 'done', 'failed', 'stopped'] }, 0]])), 'still')
})

test('cadence is run while the train turns', () => {
  assert.equal(cadence(build([[{ state: 'thinking' }, 0]])), 'run')
  assert.equal(cadence(build([[{ state: 'speaking' }, 0]])), 'run')
  assert.equal(cadence(build([[{ state: 'thinking' }, 0], [{ sessions: ['working'] }, 0]])), 'run')
})

test('cadence is tick while the balance beats, a session works or a proposal is open and the train stands', () => {
  assert.equal(cadence(build([[{ listening: true }, 0]])), 'tick')
  assert.equal(cadence(build([[{ sessions: ['done', 'working'] }, 0]])), 'tick')
  assert.equal(cadence(build([[{ proposal: { seconds: 120, secondsLeft: 120 } }, 0]])), 'tick')
  assert.equal(cadence(build([[{ listening: true }, 0], [{ sessions: ['working'] }, 0]])), 'tick')
})

test('cadence goes back to still when the stepped part stops', () => {
  const model = build([[{ listening: true }, 0], [{ sessions: ['working'] }, 0], [{ proposal: { seconds: 120, secondsLeft: 100 } }, 0]])
  assert.equal(cadence(model), 'tick')
  const stopped = build([[{ listening: false }, 10], [{ sessions: ['done'] }, 10], [{ proposal: null }, 10]], model)
  assert.equal(cadence(stopped), 'still')
})

test('a page that has closed does not tick', () => {
  assert.equal(cadence(build([[{ listening: true }, 0], [{ closed: true }, 10]])), 'still')
})

// voice-stage: "Reduced motion stops all animation".
test('cadence is still in every state while reduced motion is on', () => {
  const reduced = changes => build([[{ reduced: true }, 0], ...changes.map(c => [c, 0])])
  for (const changes of [
    [],
    [{ listening: true }],
    [{ state: 'thinking' }],
    [{ state: 'speaking' }],
    [{ sessions: ['working', 'blocked'] }],
    [{ proposal: { seconds: 120, secondsLeft: 100 } }],
    [{ listening: true }, { state: 'thinking' }, { sessions: ['working'] }, { proposal: { seconds: 120, secondsLeft: 100 } }]
  ]) {
    assert.equal(cadence(reduced(changes)), 'still', JSON.stringify(changes))
  }
})

test('cadence follows the setting when it turns on and off', () => {
  const thinking = build([[{ state: 'thinking' }, 0]])
  assert.equal(cadence(thinking), 'run')
  const reduced = reduce(thinking, { reduced: true }, 100)
  assert.equal(cadence(reduced), 'still')
  assert.equal(cadence(reduce(reduced, { reduced: false }, 200)), 'run')
})

// voice-stage: "The same picture at any time".
test('with reduced motion on and nothing changing, what the stage draws is the same at any two times', () => {
  const model = build([
    [{ reduced: true }, 0],
    [{ listening: true }, 0],
    [{ state: 'thinking' }, 0],
    [{ heard: true }, 0],
    [{ words: 7 }, 0],
    [{ sentence: true }, 0],
    [{ sessions: ['working', 'blocked', 'done', 'failed'] }, 0],
    [{ proposal: { seconds: 120, secondsLeft: 90 } }, 0]
  ])
  assert.deepEqual(scene(model, 1000), scene(model, 987654))
  assert.deepEqual(scene(model, 0), scene(model, 3333))
})

// voice-stage: "The state still shows".
test('with reduced motion on the state still shows in tone and in the marks', () => {
  const tone = (model, id) => get(model, 0, id).tone
  const rest = build([[{ reduced: true }, 0]])
  assert.notEqual(tone(rest, 'balance'), 'live')
  for (const id of train) assert.notEqual(tone(rest, id), 'live')

  const listening = build([[{ listening: true }, 0]], rest)
  assert.equal(tone(listening, 'balance'), 'live', 'the balance is live while recognition runs')
  for (const id of train) assert.notEqual(tone(listening, id), 'live')

  const thinking = build([[{ listening: false }, 0], [{ state: 'thinking' }, 0], [{ sessions: ['working'] }, 0]], listening)
  for (const id of train) assert.equal(tone(thinking, id), 'live', `${id} is live while Dial thinks`)
  assert.notEqual(tone(thinking, 'balance'), 'live')

  // the working hand rests at the mark of `working`, which differs from the other three
  const work = subHand(thinking, 0, 0).angle
  assert.equal(work, SUB_MARKS.working)
  for (const state of ['blocked', 'done', 'failed']) assert.notEqual(work, SUB_MARKS[state])
  assert.equal(subHand(thinking, 99999, 0).angle, SUB_MARKS.working, 'and stays there')
})
