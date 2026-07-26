import {  signedArea, type Pt2 } from '../pathFlattener'
import { morphChainToSpiral } from '../spiralMorph'
import {  JoinType } from 'clipper2-ts'
import {   pointInPolygon } from '../geom'
import type { MotionSegment } from '../../store/toolpathStore'
import type { Tool } from '../../store/toolStore'
import { type PocketParams, type TravelSafetyObstacles, _timed, buildOffsetLevels, centroidOfRing, emitCutTransition, emitLinkedContourRings, emitRampDescent, emitSpiralHelixEntry, growIslands, growRing, isTravelSafe, rampLeadIn, setGap } from './shared'

// ─── Spiral (curvilinear) clearing ───────────────────────────────────────────────
//
// Builds a continuous curvilinear spiral from the same concentric offset levels
// the contour strategy cuts: the nested loops are organized into a containment
// forest, each non-branching chain is morphed into one smooth outward spiral
// (see spiralMorph.ts), and the outer wall is cleaned with a finishing contour.
// This is the offset-ring realization of Bieterman's curvilinear spiral — the
// morph of Leroy et al. 2024 seeded from Clipper offsets instead of isotherms.
//
// Phase 1 scope: single-boundary pockets without islands. The forest/chain code
// is general (a pocket that pinches into lobes yields multiple chains, linked by
// travel moves), but branch linking is a nearest-first heuristic, not yet the
// optimized peak-to-peak routing planned for Phase 2/3.

export interface LoopNode {
  loop: Pt2[]
  centroid: Pt2
  children: LoopNode[]
}

// Organize the offset levels into a forest by containment: a loop on level k is
// a child of the loop on level k-1 that contains its centroid. Roots are the
// outermost (level 0) loops.
function buildOffsetForest(levels: Pt2[][][]): LoopNode[] {
  const asNode = (loop: Pt2[]): LoopNode => ({ loop, centroid: centroidOfRing(loop), children: [] })
  let prev: LoopNode[] = levels[0].map(asNode)
  const roots = prev
  for (let k = 1; k < levels.length; k++) {
    const cur = levels[k].map(asNode)
    for (const node of cur) {
      // Find the parent on the previous level whose polygon contains this
      // loop's centroid. Fall back to the nearest-centroid parent if numeric
      // offset noise leaves the point just outside every candidate.
      let parent: LoopNode | null = null
      let bestDistSq = Infinity
      for (const cand of prev) {
        const d = (cand.centroid[0] - node.centroid[0]) ** 2 + (cand.centroid[1] - node.centroid[1]) ** 2
        if (pointInPolygon(node.centroid[0], node.centroid[1], cand.loop)) {
          if (d < bestDistSq) { bestDistSq = d; parent = cand }
        }
      }
      if (!parent) {
        for (const cand of prev) {
          const d = (cand.centroid[0] - node.centroid[0]) ** 2 + (cand.centroid[1] - node.centroid[1]) ** 2
          if (d < bestDistSq) { bestDistSq = d; parent = cand }
        }
      }
      if (parent) parent.children.push(node)
    }
    prev = cur
  }
  return roots
}

export interface SpiralChain {
  loopsOuterToInner: Pt2[][]
  // True when the chain's innermost loop is a real leaf (a single-lobe center),
  // so the spiral can seed a circular center fill there. False when the inner
  // end is a branch node (the lobes that split off it are separate chains that
  // clear that interior), in which case the spiral must not seed a center.
  innerIsLeaf: boolean
}

// Decompose the forest into chains. A chain is a maximal run of singly-nested
// loops (each node with exactly one child continues the chain); at a branch
// (>1 child) the chain ends and each child subtree starts a fresh chain. Chains
// are emitted in post-order — child (lobe) chains before their parent — so the
// deepest lobes are plunged first and we climb outward, linking by travel.
function subtreeSize(n: LoopNode): number {
  let s = 1
  for (const c of n.children) s += subtreeSize(c)
  return s
}

