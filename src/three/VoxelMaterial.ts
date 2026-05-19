import type { SimSegment } from '../sim/gcodeParser'

export interface VoxelLeaf {
  readonly x0: number; readonly y0: number
  readonly x1: number; readonly y1: number
  readonly cx: number; readonly cy: number
  readonly cw: number; readonly ch: number
  readonly instanceIdx: number
  height: number
  dirty: boolean
}

// ax, ay, bx, by, r — segment endpoints in world mm + tool radius
type Seg5 = [number, number, number, number, number]

// ── quadtree builder ─────────────────────────────────────────────────────────
//
// Each recursive call receives only the segments that overlap the current cell,
// so work at each level is O(local_segs) rather than O(all_segs). This
// turns the O(nodes × all_segs) complexity into O(segs × log(area/cell)).
//
// Uses a 3-axis SAT capsule-vs-AABB test (X, Y, segment-perpendicular) instead
// of a simple bbox test. For diagonal segments this rejects the large "corner"
// regions that a bbox would falsely include, dramatically reducing voxel count
// for shapes like hexagons with sloped sides.

function capsuleOverlapsAABB(
  ax: number, ay: number, bx: number, by: number, r: number,
  x0: number, y0: number, x1: number, y1: number,
): boolean {
  // Axis 1 & 2: capsule bbox vs cell bbox
  if (Math.max(ax, bx) + r <= x0 || Math.min(ax, bx) - r >= x1) return false
  if (Math.max(ay, by) + r <= y0 || Math.min(ay, by) - r >= y1) return false
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-8) return true  // point tool — bbox test above is sufficient
  // Axis 3: perpendicular to the segment direction (unnormalised normal = (-dy, dx))
  // The capsule projects to [C − r·|n|, C + r·|n|]; the AABB projects to [min, max]
  // of its four corners.  A gap on this axis means the AABB is "off to the side"
  // of the segment and outside the capsule's rectangular body.
  const C = -dy * ax + dx * ay
  const rN = r * Math.sqrt(lenSq)
  const p00 = -dy * x0 + dx * y0, p10 = -dy * x1 + dx * y0
  const p01 = -dy * x0 + dx * y1, p11 = -dy * x1 + dx * y1
  const aabbMinP = Math.min(p00, p10, p01, p11)
  const aabbMaxP = Math.max(p00, p10, p01, p11)
  return C + rN > aabbMinP && C - rN < aabbMaxP
}

function subdivide(
  x0: number, y0: number, x1: number, y1: number,
  segs: Seg5[],
  minCellMM: number,
  T: number,
  out: VoxelLeaf[],
) {
  const w = x1 - x0, h = y1 - y0
  if (segs.length === 0 || (w <= minCellMM * 1.5 && h <= minCellMM * 1.5)) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
    out.push({ x0, y0, x1, y1, cx, cy, cw: w, ch: h, height: T, dirty: false, instanceIdx: out.length })
    return
  }
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2
  const q00: Seg5[] = [], q10: Seg5[] = [], q01: Seg5[] = [], q11: Seg5[] = []
  for (const s of segs) {
    if (capsuleOverlapsAABB(s[0], s[1], s[2], s[3], s[4], x0, y0, mx, my)) q00.push(s)
    if (capsuleOverlapsAABB(s[0], s[1], s[2], s[3], s[4], mx, y0, x1, my)) q10.push(s)
    if (capsuleOverlapsAABB(s[0], s[1], s[2], s[3], s[4], x0, my, mx, y1)) q01.push(s)
    if (capsuleOverlapsAABB(s[0], s[1], s[2], s[3], s[4], mx, my, x1, y1)) q11.push(s)
  }
  subdivide(x0, y0, mx, my, q00, minCellMM, T, out)
  subdivide(mx, y0, x1, my, q10, minCellMM, T, out)
  subdivide(x0, my, mx, y1, q01, minCellMM, T, out)
  subdivide(mx, my, x1, y1, q11, minCellMM, T, out)
}

function isCuttingSeg(seg: SimSegment): boolean {
  return !seg.rapid && (seg.prevZ < 0 || seg.z < 0)
}

