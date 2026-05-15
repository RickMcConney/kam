import { memo, useMemo } from 'react'
import { SIM_CUT_COLOR, SIM_TOOL_CUTTING_COLOR, SIM_TOOL_RAPID_COLOR, SIM_TOOL_OUTLINE_COLOR } from '../../colors'
import { Group, Circle, Line, Shape } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { useSimStore } from '../../store/simStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { getCurrentSegIdx, interpolatePos, type SimSegment } from '../../sim/gcodeParser'
import { originWorldXY } from '../layers/WorkpieceLayer'

interface Props {
  viewport: Viewport
}

// For V-bit segments, cut width = 2 * |z| * tan(halfAngle), capped at tool diameter.
function effectiveCutWidthAt(seg: SimSegment, z: number): number {
  if (seg.toolVbitHalfAngleTan !== undefined) {
    return Math.min(2 * Math.abs(z) * seg.toolVbitHalfAngleTan, seg.toolDiameterMM)
  }
  return seg.toolDiameterMM
}

function roundWidth(w: number): number {
  return Math.round(w * 10) / 10
}

interface FrustumSeg {
  x0: number; y0: number; w0: number
  x1: number; y1: number; w1: number
}

interface TrailResult {
  lineSections: { points: number[]; width: number }[]
  frustumSegs: FrustumSeg[]
}

// Groups non-rapid cutting segments into:
//   lineSections — consecutive uniform-width segs rendered as Konva Lines
//   frustumSegs  — segs where start/end widths differ by ≥ 0.1mm, rendered as filled trapezoids
function computeTrail(
  segments: SimSegment[],
  upToIdx: number,
  ox: number,
  oy: number,
): TrailResult {
  const lineSections: { points: number[]; width: number }[] = []
  const frustumSegs: FrustumSeg[] = []
  let pts: number[] | null = null
  let curWidth = 0

  const flushLine = () => {
    if (pts && pts.length >= 4) lineSections.push({ points: pts, width: curWidth })
    pts = null
    curWidth = 0
  }

  for (let i = 0; i <= upToIdx && i < segments.length; i++) {
    const seg = segments[i]
    if (seg.rapid || (seg.prevZ >= -0.001 && seg.z >= -0.001)) { flushLine(); continue }

    const w0 = effectiveCutWidthAt(seg, seg.prevZ)
    const w1 = effectiveCutWidthAt(seg, seg.z)
    const x0 = seg.prevX + ox, y0 = seg.prevY + oy
    const x1 = seg.x + ox,    y1 = seg.y + oy

    if (Math.abs(w0 - w1) < 0.1) {
      const w = roundWidth((w0 + w1) / 2)
      if (w !== curWidth || pts === null) {
        flushLine()
        pts = [x0, y0, x1, y1]
        curWidth = w
      } else {
        pts.push(x1, y1)
      }
    } else {
      flushLine()
      frustumSegs.push({ x0, y0, w0, x1, y1, w1 })
    }
  }

  flushLine()
  return { lineSections, frustumSegs }
}

// Builds a Konva sceneFunc that fills all frustum segments as closed quad subpaths.
// Each quad: left-start → left-end → right-end → right-start.
// Coordinates are in CNC mm (the layer's Y-flipped transform handles screen mapping).
function makeFrustumSceneFunc(segs: FrustumSeg[]) {
  return (ctx: any, shape: any) => {
    ctx.beginPath()
    for (const { x0, y0, w0, x1, y1, w1 } of segs) {
      const dx = x1 - x0, dy = y1 - y0
      const len = Math.hypot(dx, dy)
      if (len < 0.0001) continue
      const nx = -dy / len, ny = dx / len   // left-hand normal in CNC Y-up space
      const r0 = w0 / 2, r1 = w1 / 2
      ctx.moveTo(x0 + nx * r0, y0 + ny * r0)
      ctx.lineTo(x1 + nx * r1, y1 + ny * r1)
      ctx.lineTo(x1 - nx * r1, y1 - ny * r1)
      ctx.lineTo(x0 - nx * r0, y0 - ny * r0)
      ctx.closePath()
    }
    ctx.fillStrokeShape(shape)
  }
}

