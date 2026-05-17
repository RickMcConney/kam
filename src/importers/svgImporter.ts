import type { ShapeParams } from '../shapes/shapeGenerators'
import { PATH_COLOR } from '../colors'
import { splitCompoundPath } from '../canvas/nodeUtils'

export interface ImportedPath {
  id: string
  name: string
  d: string        // SVG d string in CNC mm coordinates (Y-up)
  visible: boolean
  hidden?: boolean // soft-hidden by boolean ops; shows in panel but not on canvas
  color: string
  shapeParams?: ShapeParams
  groupId?: string   // shared across all paths from the same SVG import
  groupName?: string // display name for the group (SVG filename without extension)
}

export interface SvgImportResult {
  paths: ImportedPath[]
  needsPpiPrompt: boolean
  svgWidthMM: number
  svgHeightMM: number
  groupId: string
}

let pathCounter = 0

export function nextPathColor(): string {
  return PATH_COLOR
}

function parseNums(s: string): number[] {
  return (s.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []).map(Number)
}

// ── Path command types (absolute only) ───────────────────────────────────────
export type AbsCmd =
  | { t: 'M'; x: number; y: number }
  | { t: 'L'; x: number; y: number }
  | { t: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { t: 'S'; x2: number; y2: number; x: number; y: number }
  | { t: 'Q'; x1: number; y1: number; x: number; y: number }
  | { t: 'T'; x: number; y: number }
  | { t: 'A'; rx: number; ry: number; ang: number; lg: number; sw: number; x: number; y: number }
  | { t: 'Z' }

// Parse SVG d string → absolute commands (H/V expanded to L)
export function parseD(d: string): AbsCmd[] {
  const result: AbsCmd[] = []
  const tokens = d.match(/[a-zA-Z][^a-zA-Z]*/g) ?? []
  let cx = 0, cy = 0, mx = 0, my = 0

  for (const tok of tokens) {
    const letter = tok[0]
    const upper = letter.toUpperCase()
    const rel = letter !== upper
    const n = parseNums(tok.slice(1))

    switch (upper) {
      case 'M':
        for (let i = 0; i < n.length; i += 2) {
          const x = rel ? cx + n[i] : n[i]
          const y = rel ? cy + n[i + 1] : n[i + 1]
          result.push({ t: i === 0 ? 'M' : 'L', x, y })
          if (i === 0) { mx = x; my = y }
          cx = x; cy = y
        }
        break
      case 'L':
        for (let i = 0; i < n.length; i += 2) {
          const x = rel ? cx + n[i] : n[i]
          const y = rel ? cy + n[i + 1] : n[i + 1]
          result.push({ t: 'L', x, y })
          cx = x; cy = y
        }
        break
      case 'H':
        for (const v of n) {
          const x = rel ? cx + v : v
          result.push({ t: 'L', x, y: cy })  // expand H → L
          cx = x
        }
        break
      case 'V':
        for (const v of n) {
          const y = rel ? cy + v : v
          result.push({ t: 'L', x: cx, y })  // expand V → L
          cy = y
        }
        break
      case 'C':
        for (let i = 0; i < n.length; i += 6) {
          const x1 = rel ? cx + n[i] : n[i], y1 = rel ? cy + n[i+1] : n[i+1]
          const x2 = rel ? cx + n[i+2] : n[i+2], y2 = rel ? cy + n[i+3] : n[i+3]
          const x  = rel ? cx + n[i+4] : n[i+4], y  = rel ? cy + n[i+5] : n[i+5]
          result.push({ t: 'C', x1, y1, x2, y2, x, y })
          cx = x; cy = y
        }
        break
      case 'S':
        for (let i = 0; i < n.length; i += 4) {
          const x2 = rel ? cx + n[i] : n[i], y2 = rel ? cy + n[i+1] : n[i+1]
          const x  = rel ? cx + n[i+2] : n[i+2], y  = rel ? cy + n[i+3] : n[i+3]
          result.push({ t: 'S', x2, y2, x, y })
          cx = x; cy = y
        }
        break
      case 'Q':
        for (let i = 0; i < n.length; i += 4) {
          const x1 = rel ? cx + n[i] : n[i], y1 = rel ? cy + n[i+1] : n[i+1]
          const x  = rel ? cx + n[i+2] : n[i+2], y  = rel ? cy + n[i+3] : n[i+3]
          result.push({ t: 'Q', x1, y1, x, y })
          cx = x; cy = y
        }
        break
      case 'T':
        for (let i = 0; i < n.length; i += 2) {
          const x = rel ? cx + n[i] : n[i], y = rel ? cy + n[i+1] : n[i+1]
          result.push({ t: 'T', x, y })
          cx = x; cy = y
        }
        break
      case 'A':
        for (let i = 0; i < n.length; i += 7) {
          const x = rel ? cx + n[i+5] : n[i+5], y = rel ? cy + n[i+6] : n[i+6]
          result.push({ t: 'A', rx: n[i], ry: n[i+1], ang: n[i+2], lg: n[i+3], sw: n[i+4], x, y })
          cx = x; cy = y
        }
        break
      case 'Z':
        result.push({ t: 'Z' })
        cx = mx; cy = my
        break
    }
  }
  return result
}

function fmt(n: number) { return +n.toFixed(4) }

export function stringifyD(cmds: AbsCmd[]): string {
  return cmds.map(c => {
    switch (c.t) {
      case 'M': return `M${fmt(c.x)},${fmt(c.y)}`
      case 'L': return `L${fmt(c.x)},${fmt(c.y)}`
      case 'C': return `C${fmt(c.x1)},${fmt(c.y1)},${fmt(c.x2)},${fmt(c.y2)},${fmt(c.x)},${fmt(c.y)}`
      case 'S': return `S${fmt(c.x2)},${fmt(c.y2)},${fmt(c.x)},${fmt(c.y)}`
      case 'Q': return `Q${fmt(c.x1)},${fmt(c.y1)},${fmt(c.x)},${fmt(c.y)}`
      case 'T': return `T${fmt(c.x)},${fmt(c.y)}`
      case 'A': return `A${fmt(c.rx)},${fmt(c.ry)},${c.ang},${c.lg},${c.sw},${fmt(c.x)},${fmt(c.y)}`
      case 'Z': return 'Z'
    }
  }).join(' ')
}

// ── 2D affine matrix [a,b,c,d,e,f]: x'=ax+cy+e, y'=bx+dy+f ─────────────────
export type Mat6 = [number, number, number, number, number, number]
const IDENTITY: Mat6 = [1, 0, 0, 1, 0, 0]

// Compose M1(M2(p)) — M2 is applied first, M1 second
function matMul(M1: Mat6, M2: Mat6): Mat6 {
  const [a1,b1,c1,d1,e1,f1] = M1
  const [a2,b2,c2,d2,e2,f2] = M2
  return [
    a1*a2 + c1*b2,
    b1*a2 + d1*b2,
    a1*c2 + c1*d2,
    b1*c2 + d1*d2,
    a1*e2 + c1*f2 + e1,
    b1*e2 + d1*f2 + f1,
  ]
}

function parseSvgTransform(attr: string | null): Mat6 {
  if (!attr) return IDENTITY
  let result: Mat6 = [...IDENTITY] as Mat6
  const re = /(\w+)\(([^)]*)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attr)) !== null) {
    const name = m[1]; const args = parseNums(m[2])
    let mat: Mat6 = [...IDENTITY] as Mat6
    switch (name) {
      case 'translate': mat = [1,0,0,1, args[0]??0, args[1]??0]; break
      case 'scale': { const sx = args[0]??1, sy = args[1]??sx; mat = [sx,0,0,sy,0,0]; break }
      case 'matrix': if (args.length===6) mat = args as Mat6; break
      case 'rotate': {
        const a = ((args[0]??0)*Math.PI)/180, cos=Math.cos(a), sin=Math.sin(a)
        const px=args[1]??0, py=args[2]??0
        mat = [cos,sin,-sin,cos, px-cos*px+sin*py, py-sin*px-cos*py]
        break
      }
    }
    // SVG CTM: T1 T2 → combined = T1 * T2 (T2 applied first to points)
    result = matMul(result, mat)
  }
  return result
}

