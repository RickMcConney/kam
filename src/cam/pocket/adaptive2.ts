import {   type Pt2 } from '../pathFlattener'
import type { MotionSegment } from '../../store/toolpathStore'
import type { Tool } from '../../store/toolStore'
import { MICRO_LIFT_MM, type PocketParams, compoundFinishRings, emitHelixBore, emitLinkedContourRings, growIslands } from './shared'
import { computeAdaptive2Plan, type Adaptive2Region } from '../adaptive2'

// ─── Adaptive2 (fast raster-marching constant engagement) ───────────────────────
//
// Delegates to computeAdaptive2Plan (./adaptive2) — a from-scratch engine that grows the
// toolpath over an occupancy grid instead of clipping polygons, so it stays fast on large
// pockets. The 2D plan is identical for every Z level, so it's computed once per geometry
// and replayed at each depth pass (single-entry cache, same scheme as the field spiral).

let adaptive2PlanCache: { key: string; plan: Adaptive2Region[] } | null = null

function adaptive2PlanFor(boundary: Pt2[], islands: Pt2[][], tool: Tool, params: PocketParams): Adaptive2Region[] {
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, sum = 0
  for (let i = 0; i < boundary.length; i++) {
    const [x, y] = boundary[i]
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y
    sum += x * (i + 1) + y * (i + 7)
  }
  for (const isl of islands) for (let i = 0; i < isl.length; i++) sum += isl[i][0] * (i + 3) - isl[i][1] * (i + 11)
  const key = [
    'a2', tool.diameterMM, params.stepoverPercent, params.direction, params.rampIn ? 1 : 0,
    boundary.length, islands.length,
    bx0.toFixed(3), by0.toFixed(3), bx1.toFixed(3), by1.toFixed(3), sum.toFixed(2),
  ].join('|')
  if (adaptive2PlanCache && adaptive2PlanCache.key === key) return adaptive2PlanCache.plan

  const plan = computeAdaptive2Plan(boundary, islands, {
    toolDiameterMM: tool.diameterMM,
    stepoverMM: tool.diameterMM * (params.stepoverPercent / 100),
    wantCCW: params.direction === 'conventional',
    helixEntry: params.rampIn ?? false,
  })
  adaptive2PlanCache = { key, plan }
  return plan
}

export function adaptive2Pocket(
  boundary: Pt2[],
  islands: Pt2[][],
  tool: Tool,
  params: PocketParams,
  zDepth: number,
  segs: MotionSegment[],
  prevZ = 0,
  incomingPos: Pt2 | null = null,
): Pt2 | null {
  const safeZ = params.safeHeightMM ?? 5
  const toolRadius = tool.diameterMM / 2
  const wantCCW = params.direction === 'climb' // inside cut: climb (M3) = CCW travel
  const rampDist = params.rampIn ? 2 * tool.diameterMM : undefined

  const plan = adaptive2PlanFor(boundary, islands, tool, params)

  let lastPos: Pt2 | null = incomingPos
  for (const reg of plan) {
    const first = reg.moves[0]?.pts[0]
    if (!first) continue
    if (lastPos) segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })
    if (reg.helixRadiusMM > 0) {
      // The plan starts the march on the bore rim; end the bore exactly there so the
      // helix flows into the spiral with no connector.
      const endAngle = Math.atan2(first[1] - reg.helixCenter[1], first[0] - reg.helixCenter[0])
      emitHelixBore(reg.helixCenter, reg.helixRadiusMM, endAngle, prevZ, zDepth, wantCCW, segs, safeZ)
    } else {
      segs.push({ x: first[0], y: first[1], z: safeZ, rapid: true })
      segs.push({ x: first[0], y: first[1], z: prevZ, rapid: true })
      segs.push({ x: first[0], y: first[1], z: zDepth, rapid: false })
    }
    lastPos = first
    for (const mv of reg.moves) {
      if (mv.kind === 'link') {
        // Stay-down air move: micro-lift, traverse as travel (dashed in the UI), drop
        // back to depth — clearly separates cutting from repositioning.
        const liftZ = Math.min(safeZ, zDepth + MICRO_LIFT_MM)
        segs.push({ x: lastPos[0], y: lastPos[1], z: liftZ, rapid: false, travel: true })
        for (const [x, y] of mv.pts) {
          segs.push({ x, y, z: liftZ, rapid: false, travel: true })
          lastPos = [x, y]
        }
        segs.push({ x: lastPos[0], y: lastPos[1], z: zDepth, rapid: false })
      } else {
        for (const [x, y] of mv.pts) {
          if (x === lastPos[0] && y === lastPos[1]) continue
          segs.push({ x, y, z: zDepth, rapid: false })
          lastPos = [x, y]
        }
      }
    }
  }

  // Finishing wall pass — compound inset, see compoundFinishRings.
  const rings = compoundFinishRings(boundary, islands, toolRadius, wantCCW)
  const islandFinish = growIslands(islands, toolRadius)
  const islandExclusions = growIslands(islands, tool.diameterMM)
  const obstacles = [...rings, ...islandExclusions]
  const finishPrevZ = plan.length > 0 ? zDepth : prevZ
  return emitLinkedContourRings(
    rings, zDepth,
    { edgeObstacles: obstacles, solidObstacles: islandFinish },
    segs, params.startNear, rampDist, finishPrevZ, safeZ, tool.diameterMM, lastPos,
  )
}

