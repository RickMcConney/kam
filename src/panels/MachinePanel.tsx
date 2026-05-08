import { useState } from 'react'
import {
  Plus, Trash2, Eye, EyeOff, AlertCircle, CheckCircle2, Loader2, Cpu,
  Crosshair, X, ChevronUp, ChevronDown,
} from 'lucide-react'
import { useToolStore, type Tool, type CuttingDirection } from '../store/toolStore'
import { useToolpathStore, type CutSide } from '../store/toolpathStore'
import { usePathsStore } from '../store/pathsStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useUIStore } from '../store/uiStore'
import { generateProfile } from '../cam/profile'
import { generatePocket } from '../cam/pocket'
import { generatePeckDrill, generateHelicalDrill } from '../cam/drill'
import { generateSurface } from '../cam/surfacing'
import { regenerateOperation } from '../cam/regenerate'
import { getBBox } from '../canvas/selectionUtils'
import type { ImportedPath } from '../store/pathsStore'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractCircle(path: ImportedPath): { cx: number; cy: number; radiusMM: number } | null {
  if (path.shapeParams?.type === 'circle') {
    return { cx: path.shapeParams.cx, cy: path.shapeParams.cy, radiusMM: path.shapeParams.radius }
  }
  if (path.shapeParams?.type === 'ellipse') {
    const { cx, cy, rx, ry } = path.shapeParams
    if (Math.abs(rx - ry) / Math.max(rx, ry, 0.001) < 0.05) {
      return { cx, cy, radiusMM: (rx + ry) / 2 }
    }
  }
  // Fall back to bounding box: accept if aspect ratio is close to 1
  const bb = getBBox(path.d)
  if (!bb) return null
  const rx = (bb.maxX - bb.minX) / 2
  const ry = (bb.maxY - bb.minY) / 2
  if (Math.max(rx, ry) < 0.001) return null
  if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.08) {
    return { cx: bb.cx, cy: bb.cy, radiusMM: (rx + ry) / 2 }
  }
  return null
}

// ─── Status icon ─────────────────────────────────────────────────────────────

const STATUS_ICON = {
  pending: <span className="w-1.5 h-1.5 rounded-full bg-neutral-500 flex-shrink-0" />,
  generating: <Loader2 size={10} className="animate-spin text-blue-400 flex-shrink-0" />,
  done: <CheckCircle2 size={11} className="text-green-400 flex-shrink-0" />,
  'needs-update': <AlertCircle size={11} className="text-amber-400 flex-shrink-0" />,
  error: <AlertCircle size={11} className="text-red-400 flex-shrink-0" />,
}

// ─── Profile form ─────────────────────────────────────────────────────────────

interface ProfileFormState {
  toolId: string
  side: CutSide
  depthMM: number
  stepDownMM: number
  direction: CuttingDirection
}

function ProfileForm({ onClose }: { onClose: () => void }) {
  const { tools } = useToolStore()
  const { paths, selectedIds } = usePathsStore()
  const selectedId = selectedIds[0] ?? null
  const { addOperation, setSegments, setError, updateOperation } = useToolpathStore()

  const defaultTool = tools[0]
  const [form, setForm] = useState<ProfileFormState>({
    toolId: defaultTool?.id ?? '',
    side: 'outside',
    depthMM: defaultTool?.maxDepthMM ?? 10,
    stepDownMM: defaultTool?.stepDownMM ?? 3,
    direction: defaultTool?.direction ?? 'climb',
  })
  const [generating, setGenerating] = useState(false)

  const selectedPath = paths.find((p) => p.id === selectedId)
  const selectedTool = tools.find((t) => t.id === form.toolId)

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, depthMM: t.maxDepthMM, stepDownMM: t.stepDownMM, direction: t.direction }))
  }

  function up<K extends keyof ProfileFormState>(k: K, v: ProfileFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleGenerate() {
    if (!selectedPath || !selectedTool) return
    setGenerating(true)
    const opId = addOperation({
      name: `Profile: ${selectedPath.name} (${selectedTool.name})`,
      type: 'profile',
      toolId: form.toolId,
      pathId: selectedPath.id,
      side: form.side,
      depthMM: form.depthMM,
      stepDownMM: form.stepDownMM,
      direction: form.direction,
    })
    updateOperation(opId, { status: 'generating' })
    setTimeout(() => {
      try {
        setSegments(opId, generateProfile(selectedPath.d, selectedTool, {
          side: form.side, depthMM: form.depthMM, stepDownMM: form.stepDownMM, direction: form.direction,
        }))
      } catch (err) {
        setError(opId, err instanceof Error ? err.message : 'Generation failed')
      }
      setGenerating(false)
      onClose()
    }, 0)
  }

  return (
    <FormShell title="New Profile Operation" onClose={onClose}>
      <PathSelector selectedPath={selectedPath} />
      <ToolSelector tools={tools} value={form.toolId} onChange={handleToolChange} />
      <ToggleRow label="Cut Side" options={['inside', 'outside', 'centerline'] as CutSide[]} value={form.side} onChange={(v) => up('side', v)} />
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)} />
      <ToggleRow label="Direction" options={['climb', 'conventional'] as CuttingDirection[]} value={form.direction} onChange={(v) => up('direction', v)} />
      <GenerateBtn
        disabled={!selectedPath || !selectedTool || generating || form.depthMM <= 0}
        generating={generating}
        onClick={handleGenerate}
      />
    </FormShell>
  )
}

