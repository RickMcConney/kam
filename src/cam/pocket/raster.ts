import {   type Pt2 } from '../pathFlattener'
import {   pointInPolygon } from '../geom'
import type { MotionSegment } from '../../store/toolpathStore'
import { type PocketPlan, type PocketPlanner, type TravelSafetyObstacles, compoundFinishRings, emitCutTransition, emitRampDescent, growIslands, insetRing, isTravelSafe, rampLeadIn } from './shared'

// ─── Raster utilities ──────────────────────────────────────────────────────────

interface Scanline { p1: Pt2; p2: Pt2; row: number }

function generateScanlines(
  boundary: Pt2[],
  spacingMM: number,
  angleDeg: number,
): Scanline[] {
  if (boundary.length < 3) return []
  const angleRad = (angleDeg * Math.PI) / 180
  const cosA = Math.cos(-angleRad), sinA = Math.sin(-angleRad)
  const cosR = Math.cos(angleRad), sinR = Math.sin(angleRad)
  const rotated = boundary.map(([x, y]) => ({ x: x * cosA - y * sinA, y: x * sinA + y * cosA }))
  const ys = rotated.map(p => p.y)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const n = rotated.length
  const segments: Scanline[] = []
  let row = 0
  for (let y = minY + spacingMM / 2; y <= maxY; y += spacingMM, row++) {
    const hits: number[] = []
    for (let i = 0; i < n; i++) {
      const a = rotated[i], b = rotated[(i + 1) % n]
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        hits.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y))
      }
    }
    hits.sort((a, b) => a - b)
    for (let i = 0; i + 1 < hits.length; i += 2) {
      segments.push({
        p1: [hits[i] * cosR - y * sinR, hits[i] * sinR + y * cosR],
        p2: [hits[i + 1] * cosR - y * sinR, hits[i + 1] * sinR + y * cosR],
        row,
      })
    }
  }
  return segments
}

function clipScanlineAgainstIslands(
  p1: Pt2, p2: Pt2, exclusions: Pt2[][],
): { p1: Pt2; p2: Pt2 }[] {
  if (exclusions.length === 0) return [{ p1, p2 }]
  const y = p1[1]
  const xL = Math.min(p1[0], p2[0]), xR = Math.max(p1[0], p2[0])
  const blocked: [number, number][] = []
  for (const poly of exclusions) {
    const hits: number[] = []
    const n = poly.length
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n]
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        hits.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]))
      }
    }
    hits.sort((a, b) => a - b)
    // An odd hit count means the scanline grazed a vertex and one crossing was
    // double-counted or missed. Pairing the list as-is would leave the island's
    // last span unblocked and cut straight through it, so treat the whole island
    // as blocking the scanline's span instead.
    if (hits.length % 2 === 1) { blocked.push([hits[0], hits[hits.length - 1]]); continue }
    for (let k = 0; k + 1 < hits.length; k += 2) blocked.push([hits[k], hits[k + 1]])
    if (hits.length === 0 && pointInPolygon((xL + xR) / 2, y, poly)) return []
  }
  if (blocked.length === 0) return [{ p1, p2 }]
  blocked.sort((a, b) => a[0] - b[0])
  const result: { p1: Pt2; p2: Pt2 }[] = []
  let cursor = xL
  for (const [bL, bR] of blocked) {
    if (bR <= cursor) continue
    if (bL > cursor) result.push({ p1: [cursor, y], p2: [Math.min(bL, xR), y] })
    cursor = Math.max(cursor, bR)
    if (cursor >= xR) break
  }
  if (cursor < xR) result.push({ p1: [cursor, y], p2: [xR, y] })
  return result.filter(s => Math.abs(s.p2[0] - s.p1[0]) >= 0.1)
}


