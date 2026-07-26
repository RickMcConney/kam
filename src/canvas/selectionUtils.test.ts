import { describe, it, expect } from 'vitest'
import { getBBox, getMultiBBox, translateD, scaleAroundD, rotateAroundD, mirrorD } from './selectionUtils'

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
