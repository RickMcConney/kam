import { useRef, useState } from 'react'
import { ICON } from '../theme'
import {
  FilePlus, FolderOpen, Save, Upload, Download,
  Undo2, Redo2, Magnet, Settings, HelpCircle, Play, Sun, Moon,
} from 'lucide-react'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolpathStore } from '../store/toolpathStore'
import { useToolStore } from '../store/toolStore'
import { usePostProcessorStore } from '../store/postProcessorStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useSimStore } from '../store/simStore'
import { generateGcode, downloadGcode } from '../cam/gcode'
import { importSvg } from '../importers/svgImporter'
import { saveProject } from '../io/projectSave'
import { openProjectFile, newProject } from '../io/projectLoad'

function ToolbarButton({
  icon,
  label,
  onClick,
  active,
  disabled,
}: {
  icon: React.ReactNode
  label: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
}) {
  return (
    <button
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={[
        'flex items-center justify-center w-8 h-8 rounded transition-colors',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        active
          ? 'bg-blue-600 text-white hover:bg-blue-500'
          : 'text-gray-700 dark:text-neutral-300 hover:text-gray-900 dark:hover:text-neutral-100 hover:bg-gray-300 dark:hover:bg-neutral-600',
      ].join(' ')}
    >
      {icon}
    </button>
  )
}

function Sep() {
  return <div className="w-px h-5 bg-gray-300 dark:bg-neutral-600 mx-1" />
}

function ProjectNameEditor() {
  const { name, setName } = useProjectStore()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)

  function startEdit() {
    setDraft(name)
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  function commit() {
    const trimmed = draft.trim()
    setName(trimmed || 'Untitled Project')
    setEditing(false)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') commit()
    if (e.key === 'Escape') setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className="ml-3 text-sm bg-gray-200 dark:bg-neutral-700 text-gray-900 dark:text-neutral-100 rounded px-2 py-0.5 w-52 focus:outline-none focus:ring-1 focus:ring-blue-500"
        autoFocus
      />
    )
  }

  return (
    <button
      onClick={startEdit}
      title="Click to rename project"
      className="ml-3 text-gray-700 dark:text-neutral-300 text-sm truncate max-w-52 hover:text-gray-900 dark:hover:text-neutral-100 hover:underline text-left"
    >
      {name}
    </button>
  )
}

export default function Toolbar() {
  const { snapEnabled, toggleSnap, setWorkspaceTab, setSidebarTab, darkMode, toggleDarkMode } = useUIStore()
  const { undo, redo, canUndo, canRedo } = usePathsStore()
  const { operations } = useToolpathStore()
  const { tools } = useToolStore()
  const { name } = useProjectStore()
  const getActiveProfile = usePostProcessorStore((s) => s.getActiveProfile)
  const importRef = useRef<HTMLInputElement>(null)

  function handleExportGcode() {
    const toolsById = Object.fromEntries(tools.map((t) => [t.id, t]))
    const profile = getActiveProfile()
    const gcode = generateGcode(operations, toolsById, name, profile)
    downloadGcode(gcode, name)
  }

  function handleSimulate() {
    const toolsById = Object.fromEntries(tools.map((t) => [t.id, t]))
    const profile = getActiveProfile()
    const gcode = generateGcode(operations, toolsById, name, profile)
    useSimStore.getState().loadGcode(gcode)
    setWorkspaceTab('2d')
  }

  function handleImportFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    if (/\.(gcode|nc|ngc|tap)$/i.test(file.name)) {
      file.text().then((text) => {
        useSimStore.getState().loadGcode(text)
        setWorkspaceTab('2d')
      })
      return
    }

    if (file.name.toLowerCase().endsWith('.svg') || file.type === 'image/svg+xml') {
      const reader = new FileReader()
      reader.onload = (ev) => {
        try {
          const { widthMM, heightMM } = useWorkpieceStore.getState()
          const result = importSvg(ev.target?.result as string, { workpieceMM: { w: widthMM, h: heightMM } })
          if (result.paths.length > 0) {
            usePathsStore.getState().addPaths(result.paths)
            setSidebarTab('paths')
          }
        } catch { /* ignore */ }
      }
      reader.readAsText(file)
    }
  }

  const hasToolpaths = operations.some((o) => o.status === 'done' && o.visible)

  return (
    <div className="h-10 bg-gray-100 dark:bg-neutral-800 border-b border-gray-300 dark:border-neutral-700 flex items-center px-2 gap-0.5 flex-shrink-0 select-none">
      {/* Brand */}
      <span className="text-blue-400 font-bold text-sm px-2 mr-1 tracking-tight">
        FK
      </span>
      <Sep />

      {/* File */}
      <ToolbarButton
        icon={<FilePlus size={ICON.md} />}
        label="New Project (Ctrl+N)"
        onClick={newProject}
      />
      <ToolbarButton
        icon={<FolderOpen size={ICON.md} />}
        label="Open Project (Ctrl+O)"
        onClick={() => openProjectFile().catch(() => {})}
      />
      <ToolbarButton
        icon={<Save size={ICON.md} />}
        label="Save Project (Ctrl+S)"
        onClick={saveProject}
      />
      <Sep />

      {/* Import / Export */}
      <input
        ref={importRef}
        type="file"
        accept=".svg,.gcode,.nc,.ngc,.tap"
        className="hidden"
        onChange={handleImportFileChange}
      />
      <ToolbarButton
        icon={<Upload size={ICON.md} />}
        label="Import File (SVG or G-code)"
        onClick={() => importRef.current?.click()}
      />
      <ToolbarButton
        icon={<Download size={ICON.md} />}
        label={hasToolpaths ? 'Export G-code' : 'Export G-code (no toolpaths)'}
        onClick={handleExportGcode}
      />
      <ToolbarButton
        icon={<Play size={ICON.md} />}
        label={hasToolpaths ? 'Simulate G-code' : 'Simulate G-code (no toolpaths)'}
        onClick={handleSimulate}
      />
      <Sep />

      {/* History */}
      <ToolbarButton icon={<Undo2 size={ICON.md} />} label="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo()} />
      <ToolbarButton icon={<Redo2 size={ICON.md} />} label="Redo (Ctrl+Y)" onClick={redo} disabled={!canRedo()} />
      <Sep />

      {/* Snap */}
      <ToolbarButton
        icon={<Magnet size={ICON.md} />}
        label={`Snap to Grid (S) — ${snapEnabled ? 'On' : 'Off'}`}
        onClick={toggleSnap}
        active={snapEnabled}
      />

      {/* Editable project name */}
      <ProjectNameEditor />

      {/* Right side */}
      <div className="ml-auto flex items-center gap-0.5">
        <ToolbarButton
          icon={darkMode ? <Sun size={ICON.md} /> : <Moon size={ICON.md} />}
          label={darkMode ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
          onClick={toggleDarkMode}
        />
        <ToolbarButton icon={<Settings size={ICON.md} />} label="Options" />
        <ToolbarButton icon={<HelpCircle size={ICON.md} />} label="Help" />
      </div>
    </div>
  )
}
