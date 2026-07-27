import {   type Pt2 } from '../pathFlattener'
import type { MotionSegment } from '../../store/toolpathStore'
import type { Tool } from '../../store/toolStore'
import { type PocketParams, buildOffsetLevels, closedPath, cutPathsAtDepth, emitLinkedContourRings, growRing, restCleanupRings } from './shared'

export function contourPocket(
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
  const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
  const toolRadius = tool.diameterMM / 2
  const wantCCW = params.direction === 'climb' // inside cut: climb (M3) = CCW travel
  const rampDist = params.rampIn ? 2 * tool.diameterMM : undefined

  const levels = buildOffsetLevels(boundary, islands, toolRadius, stepoverMM, wantCCW)

  if (levels.length === 0) return incomingPos
  const segStart = segs.length

  // Cut innermost rings first, finishing ring last for a clean wall finish.
  const finishingLevel = levels[0]
  const innerLevels = levels.slice(1).reverse()
  const innerRings = innerLevels.flat()

  // Obstacles for travel-safety checks: the finishing rings bound the tool zone.
  const islandObstacles = islands.map(isl => growRing(isl, toolRadius)).filter(o => o.length >= 3)
  const obstacles = [...finishingLevel, ...islandObstacles]

  const travelObstacles = { edgeObstacles: obstacles, solidObstacles: islandObstacles }
  // startInnermost: innerRings is ordered innermost-level-first, and ring order follows the
  // nesting, not proximity. The cut opens at the innermost ring and walks outward; an outer
  // ring is skipped while it still contains an uncut ring, so when a region runs out at a
  // medial-axis merge the cut drops back to the innermost ring still pending (the next
  // medial-axis junction) and works outward from there. Left to proximity, a startNear hint or
  // the carried-over position from the previous depth level opens an outer contour of a region
  // whose middle is still solid — a full-width slot.
  const roughEnd = emitLinkedContourRings(innerRings, zDepth, travelObstacles, segs, params.startNear, rampDist, prevZ, safeZ, tool.diameterMM, incomingPos, true)

  // Ridges the offset family can't reach (only possible above 50% stepover), cut AFTER the
  // ordinary rings: by now everything around each patch is clear, so the pass is a light skim
  // instead of the full-width plunge it would be if these went first.
  const restRings = restCleanupRings(boundary, islands, toolRadius,
    [...cutPathsAtDepth(segs, segStart, zDepth), ...finishingLevel.map(closedPath)], wantCCW)
  const cutAnything = innerRings.length > 0
  const restEnd = restRings.length > 0
    ? emitLinkedContourRings(restRings, zDepth, travelObstacles, segs, params.startNear, rampDist, cutAnything ? zDepth : prevZ, safeZ, tool.diameterMM, roughEnd)
    : roughEnd

  const finishPrevZ = cutAnything || restRings.length > 0 ? zDepth : prevZ
  return emitLinkedContourRings(finishingLevel, zDepth, travelObstacles, segs, params.startNear, rampDist, finishPrevZ, safeZ, tool.diameterMM, restEnd)
}

