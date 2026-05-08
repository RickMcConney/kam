import { Layer, Line, Circle } from 'react-konva'
import type Konva from 'konva'
import type { Viewport } from '../CanvasStage'
import type { HandleType, LiveTransform } from '../types'
import { getMultiBBox, transformPoint } from '../selectionUtils'
import type { ImportedPath } from '../../store/pathsStore'

const HANDLE_R = 5
const ROT_OFFSET_PX = 22

function applyLT(x: number, y: number, lt: LiveTransform | null): { x: number; y: number } {
  if (!lt) return { x, y }
  return transformPoint(x, y, lt as Parameters<typeof transformPoint>[2])
}

interface SharedProps {
  viewport: Viewport
  selectedPaths: ImportedPath[]
  liveTransform: LiveTransform | null
}

function useHandlePositions(viewport: Viewport, selectedPaths: ImportedPath[], liveTransform: LiveTransform | null) {
  const { x: vx, y: vy, scale } = viewport
  const ds = selectedPaths.map((p) => p.d)
  const bbox = getMultiBBox(ds)
  if (!bbox) return null

  const { minX, minY, maxX, maxY, cx, cy } = bbox

  function lt(px: number, py: number) { return applyLT(px, py, liveTransform) }
  function toS(p: { x: number; y: number }) { return { x: vx + p.x * scale, y: vy - p.y * scale } }

  const corners = {
    tl: toS(lt(minX, maxY)), tr: toS(lt(maxX, maxY)),
    bl: toS(lt(minX, minY)), br: toS(lt(maxX, minY)),
    t:  toS(lt(cx,   maxY)), b:  toS(lt(cx,   minY)),
    l:  toS(lt(minX, cy)),   r:  toS(lt(maxX, cy)),
  }

  const topEdgeCNC = lt(cx, maxY)
  const rotOffsetCNC = ROT_OFFSET_PX / scale
  const rotHandle = toS({ x: topEdgeCNC.x, y: topEdgeCNC.y + rotOffsetCNC })
  const rotBase = toS(lt(cx, maxY))

  return { corners, rotHandle, rotBase }
}

// Decorative layer: bounding box outline + rotation handle line (non-interactive)
export function SelectionLayer({ viewport, selectedPaths, liveTransform }: SharedProps) {
  const pos = useHandlePositions(viewport, selectedPaths, liveTransform)
  if (!pos) return null
  const { corners: c, rotHandle, rotBase } = pos

  const outline = [c.tl.x, c.tl.y, c.tr.x, c.tr.y, c.br.x, c.br.y, c.bl.x, c.bl.y, c.tl.x, c.tl.y]

  return (
    <Layer listening={false}>
      <Line points={outline} stroke="#60a5fa" strokeWidth={1} dash={[4, 3]} />
      <Line points={[rotBase.x, rotBase.y, rotHandle.x, rotHandle.y]} stroke="#60a5fa" strokeWidth={1} />
    </Layer>
  )
}

// Interactive handle layer: resize circles + rotation circle
interface HandleLayerProps extends SharedProps {
  onResizeHandleDown: (handle: HandleType, e: Konva.KonvaEventObject<MouseEvent>) => void
  onRotateHandleDown: (e: Konva.KonvaEventObject<MouseEvent>) => void
}

export function SelectionHandleLayer({ viewport, selectedPaths, liveTransform, onResizeHandleDown, onRotateHandleDown }: HandleLayerProps) {
  const pos = useHandlePositions(viewport, selectedPaths, liveTransform)
  if (!pos) return null
  const { corners: c, rotHandle } = pos

  const handles: { id: HandleType; pos: { x: number; y: number } }[] = [
    { id: 'tl', pos: c.tl }, { id: 'tr', pos: c.tr },
    { id: 'bl', pos: c.bl }, { id: 'br', pos: c.br },
    { id: 't',  pos: c.t  }, { id: 'b',  pos: c.b  },
    { id: 'l',  pos: c.l  }, { id: 'r',  pos: c.r  },
  ]

  return (
    <Layer>
      {handles.map(({ id, pos: p }) => (
        <Circle
          key={id}
          x={p.x} y={p.y}
          radius={HANDLE_R}
          fill="#1e293b" stroke="#60a5fa" strokeWidth={1.5}
          onMouseDown={(e) => { e.cancelBubble = true; onResizeHandleDown(id, e) }}
        />
      ))}
      <Circle
        x={rotHandle.x} y={rotHandle.y}
        radius={HANDLE_R}
        fill="#1e293b" stroke="#a78bfa" strokeWidth={1.5}
        onMouseDown={(e) => { e.cancelBubble = true; onRotateHandleDown(e) }}
      />
    </Layer>
  )
}
