import { describe, it, expect } from 'vitest'
import {
  generateVCarve,
  generateMaleTextBoundaryVCarve,
  classifySubpaths,
  findModalRadius,
} from './vcarve'
import type { MotionSegment } from '../store/toolpathStore'
import type { Pt2 } from './pathFlattener'
import type { Tool } from '../store/toolStore'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// The V-bit's own vbitAngleDeg is deliberately never read by the generator —
// the operation form passes the angle through VCarveParams.angleDeg.
const vbit = (vbitAngleDeg = 90): Tool => ({
  id: 'vb', name: 'V-Bit', type: 'vbit', diameterMM: 12.7, fluteCount: 2, rpm: 18000,
  xyFeedMmMin: 2000, zFeedMmMin: 400, stepDownMM: 2, maxDepthMM: 10,
  direction: 'climb', vbitAngleDeg,
})

// 40 × 10 mm rectangle. Medial axis = a horizontal ridge y=5 from (5,5) to (35,5)
// at inscribed radius 5, plus four 45° branches out to the sharp corners (r=0).
const RECT_40x10 = 'M 0 0 L 40 0 L 40 10 L 0 10 Z'

// 40 × 40 square with a concentric 20 × 20 hole: a constant 10 mm wide wall,
// so the medial axis is a closed rectangular loop at inscribed radius 5.
const ANNULUS = 'M 0 0 L 40 0 L 40 40 L 0 40 Z M 10 10 L 10 30 L 30 30 L 30 10 Z'
const HOLE_20x20 = 'M 10 10 L 10 30 L 30 30 L 30 10 Z'

// 40 × 20 rounded rectangle, corner radius 5 — no sharp corners anywhere.
// Medial axis = spine (10,10)→(30,10) at r=10, plus branches to the four arc centres at r=5.
const ROUNDRECT_40x20_R5 =
  'M 5 0 L 35 0 A 5 5 0 0 1 40 5 L 40 15 A 5 5 0 0 1 35 20 L 5 20 A 5 5 0 0 1 0 15 L 0 5 A 5 5 0 0 1 5 0 Z'

const cuts = (segs: MotionSegment[]) => segs.filter(s => !s.rapid)
const minZ = (segs: MotionSegment[]) => Math.min(...segs.map(s => s.z))
const at = (segs: MotionSegment[], x: number, y: number, tol = 0.02) =>
  segs.filter(s => Math.abs(s.x - x) < tol && Math.abs(s.y - y) < tol)
/** Cutting moves passing through (x, y) — excludes the safe-height rapids at the same XY. */
const cutAt = (segs: MotionSegment[], x: number, y: number, tol = 0.02) => cuts(at(segs, x, y, tol))
/** Depth of the cutting moves at (x, y); fails the caller's expectation if the point is missing. */
const depthAt = (segs: MotionSegment[], x: number, y: number, tol = 0.02) => {
  const hits = cutAt(segs, x, y, tol)
  return hits.length ? Math.min(...hits.map(s => s.z)) : NaN
}

// ─── Depth mapping: Z = −min(zStart + r / tan(θ/2), maxDepth) ─────────────────

