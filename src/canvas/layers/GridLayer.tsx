import { memo } from 'react'
import { Group, Shape } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { useUIStore } from '../../store/uiStore'
import { canvasTheme } from '../../theme'

interface Props {
  viewport: Viewport
}

export const GridLayer = memo(function GridLayer({ viewport }: Props) {
  const { units, widthMM, heightMM } = useWorkpieceStore()
  const darkMode = useUIStore((s) => s.darkMode)
  const C = canvasTheme(darkMode)
  const { scale } = viewport

  return (
    <Group listening={false}>
      <Shape
        sceneFunc={(ctx) => {
          const step = units === 'mm' ? 10 : 25.4
          if (step * scale < 3) return

          const c = ctx._context as CanvasRenderingContext2D
          c.save()
          c.strokeStyle = C.grid.axisNorm
          c.lineWidth = 0.5 / scale
          c.beginPath()

          for (let wx = 0; wx <= widthMM + 0.001; wx += step) {
            c.moveTo(wx, 0)
            c.lineTo(wx, heightMM)
          }
          for (let wy = 0; wy <= heightMM + 0.001; wy += step) {
            c.moveTo(0, wy)
            c.lineTo(widthMM, wy)
          }
          c.stroke()
          c.restore()
        }}
        listening={false}
      />
    </Group>
  )
})
