// ─── Weight-driven clock train ────────────────────────────────────────────────
//
// This is NOT a shape. It is a small designer that emits SEVERAL ordinary shapes
// — four cycloidal wheels with lantern pinions and one escapement — each landing
// as its own chip with its own parameters, so every wheel stays independently
// editable afterwards. That is the whole reason it is not a `ShapeType`: a shape
// is one set of params, and a clock is five sets that only agree about the
// tooth and pin counts.
//
// What it works out, and what it deliberately does not:
//
//   • THE PENDULUM comes from the beat and nothing else. A pendulum's period is
//     T = 2π√(L/g), the beat is half a period, so L = g·(2·beat)²/4π². A one
//     second beat gives the familiar 994 mm seconds pendulum.
//
//   • THE GOING TRAIN is then forced. The escape wheel gives up half a tooth per
//     beat, so it turns once every `2·beat·escapeTeeth` seconds; the great wheel
//     is required to turn once every `greatWheelMin` minutes (60 puts the minute
//     hand straight on it). The ratio between those two is what the three meshes
//     must produce EXACTLY — a train off by a thousandth is 86 seconds a day —
//     which is why `solveTrain` searches integer factorisations rather than
//     rounding a cube root.
//
//   • THE DRIVE WHEEL is the opposite case, and the distinction matters. It
//     carries the weight drum and drives the great wheel's pinion, so it sets
//     only how long the clock runs between winds. Nothing about the RATE depends
//     on it, so its ratio is simply rounded to a whole tooth and the achieved
//     run time reported back. Asking a search to hit a run time exactly would be
//     solving for a number nobody measures.
//
// Every wheel drives the pinion of the wheel AFTER it, so each gear is emitted
// with `emitPinion` — the pinion beside the great wheel is the SECOND wheel's,
// and the one beside the third wheel is the escape wheel's. The escapement
// generator emits no pinion of its own, which is exactly right: the third
// wheel's is it. The great wheel therefore has a pinion driven by the drive
// wheel, and the drive wheel is the one wheel in the clock with nothing driving
// it but the cord.

import { getMultiBBox } from '../canvas/selectionUtils'
import { gearDims, gearMesh, pinionDims } from './gearGenerator'
import { escapementDims, escapementPose } from './escapementGenerator'
import {
  generateShapeParts, translateShapeParams,
  type ShapeParams, type ShapeToolConfig,
} from './shapeGenerators'

/** mm/s². The pendulum length is only as good as this, so it is stated once. */
export const G_MM = 9806.65

/** Wheels in the going train — great, second, third, escape. Hardcoded. */
export const TRAIN_WHEELS = 4
/** …so there are three meshes to solve for. */
const MESHES = TRAIN_WHEELS - 1

// Bounds on ONE mesh. A wooden clock wheel much under 1.5:1 is not worth the
// arbor it sits on, and much over 12:1 needs a wheel that will not fit the case.
export const MIN_MESH_RATIO = 1.5
export const MAX_MESH_RATIO = 12
// How far above `minPins` the solver may go looking for an exact train. Each
// extra pin makes every wheel on that mesh bigger for the same ratio, so this is
// a last resort and is priced as one below.
const PIN_HEADROOM = 3

/** Degrees each link of the untouched train leans off vertical, alternating
 *  sides. A DRAWING choice — only the link LENGTHS are forced (a mesh cares
 *  only that the pitch circles are tangent), so this is just where a clock
 *  starts before anyone arranges it. */
const TRAIN_LEAN_DEG = 22

/** Where the MOTION WORK's arbor sits, as one more entry on the end of
 *  `linkAngles`. The train's links run 0…TRAIN_WHEELS-1 (one per pair of
 *  neighbouring arbors); this one is a BRANCH off the great arbor rather than
 *  the next link of the chain, which is why it is indexed past them and why its
 *  angle points the other way — from its host TO the joint, since here the host
 *  is what is fixed. */
export const MOTION_LINK = TRAIN_WHEELS

/** …and where it starts: straight out to the right of the great arbor, clear of
 *  a train that leans upward. As arbitrary as the train's own lean, and as
 *  arrangeable — only the LENGTH is forced. */
const MOTION_LEAN_DEG = 0

/** The lean as link angles: up and alternately left/right, which keeps the
 *  train compact and vertical and leaves the middle clear for the pendulum. The
 *  motion branch rides on the end, so one array covers the whole arrangement. */
export function defaultLinkAngles(links = TRAIN_WHEELS + 1): number[] {
  return Array.from({ length: links }, (_, i) => i === MOTION_LINK
    ? MOTION_LEAN_DEG
    : 90 + (i % 2 === 0 ? 1 : -1) * TRAIN_LEAN_DEG)
}

/**
 * Link *i*'s angle in RADIANS, defaulted per element.
 *
 * Per element and not `angles ?? defaults` wholesale: a short or sparse array
 * from an older project must fill in the missing ones rather than throw the
 * user's other angles away, and a non-finite entry has to be caught here — it
 * would otherwise NaN every coordinate downstream and the clock would silently
 * stop rendering rather than look wrong.
 */
export function linkAngleAt(angles: number[] | undefined, i: number): number {
  const a = angles?.[i]
  const fallback = i === MOTION_LINK ? MOTION_LEAN_DEG : 90 + (i % 2 === 0 ? 1 : -1) * TRAIN_LEAN_DEG
  const deg = Number.isFinite(a) ? (a as number) : fallback
  return (deg * Math.PI) / 180
}

export interface ClockSpec {
  /** Seconds per beat — HALF the pendulum's period, and the number a clock is
   *  actually described by ("a seconds pendulum"). Sets the pendulum length. */
  beatSeconds: number
  /** Escape wheel teeth. With a one-second beat, 30 turns it once a minute. */
  escapeTeeth: number
  /** Tooth counts the user is HOLDING, one per mesh (great, second, third);
   *  `null` or absent means the solver chooses. The rate is still what the
   *  search is costed on, so pinning one wheel moves the others to keep the
   *  train exact — pin the wheel you have stock for, or have already cut. Pin
   *  all three and there is nothing left to solve: the train is reported as it
   *  stands, in red if it no longer keeps time. See `solveTrain`. */
  lockedTeeth?: (number | null)[]
  /** Fewest pins any lantern pinion in the train may have. A lantern pinion with
   *  too few pins has a coarse, lumpy action, so this is the floor the solver
   *  works up from — it is not a target. */
  minPins: number
  /** Minutes per revolution of the great wheel. 60 puts the minute hand on it. */
  greatWheelMin: number
  /** Tooth size for the whole going train, mm. */
  module: number
  /** Play at every mesh, mm at the pitch line — tooth THINNING, not a wider
   *  centre distance (see gearGenerator). One figure for the whole clock: it is
   *  a property of how the wheels are cut, and setting it per wheel meant
   *  opening five chips to change one decision. */
  backlash: number
  /** Every lantern pinion's pin diameter, mm. On a cycloidal wheel this is a
   *  tooth-FORM parameter — the wheel's face is the epicycloid of the pin circle
   *  offset inward by the pin radius — so it belongs with the module rather than
   *  on each wheel: a clock whose wheels disagree about it has wheels cut for
   *  pins that are not in it. */
  pinDia: number
  /** Cut the MOTION WORK too — the two extra wheels that drive an hour hand off
   *  the minute arbor at 12:1 (see `solveMotionWork`). Optional, and absent on a
   *  clock designed before it existed, which reads as off. */
  motionWork?: boolean
  /** k in the motion work's `P₁ = 5k / P₂ = 4k` family — the ONE free number in
   *  it, since the ratios and the equal centre distance fix everything else. 2 is
   *  the classic 10/30 + 8/32; each step up makes both wheels and the arbor
   *  spacing half as big again, which is how the minute wheel's stud is moved
   *  out clear of a big great wheel. Absent on an older clock: reads as
   *  MOTION_SIZE. */
  motionSize?: number
  /** Hours the clock should run on one wind. */
  runHours: number
  /** How far the weight falls over that run, mm. */
  fallMM: number
  /** Diameter of the drum the cord winds on, on the drive wheel's arbor, mm. */
  drumDia: number
  /** Direction of each link of the going train, DEGREES CCW from +x — link i
   *  runs from arbor i to arbor i+1, so there is one fewer of these than there
   *  are arbors (4 for the standard five). The lengths are NOT here and never
   *  will be: they are forced by the meshes, and storing them would let the two
   *  disagree. These are the whole of what a user may arrange.
   *
   *  Read through `linkAngleAt`, never indexed directly — a project saved before
   *  this field existed has none, and an undefined angle does not draw a
   *  slightly wrong plate, it makes every coordinate NaN and the clock silently
   *  stops rendering. Same trap as `cycOf` and `toothCurve`. */
  linkAngles: number[]
}

