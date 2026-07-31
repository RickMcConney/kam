import { describe, it, expect } from 'vitest'
import { zPasses, pointInPolygon, arcLengths, interpPt, stripClosingDuplicate, ptSegDistSq, toolRadiusAtHeight } from './geom'
import type { Pt2 } from './pathFlattener'
import type { Tool } from '../store/toolStore'

const mkTool = (over: Partial<Tool>): Tool => ({
  id: 't', name: 't', type: 'endmill', diameterMM: 6.35, fluteCount: 2, rpm: 18000,
  xyFeedMmMin: 2000, zFeedMmMin: 400, stepDownMM: 2, maxDepthMM: 20, direction: 'climb',
  ...over,
})

describe('zPasses', () => {
  it('steps down by stepDown then finishes exactly at -depth', () => {
    expect(zPasses(10, 3)).toEqual([-3, -6, -9, -10])
  })

  it('does not duplicate the final pass when depth is an exact multiple of step', () => {
    expect(zPasses(6, 2)).toEqual([-2, -4, -6])
  })

  // Regression: `z -= step` accumulates float error, so for these ratios the
  // last iteration landed a few ULPs above -depth (e.g. -0.7999999999999999)
  // and was pushed, then the unconditional final push added -depth again —
  // two full cutting passes at the same Z. Ordinary settings, not edge cases.
  it('does not duplicate the final pass when float drift overshoots -depth', () => {
    expect(zPasses(0.8, 0.1)).toEqual([-0.1, -0.2, -0.30000000000000004, -0.4, -0.5, -0.6, -0.7, -0.8])
    expect(zPasses(0.5, 0.05)).toHaveLength(10)
    expect(zPasses(0.4, 0.05)).toHaveLength(8)
  })

  it('never emits two passes at the same depth across the realistic parameter space', () => {
    const dupes: string[] = []
    for (let di = 1; di <= 400; di++) {
      for (let si = 1; si <= 100; si++) {
        const passes = zPasses(di / 10, si / 100)
        for (let i = 1; i < passes.length; i++) {
          if (Math.abs(passes[i] - passes[i - 1]) < 1e-9) dupes.push(`depth=${di / 10} step=${si / 100}`)
        }
      }
    }
    expect(dupes).toEqual([])
  })

  it('cuts a single pass when step exceeds depth', () => {
    expect(zPasses(5, 10)).toEqual([-5])
  })

  it('treats negative step as its magnitude', () => {
    expect(zPasses(10, -3)).toEqual([-3, -6, -9, -10])
  })

  it('clamps a zero step to the 0.01 mm minimum instead of looping forever', () => {
    const passes = zPasses(10, 0)
    // ~1000 passes at the 0.01 clamp (float drift may add one), never unbounded
    expect(passes.length).toBeGreaterThanOrEqual(1000)
    expect(passes.length).toBeLessThanOrEqual(1001)
    expect(passes[passes.length - 1]).toBe(-10)
  })

  it('clamps a NaN step to the 0.01 mm minimum', () => {
    const passes = zPasses(1, NaN)
    expect(passes.length).toBeGreaterThanOrEqual(100)
    expect(passes.length).toBeLessThanOrEqual(101)
    expect(passes[0]).toBe(-0.01)
    expect(passes[passes.length - 1]).toBe(-1)
  })

  it('treats NaN depth as zero depth', () => {
    expect(zPasses(NaN, 2)).toEqual([-0])
  })
})

describe('pointInPolygon', () => {
  const square: Pt2[] = [[0, 0], [10, 0], [10, 10], [0, 10]]

  it('detects interior points', () => {
    expect(pointInPolygon(5, 5, square)).toBe(true)
    expect(pointInPolygon(0.1, 9.9, square)).toBe(true)
  })

  it('rejects exterior points', () => {
    expect(pointInPolygon(-1, 5, square)).toBe(false)
    expect(pointInPolygon(11, 5, square)).toBe(false)
    expect(pointInPolygon(5, 20, square)).toBe(false)
  })

  it('works whether the polygon repeats the closing vertex or not', () => {
    const closed: Pt2[] = [...square, [0, 0]]
    expect(pointInPolygon(5, 5, closed)).toBe(true)
    expect(pointInPolygon(15, 5, closed)).toBe(false)
  })

  it('handles concave polygons (even-odd rule)', () => {
    // L-shape: notch at the top-right quadrant
    const ell: Pt2[] = [[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10]]
    expect(pointInPolygon(2, 8, ell)).toBe(true)
    expect(pointInPolygon(8, 8, ell)).toBe(false) // inside the notch
  })
})

