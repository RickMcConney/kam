// ─── BRIO-compatible wooden train track ──────────────────────────────────────
//
// A straight or a curved piece of toy railway, cut flat from 12 mm stock: the
// outline (with the pegs on it and the sockets bitten out of it) and the two
// grooves the wheel flanges run in.
//
// The published dimensions (woodenrailway.info/track/brio-track-guide) are:
//
//   body      40 mm wide, 12 mm thick
//   grooves   6 mm wide, 3 mm deep, 20 mm apart — 26 mm centre to centre
//   male      an 11.5 mm peg on a 7 mm long neck
//   female    15–17 mm across with a 5 mm long throat
//   curves    eight 45° arcs to a circle
//
// A TURNOUT is the union of a straight leg and a branch that leaves the same toe
// face on a tangent, and it is a PASSIVE switch — there are no moving points, so
// both routes are grooved right through and the flange takes whichever groove it
// rolls into. That is why the throat and the frog look like mistakes and are not:
// at the toe the straight groove and the branch's inner groove come out of the
// same slot and peel apart over the first few centimetres, and at the frog the
// branch's OUTER groove crosses the straight's inner one outright. Both are what
// the real piece does. What is NOT allowed to stay as it comes out of the union
// is the crotch where the two legs part — a 41° notch at the standard numbers,
// which no round bit cuts and which is a feather edge of short grain on both
// sides. It gets a `crotch` fillet, by the same morphological closing the cutting
// board blends its handle with.
//
// **THE JOINT IS THE WHOLE POINT, AND IT IS A LOOSE ONE.** The peg is much
// smaller than the socket on purpose: the slack is what lets a joint be pulled a
// couple of millimetres apart and bent a few degrees without the cars coming off,
// which is how a floor layout survives a child. So the socket is NOT a separate
// standard to be typed in — it is derived from the peg plus two clearances, and
// the hole is centred on where a butted peg's head lands. That makes the fit
// impossible to get wrong by editing one number and forgetting the other, and it
// is why `holeClear`/`throatClear` are parameters while socket Ø and throat
// length are readouts. Against real BRIO they come out at 2.25 mm radial and
// 1 mm per side, which reproduces the Ø16 hole and the 8 mm throat.
//
// **THE PEG'S NECK RUNS ALL THE WAY TO THE HEAD'S CENTRE, not to its edge.**
// `neckL` is the VISIBLE neck — face to where the head starts — so the head sits
// at `neckL + pegDia/2` and the rectangle that makes the neck is drawn out to
// that same point. Stopped at `neckL` the rectangle would meet the circle at
// exactly one point and the union would be a bar and a disc touching at a
// corner; run through to the centre it is a bone. Same trick for the throat.
//
// **THE GROOVE IS EMITTED AS A SEPARATE PART, in one of two forms.**
// `centreline` gives the open polyline down the middle of each groove — cut it
// with a 6 mm bit in one pass and the width is right by construction, and the
// bit sweeping past the end face carries the groove out to it. `outline` gives
// the closed 6 mm ring to pocket at 3 mm with whatever is in the spindle, which
// leaves a bit-radius corner at each mouth where a flange never runs. Different
// tool, different operation from the outline, which is the same reason the gear
// hands over parts rather than one compound path.
//
// A track is SCALE-LOCKED. Every number in it is a fit against pieces made by
// somebody else — a track scaled to 90% is a very good drawing of something that
// connects to nothing.

import { type Pt, arcInto, boolRings, ccw, clamp, ellipseRing, fmt, ringToD, roundConcave } from './polyOps'

export type TrackKind = 'straight' | 'curve' | 'turnout'
/** Which side a turnout's branch leaves on. A mirror would do it, but a
 *  mirrored path loses its shapeParams and stops being a turnout. */
export type TrackHand = 'left' | 'right'
/** What each end carries. `plain` is a square end — a buffer stop, or a blank to
 *  cut a joint into by hand. */
export type TrackEnd = 'male' | 'female' | 'plain'
export type TrackGroove = 'centreline' | 'outline'

