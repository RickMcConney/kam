import { flattenPath, signedArea, ensureWinding, splitSelfIntersecting, douglasPeucker, type Pt2 } from './pathFlattener'
import { Adaptive2d, OperationType, MotionType, type AdaptiveOutput } from './adaptiveClearing'
import { morphChainToSpiral } from './spiralMorph'
import { solveField, type FieldGrid } from './spiralField'
import { traceIsolines } from './marchingSquares'
import { inflatePathsD, JoinType, EndType } from 'clipper2-ts'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool, CuttingDirection } from '../store/toolStore'

// 'spiral' is the field-based curvilinear spiral (Poisson isotherms, helix entry) —
// best for chunky pockets and islands. 'spiralOffset' is the offset-ring morph
// spiral (shown in the UI as "offset") — contour-parallel, so it stays clean on
// thin/diagonal strokes (letters) where the field spiral's ridge fragments.
export type PocketStrategy = 'raster' | 'contour' | 'adaptive' | 'spiral' | 'spiralOffset'

export interface PocketParams {
  strategy?: PocketStrategy
  depthMM: number
  stepDownMM: number
  stepoverPercent: number
  direction: CuttingDirection
  islandDs: string[]
  angle: number
  startNear?: { x: number; y: number }
  rampIn?: boolean
  safeHeightMM?: number
  // Finish allowance: stock left on every wall. Positive insets the boundary and grows
  // islands (leaves stock for a finish pass); negative does the reverse and grows the
  // pocket. Applied per resolved sub-ring, so self-intersecting boundaries keep all
  // their regions. Inlay sockets pass −clearanceMM here instead of pre-offsetting the
  // (possibly self-intersecting) path, which would merge its loops.
  finishAllowanceMM?: number
}

interface TravelSafetyObstacles {
  edgeObstacles: Pt2[][]
  solidObstacles?: Pt2[][]
}

const MICRO_LIFT_MM = 0.5

// ─── Shared utilities ──────────────────────────────────────────────────────────

function zPasses(depthMM: number, stepDownMM: number): number[] {
  const passes: number[] = []
  const step = Math.abs(stepDownMM)
  let z = -step
  while (z > -depthMM) { passes.push(z); z -= step }
  passes.push(-Math.abs(depthMM))
  return passes
}

function pointInPolygon(px: number, py: number, poly: Pt2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1]
    const xj = poly[j][0], yj = poly[j][1]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function pointOnSegment(p: Pt2, a: Pt2, b: Pt2, eps = 1e-6): boolean {
  const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])
  if (Math.abs(cross) > eps) return false
  const dot = (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])
  if (dot < -eps) return false
  const lenSq = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2
  return dot <= lenSq + eps
}

function segmentEdgeIntersectionParams(a: Pt2, b: Pt2, c: Pt2, d: Pt2): number[] {
  const r: Pt2 = [b[0] - a[0], b[1] - a[1]]
  const s: Pt2 = [d[0] - c[0], d[1] - c[1]]
  const denom = r[0] * s[1] - r[1] * s[0]
  const qmp: Pt2 = [c[0] - a[0], c[1] - a[1]]
  const eps = 1e-8

  if (Math.abs(denom) > eps) {
    const t = (qmp[0] * s[1] - qmp[1] * s[0]) / denom
    const u = (qmp[0] * r[1] - qmp[1] * r[0]) / denom
    return t >= -eps && t <= 1 + eps && u >= -eps && u <= 1 + eps
      ? [Math.max(0, Math.min(1, t))]
      : []
  }

  const collinear = Math.abs(qmp[0] * r[1] - qmp[1] * r[0]) <= eps
  if (!collinear) return []

  const lenSq = r[0] ** 2 + r[1] ** 2
  if (lenSq <= eps) return []
  const t0 = ((c[0] - a[0]) * r[0] + (c[1] - a[1]) * r[1]) / lenSq
  const t1 = ((d[0] - a[0]) * r[0] + (d[1] - a[1]) * r[1]) / lenSq
  const lo = Math.max(0, Math.min(t0, t1))
  const hi = Math.min(1, Math.max(t0, t1))
  return lo <= hi + eps ? [lo, hi] : []
}

function addUniqueParam(params: number[], t: number) {
  if (t <= 1e-6 || t >= 1 - 1e-6) return
  if (!params.some(existing => Math.abs(existing - t) < 1e-5)) params.push(t)
}

function transitionCrossesPolygonEdge(from: Pt2, to: Pt2, poly: Pt2[]): boolean {
  const tDX = to[0] - from[0], tDY = to[1] - from[1]
  const ftMinX = Math.min(from[0], to[0])
  const ftMaxX = Math.max(from[0], to[0])
  const ftMinY = Math.min(from[1], to[1])
  const ftMaxY = Math.max(from[1], to[1])
  for (let i = 0; i < poly.length; i++) {
    const edgeStart = poly[i]
    const edgeEnd = poly[(i + 1) % poly.length]
    // Reject edges whose bounding box can't overlap the travel segment's bounding box.
    if (Math.max(edgeStart[0], edgeEnd[0]) < ftMinX ||
        Math.min(edgeStart[0], edgeEnd[0]) > ftMaxX ||
        Math.max(edgeStart[1], edgeEnd[1]) < ftMinY ||
        Math.min(edgeStart[1], edgeEnd[1]) > ftMaxY) continue
    // Skip collinear/parallel edges: travel along (or parallel to) an edge is not a
    // transversal crossing — collinear slides along a boundary are always safe.
    const eDX = edgeEnd[0] - edgeStart[0], eDY = edgeEnd[1] - edgeStart[1]
    if (Math.abs(tDX * eDY - tDY * eDX) < 1e-8) continue
    for (const t of segmentEdgeIntersectionParams(from, to, edgeStart, edgeEnd)) {
      if (t <= 1e-6 || t >= 1 - 1e-6) continue
      const p: Pt2 = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]
      if (pointOnSegment(p, edgeStart, edgeEnd)) return true
    }
  }
  return false
}

function transitionEntersSolidPolygon(from: Pt2, to: Pt2, poly: Pt2[]): boolean {
  const ftMinX = Math.min(from[0], to[0])
  const ftMaxX = Math.max(from[0], to[0])
  const ftMinY = Math.min(from[1], to[1])
  const ftMaxY = Math.max(from[1], to[1])
  const params = [0, 1]
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    if (Math.max(a[0], b[0]) < ftMinX ||
        Math.min(a[0], b[0]) > ftMaxX ||
        Math.max(a[1], b[1]) < ftMinY ||
        Math.min(a[1], b[1]) > ftMaxY) continue
    for (const t of segmentEdgeIntersectionParams(from, to, a, b)) {
      addUniqueParam(params, t)
    }
  }
  params.sort((a, b) => a - b)

  for (let i = 0; i + 1 < params.length; i++) {
    const lo = params[i], hi = params[i + 1]
    if (hi - lo < 1e-5) continue
    const t = (lo + hi) / 2
    const p: Pt2 = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]
    if (pointInPolygon(p[0], p[1], poly)) return true
  }
  return false
}

function isTravelSafe(from: Pt2, to: Pt2, obstacles: TravelSafetyObstacles): boolean {
  if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 1e-6) return true

  for (const poly of obstacles.edgeObstacles) {
    if (transitionCrossesPolygonEdge(from, to, poly)) return false
  }

  for (const poly of obstacles.solidObstacles ?? []) {
    if (transitionEntersSolidPolygon(from, to, poly)) return false
  }

  return true
}

function stripClosingDuplicate(pts: Pt2[]): Pt2[] {
  if (pts.length > 1 && Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) < 1e-6) {
    return pts.slice(0, -1)
  }
  return pts
}

function arcLengths(pts: Pt2[]): { lens: number[]; total: number } {
  const lens: number[] = [0]
  for (let i = 1; i < pts.length; i++) {
    lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  }
  return { lens, total: lens[lens.length - 1] }
}

function interpPt(pts: Pt2[], lens: number[], s: number): Pt2 {
  s = Math.max(0, Math.min(lens[lens.length - 1], s))
  for (let i = 1; i < pts.length; i++) {
    if (lens[i] >= s - 1e-10) {
      const t = (lens[i] - lens[i - 1]) > 1e-10 ? (s - lens[i - 1]) / (lens[i] - lens[i - 1]) : 0
      return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])]
    }
  }
  return [pts[pts.length - 1][0], pts[pts.length - 1][1]]
}

function offsetRing(pts: Pt2[], delta: number): Pt2[] {
  const clean = stripClosingDuplicate(pts)
  if (clean.length < 3) return []
  const ccw = signedArea(clean) >= 0 ? clean : [...clean].reverse()
  const result = inflatePathsD(
    [ccw.map(([x, y]) => ({ x, y }))],
    delta, JoinType.Miter, EndType.Polygon, 4, 6,
  )
  if (result.length === 0) return []
  const best = result.reduce((a, b) => (b.length > a.length ? b : a))
  return stripClosingDuplicate(best.map(({ x, y }) => [x, y] as Pt2))
}

// Shrink polygon inward by delta. Returns [] if it collapses or inverts.
function insetRing(pts: Pt2[], delta: number): Pt2[] {
  const origArea = Math.abs(signedArea(pts))
  const result = offsetRing(pts, -delta)
  if (result.length < 3) return []
  if (Math.abs(signedArea(result)) >= origArea) return []
  return result
}

function growRing(pts: Pt2[], delta: number): Pt2[] {
  return offsetRing(pts, delta)
}

// Offset multiple island rings together as a compound shape. This is important
// for sub-rings produced by splitSelfIntersecting (e.g. a figure-8 island) —
// offsetting them as a unit avoids miter spikes at shared crossing vertices that
// would otherwise make the finishing contour cut through the original island.
function growIslands(islands: Pt2[][], delta: number, joinType: JoinType = JoinType.Miter): Pt2[][] {
  if (islands.length === 0) return []
  const result = inflatePathsD(
    islands.map(isl => {
      const clean = stripClosingDuplicate(isl)
      const ccw = signedArea(clean) >= 0 ? clean : [...clean].reverse()
      return ccw.map(([x, y]) => ({ x, y }))
    }),
    delta, joinType, EndType.Polygon, 4, 6,
  )
  return result
    .map(r => stripClosingDuplicate(r.map(({ x, y }) => [x, y] as Pt2)))
    .filter(r => r.length >= 3)
}

function emitCutTransition(
  segs: MotionSegment[],
  from: Pt2,
  to: Pt2,
  z: number,
  toolDiameterMM: number,
  safeZ: number,
) {
  const dist = Math.hypot(to[0] - from[0], to[1] - from[1])
  if (dist > toolDiameterMM * 2) {
    const liftZ = Math.min(safeZ, z + MICRO_LIFT_MM)
    segs.push({ x: from[0], y: from[1], z: liftZ, rapid: false, travel: true })
    segs.push({ x: to[0], y: to[1], z: liftZ, rapid: false, travel: true })
    segs.push({ x: to[0], y: to[1], z, rapid: false })
  } else {
    segs.push({ x: to[0], y: to[1], z, rapid: false })
  }
}

