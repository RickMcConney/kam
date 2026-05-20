import { flattenPath, ensureWinding, signedArea, rotatePolylineNear, arcFitPolyline, type Pt2 } from './pathFlattener'
import { inflatePathsD, JoinType, EndType } from 'clipper2-ts'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool, CuttingDirection } from '../store/toolStore'
import type { CutSide } from '../store/toolpathStore'
import type { Tab } from '../store/tabStore'

export interface ProfileParams {
  side: CutSide
  depthMM: number
  stepDownMM: number
  direction: CuttingDirection
  startNear?: { x: number; y: number }
  rampIn?: boolean
}

const SAFE_Z = 5.0  // mm above material surface

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

// Evaluate XY at arc-length fraction t across all subpaths (matches TabLayer's evalPathAtT convention).
function designPathAtT(subpaths: Pt2[][], t: number): [number, number] | null {
  let totalLen = 0
  const segs: { pts: Pt2[]; startLen: number; segLen: number }[] = []
  for (const sp of subpaths) {
    let len = 0
    for (let i = 1; i < sp.length; i++) len += Math.hypot(sp[i][0] - sp[i - 1][0], sp[i][1] - sp[i - 1][1])
    segs.push({ pts: sp, startLen: totalLen, segLen: len })
    totalLen += len
  }
  if (totalLen < 1e-6) return null
  const target = t * totalLen
  for (const seg of segs) {
    if (target > seg.startLen + seg.segLen && seg !== segs[segs.length - 1]) continue
    let cum = seg.startLen
    for (let i = 1; i < seg.pts.length; i++) {
      const dx = seg.pts[i][0] - seg.pts[i - 1][0], dy = seg.pts[i][1] - seg.pts[i - 1][1]
      const el = Math.hypot(dx, dy)
      if (cum + el >= target || i === seg.pts.length - 1) {
        const u = el > 1e-10 ? Math.min(1, (target - cum) / el) : 0
        return [seg.pts[i - 1][0] + u * dx, seg.pts[i - 1][1] + u * dy]
      }
      cum += el
    }
  }
  return null
}

// Project (tx, ty) onto a polyline and return the arc-length of the nearest point.
function nearestArcLen(pts: Pt2[], arcLens: number[], tx: number, ty: number): number {
  let bestDist = Infinity, bestLen = 0
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], ay = pts[i - 1][1]
    const bx = pts[i][0], by = pts[i][1]
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    const u = len2 > 1e-10 ? Math.max(0, Math.min(1, ((tx - ax) * dx + (ty - ay) * dy) / len2)) : 0
    const dist = Math.hypot(tx - (ax + u * dx), ty - (ay + u * dy))
    if (dist < bestDist) {
      bestDist = dist
      bestLen = arcLens[i - 1] + u * (arcLens[i] - arcLens[i - 1])
    }
  }
  return bestLen
}

// Compute arc length along a polyline up to each point, plus total length.
function arcLengths(pts: Pt2[]): { lens: number[]; total: number } {
  const lens: number[] = [0]
  for (let i = 1; i < pts.length; i++) {
    lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  }
  return { lens, total: lens[lens.length - 1] }
}

// Interpolate a point at arc-length s along a polyline.
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

