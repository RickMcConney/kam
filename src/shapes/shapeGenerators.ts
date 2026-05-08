import { generateTextD } from './textGenerator'

export type ShapeType = 'rectangle' | 'roundrect' | 'circle' | 'ellipse' | 'polygon' | 'star' | 'text'

export type ShapeParams =
  | { type: 'rectangle'; x: number; y: number; w: number; h: number }
  | { type: 'roundrect'; x: number; y: number; w: number; h: number; r: number }
  | { type: 'circle'; cx: number; cy: number; radius: number }
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { type: 'polygon'; cx: number; cy: number; radius: number; sides: number }
  | { type: 'star'; cx: number; cy: number; outerRadius: number; innerRadius: number; points: number }
  | { type: 'text'; x: number; y: number; text: string; fontSize: number; fontFamily: string }

export interface ShapeToolConfig {
  rectangle: { w: number; h: number }
  roundrect: { w: number; h: number; r: number }
  circle: { radius: number }
  ellipse: { rx: number; ry: number }
  polygon: { radius: number; sides: number }
  star: { outerRadius: number; innerRadius: number; points: number }
  text: { text: string; fontSize: number; fontFamily: string }
}

export const DEFAULT_SHAPE_CONFIG: ShapeToolConfig = {
  rectangle: { w: 50, h: 30 },
  roundrect: { w: 50, h: 30, r: 5 },
  circle: { radius: 20 },
  ellipse: { rx: 25, ry: 15 },
  polygon: { radius: 20, sides: 6 },
  star: { outerRadius: 20, innerRadius: 8, points: 5 },
  text: { text: 'Hello', fontSize: 10, fontFamily: 'Roboto' },
}

function f(n: number): string { return String(+n.toFixed(4)) }

// All paths in CNC Y-up space. Arc sweep=0 matches what svgImporter produces after Y-flip.
export function generateShapeD(p: ShapeParams): string {
  switch (p.type) {
    case 'rectangle': {
      const { x, y, w, h } = p
      return `M${f(x)},${f(y)} L${f(x+w)},${f(y)} L${f(x+w)},${f(y+h)} L${f(x)},${f(y+h)} Z`
    }
    case 'roundrect': {
      const { x, y, w, h } = p
      const r = Math.min(Math.abs(p.r), Math.abs(w) / 2, Math.abs(h) / 2)
      if (r < 0.001) return `M${f(x)},${f(y)} L${f(x+w)},${f(y)} L${f(x+w)},${f(y+h)} L${f(x)},${f(y+h)} Z`
      // sweep=1 because the path traces CCW in CNC Y-up — corners need CW arcs to bulge outward
      return [
        `M${f(x+r)},${f(y)}`,
        `L${f(x+w-r)},${f(y)}`,
        `A${f(r)},${f(r)},0,0,1,${f(x+w)},${f(y+r)}`,
        `L${f(x+w)},${f(y+h-r)}`,
        `A${f(r)},${f(r)},0,0,1,${f(x+w-r)},${f(y+h)}`,
        `L${f(x+r)},${f(y+h)}`,
        `A${f(r)},${f(r)},0,0,1,${f(x)},${f(y+h-r)}`,
        `L${f(x)},${f(y+r)}`,
        `A${f(r)},${f(r)},0,0,1,${f(x+r)},${f(y)} Z`,
      ].join(' ')
    }
    case 'circle': {
      const { cx, cy, radius: r } = p
      return `M${f(cx-r)},${f(cy)} A${f(r)},${f(r)},0,0,0,${f(cx+r)},${f(cy)} A${f(r)},${f(r)},0,0,0,${f(cx-r)},${f(cy)} Z`
    }
    case 'ellipse': {
      const { cx, cy, rx, ry } = p
      return `M${f(cx-rx)},${f(cy)} A${f(rx)},${f(ry)},0,0,0,${f(cx+rx)},${f(cy)} A${f(rx)},${f(ry)},0,0,0,${f(cx-rx)},${f(cy)} Z`
    }
    case 'polygon': {
      const { cx, cy, radius, sides } = p
      const pts: string[] = []
      for (let i = 0; i < sides; i++) {
        const angle = (i / sides) * 2 * Math.PI - Math.PI / 2
        pts.push(`${i === 0 ? 'M' : 'L'}${f(cx + radius * Math.cos(angle))},${f(cy + radius * Math.sin(angle))}`)
      }
      return pts.join(' ') + ' Z'
    }
    case 'star': {
      const { cx, cy, outerRadius, innerRadius, points } = p
      const pts: string[] = []
      for (let i = 0; i < points * 2; i++) {
        const angle = (i / (points * 2)) * 2 * Math.PI - Math.PI / 2
        const r = i % 2 === 0 ? outerRadius : innerRadius
        pts.push(`${i === 0 ? 'M' : 'L'}${f(cx + r * Math.cos(angle))},${f(cy + r * Math.sin(angle))}`)
      }
      return pts.join(' ') + ' Z'
    }
    case 'text': return generateTextD(p)
  }
}

export function shapeDisplayName(type: ShapeType): string {
  switch (type) {
    case 'rectangle': return 'Rectangle'
    case 'roundrect': return 'Rounded Rect'
    case 'circle': return 'Circle'
    case 'ellipse': return 'Ellipse'
    case 'polygon': return 'Polygon'
    case 'star': return 'Star'
    case 'text': return 'Text'
  }
}

