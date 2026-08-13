// ─── Recoil and deadbeat escapements, with the pallets that suit them ────────
//
// An escapement is a PAIR, and neither half means anything on its own: the
// pallet faces are the loci of the wheel's tooth tips, so a wheel and an anchor
// drawn from different numbers do not run together at all. Both come out of one
// spec here for that reason — the same call that cuts the wheel cuts its anchor.
//
// THE CLASSIC CONSTRUCTION. The pallets sit `span` teeth apart, so they subtend
// β = span·2π/N at the wheel centre. Put the anchor arbor where the two TANGENTS
// to the tip circle at those points cross:
//
//     L = R / cos(β/2)     arbor to wheel centre
//     ρ = R · tan(β/2)     arbor to either pallet
//
// Everything good about the escapement follows from that tangency. AP ⟂ OP, so a
// face concentric with the arbor is RADIAL to the wheel — the tooth pushes it
// edge-on and cannot unlock itself, which is what "dead" means. And the arms lie
// along tangent lines, so they clear the tip circle everywhere except at the one
// point where they are supposed to touch it.
//
// SPAN MUST BE A HALF-INTEGER. The wheel advances exactly half a tooth per beat,
// so the two pallets have to stand an odd number of half-pitches apart or one
// releases without the other catching. 7.5 teeth of 30 is the everyday case.
//
// THE FACES ARE GENERATED, NOT DRAWN. A tooth acts by its TIP, which is a point,
// so the face it slides on is simply the path that point takes in the anchor's
// own frame — the same reasoning that makes a lantern pinion's epicycloid the
// path of a pin centre. Roll the wheel forward by the impulse angle while the
// anchor turns by the lift, transform the tip into anchor coordinates as you go,
// and the curve you get IS the impulse face. Both escapements share it:
//
//   DEADBEAT — before impulse, the wheel is held. Freeze it and let the anchor
//   carry on: the locus becomes an arc about the arbor, which is the dead lock,
//   with `draw` tilting it a couple of degrees so the tooth pulls the pallet in
//   rather than pushing it out.
//
//   RECOIL — nothing is held. Let both keep turning past the start of impulse
//   and the wheel is driven BACKWARDS, which is exactly what a recoil escapement
//   does with the pendulum's supplementary arc.
//
// One consequence worth knowing: the entry and exit faces are NOT mirror images.
// The wheel turns the same way for both, so the two loci genuinely differ. Every
// hand construction draws them symmetric; this one does not have to.
//
// The wheel advances half a tooth per beat and that is all it has, so
//
//     impulse at the wheel = 180°/N − drop
//
// which is why `drop` is an input and the wheel's share of the impulse is not.
//
// DROP LOCK. A tooth arrives by falling, and it has to fall onto DEAD FACE. Lay
// the two loci out as above and it does not: each pallet's impulse begins at the
// exact anchor angle at which the other one releases, so the arriving tooth
// meets the corner where the locking face turns into the impulse face — and the
// running clearance then carries it a few tenths PAST that corner, onto a face
// lying some 50° off the wheel's radius. It does not lock there; it slides, and
// the escapement trips through every beat. The drawing shows nothing wrong.
//
// The fix is not to extend the dead face past the corner. That is the obvious
// move and it cannot work: past the corner is where the impulse face goes, so
// the extension is buried by the boolean and the pallet comes out exactly as it
// was. What has to move is the corner. Each pallet's whole profile is turned
// about the arbor — the entry by +D/2, the exit by −D/2 — so the two embrace
// D more of the anchor's travel than the bare loci do, and a tooth released by
// one lands D deep on the other's dead face. That D is the DROP LOCK: the lock
// the escapement has at the instant of the drop, as against the lock it runs to
// once the pendulum has carried the pallet the rest of the way in.
//
// It costs D/2 of extra swing before either pallet will unlock, which is what a
// real escapement pays for it too.
//
// THE ANCHOR CLEARS THE WHEEL BY WHERE IT IS PUT, not by being cut back. Each arm
// runs along its tangent line, rotated off it by the half swing so it lands ON
// the tangent at the extreme and outside it everywhere else; only the pallets go
// inside the tip circle, which is what pallets are for. Relieving the body with
// the swept tip circle instead — the obvious move — is wrong twice over: it is
// far too conservative (the teeth are thin spikes and an anchor sits BETWEEN
// them) and it cuts the pallets off the arms it was meant to leave them on.
// Whether the two really clear is settled by running the mesh, not by the
// outline: `scripts/escapement-check.mts`.
//
// Emitted as separate parts — wheel, spokes, bore, anchor, anchor bore — because
// they are different cuts, and drawn CLEAR of each other rather than in mesh:
// these are two parts to go on the stock, and the number that matters (the true
// centre distance) is a readout, not something to scale off the drawing.

import {
  type Pt, clamp, arcInto, ellipseRing, roundRectRing,
  boolRings, roundConcave, ringToD,
} from './polyOps'
import { seatHub, spokeWindows, type HubFit } from './spokedWheel'
import { getTreatableCorners, applyCornerTreatments } from '../tools/cornerTreatment'

export type EscapementType = 'recoil' | 'deadbeat'

export interface EscapementSpec {
  cx: number; cy: number
  escType: EscapementType
  /** Escape wheel tooth count. 30 makes a seconds pendulum beat seconds. */
  teeth: number
  /** Tip circle diameter — the wheel's overall size. */
  wheelDia: number
  /** Tip circle to root circle, mm. */
  toothDepth: number
  /** Free travel of the wheel between one tooth releasing and the next locking,
   *  in WHEEL degrees. What is left of the half tooth pitch is the impulse. */
  drop: number
  /** Impulse measured at the ANCHOR, degrees — the swing the escapement gives
   *  back to the pendulum. */
  lift: number
  /** Deadbeat only: how deep the tooth locks, in anchor degrees. */
  lock: number
  /** Deadbeat only: degrees the locking face leans off concentric so the tooth
   *  draws the pallet IN. Without it the escapement can trip on its own. */
  draw: number
  /** Recoil only: anchor degrees of supplementary swing the faces can absorb.
   *  The wheel is pushed back through all of it. */
  recoilArc: number
  /** Anchor arm and pallet width, mm. */
  armWidth: number
  /** Wheel bore Ø. 0 for none. */
  bore: number
  /** Wheel hub Ø — a FLOOR, grown if the spokes need more room to land on. */
  hubDia: number
  /** 0 for a solid wheel. */
  spokes: number
  /** Anchor arbor Ø. 0 for none. */
  anchorBore: number
  /** Wheel turns clockwise. The teeth lean the way it runs, so this is not
   *  cosmetic — a wheel cut the wrong way round will not lock at all. */
  clockwise: boolean
}

export interface EscapementDims {
  /** Arbor to wheel centre, R/cos(β/2) — the number the clock plate is drilled
   *  from. The two are drawn clear of each other, never at this spacing. */
  centreDistance: number
  /** Arbor to either pallet face, R·tan(β/2). */
  palletRadius: number
  /** Degrees of wheel per tooth, and per beat (half of it). */
  toothPitchDeg: number
  beatDeg: number
  /** Wheel degrees of impulse — the half pitch less the drop. */
  wheelImpulseDeg: number
  /** How far the anchor must swing each side of centre before the escapement
   *  will unlock and impulse. The pendulum has to beat wider than this. */
  minHalfSwingDeg: number
  /** Inclination of the impulse face to the dead arc. The escapement's working
   *  angle: too flat and it will not unlock, too steep and it wastes the drive. */
  impulseAngleDeg: number
  /** Acting face length, mm — what the tooth actually slides along. */
  faceWidth: number
  /** Recoil only: wheel degrees pushed back per anchor degree of overswing. */
  recoilRatio: number
  wheelRootDia: number
  hub: HubFit
  /** Teeth spanned by the pallets — derived from the tooth count, not asked for.
   *  See `escapementSpan`. Reported because it is what sets the arbor's distance
   *  and the whole shape of the anchor. */
  span: number
  /** Drop eats the whole half pitch — there is no impulse left. Fatal. */
  noImpulse: boolean
  /** The anchor's hub reaches into the wheel; the relief cut will eat it. */
  hubFouls: boolean
  /** The faces are steep enough that the drive may not unlock them. */
  faceTooSteep: boolean
  /** How far past the tip circle a pallet goes at the end of its swing, mm —
   *  ρ·Φ. The impulse face has to share the tooth SPACE with the tooth it just
   *  locked, so this is the number that decides whether the pair jams. */
  palletDive: number
  /** That dive is too much of the tooth depth to fit in the space beside a
   *  tooth: the pair will bind. Bigger teeth, less lock or lift, or less span. */
  divesTooDeep: boolean
  /** Tooth thickness where it leaves the gullet, mm — the first section that is
   *  the tooth's own material and not the stock joining it to its neighbours.
   *  What has to carry the drive across the grain, and what `TOOTH_BOW` is for.
   *  Measured at the top of the fill, not at the root circle: the fill reaches
   *  well above that, so a thickness taken there is a thickness of solid wheel. */
  toothBase: number
  /** The gullet, mm — the radius of the round that fills the bottom of each tooth
   *  space, sized from the room the pallet leaves rather than from the cutter,
   *  since the pallet never reaches down there. It is also the tightest inside
   *  radius on the wheel, so it says what the biggest cutter that can finish the
   *  teeth is: 2× this. */
  gulletRadius: number
  /** What a tooth locks by at the extreme of the swing, once the running
   *  clearance is taken off, mm — the lock the escapement really runs to, as
   *  against the one that was asked for. */
  lockDepth: number
  /** What it is already locked by at the instant it LANDS, mm — the drop lock.
   *  The one that decides whether the escapement is a deadbeat at all: land on
   *  no dead face and the tooth arrives on the impulse face and trips. Zero for
   *  a recoil anchor, which is meant to land on its impulse face. */
  dropLockDepth: number
  /** Nothing for the arriving tooth to land on. A deadbeat wants dead face
   *  there and has none; a recoil wants face of any kind and its own does not
   *  reach past the clearance. Either way the wheel runs straight through. */
  noLock: boolean
}

/** Wheel-side clearance the arms are held off their tangent line by, mm, on top
 *  of the swing they are already rotated back through. */
const ARM_CLEAR = 0.2
/** What the ENTRY arm's wheel-side flank is held off that tangent by at the
 *  pallet end instead — see `entryTaper`. Set from the measured skim, not
 *  guessed (`scripts/esc-arm-clearance.mts`): it takes that arm from 0.68 mm of
 *  clearance to 1.87 mm, which is where the exit arm already sits, and it is what
 *  stops a RECOIL anchor's entry arm touching the teeth outright. */
const ENTRY_CLEAR = 1.5
/** Fillet on each arm's toe — its far corner, away from the wheel — as a
 *  fraction of the arm width. Nothing touches it: shape only. */
const ARM_TOE = 0.35
/** What a RECOIL's entry blade may stand past the far end of its own acting face,
 *  mm. An eye judgement with a hard floor under it. At 0 the cut is flush with
 *  the end of the acting face — no material past it at all — and the
 *  `carries the locking face straight on into the arm` test fails, which is the
 *  right answer: the face has to run ON past its working end or the tooth reaches
 *  the very edge of it. This is that flush point plus 2 mm of margin. Going the
 *  other way, BELOW zero, the cut eats the acting face itself, and a recoil face
 *  is the travel the pendulum's overswing runs on — `recoilArc` is the honest way
 *  to shorten that. */