// ─── Pocket form ──────────────────────────────────────────────────────────────

interface PocketFormState {
  toolId: string
  depthMM: number
  stepDownMM: number
  stepoverPercent: number
  direction: CuttingDirection
}

function PocketForm({ onClose }: { onClose: () => void }) {
  const { tools } = useToolStore()
  const { paths, selectedIds } = usePathsStore()
  const { addOperation, setSegments, setError, updateOperation } = useToolpathStore()

  const defaultTool = tools[0]
  const [form, setForm] = useState<PocketFormState>({
    toolId: defaultTool?.id ?? '',
    depthMM: defaultTool?.maxDepthMM ?? 10,
    stepDownMM: defaultTool?.stepDownMM ?? 3,
    stepoverPercent: 40,
    direction: defaultTool?.direction ?? 'climb',
  })
  const [generating, setGenerating] = useState(false)

  const boundaryPath = paths.find((p) => p.id === selectedIds[0])
  const islandPaths = paths.filter((p) => selectedIds.slice(1).includes(p.id))
  const selectedTool = tools.find((t) => t.id === form.toolId)

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, depthMM: t.maxDepthMM, stepDownMM: t.stepDownMM, direction: t.direction }))
  }

  function up<K extends keyof PocketFormState>(k: K, v: PocketFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleGenerate() {
    if (!boundaryPath || !selectedTool) return
    setGenerating(true)
    const opId = addOperation({
      name: `Pocket: ${boundaryPath.name} (${selectedTool.name})`,
      type: 'pocket',
      toolId: form.toolId,
      pathId: boundaryPath.id,
      islandIds: islandPaths.map((p) => p.id),
      depthMM: form.depthMM,
      stepDownMM: form.stepDownMM,
      stepoverPercent: form.stepoverPercent,
      direction: form.direction,
    })
    updateOperation(opId, { status: 'generating' })
    setTimeout(() => {
      try {
        setSegments(opId, generatePocket(boundaryPath.d, selectedTool, {
          depthMM: form.depthMM,
          stepDownMM: form.stepDownMM,
          stepoverPercent: form.stepoverPercent,
          direction: form.direction,
          islandDs: islandPaths.map((p) => p.d),
        }))
      } catch (err) {
        setError(opId, err instanceof Error ? err.message : 'Generation failed')
      }
      setGenerating(false)
      onClose()
    }, 0)
  }

  return (
    <FormShell title="New Pocket Operation" onClose={onClose}>
      {/* Boundary */}
      <div>
        <label className="block text-[10px] text-neutral-500 uppercase tracking-wider mb-1">Boundary</label>
        {boundaryPath ? (
          <PathChip path={boundaryPath} label="boundary" />
        ) : (
          <p className="text-xs text-amber-400 flex items-center gap-1"><AlertCircle size={12} /> Select a closed path first</p>
        )}
      </div>
      {/* Islands */}
      {islandPaths.length > 0 && (
        <div>
          <label className="block text-[10px] text-neutral-500 uppercase tracking-wider mb-1">Islands</label>
          <div className="space-y-0.5">
            {islandPaths.map((p) => <PathChip key={p.id} path={p} label="island" />)}
          </div>
          <p className="text-[10px] text-neutral-500 mt-1">Additional selected paths treated as islands.</p>
        </div>
      )}
      <ToolSelector tools={tools.filter((t) => t.type === 'endmill' || t.type === 'ballnose')} value={form.toolId} onChange={handleToolChange} />
      {/* Stepover */}
      <div>
        <label className="block text-[10px] text-neutral-500 uppercase tracking-wider mb-1">
          Stepover <span className="text-neutral-400 normal-case">{form.stepoverPercent}%</span>
        </label>
        <input
          type="range" min={10} max={90} step={5}
          value={form.stepoverPercent}
          onChange={(e) => up('stepoverPercent', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)} />
      <ToggleRow label="Direction" options={['climb', 'conventional'] as CuttingDirection[]} value={form.direction} onChange={(v) => up('direction', v)} />
      <GenerateBtn
        disabled={!boundaryPath || !selectedTool || generating || form.depthMM <= 0}
        generating={generating}
        onClick={handleGenerate}
      />
    </FormShell>
  )
}

