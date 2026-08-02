import { describe, it, expect } from 'vitest'
import { generatePhotoVCarve, grooveWidthMM, lineSpacingMM, type PhotoImage, type PhotoRect } from './photoVcarve'
import type { Tool } from '../store/toolStore'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const vbit = (vbitAngleDeg = 90): Tool => ({
  id: 'vb', name: 'V-Bit', type: 'vbit', diameterMM: 12.7, fluteCount: 2, rpm: 18000,
  xyFeedMmMin: 2000, zFeedMmMin: 400, maxDepthMM: 10, vbitAngleDeg,
})

const endmill = (): Tool => ({
  id: 'em', name: 'End Mill', type: 'endmill', diameterMM: 6, fluteCount: 2, rpm: 18000,
  xyFeedMmMin: 2000, zFeedMmMin: 400, maxDepthMM: 20,
})

/** Row 0 is the TOP of the image, matching how the canvas draws it. */
function image(rows: number[][]): PhotoImage {
  const h = rows.length, w = rows[0].length
  const lum = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) lum[y * w + x] = rows[y][x]
  return { lum, w, h }
}

// 100 × 50 mm, unrotated, bottom-left at the origin.
const RECT: PhotoRect = { p0: { x: 0, y: 0 }, widthMM: 100, heightMM: 50, rotationDeg: 0 }

// A 90° bit makes the derived line spacing exactly twice the depth at black, which
// keeps every expectation below arithmetic rather than trigonometric.
const params = (over: Partial<Parameters<typeof generatePhotoVCarve>[3]> = {}) => ({
  angleDeg: 90, passAngleDeg: 0,
  minDepthMM: 0, maxDepthMM: 2, safeHeightMM: 5,
  ...over,
})

// ─── Groove geometry ──────────────────────────────────────────────────────────

describe('groove geometry', () => {
  it('a 90° bit cuts a groove twice as wide as it is deep', () => {
    expect(grooveWidthMM(1, 90)).toBeCloseTo(2, 9)
    expect(grooveWidthMM(0.5, 90)).toBeCloseTo(1, 9)
  })

  it('a 60° bit cuts narrower than a 90° one at the same depth', () => {
    expect(grooveWidthMM(1, 60)).toBeLessThan(grooveWidthMM(1, 90))
    expect(grooveWidthMM(1, 60)).toBeCloseTo(2 * Math.tan(Math.PI / 6), 9)
  })

  it('spaces the lines by the width of the deepest groove', () => {
    expect(lineSpacingMM(0.5, 90)).toBeCloseTo(1, 9)
    expect(lineSpacingMM(0.6, 60)).toBeCloseTo(grooveWidthMM(0.6, 60), 9)
  })

  it('floors the spacing so an absurdly shallow depth cannot ask for thousands of lines', () => {
    expect(lineSpacingMM(0.0001, 90)).toBe(0.05)
  })
})

// ─── Depth from brightness ────────────────────────────────────────────────────

describe('depth follows image brightness', () => {
  it('carves black to maxDepth and white to minDepth', () => {
    // Left half black, right half white.
    const img = image([[0, 255]])
    const segs = generatePhotoVCarve(img, RECT, vbit(), params({ minDepthMM: 0.25, maxDepthMM: 2 }))
    const cuts = segs.filter((s) => !s.rapid)

    const left = cuts.filter((s) => s.x < 20)
    const right = cuts.filter((s) => s.x > 80)
    expect(left.length).toBeGreaterThan(0)
    expect(right.length).toBeGreaterThan(0)
    for (const s of left) expect(s.z).toBeCloseTo(-2, 3)
    for (const s of right) expect(s.z).toBeCloseTo(-0.25, 3)
  })

  it('never cuts above the surface, or below the depth at black', () => {
    const img = image([[0, 128, 255], [255, 0, 90]])
    const segs = generatePhotoVCarve(img, RECT, vbit(), params({ minDepthMM: 0, maxDepthMM: 2 }))
    for (const s of segs.filter((x) => !x.rapid)) {
      expect(s.z).toBeLessThanOrEqual(0)
      expect(s.z).toBeGreaterThanOrEqual(-2 - 1e-9)
    }
  })

  it('mid grey lands halfway down the depth band', () => {
    const segs = generatePhotoVCarve(image([[128]]), RECT, vbit(), params({ minDepthMM: 1, maxDepthMM: 3 }))
    for (const s of segs.filter((x) => !x.rapid)) expect(s.z).toBeCloseTo(-2, 1)
  })

  it('reads the image the way the canvas draws it — row 0 at the TOP', () => {
    // Top row black, bottom row white: the deep cuts must be at high CNC Y.
    const segs = generatePhotoVCarve(image([[0], [255]]), RECT, vbit(), params({ maxDepthMM: 2 }))
    const cuts = segs.filter((s) => !s.rapid)
    const deep = cuts.filter((s) => s.z < -1.5)
    const shallow = cuts.filter((s) => s.z > -0.5)
    expect(deep.length).toBeGreaterThan(0)
    expect(shallow.length).toBeGreaterThan(0)
    for (const s of deep) expect(s.y).toBeGreaterThan(25)
    for (const s of shallow) expect(s.y).toBeLessThan(25)
  })
})

// ─── Raster layout ────────────────────────────────────────────────────────────

