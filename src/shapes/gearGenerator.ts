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
// Emitted as separate parts — rim outline, bore, spoke windows, and the engraved
// tooth count — because those are different cuts (`generateGearParts`).

import {
  type Pt, clamp, arcInto, ellipseRing,
  roundConcave, ringToD,
} from './polyOps'
import { seatHub, spokeWindows, type HubFit } from './spokedWheel'
import { generateTextD, isFontLoaded, SINGLE_LINE_FONT_FAMILY } from './textGenerator'
import { flattenPath } from '../cam/pathFlattener'

export interface GearSpec {
  cx: number; cy: number
  /** Tooth size. Pitch diameter is module × teeth, so this sets the scale. */
  module: number
  teeth: number
  /** Involute for machinery, cycloidal for clocks — see the CYCLOIDAL section. */
  toothProfile: ToothProfile
  /** Degrees. 20° is the modern standard; 14.5° is the old one. Involute only:
   *  a cycloidal mesh has no single pressure angle (it varies through the mesh),
   *  which is why the panels hide the field in that mode. */
  pressureAngle: number
  /** Pins on the MATING lantern pinion. Cycloidal only, and not optional there: a
   *  cycloidal face is conjugate to one particular mate, because the describing
   *  circle that traces it comes from the mate's pitch circle. */
  mateTeeth: number
  /** Pin diameter of that lantern pinion, mm. The face is the pin-centre
   *  epicycloid offset by its RADIUS, so this changes the tooth shape. */
  pinDia: number
  /** Also emit the mating lantern pinion — its cheek disc and pin holes. Cycloidal
   *  only; the wheel's own parameters already say everything about it. */
  emitPinion: boolean
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
  /** Engrave the tooth count on the gear — see `gearLabel`. Its own path, so it
   *  is engraved, or deleted, independently of anything that is cut. */
  toothLabel: boolean
  /** Draw the pitch circle as an extra subpath. Two gears mesh when their pitch
   *  circles are TANGENT, so this is the line to snap centres against — the
   *  centre distance is half the sum of the two pitch diameters. It is a
   *  reference, not a cut: the app has no non-cutting path, so split the
   *  compound path and drop this subpath before generating. */
  pitchCircle: boolean
}

export type ToothProfile = 'involute' | 'cycloidal'

