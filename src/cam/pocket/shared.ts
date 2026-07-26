// Shared pocket-clearing infrastructure: params/types, the sub-stage profiler,
// polygon offset helpers, travel-safety tests, ramp/helix entry emission,
// offset-level building and contour-ring linking. Imported by every strategy
// module under this directory; the public entry point is ../pocket.ts.
import {  signedArea, ensureWinding, type Pt2 } from '../pathFlattener'
import { perfLog } from '../../debug'
import { inflatePathsD, JoinType, EndType } from 'clipper2-ts'
import {  arcLengths, interpPt, stripClosingDuplicate, pointInPolygon } from '../geom'
import type { MotionSegment } from '../../store/toolpathStore'
import type {  CuttingDirection } from '../../store/toolStore'

// 'morph' is the field-based curvilinear spiral (Poisson isotherms, helix entry — cf.
// Fusion's "Morphed Spiral") — best for chunky pockets and islands. 'spiral' is the
// offset-ring spiral — contour-parallel, so it stays clean on thin/diagonal strokes
// (letters) where the field spiral's ridge fragments. Renamed 2026-06: 'spiral' was
// 'spiralOffset' (UI "offset"); 'morph' was 'spiral' — generatePocket maps the legacy
// ids so older saved projects keep working.
// 'adaptive' is the FreeCAD Adaptive2d port (slow on large pockets, kept intact);
// 'adaptive2' is the fast raster-marching constant-engagement engine (./adaptive2).
export type PocketStrategy = 'raster' | 'contour' | 'adaptive' | 'morph' | 'spiral' | 'adaptive2'

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

export interface TravelSafetyObstacles {
  edgeObstacles: Pt2[][]
  solidObstacles?: Pt2[][]
}

export const MICRO_LIFT_MM = 0.5

