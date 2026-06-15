// Flatten SVG path d-strings (in CNC mm, Y-up) to polyline sub-paths.
// All commands assumed absolute (as produced by svgImporter's stringifyD).

export type Pt2 = [number, number]

function dist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-20) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

function cubicFlat(
  p0x: number, p0y: number, p1x: number, p1y: number,
  p2x: number, p2y: number, p3x: number, p3y: number,
  tol: number, pts: Pt2[], depth = 0
) {
  if (depth > 12 || (dist(p1x, p1y, p0x, p0y, p3x, p3y) <= tol && dist(p2x, p2y, p0x, p0y, p3x, p3y) <= tol)) {
    pts.push([p3x, p3y])
    return
  }
  const m01x = (p0x+p1x)/2, m01y = (p0y+p1y)/2
  const m12x = (p1x+p2x)/2, m12y = (p1y+p2y)/2
  const m23x = (p2x+p3x)/2, m23y = (p2y+p3y)/2
  const m012x = (m01x+m12x)/2, m012y = (m01y+m12y)/2
  const m123x = (m12x+m23x)/2, m123y = (m12y+m23y)/2
  const mx = (m012x+m123x)/2, my = (m012y+m123y)/2
  cubicFlat(p0x, p0y, m01x, m01y, m012x, m012y, mx, my, tol, pts, depth+1)
  cubicFlat(mx, my, m123x, m123y, m23x, m23y, p3x, p3y, tol, pts, depth+1)
}

function quadFlat(
  p0x: number, p0y: number, p1x: number, p1y: number, p2x: number, p2y: number,
  tol: number, pts: Pt2[], depth = 0
) {
  if (depth > 12 || dist(p1x, p1y, p0x, p0y, p2x, p2y) <= tol) {
    pts.push([p2x, p2y])
    return
  }
  const m01x = (p0x+p1x)/2, m01y = (p0y+p1y)/2
  const m12x = (p1x+p2x)/2, m12y = (p1y+p2y)/2
  const mx = (m01x+m12x)/2, my = (m01y+m12y)/2
  quadFlat(p0x, p0y, m01x, m01y, mx, my, tol, pts, depth+1)
  quadFlat(mx, my, m12x, m12y, p2x, p2y, tol, pts, depth+1)
}

function arcFlat(
  x0: number, y0: number,
  rx: number, ry: number, phi: number,
  largeArc: number, sweep: number,
  x1: number, y1: number,
  pts: Pt2[],
  tol: number
) {
  if (Math.hypot(x0 - x1, y0 - y1) < 1e-10) return
  const sinP = Math.sin(phi * Math.PI / 180)
  const cosP = Math.cos(phi * Math.PI / 180)
  const dx2 = (x0 - x1) / 2, dy2 = (y0 - y1) / 2
  const x1p = cosP * dx2 + sinP * dy2
  const y1p = -sinP * dx2 + cosP * dy2
  let rxA = Math.abs(rx), ryA = Math.abs(ry)
  const lam = (x1p * x1p) / (rxA * rxA) + (y1p * y1p) / (ryA * ryA)
  if (lam > 1) { const l = Math.sqrt(lam); rxA *= l; ryA *= l }
  const num = Math.max(0, rxA*rxA*ryA*ryA - rxA*rxA*y1p*y1p - ryA*ryA*x1p*x1p)
  const den = rxA*rxA*y1p*y1p + ryA*ryA*x1p*x1p
  const sq = Math.sqrt(num / Math.max(den, 1e-20)) * (largeArc === sweep ? -1 : 1)
  const cxp = sq * rxA * y1p / ryA
  const cyp = -sq * ryA * x1p / rxA
  const cx = cosP * cxp - sinP * cyp + (x0 + x1) / 2
  const cy = sinP * cxp + cosP * cyp + (y0 + y1) / 2
  const ux = (x1p - cxp) / rxA, uy = (y1p - cyp) / ryA
  const vx = (-x1p - cxp) / rxA, vy = (-y1p - cyp) / ryA
  let theta1 = Math.atan2(uy, ux)
  let dTheta = Math.atan2(vy * ux - vx * uy, ux * vx + uy * vy)
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI
  // Chord-error formula: thetaPerStep = 2*acos(1 − tol/r) where r = max radius.
  // Using max(rxA, ryA) is conservative — guarantees chord error ≤ tol everywhere
  // on the arc, including the gentlest (largest-radius) part of an ellipse.
  const r = Math.max(rxA, ryA)
  const thetaPerStep = 2 * Math.acos(Math.max(-1, 1 - tol / r))
  const steps = Math.max(4, Math.ceil(Math.abs(dTheta) / Math.max(thetaPerStep, 1e-3)))
  for (let i = 1; i <= steps; i++) {
    const theta = theta1 + (i / steps) * dTheta
    const cosT = Math.cos(theta), sinT = Math.sin(theta)
    pts.push([cosP * rxA * cosT - sinP * ryA * sinT + cx, sinP * rxA * cosT + cosP * ryA * sinT + cy])
  }
}