export interface GearDims {
  pitchDia: number
  /** Involute only — 0 for a cycloidal gear, which has no base circle. */
  baseDia: number
  /** Cycloidal only — the circle whose rolling traces the faces. 0 for involute. */
  describingDia: number
  /** Tooth SPACE at the pitch line, mm. What a lantern pin has to pass through. */
  spaceAtPitch: number
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
const SPOKE = 2.5           // × module — spoke width
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

const inv = (a: number) => Math.tan(a) - a

export type GearHub = HubFit

/**
 * Resolve the hub.
 *
 * The rules live in `spokedWheel.ts`, stated in terms of the spoke width so the
 * escape wheel can use the same ones; this only says what a gear's spoke width
 * and rim are. `SPOKE·m` wide spokes, `WEB·m` of web and `HUB·m` of stock round
 * the bore come out as 1, 0.6 and 0.8 times that width, which is exactly what
 * `seatHub` applies.
 */
export function gearHub(module: number, teeth: number, bore: number, hubDia: number, spokes: number): GearHub {
  const m = Math.max(0.05, module)
  const z = Math.max(4, Math.round(teeth))
  const rf = Math.max(0.1, (m * z) / 2 - DEDENDUM * m)
  return seatHub(rf - RIM * m, clamp(bore / 2, 0, rf - 1), hubDia, spokes, SPOKE * m)
}

/**
 * The one place the gear's numbers are worked out — shared by the generator and by
 * the panels, so the readout can never disagree with the geometry.
 *
 * Pass `cyc` for a cycloidal gear. Its numbers genuinely differ: there is no base
 * circle, undercut is an involute idea and does not apply, the tip can be clamped
 * by the describing circle's arch as well as by the faces meeting, and a lantern's
 * pin can force a deeper root.
 */
export function gearDims(
  module: number, teeth: number, pressureAngle: number, backlash = 0,
  cyc?: CycMate,
): GearDims {
  const m = Math.max(0.05, module)
  const z = Math.max(4, Math.round(teeth))
  const alpha = clamp(pressureAngle, 5, 35) * (Math.PI / 180)
  const rp = (m * z) / 2

  if (cyc) {
    const spec: CycloidalSpec = { m, z, backlash, ...cyc }
    const pinR = Math.max(0, cyc.pinDia) / 2
    const ra = cycloidalTip(spec)
    const rf = cycloidalRoot(m, z, pinR)
    const thickness = 2 * rp * cycloidalHalfTooth(m, z, backlash)
    return {
      pitchDia: 2 * rp,
      baseDia: 0,
      describingDia: 2 * describingRadius(m, cyc.mateTeeth),
      spaceAtPitch: Math.PI * m - thickness,
      outsideDia: 2 * ra,
      rootDia: Math.max(0.2, 2 * rf),
      circularPitch: Math.PI * m,
      toothThickness: thickness,
      pointed: ra < Math.min(rp + ADDENDUM * m, rp + 2 * describingRadius(m, cyc.mateTeeth)) - 1e-6,
      undercut: false,
    }
  }

  const rb = rp * Math.cos(alpha)
  const ra = tipRadius(m, z, alpha, backlash)
  const thickness = 2 * rp * (halfToothAngle(m, z, alpha, backlash) - inv(alpha))
  return {
    pitchDia: 2 * rp,
    baseDia: 2 * rb,
    describingDia: 0,
    spaceAtPitch: Math.PI * m - thickness,
    outsideDia: 2 * ra,
    rootDia: Math.max(0.2, 2 * (rp - DEDENDUM * m)),
    circularPitch: Math.PI * m,
    toothThickness: thickness,
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

// ─── Cycloidal teeth ──────────────────────────────────────────────────────────
//
// A clock wheel is not a machine gear. It turns slowly, it is cut in wood or
// brass by hand-guided tools, and it drives a pinion of six to twelve leaves —
// often a LANTERN pinion, which is not a toothed wheel at all but a cage of round
// pins. An involute wheel run against pins is not conjugate to them: the ratio
// wobbles within each tooth, which in a clock train shows up as a tick in the
// rate and as wear at one spot on every pin. Cycloidal teeth are the answer, and
// they predate involutes in horology by centuries.
//
// The law behind them: if the face of one wheel above its pitch circle is an
// EPICYCLOID traced by a circle rolling on that pitch circle, then the mating
// flank below ITS pitch circle is the HYPOCYCLOID traced by the same describing
// circle rolling inside the mate's pitch circle — and the pair transmits constant
// angular velocity.
//
// This generator cuts wheels for LANTERN pinions, which is what wooden clocks use.
// A pin has no flank; the pin IS the tooth. Relative to the wheel, the pin's CENTRE
// traces the epicycloid of the pinion's FULL pitch circle (a point of that circle
// as it rolls), and the pin's surface stands one radius off it — so the wheel's
// face is that epicycloid OFFSET INWARD by the pin radius, the envelope of the pin
// circles. Which is why pin diameter is a tooth-FORM parameter here and not just a
// detail of the pinion. (A leaved pinion would want a describing circle of HALF the
// pinion's pitch radius, so the hypocycloid inside it degenerates to a straight
// radial flank — the Cardan couple. Nothing here does that; adding it would mean
// generating the pinion too, and verifying the mesh against its leaves.)
//
// Below the pitch circle the wheel's tooth does no driving (with a lantern the
// action is entirely on the recess side), so the flank runs RADIALLY down to the
// root — the same answer, and for the same reason, as the involute generator's
// sub-base-circle run.
//
// Placement is free: rotating a conjugate profile about its own axis only phases
// the mesh, it does not break conjugacy. So the face curve is placed with its
// inner end ON the pitch-line flank, which keeps tooth thickness the designed
// figure (`halfToothAngle`) instead of letting the pin radius eat it.

/** The cycloidal descriptor for a spec, or undefined when it is an involute gear.
 *  One place decides which profile a spec means, so no call site can disagree —
 *  and a project saved before cycloidal existed has no `toothProfile` and reads as
 *  involute, which is what it was. */
export function cycOf(spec: GearSpec): CycMate | undefined {
  if (spec.toothProfile !== 'cycloidal') return undefined
  // Defaulted, not trusted. A gear whose params were written before these fields
  // existed has neither, and an undefined pin diameter does not draw a wrong tooth
  // — it makes every coordinate NaN, so the gear silently stops rendering and the
  // panel field it belongs to disappears along with it.
  const mateTeeth = Number.isFinite(spec.mateTeeth) ? spec.mateTeeth : 8
  const pinDia = Number.isFinite(spec.pinDia) ? spec.pinDia : 1.25 * Math.max(0.05, spec.module)
  return { mateTeeth, pinDia }
}

/** The lantern pinion a cycloidal wheel is cut for. */
export interface CycMate { mateTeeth: number; pinDia: number }

/**
 * Radius of the describing circle: the pinion's FULL pitch radius.
 *
 * That is the lantern case — the pin centres ride the pitch circle, so a point of
 * that circle rolling on the wheel traces the locus the pins follow. (A LEAVED
 * pinion would want half of it, so the hypocycloid inside the pinion degenerates
 * to a radial flank; this generator only cuts for lanterns, which is what wooden
 * clocks use, so half never appears here.)
 */
export function describingRadius(m: number, mateTeeth: number): number {
  return (Math.max(0.05, m) * Math.max(2, Math.round(mateTeeth))) / 2
}

/**
 * A point on the epicycloid, with its unit tangent.
 *
 * A point of the circle of radius `rho` rolling outside the circle of radius
 * `rb`, starting at (rb, 0) and running counter-clockwise:
 *
 *     x = (rb+ρ)·cos t − ρ·cos(kt),  y = (rb+ρ)·sin t − ρ·sin(kt),  k = (rb+ρ)/ρ
 *
 * t = 0 is a CUSP — the velocity vanishes there — and the limiting tangent is
 * radial, which is exactly what lets the face meet a radial flank without a
 * corner.
 */
function epicycloidAt(rb: number, rho: number, t: number): { x: number; y: number; tx: number; ty: number } {
  const k = (rb + rho) / rho
  const x = (rb + rho) * Math.cos(t) - rho * Math.cos(k * t)
  const y = (rb + rho) * Math.sin(t) - rho * Math.sin(k * t)
  let dx = -(rb + rho) * Math.sin(t) + k * rho * Math.sin(k * t)
  let dy = (rb + rho) * Math.cos(t) - k * rho * Math.cos(k * t)
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) { dx = 1; dy = 0 } else { dx /= len; dy /= len }
  return { x, y, tx: dx, ty: dy }
}

/**
 * The face of one tooth as (radius, angle from its pitch-line foot) pairs, the
 * same form `toothedRing` consumes for an involute flank.
 *
 * Sampling is adaptive on the chord: an epicycloid's curvature runs from zero at
 * the cusp to a maximum partway up, so no fixed step in t is right everywhere —
 * midpoints are tested against `FLANK_TOL` and the interval split until they fit.
 * `pinR > 0` offsets the curve into the tooth by the pin radius, which is what
 * turns the pin-centre locus into the face that envelopes the pin.
 */
function cycloidFace(rp: number, rho: number, ra: number, pinR: number): { r: number; a: number }[] {
  // Offset INTO the tooth: the tooth body is on the +y side of this curve (it
  // rises counter-clockwise toward the tooth centreline), so the inward normal is
  // the tangent turned +90°.
  const pt = (t: number): Pt => {
    const e = epicycloidAt(rp, rho, t)
    return [e.x - pinR * e.ty, e.y + pinR * e.tx]
  }
  const rad = (p: Pt) => Math.hypot(p[0], p[1])

  // How far up the curve the tip is. r(t) climbs monotonically over the arch, so
  // bisection finds it; the arch tops out at rp + 2ρ, which is the ceiling on how
  // tall a cycloidal tooth can be for this pinion.
  const tTop = (Math.PI * rho) / (rp + rho)
  let tEnd = tTop
  if (rad(pt(tTop)) > ra) {
    let lo = 0, hi = tTop
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2
      if (rad(pt(mid)) < ra) lo = mid; else hi = mid
    }
    tEnd = lo
  }

  // Adaptive subdivision on the chord's sagitta.
  const out: { t: number; p: Pt }[] = [{ t: 0, p: pt(0) }]
  const push = (t0: number, p0: Pt, t1: number, p1: Pt, depth: number) => {
    const tm = (t0 + t1) / 2
    const pm = pt(tm)
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1]
    const len = Math.hypot(dx, dy)
    // Distance of the midpoint from the chord — the error a straight segment makes.
    const err = len < 1e-12
      ? Math.hypot(pm[0] - p0[0], pm[1] - p0[1])
      : Math.abs((pm[0] - p0[0]) * dy - (pm[1] - p0[1]) * dx) / len
    if (depth >= 9 || (err <= FLANK_TOL && len <= (ra - rp) + 0.5)) { out.push({ t: t1, p: p1 }); return }
    push(t0, p0, tm, pm, depth + 1)
    push(tm, pm, t1, p1, depth + 1)
  }
  const steps = 6              // a coarse spine, then refined where it needs it
  let prevT = 0, prevP = out[0].p
  for (let i = 1; i <= steps; i++) {
    const t = (tEnd * i) / steps
    const p = pt(t)
    push(prevT, prevP, t, p, 0)
    prevT = t; prevP = p
  }

