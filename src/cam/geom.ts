// Shared CAM geometry helpers. Canonical home for utilities that were once
// duplicated across the per-operation modules (see tofix.md R2). Note:
// adaptiveClearing.ts is deliberately excluded from this consolidation — it is
// a faithful FreeCAD port and must stay byte-for-byte comparable (tofix.md H6).

import { signedArea, sharesVertex, type Pt2 } from './pathFlattener'

// Z levels for multi-pass cutting: -step, -2·step, … then exactly -depth.
// Step is clamped to the UI's 0.01 mm minimum so a zero/negative/NaN value
// (hand-edited or corrupted .fkam project) can't loop forever or allocate
// unboundedly (tofix.md B7).
//
// The loop bound carries an epsilon because repeated `z -= step` accumulates
// float error: for e.g. depth 0.8 / step 0.1 the last iteration lands on
// -0.7999999999999999, which is > -0.8, so the loop pushed it AND the final
// push added -0.8 — two full cutting passes at the same depth (rubbing at
// zero chip load). 1e-9 mm is far below any machine's resolution, so it can
// only ever collapse a duplicate, never drop a real pass.
//
// `startZMM` is the surface the cut begins from — 0 at stock top, negative when the
// operation starts on the floor left by an earlier one (engraving into a pocket). Depth
// is always measured FROM that surface, so the levels shift down with it and every
// depth field keeps meaning what it says.
export function zPasses(depthMM: number, stepDownMM: number, startZMM = 0): number[] {
  const step = Math.max(0.01, Number.isFinite(stepDownMM) ? Math.abs(stepDownMM) : 0)
  const depth = Number.isFinite(depthMM) ? Math.abs(depthMM) : 0
  const passes: number[] = []
  let z = -step
  while (z > -depth + 1e-9) { passes.push(z); z -= step }
  passes.push(-depth)
  const start = Number.isFinite(startZMM) ? Math.min(0, startZMM) : 0
  return start === 0 ? passes : passes.map((p) => start + p)
}

// Ray-cast point-in-polygon (even-odd rule). Polygon may be open or closed —
// the i/j indexing treats it as implicitly closed either way.
export function pointInPolygon(px: number, py: number, poly: Pt2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1]
    const xj = poly[j][0], yj = poly[j][1]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// Cumulative arc length at each vertex of a polyline, plus the total.
export function arcLengths(pts: Pt2[]): { lens: number[]; total: number } {
  const lens: number[] = [0]
  for (let i = 1; i < pts.length; i++) {
    lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  }
  return { lens, total: lens[lens.length - 1] }
}

// Interpolate a point at arc-length s along a polyline.
export function interpPt(pts: Pt2[], lens: number[], s: number): Pt2 {
  s = Math.max(0, Math.min(lens[lens.length - 1], s))
  for (let i = 1; i < pts.length; i++) {
    if (lens[i] >= s - 1e-10) {
      const t = (lens[i] - lens[i - 1]) > 1e-10 ? (s - lens[i - 1]) / (lens[i] - lens[i - 1]) : 0
      return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])]
    }
  }
  return [pts[pts.length - 1][0], pts[pts.length - 1][1]]
}

// Drop a duplicated closing vertex (last == first within epsilon).
export function stripClosingDuplicate(pts: Pt2[]): Pt2[] {
  if (pts.length > 1 && Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) < 1e-6) {
    return pts.slice(0, -1)
  }
  return pts
}

// ─── Containment classifier ───────────────────────────────────────────────────
// Groups a flat list of rings into {outer, holes} regions by containment. Lives
// here (not in vcarve.ts, where it started) because pocket.ts needs it too and
// must not pull in vcarve's JSPoly medial-axis code.

export interface Region { outer: Pt2[]; holes: Pt2[][] }

export function centroidX(pts: Pt2[]): number { return pts.reduce((s, p) => s + p[0], 0) / pts.length }
export function centroidY(pts: Pt2[]): number { return pts.reduce((s, p) => s + p[1], 0) / pts.length }

// Largest ring first, so a ring is claimed by the biggest thing containing it and
// each ring is claimed at most once (a hole is never also an outer).
// `preserveOrder` returns the regions in the order their outers appeared in the
// input instead of by descending area — pocket wants that so cut order (and the
// travel between glyphs of a text path) stays the subpath order of the source.
export function classifySubpaths(subpaths: Pt2[][], opts: { preserveOrder?: boolean } = {}): Region[] {
  const byArea = subpaths.map((_, i) => i)
    .sort((a, b) => Math.abs(signedArea(subpaths[b])) - Math.abs(signedArea(subpaths[a])))
  const usedAsHole = new Set<number>()
  const found: { idx: number; region: Region }[] = []

  for (let i = 0; i < byArea.length; i++) {
    const oi = byArea[i]
    if (usedAsHole.has(oi)) continue
    const outer = subpaths[oi]
    const holes: Pt2[][] = []

    for (let j = i + 1; j < byArea.length; j++) {
      const ci = byArea[j]
      if (usedAsHole.has(ci)) continue
      const candidate = subpaths[ci]
      // Loops touching at a vertex are siblings (e.g. letter K arms), not holes.
      if (!sharesVertex(candidate, outer) && pointInPolygon(centroidX(candidate), centroidY(candidate), outer)) {
        holes.push(candidate)
        usedAsHole.add(ci)
      }
    }

    found.push({ idx: oi, region: { outer, holes } })
  }

  if (opts.preserveOrder) found.sort((a, b) => a.idx - b.idx)
  return found.map(f => f.region)
}

// Squared distance from point (px,py) to segment (ax,ay)-(bx,by).
export function ptSegDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax, aby = by - ay
  const len2 = abx * abx + aby * aby
  if (len2 === 0) return (px - ax) ** 2 + (py - ay) ** 2
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2))
  return (px - ax - t * abx) ** 2 + (py - ay - t * aby) ** 2
}
