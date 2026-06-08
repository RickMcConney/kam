// ClearedRaster — a 2D occupancy grid model of the cleared region for adaptive clearing.
//
// The cleared region is the tool (fixed radius) swept along the cut paths. Rather than maintaining
// a Clipper polygon (whose boolean/offset cost grows with the whole region — the superlinear
// blowup on large pockets), we rasterize: mark grid cells as the tool passes over them. Then the
// queries the engine needs are all O(local) cell scans, flat with total cleared size:
//
//   isCleared(p)        → one cell lookup
//   cutArea(c1,c2)      → count UNCUT cells in the tool sweep c1→c2 (read-only) = engagement
//   isClearPath(tp,rad) → any uncut cell within rad of the path ⇒ collision (distance-to-boundary)
//   mark(path)          → set cells under the tool sweep (commit a cut)
//   area()              → cut cell count × cell²
//
// Coordinates are in the engine's scaled integer space; cell is the scaled cell size (≈ a fraction
// of a mm). Cells outside the grid are treated as uncut (the grid covers the region + margin, so a
// sweep that leaves it is by definition heading into uncut stock / the wall).
//
// Validated against the Clipper polygon model by scripts/raster-area-check.mjs.

export interface XY { x: number; y: number }

export class ClearedRaster {
  private readonly grid: Uint8Array
  private readonly gw: number
  private readonly gh: number
  private readonly x0: number
  private readonly y0: number
  private readonly cell: number
  private readonly toolR: number
  private cutCellCount = 0

  /** Grid covers [minX,maxX]×[minY,maxY] (scaled units). toolR is the default sweep radius. */
  constructor(minX: number, minY: number, maxX: number, maxY: number, cell: number, toolR: number) {
    this.cell = cell > 0 ? cell : 1
    this.x0 = minX
    this.y0 = minY
    this.gw = Math.max(1, Math.ceil((maxX - minX) / this.cell))
    this.gh = Math.max(1, Math.ceil((maxY - minY) / this.cell))
    this.grid = new Uint8Array(this.gw * this.gh)
    this.toolR = toolR
  }

  get cutCells(): number { return this.cutCellCount }
  /** Total cut area in scaled units². */
  area(): number { return this.cutCellCount * this.cell * this.cell }

  /** Deep copy (same bounds/cell, copied occupancy). Used for the transient lead-path cleared. */
  clone(): ClearedRaster {
    const c = new ClearedRaster(this.x0, this.y0, this.x0 + this.gw * this.cell, this.y0 + this.gh * this.cell, this.cell, this.toolR)
    c.grid.set(this.grid)
    c.cutCellCount = this.cutCellCount
    return c
  }

  isCleared(x: number, y: number): boolean {
    const ix = Math.floor((x - this.x0) / this.cell)
    const iy = Math.floor((y - this.y0) / this.cell)
    if (ix < 0 || iy < 0 || ix >= this.gw || iy >= this.gh) return false
    return this.grid[iy * this.gw + ix] !== 0
  }

  /** Commit a cut: mark cells under the tool (radius toolR) swept along the polyline. */
  mark(path: ReadonlyArray<XY>): void {
    if (path.length === 0) return
    if (path.length === 1) { this.stampSeg(path[0].x, path[0].y, path[0].x, path[0].y, this.toolR, true) ; return }
    for (let i = 1; i < path.length; i++) this.stampSeg(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y, this.toolR, true)
  }

  /** Commit a disk (helix bore) of the given radius. */
  markStamp(cx: number, cy: number, radius: number): void { this.stampSeg(cx, cy, cx, cy, radius, true) }

  /**
   * Engagement of the move c1→c2 (read-only): area of the tool sweep that is currently UNCUT,
   * split into [total, conventional]. conventional = uncut area on the left of the travel
   * direction (cross(c2−c1, p−c1) > 0), matching the analytic CalcCutArea's rotated-frame
   * `xtest < c2.x` convention.
   */
  cutArea(c1: XY, c2: XY): [number, number] {
    const r = this.toolR, r2 = r * r
    const dx = c2.x - c1.x, dy = c2.y - c1.y
    const cellArea = this.cell * this.cell
    let total = 0, conventional = 0
    this.forEachCellNearSeg(c1.x, c1.y, c2.x, c2.y, r, (ix, iy, px, py) => {
      if (distSqPtSeg(px, py, c1.x, c1.y, c2.x, c2.y) > r2) return
      if (this.grid[iy * this.gw + ix] !== 0) return // already cut → no engagement
      total += cellArea
      if (dx * (py - c1.y) - dy * (px - c1.x) > 0) conventional += cellArea
    })
    return [total, conventional]
  }

