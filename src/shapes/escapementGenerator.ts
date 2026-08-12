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
  /** Teeth spanned by the pallets. MUST be an integer + ½, or the pallets do not
   *  alternate; N/4 rounded to the nearest half tooth is the usual choice. */
  span: number
  /** Tip circle to root circle, mm. */
  toothDepth: number
  /** Degrees the tooth's leading face leans back from radial, so only the tip
   *  can touch a pallet. */
  undercut: number
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
  /** Crutch tail sticking out past the arbor, mm. 0 for none. */
  tailLength: number
  /** Wheel bore Ø. 0 for none. */
  bore: number
  /** Wheel hub Ø — a FLOOR, grown if the spokes need more room to land on. */
  hubDia: number
  /** 0 for a solid wheel. */
  spokes: number
  /** Anchor arbor Ø. 0 for none. */
  anchorBore: number
  /** How much the tooth flanks BOW outward, 0…1. Straight flanks taper a tooth
   *  from a point to a narrow base and leave it weak across the grain; a real
   *  escape wheel curves both sides so the tooth swells towards the root. The
   *  bow grows as the square of the depth, so a flank leaves the tip on its
   *  original line and only fattens lower down — which is what keeps it out of
   *  the space in front of the tip, where the pallet's impulse face works at the
   *  lock. 0 for the straight taper. */
  toothCurve: number
  /** Running clearance, mm. The teeth are cut this much SHORT of the circle the
   *  pallets were laid out for, which opens the same gap at every surface the
   *  two meet on — the escapement's equivalent of backlash on a gear, and what
   *  keeps a wooden movement from seizing when the weather moves it. It comes
   *  straight off the lock, so it has to stay well under the lock depth. */
  clearance: number
  /** Wheel turns clockwise. The teeth lean the way it runs, so this is not
   *  cosmetic — a wheel cut the wrong way round will not lock at all. */
  clockwise: boolean
  /** Draw the tip circle and the pallet circle as extra subpaths. References for
   *  laying out the plate, not cuts — delete them before generating. */
  refCircles: boolean
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
  /** The span is not an integer + ½, so the pallets cannot alternate. Fatal. */
  spanUneven: boolean
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
  /** Tooth thickness at the root, mm — what has to carry the drive across the
   *  grain, and what the flank bow is for. */
  toothBase: number
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
/** Fillet on each arm's toe — its far corner, away from the wheel — as a
 *  fraction of the arm width. Nothing touches it: shape only. */
const ARM_TOE = 0.35
/** How sharply a vertex must turn to be a corner rather than a sample on a
 *  curve, radians. */
const TOE_MIN_TURN = 0.7
/** Root fillet on the wheel teeth, mm. A cutter leaves one whatever we draw. */
const ROOT_FILLET = 0.6
/** Fraction of the tooth pitch taken by the back slope; the rest is root land. */
const BACK_FRAC = 0.55
/** How much of a tooth pitch a pallet may occupy around the wheel — see
 *  `palletNib`. The rest of the space is the drop and the tooth itself. */
const NIB_SPACE = 0.12
/** Degrees the back of a pallet is relieved by — see `palletNib`. */
const BACK_RELIEF = 75
/** How much of the root land one bowed flank may take, so a strip of land is
 *  always left between the two that share it — see `bow`. */
const BOW_SHARE = 0.3
/** Extra depth, as a fraction of the tooth, kept clear below the pallet's reach
 *  before a flank is allowed to bow — see `toothedRing`. */
const BOW_KEEP = 0.08
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