// Completed trail — re-renders only when the current segment index changes.
interface CompletedTrailProps {
  segments: SimSegment[]
  upToIdx: number
  ox: number
  oy: number
}
const CompletedTrail = memo(function CompletedTrail({ segments, upToIdx, ox, oy }: CompletedTrailProps) {
  const trail = useMemo(
    () => computeTrail(segments, upToIdx, ox, oy),
    [segments, upToIdx, ox, oy],
  )
  const frustumFn = useMemo(() => makeFrustumSceneFunc(trail.frustumSegs), [trail.frustumSegs])

  return (
    <>
      {trail.lineSections.map((sec, i) => (
        <Line
          key={i}
          points={sec.points}
          stroke={SIM_CUT_COLOR}
          strokeWidth={sec.width}
          lineCap="round"
          lineJoin="round"
          opacity={0.55}
          listening={false}
        />
      ))}
      {trail.frustumSegs.length > 0 && (
        <Shape
          sceneFunc={frustumFn}
          fill={SIM_CUT_COLOR}
          strokeWidth={0}
          opacity={0.55}
          listening={false}
        />
      )}
    </>
  )
})

export const SimulationLayer = memo(function SimulationLayer({ viewport }: Props) {
  const segments = useSimStore((s) => s.segments)
  const elapsedTimeS = useSimStore((s) => s.elapsedTimeS)
  const gcode = useSimStore((s) => s.gcode)
  const { scale } = viewport

  const { widthMM, heightMM, origin } = useWorkpieceStore()
  const org = originWorldXY(origin, widthMM, heightMM)
  const ox = org.x
  const oy = org.y

  if (!gcode || segments.length === 0) return null

  const curSegIdx = getCurrentSegIdx(segments, elapsedTimeS)
  const pos = interpolatePos(segments, elapsedTimeS)
  if (!pos) return null

  const curSeg = curSegIdx >= 0 ? segments[curSegIdx] : null
  const isCutting = !!curSeg && !curSeg.rapid && (curSeg.prevZ < -0.001 || pos.z < -0.001)
  const tx = pos.x + ox
  const ty = pos.y + oy

  // Active partial segment: frustum when widths differ, plain line otherwise.
  // Always a Shape so the element type stays stable across frames (no React remounting).
  const activeFrustum: FrustumSeg | null = curSeg && isCutting ? {
    x0: curSeg.prevX + ox, y0: curSeg.prevY + oy,
    w0: effectiveCutWidthAt(curSeg, curSeg.prevZ),
    x1: tx, y1: ty,
    w1: effectiveCutWidthAt(curSeg, pos.z),
  } : null

  const activeCutWidth = activeFrustum ? activeFrustum.w1 : (curSeg?.toolDiameterMM ?? 0)
  const toolRadius = Math.max(activeCutWidth / 2, 1.5 / scale)

  return (
    <Group listening={false}>
      <CompletedTrail segments={segments} upToIdx={curSegIdx - 1} ox={ox} oy={oy} />

      {/* Active partial segment — 60fps updates */}
      {activeFrustum && (
        <Shape
          sceneFunc={makeFrustumSceneFunc([activeFrustum])}
          fill={SIM_CUT_COLOR}
          strokeWidth={0}
          opacity={0.55}
          listening={false}
        />
      )}

      {/* Tool dot */}
      <Circle
        x={tx} y={ty}
        radius={toolRadius + 1.5 / scale}
        stroke={SIM_TOOL_OUTLINE_COLOR}
        strokeWidth={1.5 / scale}
        opacity={0.75}
      />
      <Circle
        x={tx} y={ty}
        radius={toolRadius}
        fill={isCutting ? SIM_TOOL_CUTTING_COLOR : SIM_TOOL_RAPID_COLOR}
        opacity={0.95}
      />
    </Group>
  )
})
