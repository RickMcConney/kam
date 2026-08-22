import { describe, it, expect } from 'vitest'
import {
  getBBox, getMultiBBox, translateD, scaleAroundD, rotateAroundD, mirrorD, skewAroundD,
  extractCircles, extractRectInfo, isPlacementOnly, gestureForSteps, consolidateSteps,
  foldPlacement, applyPlacementD, applyTransformSteps, transformPoint, type TransformStep,
} from './selectionUtils'
import type { ImportedPath } from '../store/pathsStore'

const rect = 'M0,0 L10,0 L10,5 L0,5 Z' // 10×5 rect at origin, CNC mm Y-up

function bboxOf(d: string) {
  const b = getBBox(d)
  expect(b).not.toBeNull()
  return b!
}

describe('getBBox', () => {
  it('computes the bounds of a polygon path', () => {
    const b = bboxOf(rect)
    expect(b.minX).toBeCloseTo(0)
    expect(b.maxX).toBeCloseTo(10)
    expect(b.minY).toBeCloseTo(0)
    expect(b.maxY).toBeCloseTo(5)
    expect(b.width).toBeCloseTo(10)
    expect(b.height).toBeCloseTo(5)
    expect(b.cx).toBeCloseTo(5)
    expect(b.cy).toBeCloseTo(2.5)
  })

  it('returns null for an empty d string', () => {
    expect(getBBox('')).toBeNull()
  })
})

describe('getMultiBBox', () => {
  it('unions the bounds of several paths', () => {
    const other = 'M20,10 L30,10 L30,20 L20,20 Z'
    const b = getMultiBBox([rect, other])!
    expect(b.minX).toBeCloseTo(0)
    expect(b.maxX).toBeCloseTo(30)
    expect(b.minY).toBeCloseTo(0)
    expect(b.maxY).toBeCloseTo(20)
  })

  it('returns null when no path yields a bbox', () => {
    expect(getMultiBBox([''])).toBeNull()
  })
})

describe('translateD', () => {
  it('shifts the path in CNC mm', () => {
    const b = bboxOf(translateD(rect, 3, -2))
    expect(b.minX).toBeCloseTo(3)
    expect(b.maxX).toBeCloseTo(13)
    expect(b.minY).toBeCloseTo(-2)
    expect(b.maxY).toBeCloseTo(3)
  })
})

describe('scaleAroundD', () => {
  it('scales around the given anchor', () => {
    const b = bboxOf(scaleAroundD(rect, 0, 0, 2, 3))
    expect(b.maxX).toBeCloseTo(20)
    expect(b.maxY).toBeCloseTo(15)
    expect(b.minX).toBeCloseTo(0)
    expect(b.minY).toBeCloseTo(0)
  })

  it('leaves the anchor point fixed', () => {
    // anchor at the rect center: bbox center must not move
    const b = bboxOf(scaleAroundD(rect, 5, 2.5, 2, 2))
    expect(b.cx).toBeCloseTo(5)
    expect(b.cy).toBeCloseTo(2.5)
  })
})

describe('rotateAroundD', () => {
  it('rotates CCW-positive in CNC Y-up space', () => {
    // 90° CCW about origin maps (x,y) → (-y,x): x∈[0,10],y∈[0,5] → x∈[-5,0],y∈[0,10]
    const b = bboxOf(rotateAroundD(rect, 0, 0, 90))
    expect(b.minX).toBeCloseTo(-5)
    expect(b.maxX).toBeCloseTo(0)
    expect(b.minY).toBeCloseTo(0)
    expect(b.maxY).toBeCloseTo(10)
  })

  it('is identity at 360°', () => {
    const b = bboxOf(rotateAroundD(rect, 3, 3, 360))
    expect(b.minX).toBeCloseTo(0)
    expect(b.maxX).toBeCloseTo(10)
    expect(b.minY).toBeCloseTo(0)
    expect(b.maxY).toBeCloseTo(5)
  })
})