export function applyMat(cmds: AbsCmd[], m: Mat6): AbsCmd[] {
  const [a,b,c,d,e,f] = m
  const px = (x: number, y: number) => a*x + c*y + e
  const py = (x: number, y: number) => b*x + d*y + f
  const det = a*d - b*c
  const flipSweep = det < 0
  const scaleX = Math.sqrt(a*a + b*b)
  const scaleY = Math.sqrt(c*c + d*d)
  return cmds.map((cmd): AbsCmd => {
    switch (cmd.t) {
      case 'M': return { t:'M', x:px(cmd.x,cmd.y), y:py(cmd.x,cmd.y) }
      case 'L': return { t:'L', x:px(cmd.x,cmd.y), y:py(cmd.x,cmd.y) }
      case 'C': return { t:'C', x1:px(cmd.x1,cmd.y1), y1:py(cmd.x1,cmd.y1), x2:px(cmd.x2,cmd.y2), y2:py(cmd.x2,cmd.y2), x:px(cmd.x,cmd.y), y:py(cmd.x,cmd.y) }
      case 'S': return { t:'S', x2:px(cmd.x2,cmd.y2), y2:py(cmd.x2,cmd.y2), x:px(cmd.x,cmd.y), y:py(cmd.x,cmd.y) }
      case 'Q': return { t:'Q', x1:px(cmd.x1,cmd.y1), y1:py(cmd.x1,cmd.y1), x:px(cmd.x,cmd.y), y:py(cmd.x,cmd.y) }
      case 'T': return { t:'T', x:px(cmd.x,cmd.y), y:py(cmd.x,cmd.y) }
      case 'A': return { t:'A', rx:cmd.rx*scaleX, ry:cmd.ry*scaleY, ang:cmd.ang, lg:cmd.lg, sw:flipSweep?1-cmd.sw:cmd.sw, x:px(cmd.x,cmd.y), y:py(cmd.x,cmd.y) }
      case 'Z': return { t:'Z' }
    }
  })
}