function centroidOfRing(pts: Pt2[]): Pt2 {
  let area2 = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    const cross = x0 * y1 - x1 * y0
    area2 += cross
    cx += (x0 + x1) * cross
    cy += (y0 + y1) * cross
  }
  if (Math.abs(area2) < 1e-8) {
    const sum = pts.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]] as Pt2, [0, 0])
    return [sum[0] / pts.length, sum[1] / pts.length]
  }
  return [cx / (3 * area2), cy / (3 * area2)]
}

function emitHelicalRamp(
  center: Pt2,
  radius: number,
  fromZ: number,
  toZ: number,
  wantCCW: boolean,
  segs: MotionSegment[],
  safeZ = 5,
): Pt2 {
  const turns = Math.max(1, Math.ceil(Math.abs(toZ - fromZ) / 1.5))
  const stepsPerTurn = 28
  const totalSteps = turns * stepsPerTurn
  const dir = wantCCW ? 1 : -1
  const start: Pt2 = [center[0] + radius, center[1]]

  segs.push({ x: start[0], y: start[1], z: safeZ, rapid: true })
  segs.push({ x: start[0], y: start[1], z: fromZ, rapid: true })

  let last: Pt2 = start
  for (let i = 1; i <= totalSteps; i++) {
    const t = i / totalSteps
    const a = dir * t * turns * 2 * Math.PI
    last = [center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius]
    segs.push({ x: last[0], y: last[1], z: fromZ + (toZ - fromZ) * t, rapid: false, feedScale: 0.45 })
  }

  return last
}

// Descend a helical bore about `center` (tool-centre radius `radius`), finishing at
// `endAngle` on the circle at `toZ`. Integer turns ⇒ the plunge point is also at
// `endAngle`, so the bore is a clean circle entered and exited at the same place; the
// full revolutions clear the disk of radius radius+toolRadius. A final FLAT revolution
// at `toZ` removes the spiral ramp the descent leaves on the floor (each angle bottoms
// out at a different Z, so without it the bored centre isn't flat). Returns the end point.
function emitHelixBore(
  center: Pt2,
  radius: number,
  endAngle: number,
  fromZ: number,
  toZ: number,
  wantCCW: boolean,
  segs: MotionSegment[],
  safeZ = 5,
): Pt2 {
  const dir = wantCCW ? 1 : -1
  const stepsPerTurn = 28
  const turns = Math.max(1, Math.ceil(Math.abs(toZ - fromZ) / 1.5))
  const totalSteps = turns * stepsPerTurn
  const pt = (a: number): Pt2 => [center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius]
  const startPt = pt(endAngle)
  segs.push({ x: startPt[0], y: startPt[1], z: safeZ, rapid: true })
  segs.push({ x: startPt[0], y: startPt[1], z: fromZ, rapid: true })
  let last = startPt
  for (let i = 1; i <= totalSteps; i++) {
    const t = i / totalSteps
    last = pt(endAngle - dir * (1 - t) * turns * 2 * Math.PI)
    segs.push({ x: last[0], y: last[1], z: fromZ + (toZ - fromZ) * t, rapid: false, feedScale: 0.45 })
  }
  // Flat finishing revolution at full depth: levels the helical ramp groove so the bored
  // floor is flat before the spiral takes over. Full 2π back to `endAngle`.
  for (let i = 1; i <= stepsPerTurn; i++) {
    last = pt(endAngle - dir * (1 - i / stepsPerTurn) * 2 * Math.PI)
    segs.push({ x: last[0], y: last[1], z: toZ, rapid: false, feedScale: 0.45 })
  }
  return last
}

// First spiral index whose tool pass removes material the helix bore didn't already
// clear. A helix of tool-centre radius `hr` about `center` clears a solid disk of
// radius hr+toolRadius (hr ≤ toolRadius), so a spiral point only cuts new stock once
// its centre exceeds hr from `center`. The morph's seeded-centre turn hugs the bore for
// a whole revolution (centre-distance ≈ hr with small numerical wobble), so we walk the
// CONTIGUOUS leading run within hr+margin and stop at the first point that escapes it —
// only the leading run, so a spiral that later loops back near the centre (around an
// island) is never skipped. The margin absorbs the wobble; whatever is skipped leaves
// at most `margin` of stock at the bore edge (negligible, within tolerance).
function firstUncutSpiralIndex(spiral: Pt2[], center: Pt2, hr: number): number {
  const band = hr + 0.1
  let k = 1
  while (k < spiral.length - 1 &&
         Math.hypot(spiral[k][0] - center[0], spiral[k][1] - center[1]) <= band) k++
  return k
}

// Integrated helix entry for a centre-seeded spiral, bored CONCENTRIC with the spiral's
// innermost loop: `center` is that loop's centroid. The bore (radius `hr`) clears the
// middle; the descent ends at the angle of the first point the bore didn't already clear,
// so — because the spiral winds concentrically about `center` — the helix and the spiral
// share a tangent there and join cleanly, with the whole redundant inner turn skipped and
// no offset/backtrack. Returns that cut-start index; the caller cuts `spiral` from it on.
function emitSpiralHelixEntry(
  spiral: Pt2[],
  center: Pt2,
  hr: number,
  fromZ: number,
  toZ: number,
  wantCCW: boolean,
  segs: MotionSegment[],
  safeZ: number,
): number {
  const cutFrom = firstUncutSpiralIndex(spiral, center, hr)
  const join = spiral[cutFrom]
  const endAngle = Math.atan2(join[1] - center[1], join[0] - center[0])
  emitHelixBore(center, hr, endAngle, fromZ, toZ, wantCCW, segs, safeZ)
  return cutFrom
}

// ─── Linear ramp lead-in (shared by every strategy) ──────────────────────────────
//
// A ramp lead-in descends the tool from prevZ to zDepth while moving along a portion
// of the geometry that is (or will be) cut at full depth, so the ramp groove is left
// clean. The lead-in is min(rampDistMM, total*0.45) long and always ENDS at the cut
// start point. Two flavours:
//   open=true  → the first window of an open path (spiral / scanline), traversed
//                backward so it ends at geom[0].
//   open=false → the final window of a closed ring, approaching its start vertex.
// `sampleAt(t)` gives the XY position at descent fraction t (t=0 touchdown, t=1 start).
function rampLeadIn(
  geom: Pt2[],
  open: boolean,
  rampDistMM: number,
): { touchdown: Pt2; sampleAt: (t: number) => Pt2 } {
  if (open) {
    const { lens, total } = arcLengths(geom)
    const rampDist = Math.min(rampDistMM, total * 0.45)
    return {
      touchdown: interpPt(geom, lens, rampDist),
      sampleAt: (t: number) => interpPt(geom, lens, rampDist * (1 - t)),
    }
  }
  const closed: Pt2[] = [...geom, geom[0]]
  const { lens, total } = arcLengths(closed)
  const rampDist = Math.min(rampDistMM, total * 0.45)
  const rampStartS = total - rampDist
  return {
    touchdown: interpPt(closed, lens, rampStartS),
    sampleAt: (t: number) => interpPt(closed, lens, rampStartS + t * rampDist),
  }
}

// The inner ramp descent: the tool is already positioned at the touchdown point at
// `prevZ`; step down to `zDepth` over `steps` increments at reduced feed, tracing the
// lead-in via `sampleAt`. Ends at (cut start, zDepth). The lift/plunge that gets the
// tool to the touchdown point stays at each call site (it varies per strategy).
function emitRampDescent(
  segs: MotionSegment[],
  sampleAt: (t: number) => Pt2,
  prevZ: number,
  zDepth: number,
  steps: number,
  feedScale = 0.5,
): void {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const p = sampleAt(t)
    segs.push({ x: p[0], y: p[1], z: prevZ + (zDepth - prevZ) * t, rapid: false, feedScale })
  }
}

// ─── Raster utilities ──────────────────────────────────────────────────────────

function generateScanlines(
  boundary: Pt2[],
  spacingMM: number,
  angleDeg: number,
): { p1: Pt2; p2: Pt2 }[] {
  if (boundary.length < 3) return []
  const angleRad = (angleDeg * Math.PI) / 180
  const cosA = Math.cos(-angleRad), sinA = Math.sin(-angleRad)
  const cosR = Math.cos(angleRad), sinR = Math.sin(angleRad)
  const rotated = boundary.map(([x, y]) => ({ x: x * cosA - y * sinA, y: x * sinA + y * cosA }))
  const ys = rotated.map(p => p.y)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const n = rotated.length
  const segments: { p1: Pt2; p2: Pt2 }[] = []
  for (let y = minY + spacingMM / 2; y <= maxY; y += spacingMM) {
    const hits: number[] = []
    for (let i = 0; i < n; i++) {
      const a = rotated[i], b = rotated[(i + 1) % n]
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        hits.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y))
      }
    }
    hits.sort((a, b) => a - b)
    for (let i = 0; i + 1 < hits.length; i += 2) {
      segments.push({
        p1: [hits[i] * cosR - y * sinR, hits[i] * sinR + y * cosR],
        p2: [hits[i + 1] * cosR - y * sinR, hits[i + 1] * sinR + y * cosR],
      })
    }
  }
  return segments
}

function clipScanlineAgainstIslands(
  p1: Pt2, p2: Pt2, exclusions: Pt2[][],
): { p1: Pt2; p2: Pt2 }[] {
  if (exclusions.length === 0) return [{ p1, p2 }]
  const y = p1[1]
  const xL = Math.min(p1[0], p2[0]), xR = Math.max(p1[0], p2[0])
  const blocked: [number, number][] = []
  for (const poly of exclusions) {
    const hits: number[] = []
    const n = poly.length
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n]
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        hits.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]))
      }
    }
    hits.sort((a, b) => a - b)
    for (let k = 0; k + 1 < hits.length; k += 2) blocked.push([hits[k], hits[k + 1]])
    if (hits.length === 0 && pointInPolygon((xL + xR) / 2, y, poly)) return []
  }
  if (blocked.length === 0) return [{ p1, p2 }]
  blocked.sort((a, b) => a[0] - b[0])
  const result: { p1: Pt2; p2: Pt2 }[] = []
  let cursor = xL
  for (const [bL, bR] of blocked) {
    if (bR <= cursor) continue
    if (bL > cursor) result.push({ p1: [cursor, y], p2: [Math.min(bL, xR), y] })
    cursor = Math.max(cursor, bR)
    if (cursor >= xR) break
  }
  if (cursor < xR) result.push({ p1: [cursor, y], p2: [xR, y] })
  return result.filter(s => Math.abs(s.p2[0] - s.p1[0]) >= 0.1)
}