// Collapse spurious branches: when a node has several children whose loop centroids
// nearly coincide, they are the SAME lobe split apart by near-duplicate isotherm loops
// (marching-squares over-sampling), not genuinely separate lobes — which would have
// distinct centroids. Keep only the child with the largest subtree per centroid cluster;
// the dropped near-duplicates are covered by the kept chain + the wall finish. Without
// this a near-duplicate ring becomes its own pass (an extra contour overlapping the
// spiral). Recurses so the rule holds at every depth.
export function dedupeForestBranches(roots: LoopNode[], tol: number): void {
  const dedupe = (node: LoopNode) => {
    if (node.children.length > 1) {
      const kept: LoopNode[] = []
      for (const child of [...node.children].sort((a, b) => subtreeSize(b) - subtreeSize(a))) {
        if (kept.some(k => Math.hypot(k.centroid[0] - child.centroid[0], k.centroid[1] - child.centroid[1]) < tol)) continue
        kept.push(child)
      }
      node.children = kept
    }
    for (const c of node.children) dedupe(c)
  }
  for (const r of roots) dedupe(r)
}

export function forestToChains(roots: LoopNode[]): SpiralChain[] {
  const chains: SpiralChain[] = []
  const walk = (start: LoopNode) => {
    const loopsOuterToInner: Pt2[][] = []
    let innerIsLeaf = true
    let node: LoopNode | null = start
    while (node) {
      loopsOuterToInner.push(node.loop)
      if (node.children.length === 1) {
        node = node.children[0]
      } else {
        innerIsLeaf = node.children.length === 0
        for (const c of node.children) walk(c)   // children pushed before parent
        node = null
      }
    }
    chains.push({ loopsOuterToInner, innerIsLeaf })
  }
  for (const r of roots) walk(r)
  return chains
}

// Emit one chain's spiral: ramp/plunge at the spiral start (chain center) then
// cut the morphed polyline outward to the wall.
export function emitSpiralChain(
  spiral: Pt2[],
  zDepth: number,
  travelObstacles: TravelSafetyObstacles,
  segs: MotionSegment[],
  rampDistMM: number | undefined,
  prevZ: number,
  safeZ: number,
  toolDiameterMM: number,
  incomingPos: Pt2 | null,
  // Center-seeded chains may enter with an integrated helix bored CONCENTRIC with the
  // innermost loop (`center` = its centroid); `clearance(p)` is the largest safe bore
  // radius at p. Omitted for branch/island chains, which ramp/plunge instead.
  helix?: { clearance: (p: Pt2) => number; center: Pt2; wantCCW: boolean },
): Pt2 | null {
  if (spiral.length < 2) return incomingPos
  const start = spiral[0]
  const needsLift = incomingPos === null || !isTravelSafe(incomingPos, start, travelObstacles)

  if (needsLift && incomingPos !== null) {
    segs.push({ x: incomingPos[0], y: incomingPos[1], z: safeZ, rapid: true })
  }

  // Integrated helix entry concentric with the innermost loop (clears the middle, joins
  // the spiral tangentially). Falls through to the linear ramp when there's no room.
  const hr = helix ? helix.clearance(helix.center) : 0
  const helixOk = needsLift && helix !== undefined && hr >= 0.6

  // After a helix bore, skip the leading spiral points it already cleared and join at
  // the first uncut point — emitSpiralHelixEntry ends the bore right there.
  let cutFrom = 1
  if (helixOk) {
    cutFrom = emitSpiralHelixEntry(spiral, helix!.center, hr, prevZ, zDepth, helix!.wantCCW, segs, safeZ)
  } else if (needsLift && rampDistMM !== undefined) {
    // Ramp along the first rampDist of the spiral: position the tool that far in,
    // ramp backward to the spiral start descending to depth, then cut the whole
    // spiral forward (re-cutting the ramped section leaves a clean floor). This
    // keeps the ramp inside the path about to be cut, valid even in solid stock.
    const { touchdown, sampleAt } = rampLeadIn(spiral, true, rampDistMM)
    segs.push({ x: touchdown[0], y: touchdown[1], z: safeZ, rapid: true })
    segs.push({ x: touchdown[0], y: touchdown[1], z: prevZ, rapid: true })
    emitRampDescent(segs, sampleAt, prevZ, zDepth, 12)
  } else if (needsLift) {
    segs.push({ x: start[0], y: start[1], z: safeZ, rapid: true })
    segs.push({ x: start[0], y: start[1], z: zDepth, rapid: false })
  } else {
    emitCutTransition(segs, incomingPos!, start, zDepth, toolDiameterMM, safeZ)
  }

  for (let i = cutFrom; i < spiral.length; i++) {
    segs.push({ x: spiral[i][0], y: spiral[i][1], z: zDepth, rapid: false })
  }
  return spiral[spiral.length - 1]
}