const RECOIL_TIP_LAND = 2
/** The RECOIL's entry toe, as a fraction of the arm width — 6 mm on a standard
 *  8 mm arm, against `ARM_TOE`'s 2.8. On that profile the toe IS the spear the
 *  run-out leaves, and rounding it is what takes the point off. See `filletToes`. */
const RECOIL_TOE = 0.75
/** How sharply a vertex must turn to be a corner rather than a sample on a
 *  curve, radians. */
const TOE_MIN_TURN = 0.7
/** Floor on the gullet fillet, mm. Not a design choice: a cutter leaves this much
 *  whatever is drawn. The radius actually used is sized from the room — see
 *  `gulletFillet`. */
const ROOT_FILLET = 0.6
/** Extra depth, as a fraction of the tooth, left clear UNDER the pallet's reach
 *  before the gullet fill is allowed to stand — see `gulletFillet`. The fill's
 *  widest section sits at this depth, so it is the real running clearance
 *  between the pallet's deepest dive and the stock below it. */
const GULLET_KEEP = 0.2
/** The most of the tooth depth the radial tip land may take. It is sized from the
 *  lock; this is the ceiling for a wheel whose lock is a large part of its own
 *  tooth. Past it the land is most of the leading face and the undercut has
 *  nowhere left to run. */
const TIP_LAND_MAX = 0.35
/** Degrees the tip land is relieved off radial. Small on purpose — see the tip
 *  land in `toothGeom`: radial is the angle that beds on the LOCKING face, and
 *  this is the least that keeps the land's inner corner out of the IMPULSE face,
 *  which stands at 53° to it. Calibrated against the mesh, and it is a knee, not a
 *  slope: 0° binds at 0.061 mm, 2° clears at 0.024, 4° is back to the 0.010 the
 *  wheel measures with no land at all, and 6° buys another four thousandths. */
const TIP_RELIEF = 4
/** How much of a tooth pitch a pallet may occupy around the wheel — see
 *  `palletNib`. The rest of the space is the drop and the tooth itself. */
const NIB_SPACE = 0.12
/** Degrees the back of a pallet is relieved by — see `palletNib`. */
const BACK_RELIEF = 75
/** How much of the root land one bowed flank may take, so a strip of land is
 *  always left between the two that share it — see `flankAngle`. */
const BOW_SHARE = 0.3
/** How far the tooth flanks bow outward, 0…1. Fixed rather than asked for: the
 *  gullet fill buries most of what the bow used to add, so it moves the tooth's
 *  section by ~13% over its whole range — not a decision worth a field.
 *
 *  REMOVING IT WAS TRIED AND REVERTED, 2026-08-13. The apparatus is real
 *  complexity for a small effect, but the effect is not as small as `toothBase`
 *  alone suggests: measured at five depths on eight wheels
 *  (`scripts/esc-tooth-shape.mts`), taking the bow out leaves the tooth IDENTICAL
 *  over its top half — everything the pallet works against — and about a ninth
 *  thinner in the bottom quarter (5.76 → 5.14 mm at a tenth of the depth on the
 *  default wheel, 12.15 → 10.48 on a 200 mm one), with the gullet fill shrinking
 *  2.39 → 2.15 alongside it for reasons that were not run down. Not worth chasing
 *  for the lines it saves. */
const TOOTH_BOW = 0.6
/** Extra depth, as a fraction of the tooth, kept clear below the pallet's reach
 *  before a flank is allowed to bow — see `toothGeom`'s `start`. */
const BOW_KEEP = 0.08
/** Fraction of the tooth pitch taken by the back slope; the rest is root land. */
const BACK_FRAC = 0.55
/** How much of the tooth depth a pallet may dive past the tip circle before its
 *  impulse face starts to reach the tooth it has just locked. Calibrated against
 *  the mesh, not guessed: at 0.44 of the depth both profiles measure exactly
 *  zero interference and at 0.51 the recoil is into the tooth by half a
 *  millimetre. See the sweep in `scripts/escapement-check.mts`. */
const DIVE_LIMIT = 0.45
/** Dead face wanted at each end of the lock, mm — under the tooth where it
 *  lands, and above it for the pendulum's supplementary arc to run through. See
 *  `dropLock`, which splits the lock between the two. What the pallets must
 *  embrace to deliver the first is this PLUS the running clearance, since
 *  cutting the teeth short carries the landing that much further along. */
const LANDING_MARGIN = 0.5
/** A standard 1/8" end mill. The exit pallet's deep-lock corner is relieved to
 *  its radius at the one corner that would otherwise put that radius on an
 *  acting face — see `lockCorner`. */
const LOCK_RELIEF_BIT_DIA = 3.175
/** How much clear face is left beyond the fillet at that corner, mm. */
const LOCK_LAND = 0.4

const rad = (deg: number) => (deg * Math.PI) / 180
const rot = (p: Pt, a: number): Pt => {
  const c = Math.cos(a), s = Math.sin(a)
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]
}
const norm = (p: Pt): Pt => {
  const n = Math.hypot(p[0], p[1]) || 1
  return [p[0] / n, p[1] / n]
}

/**
 * How many teeth the pallets span — DERIVED from the tooth count, never asked
 * for, because only one family of values works and the user cannot see which.
 *
 * The span must be an ODD NUMBER OF HALF TEETH. The wheel gives up half a tooth
 * per beat, so at 7.5 of 30 (fifteen halves) one pallet locks as the other
 * releases; at 8.0 (sixteen) one releases with nothing to catch it and the wheel
 * runs. This used to be a field with a red warning under it, which is a bad trade
 * — a number the form can compute is not a decision, and a third of the values a
 * spinner offered were fatal.
 *
 * A quarter of the teeth is the classic choice: it puts the pallets a quarter
 * turn apart, so the arms meet at about a right angle and the anchor looks like
 * an anchor. Round that to the nearest odd half — NOT to the nearest half, which
 * lands on a whole tooth for every other count and is exactly the broken case.
 * 30 teeth gives 7.5, which is what the field's default always was.
 */
export function escapementSpan(teeth: number): number {
  const N = Math.max(6, Math.round(teeth))
  return clamp(Math.round(N / 4 - 0.5) + 0.5, 0.5, N / 2 - 0.5)
}

/** The geometry every other function here starts from. */
function frame(spec: EscapementSpec) {
  const R = Math.max(2, spec.wheelDia / 2)
  const N = Math.max(6, Math.round(spec.teeth))
  const pitch = (2 * Math.PI) / N
  // Span is clamped short of a half turn: β → π sends the arbor to infinity.
  const span = clamp(escapementSpan(N), 0.5, N / 2 - 0.5)
  const beta = span * pitch
  const L = R / Math.cos(beta / 2)
  const rho = R * Math.tan(beta / 2)
  const beat = pitch / 2
  // The wheel's whole share of a beat is half a tooth; drop is taken out of it
  // first, and what is left is the impulse. A drop that eats the lot is a fatal
  // input, flagged in dims — clamped here only so the geometry stays drawable.
  const mu = Math.max(rad(0.1), beat - rad(Math.max(0, spec.drop)))
  const lam = rad(Math.max(0.2, spec.lift))
  return { R, N, pitch, beta, L, rho, beat, mu, lam }
}

// ─── The acting faces ─────────────────────────────────────────────────────────

type Side = 'entry' | 'exit'

/**
 * The DROP LOCK, in anchor radians — how deep a tooth is already locked at the
 * instant it lands, before the pendulum's supplementary arc drives it deeper.
 *
 * Without it a tooth lands exactly on the corner where the locking face turns
 * into the impulse face, because the bare loci give each pallet an impulse
 * starting at the very anchor angle at which the other releases. That is a
 * knife edge: the running clearance is enough to carry the landing past the
 * corner and onto the impulse face, where nothing locks.
 *
 * So the amount is not a taste. A tooth cut `clearance` short has to travel
 * that much further along the face before it is caught, so the pallets must
 * embrace the clearance PLUS the dead face we actually want under the tooth —
 * a LENGTH, turned into an angle at the pallet radius. Given the room it comes
 * out at exactly `LANDING_MARGIN` of real dead face however the teeth are cut.
 *
 * It is spent OUT of the lock, so the lock is shared: the tooth lands on the
 * drop lock and the supplementary arc runs it through what is left. Both ends
 * want the same `LANDING_MARGIN` of face, and the clearance is charged to the
 * landing's end, which is the end it actually eats. A lock too small to seat
 * both is what `noLock` reports.
 *
 * Zero for a recoil anchor, which has no dead face to land on and is not
 * supposed to have one — its tooth lands on the impulse face and drives the
 * wheel back, which is the whole of what a recoil escapement does.
 */
function dropLock(spec: EscapementSpec): number {
  if (spec.escType !== 'deadbeat') return 0
  const { rho } = frame(spec)
  const want = LANDING_MARGIN / rho
  const room = rad(Math.max(0, spec.lock)) - LANDING_MARGIN / rho
  return Math.max(0, Math.min(want, room))
}

/**
 * The tooth tip's path in the anchor's own frame — the pallet face.
 *
 * `t` runs −0.5 → +0.5 across the impulse: the wheel turns −μ·t (it always runs
 * the same way) and the anchor ±λ·t, the sign being whichever WITHDRAWS that
 * pallet from the wheel. Entry retreats clockwise and exit anticlockwise, which
 * is the whole reason the thing oscillates, and it falls out of the geometry
 * rather than being asserted: the pallets sit either side of the arbor, so one
 * rises as the other dips.
 *
 * `freezeWheel` holds the wheel at the start of impulse, which turns the same
 * expression into the deadbeat's concentric lock.
 *
 * The extra half drop lock is a CONSTANT in `t`, so it is a rigid turn of the
 * whole face about the arbor — lock arc and impulse face together, in the
 * direction that buries this pallet deeper. Both pallets get it, in opposite
 * senses, which is what widens the embrace without moving the anchor's neutral.
 */
function locus(
  spec: EscapementSpec, side: Side, t: number, freezeWheel: boolean,
): Pt {
  const { R, beta, L, mu, lam } = frame(spec)
  const sgn = side === 'entry' ? -1 : 1
  const anchorDir = side === 'entry' ? -1 : 1
  const P0: Pt = [sgn * R * Math.sin(beta / 2), R * Math.cos(beta / 2)]
  const T = rot(P0, -mu * (freezeWheel ? -0.5 : t))
  const V: Pt = [T[0], T[1] - L]                 // anchor-local, anchor at neutral
  return rot(V, -anchorDir * (lam * t + dropLock(spec) / 2))
}

/**
 * One point of the deadbeat's dead arc, at anchor depth `a` past the start of
 * impulse. Its own function because the LOCKING FACE and the run-out past it
 * are one curve — see `faceBeyond` — and two copies of this law would drift.
 *
 * `draw` leans the arc off concentric so the drive tightens the lock instead of
 * picking it. WHICH WAY IT LEANS IS PER PALLET, and taking it as "shrink the
 * radius" for both is the one mistake here that looks right on the drawing. The
 * two pallets keep their stock on OPPOSITE sides of their faces — the entry's
 * lies towards the arbor, the exit's away from it — so the same radial lean
 * buries one face in its own material (a lock that tightens) and drives the
 * other out through its face into the tooth (a lock that trips, and that shows
 * up as the exit tooth embedded in the pallet while the entry stands off by the
 * same amount). Lean it towards the STOCK on each, which is what `anchorDir`
 * says here, and both draw.
 *
 * The test of it is not the outline but the wheel: with the lock deepening, a
 * drawing face lets the wheel creep FORWARD to stay in touch — the drive is
 * doing the work of pulling the pallet in, which is what draw means. Push the
 * wheel back instead and the drive is resisting, which is a repel.
 */