  // Re-expressed against the foot, so the caller can place and mirror it: the
  // face's own start angle is the datum, which is what keeps the pin radius out of
  // the tooth thickness.
  const a0 = Math.atan2(out[0].p[1], out[0].p[0])
  return out.map(({ p }) => ({ r: rad(p), a: Math.atan2(p[1], p[0]) - a0 }))
}

/** The cycloidal toothed outline, CCW, centred on the origin. */
function cycloidalRing(spec: CycloidalSpec): Pt[] {
  const { m, z, backlash, mateTeeth, pinDia } = spec
  const rp = (m * z) / 2
  const psi = cycloidalHalfTooth(m, z, backlash)
  const pinR = Math.max(0, pinDia) / 2
  const rf = cycloidalRoot(m, z, pinR)
  const rho = describingRadius(m, mateTeeth)
  const ra = cycloidalTip(spec)
  const face = cycloidFace(rp, rho, ra, pinR)
  const pitch = (2 * Math.PI) / z

  const ring: Pt[] = []
  const at = (r: number, a: number) => ring.push([r * Math.cos(a), r * Math.sin(a)])

  for (let i = 0; i < z; i++) {
    const c = i * pitch
    // Radial run up to the pitch line. Its foot is already on the ring — the
    // previous tooth's root arc ended exactly there — so only the top is pushed.
    at(face[0].r, c - psi)
    // Rising face, curving toward the tooth's centreline as it climbs.
    for (let k = 1; k < face.length; k++) at(face[k].r, c - psi + face[k].a)
    const tipA = face[face.length - 1].a
    arcInto(ring, 0, 0, ra, ra, c - psi + tipA, c + psi - tipA)
    // Falling face, then the radial run down — its foot placed by hand, for the
    // same reason the involute generator places its own (arcInto skips its start
    // point, and the root arc's start is not where the flank ended).
    for (let k = face.length - 2; k >= 0; k--) at(face[k].r, c + psi - face[k].a)
    at(rf, c + psi)
    arcInto(ring, 0, 0, rf, rf, c + psi, c + pitch - psi)
  }
  return ring
}

