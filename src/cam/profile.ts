import { flattenPath, offsetPolygon, ensureWinding, hasSelfIntersection, type Pt2 } from './pathFlattener'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool, CuttingDirection } from '../store/toolStore'
import type { CutSide } from '../store/toolpathStore'

export interface ProfileParams {
  side: CutSide
  depthMM: number
  stepDownMM: number
  direction: CuttingDirection
}

const SAFE_Z = 5.0  // mm above material surface

// Returns circle params if pts approximate a circle (std-dev/radius < 1%), else null.
function fitCircle(pts: Pt2[]): { cx: number; cy: number; r: number } | null {
  if (pts.length < 8) return null
  let sx = 0, sy = 0
  for (const [x, y] of pts) { sx += x; sy += y }
  const cx = sx / pts.length, cy = sy / pts.length
  const radii = pts.map(([x, y]) => Math.hypot(x - cx, y - cy))
  const r = radii.reduce((a, b) => a + b, 0) / radii.length
  if (r < 0.1) return null
  const variance = radii.reduce((acc, ri) => acc + (ri - r) ** 2, 0) / radii.length
  return Math.sqrt(variance) / r <= 0.01 ? { cx, cy, r } : null
}

function zPasses(depthMM: number, stepDownMM: number): number[] {
  const passes: number[] = []
  const step = Math.abs(stepDownMM)
  let z = -step
  while (z > -depthMM) { passes.push(z); z -= step }
  passes.push(-Math.abs(depthMM))
  return passes
}

export function generateProfile(
  d: string,
  tool: Tool,
  params: ProfileParams
): MotionSegment[] {
  const subpaths = flattenPath(d, 0.05)
  if (subpaths.length === 0) throw new Error('No geometry found in path')

  const delta =
    params.side === 'outside' ? tool.diameterMM / 2 :
    params.side === 'inside' ? -tool.diameterMM / 2 : 0

  const passes = zPasses(params.depthMM, params.stepDownMM)
  const segs: MotionSegment[] = []

  for (const subpath of subpaths) {
    const rawOffset = delta !== 0 ? offsetPolygon(subpath, delta) : subpath
    if (rawOffset.length < 2) continue
    if (delta !== 0 && hasSelfIntersection(rawOffset)) {
      throw new Error(
        `Tool ⌀${tool.diameterMM}mm is too large for this geometry — the offset path self-intersects (a concave feature is smaller than the tool radius). Use a smaller tool or switch to centerline.`
      )
    }

    // climb+outside/centerline = CCW, climb+inside = CW; conventional inverts
    const wantCCW = (params.direction === 'climb') !== (params.side === 'inside')
    const offsetPts = ensureWinding(rawOffset, wantCCW)

    const circle = fitCircle(offsetPts)

    if (circle) {
      // Emit a single full-circle arc per pass (G2/G3).
      // Start point is exactly on the circle at the rightmost position so I/J are clean.
      const { cx, cy, r } = circle
      const sx = cx + r, sy = cy
      const cw = !wantCCW  // G2=CW, G3=CCW

      for (const zDepth of passes) {
        segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
        segs.push({ x: sx, y: sy, z: zDepth, rapid: false })
        // Full-circle arc: end == start, arc field carries center + direction
        segs.push({ x: sx, y: sy, z: zDepth, rapid: false, arc: { cx, cy, cw } })
        segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
      }
    } else {
      const [sx, sy] = offsetPts[0]

      for (const zDepth of passes) {
        segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
        segs.push({ x: sx, y: sy, z: zDepth, rapid: false })
        for (let i = 1; i < offsetPts.length; i++) {
          segs.push({ x: offsetPts[i][0], y: offsetPts[i][1], z: zDepth, rapid: false })
        }
        segs.push({ x: sx, y: sy, z: zDepth, rapid: false })
        segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
      }
    }
  }

  return segs
}