// Build ShapeParams from a canvas drag box
export function shapeParamsFromDrag(
  type: ShapeType,
  start: { x: number; y: number },
  end: { x: number; y: number },
  config: ShapeToolConfig
): ShapeParams {
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  const w = Math.max(Math.abs(end.x - start.x), 0.1)
  const h = Math.max(Math.abs(end.y - start.y), 0.1)
  const cx = (start.x + end.x) / 2
  const cy = (start.y + end.y) / 2
  const radius = Math.min(w, h) / 2

  switch (type) {
    case 'rectangle': return { type, x, y, w, h }
    case 'roundrect': {
      const maxR = Math.min(w, h) / 2
      return { type, x, y, w, h, r: Math.min(config.roundrect.r, maxR) }
    }
    case 'circle': return { type: 'circle', cx, cy, radius }
    case 'ellipse': return { type: 'ellipse', cx, cy, rx: w / 2, ry: h / 2 }
    case 'polygon': return { type: 'polygon', cx, cy, radius, sides: config.polygon.sides }
    case 'star': {
      const ratio = config.star.innerRadius / Math.max(config.star.outerRadius, 0.001)
      return { type: 'star', cx, cy, outerRadius: radius, innerRadius: radius * ratio, points: config.star.points }
    }
    case 'text': {
      // drag height → font size; left edge and lower y as baseline position
      const h = Math.abs(end.y - start.y)
      const fontSize = h > 1 ? h : config.text.fontSize
      return { type: 'text', x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), text: config.text.text, fontSize, fontFamily: config.text.fontFamily }
    }
  }
}

// Build ShapeParams for click-to-place using panel-configured defaults
export function shapeParamsFromConfig(
  type: ShapeType,
  cx: number,
  cy: number,
  config: ShapeToolConfig
): ShapeParams {
  switch (type) {
    case 'rectangle': {
      const { w, h } = config.rectangle
      return { type, x: cx - w / 2, y: cy - h / 2, w, h }
    }
    case 'roundrect': {
      const { w, h, r } = config.roundrect
      return { type, x: cx - w / 2, y: cy - h / 2, w, h, r }
    }
    case 'circle': return { type: 'circle', cx, cy, radius: config.circle.radius }
    case 'ellipse': return { type: 'ellipse', cx, cy, rx: config.ellipse.rx, ry: config.ellipse.ry }
    case 'polygon': return { type: 'polygon', cx, cy, radius: config.polygon.radius, sides: config.polygon.sides }
    case 'star': return { type: 'star', cx, cy, outerRadius: config.star.outerRadius, innerRadius: config.star.innerRadius, points: config.star.points }
    case 'text': return { type: 'text', x: cx, y: cy, text: config.text.text, fontSize: config.text.fontSize, fontFamily: config.text.fontFamily }
  }
}

// Translate shape params by (dx, dy) — keeps params in sync with canvas moves
export function translateShapeParams(p: ShapeParams, dx: number, dy: number): ShapeParams {
  switch (p.type) {
    case 'rectangle': return { ...p, x: p.x + dx, y: p.y + dy }
    case 'roundrect': return { ...p, x: p.x + dx, y: p.y + dy }
    case 'circle': return { ...p, cx: p.cx + dx, cy: p.cy + dy }
    case 'ellipse': return { ...p, cx: p.cx + dx, cy: p.cy + dy }
    case 'polygon': return { ...p, cx: p.cx + dx, cy: p.cy + dy }
    case 'star': return { ...p, cx: p.cx + dx, cy: p.cy + dy }
    case 'text': return { ...p, x: p.x + dx, y: p.y + dy }
  }
}

// Scale shape params — returns null for shapes that don't support the given scale (e.g. non-uniform circle)
export function scaleShapeParams(
  p: ShapeParams,
  ax: number,
  ay: number,
  sx: number,
  sy: number
): ShapeParams | null {
  const asx = Math.abs(sx), asy = Math.abs(sy)
  switch (p.type) {
    case 'rectangle': {
      const nx = ax + sx * (p.x - ax), ny = ay + sy * (p.y - ay)
      return { ...p, x: Math.min(nx, nx + p.w * sx), y: Math.min(ny, ny + p.h * sy), w: p.w * asx, h: p.h * asy }
    }
    case 'roundrect': {
      const nx = ax + sx * (p.x - ax), ny = ay + sy * (p.y - ay)
      const nw = p.w * asx, nh = p.h * asy
      const nr = p.r * Math.min(asx, asy)
      return { ...p, x: Math.min(nx, nx + p.w * sx), y: Math.min(ny, ny + p.h * sy), w: nw, h: nh, r: Math.min(nr, nw / 2, nh / 2) }
    }
    case 'circle': {
      if (Math.abs(asx - asy) > 0.001) return null // non-uniform → no longer a circle
      const ncx = ax + sx * (p.cx - ax), ncy = ay + sy * (p.cy - ay)
      return { ...p, cx: ncx, cy: ncy, radius: p.radius * asx }
    }
    case 'ellipse': {
      const ncx = ax + sx * (p.cx - ax), ncy = ay + sy * (p.cy - ay)
      return { ...p, cx: ncx, cy: ncy, rx: p.rx * asx, ry: p.ry * asy }
    }
    case 'polygon': {
      if (Math.abs(asx - asy) > 0.001) return null // non-uniform distorts polygon
      const ncx = ax + sx * (p.cx - ax), ncy = ay + sy * (p.cy - ay)
      return { ...p, cx: ncx, cy: ncy, radius: p.radius * asx }
    }
    case 'star': {
      if (Math.abs(asx - asy) > 0.001) return null
      const ncx = ax + sx * (p.cx - ax), ncy = ay + sy * (p.cy - ay)
      return { ...p, cx: ncx, cy: ncy, outerRadius: p.outerRadius * asx, innerRadius: p.innerRadius * asx }
    }
    case 'text': {
      if (Math.abs(asx - asy) > 0.001) return null
      const nx = ax + sx * (p.x - ax), ny = ay + sy * (p.y - ay)
      return { ...p, x: nx, y: ny, fontSize: p.fontSize * asx }
    }
  }
}