export const DEFAULT_CLOCK_SPEC: ClockSpec = {
  // A seconds pendulum with a 30-tooth escape wheel and 12-pin pinions: the
  // train comes out 48 / 48 / 45 driving 12s, which is exactly 60:1, so the
  // great wheel turns once an hour and carries the minute hand.
  beatSeconds: 1,
  escapeTeeth: 30,
  minPins: 12,
  greatWheelMin: 60,
  // Module 4 for the cutter, not the gear — see DEFAULT_SHAPE_CONFIG.gear.
  module: 4,
  // The Gear defaults' own figures, so a clock starts where a hand-drawn gear
  // does; both are now editable in one place for the whole train.
  backlash: 0.3,
  pinDia: 5,
  // Off: a clock is a going train, and the hands are a thing you add to one.
  motionWork: false,
  // = MOTION_SIZE, which is declared with the rest of the motion work below —
  // the classic 10/30 + 8/32.
  motionSize: 2,
  // A day's run off a metre of fall on a 40 mm drum: about eight turns of cord,
  // so the drive wheel wants roughly 3:1 onto the great wheel.
  runHours: 24,
  fallMM: 1000,
  drumDia: 40,
  linkAngles: defaultLinkAngles(),
}

// ─── Pendulum ─────────────────────────────────────────────────────────────────

/**
 * Length of the simple pendulum that beats `beatSeconds`.
 *
 * This is the length to the CENTRE OF OSCILLATION, not to the top of the bob —
 * a real rod-and-bob pendulum is regulated by raising the bob against it, which
 * is what the rating nut is for.
 */
export function pendulumLengthMM(beatSeconds: number): number {
  const period = 2 * Math.max(0.05, beatSeconds)
  return (G_MM * period * period) / (4 * Math.PI * Math.PI)
}

/** Seconds the escape wheel takes for one revolution: half a tooth per beat. */
export function escapeRevSeconds(beatSeconds: number, escapeTeeth: number): number {
  return 2 * Math.max(0.05, beatSeconds) * Math.max(6, Math.round(escapeTeeth))
}

// ─── The going train ──────────────────────────────────────────────────────────

export interface Mesh {
  /** Teeth on the DRIVING wheel of this mesh. */
  teeth: number
  /** Pins on the lantern pinion it drives — which sits on the next arbor. */
  pins: number
}

export interface TrainSolution {
  /** Great→second, second→third, third→escape. Always MESHES long. */
  meshes: Mesh[]
  /** Ratio the three meshes had to produce, great wheel to escape wheel. */
  targetRatio: number
  /** What they actually produce. */
  actualRatio: number
  /** True when the two are equal — the only case that keeps time. */
  exact: boolean
  /** Seconds a day the hands gain (+) or lose (−) from an inexact train. Zero
   *  when exact. This is the whole reason the search insists on exactness. */
  errorSecPerDay: number
}

/**
 * Split `ratio` across three lantern meshes, exactly if it can be done.
 *
 * The search is over integer factorisations, not over rounded cube roots,
 * because a clock train that is a thousandth out is 86 seconds a day. It walks
 * two of the wheels and takes the third from the quotient; anything that lands
 * on a whole tooth costs nothing, everything else pays for its rate error first
 * and its shape second.
 *
 * Cost, in order: rate error, then how far the three ratios are spread apart (an
 * even split gives the smallest wheels overall), then pins above `minPins` — the
 * last priced so that a train needing fatter pinions is only ever chosen when
 * there is no exact one without them.
 *
 * `locked` HOLDS TOOTH COUNTS THE USER HAS CHOSEN, one entry per mesh (great,
 * second, third; `null` for free). The search then runs over what is left and
 * the RATE is still what it is costed on, which is the point of the feature: pin
 * the wheel you have stock for, or the one you have already cut, and the others
 * move to keep the train exact. Three things follow from a lock and each would
 * be a bug if it were forgotten:
 *
 *   • the DERIVED wheel is the last FREE one, not always the third — with two
 *     locked there is only one left to solve for, and with three there is
 *     nothing to search at all and the train is simply reported (inexact and in
 *     red, if that is what the user has asked for);
 *   • a locked count IGNORES the mesh-ratio bounds. They exist to stop the
 *     search proposing silly wheels, and a number the user typed is not a
 *     proposal;
 *   • the result is NOT SORTED when anything is locked. The sort puts the
 *     biggest wheel at the great arbor, which is right for a train the solver
 *     chose freely — but the locks are per WHEEL, and sorting would slide the
 *     user's count onto a different arbor.
 */
export function solveTrain(ratio: number, minPins: number, locked?: (number | null)[]): TrainSolution {
  const target = Math.max(1, ratio)
  const floor = Math.max(2, Math.round(minPins))
  const ideal = Math.log(target) / MESHES

  // One entry per mesh: the count the user is holding, or null.
  const lock = Array.from({ length: MESHES }, (_, i) => {
    const v = locked?.[i]
    return typeof v === 'number' && Number.isFinite(v) && v >= 4 ? Math.round(v) : null
  })
  const anyLocked = lock.some((v) => v !== null)
  // The one the quotient decides — the LAST free mesh, or none when all three
  // are held.
  const freeIdx = lock.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0)
  const derive = freeIdx.length > 0 ? freeIdx[freeIdx.length - 1] : -1
  const walk = [0, 1, 2].filter((i) => i !== derive)

  let bestCost = Infinity
  let best: Mesh[] | null = null

  const consider = (t: number[], p: number[], pinCost: number) => {
    const actual = (t[0] / p[0]) * (t[1] / p[1]) * (t[2] / p[2])
    // Rate error dominates by six orders of magnitude: an exact train is always
    // preferred to a prettier inexact one.
    const relErr = Math.abs(actual / target - 1)
    const spread = t.reduce((sum, ti, i) => sum + (Math.log(ti / p[i]) - ideal) ** 2, 0)
    const cost = relErr * 1e6 + spread + pinCost
    if (cost < bestCost) {
      bestCost = cost
      best = [0, 1, 2].map((i) => ({ teeth: t[i], pins: p[i] }))
    }
  }

  for (let p1 = floor; p1 <= floor + PIN_HEADROOM; p1++) {
    for (let p2 = floor; p2 <= floor + PIN_HEADROOM; p2++) {
      for (let p3 = floor; p3 <= floor + PIN_HEADROOM; p3++) {
        const pins = [p1, p2, p3]
        const pinCost = 0.01 * (p1 + p2 + p3 - 3 * floor)
        if (pinCost >= bestCost) continue
        const product = target * p1 * p2 * p3   // what T1·T2·T3 must come to

        if (derive < 0) {
          // Every count held: there is nothing to search, only to report.
          consider(lock as number[], pins, pinCost)
          continue
        }
        // A locked count is walked as itself and is NOT held to the ratio
        // bounds; a free one is walked over them.
        const range = (i: number): [number, number] => lock[i] !== null
          ? [lock[i]!, lock[i]!]
          : [Math.ceil(MIN_MESH_RATIO * pins[i]), Math.floor(MAX_MESH_RATIO * pins[i])]
        const [aLo, aHi] = range(walk[0])
        const [bLo, bHi] = range(walk[1])
        const [dLo, dHi] = range(derive)
        const t = [0, 0, 0]
        for (let a = aLo; a <= aHi; a++) {
          t[walk[0]] = a
          for (let b = bLo; b <= bHi; b++) {
            t[walk[1]] = b
            const d = Math.round(product / (a * b))
            if (d < dLo || d > dHi) continue
            t[derive] = d
            consider(t, pins, pinCost)
          }
        }
      }
    }
  }

  // Nothing in range at all (an absurd ratio). Fall back to an even split so the
  // caller always has a train to draw and a rate error to report — holding
  // whatever the user locked, since that is not the solver's to give up.
  if (!best) {
    const r = Math.exp(ideal)
    best = Array.from({ length: MESHES }, (_, i) => ({
      teeth: lock[i] ?? Math.max(4, Math.round(floor * r)),
      pins: floor,
    }))
  }

  // Descending, so the biggest wheel is the great wheel — the slow, high-torque
  // end of the train, which is where a wooden clock wants its material. NOT when
  // anything is locked: the locks are per wheel, and this would move them.
  if (!anyLocked) best.sort((a, b) => b.teeth / b.pins - a.teeth / a.pins)

  const actualRatio = best.reduce((r, m) => r * (m.teeth / m.pins), 1)
  // The hands advance as the great wheel turns, so a train that is too SLOW
  // (actual > target) makes the clock lose.
  const errorSecPerDay = 86400 * (target / actualRatio - 1)
  return {
    meshes: best,
    targetRatio: target,
    actualRatio,
    exact: Math.abs(errorSecPerDay) < 1e-6,
    errorSecPerDay,
  }
}