// Generate segments for one polyline pass with tab support.
function polylinePassWithTabs(
  pts: Pt2[],
  zDepth: number,
  tabRanges: { start: number; end: number; tabZ: number }[],
  arcLens: number[],
): MotionSegment[] {
  if (tabRanges.length === 0) {
    return pts.slice(1).map(([x, y]) => ({ x, y, z: zDepth, rapid: false }))
  }

  const total = arcLens[arcLens.length - 1]

  function interpXY(s: number): [number, number] {
    s = Math.max(0, Math.min(total, s))
    for (let i = 1; i < pts.length; i++) {
      if (arcLens[i] >= s - 1e-10) {
        const segLen = arcLens[i] - arcLens[i - 1]
        const t = segLen > 1e-10 ? (s - arcLens[i - 1]) / segLen : 0
        return [
          pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]),
          pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1]),
        ]
      }
    }
    return [pts[pts.length - 1][0], pts[pts.length - 1][1]]
  }

  const sorted = [...tabRanges].sort((a, b) => a.start - b.start)

  const segs: MotionSegment[] = []
  let curZ = zDepth
  let ptIdx = 1

  for (const tr of sorted) {
    const tabStart = Math.max(0, tr.start)
    const tabEnd = Math.min(total, tr.end)
    if (tabEnd <= tabStart) continue

    while (ptIdx < pts.length && arcLens[ptIdx] <= tabStart + 1e-6) {
      segs.push({ x: pts[ptIdx][0], y: pts[ptIdx][1], z: curZ, rapid: false })
      ptIdx++
    }

    const [ex, ey] = interpXY(tabStart)
    segs.push({ x: ex, y: ey, z: curZ, rapid: false })
    curZ = tr.tabZ
    segs.push({ x: ex, y: ey, z: curZ, rapid: false })

    while (ptIdx < pts.length && arcLens[ptIdx] < tabEnd - 1e-6) {
      segs.push({ x: pts[ptIdx][0], y: pts[ptIdx][1], z: curZ, rapid: false })
      ptIdx++
    }

    const [fx, fy] = interpXY(tabEnd)
    segs.push({ x: fx, y: fy, z: curZ, rapid: false })
    curZ = zDepth
    segs.push({ x: fx, y: fy, z: curZ, rapid: false })
  }

  while (ptIdx < pts.length) {
    segs.push({ x: pts[ptIdx][0], y: pts[ptIdx][1], z: curZ, rapid: false })
    ptIdx++
  }

  return segs
}

// Remove closing duplicate added by flattenPath's Z handler (last point === first point).
function stripClosingDuplicate(pts: Pt2[]): Pt2[] {
  if (pts.length > 1 && Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) < 1e-6) {
    return pts.slice(0, -1)
  }
  return pts
}