function segMaxRadius(seg: SimSegment): number {
  const vbitTan = seg.toolVbitHalfAngleTan
  if (vbitTan) return Math.max(Math.abs(seg.prevZ), Math.abs(seg.z)) * vbitTan
  return seg.toolDiameterMM / 2
}

function buildLeaves(
  W: number, H: number, T: number,
  segments: SimSegment[],
  orgX: number, orgY: number,
  minCellMM: number,
): VoxelLeaf[] {
  const segs: Seg5[] = []
  for (const seg of segments) {
    if (!isCuttingSeg(seg)) continue
    const ax = seg.prevX + orgX, ay = seg.prevY + orgY
    const bx = seg.x + orgX,    by = seg.y + orgY
    const r = segMaxRadius(seg)
    // Discard segments whose capsule bbox is entirely outside the workpiece
    if (Math.max(ax, bx) + r > 0 && Math.min(ax, bx) - r < W &&
        Math.max(ay, by) + r > 0 && Math.min(ay, by) - r < H) {
      segs.push([ax, ay, bx, by, r])
    }
  }
  const leaves: VoxelLeaf[] = []
  subdivide(0, 0, W, H, segs, minCellMM, T, leaves)
  return leaves
}

// ── spatial grid ─────────────────────────────────────────────────────────────

const GRID_COLS = 64
const GRID_ROWS = 64

function buildGrid(leaves: VoxelLeaf[], W: number, H: number): Int32Array[] {
  const cw = W / GRID_COLS, ch = H / GRID_ROWS
  const buckets: number[][] = Array.from({ length: GRID_COLS * GRID_ROWS }, () => [])
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i]
    const c0 = Math.max(0, Math.floor(leaf.x0 / cw))
    const c1 = Math.min(GRID_COLS - 1, Math.floor(leaf.x1 / cw))
    const r0 = Math.max(0, Math.floor(leaf.y0 / ch))
    const r1 = Math.min(GRID_ROWS - 1, Math.floor(leaf.y1 / ch))
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        buckets[row * GRID_COLS + col].push(i)
      }
    }
  }
  return buckets.map(b => new Int32Array(b))
}

// ── main class ───────────────────────────────────────────────────────────────

const MAX_VOXELS = 500_000

export class VoxelMaterial {
  readonly leaves: VoxelLeaf[]
  readonly thicknessMM: number
  readonly orgX: number
  readonly orgY: number
  readonly effectiveCellMM: number

  private readonly _W: number
  private readonly _H: number
  private readonly _grid: Int32Array[]
  private readonly _dedup: Uint32Array
  private _gen = 1

  private _lastFullIdx   = -1
  private _lastPartialIdx = -1
  private _lastPartialT   = 0
  anyCarved = false

  constructor(
    W: number, H: number, T: number,
    segments: SimSegment[],
    orgX: number, orgY: number,
    minCellMM = 2,
  ) {
    this.thicknessMM = T
    this.orgX = orgX
    this.orgY = orgY
    this._W = W
    this._H = H

    // Use capsule area (segLen × 2r) rather than bbox area — bbox is wildly
    // conservative for diagonal/overlapping passes and causes the budget formula
    // to pick a cell size much coarser than the 2M-voxel limit actually requires.
    let totalCutArea = 0
    for (const seg of segments) {
      if (!isCuttingSeg(seg)) continue
      const r = segMaxRadius(seg)
      const segLen = Math.hypot(seg.x - seg.prevX, seg.y - seg.prevY)
      totalCutArea += (segLen + 2 * r) * (2 * r)
    }
    const effectiveArea = totalCutArea > 0 ? Math.min(totalCutArea, W * H) : W * H

    let cellMM = Math.max(minCellMM, Math.sqrt(effectiveArea / MAX_VOXELS))

    // Build a first pass at the budget-formula cell size, then use the real
    // voxel count to check whether we can afford minCellMM.  The area formula
    // typically overestimates for sparse paths, so the first pass usually has
    // far fewer voxels than MAX_VOXELS.
    let leaves = buildLeaves(W, H, T, segments, orgX, orgY, cellMM)
    if (cellMM > minCellMM) {
      // Estimate count at minCellMM; if it fits go there, else find finest that does.
      const ratio = cellMM / minCellMM
      const estimatedAtMin = leaves.length * ratio * ratio
      const targetCell = Math.max(minCellMM,
        estimatedAtMin <= MAX_VOXELS
          ? minCellMM
          : cellMM * Math.sqrt(leaves.length / MAX_VOXELS)
      )
      if (targetCell < cellMM - 1e-6) {
        console.log(`[VoxelMaterial] refining ${cellMM.toFixed(3)} → ${targetCell.toFixed(3)} mm`)
        cellMM = targetCell
        leaves = buildLeaves(W, H, T, segments, orgX, orgY, cellMM)
        // Quadratic estimate can underestimate; correct with real count if we overshot.
        if (leaves.length > MAX_VOXELS) {
          const correctedCell = Math.max(minCellMM, cellMM * Math.sqrt(leaves.length / MAX_VOXELS))
          console.log(`[VoxelMaterial] correcting ${cellMM.toFixed(3)} → ${correctedCell.toFixed(3)} mm (actual ${leaves.length.toLocaleString()} over budget)`)
          cellMM = correctedCell
          leaves = buildLeaves(W, H, T, segments, orgX, orgY, cellMM)
        }
      }
    }

    this.effectiveCellMM = cellMM
    this.leaves = leaves
    console.log(`[VoxelMaterial] ${this.leaves.length.toLocaleString()} voxels, cell size ${cellMM.toFixed(3)} mm`)

    this._grid  = buildGrid(this.leaves, W, H)
    this._dedup = new Uint32Array(this.leaves.length)
  }

