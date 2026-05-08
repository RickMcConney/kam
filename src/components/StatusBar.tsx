import { useUIStore } from '../store/uiStore'
import { useCanvasStore } from '../store/canvasStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'

const VERSION = '0.1.0'

export default function StatusBar() {
  const snapEnabled = useUIStore((s) => s.snapEnabled)
  const workspaceTab = useUIStore((s) => s.workspaceTab)
  const cursorMM = useCanvasStore((s) => s.cursorMM)
  const zoomPct = useCanvasStore((s) => s.zoomPct)
  const { units, origin, widthMM, heightMM } = useWorkpieceStore()

  // Origin offset in world coords — cursor is reported from workpiece bottom-left;
  // subtract to get CNC-origin-relative coordinates.
  const orgWorld = originWorldXY(origin, widthMM, heightMM)

  const formatCoord = (mm: number) =>
    units === 'in'
      ? (mm / 25.4).toFixed(3) + '"'
      : mm.toFixed(1) + 'mm'

  const cnc = cursorMM
    ? { x: cursorMM.x - orgWorld.x, y: cursorMM.y - orgWorld.y }
    : null

  return (
    <div className="h-6 bg-gray-50 dark:bg-neutral-900 border-t border-gray-300 dark:border-neutral-700 flex items-center px-3 text-body text-gray-500 dark:text-neutral-400 select-none flex-shrink-0 gap-4">
      <span>Mode: Select</span>

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
        <span>FreazyKam v{VERSION}</span>
      </span>
    </div>
  )
}
