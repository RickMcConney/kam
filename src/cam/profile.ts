import { flattenPath, offsetPolygon } from './pathFlattener'
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

  // Lift to safe height at start
  segs.push({ x: 0, y: 0, z: SAFE_Z, rapid: true })

  for (const subpath of subpaths) {
    const offsetPts = delta !== 0 ? offsetPolygon(subpath, delta) : subpath
    if (offsetPts.length < 2) continue

    const [sx, sy] = offsetPts[0]

    for (const zDepth of passes) {
      // Rapid to start (XY)
      segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
      // Plunge to depth (Z only changes here)
      segs.push({ x: sx, y: sy, z: zDepth, rapid: false })
      // Follow path
      for (let i = 1; i < offsetPts.length; i++) {
        segs.push({ x: offsetPts[i][0], y: offsetPts[i][1], z: zDepth, rapid: false })
      }
      // Close loop back to start
      segs.push({ x: sx, y: sy, z: zDepth, rapid: false })
      // Retract
      segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
    }
  }

  return segs
}