function deadArc(spec: EscapementSpec, side: Side, B: Pt, a: number): Pt {
  const anchorDir = side === 'entry' ? -1 : 1
  const drawT = Math.tan(rad(clamp(spec.draw, 0, 15)))
  const p = rot(B, anchorDir * a)
  const k = clamp(1 + anchorDir * a * drawT, 0.5, 1.5)
  return [p[0] * k, p[1] * k]
}

/**
 * One pallet's acting profile, ordered from the deep-lock end to release.
 *
 * The lock end lies INSIDE the tip circle — that is what stops the tooth — and
 * the release end outside it, where the tooth gets away. Both come out of the
 * same locus; only what happens before impulse differs between the two
 * escapements.
 *
 * ACTING is the word: it ends where the tooth's reach ends. The pallet carries
 * on past both ends — a tip land at one, the run-out into the arm at the other
 * — and neither belongs here, because `faceWidth` and the mesh check's "is this
 * contact on an acting face?" both read this and would quietly count them.
 */
function actingProfile(spec: EscapementSpec, side: Side): Pt[] {
  const { lam } = frame(spec)
  const out: Pt[] = []

  if (spec.escType === 'deadbeat') {
    // Dead lock: the wheel is held, so the locus degenerates to an arc about the
    // arbor — see `deadArc`, which is that arc and its lean.
    const B = locus(spec, side, -0.5, true)
    const lock = rad(Math.max(0, spec.lock))
    // The arc runs from the deep end down to the start of impulse and STOPS
    // there. Running it on past that point is the tempting way to give a
    // late-landing tooth somewhere dead to arrive — and it does nothing: past
    // that point is the impulse face's own ground, so the extension doubles
    // back over it, the boolean drops the resulting zero-width spur, and the
    // pallet comes out with the same bare corner it had before. Where the tooth
    // lands is fixed by the EMBRACE instead; see `dropLock`.
    //
    // So it stops one step short of a = 0, because that point IS the start of
    // impulse and the shared loop below opens with it. Emitting it here as well
    // would leave a duplicated vertex in the middle of the acting face.
    const steps = 20
    for (let i = steps - 1; i >= 1; i--) out.push(deadArc(spec, side, B, (lock * i) / (steps - 1)))
  } else {
    // Recoil: nothing is held, so the same locus simply continues. Every degree
    // of supplementary swing drives the wheel back the way it came.
    const steps = 24
    const t0 = -0.5 - rad(Math.max(0, spec.recoilArc)) / lam
    for (let i = 0; i < steps; i++) out.push(locus(spec, side, t0 + ((-0.5 - t0) * i) / steps, false))
  }

  const steps = 32
  for (let i = 0; i <= steps; i++) out.push(locus(spec, side, -0.5 + i / steps, false))

  return out
}

/**
 * The pallet nib: the acting face, given substance.
 *
 * A pallet is a BLADE standing in the path of the teeth. It has to be — its face
 * is where a tooth tip comes to rest — and that fixes both of its dimensions
 * from the wheel rather than from taste:
 *
 *   ACROSS the wheel it spans what the face spans, which is the lock and the
 *   impulse and nothing else. The face is RADIAL to the wheel (that is what the
 *   tangency gives), so the tooth slides along it in and out: on the entry it
 *   slides inwards and drops off the inner corner, on the exit outwards.
 *
 *   AROUND the wheel it is `depth` thick, and that thickness has to pass through
 *   a tooth SPACE. Make it as thick as the arm and it is most of a tooth pitch:
 *   it fouls the tooth ahead of the one it is working with and the escapement
 *   jams solid. This is the one dimension that looks arbitrary and is not — see
 *   `nibDepth`.
 *
 * Which side of the face the stock lies on is decided by the tooth. At the
 * pallet the tooth's velocity runs exactly along the arm (AP ⟂ OP), so it pushes
 * the entry pallet TOWARDS the arbor and the exit pallet AWAY from it: the entry
 * nib is the end of its arm, and the exit nib hangs off the far side of its own.
 *
 * THE PALLET IS PART OF THE ARM, not a blade let into it. It is drawn as a wedge
 * whose front is the acting face and whose back is a single relieved line, run
 * OUTWARDS far enough to bury itself in the arm and then cut off flush with the
 * arm's outer edge. Nothing of it is left standing outside the arm's silhouette,
 * so wheel and anchor come off the saw as two pieces of wood rather than four.
 * (Extending the face's ends by a fixed reach instead leaves a spur poking out
 * past the arm and a step where the wedge crosses it — geometry that says
 * "mortise" to anyone reading the drawing, and means nothing to the escapement.)
 */
function nibFrame(spec: EscapementSpec, side: Side, depth: number) {
  const { R, beta, L } = frame(spec)
  const sgn = side === 'entry' ? -1 : 1
  const P: Pt = [sgn * R * Math.sin(beta / 2), R * Math.cos(beta / 2) - L]
  const u = norm(P)
  const m: Pt = side === 'entry' ? [-u[0], -u[1]] : u        // the stock's side of the face
  const O: Pt = [0, -L]

  const face = actingProfile(spec, side)
  const distO = (p: Pt) => Math.hypot(p[0] - O[0], p[1] - O[1])
  // Which end is the outer one is a fact about the pallet, so ask rather than
  // encode a guess — it is the opposite way round on the two sides.
  const outerFirst = distO(face[0]) > distO(face[face.length - 1])
  const inner = outerFirst ? face[face.length - 1] : face[0]
  const outer = outerFirst ? face[0] : face[face.length - 1]
  const away = norm([outer[0] - O[0], outer[1] - O[1]])       // radially out of the wheel
  const line = outerFirst ? face.slice().reverse() : face.slice()   // inner → outer

  // The BACK of the pallet is relieved — it leans outwards, away from the wheel,
  // as it runs back from the face. It has to: the back sits a pallet's thickness
  // around the wheel from the face, which is where the NEXT tooth is coming, and
  // a back cut square catches it and stops the escapement dead. Nothing in the
  // outline shows that; the mesh check is what finds it.
  const th = rad(clamp(BACK_RELIEF, 0, 85))
  const rel: Pt = norm([
    Math.cos(th) * m[0] + Math.sin(th) * away[0],
    Math.cos(th) * m[1] + Math.sin(th) * away[1],
  ])
  // THE PALLET ENDS AT THE RELEASE CORNER. There is no tip land: the relieved
  // back starts at `inner` itself and runs straight back into the arm, so the
  // blade comes to a point at the one end a tooth has to get past.
  //
  // It used to carry a square land a whole `nibDepth` thick there, and the land
  // was where the blade was widest around the wheel at exactly the point it has
  // least room — the release corner sits deepest inside the tooth space, and the
  // land added its thickness on the side the NEXT tooth is arriving from. That
  // is a pallet that fits the space on paper and fouls it in wood, where the
  // teeth are never quite where the drawing says. Ending at the corner instead
  // costs nothing: nothing acts on the land (the tooth leaves by the corner) and
  // the blade is still `depth`-worth of wedge by the time it reaches the arm.
  const far = 2 * (ARM_CLEAR + Math.max(1, spec.armWidth)) + depth
  // THE WEDGE'S LEADING EDGE CARRIES ON ALONG THE FACE, and this is the
  // direction it leaves in: the acting face's own, taken from its last step.
  //
  // Not the wheel's radial, which is what it used to be. The two are the same
  // only at the tangency point the whole construction is built on, and the deep
  // lock is a lock's worth of arc past that — 6° of it by the far end of the
  // entry pallet. Leaving along the radial breaks off the face by that 6° at
  // exactly the point the face ends, and the drawing shows the pallet swinging
  // away from the arbor there for no reason a reader can see. Along the face
  // there is no break at all: face and run-out are one straight run to the top
  // of the arm, which is also how a pallet's locking face is actually cut.
  //
  // Straight, rather than the locking arc genuinely continued, because both
  // ends of this edge get filleted — the deep-lock corner to the cutter's radius
  // and the arm's toe to its own — and a fillet needs millimetres of clean run
  // to sit on. Sampled as an arc it has none, and both fillets silently do
  // nothing (which is what `leaves no sharp node at either corner it rounds`
  // caught). Over the 5 mm to the arm the arc leaves its tangent by 0.29 mm, on
  // a face that is itself straight to four microns over its own length.
  const lead = norm([line[line.length - 1][0] - line[line.length - 2][0],
                     line[line.length - 1][1] - line[line.length - 2][1]])
  return { m, away, lead, rel, inner, outer, line, far }
}

/** The nib as a ring: the acting face in front, the relieved back behind, both
 *  run out far enough to bury themselves in the arm and cut off flush with the
 *  arm's outer edge — so the wedge disappears into the arm rather than sprouting
 *  out of the far side of it.
 *
 *  A TRIANGLE, not a quadrilateral: the two edges MEET at the release end, which
 *  is the whole of the tip land's removal. The ring closes from the last point
 *  back to `line[0]`, which is that corner. */
function palletNib(spec: EscapementSpec, side: Side, depth: number): Pt[][] {
  const { lead, rel, outer, inner, line, far } = nibFrame(spec, side, depth)
  const ring: Pt[] = [
    ...line,                                             // the acting face
    [outer[0] + far * lead[0], outer[1] + far * lead[1]], // on along it, past the arm
    [inner[0] + far * rel[0], inner[1] + far * rel[1]],  // and back down the relief
  ]
  return boolRings('difference', [ring], [beyondArm(spec, side)])
}



/**
 * One arm's flank, as a line in the anchor's frame. `n` is the offset in the
 * arm's own frame, so the arm runs from `ARM_CLEAR` (the flank facing the wheel)
 * to `ARM_CLEAR + width` (its outer edge). `p` is a point on that line, `dir` the
 * unit direction along it pointing AWAY from the arbor, and `out` the unit normal
 * across the arm, from the wheel-side flank towards the outer edge.
 *
 * One definition, because two things have to agree with where the arm actually
 * is: the wedge's stop (`beyondArm`, the outer edge) and the corner the exit
 * pallet's face makes with the arm (`lockCorner`, the wheel-side flank).
 */
function armFlank(spec: EscapementSpec, side: Side, n: number): { p: Pt; dir: Pt; out: Pt } {
  const { R, beta, L } = frame(spec)
  const sgn = side === 'entry' ? -1 : 1
  const dir = side === 'entry' ? -1 : 1
  const P: Pt = [sgn * R * Math.sin(beta / 2), R * Math.cos(beta / 2) - L]
  const u = norm(P)
  const across = norm([sgn * R * Math.sin(beta / 2), R * Math.cos(beta / 2)])
  const sw = dir * halfSwing(spec)
  return { p: rot([across[0] * n, across[1] * n], sw), dir: rot(u, sw), out: rot(across, sw) }
}

