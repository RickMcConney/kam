import { flattenPath, offsetPolygon, signedArea, rotatePolylineNear, type Pt2 } from './pathFlattener'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import type { PocketParams } from './pocket'

const SAFE_Z = 5.0

function zPasses(depthMM: number, stepDownMM: number): number[] {
  const passes: number[] = []
  const step = Math.abs(stepDownMM)
  let z = -step
  while (z > -depthMM) { passes.push(z); z -= step }
  passes.push(-Math.abs(depthMM))
  return passes
}

// Returns negative of standard signed area (positive = CW in Y-up).
function getArea(path: Pt2[]): number {
  let area = 0
  for (let i = 0; i < path.length; i++) {
    const p1 = path[i]
    const p2 = path[(i + 1) % path.length]
    area += (p2[0] - p1[0]) * (p2[1] + p1[1])
  }
  return area
}

// Inset a polygon inward by delta. Returns [] if the polygon collapses.
function insetPolygon(path: Pt2[], delta: number): Pt2[] {
  // Deduplicate consecutive points and remove closing duplicate
  const u: Pt2[] = [path[0]]
  for (let i = 1; i < path.length; i++) {
    if (Math.hypot(path[i][0] - u[u.length - 1][0], path[i][1] - u[u.length - 1][1]) > 1e-6) u.push(path[i])
  }
  if (u.length > 1 && Math.hypot(u[u.length - 1][0] - u[0][0], u[u.length - 1][1] - u[0][1]) < 1e-6) u.pop()
  if (u.length < 3) return []

  const area = getArea(u)
  // Force CW so that [dy, -dx] is the inward normal
  const normalized = area > 0 ? u : [...u].reverse()
  const len = normalized.length

  const offset: Pt2[] = []
  for (let i = 0; i < len; i++) {
    const prev = normalized[(i - 1 + len) % len]
    const curr = normalized[i]
    const next = normalized[(i + 1) % len]

    const dx1 = curr[0] - prev[0], dy1 = curr[1] - prev[1]
    const dx2 = next[0] - curr[0], dy2 = next[1] - curr[1]
    const l1 = Math.hypot(dx1, dy1) || 1
    const l2 = Math.hypot(dx2, dy2) || 1

    const n1: Pt2 = [dy1 / l1, -dx1 / l1]
    const n2: Pt2 = [dy2 / l2, -dx2 / l2]

    const mx = n1[0] + n2[0]
    const my = n1[1] + n2[1]
    const mLenSq = mx * mx + my * my

    // miterScale = 1/cos(half_angle); cap at 4× to avoid spikes at very sharp corners
    let miterScale = 2 / mLenSq
    if (miterScale > 4) miterScale = 4

    offset.push([curr[0] + mx * miterScale * delta, curr[1] + my * miterScale * delta])
  }

  // If the polygon inverted or didn't shrink, it collapsed
  if (Math.abs(getArea(offset)) >= Math.abs(area) || offset.length < 3) return []

  return offset
}

