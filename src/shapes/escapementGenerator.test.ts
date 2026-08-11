import { describe, it, expect } from 'vitest'
import {
  generateEscapementParts, escapementDims, escapementPose, __escFaces, __escTipLand,
  __escToothRing, type EscapementSpec,
} from './escapementGenerator'
import { scaleShapeParams, type ShapeParams } from './shapeGenerators'

// Whether the thing actually escapes is a question about the wheel and the
// anchor TOGETHER, and it is answered by running the mesh — see
// `scripts/escapement-check.mts`. What is pinned here is everything that can be
// checked on one part at a time: the construction the pallets are placed by, the
// inputs that make an escapement that cannot run, and the emitted parts.

const BASE: EscapementSpec = {
  cx: 0, cy: 0, escType: 'deadbeat', teeth: 30, wheelDia: 100, span: 7.5,
  toothDepth: 6, undercut: 20, drop: 2, lift: 3, lock: 1.5, draw: 2, recoilArc: 4,
  toothCurve: 0.6, clearance: 0.3,
  armWidth: 8, tailLength: 0, bore: 6, hubDia: 20, spokes: 5, anchorBore: 6,
  clockwise: false, refCircles: false,
}

describe('escapement — the classic construction', () => {
  it('puts the arbor where the tangents to the tip circle cross', () => {
    // L = R/cos(β/2) and ρ = R·tan(β/2), which together say AP ⟂ OP: the
    // pallet arms lie along tangents. Everything else rests on this.
    for (const span of [5.5, 7.5, 10.5]) {
      const d = escapementDims({ ...BASE, span })
      const R = BASE.wheelDia / 2
      const beta = (span * 2 * Math.PI) / BASE.teeth
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

  it('flags a span that is not an odd number of half teeth', () => {
    // The wheel gives up half a tooth per beat, so the pallets have to stand an
    // odd number of half pitches apart or one releases without the other
    // catching. This is the classic way to draw an escapement that cannot run.
    expect(escapementDims({ ...BASE, span: 7.5 }).spanUneven).toBe(false)
    expect(escapementDims({ ...BASE, span: 8.5 }).spanUneven).toBe(false)
    expect(escapementDims({ ...BASE, span: 8 }).spanUneven).toBe(true)
    expect(escapementDims({ ...BASE, span: 7 }).spanUneven).toBe(true)
    expect(escapementDims({ ...BASE, span: 7.25 }).spanUneven).toBe(true)
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

  it('leans the locking face inward when draw is asked for', () => {
    for (const side of ['entry', 'exit'] as const) {
      const face = __escFaces({ ...BASE, draw: 3 }, side)
      const r = face.slice(0, 20).map((p) => Math.hypot(p[0], p[1]))
      // Deepest first: the face closes on the arbor as the lock deepens, so the
      // drive tightens the lock instead of picking it.
      expect(r[0]).toBeLessThan(r[r.length - 1])
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
    expect(keys).not.toContain('ref')
    expect(generateEscapementParts({ ...BASE, refCircles: true }).map((p) => p.key)).toContain('ref')
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
    expect(out.span).toBe(7.5)
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

describe('escapement — the pallet tip land', () => {
  it('leaves the tooth clear of the land at release', () => {
    // The land is the pallet blade's own end face, square, and it sits within
    // about 2° of the tooth's direction of travel at release — which reads off
    // the drawing as "the tooth must rub along it and give the impulse back".
    // It does not: the pallet withdraws while the tooth runs on, so they part
    // far faster than that angle suggests. This pins the clearance, because the
    // binding check cannot see it (grazing is not interference) and the outline
    // shows only a small bevel.
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
        const [c0, c1] = __escTipLand(S, side)
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

describe('escapement — running clearance', () => {
  it('takes the clearance off the lock, and says what is left', () => {
    // Backlash, in effect: the teeth are cut short of the circle the pallets
    // were laid out for, so the gap opens everywhere the two meet and the lock
    // gives up exactly that much.
    const rho = escapementDims(BASE).palletRadius
    const nominal = rho * (BASE.lock * Math.PI) / 180
    for (const clearance of [0, 0.15, 0.3, 0.5]) {
      const d = escapementDims({ ...BASE, clearance })
      expect(d.lockDepth).toBeCloseTo(nominal - clearance, 9)
      expect(d.noLock).toBe(false)
    }
  })

  it('says so when the clearance has eaten the whole lock', () => {
    // Past this the wheel does not lock at all, it runs straight through — the
    // one failure of this parameter, and it is silent on the drawing.
    const rho = escapementDims(BASE).palletRadius
    const nominal = rho * (BASE.lock * Math.PI) / 180
    expect(escapementDims({ ...BASE, clearance: nominal + 0.5 }).noLock).toBe(true)
  })

  it('shortens the teeth and leaves everything else alone', () => {
    const tipR = (spec: EscapementSpec) => {
      const pts = generateEscapementParts(spec).find((p) => p.key === 'wheel')!.d
        .replace(/[MZ]/g, ' ').split('L').map((t) => t.trim().split(',').map(Number))
        .filter((p) => p.length === 2 && p.every(Number.isFinite))
      return Math.max(...pts.map((p) => Math.hypot(p[0] - spec.cx, p[1] - spec.cy)))
    }
    // Two decimals, not six: the root-fillet closing is a clipper offset pass
    // over the whole outline and it moves a tip by a few microns. Tightening
    // this would only be pinning that.
    expect(tipR({ ...BASE, clearance: 0 })).toBeCloseTo(BASE.wheelDia / 2, 2)
    expect(tipR({ ...BASE, clearance: 0.4 })).toBeCloseTo(BASE.wheelDia / 2 - 0.4, 2)
    // The pallets are laid out for the nominal circle and must not move with it.
    expect(escapementDims({ ...BASE, clearance: 0.4 }).palletRadius)
      .toBeCloseTo(escapementDims(BASE).palletRadius, 9)
    expect(escapementDims({ ...BASE, clearance: 0.4 }).centreDistance)
      .toBeCloseTo(escapementDims(BASE).centreDistance, 9)
  })
})

describe('escapement — bowed tooth flanks', () => {
  it('thickens the root without moving the tip', () => {
    // Straight flanks taper to a narrow base and leave the tooth weak across the
    // grain. The bow swells it towards the root — and must not touch the tip,
    // which is the acting surface the pallet faces were generated from.
    const base = (toothCurve: number) => escapementDims({ ...BASE, toothCurve }).toothBase
    expect(base(0.5)).toBeGreaterThan(base(0) * 1.3)
    expect(base(1)).toBeGreaterThan(base(0.5))
    const tipR = (toothCurve: number) => {
      const pts = generateEscapementParts({ ...BASE, toothCurve }).find((p) => p.key === 'wheel')!.d
        .replace(/[MZ]/g, ' ').split('L').map((t) => t.trim().split(',').map(Number))
        .filter((p) => p.length === 2 && p.every(Number.isFinite))
      return Math.max(...pts.map((p) => Math.hypot(p[0], p[1])))
    }
    expect(tipR(1)).toBeCloseTo(tipR(0), 2)
  })

  it('leaves no step where a flank meets the root land', () => {
    // The bow is ANGULAR, so a bowed foot stays ON the root circle and the land
    // simply runs between the feet it is given. Displace the foot off that circle
    // instead — which a bow taken perpendicular to the flank does — and the land
    // still starts where the foot used to be, leaving a visible step at every
    // tooth that no dimension catches.
    //
    // Tested on the RAW ring: the emitted outline has been through the
    // root-fillet closing, which resamples it and collapses straight runs, so a
    // long edge there means nothing.
    const rRoot = escapementDims(BASE).wheelRootDia / 2
    for (const toothCurve of [0, 0.5, 1]) {
      const ring = __escToothRing({ ...BASE, toothCurve })
      // The invariant itself: the profile never leaves the band between root and
      // tip, and it REACHES the root circle exactly. A bow taken perpendicular to
      // the flank pushes the foot off that circle, and then the land — which is
      // still drawn on it — no longer meets the flank.
      const rs = ring.map((p) => Math.hypot(p[0], p[1]))
      expect(Math.min(...rs)).toBeCloseTo(rRoot, 9)
      expect(Math.max(...rs)).toBeCloseTo(BASE.wheelDia / 2 - BASE.clearance, 9)
    }
  })
})
