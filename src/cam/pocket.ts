// Pocket clearing — public entry point and strategy dispatch.
//
// The six strategies live one-per-file under ./pocket/; everything they share
// (geometry/travel-safety helpers, ramp + helix entry, offset-ring building,
// contour-ring linking, the sub-stage profiler) is in ./pocket/shared.ts.
// fieldSpiral additionally builds on spiral.ts, which owns the loop-forest and
// spiral-clamping code both use.
//
// This file stays the module everything imports — several scripts/ harnesses
// import '../src/cam/pocket.ts' by explicit path — so the split is invisible to
// callers. The 2026-07 split was a pure code move: every strategy's emitted
// toolpath was diffed before/after and is byte-identical.
import { flattenPath, splitSelfIntersecting, douglasPeucker, type Pt2 } from './pathFlattener'
import { zPasses, pointInPolygon } from './geom'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import { _perfReset, _perfLog, _timed, offsetRing, centroidOfRing, type PocketParams } from './pocket/shared'
import { rasterPocket } from './pocket/raster'
import { contourPocket } from './pocket/contour'
import { spiralPocket } from './pocket/spiral'
import { fieldSpiralPocket } from './pocket/fieldSpiral'
import { adaptivePocket } from './pocket/adaptive'
import { adaptive2Pocket } from './pocket/adaptive2'

export type { PocketStrategy, PocketParams } from './pocket/shared'

// ─── Public API ────────────────────────────────────────────────────────────────

export function generatePocket(
  boundaryD: string,
  tool: Tool,
  params: PocketParams,
): MotionSegment[] {
  let boundaries = splitSelfIntersecting(flattenPath(boundaryD, 0.05))
  if (boundaries.length === 0) throw new Error('No geometry found in boundary path')

  const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
  if (stepoverMM < 0.01) throw new Error('Stepover too small')

  let islands: Pt2[][] = []
  for (const islandD of params.islandDs) {
    for (const ip of splitSelfIntersecting(flattenPath(islandD, 0.05))) {
      if (ip.length >= 3) islands.push(ip)
    }
  }

  // Finish allowance applied per resolved ring (positive insets the boundary + grows
  // islands; negative grows the pocket). Per-ring keeps self-intersecting regions
  // separate, unlike offsetting the raw path as one unit.
  const allowance = params.finishAllowanceMM ?? 0
  if (allowance !== 0) {
    boundaries = boundaries.flatMap(b => { const r = offsetRing(b, -allowance); return r.length >= 3 ? [r] : [] })
    islands = islands.flatMap(isl => { const r = offsetRing(isl, allowance); return r.length >= 3 ? [r] : [] })
    if (boundaries.length === 0) throw new Error('Pocket allowance collapsed the boundary')
  }

  // Legacy id from older saved projects/forms: 'spiralOffset' is today's 'spiral'.
  const rawStrategy = (params.strategy ?? 'raster') as string
  const strategy = rawStrategy === 'spiralOffset' ? 'spiral' : rawStrategy
  const zLevels = zPasses(params.depthMM, params.stepDownMM)
  const segs: MotionSegment[] = []

  const strategyFn = strategy === 'contour'
    ? contourPocket
    : strategy === 'adaptive'
      ? adaptivePocket
      : strategy === 'adaptive2'
        ? adaptive2Pocket
        : strategy === 'morph'
          ? fieldSpiralPocket
          : strategy === 'spiral'
            ? spiralPocket
            : rasterPocket

  _perfReset()
  let lastPos: Pt2 | null = null
  for (const boundary of boundaries) {
    // Only pass islands whose centroid lies inside this boundary sub-ring.
    // When both the boundary and island paths are self-intersecting they each
    // split into multiple sub-rings; passing a sub-ring from the wrong boundary
    // region as a CW hole corrupts the Clipper compound polygon used by contour
    // and adaptive (stray CW holes outside the CCW boundary create phantom filled
    // regions that offset incorrectly).
    const localIslands = islands.filter(isl => {
      const [cx, cy] = centroidOfRing(isl)
      return pointInPolygon(cx, cy, boundary)
    })
    for (let zi = 0; zi < zLevels.length; zi++) {
      const prevZ = zi === 0 ? 0 : zLevels[zi - 1]
      lastPos = strategyFn(boundary, localIslands, tool, params, zLevels[zi], segs, prevZ, lastPos)
    }
  }

  if (segs.length === 0) throw new Error('Pocket area is too small for the selected tool diameter')

  // Single retract at the end after all depth levels.
  const safeZ = params.safeHeightMM ?? 5
  if (lastPos) segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })

  const result = _timed('simplifyMotion', () => simplifyMotion(segs, 0.01))
  _perfLog(strategy)
  return result
}

// Collapse collinear runs of motion: within each maximal run of consecutive segments
// that share a move type (same z, rapid, travel, feedScale; no arc/toolChange) the XY
// path is reduced with Douglas–Peucker, so a straight edge traced as many resampled
// points becomes just its endpoints. Ramps/helixes (varying z), arcs and tool changes
// break a run and are never merged, so depth moves stay intact. `tolMM` bounds the
// deviation (tiny — collinear cleanup only). douglasPeucker returns the SAME point
// objects it kept, so we recover their segment indices by reference and keep those
// segments unchanged (each kept segment already carries the correct move attributes).
function simplifyMotion(segs: MotionSegment[], tolMM: number): MotionSegment[] {
  const n = segs.length
  if (n <= 2) return segs
  // Two consecutive moves can share a straight run only if identical in every attribute
  // that affects machining, and at the same Z (so the XY reduction is planar).
  const sameRun = (a: MotionSegment, b: MotionSegment): boolean =>
    !a.arc && !b.arc && !a.toolChange && !b.toolChange &&
    !!a.rapid === !!b.rapid && !!a.travel === !!b.travel &&
    a.feedScale === b.feedScale && a.z === b.z

  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  // Run boundaries: a point whose incoming and outgoing moves differ in type.
  const bounds: number[] = [0]
  for (let i = 1; i < n - 1; i++) {
    if (!sameRun(segs[i], segs[i + 1])) { keep[i] = 1; bounds.push(i) }
  }
  bounds.push(n - 1)

  for (let h = 0; h + 1 < bounds.length; h++) {
    const s = bounds[h], e = bounds[h + 1]
    if (e - s <= 1) continue
    const runPts: Pt2[] = []
    for (let k = s; k <= e; k++) runPts.push([segs[k].x, segs[k].y])
    const simp = douglasPeucker(runPts, tolMM)
    let sp = 0
    for (let k = 0; k < runPts.length && sp < simp.length; k++) {
      if (runPts[k] === simp[sp]) { keep[s + k] = 1; sp++ }
    }
  }

  return segs.filter((_, i) => keep[i])
}


