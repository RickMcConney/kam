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

// Compute signed area via shoelace (positive = CCW in Y-up system)
export function signedArea(pts: Pt2[]): number {
  let area = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
  }
  return area / 2
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
  const n = u.length
  if (n < 3) return []

  const area = signedArea(u)
  // Normalise winding so that positive delta = outward offset
  // CCW polygon (area > 0) in Y-up: outward normal is to the left of travel direction → (-dy, dx)/len
  // For CW polygon, flip sign
  const windSign = area >= 0 ? 1 : -1

  const en: Pt2[] = []
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const dx = u[j][0] - u[i][0], dy = u[j][1] - u[i][1]
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
      result.push([u[i][0] + next[0] * delta, u[i][1] + next[1] * delta])
    } else {
      const nx = bx / blen, ny = by / blen
      const dot = next[0] * nx + next[1] * ny
      // Cap miter at 4× to avoid spikes at very sharp corners
      const scale = Math.abs(dot) > 0.25 ? delta / dot : delta * 4 * Math.sign(dot || 1)
      result.push([u[i][0] + nx * scale, u[i][1] + ny * scale])
    }
  }
  return result
}
