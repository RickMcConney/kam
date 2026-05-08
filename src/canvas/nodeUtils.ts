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

export function parseDToNodes(d: string): { nodes: PathNode[]; closed: boolean } {
  const tokens = d.trim().split(/[\s,]+/).filter(Boolean)
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
    } else if (cmd === 'Z' || cmd === 'z') {
      closed = true
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
