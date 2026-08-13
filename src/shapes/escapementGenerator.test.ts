import { describe, it, expect } from 'vitest'
import {
  generateEscapementParts, escapementDims, escapementPose, anchorOffset, escapementSpan, __escBackCorner,
  __escFaces, __escLockCorner, __escLockPoints, __escBackEdge, __escToothRing, type EscapementSpec,
} from './escapementGenerator'
import { scaleShapeParams, type ShapeParams } from './shapeGenerators'

// Whether the thing actually escapes is a question about the wheel and the
// anchor TOGETHER, and it is answered by running the mesh — see
// `scripts/escapement-check.mts`. What is pinned here is everything that can be
// checked on one part at a time: the construction the pallets are placed by, the
// inputs that make an escapement that cannot run, and the emitted parts.

const BASE: EscapementSpec = {
  cx: 0, cy: 0, escType: 'deadbeat', teeth: 30, wheelDia: 100,
  toothDepth: 6, drop: 2, lift: 3, lock: 1.5, draw: 2, recoilArc: 4,
  armWidth: 8, bore: 6, hubDia: 20, spokes: 5, anchorBore: 6,
  clockwise: false,
}

describe('escapement — the classic construction', () => {
  it('puts the arbor where the tangents to the tip circle cross', () => {
    // L = R/cos(β/2) and ρ = R·tan(β/2), which together say AP ⟂ OP: the
    // pallet arms lie along tangents. Everything else rests on this.
    for (const teeth of [22, 30, 42]) {
      const d = escapementDims({ ...BASE, teeth })
      const R = BASE.wheelDia / 2
      const beta = (escapementSpan(teeth) * 2 * Math.PI) / teeth
      expect(d.centreDistance).toBeCloseTo(R / Math.cos(beta / 2), 9)
      expect(d.palletRadius).toBeCloseTo(R * Math.tan(beta / 2), 9)
      // Right angle at the pallet: L² = R² + ρ².
      expect(d.centreDistance ** 2).toBeCloseTo(R ** 2 + d.palletRadius ** 2, 6)
    }
  })

  it('spends the beat on impulse and drop and nothing else', () => {
    const d = escapementDims(BASE)
    expect(d.beatDeg).toBeCloseTo(180 / BASE.teeth, 12)
    expect(d.wheelImpulseDeg + BASE.drop).toBeCloseTo(d.beatDeg, 9)
  })

  it('always spans an ODD number of half teeth, whatever the tooth count', () => {
    // The wheel gives up half a tooth per beat, so the pallets have to stand an
    // odd number of half pitches apart or one releases without the other
    // catching — the classic way to draw an escapement that cannot run. It used
    // to be a field with a red warning under it; now it is derived, so the whole
    // failure mode is gone and this is what says so.
    //
    // Note what a plain "N/4 to the nearest half" would do: at 28, 32, 36, 40 it
    // lands on a WHOLE tooth, which is exactly the broken case.
    for (let n = 6; n <= 120; n++) {
      const s = escapementSpan(n)
      expect(s * 2).toBe(Math.round(s * 2))
      expect(Math.round(s * 2) % 2).toBe(1)
      // And near N/4, which is what puts the pallets either side of the wheel.
      expect(Math.abs(s - n / 4)).toBeLessThanOrEqual(0.5)
      expect(escapementDims({ ...BASE, teeth: n }).span).toBe(s)
    }
  })

  it('flags a drop that leaves no impulse', () => {
    expect(escapementDims({ ...BASE, drop: 2 }).noImpulse).toBe(false)
    expect(escapementDims({ ...BASE, drop: 6 }).noImpulse).toBe(true)
  })
})

