import { flattenPath, offsetPolygon, ensureWinding, hasSelfIntersection, resolveOffsetLoops, rotatePolylineNear, arcFitPolyline, type Pt2 } from './pathFlattener'
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
// Used to map design-path tab positions onto the (possibly rotated, offset) toolpath.
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

// Generate segments for one polyline pass with tab support.
// Tabs are arc-length ranges where Z is lifted to tabZ instead of cutting to zDepth.
// Only call this when tabRanges are deeper than zDepth (i.e. zDepth < tr.tabZ for each range).
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

  // Interpolate XY position at arc-length s along the polyline.
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
  let ptIdx = 1  // next polyline point index to emit

  for (const tr of sorted) {
    const tabStart = Math.max(0, tr.start)
    const tabEnd = Math.min(total, tr.end)
    if (tabEnd <= tabStart) continue

    // Emit polyline points before tab entry
    while (ptIdx < pts.length && arcLens[ptIdx] <= tabStart + 1e-6) {
      segs.push({ x: pts[ptIdx][0], y: pts[ptIdx][1], z: curZ, rapid: false })
      ptIdx++
    }

    // Cut to exact tab entry at current depth, then lift Z in place
    const [ex, ey] = interpXY(tabStart)
    segs.push({ x: ex, y: ey, z: curZ, rapid: false })
    curZ = tr.tabZ
    segs.push({ x: ex, y: ey, z: curZ, rapid: false })

    // Traverse interior polyline points at tab height
    while (ptIdx < pts.length && arcLens[ptIdx] < tabEnd - 1e-6) {
      segs.push({ x: pts[ptIdx][0], y: pts[ptIdx][1], z: curZ, rapid: false })
      ptIdx++
    }

    // Move to exact tab exit at tab height, then plunge back to cut depth in place
    const [fx, fy] = interpXY(tabEnd)
    segs.push({ x: fx, y: fy, z: curZ, rapid: false })
    curZ = zDepth
    segs.push({ x: fx, y: fy, z: curZ, rapid: false })
  }

  // Emit remaining points after all tabs
  while (ptIdx < pts.length) {
    segs.push({ x: pts[ptIdx][0], y: pts[ptIdx][1], z: curZ, rapid: false })
    ptIdx++
  }

  return segs
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

  for (const subpath of subpaths) {
    const rawOffset = delta !== 0 ? offsetPolygon(subpath, delta) : subpath
    if (rawOffset.length < 2) continue
    const cleanOffset = (delta !== 0 && hasSelfIntersection(rawOffset))
      ? resolveOffsetLoops(rawOffset, Math.abs(delta))
      : rawOffset
    if (cleanOffset.length < 3) continue

    const wantCCW = (params.direction === 'climb') !== (params.side === 'inside')
    const offsetPts = ensureWinding(cleanOffset, wantCCW)

    const circle = fitCircle(offsetPts)

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
        ? rotatePolylineNear(offsetPts, params.startNear.x, params.startNear.y)
        : offsetPts
      const [sx, sy] = rotated[0]

      // offsetPolygon returns an open polyline — the closing edge (last → first vertex)
      // is implicit. Append the start point so the closing edge is a real segment.
      // Without this, tabs placed on the closing edge are invisible to nearestArcLen
      // and polylinePassWithTabs, and snap to the wrong location.
      const closed: Pt2[] = [...rotated, rotated[0]]

      // Build tab ranges in the closed offset path's arc-length space.
      // Evaluate each tab's physical XY on the original design path, then project onto the
      // closed offset path. This accounts for tool-radius offset, path rotation, and ensures
      // the closing edge is reachable.
      const { lens } = arcLengths(closed)
      const tabRanges: { start: number; end: number; tabZ: number }[] = []
      if (tabs && tabs.length > 0) {
        for (const tab of tabs) {
          const pos = designPathAtT(subpaths, tab.t)
          if (!pos) continue
          const center = nearestArcLen(closed, lens, pos[0], pos[1])
          // Extend by tool radius on each side so the lift starts before the leading
          // edge of the cutter reaches the tab and ends after the trailing edge clears it.
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
        // Only apply a tab range on passes that cut deeper than the tab top (zDepth < tabZ).
        // Shallower passes are above the tab and need no lifting.
        const activeRanges = tabRanges.filter((tr) => zDepth < tr.tabZ)
        if (activeRanges.length === 0) {
          // No tabs — use arc fitting to emit G2/G3 for circular spans
          const arcSegs = arcFitPolyline(closed, 0.1)
          for (const s of arcSegs) {
            segs.push({ x: s.x, y: s.y, z: zDepth, rapid: false, ...(s.arc ? { arc: s.arc } : {}) })
          }
        } else {
          const passSegs = polylinePassWithTabs(closed, zDepth, activeRanges, lens)
          segs.push(...passSegs)
        }
        // Harmless duplicate return-to-start; keeps code consistent across both branches.
        segs.push({ x: sx, y: sy, z: zDepth, rapid: false })
      }
      segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
    }
  }

  return segs
}