/** The ratio the going train has to produce for this spec. */
export function trainRatio(spec: ClockSpec): number {
  const escSec = escapeRevSeconds(spec.beatSeconds, spec.escapeTeeth)
  return (Math.max(0.1, spec.greatWheelMin) * 60) / escSec
}

// ─── The drive wheel ──────────────────────────────────────────────────────────

export interface DriveSolution {
  teeth: number
  pins: number
  /** Turns of cord the fall gives on this drum. */
  turns: number
  /** Hours the clock really runs, with the wheel rounded to a whole tooth. */
  runHours: number
  /** The requested run needed a wheel smaller than a wheel can be — it has been
   *  held at the floor, so the clock runs LONGER than asked. A shorter run wants
   *  a fatter drum or less fall, not a smaller wheel. */
  clampedSmall: boolean
}

/**
 * The wheel that carries the weight drum.
 *
 * Unlike the going train this is rounded, not solved: it sets running time, and
 * running time is not a rate. What comes back is the wheel and the run it really
 * gives, so the panel can report the difference rather than pretend.
 */
export function solveDrive(spec: ClockSpec, minPins: number): DriveSolution {
  const pins = Math.max(2, Math.round(minPins))
  const drum = Math.max(1, spec.drumDia)
  const turns = Math.max(0.01, spec.fallMM) / (Math.PI * drum)
  const greatHours = Math.max(0.001, spec.greatWheelMin) / 60
  // Hours the drive wheel is given for one revolution, and hence its ratio onto
  // the great wheel's pinion.
  const wanted = Math.max(0.001, spec.runHours) / turns / greatHours
  const floorTeeth = Math.max(8, Math.ceil(pins * MIN_MESH_RATIO))
  const raw = Math.round(pins * wanted)
  const teeth = Math.min(Math.max(raw, floorTeeth), Math.floor(pins * MAX_MESH_RATIO))
  return {
    teeth, pins, turns,
    runHours: turns * (teeth / pins) * greatHours,
    clampedSmall: raw < floorTeeth,
  }
}

// ─── The motion work ──────────────────────────────────────────────────────────
//
// The two extra wheels that drive the HOUR HAND off the minute arbor at 12:1.
// The going train ends at the great wheel turning once an hour, which carries
// the minute hand directly; the hour hand runs on a tube around that same arbor
// and has to be geared down from it.
//
// It is one reduction folded through an intermediate arbor, and it is 3 × 4 for
// a reason that is not taste. BOTH MESHES SPAN THE SAME PAIR OF ARBORS — the
// minute arbor and the intermediate one — because the hour wheel is CONCENTRIC
// with the minute arbor (its tube runs over the cannon pinion's). So the two
// centre distances are the same distance, and with a lantern pinion of P pins
// sitting on a pitch circle of `m·P/2` (`describingRadius`, the same rule the
// wheels' teeth are cut to) that says
//
//     P₁ + T₁ = P₂ + T₂,   T₁ = r₁·P₁,   T₂ = r₂·P₂,   r₁·r₂ = 12
//
// With r₁ = 3 and r₂ = 4 that is 4P₁ = 5P₂, so P₁ = 5k and P₂ = 4k for a whole
// number k and the counts come out 15k / 16k. At k = 2 they are the classic
// 10 / 30 and 8 / 32 of a real motion work, which is where those numbers come
// from. Split any other way — 2 × 6, say — and the same arithmetic gives 3P₁ =
// 7P₂, i.e. a three-pin pinion before anything else fits: the split is forced by
// the geometry, not chosen.
//
// The pin DRIVES THE WHEEL here, the opposite of the going train, so the tooth
// contact is on the wheel's flank rather than its face — and a cycloidal wheel's
// flank is cut radial (see gearGenerator), which is conjugate to nothing in
// particular. It is what a motion work always is: the load is the hands and the
// friction of the cannon-pinion clutch, so the drive is nearly free and the
// action only has to not jam. The readout says so rather than leaving it to be
// discovered.

/** The 12:1 split, and it is forced rather than chosen — see above. */
export const MOTION_RATIOS: readonly [number, number] = [3, 4]

/** k in the P₁ = 5k / P₂ = 4k family. 2 is the smallest that gives both pinions
 *  enough pins to be worth calling lanterns (8 and 10); 1 would ask for a
 *  four-pin one. A field, if anyone ever wants the motion work a size up. */
export const MOTION_SIZE = 2

export interface MotionWork {
  /** Pins on the cannon pinion — the driver, fixed to the minute arbor. */
  cannonPins: number
  /** Teeth on the minute wheel it drives, on the intermediate arbor. */
  minuteTeeth: number
  /** Pins on the pinion beside that wheel, on the same intermediate arbor. */
  minutePins: number
  /** Teeth on the hour wheel it drives, back on the minute arbor. */
  hourTeeth: number
  /** Minute arbor to intermediate arbor. ONE number: both meshes run at it, and
   *  that is the whole constraint the counts satisfy. */
  centreDistanceMM: number
  /** 12, by construction — stated so a caller can check rather than trust. */
  ratio: number
}

export function solveMotionWork(module: number, size = MOTION_SIZE): MotionWork {
  const m = Math.max(0.05, module)
  const k = Math.max(1, Math.round(size))
  const [r1, r2] = MOTION_RATIOS
  const cannonPins = 5 * k
  const minutePins = 4 * k
  const minuteTeeth = r1 * cannonPins
  const hourTeeth = r2 * minutePins
  return {
    cannonPins, minuteTeeth, minutePins, hourTeeth,
    // m(P+T)/2 either way round — the equality is the point.
    centreDistanceMM: (m * (cannonPins + minuteTeeth)) / 2,
    ratio: (minuteTeeth / cannonPins) * (hourTeeth / minutePins),
  }
}

// ─── Emitting the parts ───────────────────────────────────────────────────────

export type ClockPartKey =
  | 'drive' | 'great' | 'second' | 'third' | 'escapement' | 'pendulum'
  // The motion work, present only when it was asked for. Off the great arbor and
  // not in the going train: they change no rate and are on no arbor `clockPlate`
  // walks — see TRAIN_PART_ORDER.
  | 'minute' | 'hour'

/** The shapes the GOING TRAIN is made of — narrowed so every reader can reach
 *  the tooth counts without re-narrowing the whole ShapeParams union. The
 *  pendulum is deliberately not one of these: it hangs off the anchor and is on
 *  no arbor, so letting it into the type would put it in the mesh chain. */