describe('escapement — the acting faces', () => {
  it('locks on an arc concentric with the arbor', () => {
    // This is what "dead" means: a circle centred on the pivot is unmoved by
    // rotation about it, so the tooth resting on it stays where it is while the
    // pendulum swings on. Draw is the one thing allowed to break it, and only
    // by the couple of degrees that pulls the pallet in.
    for (const side of ['entry', 'exit'] as const) {
      const face = __escFaces({ ...BASE, draw: 0 }, side)
      const r = face.slice(0, 20).map((p) => Math.hypot(p[0], p[1]))
      for (const v of r) expect(v).toBeCloseTo(r[0], 9)
    }
  })

  it('leans each locking face towards its OWN stock when draw is asked for', () => {
    // Draw leans the face off concentric so the drive tightens the lock rather
    // than picking it — and which way that is differs between the pallets,
    // because their stock is on opposite sides of their faces. The entry's lies
    // towards the arbor and the exit's away from it, so the face has to close on
    // the arbor as the lock deepens on one and open away from it on the other.
    //
    // Leaning both the same way (the obvious reading of "draw leans it inward")
    // draws the entry and REPELS the exit: its face travels out through itself
    // into the tooth, which is a lock that trips, and on the canvas it is the
    // exit tooth embedded in the pallet while the entry stands off by the same
    // amount. Nothing else catches it — the profile is a clean curve either way,
    // and the mesh check measured 0.04 mm.
    for (const side of ['entry', 'exit'] as const) {
      const face = __escFaces({ ...BASE, draw: 3 }, side)
      const r = face.slice(0, 20).map((p) => Math.hypot(p[0], p[1]))
      const deep = r[0], atImpulse = r[r.length - 1]        // face[0] is deepest
      if (side === 'entry') expect(deep).toBeLessThan(atImpulse)
      else expect(deep).toBeGreaterThan(atImpulse)
      // And by the amount asked for: over the face's own arc length, tan(draw).
      const arc = Math.abs(atImpulse) * (BASE.lock * Math.PI) / 180
      expect(Math.abs(deep - atImpulse)).toBeCloseTo(arc * Math.tan((3 * Math.PI) / 180), 3)
    }
  })

  it('makes the drive assist the lock on both pallets, not one', () => {
    // The test of draw is not the outline but the WHEEL. Hold the tooth and
    // deepen the lock: a drawing face retreats in the tooth's own direction of
    // travel, so the wheel creeps forward to stay in touch and the drive is
    // doing the work of pulling the pallet in. A repelling face advances into
    // the tooth instead, and the drive is fighting the lock.
    //
    // The tooth's travel at the pallet runs straight into the stock (AP ⟂ OP is
    // what makes that true), so "retreats" is simply "moves into its own stock".
    for (const draw of [2, 6, 12]) {
      for (const side of ['entry', 'exit'] as const) {
        const face = __escFaces({ ...BASE, draw }, side).slice(0, 20)
        const rDeep = Math.hypot(face[0][0], face[0][1])
        const rShallow = Math.hypot(face[19][0], face[19][1])
        const intoStock = side === 'entry' ? rShallow - rDeep : rDeep - rShallow
        expect(intoStock).toBeGreaterThan(0)
      }
    }
    // And nothing at all when none is asked for: the face is the dead arc.
    for (const side of ['entry', 'exit'] as const) {
      const face = __escFaces({ ...BASE, draw: 0 }, side).slice(0, 20)
      expect(Math.hypot(face[0][0], face[0][1]))
        .toBeCloseTo(Math.hypot(face[19][0], face[19][1]), 9)
    }
  })

  it('gives a recoil escapement no dead arc at all', () => {
    for (const side of ['entry', 'exit'] as const) {
      const face = __escFaces({ ...BASE, escType: 'recoil' }, side)
      const r = face.slice(0, 24).map((p) => Math.hypot(p[0], p[1]))
      // Every point at a different radius from the arbor — the wheel is driven
      // back through the whole of it.
      expect(Math.abs(r[0] - r[r.length - 1])).toBeGreaterThan(0.1)
    }
  })

  it('cuts the two faces differently, because the wheel turns one way', () => {
    // Every hand construction draws an anchor symmetric. The true loci are not:
    // the entry and exit act on the same rotation, so mirroring one does not
    // give the other.
    const e = __escFaces(BASE, 'entry')
    const x = __escFaces(BASE, 'exit')
    const mirrored = e.map(([px, py]) => [-px, py] as [number, number])
    const diff = Math.max(...x.map((p, i) => Math.hypot(p[0] - mirrored[i][0], p[1] - mirrored[i][1])))
    expect(diff).toBeGreaterThan(0.01)
  })
})

describe('escapement — emission', () => {
  it('emits the wheel and the anchor as separate parts', () => {
    const keys = generateEscapementParts(BASE).map((p) => p.key)
    expect(keys).toContain('wheel')
    expect(keys).toContain('anchor')
    expect(keys).toContain('spokes')
    expect(keys).toContain('bore')
    expect(keys).toContain('anchorbore')
  })

  it('drops the parts that were not asked for', () => {
    const keys = generateEscapementParts({ ...BASE, spokes: 0, bore: 0, anchorBore: 0 }).map((p) => p.key)
    expect(keys).toEqual(['wheel', 'anchor'])
  })

  it('mirrors for a clockwise wheel and leaves the readouts alone', () => {
    // The teeth lean the way the wheel runs, so this is geometry rather than a
    // view option — but it is a reflection, so no dimension changes.
    const ccw = generateEscapementParts(BASE)
    const cw = generateEscapementParts({ ...BASE, clockwise: true })
    expect(cw.map((p) => p.key)).toEqual(ccw.map((p) => p.key))
    expect(cw[0].d).not.toEqual(ccw[0].d)
    expect(escapementDims({ ...BASE, clockwise: true })).toEqual(escapementDims(BASE))
  })

  it('draws the anchor clear of the wheel, not at the centre distance', () => {
    const parts = generateEscapementParts(BASE)
    const ys = (d: string) => d.replace(/Z/g, ' ').split(/[ML]/).slice(1)
      .map((p) => Number(p.split(',')[1])).filter((v) => Number.isFinite(v))
    const wheelTop = Math.max(...ys(parts.find((p) => p.key === 'wheel')!.d))
    const anchorLow = Math.min(...ys(parts.find((p) => p.key === 'anchor')!.d))
    expect(anchorLow).toBeGreaterThan(wheelTop)
  })

  it('gives the wheel a whole number of teeth', () => {
    for (const teeth of [15, 30, 48]) {
      const d = escapementDims({ ...BASE, teeth })
      expect(d.toothPitchDeg).toBeCloseTo(360 / teeth, 12)
    }
  })
})