/** The geometry every other function here starts from. */
function frame(spec: EscapementSpec) {
  const R = Math.max(2, spec.wheelDia / 2)
  const N = Math.max(6, Math.round(spec.teeth))
  const pitch = (2 * Math.PI) / N
  // Span is clamped short of a half turn: β → π sends the arbor to infinity.
  const span = clamp(spec.span, 0.5, N / 2 - 0.5)
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
  const want = (Math.max(0, spec.clearance || 0) + LANDING_MARGIN) / rho
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
  // The TIP LAND — the short square face closing the pallet beyond the release
  // corner. It is the pallet blade's own thickness and it is left SQUARE, which
  // looks alarming: it stands within about 2° of the tooth's direction of travel
  // at the instant of release, so a static reading of the drawing says the tooth
  // must skim along it and rub the impulse back out of the pendulum.
  //
  // It does not, and the reason is that the static angle is the wrong thing to
  // look at: after release the pallet is withdrawing while the tooth runs on, so
  // the two separate far faster than that 2° suggests. Measured over the whole
  // cycle a tooth never comes closer than 0.32 mm to this face (`__escTipLand`,
  // and the test that pins it). Tilting it away makes no measurable difference —
  // 0.3149 against 0.3168 mm at 20° — so it stays square.
  const heel: Pt = [inner[0] + depth * m[0], inner[1] + depth * m[1]]
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
  return { m, away, lead, rel, inner, outer, heel, line, far }
}

/** The nib as a ring: the acting face in front, the relieved back behind, run out
 *  far enough to bury itself in the arm and cut off flush with the arm's outer
 *  edge — so the wedge disappears into the arm rather than sprouting out of the
 *  far side of it. */