function segmentsIntersect(a: Pt2, b: Pt2, c: Pt2, d: Pt2): boolean {
  const det = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0])
  if (det === 0) return false
  const lambda = ((d[1] - c[1]) * (d[0] - a[0]) + (c[0] - d[0]) * (d[1] - a[1])) / det
  const gamma = ((a[1] - b[1]) * (d[0] - a[0]) + (b[0] - a[0]) * (d[1] - a[1])) / det
  return 0 < lambda && lambda < 1 && 0 < gamma && gamma < 1
}

export function doesSegmentCrossBorder(p1: Pt2, p2: Pt2, paths: Pt2[][]): boolean {
  for (const path of paths) {
    for (let i = 0; i < path.length; i++) {
      if (segmentsIntersect(p1, p2, path[i], path[(i + 1) % path.length])) return true
    }
  }
  return false
}


function buildRasterPath(
  scanlines: { p1: Pt2; p2: Pt2 }[],
  travelObstacles: TravelSafetyObstacles,
  zDepth: number,
  segs: MotionSegment[],
  incomingPos: Pt2 | null,
  rampDistMM?: number,
  prevZ = 0,
  safeZ = 5,
  toolDiameterMM = 0,
): Pt2 | null {
  if (scanlines.length === 0) return incomingPos
  const used = new Array(scanlines.length).fill(false)
  let current: Pt2 | null = incomingPos

  for (let remaining = scanlines.length; remaining > 0; remaining--) {
    let bestIdx = -1, bestScore = Infinity, bestDist = Infinity, bestReversed = false, bestNeedsLift = true
    for (let i = 0; i < scanlines.length; i++) {
      if (used[i]) continue
      const seg = scanlines[i]
      for (let r = 0; r < 2; r++) {
        const start: Pt2 = r === 0 ? seg.p1 : seg.p2
        const needsLift = current === null || !isTravelSafe(current, start, travelObstacles)
        const dist = current ? Math.hypot(start[0] - current[0], start[1] - current[1]) : 0
        const score = needsLift ? dist * 1.25 : dist
        if (bestIdx === -1 || score < bestScore || (Math.abs(score - bestScore) < 1e-6 && dist < bestDist)) {
          bestIdx = i; bestScore = score; bestDist = dist; bestReversed = r === 1; bestNeedsLift = needsLift
        }
      }
    }
    used[bestIdx] = true
    const seg = scanlines[bestIdx]
    const start: Pt2 = bestReversed ? seg.p2 : seg.p1
    const end: Pt2   = bestReversed ? seg.p1 : seg.p2
    if (bestNeedsLift) {
      if (current !== null) segs.push({ x: current[0], y: current[1], z: safeZ, rapid: true })
      if (rampDistMM !== undefined) {
        // Position rampDist forward along the scanline, then ramp backwards to start.
        // When the tool reaches start it is at full depth; the forward cut to end
        // then re-cuts the ramp section, leaving a clean floor.
        const { touchdown, sampleAt } = rampLeadIn([start, end], true, rampDistMM)
        segs.push({ x: touchdown[0], y: touchdown[1], z: safeZ, rapid: true })
        segs.push({ x: touchdown[0], y: touchdown[1], z: prevZ, rapid: true })
        emitRampDescent(segs, sampleAt, prevZ, zDepth, 12)
        // Tool is now at (start, zDepth); fall through to cut forward to end
      } else {
        segs.push({ x: start[0], y: start[1], z: safeZ, rapid: true })
        segs.push({ x: start[0], y: start[1], z: zDepth, rapid: false })
      }
    } else {
      if (current) emitCutTransition(segs, current, start, zDepth, toolDiameterMM, safeZ)
      else segs.push({ x: start[0], y: start[1], z: zDepth, rapid: false })
    }
    segs.push({ x: end[0], y: end[1], z: zDepth, rapid: false })
    current = end
  }
  return current
}

// ─── Contour utilities ─────────────────────────────────────────────────────────

function rotateRingAt(pts: Pt2[], index: number): Pt2[] {
  return index === 0 ? pts : [...pts.slice(index), ...pts.slice(0, index)]
}


function chooseNextContourRing(
  rings: Pt2[][],
  lastPos: Pt2 | null,
  startNear: { x: number; y: number } | undefined,
  travelObstacles: TravelSafetyObstacles,
): { index: number; ring: Pt2[] } {
  if (lastPos === null && startNear === undefined) return { index: 0, ring: rings[0] }

  const target: Pt2 = lastPos ?? [startNear!.x, startNear!.y]

  // Flatten all (ring, vertex) pairs and sort by distance to target.
  // Walking nearest-first lets us stop at the first safe vertex, reducing
  // isTravelSafe calls from O(total_vertices) to O(1) in the typical case.
  type Candidate = { ri: number; vi: number; distSq: number }
  const candidates: Candidate[] = []
  for (let ri = 0; ri < rings.length; ri++) {
    const raw = rings[ri]
    for (let vi = 0; vi < raw.length; vi++) {
      const dx = raw[vi][0] - target[0], dy = raw[vi][1] - target[1]
      candidates.push({ ri, vi, distSq: dx * dx + dy * dy })
    }
  }
  candidates.sort((a, b) => a.distSq - b.distSq)

  const fallback = candidates[0]

  if (lastPos === null) {
    // No travel safety to check — nearest vertex wins.
    return { index: fallback.ri, ring: rotateRingAt(rings[fallback.ri], fallback.vi) }
  }

  // First candidate reachable without a lift is the best choice.
  for (const c of candidates) {
    if (isTravelSafe(lastPos, rings[c.ri][c.vi], travelObstacles)) {
      return { index: c.ri, ring: rotateRingAt(rings[c.ri], c.vi) }
    }
  }

  // Every entry requires a lift — return the nearest vertex overall.
  return { index: fallback.ri, ring: rotateRingAt(rings[fallback.ri], fallback.vi) }
}

// Emit a sequence of closed contour rings at depth `z`, linking consecutive rings
// with a rapid-at-depth when the direct travel is safe, lifting only when it isn't.
// Each ring's start vertex is rotated to minimise travel from the previous endpoint.
// `obstacles` = [finishingRing, ...islandObstacles] — both already offset by toolRadius.
// When `rampDistMM` is provided each ring entry is a diagonal ramp instead of a plunge.
function emitLinkedContourRings(
  rings: Pt2[][],
  z: number,
  travelObstacles: TravelSafetyObstacles,
  segs: MotionSegment[],
  startNear?: { x: number; y: number },
  rampDistMM?: number,
  prevZ = 0,
  safeZ = 5,
  toolDiameterMM = 0,
  incomingPos: Pt2 | null = null,
): Pt2 | null {
  if (rings.length === 0) return incomingPos
  let lastPos: Pt2 | null = incomingPos
  const pending = [...rings]
  let emittedCount = 0

  while (pending.length > 0) {
    const next = chooseNextContourRing(pending, lastPos, startNear, travelObstacles)
    pending.splice(next.index, 1)
    const ring = next.ring
    const [sx, sy]: Pt2 = ring[0]

    if (rampDistMM !== undefined) {
      // Ramp starts rampDist BEFORE the ring's start vertex and cuts toward it,
      // arriving at full depth exactly at (sx, sy). The first ring of every depth
      // level must ramp from prevZ to z even when linked from the prior level.
      const { touchdown, sampleAt } = rampLeadIn(ring, false, rampDistMM)
      const [rampStartX, rampStartY] = touchdown
      const firstRingAtDepth = emittedCount === 0 && Math.abs(z - prevZ) > 1e-6
      const canTravelAtDepth = lastPos !== null && isTravelSafe(lastPos, [sx, sy], travelObstacles)
      const rampNeeded = firstRingAtDepth || !canTravelAtDepth

      if (rampNeeded) {
        if (lastPos !== null && !canTravelAtDepth) {
          segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })
          segs.push({ x: rampStartX, y: rampStartY, z: safeZ, rapid: true })
          segs.push({ x: rampStartX, y: rampStartY, z: prevZ, rapid: true })
        } else if (lastPos === null) {
          segs.push({ x: rampStartX, y: rampStartY, z: safeZ, rapid: true })
          segs.push({ x: rampStartX, y: rampStartY, z: prevZ, rapid: true })
        } else {
          segs.push({ x: rampStartX, y: rampStartY, z: prevZ, rapid: false })
        }

        emitRampDescent(segs, sampleAt, prevZ, z, 12)
      } else {
        if (lastPos) emitCutTransition(segs, lastPos, [sx, sy], z, toolDiameterMM, safeZ)
        else segs.push({ x: sx, y: sy, z, rapid: false })
      }
      // Tool is now at (sx, sy, z) — cut full perimeter; this also re-cuts the ramp
      // groove section at full depth, leaving a clean finish.
      for (let j = 1; j < ring.length; j++) segs.push({ x: ring[j][0], y: ring[j][1], z, rapid: false })
      segs.push({ x: sx, y: sy, z, rapid: false })

      lastPos = [sx, sy]
    } else {
      if (lastPos === null || !isTravelSafe(lastPos, [sx, sy], travelObstacles)) {
        if (lastPos !== null) segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })
        segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
        segs.push({ x: sx, y: sy, z, rapid: false })
      } else {
        if (lastPos) emitCutTransition(segs, lastPos, [sx, sy], z, toolDiameterMM, safeZ)
        else segs.push({ x: sx, y: sy, z, rapid: false })
      }

      for (let j = 1; j < ring.length; j++) segs.push({ x: ring[j][0], y: ring[j][1], z, rapid: false })
      segs.push({ x: sx, y: sy, z, rapid: false })
      lastPos = [sx, sy]
    }
    emittedCount++
  }

  return lastPos
}


// ─── Trochoidal utilities ──────────────────────────────────────────────────────

