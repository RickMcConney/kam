import { describe, it, expect } from 'vitest'
import {
  parseDToNodes,
  nodesToD,
  removeNode,
  insertNodeOnSegment,
  nearestSegmentOnPath,
  weldNodes,
  splitCompoundPath,
  type PathNode,
} from './nodeUtils'

describe('parseDToNodes', () => {
  it('parses a closed polygon', () => {
    const { nodes, closed } = parseDToNodes('M0,0 L10,0 L10,5 Z')
    expect(closed).toBe(true)
    expect(nodes).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
    ])
  })

  it('parses an open polyline', () => {
    const { nodes, closed } = parseDToNodes('M0,0 L10,0 L10,5')
    expect(closed).toBe(false)
    expect(nodes.length).toBe(3)
  })

  it('detects implicit close when the last node returns to the start', () => {
    const { nodes, closed } = parseDToNodes('M0,0 L10,0 L5,5 L0,0')
    expect(closed).toBe(true)
    expect(nodes.length).toBe(3) // coincident closing node dropped
  })

  it('attaches cubic control points as handles', () => {
    const { nodes } = parseDToNodes('M0,0 C1,2 3,4 5,6')
    expect(nodes[0].handleOut).toEqual({ x: 1, y: 2 })
    expect(nodes[1].handleIn).toEqual({ x: 3, y: 4 })
    expect(nodes[1].x).toBe(5)
    expect(nodes[1].y).toBe(6)
  })
})

describe('nodesToD round-trip', () => {
  it('is structurally stable through parse → stringify → parse', () => {
    const d = 'M 0 0 C 1 2 3 4 5 6 L 10 0 Z'
    const first = parseDToNodes(d)
    const second = parseDToNodes(nodesToD(first.nodes, first.closed))
    expect(second.closed).toBe(first.closed)
    expect(second.nodes).toEqual(first.nodes)
  })

  it('emits L for handle-less segments and C when either handle exists', () => {
    const nodes: PathNode[] = [
      { x: 0, y: 0, handleOut: { x: 1, y: 1 } },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ]
    const d = nodesToD(nodes, false)
    expect(d).toBe('M 0 0 C 1 1 5 0 5 0 L 10 0')
  })

  it('closes with Z for straight closing segments', () => {
    const nodes: PathNode[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }]
    expect(nodesToD(nodes, true)).toBe('M 0 0 L 10 0 L 5 5 Z')
  })
})

describe('removeNode', () => {
  it('removes the node at the index', () => {
    const nodes: PathNode[] = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }]
    expect(removeNode(nodes, 1)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }])
  })
})

describe('insertNodeOnSegment', () => {
  it('inserts on a straight segment at the clicked point without inventing handles', () => {
    const nodes: PathNode[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }]
    const out = insertNodeOnSegment(nodes, 0, 5, 0.2, false)
    expect(out.length).toBe(3)
    expect(out[0]).toEqual({ x: 0, y: 0, handleOut: undefined })
    expect(out[2]).toEqual({ x: 10, y: 0, handleIn: undefined })
    expect(out[1].x).toBeCloseTo(5, 1)
    expect(out[1].y).toBeCloseTo(0)
    expect(out[1].handleIn).toBeUndefined()
    expect(out[1].handleOut).toBeUndefined()
  })

  it('splits a curved segment keeping endpoints fixed and adding handles', () => {
    const nodes: PathNode[] = [
      { x: 0, y: 0, handleOut: { x: 3, y: 5 } },
      { x: 10, y: 0, handleIn: { x: 7, y: 5 } },
    ]
    const out = insertNodeOnSegment(nodes, 0, 5, 3.75, false)
    expect(out.length).toBe(3)
    expect(out[0].x).toBe(0)
    expect(out[2].x).toBe(10)
    // symmetric curve, click at the apex → midpoint of the cubic at t=0.5
    expect(out[1].x).toBeCloseTo(5, 1)
    expect(out[1].y).toBeCloseTo(3.75, 1)
    expect(out[1].handleIn).toBeDefined()
    expect(out[1].handleOut).toBeDefined()
  })

  it('rejects the nonexistent wrap segment of an open path', () => {
    const nodes: PathNode[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }]
    expect(insertNodeOnSegment(nodes, 1, 5, 0, false)).toBe(nodes)
  })
})

describe('nearestSegmentOnPath', () => {
  const square: PathNode[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ]

  it('finds the nearest side of a closed square', () => {
    expect(nearestSegmentOnPath(square, true, 5, -1)?.segIdx).toBe(0)
    expect(nearestSegmentOnPath(square, true, 11, 5)?.segIdx).toBe(1)
    // closing segment (left side) only exists because the path is closed
    expect(nearestSegmentOnPath(square, true, -1, 5)?.segIdx).toBe(3)
  })

  it('excludes the closing segment for open paths', () => {
    const res = nearestSegmentOnPath(square, false, -1, 5)
    expect(res?.segIdx).not.toBe(3)
  })

  it('returns null for a single node', () => {
    expect(nearestSegmentOnPath([{ x: 0, y: 0 }], false, 0, 0)).toBeNull()
  })
})

describe('weldNodes', () => {
  it('welding the two endpoints of an open path closes it', () => {
    const nodes: PathNode[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0.1, y: 0.1 },
    ]
    const res = weldNodes(nodes, 3, 0, false)
    expect(res.closed).toBe(true)
    expect(res.nodes.length).toBe(3)
    // merged node sits at the target's position
    expect(res.nodes[0]).toMatchObject({ x: 0, y: 0 })
  })
})

describe('splitCompoundPath', () => {
  it('splits at each M into subpath d strings', () => {
    const parts = splitCompoundPath('M0,0 L10,0 Z M20,20 L30,20')
    expect(parts.length).toBe(2)
    expect(parts[0].startsWith('M')).toBe(true)
    expect(parts[1]).toContain('20')
  })

  it('returns a single entry for a simple path', () => {
    expect(splitCompoundPath('M0,0 L10,0 Z').length).toBe(1)
  })
})
