// Pocket clearing — public entry point, strategy dispatch and the depth loop.
//
// The strategies live one-per-file under ./pocket/; everything they share
// (geometry/travel-safety helpers, ramp + helix entry, offset-ring building,
// contour-ring linking, the sub-stage profiler) is in ./pocket/shared.ts.
//
// Each strategy is a PLANNER: it resolves its geometry once per boundary and returns
// a PocketPlan whose emitCuts replays that geometry at each depth level (see the
// contract in ./pocket/shared.ts). This file owns the depth loop and the tail every
// strategy shares — rest cleanup, then the wall/island finishing contours.
//
// This file stays the module everything imports — several scripts/ harnesses
// import '../src/cam/pocket.ts' by explicit path.
import { flattenPath, splitSelfIntersecting, douglasPeucker, type Pt2 } from './pathFlattener'
import { zPasses, pointInPolygon } from './geom'
import { reportProgress, subProgress } from './progress'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import {
  _perfReset, _perfLog, _timed, closedPath, cutPathsAtDepth, emitLinkedContourRings, offsetRing,
  restCleanupRings, type PocketParams, type PocketPlanner, type PocketStrategy,
} from './pocket/shared'
import { planRasterPocket } from './pocket/raster'
import { planContourPocket } from './pocket/contour'
import { planFieldSpiralPocket } from './pocket/fieldSpiral'
import { planAdaptivePocket } from './pocket/adaptive'
import { planAdaptive2Pocket } from './pocket/adaptive2'
import { planHybridPocket } from './pocket/hybrid'

export type { PocketStrategy, PocketParams } from './pocket/shared'

