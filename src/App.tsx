import { useEffect, lazy, Suspense, useLayoutEffect } from 'react'
import { preloadFonts } from './shapes/textGenerator'
import Toolbar from './components/Toolbar'
import Sidebar from './components/Sidebar'
import StatusBar from './components/StatusBar'
import ToolLibraryPanel from './panels/ToolLibraryPanel'
import PostProcessorPanel from './panels/PostProcessorPanel'
import WorkpiecePanel from './panels/WorkpiecePanel'
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
const ThreeView = lazy(() => import('./three/ThreeView'))

const WORKSPACE_TABS: { id: WorkspaceTab; label: string }[] = [
  { id: '2d', label: '2D View' },
  { id: '3d', label: '3D View' },
  { id: 'setup', label: 'Setup' },
  { id: 'tools', label: 'Tool Library' },
  { id: 'postprocessor', label: 'Post-Processor' },
]

const PLACEHOLDER: Record<string, { icon: string; label: string }> = {}

function MainWorkspace() {
  const { workspaceTab, setWorkspaceTab } = useUIStore()

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tab bar */}
      <div className="flex border-b border-gray-300 dark:border-neutral-700 bg-gray-100 dark:bg-neutral-800 flex-shrink-0">
        {WORKSPACE_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setWorkspaceTab(tab.id)}
            className={[
              'px-4 py-1.5 text-body border-r border-gray-300 dark:border-neutral-700 transition-colors',
              workspaceTab === tab.id
                ? 'bg-gray-50 dark:bg-neutral-900 text-gray-900 dark:text-neutral-100 border-b-2 border-b-blue-500 -mb-px'
                : 'text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content area (flex-col: canvas takes remaining space, viewer is fixed-height below) */}
      <div className="flex-1 flex flex-col overflow-hidden bg-gray-50 dark:bg-neutral-900">
        {/* Canvas + overlays */}
        <div className="flex-1 relative overflow-hidden">
          {workspaceTab === '2d' && (
            <Suspense fallback={<div className="w-full h-full flex items-center justify-center text-gray-400 dark:text-neutral-500 text-sm">Loading canvas…</div>}>
              <CanvasStage />
            </Suspense>
          )}

          {workspaceTab === '3d' && (
            <Suspense fallback={<div className="w-full h-full flex items-center justify-center text-gray-400 dark:text-neutral-500 text-sm">Loading 3D view…</div>}>
              <ThreeView />
            </Suspense>
          )}
          {workspaceTab === 'setup' && <WorkpiecePanel />}
          {workspaceTab === 'tools' && <ToolLibraryPanel />}
          {workspaceTab === 'postprocessor' && <PostProcessorPanel />}

          {PLACEHOLDER[workspaceTab] && (
            <div
              className="absolute inset-0 flex items-center justify-center text-gray-400 dark:text-neutral-500 select-none"
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
      if (mod && e.key === 'z') {
        e.preventDefault()
        const { nodeEditUndo } = useUIStore.getState()
        if (nodeEditUndo) { nodeEditUndo(); return }
        undo()
        return
      }
      if (mod && (e.key === 'y' || e.key === 'Z')) {
        e.preventDefault()
        const { nodeEditRedo } = useUIStore.getState()
        if (nodeEditRedo) { nodeEditRedo(); return }
        redo()
        return
      }
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

function useDarkMode() {
  const darkMode = useUIStore((s) => s.darkMode)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
  }, [darkMode])
}

export default function App() {
  useKeyboardShortcuts()
  useSurfaceWorkpieceSync()
  useDarkMode()
  useLayoutEffect(() => { preloadFonts() }, [])
  return (
    <div className="h-screen w-screen flex flex-col bg-gray-50 dark:bg-neutral-900 text-gray-900 dark:text-neutral-100 overflow-hidden">
      <Toolbar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <MainWorkspace />
      </div>
      <StatusBar />
    </div>
  )
}
