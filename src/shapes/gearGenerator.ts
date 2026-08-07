// ─── Involute spur gear ───────────────────────────────────────────────────────
//
// A real involute gear, not a rounded-tooth lookalike: the flanks are the true
// involute of the base circle, which is the only profile that transmits constant
// angular velocity through the mesh and the only one that stays conjugate when
// the centre distance drifts. The involute of a circle of radius r_b is the
// curve traced by the end of a string unwound from it, so the point at radius r
// stands at polar angle
//
//     inv(α_r) = tan α_r − α_r,     α_r = arccos(r_b / r)
//
// A tooth flank is that curve, rotated so it crosses the pitch circle at half
// the tooth thickness. Standard tooth thickness at the pitch circle is half the
// circular pitch, so the half-angle there is π/(2z), and the flank's angle at
// the base circle is
//
//     ψ = π/(2z) + inv(α)
//
// with α the nominal pressure angle. Everything else follows: the flank is
// φ(r) = ψ − inv(α_r), the tooth is that curve and its mirror, and the gear is
// z copies of it.
//
// Proportions are ISO full-depth: addendum = m, dedendum = 1.25 m, so the pitch
// diameter is m·z, the outside diameter m(z+2) and the root m(z−2.5). Module and
// tooth count set the size; the base diameter is m·z·cos α and cannot be dialled
// in independently, which is why it is a READOUT (`gearDims`) rather than a
// parameter.
//
// Two things a gear generator has to get right or it hands you a broken part:
//
//   ROOT. Below the base circle there is no involute — the curve does not exist
//   there — so the flank runs radially down to the root circle. A hobbed gear
//   would undercut instead; a radial root is stronger and is what a cut-on-a-
//   router gear wants. The corner it leaves is filleted by a CLOSING of radius
//   0.38 m, which is the standard rack-tip radius, so every root in the gear is
//   filleted by one pass and the tooth tips (convex) are left untouched.
//
//   POINTED TEETH. On a low tooth count the two flanks meet before they reach
//   the nominal tip, and carrying on regardless crosses them over and produces a
//   self-intersecting outline. The tip is therefore clamped to the radius where
//   the tooth thickness reaches zero, which is what the tooth physically does.
//
// Emitted as a COMPOUND path — rim outline, bore, spoke windows — because those
// are different cuts; double-click to split it.

import {
  type Pt, clamp, arcInto, ellipseRing,
  roundConcave, roundConvex, ringToD,
} from './polyOps'

export interface GearSpec {
  cx: number; cy: number
  /** Tooth size. Pitch diameter is module × teeth, so this sets the scale. */
  module: number
  teeth: number
  /** Degrees. 20° is the modern standard; 14.5° is the old one. */
  pressureAngle: number
  /** Axle hole diameter. 0 for none. */
  bore: number
  /** Hub outer diameter — a MINIMUM, not a fixed size: it is grown when the
   *  requested spoke count needs more circumference to land on. See `gearHub`. */
  hubDia: number
  /** 0 for a solid web. */
  spokes: number
  /** Circular backlash at the mesh, mm — the play a PAIR of these will have.
   *  Each gear is thinned by half of it, so setting the same figure on both
   *  gears of a pair gives exactly that much play. */
  backlash: number
  /** Draw the pitch circle as an extra subpath. Two gears mesh when their pitch
   *  circles are TANGENT, so this is the line to snap centres against — the
   *  centre distance is half the sum of the two pitch diameters. It is a
   *  reference, not a cut: the app has no non-cutting path, so split the
   *  compound path and drop this subpath before generating. */
  pitchCircle: boolean
}

export interface GearDims {
  pitchDia: number
  baseDia: number
  outsideDia: number
  rootDia: number
  circularPitch: number
  /** Tooth thickness at the pitch circle, backlash already taken off. */
  toothThickness: number
  /** The tip had to be clamped — the flanks met before the nominal outside
   *  diameter, so the teeth come to a point and the OD is smaller than m(z+2). */
  pointed: boolean
  /** Below the undercut limit for this pressure angle (z < 2/sin²α). A hob would
   *  undercut these roots; this generator cuts them radially instead. */
  undercut: boolean
}