describe('escapement — as a shape', () => {
  const params = (): ShapeParams => ({ type: 'escapement', ...BASE })

  it('scales its lengths and holds its angles', () => {
    const out = scaleShapeParams(params(), 0, 0, 2, 2)
    expect(out).not.toBeNull()
    if (out?.type !== 'escapement') throw new Error('wrong type')
    expect(out.wheelDia).toBe(200)
    expect(out.toothDepth).toBe(12)
    expect(out.bore).toBe(12)
    // The mechanism is angles and tooth counts — scaling must not touch them.
    expect(out.teeth).toBe(30)
    expect(out.lift).toBe(3)
    expect(out.drop).toBe(2)
  })

  it('gives up its params under a non-uniform scale', () => {
    // Stretched on one axis the pallets no longer stand on tangents to the tip
    // circle, and the whole construction is that tangency.
    expect(scaleShapeParams(params(), 0, 0, 2, 1)).toBeNull()
  })
})

describe('escapement — the teeth', () => {
  it('leans each tooth forward, with the tip overhanging the space in front', () => {
    // The wheel runs clockwise, so a tooth's stock must lie BEHIND its tip and
    // the space in front of it must be clear — that space is where the pallet's
    // impulse face stands at the lock. Lean them the other way, or put the
    // undercut's foot in front of the tip, and the pair binds: the wheel's own
    // root drives into the pallet. Both were live bugs; the mesh found them and
    // the outline did not.
    const parts = generateEscapementParts({ ...BASE, clockwise: true })
    const pts = parts.find((p) => p.key === 'wheel')!.d
      .replace(/[MZ]/g, ' ').split('L').map((s) => s.trim().split(',').map(Number))
      .filter((p) => p.length === 2 && p.every(Number.isFinite))
    // Measured off the emitted outline rather than the nominal circle: the
    // teeth are cut short by the running clearance, and the root-fillet closing
    // moves a tip by a few microns on its way through clipper.
    const R = Math.max(...pts.map((p) => Math.hypot(p[0], p[1])))
    const tips = pts.filter((p) => Math.hypot(p[0], p[1]) > R - 0.01)
    expect(tips.length).toBeGreaterThanOrEqual(BASE.teeth)

    // Just in FRONT of a tip (smaller angle, the way it runs) there must be no
    // stock at all down to the root; just BEHIND it there must be.
    const rRoot = escapementDims(BASE).wheelRootDia / 2
    const at = (ang: number, r: number) => [r * Math.cos(ang), r * Math.sin(ang)] as [number, number]
    const inside = (p: [number, number]) => {
      let c = false
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i] as [number, number], [xj, yj] = pts[j] as [number, number]
        if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c
      }
      return c
    }
    const tip = Math.atan2(tips[0][1], tips[0][0])
    const step = (2 * Math.PI) / BASE.teeth
    const mid = (rRoot + R) / 2
    expect(inside(at(tip - step * 0.15, mid))).toBe(false)   // in front — clear
    expect(inside(at(tip + step * 0.15, mid))).toBe(true)    // behind — stock
  })
})

describe('escapement — the pallet tip', () => {
  it('leaves the tooth clear of the relieved back at release', () => {
    // The pallet comes to a point at the release corner — no tip land — so the
    // edge a tooth has to get past there is the relieved BACK, starting at the
    // corner itself. The pallet withdraws while the tooth runs on, so the two
    // part fast; this pins that they really do, because the binding check
    // cannot see it (grazing is not interference) and the outline shows only a
    // thin wedge.
    for (const spec of [BASE, { ...BASE, escType: 'recoil' as const }]) {
      const S = { ...spec, clockwise: true }
      const L = escapementDims(S).centreDistance
      const R = S.wheelDia / 2
      const wheel = generateEscapementParts(S).find((p) => p.key === 'wheel')!.d
        .replace(/[MZ]/g, ' ').split('L').map((t) => t.trim().split(',').map(Number))
        .filter((p) => p.length === 2 && p.every(Number.isFinite)) as [number, number][]
      const tips = wheel.filter((p) => Math.hypot(p[0], p[1]) > R - 0.02)
      const rot = (p: [number, number], a: number): [number, number] =>
        [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)]

      for (const side of ['entry', 'exit'] as const) {
        const [c0, c1] = __escBackEdge(S, side)
        let closest = Infinity
        for (let i = 0; i < 200; i++) {
          const pose = escapementPose(S, i / 200)
          const phi = (pose.anchorDeg * Math.PI) / 180
          const adv = (-pose.wheelDeg * Math.PI) / 180
          const toWheel = (p: [number, number]) => {
            const q = rot(p, phi)
            return rot([q[0], q[1] + L], adv)
          }
          const a = toWheel(c0), b = toWheel(c1)
          // Past the working corner itself — the tooth is meant to touch there.
          const s0: [number, number] = [a[0] + (b[0] - a[0]) * 0.25, a[1] + (b[1] - a[1]) * 0.25]
          const dx = b[0] - s0[0], dy = b[1] - s0[1]
          for (const t of tips) {
            const u = Math.max(0, Math.min(1, ((t[0] - s0[0]) * dx + (t[1] - s0[1]) * dy) / (dx * dx + dy * dy || 1)))
            closest = Math.min(closest, Math.hypot(s0[0] + u * dx - t[0], s0[1] + u * dy - t[1]))
          }
        }
        expect(closest).toBeGreaterThan(0.2)
      }
    }
  })
})

