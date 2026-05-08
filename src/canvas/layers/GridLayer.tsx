import { memo } from 'react'
import { Layer, Shape } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { useWorkpieceStore } from '../../store/workpieceStore'

interface Props {
  viewport: Viewport
  stageWidth: number
  stageHeight: number
}

export const GridLayer = memo(function GridLayer({ viewport, stageWidth, stageHeight }: Props) {
  const { units, widthMM, heightMM } = useWorkpieceStore()


  return (
    <Layer listening={false}>
      <Shape
        width={stageWidth}
        height={stageHeight}
        sceneFunc={(ctx) => {
          const { x: panX, y: panY, scale } = viewport
          //const step = majorStepMM(scale, units)
          const step = units === 'mm' ? 10 : 25.4
          const stepPx = step * scale
          if (stepPx < 3) return

          const c = ctx._context as CanvasRenderingContext2D
          c.save()

          const xmin = 0
          const xmax = widthMM
          const ymin = 0
          const ymax = heightMM

          /*
          c.strokeStyle = '#ff0000'
          c.lineWidth = 1;
          c.beginPath()
          c.moveTo(xmin * scale + panX, panY - ymin * scale)
          c.lineTo(xmax * scale + panX, panY - ymax * scale)
          c.stroke()
          */
          // ── Vertical lines ───────────────────────────────────────────────
          
          c.strokeStyle = '#505050'
          c.lineWidth = 0.5
          c.beginPath()
          const ey = panY - ymax * scale
          const sy = panY - ymin * scale
          for (let wx = xmin; wx <= xmax; wx += step) {
            const sx = Math.round(panX + wx * scale) + 0.5
            c.moveTo(sx, sy)
            c.lineTo(sx, ey)
          }
          c.stroke()

          // ── Horizontal lines ─────────────────────────────────────────────
          c.beginPath()
          const ex = xmin * scale + panX
          const sx = xmax * scale + panX
          for (let wy = ymin; wy <= ymax; wy += step) {
            const sy = Math.round(panY - wy * scale) + 0.5
            c.moveTo(sx, sy)
            c.lineTo(ex, sy)
          }
          c.stroke()


/*
          const xStep = drawMinor ? minorStep : step
          const wxAtLeft = -panX  / scale
          const wxStart = orgWorld.x + Math.floor((wxAtLeft - orgWorld.x) / xStep) * xStep

          const wyMax = panY / scale
          const wyMin = (panY - stageHeight) / scale
          const wyStep = drawMinor ? minorStep : step
          const wyStart = orgWorld.y + Math.floor((wyMin - orgWorld.y) / wyStep) * wyStep

          const isMajorX = (wx: number) => {
            const rel = wx - orgWorld.x
            return Math.abs(Math.round(rel / step) * step - rel) < step * 0.01
          }
          const isMajorY = (wy: number) => {
            const rel = wy - orgWorld.y
            return Math.abs(Math.round(rel / step) * step - rel) < step * 0.01
          }

          // Minor vertical lines
          if (drawMinor) {
            c.strokeStyle = '#2e2e2e'
            c.lineWidth = 0.5
            c.beginPath()
            for (let wx = wxStart; panX + wx * scale <= stageWidth + stepPx; wx += xStep) {
              if (isMajorX(wx)) continue
              const sx = Math.round(panX + wx * scale) + 0.5
              if (sx < 0 || sx > stageWidth) continue
              c.moveTo(sx, 0)
              c.lineTo(sx, stageHeight)
            }
            c.stroke()
          }

          // Major vertical lines
          c.strokeStyle = '#505050'
          c.lineWidth = 0.5
          c.beginPath()
          for (let wx = wxStart; panX + wx * scale <= stageWidth + stepPx; wx += xStep) {
            if (!isMajorX(wx)) continue
            const sx = Math.round(panX + wx * scale) + 0.5
            if (sx < 0 || sx > stageWidth) continue
            c.moveTo(sx, 0)
            c.lineTo(sx, stageHeight)
          }
          c.stroke()

          // Minor horizontal lines
          if (drawMinor) {
            c.strokeStyle = '#3a3a3a'
            c.lineWidth = 0.5
            c.beginPath()
            for (let wy = wyStart; wy <= wyMax + step; wy += wyStep) {
              if (isMajorY(wy)) continue
              const sy = Math.round(panY - wy * scale) + 0.5
              if (sy < 0 || sy > stageHeight) continue
              c.moveTo(0, sy)
              c.lineTo(stageWidth, sy)
            }
            c.stroke()
          }

          // Major horizontal lines
          c.strokeStyle = '#979595'
          c.lineWidth = 0.5
          c.beginPath()
          for (let wy = wyStart; wy <= wyMax + step; wy += wyStep) {
            if (!isMajorY(wy)) continue
            const sy = Math.round(panY - wy * scale) + 0.5
            if (sy < 0 || sy > stageHeight) continue
            c.moveTo(0, sy)
            c.lineTo(stageWidth, sy)
          }
          c.stroke()
*/
          c.restore()
        }}
      />
    </Layer>
  )
}
)