export function spiralPocket(
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
  const chordTol = Math.max(0.1, Math.min(0.4, tool.diameterMM * 0.04))

  // Round joins so the spiral's corners are rounded (smooth), not mitred chamfers.
  const levels = _timed('buildOffsetLevels', () => buildOffsetLevels(boundary, islands, toolRadius, stepoverMM, wantCCW, JoinType.Round))
  if (levels.length === 0) return incomingPos

  const finishingLevel = levels[0]
  const islandObstacles = islands.map(isl => growRing(isl, toolRadius)).filter(o => o.length >= 3)
  const obstacles = [...finishingLevel, ...islandObstacles]
  const travelObstacles = { edgeObstacles: obstacles, solidObstacles: islandObstacles }

  // Island keep-outs: the outer boundary ring (largest loop of level 0) and the
  // grown islands (round join). Used to keep the spiral from seeding into / cutting
  // through an island, the same way the field spiral does.
  const insetBoundary = finishingLevel.reduce(
    (a, b) => (Math.abs(signedArea(b)) > Math.abs(signedArea(a)) ? b : a), finishingLevel[0])
  const holes = growIslands(islands, toolRadius, JoinType.Round)
  const islandCentroids = islands.map(centroidOfRing)

  // Helix keep-outs: the outer wall + grown island holes (tool-centre paths). Used by
  // center-seeded chains for the integrated helix entry.
  const helixRings = [insetBoundary, ...holes]
  const helixClearance = (p: Pt2) => maxClearHelixRadius(p, helixRings, toolRadius * 0.9)

  // Decompose into chains. forestToChains emits them in post-order (lobes before
  // their parent branch), so we plunge the deepest interior lobes first and climb
  // outward; each later chain links to the previous by travel move. Only leaf
  // chains (true single-lobe centers) seed a circular center spiral; branch
  // chains morph between their loops without one — their interior is cleared by
  // the lobe chains that split off them.
  const chains = _timed('forest+chains', () => forestToChains(buildOffsetForest(levels)))
    .filter(c => c.loopsOuterToInner.length > 0)

  let lastPos: Pt2 | null = incomingPos
  let cutAnything = false
  for (const chain of chains) {
    // A chain whose innermost loop encircles an island wraps a hole, not a point:
    // it must not centre-seed (its centre is the solid island). The centroid test
    // alone is not enough — a C-shaped inner loop hugging an island does NOT contain
    // the island's centroid, yet its OWN centroid can land inside the island; seeding
    // a circular centre fill there starts the spiral inside the island (and no clamp
    // can repair a path that dives through an island's middle). So additionally
    // require the seed point itself to sit in free space: inside the inset boundary
    // and outside every grown island.
    const innerLoop = chain.loopsOuterToInner[chain.loopsOuterToInner.length - 1]
    const encirclesIsland = islandCentroids.some(c => pointInPolygon(c[0], c[1], innerLoop))
    const innerCentroidPre = centroidOfRing(innerLoop)
    const centroidFree =
      pointInPolygon(innerCentroidPre[0], innerCentroidPre[1], insetBoundary) &&
      !holes.some(h => h.length >= 3 && pointInPolygon(innerCentroidPre[0], innerCentroidPre[1], h))
    const seedCenter = chain.innerIsLeaf && !encirclesIsland && centroidFree

    const innerToOuter = [...chain.loopsOuterToInner].reverse()
    // Full-revolution morph (transitionFrac = 1): the radius grows a constant ~one
    // stepover per turn, so there is no localized seam window — the offset rings blend
    // into one smooth uniform spiral with constant engagement. Unlike the field
    // spiral's isotherms, Clipper offset rings are uniformly spaced, so spreading the
    // step over the whole turn keeps coverage identical (verified) while removing the
    // per-revolution ripple a short window leaves.
    const raw = _timed('morphChainToSpiral', () => morphChainToSpiral(innerToOuter, chordTol, stepoverMM, toolRadius, seedCenter, 1))
    // Clamp so no point seeds/cuts into an island or past the wall, then split out any
    // snap-flip chords the clamp left behind.
    const runs = _timed('clampSpiral', () => splitClampedSpiral(clampSpiralToRegion(raw, insetBoundary, holes)))
    // Bore concentric with the innermost loop so it meshes with the offset rings — only
    // when its centroid is inside the loop (a non-convex loop's centroid lands outside it
    // and would gouge; those chains ramp in instead), and only for the first run.
    const innerCentroid = centroidOfRing(innerLoop)
    const canHelix = seedCenter && pointInPolygon(innerCentroid[0], innerCentroid[1], innerLoop)
    for (let ri = 0; ri < runs.length; ri++) {
      const spiral = runs[ri]
      const passPrevZ = cutAnything ? zDepth : prevZ
      const helixOpt = ri === 0 && canHelix
        ? { clearance: helixClearance, center: innerCentroid, wantCCW }
        : undefined
      lastPos = _timed('emitSpiralChain', () => emitSpiralChain(spiral, zDepth, travelObstacles, segs, rampDist, passPrevZ, safeZ, tool.diameterMM, lastPos, helixOpt))
      cutAnything = true
    }
  }

  if (!cutAnything) return incomingPos

  // Clean the outer wall with a finishing contour, as the contour strategy does.
  const finishPrevZ = zDepth
  return _timed('finishContour', () => emitLinkedContourRings(finishingLevel, zDepth, travelObstacles, segs, params.startNear, rampDist, finishPrevZ, safeZ, tool.diameterMM, lastPos))
}