export type ClockShapeParams = Extract<ShapeParams, { type: 'gear' } | { type: 'escapement' }>

/** …and everything a clock emits, the pendulum included. */
export type ClockPartParams = ClockShapeParams | Extract<ShapeParams, { type: 'pendulum' }>

export interface ClockPart {
  key: ClockPartKey
  /** Chip and group name — "Great Wheel". */
  name: string
  /** Revolutions of this arbor take this many seconds. The escapement's is its
   *  wheel's; the pendulum's is its own period. */
  revSeconds: number
  params: ClockPartParams
}

/** The defaults a clock's parts are built on — the user's own shape defaults,
 *  so a clock inherits whatever bore, hub, spokes and pin diameter they have
 *  already settled on. Only the counts and the module are overridden. */
export type ClockBase = Pick<ShapeToolConfig, 'gear' | 'escapement' | 'pendulum'>

export interface ClockDesign {
  train: TrainSolution
  drive: DriveSolution
  pendulumMM: number
  escRevSeconds: number
  /** The hour-hand gearing, when it was asked for. */
  motion: MotionWork | null
  parts: ClockPart[]
}

/**
 * Work out the whole clock and build every part's parameters.
 *
 * Each wheel takes `base.gear` wholesale and overrides exactly four things: the
 * module, its tooth count, the pins of the pinion it drives, and the profile —
 * a clock wheel running a lantern pinion must be cycloidal, since an involute
 * wheel is not conjugate to a pin and its ratio wobbles within every tooth. The
 * escapement takes `base.escapement` and overrides its tooth count and span.
 * Everything else — bore, hub, spokes, pin diameter, backlash, markings, the
 * escapement's whole geometry — is the user's default, untouched, and editable
 * per chip afterwards.
 */
export function designClock(spec: ClockSpec, base: ClockBase): ClockDesign {
  const escRev = escapeRevSeconds(spec.beatSeconds, spec.escapeTeeth)
  const train = solveTrain(trainRatio(spec), spec.minPins, spec.lockedTeeth)
  const drive = solveDrive(spec, spec.minPins)

  // Everything the TRAIN forces on a wheel, over the user's own Gear defaults.
  // Backlash and pin diameter are in that list rather than left to the defaults
  // because they are decisions about the CLOCK: every mesh in it runs on the
  // same play, and every lantern is pinned with the same rod — and on a
  // cycloidal wheel the pin diameter shapes the teeth, so wheels disagreeing
  // about it are cut for pins that are not in the clock.
  const pinDia = Math.max(0.1, spec.pinDia ?? base.gear.pinDia)

  // `pins` is the lantern this wheel DRIVES, on the next arbor; `carries` is the
  // one standing on its OWN arbor, driven by the wheel before it. The wheel is
  // that pinion's near cheek: its pins go through the wheel's hub, which grows
  // to hold them, and the loose cheek emitted by the previous wheel caps the far
  // ends. One part fewer per arbor, and the pins cannot creep round the wheel
  // the way a pinion glued to an arbor can.
  const wheel = (teeth: number, pins: number, carries = 0): ClockShapeParams => ({
    type: 'gear', cx: 0, cy: 0,
    ...base.gear,
    module: spec.module,
    teeth,
    toothProfile: 'cycloidal',
    mateTeeth: pins,
    backlash: Math.max(0, spec.backlash ?? base.gear.backlash),
    pinDia,
    emitPinion: true,
    ...(carries >= 2 ? {
      arborPins: carries,
      // The carried pinion's PITCH circle — m·P — since both meshes are cut to
      // the same module here.
      arborPinCircleDia: spec.module * carries,
      arborPinDia: pinDia,
    } : {}),
  })

  // Arbor periods, from the escape wheel backwards: each wheel turns its mesh
  // ratio slower than the one it drives.
  const [m1, m2, m3] = train.meshes
  const thirdSec = escRev * (m3.teeth / m3.pins)
  const secondSec = thirdSec * (m2.teeth / m2.pins)
  const greatActual = secondSec * (m1.teeth / m1.pins)

  // The hour hand's gearing, if asked for: two more wheels of the same kind, off
  // the great arbor rather than along the train. Its ratio is 12 whatever the
  // great wheel does, so a great wheel not turning once an hour makes the hour
  // hand wrong — which the readout says, since nothing here can fix it.
  const motion = spec.motionWork ? solveMotionWork(spec.module, spec.motionSize ?? MOTION_SIZE) : null

  const parts: ClockPart[] = [
    {
      // Nothing drives the drive wheel but the cord, so its arbor carries no
      // pinion — it is the one wheel in the clock with no pins through its hub.
      // What its hub IS is the drum: the cord winds on that arbor, and cutting
      // the hub to `drumDia` makes the wheel itself the drum's face, so the
      // winding has something to run against and the two cannot disagree about
      // a diameter the RUN TIME was worked out from. A floor like every other
      // hub — `seatHub` still grows it if the spokes need more, which the
      // readout reports, since then the cord would ride against the hub.
      key: 'drive', name: 'Drive Wheel',
      revSeconds: greatActual * (drive.teeth / drive.pins),
      params: { ...wheel(drive.teeth, drive.pins), hubDia: Math.max(0, spec.drumDia) },
    },
    {
      key: 'great', name: 'Great Wheel', revSeconds: greatActual,
      params: wheel(m1.teeth, m1.pins, drive.pins),
    },
    // In CLOCK_PART_ORDER position: straight after the wheel whose arbor they
    // hang off. Each is emitted with the lantern it MESHES with, exactly as a
    // train wheel is — the difference is which of the pair drives, which changes
    // nothing about the two parts to be cut.
    ...(motion ? [
      {
        // Its arbor is the stud, and the pinion on it is the one driving the hour
        // wheel — so the minute wheel carries those pins, and the hour wheel's
        // emitted lantern is their cheek.
        key: 'minute' as const, name: 'Minute Wheel',
        revSeconds: greatActual * (motion.minuteTeeth / motion.cannonPins),
        params: wheel(motion.minuteTeeth, motion.cannonPins, motion.minutePins),
      },
      {
        key: 'hour' as const, name: 'Hour Wheel',
        revSeconds: greatActual * motion.ratio,
        params: wheel(motion.hourTeeth, motion.minutePins),
      },
    ] : []),
    { key: 'second', name: 'Second Wheel', revSeconds: secondSec, params: wheel(m2.teeth, m2.pins, m1.pins) },
    { key: 'third',  name: 'Third Wheel',  revSeconds: thirdSec,  params: wheel(m3.teeth, m3.pins, m2.pins) },
    {
      key: 'escapement', name: 'Escapement', revSeconds: escRev,
      params: {
        type: 'escapement', cx: 0, cy: 0,
        ...base.escapement,
        teeth: Math.max(6, Math.round(spec.escapeTeeth)),
        // It carries the third wheel's pinion, like every other driven wheel —
        // and it is the one wheel that cannot work the pin circle out for
        // itself, having no module of its own.
        arborPins: m3.pins,
        arborPinCircleDia: spec.module * m3.pins,
        arborPinDia: pinDia,
      },
    },
    // Last, and on no arbor at all — it hangs from the anchor. Its LENGTH is the
    // whole of it and comes straight back from the beat the clock was designed
    // for; everything else about it (rod width, bob size, the hanging hole) is
    // the user's Pendulum default, untouched, exactly as the wheels take theirs.
    {
      key: 'pendulum', name: 'Pendulum', revSeconds: 2 * Math.max(0.05, spec.beatSeconds),
      params: {
        type: 'pendulum', cx: 0, cy: 0,
        ...base.pendulum,
        length: pendulumLengthMM(spec.beatSeconds),
      },
    },
  ]

  return {
    train, drive, parts, motion,
    pendulumMM: pendulumLengthMM(spec.beatSeconds),
    escRevSeconds: escRev,
  }
}

// ─── Layout ───────────────────────────────────────────────────────────────────

