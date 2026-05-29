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
  mirrorX?: boolean          // male only: mirror shape around vertical axis
  safeHeightMM?: number
}

// Offset a path by deltaMM (positive = outward, negative = inward).
// Returns an SVG path string containing all result loops, or null if the offset
// collapses all loops. Self-intersecting input paths are split into simple loops
// first so Clipper2 receives well-formed polygons.
function offsetPathD(d: string, deltaMM: number): string | null {
  const subpaths = splitSelfIntersecting(flattenPath(d, 0.05))
  if (!subpaths.length) return null

  const inputPaths = subpaths.map(sp => {
    let pts = [...sp]
    if (pts.length > 1 && Math.hypot(pts[pts.length-1][0]-pts[0][0], pts[pts.length-1][1]-pts[0][1]) < 1e-6)
      pts = pts.slice(0, -1)
    if (signedArea(pts) < 0) pts = [...pts].reverse()
    return pts.map(([x, y]) => ({ x, y }))
  })

  const result = inflatePathsD(inputPaths, deltaMM, JoinType.Miter, EndType.Polygon, 4, 6)
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

// Like offsetPathD but uses Round joins — produces smooth circular arcs at corners.
function offsetPathRound(d: string, deltaMM: number): string | null {
  const subpaths = splitSelfIntersecting(flattenPath(d, 0.05))
  if (!subpaths.length) return null
  const inputPaths = subpaths.map(sp => {
    let pts = [...sp]
    if (pts.length > 1 && Math.hypot(pts[pts.length-1][0]-pts[0][0], pts[pts.length-1][1]-pts[0][1]) < 1e-6)
      pts = pts.slice(0, -1)
    if (signedArea(pts) < 0) pts = [...pts].reverse()
    return pts.map(([x, y]) => ({ x, y }))
  })
  const result = inflatePathsD(inputPaths, deltaMM, JoinType.Round, EndType.Polygon, 4, 2)
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

// Round all convex (outer) corners of path d to radius r using the corner tool.
export function roundCornersForEndmill(d: string, r: number): string {
  if (r <= 0.001) return d
  return applyCornerTreatment(d, { type: 'outerRound', radiusMM: r })
}

// ─── End Mill Inlay ──────────────────────────────────────────────────────────

const CORNER_ROUND_EXTRA_MM = 1

// Female socket for flat (end mill) inlay.
//
// Algorithm:
//   1. Round all corners of the design path to the finish-bit radius.
//   2. Inset the rounded path by (finishR + clearance) — this is the finish-tool
//      centre path and the outer boundary for the roughing pocket.
//   3. Pocket everything inside that boundary with the roughing bit.
//   4. Profile the boundary with the finishing bit (step-down contour passes).
//
// The gap between the male wall (at roundedD) and the female wall
// (at roundedD inset by clearance) is exactly clearanceMM.
async function generateInlayFemaleEndmill(
  d: string,
  endmill: Tool,
  finishTool: Tool,
  params: InlayParams
): Promise<InlaySplitResult> {
  const safeZ = params.safeHeightMM ?? 5
  const finishR = finishTool.diameterMM / 2
  const c = params.clearanceMM
  const totalDepth = params.pocketDepthMM + params.glueLineMM
  const step = Math.abs(params.stepDownMM)

  // Round corners so the finish tool can reach every convex corner cleanly.
  // Pass roundedD directly to generatePocket — it handles the tool-radius offset
  // internally. Pre-insetting here causes a double-offset that collapses narrow
  // concave features like the notch between K's legs.
  const roundedD = roundCornersForEndmill(d, finishTool.diameterMM + CORNER_ROUND_EXTRA_MM)

  // Finish-tool centre path: used for the explicit contour pass after roughing.
  const femaleContourD = offsetPathRound(roundedD, -(finishR - c))
  if (!femaleContourD)
    throw new Error('Inlay socket is too small for the selected tools')

  const zPasses: number[] = []
  let z = -step
  while (z > -totalDepth) { zPasses.push(z); z -= step }
  zPasses.push(-totalDepth)

  // Islands: round corners and expand by clearance for the pocket keep-out boundary.
  const pocketIslandDs: string[] = []
  const islandFinishDs: string[] = []
  for (const rawIslandD of params.islandDs) {
    const roundedIsland = roundCornersForEndmill(rawIslandD, finishTool.diameterMM + CORNER_ROUND_EXTRA_MM)
    const pillar = c !== 0 ? (offsetPathRound(roundedIsland, -c) ?? roundedIsland) : roundedIsland
    pocketIslandDs.push(pillar)
    const contour = offsetPathRound(pillar, finishR)
    if (contour) islandFinishDs.push(contour)
  }

  // Pocket the rounded path directly — no pre-inset.
  const endmillSegs: MotionSegment[] = []
  try {
    endmillSegs.push(...generatePocket(roundedD, endmill, {
      strategy: 'raster',
      depthMM: totalDepth,
      stepDownMM: params.stepDownMM,
      stepoverPercent: params.stepoverPercent,
      direction: 'climb',
      islandDs: pocketIslandDs,
      angle: 0,
      safeHeightMM: params.safeHeightMM,
    }))
  } catch { /* shape too small for end mill */ }

  if (endmillSegs.length === 0)
    throw new Error('Inlay socket is too small for the selected tools')

  // Step 4: profile the socket wall (and each island wall) with the finishing bit.
  const vbitSegs: MotionSegment[] = []
  for (const pts of getOuters(femaleContourD)) {
    for (const zPass of zPasses) addContour(pts, zPass, vbitSegs, safeZ)
  }
  for (const islandD of islandFinishDs) {
    for (const pts of getOuters(islandD)) {
      for (const zPass of zPasses) addContour(pts, zPass, vbitSegs, safeZ)
    }
  }

  return { endmillSegs, vbitSegs }
}

// Male plug for flat (end mill) inlay.
//
// Algorithm:
//   1. Round all convex corners of the design path to the finish-bit radius.
//   2. Offset the rounded path outward by clearanceMM — release-cut boundary.
//   3. Outside profile that path with the finishing bit (step-down contour passes).
//   4. Pocket any islands with the roughing bit.
async function generateInlayMaleEndmill(
  d: string,
  profileTool: Tool,
  finishTool: Tool,
  params: InlayParams
): Promise<InlaySplitResult> {
  const safeZ = params.safeHeightMM ?? 5
  const workingD = params.mirrorX ? mirrorPathD(d) : d
  const finishR = finishTool.diameterMM / 2
  const depth = Math.abs(params.pocketDepthMM)
  const step = Math.abs(params.stepDownMM)

  const zPasses: number[] = []
  let z = -step
  while (z > -depth) { zPasses.push(z); z -= step }
  zPasses.push(-depth)

  // Step 1: round convex corners to finish-bit radius.
  const roundedD = roundCornersForEndmill(workingD, finishTool.diameterMM + CORNER_ROUND_EXTRA_MM)

  // Step 2: offset by clearance to get the plug boundary.
  const plugBoundaryD = params.clearanceMM > 0
    ? (offsetPathRound(roundedD, -params.clearanceMM) ?? roundedD)
    : roundedD

  // Step 3: outside profile — tool center runs finishR outside the plug boundary.
  const outsideProfileD = offsetPathRound(plugBoundaryD, finishR)
  const vbitSegs: MotionSegment[] = []
  if (outsideProfileD) {
    for (const outer of getOuters(outsideProfileD)) {
      for (const zPass of zPasses) addContour(outer, zPass, vbitSegs, safeZ)
    }
  }

  if (vbitSegs.length === 0)
    throw new Error('Inlay plug is too small for the selected tools')

  // Step 4: pocket islands with roughing bit + inside profile with finishing bit.
  const endmillSegs: MotionSegment[] = []
  for (const rawIslandD of params.islandDs) {
    const islandD = params.mirrorX ? mirrorPathD(rawIslandD) : rawIslandD
    const roundedIsland = roundCornersForEndmill(islandD, profileTool.diameterMM + CORNER_ROUND_EXTRA_MM)
    try {
      endmillSegs.push(...generatePocket(roundedIsland, profileTool, {
        strategy: 'raster',
        depthMM: params.pocketDepthMM,
        stepDownMM: params.stepDownMM,
        stepoverPercent: params.stepoverPercent,
        direction: 'climb',
        islandDs: [],
        angle: 0,
        safeHeightMM: params.safeHeightMM,
      }))
    } catch { /* island too small */ }
    // Inside profile — tool center runs finishR inside the island wall.
    const insideProfileD = offsetPathRound(roundedIsland, -finishR)
    if (insideProfileD) {
      for (const pts of getOuters(insideProfileD)) {
        for (const zPass of zPasses) addContour(pts, zPass, vbitSegs, safeZ)
      }
    }
  }

  return { vbitSegs, endmillSegs }
}

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
  const regions: { outerD: string; islandDs: string[] }[] = []

  for (let i = 0; i < sorted.length; i++) {
    if (usedAsHole.has(i)) continue
    const outer = sorted[i]
    const cx = outer.reduce((s, p) => s + p[0], 0) / outer.length
    const cy = outer.reduce((s, p) => s + p[1], 0) / outer.length
    if (regions.some(r => {
      const rSub = flattenPath(r.outerD, 0.05)[0]
      return rSub && ptInPoly(cx, cy, rSub)
    })) { usedAsHole.add(i); continue }

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
    regions.push({ outerD: ptsToD(outer), islandDs: holes })
  }
  return regions
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


function addContour(pts: Pt2[], z: number, segs: MotionSegment[], safeZ = 5) {
  if (pts.length < 2) return
  const [sx, sy] = pts[0]
  segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
  segs.push({ x: sx, y: sy, z, rapid: false })
  for (let i = 1; i < pts.length; i++) segs.push({ x: pts[i][0], y: pts[i][1], z, rapid: false })
  segs.push({ x: sx, y: sy, z, rapid: false })
  segs.push({ x: sx, y: sy, z: safeZ, rapid: true })
}

function getOuters(d: string): Pt2[][] {
  const subs = flattenPath(d, 0.05).filter(s => s.length >= 3)
  const outers = subs.filter(s => signedArea(s) >= 0)
  return outers.length > 0 ? outers : subs
}

// ─── Female socket ────────────────────────────────────────────────────────────

// Compute the two inward offset paths for the female operation.
// Exported so the UI can add them to the canvas as debug paths.
export function computeInlayFemaleOffsets(
  d: string,
  params: Pick<InlayParams, 'angleDeg' | 'pocketDepthMM' | 'glueLineMM' | 'clearanceMM'>,
): { pocketBoundaryD: string | null; vcarveIslandD: string | null } {
  const halfAngle = (params.angleDeg / 2) * (Math.PI / 180)
  const tanHalf = Math.tan(halfAngle)
  if (tanHalf < 1e-6) return { pocketBoundaryD: null, vcarveIslandD: null }
  // Offsets are computed for the total socket depth so the V-carved walls
  // reach all the way to the pocket floor (glue gap included).
  const totalDepthMM = params.pocketDepthMM + params.glueLineMM
  const halfWidthMM = totalDepthMM * tanHalf
  const fullWidthMM = halfWidthMM * 2
  const c = params.clearanceMM
  return {
    pocketBoundaryD: offsetPathD(d, c - halfWidthMM),
    vcarveIslandD:   offsetPathD(d, c - fullWidthMM * 1.5),
  }
}

/**
 * Female socket: raster-pocket a flat bottom + V-carve the sloped walls.
 *
 * V-bit geometry at pocketDepthMM:
 *   halfWidth = depth × tan(angleDeg/2) — half-width at full depth
 *   fullWidth = 2 × halfWidth            — full width at full depth
 *
 * Step 1 — End mill clears a raster pocket bounded by (socketD inset halfWidth).
 *           Everything inside that boundary is cleared flat to pocketDepthMM.
 *
 * Step 2 — V-carve the annular zone: outer = socketD, inner island = (socketD inset fullWidth).
 *           The medial axis runs at halfWidth from the outer wall, exactly where the
 *           V-bit tip reaches pocketDepthMM and is simultaneously tangent to both walls.
 *           This produces the correct sloped entry from z=0 at the outer wall down to
 *           z=−pocketDepthMM at the flat-bottom boundary.
 */
export async function generateInlayFemale(
  d: string,
  endmill: Tool,
  vbit: Tool,
  params: InlayParams
): Promise<InlaySplitResult> {
  if (vbit.type !== 'vbit') return generateInlayFemaleEndmill(d, endmill, vbit, params)

  // Multi-subpath paths (text): plain VCarve on the whole path, max depth set by
  // the V-bit's geometry (depth at full engagement = radius / tan(halfAngle)).
  // No pocket — the VCarve alone defines the female socket for text inlays.
  if (splitRegions(d).length > 0) {
    const halfAngle = (params.angleDeg / 2) * (Math.PI / 180)
    const tanHalf   = Math.tan(halfAngle)
    if (tanHalf < 1e-6) throw new Error('Invalid V-bit angle')
    const maxDepthMM = (vbit.diameterMM / 2) / tanHalf
    const vbitSegs = await generateVCarve(d, vbit, {
      angleDeg: params.angleDeg,
      maxDepthMM,
      islandDs: params.islandDs,
      safeHeightMM: params.safeHeightMM,
    })
    if (!vbitSegs.length) throw new Error('Inlay socket is too small for the selected tools')
    return { vbitSegs, endmillSegs: [] }
  }

  // Both offsets are inward from the original path d.
  const { pocketBoundaryD, vcarveIslandD } = computeInlayFemaleOffsets(d, params)

  // Precompute bevel widths so we can offset island boundaries correctly.
  const halfAngle = (params.angleDeg / 2) * (Math.PI / 180)
  const tanHalf = Math.tan(halfAngle)

  // If either offset path collapsed (shape too small/thin for the tool geometry),
  // fall back to the text strategy: plain VCarve on the whole path, no pocket.
  if (!pocketBoundaryD || !vcarveIslandD) {
    if (tanHalf < 1e-6) throw new Error('Invalid V-bit angle')
    const maxDepthMM = (vbit.diameterMM / 2) / tanHalf
    const vbitSegs = await generateVCarve(d, vbit, {
      angleDeg: params.angleDeg,
      maxDepthMM,
      islandDs: params.islandDs,
      safeHeightMM: params.safeHeightMM,
    })
    if (!vbitSegs.length) throw new Error('Inlay socket is too small for the selected tools')
    return { vbitSegs, endmillSegs: [] }
  }
  const totalDepthMM = params.pocketDepthMM + params.glueLineMM
  const halfWidthMM = totalDepthMM * tanHalf
  const fullWidthMM = halfWidthMM * 2

  const pocketSegs: MotionSegment[] = []
  const vcarveSegs: MotionSegment[] = []

  // Step 1: flat-bottom raster pocket (end mill, inside pocketBoundaryD).
  // Cut glueLineMM deeper than the plug bevel depth to leave room for glue.
  if (pocketBoundaryD) {
    const islandPocketDs = params.islandDs
      .map(iD => offsetPathD(iD, halfWidthMM - params.clearanceMM))
      .filter((s): s is string => s !== null)
    try {
      pocketSegs.push(...generatePocket(pocketBoundaryD, endmill, {
        strategy: 'raster',
        depthMM: params.pocketDepthMM + params.glueLineMM,
        stepDownMM: params.stepDownMM,
        stepoverPercent: params.stepoverPercent,
        direction: 'climb',
        islandDs: islandPocketDs,
        angle: 0,
        safeHeightMM: params.safeHeightMM,
      }))
    } catch { /* shape too small for end mill — skip pocket */ }
  }

  // Step 2: V-carved sloped walls — outer boundary + one annular zone per island.
  //
  // Outer wall: between d and (d inset by fullWidth).
  // Island wall: between (islandD outset by fullWidth) and islandD.
  // Each island's annular zone is independent — call generateVCarve separately so
  // the medial axis for each zone is clean (mixing them would corrupt both axes).
  const dVCarve = params.clearanceMM !== 0 ? (offsetPathD(d, params.clearanceMM) ?? d) : d
  if (vcarveIslandD) {
    try {
      vcarveSegs.push(...await generateVCarve(dVCarve, vbit, {
        angleDeg: params.angleDeg,
        maxDepthMM: 2.5 * (params.pocketDepthMM + params.glueLineMM),
        islandDs: [vcarveIslandD],
        safeHeightMM: params.safeHeightMM,
      }))
    } catch { /* annular zone too narrow for this bit — skip vcarve */ }
  }

  for (const islandD of params.islandDs) {
    const islandVCarveOuterD = offsetPathD(islandD, fullWidthMM - params.clearanceMM)
    if (!islandVCarveOuterD) continue
    const islandVCarveInnerD = params.clearanceMM !== 0
      ? (offsetPathD(islandD, -params.clearanceMM) ?? islandD)
      : islandD
    try {
      vcarveSegs.push(...await generateVCarve(islandVCarveOuterD, vbit, {
        angleDeg: params.angleDeg,
        maxDepthMM: params.pocketDepthMM + params.glueLineMM,
        islandDs: [islandVCarveInnerD],
        safeHeightMM: params.safeHeightMM,
      }))
    } catch { /* island too small for this bit — skip */ }
  }

  if (pocketSegs.length === 0 && vcarveSegs.length === 0)
    throw new Error('Inlay socket is too small for the selected tools')

  return { endmillSegs: pocketSegs, vbitSegs: vcarveSegs }
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
 *   The V-carve runs on the INVERTED geometry — a bounding box with the letter
 *   outlines as islands (holes). The Z-start offset forces the bit apex to sit at
 *   −pocketDepthMM at every letter boundary instead of 0, producing continuous
 *   raised prism walls. A flat-depth cap (pocketDepthMM + glueLineMM) limits how
 *   deep the background is cut in wide open areas.
 *
 *   Z_raw  = pocketDepthMM + r / tan(θ/2)
 *   Z_cut  = min(Z_raw, pocketDepthMM + glueLineMM)
 *
 * The end mill clears the recessed background (bbox minus letter regions) to
 * pocketDepthMM and pockets any letter counters (e.g. inside of 'O').
 * A perimeter profile cut frees the plug from the surrounding stock.
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
    } catch { /* letter too small — skip */ }
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
    }))
  } catch { /* background too small for end mill — skip */ }

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
      }))
    } catch { /* counter too small — skip */ }
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
    for (const pts of getOuters(releaseD)) {
      for (const zPass of zPasses) addContour(pts, zPass, endmillSegs, safeZ)
    }
  }

  if (vbitSegs.length === 0 && endmillSegs.length === 0)
    throw new Error('Inlay text plug is too small for the selected tools')
  return { vbitSegs, endmillSegs }
}

