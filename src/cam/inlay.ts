import { flattenPath, signedArea, type Pt2 } from './pathFlattener'
import { generatePocket } from './raster'
import { generateVCarve } from './vcarve'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'

export interface InlayParams {
  angleDeg: number           // V-bit full angle
  pocketDepthMM: number      // depth of the flat-bottom pocket / inlay
  stepDownMM: number         // step-down for pocket roughing
  stepoverPercent: number    // stepover for pocket roughing
  glueLineMM: number         // extra gap added to socket (female) for glue
  clearanceMM: number        // fit clearance (male plug is shrunk by this)
  islandDs: string[]         // hole paths inside the shape
}

const SAFE_Z = 5.0

function ptInPoly(px: number, py: number, pts: Pt2[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
      inside = !inside
  }
  return inside
}

function ptsToD(pts: Pt2[]): string {
  if (pts.length < 2) return ''
  const p = [`M${pts[0][0].toFixed(4)} ${pts[0][1].toFixed(4)}`]
  for (let i = 1; i < pts.length; i++) p.push(`L${pts[i][0].toFixed(4)} ${pts[i][1].toFixed(4)}`)
  p.push('Z')
  return p.join(' ')
}

// Offset polygon outward by delta using angle bisectors
function offsetPoly(pts: Pt2[], delta: number): Pt2[] {
  const n = pts.length
  if (n < 3) return []
  const area = (() => {
    let a = 0
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
    }
    return a / 2
  })()
  const ws = area >= 0 ? 1 : -1
  const en: Pt2[] = []
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const dx = pts[j][0] - pts[i][0], dy = pts[j][1] - pts[i][1]
    const len = Math.hypot(dx, dy)
    en.push(len < 1e-10 ? [0, 0] : [dy * ws / len, -dx * ws / len])
  }
  return pts.map((p, i) => {
    const prev = en[(i - 1 + n) % n], next = en[i]
    const bx = prev[0] + next[0], by = prev[1] + next[1]
    const blen = Math.hypot(bx, by)
    if (blen < 1e-10) return [p[0] + next[0] * delta, p[1] + next[1] * delta] as Pt2
    const nx = bx / blen, ny = by / blen
    const dot = next[0] * nx + next[1] * ny
    const scale = Math.abs(dot) > 0.25 ? delta / dot : delta * 4 * Math.sign(dot || 1)
    return [p[0] + nx * scale, p[1] + ny * scale] as Pt2
  })
}

function addContour(pts: Pt2[], z: number, segs: MotionSegment[]) {
  if (pts.length < 2) return
  const [sx, sy] = pts[0]
  segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
  segs.push({ x: sx, y: sy, z, rapid: false })
  for (let i = 1; i < pts.length; i++) segs.push({ x: pts[i][0], y: pts[i][1], z, rapid: false })
  segs.push({ x: sx, y: sy, z, rapid: false })
  segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
}

function getOuters(d: string): Pt2[][] {
  const subs = flattenPath(d, 0.05).filter(s => s.length >= 3)
  const outers = subs.filter(s => signedArea(s) >= 0)
  return outers.length > 0 ? outers : subs
}

/**
 * Female socket: pocket clearing + V-carve edges.
 * The socket boundary is enlarged by glueLineMM to accommodate glue.
 */
export async function generateInlayFemale(
  d: string,
  pocketTool: Tool,
  vbitTool: Tool,
  params: InlayParams
): Promise<MotionSegment[]> {
  if (vbitTool.type !== 'vbit') throw new Error('V-carve requires a V-bit tool')

  const outers = getOuters(d)
  if (outers.length === 0) throw new Error('No geometry found')

  const allSubsSubs = flattenPath(d, 0.05).filter(s => s.length >= 3)
  const innerHoles = allSubsSubs.filter(s => signedArea(s) < 0)

  const segs: MotionSegment[] = []

  for (const outer of outers) {
    const holes = innerHoles.filter(h => {
      const cx = h.reduce((s, p) => s + p[0], 0) / h.length
      const cy = h.reduce((s, p) => s + p[1], 0) / h.length
      return ptInPoly(cx, cy, outer)
    })

    // Expand socket outward to include glue gap
    const socket = offsetPoly(outer, params.glueLineMM)
    if (socket.length < 3) continue

    const socketD = ptsToD(socket)
    const islandDs = [...params.islandDs, ...holes.map(ptsToD)]

    // Step 1: pocket roughing — clears the flat bottom
    try {
      const pocketSegs = generatePocket(socketD, pocketTool, {
        depthMM: params.pocketDepthMM,
        stepDownMM: params.stepDownMM,
        stepoverPercent: params.stepoverPercent,
        direction: 'climb',
        islandDs,
        angle: 0,
      })
      segs.push(...pocketSegs)
    } catch { /* continue even if pocket fails */ }

    // Step 2: V-carve the socket perimeter — creates the angled entry edge
    // We V-carve the EXPANDED socket boundary
    try {
      const vcSegs = await generateVCarve(socketD, vbitTool, {
        angleDeg: params.angleDeg,
        maxDepthMM: params.pocketDepthMM,
        islandDs,
      })
      segs.push(...vcSegs)
    } catch { /* continue */ }
  }

  if (segs.length === 0) throw new Error('Inlay socket is too small for the selected tools')
  return segs
}

/**
 * Male plug: V-carve the plug perimeter + profile-cut to release from stock.
 * The plug is offset inward by clearanceMM so it fits the socket.
 */
export async function generateInlayMale(
  d: string,
  profileTool: Tool,
  vbitTool: Tool,
  params: InlayParams
): Promise<MotionSegment[]> {
  if (vbitTool.type !== 'vbit') throw new Error('V-carve requires a V-bit tool')

  const outers = getOuters(d)
  if (outers.length === 0) throw new Error('No geometry found')

  const segs: MotionSegment[] = []

  for (const outer of outers) {
    // Shrink plug inward by clearance so it fits the socket (which was enlarged by glueLine)
    const totalOffset = -(params.clearanceMM)
    const plug = totalOffset !== 0 ? offsetPoly(outer, totalOffset) : [...outer]
    if (plug.length < 3) continue

    const plugD = ptsToD(plug)

    // Step 1: V-carve the plug perimeter — creates matching angled edge
    try {
      const vcSegs = await generateVCarve(plugD, vbitTool, {
        angleDeg: params.angleDeg,
        maxDepthMM: params.pocketDepthMM,
        islandDs: params.islandDs,
      })
      segs.push(...vcSegs)
    } catch { /* continue */ }

    // Step 2: Profile cut outside the plug to release it from stock
    const profileOffset = offsetPoly(plug, profileTool.diameterMM / 2)
    if (profileOffset.length >= 3) {
      const step = Math.abs(params.stepDownMM)
      const zPasses: number[] = []
      let z = -step
      while (z > -params.pocketDepthMM) { zPasses.push(z); z -= step }
      zPasses.push(-Math.abs(params.pocketDepthMM))

      addContour(profileOffset, zPasses[0], segs)
      for (let i = 1; i < zPasses.length; i++) {
        addContour(profileOffset, zPasses[i], segs)
      }
    }
  }

  if (segs.length === 0) throw new Error('Inlay plug is too small for the selected tools')
  return segs
}
