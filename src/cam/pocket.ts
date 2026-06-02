import { flattenPath, signedArea, ensureWinding, splitSelfIntersecting, type Pt2 } from './pathFlattener'
import { Adaptive2d, OperationType, MotionType, type AdaptiveOutput } from './adaptiveClearing'
import { inflatePathsD, JoinType, EndType } from 'clipper2-ts'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool, CuttingDirection } from '../store/toolStore'

export type PocketStrategy = 'raster' | 'contour' | 'adaptive'

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
function growIslands(islands: Pt2[][], delta: number): Pt2[][] {
  if (islands.length === 0) return []
  const result = inflatePathsD(
    islands.map(isl => {
      const clean = stripClosingDuplicate(isl)
      const ccw = signedArea(clean) >= 0 ? clean : [...clean].reverse()
      return ccw.map(([x, y]) => ({ x, y }))
    }),
    delta, JoinType.Miter, EndType.Polygon, 4, 6,
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
        const dx = end[0] - start[0], dy = end[1] - start[1]
        const lineLen = Math.hypot(dx, dy)
        const rampOnLine = Math.min(rampDistMM, lineLen * 0.45)
        const nx = lineLen > 1e-6 ? dx / lineLen : 1
        const ny = lineLen > 1e-6 ? dy / lineLen : 0
        const rex = start[0] + nx * rampOnLine
        const rey = start[1] + ny * rampOnLine
        segs.push({ x: rex, y: rey, z: safeZ, rapid: true })
        segs.push({ x: rex, y: rey, z: prevZ, rapid: true })
        const RAMP_STEPS = 8
        for (let ri = 1; ri <= RAMP_STEPS; ri++) {
          const t = ri / RAMP_STEPS
          segs.push({
            x: rex - nx * t * rampOnLine,
            y: rey - ny * t * rampOnLine,
            z: prevZ + (zDepth - prevZ) * t,
            rapid: false, feedScale: 0.5,
          })
        }
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
      const closed: Pt2[] = [...ring, ring[0]]
      const { lens, total } = arcLengths(closed)
      const rampDist = Math.min(rampDistMM, total * 0.45)
      const rampStartS = total - rampDist
      const [rampStartX, rampStartY] = interpPt(closed, lens, rampStartS)
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

        const RAMP_STEPS = 12
        for (let i = 1; i <= RAMP_STEPS; i++) {
          const t = i / RAMP_STEPS
          const [rx, ry] = interpPt(closed, lens, rampStartS + t * rampDist)
          segs.push({ x: rx, y: ry, z: prevZ + (z - prevZ) * t, rapid: false, feedScale: 0.5 })
        }
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
    const result = inflatePathsD(current, -delta, JoinType.Miter, EndType.Polygon, 4, 6)
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

  // Geometry for the engine, in CNC mm. The engine offsets the boundary inward and islands
  // outward by the tool radius itself, so feed the raw walls (already allowance-adjusted by
  // generatePocket). paths = boundary + island holes; stock = boundary; cleared = none.
  const toDP = (pts: Pt2[]): Array<[number, number]> => pts.map(([x, y]) => [x, y] as [number, number])
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

  return segs
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
