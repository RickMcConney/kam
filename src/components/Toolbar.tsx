import { useRef, useState } from 'react'
import { ICON } from '../theme'
import {
  FilePlus, FolderOpen, Save, Import, FileCog,
  Undo2, Redo2, Magnet, HelpCircle, Play, Sun, Moon,
} from 'lucide-react'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { useTimelineStore } from '../timeline/timelineStore'
import { useToolpathStore } from '../store/toolpathStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useSimStore } from '../store/simStore'
import { generateGcode } from '../cam/gcode'
import { buildGcodeInputs } from '../io/gcodeExport'
import { triggerProjectSave, triggerGcodeExport, triggerGcodeExportSplit } from '../io/fileSystem'
import { buildExportPreflight, type ExportPreflight } from '../cam/exportPreflight'
import ExportPreflightDialog from './ExportPreflightDialog'
import DxfUnitsDialog from './DxfUnitsDialog'
import { importFile } from '../io/importFile'
import { openProjectFile, newProject } from '../io/projectLoad'
import HelpPanel from '../panels/HelpPanel'

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
          : 'text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 hover:bg-gray-300 dark:hover:bg-neutral-600',
      ].join(' ')}
    >
      {icon}
    </button>
  )
}

function Sep() {
  return <div className="w-px h-5 bg-gray-300 dark:bg-neutral-600 mx-1" />
}

