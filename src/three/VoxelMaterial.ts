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

type BBox4 = [number, number, number, number]

// ── quadtree builder ─────────────────────────────────────────────────────────

function overlapsAny(x0: number, y0: number, x1: number, y1: number, bboxes: BBox4[]): boolean {
  for (const [bx0, by0, bx1, by1] of bboxes) {
    if (x0 < bx1 && x1 > bx0 && y0 < by1 && y1 > by0) return true
  }
  return false
}

function subdivide(
  x0: number, y0: number, x1: number, y1: number,
  bboxes: BBox4[],
  minCellMM: number,
  T: number,
  out: VoxelLeaf[],
) {
  const w = x1 - x0, h = y1 - y0
  if ((w > minCellMM * 1.5 || h > minCellMM * 1.5) && bboxes.length > 0 && overlapsAny(x0, y0, x1, y1, bboxes)) {
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2
    subdivide(x0, y0, mx, my, bboxes, minCellMM, T, out)
    subdivide(mx, y0, x1, my, bboxes, minCellMM, T, out)
    subdivide(x0, my, mx, y1, bboxes, minCellMM, T, out)
    subdivide(mx, my, x1, y1, bboxes, minCellMM, T, out)
    return
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  out.push({ x0, y0, x1, y1, cx, cy, cw: w, ch: h, height: T, dirty: false, instanceIdx: out.length })
}

function buildLeaves(
  W: number, H: number, T: number,
  segments: SimSegment[],
  orgX: number, orgY: number,
  minCellMM: number,
): VoxelLeaf[] {
  const bboxes: BBox4[] = []
  for (const seg of segments) {
    if (seg.rapid || seg.z >= 0) continue
    const ax = seg.prevX + orgX, ay = seg.prevY + orgY
    const bx = seg.x + orgX,    by = seg.y + orgY
    const r = seg.toolDiameterMM / 2
    bboxes.push([Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.max(ax, bx) + r, Math.max(ay, by) + r])
  }
  const leaves: VoxelLeaf[] = []
  subdivide(0, 0, W, H, bboxes, minCellMM, T, leaves)
  return leaves
}

// ── main class ───────────────────────────────────────────────────────────────

export class VoxelMaterial {
  readonly leaves: VoxelLeaf[]
  readonly thicknessMM: number
  readonly orgX: number  // org.x: add to MR coord to get workpiece-local
  readonly orgY: number
  private _lastSegIdx = -1

  constructor(
    W: number, H: number, T: number,
    segments: SimSegment[],
    orgX: number, orgY: number,
    minCellMM = 2,
  ) {
    this.thicknessMM = T
    this.orgX = orgX
    this.orgY = orgY
    this.leaves = buildLeaves(W, H, T, segments, orgX, orgY, minCellMM)
  }

  reset() {
    for (const leaf of this.leaves) {
      leaf.height = this.thicknessMM
      leaf.dirty = true
    }
    this._lastSegIdx = -1
  }

  applyUpToSegIdx(segments: SimSegment[], segIdx: number): boolean {
    if (segIdx === this._lastSegIdx) return false
    let didReset = false
    if (segIdx < this._lastSegIdx) {
      this.reset()
      didReset = true
    }
    const from = this._lastSegIdx + 1
    let carved = false
    for (let i = from; i <= segIdx && i < segments.length; i++) {
      const seg = segments[i]
      if (!seg.rapid && seg.z < 0) { this._carve(seg); carved = true }
    }
    this._lastSegIdx = segIdx
    return carved || didReset
  }

  private _carve(seg: SimSegment) {
    const r = seg.toolDiameterMM / 2
    const cutH = Math.max(0, this.thicknessMM + seg.z)
    const ax = seg.prevX + this.orgX, ay = seg.prevY + this.orgY
    const bx = seg.x + this.orgX,    by = seg.y + this.orgY
    const dx = bx - ax, dy = by - ay
    const lenSq = dx * dx + dy * dy

    for (const leaf of this.leaves) {
      if (leaf.height <= cutH) continue

      // Exact minimum distance from segment to leaf AABB via two-pass projection:
      // 1. nearest point on segment to AABB centre
      // 2. clamp onto AABB → nearest AABB point to the segment
      // 3. nearest point on segment to that AABB point → true closest pair
      const { x0, y0, x1, y1 } = leaf
      const t1 = lenSq < 1e-8 ? 0 : Math.max(0, Math.min(1,
        ((x0 + x1) * 0.5 - ax) * dx + ((y0 + y1) * 0.5 - ay) * dy) / lenSq)
      const qx = Math.max(x0, Math.min(x1, ax + t1 * dx))
      const qy = Math.max(y0, Math.min(y1, ay + t1 * dy))
      const t2 = lenSq < 1e-8 ? 0 : Math.max(0, Math.min(1,
        ((qx - ax) * dx + (qy - ay) * dy) / lenSq))
      const dist = Math.hypot((ax + t2 * dx) - qx, (ay + t2 * dy) - qy)

      if (dist <= r) {
        leaf.height = cutH
        leaf.dirty = true
      }
    }
  }
}