  /**
   * Collision/clearance test: is every point within `rad` of the path already cut? (Equivalent to
   * IsClearPath: the tool of radius `rad` stays inside cleared.) Any uncut cell within `rad` —
   * including cells off the grid — means uncut stock is in the way, so not clear.
   */
  isClearPath(path: ReadonlyArray<XY>, rad: number): boolean {
    const segs = path.length === 1 ? [[path[0], path[0]] as const] : []
    if (segs.length === 0) for (let i = 1; i < path.length; i++) segs.push([path[i - 1], path[i]] as const)
    const r2 = rad * rad
    for (const [a, b] of segs) {
      // off-grid portion of the tube ⇒ uncut stock ⇒ not clear
      if (this.segTubeLeavesGrid(a.x, a.y, b.x, b.y, rad)) return false
      let clear = true
      this.forEachCellNearSeg(a.x, a.y, b.x, b.y, rad, (ix, iy, px, py) => {
        if (!clear) return
        if (distSqPtSeg(px, py, a.x, a.y, b.x, b.y) > r2) return
        if (this.grid[iy * this.gw + ix] === 0) clear = false
      })
      if (!clear) return false
    }
    return true
  }

  // ── internals ────────────────────────────────────────────────────────────
  private stampSeg(ax: number, ay: number, bx: number, by: number, r: number, commit: boolean): void {
    const r2 = r * r
    this.forEachCellNearSeg(ax, ay, bx, by, r, (ix, iy, px, py) => {
      if (distSqPtSeg(px, py, ax, ay, bx, by) > r2) return
      const idx = iy * this.gw + ix
      if (commit && this.grid[idx] === 0) { this.grid[idx] = 1; this.cutCellCount++ }
    })
  }

  // visit every in-grid cell whose center could be within r of segment [a,b]
  private forEachCellNearSeg(ax: number, ay: number, bx: number, by: number, r: number,
    fn: (ix: number, iy: number, px: number, py: number) => void): void {
    const minX = Math.min(ax, bx) - r, maxX = Math.max(ax, bx) + r
    const minY = Math.min(ay, by) - r, maxY = Math.max(ay, by) + r
    const ix0 = Math.max(0, Math.floor((minX - this.x0) / this.cell))
    const ix1 = Math.min(this.gw - 1, Math.floor((maxX - this.x0) / this.cell))
    const iy0 = Math.max(0, Math.floor((minY - this.y0) / this.cell))
    const iy1 = Math.min(this.gh - 1, Math.floor((maxY - this.y0) / this.cell))
    for (let iy = iy0; iy <= iy1; iy++) {
      const py = this.y0 + (iy + 0.5) * this.cell
      for (let ix = ix0; ix <= ix1; ix++) {
        const px = this.x0 + (ix + 0.5) * this.cell
        fn(ix, iy, px, py)
      }
    }
  }

  // does the radius-r tube around [a,b] extend beyond the grid bounds?
  private segTubeLeavesGrid(ax: number, ay: number, bx: number, by: number, r: number): boolean {
    return Math.min(ax, bx) - r < this.x0 || Math.max(ax, bx) + r > this.x0 + this.gw * this.cell
      || Math.min(ay, by) - r < this.y0 || Math.max(ay, by) + r > this.y0 + this.gh * this.cell
  }
}

export function distSqPtSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1
  const l2 = dx * dx + dy * dy
  if (l2 === 0) { const ex = px - x1, ey = py - y1; return ex * ex + ey * ey }
  let t = ((px - x1) * dx + (py - y1) * dy) / l2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const ex = px - (x1 + t * dx), ey = py - (y1 + t * dy)
  return ex * ex + ey * ey
}