// Generates a prolate cycloid (trochoidal) toolpath along a guide row.
// The tool traces tight overlapping loops that advance by stepoverMM per loop,
// producing the Spirograph-like pattern of trochoidal milling.
// loopRadius: amplitude of each loop (perpendicular oscillation); use toolRadius.
// The ratio loopRadius / r (where r = stepoverMM/(2π)) controls loop tightness;
// at 10–20% stepover the ratio is ~15–30, giving strong Spirograph looping.
export function generateTrochoidalRow(
  start: Pt2,
  end: Pt2,
  loopRadius: number,
  stepoverMM: number,
  wantCCW: boolean,
  z: number,
  segs: MotionSegment[],
  safeZ = 5,
) {
  const dx = end[0] - start[0], dy = end[1] - start[1]
  const len = Math.hypot(dx, dy)
  if (len < stepoverMM) return

  const ux = dx / len, uy = dy / len   // unit vector along row
  // Perpendicular: flip sign to control CCW vs CW loop direction
  const perpSign = wantCCW ? -1 : 1
  const px = perpSign * (-uy)
  const py = perpSign * ux

  // Rolling circle radius: at each 2π increment the guide advances stepoverMM
  const r = stepoverMM / (2 * Math.PI)
  const nLoops = Math.floor(len / stepoverMM)
  if (nLoops === 0) return

  const STEPS = 32   // linear segments per trochoidal loop
  // theta=0 → offset = -loopRadius (start offset perpendicular to row)
  const startX = start[0] - loopRadius * px
  const startY = start[1] - loopRadius * py

  segs.push({ x: startX, y: startY, z: safeZ, rapid: true })
  segs.push({ x: startX, y: startY, z, rapid: false })

  let lastX = startX, lastY = startY
  for (let i = 1; i <= nLoops * STEPS; i++) {
    const theta = i * (2 * Math.PI / STEPS)
    const advance = r * theta - loopRadius * Math.sin(theta)
    const offset  = -loopRadius * Math.cos(theta)
    lastX = start[0] + advance * ux + offset * px
    lastY = start[1] + advance * uy + offset * py
    segs.push({ x: lastX, y: lastY, z, rapid: false })
  }
  segs.push({ x: lastX, y: lastY, z: safeZ, rapid: true })
}

// ─── Strategy implementations ──────────────────────────────────────────────────

function rasterPocket(
  boundary: Pt2[],
  islands: Pt2[][],
  tool: Tool,
  params: PocketParams,
  zDepth: number,
  segs: MotionSegment[],
  prevZ = 0,
  incomingPos: Pt2 | null = null,
): Pt2 | null {
  const safeZ = params.safeHeightMM ?? 5
  const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
  const toolRadius = tool.diameterMM / 2
  const wantCCW = params.direction === 'conventional'
  const rampDist = params.rampIn ? 2 * tool.diameterMM : undefined

  // Island obstacles: offset ALL island rings together so that sub-rings from a
  // split self-intersecting path are treated as one compound shape — avoids miter
  // spikes at shared crossing vertices that would otherwise make the finishing
  // contour cut through the original island material.
  const islandExclusions = growIslands(islands, tool.diameterMM)
  const islandFinish = growIslands(islands, toolRadius)

  // Raster fill: tool centre stays one full diameter inside the boundary wall;
  // the finishing contour covers the remaining tool-radius margin.
  const rasterBoundary = insetRing(boundary, tool.diameterMM)
  const rawScanlines = rasterBoundary.length >= 3
    ? generateScanlines(rasterBoundary, stepoverMM, params.angle ?? 0)
    : []

  // Clip must happen in the rotated frame where scanlines are axis-aligned.
  // Rotate island exclusions into that frame, clip, then rotate results back.
  const angleRad = (params.angle ?? 0) * Math.PI / 180
  const cosF = Math.cos(-angleRad), sinF = Math.sin(-angleRad)
  const cosB = Math.cos(angleRad),  sinB = Math.sin(angleRad)
  const rotPt = ([x, y]: Pt2, c: number, s: number): Pt2 => [x * c - y * s, x * s + y * c]
  const islandExclusionsRot = islandExclusions.map(e => e.map(p => rotPt(p, cosF, sinF)))
  const clippedScanlines = rawScanlines.flatMap(s => {
    const p1r = rotPt(s.p1, cosF, sinF)
    const p2r = rotPt(s.p2, cosF, sinF)
    return clipScanlineAgainstIslands(p1r, p2r, islandExclusionsRot).map(seg => ({
      p1: rotPt(seg.p1, cosB, sinB),
      p2: rotPt(seg.p2, cosB, sinB),
    }))
  })

  // Use the finishing ring (inset by tool radius) as the raster travel-safety edge.
  // The raster boundary (inset by full diameter) eliminates narrow concave passages
  // like star inner corners, so micro-lifts through those areas aren't caught as
  // unsafe. The finishing ring (inset by only tool radius) preserves those concave
  // edges, correctly blocking transitions that would cut through uncleared wall material.
  const finishRing = insetRing(boundary, toolRadius)
  const rasterTravelEdge = finishRing.length >= 3 ? finishRing : boundary
  const rasterEnd = buildRasterPath(
    clippedScanlines,
    { edgeObstacles: [rasterTravelEdge, ...islandFinish], solidObstacles: islandFinish },
    zDepth, segs, incomingPos, rampDist, prevZ, safeZ, tool.diameterMM,
  )

  // Finishing contours: linked without lifts when safe.
  const finishingRings = [
    ...islandFinish,
    ...(finishRing.length >= 3 ? [finishRing] : []),
  ].map(r => ensureWinding(r, wantCCW))
  const finishObstacles = [
    ...(finishRing.length >= 3 ? [finishRing] : []),
    ...islandExclusions,
  ]
  const finishPrevZ = clippedScanlines.length > 0 ? zDepth : prevZ
  return emitLinkedContourRings(
    finishingRings, zDepth,
    { edgeObstacles: finishObstacles, solidObstacles: islandFinish },
    segs, params.startNear, rampDist, finishPrevZ, safeZ, tool.diameterMM, rasterEnd,
  )
}

// Build the nested concentric offset levels that both the contour and spiral
// strategies are made of. levels[0] is the outermost (finishing) ring set —
// the boundary inset by one tool radius; each subsequent level is offset inward
// by one stepover. Every level is an array of component loops (Clipper splits a
// ring that pinches apart into separate polygons automatically), already wound
// to `wantCCW`. Islands are fed as CW holes so the offset grows around them.
function buildOffsetLevels(
  boundary: Pt2[],
  islands: Pt2[][],
  toolRadius: number,
  stepoverMM: number,
  wantCCW: boolean,
  joinType: JoinType = JoinType.Miter,
): Pt2[][][] {
  const toCP = (pts: Pt2[]) => pts.map(([x, y]) => ({ x, y }))
  const fromCP = (r: { x: number; y: number }[]) =>
    stripClosingDuplicate(r.map(({ x, y }) => [x, y] as Pt2))

  // Compound polygon: CCW outer boundary + CW island holes.
  // inflatePathsD with a negative delta shrinks the outer boundary inward and
  // grows the island holes outward simultaneously, so each offset level is a
  // topologically correct ring that avoids every island automatically.
  const subject = [
    toCP(ensureWinding(boundary, true)),
    ...islands.map(isl => toCP(ensureWinding(isl, false))),
  ]

  // Iterative offset: each pass feeds the previous result into the next.
  // The geometry shrinks in complexity each step (fewer points as the polygon
  // collapses), so this is much faster than re-offsetting the original each time.
  // Clipper correctly grows CW hole paths (islands) with each negative-delta step.
  const maxPasses = Math.ceil((Math.sqrt(Math.abs(signedArea(boundary))) / stepoverMM) * 2) + 50
  const levels: Pt2[][][] = []   // levels[0] = finishing (outermost), levels[last] = innermost
  let current = subject
  let delta = toolRadius

  for (let pass = 0; pass < maxPasses; pass++) {
    const result = inflatePathsD(current, -delta, joinType, EndType.Polygon, 4, 6)
    if (result.length === 0) break
    const level = result
      .map(r => fromCP(r))
      .filter(pts => pts.length >= 3 && Math.abs(signedArea(pts)) > 0.01)
      .map(pts => ensureWinding(pts, wantCCW))
    if (level.length === 0) break
    levels.push(level)
    current = result
    delta = stepoverMM
  }

  return levels
}

function contourPocket(
  boundary: Pt2[],
  islands: Pt2[][],
  tool: Tool,
  params: PocketParams,
  zDepth: number,
  segs: MotionSegment[],
  prevZ = 0,
  incomingPos: Pt2 | null = null,
): Pt2 | null {
  const safeZ = params.safeHeightMM ?? 5
  const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
  const toolRadius = tool.diameterMM / 2
  const wantCCW = params.direction === 'conventional'
  const rampDist = params.rampIn ? 2 * tool.diameterMM : undefined

  const levels = buildOffsetLevels(boundary, islands, toolRadius, stepoverMM, wantCCW)

  if (levels.length === 0) return incomingPos

  // Cut innermost rings first, finishing ring last for a clean wall finish.
  const finishingLevel = levels[0]
  const innerLevels = levels.slice(1).reverse()
  const innerRings = innerLevels.flat()

  // Obstacles for travel-safety checks: the finishing rings bound the tool zone.
  const islandObstacles = islands.map(isl => growRing(isl, toolRadius)).filter(o => o.length >= 3)
  const obstacles = [...finishingLevel, ...islandObstacles]

  const travelObstacles = { edgeObstacles: obstacles, solidObstacles: islandObstacles }
  const roughEnd = emitLinkedContourRings(innerRings, zDepth, travelObstacles, segs, params.startNear, rampDist, prevZ, safeZ, tool.diameterMM, incomingPos)
  const finishPrevZ = innerRings.length > 0 ? zDepth : prevZ
  return emitLinkedContourRings(finishingLevel, zDepth, travelObstacles, segs, params.startNear, rampDist, finishPrevZ, safeZ, tool.diameterMM, roughEnd)
}

// ─── Spiral (curvilinear) clearing ───────────────────────────────────────────────
//
// Builds a continuous curvilinear spiral from the same concentric offset levels
// the contour strategy cuts: the nested loops are organized into a containment
// forest, each non-branching chain is morphed into one smooth outward spiral
// (see spiralMorph.ts), and the outer wall is cleaned with a finishing contour.
// This is the offset-ring realization of Bieterman's curvilinear spiral — the
// morph of Leroy et al. 2024 seeded from Clipper offsets instead of isotherms.
//
// Phase 1 scope: single-boundary pockets without islands. The forest/chain code
// is general (a pocket that pinches into lobes yields multiple chains, linked by
// travel moves), but branch linking is a nearest-first heuristic, not yet the
// optimized peak-to-peak routing planned for Phase 2/3.

interface LoopNode {
  loop: Pt2[]
  centroid: Pt2
  children: LoopNode[]
}