// ─── Drill form ───────────────────────────────────────────────────────────────

interface DrillFormState {
  toolId: string
  drillMode: 'peck' | 'helical'
  depthMM: number
  stepDownMM: number
}

function DrillForm({ onClose }: { onClose: () => void }) {
  const { tools } = useToolStore()
  const { paths, selectedIds } = usePathsStore()
  const { addOperation, setSegments, setError, updateOperation } = useToolpathStore()
  const { activeTool, setActiveTool, pendingDrillPoints, clearDrillPoints } = useUIStore()

  const defaultTool = tools[0]
  const [form, setForm] = useState<DrillFormState>({
    toolId: defaultTool?.id ?? '',
    drillMode: 'peck',
    depthMM: defaultTool?.maxDepthMM ?? 10,
    stepDownMM: defaultTool?.stepDownMM ?? 3,
  })
  const [generating, setGenerating] = useState(false)

  const selectedTool = tools.find((t) => t.id === form.toolId)
  const selectedPath = paths.find((p) => p.id === selectedIds[0])
  const circleInfo = selectedPath ? extractCircle(selectedPath) : null
  const helicalRadius = circleInfo ? circleInfo.radiusMM - (selectedTool?.diameterMM ?? 0) / 2 : null

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, depthMM: t.maxDepthMM, stepDownMM: t.stepDownMM }))
  }

  function up<K extends keyof DrillFormState>(k: K, v: DrillFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function toggleDrillMode() {
    // Leaving drill point mode when switching to helical
    if (form.drillMode === 'peck') {
      if (activeTool === 'drill') { setActiveTool('select'); clearDrillPoints() }
      setForm((f) => ({ ...f, drillMode: 'helical' }))
    } else {
      setForm((f) => ({ ...f, drillMode: 'peck' }))
    }
  }

  function handleClose() {
    if (activeTool === 'drill') { setActiveTool('select'); clearDrillPoints() }
    onClose()
  }

  function handleGenerate() {
    if (!selectedTool) return
    if (form.drillMode === 'peck' && pendingDrillPoints.length === 0) return
    if (form.drillMode === 'helical' && !circleInfo) return

    setGenerating(true)

    const opName = form.drillMode === 'helical' && circleInfo
      ? `Helical Drill: ${selectedPath?.name ?? 'circle'} (${selectedTool.name})`
      : `Peck Drill (${selectedTool.name}) ×${pendingDrillPoints.length}`

    const opId = addOperation({
      name: opName,
      type: 'drill',
      toolId: form.toolId,
      drillMode: form.drillMode,
      points: [...pendingDrillPoints],
      pathId: form.drillMode === 'helical' ? selectedPath?.id : undefined,
      helicalCenterX: circleInfo?.cx,
      helicalCenterY: circleInfo?.cy,
      helicalRadius: helicalRadius ?? undefined,
      depthMM: form.depthMM,
      stepDownMM: form.stepDownMM,
    })
    updateOperation(opId, { status: 'generating' })

    setTimeout(() => {
      try {
        let segs
        if (form.drillMode === 'helical' && circleInfo) {
          const r = Math.max(0, circleInfo.radiusMM - selectedTool.diameterMM / 2)
          segs = generateHelicalDrill(circleInfo.cx, circleInfo.cy, r, selectedTool, {
            depthMM: form.depthMM, stepDownMM: form.stepDownMM,
          })
        } else {
          segs = generatePeckDrill(pendingDrillPoints, selectedTool, {
            depthMM: form.depthMM, stepDownMM: form.stepDownMM,
          })
        }
        setSegments(opId, segs)
      } catch (err) {
        setError(opId, err instanceof Error ? err.message : 'Generation failed')
      }
      setGenerating(false)
      clearDrillPoints()
      setActiveTool('select')
      onClose()
    }, 0)
  }

  const isDrillToolSelected = selectedTool?.type === 'drill'
  const peckReady = form.drillMode === 'peck' && pendingDrillPoints.length > 0
  const helicalReady = form.drillMode === 'helical' && circleInfo !== null
  const canGenerate = !!selectedTool && !generating && form.depthMM > 0 && (peckReady || helicalReady)

  return (
    <FormShell title="New Drill Operation" onClose={handleClose}>
      {/* Mode toggle */}
      <div>
        <label className="block text-[10px] text-neutral-500 uppercase tracking-wider mb-1">Mode</label>
        <div className="flex gap-1">
          {(['peck', 'helical'] as const).map((m) => (
            <button key={m} onClick={() => { if (m !== form.drillMode) toggleDrillMode() }}
              className={[
                'flex-1 py-1 text-xs rounded border transition-colors capitalize',
                form.drillMode === m
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-neutral-700 border-neutral-600 text-neutral-400 hover:text-neutral-200',
              ].join(' ')}>
              {m === 'peck' ? 'Peck at Points' : 'Helical (Circle)'}
            </button>
          ))}
        </div>
      </div>

      {/* Peck: place points */}
      {form.drillMode === 'peck' && (
        <div>
          <label className="block text-[10px] text-neutral-500 uppercase tracking-wider mb-1">Drill Points</label>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (activeTool === 'drill') { setActiveTool('select') }
                else { setActiveTool('drill') }
              }}
              className={[
                'flex items-center gap-1.5 px-2 py-1 rounded text-xs border transition-colors',
                activeTool === 'drill'
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-neutral-700 border-neutral-600 text-neutral-300 hover:bg-neutral-600',
              ].join(' ')}
            >
              <Crosshair size={11} />
              {activeTool === 'drill' ? 'Placing…' : 'Place Points'}
            </button>
            {pendingDrillPoints.length > 0 && (
              <span className="text-xs text-neutral-300">
                {pendingDrillPoints.length} point{pendingDrillPoints.length !== 1 ? 's' : ''}
              </span>
            )}
            {pendingDrillPoints.length > 0 && (
              <button onClick={clearDrillPoints} className="p-0.5 rounded hover:bg-neutral-600 text-neutral-500 hover:text-neutral-300">
                <X size={11} />
              </button>
            )}
          </div>
          {pendingDrillPoints.length === 0 && (
            <p className="text-[10px] text-neutral-500 mt-1">Click on canvas to place drill points.</p>
          )}
          {isDrillToolSelected && (
            <p className="text-[10px] text-amber-400 mt-1 flex items-center gap-1">
              <AlertCircle size={10} /> Peck drilling with an end mill — ensure the tool is suitable.
            </p>
          )}
        </div>
      )}

      {/* Helical: show circle info */}
      {form.drillMode === 'helical' && (
        <div>
          <label className="block text-[10px] text-neutral-500 uppercase tracking-wider mb-1">Source Circle</label>
          {circleInfo ? (
            <div className="text-xs text-neutral-200 bg-neutral-700/40 rounded px-2 py-1 space-y-0.5">
              <div>Center: ({circleInfo.cx.toFixed(1)}, {circleInfo.cy.toFixed(1)}) mm</div>
              <div>Hole Ø: {(circleInfo.radiusMM * 2).toFixed(2)} mm</div>
              {helicalRadius !== null && helicalRadius > 0 && (
                <div className="text-neutral-400">Tool path Ø: {(helicalRadius * 2).toFixed(2)} mm</div>
              )}
              {helicalRadius !== null && helicalRadius <= 0 && (
                <div className="text-amber-400">Tool is wider than hole — will center-drill instead.</div>
              )}
            </div>
          ) : (
            <p className="text-xs text-amber-400 flex items-center gap-1">
              <AlertCircle size={12} /> Select a circular path first
            </p>
          )}
          {isDrillToolSelected && (
            <p className="text-[10px] text-amber-400 mt-1 flex items-center gap-1">
              <AlertCircle size={10} /> Drill bits cannot do helical drilling — use an end mill.
            </p>
          )}
        </div>
      )}

      <ToolSelector tools={tools} value={form.toolId} onChange={handleToolChange} />
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)} />
      <GenerateBtn disabled={!canGenerate} generating={generating} onClick={handleGenerate} />
    </FormShell>
  )
}

