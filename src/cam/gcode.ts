import type { AnyOperation, MotionSegment } from '../store/toolpathStore'
import { perfLog } from '../debug'
import type { Tool } from '../store/toolStore'
import type { PostProcessorProfile } from '../store/postProcessorStore'
import { useWorkpieceStore, zDatumOffsetMM } from '../store/workpieceStore'
import { SPINDLE_INFO, spindleDialLabel } from '../store/spindle'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'
import { feedsForTool } from './feeds'
import { arcFitPolyline, douglasPeucker, type Pt2 } from './pathFlattener'
import { sanitizeFileName } from '../io/filename'

const MM_PER_IN = 25.4

function f(n: number, decimals = 3) { return n.toFixed(decimals) }

function sub(template: string, vals: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vals[k] ?? ''))
}

function cmt(text: string, style: PostProcessorProfile['commentStyle']): string {
  if (style === 'semicolon') return `; ${text}`
  // RS274 parenthesis comments don't nest: the first ')' closes the comment, so any
  // '(' or ')' inside the text (tool names, the spindle-dial note, …) would break
  // parsing. Swap them for brackets so the line stays a single valid comment.
  if (style === 'parenthesis') return `(${text.replace(/[()]/g, (m) => (m === '(' ? '[' : ']'))})`
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

// Tolerance (mm) between the original chords and a fitted arc. Matches the value
// profile/trochoidal already pass to arcFitPolyline so every strategy arc-fits
// the same way. Chord vertices sit on the true curve, so genuine arcs fit well
// inside this; arcFitPolyline's own sagitta/sharp-corner guards reject straights
// and polygon corners.
const ARC_FIT_TOLERANCE_MM = 0.1

// Cap how many chords one fitted arc may absorb. arcFitPolyline re-validates the
// whole candidate span on each growth step, so without a cap a long smooth run
// (spiral/morph/adaptive pockets emit exactly these) makes arc fitting quadratic
// in the run length. 256 bounds the cost while still merging genuinely long arcs
// into just a handful of G2/G3 moves.
const ARC_FIT_MAX_SPAN = 256

// Simplify the emitted cut moves in two ways so curved and straight passes export
// compactly. Strategies like profile/trochoidal already arc-fit upstream; this
// catches the ones (pocket, adaptive, surfacing, …) that only emit flattened
// line chords:
//   - dense chords that approximate a *curve* collapse to one G2/G3 arc, and
//   - dense chords along a *straight* line collapse to a single endpoint move
//     (a straight cut needs only its start and end).
//
// Order matters: arcs are fit first on the original dense points, then only the
// straight spans between arcs are thinned — thinning first could starve a tight
// arc of points and trip arcFitPolyline's sharp-corner guard, losing the arc.
//
// Only constant-Z runs at full feed are eligible: a G2/G3 move carries a single
// feed and the emitter ignores per-segment feedScale on arcs, so any segment with
// a reduced feedScale (e.g. adaptive2 engagement control) is left untouched to
// preserve its protective feed override. Rapids, travels, plunges/lifts (pure Z
// moves), tool changes, and segments that already carry an arc pass through
// verbatim.
function reconstructArcs(segments: MotionSegment[]): MotionSegment[] {
  const eligible = (s: MotionSegment) =>
    !s.rapid && !s.travel && !s.arc && !s.toolChange && (s.feedScale ?? 1) === 1
  const out: MotionSegment[] = []
  const n = segments.length
  let i = 0
  while (i < n) {
    const s = segments[i]
    // A pure vertical move (plunge/lift) shares XY with the prior point; an XY
    // simplifier would drop it and turn the descent into an angled cut. Keep it,
    // and every ineligible/first segment, exactly as-is.
    const verticalMove = i > 0
      && Math.abs(s.x - segments[i - 1].x) < 1e-6
      && Math.abs(s.y - segments[i - 1].y) < 1e-6
    if (i === 0 || !eligible(s) || verticalMove) { out.push(s); i++; continue }

    // Maximal run of eligible cut moves at a constant Z.
    const z0 = s.z
    let e = i
    while (e < n && eligible(segments[e]) && Math.abs(segments[e].z - z0) <= 1e-4) e++

    // arcFitPolyline treats pts[0] as the (already-emitted) current position and
    // returns one segment per pts[1..]; circular spans collapse to a single arc.
    const pts: Pt2[] = [[segments[i - 1].x, segments[i - 1].y]]
    for (let k = i; k < e; k++) pts.push([segments[k].x, segments[k].y])

    // Walk the arc-fit result; RDP-thin each maximal straight span (line moves
    // between arcs), anchored at the prior emitted point so collinear runs reduce
    // to their endpoints while arcs are passed through intact.
    let anchor: Pt2 = pts[0]
    let lineRun: Pt2[] = []
    const flushLine = () => {
      if (lineRun.length === 0) return
      const simplified = douglasPeucker([anchor, ...lineRun], ARC_FIT_TOLERANCE_MM)
      for (let k = 1; k < simplified.length; k++) {
        out.push({ x: simplified[k][0], y: simplified[k][1], z: z0, rapid: false })
      }
      anchor = lineRun[lineRun.length - 1]
      lineRun = []
    }
    for (const seg of arcFitPolyline(pts, ARC_FIT_TOLERANCE_MM, ARC_FIT_MAX_SPAN)) {
      if (seg.arc) {
        flushLine()
        out.push({ x: seg.x, y: seg.y, z: z0, rapid: false, arc: seg.arc })
        anchor = [seg.x, seg.y]
      } else {
        lineRun.push([seg.x, seg.y])
      }
    }
    flushLine()
    i = e
  }
  return out
}

export function generateGcode(
  operations: AnyOperation[],
  toolsById: Record<string, Tool>,
  projectName: string,
  profile: PostProcessorProfile,
): string {
  const _tStart = performance.now()
  let _arcMs = 0
  let _segIn = 0
  let _segOut = 0

  const lines: string[] = []
  const date = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const c = (text: string) => { const l = cmt(text, profile.commentStyle); if (l) lines.push(l) }

  // Segments are stored in workpiece-local coords (0→W, 0→H).
  // G-code must be relative to the machine zero (the origin point the user set on the workpiece).
  const { widthMM, heightMM, thicknessMM, origin, zOrigin, spindleType } = useWorkpieceStore.getState()
  const org = originWorldXY(origin, widthMM, heightMM)
  // Z datum offset: segment Z is top-referenced (Z=0 at top surface). For a bottom-of-stock
  // origin, shift the emitted Z up by the stock thickness so Z=0 lands at the stock bottom.
  const zOff = zDatumOffsetMM(zOrigin, thicknessMM)

  // Comment telling the operator which dial detent to set on a fixed-speed trim
  // router (DeWalt/Makita) for the given RPM. Empty for VFD/manual spindles.
  const dialComment = (rpm: number): string => {
    const label = spindleDialLabel(spindleType, rpm)
    return label ? `Spindle ${rpm} RPM → ${label} (${SPINDLE_INFO[spindleType].label})` : ''
  }

  c(`${projectName}`) // file name (no extension) — first line, for a quick check when loading on the machine
  c(`Generated by FreazyKam`)
  c(`Generated: ${date}`)
  c(`Post-processor: ${profile.name}`)
  c(`Origin: ${origin}  offset X${f(org.x)} Y${f(org.y)}`)
  c(`Z origin: ${zOrigin} of stock (Z0 = ${zOrigin === 'bottom' ? 'stock bottom' : 'top surface'})`)
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
        const dc = dialComment(firstFeeds.rpm); if (dc) c(dc)
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

    // Collapse dense straight-line cut runs into G2/G3 arcs (skipped if the post
    // can't output arcs — they'd just be expanded straight back to lines).
    const _ta = performance.now()
    const segs = profile.outputArcs ? reconstructArcs(op.segments) : op.segments
    _arcMs += performance.now() - _ta
    _segIn += op.segments.length
    _segOut += segs.length

    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]

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
          if (profile.spindleOnTemplate.trim()) {
            const dc = dialComment(newFeeds.rpm); if (dc) c(dc)
            lines.push(sub(profile.spindleOnTemplate, { s: newFeeds.rpm }))
          }
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
      const z = f(toOut(seg.z + zOff, profile), coordDecimals)

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

  if (profile.endGcode.trim()) {
    // Shift literal Z values in endGcode by the datum offset so a hardcoded retract like
    // "G0 Z10" becomes "G0 Z22" when bottom-of-stock (T=12) is selected.
    const endBlock = zOff
      ? (() => {
          const decs = profile.unitMode === 'in' ? 3 : 2
          const zOffOut = toOut(zOff, profile)
          return profile.endGcode.replace(/\bZ(-?[\d.]+)/g, (_, n) => `Z${f(parseFloat(n) + zOffOut, decs)}`)
        })()
      : profile.endGcode
    lines.push(...endBlock.split('\n'))
  }

  perfLog(`[perf] generateGcode total ${(performance.now() - _tStart).toFixed(0)}ms | arc-fit ${_arcMs.toFixed(0)}ms | segs ${_segIn}→${_segOut}`)

  return lines.join('\n')
}

