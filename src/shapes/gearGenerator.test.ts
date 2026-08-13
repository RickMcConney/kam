import { describe, it, expect } from 'vitest'
import {
  generateGearD, gearDims, gearHub, gearMesh, gearMateParts, gearMeshRefD, gearPose,
  moduleForRadius, FLANK_TOL, type GearSpec,
} from './gearGenerator'
import { generateShapeD } from './shapeGenerators'
import { flattenPath, signedArea } from '../cam/pathFlattener'
import { pointInPolygon, ptSegDistSq } from '../cam/geom'

// No tooth-count label: these tests measure the cut geometry, and the label is
// engraved text that would only add an open subpath to walk past. (It is null in
// node anyway — the single-stroke font is fetched in the browser.)
const base: GearSpec = {
  cx: 0, cy: 0, module: 2, teeth: 24, pressureAngle: 20, bore: 8, hubDia: 16, spokes: 5, backlash: 0,
  toothProfile: 'involute', mateTeeth: 8, pinDia: 2.5, emitPinion: false,
  toothLabel: false, pitchCircle: false,
}

// [module, teeth, pressure angle]
const CASES: [number, number, number][] = [
  [2, 24, 20], [1.5, 40, 20], [3, 12, 20], [2, 30, 14.5], [1, 80, 25], [5, 6, 20],
]

const inv = (a: number) => Math.tan(a) - a

function outline(p: GearSpec) {
  return flattenPath(generateGearD(p), 0.005)[0]
}

/** Arc thickness of the material at radius `r`, averaged over the teeth. */
function toothThicknessAt(ring: number[][], r: number): { teeth: number; s: number } {
  const hits: number[] = []
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const r1 = Math.hypot(ring[j][0], ring[j][1]), r2 = Math.hypot(ring[i][0], ring[i][1])
    if ((r1 > r) === (r2 > r)) continue
    const t = (r - r1) / (r2 - r1)
    hits.push(Math.atan2(ring[j][1] + t * (ring[i][1] - ring[j][1]), ring[j][0] + t * (ring[i][0] - ring[j][0])))
  }
  hits.sort((a, b) => a - b)
  if (hits.length < 2) return { teeth: 0, s: NaN }
  // Pair the crossings so each pair spans MATERIAL, not air — at the pitch
  // circle tooth and space are equal, so getting this wrong would still pass
  // there and fail everywhere else.
  const mid = (hits[0] + hits[1]) / 2
  const start = pointInPolygon(r * Math.cos(mid), r * Math.sin(mid), ring as [number, number][]) ? 0 : 1
  const widths: number[] = []
  for (let i = start; i + 1 < hits.length; i += 2) widths.push((hits[i + 1] - hits[i]) * r)
  return { teeth: hits.length / 2, s: widths.reduce((a, b) => a + b, 0) / widths.length }
}

describe('gearDims', () => {
  it('derives the standard diameters from module, teeth and pressure angle', () => {
    for (const [m, z, a] of CASES) {
      const d = gearDims(m, z, a)
      const tag = `m${m} z${z} ${a}°`
      expect(d.pitchDia, tag).toBeCloseTo(m * z, 9)
      expect(d.baseDia, tag).toBeCloseTo(m * z * Math.cos((a * Math.PI) / 180), 9)
      expect(d.rootDia, tag).toBeCloseTo(m * (z - 2.5), 9)
      expect(d.circularPitch, tag).toBeCloseTo(Math.PI * m, 9)
      // The tip is nominal unless the tooth ran to a point first.
      if (!d.pointed) expect(d.outsideDia, tag).toBeCloseTo(m * (z + 2), 9)
      else expect(d.outsideDia, tag).toBeLessThan(m * (z + 2))
    }
  })

  it('flags the undercut limit at z < 2/sin²α', () => {
    // 2/sin²20° = 17.097, so 18 is the first count genuinely free of it — the
    // familiar "17 teeth" is that figure rounded down.
    expect(gearDims(2, 18, 20).undercut).toBe(false)
    expect(gearDims(2, 17, 20).undercut).toBe(true)
    expect(gearDims(2, 30, 14.5).undercut).toBe(true)   // 14.5° needs 32
    expect(gearDims(2, 33, 14.5).undercut).toBe(false)
  })
})