// Scan-line fill inside an inset boundary. Returns one {p1,p2} per horizontal strip.
function generateScanlines(
  insetBoundary: Pt2[],
  spacingMM: number,
  angleDeg: number,
): { p1: Pt2; p2: Pt2 }[] {
  if (insetBoundary.length < 3) return []

  const angleRad = (angleDeg * Math.PI) / 180
  const cosA = Math.cos(-angleRad), sinA = Math.sin(-angleRad)
  const cosR = Math.cos(angleRad), sinR = Math.sin(angleRad)

  const rotated = insetBoundary.map(pt => ({
    x: pt[0] * cosA - pt[1] * sinA,
    y: pt[0] * sinA + pt[1] * cosA,
  }))

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

// Grow a polygon outward by delta (CCW-oriented input).
function growPolygon(pts: Pt2[], delta: number): Pt2[] {
  const oriented = signedArea(pts) >= 0 ? pts : [...pts].reverse()
  const result = offsetPolygon(oriented, delta)
  return result.length >= 3 ? result : []
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

// Clip a horizontal scanline against pre-expanded exclusion polygons.
// The caller must pass polygons that already encode the full clearance geometry.
// Returns the surviving sub-segments (min 0.1 mm).
function clipScanlineAgainstIslands(
  p1: Pt2, p2: Pt2,
  exclusions: Pt2[][],
): { p1: Pt2; p2: Pt2 }[] {
  if (exclusions.length === 0) return [{ p1, p2 }]
  const y = p1[1]
  const xL = Math.min(p1[0], p2[0])
  const xR = Math.max(p1[0], p2[0])
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
    for (let k = 0; k + 1 < hits.length; k += 2) {
      blocked.push([hits[k], hits[k + 1]])
    }
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

// Greedy nearest-neighbour ordering that minimises lifts.
// Prefers any segment reachable without crossing the boundary over one that requires a lift.
// Within the same reachability class it picks the nearest endpoint.
function buildRasterPath(
  scanlines: { p1: Pt2; p2: Pt2 }[],
  boundaries: Pt2[][],
  zDepth: number,
): MotionSegment[] {
  if (scanlines.length === 0) return []

  const segs: MotionSegment[] = []
  const used = new Array(scanlines.length).fill(false)
  let current: Pt2 | null = null

  for (let remaining = scanlines.length; remaining > 0; remaining--) {
    let bestIdx = -1
    let bestDist = Infinity
    let bestReversed = false
    let bestNeedsLift = true

    for (let i = 0; i < scanlines.length; i++) {
      if (used[i]) continue
      const seg = scanlines[i]

      for (let r = 0; r < 2; r++) {
        const start: Pt2 = r === 0 ? seg.p1 : seg.p2
        const needsLift = current === null || doesSegmentCrossBorder(current, start, boundaries)
        const dist = current ? Math.hypot(start[0] - current[0], start[1] - current[1]) : 0

        // Prefer no-lift over lift; break ties by distance
        if (
          bestIdx === -1 ||
          (!needsLift && bestNeedsLift) ||
          (needsLift === bestNeedsLift && dist < bestDist)
        ) {
          bestIdx = i; bestDist = dist; bestReversed = r === 1; bestNeedsLift = needsLift
        }
      }
    }

    used[bestIdx] = true
    const seg = scanlines[bestIdx]
    const start: Pt2 = bestReversed ? seg.p2 : seg.p1
    const end: Pt2   = bestReversed ? seg.p1 : seg.p2

    if (bestNeedsLift) {
      // Retract from current position (if any), rapid to new start, plunge
      if (current !== null) segs.push({ x: current[0], y: current[1], z: SAFE_Z, rapid: true })
      segs.push({ x: start[0], y: start[1], z: SAFE_Z, rapid: true })
      segs.push({ x: start[0], y: start[1], z: zDepth, rapid: false })
    } else {
      // Rapid at depth — no retract needed
      segs.push({ x: start[0], y: start[1], z: zDepth, rapid: true })
    }

    segs.push({ x: end[0], y: end[1], z: zDepth, rapid: false })
    current = end
  }

  if (current !== null) segs.push({ x: current[0], y: current[1], z: SAFE_Z, rapid: true })
  return segs
}

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

  // Parse island polygons
  const islands: Pt2[][] = []
  for (const islandD of (params.islandDs ?? [])) {
    for (const ip of flattenPath(islandD, 0.05)) {
      if (ip.length >= 3) islands.push(ip)
    }
  }

  // Island offset polygons — computed once, used for both clipping and finishing passes
  const islandExclusions = islands
    .map((isl) => growPolygon(isl, tool.diameterMM))
    .filter((e) => e.length >= 3)
  const islandContours = islands
    .map((isl) => growPolygon(isl, tool.diameterMM / 2))
    .filter((c) => c.length >= 3)

  const rawInsetBoundary = insetPolygon(boundary, tool.diameterMM / 2)
  const insetBoundary = params.startNear && rawInsetBoundary.length >= 3
    ? rotatePolylineNear(rawInsetBoundary, params.startNear.x, params.startNear.y)
    : rawInsetBoundary  // finishing contour path
  const rawScanlines = generateScanlines(
    insetPolygon(boundary, tool.diameterMM),                          // raster stops one radius from wall
    stepoverMM,
    params.angle ?? 0,
  )

  // Clip scanlines against the pre-expanded island exclusion polygons
  const scanlines = rawScanlines.flatMap((s) =>
    clipScanlineAgainstIslands(s.p1, s.p2, islandExclusions)
  )

  if (insetBoundary.length < 3 && scanlines.length === 0) {
    throw new Error('Pocket area is too small for the selected tool diameter')
  }

  const allBoundaries = [boundary, ...islands]

  const zLevels = zPasses(params.depthMM, params.stepDownMM)
  const segs: MotionSegment[] = []

  for (const zDepth of zLevels) {
    // Raster fill: greedy ordering — drain each connected region before lifting
    segs.push(...buildRasterPath(scanlines, allBoundaries, zDepth))

    // Finishing pass: tool centre traces the inset boundary
    if (insetBoundary.length >= 3) {
      const [bx0, by0] = insetBoundary[0]
      segs.push({ x: bx0, y: by0, z: SAFE_Z, rapid: true })
      segs.push({ x: bx0, y: by0, z: zDepth, rapid: false })
      for (let i = 1; i < insetBoundary.length; i++) {
        segs.push({ x: insetBoundary[i][0], y: insetBoundary[i][1], z: zDepth, rapid: false })
      }
      segs.push({ x: bx0, y: by0, z: zDepth, rapid: false })
      segs.push({ x: bx0, y: by0, z: SAFE_Z, rapid: true })
    }

    // Finishing passes around each island
    for (const contour of islandContours) {
      const [cx0, cy0] = contour[0]
      segs.push({ x: cx0, y: cy0, z: SAFE_Z, rapid: true })
      segs.push({ x: cx0, y: cy0, z: zDepth, rapid: false })
      for (let i = 1; i < contour.length; i++) {
        segs.push({ x: contour[i][0], y: contour[i][1], z: zDepth, rapid: false })
      }
      segs.push({ x: cx0, y: cy0, z: zDepth, rapid: false })
      segs.push({ x: cx0, y: cy0, z: SAFE_Z, rapid: true })
    }
  }

  return segs
}

// Exported utilities kept for compatibility
export function doesSegmentCrossBorder(p1: Pt2, p2: Pt2, paths: Pt2[][]): boolean {
  for (const path of paths) {
    for (let i = 0; i < path.length; i++) {
      if (segmentsIntersect(p1, p2, path[i], path[(i + 1) % path.length])) return true
    }
  }
  return false
}

function segmentsIntersect(a: Pt2, b: Pt2, c: Pt2, d: Pt2): boolean {
  const det = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0])
  if (det === 0) return false
  const lambda = ((d[1] - c[1]) * (d[0] - a[0]) + (c[0] - d[0]) * (d[1] - a[1])) / det
  const gamma = ((a[1] - b[1]) * (d[0] - a[0]) + (b[0] - a[0]) * (d[1] - a[1])) / det
  return 0 < lambda && lambda < 1 && 0 < gamma && gamma < 1
}

export function generateInfillWithBoundary(
  paths: Pt2[][],
  diameter: number,
  stepover: number,
  angleDeg: number,
): Pt2[] {
  const boundary = paths[0]
  if (!boundary || boundary.length < 3) return []
  const inset = insetPolygon(boundary, diameter / 2)
  const spacing = diameter * (stepover / 100)
  const segments = generateScanlines(inset, spacing, angleDeg)
  return segments.flatMap(s => [s.p1, s.p2])
}
