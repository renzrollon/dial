/**
 * The frame scheduler and the painter of the voice stage (specs/voice-stage, add-voice-stage-and-capture design §3,
 * §5, §14). `createStage` touches no global: it uses the `raf`, `cancelRaf`, `timers` and `now` it is given. `paint`
 * draws the parts of `scene` with path, fill, stroke and transform calls only, and never draws text.
 */
import { gear, outline } from './gears.mjs'
import { BEAT_MS, cadence, reduce, restModel, scene } from './scene.mjs'

/** The least time between two frames while the going train turns. */
export const FRAME_MS = 33

/**
 * The scheduler. `run` asks for a frame after each frame and draws when FRAME_MS have passed; `tick` waits on one
 * timeout for the next whole beat; `still` leaves nothing pending. A change asks for one frame, and changes before
 * that frame share it. Hidden or stopped, nothing is pending.
 */
export function createStage({ draw, raf, cancelRaf, timers, now }) {
  let model = restModel()
  let frame = null
  let timer = null
  let forced = false
  let hidden = false
  let stopped = false
  let lastDraw = -Infinity

  const cancel = () => {
    if (frame !== null) cancelRaf(frame)
    if (timer !== null) timers.clearTimeout(timer)
    frame = null
    timer = null
  }

  const paintNow = () => {
    lastDraw = now()
    forced = false
    draw(scene(model, lastDraw))
  }

  const follow = () => {
    if (hidden || stopped) return
    const mode = cadence(model)
    if (mode === 'run') {
      if (frame === null) frame = raf(onFrame)
    } else if (mode === 'tick' && timer === null) {
      const at = now()
      timer = timers.setTimeout(onBeat, BEAT_MS - (at % BEAT_MS) || BEAT_MS)
    }
  }

  function onFrame() {
    frame = null
    if (hidden || stopped) return
    if (forced || now() - lastDraw >= FRAME_MS) paintNow()
    follow()
  }

  function onBeat() {
    timer = null
    if (hidden || stopped) return
    paintNow()
    follow()
  }

  const ask = () => {
    forced = true
    if (frame === null) frame = raf(onFrame)
  }

  return {
    tell(change) {
      if (stopped) return
      model = reduce(model, change, now())
      if (hidden) return
      if (timer !== null) {
        timers.clearTimeout(timer)
        timer = null
      }
      ask()
    },
    hidden(on) {
      if (stopped) return
      hidden = !!on
      if (hidden) cancel()
      else ask()
    },
    stop() {
      stopped = true
      cancel()
    },
    get model() {
      return model
    }
  }
}

const outlines = new Map()
const outlineOf = (teeth, module) => {
  const key = `${teeth}:${module}`
  if (!outlines.has(key)) outlines.set(key, outline(gear(teeth, module)).points)
  return outlines.get(key)
}

const TAU = 2 * Math.PI

/** Draw the parts scaled to fit width by height; `tones` maps ground, live, rest, accent, ok and fail to colours. */
export function paint(ctx, parts, { width, height, tones }) {
  const scale = Math.min(width, height) / 1000
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = tones.ground
  ctx.fillRect(0, 0, width, height)
  ctx.translate((width - 1000 * scale) / 2, (height - 1000 * scale) / 2)
  ctx.scale(scale, scale)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const part of parts) {
    const colour = tones[part.tone] ?? tones.rest
    ctx.save()
    ctx.translate(part.x, part.y)
    ctx.strokeStyle = colour
    ctx.fillStyle = colour
    ctx.lineWidth = 3
    ctx.beginPath()
    switch (part.kind) {
      case 'gear': {
        ctx.rotate(part.angle)
        const points = outlineOf(part.teeth, part.module)
        points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
        ctx.closePath()
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(0, 0)
        ctx.lineTo(part.r * 0.6, 0)
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(0, 0, 6, 0, TAU)
        ctx.fill()
        break
      }
      case 'escape': {
        ctx.rotate(part.angle)
        const n = part.teeth
        for (let i = 0; i < n * 2; i++) {
          const a = (i * Math.PI) / n
          const r = i % 2 === 0 ? part.r : part.r * 0.78
          if (i === 0) ctx.moveTo(r * Math.cos(a), r * Math.sin(a))
          else ctx.lineTo(r * Math.cos(a), r * Math.sin(a))
        }
        ctx.closePath()
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(0, 0, 6, 0, TAU)
        ctx.fill()
        break
      }
      case 'lever': {
        ctx.rotate(part.angle)
        ctx.moveTo(-part.r, 0)
        ctx.lineTo(part.r, 0)
        ctx.moveTo(-part.r, -10)
        ctx.lineTo(-part.r, 10)
        ctx.moveTo(part.r, -10)
        ctx.lineTo(part.r, 10)
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(0, 0, 7, 0, TAU)
        ctx.fill()
        break
      }
      case 'balance': {
        ctx.rotate(part.angle)
        ctx.arc(0, 0, part.r, 0, TAU)
        ctx.moveTo(-part.r, 0)
        ctx.lineTo(part.r, 0)
        ctx.moveTo(0, -part.r)
        ctx.lineTo(0, part.r)
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(0, 0, 8, 0, TAU)
        ctx.fill()
        break
      }
      case 'hand': {
        ctx.rotate(part.angle)
        ctx.moveTo(0, 0)
        ctx.lineTo(part.r, 0)
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(0, 0, 5, 0, TAU)
        ctx.fill()
        break
      }
      case 'arc': {
        ctx.globalAlpha = 0.35
        ctx.arc(0, 0, part.r, 0, TAU)
        ctx.stroke()
        ctx.globalAlpha = 1
        if (part.share > 0) {
          ctx.beginPath()
          ctx.lineWidth = 10
          ctx.arc(0, 0, part.r, part.angle, part.angle + part.share * TAU)
          ctx.stroke()
        }
        break
      }
      case 'dial': {
        ctx.arc(0, 0, part.r, 0, TAU)
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 2
          ctx.moveTo(part.r * 0.88 * Math.cos(a), part.r * 0.88 * Math.sin(a))
          ctx.lineTo(part.r * Math.cos(a), part.r * Math.sin(a))
        }
        ctx.stroke()
        break
      }
      default:
        break
    }
    ctx.restore()
  }
  ctx.restore()
}
