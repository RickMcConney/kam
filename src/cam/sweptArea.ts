// SweptArea — an implicit model of the cleared region for adaptive clearing.
//
// The cleared region is never an arbitrary polygon: it is always the tool (a fixed-radius disk)
// swept along the cut paths, i.e. the Minkowski sum  cleared = cutPaths ⊕ disk(R).  So instead of
// accumulating a Clipper polygon (whose boolean/offset cost grows with the whole cleared region —
// the superlinear blowup on large pockets), we store the cut *segments* in a uniform grid and
// answer every cleared query as a local distance-to-path test:
//
//   p cleared        ⟺  dist(p, cutPaths) ≤ R
//   p ≥ d deep inside ⟺  dist(p, cutPaths) ≤ R − d
//
// With per-element radius this generalizes to depth(p) = max(radius − dist(p, element)); a helix
// bore is just a zero-length segment with radius (helixR + R). cleared = depth ≥ 0, eroded(d) =
// depth ≥ d. (The depth/eroded form is the exact erosion away from concave self-junctions of the
// path, where it is mildly conservative — sub-tolerance, and validated against Clipper by
// scripts/swept-area-check.mjs.)
//
// Indexing: each segment is registered in every grid cell its (bbox expanded by radius) overlaps.
// Then any query point within `radius` of the segment necessarily falls in one of those cells, so
// a query inspects ONLY the cell containing the point — no neighbour search. Cost is O(local path
// density), independent of total cleared size. That is the whole point.

export interface XY { x: number; y: number }

// Flat segment record layout in `seg`: [x1, y1, x2, y2, radius] per segment.
const STRIDE = 5

export class SweptArea {
  private readonly cell: number
  private seg: number[] = []                 // flat [x1,y1,x2,y2,r] × n
  private grid = new Map<number, number[]>() // cell key → list of segment base offsets
  private maxRadius = 0

  // cellSize ≈ tool radius is a good default: small enough that few segments share a cell, large
  // enough that short tool steps register in only a handful of cells.
  constructor(cellSize: number) { this.cell = Math.max(1, Math.floor(cellSize)) }

  clear(): void { this.seg.length = 0; this.grid.clear(); this.maxRadius = 0 }

  get segmentCount(): number { return this.seg.length / STRIDE }

  /** Add the tool (radius r) swept along a polyline (consecutive points → segments). */
  addSegmentPath(path: ReadonlyArray<XY>, r: number): void {
    if (path.length === 1) { this.addStamp(path[0].x, path[0].y, r); return }
    for (let i = 1; i < path.length; i++) this.addSegment(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y, r)
  }

  /** Add a single disk (e.g. a helix bore) as a zero-length segment of radius r. */
  addStamp(cx: number, cy: number, r: number): void { this.addSegment(cx, cy, cx, cy, r) }

  addSegment(x1: number, y1: number, x2: number, y2: number, r: number): void {
    if (r <= 0) return
    const base = this.seg.length
    this.seg.push(x1, y1, x2, y2, r)
    if (r > this.maxRadius) this.maxRadius = r
    const minX = Math.min(x1, x2) - r, maxX = Math.max(x1, x2) + r
    const minY = Math.min(y1, y2) - r, maxY = Math.max(y1, y2) + r
    const cx0 = Math.floor(minX / this.cell), cx1 = Math.floor(maxX / this.cell)
    const cy0 = Math.floor(minY / this.cell), cy1 = Math.floor(maxY / this.cell)
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const k = this.cellKey(cx, cy)
        let arr = this.grid.get(k)
        if (!arr) this.grid.set(k, arr = [])
        arr.push(base)
      }
    }
  }

  /**
   * Unique cut elements (segments/stamps) overlapping a query box, as a flat array
   * [x1,y1,x2,y2,r, …]. Lets a caller regenerate the *local* cleared polygon (offset each element
   * by its radius, union) in O(local) instead of touching the whole cleared region — needed for
   * collision/clearance queries that depend on distance to the cleared boundary (which can exceed
   * R in overlapping regions and so cannot be answered by depth() alone).
   */
  elementsInBox(minX: number, minY: number, maxX: number, maxY: number): number[] {
    const cx0 = Math.floor(minX / this.cell), cx1 = Math.floor(maxX / this.cell)
    const cy0 = Math.floor(minY / this.cell), cy1 = Math.floor(maxY / this.cell)
    const seen = new Set<number>()
    const out: number[] = []
    const seg = this.seg
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const arr = this.grid.get(this.cellKey(cx, cy))
        if (!arr) continue
        for (let i = 0; i < arr.length; i++) {
          const b = arr[i]
          if (seen.has(b)) continue
          seen.add(b)
          out.push(seg[b], seg[b + 1], seg[b + 2], seg[b + 3], seg[b + 4])
        }
      }
    }
    return out
  }

  /** Signed clearance depth at (x,y): max over elements of (radius − distance). ≥0 ⇒ inside. */
  depth(x: number, y: number): number {
    const arr = this.grid.get(this.cellKey(Math.floor(x / this.cell), Math.floor(y / this.cell)))
    if (!arr) return -Infinity
    const seg = this.seg
    let best = -Infinity
    for (let i = 0; i < arr.length; i++) {
      const b = arr[i]
      const d = seg[b + 4] - Math.sqrt(distSqPtSeg(x, y, seg[b], seg[b + 1], seg[b + 2], seg[b + 3]))
      if (d > best) best = d
    }
    return best
  }

  /** Is (x,y) within the cleared region (within R of some cut segment)? */
  isCleared(x: number, y: number): boolean { return this.depth(x, y) >= 0 }

  /** Is (x,y) at least `d` deep inside the cleared region? (erosion test) */
  isEroded(x: number, y: number, d: number): boolean { return this.depth(x, y) >= d }

  // Cell key: pack signed cell coords into one number. Cell indices comfortably fit a 21-bit
  // half-range for any realistic scaled pocket, so this avoids string-key allocation per query.
  private cellKey(cx: number, cy: number): number {
    return (cx + 0x100000) * 0x200000 + (cy + 0x100000)
  }
}

// Squared distance from point (px,py) to segment (x1,y1)-(x2,y2). Handles zero-length (a stamp).
export function distSqPtSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1
  const l2 = dx * dx + dy * dy
  if (l2 === 0) { const ex = px - x1, ey = py - y1; return ex * ex + ey * ey }
  let t = ((px - x1) * dx + (py - y1) * dy) / l2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const ex = px - (x1 + t * dx), ey = py - (y1 + t * dy)
  return ex * ex + ey * ey
}