function buildRasterPath(
  scanlines: Scanline[],
  travelObstacles: TravelSafetyObstacles,
  zDepth: number,
  segs: MotionSegment[],
  incomingPos: Pt2 | null,
  rampDistMM?: number,
  prevZ = 0,
  safeZ = 5,
  toolDiameterMM = 0,
  // Where the previous operation left the tool. Used ONLY to choose which scanline to open
  // on — the entry is still a lift and a plunge, because the tool is not actually there and
  // cannot travel at depth from it.
  startNear?: { x: number; y: number },
): Pt2 | null {
  if (scanlines.length === 0) return incomingPos
  const used = new Array(scanlines.length).fill(false)
  let current: Pt2 | null = incomingPos

  // A raster is a linear stack of rows, so it has to be entered at one END of that stack.
  // The hint chooses WHICH end (and which end of that row) — nothing more. Letting it pick
  // the globally nearest row instead opens somewhere in the middle, and everything on the
  // far side is then stranded until a long retrace at the end.
  let minRow = Infinity, maxRow = -Infinity
  for (const sl of scanlines) {
    if (sl.row < minRow) minRow = sl.row
    if (sl.row > maxRow) maxRow = sl.row
  }

  for (let remaining = scanlines.length; remaining > 0; remaining--) {
    let bestIdx = -1, bestScore = Infinity, bestDist = Infinity, bestReversed = false, bestNeedsLift = true
    for (let i = 0; i < scanlines.length; i++) {
      if (used[i]) continue
      const seg = scanlines[i]
      // First pass only: restrict the choice to the two ends of the stack.
      if (current === null && startNear && seg.row !== minRow && seg.row !== maxRow) continue
      for (let r = 0; r < 2; r++) {
        const start: Pt2 = r === 0 ? seg.p1 : seg.p2
        const needsLift = current === null || !isTravelSafe(current, start, travelObstacles)
        // Measure from where the tool is, or — before the first pass — from the incoming
        // hint, so the raster opens on the scanline nearest where the last operation
        // finished instead of always at scanlines[0].
        const ref: Pt2 | null = current ?? (startNear ? [startNear.x, startNear.y] : null)
        const dist = ref ? Math.hypot(start[0] - ref[0], start[1] - ref[1]) : 0
        const score = needsLift ? dist * 1.25 : dist
        if (bestIdx === -1 || score < bestScore || (Math.abs(score - bestScore) < 1e-6 && dist < bestDist)) {
          bestIdx = i; bestScore = score; bestDist = dist; bestReversed = r === 1; bestNeedsLift = needsLift
        }
      }
    }
    used[bestIdx] = true
    const seg = scanlines[bestIdx]
    const start: Pt2 = bestReversed ? seg.p2 : seg.p1
    const end: Pt2   = bestReversed ? seg.p1 : seg.p2
    if (bestNeedsLift) {
      if (current !== null) segs.push({ x: current[0], y: current[1], z: safeZ, rapid: true })
      if (rampDistMM !== undefined) {
        // Position rampDist forward along the scanline, then ramp backwards to start.
        // When the tool reaches start it is at full depth; the forward cut to end
        // then re-cuts the ramp section, leaving a clean floor.
        const { touchdown, sampleAt } = rampLeadIn([start, end], true, rampDistMM)
        segs.push({ x: touchdown[0], y: touchdown[1], z: safeZ, rapid: true })
        segs.push({ x: touchdown[0], y: touchdown[1], z: prevZ, rapid: true })
        emitRampDescent(segs, sampleAt, prevZ, zDepth, 12)
        // Tool is now at (start, zDepth); fall through to cut forward to end
      } else {
        segs.push({ x: start[0], y: start[1], z: safeZ, rapid: true })
        segs.push({ x: start[0], y: start[1], z: zDepth, rapid: false })
      }
    } else {
      if (current) emitCutTransition(segs, current, start, zDepth, toolDiameterMM, safeZ)
      else segs.push({ x: start[0], y: start[1], z: zDepth, rapid: false })
    }
    segs.push({ x: end[0], y: end[1], z: zDepth, rapid: false })
    current = end
  }
  return current
}