/**
 * Male plug:
 *   vbitSegs  — V-bit profiles the letter boundary and island edges (no offset, tip on path).
 *   endmillSegs — End mill release profile (boundary outset by endmill_radius) + island pockets.
 *
 * For multi-subpath paths (text), uses the Virtual Z-Plane Shift algorithm
 * (generateInlayMaleText) which treats letters as raised prisms cut from a bounding box.
 * For single-subpath shapes the original step-down contour algorithm is used.
 *
 * Returns segments split by tool so callers can create one operation per tool, enabling
 * all V-bit passes across all shapes to run before any end mill passes (one tool change total).
 */
export async function generateInlayMale(
  d: string,
  profileTool: Tool,
  vbitTool: Tool,
  params: InlayParams
): Promise<InlaySplitResult> {
  if (vbitTool.type !== 'vbit') return generateInlayMaleEndmill(d, profileTool, vbitTool, params)
  const safeZ = params.safeHeightMM ?? 5

  // Multi-subpath paths (text): use the Virtual Z-Plane Shift algorithm which
  // inverts the geometry into a bounding box and applies a MAT VCarve with a
  // Z-start offset to produce proper raised-letter prisms.
  const regions = splitRegions(d)
  if (regions.length > 0) {
    return generateInlayMaleText(d, profileTool, vbitTool, params)
  }

  const workingD = params.mirrorX ? mirrorPathD(d) : d

  const depth = Math.abs(params.pocketDepthMM)
  const step = Math.abs(params.stepDownMM)
  const zPasses: number[] = []
  let z = -step
  while (z > -depth) { zPasses.push(z); z -= step }
  zPasses.push(-depth)

  const vbitSegs: MotionSegment[] = []

  // V-bit profiles the letter boundary and island edges (tip on path, no offset).
  for (const pts of getOuters(workingD)) {
    for (const zPass of zPasses) addContour(pts, zPass, vbitSegs, safeZ)
  }
  for (const rawIslandD of params.islandDs) {
    const islandD = params.mirrorX ? mirrorPathD(rawIslandD) : rawIslandD
    for (const sub of splitSelfIntersecting(flattenPath(islandD, 0.05)).filter(s => s.length >= 3)) {
      for (const zPass of zPasses) addContour(sub, zPass, vbitSegs, safeZ)
    }
  }

  const endmillSegs: MotionSegment[] = []

  // End mill release profile: boundary outset by endmill_radius.
  const releaseOffset = profileTool.diameterMM / 2
  const releaseD = offsetPathD(workingD, releaseOffset)
  if (releaseD) {
    for (const outer of getOuters(releaseD)) {
      for (const zPass of zPasses) addContour(outer, zPass, endmillSegs, safeZ)
    }
  }

  // End mill island pockets: clear to the island boundary with no offset.
  for (const rawIslandD of params.islandDs) {
    const islandD = params.mirrorX ? mirrorPathD(rawIslandD) : rawIslandD
    try {
      endmillSegs.push(...generatePocket(islandD, profileTool, {
        strategy: 'raster',
        depthMM: params.pocketDepthMM,
        stepDownMM: params.stepDownMM,
        stepoverPercent: params.stepoverPercent,
        direction: 'climb',
        islandDs: [],
        angle: 0,
        safeHeightMM: params.safeHeightMM,
      }))
    } catch { /* island too small for end mill — skip */ }
  }

  if (vbitSegs.length === 0 && endmillSegs.length === 0)
    throw new Error('Inlay plug is too small for the selected tools')
  return { vbitSegs, endmillSegs }
}