const ADDENDUM = 1.0        // × module
const DEDENDUM = 1.25       // × module
const ROOT_FILLET = 0.38    // × module — the standard rack tip radius
const RIM = 2.5             // × module — stock left under the root circle
const HUB = 2.0             // × module — least stock left around the bore
const SPOKE = 2.5           // × module — spoke width
const SPOKE_GAP = 0.15      // rad — daylight left between two spokes at the hub
// Chord tolerance on the involute flank, mm. This is a wooden gear cut on a
// router: it will be sanded, it will move with the seasons, and it is running
// tenths of a millimetre of backlash — so a profile held to 0.02 mm is already
// far beyond anything the part can hold. It buys a lot: the flank sample count
// falls ~20× and with it the cost of the root-fillet closing, which is what
// makes the gear slow.
//
// The chords are INSCRIBED — a gear flank is convex, so a polyline through
// points on it sits just inside the true profile. Every tooth therefore comes
// out a hair thin rather than a hair fat: the error spends itself as a few
// microns of extra backlash instead of as interference, which is the direction
// you want to err in when the part is going to be sanded anyway.
export const FLANK_TOL = 0.02
const WEB = 1.5             // × module — least radial room a window needs

const inv = (a: number) => Math.tan(a) - a

export interface GearHub {
  /** The diameter actually used. */
  dia: number
  /** It had to be grown past what was asked for, to seat the spokes. */
  grown: boolean
  /** Windows will really be cut — false means the web has no room and the gear
   *  comes out solid. */
  spoked: boolean
  /** Most spokes this gear can take at ANY hub diameter, before the hub runs
   *  into the rim. */
  maxSpokes: number
}

/**
 * Resolve the hub.
 *
 * Spokes are a fixed `SPOKE·m` wide, so what limits their number is the
 * circumference they have to land on — which is why the answer is to grow the
 * hub rather than to refuse the count or, worse, to drop every window and hand
 * back a solid gear with no explanation. Seating `n` spokes with `SPOKE_GAP` of
 * daylight between them needs
 *
 *     hubR ≥ (SPOKE·m/2) / sin(π/n − SPOKE_GAP/2)
 *
 * so `hubDia` is treated as a FLOOR and raised to that when it falls short. The
 * hub can only grow until it meets the rim, which is the real ceiling on the
 * count (`maxSpokes`); past 2π/SPOKE_GAP spokes no hub is big enough at all.
 */
export function gearHub(module: number, teeth: number, bore: number, hubDia: number, spokes: number): GearHub {
  const m = Math.max(0.05, module)
  const z = Math.max(4, Math.round(teeth))
  const rf = Math.max(0.1, (m * z) / 2 - DEDENDUM * m)
  const rimInner = rf - RIM * m
  const boreR = clamp(bore / 2, 0, rf - 1)
  const minR = boreR + HUB * m               // stock the axle needs round it
  const ceiling = rimInner - WEB * m         // past this there is no web left
  const hw = (SPOKE * m) / 2

  // Smallest hub that seats n spokes; Infinity when no hub can.
  const seat = (n: number) => {
    const room = Math.PI / n - SPOKE_GAP / 2
    return room <= 1e-6 ? Infinity : hw / Math.sin(room)
  }
  let maxSpokes = 0
  for (let n = 2; n <= Math.floor((2 * Math.PI) / SPOKE_GAP); n++) {
    if (Math.max(minR, seat(n)) <= ceiling) maxSpokes = n
  }

  const asked = Math.max(minR, hubDia / 2)
  const n = Math.round(spokes)
  if (n < 2) return { dia: 2 * asked, grown: false, spoked: false, maxSpokes }

  const need = seat(n)
  const r = Math.max(asked, isFinite(need) ? need : asked)
  // 0.05 mm, not an epsilon: growing the hub by a few microns to seat the last
  // spoke is true but not worth telling anyone about.
  return { dia: 2 * r, grown: r > asked + 0.025, spoked: isFinite(need) && r <= ceiling, maxSpokes }
}

/** The one place the gear's numbers are worked out — shared by the generator and
 *  by the panels, so the readout can never disagree with the geometry. */
export function gearDims(module: number, teeth: number, pressureAngle: number, backlash = 0): GearDims {
  const m = Math.max(0.05, module)
  const z = Math.max(4, Math.round(teeth))
  const alpha = clamp(pressureAngle, 5, 35) * (Math.PI / 180)
  const rp = (m * z) / 2
  const rb = rp * Math.cos(alpha)
  const ra = tipRadius(m, z, alpha, backlash)
  return {
    pitchDia: 2 * rp,
    baseDia: 2 * rb,
    outsideDia: 2 * ra,
    rootDia: Math.max(0.2, 2 * (rp - DEDENDUM * m)),
    circularPitch: Math.PI * m,
    toothThickness: 2 * rp * (halfToothAngle(m, z, alpha, backlash) - inv(alpha)),
    pointed: ra < rp + ADDENDUM * m - 1e-6,
    undercut: z < 2 / Math.sin(alpha) ** 2,
  }
}

