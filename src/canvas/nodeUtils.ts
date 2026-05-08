export type PathNode = {
  x: number
  y: number
  handleIn?: { x: number; y: number }
  handleOut?: { x: number; y: number }
}

function lerp(a: { x: number; y: number }, b: { x: number; y: number }, t: number) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function evalCubic(
  p0: { x: number; y: number },
  c1: { x: number; y: number },
  c2: { x: number; y: number },
  p3: { x: number; y: number },
  t: number
) {
  const q0 = lerp(p0, c1, t)
  const q1 = lerp(c1, c2, t)
  const q2 = lerp(c2, p3, t)
  const r0 = lerp(q0, q1, t)
  const r1 = lerp(q1, q2, t)
  return lerp(r0, r1, t)
}

// Convert an SVG arc to one or more cubic bezier segments (SVG spec appendix F)
function arcToCubics(
  x1: number, y1: number,
  rx: number, ry: number,
  phiDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number, y2: number,
): Array<[number, number, number, number, number, number]> {
  if (x1 === x2 && y1 === y2) return []
  if (rx === 0 || ry === 0) return [[x2, y2, x2, y2, x2, y2]]

  const phi = (phiDeg * Math.PI) / 180
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi)
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const x1p = cosPhi * dx + sinPhi * dy
  const y1p = -sinPhi * dx + cosPhi * dy

  rx = Math.abs(rx); ry = Math.abs(ry)
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s }

  const rx2 = rx * rx, ry2 = ry * ry, x1p2 = x1p * x1p, y1p2 = y1p * y1p
  const num = Math.max(0, rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2)
  const den = rx2 * y1p2 + ry2 * x1p2
  const k = (largeArc !== sweep ? 1 : -1) * Math.sqrt(den === 0 ? 0 : num / den)
  const cxp = (k * rx * y1p) / ry
  const cyp = (-k * ry * x1p) / rx
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2

  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
    const a = Math.acos(Math.max(-1, Math.min(1, dot / len)))
    return ux * vy - uy * vx < 0 ? -a : a
  }
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry
  let theta1 = ang(1, 0, ux, uy)
  let dTheta = ang(ux, uy, vx, vy)
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI

  const segs = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)))
  const result: Array<[number, number, number, number, number, number]> = []
  for (let i = 0; i < segs; i++) {
    const a1 = theta1 + (i * dTheta) / segs
    const a2 = theta1 + ((i + 1) * dTheta) / segs
    const alpha = (4 / 3) * Math.tan((a2 - a1) / 4)
    const cos1 = Math.cos(a1), sin1 = Math.sin(a1)
    const cos2 = Math.cos(a2), sin2 = Math.sin(a2)
    const toW = (ex: number, ey: number) => ({
      x: cosPhi * ex - sinPhi * ey + cx,
      y: sinPhi * ex + cosPhi * ey + cy,
    })
    const c1 = toW(rx * cos1 - alpha * rx * sin1, ry * sin1 + alpha * ry * cos1)
    const c2 = toW(rx * cos2 + alpha * rx * sin2, ry * sin2 - alpha * ry * cos2)
    const ep = toW(rx * cos2, ry * sin2)
    result.push([c1.x, c1.y, c2.x, c2.y, ep.x, ep.y])
  }
  return result
}