// Organize the offset levels into a forest by containment: a loop on level k is
// a child of the loop on level k-1 that contains its centroid. Roots are the
// outermost (level 0) loops.
function buildOffsetForest(levels: Pt2[][][]): LoopNode[] {
  const asNode = (loop: Pt2[]): LoopNode => ({ loop, centroid: centroidOfRing(loop), children: [] })
  let prev: LoopNode[] = levels[0].map(asNode)
  const roots = prev
  for (let k = 1; k < levels.length; k++) {
    const cur = levels[k].map(asNode)
    for (const node of cur) {
      // Find the parent on the previous level whose polygon contains this
      // loop's centroid. Fall back to the nearest-centroid parent if numeric
      // offset noise leaves the point just outside every candidate.
      let parent: LoopNode | null = null
      let bestDistSq = Infinity
      for (const cand of prev) {
        const d = (cand.centroid[0] - node.centroid[0]) ** 2 + (cand.centroid[1] - node.centroid[1]) ** 2
        if (pointInPolygon(node.centroid[0], node.centroid[1], cand.loop)) {
          if (d < bestDistSq) { bestDistSq = d; parent = cand }
        }
      }
      if (!parent) {
        for (const cand of prev) {
          const d = (cand.centroid[0] - node.centroid[0]) ** 2 + (cand.centroid[1] - node.centroid[1]) ** 2
          if (d < bestDistSq) { bestDistSq = d; parent = cand }
        }
      }
      if (parent) parent.children.push(node)
    }
    prev = cur
  }
  return roots
}

interface SpiralChain {
  loopsOuterToInner: Pt2[][]
  // True when the chain's innermost loop is a real leaf (a single-lobe center),
  // so the spiral can seed a circular center fill there. False when the inner
  // end is a branch node (the lobes that split off it are separate chains that
  // clear that interior), in which case the spiral must not seed a center.
  innerIsLeaf: boolean
}

// Decompose the forest into chains. A chain is a maximal run of singly-nested
// loops (each node with exactly one child continues the chain); at a branch
// (>1 child) the chain ends and each child subtree starts a fresh chain. Chains
// are emitted in post-order — child (lobe) chains before their parent — so the
// deepest lobes are plunged first and we climb outward, linking by travel.
function subtreeSize(n: LoopNode): number {
  let s = 1
  for (const c of n.children) s += subtreeSize(c)
  return s
}

// Collapse spurious branches: when a node has several children whose loop centroids
// nearly coincide, they are the SAME lobe split apart by near-duplicate isotherm loops
// (marching-squares over-sampling), not genuinely separate lobes — which would have
// distinct centroids. Keep only the child with the largest subtree per centroid cluster;
// the dropped near-duplicates are covered by the kept chain + the wall finish. Without
// this a near-duplicate ring becomes its own pass (an extra contour overlapping the
// spiral). Recurses so the rule holds at every depth.
function dedupeForestBranches(roots: LoopNode[], tol: number): void {
  const dedupe = (node: LoopNode) => {
    if (node.children.length > 1) {
      const kept: LoopNode[] = []
      for (const child of [...node.children].sort((a, b) => subtreeSize(b) - subtreeSize(a))) {
        if (kept.some(k => Math.hypot(k.centroid[0] - child.centroid[0], k.centroid[1] - child.centroid[1]) < tol)) continue
        kept.push(child)
      }
      node.children = kept
    }
    for (const c of node.children) dedupe(c)
  }
  for (const r of roots) dedupe(r)
}

function forestToChains(roots: LoopNode[]): SpiralChain[] {
  const chains: SpiralChain[] = []
  const walk = (start: LoopNode) => {
    const loopsOuterToInner: Pt2[][] = []
    let innerIsLeaf = true
    let node: LoopNode | null = start
    while (node) {
      loopsOuterToInner.push(node.loop)
      if (node.children.length === 1) {
        node = node.children[0]
      } else {
        innerIsLeaf = node.children.length === 0
        for (const c of node.children) walk(c)   // children pushed before parent
        node = null
      }
    }
    chains.push({ loopsOuterToInner, innerIsLeaf })
  }
  for (const r of roots) walk(r)
  return chains
}

// Emit one chain's spiral: ramp/plunge at the spiral start (chain center) then
// cut the morphed polyline outward to the wall.
function emitSpiralChain(
  spiral: Pt2[],
  zDepth: number,
  travelObstacles: TravelSafetyObstacles,
  segs: MotionSegment[],
  rampDistMM: number | undefined,
  prevZ: number,
  safeZ: number,
  toolDiameterMM: number,
  incomingPos: Pt2 | null,
  // Center-seeded chains may enter with an integrated helix bored CONCENTRIC with the
  // innermost loop (`center` = its centroid); `clearance(p)` is the largest safe bore
  // radius at p. Omitted for branch/island chains, which ramp/plunge instead.
  helix?: { clearance: (p: Pt2) => number; center: Pt2; wantCCW: boolean },
): Pt2 | null {
  if (spiral.length < 2) return incomingPos
  const start = spiral[0]
  const needsLift = incomingPos === null || !isTravelSafe(incomingPos, start, travelObstacles)

  if (needsLift && incomingPos !== null) {
    segs.push({ x: incomingPos[0], y: incomingPos[1], z: safeZ, rapid: true })
  }

  // Integrated helix entry concentric with the innermost loop (clears the middle, joins
  // the spiral tangentially). Falls through to the linear ramp when there's no room.
  const hr = helix ? helix.clearance(helix.center) : 0
  const helixOk = needsLift && helix !== undefined && hr >= 0.6

  // After a helix bore, skip the leading spiral points it already cleared and join at
  // the first uncut point — emitSpiralHelixEntry ends the bore right there.
  let cutFrom = 1
  if (helixOk) {
    cutFrom = emitSpiralHelixEntry(spiral, helix!.center, hr, prevZ, zDepth, helix!.wantCCW, segs, safeZ)
  } else if (needsLift && rampDistMM !== undefined) {
    // Ramp along the first rampDist of the spiral: position the tool that far in,
    // ramp backward to the spiral start descending to depth, then cut the whole
    // spiral forward (re-cutting the ramped section leaves a clean floor). This
    // keeps the ramp inside the path about to be cut, valid even in solid stock.
    const { touchdown, sampleAt } = rampLeadIn(spiral, true, rampDistMM)
    segs.push({ x: touchdown[0], y: touchdown[1], z: safeZ, rapid: true })
    segs.push({ x: touchdown[0], y: touchdown[1], z: prevZ, rapid: true })
    emitRampDescent(segs, sampleAt, prevZ, zDepth, 12)
  } else if (needsLift) {
    segs.push({ x: start[0], y: start[1], z: safeZ, rapid: true })
    segs.push({ x: start[0], y: start[1], z: zDepth, rapid: false })
  } else {
    emitCutTransition(segs, incomingPos!, start, zDepth, toolDiameterMM, safeZ)
  }

  for (let i = cutFrom; i < spiral.length; i++) {
    segs.push({ x: spiral[i][0], y: spiral[i][1], z: zDepth, rapid: false })
  }
  return spiral[spiral.length - 1]
}

function spiralPocket(
  boundary: Pt2[],
  islands: Pt2[][],
  tool: Tool,
  params: PocketParams,
  zDepth: number,
  segs: MotionSegment[],
  prevZ = 0,
  incomingPos: Pt2 | null = null,
): Pt2 | null {
  const safeZ = params.safeHeightMM ?? 5
  const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
  const toolRadius = tool.diameterMM / 2
  const wantCCW = params.direction === 'conventional'
  const rampDist = params.rampIn ? 2 * tool.diameterMM : undefined
  const chordTol = Math.max(0.1, Math.min(0.4, tool.diameterMM * 0.04))

  // Round joins so the spiral's corners are rounded (smooth), not mitred chamfers.
  const levels = buildOffsetLevels(boundary, islands, toolRadius, stepoverMM, wantCCW, JoinType.Round)
  if (levels.length === 0) return incomingPos

  const finishingLevel = levels[0]
  const islandObstacles = islands.map(isl => growRing(isl, toolRadius)).filter(o => o.length >= 3)
  const obstacles = [...finishingLevel, ...islandObstacles]
  const travelObstacles = { edgeObstacles: obstacles, solidObstacles: islandObstacles }

  // Island keep-outs: the outer boundary ring (largest loop of level 0) and the
  // grown islands (round join). Used to keep the spiral from seeding into / cutting
  // through an island, the same way the field spiral does.
  const insetBoundary = finishingLevel.reduce(
    (a, b) => (Math.abs(signedArea(b)) > Math.abs(signedArea(a)) ? b : a), finishingLevel[0])
  const holes = growIslands(islands, toolRadius, JoinType.Round)
  const islandCentroids = islands.map(centroidOfRing)

  // Helix keep-outs: the outer wall + grown island holes (tool-centre paths). Used by
  // center-seeded chains for the integrated helix entry.
  const helixRings = [insetBoundary, ...holes]
  const helixClearance = (p: Pt2) => maxClearHelixRadius(p, helixRings, toolRadius * 0.9)

  // Decompose into chains. forestToChains emits them in post-order (lobes before
  // their parent branch), so we plunge the deepest interior lobes first and climb
  // outward; each later chain links to the previous by travel move. Only leaf
  // chains (true single-lobe centers) seed a circular center spiral; branch
  // chains morph between their loops without one — their interior is cleared by
  // the lobe chains that split off them.
  const chains = forestToChains(buildOffsetForest(levels))
    .filter(c => c.loopsOuterToInner.length > 0)

  let lastPos: Pt2 | null = incomingPos
  let cutAnything = false
  for (const chain of chains) {
    // A chain whose innermost loop encircles an island wraps a hole, not a point:
    // it must not centre-seed (its centre is the solid island).
    const innerLoop = chain.loopsOuterToInner[chain.loopsOuterToInner.length - 1]
    const encirclesIsland = islandCentroids.some(c => pointInPolygon(c[0], c[1], innerLoop))
    const seedCenter = chain.innerIsLeaf && !encirclesIsland

    const innerToOuter = [...chain.loopsOuterToInner].reverse()
    // Full-revolution morph (transitionFrac = 1): the radius grows a constant ~one
    // stepover per turn, so there is no localized seam window — the offset rings blend
    // into one smooth uniform spiral with constant engagement. Unlike the field
    // spiral's isotherms, Clipper offset rings are uniformly spaced, so spreading the
    // step over the whole turn keeps coverage identical (verified) while removing the
    // per-revolution ripple a short window leaves.
    const raw = morphChainToSpiral(innerToOuter, chordTol, stepoverMM, toolRadius, seedCenter, 1)
    // Clamp so no point seeds/cuts into an island or past the wall.
    const spiral = clampSpiralToRegion(raw, insetBoundary, holes)
    if (spiral.length < 2) continue
    const passPrevZ = cutAnything ? zDepth : prevZ
    // Bore concentric with the innermost loop so it meshes with the offset rings — only
    // when its centroid is inside the loop (a non-convex loop's centroid lands outside it
    // and would gouge; those chains ramp in instead).
    const innerCentroid = centroidOfRing(innerLoop)
    const helixOpt = seedCenter && pointInPolygon(innerCentroid[0], innerCentroid[1], innerLoop)
      ? { clearance: helixClearance, center: innerCentroid, wantCCW }
      : undefined
    lastPos = emitSpiralChain(spiral, zDepth, travelObstacles, segs, rampDist, passPrevZ, safeZ, tool.diameterMM, lastPos, helixOpt)
    cutAnything = true
  }

  if (!cutAnything) return incomingPos

  // Clean the outer wall with a finishing contour, as the contour strategy does.
  const finishPrevZ = zDepth
  return emitLinkedContourRings(finishingLevel, zDepth, travelObstacles, segs, params.startNear, rampDist, finishPrevZ, safeZ, tool.diameterMM, lastPos)
}

