import { useEffect, useRef, useState } from 'react'
import { DraftingCompass, Route } from 'lucide-react'
import { ICON } from '../theme'
import { useUIStore, type SidebarTab } from '../store/uiStore'
import { usePathsStore } from '../store/pathsStore'
import { useSimStore } from '../store/simStore'
import PathsPanel from '../panels/PathsPanel'
import MachinePanel from '../panels/MachinePanel'
import PropertiesPanel from '../panels/PropertiesPanel'
import ShapePanel from '../panels/draw/ShapePanel'
import GcodeViewer from '../panels/GcodeViewer'

const TABS: { id: SidebarTab; label: string; icon: React.ReactNode }[] = [
  { id: 'draw', label: 'Draw', icon: <DraftingCompass size={ICON.md} /> },
  { id: 'paths', label: 'Paths', icon: <Route size={ICON.md} /> },
]

function TabContent({ tab, machineFormActive, shapesPanelOpen }: { tab: SidebarTab; machineFormActive: boolean; shapesPanelOpen: boolean }) {
  if (tab === 'draw') return (
    <>
      {!machineFormActive && <ShapePanel fill={shapesPanelOpen} />}
      {!shapesPanelOpen && <MachinePanel fill={machineFormActive} />}
    </>
  )
  return <PathsPanel />
}

export default function Sidebar() {
  const { sidebarTab, setSidebarTab, setMachineFormActive, setShapesPanelOpen } = useUIStore()
  const selectedIds = usePathsStore((s) => s.selectedIds)
  const gcodeViewerOpen = useSimStore((s) => s.gcodeViewerOpen)
  const hasGcode = useSimStore((s) => !!s.gcode)
  const machineFormActive = useUIStore((s) => s.machineFormActive)
  const shapesPanelOpen = useUIStore((s) => s.shapesPanelOpen)

  const [width, setWidth] = useState(320)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const delta = e.clientX - startX.current
      setWidth(Math.max(180, Math.min(600, startWidth.current + delta)))
    }
    const onUp = () => {
      if (dragging.current) {
        dragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const onHandleMouseDown = (e: React.MouseEvent) => {
    dragging.current = true
    startX.current = e.clientX
    startWidth.current = width
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    e.preventDefault()
  }

  return (
    <div
      className="bg-gray-100 dark:bg-neutral-800 border-r border-gray-300 dark:border-neutral-700 flex flex-col flex-shrink-0 overflow-hidden relative"
      style={{ width }}
    >
      {hasGcode && gcodeViewerOpen ? (
        <GcodeViewer fill />
      ) : (
        <>
          {/* Tab bar */}
          <div className="flex border-b border-gray-300 dark:border-neutral-700 flex-shrink-0">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => { setSidebarTab(tab.id); if (tab.id === 'draw') { setMachineFormActive(false); setShapesPanelOpen(false) } }}
                title={tab.label}
                className={[
                  'flex-1 flex flex-col items-center gap-0.5 py-2 text-body transition-colors border-b-2',
                  sidebarTab === tab.id
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200',
                ].join(' ')}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </div>

          {/* Scrollable content — switches to flex-col fill when machine or shapes panel is open */}
          <div className={(machineFormActive || shapesPanelOpen) && sidebarTab === 'draw'
            ? 'flex-1 overflow-hidden flex flex-col'
            : 'flex-1 overflow-y-auto'
          }>
            <TabContent tab={sidebarTab} machineFormActive={machineFormActive} shapesPanelOpen={shapesPanelOpen} />
          </div>

          {/* Properties panel — hidden while machine form fills the sidebar */}
          {selectedIds.length > 0 && !machineFormActive && <PropertiesPanel />}
        </>
      )}

      {/* Resize handle */}
      <div
        onMouseDown={onHandleMouseDown}
        className="absolute right-0 inset-y-0 w-1 cursor-col-resize hover:bg-blue-500/40 transition-colors"
      />
    </div>
  )
}