export function nearestPointOnRing(px: number, py: number, ring: Pt2[]): Pt2 {
  let best: Pt2 = ring[0]
  let bestD = Infinity
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const l2 = dx * dx + dy * dy
    let t = l2 > 1e-12 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const qx = a[0] + t * dx, qy = a[1] + t * dy
    const d = (px - qx) ** 2 + (py - qy) ** 2
    if (d < bestD) { bestD = d; best = [qx, qy] }
  }
  return best
}

// Largest helix radius at `p` that keeps a bored circle clear of every keep-out ring
// (the tool-centre paths along walls/islands), capped at `maxR`. 0 (or negative) when
// there's no room. Shared by both spiral strategies' helix entries.
export function maxClearHelixRadius(p: Pt2, rings: Pt2[][], maxR: number): number {
  let r = maxR
  for (const ring of rings) {
    if (ring.length < 2) continue
    const np = nearestPointOnRing(p[0], p[1], ring)
    r = Math.min(r, Math.hypot(p[0] - np[0], p[1] - np[1]) - 0.1)
  }
  return r
}

// Clamp every spiral point into the cuttable region: a tool centre may never sit
// inside a grown island (would gouge the island) or outside the inset boundary
// (would over-cut the wall). Out-of-region points are snapped to the nearest
// boundary point, so the tool edge lands exactly on the real island/wall edge.
// Long segments are SUBDIVIDED first: clamping only the endpoints lets a chord
// between two legal points pass straight through an island (the morph emits such
// chords when consecutive rings differ around islands) — the subdivided samples
// snap onto the keep-out ring, so the path slides around the island instead.
export function clampSpiralToRegion(spiral: Pt2[], insetBoundary: Pt2[], grownIslands: Pt2[][]): Pt2[] {
  const MAX_SEG = 0.75
  // Where a grown island overlaps the inset boundary (island close to the wall) there is
  // NO legal tool position: island-snap pushes the point outside the pocket, wall-snap
  // pulls it back inside the island ring. Such points return null (dropped); the jump
  // splitter then severs the spiral on each side of the dead zone.
  const TOL = 0.05
  const clampPt = (x: number, y: number): Pt2 | null => {
    let px = x, py = y
    for (const gi of grownIslands) {
      if (gi.length >= 3 && pointInPolygon(px, py, gi)) {
        const n = nearestPointOnRing(px, py, gi)
        px = n[0]; py = n[1]
      }
    }
    if (insetBoundary.length >= 3 && !pointInPolygon(px, py, insetBoundary)) {
      const n = nearestPointOnRing(px, py, insetBoundary)
      px = n[0]; py = n[1]
      // re-validate: the wall snap may have moved the point back into an island ring
      for (const gi of grownIslands) {
        if (gi.length >= 3 && pointInPolygon(px, py, gi)) {
          const nn = nearestPointOnRing(px, py, gi)
          if (Math.hypot(px - nn[0], py - nn[1]) > TOL) return null
        }
      }
    }
    return [px, py]
  }
  const out: Pt2[] = []
  const push = (p: Pt2 | null) => {
    if (!p) return
    const last = out[out.length - 1]
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) out.push(p)
  }
  for (let i = 0; i < spiral.length; i++) {
    if (i > 0) {
      const [ax, ay] = spiral[i - 1]
      const [bx, by] = spiral[i]
      const n = Math.floor(Math.hypot(bx - ax, by - ay) / MAX_SEG)
      for (let k = 1; k <= n; k++) {
        const t = k / (n + 1)
        push(clampPt(ax + (bx - ax) * t, ay + (by - ay) * t))
      }
    }
    push(clampPt(spiral[i][0], spiral[i][1]))
  }
  return out
}

