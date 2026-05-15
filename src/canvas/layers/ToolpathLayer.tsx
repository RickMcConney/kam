import { memo, Fragment } from 'react'
import { Group, Line, Circle } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { useToolpathStore, type MotionSegment } from '../../store/toolpathStore'
import { useToolStore } from '../../store/toolStore'

interface Props {
  viewport: Viewport
}

interface SegmentGroups {
  cutting: number[][]
  rapid: number[][]
  firstCut: [number, number] | null
}

function groupSegments(segments: MotionSegment[]): SegmentGroups {
  const cutting: number[][] = []
  const rapid: number[][] = []
  let cur: number[] = []
  let isRapid = segments[0]?.rapid ?? true
  let firstCut: [number, number] | null = null

  for (const seg of segments) {
    if (seg.rapid !== isRapid) {
      if (cur.length >= 4) (isRapid ? rapid : cutting).push(cur)
      cur = cur.length >= 2 ? [cur[cur.length - 2], cur[cur.length - 1], seg.x, seg.y] : [seg.x, seg.y]
      isRapid = seg.rapid
    } else {
      cur.push(seg.x, seg.y)
    }
    if (!seg.rapid && firstCut === null) firstCut = [seg.x, seg.y]
  }
  if (cur.length >= 4) (isRapid ? rapid : cutting).push(cur)

  return { cutting, rapid, firstCut }
}

export const ToolpathLayer = memo(function ToolpathLayer({ viewport }: Props) {
  const { operations } = useToolpathStore()
  const { tools } = useToolStore()
  const { scale } = viewport

  const visible = operations.filter((o) => o.visible && o.status === 'done' && o.segments.length > 0)

  return (
    <Group>
      {visible.map((op) => {
        const { cutting, firstCut } = groupSegments(op.segments)

        return (
          <Fragment key={op.id}>
            {cutting.map((pts, i) => (
              <Line
                key={`${op.id}-c-${i}`}
                points={pts}
                stroke={op.color}
                strokeWidth={1.5 / scale}
                lineJoin="round"
                lineCap="round"
                opacity={0.9}
                listening={false}
              />
            ))}

            {op.type === 'drill'
              ? (() => {
                  const tool = tools.find((t) => t.id === op.toolId)
                  const r = tool ? tool.diameterMM / 2 : 3.5 / scale
                  return op.points.map((pt, i) => (
                    <Circle
                      key={`${op.id}-dp-${i}`}
                      x={pt.x}
                      y={pt.y}
                      radius={r}
                      fill="transparent"
                      stroke={op.color}
                      strokeWidth={1.5 / scale}
                      opacity={0.9}
                      listening={false}
                    />
                  ))
                })()
              : firstCut && (
                  <Circle
                    key={`${op.id}-start`}
                    x={firstCut[0]}
                    y={firstCut[1]}
                    radius={3.5 / scale}
                    fill={op.color}
                    stroke="#ffffff"
                    strokeWidth={1 / scale}
                    opacity={0.95}
                    listening={false}
                  />
                )}
          </Fragment>
        )
      })}
    </Group>
  )
})
