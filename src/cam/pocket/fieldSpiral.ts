import {  signedArea, ensureWinding, type Pt2 } from '../pathFlattener'
import { morphChainToSpiral } from '../spiralMorph'
import { solveField, type FieldGrid } from '../spiralField'
import { traceIsolines } from '../marchingSquares'
import {  JoinType } from 'clipper2-ts'
import {   stripClosingDuplicate, pointInPolygon } from '../geom'
import type { MotionSegment } from '../../store/toolpathStore'
import type { Tool } from '../../store/toolStore'
import { type PocketParams, _timed, centroidOfRing, compoundFinishRings, emitLinkedContourRings, emitRampDescent, emitSpiralHelixEntry, growIslands, growRing, insetRing, isTravelSafe, rampLeadIn } from './shared'
import { setGap } from './shared'
import { type LoopNode, type SpiralChain, clampSpiralToRegion, decimateChain, dedupeForestBranches, forestToChains, maxClearHelixRadius, splitClampedSpiral } from './spiral'

// ─── Field-based curvilinear spiral (Bieterman/Leroy) ────────────────────────────
//
// Solves a Poisson "temperature" field over the pocket (0 at the walls, peaking on
// the medial ridge), traces its isotherms as structure curves spaced by the radial
// tool engagement, and morphs them into a curvilinear spiral that starts with a
// helix at the field's peak and works outward to the wall. Unlike the offset-ring
// spiral, the first cut is a helix (not a full-width slot), so engagement stays
// limited — this is the cheap approximation of the adaptive clearing path.
//


// Light Laplacian smoothing of a closed loop — removes the ~1-cell staircase that
// marching squares leaves on the grid, so the isotherm reads as the smooth curve it
// represents. Without this the blocky corners make the corner-fillet smoothing
// explode the point count (and nudge points across walls/islands).
function smoothLoop(loop: Pt2[], iters: number, factor: number): Pt2[] {
  const n = loop.length
  if (n < 5) return loop
  let cur = loop
  for (let it = 0; it < iters; it++) {
    const out: Pt2[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const a = cur[(i - 1 + n) % n], p = cur[i], b = cur[(i + 1) % n]
      out[i] = [p[0] + factor * ((a[0] + b[0]) / 2 - p[0]), p[1] + factor * ((a[1] + b[1]) / 2 - p[1])]
    }
    cur = out
  }
  return cur
}

function isothermLoops(g: FieldGrid, level: number): Pt2[][] {
  return traceIsolines(g, level)
    .map(l => smoothLoop(stripClosingDuplicate(l), 2, 0.5))
    .filter(l => l.length >= 3 && Math.abs(signedArea(l)) > 0.01)
}

// Build the structure-curve levels for the merge-tree spiral, ordered outer →
// inner: levels[0] is the inset boundary (the wall), and each subsequent level is
// the isotherm set one stepover further in. Because isotherms of a multi-maximum
// field split into separate loops near the peaks, each level is a *set* of loops;
// buildOffsetForest then turns the nesting/splits into per-seed chains.
//
// Levels are spaced by distance, not by temperature: the field is flat near a
// peak, so a fixed temperature step would leave huge distance gaps there. Levels
// are decimated per chain (below) to one stepover.
//
// Loops are NOT grouped by temperature: around an island the field is annular, so
// one temperature gives two concentric loops (toward the wall, toward the island)
// at very different distances. Instead we extract isotherm loops densely and nest
// them by area/containment — every loop encircling an island encloses its centre,
// so they sort cleanly by size into one chain wall→ridge→island. This is
// topology-agnostic: a simple disk nests the same way.

// True when a majority of `inner`'s sampled vertices lie inside `outer`. Sampling
// ~12 vertices (not one) makes isotherm nesting robust to marching-squares grid
// noise that can place an individual near-wall vertex just outside its true parent.
function loopMostlyInside(inner: Pt2[], outer: Pt2[]): boolean {
  const SAMPLES = 12
  const step = Math.max(1, Math.floor(inner.length / SAMPLES))
  let tested = 0, inCount = 0
  for (let i = 0; i < inner.length; i += step) {
    tested++
    if (pointInPolygon(inner[i][0], inner[i][1], outer)) inCount++
  }
  return tested > 0 && inCount * 2 > tested
}