export function splitCompoundPath(d: string): string[] {
  const tokens = d.match(/[MmLlCcSsQqTtAaZz]|[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g) ?? []
  const subpaths: string[] = []
  let current: string[] = []
  for (const tok of tokens) {
    if (tok === 'M' && current.length > 0) {
      subpaths.push(current.join(' '))
      current = []
    }
    current.push(tok)
  }
  if (current.length > 0) subpaths.push(current.join(' '))
  return subpaths.filter((s) => s.trim().length > 1)
}

export function parseDToNodes(d: string): { nodes: PathNode[]; closed: boolean } {
  // Tokenize properly: split command letters from numbers (handles compact "M10,20" format)
  const tokens = d.match(/[MmLlCcSsQqTtAaZz]|[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g) ?? []
  const nodes: PathNode[] = []
  let closed = false
  let i = 0

  while (i < tokens.length) {
    const cmd = tokens[i++]
    if (cmd === 'M') {
      nodes.push({ x: parseFloat(tokens[i++]), y: parseFloat(tokens[i++]) })
    } else if (cmd === 'L') {
      nodes.push({ x: parseFloat(tokens[i++]), y: parseFloat(tokens[i++]) })
    } else if (cmd === 'C') {
      const c1x = parseFloat(tokens[i++]), c1y = parseFloat(tokens[i++])
      const c2x = parseFloat(tokens[i++]), c2y = parseFloat(tokens[i++])
      const ex = parseFloat(tokens[i++]), ey = parseFloat(tokens[i++])
      if (nodes.length > 0) nodes[nodes.length - 1].handleOut = { x: c1x, y: c1y }
      nodes.push({ x: ex, y: ey, handleIn: { x: c2x, y: c2y } })
    } else if (cmd === 'A') {
      const rx = parseFloat(tokens[i++]), ry = parseFloat(tokens[i++])
      const xRot = parseFloat(tokens[i++])
      const largeArc = tokens[i++] === '1'
      const sweep = tokens[i++] === '1'
      const ex = parseFloat(tokens[i++]), ey = parseFloat(tokens[i++])
      if (nodes.length > 0) {
        const prev = nodes[nodes.length - 1]
        const cubics = arcToCubics(prev.x, prev.y, rx, ry, xRot, largeArc, sweep, ex, ey)
        for (const [c1x, c1y, c2x, c2y, epx, epy] of cubics) {
          nodes[nodes.length - 1].handleOut = { x: c1x, y: c1y }
          nodes.push({ x: epx, y: epy, handleIn: { x: c2x, y: c2y } })
        }
      } else {
        nodes.push({ x: ex, y: ey })
      }
    } else if (cmd === 'Z' || cmd === 'z') {
      closed = true
    }
  }

  // Font paths often explicitly close back to the start (last node coincident with node[0]).
  // Merge that duplicate: transfer its handleIn to node[0] so the closing bezier is preserved.
  if (closed && nodes.length >= 2) {
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (Math.abs(last.x - first.x) < 0.001 && Math.abs(last.y - first.y) < 0.001) {
      if (last.handleIn) first.handleIn = last.handleIn
      nodes.pop()
    }
  }

  return { nodes, closed }
}

export function nodesToD(nodes: PathNode[], closed: boolean): string {
  if (nodes.length === 0) return ''
  let d = `M ${nodes[0].x} ${nodes[0].y}`

  for (let i = 1; i < nodes.length; i++) {
    const prev = nodes[i - 1]
    const curr = nodes[i]
    if (!prev.handleOut && !curr.handleIn) {
      d += ` L ${curr.x} ${curr.y}`
    } else {
      d += ` C ${prev.handleOut?.x ?? prev.x} ${prev.handleOut?.y ?? prev.y} ${curr.handleIn?.x ?? curr.x} ${curr.handleIn?.y ?? curr.y} ${curr.x} ${curr.y}`
    }
  }

  if (closed && nodes.length >= 2) {
    const prev = nodes[nodes.length - 1]
    const curr = nodes[0]
    if (!prev.handleOut && !curr.handleIn) {
      d += ' Z'
    } else {
      d += ` C ${prev.handleOut?.x ?? prev.x} ${prev.handleOut?.y ?? prev.y} ${curr.handleIn?.x ?? curr.x} ${curr.handleIn?.y ?? curr.y} ${curr.x} ${curr.y} Z`
    }
  }

  return d
}

export function removeNode(nodes: PathNode[], idx: number): PathNode[] {
  return nodes.filter((_, i) => i !== idx)
}

function splitCubicAt(
  p0: { x: number; y: number },
  c1: { x: number; y: number },
  c2: { x: number; y: number },
  p3: { x: number; y: number },
  t: number
) {
  const q0 = lerp(p0, c1, t)
  const q1 = lerp(c1, c2, t)
  const q2 = lerp(c2, p3, t)
  const r0 = lerp(q0, q1, t)
  const r1 = lerp(q1, q2, t)
  const s = lerp(r0, r1, t)
  return { mid: s, leftOut: q0, leftIn: r0, rightOut: r1, rightIn: q2 }
}

export function insertNodeOnSegment(
  nodes: PathNode[],
  segIdx: number,
  cncX: number,
  cncY: number,
  closed: boolean
): PathNode[] {
  const n = nodes.length
  const toIdx = (segIdx + 1) % n
  if (!closed && toIdx === 0) return nodes

  const from = nodes[segIdx]
  const to = nodes[toIdx]
  const p0 = { x: from.x, y: from.y }
  const p3 = { x: to.x, y: to.y }
  const c1 = from.handleOut ?? p0
  const c2 = to.handleIn ?? p3
  const hasCurve = !!(from.handleOut || to.handleIn)

  let bestT = 0.5
  let bestDistSq = Infinity
  const SAMPLES = 30
  for (let j = 0; j <= SAMPLES; j++) {
    const t = j / SAMPLES
    const pt = evalCubic(p0, c1, c2, p3, t)
    const dx = pt.x - cncX, dy = pt.y - cncY
    const dsq = dx * dx + dy * dy
    if (dsq < bestDistSq) { bestDistSq = dsq; bestT = t }
  }

  const split = splitCubicAt(p0, c1, c2, p3, bestT)
  const result = [...nodes]
  const newNode: PathNode = {
    x: split.mid.x,
    y: split.mid.y,
    handleIn: hasCurve ? split.leftIn : undefined,
    handleOut: hasCurve ? split.rightOut : undefined,
  }
  result[segIdx] = { ...from, handleOut: hasCurve ? split.leftOut : undefined }
  result[toIdx] = { ...to, handleIn: hasCurve ? split.rightIn : undefined }
  result.splice(segIdx + 1, 0, newNode)
  return result
}

export function nearestSegmentOnPath(
  nodes: PathNode[],
  closed: boolean,
  cx: number,
  cy: number
): { segIdx: number; distSq: number } | null {
  const segCount = closed ? nodes.length : nodes.length - 1
  if (segCount <= 0) return null

  let bestSeg = 0, bestDistSq = Infinity
  const SAMPLES = 20

  for (let i = 0; i < segCount; i++) {
    const from = nodes[i]
    const to = nodes[(i + 1) % nodes.length]
    const p0 = { x: from.x, y: from.y }
    const p3 = { x: to.x, y: to.y }
    const c1 = from.handleOut ?? p0
    const c2 = to.handleIn ?? p3

    for (let j = 0; j <= SAMPLES; j++) {
      const t = j / SAMPLES
      const pt = evalCubic(p0, c1, c2, p3, t)
      const dx = pt.x - cx, dy = pt.y - cy
      const dsq = dx * dx + dy * dy
      if (dsq < bestDistSq) { bestDistSq = dsq; bestSeg = i }
    }
  }

  return { segIdx: bestSeg, distSq: bestDistSq }
}
