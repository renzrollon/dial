/**
 * The movement of the voice stage (specs/voice-stage, add-voice-stage-and-capture design §3 to §5, §14): the layout,
 * the model and its reducer, the cadence and the list of parts. Pure: no clock, no DOM. Lengths are in scene units
 * (the movement fits a box 1000 wide and 1000 high) and angles are in radians. A part holds numbers and fixed
 * strings only, so nothing a session or a transcript said can reach the canvas.
 */
import { balanceSide, escapeAngle, gear, meshAngle } from './gears.mjs'

export const BEAT_MS = 1000
export const WORDS_PER_NOTCH = 3
export const NOTCH = (15 * Math.PI) / 180
export const MARK = (6 * Math.PI) / 180
export const SUB_DIALS = 12
/** Radians per second of the first wheel of the going train. */
export const TRAIN_RATE = 0.6
export const SUB_MARKS = { working: -Math.PI / 2, blocked: 0, done: Math.PI / 2, failed: Math.PI }

const TOP = -Math.PI / 2
const SECOND_STEP = (6 * Math.PI) / 180
const LEVER_SWING = (10 * Math.PI) / 180
const MODULE = 5
const TRAIN = [
  { id: 'train-1', teeth: 32, x: 130, y: 480 },
  { id: 'train-2', teeth: 12, x: 240, y: 480 },
  { id: 'train-3', teeth: 30, x: 345, y: 480 },
  { id: 'train-4', teeth: 10, x: 445, y: 480 }
]
const BARREL = { teeth: 36, x: 150, y: 170 }
const ESCAPE_TEETH = 15

export const MOVEMENT = {
  module: MODULE,
  train: TRAIN,
  escape: { teeth: ESCAPE_TEETH, x: 700, y: 200, r: 70 },
  lever: { x: 790, y: 270, r: 60 },
  balance: { x: 850, y: 330, r: 100, amplitude: (50 * Math.PI) / 180 },
  barrel: BARREL,
  hand: { x: 400, y: 170, r: 110 },
  reserve: { x: 800, y: 540, r: 100 },
  subs: Array.from({ length: SUB_DIALS }, (_, i) => ({ x: 100 + (i % 6) * 160, y: i < 6 ? 720 : 880, r: 55 }))
}

const CHANGES = ['state', 'listening', 'heard', 'words', 'sentence', 'turn', 'sessions', 'proposal', 'closed', 'reduced']
const SESSION_STATES = new Set(['working', 'blocked', 'done', 'failed'])
const SESSION_TONES = { working: 'live', blocked: 'accent', done: 'ok', failed: 'fail' }
const stopped = { ran: 0, since: null }

/** The model of a page that was not started. */
export function restModel() {
  return {
    state: 'idle',
    listening: false,
    closed: false,
    reduced: false,
    heard: false,
    notches: 0,
    spoken: 0,
    sentences: 0,
    sessions: [],
    proposal: null,
    balance: stopped,
    train: stopped
  }
}

const balanceOn = m => m.listening && !m.closed
const trainOn = m => (m.state === 'thinking' || m.state === 'speaking') && !m.closed

/** Milliseconds a group has run: the sum so far, and under reduced motion nothing more. */
function ranMs(group, model, atMs) {
  if (model.reduced || group.since === null) return group.ran
  return Math.max(0, group.ran + (atMs - group.since))
}

/** Apply a change to one copy of the model, then carry each running total over to the new moment. */
export function reduce(model, change, atMs) {
  const key = change && typeof change === 'object' ? CHANGES.find(k => k in change) : undefined
  if (key === undefined) return model
  const value = change[key]
  const next = { ...model }
  switch (key) {
    case 'state':
      next.state = String(value)
      if (next.state === 'refused') next.sentences = 0
      break
    case 'listening':
      next.listening = !!value
      break
    case 'heard':
      next.heard = !!value
      next.spoken = 0
      break
    case 'words': {
      const words = Number(value)
      if (!Number.isFinite(words) || words <= 0) {
        next.spoken = 0
        break
      }
      const reached = Math.floor(words / WORDS_PER_NOTCH)
      if (reached > next.spoken) {
        next.notches += reached - next.spoken
        next.spoken = reached
      }
      break
    }
    case 'sentence':
      next.sentences += 1
      break
    case 'turn':
      next.sentences = 0
      break
    case 'sessions':
      next.sessions = Array.isArray(value) ? value.slice(0, SUB_DIALS).map(String) : []
      break
    case 'proposal':
      next.proposal =
        value && Number.isFinite(value.seconds) && value.seconds > 0
          ? { seconds: value.seconds, left: Math.max(0, Math.min(value.seconds, Number(value.secondsLeft) || 0)), at: atMs }
          : null
      break
    case 'closed':
      next.closed = !!value
      if (next.closed) next.sentences = 0
      break
    case 'reduced':
      next.reduced = !!value
      break
  }
  const carry = (group, on) => ({ ran: ranMs(group, model, atMs), since: on ? atMs : null })
  next.balance = carry(model.balance, balanceOn(next))
  next.train = carry(model.train, trainOn(next))
  return next
}