function buildIsothermChains(g: FieldGrid, insetBoundary: Pt2[], stepoverMM: number, wantCCW: boolean): SpiralChain[] {
  const wall = ensureWinding(stripClosingDuplicate(insetBoundary), wantCCW)
  const loops: Pt2[][] = [wall]
  const NL = 120
  for (let i = 1; i <= NL; i++) {
    for (const lp of isothermLoops(g, (g.tMax * i) / (NL + 1))) loops.push(ensureWinding(lp, wantCCW))
  }

  // Cull near-coincident loops. The dense extraction over-samples — near the wall
  // consecutive isotherms can sit a small fraction of a stepover apart. Such
  // near-duplicate loops make the majority-vote containment test below ambiguous
  // (~half their vertices straddle each other under grid noise), which fragments a
  // single region into multiple spurious roots/branches — the doubled spiral+contour
  // bug. Keep a loop only when it clears every already-kept (larger) loop by at least
  // a fraction of a stepover; properly spaced loops and separate lobes keep a large
  // gap and survive. Largest-area first so the wall anchors the kept set.
  const areasAll = loops.map(l => Math.abs(signedArea(l)))
  const order = loops.map((_, i) => i).sort((a, b) => areasAll[b] - areasAll[a])
  const minGap = stepoverMM * 0.2
  const kept: Pt2[][] = []
  for (const idx of order) {
    const cand = loops[idx]
    if (kept.every(k => setGap([cand], [k]) >= minGap)) kept.push(cand)
  }

  // Nest the survivors by containment: parent = the smallest-area placed (larger) loop
  // that contains this loop, by MAJORITY VOTE over sampled vertices — robust to both a
  // concave loop's centroid landing in a notch and a near-wall vertex landing just
  // outside its parent from grid noise. `kept` is largest-area first, so any container
  // is placed before its children.
  const keptAreas = kept.map(l => Math.abs(signedArea(l)))
  const nodes: LoopNode[] = kept.map(l => ({ loop: l, centroid: centroidOfRing(l), children: [] }))
  const roots: LoopNode[] = []
  for (let i = 0; i < nodes.length; i++) {
    let parent: LoopNode | null = null
    let parentArea = Infinity
    for (let j = 0; j < i; j++) {
      if (keptAreas[j] < parentArea && loopMostlyInside(kept[i], kept[j])) {
        parent = nodes[j]; parentArea = keptAreas[j]
      }
    }
    if (parent) parent.children.push(nodes[i])
    else roots.push(nodes[i])
  }

  // Belt-and-suspenders: merge any residual near-coincident sibling loops (same lobe)
  // so they don't each become a separate overlapping pass. Genuine lobes have
  // centroids far further apart than one stepover.
  dedupeForestBranches(roots, stepoverMM)

  // Decimate each chain so consecutive kept loops are ≤ one stepover apart.
  return forestToChains(roots)
    .filter(c => c.loopsOuterToInner.length > 0)
    .map(c => ({ loopsOuterToInner: decimateChain(c.loopsOuterToInner, stepoverMM), innerIsLeaf: c.innerIsLeaf }))
}

// Closest point on a closed ring's edges to (px,py).
type SpiralEntry = 'helix' | 'ramp' | 'travel'

interface FieldSpiralPlan {
  chains: { spiral: Pt2[]; entry: SpiralEntry; helixCenter: Pt2 }[]
  finishRings: Pt2[][]
}

// One-entry cache so the field is solved once per geometry, not once per Z level
// (generatePocket calls the strategy fn for every depth pass of a boundary).
let fieldPlanCache: { key: string; plan: FieldSpiralPlan | null } | null = null