export const planRasterPocket: PocketPlanner = (boundary, islands, tool, params): PocketPlan | null => {
  const safeZ = params.safeHeightMM ?? 5
  const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
  const toolRadius = tool.diameterMM / 2
  const wantCCW = params.direction === 'climb' // inside cut: climb (M3) = CCW travel
  const rampDist = params.rampIn ? 2 * tool.diameterMM : undefined

  // Island obstacles: offset ALL island rings together so that sub-rings from a
  // split self-intersecting path are treated as one compound shape — avoids miter
  // spikes at shared crossing vertices that would otherwise make the finishing
  // contour cut through the original island material.
  const islandExclusions = growIslands(islands, tool.diameterMM)
  const islandFinish = growIslands(islands, toolRadius)

  // Raster fill: tool centre stays one full diameter inside the boundary wall;
  // the finishing contour covers the remaining tool-radius margin.
  const rasterBoundary = insetRing(boundary, tool.diameterMM)
  const rawScanlines = rasterBoundary.length >= 3
    ? generateScanlines(rasterBoundary, stepoverMM, params.angle ?? 0)
    : []

  // Clip must happen in the rotated frame where scanlines are axis-aligned.
  // Rotate island exclusions into that frame, clip, then rotate results back.
  const angleRad = (params.angle ?? 0) * Math.PI / 180
  const cosF = Math.cos(-angleRad), sinF = Math.sin(-angleRad)
  const cosB = Math.cos(angleRad),  sinB = Math.sin(angleRad)
  const rotPt = ([x, y]: Pt2, c: number, s: number): Pt2 => [x * c - y * s, x * s + y * c]
  const islandExclusionsRot = islandExclusions.map(e => e.map(p => rotPt(p, cosF, sinF)))
  const clippedScanlines = rawScanlines.flatMap(s => {
    const p1r = rotPt(s.p1, cosF, sinF)
    const p2r = rotPt(s.p2, cosF, sinF)
    return clipScanlineAgainstIslands(p1r, p2r, islandExclusionsRot).map(seg => ({
      p1: rotPt(seg.p1, cosB, sinB),
      p2: rotPt(seg.p2, cosB, sinB),
      row: s.row,
    }))
  })

  // Use the finishing ring (inset by tool radius) as the raster travel-safety edge.
  // The raster boundary (inset by full diameter) eliminates narrow concave passages
  // like star inner corners, so micro-lifts through those areas aren't caught as
  // unsafe. The finishing ring (inset by only tool radius) preserves those concave
  // edges, correctly blocking transitions that would cut through uncleared wall material.
  const finishRing = insetRing(boundary, toolRadius)
  const rasterTravelEdge = finishRing.length >= 3 ? finishRing : boundary
  const rasterTravel: TravelSafetyObstacles = {
    edgeObstacles: [rasterTravelEdge, ...islandFinish], solidObstacles: islandFinish,
    containment: [rasterTravelEdge],
  }

  // Finishing contours: linked without lifts when safe. Compound inset so a near-wall
  // island pinches instead of swinging the tool through the outer wall.
  const finishRings = compoundFinishRings(boundary, islands, toolRadius, wantCCW)
  const travelObstacles: TravelSafetyObstacles = {
    edgeObstacles: [...(finishRing.length >= 3 ? [finishRing] : []), ...islandExclusions],
    solidObstacles: islandFinish,
    containment: finishRings,
  }

  return {
    finishRings,
    travelObstacles,
    emitCuts: (z: number, prevZ: number, incomingPos: Pt2 | null, segs: MotionSegment[]) =>
      buildRasterPath(clippedScanlines, rasterTravel, z, segs, incomingPos, rampDist,
        prevZ, safeZ, tool.diameterMM, params.startNear),
  }
}