  reset() {
    for (const leaf of this.leaves) {
      leaf.height = this.thicknessMM
      leaf.dirty  = true
    }
    this._lastFullIdx    = -1
    this._lastPartialIdx = -1
    this._lastPartialT   = 0
    this.anyCarved       = false
  }

  applyUpTo(segments: SimSegment[], segIdx: number, t: number): boolean {
    if (segments.length === 0) return false

    const goingBack = segIdx < this._lastPartialIdx ||
      (segIdx === this._lastPartialIdx && t < this._lastPartialT - 1e-6)
    let didReset = false
    if (goingBack) { this.reset(); didReset = true }

    let carved = false

    for (let i = this._lastFullIdx + 1; i < segIdx && i < segments.length; i++) {
      const s = segments[i]
      if (isCuttingSeg(s)) {
        this._carveFromTo(s.prevX, s.prevY, s.x, s.y, s.prevZ, s.z, s.toolVbitHalfAngleTan, s.toolBallNose, s.toolDiameterMM)
        carved = true
      }
    }
    this._lastFullIdx = segIdx - 1

    const seg = segIdx < segments.length ? segments[segIdx] : null
    if (seg && isCuttingSeg(seg)) {
      const startT = segIdx === this._lastPartialIdx ? this._lastPartialT : 0
      if (t > startT + 1e-6) {
        const x0 = seg.prevX + (seg.x - seg.prevX) * startT
        const y0 = seg.prevY + (seg.y - seg.prevY) * startT
        const x1 = seg.prevX + (seg.x - seg.prevX) * t
        const y1 = seg.prevY + (seg.y - seg.prevY) * t
        const pz0 = seg.prevZ + (seg.z - seg.prevZ) * startT
        const pz1 = seg.prevZ + (seg.z - seg.prevZ) * t
        this._carveFromTo(x0, y0, x1, y1, pz0, pz1, seg.toolVbitHalfAngleTan, seg.toolBallNose, seg.toolDiameterMM)
        carved = true
      }
    }
    this._lastPartialIdx = segIdx
    this._lastPartialT   = t

    return carved || didReset
  }