describe('mirrorD', () => {
  it("axis 'x' flips horizontally about cx", () => {
    const b = bboxOf(mirrorD(rect, 'x', 0, 0))
    expect(b.minX).toBeCloseTo(-10)
    expect(b.maxX).toBeCloseTo(0)
    expect(b.minY).toBeCloseTo(0)
    expect(b.maxY).toBeCloseTo(5)
  })

  it("axis 'y' flips vertically about cy", () => {
    const b = bboxOf(mirrorD(rect, 'y', 0, 10))
    expect(b.minY).toBeCloseTo(15)
    expect(b.maxY).toBeCloseTo(20)
    expect(b.minX).toBeCloseTo(0)
    expect(b.maxX).toBeCloseTo(10)
  })
})


// ─── Reading shapes back out of a d string ────────────────────────────────────

/** A circle as the importer writes one: two semicircular arcs and a close. */
const circleD = (cx: number, cy: number, r: number) =>
  `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`

const asPath = (d: string, extra: Partial<ImportedPath> = {}): ImportedPath =>
  ({ id: 'p1', name: 'p', d, color: '#fff', visible: true, ...extra }) as ImportedPath

describe('extractCircles', () => {
  it('finds a lone circle', () => {
    expect(extractCircles(asPath(circleD(10, 10, 5))))
      .toEqual([{ cx: 10, cy: 10, radiusMM: 5 }])
  })

  it('finds EVERY hole of a pin ring, not one hole the size of the ring', () => {
    // A path is not a hole. A pinion's pin ring is six round subpaths under one id, and
    // taking the circle from the WHOLE path's bounding box is not a near miss — it is a
    // Ø40 bore at the arbor where six Ø6 holes should be, and it looks like a perfectly
    // plausible toolpath.
    const ring = [0, 60, 120, 180, 240, 300]
      .map((a) => circleD(30 + 20 * Math.cos((a * Math.PI) / 180), 30 + 20 * Math.sin((a * Math.PI) / 180), 3))
      .join(' ')
    const holes = extractCircles(asPath(ring))
    expect(holes).toHaveLength(6)
    for (const h of holes) {
      expect(h.radiusMM).toBeCloseTo(3, 6)
      expect(Math.hypot(h.cx - 30, h.cy - 30)).toBeCloseTo(20, 6)   // on the pin circle
    }
  })

  it('trusts shapeParams only when the path really is ONE subpath', () => {
    // Every part of a multi-part shape carries the SHAPE's params, so a params check
    // alone would let one set of numbers speak for a whole ring of holes. The guard is
    // the subpath count, and the geometry has to win when they disagree.
    const ring = [0, 120, 240]
      .map((a) => circleD(30 + 20 * Math.cos((a * Math.PI) / 180), 30 + 20 * Math.sin((a * Math.PI) / 180), 3))
      .join(' ')
    const circleParams = { type: 'circle', cx: 30, cy: 30, radius: 23 } as unknown as ImportedPath['shapeParams']
    const holes = extractCircles(asPath(ring, { shapeParams: circleParams }))
    expect(holes).toHaveLength(3)
    for (const h of holes) expect(h.radiusMM).toBeCloseTo(3, 6)   // the pins, not the ring

    // And a gear's own params, which name no circle at all, simply fall through.
    const gearParams = { type: 'gear', module: 4, teeth: 24 } as unknown as ImportedPath['shapeParams']
    expect(extractCircles(asPath(ring, { shapeParams: gearParams }))).toHaveLength(3)
  })

  it('takes a single-subpath circle from its params, exactly', () => {
    // Params are the canonical geometry — no bbox rounding, no arc flattening.
    const params = { type: 'circle', cx: 7, cy: 8, radius: 9 } as unknown as ImportedPath['shapeParams']
    expect(extractCircles(asPath('M 0 0 L 1 0', { shapeParams: params })))
      .toEqual([{ cx: 7, cy: 8, radiusMM: 9 }])
  })

  it('accepts a near-round ellipse and refuses an oval one', () => {
    const ell = (rx: number, ry: number) =>
      ({ type: 'ellipse', cx: 1, cy: 2, rx, ry }) as unknown as ImportedPath['shapeParams']
    expect(extractCircles(asPath('M 0 0 L 1 0', { shapeParams: ell(5, 5.1) })))
      .toEqual([{ cx: 1, cy: 2, radiusMM: 5.05 }])
    expect(extractCircles(asPath('M 0 0 L 1 0', { shapeParams: ell(5, 9) }))).toEqual([])
  })

  it('ignores subpaths that are not round, and keeps the ones that are', () => {
    const mixed = `${circleD(10, 10, 4)} M 40 0 L 80 0 L 80 6 L 40 6 Z ${circleD(100, 10, 4)}`
    const holes = extractCircles(asPath(mixed))
    expect(holes.map((h) => h.cx)).toEqual([10, 100])
  })

  it('reads any square-ish outline as a circle — a bounding-box test cannot tell', () => {
    // KNOWN LIMITATION, pinned so a change to it is deliberate. circleFromD compares the
    // bbox's two half-extents and nothing else, so a square, a diamond or a plus all pass.
    // Selecting one and drilling it bores a hole of its half-width rather than reporting
    // that it is not round.
    expect(extractCircles(asPath('M0 0 L10 0 L10 10 L0 10 Z')))
      .toEqual([{ cx: 5, cy: 5, radiusMM: 5 }])
  })
})