function UnitToggle() {
  const { units, setUnits } = useWorkpieceStore()
  const isIn = units === 'in'
  return (
    <div
      title={`Units: ${units} — click to switch`}
      onClick={() => setUnits(isIn ? 'mm' : 'in')}
      className="relative flex items-center cursor-pointer select-none rounded-full h-7 w-14 bg-gray-300 dark:bg-neutral-700 flex-shrink-0"
    >
      <div
        className="absolute top-0.5 bottom-0.5 rounded-full bg-blue-600 transition-transform duration-150 ease-in-out"
        style={{
          left: 2,
          width: 'calc(50% - 2px)',
          transform: isIn ? 'translateX(100%)' : 'translateX(0)',
        }}
      />
      <span className={`relative z-10 flex-1 text-center text-xs font-semibold transition-colors ${!isIn ? 'text-white' : 'text-gray-500 dark:text-neutral-400'}`}>
        mm
      </span>
      <span className={`relative z-10 flex-1 text-center text-xs font-semibold transition-colors ${isIn ? 'text-white' : 'text-gray-500 dark:text-neutral-400'}`}>
        in
      </span>
    </div>
  )
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
        className="ml-3 text-sm bg-gray-300 dark:bg-neutral-700 text-gray-900 dark:text-neutral-100 rounded px-2 py-0.5 w-52 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
  const { snapEnabled, toggleSnap, setWorkspaceTab, darkMode, toggleDarkMode,
          nodeEditUndo, nodeEditRedo, nodeEditCanUndo, nodeEditCanRedo, setHelpOpen } = useUIStore()
  const { undo: mainUndo, redo: mainRedo, canUndo, canRedo } = useTimelineStore()
  // Local (node-edit/pen/drill) undo only while it has something to undo;
  // otherwise fall through to timeline undo (matches the Ctrl+Z routing in App).
  const useLocalUndo = nodeEditUndo !== null && nodeEditCanUndo
  const useLocalRedo = nodeEditRedo !== null && nodeEditCanRedo
  const undo = useLocalUndo ? nodeEditUndo : mainUndo
  const redo = useLocalRedo ? nodeEditRedo : mainRedo
  const undoDisabled = useLocalUndo ? false : !canUndo()
  const redoDisabled = useLocalRedo ? false : !canRedo()
  const { operations } = useToolpathStore()
  const { name } = useProjectStore()
  const importRef = useRef<HTMLInputElement>(null)
  const [preflight, setPreflight] = useState<ExportPreflight | null>(null)

  async function handleSimulate() {
    const { operations: ops, toolsById, profile } = await buildGcodeInputs()
    const gcode = generateGcode(ops, toolsById, name, profile)
    // Load only — the sim opens on the finished part (loadGcode parks the clock at the
    // end). Play is what rewinds and runs it.
    useSimStore.getState().loadGcode(gcode)
    const cur = useUIStore.getState().workspaceTab
    if (cur !== '2d' && cur !== '3d') setWorkspaceTab('2d')
  }

  function handleImportFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    importFile(file)
  }

  const hasToolpaths = operations.some((o) => o.status === 'done' && o.visible)

  return (
    <div className="h-10 bg-gray-200 dark:bg-neutral-800 border-b border-gray-300 dark:border-neutral-700 flex items-center px-2 gap-0.5 flex-shrink-0 select-none">


      {/* File */}
      <div style={{ display: 'flex', gap: '12px' }}>
        <ToolbarButton
          icon={<FilePlus size={ICON.md} />}
          label="New Project (Ctrl+N)"
          onClick={newProject}
        />
        <ToolbarButton
          icon={<FolderOpen size={ICON.md} />}
          label="Open Project (Ctrl+O)"
          onClick={() => openProjectFile().catch(() => { })}
        />
        <ToolbarButton
          icon={<Save size={ICON.md} />}
          label="Save Project As… (Ctrl+S)"
          onClick={() => void triggerProjectSave()}
        />
        

        {/* Import / Export */}
        <input
          ref={importRef}
          type="file"
          data-testid="import-file-input"
          aria-hidden="true"
          tabIndex={-1}
          accept=".svg,.dxf,.stl,.png,.jpg,.jpeg,.webp,.gcode,.nc,.ngc,.tap"
          className="hidden"
          onChange={handleImportFileChange}
        />
        <ToolbarButton
          icon={<Import size={ICON.md} />}
          label="Import File (SVG, DXF, STL, Image, or G-code)"
          onClick={() => importRef.current?.click()}
        />
        <ToolbarButton
          icon={<FileCog size={ICON.md} />}
          label={hasToolpaths ? 'Export G-code' : 'Export G-code (no toolpaths)'}
          onClick={() => setPreflight(buildExportPreflight())}
        />
        <Sep />


        {/* History */}
        <ToolbarButton icon={<Undo2 size={ICON.md} />} label="Undo (Ctrl+Z)" onClick={undo} disabled={undoDisabled} />
        <ToolbarButton icon={<Redo2 size={ICON.md} />} label="Redo (Ctrl+Y)" onClick={redo} disabled={redoDisabled} />
        <Sep />

        <ToolbarButton
          icon={<Play size={ICON.md} />}
          label={hasToolpaths ? 'Simulate G-code' : 'Simulate G-code (no toolpaths)'}
          onClick={handleSimulate}
        />
        <Sep />


        {/* Editable project name */}
        <ProjectNameEditor />
      </div>
      {/* Right side */}

      <div className="ml-auto flex items-center gap-0.5">
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <UnitToggle />
          <Sep />
          {/* Snap */}
          <ToolbarButton
            icon={<Magnet size={ICON.md} />}
            label={`Snap to Grid (S) — ${snapEnabled ? 'On' : 'Off'}`}
            onClick={toggleSnap}
            active={snapEnabled}
          />
          <ToolbarButton
            icon={darkMode ? <Sun size={ICON.md} /> : <Moon size={ICON.md} />}
            label={darkMode ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
            onClick={toggleDarkMode}
          />
          <ToolbarButton icon={<HelpCircle size={ICON.md} />} label="Help" onClick={() => setHelpOpen(true)} />
        </div>
      </div>

      <HelpPanel />

      {/* Pre-export review: summary + safety warnings, then run the export */}
      {preflight && (
        <ExportPreflightDialog
          report={preflight}
          onCancel={() => setPreflight(null)}
          onConfirm={(splitByTool, prefix) => { setPreflight(null); void (splitByTool ? triggerGcodeExportSplit(prefix) : triggerGcodeExport()) }}
        />
      )}

      {/* DXF units prompt modal (uiStore-driven; shared with canvas drop) */}
      <DxfUnitsDialog />
    </div>
  )
}
