import { flattenPath, signedArea, splitSelfIntersecting, sharesVertex, type Pt2 } from './pathFlattener'
import { generatePocket } from './pocket'
import { generateVCarve, generateMaleTextBoundaryVCarve } from './vcarve'
import { inflatePathsD, JoinType, EndType } from 'clipper2-ts'
import { applyCornerTreatment } from '../tools/cornerTreatment'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'

export interface InlayParams {
  angleDeg: number           // V-bit full included angle
  pocketDepthMM: number      // depth of the flat-bottom pocket / inlay
  stepDownMM: number         // step-down for end mill roughing
  stepoverPercent: number    // stepover % for end mill roughing
  glueLineMM: number         // extra depth added to female pocket for glue space
  clearanceMM: number        // reduction of male bevel offsets for fit clearance
  islandDs: string[]         // hole paths inside the shape
  rampIn?: boolean           // ramp/helical entry on roughing pockets instead of plunging
  mirrorX?: boolean          // male only: mirror shape around vertical axis
  safeHeightMM?: number
}

// Offset a path by deltaMM. Self-intersecting input is split into simple loops
// first so Clipper2 receives well-formed polygons.
// arcTolerance controls chord-error for Round joins (ignored for Miter).
function offsetPath(d: string, deltaMM: number, joinType: JoinType, arcTolerance: number): string | null {
  const subpaths = splitSelfIntersecting(flattenPath(d, 0.05))
  if (!subpaths.length) return null
  const inputPaths = subpaths.map(sp => {
    let pts = [...sp]
    if (pts.length > 1 && Math.hypot(pts[pts.length-1][0]-pts[0][0], pts[pts.length-1][1]-pts[0][1]) < 1e-6)
      pts = pts.slice(0, -1)
    if (signedArea(pts) < 0) pts = [...pts].reverse()
    return pts.map(([x, y]) => ({ x, y }))
  })
  const result = inflatePathsD(inputPaths, deltaMM, joinType, EndType.Polygon, 4, arcTolerance)
  if (!result.length) return null
  const cmds: string[] = []
  for (const loop of result) {
    if (loop.length < 3) continue
    cmds.push(`M${loop[0].x.toFixed(4)} ${loop[0].y.toFixed(4)}`)
    for (let i = 1; i < loop.length; i++) cmds.push(`L${loop[i].x.toFixed(4)} ${loop[i].y.toFixed(4)}`)
    cmds.push('Z')
  }
  return cmds.length ? cmds.join(' ') : null
}

function offsetPathD(d: string, deltaMM: number): string | null {
  return offsetPath(d, deltaMM, JoinType.Miter, 6)
}

function offsetPathRound(d: string, deltaMM: number): string | null {
  return offsetPath(d, deltaMM, JoinType.Round, 2)
}

// Offset a path by deltaMM, treating each sub-ring as an independent solid (each ring
// offset in its own Clipper call, so results are never unioned across rings). A
// self-intersecting boundary therefore keeps all its lobes on a positive/outward
// offset, which offsetPath would merge into one. Used for inlay socket offsets, where
// each lobe must stay a separate region (the same way generatePocket treats them).
function offsetEachRing(d: string, deltaMM: number): string | null {
  const cmds: string[] = []
  for (const ring of splitSelfIntersecting(flattenPath(d, 0.05))) {
    let pts = [...ring]
    if (pts.length > 1 && Math.hypot(pts[pts.length-1][0]-pts[0][0], pts[pts.length-1][1]-pts[0][1]) < 1e-6)
      pts = pts.slice(0, -1)
    if (pts.length < 3) continue
    if (signedArea(pts) < 0) pts = [...pts].reverse()
    const result = inflatePathsD([pts.map(([x, y]) => ({ x, y }))], deltaMM, JoinType.Miter, EndType.Polygon, 4, 6)
    for (const loop of result) {
      if (loop.length < 3) continue
      cmds.push(`M${loop[0].x.toFixed(4)} ${loop[0].y.toFixed(4)}`)
      for (let i = 1; i < loop.length; i++) cmds.push(`L${loop[i].x.toFixed(4)} ${loop[i].y.toFixed(4)}`)
      cmds.push('Z')
    }
  }
  return cmds.length ? cmds.join(' ') : null
}

// Returns true for geometry-constraint errors that are expected and safe to skip.
// Unknown errors (regressions, bad config) are re-thrown so they surface immediately.
function isExpectedGeometryError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  return /too small|no geometry|medial axis|boundary vcarve/i.test(e.message)
}

// Round all convex (outer) corners of path d to radius r using the corner tool.
export function roundCornersForEndmill(d: string, r: number): string {
  if (r <= 0.001) return d
  return applyCornerTreatment(d, { type: 'outerRound', radiusMM: r })
}