describe('generateGearD', () => {
  it('cuts a true involute — tooth thickness obeys s(r) = 2r(π/2z + inv α − inv α_r)', () => {
    // This is the property that decides whether the gear meshes, and no
    // rounded-tooth approximation satisfies it away from the pitch circle.
    for (const [m, z, a] of CASES) {
      const tag = `m${m} z${z} ${a}°`
      const d = gearDims(m, z, a)
      const alpha = (a * Math.PI) / 180
      const rb = d.baseDia / 2, rp = d.pitchDia / 2, ra = d.outsideDia / 2
      const ring = outline({ ...base, module: m, teeth: z, pressureAngle: a, bore: 0, spokes: 0 })
      const want = (r: number) =>
        2 * r * (Math.PI / (2 * z) + inv(alpha) - inv(Math.acos(Math.min(1, rb / r))))

      // At the pitch circle, and partway up the addendum where tooth ≠ space.
      //
      // Tolerance is FLANK_TOL, not a decimal place: the flank is a polyline
      // sampled to that chord tolerance, so this is as close as the emitted
      // path can be to the ideal involute by construction. Tightening it would
      // only be pinning the sampling density.
      for (const r of [rp, rp + (ra - rp) * 0.6]) {
        const got = toothThicknessAt(ring, r)
        expect(got.teeth, `${tag} tooth count at r=${r.toFixed(2)}`).toBe(z)
        expect(Math.abs(got.s - want(r)), `${tag} thickness at r=${r.toFixed(2)}`).toBeLessThan(2 * FLANK_TOL)
        // Inscribed chords, so the tooth may come out thin — never fat. Thin is
        // a few microns of extra backlash; fat is interference.
        expect(got.s, `${tag} tooth is FAT at r=${r.toFixed(2)}`).toBeLessThan(want(r) + 1e-4)
      }
    }
  })

  it('puts the standard tooth thickness on the pitch circle', () => {
    for (const [m, z, a] of CASES) {
      const ring = outline({ ...base, module: m, teeth: z, pressureAngle: a, bore: 0, spokes: 0 })
      const { s } = toothThicknessAt(ring, gearDims(m, z, a).pitchDia / 2)
      expect(Math.abs(s - (Math.PI * m) / 2), `m${m} z${z}`).toBeLessThan(2 * FLANK_TOL)
    }
  })

  it('never crosses its own flanks, even where the teeth run to a point', () => {
    // Carrying the involute past the point where the flanks meet produces a
    // self-intersecting outline that looks plausible until it is cut.
    //
    // Tested by actually LOOKING FOR A CROSSING, not by asking whether the polar
    // angle advances all the way round. It does not, and must not: an UNDERCUT
    // flank is re-entrant — the trochoid dips inside the involute and comes back
    // out — so its polar angle genuinely runs backwards for a stretch. That was a
    // fair proxy while the roots were cut radially, and it fails the moment they
    // are cut the way a hob leaves them (m5 z6 at 20° backtracks by 0.002 rad on
    // a perfectly sound tooth). Segment-against-segment is the thing itself.
    for (const [m, z, a] of [...CASES, [5, 6, 35], [4, 5, 30], [4, 8, 20], [4, 12, 20]] as [number, number, number][]) {
      const ring = outline({ ...base, module: m, teeth: z, pressureAngle: a, bore: 0, spokes: 0 })
      const tag = `m${m} z${z} ${a}°`
      const n = ring.length
      const cross = (p: number[], q: number[], r: number[], t: number[]) => {
        const d = (o: number[], u: number[], v: number[]) =>
          (u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0])
        const d1 = d(r, t, p), d2 = d(r, t, q), d3 = d(p, q, r), d4 = d(p, q, t)
        return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))
      }
      let hit = ''
      for (let i = 0; i < n && !hit; i++) {
        const p = ring[i], q = ring[(i + 1) % n]
        const x0 = Math.min(p[0], q[0]), x1 = Math.max(p[0], q[0])
        const y0 = Math.min(p[1], q[1]), y1 = Math.max(p[1], q[1])
        // Skip the neighbours: consecutive segments share an endpoint.
        for (let j = i + 2; j < n - (i === 0 ? 1 : 0); j++) {
          const r = ring[j], t = ring[(j + 1) % n]
          if (Math.max(r[0], t[0]) < x0 || Math.min(r[0], t[0]) > x1) continue
          if (Math.max(r[1], t[1]) < y0 || Math.min(r[1], t[1]) > y1) continue
          // Segments that share an endpoint are not a crossing. The ring closes
          // on itself — the last tooth's root arc ends exactly where the first
          // tooth's flank begins — so the wrap pair meets at a point and reads
          // as one without this.
          const shared = [p, q].some((u) => [r, t].some((v) => Math.hypot(u[0] - v[0], u[1] - v[1]) < 1e-9))
          if (shared) continue
          if (cross(p, q, r, t)) { hit = `segments ${i} and ${j}` ; break }
        }
      }
      expect(hit, `${tag} self-intersects: ${hit}`).toBe('')
      // And it still closes once round — a profile that lost a whole tooth or
      // doubled one would pass the crossing test and fail this.
      let turned = 0
      for (let i = 0; i < n; i++) {
        const a0 = Math.atan2(ring[i][1], ring[i][0])
        const a1 = Math.atan2(ring[(i + 1) % n][1], ring[(i + 1) % n][0])
        let da = a1 - a0
        if (da > Math.PI) da -= 2 * Math.PI
        if (da < -Math.PI) da += 2 * Math.PI
        turned += da
      }
      expect(Math.abs(turned), tag).toBeCloseTo(2 * Math.PI, 3)
    }
  })

  it('cuts every tooth symmetric about its own centreline', () => {
    // An asymmetric tooth drives correctly one way round and badly the other,
    // which no amount of looking at the whole gear reveals. Tooth 0 is centred
    // on angle 0, so the outline must be invariant under y → −y.
    //
    // Compare against the profile, NOT against r(angle): the radial root run
    // makes r(angle) genuinely discontinuous at ±ψ, and a sampler that straddles
    // that step reports the step height as an error on a perfectly good gear.
    //
    // The bug this pins skewed the root by one arc step of the root circle, so
    // it grew as the pressure angle fell (ψ = π/2z + inv α shrinks, the root arc
    // lengthens, its steps coarsen) — hence the sweep below.
    for (const [m, z, a] of [...CASES, [2, 24, 8], [2, 24, 12], [5, 6, 35]] as [number, number, number][]) {
      const ring = outline({ ...base, module: m, teeth: z, pressureAngle: a, bore: 0, spokes: 0 })
      let worst = 0
      for (const [x, y] of ring) {
        let best = Infinity
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          best = Math.min(best, ptSegDistSq(x, -y, ring[j][0], ring[j][1], ring[i][0], ring[i][1]))
          if (best < 1e-12) break
        }
        worst = Math.max(worst, Math.sqrt(best))
      }
      // The flattening tolerance alone is 0.005 mm; the defect was 0.7–1.4 mm.
      expect(worst, `m${m} z${z} ${a}° tooth is lopsided`).toBeLessThan(0.02)
    }
  })

  it('fillets every tooth root, and leaves the tips sharp', () => {
    // The radial root meets the root circle at a right angle; a closing of
    // 0.38·m — the standard rack tip radius — sweeps all of them out in one
    // pass. The TIPS must stay sharp: that corner is the tooth's tip land
    // meeting the involute, and rounding it would take the gear off profile.
    const ring = outline({ ...base, bore: 0, spokes: 0 })
    const d = gearDims(base.module, base.teeth, base.pressureAngle)
    const turnAt = (i: number) => {
      const p = ring[(i - 1 + ring.length) % ring.length], q = ring[i], r = ring[(i + 1) % ring.length]
      const u = Math.hypot(q[0] - p[0], q[1] - p[1]), v = Math.hypot(r[0] - q[0], r[1] - q[1])
      if (u < 1e-9 || v < 1e-9) return 0
      const dot = ((q[0] - p[0]) * (r[0] - q[0]) + (q[1] - p[1]) * (r[1] - q[1])) / (u * v)
      return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI
    }
    let worstRoot = 0, worstTip = 0
    for (let i = 0; i < ring.length; i++) {
      const r = Math.hypot(ring[i][0], ring[i][1])
      if (r < d.baseDia / 2) worstRoot = Math.max(worstRoot, turnAt(i))
      if (r > d.outsideDia / 2 - 0.01) worstTip = Math.max(worstTip, turnAt(i))
    }
    expect(worstRoot, 'root corners should be swept out').toBeLessThan(30)
    expect(worstTip, 'tip corners should stay sharp').toBeGreaterThan(20)
  })

  it('emits outline CCW with bore and spoke windows CW inside it', () => {
    const polys = flattenPath(generateGearD(base), 0.05)
    expect(polys.length).toBe(2 + base.spokes)      // outline + bore + windows
    expect(signedArea(polys[0])).toBeGreaterThan(0)
    for (let i = 1; i < polys.length; i++) {
      expect(signedArea(polys[i]), `subpath ${i}`).toBeLessThan(0)
      for (const [px, py] of polys[i])
        expect(pointInPolygon(px, py, polys[0] as [number, number][]), `subpath ${i} escapes`).toBe(true)
    }
  })

  it('leaves a rim and a hub around the spoke windows', () => {
    const d = gearDims(base.module, base.teeth, base.pressureAngle)
    const polys = flattenPath(generateGearD(base), 0.05)
    const radii = polys.slice(2).flatMap((w) => w.map((q) => Math.hypot(q[0], q[1])))
    // Windows stay clear of the root circle (rim stock) and of the bore (hub).
    expect(Math.max(...radii)).toBeLessThan(d.rootDia / 2)
    expect(Math.min(...radii)).toBeGreaterThan(base.bore / 2)
  })

  it('grows the hub to seat the spokes it was asked for', () => {
    // Spokes are a fixed width, so what caps their number is the circumference
    // they land on. Growing the hub is the fix; silently dropping every window
    // and returning a solid gear is what this replaced.
    for (const n of [3, 5, 8, 12, 16]) {
      const hub = gearHub(2, 40, 8, 16, n)
      const polys = flattenPath(generateGearD({ ...base, teeth: 40, spokes: n }), 0.05)
      expect(hub.spoked, `${n} spokes`).toBe(true)
      expect(polys.length, `${n} spokes cut`).toBe(2 + n)
      // Every window clears the hub it was sized against.
      const radii = polys.slice(2).flatMap((w) => w.map((q) => Math.hypot(q[0], q[1])))
      expect(Math.min(...radii), `${n} spokes clear the hub`).toBeGreaterThan(hub.dia / 2 - 0.6)
    }
  })

  it('treats hub diameter as a floor, never shrinking below it or below the bore', () => {
    // Asked for more than the spokes need: the request stands.
    const big = gearHub(2, 40, 8, 40, 5)
    expect(big.dia).toBeCloseTo(40, 6)
    expect(big.grown).toBe(false)
    // Asked for less than the spokes need: grown, and flagged.
    const small = gearHub(2, 40, 8, 5, 12)
    expect(small.grown).toBe(true)
    expect(small.dia).toBeGreaterThan(5)
    // Never tighter than the wall the axle needs (bore + 2·module each side).
    expect(gearHub(2, 40, 20, 1, 0).dia).toBeCloseTo(20 + 4 * 2, 6)
  })

  it('reports the real spoke ceiling instead of failing silently', () => {
    for (const [m, z, bore] of [[2, 24, 8], [2, 40, 8], [1, 60, 6], [5, 20, 30]] as const) {
      const { maxSpokes } = gearHub(m, z, bore, 0, 0)
      if (maxSpokes >= 2) {
        expect(gearHub(m, z, bore, 0, maxSpokes).spoked, `${m}/${z} at max`).toBe(true)
        expect(gearHub(m, z, bore, 0, maxSpokes + 1).spoked, `${m}/${z} past max`).toBe(false)
      } else {
        expect(gearHub(m, z, bore, 0, 2).spoked, `${m}/${z} has no web`).toBe(false)
      }
    }
  })

  it('drops the spokes rather than shredding a gear too small for them', () => {
    const tiny = flattenPath(generateGearD({ ...base, module: 1, teeth: 10, bore: 6, spokes: 8 }), 0.05)
    const outer = tiny[0]
    for (let i = 1; i < tiny.length; i++)
      for (const [px, py] of tiny[i]) expect(pointInPolygon(px, py, outer as [number, number][])).toBe(true)
  })

  it('takes backlash off the tooth thickness and nothing else', () => {
    // Slop in a wooden gear is tooth THINNING, not a wider centre distance:
    // thinning rotates the flank but leaves it the same involute of the same
    // base circle, so the pair still runs conjugate. Pitch, base and root
    // diameters must therefore be untouched, and the placement rule with them.
    for (const [m, z, a] of CASES) {
      const tag = `m${m} z${z} ${a}°`
      const j = 0.3
      const plain = gearDims(m, z, a, 0), lash = gearDims(m, z, a, j)
      expect(lash.pitchDia, tag).toBeCloseTo(plain.pitchDia, 9)
      expect(lash.baseDia, tag).toBeCloseTo(plain.baseDia, 9)
      expect(lash.rootDia, tag).toBeCloseTo(plain.rootDia, 9)
      // Each gear gives up half the play, so a PAIR set to j has j of it.
      expect(lash.toothThickness, tag).toBeCloseTo(plain.toothThickness - j / 2, 6)

      // And it shows up in the cut profile, measured at the pitch circle.
      const ring = outline({ ...base, module: m, teeth: z, pressureAngle: a, backlash: j, bore: 0, spokes: 0 })
      const got = toothThicknessAt(ring, plain.pitchDia / 2)
      expect(got.teeth, tag).toBe(z)
      expect(Math.abs(got.s - ((Math.PI * m) / 2 - j / 2)), tag).toBeLessThan(2 * FLANK_TOL)
    }
  })

  it('leaves a sliver rather than inverting a tooth thinned past nothing', () => {
    const ring = outline({ ...base, module: 1, teeth: 8, backlash: 50, bore: 0, spokes: 0 })
    expect(ring.length).toBeGreaterThan(8)
    const { teeth } = toothThicknessAt(ring, gearDims(1, 8, 20, 50).pitchDia / 2)
    expect(teeth).toBe(8)
  })

  it('draws the pitch circle on request, at the radius two gears mesh on', () => {
    // Two gears mesh when their pitch circles are TANGENT, so this is the line
    // to place centres against. It is the one subpath that CROSSES the outline
    // (it runs through the teeth) rather than sitting inside it.
    const off = flattenPath(generateGearD(base), 0.02)
    const on = flattenPath(generateGearD({ ...base, pitchCircle: true }), 0.02)
    expect(on.length).toBe(off.length + 1)
    const circle = on[on.length - 1]
    const rp = gearDims(base.module, base.teeth, base.pressureAngle).pitchDia / 2
    for (const [x, y] of circle) expect(Math.hypot(x, y)).toBeCloseTo(rp, 1)
    // …and it changes nothing else.
    expect(on.slice(0, off.length).map((p) => p.length)).toEqual(off.map((p) => p.length))
  })

  it('is centred where it is told, and moves with cx/cy', () => {
    const d = gearDims(base.module, base.teeth, base.pressureAngle)
    const ring = flattenPath(generateGearD({ ...base, cx: 30, cy: -12 }), 0.05)[0]
    const xs = ring.map((q) => q[0]), ys = ring.map((q) => q[1])
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(30, 2)
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(-12, 2)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(d.outsideDia, 1)
  })

  it('moduleForRadius sizes a gear to the box it was dragged in', () => {
    for (const teeth of [8, 24, 60]) {
      const m = moduleForRadius(37.5, teeth)
      expect(gearDims(m, teeth, 20).outsideDia / 2).toBeCloseTo(37.5, 6)
    }
  })

  it('survives degenerate input', () => {
    const cases: GearSpec[] = [
      { ...base, teeth: 1 }, { ...base, teeth: 400 },
      { ...base, module: 0 }, { ...base, module: 1e4 },
      { ...base, pressureAngle: 0 }, { ...base, pressureAngle: 90 },
      { ...base, bore: 1e4 }, { ...base, bore: 0, spokes: 20 },
      { ...base, spokes: -3 }, { ...base, spokes: 60 },
      { ...base, hubDia: 0 }, { ...base, hubDia: 1e4 },
      { ...base, pitchCircle: true, module: 0 },
      { ...base, pitchCircle: true, teeth: 400 },
      { ...base, backlash: -5 }, { ...base, backlash: 1e4 },
    ]
    for (const p of cases) {
      const d = generateGearD(p)
      expect(d.length, JSON.stringify(p)).toBeGreaterThan(0)
      expect(d, JSON.stringify(p)).not.toMatch(/NaN|Infinity/)
    }
  })

  it('is reachable through generateShapeD', () => {
    expect(generateShapeD({ type: 'gear', ...base })).toBe(generateGearD(base))
  })
})

