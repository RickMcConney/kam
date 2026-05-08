import { Layer, Path, Line, Circle } from 'react-konva'
import type Konva from 'konva'
import type { Viewport } from '../CanvasStage'
import type { PathNode } from '../nodeUtils'
import { nodesToD, nearestSegmentOnPath } from '../nodeUtils'

interface Props {
  viewport: Viewport
  nodes: PathNode[]
  closed: boolean
  hoveredNodeIdx: number | null
  onNodeMouseDown: (nodeIdx: number, kind: 'anchor' | 'handle-in' | 'handle-out', e: Konva.KonvaEventObject<MouseEvent>) => void
  onSegmentMouseDown: (segIdx: number, cncX: number, cncY: number) => void
  onHoveredNodeChange: (idx: number | null) => void
}

const ANCHOR_R = 4.5
const HANDLE_R = 3
const STROKE_COLOR = '#38bdf8'
const HANDLE_COLOR = '#94a3b8'
const HOVERED_COLOR = '#ef4444'

export function NodeEditLayer({
  viewport,
  nodes,
  closed,
  hoveredNodeIdx,
  onNodeMouseDown,
  onSegmentMouseDown,
  onHoveredNodeChange,
}: Props) {
  const { x: vx, y: vy, scale: s } = viewport
  if (nodes.length === 0) return null

  const pathD = nodesToD(nodes, closed)

  const handleSegmentMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    e.cancelBubble = true
    const pointer = e.target.getStage()?.getPointerPosition()
    if (!pointer) return
    const cncX = (pointer.x - viewport.x) / viewport.scale
    const cncY = (viewport.y - pointer.y) / viewport.scale

    // Only insert if not near any anchor (anchors cancel bubble first)
    const nearest = nearestSegmentOnPath(nodes, closed, cncX, cncY)
    if (!nearest) return
    // Threshold: 8 screen pixels → CNC
    const threshSq = (8 / s) * (8 / s)
    if (nearest.distSq > threshSq) return
    onSegmentMouseDown(nearest.segIdx, cncX, cncY)
  }

  return (
    <Layer x={vx} y={vy} scaleX={s} scaleY={-s} listening>
      {/* Wide invisible hit area for segment clicks */}
      {pathD && (
        <Path
          data={pathD}
          stroke="transparent"
          strokeWidth={12 / s}
          fill="transparent"
          hitStrokeWidth={12 / s}
          listening
          onMouseDown={handleSegmentMouseDown}
        />
      )}

      {/* Visible path outline */}
      {pathD && (
        <Path
          data={pathD}
          stroke={STROKE_COLOR}
          strokeWidth={1.5 / s}
          fill="transparent"
          listening={false}
        />
      )}

      {/* Handle lines and circles */}
      {nodes.map((node, i) => (
        <NodeHandles
          key={i}
          node={node}
          nodeIdx={i}
          scale={s}
          onMouseDown={onNodeMouseDown}
        />
      ))}

      {/* Anchor circles (rendered last = on top) */}
      {nodes.map((node, i) => (
        <Circle
          key={i}
          x={node.x}
          y={node.y}
          radius={ANCHOR_R / s}
          fill={i === 0 ? '#0f172a' : '#1e293b'}
          stroke={hoveredNodeIdx === i ? HOVERED_COLOR : i === 0 ? '#ffffff' : STROKE_COLOR}
          strokeWidth={1.5 / s}
          listening
          onMouseEnter={() => onHoveredNodeChange(i)}
          onMouseLeave={() => onHoveredNodeChange(null)}
          onMouseDown={(e) => { e.cancelBubble = true; onNodeMouseDown(i, 'anchor', e) }}
        />
      ))}
    </Layer>
  )
}

function NodeHandles({
  node,
  nodeIdx,
  scale: s,
  onMouseDown,
}: {
  node: PathNode
  nodeIdx: number
  scale: number
  onMouseDown: (nodeIdx: number, kind: 'anchor' | 'handle-in' | 'handle-out', e: Konva.KonvaEventObject<MouseEvent>) => void
}) {
  return (
    <>
      {node.handleIn && (
        <>
          <Line
            points={[node.x, node.y, node.handleIn.x, node.handleIn.y]}
            stroke={HANDLE_COLOR}
            strokeWidth={1 / s}
            listening={false}
          />
          <Circle
            x={node.handleIn.x}
            y={node.handleIn.y}
            radius={HANDLE_R / s}
            fill={HANDLE_COLOR}
            listening
            onMouseDown={(e) => { e.cancelBubble = true; onMouseDown(nodeIdx, 'handle-in', e) }}
          />
        </>
      )}
      {node.handleOut && (
        <>
          <Line
            points={[node.x, node.y, node.handleOut.x, node.handleOut.y]}
            stroke={HANDLE_COLOR}
            strokeWidth={1 / s}
            listening={false}
          />
          <Circle
            x={node.handleOut.x}
            y={node.handleOut.y}
            radius={HANDLE_R / s}
            fill={HANDLE_COLOR}
            listening
            onMouseDown={(e) => { e.cancelBubble = true; onMouseDown(nodeIdx, 'handle-out', e) }}
          />
        </>
      )}
    </>
  )
}
