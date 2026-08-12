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
const MIN_MESH_RATIO = 1.5
const MAX_MESH_RATIO = 12
// How far above `minPins` the solver may go looking for an exact train. Each
// extra pin makes every wheel on that mesh bigger for the same ratio, so this is
// a last resort and is priced as one below.
const PIN_HEADROOM = 3

/** Degrees each link of the untouched train leans off vertical, alternating
 *  sides. A DRAWING choice — only the link LENGTHS are forced (a mesh cares
 *  only that the pitch circles are tangent), so this is just where a clock
 *  starts before anyone arranges it. */
const TRAIN_LEAN_DEG = 22

/** The lean as link angles: up and alternately left/right, which keeps the
 *  train compact and vertical and leaves the middle clear for the pendulum. */
export function defaultLinkAngles(links = TRAIN_WHEELS): number[] {
  return Array.from({ length: links }, (_, i) => 90 + (i % 2 === 0 ? 1 : -1) * TRAIN_LEAN_DEG)
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
  const deg = Number.isFinite(a) ? (a as number) : 90 + (i % 2 === 0 ? 1 : -1) * TRAIN_LEAN_DEG
  return (deg * Math.PI) / 180
}

export interface ClockSpec {
  /** Seconds per beat — HALF the pendulum's period, and the number a clock is
   *  actually described by ("a seconds pendulum"). Sets the pendulum length. */
  beatSeconds: number
  /** Escape wheel teeth. With a one-second beat, 30 turns it once a minute. */
  escapeTeeth: number
  /** Fewest pins any lantern pinion in the train may have. A lantern pinion with
   *  too few pins has a coarse, lumpy action, so this is the floor the solver
   *  works up from — it is not a target. */
  minPins: number
  /** Minutes per revolution of the great wheel. 60 puts the minute hand on it. */
  greatWheelMin: number
  /** Tooth size for the whole going train, mm. */
  module: number
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

/**
 * Teeth the pallets span. Must be an integer plus a half or the pallets cannot
 * alternate (the wheel gives up half a tooth per beat) — see EscapementSpec.span.
 * N/4 rounded to the nearest half tooth is the classic choice; 30 teeth gives
 * the standard 7.5.
 */
export function escapementSpan(teeth: number): number {
  return Math.floor(Math.max(6, Math.round(teeth)) / 4) + 0.5
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
 * the two outer wheels and takes the third from the quotient; anything that
 * lands on a whole tooth costs nothing, everything else pays for its rate error
 * first and its shape second.
 *
 * Cost, in order: rate error, then how far the three ratios are spread apart (an
 * even split gives the smallest wheels overall), then pins above `minPins` — the
 * last priced so that a train needing fatter pinions is only ever chosen when
 * there is no exact one without them.
 */
export function solveTrain(ratio: number, minPins: number): TrainSolution {
  const target = Math.max(1, ratio)
  const floor = Math.max(2, Math.round(minPins))
  const ideal = Math.log(target) / MESHES

  let bestCost = Infinity
  let best: Mesh[] | null = null

  for (let p1 = floor; p1 <= floor + PIN_HEADROOM; p1++) {
    for (let p2 = floor; p2 <= floor + PIN_HEADROOM; p2++) {
      for (let p3 = floor; p3 <= floor + PIN_HEADROOM; p3++) {
        const pinCost = 0.01 * (p1 + p2 + p3 - 3 * floor)
        if (pinCost >= bestCost) continue
        const product = target * p1 * p2 * p3   // what T1·T2·T3 must come to
        const t1Lo = Math.ceil(MIN_MESH_RATIO * p1), t1Hi = Math.floor(MAX_MESH_RATIO * p1)
        const t2Lo = Math.ceil(MIN_MESH_RATIO * p2), t2Hi = Math.floor(MAX_MESH_RATIO * p2)
        const t3Lo = Math.ceil(MIN_MESH_RATIO * p3), t3Hi = Math.floor(MAX_MESH_RATIO * p3)
        for (let t1 = t1Lo; t1 <= t1Hi; t1++) {
          for (let t2 = t2Lo; t2 <= t2Hi; t2++) {
            const t3 = Math.round(product / (t1 * t2))
            if (t3 < t3Lo || t3 > t3Hi) continue
            const actual = (t1 / p1) * (t2 / p2) * (t3 / p3)
            // Rate error dominates by six orders of magnitude: an exact train is
            // always preferred to a prettier inexact one.
            const relErr = Math.abs(actual / target - 1)
            const spread =
              (Math.log(t1 / p1) - ideal) ** 2 +
              (Math.log(t2 / p2) - ideal) ** 2 +
              (Math.log(t3 / p3) - ideal) ** 2
            const cost = relErr * 1e6 + spread + pinCost
            if (cost < bestCost) {
              bestCost = cost
              best = [{ teeth: t1, pins: p1 }, { teeth: t2, pins: p2 }, { teeth: t3, pins: p3 }]
            }
          }
        }
      }
    }
  }

  // Nothing in range at all (an absurd ratio). Fall back to an even split so the
  // caller always has a train to draw and a rate error to report.
  if (!best) {
    const r = Math.exp(ideal)
    best = Array.from({ length: MESHES }, () => ({ teeth: Math.max(4, Math.round(floor * r)), pins: floor }))
  }

  // Descending, so the biggest wheel is the great wheel — the slow, high-torque
  // end of the train, which is where a wooden clock wants its material.
  best.sort((a, b) => b.teeth / b.pins - a.teeth / a.pins)

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

// ─── Emitting the parts ───────────────────────────────────────────────────────

export type ClockPartKey = 'drive' | 'great' | 'second' | 'third' | 'escapement' | 'pendulum'

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
  const train = solveTrain(trainRatio(spec), spec.minPins)
  const drive = solveDrive(spec, spec.minPins)

  const wheel = (teeth: number, pins: number): ClockShapeParams => ({
    type: 'gear', cx: 0, cy: 0,
    ...base.gear,
    module: spec.module,
    teeth,
    toothProfile: 'cycloidal',
    mateTeeth: pins,
    emitPinion: true,
  })

  // Arbor periods, from the escape wheel backwards: each wheel turns its mesh
  // ratio slower than the one it drives.
  const [m1, m2, m3] = train.meshes
  const thirdSec = escRev * (m3.teeth / m3.pins)
  const secondSec = thirdSec * (m2.teeth / m2.pins)
  const greatActual = secondSec * (m1.teeth / m1.pins)

  const parts: ClockPart[] = [
    {
      key: 'drive', name: 'Drive Wheel',
      revSeconds: greatActual * (drive.teeth / drive.pins),
      params: wheel(drive.teeth, drive.pins),
    },
    { key: 'great',  name: 'Great Wheel',  revSeconds: greatActual, params: wheel(m1.teeth, m1.pins) },
    { key: 'second', name: 'Second Wheel', revSeconds: secondSec,   params: wheel(m2.teeth, m2.pins) },
    { key: 'third',  name: 'Third Wheel',  revSeconds: thirdSec,    params: wheel(m3.teeth, m3.pins) },
    {
      key: 'escapement', name: 'Escapement', revSeconds: escRev,
      params: {
        type: 'escapement', cx: 0, cy: 0,
        ...base.escapement,
        teeth: Math.max(6, Math.round(spec.escapeTeeth)),
        span: escapementSpan(spec.escapeTeeth),
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
    train, drive, parts,
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

export interface ClockPlate {
  /** drive, great, second, third, escape — the going train, in order. */
  arbors: ClockArbor[]
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
export function clockPlate(parts: ClockAssembly, angles?: number[]): ClockPlate | null {
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

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const a of arbors) {
    minX = Math.min(minX, a.x - a.wheelRadius); maxX = Math.max(maxX, a.x + a.wheelRadius)
    minY = Math.min(minY, a.y - a.wheelRadius); maxY = Math.max(maxY, a.y + a.wheelRadius)
  }
  // The anchor's arms reach back over the wheel, so its own arbor is the only
  // point past the wheel that has to be counted.
  maxY = Math.max(maxY, anchor.y)
  return { arbors, anchor, bbox: { minX, minY, maxX, maxY } }
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
  const parent = plate.arbors[nodeIdx + 1]
  if (!parent) return null              // the root itself, or off the end
  const fx = root.x + parent.x, fy = root.y + parent.y
  // Degenerate only if the cursor is exactly on the parent arbor, where every
  // angle is equally good — hold the current one rather than snapping to 0.
  if (Math.abs(fx - cursor.x) < 1e-9 && Math.abs(fy - cursor.y) < 1e-9) return null
  const deg = (Math.atan2(fy - cursor.y, fx - cursor.x) * 180) / Math.PI
  return snapDeg > 0 ? Math.round(deg / snapDeg) * snapDeg : deg
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
 */
export function clockPose(parts: ClockAssembly, plate: ClockPlate, phase: number): ClockPose {
  const n = plate.arbors.length
  const wheelDeg = new Array<number>(n).fill(0)
  const pinionDeg = new Array<number>(n).fill(0)

  const escPart = parts[n - 1]
  const esc = escPart.params.type === 'escapement' ? escapementPose(escPart.params, phase) : { wheelDeg: 0, anchorDeg: 0 }
  wheelDeg[n - 1] = esc.wheelDeg
  // The escape pinion, clocked with the escape wheel (free choice, see above).
  pinionDeg[n - 1] = esc.wheelDeg

  for (let k = n - 2; k >= 0; k--) {
    const p = parts[k]
    if (p.params.type !== 'gear') continue
    const mesh = gearMesh(p.params)
    const th = (plate.arbors[k].toNext * 180) / Math.PI
    wheelDeg[k] = th + (mesh.matePhaseDeg + th - pinionDeg[k + 1]) / mesh.ratio
    pinionDeg[k] = wheelDeg[k]
  }

  return { wheelDeg, pinionDeg, anchorDeg: esc.anchorDeg }
}

/** Emission order — everything a clock is cut from. */
export const CLOCK_PART_ORDER: ClockPartKey[] = ['drive', 'great', 'second', 'third', 'escapement', 'pendulum']

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