// ─── Field-based curvilinear spiral (Bieterman/Leroy) ────────────────────────────
//
// Solves a Poisson "temperature" field over the pocket (0 at the walls, peaking on
// the medial ridge), traces its isotherms as structure curves spaced by the radial
// tool engagement, and morphs them into a curvilinear spiral that starts with a
// helix at the field's peak and works outward to the wall. Unlike the offset-ring
// spiral, the first cut is a helix (not a full-width slot), so engagement stays
// limited — this is the cheap approximation of the adaptive clearing path.
//
function distSqPointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const l2 = dx * dx + dy * dy
  let t = l2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const ex = px - (ax + t * dx), ey = py - (ay + t * dy)
  return ex * ex + ey * ey
}

// Largest distance from a set of inner loops out to the nearest edge of a set of
// outer loops (the paper's D_isoHQ, eq. 10, generalized to multiple components).
// Distance is to the nearest EDGE, not vertex — a low-vertex outer loop (e.g. an
// inset square's 4 corners) would otherwise read points mid-edge as far away and
// break the stepover spacing. Inner points subsampled; outer kept as edges.
function setGap(inners: Pt2[][], outers: Pt2[][]): number {
  const subVerts = (loop: Pt2[], target: number) => {
    const step = Math.max(1, Math.floor(loop.length / target))
    const out: Pt2[] = []
    for (let i = 0; i < loop.length; i += step) out.push(loop[i])
    return out
  }
  const outerSegs: [Pt2, Pt2][] = []
  for (const o of outers) {
    const v = subVerts(o, 200)
    for (let i = 0; i < v.length; i++) outerSegs.push([v[i], v[(i + 1) % v.length]])
  }
  if (outerSegs.length === 0) return Infinity
  let maxMin = 0
  for (const inner of inners) {
    for (const p of subVerts(inner, 40)) {
      let mn = Infinity
      for (const [a, b] of outerSegs) {
        const d = distSqPointSeg(p[0], p[1], a[0], a[1], b[0], b[1])
        if (d < mn) mn = d
      }
      if (mn > maxMin) maxMin = mn
    }
  }
  return Math.sqrt(maxMin)
}

// Light Laplacian smoothing of a closed loop — removes the ~1-cell staircase that
// marching squares leaves on the grid, so the isotherm reads as the smooth curve it
// represents. Without this the blocky corners make the corner-fillet smoothing
// explode the point count (and nudge points across walls/islands).
function smoothLoop(loop: Pt2[], iters: number, factor: number): Pt2[] {
  const n = loop.length
  if (n < 5) return loop
  let cur = loop
  for (let it = 0; it < iters; it++) {
    const out: Pt2[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const a = cur[(i - 1 + n) % n], p = cur[i], b = cur[(i + 1) % n]
      out[i] = [p[0] + factor * ((a[0] + b[0]) / 2 - p[0]), p[1] + factor * ((a[1] + b[1]) / 2 - p[1])]
    }
    cur = out
  }
  return cur
}

function isothermLoops(g: FieldGrid, level: number): Pt2[][] {
  return traceIsolines(g, level)
    .map(l => smoothLoop(stripClosingDuplicate(l), 2, 0.5))
    .filter(l => l.length >= 3 && Math.abs(signedArea(l)) > 0.01)
}

// Build the structure-curve levels for the merge-tree spiral, ordered outer →
// inner: levels[0] is the inset boundary (the wall), and each subsequent level is
// the isotherm set one stepover further in. Because isotherms of a multi-maximum
// field split into separate loops near the peaks, each level is a *set* of loops;
// buildOffsetForest then turns the nesting/splits into per-seed chains.
//
// Levels are spaced by distance, not by temperature: the field is flat near a
// peak, so a fixed temperature step would leave huge distance gaps there. Levels
// are decimated per chain (below) to one stepover.
//
// Loops are NOT grouped by temperature: around an island the field is annular, so
// one temperature gives two concentric loops (toward the wall, toward the island)
// at very different distances. Instead we extract isotherm loops densely and nest
// them by area/containment — every loop encircling an island encloses its centre,
// so they sort cleanly by size into one chain wall→ridge→island. This is
// topology-agnostic: a simple disk nests the same way.

// True when a majority of `inner`'s sampled vertices lie inside `outer`. Sampling
// ~12 vertices (not one) makes isotherm nesting robust to marching-squares grid
// noise that can place an individual near-wall vertex just outside its true parent.
function loopMostlyInside(inner: Pt2[], outer: Pt2[]): boolean {
  const SAMPLES = 12
  const step = Math.max(1, Math.floor(inner.length / SAMPLES))
  let tested = 0, inCount = 0
  for (let i = 0; i < inner.length; i += step) {
    tested++
    if (pointInPolygon(inner[i][0], inner[i][1], outer)) inCount++
  }
  return tested > 0 && inCount * 2 > tested
}

function buildIsothermChains(g: FieldGrid, insetBoundary: Pt2[], stepoverMM: number, wantCCW: boolean): SpiralChain[] {
  const wall = ensureWinding(stripClosingDuplicate(insetBoundary), wantCCW)
  const loops: Pt2[][] = [wall]
  const NL = 120
  for (let i = 1; i <= NL; i++) {
    for (const lp of isothermLoops(g, (g.tMax * i) / (NL + 1))) loops.push(ensureWinding(lp, wantCCW))
  }

  // Cull near-coincident loops. The dense extraction over-samples — near the wall
  // consecutive isotherms can sit a small fraction of a stepover apart. Such
  // near-duplicate loops make the majority-vote containment test below ambiguous
  // (~half their vertices straddle each other under grid noise), which fragments a
  // single region into multiple spurious roots/branches — the doubled spiral+contour
  // bug. Keep a loop only when it clears every already-kept (larger) loop by at least
  // a fraction of a stepover; properly spaced loops and separate lobes keep a large
  // gap and survive. Largest-area first so the wall anchors the kept set.
  const areasAll = loops.map(l => Math.abs(signedArea(l)))
  const order = loops.map((_, i) => i).sort((a, b) => areasAll[b] - areasAll[a])
  const minGap = stepoverMM * 0.2
  const kept: Pt2[][] = []
  for (const idx of order) {
    const cand = loops[idx]
    if (kept.every(k => setGap([cand], [k]) >= minGap)) kept.push(cand)
  }

  // Nest the survivors by containment: parent = the smallest-area placed (larger) loop
  // that contains this loop, by MAJORITY VOTE over sampled vertices — robust to both a
  // concave loop's centroid landing in a notch and a near-wall vertex landing just
  // outside its parent from grid noise. `kept` is largest-area first, so any container
  // is placed before its children.
  const keptAreas = kept.map(l => Math.abs(signedArea(l)))
  const nodes: LoopNode[] = kept.map(l => ({ loop: l, centroid: centroidOfRing(l), children: [] }))
  const roots: LoopNode[] = []
  for (let i = 0; i < nodes.length; i++) {
    let parent: LoopNode | null = null
    let parentArea = Infinity
    for (let j = 0; j < i; j++) {
      if (keptAreas[j] < parentArea && loopMostlyInside(kept[i], kept[j])) {
        parent = nodes[j]; parentArea = keptAreas[j]
      }
    }
    if (parent) parent.children.push(nodes[i])
    else roots.push(nodes[i])
  }

  // Belt-and-suspenders: merge any residual near-coincident sibling loops (same lobe)
  // so they don't each become a separate overlapping pass. Genuine lobes have
  // centroids far further apart than one stepover.
  dedupeForestBranches(roots, stepoverMM)

  // Decimate each chain so consecutive kept loops are ≤ one stepover apart.
  return forestToChains(roots)
    .filter(c => c.loopsOuterToInner.length > 0)
    .map(c => ({ loopsOuterToInner: decimateChain(c.loopsOuterToInner, stepoverMM), innerIsLeaf: c.innerIsLeaf }))
}

// Closest point on a closed ring's edges to (px,py).
function nearestPointOnRing(px: number, py: number, ring: Pt2[]): Pt2 {
  let best: Pt2 = ring[0]
  let bestD = Infinity
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const l2 = dx * dx + dy * dy
    let t = l2 > 1e-12 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const qx = a[0] + t * dx, qy = a[1] + t * dy
    const d = (px - qx) ** 2 + (py - qy) ** 2
    if (d < bestD) { bestD = d; best = [qx, qy] }
  }
  return best
}

// Largest helix radius at `p` that keeps a bored circle clear of every keep-out ring
// (the tool-centre paths along walls/islands), capped at `maxR`. 0 (or negative) when
// there's no room. Shared by both spiral strategies' helix entries.
function maxClearHelixRadius(p: Pt2, rings: Pt2[][], maxR: number): number {
  let r = maxR
  for (const ring of rings) {
    if (ring.length < 2) continue
    const np = nearestPointOnRing(p[0], p[1], ring)
    r = Math.min(r, Math.hypot(p[0] - np[0], p[1] - np[1]) - 0.1)
  }
  return r
}

// Clamp every spiral point into the cuttable region: a tool centre may never sit
// inside a grown island (would gouge the island) or outside the inset boundary
// (would over-cut the wall). Out-of-region points are snapped to the nearest
// boundary point, so the tool edge lands exactly on the real island/wall edge.
// This corrects the small over-cut the corner-fillet smoothing can introduce on
// blocky isotherms without giving up its smoothing elsewhere.
function clampSpiralToRegion(spiral: Pt2[], insetBoundary: Pt2[], grownIslands: Pt2[][]): Pt2[] {
  return spiral.map(([x, y]) => {
    let px = x, py = y
    for (const gi of grownIslands) {
      if (gi.length >= 3 && pointInPolygon(px, py, gi)) {
        const n = nearestPointOnRing(px, py, gi)
        px = n[0]; py = n[1]
      }
    }
    if (insetBoundary.length >= 3 && !pointInPolygon(px, py, insetBoundary)) {
      const n = nearestPointOnRing(px, py, insetBoundary)
      px = n[0]; py = n[1]
    }
    return [px, py] as Pt2
  })
}

