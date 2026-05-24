import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'

export interface SurfaceParams {
  widthMM: number
  heightMM: number
  depthMM: number
  stepDownMM: number
  stepoverPercent: number
  passAngleDeg: number
  safeHeightMM?: number
}

function zPasses(depthMM: number, stepDownMM: number): number[] {
  const passes: number[] = []
  const step = Math.abs(stepDownMM)
  let z = -step
  while (z > -depthMM) { passes.push(z); z -= step }
  passes.push(-Math.abs(depthMM))
  return passes
}

function workpieceBounds(widthMM: number, heightMM: number) {
  return { minX: 0, minY: 0, maxX: widthMM, maxY: heightMM }
}

// Clip a raster-space scanline at height ry to the CNC-space workpiece rectangle.
// Returns [startRX, endRX] of the valid raster-X range, or null if the scanline
// misses the workpiece entirely.
// CNC coords: cx = rx*cosA - ry*sinA, cy = rx*sinA + ry*cosA
function clipScanline(
  ry: number, rsMinX: number, rsMaxX: number,
  cosA: number, sinA: number,
  minX: number, maxX: number, minY: number, maxY: number,
): [number, number] | null {
  let lo = rsMinX
  let hi = rsMaxX

  if (Math.abs(cosA) > 1e-10) {
    const xc = ry * sinA
    const t1 = (minX + xc) / cosA
    const t2 = (maxX + xc) / cosA
    lo = Math.max(lo, Math.min(t1, t2))
    hi = Math.min(hi, Math.max(t1, t2))
  } else {
    const cx = -ry * sinA
    if (cx < minX - 1e-10 || cx > maxX + 1e-10) return null
  }

  if (Math.abs(sinA) > 1e-10) {
    const yc = ry * cosA
    const t1 = (minY - yc) / sinA
    const t2 = (maxY - yc) / sinA
    lo = Math.max(lo, Math.min(t1, t2))
    hi = Math.min(hi, Math.max(t1, t2))
  } else {
    const cy = ry * cosA
    if (cy < minY - 1e-10 || cy > maxY + 1e-10) return null
  }

  if (lo > hi + 1e-10) return null
  return [lo, hi]
}

export function generateSurface(tool: Tool, params: SurfaceParams): MotionSegment[] {
  if (tool.type !== 'endmill' && tool.type !== 'ballnose') {
    throw new Error('Surfacing requires an end mill or ball nose tool')
  }
  const safeZ = params.safeHeightMM ?? 5
  const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
  if (stepoverMM < 0.001) throw new Error('Stepover too small')

  const { minX, minY, maxX, maxY } = workpieceBounds(params.widthMM, params.heightMM)

  const θ = (params.passAngleDeg * Math.PI) / 180
  const cosA = Math.cos(θ)
  const sinA = Math.sin(θ)
  const cosB = Math.cos(-θ)
  const sinB = Math.sin(-θ)

  // Rotate workpiece corners into raster space (rotate by -θ) to find scanline extents
  const corners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]
  const raster = corners.map(([x, y]) => [x * cosB - y * sinB, x * sinB + y * cosB])
  const rsMinX = Math.min(...raster.map((c) => c[0]))
  const rsMaxX = Math.max(...raster.map((c) => c[0]))
  const rsMinY = Math.min(...raster.map((c) => c[1]))
  const rsMaxY = Math.max(...raster.map((c) => c[1]))

  const zLevels = zPasses(params.depthMM, params.stepDownMM)
  const segs: MotionSegment[] = []
  segs.push({ x: minX, y: minY, z: safeZ, rapid: true })

  for (const zDepth of zLevels) {
    let firstInLevel = true
    let pass = 0
    let lastX = 0, lastY = 0

    for (let ry = rsMinY; ry <= rsMaxY + 0.001; ry += stepoverMM, pass++) {
      const clampedRY = Math.min(ry, rsMaxY)

      const clip = clipScanline(clampedRY, rsMinX, rsMaxX, cosA, sinA, minX, maxX, minY, maxY)
      if (!clip) continue

      // Zigzag: even passes left-to-right, odd passes right-to-left
      const [clipLo, clipHi] = clip
      const startRX = pass % 2 === 0 ? clipLo : clipHi
      const endRX = pass % 2 === 0 ? clipHi : clipLo

      // Rotate back to CNC space (+θ)
      const sx = startRX * cosA - clampedRY * sinA
      const sy = startRX * sinA + clampedRY * cosA
      const ex = endRX * cosA - clampedRY * sinA
      const ey = endRX * sinA + clampedRY * cosA

      if (firstInLevel) {
        segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
        segs.push({ x: sx, y: sy, z: zDepth, rapid: false })
        firstInLevel = false
      } else {
        // Stay at cut depth — rapid across to next scanline start, no lift
        segs.push({ x: sx, y: sy, z: zDepth, rapid: true })
      }
      segs.push({ x: ex, y: ey, z: zDepth, rapid: false })
      lastX = ex
      lastY = ey
    }

    if (!firstInLevel) {
      segs.push({ x: lastX, y: lastY, z: safeZ, rapid: true })
    }
  }

  return segs
}
