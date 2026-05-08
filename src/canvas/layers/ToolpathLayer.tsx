import { memo } from 'react'
import { Layer, Line } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { useToolpathStore, type MotionSegment } from '../../store/toolpathStore'

interface Props {
  viewport: Viewport
}

function cuttingPaths(segments: MotionSegment[]): number[][] {
  const paths: number[][] = []
  let current: number[] = []
  for (const seg of segments) {
    if (seg.rapid) {
      if (current.length >= 4) paths.push(current)
      current = []
    } else {
      current.push(seg.x, seg.y)
    }
  }
  if (current.length >= 4) paths.push(current)
  return paths
}

export const ToolpathLayer = memo(function ToolpathLayer({ viewport }: Props) {
  const { operations } = useToolpathStore()
  const { scale } = viewport

  const visible = operations.filter((o) => o.visible && o.status === 'done' && o.segments.length > 0)

  return (
    <Layer x={viewport.x} y={viewport.y} scaleX={scale} scaleY={-scale}>
      {visible.map((op) =>
        cuttingPaths(op.segments).map((pts, i) => (
          <Line
            key={`${op.id}-${i}`}
            points={pts}
            stroke={op.color}
            strokeWidth={1.5 / scale}
            lineJoin="round"
            lineCap="round"
            dash={[6 / scale, 3 / scale]}
            opacity={0.85}
            listening={false}
          />
        ))
      )}
    </Layer>
  )
}
)