// Extra radius added when rounding corners for the end-mill wall method, so the finish
// bit can reach fully into convex corners (it leaves a small flat at a perfect point
// otherwise). Arbitrary — just enough to cover typical end-mill imperfection without
// visibly rounding the final cut.
const CORNER_ROUND_EXTRA_MM = 1

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ptsToD(pts: Pt2[]): string {
  if (pts.length < 2) return ''
  const p = [`M${pts[0][0].toFixed(4)} ${pts[0][1].toFixed(4)}`]
  for (let i = 1; i < pts.length; i++) p.push(`L${pts[i][0].toFixed(4)} ${pts[i][1].toFixed(4)}`)
  p.push('Z')
  return p.join(' ')
}

// Point-in-polygon (ray casting).
function ptInPoly(px: number, py: number, pts: Pt2[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
      inside = !inside
  }
  return inside
}

// Split a multi-subpath d string into per-letter regions.
// Each outer subpath is returned as { outerD, islandDs[] } where islandDs
// are subpaths whose centroid falls inside that outer ring (intrinsic holes
// like the counter of 'o' or 'a'). Single-subpath paths return [].
function splitRegions(d: string): { outerD: string; islandDs: string[] }[] {
  // A self-intersecting single path has exactly one M command. splitSelfIntersecting
  // will split it into multiple loops, but those are sub-rings of one shape — not
  // separate letters. Only treat as multi-region when the path has multiple explicit
  // subpaths (multiple M commands), i.e. text or intentionally compound shapes.
  if ((d.match(/M/g) ?? []).length <= 1) return []
  const subs = splitSelfIntersecting(flattenPath(d, 0.05))
  if (subs.length <= 1) return []

  const sorted = [...subs].sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)))
  const usedAsHole = new Set<number>()
  const regions: { outerD: string; outerPts: Pt2[]; islandDs: string[] }[] = []

  for (let i = 0; i < sorted.length; i++) {
    if (usedAsHole.has(i)) continue
    const outer = sorted[i]
    const cx = outer.reduce((s, p) => s + p[0], 0) / outer.length
    const cy = outer.reduce((s, p) => s + p[1], 0) / outer.length
    if (regions.some(r => ptInPoly(cx, cy, r.outerPts))) {
      usedAsHole.add(i); continue
    }

    const holes: string[] = []
    for (let j = i + 1; j < sorted.length; j++) {
      if (usedAsHole.has(j)) continue
      const cand = sorted[j]
      const hcx = cand.reduce((s, p) => s + p[0], 0) / cand.length
      const hcy = cand.reduce((s, p) => s + p[1], 0) / cand.length
      // Touching loops (shared vertex) are siblings, not holes.
      if (!sharesVertex(cand, outer) && ptInPoly(hcx, hcy, outer)) {
        holes.push(ptsToD(cand))
        usedAsHole.add(j)
      }
    }
    regions.push({ outerD: ptsToD(outer), outerPts: outer, islandDs: holes })
  }
  return regions.map(({ outerD, islandDs }) => ({ outerD, islandDs }))
}

// Mirror a path string around its vertical (X) center axis.
// Flattens to polylines so curves become linear approximations — fine for CAM.
function mirrorPathD(d: string): string {
  const subs = flattenPath(d, 0.05).filter(s => s.length >= 3)
  if (!subs.length) return d
  let minX = Infinity, maxX = -Infinity
  for (const sub of subs) for (const [x] of sub) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
  }
  const cx = (minX + maxX) / 2
  // Mirror X around cx; reverse each subpath to restore CCW winding (mirror flips chirality)
  return subs.map(sub =>
    ptsToD([...sub].reverse().map(([x, y]) => [2 * cx - x, y] as Pt2))
  ).join(' ')
}


// Trace a closed contour at successive Z depths without retracting between passes.
// The tool rapids to the start once, feed-plunges straight down to each depth in
// place (it always ends a pass back at the start point of a closed loop), and only
// lifts to safe Z after the final pass. This roughly halves rapid/air time versus a
// per-pass retract, and leaves a single plunge column on the visible seam instead of
// re-marking the same spot once per depth. Direction is kept constant across passes
// so the finish wall is cut consistently (climb/conventional) rather than alternating.
// Step-down Z levels from the surface to -depth, ending on the full-depth pass.
function zStepsTo(depthMM: number, stepDownMM: number): number[] {
  const depth = Math.abs(depthMM), step = Math.abs(stepDownMM)
  const out: number[] = []
  let z = -step
  while (z > -depth) { out.push(z); z -= step }
  out.push(-depth)
  return out
}

