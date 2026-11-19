import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PRESSURE_ANGLE,
  balanceSide,
  escapeAngle,
  gear,
  halfTooth,
  involute,
  meshAngle,
  outline
} from '../lib/voice/gears.mjs'

// The gear geometry of the voice stage (voice-stage delta, design §14 Interfaces). lib/voice/gears.mjs does not exist
// yet: every case here fails until task 2.2 adds it. Geometry is checked by property, never against stored
// coordinates. Every angle in code is in radians; the specs speak in degrees.

const TAU = 2 * Math.PI
const deg = x => (x * Math.PI) / 180
/** An angle brought into (-pi, pi]. */
const wrap = a => {
  let d = a % TAU
  if (d > Math.PI) d -= TAU
  if (d <= -Math.PI) d += TAU
  return d
}
const near = (actual, expected, eps, what = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what} ${actual} is not within ${eps} of ${expected}`)
const nearAngle = (actual, expected, eps, what = '') => near(wrap(actual - expected), 0, eps, what)
const radius = ([x, y]) => Math.hypot(x, y)
const polar = ([x, y]) => Math.atan2(y, x)
const involuteOf = (g, r) => involute(Math.acos(Math.min(1, g.base / r)))

// A gear whose root circle lies above its base circle needs 42 teeth or more at the module 2; 8 teeth lie far below.
const TEETH = [8, 20, 40, 64]
const MODULE = 2

// voice-stage: "A gear's teeth are involutes of its base circle" / "The four radii".
test('a gear of 40 teeth and module 2 has the four radii of the spec', () => {
  const g = gear(40, 2)
  assert.equal(g.teeth, 40)
  assert.equal(g.module, 2)
  assert.equal(g.pitch, 40)
  assert.equal(g.base.toFixed(4), '37.5877')
  assert.equal(g.tip, 42)
  assert.equal(g.root, 37.5)
  near(g.pitchAngle, TAU / 40, 1e-12, 'pitchAngle')
})

test('the pressure angle is 20 degrees', () => {
  near(PRESSURE_ANGLE, deg(20), 1e-12)
})

test('the radii follow from the teeth and the module for any gear', () => {
  for (const [teeth, module] of [[8, 1], [20, 1.5], [64, 2], [12, 0.75]]) {
    const g = gear(teeth, module)
    near(g.pitch, (module * teeth) / 2, 1e-12)
    near(g.base, g.pitch * Math.cos(deg(20)), 1e-12)
    near(g.tip, g.pitch + module, 1e-12)
    near(g.root, g.pitch - 1.25 * module, 1e-12)
    near(g.pitchAngle, TAU / teeth, 1e-12)
  }
})

test('involute is tan a minus a', () => {
  assert.equal(involute(0), 0)
  near(involute(deg(20)), 0.014904, 1e-6)
  near(involute(0.7), Math.tan(0.7) - 0.7, 1e-15)
})

// voice-stage: "Half a pitch at the pitch circle".
test('half a tooth spans pi over twice the teeth at the pitch radius, so a tooth is half a pitch wide', () => {
  for (const teeth of TEETH) {
    const g = gear(teeth, MODULE)
    near(halfTooth(g, g.pitch), Math.PI / (2 * teeth), 1e-12, `${teeth} teeth`)
    // the two crossings of the pitch circle are 180/z degrees apart
    near(2 * halfTooth(g, g.pitch), deg(180 / teeth), 1e-12, `${teeth} teeth`)
  }
})

// voice-stage: "A flank is an involute" (through halfTooth).
test('halfTooth changes along the radius by the involute of the base circle', () => {
  for (const teeth of TEETH) {
    const g = gear(teeth, MODULE)
    // radii above the base circle, ascending; the tooth narrows as the radius grows
    const radii = [g.base * 1.0001, g.pitch, (g.pitch + g.tip) / 2, g.tip].filter(r => r >= g.base)
    for (let i = 0; i + 1 < radii.length; i++) {
      const [r1, r2] = [radii[i], radii[i + 1]]
      near(
        halfTooth(g, r1) - halfTooth(g, r2),
        involuteOf(g, r2) - involuteOf(g, r1),
        1e-9,
        `${teeth} teeth, ${r1} to ${r2}`
      )
      assert.ok(halfTooth(g, r1) > halfTooth(g, r2), `${teeth} teeth: the tooth narrows outwards`)
    }
  }
})

test('halfTooth below the base circle is the same as at it', () => {
  for (const teeth of [8, 20, 40]) {
    const g = gear(teeth, MODULE)
    const atBase = halfTooth(g, g.base)
    for (const r of [g.root, (g.root + g.base) / 2, g.base * 0.999]) {
      if (r >= g.base) continue
      near(halfTooth(g, r), atBase, 1e-12, `${teeth} teeth at ${r}`)
    }
  }
})

// What a flank point at the radius r must lie at, written from the spec and not from halfTooth: half a tooth at the
// pitch circle is pi / (2z), the pitch circle sits at the angle 20 degrees on the involute, and a radial line runs
// below the base circle.
const flankHalf = (g, r) => {
  const atBase = Math.PI / (2 * g.teeth) + involute(PRESSURE_ANGLE)
  if (r <= g.base + 1e-7) return atBase
  return atBase - involuteOf(g, r)
}

test('every outline point of every flank lies the involute angle from its tooth centre', () => {
  for (const teeth of TEETH) {
    const g = gear(teeth, MODULE)
    const { points, flanks } = outline(g)
    assert.equal(flanks.length, 2 * teeth, `${teeth} teeth: two flanks for every tooth`)
    for (const flank of flanks) {
      const centre = flank.tooth * g.pitchAngle
      assert.ok(flank.side === 'rising' || flank.side === 'falling')
      assert.ok(flank.from >= 0 && flank.to < points.length && flank.from < flank.to)
      for (let i = flank.from; i <= flank.to; i++) {
        const r = radius(points[i])
        const expected = flank.side === 'rising' ? centre - flankHalf(g, r) : centre + flankHalf(g, r)
        nearAngle(polar(points[i]), expected, 1e-9, `${teeth} teeth, tooth ${flank.tooth} ${flank.side}, point ${i}`)
        // and halfTooth agrees with the spec's own relation
        near(halfTooth(g, r), flankHalf(g, r), 1e-9, `${teeth} teeth, halfTooth at ${r}`)
      }
    }
  }
})

test('the angle from where a flank leaves the base circle is tan a minus a', () => {
  for (const teeth of TEETH) {
    const g = gear(teeth, MODULE)
    const { points, flanks } = outline(g)
    for (const flank of flanks) {
      const centre = flank.tooth * g.pitchAngle
      // where the flank leaves the base circle, written as the pitch crossing less the involute up to the pitch circle
      const leaves =
        flank.side === 'rising'
          ? centre - (Math.PI / (2 * teeth) + involute(PRESSURE_ANGLE))
          : centre + (Math.PI / (2 * teeth) + involute(PRESSURE_ANGLE))
      for (let i = flank.from; i <= flank.to; i++) {
        const r = radius(points[i])
        if (r <= g.base + 1e-7) continue
        const turned = flank.side === 'rising' ? polar(points[i]) - leaves : leaves - polar(points[i])
        near(wrap(turned), involuteOf(g, r), 1e-9, `${teeth} teeth, tooth ${flank.tooth} ${flank.side} at ${r}`)
      }
    }
  }
})

test('each flank has at least steps points above the base circle, six by default', () => {
  for (const teeth of TEETH) {
    const g = gear(teeth, MODULE)
    for (const [options, steps] of [[undefined, 6], [{ steps: 10 }, 10]]) {
      const { points, flanks } = outline(g, options)
      for (const flank of flanks) {
        let above = 0
        for (let i = flank.from; i <= flank.to; i++) if (radius(points[i]) > g.base + 1e-9) above++
        assert.ok(above >= steps, `${teeth} teeth, ${steps} steps: only ${above} points above the base circle`)
      }
    }
  }
})

test('a flank climbs from the root circle to the tip circle, and the teeth are in order', () => {
  for (const teeth of TEETH) {
    const g = gear(teeth, MODULE)
    const { points, flanks } = outline(g)
    for (const flank of flanks) {
      const radii = points.slice(flank.from, flank.to + 1).map(radius)
      const [first, last] = flank.side === 'rising' ? [radii[0], radii.at(-1)] : [radii.at(-1), radii[0]]
      near(first, g.root, 1e-9, `${teeth} teeth: a flank starts at the root circle`)
      near(last, g.tip, 1e-9, `${teeth} teeth: a flank ends at the tip circle`)
    }
    for (let t = 0; t < teeth; t++) {
      const rising = flanks.find(f => f.tooth === t && f.side === 'rising')
      const falling = flanks.find(f => f.tooth === t && f.side === 'falling')
      assert.ok(rising && falling, `tooth ${t} has both flanks`)
      assert.ok(rising.to < falling.from, `tooth ${t}: the rising flank comes before the falling one`)
      if (t > 0) {
        const before = flanks.find(f => f.tooth === t - 1 && f.side === 'falling')
        assert.ok(before.to < rising.from, `tooth ${t} follows tooth ${t - 1}`)
      }
    }
  }
})

// voice-stage: "Every tooth is the same".
test('the outline turned by 360/z degrees lies on itself', () => {
  for (const teeth of TEETH) {
    const g = gear(teeth, MODULE)
    const { points } = outline(g)
    assert.equal(points.length % teeth, 0, `${teeth} teeth: the same number of points for every tooth`)
    const cos = Math.cos(g.pitchAngle)
    const sin = Math.sin(g.pitchAngle)
    for (const [x, y] of points) {
      const turned = [x * cos - y * sin, x * sin + y * cos]
      const best = Math.min(...points.map(([px, py]) => Math.hypot(px - turned[0], py - turned[1])))
      assert.ok(best < 1e-9, `${teeth} teeth: a point turned by one pitch lands ${best} from the nearest point`)
    }
  }
})

// voice-stage: "A small pinion".
test('a pinion of 8 teeth has a radial flank from the root circle to the base circle and an involute above', () => {
  const g = gear(8, MODULE)
  assert.ok(g.root < g.base, 'the root circle lies inside the base circle')
  const { points, flanks } = outline(g)
  for (const flank of flanks) {
    const centre = flank.tooth * g.pitchAngle
    const leaves =
      flank.side === 'rising'
        ? centre - (Math.PI / 16 + involute(PRESSURE_ANGLE))
        : centre + (Math.PI / 16 + involute(PRESSURE_ANGLE))
    const radii = []
    for (let i = flank.from; i <= flank.to; i++) {
      const r = radius(points[i])
      radii.push(r)
      if (r <= g.base + 1e-7) nearAngle(polar(points[i]), leaves, 1e-9, `a point at ${r} lies on the radial line`)
    }
    assert.ok(radii.some(r => r < g.base - 1e-3), 'the flank has a point on the radial line below the base circle')
    assert.ok(
      radii.some(r => Math.abs(r - g.base) < 1e-9),
      'the flank has a point on the base circle, where the radial line meets the involute'
    )
    assert.ok(radii.some(r => r > g.base + 1e-3), 'the flank has a point on the involute')
  }
})

test('no point of the outline lies inside the root circle or outside the tip circle', () => {
  for (const teeth of [8, ...TEETH]) {
    const g = gear(teeth, MODULE)
    for (const point of outline(g).points) {
      const r = radius(point)
      assert.ok(r >= g.root - 1e-9, `${teeth} teeth: ${r} is inside the root circle ${g.root}`)
      assert.ok(r <= g.tip + 1e-9, `${teeth} teeth: ${r} is outside the tip circle ${g.tip}`)
    }
  }
})

// voice-stage: "The outline does not cross itself".
test('the angle around the centre never decreases along the outline, and the last point joins the first', () => {
  for (const teeth of [8, ...TEETH]) {
    const g = gear(teeth, MODULE)
    const { points } = outline(g)
    let sweep = 0
    for (let i = 0; i < points.length; i++) {
      const next = points[(i + 1) % points.length]
      const step = wrap(polar(next) - polar(points[i]))
      assert.ok(step >= -1e-9, `${teeth} teeth: the angle decreases by ${-step} at point ${i}`)
      sweep += step
    }
    // the closing step from the last point to the first completes exactly one counter-clockwise turn
    near(sweep, TAU, 1e-9, `${teeth} teeth: one turn`)
    assert.notDeepEqual(points.at(-1), points[0], 'the last point joins the first and does not repeat it')
  }
})

test('the outline starts in the middle of the gap before tooth 0, whose centre is on the +x axis', () => {
  for (const teeth of TEETH) {
    const g = gear(teeth, MODULE)
    const { points, flanks } = outline(g)
    nearAngle(polar(points[0]), -g.pitchAngle / 2, 1e-9, `${teeth} teeth`)
    // tooth 0 is centred on +x: its flanks lie either side of angle 0
    const rising = flanks.find(f => f.tooth === 0 && f.side === 'rising')
    const falling = flanks.find(f => f.tooth === 0 && f.side === 'falling')
    assert.ok(wrap(polar(points[rising.from])) < 0 && wrap(polar(points[falling.to])) > 0)
  }
})

// voice-stage: "Meshing wheels turn in ratio with a tooth in a gap" / "Ratio and direction".
test('a wheel of 60 teeth turning 10 degrees turns a wheel of 20 teeth 30 degrees the other way', () => {
  const driver = gear(60, 1)
  const driven = gear(20, 1)
  for (const line of [0, deg(37), Math.PI]) {
    const before = meshAngle(driver, driven, deg(5), line)
    const after = meshAngle(driver, driven, deg(5) + deg(10), line)
    near(after - before, -deg(30), 1e-12, `line ${line}`)
  }
})

test('the driven wheel turns by the driver angle times the driver teeth over its own, for any pair', () => {
  for (const [zd, zn] of [[12, 30], [30, 12], [20, 20], [48, 8]]) {
    const driver = gear(zd, 1)
    const driven = gear(zn, 1)
    const base = meshAngle(driver, driven, 0.3, 1.1)
    near(meshAngle(driver, driven, 0.3 + 0.5, 1.1) - base, (-0.5 * zd) / zn, 1e-12, `${zd} to ${zn}`)
  }
})

// voice-stage: "A tooth meets a gap".
test('where the driver has a tooth on the line of centres the driven wheel has a gap, and still after one pitch', () => {
  for (const [zd, zn] of [[60, 20], [20, 40], [12, 30], [30, 12]]) {
    const driver = gear(zd, 1)
    const driven = gear(zn, 1)
    for (const line of [0, deg(37), Math.PI]) {
      // a gap of the driven wheel is centred on the line pointing back at the driver when
      // (line + pi - driven angle) / pitchAngle is a whole number and a half
      const gapOnLine = driverAngle => {
        const driven_ = meshAngle(driver, driven, driverAngle, line)
        const turns = wrap(line + Math.PI - driven_) / driven.pitchAngle - 0.5
        // wrap moves the angle by whole turns, a whole number of pitches, so turns is a whole number exactly when
        // a gap is centred on the line
        return Math.abs(turns - Math.round(turns)) < 1e-9
      }
      // a tooth of the driver is centred on the line when its angle is the line's plus whole pitches
      for (const pitches of [0, 1, 2, 5]) {
        assert.ok(gapOnLine(line + pitches * driver.pitchAngle), `${zd} to ${zn}, line ${line}, ${pitches} pitches`)
      }
      // and a half pitch on, the driver has a gap on the line and the driven wheel a tooth
      const driven_ = meshAngle(driver, driven, line + driver.pitchAngle / 2, line)
      const turns = wrap(line + Math.PI - driven_) / driven.pitchAngle
      assert.ok(Math.abs(turns - Math.round(turns)) < 1e-9, `${zd} to ${zn}: a tooth meets the driver's gap`)
    }
  }
})

// voice-stage: "Two beats pass one tooth".
test('two beats advance an escape wheel of 15 teeth by 24 degrees', () => {
  near(escapeAngle(15, 2), deg(24), 1e-12)
  assert.equal(escapeAngle(15, 0), 0)
  near(escapeAngle(15, 1), deg(12), 1e-12)
})

test('the escape wheel advances 180/z degrees for each beat and turns once in 2z beats', () => {
  for (const teeth of [15, 20, 30]) {
    near(escapeAngle(teeth, 1), deg(180 / teeth), 1e-12, `${teeth} teeth`)
    near(escapeAngle(teeth, 2 * teeth), TAU, 1e-9, `${teeth} teeth`)
  }
})

// voice-stage: "The balance changes side".
test('the balance is on the plus side after an even number of beats and the minus side after an odd one', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(balanceSide), [1, -1, 1, -1, 1, -1])
  assert.equal(balanceSide(1000), 1)
  assert.equal(balanceSide(1001), -1)
})
