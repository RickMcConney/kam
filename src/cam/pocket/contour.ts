import {   type Pt2 } from '../pathFlattener'
import type { MotionSegment } from '../../store/toolpathStore'
import type { Tool } from '../../store/toolStore'
import { type PocketParams, buildOffsetLevels, emitLinkedContourRings, growRing } from './shared'

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

  // Cut innermost rings first, finishing ring last for a clean wall finish.
  const finishingLevel = levels[0]
  const innerLevels = levels.slice(1).reverse()
  const innerRings = innerLevels.flat()

  // Obstacles for travel-safety checks: the finishing rings bound the tool zone.
  const islandObstacles = islands.map(isl => growRing(isl, toolRadius)).filter(o => o.length >= 3)
  const obstacles = [...finishingLevel, ...islandObstacles]

  const travelObstacles = { edgeObstacles: obstacles, solidObstacles: islandObstacles }
  // startInnermost: innerRings is ordered innermost-first, and the cut must OPEN there.
  // Left to proximity, a startNear hint or the carried-over position from the previous depth
  // level can pick an outer ring first, which slots.
  const roughEnd = emitLinkedContourRings(innerRings, zDepth, travelObstacles, segs, params.startNear, rampDist, prevZ, safeZ, tool.diameterMM, incomingPos, true)
  const finishPrevZ = innerRings.length > 0 ? zDepth : prevZ
  return emitLinkedContourRings(finishingLevel, zDepth, travelObstacles, segs, params.startNear, rampDist, finishPrevZ, safeZ, tool.diameterMM, roughEnd)
}