describe('escapement — the tip circle', () => {
  it('cuts the teeth to the circle the pallets were laid out for', () => {
    // There is no running clearance any more. The teeth reach the nominal tip
    // circle exactly, so the drive bears on the pallet where the construction
    // put it; what free travel the pair has is `drop`, and nothing else.
    const tipR = (spec: EscapementSpec) => {
      const pts = generateEscapementParts(spec).find((p) => p.key === 'wheel')!.d
        .replace(/[MZ]/g, ' ').split('L').map((t) => t.trim().split(',').map(Number))
        .filter((p) => p.length === 2 && p.every(Number.isFinite))
      return Math.max(...pts.map((p) => Math.hypot(p[0] - spec.cx, p[1] - spec.cy)))
    }
    // To 0.03 mm, not to six places: the gullet closing is a clipper offset pass
    // over the whole outline, and its resampling error scales with the radius —
    // which is millimetres now rather than the 0.6 mm it used to be, so a tip
    // moves by about twelve microns instead of two. A closing cannot shorten a
    // convex corner in theory; this is the sampling, and tightening the test
    // would only be pinning that.
    for (const wheelDia of [60, 100, 180]) {
      expect(Math.abs(tipR({ ...BASE, wheelDia }) - wheelDia / 2)).toBeLessThan(0.03)
    }
  })

  it('leaves the lock the full depth the swing buries the pallet by', () => {
    const rho = escapementDims(BASE).palletRadius
    expect(escapementDims(BASE).lockDepth).toBeCloseTo(rho * (BASE.lock * Math.PI) / 180, 9)
    expect(escapementDims(BASE).noLock).toBe(false)
    // And nothing to lock on at all is still reported, now only when the lock
    // itself is gone.
    expect(escapementDims({ ...BASE, lock: 0 }).noLock).toBe(true)
  })
})

describe('escapement — the tooth depth', () => {
  it('cuts a tooth as deep as it was asked for, at every depth', () => {
    // `toothDepth` sets the root circle, and for half a day the GULLET FILL then
    // overruled it: the fill was sized by what it may not bury above the pallet's
    // floor, which bounds its top and says nothing about its bottom, and a disc
    // too big to descend into a deep narrow gullet jams high and solidifies
    // everything under it. Deepening the tooth made the gullet deeper AND
    // narrower, so a bigger disc jammed higher still — past about 10 mm the floor
    // rose faster than the root fell, and 24 mm of tooth depth emitted a 1.26 mm
    // tooth. The wheel came out nearly a circle, which is how it was noticed; no
    // clearance, binding or fill-position check could see it, because none of
    // them asked this.
    for (const toothDepth of [2, 4, 6, 8, 10, 14, 18, 24]) {
      const spec = { ...BASE, toothDepth }
      const pts = generateEscapementParts(spec).find((p) => p.key === 'wheel')!.d
        .replace(/[MZ]/g, ' ').split('L').map((t) => t.trim().split(',').map(Number))
        .filter((p) => p.length === 2 && p.every(Number.isFinite)) as [number, number][]
      const floor = Math.min(...pts.map((p) => Math.hypot(p[0] - spec.cx, p[1] - spec.cy)))
      const root = escapementDims(spec).wheelRootDia / 2
      // Measured off the EMITTED outline, so it sees the gullet closing. To
      // 0.05 mm: the closing is a clipper pass and resamples everything it
      // touches.
      expect(Math.abs(floor - root), `toothDepth ${toothDepth}`).toBeLessThan(0.05)
      expect(Math.abs((spec.wheelDia / 2 - floor) - toothDepth), `toothDepth ${toothDepth}`).toBeLessThan(0.05)
    }
  })
})