export interface TrackSpec {
  cx: number; cy: number
  kind: TrackKind
  /** Straight and turnout: body length FACE TO FACE, which is also what the piece
   *  adds to a layout — the peg lives inside its neighbour's socket. On a turnout
   *  it is the STRAIGHT leg, so the piece drops in where an A-track was. */
  length: number
  /** Curve and turnout: radius to the track's CENTRELINE, not to either edge. */
  radius: number
  /** Curve and turnout: the arc it turns through. 45° puts eight to a circle. */
  sweepDeg: number
  /** Turnout only: which side the branch leaves on. */
  hand: TrackHand
  /** Turnout only: fillet in the crotch where the two legs part. */
  crotch: number
  /** Across the piece. 40 on real track. */
  width: number
  /** Groove centre to groove centre. 26 on real track. */
  gauge: number
  /** Groove width — the flange slot. 6 on real track. */
  grooveW: number
  grooveMode: TrackGroove
  /** The low-X (straight) or low-angle (curve) end; a turnout's TOE. */
  endA: TrackEnd
  /** The far end; a turnout's straight heel. */
  endB: TrackEnd
  /** Turnout only: the branch's heel. */
  endC: TrackEnd
  /** Peg head diameter. */
  pegDia: number
  /** Peg neck width. */
  neckW: number
  /** VISIBLE neck: the end face to where the head starts. */
  neckL: number
  /** How much bigger the socket's radius is than the peg head's. */
  holeClear: number
  /** How much wider the throat is than the neck, PER SIDE. */
  throatClear: number
}

/** Real BRIO, for the panel defaults and for anyone resetting a piece back to
 *  the standard. Thickness and groove depth are cut depths, not geometry, so
 *  they are here to be quoted rather than drawn. */
export const BRIO = {
  width: 40, thickness: 12,
  grooveW: 6, grooveDepth: 3, gauge: 26,
  pegDia: 11.5, neckW: 6, neckL: 7,
  holeClear: 2.25, throatClear: 1,
  radius: 182, sweepDeg: 45,
  /** Enough to take the notch off the crotch without bridging the two heels. */
  crotch: 6,
  /** The catalogue straights: mini, middle, short, medium, long. */
  lengths: [54, 72, 108, 144, 216],
} as const

/** How far a feature reaches into the body before the boolean, so a union or a
 *  difference never runs along a coincident edge. */
const EMBED = 0.5

// ─── Dimensions and fit ───────────────────────────────────────────────────────

export interface TrackDims {
  /** Face to face (straight) or along the centreline arc (curve). */
  bodyLength: number
  /** What one piece advances a layout: the length, or a curve's chord. */
  pitch: number
  /** The whole extent along the run, pegs included — what the stock must hold. */
  overall: number
  innerRadius: number
  outerRadius: number
  /** 360/sweep — how many of this piece make a circle. */
  perCircle: number
  closesCircle: boolean
  /** End face to the head's centre; the socket's hole is centred here too. */
  headCentre: number
  /** End face to the tip of the peg. */
  pegReach: number
  socketDia: number
  throatW: number
  /** End face to the front of the hole — the published "throat length". */
  throatL: number
  /** End face to the back of the hole. */
  socketDepth: number
  /** Slack of the head in the hole, radial. */
  headClearance: number
  /** Slack of the neck in the throat, per side. */
  neckClearance: number
  /** Groove's outer edge to the edge of the track — the outer flange. 4 on real track. */
  railMargin: number
  /** The hole to the groove's inner edge — what is left of the centre spine. */
  spineMargin: number
  grooveOffTrack: boolean
  socketBreachesGroove: boolean
  socketsTooDeep: boolean
  pegTooThin: boolean

  // ── turnout ──
  /** Toe face to the frog, along the straight route: where the branch's OUTER
   *  groove crosses the straight's inner one. √(2·R·gauge) — it depends on the
   *  gauge, not on the sweep, so a shallower branch does not move it. */
  frogDist: number
  /** How far round the branch the frog sits — the sweep must reach past it or
   *  the piece ends in the middle of the crossing. */
  frogDeg: number
  /** How far the branch has stepped sideways by its heel. */
  divergeOffset: number
  /** The straight leg stops before the routes have finished crossing. */
  frogPastEnd: boolean
  /** The branch is cut off before the frog — the two routes never separate. */
  frogPastSweep: boolean
  /** The two heels are still in each other's stock. */
  heelsFoul: boolean
}