// Apply simple scale+translate (SVG px → CNC mm with Y-flip)
function applyGlobalTransform(cmds: AbsCmd[], sx: number, sy: number, tx: number, ty: number): AbsCmd[] {
  // sy is negative (Y-flip). sweep must be flipped.
  const flipSweep = sy < 0
  const fx = (x: number) => x * sx + tx
  const fy = (y: number) => y * sy + ty
  return cmds.map((cmd): AbsCmd => {
    switch (cmd.t) {
      case 'M': return { t:'M', x:fx(cmd.x), y:fy(cmd.y) }
      case 'L': return { t:'L', x:fx(cmd.x), y:fy(cmd.y) }
      case 'C': return { t:'C', x1:fx(cmd.x1), y1:fy(cmd.y1), x2:fx(cmd.x2), y2:fy(cmd.y2), x:fx(cmd.x), y:fy(cmd.y) }
      case 'S': return { t:'S', x2:fx(cmd.x2), y2:fy(cmd.y2), x:fx(cmd.x), y:fy(cmd.y) }
      case 'Q': return { t:'Q', x1:fx(cmd.x1), y1:fy(cmd.y1), x:fx(cmd.x), y:fy(cmd.y) }
      case 'T': return { t:'T', x:fx(cmd.x), y:fy(cmd.y) }
      case 'A': return { t:'A', rx:Math.abs(cmd.rx*sx), ry:Math.abs(cmd.ry*sy), ang:cmd.ang, lg:cmd.lg, sw:flipSweep?1-cmd.sw:cmd.sw, x:fx(cmd.x), y:fy(cmd.y) }
      case 'Z': return { t:'Z' }
    }
  })
}

