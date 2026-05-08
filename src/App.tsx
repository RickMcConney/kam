import { useEffect, lazy, Suspense } from 'react'
import Toolbar from './components/Toolbar'
import Sidebar from './components/Sidebar'
import StatusBar from './components/StatusBar'
import ToolLibraryPanel from './panels/ToolLibraryPanel'
import { useUIStore, type WorkspaceTab } from './store/uiStore'
import { usePathsStore } from './store/pathsStore'

const CanvasStage = lazy(() => import('./canvas/CanvasStage'))

const WORKSPACE_TABS: { id: WorkspaceTab; label: string }[] = [
  { id: '2d', label: '2D View' },
  { id: '3d', label: '3D View' },
  { id: 'tools', label: 'Tool Library' },
]

const PLACEHOLDER: Record<Exclude<WorkspaceTab, '2d' | 'tools'>, { icon: string; label: string }> = {
  '3d': { icon: '◈', label: '3D View — added in Phase 15' },
}

function MainWorkspace() {
  const { workspaceTab, setWorkspaceTab } = useUIStore()

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tab bar */}
      <div className="flex border-b border-neutral-700 flex-shrink-0" style={{ backgroundColor: '#1c1c1c' }}>
        {WORKSPACE_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setWorkspaceTab(tab.id)}
            className={[
              'px-4 py-1.5 text-xs border-r border-neutral-700 transition-colors',
              workspaceTab === tab.id
                ? 'bg-neutral-900 text-neutral-100 border-b-2 border-b-blue-500 -mb-px'
                : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content area */}
      <div className="flex-1 relative overflow-hidden" style={{ backgroundColor: '#111111' }}>
        {workspaceTab === '2d' && (
          <Suspense fallback={<div className="w-full h-full flex items-center justify-center text-neutral-600 text-sm">Loading canvas…</div>}>
            <CanvasStage />
          </Suspense>
        )}

        {workspaceTab === 'tools' && <ToolLibraryPanel />}

        {workspaceTab !== '2d' && workspaceTab !== 'tools' && (() => {
          const p = PLACEHOLDER[workspaceTab as Exclude<WorkspaceTab, '2d' | 'tools'>]
          return (
            <div
              className="absolute inset-0 flex items-center justify-center text-neutral-700 select-none"
              style={{
                backgroundImage: [
                  'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px)',
                  'linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
                ].join(','),
                backgroundSize: '20px 20px',
              }}
            >
              <div className="text-center">
                <div className="text-5xl mb-3">{p.icon}</div>
                <div className="text-sm">{p.label}</div>
              </div>
            </div>
          )
        })()}
      </div>
    </div>
  )
}

function useKeyboardShortcuts() {
  const { toggleSnap } = useUIStore()
  const { deleteSelected, undo, redo, duplicateSelected } = usePathsStore()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const inInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      if (inInput) return

      if (e.key === 's' || e.key === 'S') { toggleSnap(); return }
      if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); return }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); return }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Z')) { e.preventDefault(); redo(); return }
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') { e.preventDefault(); duplicateSelected(); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSnap, deleteSelected, undo, redo, duplicateSelected])
}

export default function App() {
  useKeyboardShortcuts()
  return (
    <div className="h-screen w-screen flex flex-col bg-neutral-900 text-neutral-100 overflow-hidden">
      <Toolbar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <MainWorkspace />
      </div>
      <StatusBar />
    </div>
  )
}