describe('extractRectInfo', () => {
  it('reads an axis-aligned rectangle', () => {
    expect(extractRectInfo('M 10 20 L 60 20 L 60 50 L 10 50 Z'))
      .toEqual({ p0: { x: 10, y: 20 }, widthMM: 50, heightMM: 30, rotationDeg: 0 })
  })

  it('measures a rotated rectangle along its EDGES, not its bounding box', () => {
    // This is what makes the carve agree with the canvas: DesignLayer and the photo
    // V-carve both place the picture through this one function, so a rotated photo is
    // carved where it is drawn. A bbox would report a bigger, un-rotated rectangle.
    const c = 40 * Math.SQRT1_2
    const info = extractRectInfo(`M 0 0 L ${c} ${c} L ${c - 14.142} ${c + 14.142} L -14.142 14.142 Z`)!
    expect(info.rotationDeg).toBeCloseTo(45, 6)
    expect(info.widthMM).toBeCloseTo(40, 4)
    expect(info.heightMM).toBeCloseTo(20, 3)
    expect(info.p0).toEqual({ x: 0, y: 0 })
  })

  it('returns null for anything that is not four corners', () => {
    expect(extractRectInfo('M 0 0 L 10 0 L 10 10')).toBeNull()
    expect(extractRectInfo('')).toBeNull()
  })

  it('returns null for a degenerate edge', () => {
    expect(extractRectInfo('M 0 0 L 0 0 L 10 0 L 10 10 Z')).toBeNull()
  })
})

// ─── Placement recipes ────────────────────────────────────────────────────────

const T = (dx: number, dy: number): TransformStep => ({ kind: 'translate', dx, dy })
const R = (angle: number, cx = 5, cy = 5): TransformStep => ({ kind: 'rotate', angle, cx, cy })
const S = (s: number, ax = 5, ay = 5): TransformStep => ({ kind: 'scale', sx: s, sy: s, ax, ay })
const MIR = (axis: 'x' | 'y', cx = 5, cy = 5): TransformStep => ({ kind: 'mirror', axis, cx, cy })
const SK = (kx: number, ky: number): TransformStep => ({ kind: 'skew', kx, ky, ax: 0, ay: 0 })
const SQ = 'M0 0 L10 0 L10 10 L0 10 Z'

describe('isPlacementOnly', () => {
  it('counts the gestures that move a part without changing what it IS', () => {
    expect(isPlacementOnly([T(1, 2)])).toBe(true)
    expect(isPlacementOnly([R(30)])).toBe(true)
    expect(isPlacementOnly([MIR('x')])).toBe(true)
    expect(isPlacementOnly([SK(0.2, 0)])).toBe(true)
    expect(isPlacementOnly([T(1, 2), R(30)])).toBe(true)
  })

  it('excludes scale, which edits the DEFINITION', () => {
    // Scaling a gear scales its module, so a scale is not a placement — it goes on
    // rewriting shapeParams. One scale anywhere in the chain disqualifies the lot.
    expect(isPlacementOnly([S(2)])).toBe(false)
    expect(isPlacementOnly([T(1, 2), S(2)])).toBe(false)
  })

  it('is false for nothing at all', () => {
    expect(isPlacementOnly([])).toBe(false)
    expect(isPlacementOnly(undefined)).toBe(false)
  })
})