function palletNib(spec: EscapementSpec, side: Side, depth: number): Pt[][] {
  const { lead, rel, outer, heel, line, far } = nibFrame(spec, side, depth)
  const ring: Pt[] = [
    ...line,                                             // the acting face
    [outer[0] + far * lead[0], outer[1] + far * lead[1]], // on along it, past the arm
    [heel[0] + far * rel[0], heel[1] + far * rel[1]],    // and back down the relief
    heel,
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
  const { heel, rel, far } = nibFrame(spec, side, nibDepth(spec))
  const { p, dir } = armFlank(spec, side, ARM_CLEAR)
  const den = rel[0] * dir[1] - rel[1] * dir[0]
  if (Math.abs(den) < 1e-6) return null
  const s = ((p[0] - heel[0]) * dir[1] - (p[1] - heel[1]) * dir[0]) / den
  if (!(s > 0.05 && s < far)) return null
  const at: Pt = [heel[0] + rel[0] * s, heel[1] + rel[1] * s]
  // Two infinite lines always cross. It is only a corner of the anchor if the
  // crossing lands on the arm that is actually there — which on the exit side it
  // does not: that one is out past the end of its own arm.
  const along = (at[0] - p[0]) * dir[0] + (at[1] - p[1]) * dir[1]
  return along > -w / 2 && along < armReach(spec, side, w) + w / 2 ? at : null
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
  // Square-ended, not a stadium: the pallet wedge is cut off flush with this
  // arm's OUTER edge, and a rounded end curves away from that line and leaves a
  // step sticking out of the silhouette. The corner it makes with the wedge is
  // rounded later, on the assembled anchor — see `anchorRings`.
  const bar: Pt[] = taper > 0
    ? [[-width / 2, -width / 2], [reach + width / 2, -width / 2 + taper],
       [reach + width / 2, width / 2], [-width / 2, width / 2]]
    : roundRectRing(-width / 2, -width / 2, reach + width, width, 0)
  const a = Math.atan2(u[1], u[0])
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
  add(palletArm(spec, 'entry', armReach(spec, 'entry', w), w))
  add(palletArm(spec, 'exit', armReach(spec, 'exit', w), w, lockCorner(spec, 'exit')?.taper ?? 0))
  if (spec.tailLength > 0.5) {
    add(roundRectRing(-w / 2, -w / 2, w, spec.tailLength + w, w / 2))
  }

  // Fillet the arm-to-hub junctions, and ONLY those: the nibs go on afterwards,
  // untouched. A closing of a couple of millimetres is nothing on an arm and
  // everything on a pallet — the whole acting face is a few millimetres long, so
  // filleting it rounds the locking corner away and turns a dead lock into a
  // recoiling one. It still LOOKS like a deadbeat escapement.
  let out: Pt[][] = roundConcave(body, Math.min(w * 0.35, rho * 0.05))
  const addTo = (r: Pt[]) => { for (const p of boolRings('union', out.splice(0), [r])) out.push(p) }
  for (const r of palletNib(spec, 'entry', nibDepth(spec))) addTo(r)
  for (const r of palletNib(spec, 'exit', nibDepth(spec))) addTo(r)

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
/** Test hook — the toothed ring BEFORE the root-fillet closing, so a test can
 *  tell a break in the profile from the resampling clipper does to the whole
 *  outline on its way through. */
export function __escToothRing(spec: EscapementSpec): Pt[] { return toothedRing(spec) }
export function __escLockPoints(spec: EscapementSpec): number { return spec.escType === 'deadbeat' ? 20 : 24 }
/** The pallet's inner (lock-side) face point and its TIP LAND — the short face
 *  closing the pallet beyond the release corner, `nibDepth` back from `inner`
 *  along the stock side of the face. Shared by the test hook below and by
 *  `filletToes`, which rounds the heel for clearance — see `HEEL_ROUND`. */
function tipLandPts(spec: EscapementSpec, side: Side): [Pt, Pt] {
  const { inner, heel } = nibFrame(spec, side, nibDepth(spec))
  return [inner, heel]
}

/** Test hook — the pallet's TIP LAND, the short face closing it beyond the
 *  release corner. A tooth must drop CLEAR of this at release; measuring that is
 *  the only way to see the relief is doing its job, since grazing it is not
 *  interference and the outline just shows a small bevel. */
export function __escTipLand(spec: EscapementSpec, side: Side): [Pt, Pt] { return tipLandPts(spec, side) }

// ─── The escape wheel ─────────────────────────────────────────────────────────

/**
 * One toothed ring, centred on the origin.
 *
 * The tooth leans the way the wheel runs and its leading face is undercut, so
 * the only thing that can reach a pallet is the tip — which is what makes the
 * pallet face a locus of a POINT and the whole construction above possible. The
 * back is a long slope from the root land up to the next tip.
 *
 * Drawn for an anticlockwise wheel; a clockwise one is the mirror of it, applied
 * to the whole assembly at the end.
 */
function toothedRing(spec: EscapementSpec): Pt[] {
  const { R, N, pitch, beta, rho } = frame(spec)
  // Phase the teeth so one tip lands exactly on the entry contact point. It
  // costs nothing and it makes the drawing mean something: wheel and anchor are
  // then shown in the relative position they are actually in, mid-impulse,
  // rather than at whichever phase the tooth loop happened to start at.
  const phase = Math.PI / 2 + beta / 2
  const rRoot = Math.max(R * 0.25, R - Math.max(0.5, spec.toothDepth))
  // Cut short of the circle the pallets were laid out for. One number, applied
  // in one place, opening the same gap wherever the two meet — see `clearance`.
  // `|| 0` rather than a bare read: a project saved before these fields existed
  // has neither, and an undefined clearance does not draw a slightly wrong wheel
  // — it makes every coordinate NaN and the escapement silently stops rendering.
  // Same trap the gear's `cycOf` guards against.
  const rTip = Math.max(rRoot + 0.2, R - Math.max(0, spec.clearance || 0))
  const backSpan = clamp(BACK_FRAC * pitch, 0.02, pitch * 0.9)
  // The undercut, as an angle at the root. Increasing angle is BEHIND the tooth
  // (the wheel runs clockwise), so BOTH of a tooth's edges run back from the tip:
  // the short leading face to a0+u and the long back to a0+backSpan. The tooth is
  // the sliver between them, coming to a point at a0 — which is what makes the
  // tip OVERHANG the space in front of it.
  //
  // That overhang is the whole purpose. Put the foot in front of the tip instead
  // and the tooth's root projects forward into exactly the space the pallet's
  // impulse face has to occupy at the lock, and the escapement binds harder the
  // more undercut it is asked for — which is the tell.
  const u = clamp(((rTip - rRoot) * Math.tan(rad(clamp(spec.undercut, 0, 60)))) / rRoot, 0, backSpan * 0.7)

  // How far a flank may bow, as an ANGLE at the root. Angular, not perpendicular
  // to the flank, so a bowed foot stays ON the root circle and the land between
  // two teeth simply runs between the feet it is given. Displace the foot off
  // that circle instead and the land still starts where the foot used to be,
  // which leaves a step in the outline at every tooth.
  //
  // Both flanks of a gap eat the same land, so each is held to a share of it.
  const landAng = pitch - backSpan + u
  const bowAng = clamp(spec.toothCurve || 0, 0, 1) * BOW_SHARE * landAng
  // And WHERE the bow may start: not until below everything the pallet reaches.
  // A pallet dives ρ·Φ past the tip circle at the end of its swing, so above that
  // depth the tooth must stay exactly as it was — stock added there goes straight
  // back into the pallet's way, which is what a bow reaching the tip does, and it
  // is the recoil (whose pallet is the longer blade) that finds it first. Below
  // it the space is the tooth's own, and that is where the strength is wanted.
  const start = clamp((rho * halfSwing(spec)) / Math.max(0.5, rTip - rRoot) + BOW_KEEP, 0, 0.92)

  const ring: Pt[] = []
  const at = (r: number, a: number) => ring.push([r * Math.cos(a), r * Math.sin(a)])
  at(rRoot, phase - pitch + backSpan + bowAng)   // foot of the back before the first tooth
  for (let i = 0; i < N; i++) {
    const a0 = phase + i * pitch
    // Increasing angle is BEHIND the tooth: the wheel runs clockwise, so a tooth
    // leans towards decreasing angle and both of its edges run back from the tip.
    // The tooth is the sliver between them and comes to a point at a0, which is
    // what makes the tip OVERHANG the space in front of it. Put the undercut's
    // foot in front of the tip instead and the root projects forward into exactly
    // the space the pallet's impulse face needs at the lock.
    arcInto(ring, 0, 0, rRoot, rRoot, a0 - pitch + backSpan + bowAng, a0 + u - bowAng)
    flank(ring, rRoot, rTip, a0 + u - bowAng, a0, -1, bowAng, start)   // up the leading face
    flank(ring, rTip, rRoot, a0, a0 + backSpan + bowAng, 1, bowAng, start)  // down the back
  }
  return ring
}

/**
 * One flank, from (r0,a0) to (r1,a1), bowed outward from the tooth.
 *
 * The bow grows as the SQUARE of the depth below `start`, which is the whole
 * trick: at that depth it is zero and so is its slope, so the flank leaves the
 * pallet's region on exactly the line it would have taken and only fattens
 * further down. `dir` is which way is out of the tooth, and the foot angles
 * handed in already include the bow, so the curve lands on them.
 */
function flank(
  out: Pt[], r0: number, r1: number, a0: number, a1: number,
  dir: number, bowAng: number, start: number,
): void {
  // Always sampled, even dead straight: it costs nothing, it keeps the outline
  // uniform for the root-fillet closing, and it means a genuine break in the
  // profile shows up as one long edge instead of hiding among the flanks.
  const steps = 12
  const tipFirst = r0 > r1                     // the tip is the larger radius
  for (let i = 1; i <= steps; i++) {
    const s = i / steps
    const t = tipFirst ? s : 1 - s             // depth below the tip, 0…1
    // The straight line between the two ends already ramps the bow linearly with
    // depth, since the foot's angle carries all of it. Replace that ramp with the
    // squared one: zero and flat where the pallet reaches, all of it at the foot.
    const g = Math.max(0, (t - start) / Math.max(1e-6, 1 - start))
    const a = a0 + (a1 - a0) * s + dir * bowAng * (g * g - t)
    const r = r0 + (r1 - r0) * s
    out.push([r * Math.cos(a), r * Math.sin(a)])
  }
}

// ─── Readouts ─────────────────────────────────────────────────────────────────

export function escapementDims(spec: EscapementSpec): EscapementDims {
  const { R, N, L, rho, beat, mu, lam, pitch: pitchR } = frame(spec)
  const rRoot = Math.max(R * 0.25, R - Math.max(0.5, spec.toothDepth))
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
  // Tooth thickness at the root — the chord between the two feet, plus whatever
  // the bow has added to each flank on the way down.
  const rRootD = Math.max(R * 0.25, R - Math.max(0.5, spec.toothDepth))
  const backSpanD = clamp(BACK_FRAC * pitchR, 0.02, pitchR * 0.9)
  const rTipD = Math.max(rRootD + 0.2, R - Math.max(0, spec.clearance || 0))
  const uD = clamp(((rTipD - rRootD) * Math.tan(rad(clamp(spec.undercut, 0, 60)))) / rRootD, 0, backSpanD * 0.7)
  const landD = (pitchR - backSpanD + uD) * rRootD
  const toothBase = (backSpanD - uD) * rRootD + 2 * clamp(spec.toothCurve || 0, 0, 1) * BOW_SHARE * landD
  // The lock actually left: what the anchor's swing buries the pallet by, less
  // the clearance the teeth were cut short by. And the part of it that is there
  // the moment the tooth lands, which is what the pallets' embrace buys.
  const lockDepth = rho * rad(Math.max(0, spec.escType === 'deadbeat' ? spec.lock : spec.recoilArc))
    - Math.max(0, spec.clearance || 0)
  const dead = spec.escType === 'deadbeat'
  const dropLockDepth = dead ? rho * dropLock(spec) - Math.max(0, spec.clearance || 0) : 0
  const half = spec.span * 2
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
    // An integer number of half teeth, and an ODD one: 7.5 is 15 halves, 8 is 16
    // and does not alternate.
    spanUneven: Math.abs(half - Math.round(half)) > 1e-6 || Math.round(half) % 2 === 0,
    noImpulse: rad(Math.max(0, spec.drop)) >= beat - 1e-9,
    // The arbor sits L from the wheel centre and the teeth reach R, so there is
    // only L−R of daylight for the anchor's own hub.
    hubFouls: hubR > L - R - 0.5,
    faceTooSteep: impulseAngleDeg > 60,
    palletDive: dive,
    toothBase,
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
  const { R, rho } = frame(spec)
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
    d: roundConcave([toothedRing(spec)], ROOT_FILLET).map((r) => ringToD(place(r), true)).join(' '),
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

  // References, not cuts: the tip circle the pallets are set to, and the pallet
  // circle about the arbor. Tangent to each other at the true centre distance,
  // which is the check that the two parts were drawn for one another.
  if (spec.refCircles) {
    out.push({
      key: 'ref',
      d: [
        ringToD(place(ellipseRing(0, 0, R, R)), false),
        ringToD(place(ellipseRing(0, 0, rho, rho), yA), false),
      ].join(' '),
    })
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
 * Two more corners are rounded here, found the opposite way: by GEOMETRY rather
 * than by rule, because each is a specific named point the rest of this file
 * already computes. Each pallet's TIP LAND has its own far corner
 * (`tipLandPts`'s `heel`) a few mm short of the toe, on the wheel side of it —
 * that one nothing touches either, but it sits closer to the wheel than the toe
 * does, so it is the one that actually tightens clearance. They are matched by
 * nearest coordinate in the PLACED (mirrored) outline, not by index — the raw
 * ring can come out with its winding reversed by the mirror (`ringToD`'s
 * CCW-forcing `reverse()`), which renumbers every vertex, so an index computed
 * before placement would not point at the same corner after it.
 *
 * Two more are rounded to the BIT rather than to the toe radius, because they
 * are tight for the cutter rather than for the tooth: the deep-lock corner
 * (`lockCorner`) and the one the pallet's back makes with its arm
 * (`backCorner`). The first only works because `lockCorner` has already moved
 * that corner away from the wheel — rounded where it sits naturally, the
 * set-back would run back along the acting face and take the lock with it. The
 * second needs no such help; there is room where it stands.
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

  const pick = new Map<number, { type: 'outerRound'; radiusMM: number }>()
  for (const sideSign of [-1, 1]) {
    let far = 0, at = -1
    for (const c of corners) {
      if (Math.sign(c.x - arbor[0]) !== sideSign) continue
      if (c.idx >= pts.length || turn(c.idx) < TOE_MIN_TURN) continue
      const dist = Math.hypot(c.x - arbor[0], c.y - arbor[1])
      if (dist > far) { far = dist; at = c.idx }
    }
    if (at >= 0) pick.set(at, { type: 'outerRound', radiusMM: r })
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
    const heel = nearestCorner(place(tipLandPts(spec, side)[1]))
    if (heel >= 0) pick.set(heel, { type: 'outerRound', radiusMM: r })
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
