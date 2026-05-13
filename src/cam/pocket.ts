import { flattenPath, offsetPolygon, signedArea, type Pt2 } from './pathFlattener'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool, CuttingDirection } from '../store/toolStore'

export interface PocketParams {
  depthMM: number
  stepDownMM: number
  stepoverPercent: number
  direction: CuttingDirection
  islandDs: string[]
  angle: number
}

const SAFE_Z = 5.0

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
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

function ensureCCW(pts: Pt2[]): Pt2[] {
  return signedArea(pts) >= 0 ? pts : [...pts].reverse()
}

// Shrink polygon inward by delta — works for both CCW and CW input.
// Returns [] when the polygon collapses, inverts, or fails to get smaller.
// The "fails to get smaller" guard is essential for concave/star shapes:
// concave vertices move outward during an inward offset, which can make
// the signed area grow instead of shrink, causing an infinite loop.
function shrink(pts: Pt2[], delta: number): Pt2[] {
  const origArea = signedArea(pts)
  const result = offsetPolygon(pts, -delta)
  if (result.length < 3) return []
  const resultArea = signedArea(result)
  // Winding flipped or area zero → collapsed or inverted
  if (Math.sign(resultArea) !== Math.sign(origArea)) return []
  // Area didn't decrease → pathological (concave/self-intersecting case)
  if (Math.abs(resultArea) >= Math.abs(origArea)) return []
  return result
}

// Grow polygon outward by delta — ensure CCW before growing so direction is predictable.
function grow(pts: Pt2[], delta: number): Pt2[] {
  const oriented = ensureCCW(pts)
  const result = offsetPolygon(oriented, delta)
  if (result.length < 3) return []
  return result
}

function centroid(pts: Pt2[]): Pt2 {
  const x = pts.reduce((s, p) => s + p[0], 0) / pts.length
  const y = pts.reduce((s, p) => s + p[1], 0) / pts.length
  return [x, y]
}

function addContour(pts: Pt2[], z: number, segs: MotionSegment[]) {
  if (pts.length < 2) return
  const [sx, sy] = pts[0]
  segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
  segs.push({ x: sx, y: sy, z, rapid: false })
  for (let i = 1; i < pts.length; i++) {
    segs.push({ x: pts[i][0], y: pts[i][1], z, rapid: false })
  }
  segs.push({ x: sx, y: sy, z, rapid: false })
  segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
}

export function generatePocket(
  boundaryD: string,
  tool: Tool,
  params: PocketParams
): MotionSegment[] {
  const subpaths = flattenPath(boundaryD, 0.05)
  if (subpaths.length === 0) throw new Error('No geometry found in boundary path')
  const boundary = subpaths[0]
  if (boundary.length < 3) throw new Error('Boundary path must be a closed polygon')

  const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
  if (stepoverMM < 0.01) throw new Error('Stepover too small')

  // Parse island polygons
  const islands: Pt2[][] = []
  for (const islandD of params.islandDs) {
    for (const ip of flattenPath(islandD, 0.05)) {
      if (ip.length >= 3) islands.push(ip)
    }
  }

  // Expand each island by tool radius to create no-go zones for the tool center
  const islandObstacles = islands
    .map((isl) => grow(isl, tool.diameterMM / 2))
    .filter((o) => o.length >= 3)

  const boundaryArea = Math.abs(signedArea(boundary))

  // Estimate a generous upper bound on passes: diameter / stepover + 10 buffer.
  // This is a hard safety cap — well-formed shapes terminate via shrink() long before this.
  const maxPasses = Math.ceil((Math.sqrt(boundaryArea) / stepoverMM) * 2) + 50

  // Generate boundary-inward contours.
  const boundaryContours: Pt2[][] = []
  let ring = shrink(boundary, tool.diameterMM / 2)
  let passCount = 0
  while (ring.length >= 3 && passCount++ < maxPasses) {
    const [cx, cy] = centroid(ring)
    const blocked = islandObstacles.some((obs) => pointInPolygon(cx, cy, obs))
    if (!blocked) boundaryContours.push(ring)
    ring = shrink(ring, stepoverMM)
  }

  // Generate island-outward contours (clears around each island)
  const islandContours: Pt2[][] = []
  for (const island of islands) {
    let ir = grow(island, tool.diameterMM / 2)
    let islandPass = 0
    while (ir.length >= 3 && islandPass++ < maxPasses) {
      if (Math.abs(signedArea(ir)) >= boundaryArea * 0.98) break
      const [cx, cy] = centroid(ir)
      if (!pointInPolygon(cx, cy, boundary)) break
      islandContours.push(ir)
      ir = grow(ir, stepoverMM)
    }
  }

  // Combine; conventional reverses the boundary pass order
  const allContours: Pt2[][] =
    params.direction === 'conventional'
      ? [...boundaryContours].reverse().concat(islandContours)
      : [...boundaryContours, ...islandContours]

  if (allContours.length === 0) {
    throw new Error('Pocket area is too small for the selected tool diameter')
  }

  const zLevels = zPasses(params.depthMM, params.stepDownMM)
  const segs: MotionSegment[] = []

  for (const zDepth of zLevels) {
    for (const contour of allContours) {
      addContour(contour, zDepth, segs)
    }
  }

  return segs
}
