import { type Pt2 } from '../pathFlattener'
import { pointInPolygon } from '../geom'
import { setGap } from './shared'

// ─── Spiral geometry: loop forest, chains, region clamping ───────────────────────
//
// Shared machinery for turning a set of nested loops into continuous outward spirals:
// the containment forest and its non-branching chains, and the clamping that keeps a
// morphed spiral off the walls and islands (see spiralMorph.ts for the morph itself).
//
// The offset-ring 'spiral' pocket strategy that used to live here was dropped in
// 2026-07 — it left stock even at 50% stepover and 'morph' covers the same ground.
// fieldSpiral.ts (the 'morph' strategy) builds its forest from Poisson isotherms and
// uses everything below.

export interface LoopNode {
  loop: Pt2[]
  centroid: Pt2
  children: LoopNode[]
}

export interface SpiralChain {
  loopsOuterToInner: Pt2[][]
  // True when the chain's innermost loop is a real leaf (a single-lobe center),
  // so the spiral can seed a circular center fill there. False when the inner
  // end is a branch node (the lobes that split off it are separate chains that
  // clear that interior), in which case the spiral must not seed a center.
  innerIsLeaf: boolean
}

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