export function generateProfile(
  d: string,
  tool: Tool,
  params: ProfileParams,
  tabs?: Tab[]
): MotionSegment[] {
  const subpaths = flattenPath(d, 0.05)
  if (subpaths.length === 0) throw new Error('No geometry found in path')

  const delta =
    params.side === 'outside' ? tool.diameterMM / 2 :
    params.side === 'inside' ? -tool.diameterMM / 2 : 0

  const passes = zPasses(params.depthMM, params.stepDownMM)
  const segs: MotionSegment[] = []

  // Compute offset paths using Clipper2.
  // Normalize inputs to CCW so positive delta = expand, negative = shrink.
  // Clipper2 handles self-intersections automatically, eliminating the need for
  // the manual resolveOffsetLoops pass.
  let offsetPaths: Pt2[][]
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
  } else {
    offsetPaths = subpaths.map(stripClosingDuplicate).filter(sp => sp.length >= 3)
  }

  const wantCCW = (params.direction === 'climb') !== (params.side === 'inside')

  for (const rawPts of offsetPaths) {
    const oriented = ensureWinding(rawPts, wantCCW)
    const circle = fitCircle(oriented)

    if (circle) {
      // Circle pass — tabs not supported for arc output (rare edge case)
      const { cx, cy, r } = circle
      let sx: number, sy: number
      if (params.startNear) {
        const dx = params.startNear.x - cx, dy = params.startNear.y - cy
        const d = Math.hypot(dx, dy)
        sx = d < 1e-10 ? cx + r : cx + r * dx / d
        sy = d < 1e-10 ? cy     : cy + r * dy / d
      } else {
        sx = cx + r; sy = cy
      }
      const cw = !wantCCW

      segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
      for (const zDepth of passes) {
        segs.push({ x: sx, y: sy, z: zDepth, rapid: false })
        segs.push({ x: sx, y: sy, z: zDepth, rapid: false, arc: { cx, cy, cw } })
      }
      segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
    } else {
      const rotated = params.startNear
        ? rotatePolylineNear(oriented, params.startNear.x, params.startNear.y)
        : oriented
      const [sx, sy] = rotated[0]

      // Append start point so the closing edge is a real segment (needed for tab arc-length math).
      const closed: Pt2[] = [...rotated, rotated[0]]

      const { lens } = arcLengths(closed)

      if (params.rampIn) {
        const rampLen = 2 * tool.diameterMM
        const { lens: rampLens, total } = arcLengths(closed)
        const rampDist = Math.min(rampLen, total * 0.45)
        const [rampEndX, rampEndY] = interpPt(closed, rampLens, rampDist)

        segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
        for (let pi = 0; pi < passes.length; pi++) {
          const zDepth = passes[pi]
          // Ramp starts at the material surface (Z=0) on first pass,
          // or at the previous pass depth on subsequent passes.
          const rampStartZ = pi === 0 ? 0 : passes[pi - 1]

          if (pi > 0) {
            segs.push({ x: rampEndX, y: rampEndY, z: SAFE_Z, rapid: true })
            segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
          }
          // Rapid down to ramp start (surface or previous cut depth)
          segs.push({ x: sx, y: sy, z: rampStartZ, rapid: true })

          // Ramp in: descend from rampStartZ to zDepth while moving along path
          const RAMP_STEPS = 12
          for (let i = 1; i <= RAMP_STEPS; i++) {
            const t = i / RAMP_STEPS
            const [rx, ry] = interpPt(closed, rampLens, t * rampDist)
            segs.push({ x: rx, y: ry, z: rampStartZ + (zDepth - rampStartZ) * t, rapid: false, feedScale: 0.5 })
          }

          // Cut from rampDist back to start (sx, sy)
          for (let i = 1; i < closed.length; i++) {
            if (rampLens[i] > rampDist + 1e-6) {
              segs.push({ x: closed[i][0], y: closed[i][1], z: zDepth, rapid: false })
            }
          }

          // Cleanup: continue past start to ramp endpoint to clear ramp-entry material
          for (let i = 1; i < closed.length; i++) {
            if (rampLens[i] > rampDist + 1e-6) {
              segs.push({ x: rampEndX, y: rampEndY, z: zDepth, rapid: false })
              break
            }
            segs.push({ x: closed[i][0], y: closed[i][1], z: zDepth, rapid: false })
          }
        }
        segs.push({ x: rampEndX, y: rampEndY, z: SAFE_Z, rapid: true })
      } else {
        const tabRanges: { start: number; end: number; tabZ: number }[] = []
        if (tabs && tabs.length > 0) {
          for (const tab of tabs) {
            const pos = designPathAtT(subpaths, tab.t)
            if (!pos) continue
            const center = nearestArcLen(closed, lens, pos[0], pos[1])
            const half = tab.lengthMM / 2 + tool.diameterMM / 2
            tabRanges.push({
              start: center - half,
              end: center + half,
              tabZ: Math.min(0, -params.depthMM + tab.heightMM),
            })
          }
        }

        segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
        for (const zDepth of passes) {
          segs.push({ x: sx, y: sy, z: zDepth, rapid: false })
          const activeRanges = tabRanges.filter((tr) => zDepth < tr.tabZ)
          if (activeRanges.length === 0) {
            const arcSegs = arcFitPolyline(closed, 0.1)
            for (const s of arcSegs) {
              segs.push({ x: s.x, y: s.y, z: zDepth, rapid: false, ...(s.arc ? { arc: s.arc } : {}) })
            }
          } else {
            const passSegs = polylinePassWithTabs(closed, zDepth, activeRanges, lens)
            segs.push(...passSegs)
          }
          segs.push({ x: sx, y: sy, z: zDepth, rapid: false })
        }
        segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
      }
    }
  }

  return segs
}