// ── Shape element → d string (SVG coordinate space) ──────────────────────────
function getRectD(el: Element): string {
  const a = (n: string) => parseFloat(el.getAttribute(n) ?? '0')
  const x=a('x'), y=a('y'), w=a('width'), h=a('height')
  let rx=a('rx')||a('ry'), ry=a('ry')||a('rx')
  rx=Math.min(rx,w/2); ry=Math.min(ry,h/2)
  if (rx===0) return `M${x},${y} L${x+w},${y} L${x+w},${y+h} L${x},${y+h} Z`
  return `M${x+rx},${y} L${x+w-rx},${y} A${rx},${ry},0,0,1,${x+w},${y+ry} L${x+w},${y+h-ry} A${rx},${ry},0,0,1,${x+w-rx},${y+h} L${x+rx},${y+h} A${rx},${ry},0,0,1,${x},${y+h-ry} L${x},${y+ry} A${rx},${ry},0,0,1,${x+rx},${y} Z`
}

function getCircleD(el: Element): string {
  const a=(n:string)=>parseFloat(el.getAttribute(n)?? '0')
  const cx=a('cx'), cy=a('cy'), r=a('r')
  return `M${cx-r},${cy} A${r},${r},0,0,1,${cx+r},${cy} A${r},${r},0,0,1,${cx-r},${cy} Z`
}

function getEllipseD(el: Element): string {
  const a=(n:string)=>parseFloat(el.getAttribute(n)?? '0')
  const cx=a('cx'), cy=a('cy'), rx=a('rx'), ry=a('ry')
  return `M${cx-rx},${cy} A${rx},${ry},0,0,1,${cx+rx},${cy} A${rx},${ry},0,0,1,${cx-rx},${cy} Z`
}

function getLineD(el: Element): string {
  const a=(n:string)=>parseFloat(el.getAttribute(n)?? '0')
  return `M${a('x1')},${a('y1')} L${a('x2')},${a('y2')}`
}

function getPolyD(el: Element, close: boolean): string {
  const pts = el.getAttribute('points') ?? ''
  const n = pts.trim().split(/[\s,]+/).map(Number)
  const cmds: string[] = []
  for (let i=0; i+1<n.length; i+=2) cmds.push(`${i===0?'M':'L'}${n[i]},${n[i+1]}`)
  return cmds.join(' ') + (close ? ' Z' : '')
}

// ── Unit helpers ─────────────────────────────────────────────────────────────
const UNIT_PX: Record<string,number> = { px:1, pt:96/72, pc:16, mm:96/25.4, cm:96/2.54, in:96 }
const REAL_WORLD = new Set(['mm','cm','in','pt','pc'])

function parseSvgLength(attr: string|null): {px:number; unit:string}|null {
  if (!attr) return null
  const m = attr.trim().match(/^([\d.eE+\-]+)(mm|cm|in|pt|pc|px)?$/)
  if (!m) return null
  const unit = m[2]??'px', factor=UNIT_PX[unit]
  if (!factor) return null
  return { px: parseFloat(m[1])*factor, unit }
}

// ── Main export ───────────────────────────────────────────────────────────────
export interface ImportOptions {
  ppi?: number
  workpieceMM?: { w: number; h: number }  // if provided, SVG is centered on workpiece
}

let _groupCounter = 0

