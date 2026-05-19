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
  pts: Pt2[]
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
  const steps = Math.max(4, Math.ceil(Math.abs(dTheta) * Math.max(rxA, ryA) / 0.25))
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
          arcFlat(cx, cy, n[i], n[i+1], n[i+2], n[i+3], n[i+4], n[i+5], n[i+6], current)
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

// Intersection of open line segments (a→b) and (c→d). Returns null if parallel or endpoint-only.
function segIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): Pt2 | null {
  const rx = bx - ax, ry = by - ay
  const sx = dx - cx, sy = dy - cy
  const d = rx * sy - ry * sx
  if (Math.abs(d) < 1e-10) return null
  const t = ((cx - ax) * sy - (cy - ay) * sx) / d
  const u = ((cx - ax) * ry - (cy - ay) * rx) / d
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9
    ? [ax + t * rx, ay + t * ry]
    : null
}

// Remove self-intersecting loops from an offset polygon. Iteratively finds the
// first self-crossing and retains the larger (outer) sub-polygon until clean.
// safetyDelta: push the bridge point this far outward (away from the inner loop)
// so the tool centre never dips inside the original shape at concave features.
export function resolveOffsetLoops(pts: Pt2[], safetyDelta = 0): Pt2[] {
  let poly = [...pts]
  for (let iter = 0; iter < 30; iter++) {
    const n = poly.length
    if (n < 4) break
    let found = false
    outer: for (let i = 0; i < n - 1; i++) {
      const ax = poly[i][0], ay = poly[i][1]
      const bx = poly[i + 1][0], by = poly[i + 1][1]
      const jEnd = i === 0 ? n - 1 : n   // skip closing-edge pair (shares vertex 0)
      for (let j = i + 2; j < jEnd; j++) {
        const p = segIntersect(ax, ay, bx, by,
          poly[j][0], poly[j][1], poly[(j + 1) % n][0], poly[(j + 1) % n][1])
        if (p) {
          // Compute a safe bridge point: push p away from the inner-loop centroid
          // so the tool doesn't cut into a concave feature (e.g. heart V-notch).
          let bridge: Pt2 = p
          if (safetyDelta > 0) {
            let icx = 0, icy = 0
            for (let k = i + 1; k <= j; k++) { icx += poly[k][0]; icy += poly[k][1] }
            const cnt = j - i
            icx /= cnt; icy /= cnt
            const odx = p[0] - icx, ody = p[1] - icy
            const olen = Math.hypot(odx, ody)
            if (olen > 1e-6) bridge = [p[0] + (odx / olen) * safetyDelta, p[1] + (ody / olen) * safetyDelta]
          }
          const loopA: Pt2[] = [...poly.slice(0, i + 1), bridge, ...poly.slice(j + 1)]
          const loopB: Pt2[] = [...poly.slice(i + 1, j + 1), p]
          poly = Math.abs(signedArea(loopA)) >= Math.abs(signedArea(loopB)) ? loopA : loopB
          found = true
          break outer
        }
      }
    }
    if (!found) break
  }
  return poly
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
export function arcFitPolyline(pts: Pt2[], tol: number): ArcFitSeg[] {
  const result: ArcFitSeg[] = []
  const n = pts.length
  let i = 0
  while (i < n - 1) {
    let bestJ = -1
    let bestCircle: { cx: number; cy: number; r: number } | null = null
    for (let j = Math.min(i + 2, n - 1); j < n; j++) {
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
      if (sagitta > 0.05 && startOnArc) {
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

// Detect whether a closed polygon's edges properly intersect (O(n²)).
// Skips adjacent edge pairs that share a vertex.
export function hasSelfIntersection(pts: Pt2[]): boolean {
  const n = pts.length
  for (let i = 0; i < n - 1; i++) {
    const ax = pts[i][0], ay = pts[i][1]
    const bx = pts[(i + 1) % n][0], by = pts[(i + 1) % n][1]
    // When i=0 skip j=n-1: that edge shares pts[0] (adjacent via the closing seam)
    const jEnd = i === 0 ? n - 1 : n
    for (let j = i + 2; j < jEnd; j++) {
      const cx = pts[j][0], cy = pts[j][1]
      const dx = pts[(j + 1) % n][0], dy = pts[(j + 1) % n][1]
      const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax)
      const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx)
      const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx)
      if (d1 * d2 < -1e-10 && d3 * d4 < -1e-10) return true
    }
  }
  return false
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

// Offset a closed polygon by delta mm. Positive = expand outward (CCW).
export function offsetPolygon(pts: Pt2[], delta: number): Pt2[] {
  // Remove near-duplicate consecutive points
  const u: Pt2[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    if (Math.hypot(pts[i][0] - u[u.length-1][0], pts[i][1] - u[u.length-1][1]) > 1e-6) u.push(pts[i])
  }
  // Remove closing duplicate (last ≈ first) so the polygon has no degenerate edge at the seam
  if (u.length > 1 && Math.hypot(u[u.length-1][0] - u[0][0], u[u.length-1][1] - u[0][1]) < 1e-6) u.pop()
  if (u.length < 3) return []

  // Simplify before offset. Dense polylines from DXF line-segment approximations
  // (e.g. gear teeth at 0.02–0.05 mm/segment) create near-collinear vertex clusters
  // that produce huge miter spikes and false self-intersection detections.
  // Open the closed polygon at u[0], run D-P, then drop the re-appended closing point.
  // Tolerance: 2% of |delta|, floor 0.001 mm — well within CNC accuracy.
  const dpTol = Math.max(1e-3, Math.abs(delta) * 0.02)
  const opened = [...u, u[0]]
  const simplified = douglasPeucker(opened, dpTol)
  simplified.pop()
  const v = simplified.length >= 3 ? simplified : u

  const n = v.length
  if (n < 3) return []

  const area = signedArea(v)
  // Normalise winding so that positive delta = outward offset
  // CCW polygon (area > 0) in Y-up: outward normal is to the left of travel direction → (-dy, dx)/len
  // For CW polygon, flip sign
  const windSign = area >= 0 ? 1 : -1

  const en: Pt2[] = []
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const dx = v[j][0] - v[i][0], dy = v[j][1] - v[i][1]
    const len = Math.hypot(dx, dy)
    // CCW (windSign=1): outward = right of travel = (dy, -dx)/len
    // CW  (windSign=-1): outward = left of travel = (-dy, dx)/len
    en.push(len < 1e-10 ? [0, 0] : [dy * windSign / len, -dx * windSign / len])
  }

  const result: Pt2[] = []
  for (let i = 0; i < n; i++) {
    const prev = en[(i - 1 + n) % n]
    const next = en[i]
    const bx = prev[0] + next[0], by = prev[1] + next[1]
    const blen = Math.hypot(bx, by)
    if (blen < 1e-10) {
      result.push([v[i][0] + next[0] * delta, v[i][1] + next[1] * delta])
    } else {
      const nx = bx / blen, ny = by / blen
      const dot = next[0] * nx + next[1] * ny
      // Cap miter at 4× to avoid spikes at very sharp corners
      const scale = Math.abs(dot) > 0.25 ? delta / dot : delta * 4 * Math.sign(dot || 1)
      result.push([v[i][0] + nx * scale, v[i][1] + ny * scale])
    }
  }
  return result
}
