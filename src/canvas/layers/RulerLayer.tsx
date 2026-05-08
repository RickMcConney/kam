import { memo } from 'react'
import { Layer, Shape } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { useUIStore } from '../../store/uiStore'
import { originWorldXY } from './WorkpieceLayer'
import { majorStepMM, formatRulerLabel } from '../gridUtils'
import { canvasTheme } from '../../theme'

export const RULER_H = 20   // top ruler height (px)
export const RULER_W = 40   // left ruler width (px)

interface Props {
  viewport: Viewport
  stageWidth: number
  stageHeight: number
}

export const RulerLayer = memo(function RulerLayer({ viewport, stageWidth, stageHeight }: Props) {
  const { units, origin, widthMM, heightMM } = useWorkpieceStore()
  const darkMode = useUIStore((s) => s.darkMode)
  const orgWorld = originWorldXY(origin, widthMM, heightMM)
  const { bg: BG, border: BORDER, tickMj: TICK_MJ, tickMn: TICK_MN, label: LABEL, corner: CORNER } = canvasTheme(darkMode).ruler

  return (
    <Layer listening={false}>
      <Shape
        width={stageWidth}
        height={stageHeight}
        sceneFunc={(ctx) => {
          const c = ctx._context as CanvasRenderingContext2D
          const { x: panX, y: panY, scale } = viewport
          const step = majorStepMM(scale, units)
          const stepPx = step * scale
          const minorStep = step / 5
          const minorPx = minorStep * scale
          const drawMinor = minorPx >= 4

          c.save()
          c.font = '10px ui-monospace, "SF Mono", Menlo, monospace'

          // ── Top ruler (X) ───────────────────────────────────────────────
          c.fillStyle = BG
          c.fillRect(RULER_W, 0, stageWidth - RULER_W, RULER_H)

          // Major ticks + labels
          const wxAtRulerLeft = (-panX + RULER_W) / scale
          const wxMajStart = orgWorld.x + Math.floor((wxAtRulerLeft - orgWorld.x) / step) * step
          for (let wx = wxMajStart; panX + wx * scale <= stageWidth + stepPx; wx += step) {
            const sx = panX + wx * scale
            if (sx < RULER_W || sx > stageWidth) continue
            c.strokeStyle = TICK_MJ
            c.lineWidth = 0.5
            c.beginPath()
            c.moveTo(sx + 0.5, RULER_H - 9)
            c.lineTo(sx + 0.5, RULER_H)
            c.stroke()
            const label = formatRulerLabel(wx - orgWorld.x, units)
            c.fillStyle = LABEL
            c.textAlign = 'center'
            c.textBaseline = 'top'
            c.fillText(label, sx, 2)
          }

          // Minor ticks
          if (drawMinor) {
            const wxMinStart = orgWorld.x + Math.floor((wxAtRulerLeft - orgWorld.x) / minorStep) * minorStep
            for (let wx = wxMinStart; panX + wx * scale <= stageWidth + stepPx; wx += minorStep) {
              const relX = wx - orgWorld.x
              if (Math.abs(Math.round(relX / step) * step - relX) < step * 0.01) continue // skip majors
              const sx = panX + wx * scale
              if (sx < RULER_W || sx > stageWidth) continue
              c.strokeStyle = TICK_MN
              c.lineWidth = 0.5
              c.beginPath()
              c.moveTo(sx + 0.5, RULER_H - 4)
              c.lineTo(sx + 0.5, RULER_H)
              c.stroke()
            }
          }

          // Bottom border
          c.strokeStyle = BORDER
          c.lineWidth = 1
          c.beginPath()
          c.moveTo(RULER_W, RULER_H - 0.5)
          c.lineTo(stageWidth, RULER_H - 0.5)
          c.stroke()

          // ── Left ruler (Y) ──────────────────────────────────────────────
          c.fillStyle = BG
          c.fillRect(0, RULER_H, RULER_W, stageHeight - RULER_H)

          // Major ticks + labels (Y flipped: screenY = panY - worldY * scale)
          const wyMax = panY / scale
          const wyMin = (panY - stageHeight) / scale
          const wyMajStart = orgWorld.y + Math.floor((wyMin - orgWorld.y) / step) * step
          for (let wy = wyMajStart; wy <= wyMax + step; wy += step) {
            const sy = panY - wy * scale
            if (sy < RULER_H || sy > stageHeight) continue
            c.strokeStyle = TICK_MJ
            c.lineWidth = 0.5
            c.beginPath()
            c.moveTo(RULER_W - 9, sy + 0.5)
            c.lineTo(RULER_W, sy + 0.5)
            c.stroke()
            const label = formatRulerLabel(wy - orgWorld.y, units)
            c.fillStyle = LABEL
            c.textAlign = 'right'
            c.textBaseline = 'middle'
            c.fillText(label, RULER_W - 11, sy)
          }

          // Minor ticks
          if (drawMinor) {
            const wyMinStart = orgWorld.y + Math.floor((wyMin - orgWorld.y) / minorStep) * minorStep
            for (let wy = wyMinStart; wy <= wyMax + step; wy += minorStep) {
              const relY = wy - orgWorld.y
              if (Math.abs(Math.round(relY / step) * step - relY) < step * 0.01) continue
              const sy = panY - wy * scale
              if (sy < RULER_H || sy > stageHeight) continue
              c.strokeStyle = TICK_MN
              c.lineWidth = 0.5
              c.beginPath()
              c.moveTo(RULER_W - 4, sy + 0.5)
              c.lineTo(RULER_W, sy + 0.5)
              c.stroke()
            }
          }

          // Right border
          c.strokeStyle = BORDER
          c.lineWidth = 1
          c.beginPath()
          c.moveTo(RULER_W - 0.5, RULER_H)
          c.lineTo(RULER_W - 0.5, stageHeight)
          c.stroke()

          // ── Corner box ──────────────────────────────────────────────────
          c.fillStyle = CORNER
          c.fillRect(0, 0, RULER_W, RULER_H)
          c.strokeStyle = BORDER
          c.lineWidth = 1
          c.beginPath()
          c.moveTo(RULER_W - 0.5, 0)
          c.lineTo(RULER_W - 0.5, RULER_H)
          c.moveTo(0, RULER_H - 0.5)
          c.lineTo(RULER_W, RULER_H - 0.5)
          c.stroke()
          c.fillStyle = '#505050'
          c.font = '8px ui-monospace, "SF Mono", Menlo, monospace'
          c.textAlign = 'center'
          c.textBaseline = 'middle'
          c.fillText(units, RULER_W / 2, RULER_H / 2)

          c.restore()
        }}
      />
    </Layer>
  )
}
)
