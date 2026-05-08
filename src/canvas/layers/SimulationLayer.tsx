import { memo, useMemo } from 'react'
import { Layer, Circle, Line } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { useSimStore } from '../../store/simStore'
import { getCurrentSegIdx, interpolatePos, type SimSegment } from '../../sim/gcodeParser'

interface Props {
  viewport: Viewport
}

// Groups non-rapid cutting segments into continuous polylines for the trail.
// Splits on rapids, above-material moves, or tool diameter changes.
function computeTrailSections(
  segments: SimSegment[],
  upToIdx: number,
): { points: number[]; toolDiameterMM: number }[] {
  const sections: { points: number[]; toolDiameterMM: number }[] = []
  let pts: number[] | null = null
  let curDia = 0

  for (let i = 0; i <= upToIdx && i < segments.length; i++) {
    const seg = segments[i]
    const isCut = !seg.rapid && seg.z < -0.001

    if (!isCut || seg.toolDiameterMM !== curDia) {
      if (pts && pts.length >= 4) sections.push({ points: pts, toolDiameterMM: curDia })
      pts = isCut ? [seg.prevX, seg.prevY, seg.x, seg.y] : null
      curDia = isCut ? seg.toolDiameterMM : 0
    } else {
      pts!.push(seg.x, seg.y)
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
}
const CompletedTrail = memo(function CompletedTrail({ segments, upToIdx }: CompletedTrailProps) {
  const sections = useMemo(
    () => computeTrailSections(segments, upToIdx),
    [segments, upToIdx],
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

  if (!gcode || segments.length === 0) return null

  const curSegIdx = getCurrentSegIdx(segments, elapsedTimeS)
  const pos = interpolatePos(segments, elapsedTimeS)
  if (!pos) return null

  const curSeg = curSegIdx >= 0 ? segments[curSegIdx] : null
  const isCutting = pos.z < -0.001
  const toolRadius = curSeg ? Math.max(curSeg.toolDiameterMM / 2, 1.5 / scale) : 3 / scale

  return (
    <Layer x={viewport.x} y={viewport.y} scaleX={scale} scaleY={-scale} listening={false}>
      {/* Completed trail sections — memoized, only updates at segment boundaries */}
      <CompletedTrail segments={segments} upToIdx={curSegIdx - 1} />

      {/* Active (partial) segment — updates at 60fps, just 2 points */}
      {curSeg && isCutting && (
        <Line
          points={[curSeg.prevX, curSeg.prevY, pos.x, pos.y]}
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
        x={pos.x}
        y={pos.y}
        radius={toolRadius + 1.5 / scale}
        stroke="#ffffff"
        strokeWidth={1.5 / scale}
        opacity={0.75}
      />
      {/* Tool dot — fill */}
      <Circle
        x={pos.x}
        y={pos.y}
        radius={toolRadius}
        fill={isCutting ? '#ef4444' : '#9ca3af'}
        opacity={0.95}
      />
    </Layer>
  )
})
