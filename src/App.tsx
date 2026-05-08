import { useEffect, lazy, Suspense } from 'react'
import Toolbar from './components/Toolbar'
import Sidebar from './components/Sidebar'
import StatusBar from './components/StatusBar'
import ToolLibraryPanel from './panels/ToolLibraryPanel'
import PostProcessorPanel from './panels/PostProcessorPanel'
import GcodeViewer from './panels/GcodeViewer'
import { useUIStore, type WorkspaceTab } from './store/uiStore'
import { usePathsStore } from './store/pathsStore'
import { saveProject } from './io/projectSave'
import { openProjectFile, newProject } from './io/projectLoad'
import { useProjectStore } from './store/projectStore'
import { useWorkpieceStore } from './store/workpieceStore'
import { useToolpathStore } from './store/toolpathStore'
import { regenerateOperation } from './cam/regenerate'
import { useSimStore } from './store/simStore'

const CanvasStage = lazy(() => import('./canvas/CanvasStage'))

const WORKSPACE_TABS: { id: WorkspaceTab; label: string }[] = [
  { id: '2d', label: '2D View' },
  { id: '3d', label: '3D View' },
  { id: 'tools', label: 'Tool Library' },
  { id: 'postprocessor', label: 'Post-Processor' },
]

const PLACEHOLDER: Record<string, { icon: string; label: string }> = {
  '3d': { icon: '◈', label: '3D View — added in Phase 15' },
}

function MainWorkspace() {
  const { workspaceTab, setWorkspaceTab } = useUIStore()
  const gcodeViewerOpen = useSimStore((s) => s.gcodeViewerOpen)
  const hasGcode = useSimStore((s) => !!s.gcode)

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

      {/* Content area (flex-col: canvas takes remaining space, viewer is fixed-height below) */}
      <div className="flex-1 flex flex-col overflow-hidden" style={{ backgroundColor: '#111111' }}>
        {/* Canvas + overlays */}
        <div className="flex-1 relative overflow-hidden">
          {workspaceTab === '2d' && (
            <Suspense fallback={<div className="w-full h-full flex items-center justify-center text-neutral-600 text-sm">Loading canvas…</div>}>
              <CanvasStage />
            </Suspense>
          )}

          {workspaceTab === 'tools' && <ToolLibraryPanel />}
          {workspaceTab === 'postprocessor' && <PostProcessorPanel />}

          {PLACEHOLDER[workspaceTab] && (
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
                <div className="text-5xl mb-3">{PLACEHOLDER[workspaceTab].icon}</div>
                <div className="text-sm">{PLACEHOLDER[workspaceTab].label}</div>
              </div>
            </div>
          )}
        </div>

        {/* G-code viewer panel — visible below the canvas when open */}
        {workspaceTab === '2d' && hasGcode && gcodeViewerOpen && <GcodeViewer />}
      </div>
    </div>
  )
}

function useKeyboardShortcuts() {
  const { toggleSnap } = useUIStore()
  const { deleteSelected, undo, redo, duplicateSelected } = usePathsStore()
  const { isDirty } = useProjectStore()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const inInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      if (inInput && !e.ctrlKey && !e.metaKey) return

      const mod = e.ctrlKey || e.metaKey

      if (mod && e.key === 's') { e.preventDefault(); saveProject(); return }
      if (mod && e.key === 'o') { e.preventDefault(); openProjectFile(); return }
      if (mod && e.key === 'n') { e.preventDefault(); newProject(); return }

      if (inInput) return

      if (e.code === 'Space') {
        const sim = useSimStore.getState()
        if (sim.gcode) { e.preventDefault(); sim.playing ? sim.pause() : sim.play(); return }
      }
      if (e.key === 's' || e.key === 'S') { toggleSnap(); return }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!useUIStore.getState().nodeEditPathId) deleteSelected()
        return
      }
      if (mod && e.key === 'z') { e.preventDefault(); undo(); return }
      if (mod && (e.key === 'y' || e.key === 'Z')) { e.preventDefault(); redo(); return }
      if (mod && e.key === 'd') { e.preventDefault(); duplicateSelected(); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSnap, deleteSelected, undo, redo, duplicateSelected, isDirty])
}

function useSurfaceWorkpieceSync() {
  useEffect(() => {
    return useWorkpieceStore.subscribe((state, prev) => {
      if (
        state.widthMM === prev.widthMM &&
        state.heightMM === prev.heightMM &&
        state.origin === prev.origin
      ) return
      for (const op of useToolpathStore.getState().operations) {
        if (op.type === 'surface') regenerateOperation(op.id)
      }
    })
  }, [])
}

export default function App() {
  useKeyboardShortcuts()
  useSurfaceWorkpieceSync()
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