describe('gear — running the pair', () => {
  // What the Animate button shows. A gear is drawn alone and its lantern is drawn
  // clear of it, so whether the two actually run together is the one question the
  // drawing cannot answer — and the way to get it wrong is PHASE, which fails
  // silently: the preview just draws two solids through each other. The mesh
  // itself is measured against the emitted outlines by
  // `scripts/gear-mesh-check.mts`; what is pinned here is the arithmetic it rests
  // on.

  it('spaces the pair by the sum of the pitch radii', () => {
    // Gears mesh when their pitch circles are TANGENT. This is the number a plate
    // is drilled from, and the whole reason the preview is worth trusting.
    for (const mateTeeth of [8, 13, 24, 40]) {
      const mesh = gearMesh({ ...base, mateTeeth })
      expect(mesh.centreDistance).toBeCloseTo((base.module * (base.teeth + mateTeeth)) / 2, 9)
      expect(mesh.centreDistance).toBeCloseTo(mesh.pitchRadius + mesh.matePitchRadius, 9)
      expect(mesh.ratio).toBeCloseTo(base.teeth / mateTeeth, 9)
    }
    // A cycloidal wheel runs against the lantern it was CUT for, and the pin
    // circle is the pinion's own pitch circle — so the same rule holds.
    const cyc = gearMesh({ ...base, toothProfile: 'cycloidal', mateTeeth: 8, pinDia: 2 })
    expect(cyc.kind).toBe('lantern')
    expect(cyc.centreDistance).toBeCloseTo(cyc.pitchRadius + cyc.matePitchRadius, 9)
  })

  it('turns the mate the other way, at the ratio', () => {
    const spec = { ...base, mateTeeth: 12 }
    const mesh = gearMesh(spec)
    const a = gearPose(spec, 0), b = gearPose(spec, 1)
    // One unit of phase is one TOOTH of the gear — that is what makes the preview
    // watchable at any tooth count.
    expect(b.gearDeg - a.gearDeg).toBeCloseTo(360 / spec.teeth, 9)
    expect(b.mateDeg - a.mateDeg).toBeCloseTo(-(360 / spec.teeth) * mesh.ratio, 9)
    // And the mate gives up exactly one of ITS teeth in the same time.
    expect(a.mateDeg - b.mateDeg).toBeCloseTo(360 / mesh.mateTeeth, 9)
  })

  it('puts a space on the line of centres, not a tooth', () => {
    // Tooth 0 of the gear is centred on angle 0 and the mate sits along +x, so
    // the gear points a tooth straight at it. The mate must answer with a space
    // or the two are drawn one inside the other — and it is a half pitch of the
    // MATE, which is the easy thing to get wrong on a pair of different sizes.
    for (const mateTeeth of [8, 13, 24]) {
      const mesh = gearMesh({ ...base, mateTeeth })
      // Undo the settle onto the driving flank to get the centred phase back.
      const centred = mesh.matePhaseDeg - (mesh.playAtPitch / 2 / mesh.matePitchRadius) * (180 / Math.PI)
      expect(centred).toBeCloseTo(180 - 180 / mateTeeth, 6)
    }
    for (const pins of [6, 8, 10]) {
      const mesh = gearMesh({ ...base, toothProfile: 'cycloidal', mateTeeth: pins, pinDia: 2 })
      const centred = mesh.matePhaseDeg - (mesh.playAtPitch / 2 / mesh.matePitchRadius) * (180 / Math.PI)
      expect(centred).toBeCloseTo(180 + 180 / pins, 6)
    }
  })

  it('reports the play, and it is the backlash for two gears', () => {
    // Both halves of a pair are thinned by half the backlash, so a pair cut to
    // the same figure has exactly that much play — which is the definition the
    // backlash field is documented by, checked end to end.
    for (const backlash of [0, 0.2, 0.5]) {
      for (const mateTeeth of [8, 24]) {
        expect(gearMesh({ ...base, backlash, mateTeeth }).playAtPitch).toBeCloseTo(backlash, 9)
      }
    }
  })

  it('gives a lantern pair the backlash it asked for and no more', () => {
    // A LANTERN TOOTH IS NOT HALF THE PITCH. That is the involute rule, where the
    // mate presents a tooth of the same thickness and the two split the pitch. A
    // pin is much thinner than half a pitch, so the wheel's tooth has to fill the
    // whole of what the pin leaves — and cut to half the pitch instead it simply
    // rattles: Ø3 pins on an m4 wheel had 3.4 mm of play against a 0.3 mm
    // backlash. Every surface was where it should be and the pair still turned,
    // which is why only running it in the canvas found it.
    const m = 4, pins = 8
    for (const pinDia of [2, 3, 5]) {
      for (const backlash of [0, 0.3]) {
        const spec = { ...base, module: m, teeth: 48, toothProfile: 'cycloidal' as const, mateTeeth: pins, pinDia, backlash }
        const d = gearDims(m, 48, base.pressureAngle, backlash, { mateTeeth: pins, pinDia })
        expect(d.toothThickness).toBeCloseTo(Math.PI * m - pinDia - backlash, 9)
        // Which is the same as saying the pin fills the tooth space exactly.
        expect(d.spaceAtPitch).toBeCloseTo(pinDia + backlash, 9)
        expect(gearMesh(spec).playAtPitch).toBeCloseTo(backlash, 9)
      }
    }
  })

  it('says when the pin has eaten the tooth', () => {
    // The fat-pin failure moved. It used to be "the pin cannot pass the tooth
    // space", which was an artefact of cutting the tooth to half the pitch
    // whatever the pin — sized FOR the pin, the space always admits it. What can
    // still go wrong is the other end: a pin approaching the circular pitch
    // leaves nothing to drive with.
    const m = 4, pins = 8
    const dims = (pinDia: number) => gearDims(m, 24, base.pressureAngle, 0.3, { mateTeeth: pins, pinDia })
    expect(dims(3).pinTooFat).toBe(false)
    expect(dims(7).pinTooFat).toBe(false)         // thin tooth, but a tooth
    expect(dims(12.4).pinTooFat).toBe(true)       // circular pitch is 12.566
    // A Ø7 pin used to be reported as unable to turn at all. It runs.
    expect(dims(7).toothThickness).toBeGreaterThan(0)
    expect(dims(7).spaceAtPitch).toBeGreaterThan(7)
    expect(gearDims(m, 24, base.pressureAngle, 0.3).pinTooFat).toBe(false)
  })

  it('draws a lantern as pins, with the cheek only as a ghost', () => {
    // The cheek is wider than the pin circle and the wheel's teeth reach INSIDE
    // that circle, so in plan view it really does cover them — the wheel runs
    // between two cheeks, axially. Solid, it reads as a crash.
    const spec = { ...base, toothProfile: 'cycloidal' as const, mateTeeth: 8, pinDia: 2 }
    const { solid, ghost } = gearMateParts(spec)
    expect((solid.match(/M/g) || []).length).toBe(8)     // one subpath per pin
    expect(ghost.length).toBeGreaterThan(0)
    // A mate GEAR is all solid — there is nothing on another plane.
    const g = gearMateParts({ ...base, mateTeeth: 12 })
    expect(g.ghost).toBe('')
    expect(g.solid.length).toBeGreaterThan(0)
  })

  it('draws both pitch circles, tangent at the mesh', () => {
    // The proof that the pair is spaced right, which is why they are drawn here
    // whatever the shape's own pitch-circle setting says.
    const spec = { ...base, cx: 5, cy: -3, mateTeeth: 12 }
    const mesh = gearMesh(spec)
    const xs = (gearMeshRefD(spec).match(/-?\d+(\.\d+)?/g) || []).map(Number)
      .filter((_, i) => i % 2 === 0)
    // Rightmost point of the gear's circle meets the leftmost of the mate's.
    // One decimal, not three: these are sampled rings, so an extreme vertex sits
    // a chord's sagitta inside the true circle — tightening it would only pin
    // `ellipseRing`'s step.
    expect(Math.max(...xs)).toBeCloseTo(spec.cx + mesh.centreDistance + mesh.matePitchRadius, 1)
    expect(Math.min(...xs)).toBeCloseTo(spec.cx - mesh.pitchRadius, 1)
  })
})