// When `rampLenMM` is given, each pass enters by ramping down along the contour over
// ~rampLenMM of travel (feed-reduced) instead of plunging straight in, then cuts the
// full perimeter at depth and re-cuts the ramped zone to clean the floor. This mirrors
// the ramp-in entry that generateProfile/generatePocket use. `undefined` → plunge in place.
function addContourStack(pts: Pt2[], zPasses: number[], segs: MotionSegment[], safeZ = 5, rampLenMM?: number) {
  if (pts.length < 2 || zPasses.length === 0) return
  // Normalize: drop a duplicate closing vertex so the loop is a clean vertex ring.
  let loop = pts
  if (loop.length > 2 && Math.hypot(loop[loop.length-1][0]-loop[0][0], loop[loop.length-1][1]-loop[0][1]) < 1e-6)
    loop = loop.slice(0, -1)
  const [sx, sy] = loop[0]
  const n = loop.length

  if (rampLenMM === undefined || rampLenMM <= 0 || n < 3) {
    segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
    for (const z of zPasses) {
      segs.push({ x: sx, y: sy, z, rapid: false })   // feed-plunge in place
      for (let i = 1; i < loop.length; i++) segs.push({ x: loop[i][0], y: loop[i][1], z, rapid: false })
      segs.push({ x: sx, y: sy, z, rapid: false })   // close loop back to start
    }
    segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
    return
  }

  // Cumulative arc length at each vertex (cum[0] = 0); total perimeter includes the
  // closing segment back to loop[0].
  const cum = [0]
  let total = 0
  for (let i = 1; i < n; i++) { total += Math.hypot(loop[i][0]-loop[i-1][0], loop[i][1]-loop[i-1][1]); cum.push(total) }
  total += Math.hypot(loop[0][0]-loop[n-1][0], loop[0][1]-loop[n-1][1])
  if (total < 1e-6) { segs.push({ x: sx, y: sy, z: safeZ, rapid: true }); return }
  const rampLen = Math.min(rampLenMM, total * 0.45)

  // Vertices spanned by the ramp: 1..rampLast (rampLast = first vertex at/after rampLen).
  let rampLast = 1
  for (let i = 1; i < n; i++) { rampLast = i; if (cum[i] >= rampLen) break }

  segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
  segs.push({ x: sx, y: sy, z: 0, rapid: true })   // rapid to surface at the start point
  let prevZ = 0
  for (const z of zPasses) {
    // Ramp: loop[0] (already here at prevZ) → loop[rampLast], descending prevZ → z.
    for (let i = 1; i <= rampLast; i++) {
      const f = Math.min(cum[i] / rampLen, 1)
      segs.push({ x: loop[i][0], y: loop[i][1], z: prevZ + (z - prevZ) * f, rapid: false, feedScale: 0.5 })
    }
    // Cut the rest of the perimeter at depth: loop[rampLast] → … → loop[0].
    for (let i = rampLast + 1; i < n; i++) segs.push({ x: loop[i][0], y: loop[i][1], z, rapid: false })
    segs.push({ x: sx, y: sy, z, rapid: false })
    // Re-cut the ramped zone at full depth, ending back at loop[0] for the next pass.
    for (let i = 1; i <= rampLast; i++) segs.push({ x: loop[i][0], y: loop[i][1], z, rapid: false })
    for (let i = rampLast - 1; i >= 1; i--) segs.push({ x: loop[i][0], y: loop[i][1], z, rapid: false })
    segs.push({ x: sx, y: sy, z, rapid: false })
    prevZ = z
  }
  segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
}

function getOuters(d: string): Pt2[][] {
  const subs = flattenPath(d, 0.05).filter(s => s.length >= 3)
  const outers = subs.filter(s => signedArea(s) >= 0)
  return outers.length > 0 ? outers : subs
}

// ─── Female socket ────────────────────────────────────────────────────────────