/**
 * Lay the parts out shelf-packed and CENTRED ON THE STOCK, wrapping downward.
 *
 * Centred rather than run out from a corner because these are big: an m4
 * 48-tooth wheel is 200 mm across against a 300 mm stock, so nearly every part
 * takes a row to itself and a corner-anchored pack comes out as a column hugging
 * one edge and trailing off the bottom. Centred, the block straddles the middle
 * whatever it does not fit.
 *
 * They are placed CLEAR of each other, never at their true centre distances —
 * these are parts to be cut, and two wheels drawn in mesh would overlap on the
 * stock. The spacings a plate is drilled from are reported by the panel instead.
 *
 * Each part is measured from its own emitted geometry rather than from a formula
 * per shape: a gear's bbox includes the pinion drawn beside it and an
 * escapement's includes its anchor, and neither is worth restating here.
 *
 * ORDER IS PRESERVED, including for a part with no geometry — callers index the
 * result against the parts they passed in.
 */
export function layoutClock(
  parts: ClockPart[],
  centre: { x: number; y: number },
  maxWidth: number,
  gap: number,
): ClockPart[] {
  const measured = parts.map((p) => {
    const geo = generateShapeParts(p.params)
    const box = geo ? getMultiBBox(geo.map((g) => g.d)) : null
    return { part: p, box }
  })

  type Item = (typeof measured)[number]
  interface Row { items: Item[]; w: number; h: number }
  const rows: Row[] = []
  let row: Row = { items: [], w: 0, h: 0 }

  for (const m of measured) {
    const w = m.box ? m.box.maxX - m.box.minX : 0
    const h = m.box ? m.box.maxY - m.box.minY : 0
    const would = row.items.length === 0 ? w : row.w + gap + w
    if (row.items.length > 0 && would > maxWidth) {
      rows.push(row)
      row = { items: [], w: 0, h: 0 }
    }
    row.w = row.items.length === 0 ? w : row.w + gap + w
    row.h = Math.max(row.h, h)
    row.items.push(m)
  }
  if (row.items.length > 0) rows.push(row)

  const totalH = rows.reduce((t, r) => t + r.h, 0) + gap * Math.max(0, rows.length - 1)
  let top = centre.y + totalH / 2      // rows stack DOWNWARD from the block's top edge

  const out: ClockPart[] = []
  for (const r of rows) {
    let x = centre.x - r.w / 2
    for (const { part, box } of r.items) {
      if (!box) { out.push(part); continue }
      // Params are at (0,0); shift so the part's bbox starts at the cursor and
      // hangs from the row's top edge. `translateShapeParams` preserves the
      // variant it is handed — its return type just cannot say so.
      const moved = translateShapeParams(part.params, x - box.minX, top - box.maxY) as ClockPartParams
      out.push({ ...part, params: moved })
      x += (box.maxX - box.minX) + gap
    }
    top -= r.h + gap
  }
  return out
}

// ─── Assembled: where the arbors go, and where everything stands ──────────────
//
// The parts are drawn CLEAR of each other on the stock, which leaves the one
// question a drawing of five wheels cannot answer: assembled, does the train
// run? `clockPlate` puts the arbors at their true spacings and `clockPose`
// turns everything from the escapement's own kinematics, which is what the
// canvas preview (canvas/layers/ClockAnimLayer.tsx) draws.
//
// TWO THINGS ARE TRUE OF THIS AND EASY TO GET WRONG.
//
// (1) Only the DISTANCES between arbors are forced — the directions are the
//     plate designer's choice, since a mesh only cares that the pitch circles
//     are tangent. So the angles are the USER'S (`ClockSpec.linkAngles`, dragged
//     on the canvas), and `defaultLinkAngles` is only where a clock starts.
//
//     THE CHAIN IS ROOTED AT THE ESCAPE ARBOR and walks BACKWARDS from it to the
//     drive wheel. That is not a convenience. The anchor sits +y from the escape
//     wheel in the escapement's own frame and the pendulum hangs from the anchor,
//     so rooting anywhere else would let a link angle tip the escapement — the
//     anchor would stop being above its wheel and the pendulum would hang
//     sideways, which means rotating the escapement's whole drawn frame and
//     re-checking `escapementPose`. Rooted here, none of that geometry moves at
//     all. It is also how a movement is really laid out: the pendulum defines the
//     vertical, the escapement is fixed to it, and the train is arranged round it.
//
// (2) SUCCESSIVE WHEELS OVERLAP IN PLAN VIEW, and that is correct, not a bug to
//     lay out around. The great wheel's radius plus the second wheel's is 200 mm
//     against a 120 mm centre distance: they cannot help but overlap, because in
//     a real movement each wheel meshes with the NEXT ARBOR'S PINION and the two
//     wheels sit at different depths between the plates. Trying to separate them
//     would mean lying about the spacings. It is the same fact `gearMateParts`
//     handles by drawing a lantern's cheek dashed — the preview draws the wheels
//     translucent and in different hues for the same reason.

/**
 * The least a caller needs to stand a clock up: the parts in TRAIN ORDER with
 * their current parameters. `designClock`'s output satisfies it (less the
 * pendulum, which is on no arbor), and so does a set of live paths gathered back
 * out of the document by their `clockId` — which is the point, since by then each
 * wheel has been edited on its own and the assembly must be read from what is
 * actually there rather than from the spec it came from.
 */
export type ClockAssembly = { key: ClockPartKey; params: ClockShapeParams }[]

/** A gear's parameters, narrowed — the motion work is two of them. */
export type ClockGearParams = Extract<ShapeParams, { type: 'gear' }>

/**
 * The motion work as an assembly: the two wheels, read back out of the document
 * the same way the train is.
 *
 * Separate from `ClockAssembly` because it is a BRANCH, not more of the chain —
 * letting it into the train's array would put its wheels on arbors of their own
 * and `clockPose` would gear the escapement through them. Both wheels or
 * nothing: one of them alone cannot be stood up, since the pair is what fixes
 * the intermediate arbor.
 */
export interface ClockMotion {
  /** On the intermediate arbor, driven by the cannon pinion. */
  minute: ClockGearParams
  /** Back on the minute arbor, driven by the pinion beside the minute wheel. */
  hour: ClockGearParams
}

export interface ClockArbor {
  /** Which part's WHEEL sits on this arbor. The pinion on it (for every arbor
   *  but the first) was emitted by the part BEFORE it. */
  key: ClockPartKey
  x: number
  y: number
  /** Radius of the wheel on this arbor — its tips, for extent and for drawing. */
  wheelRadius: number
  /** Direction to the next arbor, radians CCW from +x. Meaningless on the last. */
  toNext: number
  /** Distance to the next arbor: this wheel's pitch radius plus its pinion's,
   *  which is where the two pitch circles come tangent. 0 on the last. */
  centreDistance: number
}

/** Where the motion work stands, when the clock has one. */
export interface ClockPlateMotion {
  /** Index in `arbors` of the arbor it hangs off — the great wheel's, which is
   *  the minute arbor. The HOUR WHEEL sits on that same arbor, concentric with
   *  it, so it has no position of its own. */
  hostIdx: number
  /** The intermediate arbor, carrying the minute wheel and its pinion. */
  x: number
  y: number
  /** Host to intermediate. ONE distance: both meshes run at it (see
   *  `solveMotionWork`), and it is taken from the MINUTE wheel — if a hand edit
   *  has left the hour wheel wanting a different one, the drawing shows that
   *  mesh standing off rather than quietly splitting the difference. */
  centreDistance: number
  minuteRadius: number
  hourRadius: number
}

export interface ClockPlate {
  /** drive, great, second, third, escape — the going train, in order. */
  arbors: ClockArbor[]
  /** The hour hand's gearing, if the clock has any. */
  motion: ClockPlateMotion | null
  /** The pallet arbor, straight above the escape wheel at the escapement's own
   *  centre distance (which is how the escapement generator lays it out). */
  anchor: { x: number; y: number }
  /** Everything the assembly occupies, for centring it on the canvas. */
  bbox: { minX: number; minY: number; maxX: number; maxY: number }
}

