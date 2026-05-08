import { Layer, Path } from 'react-konva'
import type Konva from 'konva'
import type { Viewport } from '../CanvasStage'
import { usePathsStore } from '../../store/pathsStore'
import type { LiveTransform } from '../types'

interface Props {
  viewport: Viewport
  liveTransform: LiveTransform | null
  onPathMouseDown: (id: string, shift: boolean, e: Konva.KonvaEventObject<MouseEvent>) => void
}

export function DesignLayer({ viewport, liveTransform, onPathMouseDown }: Props) {
  const { paths, selectedIds } = usePathsStore()
  const { x, y, scale } = viewport

  return (
    <Layer x={x} y={y} scaleX={scale} scaleY={-scale}>
      {paths.filter((p) => p.visible).map((p) => {
        const isSelected = selectedIds.includes(p.id)
        const lt = liveTransform && liveTransform.pathIds.has(p.id) ? liveTransform : null

        // Compute Konva node transform attributes for live preview
        let nodeX = 0, nodeY = 0
        let nodeScaleX = 1, nodeScaleY = 1
        let nodeOffsetX = 0, nodeOffsetY = 0
        let nodeRotation = 0

        if (lt) {
          if (lt.kind === 'translate') {
            nodeX = lt.dx
            nodeY = lt.dy
          } else if (lt.kind === 'scale') {
            nodeOffsetX = lt.ax
            nodeOffsetY = lt.ay
            nodeX = lt.ax
            nodeY = lt.ay
            nodeScaleX = lt.sx
            nodeScaleY = lt.sy
          } else if (lt.kind === 'rotate') {
            nodeOffsetX = lt.cx
            nodeOffsetY = lt.cy
            nodeX = lt.cx
            nodeY = lt.cy
            // rotation=angle: in Y-flipped layer, positive angle = CCW on screen (correct for CNC)
            nodeRotation = lt.angle
          }
        }

        return (
          <Path
            key={p.id}
            data={p.d}
            stroke={isSelected ? '#ffffff' : p.color}
            strokeWidth={(isSelected ? 2 : 1.5) / scale}
            fill="transparent"
            listening
            x={nodeX}
            y={nodeY}
            scaleX={nodeScaleX}
            scaleY={nodeScaleY}
            offsetX={nodeOffsetX}
            offsetY={nodeOffsetY}
            rotation={nodeRotation}
            onMouseDown={(e) => {
              e.cancelBubble = true
              onPathMouseDown(p.id, e.evt.shiftKey, e)
            }}
            hitStrokeWidth={8 / scale}
          />
        )
      })}
    </Layer>
  )
}