// Compute the socket boundary + two inward offset paths for the female operation.
// Exported so the UI can add them to the canvas as debug paths.
//
// Clearance is applied here and only here: the socket is offset OUTWARD by clearanceMM
// (offset-then-inset), so the fit gap lives entirely on the socket side — holes grow,
// plugs stay nominal, and the gap is never doubled across a joint.
export function computeInlayFemaleOffsets(
  d: string,
  params: Pick<InlayParams, 'angleDeg' | 'pocketDepthMM' | 'glueLineMM' | 'clearanceMM'>,
): { socketD: string | null; pocketBoundaryD: string | null; vcarveIslandD: string | null } {
  const halfAngle = (params.angleDeg / 2) * (Math.PI / 180)
  const tanHalf = Math.tan(halfAngle)
  if (tanHalf < 1e-6) return { socketD: null, pocketBoundaryD: null, vcarveIslandD: null }
  // Offsets use the total socket depth so the V-carved walls reach the pocket floor
  // (glue gap included). fullWidth = 2 × halfWidth.
  const halfWidthMM = (params.pocketDepthMM + params.glueLineMM) * tanHalf
  const c = params.clearanceMM
  // Per-ring offsets (offsetEachRing) so a self-intersecting boundary keeps each lobe
  // separate on the outward socket offset — offsetPath would merge them and carve only
  // one side. The pocket-floor / V-carve-island insets are net-inward for normal
  // clearances and behave the same either way, but stay per-ring for consistency.
  const socketD = c !== 0 ? offsetEachRing(d, c) : d
  if (!socketD) return { socketD: null, pocketBoundaryD: null, vcarveIslandD: null }
  return {
    socketD,
    pocketBoundaryD: offsetEachRing(d, c - halfWidthMM),
    vcarveIslandD:   offsetEachRing(d, c - halfWidthMM * 3),  // inset by fullWidth × 1.5
  }
}

// ── Inlay primitives ──────────────────────────────────────────────────────────
//
// Every V-bit inlay reduces to two dual operations:
//
//   insideClear(boundary, protrusions) — a SOCKET. Raster-pockets the interior and
//     V-carves the walls sloping inward, leaving any protrusions standing proud.
//     Clearance lives here (see computeInlayFemaleOffsets): the socket grows outward
//     by clearanceMM so the mating plug fits.
//
//   outerCut(boundary) — a PLUG. V-carves the outline (tip on path) at each stepdown
//     and frees it from stock with an outward end-mill release profile. No clearance.
//
//   female(shape) = insideClear(outer, islands)
//   male(shape)   = outerCut(outer) + insideClear(eachIsland, [])
//
// i.e. the male part is the female part with the solid side flipped on every boundary.

