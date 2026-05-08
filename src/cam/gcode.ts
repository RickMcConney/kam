import type { AnyOperation } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'

function f(n: number) { return n.toFixed(3) }

function opComment(op: AnyOperation): string {
  if (op.type === 'profile') return `${op.side} · ${op.depthMM}mm`
  if (op.type === 'pocket') return `pocket · ${op.stepoverPercent}% stepover · ${op.depthMM}mm`
  if (op.type === 'drill') return `${op.drillMode} drill · ${op.depthMM}mm`
  return ''
}

export function generateGcode(
  operations: AnyOperation[],
  toolsById: Record<string, Tool>,
  projectName: string
): string {
  const lines: string[] = []
  const date = new Date().toISOString().replace('T', ' ').slice(0, 19)

  lines.push(`; FreazyKam - ${projectName}`)
  lines.push(`; Generated: ${date}`)
  lines.push(`G21   ; mm`)
  lines.push(`G90   ; absolute`)
  lines.push(`G17   ; XY plane`)
  lines.push(``)

  const doneOps = operations.filter((o) => o.visible && o.status === 'done' && o.segments.length > 0)
  if (doneOps.length === 0) {
    lines.push(`; No toolpaths to export.`)
    lines.push(`M30`)
    return lines.join('\n')
  }

  let lastToolId = ''

  for (const op of doneOps) {
    const tool = toolsById[op.toolId]
    if (!tool) continue

    lines.push(`; === ${op.name} ===`)
    lines.push(`; Tool: ${tool.name}  dia ${f(tool.diameterMM)}mm  ${opComment(op)}`)

    if (lastToolId !== op.toolId) {
      if (lastToolId) lines.push(`M5   ; spindle off (tool change)`)
      lines.push(`M3 S${tool.rpm}   ; spindle on`)
      lastToolId = op.toolId
    }

    let prevX = NaN, prevY = NaN, prevZ = NaN

    for (let i = 0; i < op.segments.length; i++) {
      const seg = op.segments[i]
      const prevSeg = i > 0 ? op.segments[i - 1] : null

      if (seg.rapid) {
        const parts: string[] = ['G0']
        if (seg.x !== prevX || seg.y !== prevY) parts.push(`X${f(seg.x)} Y${f(seg.y)}`)
        if (seg.z !== prevZ) parts.push(`Z${f(seg.z)}`)
        if (parts.length > 1) lines.push(parts.join(' '))
      } else {
        const zChanged = seg.z !== prevZ
        const xyChanged = seg.x !== prevX || seg.y !== prevY
        const isPlunge = zChanged && prevSeg && !prevSeg.rapid && !xyChanged
        const feed = isPlunge ? tool.zFeedMmMin : tool.xyFeedMmMin
        const parts: string[] = ['G1']
        if (xyChanged) parts.push(`X${f(seg.x)} Y${f(seg.y)}`)
        if (zChanged) parts.push(`Z${f(seg.z)}`)
        parts.push(`F${feed}`)
        if (parts.length > 2) lines.push(parts.join(' '))
      }

      prevX = seg.x; prevY = seg.y; prevZ = seg.z
    }
    lines.push(``)
  }

  lines.push(`M5     ; spindle off`)
  lines.push(`G0 Z10.000   ; safe retract`)
  lines.push(`M30    ; end`)

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