function parseNums(s: string): number[] {
  return (s.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []).map(Number)
}

export function flattenPath(d: string, tolerance = 0.1): Pt2[][] {
  const subpaths: Pt2[][] = []
  let current: Pt2[] = []
  let cx = 0, cy = 0, mx = 0, my = 0
  let prevCx2 = 0, prevCy2 = 0, prevIsC = false
  let prevQx1 = 0, prevQy1 = 0, prevIsQ = false

  const tokens = d.match(/[MLCSQTAZmlcsqtaz][^MLCSQTAZmlcsqtaz]*/g) ?? []

  function pushSub() {
    if (current.length >= 2) subpaths.push(current)
    current = []
  }

  for (const token of tokens) {
    const cmd = token[0]
    const n = parseNums(token.slice(1))

    switch (cmd) {
      case 'M': {
        pushSub()
        current.push([n[0], n[1]])
        cx = mx = n[0]; cy = my = n[1]
        for (let i = 2; i < n.length; i += 2) { cx = n[i]; cy = n[i+1]; current.push([cx, cy]) }
        prevIsC = false; prevIsQ = false; break
      }
      case 'L': {
        for (let i = 0; i < n.length; i += 2) { cx = n[i]; cy = n[i+1]; current.push([cx, cy]) }
        prevIsC = false; prevIsQ = false; break
      }
      case 'C': {
        for (let i = 0; i < n.length; i += 6) {
          const x1=n[i], y1=n[i+1], x2=n[i+2], y2=n[i+3], x=n[i+4], y=n[i+5]
          cubicFlat(cx, cy, x1, y1, x2, y2, x, y, tolerance, current)
          prevCx2 = x2; prevCy2 = y2; prevIsC = true; prevIsQ = false
          cx = x; cy = y
        }
        break
      }
      case 'S': {
        for (let i = 0; i < n.length; i += 4) {
          const x1 = prevIsC ? 2*cx - prevCx2 : cx
          const y1 = prevIsC ? 2*cy - prevCy2 : cy
          const x2=n[i], y2=n[i+1], x=n[i+2], y=n[i+3]
          cubicFlat(cx, cy, x1, y1, x2, y2, x, y, tolerance, current)
          prevCx2 = x2; prevCy2 = y2; prevIsC = true; prevIsQ = false
          cx = x; cy = y
        }
        break
      }
      case 'Q': {
        for (let i = 0; i < n.length; i += 4) {
          const x1=n[i], y1=n[i+1], x=n[i+2], y=n[i+3]
          quadFlat(cx, cy, x1, y1, x, y, tolerance, current)
          prevQx1 = x1; prevQy1 = y1; prevIsQ = true; prevIsC = false
          cx = x; cy = y
        }
        break
      }
      case 'T': {
        for (let i = 0; i < n.length; i += 2) {
          const x1 = prevIsQ ? 2*cx - prevQx1 : cx
          const y1 = prevIsQ ? 2*cy - prevQy1 : cy
          const x=n[i], y=n[i+1]
          quadFlat(cx, cy, x1, y1, x, y, tolerance, current)
          prevQx1 = x1; prevQy1 = y1; prevIsQ = true; prevIsC = false
          cx = x; cy = y
        }
        break
      }
      case 'A': {
        for (let i = 0; i < n.length; i += 7) {
          arcFlat(cx, cy, n[i], n[i+1], n[i+2], n[i+3], n[i+4], n[i+5], n[i+6], current, tolerance)
          cx = n[i+5]; cy = n[i+6]
        }
        prevIsC = false; prevIsQ = false; break
      }
      case 'Z': {
        if (current.length >= 2) current.push([mx, my])  // close the loop so the closing segment is present
        pushSub()
        cx = mx; cy = my
        prevIsC = false; prevIsQ = false; break
      }
    }
  }
  pushSub()
  return subpaths
}


// Fit a circle through 3 points. Returns null if collinear or radius < 0.1mm.
function circleFrom3Pts(a: Pt2, b: Pt2, c: Pt2): { cx: number; cy: number; r: number } | null {
  const ax = b[0] - a[0], ay = b[1] - a[1]
  const bx = c[0] - a[0], by = c[1] - a[1]
  const D = 2 * (ax * by - ay * bx)
  if (Math.abs(D) < 1e-10) return null
  const ux = (by * (ax * ax + ay * ay) - ay * (bx * bx + by * by)) / D
  const uy = (ax * (bx * bx + by * by) - bx * (ax * ax + ay * ay)) / D
  const r = Math.hypot(ux, uy)
  if (r < 0.1) return null
  return { cx: a[0] + ux, cy: a[1] + uy, r }
}

