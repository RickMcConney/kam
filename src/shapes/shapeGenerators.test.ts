import { describe, it, expect } from 'vitest'
import { generateShapeD, translateShapeParams, scaleShapeParams, type ShapeParams } from './shapeGenerators'
import { getBBox } from '../canvas/selectionUtils'
import { flattenPath, signedArea } from '../cam/pathFlattener'
import { stripClosingDuplicate } from '../cam/geom'

// Winding of the generated outline in CNC Y-up space (positive area = CCW)
function outlineArea(d: string): number {
  const polys = flattenPath(d, 0.05)
  expect(polys.length).toBeGreaterThan(0)
  return signedArea(stripClosingDuplicate(polys[0]))
}

describe('generateShapeD', () => {
  it('rectangle emits the exact CCW polygon', () => {
    const d = generateShapeD({ type: 'rectangle', x: 0, y: 0, w: 50, h: 30 })
    expect(d).toBe('M0,0 L50,0 L50,30 L0,30 Z')
  })

  it('polygon-based shapes trace CCW in CNC Y-up', () => {
    const shapes: ShapeParams[] = [
      { type: 'rectangle', x: 0, y: 0, w: 50, h: 30 },
      { type: 'roundrect', x: 0, y: 0, w: 50, h: 30, r: 5 },
      { type: 'polygon', cx: 0, cy: 0, radius: 20, sides: 6 },
      { type: 'star', cx: 0, cy: 0, outerRadius: 20, innerRadius: 8, points: 5 },
    ]
    for (const p of shapes) {
      expect(outlineArea(generateShapeD(p)), `${p.type} should be CCW`).toBeGreaterThan(0)
    }
  })

  it('circle and ellipse (sweep=0 arcs) trace CW in CNC Y-up', () => {
    // Direction is irrelevant for these downstream (CLAUDE.md), but the
    // winding the generator emits is CW — pin it so a change is deliberate.
    expect(outlineArea(generateShapeD({ type: 'circle', cx: 0, cy: 0, radius: 20 }))).toBeLessThan(0)
    expect(outlineArea(generateShapeD({ type: 'ellipse', cx: 0, cy: 0, rx: 25, ry: 15 }))).toBeLessThan(0)
  })

  it('circle bbox spans cx±r / cy±r', () => {
    const b = getBBox(generateShapeD({ type: 'circle', cx: 10, cy: 20, radius: 5 }))!
    expect(b.minX).toBeCloseTo(5, 1)
    expect(b.maxX).toBeCloseTo(15, 1)
    expect(b.minY).toBeCloseTo(15, 1)
    expect(b.maxY).toBeCloseTo(25, 1)
  })

  it('circle area matches πr² after flattening', () => {
    // flattened polygon is inscribed, so slightly under the true area
    const area = Math.abs(outlineArea(generateShapeD({ type: 'circle', cx: 0, cy: 0, radius: 10 })))
    expect(area).toBeGreaterThan(Math.PI * 100 * 0.99)
    expect(area).toBeLessThanOrEqual(Math.PI * 100)
  })

  it('polygon places the first vertex at the bottom (angle −90°)', () => {
    const d = generateShapeD({ type: 'polygon', cx: 0, cy: 0, radius: 10, sides: 6 })
    expect(d.startsWith('M0,-10')).toBe(true)
  })

  it('roundrect corner radius is clamped to half the smaller side', () => {
    // r=100 on a 50×30 rect must clamp to 15 — bbox still exactly w×h
    const b = getBBox(generateShapeD({ type: 'roundrect', x: 0, y: 0, w: 50, h: 30, r: 100 }))!
    expect(b.minX).toBeCloseTo(0, 1)
    expect(b.maxX).toBeCloseTo(50, 1)
    expect(b.minY).toBeCloseTo(0, 1)
    expect(b.maxY).toBeCloseTo(30, 1)
  })

  it('roundrect corners bulge outward (area between sharp rect and inscribed)', () => {
    const area = outlineArea(generateShapeD({ type: 'roundrect', x: 0, y: 0, w: 50, h: 30, r: 5 }))
    const sharp = 50 * 30
    const cornerLoss = (4 - Math.PI) * 5 * 5 // exact loss for 4 convex r=5 corners
    // flattening chords shave a little more off the rounded corners
    expect(area).toBeGreaterThan(sharp - cornerLoss - 2)
    expect(area).toBeLessThan(sharp - cornerLoss + 0.5)
  })
})

describe('translateShapeParams', () => {
  it('moves xy-anchored and center-anchored shapes alike', () => {
    expect(translateShapeParams({ type: 'rectangle', x: 1, y: 2, w: 5, h: 5 }, 10, -3))
      .toEqual({ type: 'rectangle', x: 11, y: -1, w: 5, h: 5 })
    expect(translateShapeParams({ type: 'circle', cx: 0, cy: 0, radius: 4 }, 2, 3))
      .toEqual({ type: 'circle', cx: 2, cy: 3, radius: 4 })
  })
})

describe('scaleShapeParams', () => {
  it('uniformly scales a circle around the anchor', () => {
    const p = scaleShapeParams({ type: 'circle', cx: 10, cy: 0, radius: 5 }, 0, 0, 2, 2)
    expect(p).toEqual({ type: 'circle', cx: 20, cy: 0, radius: 10 })
  })

  it('converts a circle to an ellipse under non-uniform scale', () => {
    const p = scaleShapeParams({ type: 'circle', cx: 0, cy: 0, radius: 5 }, 0, 0, 2, 1)
    expect(p).toEqual({ type: 'ellipse', cx: 0, cy: 0, rx: 10, ry: 5 })
  })

  it('returns null where the shape cannot represent a non-uniform scale', () => {
    expect(scaleShapeParams({ type: 'polygon', cx: 0, cy: 0, radius: 5, sides: 6 }, 0, 0, 2, 1)).toBeNull()
    expect(scaleShapeParams({ type: 'star', cx: 0, cy: 0, outerRadius: 5, innerRadius: 2, points: 5 }, 0, 0, 1, 3)).toBeNull()
  })

  it('normalizes a mirror scale so w/h stay positive and x/y stay the min corner', () => {
    const p = scaleShapeParams({ type: 'rectangle', x: 0, y: 0, w: 10, h: 5 }, 0, 0, -1, 1)
    expect(p).toEqual({ type: 'rectangle', x: -10, y: 0, w: 10, h: 5 })
  })

  it('re-clamps the roundrect radius after scaling', () => {
    const p = scaleShapeParams({ type: 'roundrect', x: 0, y: 0, w: 50, h: 30, r: 15 }, 0, 0, 1, 0.5)
    expect(p).toMatchObject({ w: 50, h: 15, r: 7.5 })
  })

  it('params scale in sync with the geometry (bbox agreement)', () => {
    const before: ShapeParams = { type: 'ellipse', cx: 10, cy: 10, rx: 5, ry: 3 }
    const after = scaleShapeParams(before, 0, 0, 2, 2)!
    // getBBox flattens at 0.5 mm tolerance, so bounds may fall short by up to ~0.6
    const b = getBBox(generateShapeD(after))!
    expect(b.cx).toBeCloseTo(20, 0)
    expect(b.cy).toBeCloseTo(20, 0)
    expect(b.width).toBeGreaterThan(19)
    expect(b.width).toBeLessThanOrEqual(20.01)
    expect(b.height).toBeGreaterThan(11)
    expect(b.height).toBeLessThanOrEqual(12.01)
  })
})