/**
 * Everything past a line square across one arm, `reach` from the arbor — the
 * RECOIL entry blade's second stop.
 *
 * `beyondArm` catches the run-out along `lead` at the arm's outer EDGE, which is
 * a line running the length of the arm. That works on a deadbeat, whose dead arc
 * is concentric with the arbor so its tangent crosses that edge almost at once —
 * a fifth of a millimetre past the acting face. A RECOIL has no dead arc: the
 * locus is still climbing at the deep end, the run-out points nearly straight out
 * along the arm, and it is 9.45 mm past the face before the edge catches it.
 * Rounding that off (`RECOIL_TOE`) takes the point away but not the length.
 *
 * So this cuts it square instead, across the arm rather than along it, and the
 * toe fillet then rounds what is left. What must NOT be done is to shorten the
 * run-out itself: the blade would stop before it reached the arm at all, its end
 * face would cross the arm's TOE, and a deadbeat would come out with a jog in the
 * silhouette where a rounded toe used to be. Tried; it broke the profile that was
 * already right.
 */
function beyondTip(spec: EscapementSpec, side: Side, reach: number): Pt[] {
  const { R, L } = frame(spec)
  const { p, dir, out } = armFlank(spec, side, ARM_CLEAR)
  const big = 4 * (L + R)
  return ([[0, -big], [big, -big], [big, big], [0, big]] as Pt[])
    .map(([u, v]) => [
      p[0] + dir[0] * (reach + u) + out[0] * v,
      p[1] + dir[1] * (reach + u) + out[1] * v,
    ] as Pt)
}

/**
 * How far from the arbor a RECOIL's entry blade may reach — its acting face's own
 * far end, plus a land. Infinite on a deadbeat, which needs none of this.
 */
function recoilTipReach(spec: EscapementSpec): number {
  if (spec.escType !== 'recoil') return Infinity
  const face = actingProfile(spec, 'entry')
  return Math.max(...face.map((q) => Math.hypot(q[0], q[1]))) + RECOIL_TIP_LAND
}

/** Everything past the outer edge of one arm — the wedge's stop. */
function beyondArm(spec: EscapementSpec, side: Side): Pt[] {
  const { R, L } = frame(spec)
  const { p, dir, out } = armFlank(spec, side, ARM_CLEAR + Math.max(1, spec.armWidth))
  const big = 4 * (L + R)
  // The half plane beyond the edge, as a box far larger than the anchor.
  return ([[-big, 0], [big, 0], [big, big], [-big, big]] as Pt[])
    .map(([s, t]) => [p[0] + dir[0] * s + out[0] * t, p[1] + dir[1] * s + out[1] * t] as Pt)
}

/**
 * Where the exit pallet's face runs into its own arm — the corner that has to be
 * moved — and how far the arm's wheel-side flank must be SET BACK to move it.
 *
 * The two pallets end differently, and that is the whole of this. The entry nib
 * is the end of its own arm, so its deep-lock end stands in open air. The exit
 * nib hangs off the SIDE of its arm, and at the lock the face is RADIAL to the
 * wheel while the arm lies along the tangent (AP ⟂ OP), so the arm's flank
 * crosses the face's own line barely two tenths past the end of the face.
 *
 * That is an inside corner, and no cutter cuts an inside corner: a 1/8" bit
 * leaves 1.6 mm of radius in it whatever the drawing says. Which would not
 * matter, except for WHERE it is — the whole locking face is barely 1.3 mm, and
 * a tooth lands part way down it, so the radius lands on working face and the
 * tooth rides a lump instead of the curve the escapement was drawn from.
 *
 * So move the corner AWAY FROM THE WHEEL, by taking the flank back, until the
 * corner stands a whole fillet clear of the end of the face. Then the fillet has
 * room and the landing keeps every millimetre. The set-back is a TAPER — nothing
 * at the hub, everything at the pallet — which is where an arm can spare it: the
 * bending it carries is largest at the hub, and this is the far end.
 *
 * What must NOT be done instead is to cut the relief out of the corner itself.
 * That is the obvious move and it is a gouge: it takes its bite out of the arm
 * right behind the landing, exactly where the pallet needs to be solid.
 */
/**
 * How far the ENTRY arm's wheel-side flank is set back at the pallet end.
 *
 * The exit arm needs no such thing and already has one: `lockCorner` takes its
 * flank back to get an inside corner off the acting face, and that set-back
 * incidentally leaves it 3.5 mm clear of the teeth. The entry arm has nothing,
 * and it is the arm that runs closest to the wheel — measured over a full period
 * it skims the tips by 0.44 mm on a deadbeat and TOUCHES on a recoil, whose
 * pallet is the longer blade and whose arm therefore reaches further in.
 * `escapement-check` cannot see it: grazing is not interference, so it reports
 * both as clear. `scripts/esc-arm-clearance.mts` is the harness that can.
 *
 * A TAPER, not a wider `ARM_CLEAR`: the clearance is wanted at the pallet end
 * and nowhere else, and that is the end an arm can spare — the bending it carries
 * is largest at the hub. Same shape of answer as `lockCorner`'s, for the same
 * reason, which is why `palletArm` already takes it.
 *
 * It moves NOTHING that acts. The pallet nib is its own ring, unioned on
 * afterwards and cut off only at the arm's OUTER edge (`beyondArm`), so neither
 * face moves and neither does the tip land. What does move is `backCorner`, which
 * is where the nib's relieved back runs into this flank — it reads the taper, or
 * it would round a corner that is no longer there and silently do nothing.
 */
function entryTaper(spec: EscapementSpec): number {
  return Math.min(Math.max(1, spec.armWidth) / 2, Math.max(0, ENTRY_CLEAR - ARM_CLEAR))
}

function lockCorner(spec: EscapementSpec, side: Side): { taper: number; at: Pt } | null {
  if (side !== 'exit') return null
  const r = LOCK_RELIEF_BIT_DIA / 2
  const w = Math.max(1, spec.armWidth)
  const reach = armReach(spec, side, w)
  const A = actingProfile(spec, side)[0]                  // the deep-lock end
  // The line the corner slides along is the nib's OWN leading edge, which is the
  // acting face continued (`faceBeyond`) — taken as its tangent here, since the
  // corner sits a couple of millimetres along it and the arc leaves the tangent
  // by four hundredths in that distance.
  const t = nibFrame(spec, side, nibDepth(spec)).lead
  const { p, dir, out } = armFlank(spec, side, ARM_CLEAR)

  // Where the face's line crosses the flank, as a function of the set-back —
  // linear in it, so two evaluations solve it exactly.
  const cross = (taper: number): number | null => {
    const near: Pt = [p[0] - dir[0] * w / 2, p[1] - dir[1] * w / 2]
    const far: Pt = [
      p[0] + dir[0] * (reach + w / 2) + out[0] * taper,
      p[1] + dir[1] * (reach + w / 2) + out[1] * taper,
    ]
    const e = norm([far[0] - near[0], far[1] - near[1]])
    const den = t[0] * e[1] - t[1] * e[0]
    if (Math.abs(den) < 1e-6) return null
    return ((near[0] - A[0]) * e[1] - (near[1] - A[1]) * e[0]) / den
  }

  const s0 = cross(0), s1 = cross(1)
  if (s0 === null || s1 === null || Math.abs(s1 - s0) < 1e-6) return null
  // The corner has to clear the end of the face by the fillet's own set-back,
  // plus a hair so the fillet's near end lands past it rather than on it.
  const want = r + LOCK_LAND
  const taper = Math.max(0, Math.min(w / 2, (want - s0) / (s1 - s0)))
  const s = cross(taper)
  if (s === null) return null
  return { taper, at: [A[0] + t[0] * s, A[1] + t[1] * s] }
}

/**
 * Where the pallet's relieved BACK runs into its own arm — the other inside
 * corner, on the entry pallet, and the other one no cutter can cut sharp.
 *
 * It needs nothing like the trouble the deep-lock corner does. Nothing acts on
 * the back of a pallet, and the corner has a whole arm along one side of it and
 * most of the relief along the other, so there is room for the fillet exactly
 * where it stands: no point has to move, only the corner has to be rounded to
 * the bit that will cut it. `filletToes` does that.
 *
 * Null when the back does not reach that flank at all, which is the exit pallet:
 * its stock lies on the far side of its arm, so its back runs out through the
 * OUTER edge and is cut off there by `beyondArm` instead.
 */
function backCorner(spec: EscapementSpec, side: Side): Pt | null {
  const w = Math.max(1, spec.armWidth)
  const { inner, rel, far } = nibFrame(spec, side, nibDepth(spec))
  // The TAPERED flank, not the nominal one: the entry arm's is set back at the
  // pallet end (`entryTaper`) and this corner is at the pallet end. Read the
  // nominal line here and the corner lands off the outline, where `filletToes`
  // matches by coordinate and so rounds nothing at all — silently.
  const [hub, tip] = __escArmFlank(spec, side)
  const p = hub
  const dir = norm([tip[0] - hub[0], tip[1] - hub[1]])
  const den = rel[0] * dir[1] - rel[1] * dir[0]
  if (Math.abs(den) < 1e-6) return null
  const s = ((p[0] - inner[0]) * dir[1] - (p[1] - inner[1]) * dir[0]) / den
  if (!(s > 0.05 && s < far)) return null
  const at: Pt = [inner[0] + rel[0] * s, inner[1] + rel[1] * s]
  // Two infinite lines always cross. It is only a corner of the anchor if the
  // crossing lands on the arm that is actually there — which on the exit side it
  // does not: that one is out past the end of its own arm. Measured from the HUB
  // end of the flank, which is where `palletArm` starts its bar, so the window is
  // the bar's own length; taking it from `armFlank`'s own origin instead is half
  // an arm width out, and half an arm width is the difference between finding
  // this corner and returning null.
  const along = (at[0] - p[0]) * dir[0] + (at[1] - p[1]) * dir[1]
  return along > 0 && along < armReach(spec, side, w) + w ? at : null
}

/** How thick a pallet may be around the wheel — a fraction of the tooth pitch at
 *  the tip circle, so it always has a tooth space to stand in. */
function nibDepth(spec: EscapementSpec): number {
  const { R, pitch } = frame(spec)
  return Math.min(Math.max(1, spec.armWidth), NIB_SPACE * pitch * R)
}

/** Half the swing the faces are drawn for — the anchor never goes outside it,
 *  and everything that must stay clear of the wheel is set back by it.
 *
 *  The drop lock comes OUT of it: a tooth lands D deep and only the rest of the
 *  lock is left for the supplementary arc to run through, so the anchor reaches
 *  the deep end of the dead face half a drop lock sooner than it used to. */
function halfSwing(spec: EscapementSpec): number {
  const { lam } = frame(spec)
  return lam / 2 - dropLock(spec) / 2
    + rad(Math.max(0, spec.escType === 'deadbeat' ? spec.lock : spec.recoilArc))
}

/** How far each arm reaches from the arbor. The entry arm stops at the pallet
 *  circle and its nib is the last of it; the exit arm has to reach PAST that
 *  circle, because its nib's stock lies on the far side of the face — which is
 *  where the tooth pushes it. Each stops short of the face by its own cap
 *  radius, so no arm end can stand in front of a pallet. */
function armReach(spec: EscapementSpec, side: Side, width: number): number {
  const { rho } = frame(spec)
  return side === 'entry' ? rho - nibDepth(spec) - width / 2 : rho + nibDepth(spec) - width / 2
}