export type ArcFitSeg = { x: number; y: number; arc?: { cx: number; cy: number; cw: boolean } }

// Convert a polyline to a list of G1/G2/G3 motion endpoints.
// Arc spans where all points fit within `tol` of a circle are collapsed to a single arc segment.
// The first point of `pts` is the current position (not emitted); segments cover pts[1..n-1].
//
// `maxSpan` caps how many points a single arc may absorb. The fit re-validates the
// whole candidate span on every growth step (O(span²) per arc), so on long smooth
// runs (spiral/morph/adaptive pockets) an uncapped span makes this quadratic in the
// run length. Capping bounds the cost to O(n·maxSpan); a longer-than-cap arc is just
// emitted as a few arcs instead of one. Default Infinity keeps prior callers exact.
export function arcFitPolyline(pts: Pt2[], tol: number, maxSpan = Infinity): ArcFitSeg[] {
  const result: ArcFitSeg[] = []
  const n = pts.length
  let i = 0
  while (i < n - 1) {
    let bestJ = -1
    let bestCircle: { cx: number; cy: number; r: number } | null = null
    const jCap = Math.min(n - 1, i + maxSpan)
    for (let j = Math.min(i + 2, n - 1); j <= jCap; j++) {
      const mid = (i + j) >> 1
      const c = circleFrom3Pts(pts[i], pts[mid], pts[j])
      if (!c) break
      let ok = true
      for (let k = i + 1; k <= j; k++) {
        if (Math.abs(Math.hypot(pts[k][0] - c.cx, pts[k][1] - c.cy) - c.r) > tol) {
          ok = false
          break
        }
      }
      if (ok) { bestJ = j; bestCircle = c }
      else break
    }
    if (bestJ >= i + 3 && bestCircle) {
      const s = pts[i], e = pts[bestJ], m = pts[(i + bestJ) >> 1]
      // Sagitta = bow height from midpoint to chord.  Near-zero = effectively straight.
      const sagitta = dist(m[0], m[1], s[0], s[1], e[0], e[1])
      // Local circle from first three interior points — this approximates the true arc.
      // pts[i] must also lie on this circle; if it doesn't, pts[i] is a line endpoint
      // adjacent to the arc start (arc tangent point), not the arc start itself.
      const localC = circleFrom3Pts(pts[i + 1], pts[i + 2], pts[i + 3])
      const startOnArc = localC !== null &&
        Math.abs(Math.hypot(s[0] - localC.cx, s[1] - localC.cy) - localC.r) <= tol
      // Reject spans containing sharp corners (polygon vertices lying on circumscribed circle).
      // Real flattened arcs have tiny per-segment direction changes; polygon corners are ≥60°.
      let hasSharpCorner = false
      for (let k = i + 1; k < bestJ; k++) {
        const ax = pts[k][0] - pts[k - 1][0], ay = pts[k][1] - pts[k - 1][1]
        const bx = pts[k + 1][0] - pts[k][0], by = pts[k + 1][1] - pts[k][1]
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by)
        if (la < 1e-10 || lb < 1e-10) continue
        if ((ax * bx + ay * by) / (la * lb) < 0.707) { hasSharpCorner = true; break } // > 45°
      }
      if (false &&sagitta > 0.05 && startOnArc && !hasSharpCorner) {
        // Signed area of triangle (s,m,e): positive = CCW in CNC Y-up
        const triArea = (m[0] - s[0]) * (e[1] - s[1]) - (m[1] - s[1]) * (e[0] - s[0])
        result.push({ x: e[0], y: e[1], arc: { cx: bestCircle.cx, cy: bestCircle.cy, cw: triArea < 0 } })
        i = bestJ
      } else {
        result.push({ x: pts[i + 1][0], y: pts[i + 1][1] })
        i++
      }
    } else {
      result.push({ x: pts[i + 1][0], y: pts[i + 1][1] })
      i++
    }
  }
  return result
}

// Iterative Ramer-Douglas-Peucker simplification.
// Reduces a dense polyline to the minimum set of points that deviate no more
// than `tol` from the original curve. Runs in O(n log n) average.
export function douglasPeucker(pts: Pt2[], tol: number): Pt2[] {
  const n = pts.length
  if (n <= 2) return [...pts]
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!
    if (hi <= lo + 1) continue
    const ax = pts[lo][0], ay = pts[lo][1], bx = pts[hi][0], by = pts[hi][1]
    let maxD = 0, split = lo
    for (let i = lo + 1; i < hi; i++) {
      const d = dist(pts[i][0], pts[i][1], ax, ay, bx, by)
      if (d > maxD) { maxD = d; split = i }
    }
    if (maxD > tol) {
      keep[split] = 1
      stack.push([lo, split], [split, hi])
    }
  }
  return pts.filter((_, i) => keep[i])
}


