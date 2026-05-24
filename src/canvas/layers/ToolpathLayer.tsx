import { memo, Fragment } from 'react'
import { Group, Shape, Circle } from 'react-konva'
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

// Expands an arc MotionSegment to flat [x,y,...] polyline points starting after the given prev position.
function arcToPolyPts(px: number, py: number, seg: MotionSegment): number[] {
  const { cx, cy, cw } = seg.arc!
  const r = Math.hypot(px - cx, py - cy)
  if (r < 0.001) return [seg.x, seg.y]
  let a0 = Math.atan2(py - cy, px - cx)
  let a1 = Math.atan2(seg.y - cy, seg.x - cx)
  const isFullCircle = Math.abs(px - seg.x) < 0.001 && Math.abs(py - seg.y) < 0.001
  if (isFullCircle) a1 = a0 + (cw ? -2 * Math.PI : 2 * Math.PI)
  else if (cw) { if (a1 >= a0) a1 -= 2 * Math.PI }
  else { if (a1 <= a0) a1 += 2 * Math.PI }
  const steps = Math.max(8, Math.ceil(Math.abs(a1 - a0) / (5 * Math.PI / 180)))
  const pts: number[] = []
  for (let k = 1; k <= steps; k++) {
    const a = a0 + (a1 - a0) * (k / steps)
    pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a))
  }
  return pts
}

function groupSegments(segments: MotionSegment[]): SegmentGroups {
  const cutting: number[][] = []
  const rapid: number[][] = []
  let cur: number[] = []
  let isRapid = segments[0]?.rapid ?? true
  let firstCut: [number, number] | null = null
  let prevX = segments[0]?.x ?? 0
  let prevY = segments[0]?.y ?? 0

  for (const seg of segments) {
    const pts = seg.arc ? arcToPolyPts(prevX, prevY, seg) : [seg.x, seg.y]

    if (seg.rapid !== isRapid) {
      if (cur.length >= 4) (isRapid ? rapid : cutting).push(cur)
      cur = cur.length >= 2 ? [cur[cur.length - 2], cur[cur.length - 1], ...pts] : [...pts]
      isRapid = seg.rapid
    } else {
      cur.push(...pts)
    }
    if (!seg.rapid && firstCut === null) firstCut = [pts[0], pts[1]]
    prevX = seg.x; prevY = seg.y
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
            <Shape
              key={`${op.id}-c`}
              sceneFunc={(ctx, shape) => {
                ctx.beginPath()
                for (const pts of cutting) {
                  if (pts.length < 4) continue
                  ctx.moveTo(pts[0], pts[1])
                  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1])
                }
                ctx.strokeShape(shape)
              }}
              stroke={op.color}
              strokeWidth={1.5 / scale}
              lineJoin="round"
              lineCap="round"
              opacity={0.9}
              listening={false}
            />

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
