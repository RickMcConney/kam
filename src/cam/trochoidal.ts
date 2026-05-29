import { flattenPath, ensureWinding, signedArea, rotatePolylineNear, arcFitPolyline, splitSelfIntersecting, type Pt2 } from './pathFlattener'
import { inflatePathsD, JoinType, EndType } from 'clipper2-ts'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import type { CutSide } from '../store/toolpathStore'
import type { CuttingDirection } from '../store/toolStore'

export interface TrochoidalParams {
  side: CutSide
  depthMM: number
  stepDownMM: number
  direction: CuttingDirection
  // loopRadius (l): amplitude of each loop — tool swings 0..2l outward from profile wall.
  // Use toolRadius for a 1-diameter-wide clearing pass; larger = wider cut.
  trochRadiusMM: number
  // stepoverMM (w): forward advance along path per complete loop.
  // r = w/(2π) is the rolling-circle radius. Small values (10–20% of toolDia) give
  // the tight Spirograph-like pattern that keeps engagement constant.
  trochStepMM: number
  finishingPass: boolean
  rampIn?: boolean
  startNear?: { x: number; y: number }
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

function stripClosingDuplicate(pts: Pt2[]): Pt2[] {
  if (pts.length > 1 && Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) < 1e-6) {
    return pts.slice(0, -1)
  }
  return pts
}

// Unit tangent at arc-length s along a polyline.
function tangentAt(pts: Pt2[], lens: number[], s: number): [number, number] {
  s = Math.max(0, Math.min(lens[lens.length - 1], s))
  for (let i = 1; i < pts.length; i++) {
    if (lens[i] >= s - 1e-10) {
      const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1]
      const len = Math.hypot(dx, dy)
      if (len > 1e-10) return [dx / len, dy / len]
    }
  }
  const n = pts.length
  const dx = pts[n - 1][0] - pts[n - 2][0], dy = pts[n - 1][1] - pts[n - 2][1]
  const len = Math.hypot(dx, dy)
  return len > 1e-10 ? [dx / len, dy / len] : [1, 0]
}