export function trackDims(s: TrackSpec): TrackDims {
  const half = s.gauge / 2
  const hw = s.grooveW / 2
  const headCentre = s.neckL + s.pegDia / 2
  const socketDia = s.pegDia + 2 * s.holeClear
  const throatW = s.neckW + 2 * s.throatClear
  const sweep = curveSweep(s)
  const R = curveRadius(s)

  // A turnout is quoted on its MAIN route: that is the run it substitutes for in
  // a layout, and the branch is described by its radius and sweep like any curve.
  const bodyLength = s.kind === 'curve' ? R * sweep : s.length
  const pitch = s.kind === 'curve' ? 2 * R * Math.sin(sweep / 2) : s.length
  const pegReach = s.neckL + s.pegDia
  const socketDepth = headCentre + socketDia / 2
  const ends = s.kind === 'turnout' ? [s.endA, s.endB, s.endC] : [s.endA, s.endB]
  // The branch's outer groove sits at R + gauge/2 from a centre `radius` off the
  // straight route, and crosses the straight's inner groove where that circle
  // meets y = gauge/2 — which reduces to √(2·R·gauge), the sweep playing no part.
  const frogDist = Math.sqrt(2 * R * s.gauge)
  const frogDeg = (Math.asin(clamp(frogDist / (R + s.gauge / 2), -1, 1)) * 180) / Math.PI
  const divergeOffset = R * (1 - Math.cos(sweep))

  return {
    bodyLength,
    pitch,
    overall: pitch + [s.endA, s.endB].filter((e) => e === 'male').length * pegReach,
    innerRadius: R - s.width / 2,
    outerRadius: R + s.width / 2,
    perCircle: 360 / Math.max(1e-6, s.sweepDeg),
    closesCircle: Math.abs(360 / Math.max(1e-6, s.sweepDeg) - Math.round(360 / Math.max(1e-6, s.sweepDeg))) < 1e-6,
    headCentre,
    pegReach,
    socketDia,
    throatW,
    throatL: headCentre - socketDia / 2,
    socketDepth,
    headClearance: s.holeClear,
    neckClearance: s.throatClear,
    railMargin: s.width / 2 - half - hw,
    spineMargin: half - hw - socketDia / 2,
    grooveOffTrack: half + hw > s.width / 2,
    socketBreachesGroove: socketDia / 2 > half - hw || throatW / 2 > half - hw,
    socketsTooDeep: ends.filter((e) => e === 'female').length * socketDepth > bodyLength,
    // The neck is what the whole joint hangs off — thinner than the head is
    // deep, and it is the grain-short piece that snaps first.
    pegTooThin: s.neckW >= s.pegDia,

    frogDist,
    frogDeg,
    divergeOffset,
    frogPastEnd: s.kind === 'turnout' && frogDist > s.length,
    frogPastSweep: s.kind === 'turnout' && frogDeg > s.sweepDeg,
    // Two end faces inside 40 mm of each other have no stock between them to be
    // two pieces of track, whatever the drawing looks like.
    heelsFoul: s.kind === 'turnout' && divergeOffset < s.width,
  }
}

// ─── Frames ───────────────────────────────────────────────────────────────────
//
// Every connector is drawn in the frame of the end face it sits on: u out along
// the joint's axis (away from the body), v across it. That is the one thing that
// lets a straight and a curve share all of the connector geometry — on a curve
// the axis is the TANGENT at the end, which is what makes a ring of eight pieces
// meet squarely.

interface EndFrame { ox: number; oy: number; ux: number; uy: number }

function place(fr: EndFrame, u: number, v: number): Pt {
  return [fr.ox + u * fr.ux - v * fr.uy, fr.oy + u * fr.uy + v * fr.ux]
}

function curveSweep(s: TrackSpec): number {
  return (clamp(s.sweepDeg, 1, 350) * Math.PI) / 180
}

function curveRadius(s: TrackSpec): number {
  return Math.max(s.width / 2 + 1, s.radius)
}

/**
 * A turnout's branch, in the LEFT-handed frame everything is built in: the toe
 * face is at x=0 with the straight leg running down +x, and the branch curls up
 * from the same face about a centre directly above it. A right-handed piece is
 * this mirrored in y at the very end — the geometry cannot disagree with itself
 * that way, and there is only one of it to get right.
 */
function branchArc(s: TrackSpec) {
  const R = curveRadius(s)
  const sweep = curveSweep(s)
  // Angles about (0, R): the toe end of the branch is straight below its centre.
  return { cy: R, R, sweep, a0: -Math.PI / 2, a1: sweep - Math.PI / 2 }
}

/** Every end the piece has, with what it carries — toe first. */
function connectors(s: TrackSpec): { fr: EndFrame; end: TrackEnd }[] {
  if (s.kind === 'turnout') {
    const { R, sweep } = branchArc(s)
    const L = Math.max(1, s.length)
    return [
      { fr: { ox: 0, oy: 0, ux: -1, uy: 0 }, end: s.endA },
      { fr: { ox: L, oy: 0, ux: 1, uy: 0 }, end: s.endB },
      // The branch's heel, square to its own radial face — so the tangent again.
      {
        fr: {
          ox: R * Math.sin(sweep), oy: R * (1 - Math.cos(sweep)),
          ux: Math.cos(sweep), uy: Math.sin(sweep),
        },
        end: s.endC,
      },
    ]
  }
  if (s.kind === 'straight') {
    const L = Math.max(1, s.length)
    return [
      { fr: { ox: 0, oy: 0, ux: -1, uy: 0 }, end: s.endA },
      { fr: { ox: L, oy: 0, ux: 1, uy: 0 }, end: s.endB },
    ]
  }
  const R = curveRadius(s)
  const sweep = curveSweep(s)
  const a0 = -sweep / 2, a1 = sweep / 2
  return [
    // Out of the low end is the direction of DECREASING angle.
    { fr: { ox: R * Math.cos(a0), oy: R * Math.sin(a0), ux: Math.sin(a0), uy: -Math.cos(a0) }, end: s.endA },
    { fr: { ox: R * Math.cos(a1), oy: R * Math.sin(a1), ux: -Math.sin(a1), uy: Math.cos(a1) }, end: s.endB },
  ]
}