describe('escapement — bowed tooth flanks', () => {
  it('leaves no step where a flank meets the root land', () => {
    // The bow is ANGULAR, so a bowed foot stays ON the root circle and the land
    // simply runs between the feet it is given. Displace the foot off that circle
    // instead — which a bow taken perpendicular to the flank does — and the land
    // still starts where the foot used to be, leaving a visible step at every
    // tooth that no dimension catches.
    //
    // The bow is fixed at `TOOTH_BOW` now rather than asked for, so this is swept
    // over the WHEEL instead: the invariant has to hold at any size.
    //
    // Tested on the RAW ring: the emitted outline has been through the gullet
    // closing, which resamples it and collapses straight runs, so a long edge
    // there means nothing.
    for (const wheelDia of [40, 100, 200]) {
      const spec = { ...BASE, wheelDia }
      const rRoot = escapementDims(spec).wheelRootDia / 2
      const ring = __escToothRing(spec)
      // The invariant itself: the profile never leaves the band between root and
      // tip, and it REACHES the root circle exactly. A bow taken perpendicular to
      // the flank pushes the foot off that circle, and then the land — which is
      // still drawn on it — no longer meets the flank.
      const rs = ring.map((p) => Math.hypot(p[0], p[1]))
      expect(Math.min(...rs)).toBeCloseTo(rRoot, 9)
      expect(Math.max(...rs)).toBeCloseTo(wheelDia / 2, 9)
    }
  })
})

describe('escapement — the deep-lock corner relief', () => {
  // The exit pallet's face runs into the side of its own arm, at a right angle
  // (AP ⟂ OP), and the lock plus its landing allowance is barely 2 mm of face.
  // So whatever radius the cutter leaves in that inside corner lands ON the
  // working face unless the drawing gives it somewhere else to go — which is
  // what `lockRelief` cuts. The question is not what the outline looks like but
  // whether a real cutter can reach the whole face, so that is what is asked
  // here: roll the bit down the face and see if anything stops it.
  const BIT = 3.175

  const outline = (spec: EscapementSpec): [number, number][] =>
    (generateEscapementParts(spec).find((p) => p.key === 'anchor')!.d
      .match(/[MLAC][^MLACZQ]*/g) || [])
      .map((c) => c.match(/-?\d+(\.\d+)?/g)!)
      .map((v) => [Number(v[v.length - 2]), Number(v[v.length - 1])] as [number, number])

  /** How far the bit can be pushed onto each point of the face before it fouls
   *  the anchor — negative is how deep the anchor stands in its way. */
  const reach = (spec: EscapementSpec, side: 'entry' | 'exit'): number => {
    const R = spec.wheelDia / 2
    const dm = escapementDims(spec)
    const L = dm.centreDistance
    const beta = (dm.span * 2 * Math.PI) / spec.teeth
    const yA = anchorOffset(spec)
    const mir = spec.clockwise ? 1 : -1
    const sgn = side === 'entry' ? -1 : 1
    // The stock lies on `m`, so the cutter comes at the face from the other side.
    const P: [number, number] = [sgn * R * Math.sin(beta / 2), R * Math.cos(beta / 2) - L]
    const un = Math.hypot(P[0], P[1])
    const m: [number, number] = side === 'entry' ? [-P[0] / un, -P[1] / un] : [P[0] / un, P[1] / un]
    const poly = outline(spec)

    let worst = Infinity
    const face = __escFaces(spec, side)
    for (let k = 0; k < face.length; k++) {
      const p = face[k]
      // Bit rolled along the face: tangent to it, on the side the tooth is. The
      // offset is the face's OWN normal — the impulse face is nowhere near
      // perpendicular to the arm, so `m` is not it.
      const a = face[Math.max(0, k - 1)], b = face[Math.min(face.length - 1, k + 1)]
      const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
      const nx = -(b[1] - a[1]) / tl, ny = (b[0] - a[0]) / tl
      const sg = nx * m[0] + ny * m[1] > 0 ? -1 : 1
      const c: [number, number] = [
        spec.cx + mir * (p[0] + sg * nx * BIT / 2), spec.cy + (p[1] + sg * ny * BIT / 2) + yA,
      ]
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [ax, ay] = poly[j], [bx, by] = poly[i]
        const dx = bx - ax, dy = by - ay
        const t = Math.max(0, Math.min(1, ((c[0] - ax) * dx + (c[1] - ay) * dy) / (dx * dx + dy * dy || 1)))
        worst = Math.min(worst, Math.hypot(ax + t * dx - c[0], ay + t * dy - c[1]) - BIT / 2)
      }
    }
    return worst
  }

  it('lets a 1/8" bit reach every point of both acting faces', () => {
    for (const escType of ['deadbeat', 'recoil'] as const) {
      for (const clockwise of [false, true]) {
        for (const armWidth of [4, 8, 14]) {
        for (const side of ['entry', 'exit'] as const) {
          // Zero is the bit resting exactly on the face, which is what cutting
          // it means; under that is the anchor standing in its way. A few
          // hundredths are left and are not worth chasing: a bit cannot cut the
          // kink where the lock face meets the impulse face sharp either, and
          // the nib's own outward edge leaves the face's line by 3° past the
          // deep end. Both are rounded corners on the finished pallet, not a
          // lump on an acting face — which at 1.3 mm is what this used to be.
          expect(reach({ ...BASE, escType, clockwise, armWidth }, side)).toBeGreaterThan(-0.06)
        }
        }
      }
    }
  })

  it('stands the deep-lock corner clear of the end of the face', () => {
    // The corner is moved AWAY FROM THE WHEEL, along the face's own line, until
    // there is a whole fillet's set-back between it and the last of the face.
    // Rounding it where it sits would take the set-back out of the lock.
    expect(__escLockCorner(BASE, 'entry')).toBeNull()
    for (const escType of ['deadbeat', 'recoil'] as const) {
      const spec = { ...BASE, escType }
      const corner = __escLockCorner(spec, 'exit')!
      const deep = __escFaces(spec, 'exit')[0]
      expect(corner.taper).toBeGreaterThan(0)
      // Measured along the face's own line, which is where the corner slides.
      expect(Math.hypot(corner.at[0] - deep[0], corner.at[1] - deep[1]))
        .toBeGreaterThan(BIT / 2)
    }
  })

  it('rounds the corner the pallet\'s back makes with its arm', () => {
    // The other inside corner, and the other one no cutter cuts sharp — but
    // nothing acts on the back of a pallet and there is room where it stands,
    // so it is rounded in place. It is the entry pallet that has one: the exit
    // nib's back runs out through its arm's OUTER edge and is cut off there.
    expect(__escBackCorner(BASE, 'exit')).toBeNull()
    for (const escType of ['deadbeat', 'recoil'] as const) {
      expect(__escBackCorner({ ...BASE, escType }, 'entry')).not.toBeNull()
    }
  })

  it('leaves no sharp node at either corner it rounds', () => {
    // The failure mode of picking corners by coordinate is silence: a target
    // that misses rounds nothing and the outline comes out exactly as sharp as
    // it went in. A treated corner is REPLACED by its two tangent points, so
    // the corner's own position is what must no longer be a node.
    for (const escType of ['deadbeat', 'recoil'] as const) {
      for (const clockwise of [false, true]) {
        const spec = { ...BASE, escType, clockwise }
        const mir = clockwise ? 1 : -1
        const yA = anchorOffset(spec)
        const poly = outline(spec)
        for (const side of ['entry', 'exit'] as const) {
          for (const raw of [__escLockCorner(spec, side)?.at, __escBackCorner(spec, side)]) {
            if (!raw) continue
            const at = [spec.cx + mir * raw[0], spec.cy + raw[1] + yA]
            const near = Math.min(...poly.map((q) => Math.hypot(q[0] - at[0], q[1] - at[1])))
            expect(near).toBeGreaterThan(0.4)
          }
        }
      }
    }
  })

  it('takes the set-back off the arm at the pallet, not at the hub', () => {
    // An arm carries its bending at the hub; the pallet end is where it can be
    // spared. And the flank it comes off is the WHEEL side, so the taper can
    // only ever open the running clearance.
    const corner = __escLockCorner(BASE, 'exit')!
    expect(corner.taper).toBeLessThan(BASE.armWidth / 2)
  })
})