/** `run` while the train turns, `tick` while a stepped part is live, else `still`. */
export function cadence(model) {
  if (model.reduced || model.closed) return 'still'
  if (trainOn(model)) return 'run'
  if (balanceOn(model) || model.proposal || model.sessions.includes('working')) return 'tick'
  return 'still'
}

const gearPart = (id, spec, angle, tone) => {
  const g = gear(spec.teeth, MODULE)
  return { id, kind: 'gear', x: spec.x, y: spec.y, r: g.tip, angle, tone, teeth: spec.teeth, module: MODULE }
}

/** The parts of the movement at one moment. With reduced motion `atMs` is not read. */
export function scene(model, atMs) {
  const parts = []
  const heardTone = model.heard ? 'live' : 'rest'
  parts.push(gearPart('barrel', BARREL, TOP + model.notches * NOTCH, heardTone))

  const seconds = ranMs(model.train, model, atMs) / 1000
  const trainTone = trainOn(model) ? 'live' : 'rest'
  const wheels = TRAIN.map(w => gear(w.teeth, MODULE))
  let angle = TRAIN_RATE * seconds
  TRAIN.forEach((w, i) => {
    if (i > 0) {
      const from = TRAIN[i - 1]
      angle = meshAngle(wheels[i - 1], wheels[i], angle, Math.atan2(w.y - from.y, w.x - from.x))
    }
    parts.push(gearPart(w.id, w, angle, trainTone))
  })

  const beats = Math.floor(ranMs(model.balance, model, atMs) / BEAT_MS)
  const side = balanceSide(beats)
  const beatTone = balanceOn(model) ? 'live' : 'rest'
  const { escape, lever, balance } = MOVEMENT
  parts.push({ id: 'escape', kind: 'escape', x: escape.x, y: escape.y, r: escape.r, angle: escapeAngle(ESCAPE_TEETH, beats), tone: beatTone, teeth: ESCAPE_TEETH })
  parts.push({ id: 'lever', kind: 'lever', x: lever.x, y: lever.y, r: lever.r, angle: side * LEVER_SWING, tone: beatTone })
  parts.push({ id: 'balance', kind: 'balance', x: balance.x, y: balance.y, r: balance.r, angle: side * balance.amplitude, tone: beatTone })

  const { hand, reserve } = MOVEMENT
  parts.push({ id: 'hand', kind: 'hand', x: hand.x, y: hand.y, r: hand.r, angle: TOP + model.sentences * MARK, tone: model.sentences > 0 ? 'accent' : 'rest' })

  const open = model.proposal
  const elapsed = open && !model.reduced ? Math.floor(Math.max(0, atMs - open.at) / 1000) : 0
  const share = open ? Math.max(0, Math.min(1, (open.left - elapsed) / open.seconds)) : 0
  parts.push({ id: 'reserve', kind: 'arc', x: reserve.x, y: reserve.y, r: reserve.r, angle: TOP, tone: open ? 'accent' : 'rest', share })

  const step = model.reduced ? 0 : Math.floor(atMs / BEAT_MS) % 60
  MOVEMENT.subs.forEach((sub, i) => {
    const state = model.sessions[i]
    const known = SESSION_STATES.has(state)
    parts.push({ id: `sub-${i}`, kind: 'dial', x: sub.x, y: sub.y, r: sub.r, angle: TOP, tone: state === 'blocked' ? 'accent' : 'rest' })
    if (known) {
      const at = state === 'working' ? SUB_MARKS.working + step * SECOND_STEP : SUB_MARKS[state]
      parts.push({ id: `sub-${i}-hand`, kind: 'hand', x: sub.x, y: sub.y, r: sub.r * 0.8, angle: at, tone: SESSION_TONES[state] })
    }
  })
  return parts
}