// ─── Split-by-tool export ──────────────────────────────────────────────────
// One standalone file per tool (and therefore per spindle speed, since RPM is
// derived from the tool). Lets a hobbyist run each setup on its own, setting the
// tool and spindle by hand between files instead of mid-program.

export interface SplitGcodeFile {
  toolId: string
  toolName: string
  rpm: number
  filename: string  // no extension
  gcode: string
}

// The segments of one operation that belong to `toolId`. Walks the stream tracking
// the active tool (it flips at each `toolChange` marker — e.g. a 3D-profile op goes
// roughing-tool → finishing-tool), so each tool gets exactly its own motion.
function segmentsForTool(op: AnyOperation, toolId: string): MotionSegment[] {
  let current = op.type === 'profile3d' && op.roughingToolId ? op.roughingToolId : op.toolId
  const out: MotionSegment[] = []
  for (const s of op.segments) {
    if (s.toolChange) {
      current = s.toolChange
      // The marker is a safe-Z rapid into the next tool's work — keep it as a plain
      // positioning move (no embedded tool change) in that tool's file.
      if (current === toolId) {
        const { toolChange: _tc, ...rest } = s
        out.push(rest)
      }
      continue
    }
    if (current === toolId) out.push(s)
  }
  return out
}

// Single-tool copies of every operation that contributes motion for `toolId`.
function opsForTool(operations: AnyOperation[], toolId: string): AnyOperation[] {
  const out: AnyOperation[] = []
  for (const op of operations) {
    if (!op.visible || op.status !== 'done' || op.type === 'gcode' || op.segments.length === 0) continue
    const segments = segmentsForTool(op, toolId)
    if (segments.length === 0) continue
    // Drop roughingToolId so generateGcode treats the copy as a single-tool op.
    out.push({ ...op, segments, toolId, ...(op.type === 'profile3d' ? { roughingToolId: undefined } : {}) } as AnyOperation)
  }
  return out
}

