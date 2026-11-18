/**
 * The gear geometry of the voice stage (specs/voice-stage, design §14): pure, no imports, every angle in radians.
 * A tooth's flanks are involutes of the base circle; below the base circle a flank runs radially.
 */

/** 20 degrees, in radians. */
export const PRESSURE_ANGLE = (20 * Math.PI) / 180

/** The four radii of a gear and the angle between two teeth. */
export function gear(teeth, module) {
  const pitch = (module * teeth) / 2
  return {
    teeth,
    module,
    pitch,
    base: pitch * Math.cos(PRESSURE_ANGLE),
    tip: pitch + module,
    root: pitch - 1.25 * module,
    pitchAngle: (2 * Math.PI) / teeth
  }
}

/** tan a minus a. */
export function involute(a) {
  return Math.tan(a) - a
}

/** Half the angle a tooth spans at the radius r: pi over twice the teeth at the pitch radius, the same below the base radius as at it. */
export function halfTooth(g, r) {
  const atBase = Math.PI / (2 * g.teeth) + involute(PRESSURE_ANGLE)
  if (r <= g.base) return atBase
  return atBase - involute(Math.acos(Math.min(1, g.base / r)))
}

/**
 * The closed outline, counter-clockwise from the middle of the gap before tooth 0 (whose centre is on +x), the
 * last point joining the first. `flanks` index the points of each flank in the order of `points`.
 */
export function outline(g, { steps = 6 } = {}) {
  const radii = g.root < g.base ? [g.root, g.base] : [g.root]
  const from = g.root < g.base ? g.base : g.root
  for (let i = 1; i <= steps; i++) radii.push(i === steps ? g.tip : from + ((g.tip - from) * i) / steps)
  const at = (r, angle) => [r * Math.cos(angle), r * Math.sin(angle)]
  const points = []
  const flanks = []
  for (let tooth = 0; tooth < g.teeth; tooth++) {
    const centre = tooth * g.pitchAngle
    points.push(at(g.root, centre - g.pitchAngle / 2))
    const rising = points.length
    for (const r of radii) points.push(at(r, centre - halfTooth(g, r)))
    flanks.push({ tooth, side: 'rising', from: rising, to: points.length - 1 })
    const falling = points.length
    for (const r of [...radii].reverse()) points.push(at(r, centre + halfTooth(g, r)))
    flanks.push({ tooth, side: 'falling', from: falling, to: points.length - 1 })
  }
  return { points, flanks }
}

/** The driven wheel's angle when the driver is at `driverAngle` and the line of centres points at `lineAngle`: a tooth meets a gap. */
export function meshAngle(driver, driven, driverAngle, lineAngle) {
  return lineAngle + Math.PI - driven.pitchAngle / 2 - ((driverAngle - lineAngle) * driver.teeth) / driven.teeth
}

/** The escape wheel passes one tooth in two beats. */
export function escapeAngle(teeth, beats) {
  return (beats * Math.PI) / teeth
}

/** 1 for an even count of beats, -1 for an odd one. */
export function balanceSide(beats) {
  return beats % 2 === 0 ? 1 : -1
}
