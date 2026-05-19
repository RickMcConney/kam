import { useUIStore } from '../store/uiStore'
import { useCanvasStore } from '../store/canvasStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'
import { BUILD_DATE } from '../version'
import { shapeDisplayName, type ShapeType } from '../shapes/shapeGenerators'

function modeLabel(activeTool: string, nodeEditPathId: string | null): string {
  if (nodeEditPathId) return 'Edit Points'
  if (activeTool === 'select') return 'Select'
  if (activeTool === 'pen') return 'Pen'
  if (activeTool === 'drill') return 'Drill'
  return shapeDisplayName(activeTool as ShapeType)
}

export default function StatusBar() {
  const snapEnabled = useUIStore((s) => s.snapEnabled)
  const workspaceTab = useUIStore((s) => s.workspaceTab)
  const activeTool = useUIStore((s) => s.activeTool)
  const nodeEditPathId = useUIStore((s) => s.nodeEditPathId)
  const cursorMM = useCanvasStore((s) => s.cursorMM)
  const zoomPct = useCanvasStore((s) => s.zoomPct)
  const { units, origin, widthMM, heightMM } = useWorkpieceStore()

  const orgWorld = originWorldXY(origin, widthMM, heightMM)

  const formatCoord = (mm: number) =>
    units === 'in'
      ? (mm / 25.4).toFixed(3) + '"'
      : mm.toFixed(1) + 'mm'

  const cnc = cursorMM
    ? { x: cursorMM.x - orgWorld.x, y: cursorMM.y - orgWorld.y }
    : null

  const mode = modeLabel(activeTool, nodeEditPathId)

  return (
    <div className="h-6 bg-gray-50 dark:bg-neutral-900 border-t border-gray-300 dark:border-neutral-700 flex items-center px-3 text-body text-gray-500 dark:text-neutral-400 select-none flex-shrink-0 gap-4">
      <span>Mode: {mode}</span>

      {snapEnabled && <span className="text-blue-400 font-medium">SNAP</span>}

      {workspaceTab === '2d' && cnc && (
        <span className="font-mono">
          X: {formatCoord(cnc.x)}&nbsp;&nbsp;Y: {formatCoord(cnc.y)}
        </span>
      )}

      <span className="ml-auto flex items-center gap-4">
        {workspaceTab === '2d' && (
          <span className="font-mono">{Math.round(zoomPct * 100)}%</span>
        )}
        <span>FreazyKam {BUILD_DATE}</span>
      </span>
    </div>
  )
}
