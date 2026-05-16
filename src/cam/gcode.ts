import type { AnyOperation } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import type { PostProcessorProfile } from '../store/postProcessorStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'

const MM_PER_IN = 25.4

function f(n: number, decimals = 3) { return n.toFixed(decimals) }

function sub(template: string, vals: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vals[k] ?? ''))
}

function cmt(text: string, style: PostProcessorProfile['commentStyle']): string {
  if (style === 'semicolon') return `; ${text}`
  if (style === 'parenthesis') return `(${text})`
  return ''
}

function opDesc(op: AnyOperation): string {
  if (op.type === 'profile') return `${op.side} · ${op.depthMM}mm`
  if (op.type === 'pocket') return `pocket · ${op.stepoverPercent}% stepover · ${op.depthMM}mm`
  if (op.type === 'drill') return `${op.drillMode} drill · ${op.depthMM}mm`
  if (op.type === 'surface') return `surface · ${op.stepoverPercent}% stepover · ${op.passAngleDeg}° · ${op.depthMM}mm`
  if (op.type === 'vcarve') return `vcarve · ${op.angleDeg}° · ${op.maxDepthMM}mm max`
  return ''
}

function toOut(mm: number, profile: PostProcessorProfile): number {
  return profile.unitMode === 'in' ? mm / MM_PER_IN : mm
}

export function generateGcode(
  operations: AnyOperation[],
  toolsById: Record<string, Tool>,
  projectName: string,
  profile: PostProcessorProfile,
): string {
  const lines: string[] = []
  const date = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const c = (text: string) => { const l = cmt(text, profile.commentStyle); if (l) lines.push(l) }

  // Segments are stored in workpiece-local coords (0→W, 0→H).
  // G-code must be relative to the machine zero (the origin point the user set on the workpiece).
  const { widthMM, heightMM, origin } = useWorkpieceStore.getState()
  const org = originWorldXY(origin, widthMM, heightMM)

  c(`FreazyKam - ${projectName}`)
  c(`Generated: ${date}`)
  c(`Post-processor: ${profile.name}`)
  c(`Origin: ${origin}  offset X${f(org.x)} Y${f(org.y)}`)
  if (profile.startGcode.trim()) lines.push(...profile.startGcode.split('\n'))
  lines.push('')

  const doneOps = operations.filter((o) => o.visible && o.status === 'done' && o.segments.length > 0)
  if (doneOps.length === 0) {
    c('No toolpaths to export.')
    lines.push('M30')
    return lines.join('\n')
  }

  let lastToolId = ''

  for (const op of doneOps) {
    const tool = toolsById[op.toolId]
    if (!tool) continue

    c(`=== ${op.name} ===`)
    c(`Tool: ${tool.name}  dia ${f(tool.diameterMM)}mm  ${opDesc(op)}`)
    if (tool.type === 'vbit') {
      // For vcarve/inlay, op.angleDeg is the angle used to generate Z depths — must match exactly.
      // For other ops (profile, pocket) the tool angle is used for simulation display only.
      const angleDeg = (op.type === 'vcarve' || op.type === 'inlay')
        ? op.angleDeg
        : (tool.vbitAngleDeg ?? 60)
      c(`vbit-angle:${f(angleDeg / 2)}`)
    }
    if (tool.type === 'ballnose') {
      c(`ballnose`)
    }

    if (lastToolId !== op.toolId) {
      if (lastToolId && profile.toolChangeGcode.trim()) {
        lines.push(...profile.toolChangeGcode.split('\n'))
      }
      if (profile.spindleOnTemplate.trim()) {
        lines.push(sub(profile.spindleOnTemplate, { s: tool.rpm }))
      }
      lastToolId = op.toolId
    }

    const coordDecimals = profile.unitMode === 'in' ? 3 : 2
    let prevX = NaN, prevY = NaN, prevZ = NaN

    for (let i = 0; i < op.segments.length; i++) {
      const seg = op.segments[i]
      const prevSeg = i > 0 ? op.segments[i - 1] : null
      const posChanged = seg.x !== prevX || seg.y !== prevY || seg.z !== prevZ
      // Arc segments (full circle) have start == end, so posChanged is false — never skip them.
      if (!posChanged && !seg.arc) { prevX = seg.x; prevY = seg.y; prevZ = seg.z; continue }

      // Convert workpiece-local → machine-relative by subtracting origin offset
      const x = f(toOut(seg.x - org.x, profile), coordDecimals)
      const y = f(toOut(seg.y - org.y, profile), coordDecimals)
      const z = f(toOut(seg.z, profile), coordDecimals)

      if (seg.rapid) {
        lines.push(sub(profile.rapidTemplate, { x, y, z }))
      } else if (seg.arc && profile.outputArcs) {
        // Arc move (G2/G3). I/J are offsets from the arc START point to the center.
        const ii = f(toOut(seg.arc.cx - prevX, profile), coordDecimals)
        const jj = f(toOut(seg.arc.cy - prevY, profile), coordDecimals)
        const feed = Math.round(toOut(tool.xyFeedMmMin, profile))
        const template = seg.arc.cw ? profile.arcCWTemplate : profile.arcCCWTemplate
        lines.push(sub(template, { x, y, z, i: ii, j: jj, f: feed }))
      } else if (seg.arc) {
        // outputArcs disabled — expand arc to G1 linear approximation
        const { cx, cy, cw } = seg.arc
        const r = Math.hypot(prevX - cx, prevY - cy)
        let a0 = Math.atan2(prevY - cy, prevX - cx)
        let a1 = Math.atan2(seg.y - cy, seg.x - cx)
        const isFullCircle = Math.abs(prevX - seg.x) < 0.001 && Math.abs(prevY - seg.y) < 0.001
        if (isFullCircle) a1 = a0 + (cw ? -2 * Math.PI : 2 * Math.PI)
        else if (cw) { if (a1 >= a0) a1 -= 2 * Math.PI }
        else { if (a1 <= a0) a1 += 2 * Math.PI }
        const steps = Math.max(4, Math.ceil(Math.abs(a1 - a0) / (5 * Math.PI / 180)))
        const feed = Math.round(toOut(tool.xyFeedMmMin, profile))
        for (let k = 1; k <= steps; k++) {
          const t = k / steps
          const a = a0 + (a1 - a0) * t
          const ax = f(toOut(cx + r * Math.cos(a) - org.x, profile), coordDecimals)
          const ay = f(toOut(cy + r * Math.sin(a) - org.y, profile), coordDecimals)
          const az = f(toOut(prevZ + (seg.z - prevZ) * t, profile), coordDecimals)
          lines.push(sub(profile.cutTemplate, { x: ax, y: ay, z: az, f: feed }))
        }
      } else {
        const zChanged = seg.z !== prevZ
        const xyChanged = seg.x !== prevX || seg.y !== prevY
        const isPlunge = zChanged && prevSeg && !prevSeg.rapid && !xyChanged
        const feedMm = isPlunge ? tool.zFeedMmMin : tool.xyFeedMmMin
        const feed = Math.round(toOut(feedMm, profile))
        lines.push(sub(profile.cutTemplate, { x, y, z, f: feed }))
      }

      prevX = seg.x; prevY = seg.y; prevZ = seg.z
    }
    lines.push('')
  }

  if (profile.endGcode.trim()) lines.push(...profile.endGcode.split('\n'))

  return lines.join('\n')
}

export function downloadGcode(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.gcode') ? filename : `${filename}.gcode`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