// SOCKET. `roughTool` clears the flat bottom; `wallTool` forms the walls — a V-bit
// (medial-axis V-carve) or an end mill (corner-round + step-down finish contours).
// Result slots: vbitSegs = wall/finish-tool passes, endmillSegs = roughing passes.
async function insideClear(
  boundaryD: string, protrusionDs: string[],
  roughTool: Tool, wallTool: Tool | null, params: InlayParams,
): Promise<InlaySplitResult> {
  const totalDepthMM = params.pocketDepthMM + params.glueLineMM

  // ── No finish tool: raster-pocket only (roughing socket, no wall-finish pass). ──
  // The raster pocket already emits a finishing contour ring at each Z (see pocket.ts),
  // so for a plain flat-walled socket the rough bit alone produces the final socket.
  // Corners are rounded to the ROUGHING tool (there's no finish tool to do it), matching
  // outerCut's no-finish male plug so the socket corners and plug corners agree.
  // Clearance still lives on the socket: finishAllowanceMM = −c grows the pocket outward
  // by c, and protrusions are pre-grown by c so the −c allowance nets them to nominal.
  if (wallTool === null) {
    const c = params.clearanceMM
    const roundedD = roundCornersForEndmill(boundaryD, roughTool.diameterMM + CORNER_ROUND_EXTRA_MM)
    const pocketIslandDs = protrusionDs.map(iD => {
      const roundedIsland = roundCornersForEndmill(iD, roughTool.diameterMM + CORNER_ROUND_EXTRA_MM)
      return c !== 0 ? (offsetPathRound(roundedIsland, c) ?? roundedIsland) : roundedIsland
    })
    const endmillSegs: MotionSegment[] = []
    try {
      endmillSegs.push(...generatePocket(roundedD, roughTool, {
        strategy: 'raster', depthMM: totalDepthMM, stepDownMM: params.stepDownMM,
        stepoverPercent: params.stepoverPercent, direction: 'climb',
        islandDs: pocketIslandDs, angle: 0, safeHeightMM: params.safeHeightMM,
        finishAllowanceMM: -c, rampIn: params.rampIn,
      }))
    } catch (e) { if (!isExpectedGeometryError(e)) throw e }
    if (endmillSegs.length === 0)
      throw new Error('Inlay socket is too small for the selected tool')
    return { endmillSegs, vbitSegs: [] }
  }

  // ── V-bit walls: raster pocket to the bevel-foot boundary + medial-axis V-carve. ──
  if (wallTool.type === 'vbit') {
    const tanHalf = Math.tan((params.angleDeg / 2) * (Math.PI / 180))
    if (tanHalf < 1e-6) throw new Error('Invalid V-bit angle')
    const halfWidthMM = totalDepthMM * tanHalf
    const fullWidthMM = halfWidthMM * 2

    const { socketD, pocketBoundaryD, vcarveIslandD } = computeInlayFemaleOffsets(boundaryD, params)

    // Socket too small/thin for the tool geometry → plain medial-axis VCarve, no pocket.
    if (!socketD || !pocketBoundaryD || !vcarveIslandD) {
      const vbitSegs = await generateVCarve(socketD ?? boundaryD, wallTool, {
        angleDeg: params.angleDeg,
        maxDepthMM: (wallTool.diameterMM / 2) / tanHalf,
        islandDs: protrusionDs,
        safeHeightMM: params.safeHeightMM,
      })
      if (!vbitSegs.length) throw new Error('Inlay socket is too small for the selected tools')
      return { vbitSegs, endmillSegs: [] }
    }

    const pocketSegs: MotionSegment[] = []
    const vcarveSegs: MotionSegment[] = []

    const islandPocketDs = protrusionDs
      .map(iD => offsetPathD(iD, halfWidthMM))
      .filter((s): s is string => s !== null)
    try {
      pocketSegs.push(...generatePocket(pocketBoundaryD, roughTool, {
        strategy: 'raster', depthMM: totalDepthMM, stepDownMM: params.stepDownMM,
        stepoverPercent: params.stepoverPercent, direction: 'climb',
        islandDs: islandPocketDs, angle: 0, safeHeightMM: params.safeHeightMM,
        rampIn: params.rampIn,
      }))
    } catch (e) { if (!isExpectedGeometryError(e)) throw e }

    // V-carve the outer wall: socketD down to the flat-bottom boundary (vcarveIslandD).
    try {
      vcarveSegs.push(...await generateVCarve(socketD, wallTool, {
        angleDeg: params.angleDeg, maxDepthMM: 2.5 * totalDepthMM,
        islandDs: [vcarveIslandD], safeHeightMM: params.safeHeightMM,
      }))
    } catch (e) { if (!isExpectedGeometryError(e)) throw e }

    // V-carve each protrusion's annular wall (nominal — clearance is on the socket only).
    for (const iD of protrusionDs) {
      const islandVCarveOuterD = offsetPathD(iD, fullWidthMM)
      if (!islandVCarveOuterD) continue
      try {
        vcarveSegs.push(...await generateVCarve(islandVCarveOuterD, wallTool, {
          angleDeg: params.angleDeg, maxDepthMM: totalDepthMM,
          islandDs: [iD], safeHeightMM: params.safeHeightMM,
        }))
      } catch (e) { if (!isExpectedGeometryError(e)) throw e }
    }

    if (pocketSegs.length === 0 && vcarveSegs.length === 0)
      throw new Error('Inlay socket is too small for the selected tools')
    return { endmillSegs: pocketSegs, vbitSegs: vcarveSegs }
  }

  // ── End-mill walls: round corners, raster pocket, step-down finish contours. ──
  const safeZ = params.safeHeightMM ?? 5
  const finishR = wallTool.diameterMM / 2
  const c = params.clearanceMM
  const zPasses = zStepsTo(totalDepthMM, params.stepDownMM)

  // Round corners so the finish bit reaches convex corners.
  const roundedD = roundCornersForEndmill(boundaryD, wallTool.diameterMM + CORNER_ROUND_EXTRA_MM)
  // Socket wall = rounded outline grown outward by clearance (clearance lives on the
  // socket only). The pocket grows itself by clearance via finishAllowanceMM = −c (done
  // per-ring inside generatePocket, so self-intersecting boundaries stay intact rather
  // than merging). The finish contour is the wall offset inward by the tool radius:
  // offset(roundedD, c − finishR) — a net inward offset for normal clearances, so it
  // doesn't merge self-intersecting loops either.
  const finishContourD = offsetPathRound(roundedD, c - finishR)
  if (!finishContourD) throw new Error('Inlay socket is too small for the selected tools')

  // Protrusions: rounded; pre-grown by clearance so the pocket's −c allowance nets back
  // to nominal (clearance stays on the socket, not the protrusion). Finish-contoured
  // with the tool running finishR outside the nominal protrusion.
  const pocketIslandDs: string[] = []
  const protrusionFinishDs: string[] = []
  for (const iD of protrusionDs) {
    const roundedIsland = roundCornersForEndmill(iD, wallTool.diameterMM + CORNER_ROUND_EXTRA_MM)
    pocketIslandDs.push(c !== 0 ? (offsetPathRound(roundedIsland, c) ?? roundedIsland) : roundedIsland)
    const contour = offsetPathRound(roundedIsland, finishR)
    if (contour) protrusionFinishDs.push(contour)
  }

  const endmillSegs: MotionSegment[] = []
  try {
    endmillSegs.push(...generatePocket(roundedD, roughTool, {
      strategy: 'raster', depthMM: totalDepthMM, stepDownMM: params.stepDownMM,
      stepoverPercent: params.stepoverPercent, direction: 'climb',
      islandDs: pocketIslandDs, angle: 0, safeHeightMM: params.safeHeightMM,
      finishAllowanceMM: -c, rampIn: params.rampIn,
    }))
  } catch (e) { if (!isExpectedGeometryError(e)) throw e }

  const wallRampLen = params.rampIn ? 2 * wallTool.diameterMM : undefined
  const vbitSegs: MotionSegment[] = []
  for (const pts of getOuters(finishContourD)) addContourStack(pts, zPasses, vbitSegs, safeZ, wallRampLen)
  for (const cD of protrusionFinishDs)
    for (const pts of getOuters(cD)) addContourStack(pts, zPasses, vbitSegs, safeZ, wallRampLen)

  if (endmillSegs.length === 0 && vbitSegs.length === 0)
    throw new Error('Inlay socket is too small for the selected tools')
  return { endmillSegs, vbitSegs }
}

