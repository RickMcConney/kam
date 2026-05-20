import { flattenPath, signedArea, ensureWinding, rotatePolylineNear, type Pt2 } from './pathFlattener'
import { inflatePathsD, JoinType, EndType } from 'clipper2-ts'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool, CuttingDirection } from '../store/toolStore'

export type PocketStrategy = 'raster' | 'contour'

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
}

const SAFE_Z = 5.0

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
  boundaries: Pt2[][],
  zDepth: number,
  rampDistMM?: number,
  prevZ = 0,
): MotionSegment[] {
  if (scanlines.length === 0) return []
  const segs: MotionSegment[] = []
  const used = new Array(scanlines.length).fill(false)
  let current: Pt2 | null = null

  for (let remaining = scanlines.length; remaining > 0; remaining--) {
    let bestIdx = -1, bestDist = Infinity, bestReversed = false, bestNeedsLift = true
    for (let i = 0; i < scanlines.length; i++) {
      if (used[i]) continue
      const seg = scanlines[i]
      for (let r = 0; r < 2; r++) {
        const start: Pt2 = r === 0 ? seg.p1 : seg.p2
        const needsLift = current === null || doesSegmentCrossBorder(current, start, boundaries)
        const dist = current ? Math.hypot(start[0] - current[0], start[1] - current[1]) : 0
        if (bestIdx === -1 || (!needsLift && bestNeedsLift) || (needsLift === bestNeedsLift && dist < bestDist)) {
          bestIdx = i; bestDist = dist; bestReversed = r === 1; bestNeedsLift = needsLift
        }
      }
    }
    used[bestIdx] = true
    const seg = scanlines[bestIdx]
    const start: Pt2 = bestReversed ? seg.p2 : seg.p1
    const end: Pt2   = bestReversed ? seg.p1 : seg.p2
    if (bestNeedsLift) {
      if (current !== null) segs.push({ x: current[0], y: current[1], z: SAFE_Z, rapid: true })
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
        segs.push({ x: rex, y: rey, z: SAFE_Z, rapid: true })
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
        segs.push({ x: start[0], y: start[1], z: SAFE_Z, rapid: true })
        segs.push({ x: start[0], y: start[1], z: zDepth, rapid: false })
      }
    } else {
      segs.push({ x: start[0], y: start[1], z: zDepth, rapid: true })
    }
    segs.push({ x: end[0], y: end[1], z: zDepth, rapid: false })
    current = end
  }
  if (current !== null) segs.push({ x: current[0], y: current[1], z: SAFE_Z, rapid: true })
  return segs
}

// ─── Contour utilities ─────────────────────────────────────────────────────────

// True if the straight-line path from `from` to `to` does not cross any edge of
// any obstacle polygon. Obstacles should be the tool-radius-inset finishing ring
// and tool-radius-grown island exclusion zones — both already encode tool radius,
// so a crossing here means the tool body would violate a boundary.
function travelIsSafe(from: Pt2, to: Pt2, obstacles: Pt2[][]): boolean {
  for (const obs of obstacles) {
    const n = obs.length
    for (let i = 0; i < n; i++) {
      if (segmentsIntersect(from, to, obs[i], obs[(i + 1) % n])) return false
    }
  }
  return true
}

