import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'

export interface DrillPoint {
  x: number
  y: number
}

export interface DrillParams {
  depthMM: number
  stepDownMM: number
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

export function generatePeckDrill(
  points: DrillPoint[],
  _tool: Tool,
  params: DrillParams
): MotionSegment[] {
  if (points.length === 0) throw new Error('No drill points specified')
  const zLevels = zPasses(params.depthMM, params.stepDownMM)
  const segs: MotionSegment[] = []

  segs.push({ x: 0, y: 0, z: SAFE_Z, rapid: true })

  for (const pt of points) {
    segs.push({ x: pt.x, y: pt.y, z: SAFE_Z, rapid: true })
    for (const zDepth of zLevels) {
      segs.push({ x: pt.x, y: pt.y, z: zDepth, rapid: false })
      segs.push({ x: pt.x, y: pt.y, z: SAFE_Z, rapid: true })
    }
  }

  return segs
}

// Helical drilling: spiral down at outermost radius, then concentric flat passes
// inward to clear the full hole interior.
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

  const zLevels = zPasses(params.depthMM, params.stepDownMM)
  const stepsPerTurn = 32
  const stepoverMM = tool.diameterMM * 0.4

  // Radii for flat cleanup passes: outermost first, stepping inward to center
  const radii: number[] = []
  for (let r = helicalRadius; r > stepoverMM / 2; r -= stepoverMM) radii.push(r)
  radii.push(0) // center peck to ensure core is cleared

  const segs: MotionSegment[] = []
  segs.push({ x: centerX + helicalRadius, y: centerY, z: SAFE_Z, rapid: true })

  let prevZ = SAFE_Z
  for (const zDepth of zLevels) {
    // Helical descent at outermost radius
    for (let i = 1; i <= stepsPerTurn; i++) {
      const angle = (i / stepsPerTurn) * 2 * Math.PI
      const z = prevZ + ((zDepth - prevZ) * i) / stepsPerTurn
      segs.push({
        x: centerX + helicalRadius * Math.cos(angle),
        y: centerY + helicalRadius * Math.sin(angle),
        z,
        rapid: false,
      })
    }
    prevZ = zDepth

    // Flat cleanup passes working inward
    for (const r of radii) {
      if (r === 0) {
        segs.push({ x: centerX, y: centerY, z: zDepth, rapid: false })
      } else {
        segs.push({ x: centerX + r, y: centerY, z: zDepth, rapid: false })
        for (let i = 1; i <= stepsPerTurn; i++) {
          const angle = (i / stepsPerTurn) * 2 * Math.PI
          segs.push({
            x: centerX + r * Math.cos(angle),
            y: centerY + r * Math.sin(angle),
            z: zDepth,
            rapid: false,
          })
        }
      }
    }
  }

  // Retract from center
  segs.push({ x: centerX, y: centerY, z: prevZ, rapid: false })
  segs.push({ x: centerX, y: centerY, z: SAFE_Z, rapid: true })

  return segs
}
