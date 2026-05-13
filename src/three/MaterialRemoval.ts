import type { SimSegment } from '../sim/gcodeParser'

export class MaterialRemoval {
  readonly gridW: number
  readonly gridH: number
  readonly heights: Float32Array  // heights[row*gridW+col] = mm from workpiece bottom
  readonly thicknessMM: number
  readonly workpieceW: number
  readonly workpieceH: number
  readonly originX: number  // CNC X of workpiece left edge
  readonly originY: number  // CNC Y of workpiece bottom edge
  private _lastSegIdx = -1

  constructor(
    workpieceW: number,
    workpieceH: number,
    thicknessMM: number,
    originX: number,
    originY: number,
    resolution = 150,
  ) {
    this.workpieceW = workpieceW
    this.workpieceH = workpieceH
    this.thicknessMM = thicknessMM
    this.originX = originX
    this.originY = originY
    const aspect = workpieceW / workpieceH
    this.gridW = Math.max(2, Math.round(resolution * Math.sqrt(aspect)))
    this.gridH = Math.max(2, Math.round(resolution / Math.sqrt(aspect)))
    this.heights = new Float32Array(this.gridW * this.gridH).fill(thicknessMM)
  }

  reset() {
    this.heights.fill(this.thicknessMM)
    this._lastSegIdx = -1
  }

  // Apply segments up to segIdx. Returns true if heights changed.
  applyUpToSegIdx(segments: SimSegment[], segIdx: number): boolean {
    if (segIdx === this._lastSegIdx) return false

    let didReset = false
    if (segIdx < this._lastSegIdx) {
      this.reset()  // sets _lastSegIdx = -1
      didReset = true
    }

    const fromIdx = this._lastSegIdx + 1
    let carved = false

    for (let i = fromIdx; i <= segIdx && i < segments.length; i++) {
      const seg = segments[i]
      if (!seg.rapid && seg.z < 0) {
        this._carve(seg)
        carved = true
      }
    }

    this._lastSegIdx = segIdx
    return carved || didReset
  }

  private _carve(seg: SimSegment) {
    const r = seg.toolDiameterMM / 2
    // Height from workpiece bottom after this cut (cncZ is negative = into material)
    const cutHeight = Math.max(0, this.thicknessMM + seg.z)

    const cellW = this.workpieceW / this.gridW
    const cellH = this.workpieceH / this.gridH

    // Translate segment coords into workpiece-local space
    const ax = seg.prevX - this.originX
    const ay = seg.prevY - this.originY
    const bx = seg.x - this.originX
    const by = seg.y - this.originY

    const bMinX = Math.min(ax, bx) - r
    const bMaxX = Math.max(ax, bx) + r
    const bMinY = Math.min(ay, by) - r
    const bMaxY = Math.max(ay, by) + r

    const colMin = Math.max(0, Math.floor(bMinX / cellW))
    const colMax = Math.min(this.gridW - 1, Math.ceil(bMaxX / cellW))
    const rowMin = Math.max(0, Math.floor(bMinY / cellH))
    const rowMax = Math.min(this.gridH - 1, Math.ceil(bMaxY / cellH))

    const dx = bx - ax
    const dy = by - ay
    const lenSq = dx * dx + dy * dy

    for (let row = rowMin; row <= rowMax; row++) {
      for (let col = colMin; col <= colMax; col++) {
        const cx = (col + 0.5) * cellW
        const cy = (row + 0.5) * cellH

        let dist: number
        if (lenSq < 1e-8) {
          dist = Math.hypot(cx - bx, cy - by)
        } else {
          const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / lenSq))
          dist = Math.hypot(cx - (ax + t * dx), cy - (ay + t * dy))
        }

        if (dist <= r) {
          const idx = row * this.gridW + col
          if (this.heights[idx] > cutHeight) {
            this.heights[idx] = cutHeight
          }
        }
      }
    }
  }
}