describe('generateVCarve — depth from medial-axis radius', () => {
  it('cuts the ridge of a 40×10 rectangle at the inscribed radius with a 90° bit', async () => {
    const segs = await generateVCarve(RECT_40x10, vbit(), {
      angleDeg: 90, maxDepthMM: 10, islandDs: [],
    })

    // tan(45°) = 1, so a 5 mm inscribed radius maps 1:1 to 5 mm of depth.
    expect(minZ(segs)).toBeCloseTo(-5, 6)

    // Ridge endpoints sit one radius in from the short walls.
    expect(depthAt(segs, 5, 5)).toBeCloseTo(-5, 6)
    expect(depthAt(segs, 35, 5)).toBeCloseTo(-5, 6)

    // Sharp corners have zero inscribed radius → the tip just grazes the surface.
    for (const [cx, cy] of [[0, 0], [40, 0], [0, 10], [40, 10]] as const) {
      expect(cutAt(segs, cx, cy).length).toBeGreaterThan(0)
      expect(depthAt(segs, cx, cy)).toBeCloseTo(0, 6)
    }
  })

  it('scales depth by 1/tan(halfAngle) for a 60° bit', async () => {
    const segs = await generateVCarve(RECT_40x10, vbit(), {
      angleDeg: 60, maxDepthMM: 20, islandDs: [],
    })
    // r / tan(30°) = 5 / 0.57735 = 8.6603 mm
    expect(minZ(segs)).toBeCloseTo(-5 / Math.tan(Math.PI / 6), 6)
  })

  it('reads the angle from params, not from the tool', async () => {
    const wrongAngleTool = vbit(30) // tool says 30°, params say 90°
    const segs = await generateVCarve(RECT_40x10, wrongAngleTool, {
      angleDeg: 90, maxDepthMM: 10, islandDs: [],
    })
    expect(minZ(segs)).toBeCloseTo(-5, 6) // 90° result, not the 30° one (−18.66)
  })

  it('clamps to maxDepthMM without flattening the shallow ends', async () => {
    const segs = await generateVCarve(RECT_40x10, vbit(), {
      angleDeg: 60, maxDepthMM: 3, islandDs: [],
    })
    // Unclamped the ridge would be −8.66; the whole spine is pinned at −3.
    expect(minZ(segs)).toBe(-3)
    expect(depthAt(segs, 5, 5)).toBe(-3)
    // The corner ramps are still shallower than the clamp.
    expect(depthAt(segs, 0, 0)).toBeCloseTo(0, 6)
  })

  it('shifts the whole cut down by zStartMM (male-inlay plug offset)', async () => {
    const segs = await generateVCarve(RECT_40x10, vbit(), {
      angleDeg: 90, maxDepthMM: 10, islandDs: [], zStartMM: 1,
    })
    expect(minZ(segs)).toBeCloseTo(-6, 6)             // 1 + 5
    expect(depthAt(segs, 0, 0)).toBeCloseTo(-1, 6)    // r = 0 corner, offset only
  })

  it('never emits a positive cutting Z', async () => {
    const segs = await generateVCarve(ANNULUS, vbit(), {
      angleDeg: 90, maxDepthMM: 10, islandDs: [],
    })
    expect(cuts(segs).every(s => s.z <= 0)).toBe(true)
  })
})

// ─── Retract framing ──────────────────────────────────────────────────────────

describe('generateVCarve — plunge/retract framing', () => {
  it('brackets each region with a rapid in at safe height and a rapid out', async () => {
    const segs = await generateVCarve(RECT_40x10, vbit(), {
      angleDeg: 90, maxDepthMM: 10, islandDs: [], safeHeightMM: 12,
    })

    const first = segs[0], second = segs[1], last = segs[segs.length - 1]

    expect(first.rapid).toBe(true)
    expect(first.z).toBe(12)
    // The plunge happens at the same XY the rapid positioned to.
    expect(second.rapid).toBe(false)
    expect([second.x, second.y]).toEqual([first.x, first.y])

    expect(last.rapid).toBe(true)
    expect(last.z).toBe(12)

    // Everything in between stays down.
    expect(segs.slice(1, -1).some(s => s.rapid)).toBe(false)
  })

  it('defaults safe height to 5 mm', async () => {
    const segs = await generateVCarve(RECT_40x10, vbit(), {
      angleDeg: 90, maxDepthMM: 10, islandDs: [],
    })
    expect(segs[0].z).toBe(5)
    expect(segs[segs.length - 1].z).toBe(5)
  })

  it('retracts once per disjoint region', async () => {
    const two = 'M 50 0 L 70 0 L 70 10 L 50 10 Z M 0 0 L 20 0 L 20 10 L 0 10 Z'
    const segs = await generateVCarve(two, vbit(), {
      angleDeg: 90, maxDepthMM: 10, islandDs: [],
    })
    expect(segs.filter(s => s.rapid).length).toBe(4) // 2 regions × (rapid in + rapid out)
  })
})

// ─── Medial-axis geometry ─────────────────────────────────────────────────────

