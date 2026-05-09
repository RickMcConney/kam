import { Group, Path } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { usePathsStore } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import { canvasTheme } from '../../theme'
import type { LiveTransform } from '../types'

interface Props {
  viewport: Viewport
  liveTransform: LiveTransform | null
  excludePathId?: string | null
}

export function DesignLayer({ viewport, liveTransform, excludePathId }: Props) {
  const { paths, selectedIds } = usePathsStore()
  const darkMode = useUIStore((s) => s.darkMode)
  const C = canvasTheme(darkMode)
  const { scale } = viewport

  return (
    <Group listening={false}>
      {paths.filter((p) => p.visible && p.id !== excludePathId).map((p) => {
        const isSelected = selectedIds.includes(p.id)
        const lt = liveTransform && liveTransform.pathIds.has(p.id) ? liveTransform : null

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
            nodeRotation = lt.angle
          }
        }

        return (
          <Path
            key={p.id}
            data={p.d}
            stroke={isSelected ? C.path.selected : p.color}
            strokeWidth={(isSelected ? 2 : 1.5) / scale}
            listening={false}
            x={nodeX}
            y={nodeY}
            scaleX={nodeScaleX}
            scaleY={nodeScaleY}
            offsetX={nodeOffsetX}
            offsetY={nodeOffsetY}
            rotation={nodeRotation}
          />
        )
      })}
    </Group>
  )
}