/**
 * Stand the train up, with the ESCAPE ARBOR AT THE ORIGIN and everything walked
 * back from it to the drive wheel. `clockRoot` says where that origin goes on
 * the stock; nothing here knows about the stock at all.
 *
 * `angles` are `ClockSpec.linkAngles` — link *i* runs from arbor *i* to arbor
 * *i+1*. Omitted or short, it defaults per element (see `linkAngleAt`).
 */
export function clockPlate(parts: ClockAssembly, angles?: number[], motionParts?: ClockMotion | null): ClockPlate | null {
  if (parts.length < 2) return null
  const n = parts.length

  // Each arbor's wheel radius, and the distance to the NEXT arbor — a property
  // of the gear on this one (its pitch radius plus its pinion's, where the two
  // pitch circles come tangent). The escape wheel ends the train: what follows
  // it is the anchor, not another arbor.
  const radius: number[] = []
  const dist: number[] = []
  for (let i = 0; i < n; i++) {
    const p = parts[i]
    if (p.params.type === 'gear') {
      const g = p.params
      const dims = gearDims(g.module, g.teeth, g.pressureAngle, g.backlash, { mateTeeth: g.mateTeeth, pinDia: g.pinDia })
      radius.push(dims.outsideDia / 2)
      dist.push(i === n - 1 ? 0 : (pinionDims(g)?.centreDistance ?? 0))
    } else {
      radius.push(p.params.wheelDia / 2)
      dist.push(0)
    }
  }

  // Backwards from the escape arbor at (0,0).
  const xs = new Array<number>(n).fill(0)
  const ys = new Array<number>(n).fill(0)
  for (let k = n - 2; k >= 0; k--) {
    const th = linkAngleAt(angles, k)
    xs[k] = xs[k + 1] - dist[k] * Math.cos(th)
    ys[k] = ys[k + 1] - dist[k] * Math.sin(th)
  }

  const arbors: ClockArbor[] = parts.map((p, i) => ({
    key: p.key,
    x: xs[i], y: ys[i],
    wheelRadius: radius[i],
    // The last arbor has no next; +y is where its anchor goes.
    toNext: i === n - 1 ? Math.PI / 2 : linkAngleAt(angles, i),
    centreDistance: dist[i],
  }))

  const escPart = parts[n - 1]
  const escArbor = arbors[n - 1]
  const anchorGap = escPart.params.type === 'escapement' ? escapementDims(escPart.params).centreDistance : 0
  const anchor = { x: escArbor.x, y: escArbor.y + anchorGap }

  // The motion work hangs off the GREAT arbor — the minute arbor — at an angle
  // that is the user's, like every other link. Its own wheel is on the host
  // arbor itself, so only the intermediate one has to be placed.
  let motion: ClockPlateMotion | null = null
  const hostIdx = parts.findIndex((p) => p.key === 'great')
  if (motionParts && hostIdx >= 0) {
    const host = arbors[hostIdx]
    const th = linkAngleAt(angles, MOTION_LINK)
    const cd = pinionDims(motionParts.minute)?.centreDistance ?? 0
    const rOf = (g: ClockGearParams) =>
      gearDims(g.module, g.teeth, g.pressureAngle, g.backlash, { mateTeeth: g.mateTeeth, pinDia: g.pinDia })
        .outsideDia / 2
    motion = {
      hostIdx,
      x: host.x + cd * Math.cos(th),
      y: host.y + cd * Math.sin(th),
      centreDistance: cd,
      minuteRadius: rOf(motionParts.minute),
      hourRadius: rOf(motionParts.hour),
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const span = (x: number, y: number, r: number) => {
    minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r)
    minY = Math.min(minY, y - r); maxY = Math.max(maxY, y + r)
  }
  for (const a of arbors) span(a.x, a.y, a.wheelRadius)
  if (motion) {
    span(motion.x, motion.y, motion.minuteRadius)
    span(arbors[motion.hostIdx].x, arbors[motion.hostIdx].y, motion.hourRadius)
  }
  // The anchor's arms reach back over the wheel, so its own arbor is the only
  // point past the wheel that has to be counted.
  maxY = Math.max(maxY, anchor.y)
  return { arbors, anchor, motion, bbox: { minX, minY, maxX, maxY } }
}

/**
 * The angle that swings joint `nodeIdx` as near the cursor as its link allows.
 *
 * The LENGTH is not negotiable — it is the centre distance that mesh runs at —
 * so the joint rides a circle about the arbor it hangs from, and only the angle
 * is free. That arbor is the NEXT one along, toward the escapement, because the
 * chain is rooted there: link *k* runs from arbor *k* to arbor *k+1*, so
 * `angles[k]` is the direction from the dragged joint towards its parent, i.e.
 * `atan2(parent − cursor)` and not the other way round.
 *
 * Writing `angles[k]` alone is the whole of the drag: everything toward the
 * drive wheel is built off this joint with its own angles intact and so
 * translates rigidly, and everything toward the escapement does not move at all.
 *
 * `plate` is in its own frame with the escape arbor at the origin; `root` is
 * where that origin sits, so the cursor can be passed in plain path coordinates.
 * Returns degrees, snapped if asked.
 */
export function dragLinkAngle(
  plate: ClockPlate,
  root: { x: number; y: number },
  nodeIdx: number,
  cursor: { x: number; y: number },
  snapDeg = 0,
): number | null {
  // THE MOTION BRANCH IS MEASURED THE OTHER WAY ROUND. Along the train the
  // dragged joint is the CHILD's arbor and its parent is the next one toward the
  // escapement, so the angle wanted is from the joint to the parent. The motion
  // arbor hangs off a great arbor that is itself fixed by the chain, so here the
  // parent is the anchor point and the angle runs from IT to the cursor.
  if (nodeIdx === MOTION_LINK) {
    const m = plate.motion
    if (!m) return null
    const host = plate.arbors[m.hostIdx]
    const hx = root.x + host.x, hy = root.y + host.y
    if (Math.abs(hx - cursor.x) < 1e-9 && Math.abs(hy - cursor.y) < 1e-9) return null
    const deg = (Math.atan2(cursor.y - hy, cursor.x - hx) * 180) / Math.PI
    return snapDeg > 0 ? Math.round(deg / snapDeg) * snapDeg : deg
  }
  const parent = plate.arbors[nodeIdx + 1]
  if (!parent) return null              // the root itself, or off the end
  const fx = root.x + parent.x, fy = root.y + parent.y
  // Degenerate only if the cursor is exactly on the parent arbor, where every
  // angle is equally good — hold the current one rather than snapping to 0.
  if (Math.abs(fx - cursor.x) < 1e-9 && Math.abs(fy - cursor.y) < 1e-9) return null
  const deg = (Math.atan2(fy - cursor.y, fx - cursor.x) * 180) / Math.PI
  return snapDeg > 0 ? Math.round(deg / snapDeg) * snapDeg : deg
}

/** An arbor running through the space a wheel turns in. `depth` is how far
 *  inside that wheel's tip circle it falls. */
export interface ClockArborClash {
  arbor: ClockPartKey | 'motion' | 'anchor'
  wheel: ClockPartKey | 'minute' | 'hour'
  depthMM: number
}

/**
 * Arbors that pass through a wheel they do not belong to — which is fatal,
 * unlike two wheels overlapping.
 *
 * THE DIFFERENCE IS DEPTH. Wheels a mesh apart always overlap in plan view and
 * are meant to: each meshes with the NEXT arbor's pinion, and the two sit at
 * different depths along their arbors, so the outlines cross and the material
 * never does (`clockWheelClashes` ignores neighbours for exactly this reason).
 * An ARBOR is not at a depth — it is a rod running the whole way from plate to
 * plate, so it sweeps every depth, and a wheel whose tip circle contains one has
 * nowhere to turn.
 *
 * A normal train never trips it, and the reason is worth knowing: the centre
 * distance is the wheel's pitch radius plus its pinion's, while the wheel
 * reaches one addendum past its pitch circle — so it clears the next arbor by
 * `m·(pins/2 − 1)`, which is 20 mm for a 12-pin m4 pinion and shrinks as the
 * pinion does. Folding the linkage tight is what breaks it.
 *
 * TWO SPACES, NOT ONE. The going train runs between the plates; the motion work
 * runs in FRONT of the front plate, its stud fixed to that plate and the hour
 * wheel on a tube over the minute arbor. So the stud landing inside the great
 * wheel is not a clash — they are on opposite sides of the plate, the same way
 * neighbouring wheels are at different depths — and only bodies sharing a space
 * are compared. In front there are just two shafts: the stud, and the minute
 * arbor coming through to carry the cannon pinion.
 */
export function clockArborClashes(plate: ClockPlate): ClockArborClash[] {
  const out: ClockArborClash[] = []
  const a = plate.arbors
  const test = (
    arbor: ClockArborClash['arbor'], ax: number, ay: number,
    wheel: ClockArborClash['wheel'], wx: number, wy: number, r: number,
  ) => {
    const d = Math.hypot(ax - wx, ay - wy)
    if (d < r) out.push({ arbor, wheel, depthMM: r - d })
  }

  // Between the plates: every arbor against every wheel but its own, the PALLET
  // arbor included — it is a rod like the others, and folding a train tight can
  // bring a wheel over it. Its own escape wheel is exempt: the anchor is placed
  // where the tangents to the tip circle cross, so it always stands outside it,
  // and the pallets sweeping that wheel is the whole point of an escapement.
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a.length; j++) {
      if (i === j) continue
      test(a[j].key, a[j].x, a[j].y, a[i].key, a[i].x, a[i].y, a[i].wheelRadius)
    }
    if (i < a.length - 1) {
      test('anchor', plate.anchor.x, plate.anchor.y, a[i].key, a[i].x, a[i].y, a[i].wheelRadius)
    }
  }

  // In front of it: the minute wheel must clear the minute arbor it is driven
  // from, and the hour wheel must clear the stud the minute wheel turns on.
  // Both hold by construction at any sane size — they are here because a wheel
  // edited by hand can break them, and nothing else would say so.
  const m = plate.motion
  if (m) {
    const host = a[m.hostIdx]
    test(host.key, host.x, host.y, 'minute', m.x, m.y, m.minuteRadius)
    test('motion', m.x, m.y, 'hour', host.x, host.y, m.hourRadius)
  }
  return out
}