export function generateTrochoidal(
  d: string,
  tool: Tool,
  params: TrochoidalParams,
): MotionSegment[] {
  const subpaths = splitSelfIntersecting(flattenPath(d, 0.05))
  if (subpaths.length === 0) throw new Error('No geometry found in path')

  const safeZ = params.safeHeightMM ?? 5
  const l = Math.max(0.01, params.trochRadiusMM)  // loop amplitude
  const w = Math.max(0.1, params.trochStepMM)      // stepover per loop
  const r = w / (2 * Math.PI)                      // rolling-circle radius

  const delta =
    params.side === 'outside' ? tool.diameterMM / 2 :
    params.side === 'inside' ? -tool.diameterMM / 2 : 0

  const passes = zPasses(params.depthMM, params.stepDownMM)
  const segs: MotionSegment[] = []

  const wantCCW = (params.direction === 'climb') !== (params.side === 'inside')

  // perpSign controls which side of the offset path the loops swing into (into material,
  // away from the boundary wall). This is NOT the same as pocket.ts's generateTrochoidalRow
  // perpSign — that function operates on straight raster rows where wantCCW means loop
  // direction, not polygon winding. For a polygon boundary the correct sign depends only
  // on direction: climb always needs -1 and conventional always needs +1, regardless of
  // whether the cut is inside or outside.
  //
  // Proof by case:
  //   outside+climb:        CCW polygon, RIGHT of travel = outward → (ty,-tx) → perpSign=-1
  //   outside+conventional: CW polygon,  LEFT of travel  = outward → (-ty,tx) → perpSign=+1
  //   inside+climb:         CW polygon,  RIGHT of travel = inward  → (ty,-tx) → perpSign=-1
  //   inside+conventional:  CCW polygon, LEFT of travel  = inward  → (-ty,tx) → perpSign=+1
  const perpSign = params.direction === 'climb' ? -1 : 1

  // Compute offset paths via Clipper2 (same as profile.ts).
  interface OffsetPath { pts: Pt2[] }
  let offsetPaths: OffsetPath[]
  if (delta !== 0) {
    const inputPaths = subpaths
      .map(sp => stripClosingDuplicate(sp))
      .filter(sp => sp.length >= 3)
      .map(sp => {
        const ccw = signedArea(sp) >= 0 ? sp : [...sp].reverse()
        return ccw.map(([x, y]) => ({ x, y }))
      })
    const result = inflatePathsD(inputPaths, delta, JoinType.Miter, EndType.Polygon, 4, 6)
    offsetPaths = result
      .map(p => stripClosingDuplicate(p.map(({ x, y }) => [x, y] as Pt2)))
      .filter(p => p.length >= 3)
      .map(pts => ({ pts }))
  } else {
    offsetPaths = subpaths
      .map(sp => stripClosingDuplicate(sp))
      .filter(sp => sp.length >= 3)
      .map(pts => ({ pts }))
  }

  const STEPS = 32  // segments per trochoidal loop (matches pocket.ts)

  for (const { pts: rawPts } of offsetPaths) {
    const oriented = ensureWinding(rawPts, wantCCW)
    const rotated = params.startNear
      ? rotatePolylineNear(oriented, params.startNear.x, params.startNear.y)
      : oriented

    // Close polyline for full loop traversal.
    const closed: Pt2[] = [...rotated, rotated[0]]
    const { lens, total } = arcLengths(closed)
    if (total < 1e-6) continue

    const nLoops = Math.floor(total / w)
    if (nLoops === 0) continue

    // Start: tool is on the offset path (offset=0 at θ=0).
    const [p0x, p0y] = closed[0]

    // Ramp spans 2× tool diameter of arc-length advance, split into rampLoops full loops.
    // Matches profile.ts ramp distance convention.
    const rampLoops = params.rampIn
      ? Math.max(1, Math.ceil((2 * tool.diameterMM) / w))
      : 0
    const rampSteps = rampLoops * STEPS

    segs.push({ x: p0x, y: p0y, z: safeZ, rapid: true })

    for (let pi = 0; pi < passes.length; pi++) {
      const zDepth = passes[pi]
      const rampStartZ = pi === 0 ? 0 : passes[pi - 1]

      if (params.rampIn) {
        // Rapid to ramp start Z (surface on first pass, previous depth thereafter).
        // This mirrors profile.ts's ramp entry: position without a full retract on pi > 0.
        segs.push({ x: p0x, y: p0y, z: rampStartZ, rapid: true })
      } else {
        // Straight plunge to depth.
        segs.push({ x: p0x, y: p0y, z: zDepth, rapid: false })
      }

      // Prolate cycloid along the curved offset path.
      // advance(θ) = r*θ - l*sin(θ)   — forward arc-length along the offset path
      // offset(θ)  = l*(1-cos(θ))     — lateral swing: 0 at wall, 2l at peak, 0 at wall
      // The outward perpendicular at each arc-length s is derived from the path tangent.
      for (let i = 1; i <= nLoops * STEPS; i++) {
        const theta = i * (2 * Math.PI / STEPS)
        const advance = r * theta - l * Math.sin(theta)
        const s = Math.min(advance, total)
        const offsetVal = l * (1 - Math.cos(theta))

        const [cx, cy] = interpPt(closed, lens, s)
        const [tx, ty] = tangentAt(closed, lens, s)
        // Outward perpendicular — same sign convention as generateTrochoidalRow in pocket.ts.
        const px = perpSign * (-ty)
        const py = perpSign * tx

        // During ramp: Z descends linearly over the first rampSteps; feedScale 0.5 matches profile.ts.
        let z = zDepth
        let feedScale: number | undefined
        if (params.rampIn && i <= rampSteps) {
          z = rampStartZ + (zDepth - rampStartZ) * (i / rampSteps)
          feedScale = 0.5
        }

        const seg: MotionSegment = { x: cx + offsetVal * px, y: cy + offsetVal * py, z, rapid: false }
        if (feedScale !== undefined) seg.feedScale = feedScale
        segs.push(seg)
      }

      // Return to start to close the loop at full depth.
      segs.push({ x: p0x, y: p0y, z: zDepth, rapid: false })

      // Optional finishing pass: one clean sweep along the offset path.
      if (params.finishingPass) {
        const arcSegs = arcFitPolyline(closed, 0.1)
        for (const s of arcSegs) {
          segs.push({ x: s.x, y: s.y, z: zDepth, rapid: false, ...(s.arc ? { arc: s.arc } : {}) })
        }
      }
    }

    segs.push({ x: p0x, y: p0y, z: safeZ, rapid: true })
  }

  return segs
}