describe('escapement — the drop lock', () => {
  // A tooth arrives by FALLING, and what it falls onto decides whether the
  // escapement is a deadbeat or a thing that trips through every beat. The bare
  // loci give each pallet an impulse beginning at the very anchor angle at which
  // the other releases, so the tooth meets the corner between the two faces —
  // and the running clearance then carries it past that corner onto a face lying
  // ~53° off the wheel's radius, where it slides instead of locking. Nothing in
  // the outline, in the readouts or in the binding check can see it: the pair
  // meshes perfectly and never touches. Only asking WHERE the tooth lands does.

  const rot = (p: [number, number], a: number): [number, number] =>
    [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)]
  const rad = (d: number) => (d * Math.PI) / 180

  /** Where a tooth first comes to rest on one pallet, as a fractional index into
   *  that pallet's acting profile. Driven by the same pose the animation runs. */
  const landing = (spec: EscapementSpec, side: 'entry' | 'exit') => {
    const L = escapementDims(spec).centreDistance
    const mir = spec.clockwise ? 1 : -1
    const face = __escFaces(spec, side)
    const wheel = generateEscapementParts(spec).find((p) => p.key === 'wheel')!.d
      .replace(/[MZ]/g, ' ').split('L').map((t) => t.trim().split(',').map(Number))
      .filter((p) => p.length === 2 && p.every(Number.isFinite)) as [number, number][]
    const rTip = spec.wheelDia / 2
    const tips = wheel.filter((p) => Math.hypot(p[0], p[1]) > rTip - 0.02)
    // Into the anchor's own frame, where the faces live — and back out of the
    // mirror the emitted parts were placed through.
    const toAnchor = (w: [number, number], thW: number, thA: number): [number, number] => {
      const world = rot(w, thW)
      const q = rot([world[0], world[1] - L], -thA)
      return [mir * q[0], q[1]]
    }
    // The landing is the instant AFTER the drop, and the drop is the one moment
    // the wheel angle jumps — so find the jump rather than guess a phase. Asking
    // for the closest approach over the whole cycle would answer nothing: the
    // tooth is ON the face for most of a beat, at a distance of zero.
    const N = 4000
    const w = (i: number) => escapementPose(spec, i / N).wheelDeg
    let best = { d: Infinity, at: 0 }
    for (let i = 1; i <= N; i++) {
      if (Math.abs(w(i) - w(i - 1)) < spec.drop * 0.5) continue
      const pose = escapementPose(spec, i / N)
      for (const t of tips) {
        const q = toAnchor(t, rad(pose.wheelDeg), rad(pose.anchorDeg))
        for (let k = 1; k < face.length; k++) {
          const [ax, ay] = face[k - 1], [bx, by] = face[k]
          const dx = bx - ax, dy = by - ay
          const u = Math.max(0, Math.min(1, ((q[0] - ax) * dx + (q[1] - ay) * dy) / (dx * dx + dy * dy || 1)))
          const dd = Math.hypot(ax + u * dx - q[0], ay + u * dy - q[1])
          if (dd < best.d) best = { d: dd, at: k - 1 + u }
        }
      }
    }
    return best
  }

  it('lands the tooth on dead face, clear of the corner it turns into impulse at', () => {
    const nLock = __escLockPoints(BASE)          // face[nLock - 1] IS the corner
    for (const clockwise of [false, true]) {
      for (const clearance of [0, 0.3, 0.6]) {
        for (const side of ['entry', 'exit'] as const) {
          const spec = { ...BASE, clockwise, clearance }
          const hit = landing(spec, side)
          const face = __escFaces(spec, side)
          expect(hit.d).toBeLessThan(0.05)
          // On the locking arc, not on the impulse face past it.
          expect(hit.at).toBeLessThan(nLock - 1)
          // And clear of the corner by real dead face, measured as a length —
          // this is the whole of the fix, and it is what the clearance eats.
          const k = Math.floor(hit.at)
          const p: [number, number] = [
            face[k][0] + (face[k + 1][0] - face[k][0]) * (hit.at - k),
            face[k][1] + (face[k + 1][1] - face[k][1]) * (hit.at - k),
          ]
          const B = face[nLock - 1]
          const under = Math.hypot(p[0] - B[0], p[1] - B[1])
          expect(under).toBeGreaterThan(0.1)
          // And it is the figure the panel prints. Quoted at the nominal pallet
          // radius, where the two faces sit at 48.2 and 51.7 mm, so it is a few
          // hundredths out either way — but it is the same number, which is what
          // stops the readout and the geometry drifting apart.
          expect(under).toBeCloseTo(escapementDims(spec).dropLockDepth, 1)
          // With run to lock still left above it — all of the lock as drop lock
          // and the supplementary arc drives the tooth off the deep end.
          expect(hit.at).toBeGreaterThan(0.5)
        }
      }
    }
  })

  it('never doubles the acting profile back on itself', () => {
    // The tempting way to give the tooth somewhere dead to land is to run the
    // dead arc on PAST the start of impulse. It cannot work — past that point is
    // the impulse face's own ground, so the extension retraces it, and the
    // boolean drops the zero-width spur without a word. What is left is the bare
    // corner it was meant to cover, one twentieth of the face shorter.
    for (const escType of ['deadbeat', 'recoil'] as const) {
      for (const side of ['entry', 'exit'] as const) {
        const face = __escFaces({ ...BASE, escType }, side)
        for (let i = 1; i < face.length - 1; i++) {
          let t = Math.atan2(face[i + 1][1] - face[i][1], face[i + 1][0] - face[i][0])
            - Math.atan2(face[i][1] - face[i - 1][1], face[i][0] - face[i - 1][0])
          while (t > Math.PI) t -= 2 * Math.PI
          while (t < -Math.PI) t += 2 * Math.PI
          expect(Math.abs((t * 180) / Math.PI)).toBeLessThan(150)
        }
        // And no duplicated vertex where the lock arc hands over to the impulse.
        for (let i = 1; i < face.length; i++) {
          expect(Math.hypot(face[i][0] - face[i - 1][0], face[i][1] - face[i - 1][1]))
            .toBeGreaterThan(1e-9)
        }
      }
    }
  })

  it('spends the drop lock OUT of the lock, and reports both', () => {
    // The tooth lands on part of the lock and the supplementary arc runs it to
    // the rest. Asking for more lock buys more of both until the drop lock has
    // all the dead face it wants, which is a fixed length past the clearance.
    for (const lock of [1, 1.5, 3, 6]) {
      const d = escapementDims({ ...BASE, lock })
      expect(d.dropLockDepth).toBeGreaterThan(0)
      expect(d.dropLockDepth).toBeLessThanOrEqual(d.lockDepth + 1e-9)
      expect(d.noLock).toBe(false)
    }
    // Too little lock to seat a landing in, and it says so — the tooth would
    // arrive on the impulse face. This is stricter than the old test (which only
    // caught the clearance eating the lock ENTIRELY) and it has to be: a tooth
    // landing on the impulse face is exactly as broken and looks exactly as fine.
    expect(escapementDims({ ...BASE, lock: 0.5 }).noLock).toBe(true)
  })

  it('gives a recoil anchor none of it', () => {
    // A recoil has no dead face and is not supposed to: its tooth lands on the
    // impulse face and drives the wheel back, which is what a recoil escapement
    // IS. So the embrace is left alone and its faces sit where the bare loci put
    // them, whatever the lock is asked to be.
    expect(escapementDims({ ...BASE, escType: 'recoil' }).dropLockDepth).toBe(0)
    for (const side of ['entry', 'exit'] as const) {
      const a = __escFaces({ ...BASE, escType: 'recoil', lock: 0 }, side)
      const b = __escFaces({ ...BASE, escType: 'recoil', lock: 3 }, side)
      for (let i = 0; i < a.length; i++) {
        expect(a[i][0]).toBeCloseTo(b[i][0], 12)
        expect(a[i][1]).toBeCloseTo(b[i][1], 12)
      }
    }
  })

  it('still gives up exactly half a tooth per beat', () => {
    // The embrace shifts each pallet's impulse window off the anchor's neutral,
    // in opposite senses, so the handover arithmetic in `escapementPose` had to
    // move with it. If it did not, the wheel loses or gains on every beat.
    for (const escType of ['deadbeat', 'recoil'] as const) {
      for (const clockwise of [false, true]) {
        const spec = { ...BASE, escType, clockwise }
        const w = (p: number) => escapementPose(spec, p).wheelDeg
        const halfTooth = (clockwise ? -1 : 1) * 180 / BASE.teeth
        expect(w(0.5) - w(0)).toBeCloseTo(halfTooth, 9)
        expect(w(1) - w(0.5)).toBeCloseTo(halfTooth, 9)
        expect(w(3) - w(2)).toBeCloseTo(2 * halfTooth, 9)
      }
    }
  })
})