describe('gestureForSteps', () => {
  it('names a single gesture and calls a mixed chain a transform', () => {
    expect(gestureForSteps([T(1, 1)])).toBe('move')
    expect(gestureForSteps([R(10)])).toBe('rotate')
    expect(gestureForSteps([S(2)])).toBe('scale')
    expect(gestureForSteps([MIR('y')])).toBe('mirror')
    expect(gestureForSteps([SK(0.1, 0)])).toBe('skew')
    expect(gestureForSteps([T(1, 1), R(10)])).toBe('transform')
  })
})

describe('consolidateSteps', () => {
  const bbox = getBBox(SQ)!

  it('merges a session of dragging into one step', () => {
    expect(consolidateSteps([T(5, 0), T(3, 0)], bbox)).toEqual([{ kind: 'translate', dx: 8, dy: 0 }])
  })

  it('leaves an empty chain empty', () => {
    expect(consolidateSteps([], bbox)).toEqual([])
  })

  it('composes a mixed chain into the SAME map it started as', () => {
    // The point of consolidating: one canonical recipe, not a growing list — and the
    // geometry must be untouched by the rewrite.
    const chain = [T(10, 0), R(45), S(2)]
    const before = getBBox(applyTransformSteps({ d: SQ }, chain).d)!
    const after = getBBox(applyTransformSteps({ d: SQ }, consolidateSteps(chain, bbox)).d)!
    expect(after).toEqual(before)
  })

  it('sums rotations about a shared pivot', () => {
    const out = consolidateSteps([R(90), R(90)], bbox)
    expect(out[0]).toMatchObject({ kind: 'rotate', angle: 180, cx: 5, cy: 5 })
  })
})

describe('foldPlacement', () => {
  it('starts a placement from nothing', () => {
    expect(foldPlacement({ d: SQ }, [T(1, 1)])).toEqual([{ kind: 'translate', dx: 1, dy: 1 }])
  })

  it('adds a drag to the placement already there, still as one step', () => {
    // A part dragged twice has moved once, as far as the recipe is concerned.
    expect(foldPlacement({ d: SQ, placement: [T(1, 1)] }, [T(2, 2)]))
      .toEqual([{ kind: 'translate', dx: 3, dy: 3 }])
  })

  it('keeps a mixed placement consolidated rather than growing a list', () => {
    const out = foldPlacement({ d: SQ, placement: [T(1, 1)] }, [R(90)])
    expect(out).toHaveLength(2)
    expect(out.map((s) => s.kind)).toEqual(['rotate', 'translate'])
  })
})

describe('applyPlacementD', () => {
  it('is the identity when a part has never been moved', () => {
    expect(applyPlacementD(SQ, undefined)).toBe(SQ)
    expect(applyPlacementD(SQ, [])).toBe(SQ)
  })

  it('bakes the recipe into the d string', () => {
    expect(getBBox(applyPlacementD(SQ, [T(5, 3)])!)).toMatchObject({ minX: 5, minY: 3, maxX: 15, maxY: 13 })
  })
})

describe('transformPoint', () => {
  it('moves a point the same way each gesture moves geometry', () => {
    expect(transformPoint(1, 1, { kind: 'translate', dx: 2, dy: 3 })).toEqual({ x: 3, y: 4 })
    const r = transformPoint(1, 0, { kind: 'rotate', angle: 90, cx: 0, cy: 0 })
    expect(r.x).toBeCloseTo(0, 9)
    expect(r.y).toBeCloseTo(1, 9)   // CCW-positive in CNC Y-up
    expect(transformPoint(2, 2, { kind: 'scale', sx: 3, sy: 3, ax: 0, ay: 0 })).toEqual({ x: 6, y: 6 })
    expect(transformPoint(2, 2, { kind: 'skew', kx: 0.5, ky: 0, ax: 0, ay: 0 })).toEqual({ x: 3, y: 2 })
  })
})

describe('skewAroundD', () => {
  it('shears about the anchor, leaving points on it fixed', () => {
    expect(skewAroundD(SQ, 0.5, 0, 0, 0)).toBe('M0,0 L10,0 L15,10 L5,10 Z')
  })
})
