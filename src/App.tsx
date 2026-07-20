import { useEffect, lazy, Suspense } from 'react'
import { preloadFonts } from './shapes/textGenerator'
import Toolbar from './components/Toolbar'
import Sidebar from './components/Sidebar'
import StatusBar from './components/StatusBar'
import ToolLibraryPanel from './panels/ToolLibraryPanel'
import PostProcessorPanel from './panels/PostProcessorPanel'
import { useUIStore, type WorkspaceTab } from './store/uiStore'
import { usePathsStore } from './store/pathsStore'
import { openProjectFile, newProject } from './io/projectLoad'
import { triggerProjectSave } from './io/fileSystem'
import SaveDialog from './components/SaveDialog'
import { useWorkpieceStore } from './store/workpieceStore'
import { useToolpathStore } from './store/toolpathStore'
import { useTimelineStore } from './timeline/timelineStore'
import { regenerateOperation } from './cam/regenerate'
import { useSimStore } from './store/simStore'

const CanvasStage = lazy(() => import('./canvas/CanvasStage'))
const ThreeView = lazy(() => import('./three/ThreeView'))
const TimelinePanel = lazy(() => import('./panels/TimelinePanel'))

const WORKSPACE_TABS: { id: WorkspaceTab; label: string }[] = [
  { id: '2d', label: '2D View' },
  { id: '3d', label: '3D View' },
  { id: 'tools', label: 'Tool Library' },
  { id: 'postprocessor', label: 'Post-Processor' },
]

function MainWorkspace() {
  // Individual selectors — whole-store destructuring re-rendered the entire
  // workspace on every uiStore change (bugs.md H5).
  const workspaceTab = useUIStore((s) => s.workspaceTab)
  const setWorkspaceTab = useUIStore((s) => s.setWorkspaceTab)

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
          {workspaceTab === 'tools' && <ToolLibraryPanel />}
          {workspaceTab === 'postprocessor' && <PostProcessorPanel />}
        </div>

        {workspaceTab === '2d' && (
          <Suspense fallback={null}>
            <TimelinePanel />
          </Suspense>
        )}
      </div>
    </div>
  )
}

function useKeyboardShortcuts() {
  // No store subscriptions: the handler reads getState() at keypress time, so
  // App no longer re-renders its whole subtree on every path edit / selection
  // change / history push (bugs.md H5).
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

      if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); void triggerProjectSave(e.shiftKey); return }
      if (mod && e.key === 'o') { e.preventDefault(); openProjectFile(); return }
      if (mod && e.key === 'n') { e.preventDefault(); newProject(); return }

      if (inInput) return

      if (e.code === 'Space') {
        const sim = useSimStore.getState()
        if (sim.gcode) { e.preventDefault(); sim.playing ? sim.pause() : sim.play(); return }
      }
      if (e.key === 's' || e.key === 'S') { useUIStore.getState().toggleSnap(); return }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!useUIStore.getState().nodeEditPathId) usePathsStore.getState().deleteSelected()
        return
      }
      if (mod && e.key === 'z') {
        e.preventDefault()
        // Local (node-edit/pen/drill) undo only while it has something to undo;
        // otherwise fall through to timeline undo — e.g. a cross-path join clears
        // the local stack and is undone via the timeline event it wrote.
        const { nodeEditUndo, nodeEditCanUndo } = useUIStore.getState()
        if (nodeEditUndo && nodeEditCanUndo) { nodeEditUndo(); return }
        useTimelineStore.getState().undo()
        return
      }
      if (mod && (e.key === 'y' || e.key === 'Z')) {
        e.preventDefault()
        const { nodeEditRedo, nodeEditCanRedo } = useUIStore.getState()
        if (nodeEditRedo && nodeEditCanRedo) { nodeEditRedo(); return }
        useTimelineStore.getState().redo()
        return
      }
      if (mod && e.key === 'd') { e.preventDefault(); usePathsStore.getState().duplicateSelected(); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
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
  const activeTool = useUIStore(s => s.activeTool)
  useEffect(() => {
    if (activeTool === 'text') preloadFonts()
  }, [activeTool])
  return (
    <div className="h-screen w-screen flex flex-col bg-gray-50 dark:bg-neutral-900 text-gray-900 dark:text-neutral-100 overflow-hidden">
      <Toolbar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <MainWorkspace />
      </div>
      <StatusBar />
      <SaveDialog />
    </div>
  )
}