// ─── Shared sub-components ───────────────────────────────────────────────────

function FormShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="border border-neutral-600 rounded-lg mx-3 mt-3 mb-2 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-neutral-700/50 border-b border-neutral-600">
        <span className="text-xs font-semibold text-neutral-300">{title}</span>
        <button onClick={onClose} className="text-neutral-500 hover:text-neutral-300 text-sm leading-none">✕</button>
      </div>
      <div className="p-3 space-y-2.5">{children}</div>
    </div>
  )
}

function PathChip({ path, label }: { path: ImportedPath; label: string }) {
  return (
    <div className="text-xs text-neutral-200 bg-neutral-700/40 rounded px-2 py-1 flex items-center gap-1.5">
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: path.color }} />
      {path.name}
      <span className="text-neutral-500">({label})</span>
    </div>
  )
}

function PathSelector({ selectedPath }: { selectedPath: ImportedPath | undefined }) {
  return (
    <div>
      <label className="block text-[10px] text-neutral-500 uppercase tracking-wider mb-1">Path</label>
      {selectedPath ? (
        <PathChip path={selectedPath} label="selected" />
      ) : (
        <p className="text-xs text-amber-400 flex items-center gap-1">
          <AlertCircle size={12} /> Select a path on the canvas first
        </p>
      )}
    </div>
  )
}