// ─── Rings ────────────────────────────────────────────────────────────────────

function rectRing(x: number, y: number, w: number, h: number): Pt[] {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
}

/** An arc, as an open polyline starting on `a0`. */
function arcPoly(cx: number, cy: number, r: number, a0: number, a1: number): Pt[] {
  const out: Pt[] = [[cx + r * Math.cos(a0), cy + r * Math.sin(a0)]]
  arcInto(out, cx, cy, r, r, a0, a1)
  return out
}

/** An annular sector — the shape of every curved leg here. */
function sectorRing(cx: number, cy: number, ri: number, ro: number, a0: number, a1: number): Pt[] {
  const ring = arcPoly(cx, cy, ri, a0, a1)
  ring.push([cx + ro * Math.cos(a1), cy + ro * Math.sin(a1)])
  arcInto(ring, cx, cy, ro, ro, a1, a0)
  return ccw(ring)
}

function bodyRings(s: TrackSpec): Pt[][] {
  const hw = s.width / 2
  if (s.kind === 'straight') return [rectRing(0, -hw, Math.max(1, s.length), s.width)]
  if (s.kind === 'curve') {
    const R = curveRadius(s)
    const sweep = curveSweep(s)
    return [sectorRing(0, 0, R - hw, R + hw, -sweep / 2, sweep / 2)]
  }
  const { cy, R, a0, a1 } = branchArc(s)
  const legs = boolRings(
    'union',
    [rectRing(0, -hw, Math.max(1, s.length), s.width)],
    [sectorRing(0, cy, R - hw, R + hw, a0, a1)],
  )
  // The closing fills the crotch with a tangent arc and leaves every convex
  // corner — the end faces included — exactly where it found them, which is why
  // it can run before the pegs and sockets go on without touching them.
  return roundConcave(legs, clamp(s.crotch, 0, hw))
}

/** The bone: a neck run through to the head's centre, unioned with the head. */
function pegRings(fr: EndFrame, s: TrackSpec): Pt[][] {
  const headCentre = s.neckL + s.pegDia / 2
  const hw = s.neckW / 2
  const neck = [
    place(fr, -EMBED, -hw), place(fr, headCentre, -hw),
    place(fr, headCentre, hw), place(fr, -EMBED, hw),
  ]
  const c = place(fr, headCentre, 0)
  const head = ellipseRing(c[0], c[1], s.pegDia / 2, s.pegDia / 2)
  return boolRings('union', [ccw(neck)], [head])
}

/** The keyhole to bite out. Reaches OUT past the face so the notch opens on it. */
function socketRings(fr: EndFrame, s: TrackSpec): Pt[][] {
  const d = trackDims(s)
  const hw = d.throatW / 2
  const throat = [
    place(fr, EMBED, -hw), place(fr, -d.headCentre, -hw),
    place(fr, -d.headCentre, hw), place(fr, EMBED, hw),
  ]
  const c = place(fr, -d.headCentre, 0)
  const hole = ellipseRing(c[0], c[1], d.socketDia / 2, d.socketDia / 2)
  return boolRings('union', [ccw(throat)], [hole])
}

function outlineRings(s: TrackSpec): Pt[][] {
  const ends = connectors(s)
  let rings = bodyRings(s)
  // Every peg first, then every socket: a socket bitten out before a neighbouring
  // peg is unioned on would be partly filled back in by it.
  for (const { fr, end } of ends) {
    if (end === 'male') rings = boolRings('union', rings, pegRings(fr, s))
  }
  for (const { fr, end } of ends) {
    if (end === 'female') rings = boolRings('difference', rings, socketRings(fr, s))
  }
  return rings
}

/** Groove centrelines, as open polylines. They run the full body, face to face:
 *  a flange has to roll across the joint, so a groove that stops short of the
 *  end is a step for it to climb. */
