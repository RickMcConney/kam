import { useRef, useState } from 'react'
import { ICON } from '../theme'
import {
  FilePlus, FolderOpen, Save, Import, FileCog,
  Undo2, Redo2, Magnet, HelpCircle, Play, Sun, Moon,
} from 'lucide-react'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolpathStore } from '../store/toolpathStore'
import { useToolStore } from '../store/toolStore'
import { usePostProcessorStore } from '../store/postProcessorStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useSimStore } from '../store/simStore'
import { GCODE_IMPORT_TOOL_ID, type MotionSegment } from '../store/toolpathStore'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'
import type { DxfUnitsChoice } from '../importers/dxfImporter'
import { generateGcode } from '../cam/gcode'
import { optimizeStartPoints } from '../cam/startOptimizer'
import { triggerProjectSave, triggerGcodeExport, triggerGcodeExportSplit } from '../io/fileSystem'
import { buildExportPreflight, type ExportPreflight } from '../cam/exportPreflight'
import ExportPreflightDialog from './ExportPreflightDialog'
import { importSvg } from '../importers/svgImporter'
import { importDxf } from '../importers/dxfImporter'
import { importStl } from '../importers/stlImporter'
import { getMultiBBox, translateD } from '../canvas/selectionUtils'
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
      className="relative flex items-center cursor-pointer select-none rounded-full h-7 w-14 bg-gray-200 dark:bg-neutral-700 flex-shrink-0"
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
  const { snapEnabled, toggleSnap, setWorkspaceTab, setSidebarTab, darkMode, toggleDarkMode,
          nodeEditUndo, nodeEditRedo, nodeEditCanUndo, nodeEditCanRedo, setHelpOpen } = useUIStore()
  const { undo: mainUndo, redo: mainRedo, canUndo, canRedo } = usePathsStore()
  const undo = nodeEditUndo ?? mainUndo
  const redo = nodeEditRedo ?? mainRedo
  const undoDisabled = nodeEditUndo ? !nodeEditCanUndo : !canUndo()
  const redoDisabled = nodeEditRedo ? !nodeEditCanRedo : !canRedo()
  const { operations } = useToolpathStore()
  const { tools } = useToolStore()
  const { name } = useProjectStore()
  const getActiveProfile = usePostProcessorStore((s) => s.getActiveProfile)
  const importRef = useRef<HTMLInputElement>(null)
  const [pendingDxf, setPendingDxf] = useState<{ text: string; name: string } | null>(null)
  const [preflight, setPreflight] = useState<ExportPreflight | null>(null)
  const fmt = (n: number) => +n.toFixed(4)

  async function handleSimulate() {
    await optimizeStartPoints()
    const toolsById = Object.fromEntries(tools.map((t) => [t.id, t]))
    const profile = getActiveProfile()
    const { operations: ops } = useToolpathStore.getState()
    const gcode = generateGcode(ops, toolsById, name, profile)
    useSimStore.getState().loadGcode(gcode)
    useSimStore.getState().play()
    const cur = useUIStore.getState().workspaceTab
    if (cur !== '2d' && cur !== '3d') setWorkspaceTab('2d')
  }

  function completeDxfImport(text: string, fileName: string, units?: DxfUnitsChoice) {
    setPendingDxf(null)
    const { widthMM, heightMM } = useWorkpieceStore.getState()
    const result = importDxf(text, fileName, units, { x: widthMM / 2, y: heightMM / 2 })
    if (result.paths.length > 0) {
      const store = usePathsStore.getState()
      store.addPaths(result.paths)
      store.toggleGroupCollapsed(result.groupId)
      setSidebarTab('draw')
    } else if (!result.needsUnitsPrompt) {
      console.warn('DXF import: no supported geometry found')
    }
  }

  function handleImportFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    if (/\.(gcode|nc|ngc|tap)$/i.test(file.name)) {
      file.text().then((text) => {
        // Load into sim store for simulation playback
        useSimStore.getState().loadGcode(text)

        // Convert parsed SimSegments (machine coords) → MotionSegments (workpiece coords)
        const { widthMM, heightMM, origin } = useWorkpieceStore.getState()
        const org = originWorldXY(origin, widthMM, heightMM)
        const simSegs = useSimStore.getState().segments
        const motionSegs: MotionSegment[] = simSegs.map((s) => ({
          x: s.x + org.x,
          y: s.y + org.y,
          z: s.z,
          rapid: s.rapid,
        }))

        // Replace any existing imported G-code operations, then add the new one
        const tpStore = useToolpathStore.getState()
        tpStore.replaceOperations(
          tpStore.operations.filter((o) => o.type !== 'gcode')
        )
        const filename = file.name
        const opName = filename.replace(/\.(gcode|nc|ngc|tap)$/i, '')
        const opId = tpStore.addOperation({
          type: 'gcode',
          name: opName,
          toolId: GCODE_IMPORT_TOOL_ID,
          filename,
        })
        useToolpathStore.getState().setSegments(opId, motionSegs)

        // Rename project to match the imported file
        useProjectStore.getState().setName(opName)

        // Open the G-code viewer so the user sees the imported code immediately
        const simState = useSimStore.getState()
        if (!simState.gcodeViewerOpen) simState.toggleGcodeViewer()

        setSidebarTab('draw')
        const cur = useUIStore.getState().workspaceTab
        if (cur !== '2d' && cur !== '3d') setWorkspaceTab('2d')
      })
      return
    }

    if (file.name.toLowerCase().endsWith('.svg') || file.type === 'image/svg+xml') {
      const reader = new FileReader()
      reader.onload = (ev) => {
        try {
          const { widthMM, heightMM } = useWorkpieceStore.getState()
          const gn = file.name.replace(/\.svg$/i, '')
          const result = importSvg(ev.target?.result as string, {}, gn)
          if (result.paths.length > 0) {
            // Center on workpiece by actual path bbox (handles SVGs where content
            // is smaller than the declared page size, e.g. tiny art on an A4 canvas)
            const bbox = getMultiBBox(result.paths.map(p => p.d))
            if (bbox) {
              const dx = widthMM / 2 - (bbox.minX + bbox.maxX) / 2
              const dy = heightMM / 2 - (bbox.minY + bbox.maxY) / 2
              if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001)
                for (const path of result.paths) path.d = translateD(path.d, dx, dy)
            }
            const store = usePathsStore.getState()
            store.addPaths(result.paths)
            store.toggleGroupCollapsed(result.groupId)
            setSidebarTab('draw')
          }
        } catch { /* ignore */ }
      }
      reader.readAsText(file)
      return
    }

    if (file.name.toLowerCase().endsWith('.dxf')) {
      const reader = new FileReader()
      reader.onload = (ev) => {
        const text = ev.target?.result as string
        const fileName = file.name.replace(/\.dxf$/i, '')
        const result = importDxf(text, fileName)
        if (result.needsUnitsPrompt) {
          setPendingDxf({ text, name: fileName })
        } else {
          completeDxfImport(text, fileName)
        }
      }
      reader.readAsText(file)
      return
    }

    if (file.name.toLowerCase().endsWith('.stl')) {
      const reader = new FileReader()
      reader.onload = (ev) => {
        const buffer = ev.target?.result as ArrayBuffer
        try {
          const { widthMM, heightMM } = useWorkpieceStore.getState()
          const path = importStl(buffer, file.name.replace(/\.stl$/i, ''), widthMM / 2, heightMM / 2)
          const store = usePathsStore.getState()
          store.addPaths([path])
          store.selectPath(path.id)
          setSidebarTab('draw')
        } catch (err) {
          console.error('STL import failed:', err)
          alert(`Could not import STL: ${err instanceof Error ? err.message : 'Unknown error'}`)
        }
      }
      reader.readAsArrayBuffer(file)
      return
    }

    if (/\.(png|jpe?g|webp)$/i.test(file.name) || file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = (ev) => {
        const src = ev.target?.result as string
        const img = new window.Image()
        img.onload = () => {
          const { widthMM, heightMM } = useWorkpieceStore.getState()
          // Convert natural pixels → mm at 96 DPI, then scale to fit 80% of workpiece
          const PX_TO_MM = 25.4 / 96
          const naturalW = img.naturalWidth * PX_TO_MM
          const naturalH = img.naturalHeight * PX_TO_MM
          const scl = Math.min((widthMM * 0.8) / naturalW, (heightMM * 0.8) / naturalH, 1)
          const imgW = naturalW * scl
          const imgH = naturalH * scl
          // Center on the workpiece
          const cx = widthMM / 2, cy = heightMM / 2
          const hw = imgW / 2, hh = imgH / 2
          const d = `M${fmt(cx - hw)},${fmt(cy - hh)} L${fmt(cx + hw)},${fmt(cy - hh)} L${fmt(cx + hw)},${fmt(cy + hh)} L${fmt(cx - hw)},${fmt(cy + hh)} Z`
          usePathsStore.getState().addPaths([{
            id: `img-${Date.now()}`,
            name: file.name.replace(/\.[^.]+$/, ''),
            d,
            visible: true,
            color: '#94a3b8',
            imageSrc: src,
          }])
          setSidebarTab('draw')
        }
        img.src = src
      }
      reader.readAsDataURL(file)
    }
  }

  const hasToolpaths = operations.some((o) => o.status === 'done' && o.visible)

  return (
    <div className="h-10 bg-gray-100 dark:bg-neutral-800 border-b border-gray-300 dark:border-neutral-700 flex items-center px-2 gap-0.5 flex-shrink-0 select-none">


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
          label="Save Project (Ctrl+S)"
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

      {/* DXF units prompt modal */}
      {pendingDxf && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-neutral-800 rounded-lg p-6 shadow-2xl w-80 border border-gray-200 dark:border-neutral-700">
            <h3 className="text-base font-semibold text-gray-900 dark:text-neutral-100 mb-1">DXF Units</h3>
            <p className="text-sm text-gray-500 dark:text-neutral-400 mb-4">
              This DXF file has no unit information. Select the drawing units:
            </p>
            <div className="grid grid-cols-3 gap-2 mb-4">
              {(['mm', 'cm', 'in', 'ft', 'm'] as DxfUnitsChoice[]).map((u) => (
                <button
                  key={u}
                  onClick={() => completeDxfImport(pendingDxf.text, pendingDxf.name, u)}
                  className="px-3 py-2 rounded bg-gray-100 dark:bg-neutral-700 hover:bg-blue-100 dark:hover:bg-blue-900/40 text-sm font-medium text-gray-800 dark:text-neutral-200 transition-colors"
                >
                  {u}
                </button>
              ))}
            </div>
            <button
              onClick={() => setPendingDxf(null)}
              className="w-full text-sm text-gray-400 hover:text-gray-600 dark:hover:text-neutral-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