/**
 * Pairs of wheels that collide, ignoring neighbours.
 *
 * SUCCESSIVE wheels overlap by design — each meshes with the next arbor's pinion
 * and the two sit at different depths between the plates — so a neighbour
 * overlap is not a fault and is never reported. Two wheels that are NOT
 * neighbours have no reason to share space, though: fold a train far enough and
 * the drive wheel lands on the third, which is a real collision and the thing a
 * maker needs telling about while arranging.
 *
 * A warning, not a block. It is the user's frame, and they may be planning to
 * put those two on different plates.
 */
export function clockWheelClashes(plate: ClockPlate): [number, number][] {
  const out: [number, number][] = []
  const a = plate.arbors
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 2; j < a.length; j++) {
      if (Math.hypot(a[j].x - a[i].x, a[j].y - a[i].y) < a[i].wheelRadius + a[j].wheelRadius) {
        out.push([i, j])
      }
    }
  }
  return out
}

/** Stock left above the escapement. */
const ROOT_MARGIN = 10

/**
 * Where the escape arbor goes on the stock — and it NEVER moves.
 *
 * There is no centring here, at any point: not on entry to a mode, not on
 * commit, not per frame. Centring the assembly's bounding box (which the preview
 * used to do) makes the whole clock slide under the cursor while the user
 * arranges it, because the box changes with the arrangement. Instead:
 *
 *   • X — centred on the stock.
 *   • Y — at the TOP, the escapement's own extent sitting a margin below `h`.
 *     That is where a movement's escapement really is, with the pendulum hanging
 *     below through the frame.
 *
 * It is a pure function of the stock and the ESCAPEMENT ALONE, so it cannot
 * depend on the arrangement and therefore cannot drift as the user drags. Both
 * the preview and the linkage editor call it, so they cannot disagree about
 * where the clock is.
 *
 * Note the stock is `[0,w]×[0,h]` in path space whatever the XY origin says —
 * `originWorldXY` is a DISPLAY and G-code offset and must not appear here. That
 * mistake moved the whole clock by −origin once already.
 *
 * It generates the escapement to measure it, so keep it inside a memo.
 */
export function clockRoot(
  stockW: number,
  stockH: number,
  esc: ClockShapeParams | undefined,
): { x: number; y: number } {
  let top = 0
  if (esc?.type === 'escapement') {
    const geo = generateShapeParts({ ...esc, cx: 0, cy: 0 })
    const box = geo ? getMultiBBox(geo.map((g) => g.d)) : null
    if (box) top = Math.max(0, box.maxY)
  }
  return { x: stockW / 2, y: stockH - ROOT_MARGIN - top }
}

export interface ClockPose {
  /** Wheel rotation on each arbor, degrees CCW, index-matched to `plate.arbors`. */
  wheelDeg: number[]
  /** The lantern pinion standing on each arbor — the one the PREVIOUS wheel
   *  drives. Index 0 is meaningless: nothing drives the drive wheel but the cord. */
  pinionDeg: number[]
  /** The pallets, about the anchor arbor. */
  anchorDeg: number
  /** The motion work, when the clock has one. */
  motion: ClockPoseMotion | null
}

export interface ClockPoseMotion {
  /** The minute wheel AND the pinion beside it — one body on the intermediate
   *  arbor, so one angle (their relative clocking is free, as everywhere else a
   *  wheel and a pinion share an arbor). */
  minuteDeg: number
  /** The hour wheel, about the host arbor it is concentric with. */
  hourDeg: number
  /** The cannon pinion, on that same host arbor — FIXED to it in a real clock
   *  through the friction clutch, so it simply turns with the great wheel. */
  cannonDeg: number
}

/**
 * Where everything stands at a given moment. `phase` counts escapement PERIODS
 * and runs past 1 — the wheel advances one tooth per period and nothing resets.
 *
 * THE ESCAPEMENT IS THE MASTER, and the chain is solved BACKWARDS from it. That
 * is not a convenience: the escapement is the only part of a clock with any
 * kinematics of its own (impulse, drop, lock — see `escapementPose`), and every
 * other arbor is rigidly geared to it. Driving the train forwards and hoping the
 * escape wheel came out where the escapement wanted it would be two answers to
 * one question.
 *
 * THE PHASE OF EACH MESH IS THE WHOLE OF IT AND IT FAILS SILENTLY — get it wrong
 * and nothing errors, the preview just draws pins through teeth. `gearMesh`
 * already solves it for a mate lying along +x; here the mate lies along θ, so
 * the whole two-body assembly is rotated by θ about the wheel's centre, which
 * turns BOTH bodies by θ as well as moving the mate. Hence the θ terms:
 *
 *     pinion = matePhase + θ − (wheel − θ)·ratio
 *
 * which is `gearPose` exactly when θ = 0. Solved the other way round here,
 * because it is the pinion angle that is known and the wheel behind it that is
 * wanted. Proven against the emitted outlines by scripts/clock-mesh-check.mts.
 *
 * Where a wheel and a pinion share an arbor their relative clocking is FREE —
 * a maker glues the lantern on at any angle — so it is taken as zero. Nothing
 * downstream may assume otherwise.
 *
 * EVERY WHEEL TURNS THE OTHER WAY FROM THE ONE IT DRIVES, and each mesh's play
 * has to be taken up on the flank ITS OWN wheel is pushing — so the sense
 * alternates back along the chain from the escape wheel and is handed to
 * `gearMesh`. Its default is a gear running CCW, which is right for half the
 * train and backwards for the other half: the drive shows as slop ahead of the
 * pin instead of behind it, which reads as the pinion driving the wheel. Nothing
 * errors, and no clearance check can see it — the pair runs cleanly either way,
 * it is simply resting on the wrong side of its play.
 */