/**
 * An arm from the arbor out to `reach`, along its tangent line but ROTATED off
 * it by the half swing.
 *
 * A constant offset is not enough, and the reason is the whole shape of an
 * anchor's arms: it rocks about the arbor, so a point d from it crosses the
 * tangent by d·φ, and the far end of an arm is exactly where that is largest.
 * Setting the arm back by the swing itself puts it ON the tangent at the extreme
 * of the swing and outside it everywhere else, so the clearance scales with the
 * arm instead of being a number someone guessed. Only the pallets go inside,
 * which is what pallets are for.
 *
 * `taper` takes the WHEEL-SIDE flank back at the far end, nothing at the hub —
 * the set-back that moves the exit pallet's deep-lock corner out of the way of
 * its own fillet. See `lockCorner`.
 *
 * The arms are STRAIGHT, and bowing them is a change that has been tried and
 * rejected. It is tempting — a straight bar is the weakest arm that fits between
 * the two things that fix its ends, and swelling it through the middle would
 * both strengthen it and hand the wheel some clearance back. It does not look
 * like an anchor afterwards. There is also a mechanical cost to know about
 * before trying again: `beyondArm`, `lockCorner` and `backCorner` all read this
 * arm as a straight LINE, and all three work at the pallet end, so a bow that
 * reaches them puts the wedge's flush cut off the edge it is flush with and the
 * two inside corners off the outline their fillets are meant to round.
 */
function palletArm(spec: EscapementSpec, side: Side, reach: number, width: number, taper = 0): Pt[] {
  const { R, beta, L } = frame(spec)
  const sgn = side === 'entry' ? -1 : 1
  const dir = side === 'entry' ? -1 : 1
  const P: Pt = [sgn * R * Math.sin(beta / 2), R * Math.cos(beta / 2) - L]
  const u = norm(P)
  // The wheel lies on the far side of the tangent line from `n`: it is the
  // outward radius of the tip circle at the contact point.
  const n = norm([sgn * R * Math.sin(beta / 2), R * Math.cos(beta / 2)])
  const off = ARM_CLEAR + width / 2
  const a = Math.atan2(u[1], u[0])
  // WHICH LOCAL EDGE FACES THE WHEEL IS NOT THE SAME ON THE TWO ARMS, and it has
  // to be asked rather than assumed. The bar is laid out along `u` and rotated by
  // `a`, so local +y lands on the CCW perpendicular of `u` — which is `+n` on the
  // exit arm and `−n` on the entry one, the two contact points being either side
  // of the arbor. So local −y is the wheel side of the exit arm and the OUTER
  // side of the entry arm.
  //
  // The taper existed for `lockCorner`, which is exit-only, so it was written as
  // a flat `−width/2 + taper` and was right by luck. Handed to the entry arm that
  // sets its OUTER edge back: the pallet wedge is still cut flush at the real
  // outer edge (`beyondArm` works in `n`, not in local y, and is unaffected), so
  // a taper's worth of wedge is left standing outside the arm's silhouette as a
  // spur, with a notch behind it. It is visible in the outline and in nothing
  // else — the mesh does not care what happens on the far side of an arm.
  const ws = Math.sign(rot([0, 1], a)[0] * n[0] + rot([0, 1], a)[1] * n[1]) || 1
  const near = (-ws * width) / 2                       // the wheel-side edge
  const far = (ws * width) / 2                         // the outer edge
  // Square-ended, not a stadium: the pallet wedge is cut off flush with this
  // arm's OUTER edge, and a rounded end curves away from that line and leaves a
  // step sticking out of the silhouette. The corner it makes with the wedge is
  // rounded later, on the assembled anchor — see `anchorRings`.
  const bar: Pt[] = taper > 0
    ? [[-width / 2, near], [reach + width / 2, near + ws * taper],
       [reach + width / 2, far], [-width / 2, far]]
    : roundRectRing(-width / 2, -width / 2, reach + width, width, 0)
  return bar.map(([x, y]) => {
    const p = rot([x, y], a)
    return rot([p[0] + off * n[0], p[1] + off * n[1]], dir * halfSwing(spec))
  })
}

/**
 * The anchor, in its own frame: arbor at the origin, pallets hanging below.
 *
 * The arms clear the wheel BY CONSTRUCTION rather than by being cut back —
 * every one lies along a tangent to the tip circle, held off it by ARM_CLEAR,
 * so nothing but the two pallet faces ever reaches inside. That is what the
 * classic construction buys: put the arbor where the tangents cross and the
 * clearance comes free.
 *
 * The obvious-looking alternative — relieve the body by everything the tip
 * circle sweeps through — is wrong twice over. It is far too conservative (the
 * teeth are thin spikes; an anchor sits BETWEEN them, and no real one clears
 * the whole swept annulus) and it cuts the pallets off the arms it is supposed
 * to leave them on. What actually has to be checked is the anchor against the
 * teeth along the motion they really make together, which is what
 * `scripts/escapement-check.mts` does.
 */
function anchorRings(spec: EscapementSpec): Pt[][] {
  const { rho } = frame(spec)
  const w = Math.max(1, spec.armWidth)
  const hubR = Math.max(w * 0.75, spec.anchorBore / 2 + Math.max(1.5, w * 0.4))

  const body: Pt[][] = [ellipseRing(0, 0, hubR, hubR)]
  const add = (r: Pt[]) => { for (const p of boolRings('union', body.splice(0), [r])) body.push(p) }
  add(palletArm(spec, 'entry', armReach(spec, 'entry', w), w, entryTaper(spec)))
  add(palletArm(spec, 'exit', armReach(spec, 'exit', w), w, lockCorner(spec, 'exit')?.taper ?? 0))

  // Fillet the arm-to-hub junctions, and ONLY those: the nibs go on afterwards,
  // untouched. A closing of a couple of millimetres is nothing on an arm and
  // everything on a pallet — the whole acting face is a few millimetres long, so
  // filleting it rounds the locking corner away and turns a dead lock into a
  // recoiling one. It still LOOKS like a deadbeat escapement.
  let out: Pt[][] = roundConcave(body, Math.min(w * 0.35, rho * 0.05))
  const addTo = (r: Pt[]) => { for (const p of boolRings('union', out.splice(0), [r])) out.push(p) }
  for (const r of palletNib(spec, 'entry', nibDepth(spec))) addTo(r)
  for (const r of palletNib(spec, 'exit', nibDepth(spec))) addTo(r)

  // Square off a recoil's entry end — AFTER the nibs, so the blade and the arm
  // under it are cut to the same length. Cutting the arm first leaves the nib's
  // own run-out standing past it, which is most of what there was to remove.
  const cap = recoilTipReach(spec)
  if (Number.isFinite(cap)) out = boolRings('difference', out, [beyondTip(spec, 'entry', cap)])

  return out
}

/** Test hooks — one pallet's acting profile in anchor coordinates, and how many
 *  of its points are the LOCKING face rather than the impulse face. The mesh
 *  harness has to tell those apart: which one a tooth is riding is the whole
 *  difference between a deadbeat and a recoil. */
export function __escFaces(spec: EscapementSpec, side: Side): Pt[] { return actingProfile(spec, side) }
/** Test hooks — the two corners rounded to the cutter's radius: the one the
 *  exit pallet's face makes with its arm (with the set-back that put it where it
 *  is), and the one the entry pallet's back makes with its own. Each is null on
 *  the side that has no such corner. */
export function __escLockCorner(spec: EscapementSpec, side: Side): { taper: number; at: Pt } | null {
  return lockCorner(spec, side)
}
export function __escBackCorner(spec: EscapementSpec, side: Side): Pt | null { return backCorner(spec, side) }
/** Test hook — one arm's WHEEL-SIDE flank, hub end to pallet end, in anchor
 *  coordinates. The edge that runs closest to the teeth along its whole length,
 *  and the only part of an anchor that is neither an acting face nor set by the
 *  construction, so it is the one a clearance measurement can act on. */
export function __escArmFlank(spec: EscapementSpec, side: Side): [Pt, Pt] {
  const w = Math.max(1, spec.armWidth)
  const { p, dir, out } = armFlank(spec, side, ARM_CLEAR)
  const taper = side === 'exit' ? lockCorner(spec, 'exit')?.taper ?? 0 : entryTaper(spec)
  const reach = armReach(spec, side, w)
  return [
    [p[0] - dir[0] * w / 2, p[1] - dir[1] * w / 2],
    [p[0] + dir[0] * (reach + w / 2) + out[0] * taper, p[1] + dir[1] * (reach + w / 2) + out[1] * taper],
  ]
}
/** Test hook — the toothed ring BEFORE the root-fillet closing, so a test can
 *  tell a break in the profile from the resampling clipper does to the whole
 *  outline on its way through. */
export function __escToothRing(spec: EscapementSpec): Pt[] { return toothedRing(spec) }
export function __escLockPoints(spec: EscapementSpec): number { return spec.escType === 'deadbeat' ? 20 : 24 }
/** Test hook — the first stretch of the pallet's relieved BACK, from the release
 *  corner outwards. With no tip land between them, this edge starts AT the
 *  working corner, so it is what now stands closest to a tooth at release and
 *  the tooth must drop clear of it. Measuring that is the only way to see the
 *  relief doing its job: grazing is not interference, so the binding check
 *  cannot see it, and the outline just shows a thin wedge. */
export function __escBackEdge(spec: EscapementSpec, side: Side): [Pt, Pt] {
  const { inner, rel } = nibFrame(spec, side, nibDepth(spec))
  const k = 2 * nibDepth(spec)
  return [inner, [inner[0] + k * rel[0], inner[1] + k * rel[1]]]
}

// ─── The escape wheel ─────────────────────────────────────────────────────────

/**
 * The tooth geometry every tooth-side function starts from: the two radii, the
 * angular spans of the two edges, and where the pallet's reach ends.
 *
 * One definition, because `toothedRing`, `gulletFillet`, `toothSpace` and the
 * readouts all have to be talking about the same tooth — they each had their own
 * copy of this arithmetic, and the readouts' copy is the one that would have gone
 * stale.
 */