// Keep loops one stepover apart along a chain (ordered outer→inner): from each
// anchor, take the farthest-in loop still within a stepover, then repeat.
function decimateChain(loops: Pt2[][], stepoverMM: number): Pt2[][] {
  if (loops.length <= 1) return loops
  const kept: Pt2[][] = [loops[0]]
  let anchor = 0, i = 1
  while (i < loops.length) {
    let lastGood = -1, j = i
    while (j < loops.length && setGap([loops[j]], [loops[anchor]]) <= stepoverMM) { lastGood = j; j++ }
    const pick = lastGood === -1 ? i : lastGood
    kept.push(loops[pick])
    anchor = pick
    i = pick + 1
  }
  if (kept[kept.length - 1] !== loops[loops.length - 1]) kept.push(loops[loops.length - 1])
  return kept
}

// How a chain's spiral is entered: 'helix' bores a hole at a point centre; 'ramp'
// descends along the path (island chains / first cut into solid); 'travel' drops
// straight in because the interior is already cleared (branch chains).
type SpiralEntry = 'helix' | 'ramp' | 'travel'

interface FieldSpiralPlan {
  chains: { spiral: Pt2[]; entry: SpiralEntry; helixCenter: Pt2 }[]
  finishRings: Pt2[][]
}

// One-entry cache so the field is solved once per geometry, not once per Z level
// (generatePocket calls the strategy fn for every depth pass of a boundary).
let fieldPlanCache: { key: string; plan: FieldSpiralPlan | null } | null = null

function computeFieldSpiralPlan(boundary: Pt2[], islands: Pt2[][], tool: Tool, params: PocketParams): FieldSpiralPlan | null {
  const toolRadius = tool.diameterMM / 2
  const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
  const wantCCW = params.direction === 'conventional'
  // Coarser chord on the spiral body keeps gcode size sane; sub-0.4 mm facets are
  // invisible on a roughing pass.
  const chordTol = Math.max(0.3, Math.min(0.6, tool.diameterMM * 0.07))

  // Geometry signature: bounding box + a coordinate checksum, so distinct
  // boundaries that happen to share a point count / first vertex don't collide.
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, sum = 0
  for (let i = 0; i < boundary.length; i++) {
    const [x, y] = boundary[i]
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y
    sum += x * (i + 1) + y * (i + 7)
  }
  for (const isl of islands) for (let i = 0; i < isl.length; i++) sum += isl[i][0] * (i + 3) - isl[i][1] * (i + 11)
  const key = [
    tool.diameterMM, params.stepoverPercent, params.direction, params.finishAllowanceMM ?? 0,
    boundary.length, islands.length,
    bx0.toFixed(3), by0.toFixed(3), bx1.toFixed(3), by1.toFixed(3), sum.toFixed(2),
  ].join('|')
  if (fieldPlanCache && fieldPlanCache.key === key) return fieldPlanCache.plan

  const plan = ((): FieldSpiralPlan | null => {
    const inset = insetRing(boundary, toolRadius)
    if (inset.length < 3) return null
    // Round join: the tool-centre path around a convex island corner is an arc of
    // the tool radius, not a sharp mitre — keeps the keep-out free of corners the
    // clamped spiral could chord across.
    const holes = growIslands(islands, toolRadius, JoinType.Round)
    const cell = Math.max(0.25, toolRadius / 4)
    const g = solveField([inset], holes, cell)
    if (g.tMax <= 0) return null

    // Isotherm loops → containment nesting → per-region chains (handles islands).
    const chains = buildIsothermChains(g, inset, stepoverMM, wantCCW)
    if (chains.length === 0) return null
    const islandCentroids = islands.map(centroidOfRing)

    const out: { spiral: Pt2[]; entry: SpiralEntry; helixCenter: Pt2 }[] = []
    for (const chain of chains) {
      // A chain whose innermost loop encircles an island wraps a hole, not a point:
      // it must not centre-fill (its "centre" is the solid island) and it enters by
      // ramp (no helix at the island). The morph still spirals around the island.
      const innerLoop = chain.loopsOuterToInner[chain.loopsOuterToInner.length - 1]
      const encirclesIsland = islandCentroids.some(c => pointInPolygon(c[0], c[1], innerLoop))
      const seedCenter = chain.innerIsLeaf && !encirclesIsland

      const innerToOuter = [...chain.loopsOuterToInner].reverse()
      // Localized transition (default fraction): stays on-contour most of each turn
      // so coverage holds even where consecutive isotherms differ in extent (arm
      // tips). The entry handles the worst-case entry engagement.
      const raw = morphChainToSpiral(innerToOuter, chordTol, stepoverMM, toolRadius, seedCenter)
      // Never let the tool centre enter an island or leave the inset wall.
      const spiral = clampSpiralToRegion(raw, inset, holes)
      if (spiral.length < 2) continue
      // Helix at a true point centre; ramp everywhere else. A branch/saddle chain's
      // start is NOT inside its children's cleared lobes (the lobes are deeper in),
      // so a straight plunge there slots at full engagement — always ramp instead.
      // Bore concentric with the innermost loop so the helix meshes with the spiral —
      // but only when its centroid lies INSIDE the loop. A non-convex (L-shaped) loop's
      // centroid falls in a notch outside it; boring there would gouge the wall, so such
      // chains ramp in instead.
      const helixCenter = centroidOfRing(innerLoop)
      const canHelix = seedCenter && pointInPolygon(helixCenter[0], helixCenter[1], innerLoop)
      out.push({ spiral, entry: canHelix ? 'helix' : 'ramp', helixCenter })
    }
    if (out.length === 0) return null
    // Finish the outer wall and each island wall (the tool-centre path around a
    // grown island is its finishing contour). Islands wound opposite for climb.
    const finishRings = [
      ensureWinding(stripClosingDuplicate(inset), wantCCW),
      ...holes.map(h => ensureWinding(stripClosingDuplicate(h), !wantCCW)),
    ].filter(r => r.length >= 3)
    return { chains: out, finishRings }
  })()

  fieldPlanCache = { key, plan }
  return plan
}

function fieldSpiralPocket(
  boundary: Pt2[],
  islands: Pt2[][],
  tool: Tool,
  params: PocketParams,
  zDepth: number,
  segs: MotionSegment[],
  prevZ = 0,
  incomingPos: Pt2 | null = null,
): Pt2 | null {
  const safeZ = params.safeHeightMM ?? 5
  const toolRadius = tool.diameterMM / 2
  const wantCCW = params.direction === 'conventional'
  const rampDist = params.rampIn ? 2 * tool.diameterMM : undefined

  const plan = computeFieldSpiralPlan(boundary, islands, tool, params)
  if (!plan) return incomingPos
  const { chains, finishRings } = plan

  const islandObstacles = islands.map(isl => growRing(isl, toolRadius)).filter(o => o.length >= 3)
  const obstacles = [...finishRings, ...islandObstacles]
  const travelObstacles = { edgeObstacles: obstacles, solidObstacles: islandObstacles }

  // Largest helix radius at `p` that keeps the bored circle clear of every wall and
  // island (finishRings are the tool-centre paths along them). 0 if there's no room.
  const safeHelixRadius = (p: Pt2) => maxClearHelixRadius(p, finishRings, toolRadius * 0.9)

  const rampIn = (start: Pt2, spiral: Pt2[], passPrevZ: number) => {
    if (lastPos !== null && !isTravelSafe(lastPos, start, travelObstacles)) {
      segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })
    }
    const { touchdown, sampleAt } = rampLeadIn(spiral, true, rampDist ?? 2 * tool.diameterMM)
    segs.push({ x: touchdown[0], y: touchdown[1], z: safeZ, rapid: true })
    segs.push({ x: touchdown[0], y: touchdown[1], z: passPrevZ, rapid: true })
    emitRampDescent(segs, sampleAt, passPrevZ, zDepth, 12)
  }

  let lastPos: Pt2 | null = incomingPos
  let cutAnything = false
  for (const { spiral, entry, helixCenter } of chains) {
    const start = spiral[0]
    const passPrevZ = cutAnything ? zDepth : prevZ
    // Bore concentric with the innermost loop so the helix meshes with the spiral.
    const hr = entry === 'helix' ? safeHelixRadius(helixCenter) : 0
    const helixOk = entry === 'helix' && hr >= 0.6
    let cutFrom = 1
    if (helixOk) {
      // Integrated helix entry: bores the centre and ends at the first uncut point,
      // already moving along the spiral — no straight connector, no redundant seed loop.
      if (lastPos !== null && !isTravelSafe(lastPos, start, travelObstacles)) {
        segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })
      }
      cutFrom = emitSpiralHelixEntry(spiral, helixCenter, hr, passPrevZ, zDepth, wantCCW, segs, safeZ)
    } else {
      // Ramp down along the spiral start — used for branch/island chains and for any
      // helix start with no room to bore (near a wall or island). Also ends at the
      // spiral start, flowing into it.
      rampIn(start, spiral, passPrevZ)
    }
    for (let i = cutFrom; i < spiral.length; i++) {
      segs.push({ x: spiral[i][0], y: spiral[i][1], z: zDepth, rapid: false })
    }
    lastPos = spiral[spiral.length - 1]
    cutAnything = true
  }
  if (!cutAnything) return incomingPos

  // Finish the wall with a contour pass on the inset boundary.
  return emitLinkedContourRings(finishRings, zDepth, travelObstacles, segs, params.startNear, rampDist, zDepth, safeZ, tool.diameterMM, lastPos)
}

// ─── Adaptive (constant-engagement) clearing ─────────────────────────────────────
//
// Delegates to the Adaptive2d engine (a faithful port of FreeCAD's libarea Adaptive.cpp)
// in ./adaptiveClearing. That engine measures cutter engagement analytically and steers the
// tool to hold it constant, so spirals and trochoids emerge automatically. Here we just feed
// it the pocket geometry (boundary + islands) for this depth level and translate its
// motion-type-tagged output paths into MotionSegments — emitting a helix/plunge entry per
// region and lifting only on the engine's "link not clear" relinks.