function computeFieldSpiralPlan(boundary: Pt2[], islands: Pt2[][], tool: Tool, params: PocketParams): FieldSpiralPlan | null {
  const toolRadius = tool.diameterMM / 2
  const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
  const wantCCW = params.direction === 'climb' // inside cut: climb (M3) = CCW travel
  // Coarser chord on the spiral body keeps gcode size sane; sub-0.4 mm facets are
  // invisible on a roughing pass.
  const chordTol = Math.max(0.3, Math.min(0.6, tool.diameterMM * 0.07))

  // Geometry signature: bounding box + a coordinate checksum, so distinct
  // boundaries that happen to share a point count / first vertex don't collide.
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, sum = 0
  for (let i = 0; i < boundary.length; i++) {
    const [x, y] = boundary[i]
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y
    sum += x * (i + 1) + y * (i + 7)
  }
  for (const isl of islands) for (let i = 0; i < isl.length; i++) sum += isl[i][0] * (i + 3) - isl[i][1] * (i + 11)
  const key = [
    tool.diameterMM, params.stepoverPercent, params.direction, params.finishAllowanceMM ?? 0,
    boundary.length, islands.length,
    bx0.toFixed(3), by0.toFixed(3), bx1.toFixed(3), by1.toFixed(3), sum.toFixed(2),
  ].join('|')
  if (fieldPlanCache && fieldPlanCache.key === key) return fieldPlanCache.plan

  const plan = ((): FieldSpiralPlan | null => {
    const inset = insetRing(boundary, toolRadius)
    if (inset.length < 3) return null
    // Round join: the tool-centre path around a convex island corner is an arc of
    // the tool radius, not a sharp mitre — keeps the keep-out free of corners the
    // clamped spiral could chord across.
    const holes = growIslands(islands, toolRadius, JoinType.Round)
    const cell = Math.max(0.25, toolRadius / 4)
    const g = _timed('solveField', () => solveField([inset], holes, cell))
    if (g.tMax <= 0) return null

    // Isotherm loops → containment nesting → per-region chains (handles islands).
    const chains = _timed('buildIsothermChains', () => buildIsothermChains(g, inset, stepoverMM, wantCCW))
    if (chains.length === 0) return null
    const islandCentroids = islands.map(centroidOfRing)

    const out: { spiral: Pt2[]; entry: SpiralEntry; helixCenter: Pt2 }[] = []
    for (const chain of chains) {
      // A chain whose innermost loop encircles an island wraps a hole, not a point:
      // it must not centre-fill (its "centre" is the solid island) and it enters by
      // ramp (no helix at the island). The morph still spirals around the island.
      // As in spiralPocket: a C-shaped inner loop hugging an island defeats the
      // centroid-containment test while its OWN centroid sits inside the island, so
      // additionally require the seed point to lie in free space.
      const innerLoop = chain.loopsOuterToInner[chain.loopsOuterToInner.length - 1]
      const encirclesIsland = islandCentroids.some(c => pointInPolygon(c[0], c[1], innerLoop))
      const innerCentroidPre = centroidOfRing(innerLoop)
      const centroidFree =
        pointInPolygon(innerCentroidPre[0], innerCentroidPre[1], inset) &&
        !holes.some(hh => hh.length >= 3 && pointInPolygon(innerCentroidPre[0], innerCentroidPre[1], hh))
      const seedCenter = chain.innerIsLeaf && !encirclesIsland && centroidFree

      const innerToOuter = [...chain.loopsOuterToInner].reverse()
      // Localized transition (default fraction): stays on-contour most of each turn
      // so coverage holds even where consecutive isotherms differ in extent (arm
      // tips). The entry handles the worst-case entry engagement.
      const raw = _timed('morphChainToSpiral', () => morphChainToSpiral(innerToOuter, chordTol, stepoverMM, toolRadius, seedCenter))
      // Never let the tool centre enter an island or leave the inset wall; split out any
      // snap-flip chords the clamp left behind.
      const runs = _timed('clampSpiral', () => splitClampedSpiral(clampSpiralToRegion(raw, inset, holes)))
      // Helix at a true point centre; ramp everywhere else. A branch/saddle chain's
      // start is NOT inside its children's cleared lobes (the lobes are deeper in),
      // so a straight plunge there slots at full engagement — always ramp instead.
      // Bore concentric with the innermost loop so the helix meshes with the spiral —
      // but only when its centroid lies INSIDE the loop. A non-convex (L-shaped) loop's
      // centroid falls in a notch outside it; boring there would gouge the wall, so such
      // chains ramp in instead — and only the first run may helix.
      const helixCenter = centroidOfRing(innerLoop)
      const canHelix = seedCenter && pointInPolygon(helixCenter[0], helixCenter[1], innerLoop)
      for (let ri = 0; ri < runs.length; ri++) {
        out.push({ spiral: runs[ri], entry: ri === 0 && canHelix ? 'helix' : 'ramp', helixCenter })
      }
    }
    if (out.length === 0) return null
    // Finish the outer wall and each island wall. Compound inset (round joins, matching
    // this strategy's smooth style) so a near-wall island pinches instead of swinging
    // the tool through the outer wall; islands wound opposite for climb.
    const finishRings = _timed('compoundFinishRings', () => compoundFinishRings(boundary, islands, toolRadius, wantCCW, JoinType.Round))
    return { chains: out, finishRings }
  })()

  fieldPlanCache = { key, plan }
  return plan
}