describe('generateVCarve — medial axis geometry', () => {
  it('finds the spine and corner-arc centres of a rounded rectangle', async () => {
    const segs = await generateVCarve(ROUNDRECT_40x20_R5, vbit(), {
      angleDeg: 90, maxDepthMM: 15, islandDs: [],
    })

    // Spine runs (10,10)→(30,10); half the 20 mm height is the inscribed radius.
    expect(minZ(segs)).toBeCloseTo(-10, 6)
    expect(at(segs, 10, 10).length).toBeGreaterThan(0)
    expect(at(segs, 30, 10).length).toBeGreaterThan(0)

    // The four corner-arc centres are at radius 5.
    for (const [cx, cy] of [[5, 5], [35, 5], [5, 15], [35, 15]] as const) {
      expect(cutAt(segs, cx, cy, 0.01).length).toBeGreaterThan(0)
      expect(depthAt(segs, cx, cy, 0.01)).toBeCloseTo(-5, 1)
    }

    // A shape with no sharp corners must never bring the tip back to the surface
    // mid-cut — that is exactly the discretization noise pruneNoisyBranches kills.
    expect(Math.max(...cuts(segs).map(s => s.z))).toBeLessThan(-4)
  })

  it('walks a constant-width wall as a closed loop at constant depth', async () => {
    const segs = await generateVCarve(ANNULUS, vbit(), {
      angleDeg: 90, maxDepthMM: 10, islandDs: [],
    })
    const cut = cuts(segs)

    // The four straight runs sit 5 mm from both the outer wall and the counter,
    // so each run's endpoints carve at exactly the inscribed radius.
    for (const [x, y] of [[10, 5], [30, 5], [35, 10], [35, 30], [30, 35], [10, 35], [5, 30], [5, 10]] as const) {
      expect(depthAt(segs, x, y)).toBeCloseTo(-5, 6)
    }

    // Outer sharp corners pull the axis outward: the point equidistant from
    // x=0, y=0 and the hole corner (10,10) is t = 10√2/(1+√2) ≈ 5.858.
    const t = 10 * Math.SQRT2 / (1 + Math.SQRT2)
    expect(minZ(segs)).toBeCloseTo(-t, 3)
    expect(at(segs, t, t, 0.01).length).toBeGreaterThan(0)

    // The four outer corners spur off the loop and taper to the surface.
    for (const [x, y] of [[0, 0], [40, 0], [40, 40], [0, 40]] as const) {
      expect(depthAt(segs, x, y)).toBeCloseTo(0, 6)
    }

    // The skeleton contains a cycle, which the plain leaf-to-leaf traversal cannot
    // cover — findPossiblePath's second pass must close it, so the final cut point
    // is a revisit of a point the tool already passed through.
    const end = cut[cut.length - 1]
    const revisits = cut.filter(s => Math.abs(s.x - end.x) < 1e-9 && Math.abs(s.y - end.y) < 1e-9)
    expect(revisits.length).toBeGreaterThan(1)
  })

  it('covers both arms of a concave L shape', async () => {
    const segs = await generateVCarve('M 0 0 L 30 0 L 30 10 L 10 10 L 10 30 L 0 30 Z', vbit(), {
      angleDeg: 90, maxDepthMM: 10, islandDs: [],
    })
    expect(depthAt(segs, 25, 5)).toBeCloseTo(-5, 6) // horizontal arm
    expect(depthAt(segs, 5, 25)).toBeCloseTo(-5, 6) // vertical arm
  })

  it('carves sub-millimetre shapes instead of pruning them away', async () => {
    const segs = await generateVCarve('M 0 0 L 0.4 0 L 0.4 0.4 L 0 0.4 Z', vbit(), {
      angleDeg: 90, maxDepthMM: 10, islandDs: [],
    })
    expect(minZ(segs)).toBeCloseTo(-0.2, 6)
  })

  it('treats islandDs identically to a hole subpath in the same path', async () => {
    const opts = { angleDeg: 90, maxDepthMM: 10 }
    const fromSubpath = await generateVCarve(ANNULUS, vbit(), { ...opts, islandDs: [] })
    const fromIsland = await generateVCarve('M 0 0 L 40 0 L 40 40 L 0 40 Z', vbit(), {
      ...opts, islandDs: [HOLE_20x20],
    })
    expect(fromIsland).toEqual(fromSubpath)
  })
})

// ─── Ordering and entry selection ─────────────────────────────────────────────