interface CycloidalSpec extends CycMate { m: number; z: number; backlash: number }

/** Half the tooth's angular width at the PITCH circle — where a cycloidal tooth's
 *  thickness is defined (there is no base circle to measure it on). Backlash
 *  thins it, exactly as in the involute case. */
function cycloidalHalfTooth(m: number, z: number, backlash: number): number {
  const nominal = Math.PI / (2 * z)
  return Math.max(nominal * 0.05, nominal - Math.max(0, backlash) / (2 * m * z))
}

/**
 * Root radius. Deeper than the involute dedendum when a fat pin needs it: the pin
 * centre rides the pinion's pitch circle, so the pin's inner edge dips to
 * `rp − pinR` at the line of centres, and a root above that is a pin bottoming in
 * the wheel — the loudest failure in a clock train, and one that looks fine on the
 * canvas. The panels report the deepened root.
 */
function cycloidalRoot(m: number, z: number, pinR: number): number {
  const rp = (m * z) / 2
  const clearance = 0.2 * m
  return Math.max(0.1, Math.min(rp - DEDENDUM * m, rp - pinR - clearance))
}

/** The tip, pulled in to where the two faces meet or where the epicycloid's arch
 *  ends — whichever comes first. A cycloidal tooth cannot be taller than
 *  `2·ρ` above the pitch circle, however much addendum is asked for. */