function toothGeom(spec: EscapementSpec) {
  const { R, pitch, rho } = frame(spec)
  const rRoot = Math.max(R * 0.25, R - Math.max(0.5, spec.toothDepth))
  // Cut short of the circle the pallets were laid out for. One number, applied
  // in one place, opening the same gap wherever the two meet — see `clearance`.
  // `|| 0` rather than a bare read: a project saved before these fields existed
  // has neither, and an undefined clearance does not draw a slightly wrong wheel
  // — it makes every coordinate NaN and the escapement silently stops rendering.
  // Same trap the gear's `cycOf` guards against.
  const rTip = R
  const depth = rTip - rRoot
  const backSpan = clamp(BACK_FRAC * pitch, 0.02, pitch * 0.9)
  // THE TIP LAND — the top of the leading face, cut almost RADIAL so the tooth
  // BEDS on the locking face instead of standing on a corner.
  //
  // Almost radial because the locking face IS radial. The construction puts the
  // arbor where the tangents to the tip circle cross, so at the contact point the
  // triangle centre–tip–arbor is right-angled AT THE TIP: the arbor radius and
  // the wheel radius are perpendicular there, and a face concentric with the
  // arbor is therefore radial to the wheel. That is what makes a deadbeat dead,
  // and it is the same answer for both pallets — no need to pick one. Without the
  // land the tooth meets that face at the full undercut and takes all the drive
  // through one line of end grain, which in a wooden wheel is how a tip goes
  // blunt.
  //
  // ALMOST, and the couple of degrees matter: a truly radial land FOULS THE
  // IMPULSE FACE. That face stands 53° off the locking face, so a land lying flat
  // on one is at 53° to the other and its inner corner ploughs into it — 0.061 mm
  // at the default, growing dead linearly with the land, which is the fingerprint.
  // `TIP_RELIEF` degrees of relief lifts that corner clear while opening the bed
  // by only its own length × the tangent, a few hundredths over the whole land.
  // Shortening the land instead works too and is the worse trade: it clears at
  // half the lock, which is half a bed.
  //
  // Sized from the LOCK, since that is how deep the pallet actually comes into
  // the tooth; a land shorter than that would bed on part of it only.
  const lock = rho * rad(Math.max(0, spec.escType === 'deadbeat' ? spec.lock : spec.recoilArc))
  const land = clamp(lock, 0.2, TIP_LAND_MAX * depth)
  const rLand = rTip - land
  // The land's own angular width at the root radius, so the leading face below it
  // simply carries on from where it ends.
  const uLand = (land * Math.tan(rad(TIP_RELIEF))) / rRoot
  // The undercut, as an angle at the root, taken over the face's OWN span below
  // the land. Increasing angle is BEHIND the tooth — the wheel runs clockwise —
  // so both of a tooth's edges run back from the tip: the leading face to a0+u
  // and the back to a0+backSpan. The tooth is the sliver between them, and the
  // tip still OVERHANGS the space in front of it, because nothing reaches in
  // front of the land.
  //
  // Put the undercut's foot in front of the tip instead and the tooth's root
  // projects forward into exactly the space the pallet's impulse face has to
  // occupy at the lock, and the escapement binds harder the more undercut it is
  // asked for — which is the tell.
  const u = clamp(uLand, 0, backSpan * 0.7)
  // The root land, as an angle: what is left of the pitch once the back slope is
  // taken out and the undercut given back.
  const landAng = pitch - backSpan + u
  // How far a flank may bow, as an ANGLE at the root. Angular, not perpendicular
  // to the flank, so a bowed foot stays ON the root circle and the land between
  // two teeth simply runs between the feet it is given. Displace the foot off
  // that circle instead and the land still starts where the foot used to be,
  // which leaves a step in the outline at every tooth.
  //
  // Both flanks of a gap eat the same land, so each is held to a share of it.
  const bowAng = TOOTH_BOW * BOW_SHARE * landAng
  // WHERE THE TOOTH'S OWN GROUND BEGINS, as a fraction of the tooth depth below
  // the tip. A pallet dives ρ·Φ past the tip circle at the end of its swing, so
  // above that depth nothing may be added — stock there goes straight into the
  // pallet's way, and it is the recoil (whose pallet is the longer blade) that
  // finds it first. Below it the space is the tooth's own, and that is where the
  // strength is wanted. Both the flank bow and the gullet fill are held to it.
  const start = clamp((rho * halfSwing(spec)) / Math.max(0.5, depth) + BOW_KEEP, 0, 0.92)
  return { rRoot, rTip, rLand, depth, backSpan, u, uLand, landAng, bowAng, start }
}

/**
 * The angle of one bowed edge, `s` of the way along it. The law, on its own,
 * because `flank` draws with it and `toothSpace` measures with it, and the two
 * disagreeing would size the gullet against a tooth that is not there.
 *
 * The bow grows as the SQUARE of the depth below `start`, which is the whole
 * trick: at that depth it is zero and so is its slope, so the flank leaves the
 * pallet's region on exactly the line it would have taken and only fattens
 * further down. `dir` is which way is out of the tooth, and the foot angles
 * handed in already include the bow, so the curve lands on them.
 */
function flankAngle(
  a0: number, a1: number, s: number, dir: number,
  bowAng: number, start: number, tipFirst: boolean,
): number {
  const t = tipFirst ? s : 1 - s               // depth below the tip, 0…1
  const g = Math.max(0, (t - start) / Math.max(1e-6, 1 - start))
  return a0 + (a1 - a0) * s + dir * bowAng * (g * g - t)
}

/**
 * How wide the tooth SPACE is, in mm, at depth fraction `at` below the tip
 * circle — one tooth's back on one side and the next tooth's leading face on the
 * other, measured on the arc at that radius.
 *
 * This is what sizes the gullet fill, so it reads the two edges through
 * `flankAngle` rather than approximating them: a linearised back is a tenth of a
 * millimetre out where it matters, which is a tenth of a millimetre of fill
 * standing in the pallet's way.
 */
function toothSpace(spec: EscapementSpec, at: number): number {
  const { pitch } = frame(spec)
  const g = toothGeom(spec)
  const r = g.rTip - g.depth * at
  return (pitch + faceAngle(g, at) - backAngle(g, at)) * r
}

type Tooth = ReturnType<typeof toothGeom>

/** This tooth's back, at depth fraction `at` — from its own tip (0) to its foot
 *  (1), as an angle off the tip. */
function backAngle(g: Tooth, at: number): number {
  return flankAngle(0, g.backSpan + g.bowAng, clamp(at, 0, 1), 1, g.bowAng, g.start, true)
}

/** The leading face, at depth fraction `at` — as an angle off its OWN tip. Below
 *  the land it is the undercut face; at and above the land the tooth is radial,
 *  so this stops moving and stays at 0. */
function faceAngle(g: Tooth, at: number): number {
  const landAt = (g.rTip - g.rLand) / Math.max(1e-6, g.depth)
  if (at <= landAt) return (g.uLand * at) / Math.max(1e-6, landAt)   // the tip land
  const s = clamp((1 - at) / Math.max(1e-6, 1 - landAt), 0, 1)
  return flankAngle(g.u - g.bowAng, g.uLand, s, -1, g.bowAng, g.start, false)
}

/**
 * The GULLET — the round that fills the bottom of each tooth space, and the one
 * dimension of a wooden escape wheel that decides whether a tooth snaps off.
 *
 * It used to be a flat `ROOT_FILLET` of 0.6 mm, which was the cutter's radius and
 * nothing else: it left the one place a tooth actually breaks — its root, across
 * the grain — as sharp as the drawing, with a deep narrow slot behind it.
 *
 * **The pallet never reaches the gullet.** It dives ρ·Φ past the tip circle, and
 * everything below that is the tooth's own ground. So this is not a fillet in a
 * corner any more: at the radius that room allows, the closing that draws it
 * stops rounding the two corners and starts BRIDGING the space, filling it from
 * the bottom up — which is the whole point, material at the base of the tooth,
 * where nothing has to pass.
 *
 * WHICH MAKES IT A QUESTION ABOUT REACH, not about a width and not about a corner
 * radius. A closing by f is a disc of radius f rolled through the space, filling
 * everything it cannot reach — so a point of a wall SURVIVES if some f-disc can
 * still touch it, and is buried otherwise. The rule is then exactly one line: the
 * largest f that buries nothing above the pallet's floor. That is the closing's
 * own definition, run forwards, and it is monotone in f, so it bisects.
 *
 * Three sizings that look right and are not, all found by measuring the emitted
 * outline (`scripts/esc-gullet-sweep.mts`) rather than by reading:
 *
 *   HALF THE SPACE'S WIDTH at the floor is wrong by a third of a millimetre to a
 *   whole one, always in the direction that puts stock in the pallet's way. The
 *   width is measured along the ARC and the two walls are nothing like equally
 *   steep — between a near-radial leading face and a back at 40°, the arc gap is
 *   far wider than any disc that fits between them.
 *
 *   THE LARGEST DISC THAT FITS BELOW THE FLOOR is wrong the other way, and gives
 *   up half the fillet. A disc bigger than that does not overshoot: it cannot get
 *   down there at all, so it jams higher and fills MORE, which is the mechanism.
 *   Fitting below the floor is not the constraint.
 *
 *   THE DEEPEST DISC THAT JAMS BETWEEN THE WALLS misses the case that matters. A
 *   disc resting on the root circle with slack to both walls is jammed by nothing
 *   and passes any test written about its tangencies, while being far too big —
 *   it fills the whole gullet up to the tips. Reach has to be asked of every
 *   point, not of one disc.
 *
 * Floored at `ROOT_FILLET`, which is not a design choice: a cutter leaves that
 * much whatever is drawn. That floor is what a wheel whose pallet dives too deep
 * to fit falls back to — `divesTooDeep` is the honest report of that, not this.
 */
function gulletFillet(spec: EscapementSpec): number {
  const { pitch } = frame(spec)
  const g = toothGeom(spec)
  const rFloor = g.rTip - g.depth * Math.min(0.98, g.start + GULLET_KEEP)
  if (!(rFloor > g.rRoot + 0.05)) return ROOT_FILLET

  // The two walls of one gullet: this tooth's back running down from its tip at
  // angle 0, and the next tooth's leading face running up to its own tip at angle
  // `pitch`. Sampled over the whole depth, so a disc sitting high in the space
  // still sees the wall above it.
  const WALL = 40
  const sample = (off: number, ang: (at: number) => number): Pt[] => {
    const out: Pt[] = []
    for (let i = 0; i <= WALL; i++) {
      const at = i / WALL
      const r = g.rTip - g.depth * at
      const a = off + ang(at)
      out.push([r * Math.cos(a), r * Math.sin(a)])
    }
    return out
  }
  const near = sample(0, (at) => backAngle(g, at))
  const far = sample(pitch, (at) => faceAngle(g, at))
  const toWall = (p: Pt, w: Pt[]) => {
    let best = Infinity
    for (let i = 1; i < w.length; i++) {
      const a = w[i - 1], b = w[i]
      const dx = b[0] - a[0], dy = b[1] - a[1]
      const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1)
      best = Math.min(best, Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]))
    }
    return best
  }
  // How big a disc fits with its centre here: clear of both walls, and never
  // below the root circle.
  const room = (p: Pt) => Math.min(toWall(p, near), toWall(p, far), Math.hypot(p[0], p[1]) - g.rRoot)

  // Can a disc of radius f descend until it TOUCHES THE ROOT CIRCLE, clearing
  // both walls on the way? Its centre is then at rRoot + f by definition, so
  // there is only the angle to search.
  //
  // THIS IS WHAT KEEPS `toothDepth` HONEST, and it is the constraint the first
  // version of this was missing. Sizing the fill by "the largest disc that buries
  // nothing above the pallet's floor" bounds the TOP of the fill and says nothing
  // about its bottom — and a big disc cannot descend into a deep narrow gullet at
  // all, so it jams high and everything under it becomes solid. Deepening the
  // tooth makes the gullet deeper AND narrower, which lets a bigger disc jam
  // higher still, so past about 10 mm the floor rose faster than the root fell
  // and asking for a deeper tooth gave a SHALLOWER one: 24 mm of tooth depth
  // emitted a 1.26 mm tooth, and the wheel came out very nearly a circle.
  //
  // Tangency to the root circle fixes the floor at rRoot at every depth, so the
  // tooth is as tall as it was asked to be and the fill is only ever as fat as
  // the space at the bottom allows.
  const touchesRoot = (f: number): boolean => {
    const rc = g.rRoot + f
    const STEPS = 72
    for (let j = 0; j <= STEPS; j++) {
      const a = g.backSpan + ((pitch - g.backSpan) * j) / STEPS
      const p: Pt = [rc * Math.cos(a), rc * Math.sin(a)]
      if (toWall(p, near) >= f - 1e-6 && toWall(p, far) >= f - 1e-6) return true
    }
    return false
  }

  // Can an f-disc still touch this point? Stand one off along the wall's inward
  // Can an f-disc still touch this point? Stand one off along the wall's inward
  // normal and ask whether it fits. The normal's sign is taken by trying both and
  // keeping the roomier — the two walls face opposite ways and a sign rule would
  // be one more thing to get backwards.
  const reaches = (w: Pt[], i: number, f: number): boolean => {
    const p = w[i]
    const a = w[Math.max(0, i - 1)], b = w[Math.min(w.length - 1, i + 1)]
    const tx = b[0] - a[0], ty = b[1] - a[1]
    const n = Math.hypot(tx, ty) || 1
    for (const s of [1, -1]) {
      const c: Pt = [p[0] - (s * ty * f) / n, p[1] + (s * tx * f) / n]
      if (room(c) >= f - 1e-3) return true
    }
    return false
  }
  const buriesNothing = (f: number): boolean => {
    for (const w of [near, far]) {
      for (let i = 0; i < w.length; i++) {
        if (Math.hypot(w[i][0], w[i][1]) <= rFloor) continue
        if (!reaches(w, i, f)) return false
      }
    }
    return true
  }

  // Both, and both are monotone in f: a bigger disc needs more clearance to get
  // down, and leaves more behind when it cannot.
  const ok = (f: number) => touchesRoot(f) && buriesNothing(f)
  let lo = ROOT_FILLET, hi = g.depth + pitch * g.rTip
  if (!ok(lo)) return ROOT_FILLET
  for (let i = 0; i < 26; i++) {
    const m = (lo + hi) / 2
    if (ok(m)) lo = m; else hi = m
  }
  return Number.isFinite(lo) ? Math.max(ROOT_FILLET, lo) : ROOT_FILLET
}

