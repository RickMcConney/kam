import { describe, it, expect } from 'vitest'
import { generateMazeD, mazeGrid } from './mazeGenerator'
import { generateShapeD } from './shapeGenerators'
import { flattenPath } from '../cam/pathFlattener'
import { getBBox } from '../canvas/selectionUtils'

const base = { x: 10, y: 20, w: 150, h: 120, spacing: 12, corner: 4, seed: 1, loops: 0 }

// Walk the emitted geometry back into the corridor graph it stands for. Only
// valid with corner=0: with fillets on, a turn's vertices sit off the grid.
// Straight runs are collapsed into one segment, so each is expanded again.
function graphOf(p: typeof base) {
  const g = mazeGrid(p.w, p.h, p.spacing)
  const polys = flattenPath(generateMazeD({ ...p, corner: 0 }), 0.05)
  const cells = new Set<number>()
  const links = new Map<string, number>()
  let offGrid = 0
  for (const poly of polys) {
    let prev: number | null = null
    for (const [x, y] of poly) {
      const i = Math.round((x - p.x) / g.dx), j = Math.round((y - p.y) / g.dy)
      if (Math.abs(p.x + i * g.dx - x) > 1e-6 || Math.abs(p.y + j * g.dy - y) > 1e-6) offGrid++
      const n = j * g.cols + i
      cells.add(n)
      if (prev !== null && prev !== n) {
        const pi = prev % g.cols, pj = (prev - pi) / g.cols
        const step = pj === j ? Math.sign(i - pi) : Math.sign(j - pj) * g.cols
        for (let a: number = prev; a !== n; a += step) {
          const b = a + step
          cells.add(a); cells.add(b)
          const k = a < b ? `${a}-${b}` : `${b}-${a}`
          links.set(k, (links.get(k) ?? 0) + 1)
        }
      }
      prev = n
    }
  }
  return { g, cells, links, offGrid, trails: polys.length }
}

describe('mazeGrid', () => {
  it('rounds the pitch UP from the requested spacing, never down', () => {
    // Thin walls are the failure that breaks the part, so the pitch may only
    // ever err coarse.
    for (const w of [50, 97.3, 150, 301]) {
      for (const s of [3, 7.5, 12, 25.4]) {
        const g = mazeGrid(w, w, s)
        expect(g.dx, `${w}mm at ${s}mm spacing`).toBeGreaterThanOrEqual(s - 1e-9)
      }
    }
  })

  it('caps the cell count by coarsening, never by cropping', () => {
    const g = mazeGrid(1200, 1200, 0.5)
    expect(g.cols * g.rows).toBeLessThanOrEqual(6000)
    expect(g.dx).toBeGreaterThan(0.5)
    expect(g.dx * (g.cols - 1)).toBeCloseTo(1200, 6)   // still spans the full size
  })

  it('always has at least a 2×2 grid', () => {
    const g = mazeGrid(5, 5, 50)
    expect(g.cols).toBe(2)
    expect(g.rows).toBe(2)
  })
})

