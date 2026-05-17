// Offset tool: inset/outset a path by a distance with configurable corner styles.
// Converts to polyline, offsets, and converts back to a d string.

import { flattenPath, signedArea } from '../cam/pathFlattener'
import type { Pt2 } from '../cam/pathFlattener'

export type OffsetCornerStyle = 'miter' | 'round' | 'square'

export interface OffsetOpParams {
  distanceMM: number        // positive = outset, negative = inset
  cornerStyle: OffsetCornerStyle
  joinPaths?: boolean       // if true, merge all subpaths into one result
}

function offsetRing(pts: Pt2[], delta: number, style: OffsetCornerStyle): Pt2[] {
  // Remove near-duplicate consecutive points and closing duplicate
  const u: Pt2[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    if (Math.hypot(pts[i][0] - u[u.length - 1][0], pts[i][1] - u[u.length - 1][1]) > 1e-6) u.push(pts[i])
  }
  if (u.length > 1 && Math.hypot(u[u.length - 1][0] - u[0][0], u[u.length - 1][1] - u[0][1]) < 1e-6) u.pop()
  const n = u.length
  if (n < 3) return []

  const area = signedArea(u)
  const windSign = area >= 0 ? 1 : -1

  // Edge normals (outward)
  const en: Pt2[] = []
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const dx = u[j][0] - u[i][0], dy = u[j][1] - u[i][1]
    const len = Math.hypot(dx, dy)
    en.push(len < 1e-10 ? [0, 0] : [dy * windSign / len, -dx * windSign / len])
  }

  if (style === 'miter') {
    return miterOffset(u, en, delta)
  } else if (style === 'round') {
    return roundOffset(u, en, delta)
  } else {
    return squareOffset(u, en, delta)
  }
}

function miterOffset(u: Pt2[], en: Pt2[], delta: number): Pt2[] {
  const n = u.length
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
      const scale = Math.abs(dot) > 0.2 ? delta / dot : delta * 5 * Math.sign(dot || 1)
      result.push([u[i][0] + nx * scale, u[i][1] + ny * scale])
    }
  }
  return result
}

function roundOffset(u: Pt2[], en: Pt2[], delta: number): Pt2[] {
  const n = u.length
  const windSign = signedArea(u) >= 0 ? 1 : -1
  const result: Pt2[] = []
  for (let i = 0; i < n; i++) {
    const prev = en[(i - 1 + n) % n]
    const next = en[i]
    const cross = prev[0] * next[1] - prev[1] * next[0]
    // Convex for outset = normals diverge; for inset, concave corners diverge
    const isConvex = cross * windSign * Math.sign(delta || 1) > 0

    if (isConvex && Math.abs(delta) > 0.01) {
      // Insert arc at convex corner
      const cx = u[i][0], cy = u[i][1]
      const a0 = Math.atan2(prev[1], prev[0])
      const a1 = Math.atan2(next[1], next[0])
      let dA = a1 - a0
      if (delta > 0) {
        if (dA < 0) dA += 2 * Math.PI
      } else {
        if (dA > 0) dA -= 2 * Math.PI
      }
      const steps = Math.max(3, Math.ceil(Math.abs(dA * Math.abs(delta)) / 0.5))
      for (let k = 0; k <= steps; k++) {
        const a = a0 + (k / steps) * dA
        result.push([cx + Math.cos(a) * delta, cy + Math.sin(a) * delta])
      }
    } else {
      // Concave corner or inset: use miter bisector
      const bx = prev[0] + next[0], by = prev[1] + next[1]
      const blen = Math.hypot(bx, by)
      if (blen < 1e-10) {
        result.push([u[i][0] + next[0] * delta, u[i][1] + next[1] * delta])
      } else {
        const nx = bx / blen, ny = by / blen
        const dot = next[0] * nx + next[1] * ny
        const scale = Math.abs(dot) > 0.2 ? delta / dot : delta * 5 * Math.sign(dot || 1)
        result.push([u[i][0] + nx * scale, u[i][1] + ny * scale])
      }
    }
  }
  return result
}

function squareOffset(u: Pt2[], en: Pt2[], delta: number): Pt2[] {
  const n = u.length
  const windSign = signedArea(u) >= 0 ? 1 : -1
  const result: Pt2[] = []
  for (let i = 0; i < n; i++) {
    const prev = en[(i - 1 + n) % n]
    const next = en[i]
    const cross = prev[0] * next[1] - prev[1] * next[0]
    const isConvex = cross * windSign * Math.sign(delta || 1) > 0

    if (isConvex) {
      // Square cap: cap face perpendicular to bisector, at exactly |delta| from vertex.
      // Find where each adjacent offset-edge line pierces that cap face.
      const sumx = prev[0] + next[0], sumy = prev[1] + next[1]
      const blen = Math.hypot(sumx, sumy)
      if (blen < 1e-10) {
        result.push([u[i][0] + next[0] * delta, u[i][1] + next[1] * delta])
      } else {
        const bux = sumx / blen, buy = sumy / blen
        // Cap face midpoint M = vertex + bisector * delta  (distance |delta| from vertex)
        const mx = u[i][0] + bux * delta, my = u[i][1] + buy * delta

        // Previous edge offset endpoint + edge tangent
        const ax = u[i][0] + prev[0] * delta, ay = u[i][1] + prev[1] * delta
        const tpx = windSign * -prev[1], tpy = windSign * prev[0]
        const da = (ax - mx) * bux + (ay - my) * buy
        const dp = tpx * bux + tpy * buy
        result.push(Math.abs(dp) > 1e-10
          ? [ax - da / dp * tpx, ay - da / dp * tpy]
          : [ax, ay])

        // Next edge offset endpoint + edge tangent
        const qx = u[i][0] + next[0] * delta, qy = u[i][1] + next[1] * delta
        const tnx = windSign * -next[1], tny = windSign * next[0]
        const db = (qx - mx) * bux + (qy - my) * buy
        const dn = tnx * bux + tny * buy
        result.push(Math.abs(dn) > 1e-10
          ? [qx - db / dn * tnx, qy - db / dn * tny]
          : [qx, qy])
      }
    } else {
      // Concave corner: miter bisector to avoid self-intersection
      const bx = prev[0] + next[0], by = prev[1] + next[1]
      const blen = Math.hypot(bx, by)
      if (blen < 1e-10) {
        result.push([u[i][0] + next[0] * delta, u[i][1] + next[1] * delta])
      } else {
        const nx = bx / blen, ny = by / blen
        const dot = next[0] * nx + next[1] * ny
        const scale = Math.abs(dot) > 0.2 ? delta / dot : delta * 5 * Math.sign(dot || 1)
        result.push([u[i][0] + nx * scale, u[i][1] + ny * scale])
      }
    }
  }
  return result
}

function ptsToD(pts: Pt2[]): string {
  if (pts.length < 2) return ''
  const [sx, sy] = pts[0]
  const parts = [`M ${sx.toFixed(4)} ${sy.toFixed(4)}`]
  for (let i = 1; i < pts.length; i++) {
    parts.push(`L ${pts[i][0].toFixed(4)} ${pts[i][1].toFixed(4)}`)
  }
  parts.push('Z')
  return parts.join(' ')
}

export function applyOffset(d: string, params: OffsetOpParams): string {
  const subpaths = flattenPath(d, 0.05)
  const results: string[] = []
  for (const sp of subpaths) {
    const offsetted = offsetRing(sp, params.distanceMM, params.cornerStyle)
    if (offsetted.length >= 3) {
      results.push(ptsToD(offsetted))
    }
  }
  return results.join(' ')
}
