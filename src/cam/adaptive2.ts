// Adaptive2 — fast constant-engagement (adaptive) pocket clearing.
//
// A from-scratch replacement for the Adaptive2d port in ./adaptiveClearing.ts. The old engine
// maintains the cleared region as a Clipper polygon, so every engagement probe, lead path and
// link check is a boolean/offset op against geometry whose vertex count grows with everything
// cut so far — that is the measured superlinear blowup on large pockets.
//
// This engine keeps the cleared region as a fixed-resolution occupancy grid instead, so every
// query is O(local) and the total cost is linear in removed area:
//
//   engagement(p)   → sample the tool circumference against the grid (count uncut samples)
//   commit a step   → stamp the swept tool disk into the grid
//   link / re-seed  → exact distance transforms over the grid (O(cells), run rarely)
//
// The toolpath is GROWN, not offset: from a helix bore at the deepest point of the pocket the
// tool advances in small steps, and each step picks the turn angle whose circumferential
// engagement is closest to the target. Holding that equality makes the path follow the stock
// frontier outward as a spiral with constant radial engagement; when a corner pinches the
// engagement upward the best candidate turns away through cleared stock and re-approaches —
// the classic adaptive trochoidal corner loops emerge from the steering rule by themselves.
// When no stock is in sampling reach the engine floods a BFS "guide field" (distance to the
// nearest remaining stock, routed through the machinable region so it bends around islands)
// and descends it across the cleared floor — a stay-down link. It lifts and re-seeds with a
// fresh bore only when remaining stock is genuinely unreachable from the current position.
//
// All geometry in CNC mm. The only polygon op is one compound Clipper offset at setup (the
// tool-centre allowed region); islands are handled there and need no special cases afterward.

import { inflatePathsD, JoinType, EndType } from 'clipper2-ts'
import { signedArea, douglasPeucker, type Pt2 } from './pathFlattener'
import { distSqPtSeg } from './clearedRaster'

export interface Adaptive2Move {
  // 'cut' = engagement-controlled material removal; 'link' = stay-down traverse over
  // already-cleared floor (verified ~zero engagement while walking it).
  kind: 'cut' | 'link'
  pts: Pt2[]
}

export interface Adaptive2Region {
  helixCenter: Pt2
  /** Tool-centre radius of the entry bore; 0 ⇒ plunge entry at the first cut point. */
  helixRadiusMM: number
  moves: Adaptive2Move[]
}

export interface Adaptive2Params {
  toolDiameterMM: number
  /** Target radial engagement (the UI engagement % × tool diameter). */
  stepoverMM: number
  /** Spiral winding: CCW = conventional for an inside pocket (codebase convention). */
  wantCCW: boolean
  /** Helix-bore entries (the rampIn checkbox); false = straight plunge at each seed. */
  helixEntry: boolean
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

// ─── Rasterization ───────────────────────────────────────────────────────────────

// Even-odd scanline fill of a polygon set (outer boundaries + holes in one list).
function fillEvenOdd(polys: Pt2[][], w: number, h: number, x0: number, y0: number, cell: number): Uint8Array {
  const out = new Uint8Array(w * h)
  const xs: number[] = []
  for (let iy = 0; iy < h; iy++) {
    const yc = y0 + (iy + 0.5) * cell
    xs.length = 0
    for (const poly of polys) {
      const n = poly.length
      for (let i = 0; i < n; i++) {
        const ax = poly[i][0], ay = poly[i][1]
        const bx = poly[(i + 1) % n][0], by = poly[(i + 1) % n][1]
        if ((ay <= yc) !== (by <= yc)) xs.push(ax + ((yc - ay) * (bx - ax)) / (by - ay))
      }
    }
    if (xs.length < 2) continue
    xs.sort((a, b) => a - b)
    const row = iy * w
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let i0 = Math.ceil((xs[k] - x0) / cell - 0.5)
      let i1 = Math.floor((xs[k + 1] - x0) / cell - 0.5)
      if (i0 < 0) i0 = 0
      if (i1 > w - 1) i1 = w - 1
      for (let ix = i0; ix <= i1; ix++) out[row + ix] = 1
    }
  }
  return out
}

// ─── Exact Euclidean distance transform (Felzenszwalb & Huttenlocher) ────────────

const EDT_INF = 1e10

function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0
  z[0] = -EDT_INF
  z[1] = EDT_INF
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = EDT_INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
}