describe('generateMazeD', () => {
  it('reaches every cell and cuts each corridor exactly once', () => {
    for (const seed of [1, 7, 42, 1234]) {
      const { g, cells, links, offGrid } = graphOf({ ...base, seed })
      expect(cells.size, `seed ${seed}`).toBe(g.cols * g.rows)
      // A spanning tree over N cells has exactly N−1 corridors…
      expect(links.size, `seed ${seed}`).toBe(g.cols * g.rows - 1)
      // …and no trail may retrace one (that would be air-cutting an open groove).
      expect([...links.values()].every((v) => v === 1), `seed ${seed}`).toBe(true)
      expect(offGrid).toBe(0)
    }
  })

  it('braiding adds corridors without stranding a cell', () => {
    const plain = graphOf(base)
    const braided = graphOf({ ...base, loops: 0.6 })
    expect(braided.cells.size).toBe(plain.cells.size)
    expect(braided.links.size).toBeGreaterThan(plain.links.size)
    expect([...braided.links.values()].every((v) => v === 1)).toBe(true)
  })

  it('is a pure function of the seed', () => {
    expect(generateMazeD(base)).toBe(generateMazeD({ ...base }))
    expect(generateMazeD({ ...base, seed: 2 })).not.toBe(generateMazeD(base))
  })

  it('spans exactly x..x+w / y..y+h', () => {
    // The drag box IS the maze extent — shapeParamsFromDrag depends on it.
    const b = getBBox(generateMazeD({ ...base, corner: 0 }))!
    expect(b.minX).toBeCloseTo(base.x, 6)
    expect(b.minY).toBeCloseTo(base.y, 6)
    expect(b.maxX).toBeCloseTo(base.x + base.w, 6)
    expect(b.maxY).toBeCloseTo(base.y + base.h, 6)
  })

  it('every branch end meets the corridor it joins', () => {
    // A filleted turn leaves the junction a tangent length short, so a branch
    // that merely stopped at the cell centre would end `corner` mm from the arc
    // — a gap the ball only grazes, leaving a ridge across the branch mouth.
    // The only ends allowed to stand free are real dead ends.
    for (const corner of [2, 4, 6]) {
      for (const seed of [1, 7, 42]) {
        const p = { ...base, corner, seed }
        const polys = flattenPath(generateMazeD(p), 0.02)
        const g = mazeGrid(p.w, p.h, p.spacing)
        // Cell degree, straight off the reconstructed graph.
        const deg = new Map<string, number>()
        for (const k of graphOf(p).links.keys())
          for (const n of k.split('-')) deg.set(n, (deg.get(n) ?? 0) + 1)
        expect([...deg.values()].filter((v) => v === 1).length).toBeGreaterThan(0)

        for (let a = 0; a < polys.length; a++) {
          for (const end of [polys[a][0], polys[a][polys[a].length - 1]]) {
            const i = Math.round((end[0] - p.x) / g.dx)
            const j = Math.round((end[1] - p.y) / g.dy)
            const onCentre = Math.hypot(p.x + i * g.dx - end[0], p.y + j * g.dy - end[1]) < 1e-6
            if (onCentre && deg.get(String(j * g.cols + i)) === 1) continue  // real dead end
            let best = Infinity
            for (let b = 0; b < polys.length; b++) {
              if (b === a) continue
              for (let k = 1; k < polys[b].length; k++) {
                const [x1, y1] = polys[b][k - 1], [x2, y2] = polys[b][k]
                const vx = x2 - x1, vy = y2 - y1
                const L2 = vx * vx + vy * vy
                const t = L2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((end[0] - x1) * vx + (end[1] - y1) * vy) / L2))
                best = Math.min(best, Math.hypot(end[0] - (x1 + t * vx), end[1] - (y1 + t * vy)))
              }
            }
            // Flattening tolerance is 0.02, so touching reads as ~0.
            expect(best, `corner=${corner} seed=${seed} end ${end}`).toBeLessThan(0.05)
          }
        }
      }
    }
  })

  it('emits open subpaths — it is a skeleton, not an outline', () => {
    expect(generateMazeD(base)).not.toMatch(/Z/)
  })

  it('never fillets wider than half the pitch', () => {
    // A bigger arc would swing the centreline into the neighbouring corridor
    // and cut through the wall between them.
    const g = mazeGrid(base.w, base.h, base.spacing)
    const cap = Math.min(g.dx, g.dy) / 2
    const d = generateMazeD({ ...base, corner: 500 })
    const radii = [...d.matchAll(/A([\d.]+),/g)].map((m) => parseFloat(m[1]))
    expect(radii.length).toBeGreaterThan(0)
    expect(Math.max(...radii)).toBeLessThanOrEqual(cap + 1e-9)
  })

  it('is reachable through generateShapeD', () => {
    expect(generateShapeD({ type: 'maze', ...base })).toBe(generateMazeD(base))
  })
})