function ToolSelector({ tools, value, onChange }: {
  tools: Tool[]
  value: string
  onChange: (id: string) => void
}) {
  return (
    <div>
      <label className="block text-[10px] text-neutral-500 uppercase tracking-wider mb-1">Tool</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-neutral-700 border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-100 focus:outline-none focus:border-blue-500"
      >
        {tools.map((t) => (
          <option key={t.id} value={t.id}>{t.name} (Ø{t.diameterMM}mm)</option>
        ))}
      </select>
    </div>
  )
}

function ToggleRow<T extends string>({ label, options, value, onChange }: {
  label: string
  options: readonly T[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div>
      <label className="block text-[10px] text-neutral-500 uppercase tracking-wider mb-1">{label}</label>
      <div className="flex gap-1">
        {options.map((o) => (
          <button key={o} onClick={() => onChange(o)}
            className={[
              'flex-1 py-1 text-xs rounded border transition-colors capitalize',
              value === o
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-neutral-700 border-neutral-600 text-neutral-400 hover:text-neutral-200',
            ].join(' ')}>
            {o}
          </button>
        ))}
      </div>
    </div>
  )
}

function DepthRow({ depthMM, stepDownMM, onDepth, onStep }: {
  depthMM: number; stepDownMM: number
  onDepth: (v: number) => void; onStep: (v: number) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {([
        ['Depth', depthMM, onDepth],
        ['Step Down', stepDownMM, onStep],
      ] as [string, number, (v: number) => void][]).map(([lbl, val, fn]) => (
        <div key={lbl}>
          <label className="block text-[10px] text-neutral-500 uppercase tracking-wider mb-1">{lbl}</label>
          <div className="flex items-center gap-1">
            <input type="number" value={val} min={0.01} step={0.5}
              onChange={(e) => fn(parseFloat(e.target.value) || 0)}
              className="flex-1 bg-neutral-700 border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
            />
            <span className="text-[10px] text-neutral-500">mm</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function GenerateBtn({ disabled, generating, onClick }: { disabled: boolean; generating: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="w-full py-1.5 rounded text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5">
      {generating && <Loader2 size={12} className="animate-spin" />}
      {generating ? 'Generating…' : 'Generate Toolpath'}
    </button>
  )
}

// ─── Surface form ─────────────────────────────────────────────────────────────

interface SurfaceFormState {
  toolId: string
  depthMM: number
  stepDownMM: number
  stepoverPercent: number
  passAngleDeg: number
}

function SurfaceForm({ onClose }: { onClose: () => void }) {
  const { tools } = useToolStore()
  const { widthMM, heightMM, origin } = useWorkpieceStore()
  const { addOperation, setSegments, setError, updateOperation } = useToolpathStore()

  const endMills = tools.filter((t) => t.type === 'endmill' || t.type === 'ballnose')
  const defaultTool = endMills[0] ?? tools[0]
  const [form, setForm] = useState<SurfaceFormState>({
    toolId: defaultTool?.id ?? '',
    depthMM: defaultTool?.stepDownMM ?? 1,
    stepDownMM: defaultTool?.stepDownMM ?? 1,
    stepoverPercent: 40,
    passAngleDeg: 0,
  })
  const [generating, setGenerating] = useState(false)
  const selectedTool = tools.find((t) => t.id === form.toolId)

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, depthMM: t.stepDownMM, stepDownMM: t.stepDownMM }))
  }

  function up<K extends keyof SurfaceFormState>(k: K, v: SurfaceFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleGenerate() {
    if (!selectedTool) return
    setGenerating(true)
    const opId = addOperation({
      name: `Surface (${selectedTool.name})`,
      type: 'surface',
      toolId: form.toolId,
      depthMM: form.depthMM,
      stepDownMM: form.stepDownMM,
      stepoverPercent: form.stepoverPercent,
      passAngleDeg: form.passAngleDeg,
    })
    updateOperation(opId, { status: 'generating' })
    setTimeout(() => {
      try {
        setSegments(opId, generateSurface(selectedTool, {
          widthMM, heightMM, origin,
          depthMM: form.depthMM,
          stepDownMM: form.stepDownMM,
          stepoverPercent: form.stepoverPercent,
          passAngleDeg: form.passAngleDeg,
        }))
      } catch (err) {
        setError(opId, err instanceof Error ? err.message : 'Generation failed')
      }
      setGenerating(false)
      onClose()
    }, 0)
  }

  return (
    <FormShell title="New Surface Operation" onClose={onClose}>
      <div className="text-[10px] text-neutral-500 bg-neutral-700/30 rounded px-2 py-1.5">
        Covers workpiece: {widthMM} × {heightMM} mm
      </div>
      <ToolSelector
        tools={endMills.length > 0 ? endMills : tools}
        value={form.toolId}
        onChange={handleToolChange}
      />
      {/* Stepover */}
      <div>
        <label className="block text-[10px] text-neutral-500 uppercase tracking-wider mb-1">
          Stepover <span className="text-neutral-400 normal-case">{form.stepoverPercent}%</span>
        </label>
        <input
          type="range" min={10} max={90} step={5}
          value={form.stepoverPercent}
          onChange={(e) => up('stepoverPercent', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>
      {/* Pass angle */}
      <div>
        <label className="block text-[10px] text-neutral-500 uppercase tracking-wider mb-1">
          Pass Angle <span className="text-neutral-400 normal-case">{form.passAngleDeg}°</span>
        </label>
        <input
          type="range" min={0} max={180} step={5}
          value={form.passAngleDeg}
          onChange={(e) => up('passAngleDeg', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>
      <DepthRow
        depthMM={form.depthMM}
        stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)}
        onStep={(v) => up('stepDownMM', v)}
      />
      <GenerateBtn
        disabled={!selectedTool || generating || form.depthMM <= 0}
        generating={generating}
        onClick={handleGenerate}
      />
    </FormShell>
  )
}

// ─── Operation type selector ──────────────────────────────────────────────────

type OpType = 'profile' | 'pocket' | 'drill' | 'surface'
type FormState = null | 'menu' | OpType

function AddOperationMenu({ onSelect }: { onSelect: (t: OpType) => void }) {
  return (
    <div className="mx-3 mt-3 mb-2 border border-neutral-600 rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-neutral-700/50 border-b border-neutral-600 text-xs font-semibold text-neutral-300">
        Add Operation
      </div>
      <div className="p-2 grid grid-cols-3 gap-1.5">
        {([
          ['profile', 'Profile', 'Cut along path edge'],
          ['pocket', 'Pocket', 'Clear inside boundary'],
          ['drill', 'Drill', 'Peck or helical drill'],
          ['surface', 'Surface', 'Flatten workpiece top'],
        ] as [OpType, string, string][]).map(([type, name, desc]) => (
          <button key={type} onClick={() => onSelect(type)}
            className="flex flex-col items-center gap-1 px-2 py-2.5 rounded border border-neutral-600 bg-neutral-700/40 hover:bg-neutral-700 text-neutral-300 hover:text-white transition-colors">
            <span className="text-xs font-medium">{name}</span>
            <span className="text-[9px] text-neutral-500 text-center leading-tight">{desc}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export default function MachinePanel() {
  const { operations, deleteOperation, toggleVisibility, moveOperation } = useToolpathStore()
  const { tools } = useToolStore()
  const [activeForm, setActiveForm] = useState<FormState>(null)

  function handleRegenerate(opId: string) {
    regenerateOperation(opId)
  }

  function opDescription(op: typeof operations[0]): string {
    const tool = tools.find((t) => t.id === op.toolId)
    const toolName = tool?.name ?? 'Unknown tool'
    if (op.type === 'profile') return `${toolName} · ${op.side} · ${op.depthMM}mm`
    if (op.type === 'pocket') return `${toolName} · ${op.stepoverPercent}% stepover · ${op.depthMM}mm`
    if (op.type === 'drill') return `${toolName} · ${op.drillMode} · ${op.depthMM}mm`
    if (op.type === 'surface') return `${toolName} · ${op.stepoverPercent}% · ${op.passAngleDeg}° · ${op.depthMM}mm`
    return toolName
  }

  const closeForm = () => setActiveForm(null as FormState)

  return (
    <div className="flex flex-col h-full">
      {/* Form area */}
      {activeForm === null ? (
        <div className="mx-3 mt-3 mb-2">
          <button
            onClick={() => setActiveForm('menu')}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 text-neutral-300 transition-colors"
          >
            <Plus size={13} />
            Add Operation
          </button>
        </div>
      ) : activeForm === 'menu' ? (
        <div>
          <AddOperationMenu onSelect={(t) => setActiveForm(t)} />
          <div className="mx-3">
            <button onClick={closeForm} className="w-full py-1 text-xs text-neutral-500 hover:text-neutral-300">Cancel</button>
          </div>
        </div>
      ) : activeForm === 'profile' ? (
        <ProfileForm onClose={closeForm} />
      ) : activeForm === 'pocket' ? (
        <PocketForm onClose={closeForm} />
      ) : activeForm === 'drill' ? (
        <DrillForm onClose={closeForm} />
      ) : activeForm === 'surface' ? (
        <SurfaceForm onClose={closeForm} />
      ) : null}

      {/* Operations list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {operations.length === 0 ? (
          <div className="px-3 py-6 text-xs text-neutral-500 text-center">
            <Cpu size={28} className="mx-auto mb-2 opacity-30" />
            No operations yet.
          </div>
        ) : (
          <ul className="space-y-1">
            {operations.map((op) => (
              <li key={op.id} className="rounded border border-neutral-700 bg-neutral-800/50 overflow-hidden">
                <div className="flex items-center gap-1.5 px-2 py-2">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: op.color }} />
                  {STATUS_ICON[op.status]}
                  <span className="flex-1 text-xs text-neutral-200 truncate min-w-0" title={op.name}>{op.name}</span>
                  <button title="Move up" onClick={() => moveOperation(op.id, 'up')}
                    className="p-0.5 rounded hover:bg-neutral-600 text-neutral-600 hover:text-neutral-300">
                    <ChevronUp size={12} />
                  </button>
                  <button title="Move down" onClick={() => moveOperation(op.id, 'down')}
                    className="p-0.5 rounded hover:bg-neutral-600 text-neutral-600 hover:text-neutral-300">
                    <ChevronDown size={12} />
                  </button>
                  <button title={op.visible ? 'Hide' : 'Show'} onClick={() => toggleVisibility(op.id)}
                    className="p-0.5 rounded hover:bg-neutral-600 text-neutral-500 hover:text-neutral-300">
                    {op.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                  </button>
                  <button title="Delete" onClick={() => deleteOperation(op.id)}
                    className="p-0.5 rounded hover:bg-red-900/30 text-neutral-500 hover:text-red-400">
                    <Trash2 size={12} />
                  </button>
                </div>
                <div className="px-2 pb-1.5 flex items-center gap-2">
                  <span className="text-[10px] text-neutral-500 flex-1 capitalize">{op.type} · {opDescription(op)}</span>
                  {(op.status === 'needs-update' || op.status === 'error') && (
                    <button onClick={() => handleRegenerate(op.id)} className="text-[10px] text-blue-400 hover:text-blue-300">
                      Regenerate
                    </button>
                  )}
                </div>
                {op.status === 'error' && op.errorMessage && (
                  <p className="px-2 pb-1.5 text-[10px] text-red-400">{op.errorMessage}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