/**
 * Half the tooth's angular width at the base circle.
 *
 * Backlash is taken off HERE — as tooth thinning — and nowhere else. Thinning
 * rotates each flank inward by half the play but leaves it the same involute of
 * the same base circle, so the pair still runs conjugate; it simply has slop.
 * Opening the centre distance instead would move the operating pitch circles and
 * break the one rule that makes the gears placeable (mesh when pitch circles are
 * tangent). Tip and root diameters are untouched for the same reason.
 *
 * `backlash` is the play at the MESH, so each gear takes half: the pitch-circle
 * tooth thickness goes πm/2 → πm/2 − backlash/2, and the half-angle there falls
 * by backlash/(2·m·z).
 */
function halfToothAngle(m: number, z: number, alpha: number, backlash: number): number {
  const nominal = Math.PI / (2 * z)
  const thinned = nominal - Math.max(0, backlash) / (2 * m * z)
  // A tooth thinned past nothing is not a tooth; leave a sliver rather than
  // inverting the profile.
  return Math.max(nominal * 0.05, thinned) + inv(alpha)
}

/** Angle of the flank at radius r, measured from the tooth's centreline. Zero
 *  means the two flanks have met — the tooth has come to a point. */
function flankAngle(r: number, rb: number, psi: number): number {
  if (r <= rb) return psi              // below the base circle the flank is radial
  return psi - inv(Math.acos(clamp(rb / r, -1, 1)))
}

/** The nominal tip, pulled in to where the tooth would come to a point. */
function tipRadius(m: number, z: number, alpha: number, backlash: number): number {
  const rp = (m * z) / 2
  const rb = rp * Math.cos(alpha)
  const psi = halfToothAngle(m, z, alpha, backlash)
  const nominal = rp + ADDENDUM * m
  if (flankAngle(nominal, rb, psi) > 1e-4) return nominal
  // Bisect for flankAngle = 0. It falls monotonically with r, so this is safe.
  let lo = Math.max(rb, rp * 0.5), hi = nominal
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (flankAngle(mid, rb, psi) > 0) lo = mid; else hi = mid
  }
  return lo
}

/**
 * The involute flank, from where it starts up to the tip, as offsets from the
 * tooth centreline. Sampled on the involute's roll angle rather than on radius:
 * the curve turns fastest near the base circle, and rolling uniformly puts the
 * points where the curvature is.
 *
 * The count comes from the ERROR, not from a fixed spacing. An involute's radius
 * of curvature at roll angle t is ρ = r_b·t, so a chord spanning Δt bulges away
 * from the true curve by ρ·Δt²/8 — worst at the tip, where ρ is largest. Solving
 * there for `FLANK_TOL` sizes the whole flank. A fixed spacing cannot do this:
 * it puts the same number of points on the near-straight outer flank as on the
 * tight curl by the base circle, which is where the 20× waste was.
 *
 * The radial run below the base circle is NOT here — `toothedRing` lays that in,
 * because both of its ends have to be placed by hand to keep the tooth
 * symmetric.
 */
function flankPoints(rStart: number, rEnd: number, rb: number, psi: number): { r: number; a: number }[] {
  // r = rb·√(1 + t²) for roll angle t, so t = √((r/rb)² − 1).
  const roll = (r: number) => Math.sqrt(Math.max(0, (r / rb) ** 2 - 1))
  const t0 = roll(Math.max(rStart, rb)), t1 = roll(rEnd)
  const dt = Math.sqrt((8 * FLANK_TOL) / Math.max(rb * t1, 1e-9))
  const steps = Math.round(clamp(Math.ceil((t1 - t0) / dt), 4, 200))

  const out: { r: number; a: number }[] = []
  for (let i = 0; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps
    const r = rb * Math.sqrt(1 + t * t)
    out.push({ r, a: flankAngle(r, rb, psi) })
  }
  return out
}