export function importSvg(svgText: string, options?: ImportOptions | number, groupName?: string): SvgImportResult {
  const groupId = `svg-group-${++_groupCounter}-${Date.now()}`
  const opts: ImportOptions = typeof options === 'number' ? { ppi: options } : (options ?? {})
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  if (doc.querySelector('parsererror')) throw new Error('Invalid SVG file')
  const svg = doc.querySelector('svg')
  if (!svg) throw new Error('No <svg> element found')

  let vbX=0, vbY=0, vbW=0, vbH=0
  const vbAttr = svg.getAttribute('viewBox')
  if (vbAttr) { const [a,b,c,d]=parseNums(vbAttr); vbX=a; vbY=b; vbW=c; vbH=d }

  const wParsed = parseSvgLength(svg.getAttribute('width'))
  const hParsed = parseSvgLength(svg.getAttribute('height'))
  const ppiOverride = opts.ppi

  let needsPpiPrompt = false
  let widthMM = 0, heightMM = 0

  if (wParsed && hParsed) {
    if (REAL_WORLD.has(wParsed.unit) || REAL_WORLD.has(hParsed.unit)) {
      widthMM  = wParsed.px  / (96/25.4)
      heightMM = hParsed.px / (96/25.4)
    } else {
      const ppi = ppiOverride ?? 96
      needsPpiPrompt = !ppiOverride
      widthMM  = wParsed.px  / (ppi/25.4)
      heightMM = hParsed.px / (ppi/25.4)
    }
    if (!vbAttr) { vbW=wParsed.px; vbH=hParsed.px }
  } else if (vbW && vbH) {
    const ppi = ppiOverride ?? 96
    needsPpiPrompt = !ppiOverride
    widthMM  = vbW / (ppi/25.4)
    heightMM = vbH / (ppi/25.4)
  } else {
    widthMM=100; heightMM=100; vbW=100; vbH=100; needsPpiPrompt=true
  }

  // Global transform: SVG px → CNC mm (Y-up)
  // x_mm = (x_px - vbX) * (widthMM/vbW)
  // y_mm = heightMM - (y_px - vbY) * (heightMM/vbH)
  const gsx = widthMM / vbW
  const gsy = -(heightMM / vbH)
  let gtx = -vbX * gsx
  let gty = heightMM + vbY * (heightMM / vbH)

  // Center on workpiece if dimensions provided
  if (opts.workpieceMM) {
    gtx += (opts.workpieceMM.w - widthMM) / 2
    gty += (opts.workpieceMM.h - heightMM) / 2
  }

  const paths: ImportedPath[] = []

  function processElement(el: Element, parentMat: Mat6) {
    const tag = el.tagName.toLowerCase().replace(/^.*:/, '')
    const elMat = matMul(parentMat, parseSvgTransform(el.getAttribute('transform')))

    if (tag === 'g' || tag === 'svg') {
      for (const child of el.children) processElement(child, elMat)
      return
    }

    let rawD: string|null = null
    switch (tag) {
      case 'path':     rawD = el.getAttribute('d'); break
      case 'rect':     rawD = getRectD(el); break
      case 'circle':   rawD = getCircleD(el); break
      case 'ellipse':  rawD = getEllipseD(el); break
      case 'line':     rawD = getLineD(el); break
      case 'polyline': rawD = getPolyD(el, false); break
      case 'polygon':  rawD = getPolyD(el, true); break
    }
    if (!rawD?.trim()) return

    try {
      const cmds = parseD(rawD)
      const withElMat = applyMat(cmds, elMat)
      const withGlobal = applyGlobalTransform(withElMat, gsx, gsy, gtx, gty)
      const d = stringifyD(withGlobal)

      const baseName = el.getAttribute('id') || el.getAttribute('inkscape:label') || null
      const subDs = splitCompoundPath(d)
      if (subDs.length > 1) {
        subDs.forEach((subD, i) => {
          const id = `path-${++pathCounter}`
          const name = baseName ? `${baseName} ${i + 1}` : `Path ${pathCounter}`
          paths.push({ id, name, d: subD, visible: true, color: PATH_COLOR, groupId, groupName })
        })
      } else {
        const id = `path-${++pathCounter}`
        const name = baseName || `Path ${pathCounter}`
        paths.push({ id, name, d, visible: true, color: PATH_COLOR, groupId, groupName })
      }
    } catch {
      // skip malformed elements
    }
  }

  const svgMat = parseSvgTransform(svg.getAttribute('transform'))
  for (const child of svg.children) processElement(child, svgMat)

  return { paths, needsPpiPrompt, svgWidthMM: widthMM, svgHeightMM: heightMM, groupId }
}
