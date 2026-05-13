import { memo, useMemo } from 'react'
import { Group, Circle, Line } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { useSimStore } from '../../store/simStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { getCurrentSegIdx, interpolatePos, type SimSegment } from '../../sim/gcodeParser'
import { originWorldXY } from '../layers/WorkpieceLayer'

interface Props {
  viewport: Viewport
}

// Groups non-rapid cutting segments into continuous polylines for the trail.
// Splits on rapids, above-material moves, or tool diameter changes.
// ox/oy: origin offset to convert machine-relative G-code coords back to workpiece-local.
function computeTrailSections(
  segments: SimSegment[],
  upToIdx: number,
  ox: number,
  oy: number,
): { points: number[]; toolDiameterMM: number }[] {
  const sections: { points: number[]; toolDiameterMM: number }[] = []
  let pts: number[] | null = null
  let curDia = 0

  for (let i = 0; i <= upToIdx && i < segments.length; i++) {
    const seg = segments[i]
    const isCut = !seg.rapid && seg.z < -0.001

    if (!isCut || seg.toolDiameterMM !== curDia) {
      if (pts && pts.length >= 4) sections.push({ points: pts, toolDiameterMM: curDia })
      pts = isCut ? [seg.prevX + ox, seg.prevY + oy, seg.x + ox, seg.y + oy] : null
      curDia = isCut ? seg.toolDiameterMM : 0
    } else {
      pts!.push(seg.x + ox, seg.y + oy)
    }
  }
  if (pts && pts.length >= 4) sections.push({ points: pts, toolDiameterMM: curDia })
  return sections
}

// Completed trail — only re-renders when the current segment index changes.
// The 60fps elapsedTimeS updates don't flow through here.
interface CompletedTrailProps {
  segments: SimSegment[]
  upToIdx: number
  ox: number
  oy: number
}
const CompletedTrail = memo(function CompletedTrail({ segments, upToIdx, ox, oy }: CompletedTrailProps) {
  const sections = useMemo(
    () => computeTrailSections(segments, upToIdx, ox, oy),
    [segments, upToIdx, ox, oy],
  )
  return (
    <>
      {sections.map((sec, i) => (
        <Line
          key={i}
          points={sec.points}
          stroke="#06b6d4"
          strokeWidth={sec.toolDiameterMM}
          lineCap="round"
          lineJoin="round"
          opacity={0.55}
          listening={false}
        />
      ))}
    </>
  )
})

export const SimulationLayer = memo(function SimulationLayer({ viewport }: Props) {
  const segments = useSimStore((s) => s.segments)
  const elapsedTimeS = useSimStore((s) => s.elapsedTimeS)
  const gcode = useSimStore((s) => s.gcode)
  const { scale } = viewport

  // G-code coords are machine-relative; add origin offset to get workpiece-local for rendering.
  const { widthMM, heightMM, origin } = useWorkpieceStore()
  const org = originWorldXY(origin, widthMM, heightMM)
  const ox = org.x
  const oy = org.y

  if (!gcode || segments.length === 0) return null

  const curSegIdx = getCurrentSegIdx(segments, elapsedTimeS)
  const pos = interpolatePos(segments, elapsedTimeS)
  if (!pos) return null

  const curSeg = curSegIdx >= 0 ? segments[curSegIdx] : null
  const isCutting = pos.z < -0.001
  const toolRadius = curSeg ? Math.max(curSeg.toolDiameterMM / 2, 1.5 / scale) : 3 / scale

  // Workpiece-local tool position
  const tx = pos.x + ox
  const ty = pos.y + oy

  return (
    <Group listening={false}>
      {/* Completed trail sections — memoized, only updates at segment boundaries */}
      <CompletedTrail segments={segments} upToIdx={curSegIdx - 1} ox={ox} oy={oy} />

      {/* Active (partial) segment — updates at 60fps, just 2 points */}
      {curSeg && isCutting && (
        <Line
          points={[curSeg.prevX + ox, curSeg.prevY + oy, tx, ty]}
          stroke="#06b6d4"
          strokeWidth={curSeg.toolDiameterMM}
          lineCap="round"
          lineJoin="round"
          opacity={0.55}
          listening={false}
        />
      )}

      {/* Tool dot — outer ring */}
      <Circle
        x={tx}
        y={ty}
        radius={toolRadius + 1.5 / scale}
        stroke="#ffffff"
        strokeWidth={1.5 / scale}
        opacity={0.75}
      />
      {/* Tool dot — fill */}
      <Circle
        x={tx}
        y={ty}
        radius={toolRadius}
        fill={isCutting ? '#ef4444' : '#9ca3af'}
        opacity={0.95}
      />
    </Group>
  )
})