// PLUG. Frees a raised feature, with no clearance (the plug stays nominal). For a V-bit
// the outline is traced (tip on path) and the surrounding stock freed by a roughing
// release profile; for an end mill a single outside finish profile forms the wall and
// frees the plug at once. vbitSegs = wall/finish-tool passes, endmillSegs = roughing.
function outerCut(boundaryD: string, roughTool: Tool, wallTool: Tool | null, params: InlayParams): InlaySplitResult {
  const safeZ = params.safeHeightMM ?? 5
  const zPasses = zStepsTo(params.pocketDepthMM, params.stepDownMM)

  // No finish tool: free the plug with a single flat-walled outside profile cut by the
  // roughing end mill itself (corners rounded to its radius). Segments go in endmillSegs.
  if (wallTool === null) {
    const r = roughTool.diameterMM / 2
    const roundedD = roundCornersForEndmill(boundaryD, roughTool.diameterMM + CORNER_ROUND_EXTRA_MM)
    const outsideProfileD = offsetPathRound(roundedD, r)
    const endmillSegs: MotionSegment[] = []
    const rampLen = params.rampIn ? 2 * roughTool.diameterMM : undefined
    if (outsideProfileD)
      for (const outer of getOuters(outsideProfileD)) addContourStack(outer, zPasses, endmillSegs, safeZ, rampLen)
    return { vbitSegs: [], endmillSegs }
  }

  if (wallTool.type !== 'vbit') {
    // End mill: round corners, then one outside profile (finishR outside the wall).
    const finishR = wallTool.diameterMM / 2
    const roundedD = roundCornersForEndmill(boundaryD, wallTool.diameterMM + CORNER_ROUND_EXTRA_MM)
    const outsideProfileD = offsetPathRound(roundedD, finishR)
    const vbitSegs: MotionSegment[] = []
    const rampLen = params.rampIn ? 2 * wallTool.diameterMM : undefined
    if (outsideProfileD)
      for (const outer of getOuters(outsideProfileD)) addContourStack(outer, zPasses, vbitSegs, safeZ, rampLen)
    return { vbitSegs, endmillSegs: [] }
  }

  // V-bit: trace the outline (tip on path) + roughing release profile to free the plug.
  const vbitSegs: MotionSegment[] = []
  for (const pts of getOuters(boundaryD)) addContourStack(pts, zPasses, vbitSegs, safeZ)
  const endmillSegs: MotionSegment[] = []
  const releaseD = offsetPathD(boundaryD, roughTool.diameterMM / 2)
  const rampLen = params.rampIn ? 2 * roughTool.diameterMM : undefined
  if (releaseD) for (const outer of getOuters(releaseD)) addContourStack(outer, zPasses, endmillSegs, safeZ, rampLen)
  return { vbitSegs, endmillSegs }
}

/**
 * Female socket = insideClear(outline, islands): pocket the interior and form the walls
 * (V-bit V-carve or end-mill finish contour), leaving any islands standing as protrusions.
 * `endmill` is the roughing tool, `vbit` the wall tool (its .type selects the wall method).
 * `vbit === null` skips the wall pass entirely → a plain flat-walled roughing-only socket.
 */
