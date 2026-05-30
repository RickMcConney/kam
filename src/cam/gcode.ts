import type { AnyOperation } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import type { PostProcessorProfile } from '../store/postProcessorStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'
import { feedsForTool } from './feeds'

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
  if (op.type === 'profile3d') return `3D raster · ${op.stepoverPercent}% stepover · ${op.maxDepthMM}mm max depth`
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

  const doneOps = operations.filter((o) => o.visible && o.status === 'done' && o.segments.length > 0 && o.type !== 'gcode')
  if (doneOps.length === 0) {
    c('No toolpaths to export.')
    lines.push('M30')
    return lines.join('\n')
  }

  let lastToolId = ''

  for (const op of doneOps) {
    const finishTool = toolsById[op.toolId]
    if (!finishTool) continue

    // For profile3d ops with a roughing tool, the first tool is the roughing endmill.
    const roughingToolId = op.type === 'profile3d' ? op.roughingToolId : undefined
    const roughTool = roughingToolId ? toolsById[roughingToolId] : null
    const firstTool = roughTool || finishTool
    const firstToolId = roughTool ? roughingToolId! : op.toolId
    const firstFeeds = feedsForTool(firstTool)

    c(`=== ${op.name} ===`)
    if (roughingToolId && toolsById[roughingToolId]) {
      const rt = toolsById[roughingToolId]
      // Sim parser reads "dia X.XXXmm" to set tool diameter — emit roughing tool LAST so
      // the roughing segments get the correct (large) diameter.  Finishing tool dia is
      // emitted at the tool-change segment later.
      c(`Finishing: ${finishTool.name}  ${opDesc(op)}`)
      c(`Roughing: ${rt.name}  dia ${f(rt.diameterMM)}mm  flutes:${rt.fluteCount}`)
      if (rt.type === 'ballnose') c(`ballnose`)
    } else {
      c(`Tool: ${finishTool.name}  dia ${f(finishTool.diameterMM)}mm  flutes:${finishTool.fluteCount}  ${opDesc(op)}`)
      if (finishTool.type === 'vbit') {
        const angleDeg = (op.type === 'vcarve' || op.type === 'inlay')
          ? op.angleDeg
          : (finishTool.vbitAngleDeg ?? 60)
        c(`vbit-angle:${f(angleDeg / 2)}`)
      }
      if (finishTool.type === 'ballnose') c(`ballnose`)
    }

    if (lastToolId !== firstToolId) {
      if (lastToolId && profile.toolChangeGcode.trim()) {
        lines.push(...profile.toolChangeGcode.split('\n'))
      }
      if (profile.spindleOnTemplate.trim()) {
        lines.push(sub(profile.spindleOnTemplate, { s: firstFeeds.rpm }))
      }
      if (firstFeeds.rpmAdjusted) {
        c(`NOTE: auto-feed set spindle to ${firstFeeds.rpm} RPM (tool stored ${firstTool.rpm}). If your machine has no spindle-speed control, set the speed by hand.`)
      }
      lastToolId = firstToolId
    }

    const coordDecimals = profile.unitMode === 'in' ? 3 : 2
    let prevX = NaN, prevY = NaN, prevZ = NaN
    let currentTool = firstTool
    let currentFeeds = firstFeeds

    for (let i = 0; i < op.segments.length; i++) {
      const seg = op.segments[i]

      // Tool-change marker: emit tool-change gcode, update current tool, no movement
      if (seg.toolChange) {
        const newTool = toolsById[seg.toolChange]
        if (newTool && seg.toolChange !== lastToolId) {
          if (profile.toolChangeGcode.trim()) lines.push(...profile.toolChangeGcode.split('\n'))
          // Emit dia + tool type so sim parser updates to the new tool
          c(`${newTool.name}  dia ${f(newTool.diameterMM)}mm  flutes:${newTool.fluteCount}`)
          if (newTool.type === 'vbit') {
            const vbitAngle = op.type === 'inlay' ? op.angleDeg : (newTool.vbitAngleDeg ?? 60)
            c(`vbit-angle:${f(vbitAngle / 2)}`)
          }
          if (newTool.type === 'ballnose') c(`ballnose`)
          const newFeeds = feedsForTool(newTool)
          if (profile.spindleOnTemplate.trim()) lines.push(sub(profile.spindleOnTemplate, { s: newFeeds.rpm }))
          if (newFeeds.rpmAdjusted) {
            c(`NOTE: auto-feed set spindle to ${newFeeds.rpm} RPM (tool stored ${newTool.rpm}). If your machine has no spindle-speed control, set the speed by hand.`)
          }
          currentTool = newTool
          currentFeeds = newFeeds
          lastToolId = seg.toolChange
        }
        prevX = seg.x; prevY = seg.y; prevZ = seg.z
        continue
      }

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
        const isHelical = seg.z !== prevZ
        const feedMm = (isHelical || currentTool.xyFeedMmMin === 0) ? currentFeeds.plungeMmMin : currentFeeds.xyFeedMmMin
        const feed = Math.round(toOut(feedMm, profile))
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
        const feed = Math.round(toOut(currentFeeds.xyFeedMmMin, profile))
        for (let k = 1; k <= steps; k++) {
          const t = k / steps
          const a = a0 + (a1 - a0) * t
          const ax = f(toOut(cx + r * Math.cos(a) - org.x, profile), coordDecimals)
          const ay = f(toOut(cy + r * Math.sin(a) - org.y, profile), coordDecimals)
          const az = f(toOut(prevZ + (seg.z - prevZ) * t, profile), coordDecimals)
          lines.push(sub(profile.cutTemplate, { x: ax, y: ay, z: az, f: feed }))
        }
      } else {
        const xyChanged = seg.x !== prevX || seg.y !== prevY
        const isPlunge = !xyChanged && seg.z < prevZ
        const feedMm = isPlunge ? currentFeeds.plungeMmMin : currentFeeds.xyFeedMmMin
        const feed = Math.round(toOut(feedMm * (seg.feedScale ?? 1), profile))
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