/** The toothed outline, CCW, centred on the origin. */
function toothedRing(m: number, z: number, alpha: number, backlash: number): Pt[] {
  const rp = (m * z) / 2
  const rb = rp * Math.cos(alpha)
  const ra = tipRadius(m, z, alpha, backlash)
  const rf = Math.max(0.1, rp - DEDENDUM * m)
  const psi = halfToothAngle(m, z, alpha, backlash)
  const rStart = Math.max(rf, Math.min(rb, ra * 0.999))
  const flank = flankPoints(rStart, ra, rb, psi)
  const rootA = flank[0].a
  const pitch = (2 * Math.PI) / z

  const ring: Pt[] = []
  const at = (r: number, a: number) => ring.push([r * Math.cos(a), r * Math.sin(a)])

  // Below the base circle there is no involute, so the flank finishes as a
  // radial run down to the root circle. It needs an explicit vertex at each end:
  // `arcInto` skips its start point so arcs chain onto the previous vertex, but
  // here the previous vertex is on the BASE circle, not the root circle, so
  // without one the drop lands on the root arc's first SAMPLE instead of on its
  // start — skewed by one arc step. The rising flank has no such problem (it
  // leaves from the previous root arc's exact endpoint), so the tooth comes out
  // lopsided: one flank meets the root square, the other at a slant, and the
  // gear only runs true in one direction. Worse at low pressure angles, where
  // ψ = π/2z + inv α is small, the root arc is long and its steps are coarse.
  const hasRadial = rf < rStart - 1e-9

  for (let i = 0; i < z; i++) {
    const c = i * pitch
    // Rising flank: root → tip on the −φ side, which runs CCW. Its foot is
    // already on the ring — the previous tooth's root arc ended exactly there.
    for (const q of flank) at(q.r, c - q.a)
    // Across the tip.
    arcInto(ring, 0, 0, ra, ra, c - flank[flank.length - 1].a, c + flank[flank.length - 1].a)
    // Falling flank: tip → root on the +φ side.
    for (let k = flank.length - 2; k >= 0; k--) at(flank[k].r, c + flank[k].a)
    if (hasRadial) at(rf, c + rootA)   // the foot the root arc will not emit
    // Root arc across to the next tooth. On a high tooth count the root sits
    // above the base circle and this arc is short; it never inverts, because
    // rootA < pitch/2 is exactly the condition that the tooth is thinner than
    // the pitch.
    arcInto(ring, 0, 0, rf, rf, c + rootA, c + pitch - rootA)
  }
  return ring
}

/** The windows between the spokes, as CW holes. `gearHub` has already sized the
 *  hub so they fit, so this only has to draw them. */
function spokeWindows(n: number, rimInner: number, hubOuter: number, m: number): Pt[][] {
  if (n < 2 || rimInner - hubOuter < WEB * m) return []
  const hw = Math.min((SPOKE * m) / 2, hubOuter * 0.9)   // half the spoke width
  // Angular half-width of a straight-sided spoke, which is widest at the hub.
  const halfAt = (r: number) => Math.asin(clamp(hw / r, -1, 1))
  const step = (2 * Math.PI) / n
  if (step - 2 * halfAt(hubOuter) < SPOKE_GAP * 0.5) return []   // belt and braces
  const fillet = Math.min(1.5 * m, (rimInner - hubOuter) * 0.25, hw * 0.9)

  const out: Pt[][] = []
  for (let i = 0; i < n; i++) {
    const a0 = i * step, a1 = a0 + step
    const ring: Pt[] = []
    const radial = (from: number, to: number, side: 1 | -1, centre: number) => {
      const steps = 24
      for (let k = 0; k <= steps; k++) {
        const r = from + ((to - from) * k) / steps
        const a = centre + side * halfAt(r)
        ring.push([r * Math.cos(a), r * Math.sin(a)])
      }
    }
    radial(hubOuter, rimInner, 1, a0)                     // up this spoke's + side
    arcInto(ring, 0, 0, rimInner, rimInner, a0 + halfAt(rimInner), a1 - halfAt(rimInner))
    radial(rimInner, hubOuter, -1, a1)                    // down the next spoke's − side
    arcInto(ring, 0, 0, hubOuter, hubOuter, a1 - halfAt(hubOuter), a0 + halfAt(hubOuter))
    // The window's convex corners are the WEB's concave ones — the stress
    // risers where a spoke meets the hub and the rim.
    for (const r of roundConvex([ring], fillet)) out.push(r)
  }
  return out
}

// ─── Toothed-outline cache ────────────────────────────────────────────────────
//
// The teeth are ~99% of the cost of a gear: at 24 teeth the outline is 73 ms of
// a 74 ms call, at 80 teeth 330 ms of 332 ms. Almost none of that is the
// involute arithmetic — it is the root-fillet CLOSING, two clipper offset passes
// over a 3.6k–12k point polygon.
//
// But bore, hub, spokes and position do not touch a single tooth, and those are
// exactly the parameters a user nudges with a spinner. So the outline is
// memoised on the four things that DO define it, and stepping the bore or the
// spoke count costs only the windows (1–2 ms). It is centred on the origin and
// translated at emit time, so moving a gear hits the cache too.
//
// Deterministic in, deterministic out — the same four numbers always produce the
// same rings — so this is a pure memo, not a snapshot of anything mutable.
// Callers never mutate what they get back: `generateGearD` copies every point on
// its way out.
const TOOTH_CACHE = new Map<string, Pt[][]>()
const TOOTH_CACHE_MAX = 8

