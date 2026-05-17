import type { PathNode } from '../canvas/nodeUtils'
import { parseDToNodes, nodesToD } from '../canvas/nodeUtils'

export type CornerTreatmentType = 'outerRound' | 'innerRound' | 'chamfer' | 'dogbone'

export interface CornerTreatmentParams {
  type: CornerTreatmentType
  radiusMM: number
}

function norm(x: number, y: number) {
  const len = Math.hypot(x, y)
  return len < 1e-10 ? { x: 0, y: 0 } : { x: x / len, y: y / len }
}

function dist2(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

// Bezier handle length approximating a circular arc of given angle and radius
function arcHandle(angleDeg: number, r: number) {
  return (4 / 3) * Math.tan((angleDeg * Math.PI) / 720) * r
}

export function applyCornerTreatment(d: string, params: CornerTreatmentParams): string {
  const { nodes, closed } = parseDToNodes(d)
  if (nodes.length < 2) return d

  const r = Math.max(0.001, params.radiusMM)
  const n = nodes.length
  const newNodes: PathNode[] = []

  for (let i = 0; i < n; i++) {
    const node = nodes[i]

    // Skip endpoints of open paths
    if (!closed && (i === 0 || i === n - 1)) {
      newNodes.push(node)
      continue
    }

    // Only treat sharp (corner) nodes — no bezier handles
    if (node.handleIn || node.handleOut) {
      newNodes.push(node)
      continue
    }

    const prevIdx = (i - 1 + n) % n
    const nextIdx = (i + 1) % n
    const prev = nodes[prevIdx]
    const next = nodes[nextIdx]

    // Tangent directions, accounting for adjacent bezier handles
    const tin = prev.handleOut
      ? norm(node.x - prev.handleOut.x, node.y - prev.handleOut.y)
      : norm(node.x - prev.x, node.y - prev.y)
    const tout = next.handleIn
      ? norm(next.handleIn.x - node.x, next.handleIn.y - node.y)
      : norm(next.x - node.x, next.y - node.y)

    if ((tin.x === 0 && tin.y === 0) || (tout.x === 0 && tout.y === 0)) {
      newNodes.push(node)
      continue
    }

    // theta = angle between the two tangent vectors (0 = same dir, π = reversal)
    const dot = Math.max(-1, Math.min(1, tin.x * tout.x + tin.y * tout.y))
    const cross = tin.x * tout.y - tin.y * tout.x
    const theta = Math.acos(dot)

    if (theta < 0.05 || Math.PI - theta < 0.05) {
      newNodes.push(node)
      continue
    }

    const dPrev = dist2(prev, node)
    const dNext = dist2(node, next)

    // ── Chamfer / Outer Round / Inner Round ───────────────────────────────────
    // Setback = r along each edge from the corner
    if (params.type !== 'dogbone') {
      const rc = Math.min(r, Math.min(dPrev, dNext) * 0.45)
      if (rc < 0.001) { newNodes.push(node); continue }

      const p1 = { x: node.x - tin.x * rc, y: node.y - tin.y * rc }
      const p2 = { x: node.x + tout.x * rc, y: node.y + tout.y * rc }

      // Exterior turn angle in degrees (how much direction changes at corner)
      const turnDeg = (Math.PI - theta) * (180 / Math.PI)
      const h = arcHandle(turnDeg, rc)

      switch (params.type) {
        case 'chamfer':
          newNodes.push({ x: p1.x, y: p1.y })
          newNodes.push({ x: p2.x, y: p2.y })
          break

        case 'outerRound':
          // Arc bulges away from the interior of the corner
          newNodes.push({ x: p1.x, y: p1.y, handleOut: { x: p1.x + tin.x * h, y: p1.y + tin.y * h } })
          newNodes.push({ x: p2.x, y: p2.y, handleIn: { x: p2.x - tout.x * h, y: p2.y - tout.y * h } })
          break

        case 'innerRound':
          // Arc bulges toward the interior of the corner (fillet / concave)
          newNodes.push({ x: p1.x, y: p1.y, handleOut: { x: p1.x + tout.x * h, y: p1.y + tout.y * h } })
          newNodes.push({ x: p2.x, y: p2.y, handleIn: { x: p2.x - tin.x * h, y: p2.y - tin.y * h } })
          break
      }
      continue
    }

    // ── Dogbone ───────────────────────────────────────────────────────────────
    // The dogbone circle is centered at C = N + bisector*r, where bisector points
    // into the "mouth" of the corner.  The circle has radius r and passes through N.
    // The circle also intersects the two edges at P_in and P_out, which are
    // diametrically opposite each other (setback = 2r·sin(θ/2) along each edge).
    // The path replaces the corner with: P_in → semicircle through N → P_out.
    {
      // Bisector = normalize(-t_in + t_out) points into the corner mouth
      const bx = -tin.x + tout.x, by = -tin.y + tout.y
      const bLen = Math.hypot(bx, by)
      if (bLen < 0.01) { newNodes.push(node); continue }
      const bisector = { x: bx / bLen, y: by / bLen }

      // Circle center
      const cx = node.x + bisector.x * r
      const cy = node.y + bisector.y * r

      // Distance along each edge from N to the circle intersection
      // Proof: since N is on the circle, |N - C| = r.  Edge direction tin.
      // Point on edge: N - tin*t.  Solve |(N - tin*t) - C|² = r².
      // → t² - 2(D·tin)t = 0 where D = N-C = -bisector*r
      // → t = 2·(D·tin) = 2·(-bisector·tin)·r = 2·r·sin(θ/2)
      const setback = 2 * r * Math.sin(theta / 2)

      // Skip if the setback would overrun the adjacent segments
      if (setback > dPrev * 0.9 || setback > dNext * 0.9) {
        newNodes.push(node)
        continue
      }

      const P_in  = { x: node.x - tin.x  * setback, y: node.y - tin.y  * setback }
      const P_out = { x: node.x + tout.x * setback, y: node.y + tout.y * setback }

      // The arc is a semicircle split into two 90° bezier arcs: P_in → N → P_out
      // Arc direction matches the corner turn direction (CCW turn → CCW arc)
      const dir = cross >= 0 ? 1 : -1   // +1 = CCW, -1 = CW

      const k = arcHandle(90, r)   // handle length for 90° arc

      // Tangent function on the circle at angle a, in the arc direction
      const arcTan = (a: number) => ({
        x: dir * -Math.sin(a),
        y: dir *  Math.cos(a),
      })

      const a_in  = Math.atan2(P_in.y  - cy, P_in.x  - cx)
      const a_N   = Math.atan2(node.y  - cy, node.x  - cx)
      const a_out = Math.atan2(P_out.y - cy, P_out.x - cx)

      const tIn  = arcTan(a_in)
      const tN   = arcTan(a_N)
      const tOut = arcTan(a_out)

      newNodes.push(
        // P_in: sharp entry from the incoming edge, departs along arc tangent
        {
          x: P_in.x, y: P_in.y,
          handleOut: { x: P_in.x + tIn.x * k, y: P_in.y + tIn.y * k },
        },
        // N: smooth midpoint of the semicircle
        {
          x: node.x, y: node.y,
          handleIn:  { x: node.x - tN.x * k, y: node.y - tN.y * k },
          handleOut: { x: node.x + tN.x * k, y: node.y + tN.y * k },
        },
        // P_out: arc arrives, sharp exit along the outgoing edge
        {
          x: P_out.x, y: P_out.y,
          handleIn: { x: P_out.x - tOut.x * k, y: P_out.y - tOut.y * k },
        },
      )
    }
  }

  return nodesToD(newNodes, closed)
}
