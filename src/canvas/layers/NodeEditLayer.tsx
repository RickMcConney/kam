import { useState } from 'react'
import { Group, Path, Line, Circle } from 'react-konva'
import type Konva from 'konva'
import type { Viewport } from '../CanvasStage'
import type { PathNode } from '../nodeUtils'
import { nodesToD, nearestSegmentOnPath, nearestPointOnSegment, segmentMidpoint } from '../nodeUtils'

interface Props {
  viewport: Viewport
  nodes: PathNode[]
  closed: boolean
  hoveredNodeIdx: number | null
  onNodeMouseDown: (nodeIdx: number, kind: 'anchor' | 'handle-in' | 'handle-out', e: Konva.KonvaEventObject<MouseEvent>) => void
  onSegmentMouseDown: (segIdx: number, cncX: number, cncY: number) => void
  onHoveredNodeChange: (idx: number | null) => void
  onHoverSegChange?: (segIdx: number | null) => void
}

const ANCHOR_R = 4.5
const HANDLE_R = 3
const STROKE_COLOR = '#38bdf8'
const HANDLE_COLOR = '#94a3b8'
const HOVERED_COLOR = '#ef4444'
const INSERT_COLOR = '#38bdf8'
const INSERT_CENTER_COLOR = '#f59e0b'
const INSERT_THRESHOLD_PX = 8
const CENTER_SNAP_THRESHOLD_PX = 12

type HoverInsert = { x: number; y: number; segIdx: number; snapCenter: boolean }

export function NodeEditLayer({
  viewport,
  nodes,
  closed,
  hoveredNodeIdx,
  onNodeMouseDown,
  onSegmentMouseDown,
  onHoveredNodeChange,
  onHoverSegChange,
}: Props) {
  const { scale: s } = viewport
  const [hoverInsert, setHoverInsert] = useState<HoverInsert | null>(null)

  const updateHoverInsert = (h: HoverInsert | null) => {
    setHoverInsert(h)
    onHoverSegChange?.(h?.segIdx ?? null)
  }

  if (nodes.length === 0) return null

  const pathD = nodesToD(nodes, closed)

  const toCNC = (pointer: { x: number; y: number }) => ({
    x: (pointer.x - viewport.x) / viewport.scale,
    y: (viewport.y - pointer.y) / viewport.scale,
  })

  const handleSegmentMouseMove = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const pointer = e.target.getStage()?.getPointerPosition()
    if (!pointer) { updateHoverInsert(null); return }
    const { x: cncX, y: cncY } = toCNC(pointer)

    const nearest = nearestSegmentOnPath(nodes, closed, cncX, cncY)
    if (!nearest) { updateHoverInsert(null); return }

    const pt = nearestPointOnSegment(nodes, nearest.segIdx, cncX, cncY)
    const threshSq = (INSERT_THRESHOLD_PX / s) ** 2
    if (pt.distSq > threshSq) { updateHoverInsert(null); return }

    const mid = segmentMidpoint(nodes, nearest.segIdx)
    const midScreenDistSq = ((mid.x - pt.x) * s) ** 2 + ((mid.y - pt.y) * s) ** 2
    const snapCenter = midScreenDistSq < CENTER_SNAP_THRESHOLD_PX ** 2

    updateHoverInsert({
      x: snapCenter ? mid.x : pt.x,
      y: snapCenter ? mid.y : pt.y,
      segIdx: nearest.segIdx,
      snapCenter,
    })
  }

  const handleSegmentMouseLeave = () => updateHoverInsert(null)

  const handleSegmentMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    e.cancelBubble = true

    if (hoverInsert?.snapCenter) {
      onSegmentMouseDown(hoverInsert.segIdx, hoverInsert.x, hoverInsert.y)
      return
    }

    const pointer = e.target.getStage()?.getPointerPosition()
    if (!pointer) return
    const { x: cncX, y: cncY } = toCNC(pointer)

    const nearest = nearestSegmentOnPath(nodes, closed, cncX, cncY)
    if (!nearest) return
    const threshSq = (INSERT_THRESHOLD_PX / s) ** 2
    if (nearest.distSq > threshSq) return
    onSegmentMouseDown(nearest.segIdx, cncX, cncY)
  }

  return (
    <Group>
      {/* Wide invisible hit area for segment hover + clicks */}
      {pathD && (
        <Path
          data={pathD}
          stroke="transparent"
          strokeWidth={12 / s}
          fill="transparent"
          hitStrokeWidth={12 / s}
          listening
          onMouseMove={handleSegmentMouseMove}
          onMouseLeave={handleSegmentMouseLeave}
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

      {/* Insert preview point */}
      {hoverInsert && (
        <Circle
          x={hoverInsert.x}
          y={hoverInsert.y}
          radius={ANCHOR_R / s}
          fill={hoverInsert.snapCenter ? INSERT_CENTER_COLOR : 'transparent'}
          stroke={hoverInsert.snapCenter ? INSERT_CENTER_COLOR : INSERT_COLOR}
          strokeWidth={1.5 / s}
          opacity={0.85}
          listening={false}
        />
      )}
    </Group>
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