describe('escapement — the wedge\'s leading edge', () => {
  // Past the deep end of the acting face the pallet carries on into the arm, and
  // that last stretch used to leave along the WHEEL'S RADIAL. The two directions
  // agree only at the tangency point the whole construction is built on, and the
  // deep lock is a lock's worth of arc past it — 6° by the far end of the entry
  // pallet, which on a 5 mm run puts the top of the arm 0.6 mm off the line the
  // face was on. It reads as the pallet swinging away from the arbor at exactly
  // the point the face ends, with nothing behind it.
  it('carries the locking face straight on into the arm, with no break at its end', () => {
    for (const escType of ['deadbeat', 'recoil'] as const) {
      for (const clockwise of [false, true]) {
        for (const side of ['entry', 'exit'] as const) {
          const spec = { ...BASE, escType, clockwise }
          const mir = clockwise ? 1 : -1
          const yA = anchorOffset(spec)
          const place = (p: [number, number]): [number, number] =>
            [spec.cx + mir * p[0], spec.cy + p[1] + yA]
          const face = __escFaces(spec, side)
          // The deep-lock end and the direction the face is going when it gets
          // there — both in placed coordinates, since that is where the outline
          // is and the mirror reverses the sense of x.
          const end = place(face[0]), prev = place(face[1])
          const len = Math.hypot(end[0] - prev[0], end[1] - prev[1])
          const dir: [number, number] = [(end[0] - prev[0]) / len, (end[1] - prev[1]) / len]

          const poly = (generateEscapementParts(spec).find((p) => p.key === 'anchor')!.d
            .match(/[MLAC][^MLACZQ]*/g) || [])
            .map((c) => c.match(/-?\d+(\.\d+)?/g)!)
            .map((v) => [Number(v[v.length - 2]), Number(v[v.length - 1])] as [number, number])

          // A millimetre on along the face's own line must still be ON the
          // outline. Off the wheel's radial instead it is a tenth of a
          // millimetre clear of it, and the deep-lock fillet has not started
          // that soon on either pallet.
          const probe: [number, number] = [end[0] + dir[0], end[1] + dir[1]]
          let best = Infinity
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const [ax, ay] = poly[j], [bx, by] = poly[i]
            const dx = bx - ax, dy = by - ay
            const u = Math.max(0, Math.min(1, ((probe[0] - ax) * dx + (probe[1] - ay) * dy) / (dx * dx + dy * dy || 1)))
            best = Math.min(best, Math.hypot(ax + u * dx - probe[0], ay + u * dy - probe[1]))
          }
          expect(best).toBeLessThan(0.03)
        }
      }
    }
  })
})
