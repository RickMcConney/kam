import { memo, Fragment } from 'react'
import { Layer, Line, Circle } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { useToolpathStore, type MotionSegment, type AnyOperation } from '../../store/toolpathStore'

interface Props {
  viewport: Viewport
  onHover?: (info: { name: string; depth: string } | null, stageX: number, stageY: number) => void
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

function opDepthLabel(op: AnyOperation): string {
  const d = (op as { depthMM?: number }).depthMM
  return d !== undefined ? `${d} mm deep` : ''
}

export const ToolpathLayer = memo(function ToolpathLayer({ viewport, onHover }: Props) {
  const { operations } = useToolpathStore()
  const { scale } = viewport

  const visible = operations.filter((o) => o.visible && o.status === 'done' && o.segments.length > 0)

  return (
    <Layer x={viewport.x} y={viewport.y} scaleX={scale} scaleY={-scale}>
      {visible.map((op) => {
        const { cutting, firstCut } = groupSegments(op.segments)
        const depth = opDepthLabel(op)

        return (
          <Fragment key={op.id}>
            {/* Cutting moves — solid, colored, hoverable */}
            {cutting.map((pts, i) => (
              <Line
                key={`${op.id}-c-${i}`}
                points={pts}
                stroke={op.color}
                strokeWidth={1.5 / scale}
                hitStrokeWidth={16 / scale}
                lineJoin="round"
                lineCap="round"
                opacity={0.9}
                onMouseEnter={(e) => {
                  if (!onHover) return
                  const pos = e.target.getStage()?.getPointerPosition()
                  if (pos) onHover({ name: op.name, depth }, pos.x, pos.y)
                }}
                onMouseMove={(e) => {
                  if (!onHover) return
                  const pos = e.target.getStage()?.getPointerPosition()
                  if (pos) onHover({ name: op.name, depth }, pos.x, pos.y)
                }}
                onMouseLeave={() => onHover?.(null, 0, 0)}
              />
            ))}

            {/* Start marker */}
            {firstCut && (
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
    </Layer>
  )
})