function adaptivePocket(
  boundary: Pt2[],
  islands: Pt2[][],
  tool: Tool,
  params: PocketParams,
  zDepth: number,
  segs: MotionSegment[],
  prevZ = 0,
  incomingPos: Pt2 | null = null,
): Pt2 | null {
  const safeZ = params.safeHeightMM ?? 5
  const dia = tool.diameterMM
  const wantCCW = params.direction === 'conventional'
  const rampIn = params.rampIn ?? false

  // Winding control via geometric reflection. The engine's engagement steering always winds CCW
  // (its tuned, clean path = conventional for an inside pocket). To get the CW/climb path we mirror
  // the geometry across X, clear in the engine's natural mode, then mirror the toolpath back:
  // reflection reverses orientation (CCW→CW) and swaps climb↔conventional, so the flipped result is
  // exactly as clean as the natural one. (Inverting the engine's conventional test instead left the
  // flipped spiral hunting — the angle/interpolation conventions don't invert with it.) wantCCW is
  // true for conventional on an inside pocket, so reflect exactly when we want CW (climb).
  const reflect = !wantCCW
  const mx = reflect ? -1 : 1

  // Geometry for the engine, in CNC mm. The engine offsets the boundary inward and islands
  // outward by the tool radius itself, so feed the raw walls (already allowance-adjusted by
  // generatePocket). paths = boundary + island holes; stock = boundary; cleared = none.
  const toDP = (pts: Pt2[]): Array<[number, number]> => pts.map(([x, y]) => [mx * x, y] as [number, number])
  const geomPaths: Array<Array<[number, number]>> = [toDP(boundary), ...islands.map(toDP)]
  const stock: Array<Array<[number, number]>> = [toDP(boundary)]

  const engine = new Adaptive2d({
    toolDiameter: dia,
    stepOverFactor: params.stepoverPercent / 100,
    tolerance: 0.1,
    stockToLeave: 0,             // allowance already applied upstream in generatePocket
    forceInsideOut: true,        // stay inside the pocket boundary
    finishingProfile: true,      // clean the walls with a finishing contour
    keepToolDownDistRatio: 3.0,
    helixRampMinDiameter: rampIn ? 0 : dia / 8,      // 0 → engine defaults to dia/8
    helixRampTargetDiameter: rampIn ? dia : dia / 8, // small target when not ramping
    opType: OperationType.ClearingInside,
  })

  let outputs: AdaptiveOutput[]
  try {
    outputs = engine.Execute(stock, geomPaths, [])
  } catch (err) {
    console.error('[adaptive] engine failed', err)
    return incomingPos
  }

  // Mirror the toolpath back into real coordinates (no-op when not reflecting).
  if (reflect) for (const out of outputs) {
    out.helixCenter = [mx * out.helixCenter[0], out.helixCenter[1]]
    out.startPoint = [mx * out.startPoint[0], out.startPoint[1]]
    for (const tp of out.adaptivePaths) for (const p of tp.pts) p[0] = mx * p[0]
  }

  let lastPos: Pt2 | null = incomingPos

  for (const out of outputs) {
    if (out.adaptivePaths.length === 0) continue
    const firstCut = out.adaptivePaths[0].pts[0]
    if (!firstCut) continue
    const helixCenter: Pt2 = [out.helixCenter[0], out.helixCenter[1]]
    const helixR = Math.hypot(firstCut[0] - helixCenter[0], firstCut[1] - helixCenter[1])

    // Entry: ramp or plunge from prevZ down to zDepth, then settle on the first cut point.
    if (lastPos !== null) segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })
    if (rampIn && helixR >= 0.1) {
      emitHelicalRamp(helixCenter, helixR, prevZ, zDepth, wantCCW, segs, safeZ)
      segs.push({ x: firstCut[0], y: firstCut[1], z: zDepth, rapid: false })
    } else {
      segs.push({ x: firstCut[0], y: firstCut[1], z: safeZ, rapid: true })
      segs.push({ x: firstCut[0], y: firstCut[1], z: prevZ, rapid: true })
      segs.push({ x: firstCut[0], y: firstCut[1], z: zDepth, rapid: false })
    }
    let cur: Pt2 = [firstCut[0], firstCut[1]]

    for (const tp of out.adaptivePaths) {
      if (tp.pts.length === 0) continue
      if (tp.motion === MotionType.Helix) {
        // Mid-region helix re-entry into a fresh blob: lift, then ramp down at the blob centre.
        // pts = [center, rim]; the rim is the first cut point (helix radius = |rim-center|).
        const center = tp.pts[0]
        const rim = tp.pts[tp.pts.length - 1]
        const hr = Math.hypot(rim[0] - center[0], rim[1] - center[1])
        segs.push({ x: cur[0], y: cur[1], z: safeZ, rapid: true })
        if (hr >= 0.1) {
          emitHelicalRamp([center[0], center[1]], hr, prevZ, zDepth, wantCCW, segs, safeZ)
          segs.push({ x: rim[0], y: rim[1], z: zDepth, rapid: false })
        } else {
          segs.push({ x: center[0], y: center[1], z: safeZ, rapid: true })
          segs.push({ x: center[0], y: center[1], z: zDepth, rapid: false })
        }
        cur = [rim[0], rim[1]]
      } else if (tp.motion === MotionType.LinkNotClear) {
        // Relink that crosses uncleared stock — lift, rapid across, plunge back down.
        const dest = tp.pts[tp.pts.length - 1]
        segs.push({ x: cur[0], y: cur[1], z: safeZ, rapid: true })
        segs.push({ x: dest[0], y: dest[1], z: safeZ, rapid: true })
        segs.push({ x: dest[0], y: dest[1], z: zDepth, rapid: false })
        cur = [dest[0], dest[1]]
      } else if (tp.motion === MotionType.LinkClear) {
        // Stay-down reposition over already-cleared stock — the engine verified it's clear, so
        // traverse it at depth (travel, not a cut). Marked `travel` so it's shown/treated as a
        // rapid-at-depth, not a cutting feed move (that re-machined air and cluttered the view).
        for (const [x, y] of tp.pts) {
          segs.push({ x, y, z: zDepth, rapid: false, travel: true })
          cur = [x, y]
        }
      } else {
        // Cutting move — actual material removal at controlled engagement.
        for (const [x, y] of tp.pts) {
          segs.push({ x, y, z: zDepth, rapid: false })
          cur = [x, y]
        }
      }
    }
    lastPos = cur
  }

  return lastPos
}


// ─── Public API ────────────────────────────────────────────────────────────────

export function generatePocket(
  boundaryD: string,
  tool: Tool,
  params: PocketParams,
): MotionSegment[] {
  let boundaries = splitSelfIntersecting(flattenPath(boundaryD, 0.05))
  if (boundaries.length === 0) throw new Error('No geometry found in boundary path')

  const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
  if (stepoverMM < 0.01) throw new Error('Stepover too small')

  let islands: Pt2[][] = []
  for (const islandD of params.islandDs) {
    for (const ip of splitSelfIntersecting(flattenPath(islandD, 0.05))) {
      if (ip.length >= 3) islands.push(ip)
    }
  }

  // Finish allowance applied per resolved ring (positive insets the boundary + grows
  // islands; negative grows the pocket). Per-ring keeps self-intersecting regions
  // separate, unlike offsetting the raw path as one unit.
  const allowance = params.finishAllowanceMM ?? 0
  if (allowance !== 0) {
    boundaries = boundaries.flatMap(b => { const r = offsetRing(b, -allowance); return r.length >= 3 ? [r] : [] })
    islands = islands.flatMap(isl => { const r = offsetRing(isl, allowance); return r.length >= 3 ? [r] : [] })
    if (boundaries.length === 0) throw new Error('Pocket allowance collapsed the boundary')
  }

  const strategy = params.strategy ?? 'raster'
  const zLevels = zPasses(params.depthMM, params.stepDownMM)
  const segs: MotionSegment[] = []

  const strategyFn = strategy === 'contour'
    ? contourPocket
    : strategy === 'adaptive'
      ? adaptivePocket
      : strategy === 'spiral'
        ? fieldSpiralPocket
        : strategy === 'spiralOffset'
          ? spiralPocket
          : rasterPocket

  let lastPos: Pt2 | null = null
  for (const boundary of boundaries) {
    // Only pass islands whose centroid lies inside this boundary sub-ring.
    // When both the boundary and island paths are self-intersecting they each
    // split into multiple sub-rings; passing a sub-ring from the wrong boundary
    // region as a CW hole corrupts the Clipper compound polygon used by contour
    // and adaptive (stray CW holes outside the CCW boundary create phantom filled
    // regions that offset incorrectly).
    const localIslands = islands.filter(isl => {
      const [cx, cy] = centroidOfRing(isl)
      return pointInPolygon(cx, cy, boundary)
    })
    for (let zi = 0; zi < zLevels.length; zi++) {
      const prevZ = zi === 0 ? 0 : zLevels[zi - 1]
      lastPos = strategyFn(boundary, localIslands, tool, params, zLevels[zi], segs, prevZ, lastPos)
    }
  }

  if (segs.length === 0) throw new Error('Pocket area is too small for the selected tool diameter')

  // Single retract at the end after all depth levels.
  const safeZ = params.safeHeightMM ?? 5
  if (lastPos) segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })

  return simplifyMotion(segs, 0.01)
}

// Collapse collinear runs of motion: within each maximal run of consecutive segments
// that share a move type (same z, rapid, travel, feedScale; no arc/toolChange) the XY
// path is reduced with Douglas–Peucker, so a straight edge traced as many resampled
// points becomes just its endpoints. Ramps/helixes (varying z), arcs and tool changes
// break a run and are never merged, so depth moves stay intact. `tolMM` bounds the
// deviation (tiny — collinear cleanup only). douglasPeucker returns the SAME point
// objects it kept, so we recover their segment indices by reference and keep those
// segments unchanged (each kept segment already carries the correct move attributes).
function simplifyMotion(segs: MotionSegment[], tolMM: number): MotionSegment[] {
  const n = segs.length
  if (n <= 2) return segs
  // Two consecutive moves can share a straight run only if identical in every attribute
  // that affects machining, and at the same Z (so the XY reduction is planar).
  const sameRun = (a: MotionSegment, b: MotionSegment): boolean =>
    !a.arc && !b.arc && !a.toolChange && !b.toolChange &&
    !!a.rapid === !!b.rapid && !!a.travel === !!b.travel &&
    a.feedScale === b.feedScale && a.z === b.z

  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  // Run boundaries: a point whose incoming and outgoing moves differ in type.
  const bounds: number[] = [0]
  for (let i = 1; i < n - 1; i++) {
    if (!sameRun(segs[i], segs[i + 1])) { keep[i] = 1; bounds.push(i) }
  }
  bounds.push(n - 1)

  for (let h = 0; h + 1 < bounds.length; h++) {
    const s = bounds[h], e = bounds[h + 1]
    if (e - s <= 1) continue
    const runPts: Pt2[] = []
    for (let k = s; k <= e; k++) runPts.push([segs[k].x, segs[k].y])
    const simp = douglasPeucker(runPts, tolMM)
    let sp = 0
    for (let k = 0; k < runPts.length && sp < simp.length; k++) {
      if (runPts[k] === simp[sp]) { keep[s + k] = 1; sp++ }
    }
  }

  return segs.filter((_, i) => keep[i])
}

export function generateInfillWithBoundary(
  paths: Pt2[][],
  diameter: number,
  stepover: number,
  angleDeg: number,
): Pt2[] {
  const boundary = paths[0]
  if (!boundary || boundary.length < 3) return []
  const inset = insetRing(boundary, diameter / 2)
  const spacing = diameter * (stepover / 100)
  const segments = generateScanlines(inset, spacing, angleDeg)
  return segments.flatMap(s => [s.p1, s.p2])
}
