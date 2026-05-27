import { useState } from 'react'
import { Group, Path, Line, Circle } from 'react-konva'
import type Konva from 'konva'
import type { Viewport } from '../CanvasStage'
import type { PathNode } from '../nodeUtils'
import { nodesToD, nearestSegmentOnPath, nearestPointOnSegment, segmentMidpoint } from '../nodeUtils'

export type CrossPathEntry = {
  pathId: string
  nodeIdx: number
  x: number
  y: number
  nodes: PathNode[]
  closed: boolean
}

interface Props {
  viewport: Viewport
  nodes: PathNode[]
  closed: boolean
  hoveredNodeIdx: number | null
  weldTargetIdx?: number | null
  crossPathCandidates?: CrossPathEntry[]
  crossPathWeldTarget?: CrossPathEntry | null
  connectSourceIdx?: number | null
  connectPreviewTo?: { x: number; y: number } | null
  connectSnapTargetIdx?: number | null
  onNodeMouseDown: (nodeIdx: number, kind: 'anchor' | 'handle-in' | 'handle-out', e: Konva.KonvaEventObject<MouseEvent>) => void
  onSegmentMouseDown: (segIdx: number, cncX: number, cncY: number) => void
  onHoveredNodeChange: (idx: number | null) => void
  onHoverSegChange?: (segIdx: number | null) => void
}

const ANCHOR_R = 7
const HANDLE_R = 5
const STROKE_COLOR = '#38bdf8'
const HANDLE_COLOR = '#94a3b8'
const HOVERED_COLOR = '#ef4444'
const WELD_COLOR = '#22c55e'
const CONNECT_COLOR = '#f59e0b'
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
  weldTargetIdx,
  crossPathCandidates,
  crossPathWeldTarget,
  connectSourceIdx,
  connectPreviewTo,
  connectSnapTargetIdx,
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

      {/* Connect mode preview line */}
      {connectSourceIdx != null && connectPreviewTo && nodes[connectSourceIdx] && (
        <Line
          points={[nodes[connectSourceIdx].x, nodes[connectSourceIdx].y, connectPreviewTo.x, connectPreviewTo.y]}
          stroke={CONNECT_COLOR}
          strokeWidth={1.5 / s}
          dash={[4 / s, 3 / s]}
          listening={false}
        />
      )}

      {/* Anchor circles (rendered last = on top) */}
      {nodes.map((node, i) => {
        const isWeldTarget = weldTargetIdx === i
        const isConnectSrc = connectSourceIdx === i
        const isConnectSnap = connectSnapTargetIdx === i
        const isHovered = hoveredNodeIdx === i
        const fill = isWeldTarget ? WELD_COLOR : isConnectSrc ? CONNECT_COLOR : isConnectSnap ? CONNECT_COLOR : isHovered ? HOVERED_COLOR : i === 0 ? '#0f172a' : '#1e293b'
        const stroke = isWeldTarget ? WELD_COLOR : isConnectSrc ? CONNECT_COLOR : isConnectSnap ? CONNECT_COLOR : isHovered ? HOVERED_COLOR : i === 0 ? '#ffffff' : STROKE_COLOR
        const r = (isWeldTarget || isConnectSrc || isConnectSnap) ? (ANCHOR_R + 3) / s : ANCHOR_R / s
        return (
          <Circle
            key={i}
            x={node.x}
            y={node.y}
            radius={r}
            fill={fill}
            stroke={stroke}
            strokeWidth={1.5 / s}
            listening
            onMouseEnter={() => onHoveredNodeChange(i)}
            onMouseLeave={() => onHoveredNodeChange(null)}
            onMouseDown={(e) => { e.cancelBubble = true; onNodeMouseDown(i, 'anchor', e) }}
          />
        )
      })}

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

      {/* Cross-path weld candidates (faint rings shown during endpoint drag) */}
      {crossPathCandidates?.map((c, i) => {
        const isTarget = crossPathWeldTarget?.pathId === c.pathId && crossPathWeldTarget?.nodeIdx === c.nodeIdx
        return (
          <Circle
            key={`cp-${c.pathId}-${c.nodeIdx}-${i}`}
            x={c.x}
            y={c.y}
            radius={isTarget ? (ANCHOR_R + 3) / s : ANCHOR_R / s}
            fill={isTarget ? WELD_COLOR : 'transparent'}
            stroke={WELD_COLOR}
            strokeWidth={isTarget ? 1.5 / s : c.closed ? 1 / s : 1.5 / s}
            dash={c.closed && !isTarget ? [3 / s, 2 / s] : undefined}
            opacity={isTarget ? 1 : 0.5}
            listening={false}
          />
        )
      })}
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
  const [hoveredIn, setHoveredIn] = useState(false)
  const [hoveredOut, setHoveredOut] = useState(false)

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
            fill={hoveredIn ? '#ffffff' : HANDLE_COLOR}
            listening
            onMouseEnter={() => setHoveredIn(true)}
            onMouseLeave={() => setHoveredIn(false)}
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
            fill={hoveredOut ? '#ffffff' : HANDLE_COLOR}
            listening
            onMouseEnter={() => setHoveredOut(true)}
            onMouseLeave={() => setHoveredOut(false)}
            onMouseDown={(e) => { e.cancelBubble = true; onMouseDown(nodeIdx, 'handle-out', e) }}
          />
        </>
      )}
    </>
  )
}