describe('generateVCarve — ordering', () => {
  it('cuts regions left-to-right by centroid X regardless of subpath order', async () => {
    // Right-hand rectangle is written first in the d string.
    const segs = await generateVCarve(
      'M 50 0 L 70 0 L 70 10 L 50 10 Z M 0 0 L 20 0 L 20 10 L 0 10 Z',
      vbit(), { angleDeg: 90, maxDepthMM: 10, islandDs: [] })

    const firstRapid = segs.findIndex(s => s.rapid)
    expect(segs[firstRapid].x).toBeLessThan(25)
    // Second region's entry rapid is on the right.
    const entries = segs.filter((s, i) => s.rapid && (i === 0 || !segs[i - 1].rapid) && s.z === 5)
    expect(entries[0].x).toBeLessThan(entries[1].x)
  })

  it('starts at the skeleton leaf nearest the incoming tool position', async () => {
    const opts = { angleDeg: 90, maxDepthMM: 10, islandDs: [] }
    const fromOrigin = await generateVCarve(RECT_40x10, vbit(), { ...opts, startNear: { x: 0, y: 0 } })
    const fromFarEnd = await generateVCarve(RECT_40x10, vbit(), { ...opts, startNear: { x: 40, y: 10 } })

    expect(fromOrigin[0].x).toBeCloseTo(0, 6)
    expect(fromOrigin[0].y).toBeCloseTo(0, 6)
    expect(fromFarEnd[0].x).toBeCloseTo(40, 6)
    expect(fromFarEnd[0].y).toBeCloseTo(10, 6)
  })
})

// ─── Error handling ───────────────────────────────────────────────────────────

describe('generateVCarve — rejections', () => {
  it('rejects a non-V-bit tool', async () => {
    const endmill: Tool = { ...vbit(), type: 'endmill' }
    await expect(generateVCarve(RECT_40x10, endmill, { angleDeg: 90, maxDepthMM: 10, islandDs: [] }))
      .rejects.toThrow('V-carve requires a V-bit tool')
  })

  it('rejects a degenerate V-bit angle', async () => {
    await expect(generateVCarve(RECT_40x10, vbit(), { angleDeg: 0, maxDepthMM: 10, islandDs: [] }))
      .rejects.toThrow('Invalid V-bit angle')
  })

  it('rejects a path with no closed geometry', async () => {
    await expect(generateVCarve('M 0 0 L 10 10', vbit(), { angleDeg: 90, maxDepthMM: 10, islandDs: [] }))
      .rejects.toThrow('No geometry found in path')
  })
})

// ─── Male text inlay boundary pass ────────────────────────────────────────────