/**
 * One toothed ring, centred on the origin.
 *
 * The tooth leans the way the wheel runs and its leading face is undercut, so the
 * only thing that can reach a pallet is its tip — which is what makes the pallet
 * face a locus of a POINT and the whole construction above possible. The tip is
 * not quite a point: it carries a short RADIAL land so it beds flat on the
 * locking face (see `toothGeom`), and the land's outer corner is that point.
 * The back is a long slope from the root land up to the next tip.
 *
 * Drawn for an anticlockwise wheel; a clockwise one is the mirror of it, applied
 * to the whole assembly at the end.
 */
function toothedRing(spec: EscapementSpec): Pt[] {
  const { N, pitch, beta } = frame(spec)
  // Phase the teeth so one tip lands exactly on the entry contact point. It
  // costs nothing and it makes the drawing mean something: wheel and anchor are
  // then shown in the relative position they are actually in, mid-impulse,
  // rather than at whichever phase the tooth loop happened to start at.
  const phase = Math.PI / 2 + beta / 2
  const { rRoot, rTip, rLand, backSpan, u, uLand, bowAng, start } = toothGeom(spec)

  const ring: Pt[] = []
  const at = (r: number, a: number) => ring.push([r * Math.cos(a), r * Math.sin(a)])
  at(rRoot, phase - pitch + backSpan + bowAng)   // foot of the back before the first tooth
  for (let i = 0; i < N; i++) {
    const a0 = phase + i * pitch
    arcInto(ring, 0, 0, rRoot, rRoot, a0 - pitch + backSpan + bowAng, a0 + u - bowAng)
    flank(ring, rRoot, rLand, a0 + u - bowAng, a0 + uLand, -1, bowAng, start)  // up the leading face
    at(rTip, a0)                                                        // the tip land
    flank(ring, rTip, rRoot, a0, a0 + backSpan + bowAng, 1, bowAng, start)  // down the back
  }
  return ring
}

/** One flank, from (r0,a0) to (r1,a1), bowed outward from the tooth by
 *  `flankAngle`'s law. Always sampled, even dead straight: it costs nothing, it
 *  keeps the outline uniform for the gullet closing, and it means a genuine break
 *  in the profile shows up as one long edge instead of hiding among the flanks. */
function flank(
  out: Pt[], r0: number, r1: number, a0: number, a1: number,
  dir: number, bowAng: number, start: number,
): void {
  const steps = 12
  const tipFirst = r0 > r1                     // the tip is the larger radius
  for (let i = 1; i <= steps; i++) {
    const s = i / steps
    const a = flankAngle(a0, a1, s, dir, bowAng, start, tipFirst)
    const r = r0 + (r1 - r0) * s
    out.push([r * Math.cos(a), r * Math.sin(a)])
  }
}
// ─── Readouts ─────────────────────────────────────────────────────────────────