// ─── temporary sub-stage profiling (remove once pocket perf work is done) ────────
// Accumulates wall-clock time per named stage across one generatePocket call.
export const _perf = new Map<string, number>()
export function _timed<T>(stage: string, fn: () => T): T {
  const t = performance.now()
  try { return fn() } finally { _perf.set(stage, (_perf.get(stage) ?? 0) + (performance.now() - t)) }
}
export function _perfReset() { _perf.clear() }
export function _perfLog(label: string) {
  if (_perf.size === 0) return
  const parts = [..._perf.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(0)}ms`)
  perfLog(`[perf] pocket/${label} substages: ${parts.join(' | ')}`)
}
// ─── Shared utilities ──────────────────────────────────────────────────────────

export function pointOnSegment(p: Pt2, a: Pt2, b: Pt2, eps = 1e-6): boolean {
  const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])
  if (Math.abs(cross) > eps) return false
  const dot = (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])
  if (dot < -eps) return false
  const lenSq = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2
  return dot <= lenSq + eps
}

export function segmentEdgeIntersectionParams(a: Pt2, b: Pt2, c: Pt2, d: Pt2): number[] {
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

export function addUniqueParam(params: number[], t: number) {
  if (t <= 1e-6 || t >= 1 - 1e-6) return
  if (!params.some(existing => Math.abs(existing - t) < 1e-5)) params.push(t)
}

export function transitionCrossesPolygonEdge(from: Pt2, to: Pt2, poly: Pt2[]): boolean {
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

export function transitionEntersSolidPolygon(from: Pt2, to: Pt2, poly: Pt2[]): boolean {
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

export function isTravelSafe(from: Pt2, to: Pt2, obstacles: TravelSafetyObstacles): boolean {
  if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 1e-6) return true

  for (const poly of obstacles.edgeObstacles) {
    if (transitionCrossesPolygonEdge(from, to, poly)) return false
  }

  for (const poly of obstacles.solidObstacles ?? []) {
    if (transitionEntersSolidPolygon(from, to, poly)) return false
  }

  return true
}

export function offsetRing(pts: Pt2[], delta: number): Pt2[] {
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
export function insetRing(pts: Pt2[], delta: number): Pt2[] {
  const origArea = Math.abs(signedArea(pts))
  const result = offsetRing(pts, -delta)
  if (result.length < 3) return []
  if (Math.abs(signedArea(result)) >= origArea) return []
  return result
}

export function growRing(pts: Pt2[], delta: number): Pt2[] {
  return offsetRing(pts, delta)
}

// Offset multiple island rings together as a compound shape. This is important
// for sub-rings produced by splitSelfIntersecting (e.g. a figure-8 island) —
// offsetting them as a unit avoids miter spikes at shared crossing vertices that
// would otherwise make the finishing contour cut through the original island.
export function growIslands(islands: Pt2[][], delta: number, joinType: JoinType = JoinType.Miter): Pt2[][] {
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

// Finishing contours for a pocket with islands: ONE compound inset — boundary ⊖ R with
// the islands as CW holes — so an island closer than a tool diameter to the outer wall
// (or to another island) pinches/merges into a contour that never swings the tool centre
// past a wall. Growing island rings independently of the boundary gouges the outer wall
// in exactly that case. Output: outer-type loops wound to `wantCCW`, island (hole-type)
// loops wound opposite, so climb stays climb on island walls (material is on the inside
// of an island ring, so the traversal direction must flip to keep the same chip formation).
export function compoundFinishRings(
  boundary: Pt2[],
  islands: Pt2[][],
  toolRadius: number,
  wantCCW: boolean,
  joinType: JoinType = JoinType.Miter,
): Pt2[][] {
  const toCP = (pts: Pt2[], ccw: boolean) =>
    ensureWinding(stripClosingDuplicate(pts), ccw).map(([x, y]) => ({ x, y }))
  return inflatePathsD(
    [toCP(boundary, true), ...islands.map(isl => toCP(isl, false))],
    -toolRadius, joinType, EndType.Polygon, 4, 6,
  )
    .map(r => stripClosingDuplicate(r.map(({ x, y }) => [x, y] as Pt2)))
    .filter(r => r.length >= 3)
    .map(r => ensureWinding(r, signedArea(r) < 0 ? !wantCCW : wantCCW))
}

export function emitCutTransition(
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

export function centroidOfRing(pts: Pt2[]): Pt2 {
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

export function emitHelicalRamp(
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
export function emitHelixBore(
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
export function firstUncutSpiralIndex(spiral: Pt2[], center: Pt2, hr: number): number {
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
export function emitSpiralHelixEntry(
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
export function rampLeadIn(
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
export function emitRampDescent(
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

// ─── Contour utilities ─────────────────────────────────────────────────────────

export function rotateRingAt(pts: Pt2[], index: number): Pt2[] {
  return index === 0 ? pts : [...pts.slice(index), ...pts.slice(0, index)]
}


export function chooseNextContourRing(
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
export function emitLinkedContourRings(
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


export function buildOffsetLevels(
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

  // Incremental offset (feed each result into the next) keeps vertex counts low for
  // MITRE joins — the polygon shrinks in complexity each step, so chaining is cheap.
  // But ROUND joins ADD arc vertices at every corner on each pass, so chaining makes
  // the vertex count grow without bound: ~O(passes²) total, seconds of Clipper time
  // on a big pocket. For round joins, offset the ORIGINAL by a cumulative delta each
  // pass instead, so every ring's vertex count stays bounded by the source geometry.
  // Clipper correctly shrinks the CCW boundary and grows CW island holes either way.
  const fromOriginal = joinType === JoinType.Round
  const maxPasses = Math.ceil((Math.sqrt(Math.abs(signedArea(boundary))) / stepoverMM) * 2) + 50
  const levels: Pt2[][][] = []   // levels[0] = finishing (outermost), levels[last] = innermost
  let current = subject
  let incDelta = toolRadius   // incremental step from the previous ring (mitre path)
  let cumDelta = toolRadius   // cumulative offset from the original (round path)

  for (let pass = 0; pass < maxPasses; pass++) {
    const result = fromOriginal
      ? inflatePathsD(subject, -cumDelta, joinType, EndType.Polygon, 4, 6)
      : inflatePathsD(current, -incDelta, joinType, EndType.Polygon, 4, 6)
    if (result.length === 0) break
    const level = result
      .map(r => fromCP(r))
      .filter(pts => pts.length >= 3 && Math.abs(signedArea(pts)) > 0.01)
      .map(pts => ensureWinding(pts, wantCCW))
    if (level.length === 0) break
    levels.push(level)
    if (!fromOriginal) current = result
    incDelta = stepoverMM
    cumDelta += stepoverMM
  }

  return levels
}


export // Largest distance from a set of inner loops out to the nearest edge of a set of
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

// Squared distance from a point to a segment.
export function distSqPointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const l2 = dx * dx + dy * dy
  let t = l2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const ex = px - (ax + t * dx), ey = py - (ay + t * dy)
  return ex * ex + ey * ey
}
