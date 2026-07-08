// Poisson "temperature" field for the curvilinear-spiral pocket strategy.
//
// Solves −∆T = 1 with T = 0 on every wall (the eroded pocket boundary and every
// grown island) on a regular grid, by SOR. The solution is a smooth scalar field
// that is 0 at the walls and rises to local maxima along the pocket's medial
// ridge. Its level sets (isotherms, traced in marchingSquares.ts) are the
// structure curves of Bieterman's curvilinear spiral, and its maxima are the
// spiral seed points (where we helix in).
//
// All geometry is CNC mm, Y-up. The caller passes the tool-centre domain already
// offset: outer rings = boundary eroded by the tool radius, holes = islands grown
// by the tool radius.

import type { Pt2 } from './pathFlattener'

export interface FieldGrid {
  T: Float32Array        // temperature, 0 outside the domain
  inside: Uint8Array     // 1 where a cell centre is in the tool-centre domain
  gw: number
  gh: number
  x0: number             // CNC x of grid column 0
  y0: number             // CNC y of grid row 0
  cell: number           // cell size (mm)
  tMax: number
}

function pointInPolys(px: number, py: number, polys: Pt2[][]): boolean {
  // Even-odd over all rings: a point inside an odd number of rings is "in".
  let inside = false
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

// Rasterize the domain and solve the Poisson field.
//  outers — tool-centre boundary rings (boundary eroded by tool radius)
//  holes  — island rings grown by tool radius
export function solveField(outers: Pt2[][], holes: Pt2[][], cell: number): FieldGrid {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
  for (const poly of outers) for (const [x, y] of poly) {
    if (x < minx) minx = x; if (x > maxx) maxx = x
    if (y < miny) miny = y; if (y > maxy) maxy = y
  }
  if (!Number.isFinite(minx)) {
    return { T: new Float32Array(0), inside: new Uint8Array(0), gw: 0, gh: 0, x0: 0, y0: 0, cell, tMax: 0 }
  }
  // One-cell margin so the domain border has an outside (T=0) ring of cells.
  const x0 = minx - cell, y0 = miny - cell
  const gw = Math.ceil((maxx - minx) / cell) + 3
  const gh = Math.ceil((maxy - miny) / cell) + 3

  const inside = new Uint8Array(gw * gh)
  for (let iy = 0; iy < gh; iy++) {
    for (let ix = 0; ix < gw; ix++) {
      const px = x0 + ix * cell, py = y0 + iy * cell
      if (pointInPolys(px, py, outers) && !pointInPolys(px, py, holes)) inside[iy * gw + ix] = 1
    }
  }

  // SOR for −∆T = 1  ⇒  T_P = (T_E + T_W + T_N + T_S + h²) / 4. Cells outside the
  // domain hold T = 0 (Dirichlet), so they contribute 0 to interior neighbours.
  const T = new Float32Array(gw * gh)
  const h2 = cell * cell
  const omega = 1.85
  const maxIter = Math.min(20000, 30 * Math.max(gw, gh))
  const tol = 1e-4 * h2
  for (let iter = 0; iter < maxIter; iter++) {
    let maxDelta = 0
    for (let iy = 1; iy < gh - 1; iy++) {
      for (let ix = 1; ix < gw - 1; ix++) {
        const idx = iy * gw + ix
        if (!inside[idx]) continue
        const sum = T[idx - 1] + T[idx + 1] + T[idx - gw] + T[idx + gw]
        const tNew = (sum + h2) / 4
        const old = T[idx]
        const next = old + omega * (tNew - old)
        T[idx] = next
        const d = Math.abs(next - old)
        if (d > maxDelta) maxDelta = d
      }
    }
    if (maxDelta < tol) break
  }

  // Smooth out grid-scale variation along ridges. The Poisson solution has small
  // cell-to-cell wobble along a flat medial ridge (especially diagonal ones, which
  // the axis-aligned grid staircases); each bump would otherwise read as a separate
  // local maximum and spawn a redundant spiral. A few neighbour-averaging passes
  // (over interior cells only, so walls stay at 0) merge a ridge into one crest.
  for (let pass = 0; pass < 3; pass++) {
    const src = T.slice()
    for (let iy = 1; iy < gh - 1; iy++) {
      for (let ix = 1; ix < gw - 1; ix++) {
        const idx = iy * gw + ix
        if (!inside[idx]) continue
        let sum = src[idx], cnt = 1
        if (inside[idx - 1]) { sum += src[idx - 1]; cnt++ }
        if (inside[idx + 1]) { sum += src[idx + 1]; cnt++ }
        if (inside[idx - gw]) { sum += src[idx - gw]; cnt++ }
        if (inside[idx + gw]) { sum += src[idx + gw]; cnt++ }
        T[idx] = sum / cnt
      }
    }
  }

  let tMax = 0
  for (let i = 0; i < T.length; i++) if (T[i] > tMax) tMax = T[i]
  return { T, inside, gw, gh, x0, y0, cell, tMax }
}