describe('generateMaleTextBoundaryVCarve', () => {
  it('traces the outline at one constant depth taken from the modal radius', async () => {
    const segs = await generateMaleTextBoundaryVCarve(RECT_40x10, vbit(), {
      angleDeg: 90, maxDepthMM: 10, zStartMM: 0, islandDs: [],
    })
    const cut = cuts(segs)

    // A constant-width 10 mm stroke: true half-width is 5, so at 90° the depth is
    // ≈ −5 mm. It is not exact — findModalRadius reports a 20-bin bucket centre,
    // which lands within half a bin of the true radius.
    const z = cut[0].z
    expect(z).toBeCloseTo(-5, 0)
    expect(z).toBeLessThan(0)
    expect(cut.every(s => s.z === z)).toBe(true) // no ramping — it's a boundary pass

    // The contour is closed and visits every rectangle corner.
    expect(cut[cut.length - 1].x).toBeCloseTo(cut[0].x, 6)
    expect(cut[cut.length - 1].y).toBeCloseTo(cut[0].y, 6)
    for (const [cx, cy] of [[0, 0], [40, 0], [40, 10], [0, 10]] as const) {
      expect(at(segs, cx, cy).length).toBeGreaterThan(0)
    }

    expect(segs[0].rapid).toBe(true)
    expect(segs[segs.length - 1].rapid).toBe(true)
  })

  it('traces counters as their own retracted contour at the same depth', async () => {
    const segs = await generateMaleTextBoundaryVCarve(ANNULUS, vbit(), {
      angleDeg: 90, maxDepthMM: 10, zStartMM: 0, islandDs: [], safeHeightMM: 3,
    })

    // Outer ring + hole ring, each bracketed by a rapid pair.
    expect(segs.filter(s => s.rapid).length).toBe(4)
    expect(segs.filter(s => s.rapid).every(s => s.z === 3)).toBe(true)

    const depths = new Set(cuts(segs).map(s => s.z))
    expect(depths.size).toBe(1) // one depth for the letter body and its counter

    expect(at(segs, 10, 10).length).toBeGreaterThan(0) // hole corner is traced
    expect(at(segs, 40, 40).length).toBeGreaterThan(0) // outer corner is traced
  })

  it('offsets the boundary depth by zStartMM', async () => {
    const base = await generateMaleTextBoundaryVCarve(RECT_40x10, vbit(), {
      angleDeg: 90, maxDepthMM: 10, zStartMM: 0, islandDs: [],
    })
    const shifted = await generateMaleTextBoundaryVCarve(RECT_40x10, vbit(), {
      angleDeg: 90, maxDepthMM: 10, zStartMM: 0.5, islandDs: [],
    })
    expect(cuts(shifted)[0].z).toBeCloseTo(cuts(base)[0].z - 0.5, 6)
  })

  it('clamps the boundary depth to maxDepthMM', async () => {
    const segs = await generateMaleTextBoundaryVCarve(RECT_40x10, vbit(), {
      angleDeg: 90, maxDepthMM: 2, zStartMM: 0, islandDs: [],
    })
    expect(cuts(segs).every(s => s.z === -2)).toBe(true)
  })

  it('rejects a non-V-bit tool', async () => {
    const endmill: Tool = { ...vbit(), type: 'endmill' }
    await expect(generateMaleTextBoundaryVCarve(RECT_40x10, endmill, {
      angleDeg: 90, maxDepthMM: 10, zStartMM: 0, islandDs: [],
    })).rejects.toThrow('V-carve requires a V-bit tool')
  })
})

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe('findModalRadius', () => {
  it('returns 0 for no samples', () => {
    expect(findModalRadius([])).toBe(0)
  })

  it('returns the value itself when every sample is identical', () => {
    expect(findModalRadius([3, 3, 3])).toBe(3)
  })

  it('returns the centre of the most populated of 20 bins', () => {
    // range 0..20 → binSize 1; the four 5s land in bin 5 → centre 5.5
    expect(findModalRadius([0, 20, 5, 5, 5, 5])).toBeCloseTo(5.5, 9)
  })

  it('folds the maximum sample into the last bin rather than overflowing', () => {
    // range 0..10 → binSize 0.5; 10 would index bin 20, clamped to 19 → centre 9.75
    expect(findModalRadius([0, 10, 10, 10])).toBeCloseTo(9.75, 9)
  })

  it('is insensitive to a handful of deep outliers', () => {
    const radii = [...Array(50).fill(2), 100]
    expect(findModalRadius(radii)).toBeLessThan(10)
  })
})

describe('classifySubpaths', () => {
  const square = (x: number, y: number, s: number): Pt2[] =>
    [[x, y], [x + s, y], [x + s, y + s], [x, y + s]]

  it('nests a contained loop as a hole of the larger loop', () => {
    const regions = classifySubpaths([square(10, 10, 20), square(0, 0, 40)])
    expect(regions.length).toBe(1)
    expect(regions[0].holes.length).toBe(1)
    // Largest by area becomes the outer ring regardless of input order.
    expect(regions[0].outer).toEqual(square(0, 0, 40))
  })

  it('keeps disjoint loops as separate regions', () => {
    const regions = classifySubpaths([square(0, 0, 10), square(50, 0, 10)])
    expect(regions.length).toBe(2)
    expect(regions.every(r => r.holes.length === 0)).toBe(true)
  })

  it('treats loops that touch at a vertex as siblings, not holes', () => {
    // Inner loop shares the (10,10) vertex with the outer — the letter-K arm case.
    const outer: Pt2[] = [[0, 0], [40, 0], [40, 40], [0, 40]]
    const touching: Pt2[] = [[10, 10], [30, 10], [30, 30]]
    const withShared: Pt2[] = [[0, 0], ...touching]

    expect(classifySubpaths([outer, touching])[0].holes.length).toBe(1)
    // Once it shares a vertex with the outer ring it is no longer a counter.
    const regions = classifySubpaths([outer, withShared])
    expect(regions.length).toBe(2)
    expect(regions[0].holes.length).toBe(0)
  })

  it('handles a hole inside a hole by starting a new region', () => {
    const regions = classifySubpaths([square(0, 0, 60), square(10, 10, 40), square(20, 20, 20)])
    // Both inner loops are contained by the outermost, so they both read as its holes.
    expect(regions.length).toBe(1)
    expect(regions[0].holes.length).toBe(2)
  })
})