function cycloidalTip(spec: CycloidalSpec): number {
  const { m, z, backlash, mateTeeth, pinDia } = spec
  const rp = (m * z) / 2
  const psi = cycloidalHalfTooth(m, z, backlash)
  const pinR = Math.max(0, pinDia) / 2
  const rho = describingRadius(m, mateTeeth)
  const arch = rp + 2 * rho
  const nominal = Math.min(rp + ADDENDUM * m, arch)

  // The faces converge as they climb; where their angular offset reaches psi the
  // tooth has come to a point and anything beyond crosses them over.
  const face = cycloidFace(rp, rho, nominal, pinR)
  const meet = face.find((q) => q.a >= psi)
  if (!meet) return nominal
  return Math.max(rp + 0.05 * m, meet.r)
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

function toothedOutline(
  m: number, z: number, alpha: number, backlash: number,
  cyc?: CycMate,
): Pt[][] {
  // The cycloidal face depends on the mate, so those three go in the key: two
  // gears alike but for the pinion they are cut for have different teeth.
  const key = cyc
    ? `c|${m}|${z}|${backlash}|${cyc.mateTeeth}|${cyc.pinDia}`
    : `i|${m}|${z}|${alpha}|${backlash}`
  const hit = TOOTH_CACHE.get(key)
  if (hit) return hit
  const ring = cyc
    ? cycloidalRing({ m, z, backlash, ...cyc })
    : toothedRing(m, z, alpha, backlash)
  const rings = roundConcave([ring], ROOT_FILLET * m)
  if (TOOTH_CACHE.size >= TOOTH_CACHE_MAX) TOOTH_CACHE.delete(TOOTH_CACHE.keys().next().value!)
  TOOTH_CACHE.set(key, rings)
  return rings
}

/** Test hook — the memo is module-scope, so a perf test has to be able to clear it. */
export function __resetGearCache(): void { TOOTH_CACHE.clear() }

/** Test hook — the toothed ring BEFORE the root-fillet closing, so a harness can
 *  tell a geometry error from the resampling that closing does to the whole
 *  outline (it offsets a polyline by its own vertex normals, twice). */
export function __gearRingRaw(spec: GearSpec): Pt[] {
  const m = Math.max(0.05, spec.module)
  const z = Math.max(4, Math.round(spec.teeth))
  const cyc = cycOf(spec)
  return cyc
    ? cycloidalRing({ m, z, backlash: Math.max(0, spec.backlash), ...cyc })
    : toothedRing(m, z, clamp(spec.pressureAngle, 5, 35) * (Math.PI / 180), Math.max(0, spec.backlash))
}

// ─── Tooth count and pitch radius ─────────────────────────────────────────────
//
// Two gears of the same module a few teeth apart are hard to tell apart once they
// are off the machine: the outside diameters differ by 2m, and nobody counts 47
// teeth by eye. So the count is engraved on the gear — and with it the PITCH
// RADIUS, because that is the number the pair is actually built around: two gears
// mesh when their pitch circles are tangent, so the centre distance is one gear's
// pitch radius plus the other's, and a gear that carries its own radius can be
// laid out against any partner with one addition and no arithmetic about modules.
//
// It is set in the single-STROKE face (Relief SingleLine), which is what makes it
// worth cutting on a gear at all: the glyphs are open strokes, so a V-bit or an
// engraving bit follows them in one pass — there is no outline to pocket out.
//
// It runs OUTWARD ALONG THE RIGHT-HAND SPOKE, on the axis, starting clear of the
// bore. `spokeWindows` lays window i from angle i·step, so there is always a spoke
// centred on +X — which is the roomiest line on the whole gear, and the reason the
// text can be a line long enough to carry two figures. The material under it is
// the hub disc out to `hubR`, then the spoke: the sides of a spoke are the lines
// y = ±hw (that is what `radial` traces), so everything with |y| ≤ hw and
// 0 ≤ x ≤ rimInner is one continuous run of stock, and the window fillets only add
// to it. A solid web has no spoke to follow and no window to avoid, so there the
// bound is simply the root circle.
//
// Shrunk to fit that run, and DROPPED below `LABEL_MIN_SIZE` — an absent number is
// obvious on the canvas, a number cut through a spoke window is not.

/** Cap height of the text, mm — a size that reads across a workshop. */
export const TOOTH_LABEL_SIZE = 6
/** Shrink no further than this; below it, no text at all. */
const LABEL_MIN_SIZE = 2.5
/** Daylight between the text and the stock it is running down, mm. */
const LABEL_CLEAR = 0.75
/** Daylight from the bore, mm — deliberately more than `LABEL_CLEAR`. The bore is
 *  the edge the eye lines the text up against, and a gap that looks generous
 *  against a straight spoke side looks pinched against a circle. */
const LABEL_BORE_CLEAR = 1.6

/** Ink extents of a `d` string, in the same space as the path. */
function inkBox(d: string): { x0: number; y0: number; w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const poly of flattenPath(d, 0.02)) {
    for (const [x, y] of poly) {
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (!isFinite(x0)) return null
  return { x0, y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * Largest scale at which a w×h box, laid on the +X axis with its left edge at
 * `xl`, stays inside radius `R`. Its far CORNERS are what the circle has to clear:
 *
 *     (xl + s·w)² + (s·h/2)² ≤ R²
 *
 * a quadratic in s. Zero when even a vanishing box would not fit.
 */
/**
 * Largest scale at which a w×h box laid FLAT below the centre fits the annulus
 * [ri, ro], with the inner radius it was seated against. The box is pushed as far
 * in as the ring allows — its inner edge rides ri — so the outer radius has to
 * clear its far CORNERS:
 *
 *     (s·w/2)² + (a + s·h)² ≤ R²,     a = ri + clear,  R = ro − clear
 *
 * the same quadratic as `fitInDisc`, with the roles of the two dimensions swapped.
 * This is the ring between a pinion's arbor and its pin holes; the wheel's marking
 * uses the radial mode instead, because a spoke gives it a longer run.
 */
function fitInRing(w: number, h: number, ri: number, ro: number, inner = LABEL_CLEAR): { s: number; a: number } | null {
  const R = ro - LABEL_CLEAR
  const a = ri + inner
  if (R <= 0 || w <= 0 || h <= 0 || a >= R) return null
  const A = (w * w) / 4 + h * h
  const B = 2 * a * h
  const C = a * a - R * R                      // negative, since a < R
  const s = (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A)
  return s > 0 ? { s, a } : null
}

function fitInDisc(w: number, h: number, xl: number, R: number): number {
  const A = w * w + (h * h) / 4
  const B = 2 * xl * w
  const C = xl * xl - R * R
  if (C >= 0 || A <= 0) return 0
  return (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A)
}

export interface GearLabel {
  d: string
  /** What is engraved — the tooth count and the pitch radius. */
  text: string
  /** Cap height actually used — less than `TOOTH_LABEL_SIZE` when the gear was
   *  tight and the text had to be shrunk to fit the spoke. */
  sizeMM: number
}

/**
 * The engraved tooth count and pitch radius, placed and sized for this gear.
 *
 * Null means there is nothing to emit: it was not asked for, no room beside the
 * bore holds a legible line, or the single-stroke font has not finished loading
 * (it is fetched on demand — a caller that can regenerate should do so once it
 * has, and a caller that is about to REPLACE a gear's paths must wait for it, or
 * the text the gear already carries would be dropped).
 *
 * Always mm, whatever the toolbar is displaying: this is a physical marking on a
 * physical part, so it must not change under a units toggle that touches nothing
 * else about the gear.
 */
export function gearLabel(spec: GearSpec): GearLabel | null {
  if (!spec.toothLabel || !isFontLoaded(SINGLE_LINE_FONT_FAMILY)) return null
  const m = Math.max(0.05, spec.module)
  const z = Math.max(4, Math.round(spec.teeth))
  const rp = (m * z) / 2
  // "24 R48" — count, then the radius to add to a partner's for the centres.
  const text = `${z} R${+rp.toFixed(2)}`

  // The profile's own root: a cycloidal lantern gear may have been cut deeper to
  // clear its pins, and the marking must not run out into that.
  const rf = gearDims(m, z, spec.pressureAngle, spec.backlash, cycOf(spec)).rootDia / 2
  // The bore is only a hole once it is big enough to be emitted; below that the
  // middle is solid stock and the text can start almost at the centre.
  const boreR = clamp(spec.bore / 2, 0, rf - 1)
  const inner = boreR > 0.25 ? boreR : 0
  const xl = inner + (inner > 0 ? LABEL_BORE_CLEAR : LABEL_CLEAR)

  const probe = generateTextD({ type: 'text', x: 0, y: 0, text, fontSize: TOOTH_LABEL_SIZE, fontFamily: SINGLE_LINE_FONT_FAMILY })
  const box = probe ? inkBox(probe) : null
  if (!box || box.w <= 0 || box.h <= 0) return null

  // The line may run all the way out to the root circle: hub disc, then spoke,
  // then — past the window arc — the rim ring, which is solid at every angle. So
  // the disc bound is the same for a spoked gear as for a solid one, and being
  // spoked adds exactly one constraint: the text has to fit BETWEEN the spoke's
  // sides. `hub.spoked` is the same test `spokeWindows` guards on, so it cannot
  // claim a spoke that was not drawn.
  const hub = gearHub(m, z, spec.bore, spec.hubDia, spec.spokes)
  let s = fitInDisc(box.w, box.h, xl, rf - LABEL_CLEAR)
  if (hub.spoked) {
    const hw = Math.min((SPOKE * m) / 2, (hub.dia / 2) * 0.9)   // as spokeWindows sizes it
    s = Math.min(s, (2 * (hw - LABEL_CLEAR)) / box.h)
  }
  if (!(s > 0)) return null

  s = Math.min(1, s)
  const sizeMM = s * TOOTH_LABEL_SIZE
  if (sizeMM < LABEL_MIN_SIZE) return null

  // `generateTextD` is linear in size about its origin, so the probe's ink box
  // scales with s — the final string needs no second measurement, only the offset
  // that puts its left edge at `xl` and centres it on the spoke's axis.
  const d = generateTextD({
    type: 'text', text, fontSize: sizeMM, fontFamily: SINGLE_LINE_FONT_FAMILY,
    x: spec.cx + xl - s * box.x0,
    y: spec.cy - s * (box.y0 + box.h / 2),
  })
  return d ? { d, text, sizeMM } : null
}

// ─── The lantern pinion ───────────────────────────────────────────────────────
//
// The mate, drawn from the wheel's own parameters — pin count and pin diameter are
// already what shaped the teeth, so there is nothing left to ask for.
//
// A lantern pinion is two round CHEEKS with dowels between them, and the geometry
// only makes sense once you see where the wheel goes: its teeth reach INSIDE the pin
// circle (that is how a tooth gets behind a pin to push it), so the cheeks cannot
// clear the teeth radially at all — the wheel runs between them, axially. Which is
// what frees the cheek to be bigger than the pin circle and to enclose the holes
// properly. Two cheeks per pinion, and the wheel must be thinner than the gap.
//
// It is drawn CLEAR of the wheel rather than at the centre distance. Overlapping
// outlines would be the truth of the assembly — in plan view the cheek does cover
// the wheel's teeth — but they are two parts to be cut, not an assembly drawing,
// and geometry that overlaps is a nuisance to machine. The panels print the real
// centre distance instead, which is the number a clock plate is laid out from.

const PIN_RIM = 0.5        // × module — stock left outside a pin hole (min 1.5 mm)
const PINION_GAP = 0.5     // × module — daylight between wheel tips and cheek (min 2 mm)

export interface PinionDims {
  /** Cheek disc diameter — big enough to enclose the pin holes with a rim. */
  cheekDia: number
  /** Pin centres ride this: the pinion's pitch circle. */
  pinCircleDia: number
  pins: number
  pinDia: number
  /** Where the PAIR runs — pitch circles tangent. NOT where the pinion is drawn. */
  centreDistance: number
  /** Wood left between two neighbouring pin holes, mm. Negative means they merge. */
  pinGap: number
}

/** The mating pinion's numbers, or null for a gear that has no lantern mate. */
export function pinionDims(spec: GearSpec): PinionDims | null {
  const cyc = cycOf(spec)
  if (!cyc) return null
  const m = Math.max(0.05, spec.module)
  const z = Math.max(4, Math.round(spec.teeth))
  const pins = Math.max(2, Math.round(cyc.mateTeeth))
  const pinDia = Math.max(0.1, cyc.pinDia)
  const rPin = describingRadius(m, pins)                 // = the pinion's pitch radius
  const rim = Math.max(1.5, PIN_RIM * m)
  return {
    cheekDia: 2 * (rPin + pinDia / 2 + rim),
    pinCircleDia: 2 * rPin,
    pins,
    pinDia,
    centreDistance: (m * z) / 2 + rPin,
    // Chord between neighbouring pin centres, less a pin.
    pinGap: 2 * rPin * Math.sin(Math.PI / pins) - pinDia,
  }
}

/**
 * The pinion's marking: its own PITCH RADIUS, e.g. "R16".
 *
 * Which is the number a clock plate is laid out from — the wheel carries "24 R48",
 * the pinion "R16", and 48 + 16 is the centre distance, arbor to arbor. Marked on
 * the cheek so that arithmetic survives the parts being cut, unpacked and picked up
 * months later, which is why the wheel carries its own.
 *
 * The pin COUNT is deliberately left off, though the wheel engraves its tooth count.
 * The wheel does that because nobody counts 47 teeth by eye — and nobody needs to
 * count six pins. Leaving it off halves the width, and a cheek has very little room:
 * the only solid ground on one is the ring between the arbor hole and the pin holes,
 * and "8 R16" did not fit a 6-pin m4 cheek at any legible size. The mark sits flat
 * below the arbor in that ring, shrunk to fit, dropped if illegible.
 */
export function pinionLabel(spec: GearSpec): GearLabel | null {
  const p = pinionDims(spec)
  if (!p || !spec.emitPinion || !spec.toothLabel) return null
  if (!isFontLoaded(SINGLE_LINE_FONT_FAMILY)) return null
  const rC = p.pinCircleDia / 2
  const text = `R${+rC.toFixed(2)}`

  const probe = generateTextD({ type: 'text', x: 0, y: 0, text, fontSize: TOOTH_LABEL_SIZE, fontFamily: SINGLE_LINE_FONT_FAMILY })
  const box = probe ? inkBox(probe) : null
  if (!box || box.w <= 0 || box.h <= 0) return null

  // Solid ring: outside the arbor hole, inside the pin holes.
  const cheekR = p.cheekDia / 2
  const boreR = clamp(spec.bore / 2, 0, cheekR - 1)
  // Standing off the arbor by the plain clearance rather than the wheel's wider
  // LABEL_BORE_CLEAR: that extra millimetre is an aesthetic nicety on a wheel's open
  // face, and on a cheek this crowded it is the difference between a mark and none.
  const fit = fitInRing(box.w, box.h, boreR > 0.25 ? boreR : 0, rC - p.pinDia / 2)
  if (!fit) return null
  const s = Math.min(1, fit.s)
  const sizeMM = s * TOOTH_LABEL_SIZE
  if (sizeMM < LABEL_MIN_SIZE) return null

  const { cx, cy } = pinionCentre(spec)
  const yc = fit.a + (s * box.h) / 2
  const d = generateTextD({
    type: 'text', text, fontSize: sizeMM, fontFamily: SINGLE_LINE_FONT_FAMILY,
    x: cx - s * (box.x0 + box.w / 2),
    y: cy - yc - s * (box.y0 + box.h / 2),
  })
  return d ? { d, text, sizeMM } : null
}

/** Where the pinion is drawn — clear of the wheel, along +X. */
function pinionCentre(spec: GearSpec): { cx: number; cy: number } {
  const m = Math.max(0.05, spec.module)
  const p = pinionDims(spec)!
  const raWheel = gearDims(m, spec.teeth, spec.pressureAngle, spec.backlash, cycOf(spec)).outsideDia / 2
  return { cx: spec.cx + raWheel + p.cheekDia / 2 + Math.max(2, PINION_GAP * m), cy: spec.cy }
}

/** Cheek outline and pin holes, placed clear of the wheel. */
function pinionParts(spec: GearSpec): GearPart[] {
  const p = pinionDims(spec)
  if (!p || !spec.emitPinion) return []
  const cheekR = p.cheekDia / 2
  const { cx, cy } = pinionCentre(spec)

  const out: GearPart[] = [
    { key: 'pinion', d: ringToD(ellipseRing(cx, cy, cheekR, cheekR), true) },
  ]
  const rHole = p.pinDia / 2
  const rC = p.pinCircleDia / 2
  const holes: string[] = []
  for (let i = 0; i < p.pins; i++) {
    const a = (i * 2 * Math.PI) / p.pins
    holes.push(ringToD(ellipseRing(cx + rC * Math.cos(a), cy + rC * Math.sin(a), rHole, rHole), false))
  }
  out.push({ key: 'pinholes', d: holes.join(' ') })

  // The arbor hole, on the same reasoning as the wheel's: its own part, because it
  // is its own cut at its own diameter. Only when the wheel has a bore to copy.
  const boreR = clamp(spec.bore / 2, 0, cheekR - 1)
  if (boreR > 0.25) out.push({ key: 'pinionbore', d: ringToD(ellipseRing(cx, cy, boreR, boreR), false) })

  // The pinion's pitch circle, on the same switch as the wheel's — and it is the
  // one that makes the layout obvious, because it runs exactly THROUGH the pin
  // centres. That is the whole answer to "which radius do I space them by": the
  // pinion's pitch radius is arbor to pin CENTRE, and the two pitch circles are
  // tangent when the pair is correctly spaced. A reference, not a cut.
  if (spec.pitchCircle) {
    out.push({ key: 'pinionpitch', d: ringToD(ellipseRing(cx, cy, rC, rC), false) })
  }

  // Its own marking — the pitch radius to add to the wheel's.
  const label = pinionLabel(spec)
  if (label) out.push({ key: 'pinionlabel', d: label.d })
  return out
}

/** A gear's parts, each of which wants its OWN operation. */
export type GearPartKey = 'teeth' | 'spokes' | 'bore' | 'label' | 'pitch' | 'pinion' | 'pinholes' | 'pinionbore' | 'pinionpitch' | 'pinionlabel'

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
  const cyc = cycOf(spec)
  // Everything inside the teeth hangs off the root circle, and a lantern's pin can
  // push that deeper — so ask for the profile's own root, not the ISO dedendum.
  const rf = gearDims(m, z, spec.pressureAngle, spec.backlash, cyc).rootDia / 2
  const place = (r: Pt[]) => r.map(([x, y]) => [x + spec.cx, y + spec.cy] as Pt)

  // One closing fills every root corner at once with the rack-tip radius, and
  // leaves the convex tooth tips exactly where the involute put them — memoised,
  // because it is the whole cost of the gear and none of these four numbers
  // change when the bore, hub or spokes do.
  const outline = toothedOutline(m, z, alpha, Math.max(0, spec.backlash), cyc)
  const out: GearPart[] = [{
    key: 'teeth',
    d: outline.map((r) => ringToD(place(r), true)).join(' '),
  }]

  const boreR = clamp(spec.bore / 2, 0, rf - 1)
  if (boreR > 0.25) out.push({ key: 'bore', d: ringToD(place(ellipseRing(0, 0, boreR, boreR)), false) })

  // Windings stay as they were: these are holes in the blank, so CW, which is
  // what anything reading them as regions expects.
  const hub = gearHub(m, z, spec.bore, spec.hubDia, spec.spokes)
  const windows = spokeWindows(Math.round(spec.spokes), rf - RIM * m, hub.dia / 2, SPOKE * m)
  if (windows.length > 0) {
    out.push({ key: 'spokes', d: windows.map((r) => ringToD(place(r), false)).join(' ') })
  }

  // Open strokes, already in place — its own path because it is engraved, not
  // profiled, and because a user who does not want it deletes one path.
  const label = gearLabel(spec)
  if (label) out.push({ key: 'label', d: label.d })

  // A reference, not a cut — see GearSpec.pitchCircle. Its own path so it can be
  // deleted without touching anything that is going to be machined.
  if (spec.pitchCircle) {
    out.push({ key: 'pitch', d: ringToD(place(ellipseRing(0, 0, (m * z) / 2, (m * z) / 2)), false) })
  }

  // The mate, if asked for — cheek, pin holes, arbor.
  out.push(...pinionParts(spec))
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
