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

  // Tool-centre allowed region: boundary ⊖ R, islands ⊕ R — the single polygon op. The
  // extra half cell covers raster quantization (a cell centre can sit up to ~0.7 cell
  // inside the polygon while its true position is outside), so no committed step can
  // stray past the real inset wall; the finishing pass owns that margin anyway.
  const toCP = (pts: Pt2[], ccw: boolean) => {
    const wound = (signedArea(pts) >= 0) === ccw ? pts : [...pts].reverse()
    return wound.map(([x, y]) => ({ x, y }))
  }
  const machPolys = inflatePathsD(
    [toCP(boundary, true), ...islands.map(i => toCP(i, false))],
    -(R + 0.5 * cell), JoinType.Round, EndType.Polygon, 4, 6,
  ).map(r => r.map(({ x, y }) => [x, y] as Pt2)).filter(r => r.length >= 3)
  if (machPolys.length === 0) return []

  const mach = fillEvenOdd(machPolys, w, h, x0, y0, cell)
  const region = fillEvenOdd([boundary, ...islands], w, h, x0, y0, cell)

  // cleared[i] = 1 ⇒ no stock at cell i (outside the pocket, island, or already cut).
  // Pre-clearing everything outside the region makes walls invisible to the engagement
  // probe — the tool-centre mask (mach) is what actually keeps the tool off them.
  const cleared = new Uint8Array(nCells)
  for (let i = 0; i < nCells; i++) if (!region[i]) cleared[i] = 1

  // Drop stock no tool position can ever touch (sharp concave corner fillets) so it
  // neither registers as engagement nor keeps the march hunting for it.
  const dMach = edtSq(w, h, i => mach[i] !== 0)
  const reachSq = (rb / cell) * (rb / cell)
  for (let i = 0; i < nCells; i++) {
    if (!cleared[i] && dMach[i] > reachSq) cleared[i] = 1
  }

  // Distance from every cell to the nearest non-machinable cell — helix headroom at seeds.
  const dWall = edtSq(w, h, i => mach[i] === 0)

  const s = clamp(prm.stepoverMM, cell, 1.9 * rb)
  // Target fraction of the tool circumference in stock: for a straight pass at radial
  // stepover s the engaged arc is acos(1 − s/rb).
  const ft = Math.acos(clamp(1 - s / rb, -1, 1)) / (2 * Math.PI)

  // band[i] = 1 ⇒ wall sliver the finishing pass takes: stock at most ONE STEPOVER deep
  // along the walls/islands, so the finishing bite never exceeds the target engagement.
  // Band stock stays fully visible to the engagement probe — the tool really cuts it in
  // passing and the steering must respect it (blinding the probe to it kills the
  // trochoids and overloads the cutter) — but it is never a GOAL: seeds, guide-field
  // targets and the completion count all ignore it, so the march never travels back
  // across the pocket just to shave a wall crumb the finishing pass erases anyway.
  const band = new Uint8Array(nCells)
  const dEdge = edtSq(w, h, i => region[i] === 0)
  const bandCells = Math.min(s, rb) / cell
  const bandSq = bandCells * bandCells
  for (let i = 0; i < nCells; i++) {
    if (region[i] && dEdge[i] <= bandSq) band[i] = 1
  }

  // uncut counts OWED stock only (real and not band) — the marcher's goal metric.
  let uncut = 0
  for (let i = 0; i < nCells; i++) if (!cleared[i] && !band[i]) uncut++
  if (uncut === 0) return []

  // Cutting steps prefer to keep the tool edge OUT of the finishing band: without this
  // the final wall lap pins against the machinable limit and swallows leftover strip +
  // band in one bite (~2 stepovers ≈ 80–95% width — the frontier-collision spikes). The
  // penalty is soft: in corridors narrower than the threshold every candidate carries it
  // equally, so geometric slots are still cut.
  const bandKeep = (R + Math.min(s, rb)) / cell
  const bandKeepSq = bandKeep * bandKeep
  const inBandZone = (x: number, y: number): boolean => {
    const ix = Math.floor((x - x0) / cell)
    const iy = Math.floor((y - y0) / cell)
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return true
    return dEdge[iy * w + ix] < bandKeepSq
  }

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

  // Returns how many cells this sweep cleared — `n` = any material (0 ⇒ pure air, the
  // path-straightener may reroute it), `owed` = non-band material (goal progress).
  const stampSeg = (ax: number, ay: number, bx: number, by: number, r: number): { n: number; owed: number } => {
    const r2 = r * r
    const ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - x0) / cell))
    const ix1 = Math.min(w - 1, Math.floor((Math.max(ax, bx) + r - x0) / cell))
    const iy0 = Math.max(0, Math.floor((Math.min(ay, by) - r - y0) / cell))
    const iy1 = Math.min(h - 1, Math.floor((Math.max(ay, by) + r - y0) / cell))
    let n = 0
    let owed = 0
    for (let iy = iy0; iy <= iy1; iy++) {
      const py = y0 + (iy + 0.5) * cell
      const row = iy * w
      for (let ix = ix0; ix <= ix1; ix++) {
        if (cleared[row + ix]) continue
        const px = x0 + (ix + 0.5) * cell
        if (distSqPtSeg(px, py, ax, ay, bx, by) <= r2) {
          cleared[row + ix] = 1
          if (!band[row + ix]) { uncut--; owed++ }
          n++
        }
      }
    }
    return { n, owed }
  }
  const stampDisk = (cx: number, cy: number, r: number): void => { stampSeg(cx, cy, cx, cy, r) }

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
    // Sources: machinable cells holding OWED stock (band crumbs are not goals). The
    // flood then expands ONLY across the cleared floor — cells the tool can actually
    // slide over — so descending the field never demands plowing through solid stock.
    for (let i = 0; i < nCells; i++) {
      if (mach[i] && cleared[i] === 0 && band[i] === 0) { guide[i] = 0; q[qt++] = i }
    }
    if (qt === 0) return false
    let qh = 0
    while (qh < qt) {
      const c = q[qh++]
      const d = guide[c] + 1
      const x = c % w
      if (x > 0 && mach[c - 1] && cleared[c - 1] && guide[c - 1] < 0) { guide[c - 1] = d; q[qt++] = c - 1 }
      if (x < w - 1 && mach[c + 1] && cleared[c + 1] && guide[c + 1] < 0) { guide[c + 1] = d; q[qt++] = c + 1 }
      if (c >= w && mach[c - w] && cleared[c - w] && guide[c - w] < 0) { guide[c - w] = d; q[qt++] = c - w }
      if (c + w < nCells && mach[c + w] && cleared[c + w] && guide[c + w] < 0) { guide[c + w] = d; q[qt++] = c + w }
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
  // Hard chip-load governor: no single step may sweep more new stock than a pass at
  // 1.3× the target stepover would.
  const maxStepArea = 1.3 * s * ds
  const dirSign = prm.wantCCW ? 1 : -1
  // Candidate turns, as fractions of A. The score prefers engagement closest to target,
  // mildly prefers going straight (smoothness), and nudges toward the requested winding
  // direction so re-engagements settle on the climb/conventional side consistently.
  const CAND = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1]
  const idleLimit = Math.ceil((2 * Math.PI * 0.45 * R) / ds) + 4

  let px = 0, py = 0, theta = 0               // march state

  // Read-only preview of a step's newly-swept stock area (mm²): uncut cells inside the
  // leading crescent (within rb of the step end, beyond rb of the start).
  const previewStepArea = (ax: number, ay: number, bx: number, by: number): number => {
    const r2 = rb * rb
    const ix0 = Math.max(0, Math.floor((bx - rb - x0) / cell))
    const ix1 = Math.min(w - 1, Math.floor((bx + rb - x0) / cell))
    const iy0 = Math.max(0, Math.floor((by - rb - y0) / cell))
    const iy1 = Math.min(h - 1, Math.floor((by + rb - y0) / cell))
    let n = 0
    for (let iy = iy0; iy <= iy1; iy++) {
      const pyc = y0 + (iy + 0.5) * cell
      const row = iy * w
      for (let ix = ix0; ix <= ix1; ix++) {
        if (cleared[row + ix]) continue
        const pxc = x0 + (ix + 0.5) * cell
        const dbx = pxc - bx, dby = pyc - by
        if (dbx * dbx + dby * dby > r2) continue
        const dax = pxc - ax, day = pyc - ay
        if (dax * dax + day * day <= r2) continue
        n++
      }
    }
    return n * cell * cell
  }

  const steerStep = (): { e: number; cut: number; owed: number } | null => {
    // Rank candidates by circumference occupancy (cheap), then govern by ACTUAL swept
    // area: occupancy misreads pivots around convex corners (the outer flank sweeps a
    // wide fan at on-target occupancy) and deep wall strips. If the winner's previewed
    // area overloads, re-rank every candidate by area — biggest bite under the cap,
    // else retreat through cleared (the trochoidal loop-back), else least overload
    // (true geometric slots).
    let bestDelta = NaN, bestScore = Infinity, bestE = 0
    for (let i = 0; i < CAND.length; i++) {
      const c = CAND[i]
      const th = theta + c * A
      const nx = px + Math.cos(th) * ds
      const ny = py + Math.sin(th) * ds
      if (!machAt(nx, ny)) continue
      const e = engagement(nx, ny)
      const score = Math.abs(e - ft) + 0.02 * Math.abs(c) - 0.012 * c * dirSign
        + (inBandZone(nx, ny) ? 0.6 : 0)
      if (score < bestScore) { bestScore = score; bestDelta = c * A; bestE = e }
    }
    if (Number.isNaN(bestDelta)) return null
    {
      const th = theta + bestDelta
      const nx = px + Math.cos(th) * ds
      const ny = py + Math.sin(th) * ds
      if (previewStepArea(px, py, nx, ny) > maxStepArea) {
        let areaDelta = NaN
        let areaScore = Infinity
        for (let i = 0; i < CAND.length; i++) {
          const c = CAND[i]
          const t2 = theta + c * A
          const mx = px + Math.cos(t2) * ds
          const my = py + Math.sin(t2) * ds
          if (!machAt(mx, my)) continue
          const a2 = previewStepArea(px, py, mx, my)
          const sc = (a2 > maxStepArea ? 1000 + a2 : maxStepArea - a2) + 0.05 * Math.abs(c)
          if (sc < areaScore) { areaScore = sc; areaDelta = c * A }
        }
        if (!Number.isNaN(areaDelta)) bestDelta = areaDelta
      }
    }
    theta += bestDelta
    const nx = px + Math.cos(theta) * ds
    const ny = py + Math.sin(theta) * ds
    const st = stampSeg(px, py, nx, ny, rb)
    px = nx
    py = ny
    return { e: bestE, cut: st.n, owed: st.owed }
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
      const sc = (e > ft * 1.2 ? 2 + e : Math.abs(e - ft)) + (inBandZone(nx, ny) ? 0.6 : 0)
      if (sc < bestSc) { bestSc = sc; bestT = th }
    }
    if (Number.isNaN(bestT)) return false
    theta = bestT
    return true
  }

  // True when the straight tool move a→b runs entirely over already-cut floor: the
  // centre line stays machinable (same wall guarantee as a marched step) and every cell
  // the tool sweeps is cut AND inside the pocket (outside-region cells read "cleared"
  // for the engagement probe, but they are wall — a chord may never cross them).
  const chordClear = (ax: number, ay: number, bx: number, by: number): boolean => {
    const len = Math.hypot(bx - ax, by - ay)
    const lineSteps = Math.max(1, Math.ceil(len / cell))
    for (let k = 0; k <= lineSteps; k++) {
      if (!machAt(ax + ((bx - ax) * k) / lineSteps, ay + ((by - ay) * k) / lineSteps)) return false
    }
    const r2 = rb * rb
    const ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - rb - x0) / cell))
    const ix1 = Math.min(w - 1, Math.floor((Math.max(ax, bx) + rb - x0) / cell))
    const iy0 = Math.max(0, Math.floor((Math.min(ay, by) - rb - y0) / cell))
    const iy1 = Math.min(h - 1, Math.floor((Math.max(ay, by) + rb - y0) / cell))
    for (let iy = iy0; iy <= iy1; iy++) {
      const pyc = y0 + (iy + 0.5) * cell
      const row = iy * w
      for (let ix = ix0; ix <= ix1; ix++) {
        const pxc = x0 + (ix + 0.5) * cell
        if (distSqPtSeg(pxc, pyc, ax, ay, bx, by) > r2) continue
        if (!cleared[row + ix] || !region[row + ix]) return false
      }
    }
    return true
  }

  // Replace a steered air run (steps that removed no material) with the fewest straight
  // chords over cut floor — the straight back-stroke of the trochoidal "D". Greedy
  // line-of-sight: from each anchor jump to the farthest run point reachable by a clear
  // chord (adjacent points were physically traversed, so the fallback is always valid).
  // Endpoints are preserved, so the rejoin into the next cut is unchanged.
  const straighten = (from: Pt2, pts: Pt2[]): Pt2[] => {
    if (pts.length <= 1) return pts
    const out: Pt2[] = []
    let ax = from[0], ay = from[1]
    let i = 0
    while (i < pts.length) {
      let j = pts.length - 1
      while (j > i && !chordClear(ax, ay, pts[j][0], pts[j][1])) {
        j = i + Math.floor((j - i) / 2)
      }
      out.push(pts[j])
      ax = pts[j][0]
      ay = pts[j][1]
      i = j + 1
    }
    return out
  }

  // ── Region loop ───────────────────────────────────────────────────────────────

  const regions: Adaptive2Region[] = []
  const simplifyTol = cell * 0.4
  // Owed leftovers under ~1 mm² aren't worth another entry move.
  const stopUncut = Math.max(4, Math.round(1 / (cell * cell)))
  let budget = Math.ceil((uncut * cell * cell) / (ds * s)) * 8 + 20000

  while (uncut > stopUncut && regions.length < 200 && budget > 0) {
    // Seed at the deepest remaining OWED stock the tool centre can sit on (depth measured
    // to anything cut, void, or mere band — keeps seeds off the walls). Owed stock always
    // sits on machinable cells (everything else is band), so no seed means done.
    const dClear = edtSq(w, h, i => cleared[i] !== 0 || band[i] !== 0)
    let seedIdx = -1
    let seedScore = 0
    for (let i = 0; i < nCells; i++) {
      if (mach[i] && !cleared[i] && !band[i] && dClear[i] > seedScore) { seedScore = dClear[i]; seedIdx = i }
    }
    if (seedIdx < 0) break

    const sx = x0 + ((seedIdx % w) + 0.5) * cell
    const sy = y0 + (Math.floor(seedIdx / w) + 0.5) * cell
    let hr = 0
    if (prm.helixEntry) {
      const head = Math.min(Math.sqrt(dWall[seedIdx]), Math.sqrt(dClear[seedIdx])) * cell - cell
      hr = Math.min(0.9 * R, head)
      if (hr < Math.max(0.3, 0.15 * R)) hr = 0
    }

    const before = uncut

    // Entry: bore (helix) or plunge, then march. A plunge's first lateral moves are
    // area-governed like any other step, so even a plunge into a leftover sliver cuts
    // its way out at capped width rather than slotting.
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
    let navMode = false               // descending the guide field to new stock
    let navSteps = 0
    let navLimit = 0

    // Steps that removed nothing accumulate here instead of going straight into the
    // path; when cutting resumes the run is replaced by straight chords over cut floor
    // (straighten) and emitted as a stay-down 'link' move — rendered as dashed travel in
    // the UI, so cutting and air-moves are visually distinct. Hops shorter than a couple
    // of steps stay inline in the cut move. Only zero-cut steps may be rerouted — their
    // stamps changed nothing, so the swap is exactly behavior-preserving on the grid.
    const air: Pt2[] = []
    const emitAir = () => {
      if (air.length === 0) return
      const from = cur[cur.length - 1]
      const pts = straighten(from, air)
      air.length = 0
      let len = 0
      let prev = from
      for (const p of pts) { len += Math.hypot(p[0] - prev[0], p[1] - prev[1]); prev = p }
      if (len <= ds * 2) {
        for (const p of pts) cur.push(p)
        return
      }
      if (cur.length >= 2) moves.push({ kind: 'cut', pts: cur })
      moves.push({ kind: 'link', pts })
      cur = [pts[pts.length - 1]]
    }

    while (uncut > stopUncut && budget-- > 0) {
      if (!navMode) {
        // ── cutting mode: hold engagement at target ──
        let r = steerStep()
        if (r === null) {
          if (!reAim()) break
          r = steerStep()
          if (r === null) break
        }
        if (r.cut === 0) air.push([px, py])
        else { emitAir(); cur.push([px, py]) }
        // Idle = no GOAL progress: steps that cut nothing, or only shave band stock the
        // finishing pass owns, both count — otherwise the march nibbles the band edge
        // forever at low engagement without ever moving on.
        if (r.owed === 0) idle++
        else idle = 0
        if (idle > idleLimit) {
          // A full loop without touching stock: nothing left here. Flood the guide field
          // and slide to the nearest remaining stock without lifting; end the region only
          // if no stock is reachable from where we stand.
          if (!buildGuide()) break
          const g0 = guideAt(px, py)
          if (!Number.isFinite(g0)) break
          navMode = true
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
          // Same chip-load governor as cutting mode: occupancy alone misses pivot
          // inflation (e.g. rounding an island while walking to new stock).
          if (previewStepArea(px, py, nx, ny) > maxStepArea) continue
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
        const st = stampSeg(px, py, nx, ny, rb)
        px = nx
        py = ny
        if (st.n === 0) air.push([px, py])
        else { emitAir(); cur.push([px, py]) }
        if (bestE >= ft * 0.5 || guideAt(px, py) === 0) {
          navMode = false
          idle = 0
        } else if (++navSteps > navLimit) {
          break
        }
      }
    }
    emitAir()
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