describe('arcLengths / interpPt', () => {
  const pts: Pt2[] = [[0, 0], [3, 0], [3, 4]]

  it('accumulates cumulative lengths', () => {
    const { lens, total } = arcLengths(pts)
    expect(lens).toEqual([0, 3, 7])
    expect(total).toBe(7)
  })

  it('interpolates a point at a given arc length', () => {
    const { lens } = arcLengths(pts)
    const mid = interpPt(pts, lens, 5)
    expect(mid[0]).toBeCloseTo(3)
    expect(mid[1]).toBeCloseTo(2)
  })

  it('clamps s to the polyline ends', () => {
    const { lens } = arcLengths(pts)
    expect(interpPt(pts, lens, -5)).toEqual([0, 0])
    expect(interpPt(pts, lens, 100)).toEqual([3, 4])
  })
})

describe('stripClosingDuplicate', () => {
  it('drops a duplicated closing vertex', () => {
    const pts: Pt2[] = [[0, 0], [10, 0], [10, 10], [0, 0]]
    expect(stripClosingDuplicate(pts)).toEqual([[0, 0], [10, 0], [10, 10]])
  })

  it('leaves an open polyline untouched', () => {
    const pts: Pt2[] = [[0, 0], [10, 0], [10, 10]]
    expect(stripClosingDuplicate(pts)).toBe(pts)
  })
})

describe('ptSegDistSq', () => {
  it('measures perpendicular distance to the segment interior', () => {
    expect(ptSegDistSq(5, 3, 0, 0, 10, 0)).toBeCloseTo(9)
  })

  it('clamps to the nearest endpoint beyond the segment', () => {
    expect(ptSegDistSq(13, 4, 0, 0, 10, 0)).toBeCloseTo(25)
  })

  it('handles a degenerate zero-length segment', () => {
    expect(ptSegDistSq(3, 4, 1, 1, 1, 1)).toBeCloseTo(13)
  })
})

describe('toolRadiusAtHeight', () => {
  it('is constant for flat-bottomed tools', () => {
    const em = mkTool({ type: 'endmill', diameterMM: 6 })
    expect(toolRadiusAtHeight(em, 0)).toBe(3)
    expect(toolRadiusAtHeight(em, 0.5)).toBe(3)
    expect(toolRadiusAtHeight(em, 100)).toBe(3)
  })

  it('follows the cone of a V-bit, then the shank', () => {
    // 90° included → 45° half-angle → radius equals depth until the shank.
    const v90 = mkTool({ type: 'vbit', diameterMM: 6, vbitAngleDeg: 90 })
    expect(toolRadiusAtHeight(v90, 1)).toBeCloseTo(1)
    expect(toolRadiusAtHeight(v90, 2.5)).toBeCloseTo(2.5)
    expect(toolRadiusAtHeight(v90, 10)).toBeCloseTo(3)   // capped at the full radius
    // 60° included → 30° half-angle.
    const v60 = mkTool({ type: 'vbit', diameterMM: 6.35, vbitAngleDeg: 60 })
    expect(toolRadiusAtHeight(v60, 2)).toBeCloseTo(2 * Math.tan(Math.PI / 6))
  })

  it('follows the ball of a ball nose, then the shank', () => {
    const ball = mkTool({ type: 'ballnose', diameterMM: 6 })
    expect(toolRadiusAtHeight(ball, 0)).toBeCloseTo(0)
    expect(toolRadiusAtHeight(ball, 3)).toBeCloseTo(3)   // equator
    expect(toolRadiusAtHeight(ball, 1)).toBeCloseTo(Math.sqrt(5))
    expect(toolRadiusAtHeight(ball, 20)).toBeCloseTo(3)
  })

  it('clamps a negative height and survives a degenerate V angle', () => {
    expect(toolRadiusAtHeight(mkTool({ type: 'ballnose', diameterMM: 6 }), -1)).toBe(0)
    expect(toolRadiusAtHeight(mkTool({ type: 'vbit', diameterMM: 6, vbitAngleDeg: 0 }), 5)).toBe(3)
    expect(toolRadiusAtHeight(mkTool({ type: 'vbit', diameterMM: 6, vbitAngleDeg: 180 }), 5)).toBe(3)
  })
})