function grooveLines(s: TrackSpec): Pt[][] {
  const half = s.gauge / 2
  const straight = (L: number): Pt[][] => [[[0, half], [L, half]], [[0, -half], [L, -half]]]
  if (s.kind === 'straight') return straight(Math.max(1, s.length))
  if (s.kind === 'curve') {
    const R = curveRadius(s)
    const sweep = curveSweep(s)
    return [arcPoly(0, 0, R + half, -sweep / 2, sweep / 2), arcPoly(0, 0, R - half, -sweep / 2, sweep / 2)]
  }
  // BOTH routes are grooved end to end. A passive switch has no moving points,
  // so a flange has to find a continuous groove whichever way it goes — which
  // means the two pairs share a slot at the throat and cross outright at the
  // frog, and neither may be trimmed back to tidy that up.
  const { cy, R, a0, a1 } = branchArc(s)
  return [
    ...straight(Math.max(1, s.length)),
    arcPoly(0, cy, R - half, a0, a1),
    arcPoly(0, cy, R + half, a0, a1),
  ]
}

/** Groove outlines, as closed rings — square-ended, because the groove has to
 *  reach the face. */
function grooveRings(s: TrackSpec): Pt[][] {
  const half = s.gauge / 2
  const hw = s.grooveW / 2
  const straight = (L: number): Pt[][] => [
    rectRing(0, half - hw, L, s.grooveW),
    rectRing(0, -half - hw, L, s.grooveW),
  ]
  if (s.kind === 'straight') return straight(Math.max(1, s.length))
  if (s.kind === 'curve') {
    const R = curveRadius(s)
    const sweep = curveSweep(s)
    return [
      sectorRing(0, 0, R + half - hw, R + half + hw, -sweep / 2, sweep / 2),
      sectorRing(0, 0, R - half - hw, R - half + hw, -sweep / 2, sweep / 2),
    ]
  }
  // UNIONED, unlike the centrelines. Four rings that overlap at the throat and
  // cross at the frog are four regions a pocket would cut twice — and worse,
  // under an even-odd fill the crossing at the frog reads as a HOLE and is left
  // standing, which is a lump in the middle of the one place a flange is
  // already unsupported. The union has no hole in it: no two of these four
  // rings meet twice, so there is no cycle to enclose one (pinned in the test).
  const { cy, R, a0, a1 } = branchArc(s)
  return boolRings('union', straight(Math.max(1, s.length)), [
    sectorRing(0, cy, R - half - hw, R - half + hw, a0, a1),
    sectorRing(0, cy, R + half - hw, R + half + hw, a0, a1),
  ])
}

// ─── Emission ─────────────────────────────────────────────────────────────────

function shiftRings(rings: Pt[][], dx: number, dy: number): Pt[][] {
  return rings.map((r) => r.map(([x, y]) => [x + dx, y + dy] as Pt))
}

/** A right-hand turnout is the left-hand one flipped, and that is the whole of
 *  the difference — flipping at the end rather than signing every angle is what
 *  keeps the two hands from ever disagreeing. Winding is fixed on emission. */
function mirrorRings(rings: Pt[][]): Pt[][] {
  return rings.map((r) => r.map(([x, y]) => [x, -y] as Pt))
}

function polyToD(pts: Pt[]): string {
  return 'M' + pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' L')
}

export interface TrackPart { key: string; d: string }

/**
 * The piece, centred on the OUTLINE's bounding box — the extent the stock has to
 * hold, pegs included, which is the same reading the gear gives for a wheel with
 * a pinion beside it.
 */
export function generateTrackParts(s: TrackSpec): TrackPart[] {
  const flip = s.kind === 'turnout' && s.hand === 'right'
  const outline = flip ? mirrorRings(outlineRings(s)) : outlineRings(s)
  if (outline.length === 0) return []

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const ring of outline) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const dx = s.cx - (minX + maxX) / 2
  const dy = s.cy - (minY + maxY) / 2

  const parts: TrackPart[] = [{
    key: 'body',
    d: shiftRings(outline, dx, dy).map((r) => ringToD(r, true)).join(' '),
  }]

  const raw = s.grooveMode === 'outline' ? grooveRings(s) : grooveLines(s)
  const grooves = shiftRings(flip ? mirrorRings(raw) : raw, dx, dy)
    .map((r) => (s.grooveMode === 'outline' ? ringToD(r, true) : polyToD(r)))
  if (grooves.length > 0) parts.push({ key: 'groove', d: grooves.join(' ') })

  return parts
}

export function generateTrackD(s: TrackSpec): string {
  return generateTrackParts(s).map((p) => p.d).join(' ')
}