  private _carveFromTo(
    ax: number, ay: number, bx: number, by: number,
    prevZ: number, endZ: number,
    vbitTan?: number,
    ballNose?: boolean,
    toolDiameterMM = 0,
  ) {
    const dz = endZ - prevZ
    const r = vbitTan
      ? Math.max(Math.abs(prevZ), Math.abs(endZ)) * vbitTan
      : toolDiameterMM / 2

    // Deepest achievable height for early-exit: at the tip (d=0) and deepest Z.
    const flatH = Math.max(0, this.thicknessMM + Math.min(prevZ, endZ))

    ax += this.orgX; ay += this.orgY
    bx += this.orgX; by += this.orgY
    const dx = bx - ax, dy = by - ay
    const lenSq = dx * dx + dy * dy

    let gen = (this._gen + 1) >>> 0
    if (gen === 0) { this._dedup.fill(0); gen = 1 }
    this._gen = gen

    const cw = this._W / GRID_COLS, ch = this._H / GRID_ROWS
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - r) / cw))
    const c1 = Math.min(GRID_COLS - 1, Math.floor((Math.max(ax, bx) + r) / cw))
    const r0 = Math.max(0, Math.floor((Math.min(ay, by) - r) / ch))
    const r1 = Math.min(GRID_ROWS - 1, Math.floor((Math.max(ay, by) + r) / ch))

    const { _grid: grid, _dedup: dedup, leaves } = this

    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const cell = grid[row * GRID_COLS + col]
        for (let k = 0; k < cell.length; k++) {
          const idx = cell[k]
          if (dedup[idx] === gen) continue
          dedup[idx] = gen

          const leaf = leaves[idx]
          if (leaf.height <= flatH) continue

          // Closest point on the 2D segment to the leaf centre.
          const ex = leaf.cx - ax, ey = leaf.cy - ay
          const proj = ex * dx + ey * dy
          const tc_raw = lenSq < 1e-8 ? 0 : proj / lenSq
          // perp_sq = d(tc_raw)² = dist0² - proj²/lenSq (squared perp distance at unclamped tc)
          const dist0sq = ex * ex + ey * ey
          const perp_sq = Math.max(0, dist0sq - tc_raw * proj)

          let newH: number

          if (vbitTan) {
            // V-bit cone: height carved at voxel = thicknessMM + Z(t) + d(t)/tan
            // Minimise over t ∈ [0,1]:  f(t) = Z(t) + d(t)/tan
            //   d(t)² = (t − tc_raw)² · lenSq + perp_sq
            // Interior critical point (when lenSq > dz²·tan²):
            //   t_opt = tc_raw − dz·tan·√perp_sq / √(lenSq·(lenSq − dz²·tan²))
            const evalF = (tRaw: number): number => {
              const t = Math.max(0, Math.min(1, tRaw))
              const dt = t - tc_raw
              return (prevZ + t * dz) + Math.sqrt(dt * dt * lenSq + perp_sq) / vbitTan
            }

            // Evaluate at both endpoints and the clamped closest point.
            let fMin = Math.min(evalF(0), evalF(1), evalF(Math.max(0, Math.min(1, tc_raw))))

            // Add the analytical interior minimum when it exists.
            const discrim = lenSq * (lenSq - dz * dz * vbitTan * vbitTan)
            if (discrim > 1e-12 && perp_sq > 1e-12) {
              const t_opt = tc_raw - dz * vbitTan * Math.sqrt(perp_sq) / Math.sqrt(discrim)
              fMin = Math.min(fMin, evalF(t_opt))
            }

            newH = Math.max(0, this.thicknessMM + fMin)
          } else if (ballNose) {
            // Ball nose: closest-point depth, spherical cap
            const tc = Math.max(0, Math.min(1, tc_raw))
            const z_tc = prevZ + tc * dz
            if (z_tc >= 0) continue
            const br = toolDiameterMM / 2
            const dt = tc - tc_raw
            const dist = Math.sqrt(dt * dt * lenSq + perp_sq)
            if (dist > br) continue
            newH = Math.max(0, this.thicknessMM + z_tc + br - Math.sqrt(Math.max(0, br * br - dist * dist)))
          } else {
            // Flat endmill: closest-point depth, flat bottom
            const tc = Math.max(0, Math.min(1, tc_raw))
            const z_tc = prevZ + tc * dz
            if (z_tc >= 0) continue
            const dt = tc - tc_raw
            const dist = Math.sqrt(dt * dt * lenSq + perp_sq)
            if (dist > r) continue
            newH = Math.max(0, this.thicknessMM + z_tc)
          }

          if (leaf.height > newH) {
            leaf.height = newH
            leaf.dirty  = true
            this.anyCarved = true
          }
        }
      }
    }
  }
}