export function fieldSpiralPocket(
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

  const plan = _timed('computeFieldSpiralPlan', () => computeFieldSpiralPlan(boundary, islands, tool, params))
  if (!plan) return incomingPos
  const { chains, finishRings } = plan

  const islandObstacles = islands.map(isl => growRing(isl, toolRadius)).filter(o => o.length >= 3)
  const obstacles = [...finishRings, ...islandObstacles]
  const travelObstacles = { edgeObstacles: obstacles, solidObstacles: islandObstacles }

  // Largest helix radius at `p` that keeps the bored circle clear of every wall and
  // island (finishRings are the tool-centre paths along them). 0 if there's no room.
  const safeHelixRadius = (p: Pt2) => maxClearHelixRadius(p, finishRings, toolRadius * 0.9)

  const rampIn = (start: Pt2, spiral: Pt2[], passPrevZ: number) => {
    if (lastPos !== null && !isTravelSafe(lastPos, start, travelObstacles)) {
      segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })
    }
    const { touchdown, sampleAt } = rampLeadIn(spiral, true, rampDist ?? 2 * tool.diameterMM)
    segs.push({ x: touchdown[0], y: touchdown[1], z: safeZ, rapid: true })
    segs.push({ x: touchdown[0], y: touchdown[1], z: passPrevZ, rapid: true })
    emitRampDescent(segs, sampleAt, passPrevZ, zDepth, 12)
  }

  let lastPos: Pt2 | null = incomingPos
  let cutAnything = false
  for (const { spiral, entry, helixCenter } of chains) {
    const start = spiral[0]
    const passPrevZ = cutAnything ? zDepth : prevZ
    // Bore concentric with the innermost loop so the helix meshes with the spiral.
    const hr = entry === 'helix' ? safeHelixRadius(helixCenter) : 0
    const helixOk = entry === 'helix' && hr >= 0.6
    let cutFrom = 1
    if (helixOk) {
      // Integrated helix entry: bores the centre and ends at the first uncut point,
      // already moving along the spiral — no straight connector, no redundant seed loop.
      if (lastPos !== null && !isTravelSafe(lastPos, start, travelObstacles)) {
        segs.push({ x: lastPos[0], y: lastPos[1], z: safeZ, rapid: true })
      }
      cutFrom = emitSpiralHelixEntry(spiral, helixCenter, hr, passPrevZ, zDepth, wantCCW, segs, safeZ)
    } else {
      // Ramp down along the spiral start — used for branch/island chains and for any
      // helix start with no room to bore (near a wall or island). Also ends at the
      // spiral start, flowing into it.
      rampIn(start, spiral, passPrevZ)
    }
    for (let i = cutFrom; i < spiral.length; i++) {
      segs.push({ x: spiral[i][0], y: spiral[i][1], z: zDepth, rapid: false })
    }
    lastPos = spiral[spiral.length - 1]
    cutAnything = true
  }
  if (!cutAnything) return incomingPos

  // Finish the wall with a contour pass on the inset boundary.
  return emitLinkedContourRings(finishRings, zDepth, travelObstacles, segs, params.startNear, rampDist, zDepth, safeZ, tool.diameterMM, lastPos)
}

