import { Group, Path, Line, Circle } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import type { PenNode } from '../../store/uiStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUIStore } from '../../store/uiStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { majorStepMM, minorStepMM } from '../gridUtils'
import { originWorldXY } from './WorkpieceLayer'

export function penNodesToPathD(nodes: PenNode[], closed?: boolean): string {
  if (nodes.length < 1) return ''
  let d = `M ${nodes[0].x} ${nodes[0].y}`
  for (let i = 1; i < nodes.length; i++) {
    const prev = nodes[i - 1]
    const curr = nodes[i]
    const cp1 = prev.outHandle
    const cp2 = curr.inHandle
    if (!cp1 && !cp2) {
      d += ` L ${curr.x} ${curr.y}`
    } else {
      d += ` C ${cp1?.x ?? prev.x} ${cp1?.y ?? prev.y} ${cp2?.x ?? curr.x} ${cp2?.y ?? curr.y} ${curr.x} ${curr.y}`
    }
  }
  if (closed && nodes.length >= 2) {
    const prev = nodes[nodes.length - 1]
    const curr = nodes[0]
    const cp1 = prev.outHandle
    const cp2 = curr.inHandle
    if (!cp1 && !cp2) {
      d += ' Z'
    } else {
      d += ` C ${cp1?.x ?? prev.x} ${cp1?.y ?? prev.y} ${cp2?.x ?? curr.x} ${cp2?.y ?? curr.y} ${curr.x} ${curr.y} Z`
    }
  }
  return d
}

function liveSegmentD(
  from: PenNode,
  to: { x: number; y: number },
  toInHandle?: { x: number; y: number }
): string {
  const cp1 = from.outHandle
  const cp2 = toInHandle
  if (!cp1 && !cp2) {
    return `M ${from.x} ${from.y} L ${to.x} ${to.y}`
  }
  return `M ${from.x} ${from.y} C ${cp1?.x ?? from.x} ${cp1?.y ?? from.y} ${cp2?.x ?? to.x} ${cp2?.y ?? to.y} ${to.x} ${to.y}`
}

interface Props {
  viewport: Viewport
  penNodes: PenNode[]
  livePen: { anchor: { x: number; y: number }; handle: { x: number; y: number } | null } | null
  penClosing: boolean
}

export function PenLayer({ viewport, penNodes, livePen, penClosing }: Props) {
  const rawCursorCNC = useCanvasStore((s) => s.cursorMM)
  const snapEnabled = useUIStore((s) => s.snapEnabled)
  const { units, origin, widthMM, heightMM } = useWorkpieceStore()
  const { scale: s } = viewport

  let cursorCNC = rawCursorCNC
  if (snapEnabled && rawCursorCNC) {
    const org = originWorldXY(origin, widthMM, heightMM)
    const step = minorStepMM(majorStepMM(s, units), units)
    if (step > 0) {
      cursorCNC = {
        x: Math.round((rawCursorCNC.x - org.x) / step) * step + org.x,
        y: Math.round((rawCursorCNC.y - org.y) / step) * step + org.y,
      }
    }
  }

  const last = penNodes.length > 0 ? penNodes[penNodes.length - 1] : null
  const first = penNodes.length > 0 ? penNodes[0] : null

  const committedD = penNodesToPathD(penNodes)

  let previewD: string | null = null
  if (last) {
    if (livePen) {
      const inH = livePen.handle
        ? {
            x: livePen.anchor.x - (livePen.handle.x - livePen.anchor.x),
            y: livePen.anchor.y - (livePen.handle.y - livePen.anchor.y),
          }
        : undefined
      previewD = liveSegmentD(last, livePen.anchor, inH)
    } else if (cursorCNC && penClosing && first) {
      previewD = liveSegmentD(last, first)
    } else if (cursorCNC && !penClosing) {
      previewD = liveSegmentD(last, cursorCNC)
    }
  }

  if (penNodes.length === 0 && !livePen) return null

  return (
    <Group listening={false}>
      {/* Committed path so far */}
      {committedD && (
        <Path data={committedD} stroke="#38bdf8" strokeWidth={1.5 / s} fill="transparent" listening={false} />
      )}

      {/* Live preview to cursor or closing node */}
      {previewD && (
        <Path
          data={previewD}
          stroke="#38bdf8"
          strokeWidth={1.5 / s}
          opacity={0.5}
          dash={[4 / s, 3 / s]}
          fill="transparent"
          listening={false}
        />
      )}

      {/* Outgoing handle of last committed node */}
      {last?.outHandle && (
        <>
          <Line
            points={[last.x, last.y, last.outHandle.x, last.outHandle.y]}
            stroke="#94a3b8"
            strokeWidth={1 / s}
            listening={false}
          />
          <Circle x={last.outHandle.x} y={last.outHandle.y} radius={3 / s} fill="#94a3b8" listening={false} />
        </>
      )}

      {/* Live handle lines during drag to set curve */}
      {livePen?.handle && (
        <>
          <Line
            points={[livePen.anchor.x, livePen.anchor.y, livePen.handle.x, livePen.handle.y]}
            stroke="#94a3b8"
            strokeWidth={1 / s}
            listening={false}
          />
          <Circle x={livePen.handle.x} y={livePen.handle.y} radius={3 / s} fill="#94a3b8" listening={false} />
          <Line
            points={[
              livePen.anchor.x,
              livePen.anchor.y,
              livePen.anchor.x - (livePen.handle.x - livePen.anchor.x),
              livePen.anchor.y - (livePen.handle.y - livePen.anchor.y),
            ]}
            stroke="#94a3b8"
            strokeWidth={1 / s}
            listening={false}
          />
          <Circle
            x={livePen.anchor.x - (livePen.handle.x - livePen.anchor.x)}
            y={livePen.anchor.y - (livePen.handle.y - livePen.anchor.y)}
            radius={3 / s}
            fill="#94a3b8"
            listening={false}
          />
        </>
      )}

      {/* Committed anchor point circles */}
      {penNodes.map((node, i) => (
        <Circle
          key={i}
          x={node.x}
          y={node.y}
          radius={4 / s}
          fill={i === 0 && penClosing ? '#38bdf8' : '#1e293b'}
          stroke={i === 0 && penClosing ? '#ffffff' : '#38bdf8'}
          strokeWidth={1.5 / s}
          listening={false}
        />
      ))}

      {/* Ghost anchor being placed (during mousedown-drag) */}
      {livePen && (
        <Circle
          x={livePen.anchor.x}
          y={livePen.anchor.y}
          radius={4 / s}
          fill="#1e293b"
          stroke="#38bdf8"
          strokeWidth={1.5 / s}
          listening={false}
        />
      )}
    </Group>
  )
}
