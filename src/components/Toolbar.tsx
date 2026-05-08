import {
  FilePlus, FolderOpen, Save, Upload, Download,
  Undo2, Redo2, Magnet, Settings, HelpCircle,
} from 'lucide-react'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolpathStore } from '../store/toolpathStore'
import { useToolStore } from '../store/toolStore'
import { generateGcode, downloadGcode } from '../cam/gcode'

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
          : 'text-neutral-300 hover:text-neutral-100 hover:bg-neutral-600',
      ].join(' ')}
    >
      {icon}
    </button>
  )
}

function Sep() {
  return <div className="w-px h-5 bg-neutral-600 mx-1" />
}

export default function Toolbar() {
  const { name } = useProjectStore()
  const { snapEnabled, toggleSnap } = useUIStore()
  const { undo, redo, canUndo, canRedo } = usePathsStore()
  const { operations } = useToolpathStore()
  const { tools } = useToolStore()

  function handleExportGcode() {
    const toolsById = Object.fromEntries(tools.map((t) => [t.id, t]))
    const gcode = generateGcode(operations, toolsById, name)
    downloadGcode(gcode, name)
  }

  const hasToolpaths = operations.some((o) => o.status === 'done' && o.visible)

  return (
    <div className="h-10 bg-neutral-800 border-b border-neutral-700 flex items-center px-2 gap-0.5 flex-shrink-0 select-none">
      {/* Brand */}
      <span className="text-blue-400 font-bold text-sm px-2 mr-1 tracking-tight">
        FK
      </span>
      <Sep />

      {/* File */}
      <ToolbarButton icon={<FilePlus size={16} />} label="New Project" />
      <ToolbarButton icon={<FolderOpen size={16} />} label="Open Project (Ctrl+O)" />
      <ToolbarButton icon={<Save size={16} />} label="Save Project (Ctrl+S)" />
      <Sep />

      {/* Import / Export */}
      <ToolbarButton icon={<Upload size={16} />} label="Import File" />
      <ToolbarButton
        icon={<Download size={16} />}
        label={hasToolpaths ? 'Export G-code' : 'Export G-code (no toolpaths)'}
        onClick={handleExportGcode}
      />
      <Sep />

      {/* History */}
      <ToolbarButton icon={<Undo2 size={16} />} label="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo()} />
      <ToolbarButton icon={<Redo2 size={16} />} label="Redo (Ctrl+Y)" onClick={redo} disabled={!canRedo()} />
      <Sep />

      {/* Snap */}
      <ToolbarButton
        icon={<Magnet size={16} />}
        label={`Snap to Grid (S) — ${snapEnabled ? 'On' : 'Off'}`}
        onClick={toggleSnap}
        active={snapEnabled}
      />

      {/* Project name */}
      <span className="ml-3 text-neutral-300 text-sm truncate max-w-52 select-text">
        {name}
      </span>

      {/* Right side */}
      <div className="ml-auto flex items-center gap-0.5">
        <ToolbarButton icon={<Settings size={16} />} label="Options" />
        <ToolbarButton icon={<HelpCircle size={16} />} label="Help" />
      </div>
    </div>
  )
}