export function escapementDims(spec: EscapementSpec): EscapementDims {
  const { R, N, L, rho, beat, mu, lam, pitch: pitchR } = frame(spec)
  const t = toothGeom(spec)
  const rRoot = t.rRoot
  const rimInner = rRoot - Math.max(2, spec.wheelDia / 30)
  const hub = seatHub(rimInner, clamp(spec.bore / 2, 0, rRoot - 1), spec.hubDia, spec.spokes, spokeWidth(spec))

  // The impulse face's inclination to the dead arc: the angle its chord makes
  // with the perpendicular to the arbor radius.
  const a = locus(spec, 'entry', -0.5, false)
  const b = locus(spec, 'entry', 0.5, false)
  const chord: Pt = [b[0] - a[0], b[1] - a[1]]
  const mid = norm([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
  const len = Math.hypot(chord[0], chord[1]) || 1
  const impulseAngleDeg = (Math.asin(clamp(Math.abs((chord[0] * mid[0] + chord[1] * mid[1]) / len), 0, 1)) * 180) / Math.PI

  const face = actingProfile(spec, 'entry')
  let faceWidth = 0
  for (let i = 1; i < face.length; i++) faceWidth += Math.hypot(face[i][0] - face[i - 1][0], face[i][1] - face[i - 1][1])

  const dive = rho * halfSwing(spec)
  // Tooth thickness WHERE IT LEAVES THE GULLET — at the top of the fill, which is
  // the first section that is the tooth's own material rather than the stock
  // joining it to its neighbours. Not at the root circle: the fill reaches well
  // above that now, so a thickness measured there is a thickness of solid wheel.
  const gFill = Math.min(0.98, t.start + GULLET_KEEP)
  const rSec = t.rTip - t.depth * gFill
  const toothBase = Math.max(0, pitchR * rSec - toothSpace(spec, gFill))
  // The lock actually left: what the anchor's swing buries the pallet by, less
  // the clearance the teeth were cut short by. And the part of it that is there
  // the moment the tooth lands, which is what the pallets' embrace buys.
  const lockDepth = rho * rad(Math.max(0, spec.escType === 'deadbeat' ? spec.lock : spec.recoilArc))
  const dead = spec.escType === 'deadbeat'
  const dropLockDepth = dead ? rho * dropLock(spec) : 0
  const w = Math.max(1, spec.armWidth)
  const hubR = Math.max(w * 0.75, spec.anchorBore / 2 + Math.max(1.5, w * 0.4))
  return {
    centreDistance: L,
    palletRadius: rho,
    toothPitchDeg: 360 / N,
    beatDeg: 180 / N,
    wheelImpulseDeg: ((beat - rad(Math.max(0, spec.drop))) * 180) / Math.PI,
    // What the pendulum has to beat to UNLOCK: half the lift to run the impulse
    // out, plus the half drop lock that the embrace puts in front of it. Any
    // swing past that is run to lock, which the escapement does not need.
    minHalfSwingDeg: ((lam / 2 + dropLock(spec) / 2) * 180) / Math.PI,
    impulseAngleDeg,
    faceWidth,
    recoilRatio: mu / lam,
    wheelRootDia: 2 * rRoot,
    hub,
    span: escapementSpan(spec.teeth),
    noImpulse: rad(Math.max(0, spec.drop)) >= beat - 1e-9,
    // The arbor sits L from the wheel centre and the teeth reach R, so there is
    // only L−R of daylight for the anchor's own hub.
    hubFouls: hubR > L - R - 0.5,
    faceTooSteep: impulseAngleDeg > 60,
    palletDive: dive,
    toothBase,
    gulletRadius: gulletFillet(spec),
    lockDepth,
    dropLockDepth,
    // A deadbeat is judged on the DROP lock — it is never more than the total,
    // so this catches the clearance eating the whole lock as well as the
    // narrower case of it eating only what was there at the landing. A recoil
    // has no drop lock to judge and is asked the older question instead.
    noLock: (dead ? dropLockDepth : lockDepth) <= 0.02,
    // Measured against the mesh: past about half the tooth depth the impulse
    // face starts to reach the tooth it has just locked. See the sweep in
    // `scripts/escapement-check.mts`.
    divesTooDeep: dive > DIVE_LIMIT * (R - rRoot),
  }
}

/** Spoke and rim widths are proportions of the wheel — an escape wheel has no
 *  module to state them in, and nobody wants two more fields to set them. */
function spokeWidth(spec: EscapementSpec): number {
  return Math.max(3, spec.wheelDia / 25)
}

/** How far above the wheel the anchor is drawn — clear of the teeth by a margin,
 *  on the line it really sits on, so the drawing still reads as an escapement. */
export function anchorOffset(spec: EscapementSpec): number {
  const { R, beta, rho } = frame(spec)
  const w = Math.max(1, spec.armWidth)
  const gap = Math.max(3, R * 0.06)
  return R + gap + Math.cos(beta / 2) * (rho + 2 * w)
}

// ─── Motion ───────────────────────────────────────────────────────────────────

export interface EscapementPose {
  /** Anchor rotation about its arbor, degrees, CCW positive. */
  anchorDeg: number
  /** Wheel rotation about its own centre, degrees, CCW positive. */
  wheelDeg: number
}

/**
 * Where the two stand at a given moment — the escapement's own kinematics, so a
 * preview shows what it really does rather than an animator's impression of it.
 *
 * `phase` counts PERIODS (two beats, one full swing out and back), and runs on
 * past 1 — the wheel advances exactly one tooth per period, so the pose is
 * continuous across the join with nothing to reset.
 *
 * Within a beat the anchor rocks φ = Φ·cos, and the wheel is carried by whichever
 * pallet has hold of it:
 *
 *   IMPULSE, φ within the pallet's own λ-wide window — the tooth is on the impulse
 *   face and the wheel turns μ for the anchor's λ, which is the ratio the faces
 *   were generated from.
 *   LOCKED, outside it — a deadbeat holds the wheel dead still; a recoil has no
 *   dead face, so the same straight-line relation carries on and drives the wheel
 *   BACKWARDS through the supplementary arc.
 *   RELEASE, at the low end of that window — the tooth drops off, the wheel runs
 *   free by `drop`, and the other pallet catches the next tooth.
 *
 * The two windows are not the same window: the drop lock slides the entry's down
 * by D/2 and the exit's up by D/2 (see `dropLock`), so one pallet releases D of
 * anchor travel BEFORE the other's impulse could begin — which is exactly the
 * dead face the arriving tooth lands on. The pair stays symmetric about the
 * anchor's neutral, so a pendulum still swings evenly.
 *
 * Which comes out at exactly half a tooth per beat, as it must.
 */
export function escapementPose(spec: EscapementSpec, phase: number): EscapementPose {
  const { lam, mu, pitch } = frame(spec)
  const Phi = halfSwing(spec)
  const drop = Math.max(0, rad(spec.drop))
  const half = lam / 2
  const shift = dropLock(spec) / 2
  const dead = spec.escType === 'deadbeat'

  const cycles = Math.floor(phase)
  const tau = phase - cycles
  const phi = Phi * Math.cos(2 * Math.PI * tau)
  const falling = tau < 0.5

  // What one pallet has moved the wheel by at anchor angle φ. Outside the
  // impulse a dead face holds it; a recoil face does not. Each pallet reads φ
  // through its own half of the embrace.
  const lim = (v: number) => (dead ? clamp(v, -mu / 2, mu / 2) : v)
  const entry = (p: number) => lim((-mu * (p + shift)) / lam)
  const exit = (p: number) => lim((mu * (p - shift)) / lam)
  const eRel = -half - shift          // where the entry lets go, falling
  const xRel = half + shift           // where the exit lets go, rising

  // Each pallet's own law, used DIRECTLY — no re-zeroing at the extreme of the
  // swing. A deadbeat is unaffected either way (its law is flat out there), but
  // a recoil face has no flat part, so re-zeroing shifts the wheel by μΦ/λ − μ/2
  // and the pair reads as binding through the whole supplementary arc.
  let adv: number
  if (falling) {
    // The entry works and lets go at eRel; the exit takes the next tooth, one
    // free `drop` further on — and takes it a drop lock deep, since its own
    // impulse cannot start until φ has climbed back to −λ/2 + D/2.
    if (phi >= eRel) adv = entry(phi)
    else adv = entry(eRel) + drop + exit(phi) - exit(eRel)
  } else {
    // Coming back: the exit is still on until xRel, then the entry catches.
    const handover = entry(eRel) + drop - exit(eRel)
    if (phi <= xRel) adv = handover + exit(phi)
    else adv = handover + exit(xRel) + drop + entry(phi) - entry(xRel)
  }
  adv += cycles * pitch

  // The construction runs clockwise, so advance is a NEGATIVE rotation — and the
  // anticlockwise wheel is its mirror, which flips both.
  const mir = spec.clockwise ? 1 : -1
  return {
    anchorDeg: (mir * phi * 180) / Math.PI,
    wheelDeg: (-mir * adv * 180) / Math.PI,
  }
}

// ─── Emission ─────────────────────────────────────────────────────────────────

export type EscapementPartKey =
  | 'wheel' | 'spokes' | 'bore' | 'anchor' | 'anchorbore' | 'ref'

export interface EscapementPart { key: EscapementPartKey; d: string }

/**
 * Wheel and anchor as separate paths — the teeth are profiled outside, the
 * spokes and bores inside, and the anchor is its own part on its own stock.
 * Drawn clear of each other; `escapementDims().centreDistance` is the spacing.
 */
export function generateEscapementParts(spec: EscapementSpec): EscapementPart[] {
  const d = escapementDims(spec)
  const rRoot = d.wheelRootDia / 2
  const yA = anchorOffset(spec)
  // The teeth lean the way the wheel runs, so the two directions are mirror
  // images and the whole assembly is mirrored together — anchor with wheel, or
  // they would no longer be cut for each other. The construction is laid out
  // CLOCKWISE (`locus` advances the wheel through negative angles), so it is the
  // anticlockwise wheel that is the reflection.
  const mir = spec.clockwise ? 1 : -1
  const place = (r: Pt[], dy = 0) =>
    r.map(([x, y]) => [spec.cx + mir * x, spec.cy + y + dy] as Pt)

  const out: EscapementPart[] = [{
    key: 'wheel',
    d: roundConcave([toothedRing(spec)], gulletFillet(spec)).map((r) => ringToD(place(r), true)).join(' '),
  }]

  const boreR = clamp(spec.bore / 2, 0, rRoot - 1)
  const anchorBoreR = Math.max(0, spec.anchorBore / 2)
  const holes: string[] = []
  if (boreR > 0.25) holes.push(ringToD(place(ellipseRing(0, 0, boreR, boreR)), false))
  if (holes.length > 0) out.push({ key: 'bore', d: holes.join(' ') })

  const rimInner = rRoot - Math.max(2, spec.wheelDia / 30)
  const windows = spokeWindows(Math.round(spec.spokes), rimInner, d.hub.dia / 2, spokeWidth(spec))
  if (windows.length > 0) {
    out.push({ key: 'spokes', d: windows.map((r) => ringToD(place(r), false)).join(' ') })
  }

  out.push({
    key: 'anchor',
    d: filletToes(
      anchorRings(spec).map((r) => ringToD(place(r, yA), true)).join(' '),
      [spec.cx, spec.cy + yA],
      ARM_TOE * Math.max(1, spec.armWidth),
      spec, mir,
    ),
  })
  if (anchorBoreR > 0.25) {
    out.push({ key: 'anchorbore', d: ringToD(place(ellipseRing(0, 0, anchorBoreR, anchorBoreR), yA), false) })
  }

  return out
}

/**
 * Round the toe of each arm — the far corner where its outer edge turns down
 * towards the pallet, which nothing ever touches.
 *
 * Done with the app's own corner treatment, the same operation the corner tool
 * applies by hand, so there is no second implementation of a fillet here to get
 * the material side wrong.
 *
 * Picking WHICH corner is the whole problem, and the answer is the simplest one:
 * the toe is the point of each arm FURTHEST FROM THE ARBOR. Nearest-to-a-computed
 * point is not good enough — the two arms reach different distances, so on one of
 * them the extreme point is the arm's own end rather than where the stem crosses
 * its edge, and a calculation for the latter misses by the better part of a
 * centimetre. Distance from the arbor is true of both, and of a mirrored wheel.
 *
 * Two more are found the opposite way: by GEOMETRY rather than by rule, because
 * each is a specific named point the rest of this file already computes, and
 * both are rounded to the BIT rather than to the toe radius because they are
 * tight for the cutter rather than for the tooth — the deep-lock corner
 * (`lockCorner`) and the one the pallet's back makes with its arm
 * (`backCorner`). The first only works because `lockCorner` has already moved
 * that corner away from the wheel — rounded where it sits naturally, the
 * set-back would run back along the acting face and take the lock with it. The
 * second needs no such help; there is room where it stands. They are matched by
 * nearest coordinate in the PLACED (mirrored) outline, not by index — the raw
 * ring can come out with its winding reversed by the mirror (`ringToD`'s
 * CCW-forcing `reverse()`), which renumbers every vertex, so an index computed
 * before placement would not point at the same corner after it.
 *
 * NOTHING rounds the release corner where the acting face meets the relieved
 * back. That corner is the pallet's tip now that the tip land is gone, and it is
 * a working corner: it is where the tooth leaves. The land's own far corner used
 * to be rounded here, which is why this reads as one fillet short of the shape.
 */
function filletToes(d: string, arbor: Pt, r: number, spec: EscapementSpec, mir: number): string {
  if (r < 0.05) return d
  const corners = getTreatableCorners(d)
  if (corners.length === 0) return d

  // Every vertex of an outline this dense is technically a corner — hundreds of
  // short segments, each turning a fraction of a degree — so they are ranked by
  // how sharply they actually turn. The path is straight segments at this point,
  // before any treatment has put curves in it.
  const pts = d.replace(/[MZ]/g, ' ').split('L')
    .map((t) => t.trim().split(',').map(Number))
    .filter((q) => q.length === 2 && q.every(Number.isFinite)) as Pt[]
  const turn = (i: number) => {
    const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length]
    let t = Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0])
    while (t > Math.PI) t -= 2 * Math.PI
    while (t < -Math.PI) t += 2 * Math.PI
    return Math.abs(t)
  }

  // A RECOIL'S ENTRY TOE IS ROUNDED HARDER — `RECOIL_TOE` rather than `ARM_TOE`,
  // 6 mm against 2.8 on a standard arm.
  //
  // The run-out along `lead` is what buries the wedge in its arm, and the entry
  // nib is the END of its arm, so on that side the run goes out into open air
  // with only the arm's outer edge to catch it. On a DEADBEAT it is caught a
  // fifth of a millimetre past the acting face, because the dead arc is
  // concentric with the arbor and its tangent runs across the arm. A RECOIL has
  // no dead arc: the locus is still climbing at the deep end, the same run-out
  // points nearly straight out, and the arm ends in a long thin spear.
  //
  // Rounding it is the right lever because that spear tip is ALREADY the corner
  // this picks as the arm's toe — the furthest point from the arbor on its side —
  // so nothing new has to be found or matched, and nothing that acts is touched.
  // What must NOT be done instead is to shorten the run-out: the blade then stops
  // before it reaches the arm, its end face crosses the arm's toe, and a DEADBEAT
  // comes out with a jog in the silhouette where a rounded toe used to be. That
  // was tried, and it broke the one profile that was already right.
  //
  // The size is an eye judgement and cannot be anything else: winding `drop` up
  // shortens the spear too, but by changing the angle it comes to a point at, so
  // there is no length to calibrate a radius against.
  //
  // The entry pallet sits at negative x in the anchor's own frame, so it lands on
  // the −mir side of the placed outline.
  const entryToe = spec.escType === 'recoil' ? RECOIL_TOE * Math.max(1, spec.armWidth) : r
  const pick = new Map<number, { type: 'outerRound'; radiusMM: number }>()
  for (const sideSign of [-1, 1]) {
    let far = 0, at = -1
    for (const c of corners) {
      if (Math.sign(c.x - arbor[0]) !== sideSign) continue
      if (c.idx >= pts.length || turn(c.idx) < TOE_MIN_TURN) continue
      const dist = Math.hypot(c.x - arbor[0], c.y - arbor[1])
      if (dist > far) { far = dist; at = c.idx }
    }
    if (at >= 0) {
      pick.set(at, { type: 'outerRound', radiusMM: sideSign === -mir ? entryToe : r })
    }
  }

  const place = (p: Pt): Pt => [arbor[0] + mir * p[0], arbor[1] + p[1]]
  const nearestCorner = (target: Pt, tol = 0.2): number => {
    let best = Infinity, at = -1
    for (const c of corners) {
      const dd = Math.hypot(c.x - target[0], c.y - target[1])
      if (dd < best) { best = dd; at = c.idx }
    }
    return best <= tol ? at : -1
  }

  for (const side of ['entry', 'exit'] as const) {
    // The two corners that are tight for the CUTTER rather than for the tooth,
    // so both are rounded to the bit rather than to the arm's toe radius: where
    // the face runs into the arm at the deep lock (`lockCorner` has already
    // taken the arm back far enough that this radius lands clear of the face),
    // and where the pallet's back does (`backCorner`, which needs no such room
    // made for it). Either can be absent, and then nothing is picked.
    for (const target of [lockCorner(spec, side)?.at, backCorner(spec, side)]) {
      const at = target && nearestCorner(place(target), 0.3)
      if (at !== undefined && at !== null && at >= 0) {
        pick.set(at, { type: 'outerRound', radiusMM: LOCK_RELIEF_BIT_DIA / 2 })
      }
    }
  }

  return pick.size === 0 ? d : applyCornerTreatments(d, pick)
}

/** Every part in one compound path — the live drag preview. */
export function generateEscapementD(spec: EscapementSpec): string {
  return generateEscapementParts(spec).map((p) => p.d).join(' ')
}

/** Wheel diameter for a drag box of this radius. The box sizes the WHEEL, which
 *  is what a user is thinking about; the anchor comes along above it. */
export function wheelDiaForRadius(radius: number): number {
  return Math.max(4, 2 * Math.max(1, radius))
}