export function clockPose(
  parts: ClockAssembly,
  plate: ClockPlate,
  phase: number,
  motionParts?: ClockMotion | null,
): ClockPose {
  const n = plate.arbors.length
  const wheelDeg = new Array<number>(n).fill(0)
  const pinionDeg = new Array<number>(n).fill(0)
  const senses = new Array<1 | -1>(n).fill(1)

  const escPart = parts[n - 1]
  const esc = escPart.params.type === 'escapement' ? escapementPose(escPart.params, phase) : { wheelDeg: 0, anchorDeg: 0 }
  wheelDeg[n - 1] = esc.wheelDeg
  // The escape pinion, clocked with the escape wheel (free choice, see above).
  pinionDeg[n - 1] = esc.wheelDeg

  // The escape wheel's own sense: `escapementPose` runs a clockwise wheel through
  // falling angles. Each mesh reverses it, so wheel k turns against wheel k+1.
  let sense: 1 | -1 = escPart.params.type === 'escapement' && escPart.params.clockwise ? -1 : 1
  senses[n - 1] = sense

  for (let k = n - 2; k >= 0; k--) {
    sense = sense === 1 ? -1 : 1
    senses[k] = sense
    const p = parts[k]
    if (p.params.type !== 'gear') continue
    const mesh = gearMesh(p.params, sense)
    const th = (plate.arbors[k].toNext * 180) / Math.PI
    wheelDeg[k] = th + (mesh.matePhaseDeg + th - pinionDeg[k + 1]) / mesh.ratio
    pinionDeg[k] = wheelDeg[k]
  }

  return {
    wheelDeg, pinionDeg, anchorDeg: esc.anchorDeg,
    motion: motionPose(motionParts, plate, wheelDeg, senses),
  }
}

/**
 * The motion work's two bodies, solved off the great wheel.
 *
 * Same solve as a train mesh and the same trap: the phase is the whole of it and
 * a wrong one draws pins through teeth without erroring. `gearMesh` puts the
 * mate along +x, so each mesh is turned by the angle it really lies at — from
 * the WHEEL to its mate, which for the minute wheel is back towards the host
 * arbor (θ + 180°) and for the hour wheel is out along the branch (θ).
 *
 * TWO THINGS ARE BACKWARDS HERE COMPARED WITH THE TRAIN, and both follow from
 * the pinion being the driver:
 *
 *   • the KNOWN angle is the mate's, not the wheel's, for both meshes — the
 *     cannon pinion is fixed to the great arbor and the minute pinion is fixed
 *     to the minute wheel — which is the same inversion `clockPose` already does
 *     along the train, so the formula is the same one;
 *   • the SETTLE is inverted (`-sense`). `gearMesh` shifts the mate onto the
 *     flank the GEAR is pushing; here the mate pushes the gear, so the play is
 *     taken up on the other side. Nothing errors either way — it is the same
 *     silent "reads as the pinion driving the wheel" as along the train, except
 *     that here the pinion really is driving.
 */
function motionPose(
  motionParts: ClockMotion | null | undefined,
  plate: ClockPlate,
  wheelDeg: number[],
  senses: (1 | -1)[],
): ClockPoseMotion | null {
  const m = plate.motion
  if (!motionParts || !m) return null

  // The cannon pinion turns WITH the great wheel — it is fixed to that arbor
  // through the clutch that lets the hands be set.
  const cannonDeg = wheelDeg[m.hostIdx]
  const hostSense = senses[m.hostIdx]
  const th = (Math.atan2(m.y - plate.arbors[m.hostIdx].y, m.x - plate.arbors[m.hostIdx].x) * 180) / Math.PI

  // Minute wheel: on the intermediate arbor, its mate (the cannon pinion) lying
  // back along the branch. Driven, so it turns against the great wheel.
  const minuteSense: 1 | -1 = hostSense === 1 ? -1 : 1
  const mm = gearMesh(motionParts.minute, minuteSense === 1 ? -1 : 1)
  const thMinute = th + 180
  const minuteDeg = thMinute + (mm.matePhaseDeg + thMinute - cannonDeg) / mm.ratio

  // Hour wheel: back on the host arbor, its mate (the pinion beside the minute
  // wheel, clocked with it) out along the branch. Turns with the great wheel
  // again, which is why both hands go round the same way.
  const hm = gearMesh(motionParts.hour, hostSense === 1 ? -1 : 1)
  const hourDeg = th + (hm.matePhaseDeg + th - minuteDeg) / hm.ratio

  return { minuteDeg, hourDeg, cannonDeg }
}

/** Emission order — everything a clock CAN be cut from. The motion work is in
 *  it only when the spec asks for it, so compare against `designClock`'s output
 *  rather than assuming the whole list. It sits straight after the great wheel
 *  because that is the arbor it hangs off. */
export const CLOCK_PART_ORDER: ClockPartKey[] =
  ['drive', 'great', 'minute', 'hour', 'second', 'third', 'escapement', 'pendulum']

/** …and the subset that is the GOING TRAIN, arbor by arbor. The pendulum is on
 *  no arbor, so it is not here: `clockPlate` would try to mesh it. */
export const TRAIN_PART_ORDER: ClockPartKey[] = ['drive', 'great', 'second', 'third', 'escapement']

/**
 * Gather a clock back out of the document.
 *
 * The five wheels are ordinary independent shapes once emitted — several paths
 * each, all carrying the same `shapeParams` — so this takes the FIRST path of
 * each `clockPart` and reads its current parameters. Which means the assembly
 * reflects every edit made to a wheel since, including edits that break the
 * train; that is the honest answer, and the preview showing a broken mesh is
 * more use than one showing the clock as designed.
 *
 * Returns the parts in train order, dropping any whose paths have been deleted —
 * a caller must handle a short list rather than assume five.
 */
export function clockAssemblyFromPaths(
  paths: { clockId?: string; clockPart?: string; shapeParams?: ShapeParams }[],
  clockId: string,
): ClockAssembly {
  const out: ClockAssembly = []
  for (const key of TRAIN_PART_ORDER) {
    const hit = paths.find((p) =>
      p.clockId === clockId && p.clockPart === key &&
      (p.shapeParams?.type === 'gear' || p.shapeParams?.type === 'escapement'))
    if (hit) out.push({ key, params: hit.shapeParams as ClockShapeParams })
  }
  return out
}

/**
 * The motion work, from the same paths — BOTH wheels or nothing.
 *
 * One of them alone cannot be stood up: the intermediate arbor is where the two
 * meshes agree, so a clock with only its hour wheel left has nowhere to put it.
 */
export function clockMotionFromPaths(
  paths: { clockId?: string; clockPart?: string; shapeParams?: ShapeParams }[],
  clockId: string,
): ClockMotion | null {
  const of = (key: ClockPartKey) => {
    const hit = paths.find((p) =>
      p.clockId === clockId && p.clockPart === key && p.shapeParams?.type === 'gear')
    return hit ? (hit.shapeParams as ClockGearParams) : null
  }
  const minute = of('minute'), hour = of('hour')
  return minute && hour ? { minute, hour } : null
}

/**
 * The clock's pendulum, from the same paths.
 *
 * Separate from `clockAssemblyFromPaths` because a pendulum is on NO ARBOR — it
 * hangs from the pallet arbor — so letting it into the assembly would put it in
 * the mesh chain that `clockPlate` walks.
 */
export function clockPendulumFromPaths(
  paths: { clockId?: string; clockPart?: string; shapeParams?: ShapeParams }[],
  clockId: string,
): Extract<ShapeParams, { type: 'pendulum' }> | null {
  const hit = paths.find((p) =>
    p.clockId === clockId && p.clockPart === 'pendulum' && p.shapeParams?.type === 'pendulum')
  return hit ? (hit.shapeParams as Extract<ShapeParams, { type: 'pendulum' }>) : null
}
