import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'

export interface DrillPoint {
  x: number
  y: number
}

export interface DrillParams {
  depthMM: number
  stepDownMM: number
  startNear?: { x: number; y: number }
  safeHeightMM?: number
}

function nearestNeighbourOrder(pts: DrillPoint[], startX: number, startY: number): DrillPoint[] {
  const remaining = [...pts]
  const ordered: DrillPoint[] = []
  let cx = startX, cy = startY
  while (remaining.length > 0) {
    let bestIdx = 0, bestDist = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const d = (remaining[i].x - cx) ** 2 + (remaining[i].y - cy) ** 2
      if (d < bestDist) { bestDist = d; bestIdx = i }
    }
    ordered.push(remaining[bestIdx])
    cx = remaining[bestIdx].x; cy = remaining[bestIdx].y
    remaining.splice(bestIdx, 1)
  }
  return ordered
}

function zPasses(depthMM: number, stepDownMM: number): number[] {
  const passes: number[] = []
  const step = Math.abs(stepDownMM)
  let z = -step
  while (z > -depthMM) { passes.push(z); z -= step }
  passes.push(-Math.abs(depthMM))
  return passes
}

export function generatePeckDrill(
  points: DrillPoint[],
  _tool: Tool,
  params: DrillParams
): MotionSegment[] {
  if (points.length === 0) throw new Error('No drill points specified')
  const safeZ = params.safeHeightMM ?? 5
  const zLevels = zPasses(params.depthMM, params.stepDownMM)
  const segs: MotionSegment[] = []

  const ordered = params.startNear
    ? nearestNeighbourOrder(points, params.startNear.x, params.startNear.y)
    : points

  for (const pt of ordered) {
    segs.push({ x: pt.x, y: pt.y, z: safeZ, rapid: true })
    for (const zDepth of zLevels) {
      segs.push({ x: pt.x, y: pt.y, z: zDepth, rapid: false })
      segs.push({ x: pt.x, y: pt.y, z: safeZ, rapid: true })
    }
  }

  return segs
}

// Helical drilling: spiral down at outermost radius (G3/CCW arc), then concentric flat
// arc passes inward to clear the full hole interior.
// helicalRadius = holeRadius - tool.diameterMM / 2 (must be > 0)
export function generateHelicalDrill(
  centerX: number,
  centerY: number,
  helicalRadius: number,
  tool: Tool,
  params: DrillParams
): MotionSegment[] {
  if (helicalRadius <= 0) {
    // Tool is larger than the hole — fall back to peck drilling at center
    return generatePeckDrill([{ x: centerX, y: centerY }], tool, params)
  }

  const safeZ = params.safeHeightMM ?? 5
  const zLevels = zPasses(params.depthMM, params.stepDownMM)
  const stepoverMM = tool.diameterMM * 0.4

  // Radii for flat cleanup passes: outermost first, stepping inward to center
  const radii: number[] = []
  for (let r = helicalRadius; r > stepoverMM / 2; r -= stepoverMM) radii.push(r)
  radii.push(0) // center peck to ensure core is cleared

  // Start point: rightmost point of helix circle (I = -r, J = 0 → clean G-code)
  const sx = centerX + helicalRadius

  const segs: MotionSegment[] = []
  segs.push({ x: sx, y: centerY, z: safeZ, rapid: true })

  let prevZ = safeZ
  let firstPass = true

  for (const zDepth of zLevels) {
    // Between passes, machine is at (cx, cy, prevZ) after center peck.
    // Move back to helix start position at the same Z before descending.
    if (!firstPass) {
      segs.push({ x: sx, y: centerY, z: prevZ, rapid: false })
    }
    firstPass = false

    // Helical descent: one full CCW revolution from prevZ down to zDepth (G3).
    segs.push({ x: sx, y: centerY, z: zDepth, rapid: false, arc: { cx: centerX, cy: centerY, cw: false } })
    prevZ = zDepth

    // Flat cleanup arc passes working inward.
    for (const r of radii) {
      if (r === 0) {
        segs.push({ x: centerX, y: centerY, z: zDepth, rapid: false })
      } else {
        // After the helical descent we're already at (sx, cy) = (cx+helicalRadius, cy).
        // For smaller radii, move to the new start position first.
        if (r !== helicalRadius) {
          segs.push({ x: centerX + r, y: centerY, z: zDepth, rapid: false })
        }
        // Full flat circle arc (CCW = G3).
        segs.push({ x: centerX + r, y: centerY, z: zDepth, rapid: false, arc: { cx: centerX, cy: centerY, cw: false } })
      }
    }
  }

  // Retract from center
  segs.push({ x: centerX, y: centerY, z: safeZ, rapid: true })

  return segs
}
