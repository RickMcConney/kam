import { useEffect, useRef, useState } from 'react'
import { DraftingCompass, Route, SlidersHorizontal, X } from 'lucide-react'
import { ICON } from '../theme'
import { useUIStore, type SidebarTab } from '../store/uiStore'
import { usePathsStore } from '../store/pathsStore'
import { useSimStore } from '../store/simStore'
import PathsPanel from '../panels/PathsPanel'
import MachinePanel from '../panels/MachinePanel'
import PropertiesPanel from '../panels/PropertiesPanel'
import ShapePanel from '../panels/draw/ShapePanel'
import ClockPanel from '../panels/draw/ClockPanel'
import WorkpiecePanel from '../panels/WorkpiecePanel'
import GcodeViewer from '../panels/GcodeViewer'

const TABS: { id: SidebarTab; label: string; icon: React.ReactNode }[] = [
  { id: 'draw', label: 'Draw', icon: <DraftingCompass size={ICON.md} /> },
  { id: 'paths', label: 'Paths', icon: <Route size={ICON.md} /> },
]

function TabContent({ tab, machineFormActive, shapesPanelOpen, clockPanelOpen }: {
  tab: SidebarTab; machineFormActive: boolean; shapesPanelOpen: boolean; clockPanelOpen: boolean
}) {
  // The clock designer fills the sidebar like the shapes picker does — it has a
  // train's worth of readouts and nothing else in the draw tab applies while it
  // is open.
  if (tab === 'draw' && clockPanelOpen) return <ClockPanel />
  if (tab === 'draw') return (
    <>
      {!machineFormActive && <ShapePanel fill={shapesPanelOpen} />}
      {!shapesPanelOpen && <MachinePanel fill={machineFormActive} />}
    </>
  )
  return <PathsPanel />
}

export default function Sidebar() {
  const { sidebarTab, setSidebarTab, setMachineFormActive, setShapesPanelOpen, setClockPanelOpen, setSetupPanelOpen, setWorkspaceTab } = useUIStore()
  const selectedIds = usePathsStore((s) => s.selectedIds)
  const gcodeViewerOpen = useSimStore((s) => s.gcodeViewerOpen)
  const hasGcode = useSimStore((s) => !!s.gcode)
  const machineFormActive = useUIStore((s) => s.machineFormActive)
  const shapesPanelOpen = useUIStore((s) => s.shapesPanelOpen)
  const clockPanelOpen = useUIStore((s) => s.clockPanelOpen)
  const setupPanelOpen = useUIStore((s) => s.setupPanelOpen)

  const showProps = selectedIds.length > 0 && !machineFormActive && !clockPanelOpen

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
      className="bg-gray-200 dark:bg-neutral-800 border-r border-gray-300 dark:border-neutral-700 flex flex-row flex-shrink-0 overflow-hidden"
      style={{ width }}
    >
      {/* Content column — its scrollbar lands at this column's right edge, to the
          left of the resize handle, so the two no longer overlap. */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
      {hasGcode && gcodeViewerOpen ? (
        <GcodeViewer fill />
      ) : setupPanelOpen ? (
        /* Setup fills the sidebar so stock / origin / material edits are visible
           live in the 2D or 3D view while the panel stays open. */
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-300 dark:border-neutral-700 flex-shrink-0">
            <span className="text-sm font-semibold text-gray-700 dark:text-neutral-300">Setup</span>
            <button
              onClick={() => setSetupPanelOpen(false)}
              title="Close setup"
              className="text-gray-400 dark:text-neutral-500 hover:text-gray-700 dark:hover:text-neutral-300 transition-colors"
            >
              <X size={ICON.sm} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            <WorkpiecePanel />
          </div>
        </div>
      ) : (
        <>
          {/* Tab bar */}
          <div className="flex border-b border-gray-300 dark:border-neutral-700 flex-shrink-0">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => { setSidebarTab(tab.id); if (tab.id === 'draw') { setMachineFormActive(false); setShapesPanelOpen(false); setClockPanelOpen(false) } }}
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
            {/* Setup opens a fill panel rather than a content tab (no active state).
                Switch to the 2D view if the current workspace tab can't show the
                stock (Tools / Post-Processor) so edits are always visible live;
                stay on 3D if already there. */}
            <button
              onClick={() => {
                const tab = useUIStore.getState().workspaceTab
                if (tab !== '2d' && tab !== '3d') setWorkspaceTab('2d')
                setSetupPanelOpen(true)
              }}
              title="Setup — stock size, origin, material, machine limits"
              className="flex-1 flex flex-col items-center gap-0.5 py-2 text-body transition-colors border-b-2 border-transparent text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200"
            >
              <SlidersHorizontal size={ICON.md} />
              <span>Setup</span>
            </button>
          </div>

          {/* Scrollable content — switches to flex-col fill when machine or
              shapes panel is open.

              WHEN THE PROPERTIES PANEL IS SHOWING IT STOPS GROWING (`flex-initial`
              rather than `flex-1`), and that is what anchors that panel's top
              edge. As `flex-1` this took all the free space and the properties
              panel hung off the bottom, so the panel grew UPWARD — every warning
              line it gained slid its own fields up, out from under a pointer
              mid-click on a spinner. Here it takes its natural height, still
              scrolling if it wants more, and the properties panel takes the
              remainder and grows down into it. */}
          <div className={(machineFormActive || shapesPanelOpen || clockPanelOpen) && sidebarTab === 'draw'
            ? 'flex-1 min-h-0 overflow-hidden flex flex-col'
            : showProps
              ? 'flex-initial min-h-0 overflow-y-auto'
              : 'flex-1 overflow-y-auto'
          }>
            <TabContent tab={sidebarTab} machineFormActive={machineFormActive} shapesPanelOpen={shapesPanelOpen} clockPanelOpen={clockPanelOpen} />
          </div>

          {/* Properties panel — hidden while the machine form or the clock
              designer fills the sidebar */}
          {showProps && <PropertiesPanel />}
        </>
      )}
      </div>

      {/* Resize handle — its own column beside the content so it sits clear of the
          scrollbar; widened a little to make it easy to grab. */}
      <div
        onMouseDown={onHandleMouseDown}
        title="Drag to resize sidebar"
        className="w-1.5 flex-shrink-0 cursor-col-resize bg-transparent hover:bg-blue-500/40 transition-colors"
      />
    </div>
  )
}