// Compute signed area via shoelace (positive = CCW in Y-up system)
export function signedArea(pts: Pt2[]): number {
  let area = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
  }
  return area / 2
}

// Rotate a closed polyline so the point nearest (x, y) becomes first.
export function rotatePolylineNear(pts: Pt2[], x: number, y: number): Pt2[] {
  let best = 0, bestDist = Infinity
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i][0] - x) ** 2 + (pts[i][1] - y) ** 2
    if (d < bestDist) { bestDist = d; best = i }
  }
  return best === 0 ? pts : [...pts.slice(best), ...pts.slice(0, best)]
}

// Ensure polygon has the requested winding. Returns input unchanged or reversed.
export function ensureWinding(pts: Pt2[], wantCCW: boolean): Pt2[] {
  const isCCW = signedArea(pts) >= 0
  return isCCW === wantCCW ? pts : [...pts].reverse()
}

// ─── Self-intersection splitting ──────────────────────────────────────────────
// Used by VCarve, Profile, and Pocket to decompose self-touching or self-crossing
// polygons (e.g. letter K, figure-8) into simple loops before passing to JSPoly
// or Clipper2, both of which expect non-self-intersecting input.

export function sharesVertex(a: Pt2[], b: Pt2[], tol = 0.01): boolean {
  for (const pa of a) {
    for (const pb of b) {
      if (Math.abs(pa[0] - pb[0]) < tol && Math.abs(pa[1] - pb[1]) < tol) return true
    }
  }
  return false
}

export function splitSelfTouching(pts: Pt2[], tol = 0.01): Pt2[][] {
  const n = pts.length
  const checkLen = (n > 1 &&
    Math.abs(pts[0][0] - pts[n-1][0]) < tol &&
    Math.abs(pts[0][1] - pts[n-1][1]) < tol) ? n - 1 : n
  for (let i = 0; i < checkLen - 2; i++) {
    for (let j = i + 2; j < checkLen; j++) {
      if (Math.abs(pts[i][0] - pts[j][0]) < tol && Math.abs(pts[i][1] - pts[j][1]) < tol) {
        const loop1 = pts.slice(i, j + 1)
        const loop2 = [...pts.slice(j, checkLen), ...pts.slice(0, i + 1)]
        return [...splitSelfTouching(loop1, tol), ...splitSelfTouching(loop2, tol)]
      }
    }
  }
  return [pts]
}

function segIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): Pt2 | null {
  const denom = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx)
  if (Math.abs(denom) < 1e-10) return null
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denom
  const s = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denom
  if (t <= 1e-9 || t >= 1 - 1e-9 || s <= 1e-9 || s >= 1 - 1e-9) return null
  return [ax + t * (bx - ax), ay + t * (by - ay)]
}

export function splitAtIntersections(pts: Pt2[], tol = 0.01): Pt2[][] {
  const n = pts.length
  const isClosedDup = n > 1 &&
    Math.abs(pts[0][0] - pts[n-1][0]) < tol &&
    Math.abs(pts[0][1] - pts[n-1][1]) < tol
  const poly = isClosedDup ? pts.slice(0, -1) : pts
  const m = poly.length
  if (m < 4) return [pts]
  for (let i = 0; i < m; i++) {
    const i1 = (i + 1) % m
    for (let j = i + 2; j < m; j++) {
      const j1 = (j + 1) % m
      if (j1 === i) continue
      const X = segIntersect(
        poly[i][0], poly[i][1], poly[i1][0], poly[i1][1],
        poly[j][0], poly[j][1], poly[j1][0], poly[j1][1],
      )
      if (!X) continue
      const loop1: Pt2[] = [X, ...poly.slice(i1, j + 1), X]
      const loop2: Pt2[] = [...poly.slice(0, i1), X, ...(j1 > 0 ? poly.slice(j1) : []), poly[0]]
      return [...splitAtIntersections(loop1, tol), ...splitAtIntersections(loop2, tol)]
    }
  }
  return [pts]
}

// Convenience: split any self-touching or self-crossing subpaths into simple loops.
export function splitSelfIntersecting(subpaths: Pt2[][]): Pt2[][] {
  return subpaths
    .filter(s => s.length >= 3)
    .flatMap(s => splitSelfTouching(s))
    .filter(s => s.length >= 3)
    .flatMap(s => splitAtIntersections(s))
    .filter(s => s.length >= 3)
}