// Emit a sequence of closed contour rings at depth `z`, linking consecutive rings
// with a rapid-at-depth when the direct travel is safe, lifting only when it isn't.
// Each ring's start vertex is rotated to minimise travel from the previous endpoint.
// `obstacles` = [finishingRing, ...islandObstacles] — both already offset by toolRadius.
// When `rampDistMM` is provided each ring entry is a diagonal ramp instead of a plunge.
function emitLinkedContourRings(
  rings: Pt2[][],
  z: number,
  obstacles: Pt2[][],
  segs: MotionSegment[],
  startNear?: { x: number; y: number },
  rampDistMM?: number,
  prevZ = 0,
) {
  if (rings.length === 0) return
  let lastPos: Pt2 | null = null

  for (const raw of rings) {
    // Rotate start vertex to minimise travel from where the tool currently is.
    const ring: Pt2[] = lastPos !== null
      ? rotatePolylineNear(raw, lastPos[0], lastPos[1])
      : startNear !== undefined
        ? rotatePolylineNear(raw, startNear.x, startNear.y)
        : raw
    const [sx, sy]: Pt2 = ring[0]

    if (rampDistMM !== undefined) {
      // Ramp starts rampDist BEFORE the ring's start vertex and cuts toward it,
      // arriving at full depth exactly at (sx, sy). The subsequent full-perimeter
      // pass then cleans the ramp groove — no separate cleanup needed.
      // Only lift+ramp when travel from the last position is not safe; if it is
      // safe the tool is already at depth and can rapid directly to the ring start.
      const rampNeeded = lastPos === null || !travelIsSafe(lastPos, [sx, sy], obstacles)
      if (rampNeeded) {
        const closed: Pt2[] = [...ring, ring[0]]
        const { lens, total } = arcLengths(closed)
        const rampDist = Math.min(rampDistMM, total * 0.45)
        const rampStartS = total - rampDist
        const [rampStartX, rampStartY] = interpPt(closed, lens, rampStartS)

        if (lastPos !== null) segs.push({ x: lastPos[0], y: lastPos[1], z: SAFE_Z, rapid: true })
        segs.push({ x: rampStartX, y: rampStartY, z: SAFE_Z, rapid: true })
        segs.push({ x: rampStartX, y: rampStartY, z: prevZ, rapid: true })

        const RAMP_STEPS = 12
        for (let i = 1; i <= RAMP_STEPS; i++) {
          const t = i / RAMP_STEPS
          const [rx, ry] = interpPt(closed, lens, rampStartS + t * rampDist)
          segs.push({ x: rx, y: ry, z: prevZ + (z - prevZ) * t, rapid: false, feedScale: 0.5 })
        }
      } else {
        segs.push({ x: sx, y: sy, z, rapid: false })
      }
      // Tool is now at (sx, sy, z) — cut full perimeter; this also re-cuts the ramp
      // groove section at full depth, leaving a clean finish.
      for (let j = 1; j < ring.length; j++) segs.push({ x: ring[j][0], y: ring[j][1], z, rapid: false })
      segs.push({ x: sx, y: sy, z, rapid: false })

      lastPos = [sx, sy]
    } else {
      if (lastPos === null || !travelIsSafe(lastPos, [sx, sy], obstacles)) {
        if (lastPos !== null) segs.push({ x: lastPos[0], y: lastPos[1], z: SAFE_Z, rapid: true })
        segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
        segs.push({ x: sx, y: sy, z, rapid: false })
      } else {
        segs.push({ x: sx, y: sy, z, rapid: false })
      }

      for (let j = 1; j < ring.length; j++) segs.push({ x: ring[j][0], y: ring[j][1], z, rapid: false })
      segs.push({ x: sx, y: sy, z, rapid: false })
      lastPos = [sx, sy]
    }
  }

  if (lastPos !== null) segs.push({ x: lastPos[0], y: lastPos[1], z: SAFE_Z, rapid: true })
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

  segs.push({ x: startX, y: startY, z: SAFE_Z, rapid: true })
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
  segs.push({ x: lastX, y: lastY, z: SAFE_Z, rapid: true })
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
) {
  const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
  const toolRadius = tool.diameterMM / 2
  const wantCCW = params.direction === 'conventional'
  const rampDist = params.rampIn ? 2 * tool.diameterMM : undefined

  // Island obstacles: tool centre must stay a full diameter from island edge so
  // the finishing contour around each island is handled separately.
  const islandExclusions = islands.map(isl => growRing(isl, tool.diameterMM)).filter(e => e.length >= 3)
  const islandFinish = islands.map(isl => growRing(isl, toolRadius)).filter(c => c.length >= 3)

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

  // Use islandExclusions (not actual island polygons) so doesSegmentCrossBorder
  // correctly blocks at-depth travel through the uncut ring around each island.
  segs.push(...buildRasterPath(clippedScanlines, [boundary, ...islandExclusions], zDepth, rampDist, prevZ))

  // Finishing contours: island rings then boundary ring, linked without lifts when safe.
  const finishRing = insetRing(boundary, toolRadius)
  const finishingRings = [
    ...islandFinish,
    ...(finishRing.length >= 3 ? [finishRing] : []),
  ].map(r => ensureWinding(r, wantCCW))
  const finishObstacles = [
    ...(finishRing.length >= 3 ? [finishRing] : []),
    ...islandExclusions,
  ]
  emitLinkedContourRings(finishingRings, zDepth, finishObstacles, segs, params.startNear, rampDist, prevZ)
}

function contourPocket(
  boundary: Pt2[],
  islands: Pt2[][],
  tool: Tool,
  params: PocketParams,
  zDepth: number,
  segs: MotionSegment[],
  prevZ = 0,
) {
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

  if (levels.length === 0) return

  // Cut innermost rings first, finishing ring last for a clean wall finish.
  const finishingLevel = levels[0]
  const innerLevels = levels.slice(1).reverse()
  const allRings = [...innerLevels.flat(), ...finishingLevel]

  // Obstacles for travel-safety checks: the finishing rings bound the tool zone.
  const islandObstacles = islands.map(isl => growRing(isl, toolRadius)).filter(o => o.length >= 3)
  const obstacles = [...finishingLevel, ...islandObstacles]

  emitLinkedContourRings(allRings, zDepth, obstacles, segs, params.startNear, rampDist, prevZ)
}


// ─── Public API ────────────────────────────────────────────────────────────────

export function generatePocket(
  boundaryD: string,
  tool: Tool,
  params: PocketParams,
): MotionSegment[] {
  const subpaths = flattenPath(boundaryD, 0.05)
  if (subpaths.length === 0) throw new Error('No geometry found in boundary path')
  const boundary = subpaths[0]
  if (boundary.length < 3) throw new Error('Boundary path must be a closed polygon')

  const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
  if (stepoverMM < 0.01) throw new Error('Stepover too small')

  const islands: Pt2[][] = []
  for (const islandD of params.islandDs) {
    for (const ip of flattenPath(islandD, 0.05)) {
      if (ip.length >= 3) islands.push(ip)
    }
  }

  const strategy = params.strategy ?? 'raster'
  const zLevels = zPasses(params.depthMM, params.stepDownMM)
  const segs: MotionSegment[] = []

  const strategyFn = strategy === 'contour' ? contourPocket : rasterPocket

  for (let zi = 0; zi < zLevels.length; zi++) {
    // prevZ is the surface (0) for the first pass, or the previous cut depth after that.
    const prevZ = zi === 0 ? 0 : zLevels[zi - 1]
    strategyFn(boundary, islands, tool, params, zLevels[zi], segs, prevZ)
  }

  if (segs.length === 0) throw new Error('Pocket area is too small for the selected tool diameter')
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