export function generateGcodePerTool(
  operations: AnyOperation[],
  toolsById: Record<string, Tool>,
  baseName: string,
  profile: PostProcessorProfile,
): SplitGcodeFile[] {
  // Distinct tools in order of first use (roughing tool before finishing).
  const orderedToolIds: string[] = []
  for (const op of operations) {
    if (!op.visible || op.status !== 'done' || op.type === 'gcode' || op.segments.length === 0) continue
    if (op.type === 'profile3d' && op.roughingToolId && toolsById[op.roughingToolId] && !orderedToolIds.includes(op.roughingToolId)) {
      orderedToolIds.push(op.roughingToolId)
    }
    if (toolsById[op.toolId] && !orderedToolIds.includes(op.toolId)) orderedToolIds.push(op.toolId)
  }

  const files: SplitGcodeFile[] = []
  for (const toolId of orderedToolIds) {
    const ops = opsForTool(operations, toolId)
    if (ops.length === 0) continue
    const tool = toolsById[toolId]
    const filename = `${baseName}_${files.length + 1}_${sanitizeFileName(tool.name, 'tool')}`
    files.push({
      toolId,
      toolName: tool.name,
      rpm: feedsForTool(tool).rpm,
      filename,
      gcode: generateGcode(ops, toolsById, filename, profile),
    })
  }
  return files
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