describe('raster layout', () => {
  it('spaces the lines a full-depth groove apart and keeps them inside the image', () => {
    // 90° bit, 2.5 mm at black → 5 mm grooves → 5 mm lines.
    const segs = generatePhotoVCarve(image([[128]]), RECT, vbit(), params({ maxDepthMM: 2.5 }))
    const ys = [...new Set(segs.map((s) => +s.y.toFixed(6)))].sort((a, b) => a - b)
    // 50 mm of image at 5 mm spacing = 11 lines, centred with equal margins.
    expect(ys.length).toBe(11)
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeCloseTo(5, 6)
    expect(ys[0]).toBeGreaterThanOrEqual(0)
    expect(ys[ys.length - 1]).toBeLessThanOrEqual(50)
    expect(ys[0]).toBeCloseTo(50 - ys[ys.length - 1], 6)

    for (const s of segs) {
      expect(s.x).toBeGreaterThanOrEqual(-1e-9)
      expect(s.x).toBeLessThanOrEqual(100 + 1e-9)
    }
  })

  it('halving the depth at black roughly doubles the line count', () => {
    const lines = (maxDepthMM: number) => {
      const segs = generatePhotoVCarve(image([[128]]), RECT, vbit(), params({ maxDepthMM }))
      return new Set(segs.map((s) => +s.y.toFixed(6))).size
    }
    expect(lines(0.5)).toBeCloseTo(2 * lines(1), -1)
  })

  it('runs the lines along the raster angle', () => {
    const segs = generatePhotoVCarve(image([[128]]), RECT, vbit(), params({ passAngleDeg: 90 }))
    // Vertical lines: each one holds a single X and sweeps Y.
    const xs = new Set(segs.map((s) => +s.x.toFixed(6)))
    const ys = new Set(segs.map((s) => +s.y.toFixed(6)))
    expect(xs.size).toBeGreaterThan(ys.size)
    expect(ys.size).toBe(2)
  })

  it('follows a rotated image', () => {
    // Same picture, rotated 90° CCW about its bottom-left corner: p0→p1 now runs +Y,
    // so the 100 mm edge is vertical and the carve occupies x ∈ [-50, 0].
    const rot: PhotoRect = { p0: { x: 0, y: 0 }, widthMM: 100, heightMM: 50, rotationDeg: 90 }
    const segs = generatePhotoVCarve(image([[128]]), rot, vbit(), params())
    for (const s of segs) {
      expect(s.x).toBeGreaterThanOrEqual(-50 - 1e-9)
      expect(s.x).toBeLessThanOrEqual(1e-9)
      expect(s.y).toBeGreaterThanOrEqual(-1e-9)
      expect(s.y).toBeLessThanOrEqual(100 + 1e-9)
    }
  })
})

// ─── Motion ───────────────────────────────────────────────────────────────────

describe('motion', () => {
  it('enters and leaves every groove at safe height', () => {
    const segs = generatePhotoVCarve(image([[128]]), RECT, vbit(), params({ safeHeightMM: 7 }))
    expect(segs[0].rapid).toBe(true)
    expect(segs[0].z).toBe(7)
    expect(segs[segs.length - 1].rapid).toBe(true)
    expect(segs[segs.length - 1].z).toBe(7)
    for (const s of segs) if (s.rapid) expect(s.z).toBe(7)
    // The plunge that follows each rapid holds the same XY — no cutting move into the stock.
    for (let i = 1; i < segs.length; i++) {
      if (segs[i - 1].rapid && !segs[i].rapid) {
        expect(segs[i].x).toBeCloseTo(segs[i - 1].x, 9)
        expect(segs[i].y).toBeCloseTo(segs[i - 1].y, 9)
      }
    }
  })

  it('cuts alternate lines in opposite directions', () => {
    const segs = generatePhotoVCarve(image([[128]]), RECT, vbit(), params({ maxDepthMM: 5 }))
    // Per line: rapid-in, plunge, … , retract. Direction = sign of (last x − first x).
    const dirs: number[] = []
    let start: number | null = null
    for (const s of segs) {
      if (!s.rapid && start === null) start = s.x
      else if (s.rapid && start !== null) { dirs.push(Math.sign(s.x - start)); start = null }
    }
    expect(dirs.length).toBeGreaterThan(2)
    for (let i = 1; i < dirs.length; i++) expect(dirs[i]).toBe(-dirs[i - 1])
  })

  it('thins a flat groove down to its two ends', () => {
    // A uniform image gives a constant-depth groove: everything between the ends is
    // redundant, so one line is rapid + plunge + end + retract. A spacing wider than the
    // image (30 mm at black → 60 mm grooves) leaves exactly one line, centred.
    const segs = generatePhotoVCarve(image([[128]]), RECT, vbit(), params({ maxDepthMM: 30 }))
    expect(segs.length).toBe(4)
    expect(segs[0].y).toBeCloseTo(25, 6)
  })
})

// ─── Guards ───────────────────────────────────────────────────────────────────

describe('guards', () => {
  it('refuses anything but a V-bit', () => {
    expect(() => generatePhotoVCarve(image([[128]]), RECT, endmill(), params()))
      .toThrow(/V-bit/)
  })

  it('refuses a zero depth at black — there would be nothing to space the lines by', () => {
    expect(() => generatePhotoVCarve(image([[128]]), RECT, vbit(), params({ maxDepthMM: 0 })))
      .toThrow(/Depth at black/)
  })

  it('refuses an image with no size on the workpiece', () => {
    const flat: PhotoRect = { ...RECT, heightMM: 0 }
    expect(() => generatePhotoVCarve(image([[128]]), flat, vbit(), params()))
      .toThrow(/zero size/)
  })
})