const PLANNERS: Record<PocketStrategy, PocketPlanner> = {
  raster: planRasterPocket,
  contour: planContourPocket,
  morph: planFieldSpiralPocket,
  adaptive: planAdaptivePocket,
  adaptive2: planAdaptive2Pocket,
  hybrid: planHybridPocket,
}

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

  // Legacy ids from older saved projects/forms. The offset-ring spiral ('spiral', once
  // 'spiralOffset') was dropped in 2026-07 — it left stock even at 50% stepover — so those
  // operations regenerate as 'morph', the curvilinear spiral that replaced it.
  const rawStrategy = (params.strategy ?? 'raster') as string
  const remapped = rawStrategy === 'spiralOffset' || rawStrategy === 'spiral' ? 'morph' : rawStrategy
  const strategy: PocketStrategy = remapped in PLANNERS ? (remapped as PocketStrategy) : 'raster'
  const zLevels = zPasses(params.depthMM, params.stepDownMM)
  const segs: MotionSegment[] = []

  const safeZ = params.safeHeightMM ?? 5
  const toolRadius = tool.diameterMM / 2
  const wantCCW = params.direction === 'climb'
  const rampDist = params.rampIn ? 2 * tool.diameterMM : undefined

  _perfReset()
  // Progress is split per boundary; within one, planning gets the lion's share because
  // that is where the field solve and the adaptive march live, and the depth levels are
  // just replays of the plan.
  reportProgress(0, 'Planning')
  const PLAN_SHARE = 0.8
  let lastPos: Pt2 | null = null
  for (let bi = 0; bi < boundaries.length; bi++) {
    const boundary = boundaries[bi]
    const bLo = bi / boundaries.length
    const bHi = (bi + 1) / boundaries.length
    const bSpan = bHi - bLo
    // Only pass islands that lie inside this boundary sub-ring. When both the boundary
    // and island paths are self-intersecting they each split into multiple sub-rings;
    // passing a sub-ring from the wrong boundary region as a CW hole corrupts the Clipper
    // compound polygon used by contour and adaptive (stray CW holes outside the CCW
    // boundary create phantom filled regions that offset incorrectly).
    //
    // Tested per VERTEX, not by centroid: a C-shaped island's centroid lies outside the
    // island itself and can fall outside the boundary too, which dropped the island from
    // the pocket entirely and machined straight through it.
    const localIslands = islands.filter(isl => isl.some(([x, y]) => pointInPolygon(x, y, boundary)))

    const plan = _timed('plan', () => PLANNERS[strategy](boundary, localIslands, tool, params,
      subProgress(bLo, bLo + bSpan * PLAN_SHARE, 'Planning')))
    if (!plan) continue

    // Every depth level cuts an IDENTICAL 2D path. Each level is emitted with no incoming
    // position, so ring order, start vertices and the links between them are chosen from
    // the same starting reference every time, and the tool is retracted to safe Z between
    // levels rather than carried over. Two things fall out of that: the operator sees the
    // same pattern repeated at each depth instead of a different one per level, and — the
    // reason it is done this way — what the path COVERS is the same at every level, so
    // rest detection is a property of the pocket rather than of the level. Carrying the
    // position over instead shifted the links per level, and a sliver one level's link
    // happened to sweep could survive at another (pocketCoverage's 90%-stepover case lost
    // a full step-down of depth over 26 audit cells that way).
    let restRings: Pt2[][] | null = null

    for (let zi = 0; zi < zLevels.length; zi++) {
      reportProgress(bLo + bSpan * (PLAN_SHARE + (1 - PLAN_SHARE) * (zi / zLevels.length)),
        zLevels.length > 1 ? `Depth ${zi + 1}/${zLevels.length}` : 'Cutting')
      const z = zLevels[zi]
      const prevZ = zi === 0 ? 0 : zLevels[zi - 1]
      // Clear of the work before repositioning to this level's fixed start point.
      if (lastPos) segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })
      const segStart = segs.length
      lastPos = plan.emitCuts(z, prevZ, null, segs) ?? lastPos
      if (plan.selfFinishing) continue

      const roughed = segs.length > segStart
      if (restRings === null) {
        // The finishing rings the tail is about to cut must count as covered, or the
        // untouched wall allowance reads as leftover stock.
        restRings = _timed('restCleanupRings', () => restCleanupRings(boundary, localIslands, toolRadius,
          [...cutPathsAtDepth(segs, segStart, z), ...plan.finishRings.map(closedPath)], wantCCW))
      }

      // Stock the strategy's passes couldn't reach, cut AFTER them and before the wall
      // pass: by now everything around each patch is clear, so it's a light skim instead
      // of the full-width plunge it would be going first. See restCleanupRings.
      if (restRings.length > 0) {
        lastPos = emitLinkedContourRings(restRings, z, plan.travelObstacles, segs, params.startNear,
          rampDist, roughed ? z : prevZ, safeZ, tool.diameterMM, lastPos)
      }
      lastPos = emitLinkedContourRings(plan.finishRings, z, plan.travelObstacles, segs, params.startNear,
        rampDist, roughed || restRings.length > 0 ? z : prevZ, safeZ, tool.diameterMM, lastPos)
    }
  }

  if (segs.length === 0) throw new Error('Pocket area is too small for the selected tool diameter')

  // Single retract at the end after all depth levels.
  if (lastPos) segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })

  reportProgress(1)
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

  // A pure-Z move (plunge/lift) shares XY with the point before it, so Douglas–Peucker —
  // which measures XY deviation only — reads it as zero-deviation and deletes it, turning a
  // rapid-to-position + plunge into one diagonal dive from safe Z into the cut. Pinning it as
  // a run boundary keeps the descent intact (reconstructArcs guards the same case downstream).
  const verticalMove = (i: number) =>
    Math.abs(segs[i].x - segs[i - 1].x) < 1e-6 && Math.abs(segs[i].y - segs[i - 1].y) < 1e-6

  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  // Run boundaries: a point whose incoming and outgoing moves differ in type.
  const bounds: number[] = [0]
  for (let i = 1; i < n - 1; i++) {
    if (verticalMove(i) || !sameRun(segs[i], segs[i + 1])) { keep[i] = 1; bounds.push(i) }
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