/** Squared distance (in cells) from every cell to the nearest cell where isFeature(i) is true. */
function edtSq(w: number, h: number, isFeature: (i: number) => boolean): Float64Array {
  const m = Math.max(w, h)
  const f = new Float64Array(m)
  const d = new Float64Array(m)
  const v = new Int32Array(m)
  const z = new Float64Array(m + 1)
  const out = new Float64Array(w * h)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = isFeature(y * w + x) ? 0 : EDT_INF
    dt1d(f, h, d, v, z)
    for (let y = 0; y < h; y++) out[y * w + x] = d[y]
  }
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) f[x] = out[row + x]
    dt1d(f, w, d, v, z)
    for (let x = 0; x < w; x++) out[row + x] = d[x]
  }
  return out
}

// ─── The engine ──────────────────────────────────────────────────────────────────

export function computeAdaptive2Plan(boundary: Pt2[], islands: Pt2[][], prm: Adaptive2Params): Adaptive2Region[] {
  const R = prm.toolDiameterMM / 2
  if (R <= 0 || boundary.length < 3) return []

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of boundary) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  // Grid resolution: fine enough to steer by (R/10), coarsened if a huge pocket would
  // otherwise blow past the cell budget.
  let cell = clamp(R / 10, 0.08, 0.35)
  let w = 0, h = 0, x0 = 0, y0 = 0
  for (;;) {
    x0 = minX - 2 * cell
    y0 = minY - 2 * cell
    w = Math.ceil((maxX - minX + 4 * cell) / cell)
    h = Math.ceil((maxY - minY + 4 * cell) / cell)
    if (w * h <= 6e6) break
    cell *= 1.4
  }
  const nCells = w * h

  // Bookkeeping radius: a hair under the true tool radius so circumference samples always
  // land inside cells the stamp marked. Stamping, sampling and the bore all use rb, so the
  // model is self-consistent; the real tool over-covers the grid by ~0.75 cell, which is the
  // safe direction (never reports cut stock that the tool didn't actually reach).
  const rb = R - 0.75 * cell
  if (rb <= cell) return []   // tool of the order of grid resolution — nothing sensible to do

  // Tool-centre allowed region: boundary ⊖ R, islands ⊕ R — the single polygon op.
  const toCP = (pts: Pt2[], ccw: boolean) => {
    const wound = (signedArea(pts) >= 0) === ccw ? pts : [...pts].reverse()
    return wound.map(([x, y]) => ({ x, y }))
  }
  const machPolys = inflatePathsD(
    [toCP(boundary, true), ...islands.map(i => toCP(i, false))],
    -R, JoinType.Round, EndType.Polygon, 4, 6,
  ).map(r => r.map(({ x, y }) => [x, y] as Pt2)).filter(r => r.length >= 3)
  if (machPolys.length === 0) return []

  const mach = fillEvenOdd(machPolys, w, h, x0, y0, cell)
  const region = fillEvenOdd([boundary, ...islands], w, h, x0, y0, cell)

  // cleared[i] = 1 ⇒ no stock at cell i (outside the pocket, island, or already cut).
  // Pre-clearing everything outside the region makes walls invisible to the engagement
  // probe — the tool-centre mask (mach) is what actually keeps the tool off them.
  const cleared = new Uint8Array(nCells)
  let uncut = 0
  for (let i = 0; i < nCells; i++) {
    if (region[i]) uncut++
    else cleared[i] = 1
  }

  // Drop stock no tool position can ever touch (sharp concave corner fillets) so it
  // neither registers as engagement nor keeps the march hunting for it.
  const dMach = edtSq(w, h, i => mach[i] !== 0)
  const reachSq = (rb / cell) * (rb / cell)
  for (let i = 0; i < nCells; i++) {
    if (!cleared[i] && dMach[i] > reachSq) { cleared[i] = 1; uncut-- }
  }
  if (uncut === 0) return []

  // Distance from every cell to the nearest non-machinable cell — helix headroom at seeds.
  const dWall = edtSq(w, h, i => mach[i] === 0)

  const s = clamp(prm.stepoverMM, cell, 1.9 * rb)
  // Target fraction of the tool circumference in stock: for a straight pass at radial
  // stepover s the engaged arc is acos(1 − s/rb).
  const ft = Math.acos(clamp(1 - s / rb, -1, 1)) / (2 * Math.PI)

  const K = 96
  const cosT = new Float64Array(K)
  const sinT = new Float64Array(K)
  for (let k = 0; k < K; k++) {
    cosT[k] = Math.cos((2 * Math.PI * k) / K) * rb
    sinT[k] = Math.sin((2 * Math.PI * k) / K) * rb
  }

  const clearedAt = (x: number, y: number): boolean => {
    const ix = Math.floor((x - x0) / cell)
    const iy = Math.floor((y - y0) / cell)
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return true
    return cleared[iy * w + ix] !== 0
  }
  const machAt = (x: number, y: number): boolean => {
    const ix = Math.floor((x - x0) / cell)
    const iy = Math.floor((y - y0) / cell)
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return false
    return mach[iy * w + ix] !== 0
  }
  const engagement = (x: number, y: number): number => {
    let c = 0
    for (let k = 0; k < K; k++) if (!clearedAt(x + cosT[k], y + sinT[k])) c++
    return c / K
  }

  const stampSeg = (ax: number, ay: number, bx: number, by: number, r: number): void => {
    const r2 = r * r
    const ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - x0) / cell))
    const ix1 = Math.min(w - 1, Math.floor((Math.max(ax, bx) + r - x0) / cell))
    const iy0 = Math.max(0, Math.floor((Math.min(ay, by) - r - y0) / cell))
    const iy1 = Math.min(h - 1, Math.floor((Math.max(ay, by) + r - y0) / cell))
    for (let iy = iy0; iy <= iy1; iy++) {
      const py = y0 + (iy + 0.5) * cell
      const row = iy * w
      for (let ix = ix0; ix <= ix1; ix++) {
        if (cleared[row + ix]) continue
        const px = x0 + (ix + 0.5) * cell
        if (distSqPtSeg(px, py, ax, ay, bx, by) <= r2) { cleared[row + ix] = 1; uncut-- }
      }
    }
  }
  const stampDisk = (cx: number, cy: number, r: number): void => stampSeg(cx, cy, cx, cy, r)

  // Guide field: BFS distance (in cells, over machinable cells only) to the nearest
  // machinable cell that still touches stock. Descending it walks the tool across the
  // cleared floor to the next work, bending around islands automatically — the stay-down
  // alternative to lifting. Rebuilt on demand; allocated lazily.
  let guide: Int32Array | null = null
  let guideQueue: Uint32Array | null = null
  const buildGuide = (): boolean => {
    if (!guide) { guide = new Int32Array(nCells); guideQueue = new Uint32Array(nCells) }
    guide.fill(-1)
    const q = guideQueue!
    let qt = 0
    for (let i = 0; i < nCells; i++) {
      if (!mach[i]) continue
      if (!cleared[i]) { guide[i] = 0; q[qt++] = i; continue }
      const x = i % w
      if ((x > 0 && !cleared[i - 1]) || (x < w - 1 && !cleared[i + 1]) ||
          (i >= w && !cleared[i - w]) || (i + w < nCells && !cleared[i + w])) { guide[i] = 0; q[qt++] = i }
    }
    if (qt === 0) return false
    let qh = 0
    while (qh < qt) {
      const c = q[qh++]
      const d = guide[c] + 1
      const x = c % w
      if (x > 0 && mach[c - 1] && guide[c - 1] < 0) { guide[c - 1] = d; q[qt++] = c - 1 }
      if (x < w - 1 && mach[c + 1] && guide[c + 1] < 0) { guide[c + 1] = d; q[qt++] = c + 1 }
      if (c >= w && mach[c - w] && guide[c - w] < 0) { guide[c - w] = d; q[qt++] = c - w }
      if (c + w < nCells && mach[c + w] && guide[c + w] < 0) { guide[c + w] = d; q[qt++] = c + w }
    }
    return true
  }
  const guideAt = (x: number, y: number): number => {
    const ix = Math.floor((x - x0) / cell)
    const iy = Math.floor((y - y0) / cell)
    if (!guide || ix < 0 || iy < 0 || ix >= w || iy >= h) return Infinity
    const g = guide[iy * w + ix]
    return g < 0 ? Infinity : g
  }

  // ── Marching ──────────────────────────────────────────────────────────────────

  const ds = Math.max(2 * cell, R / 5)        // step length
  const A = ds / (0.45 * R)                   // max turn per step (loop radius ≥ 0.45 R)
  const dirSign = prm.wantCCW ? 1 : -1
  // Candidate turns, as fractions of A. The score prefers engagement closest to target,
  // mildly prefers going straight (smoothness), and nudges toward the requested winding
  // direction so re-engagements settle on the climb/conventional side consistently.
  const CAND = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1]
  const idleLimit = Math.ceil((2 * Math.PI * 0.45 * R) / ds) + 4

  let px = 0, py = 0, theta = 0               // march state

  const steerStep = (): number | null => {
    let bestDelta = NaN, bestScore = Infinity, bestE = 0
    for (let i = 0; i < CAND.length; i++) {
      const c = CAND[i]
      const th = theta + c * A
      const nx = px + Math.cos(th) * ds
      const ny = py + Math.sin(th) * ds
      if (!machAt(nx, ny)) continue
      const e = engagement(nx, ny)
      const score = Math.abs(e - ft) + 0.02 * Math.abs(c) - 0.012 * c * dirSign
      if (score < bestScore) { bestScore = score; bestDelta = c * A; bestE = e }
    }
    if (Number.isNaN(bestDelta)) return null
    theta += bestDelta
    const nx = px + Math.cos(theta) * ds
    const ny = py + Math.sin(theta) * ds
    stampSeg(px, py, nx, ny, rb)
    px = nx
    py = ny
    return bestE
  }

  // The turn-per-step limit keeps the path smooth, but it can nose the march into a
  // dead-end (every candidate off the machinable mask). A round tool can re-aim in place
  // for free — pick the best heading over the full circle and carry on.
  const reAim = (): boolean => {
    let bestT = NaN
    let bestSc = Infinity
    for (let k = 0; k < 24; k++) {
      const th = (k / 24) * 2 * Math.PI
      const nx = px + Math.cos(th) * ds
      const ny = py + Math.sin(th) * ds
      if (!machAt(nx, ny)) continue
      const e = engagement(nx, ny)
      const sc = e > ft * 1.2 ? 2 + e : Math.abs(e - ft)
      if (sc < bestSc) { bestSc = sc; bestT = th }
    }
    if (Number.isNaN(bestT)) return false
    theta = bestT
    return true
  }

  // ── Region loop ───────────────────────────────────────────────────────────────

  const regions: Adaptive2Region[] = []
  const simplifyTol = cell * 0.4
  // Leftovers below ~one step's worth of stock aren't worth another entry move.
  const stopUncut = Math.max(4, Math.round(Math.max(s * R, 1) / (cell * cell)))
  let budget = Math.ceil((uncut * cell * cell) / (ds * s)) * 8 + 20000

  while (uncut > stopUncut && regions.length < 200 && budget > 0) {
    // Seed at the deepest remaining stock the tool centre can sit on.
    const dClear = edtSq(w, h, i => cleared[i] !== 0)
    let seedIdx = -1
    let seedScore = 0
    for (let i = 0; i < nCells; i++) {
      if (mach[i] && !cleared[i] && dClear[i] > seedScore) { seedScore = dClear[i]; seedIdx = i }
    }

    let sx: number, sy: number, hr = 0
    if (seedIdx >= 0) {
      sx = x0 + ((seedIdx % w) + 0.5) * cell
      sy = y0 + (Math.floor(seedIdx / w) + 0.5) * cell
      if (prm.helixEntry) {
        const head = Math.min(Math.sqrt(dWall[seedIdx]), Math.sqrt(dClear[seedIdx])) * cell - cell
        hr = Math.min(0.9 * R, head)
        if (hr < Math.max(0.3, 0.15 * R)) hr = 0
      }
    } else {
      // Every machinable centre is already cleared, but reachable stock remains (wall
      // bands and corner nibs that only the tool's edge can take). Enter on the cleared
      // floor at the machinable cell nearest that stock and let the march walk to it.
      let uIdx = -1
      let uBest = Infinity
      for (let i = 0; i < nCells; i++) {
        if (!cleared[i] && dMach[i] < uBest) { uBest = dMach[i]; uIdx = i }
      }
      if (uIdx < 0) break
      const ux = x0 + ((uIdx % w) + 0.5) * cell
      const uy = y0 + (Math.floor(uIdx / w) + 0.5) * cell
      // nearest machinable cell to that stock cell
      const cx = uIdx % w, cy = Math.floor(uIdx / w)
      let found = false
      const maxR = Math.ceil(rb / cell) + 2
      sx = ux; sy = uy
      outer: for (let r = 0; r <= maxR && !found; r++) {
        for (let iy = Math.max(0, cy - r); iy <= Math.min(h - 1, cy + r); iy++) {
          for (let ix = Math.max(0, cx - r); ix <= Math.min(w - 1, cx + r); ix++) {
            if (Math.max(Math.abs(ix - cx), Math.abs(iy - cy)) !== r) continue
            if (mach[iy * w + ix]) {
              sx = x0 + (ix + 0.5) * cell
              sy = y0 + (iy + 0.5) * cell
              found = true
              break outer
            }
          }
        }
      }
      if (!found) break
    }

    const before = uncut

    // Entry: bore (helix) or plunge, then march.
    let moves: Adaptive2Move[] = []
    let cur: Pt2[] = []
    if (hr > 0) {
      stampDisk(sx, sy, hr + rb)
      px = sx + hr                      // bore rim at angle 0 — the emitter ends the helix here
      py = sy
      theta = dirSign * (Math.PI / 2)   // tangent to the rim in the winding direction
    } else {
      stampDisk(sx, sy, rb)
      px = sx
      py = sy
      // Pick the start heading whose first step lands closest to target engagement.
      let bestT = 0
      let bestSc = Infinity
      for (let k = 0; k < 16; k++) {
        const th = (k / 16) * 2 * Math.PI
        const nx = px + Math.cos(th) * ds
        const ny = py + Math.sin(th) * ds
        if (!machAt(nx, ny)) continue
        const sc = Math.abs(engagement(nx, ny) - ft)
        if (sc < bestSc) { bestSc = sc; bestT = th }
      }
      theta = bestT
    }
    cur.push([px, py])

    let idle = 0
    let navPts: Pt2[] | null = null   // non-null ⇒ descending the guide field to new stock
    let navMaxE = 0
    let navSteps = 0
    let navLimit = 0

    while (uncut > stopUncut && budget-- > 0) {
      if (navPts === null) {
        // ── cutting mode: hold engagement at target ──
        let e = steerStep()
        if (e === null) {
          if (!reAim()) break
          e = steerStep()
          if (e === null) break
        }
        cur.push([px, py])
        if (e < ft * 0.08) idle++
        else idle = 0
        if (idle > idleLimit) {
          // A full loop without touching stock: nothing left here. Flood the guide field
          // and slide to the nearest remaining stock without lifting; end the region only
          // if no stock is reachable from where we stand.
          if (!buildGuide()) break
          const g0 = guideAt(px, py)
          if (!Number.isFinite(g0)) break
          navPts = []
          navMaxE = 0
          navSteps = 0
          navLimit = g0 * 3 + 100
          idle = 0
        }
      } else {
        // ── navigation mode: descend the guide field, engagement still capped ──
        let bestDelta = NaN
        let bestSc = Infinity
        let bestE = 0
        for (let i = 0; i < CAND.length; i++) {
          const th = theta + CAND[i] * A
          const nx = px + Math.cos(th) * ds
          const ny = py + Math.sin(th) * ds
          if (!machAt(nx, ny)) continue
          const g = guideAt(nx, ny)
          if (!Number.isFinite(g)) continue
          const e = engagement(nx, ny)
          const sc = g + (e > ft * 1.15 ? 1e6 : 0) + 0.3 * Math.abs(CAND[i])
          if (sc < bestSc) { bestSc = sc; bestDelta = CAND[i] * A; bestE = e }
        }
        if (Number.isNaN(bestDelta) || bestSc >= 1e6) {
          if (!reAim() || ++navSteps > navLimit) break
          continue
        }
        theta += bestDelta
        const nx = px + Math.cos(theta) * ds
        const ny = py + Math.sin(theta) * ds
        stampSeg(px, py, nx, ny, rb)
        px = nx
        py = ny
        navPts.push([px, py])
        if (bestE > navMaxE) navMaxE = bestE
        if (bestE >= ft * 0.5 || guideAt(px, py) === 0) {
          // Re-engaged. A traverse that never really cut is a stay-down link; one that
          // nibbled on the way is just more cutting.
          if (navMaxE < ft * 0.2 && navPts.length >= 2) {
            if (cur.length >= 2) moves.push({ kind: 'cut', pts: cur })
            moves.push({ kind: 'link', pts: navPts })
            cur = [navPts[navPts.length - 1]]
          } else {
            for (const p of navPts) cur.push(p)
          }
          navPts = null
          idle = 0
        } else if (++navSteps > navLimit) {
          break
        }
      }
    }
    if (navPts) for (const p of navPts) cur.push(p)
    if (cur.length >= 2) moves.push({ kind: 'cut', pts: cur })

    moves = moves
      .map(m => (m.kind === 'cut' ? { kind: m.kind, pts: douglasPeucker(m.pts, simplifyTol) } : m))
      .filter(m => m.pts.length >= (m.kind === 'cut' ? 2 : 1))

    if (moves.some(m => m.kind === 'cut')) {
      regions.push({ helixCenter: [sx, sy], helixRadiusMM: hr, moves })
    }
    if (uncut >= before) break   // no progress — bail rather than spin
  }

  return regions
}