// Clamping can snap neighbouring (densified) samples to opposite sides of a keep-out,
// leaving a chord straight through an island. Legitimate steps are sub-millimetre after
// densification, so any far longer step is such an artifact: split the spiral there and
// keep each contiguous run; runs too short to cut anything are dropped (their crumb is
// swept by the finishing contour).
export function splitClampedSpiral(spiral: Pt2[]): Pt2[][] {
  // Legitimate densified steps are ≤ 0.75 mm; a chord ≤ JUMP across a convex keep-out
  // dips at most ~c²/8r ≈ 0.1 mm into it — below the cut tolerance.
  const JUMP = 1.5
  const runs: Pt2[][] = []
  let run: Pt2[] = []
  for (let i = 0; i < spiral.length; i++) {
    if (i > 0 && Math.hypot(spiral[i][0] - spiral[i - 1][0], spiral[i][1] - spiral[i - 1][1]) > JUMP) {
      if (run.length >= 5) runs.push(run)
      run = []
    }
    run.push(spiral[i])
  }
  if (run.length >= 5) runs.push(run)
  return runs
}

// Keep loops one stepover apart along a chain (ordered outer→inner): from each
// anchor, take the farthest-in loop still within a stepover, then repeat.
export function decimateChain(loops: Pt2[][], stepoverMM: number): Pt2[][] {
  if (loops.length <= 1) return loops
  const kept: Pt2[][] = [loops[0]]
  let anchor = 0, i = 1
  while (i < loops.length) {
    let lastGood = -1, j = i
    while (j < loops.length && setGap([loops[j]], [loops[anchor]]) <= stepoverMM) { lastGood = j; j++ }
    const pick = lastGood === -1 ? i : lastGood
    kept.push(loops[pick])
    anchor = pick
    i = pick + 1
  }
  if (kept[kept.length - 1] !== loops[loops.length - 1]) kept.push(loops[loops.length - 1])
  return kept
}

// How a chain's spiral is entered: 'helix' bores a hole at a point centre; 'ramp'
// descends along the path (island chains / first cut into solid); 'travel' drops
// straight in because the interior is already cleared (branch chains).
