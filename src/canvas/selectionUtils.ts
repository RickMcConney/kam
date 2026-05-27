import { flattenPath } from '../cam/pathFlattener'
import { parseD, stringifyD, applyMat, type Mat6, type ImportedPath } from '../importers/svgImporter'

export interface BBox {
  minX: number; minY: number; maxX: number; maxY: number
  width: number; height: number; cx: number; cy: number
}

export function getBBox(d: string): BBox | null {
  const subpaths = flattenPath(d, 0.5)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const sp of subpaths) {
    for (const [x, y] of sp) {
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }
  }
  if (!isFinite(minX)) return null
  const width = maxX - minX, height = maxY - minY
  return { minX, minY, maxX, maxY, width, height, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
}

export function getMultiBBox(ds: string[]): BBox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const d of ds) {
    const b = getBBox(d)
    if (!b) continue
    if (b.minX < minX) minX = b.minX; if (b.maxX > maxX) maxX = b.maxX
    if (b.minY < minY) minY = b.minY; if (b.maxY > maxY) maxY = b.maxY
  }
  if (!isFinite(minX)) return null
  const width = maxX - minX, height = maxY - minY
  return { minX, minY, maxX, maxY, width, height, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
}

export function translateD(d: string, dx: number, dy: number): string {
  const mat: Mat6 = [1, 0, 0, 1, dx, dy]
  return stringifyD(applyMat(parseD(d), mat))
}

export function scaleAroundD(d: string, ax: number, ay: number, sx: number, sy: number): string {
  const mat: Mat6 = [sx, 0, 0, sy, ax - sx * ax, ay - sy * ay]
  return stringifyD(applyMat(parseD(d), mat))
}

export function rotateAroundD(d: string, cx: number, cy: number, angleDeg: number): string {
  const r = angleDeg * Math.PI / 180
  const cos = Math.cos(r), sin = Math.sin(r)
  // CCW rotation in CNC Y-up space
  const mat: Mat6 = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy]
  return stringifyD(applyMat(parseD(d), mat))
}

// axis 'x' negates X (horizontal flip); axis 'y' negates Y (vertical flip)
export function mirrorD(d: string, axis: 'x' | 'y', cx: number, cy: number): string {
  return scaleAroundD(d, cx, cy, axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1)
}

// kx = horizontal shear (X shift per unit Y), ky = vertical shear (Y shift per unit X), both around (ax, ay)
export function skewAroundD(d: string, kx: number, ky: number, ax: number, ay: number): string {
  const mat: Mat6 = [1, ky, kx, 1, -kx * ay, -ky * ax]
  return stringifyD(applyMat(parseD(d), mat))
}

// Apply a live transform to a single CNC-space point
export function transformPoint(
  x: number, y: number,
  transform: { kind: 'translate'; dx: number; dy: number }
           | { kind: 'scale'; sx: number; sy: number; ax: number; ay: number }
           | { kind: 'rotate'; angle: number; cx: number; cy: number }
           | { kind: 'skew'; kx: number; ky: number; ax: number; ay: number }
): { x: number; y: number } {
  switch (transform.kind) {
    case 'translate':
      return { x: x + transform.dx, y: y + transform.dy }
    case 'scale':
      return { x: transform.ax + transform.sx * (x - transform.ax), y: transform.ay + transform.sy * (y - transform.ay) }
    case 'rotate': {
      const r = transform.angle * Math.PI / 180
      const cos = Math.cos(r), sin = Math.sin(r)
      const dx = x - transform.cx, dy = y - transform.cy
      return { x: transform.cx + cos * dx - sin * dy, y: transform.cy + sin * dx + cos * dy }
    }
    case 'skew':
      return {
        x: x + transform.kx * (y - transform.ay),
        y: transform.ky * (x - transform.ax) + y,
      }
  }
}

export function extractCircle(path: ImportedPath): { cx: number; cy: number; radiusMM: number } | null {
  if (path.shapeParams?.type === 'circle') {
    return { cx: path.shapeParams.cx, cy: path.shapeParams.cy, radiusMM: path.shapeParams.radius }
  }
  if (path.shapeParams?.type === 'ellipse') {
    const { cx, cy, rx, ry } = path.shapeParams
    if (Math.abs(rx - ry) / Math.max(rx, ry, 0.001) < 0.05) {
      return { cx, cy, radiusMM: (rx + ry) / 2 }
    }
  }
  const bb = getBBox(path.d)
  if (!bb) return null
  const rx = (bb.maxX - bb.minX) / 2
  const ry = (bb.maxY - bb.minY) / 2
  if (Math.max(rx, ry) < 0.001) return null
  if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.08) {
    return { cx: bb.cx, cy: bb.cy, radiusMM: (rx + ry) / 2 }
  }
  return null
}