export async function generateInlayFemale(
  d: string,
  endmill: Tool,
  vbit: Tool | null,
  params: InlayParams
): Promise<InlaySplitResult> {
  // Text / multi-subpath with a V-bit: plain VCarve over the whole path (the VCarve
  // alone forms the socket; no flat pocket). Depth at full engagement = r / tan(half).
  if (vbit && vbit.type === 'vbit' && splitRegions(d).length > 0) {
    const tanHalf = Math.tan((params.angleDeg / 2) * (Math.PI / 180))
    if (tanHalf < 1e-6) throw new Error('Invalid V-bit angle')
    const vbitSegs = await generateVCarve(d, vbit, {
      angleDeg: params.angleDeg,
      maxDepthMM: (vbit.diameterMM / 2) / tanHalf,
      islandDs: params.islandDs,
      safeHeightMM: params.safeHeightMM,
    })
    if (!vbitSegs.length) throw new Error('Inlay socket is too small for the selected tools')
    return { vbitSegs, endmillSegs: [] }
  }

  // Closed shape: socket of the outline, with its islands standing as protrusions.
  return insideClear(d, params.islandDs, endmill, vbit, params)
}

// ─── Male plug ────────────────────────────────────────────────────────────────

export interface InlaySplitResult {
  vbitSegs: MotionSegment[]
  endmillSegs: MotionSegment[]
}

/**
 * Male text-plug algorithm — Virtual Z-Plane Shift.
 *
 * Called for multi-subpath paths (text, multi-letter shapes) where each letter
 * subpath acts as a raised prism on the plug face.
 *
 * Core principle:
 *   The V-carve runs directly on each letter boundary (not inverted). The bit
 *   apex starts at z=0 (surface) and descends in proportion to the local MAT
 *   radius, producing continuous raised-prism walls along each letter edge.
 *
 *   Z_raw = r / tan(θ/2)   (r = MAT radius at each skeleton point)
 *   Z_max = vbitRadius / tan(θ/2)   (caps Z when the bit is fully engaged)
 *
 * The end mill clears the recessed background (bbox minus letter outers) to
 * pocketDepthMM, pockets any letter counters (e.g. inside of 'O') to the same
 * depth, and profiles the bounding-box perimeter to free the plug from stock.
 * glueLineMM is not applied to the male plug — it only affects the female socket.
 */
async function generateInlayMaleText(
  d: string,
  profileTool: Tool,
  vbitTool: Tool,
  params: InlayParams,
): Promise<InlaySplitResult> {
  const safeZ = params.safeHeightMM ?? 5
  const workingD = params.mirrorX ? mirrorPathD(d) : d

  const startDepthMM = 0  // Z_start: bit apex at surface; depth grows with stroke width

  const halfAngle    = (params.angleDeg / 2) * (Math.PI / 180)
  const tanHalfAngle = Math.tan(halfAngle)
  if (tanHalfAngle < 1e-6) throw new Error('Invalid V-bit angle')

  // Z_max: depth when the V-bit is fully engaged at its widest cutting radius.
  const vbitMaxDepthMM = (vbitTool.diameterMM / 2) / tanHalfAngle

  // Split into per-letter regions (outer ring + intrinsic counter-holes like 'O', 'A').
  const regions = splitRegions(workingD)
  if (regions.length === 0) throw new Error('Text path produced no letter regions')

  const letterOuterDs  = regions.map(r => r.outerD)
  const letterCounterDs = regions.flatMap(r => r.islandDs)

  // Compute bounding box of all letter outer rings.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const od of letterOuterDs) {
    for (const sub of flattenPath(od, 0.05)) {
      for (const [x, y] of sub) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (!isFinite(minX)) throw new Error('Cannot compute bounding box for text path')

  // Margin: wide enough for the V-bit at max engagement + end mill diameter clearance.
  const margin = Math.max(vbitMaxDepthMM * tanHalfAngle * 2, profileTool.diameterMM, 2.0)
  minX -= margin; minY -= margin; maxX += margin; maxY += margin

  // Bounding box polygon (CCW in CNC Y-up).
  const bboxPts: Pt2[] = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]
  const bboxD = ptsToD(bboxPts)

  const vbitSegs: MotionSegment[] = []
  const endmillSegs: MotionSegment[] = []

  // ── V-bit pass ─────────────────────────────────────────────────────────────
  // Profile each letter's boundary with the V-bit at depths set by the nearest
  // MAT radius: Z = -(startDepth + r/tan(θ/2)).  This traces the letter outline
  // (not the skeleton) so the cut creates the outward bevel on the raised prism.
  for (const r of regions) {
    try {
      vbitSegs.push(...await generateMaleTextBoundaryVCarve(r.outerD, vbitTool, {
        angleDeg:   params.angleDeg,
        maxDepthMM: vbitMaxDepthMM,
        zStartMM:   startDepthMM,
        islandDs:   r.islandDs,
        safeHeightMM: params.safeHeightMM,
      }))
    } catch (e) { if (!isExpectedGeometryError(e)) throw e }
  }

  // ── End mill background pocket ──────────────────────────────────────────────
  // Clear the background (inside bboxD, outside letter outer rings) to inlay depth.
  // generatePocket automatically respects the tool radius when approaching islands.
  try {
    endmillSegs.push(...generatePocket(bboxD, profileTool, {
      strategy:       'raster',
      depthMM:        params.pocketDepthMM,
      stepDownMM:     params.stepDownMM,
      stepoverPercent: params.stepoverPercent,
      direction:      'climb',
      islandDs:       letterOuterDs,
      angle:          0,
      safeHeightMM:   params.safeHeightMM,
      rampIn:         params.rampIn,
    }))
  } catch (e) { if (!isExpectedGeometryError(e)) throw e }

  // ── End mill counter pockets ────────────────────────────────────────────────
  // Letter counters (e.g. the void inside 'O') must be recessed to inlay depth
  // so they match the female socket's protruding counter islands.
  for (const counterD of letterCounterDs) {
    try {
      endmillSegs.push(...generatePocket(counterD, profileTool, {
        strategy:       'raster',
        depthMM:        params.pocketDepthMM,
        stepDownMM:     params.stepDownMM,
        stepoverPercent: params.stepoverPercent,
        direction:      'climb',
        islandDs:       [],
        angle:          0,
        safeHeightMM:   params.safeHeightMM,
        rampIn:         params.rampIn,
      }))
    } catch (e) { if (!isExpectedGeometryError(e)) throw e }
  }

  // ── Release profile ─────────────────────────────────────────────────────────
  // Profile the bounding box perimeter to inlay depth to free the plug from stock.
  const releaseOffset = profileTool.diameterMM / 2
  const releaseD = offsetPathD(bboxD, releaseOffset)
  if (releaseD) {
    const depth = params.pocketDepthMM
    const step  = Math.abs(params.stepDownMM)
    const zPasses: number[] = []
    let zr = -step
    while (zr > -depth) { zPasses.push(zr); zr -= step }
    zPasses.push(-depth)
    const rampLen = params.rampIn ? 2 * profileTool.diameterMM : undefined
    for (const pts of getOuters(releaseD)) {
      addContourStack(pts, zPasses, endmillSegs, safeZ, rampLen)
    }
  }

  if (vbitSegs.length === 0 && endmillSegs.length === 0)
    throw new Error('Inlay text plug is too small for the selected tools')
  return { vbitSegs, endmillSegs }
}