function toothedOutline(m: number, z: number, alpha: number, backlash: number): Pt[][] {
  const key = `${m}|${z}|${alpha}|${backlash}`
  const hit = TOOTH_CACHE.get(key)
  if (hit) return hit
  const rings = roundConcave([toothedRing(m, z, alpha, backlash)], ROOT_FILLET * m)
  if (TOOTH_CACHE.size >= TOOTH_CACHE_MAX) TOOTH_CACHE.delete(TOOTH_CACHE.keys().next().value!)
  TOOTH_CACHE.set(key, rings)
  return rings
}

/** Test hook — the memo is module-scope, so a perf test has to be able to clear it. */
export function __resetGearCache(): void { TOOTH_CACHE.clear() }

/** A gear's parts, each of which wants its OWN operation. */
export type GearPartKey = 'teeth' | 'spokes' | 'bore' | 'pitch'

export interface GearPart {
  key: GearPartKey
  d: string
}

/**
 * The gear as separate paths rather than one compound path — teeth, spokes,
 * bore, and the pitch-circle reference if it was asked for. Empty parts are
 * omitted.
 *
 * They are split because they are three different CUTS, and a compound path
 * cannot express that: a profile reads it as one region, so `side: 'outside'`
 * follows the outer boundary and nothing else. Handing the user one path means
 * either the bore and spokes go uncut, or — if the path is split afterwards to
 * reach them — the outside profile is lost with it. Emitting the parts up front
 * lets each take the operation it actually wants: the teeth profiled outside,
 * the spokes and bore profiled inside.
 */
export function generateGearParts(spec: GearSpec): GearPart[] {
  const m = Math.max(0.05, spec.module)
  const z = Math.max(4, Math.round(spec.teeth))
  const alpha = clamp(spec.pressureAngle, 5, 35) * (Math.PI / 180)
  const rf = Math.max(0.1, (m * z) / 2 - DEDENDUM * m)
  const place = (r: Pt[]) => r.map(([x, y]) => [x + spec.cx, y + spec.cy] as Pt)

  // One closing fills every root corner at once with the rack-tip radius, and
  // leaves the convex tooth tips exactly where the involute put them — memoised,
  // because it is the whole cost of the gear and none of these four numbers
  // change when the bore, hub or spokes do.
  const outline = toothedOutline(m, z, alpha, Math.max(0, spec.backlash))
  const out: GearPart[] = [{
    key: 'teeth',
    d: outline.map((r) => ringToD(place(r), true)).join(' '),
  }]

  const boreR = clamp(spec.bore / 2, 0, rf - 1)
  if (boreR > 0.25) out.push({ key: 'bore', d: ringToD(place(ellipseRing(0, 0, boreR, boreR)), false) })

  // Windings stay as they were: these are holes in the blank, so CW, which is
  // what anything reading them as regions expects.
  const hub = gearHub(m, z, spec.bore, spec.hubDia, spec.spokes)
  const windows = spokeWindows(Math.round(spec.spokes), rf - RIM * m, hub.dia / 2, m)
  if (windows.length > 0) {
    out.push({ key: 'spokes', d: windows.map((r) => ringToD(place(r), false)).join(' ') })
  }

  // A reference, not a cut — see GearSpec.pitchCircle. Its own path so it can be
  // deleted without touching anything that is going to be machined.
  if (spec.pitchCircle) {
    out.push({ key: 'pitch', d: ringToD(place(ellipseRing(0, 0, (m * z) / 2, (m * z) / 2)), false) })
  }
  return out
}

/** Every part in one compound path — the live drag preview, and the fallback for
 *  anywhere that still wants a single `d` for a gear. */
export function generateGearD(spec: GearSpec): string {
  return generateGearParts(spec).map((p) => p.d).join(' ')
}

/** Module that makes a gear of this outer radius — used when placing by drag. */
export function moduleForRadius(radius: number, teeth: number): number {
  const z = Math.max(4, Math.round(teeth))
  return Math.max(0.05, (2 * Math.max(0.5, radius)) / (z + 2 * ADDENDUM))
}
