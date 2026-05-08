import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import type { OriginPosition } from '../store/workpieceStore'

export interface SurfaceParams {
  widthMM: number
  heightMM: number
  origin: OriginPosition
  depthMM: number
  stepDownMM: number
  stepoverPercent: number
  passAngleDeg: number
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

function workpieceBounds(widthMM: number, heightMM: number, origin: OriginPosition) {
  const xOff =
    origin.includes('left') ? 0 :
    origin.includes('right') ? -widthMM :
    -widthMM / 2
  const yOff =
    origin.includes('bottom') ? 0 :
    origin.includes('top') ? -heightMM :
    -heightMM / 2
  return { minX: xOff, minY: yOff, maxX: xOff + widthMM, maxY: yOff + heightMM }
}

export function generateSurface(tool: Tool, params: SurfaceParams): MotionSegment[] {
  if (tool.type !== 'endmill' && tool.type !== 'ballnose') {
    throw new Error('Surfacing requires an end mill or ball nose tool')
  }
  const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
  if (stepoverMM < 0.001) throw new Error('Stepover too small')

  const { minX, minY, maxX, maxY } = workpieceBounds(params.widthMM, params.heightMM, params.origin)

  // Rotate workpiece corners into raster space (rotate by -θ)
  const θ = (params.passAngleDeg * Math.PI) / 180
  const cosA = Math.cos(θ)
  const sinA = Math.sin(θ)
  const cosB = Math.cos(-θ)
  const sinB = Math.sin(-θ)

  const corners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]
  const raster = corners.map(([x, y]) => [x * cosB - y * sinB, x * sinB + y * cosB])
  const rsMinX = Math.min(...raster.map((c) => c[0]))
  const rsMaxX = Math.max(...raster.map((c) => c[0]))
  const rsMinY = Math.min(...raster.map((c) => c[1]))
  const rsMaxY = Math.max(...raster.map((c) => c[1]))

  const zLevels = zPasses(params.depthMM, params.stepDownMM)
  const segs: MotionSegment[] = []
  segs.push({ x: minX, y: minY, z: SAFE_Z, rapid: true })

  for (const zDepth of zLevels) {
    let pass = 0
    for (let ry = rsMinY; ry <= rsMaxY + 0.001; ry += stepoverMM, pass++) {
      const clampedRY = Math.min(ry, rsMaxY)
      // Zigzag: even passes left-to-right, odd passes right-to-left
      const startRX = pass % 2 === 0 ? rsMinX : rsMaxX
      const endRX = pass % 2 === 0 ? rsMaxX : rsMinX

      // Rotate back to CNC space (+θ)
      const sx = startRX * cosA - clampedRY * sinA
      const sy = startRX * sinA + clampedRY * cosA
      const ex = endRX * cosA - clampedRY * sinA
      const ey = endRX * sinA + clampedRY * cosA

      segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
      segs.push({ x: sx, y: sy, z: zDepth, rapid: false })
      segs.push({ x: ex, y: ey, z: zDepth, rapid: false })
      segs.push({ x: ex, y: ey, z: SAFE_Z, rapid: true })
    }
  }

  return segs
}