/**
 * Male plug = outerCut(outer boundary) + insideClear(each island).
 *   - The border is a plug: V-carve the outline + end-mill release profile (outerCut).
 *   - Each island is a hole = a socket that receives the mating female protrusion, so
 *     it's an inside-clear (the same primitive the female socket uses).
 * This is the female operation with the solid side flipped on every boundary.
 *
 * Multi-subpath paths (text) use the Virtual Z-Plane Shift algorithm (generateInlayMaleText),
 * which treats letters as raised prisms cut from a bounding box.
 *
 * Returns segments split by tool so callers can create one operation per tool, enabling
 * all V-bit passes to run before any end mill passes (one tool change total).
 */
export async function generateInlayMale(
  d: string,
  profileTool: Tool,
  vbitTool: Tool | null,
  params: InlayParams
): Promise<InlaySplitResult> {
  // Multi-subpath paths (text) with a V-bit: Virtual Z-Plane Shift (raised-letter prisms).
  if (vbitTool && vbitTool.type === 'vbit' && splitRegions(d).length > 0) {
    return generateInlayMaleText(d, profileTool, vbitTool, params)
  }

  const workingD = params.mirrorX ? mirrorPathD(d) : d
  const vbitSegs: MotionSegment[] = []
  const endmillSegs: MotionSegment[] = []

  // Plug border: outer-cut (no clearance — the plug stays nominal).
  const border = outerCut(workingD, profileTool, vbitTool, params)
  vbitSegs.push(...border.vbitSegs)
  endmillSegs.push(...border.endmillSegs)

  // Each island is a hole in the plug = a socket that receives the mating female
  // protrusion, so it's an inside-clear. clearanceMM enlarges it so the protrusion fits
  // (and its medial-axis V-carve clears the tips a round end mill can't reach). glueLine
  // belongs only to the real female socket, not the male.
  for (const rawIslandD of params.islandDs) {
    const islandD = params.mirrorX ? mirrorPathD(rawIslandD) : rawIslandD
    try {
      const socket = await insideClear(islandD, [], profileTool, vbitTool, { ...params, glueLineMM: 0 })
      vbitSegs.push(...socket.vbitSegs)
      endmillSegs.push(...socket.endmillSegs)
    } catch (e) { if (!isExpectedGeometryError(e)) throw e }
  }

  if (vbitSegs.length === 0 && endmillSegs.length === 0)
    throw new Error('Inlay plug is too small for the selected tools')
  return { vbitSegs, endmillSegs }
}
