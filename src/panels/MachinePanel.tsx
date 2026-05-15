import { useState } from 'react'
import { ICON } from '../theme'
import {
  Trash2, Eye, EyeOff, AlertCircle, CheckCircle2, Loader2, Cpu,
  Crosshair, X, ChevronUp, ChevronDown, Circle, CircleDot, Target, Layers,
  Star, Package
} from 'lucide-react'
import { useToolStore, type Tool, type CuttingDirection } from '../store/toolStore'
import { useToolpathStore, type CutSide } from '../store/toolpathStore'
import { usePathsStore } from '../store/pathsStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useUIStore } from '../store/uiStore'
import { flattenPath } from '../cam/pathFlattener'
import { generateProfile } from '../cam/profile'
import { generatePocket } from '../cam/raster'
import { generatePeckDrill, generateHelicalDrill } from '../cam/drill'
import { generateSurface } from '../cam/surfacing'
import { generateVCarve } from '../cam/vcarve'
import { generateInlayFemale, generateInlayMale } from '../cam/inlay'
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

// ─── Containment grouping ─────────────────────────────────────────────────────

function ptInPoly(px: number, py: number, poly: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// Groups selected paths into {boundary, islands} pairs.
// A path is an island if its first point lies inside another selected path.
// Paths not contained in any other become independent boundaries.
function groupPathsByContainment(
  selectedPaths: ImportedPath[]
): { boundary: ImportedPath; islands: ImportedPath[] }[] {
  if (selectedPaths.length === 0) return []
  if (selectedPaths.length === 1) return [{ boundary: selectedPaths[0], islands: [] }]

  const polyCache = new Map<string, [number, number][]>()
  function getPoly(p: ImportedPath): [number, number][] {
    if (!polyCache.has(p.id)) {
      const pts = flattenPath(p.d, 0.1)
      polyCache.set(p.id, (pts[0] ?? []) as [number, number][])
    }
    return polyCache.get(p.id)!
  }

  // For each path find its smallest (most direct) containing path among the selection
  const parentId = new Map<string, string>()
  for (const inner of selectedPaths) {
    const poly = getPoly(inner)
    if (poly.length < 1) continue
    const [px, py] = poly[0]
    for (const outer of selectedPaths) {
      if (outer.id === inner.id) continue
      const outerPoly = getPoly(outer)
      if (outerPoly.length < 3) continue
      if (!ptInPoly(px, py, outerPoly)) continue
      // Prefer the smallest container (direct parent over grandparent)
      const existing = parentId.get(inner.id)
      if (!existing) {
        parentId.set(inner.id, outer.id)
      } else {
        const bCur = getBBox(selectedPaths.find(p => p.id === existing)!.d)
        const bNew = getBBox(outer.d)
        if (bCur && bNew && bNew.w * bNew.h < bCur.w * bCur.h) parentId.set(inner.id, outer.id)
      }
    }
  }

  const boundaries = selectedPaths.filter(p => !parentId.has(p.id))
  return boundaries.map(b => ({
    boundary: b,
    islands: selectedPaths.filter(p => parentId.get(p.id) === b.id),
  }))
}

// ─── Status icon ─────────────────────────────────────────────────────────────

const STATUS_ICON = {
  pending: <span className="w-1.5 h-1.5 rounded-full bg-gray-300 dark:bg-neutral-600 flex-shrink-0" />,
  generating: <Loader2 size={ICON.xs} className="animate-spin text-blue-400 flex-shrink-0" />,
  done: <CheckCircle2 size={ICON.xs} className="text-green-400 flex-shrink-0" />,
  'needs-update': <AlertCircle size={ICON.xs} className="text-amber-400 flex-shrink-0" />,
  error: <AlertCircle size={ICON.xs} className="text-red-400 flex-shrink-0" />,
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
  const { paths, selectedIds, pushHistoryBoth } = usePathsStore()
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

  const selectedPaths = paths.filter((p) => selectedIds.includes(p.id))
  const selectedTool = tools.find((t) => t.id === form.toolId)

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, depthMM: t.maxDepthMM, stepDownMM: t.stepDownMM, direction: t.direction }))
  }

  function up<K extends keyof ProfileFormState>(k: K, v: ProfileFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleGenerate() {
    if (selectedPaths.length === 0 || !selectedTool) return
    pushHistoryBoth()
    setGenerating(true)
    setTimeout(() => {
      for (const path of selectedPaths) {
        const opId = addOperation({
          name: `Profile: ${path.name} (${selectedTool.name})`,
          type: 'profile',
          toolId: form.toolId,
          pathId: path.id,
          side: form.side,
          depthMM: form.depthMM,
          stepDownMM: form.stepDownMM,
          direction: form.direction,
        })
        updateOperation(opId, { status: 'generating' })
        try {
          setSegments(opId, generateProfile(path.d, selectedTool, {
            side: form.side, depthMM: form.depthMM, stepDownMM: form.stepDownMM, direction: form.direction,
          }))
        } catch (err) {
          setError(opId, err instanceof Error ? err.message : 'Generation failed')
        }
      }
      setGenerating(false)
      onClose()
    }, 0)
  }

  return (
    <FormShell title="New Profile Operation" onClose={onClose}>
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          Paths {selectedPaths.length > 1 && <span className="normal-case text-gray-500 dark:text-neutral-400">({selectedPaths.length} selected — one operation each)</span>}
        </label>
        {selectedPaths.length > 0 ? (
          <div className="space-y-0.5">
            {selectedPaths.map((p) => <PathChip key={p.id} path={p} label="selected" />)}
          </div>
        ) : (
          <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> Select a path on the canvas first</p>
        )}
      </div>
      <ToolSelector tools={tools} value={form.toolId} onChange={handleToolChange} />
      <ToggleRow label="Cut Side" options={['inside', 'outside', 'centerline'] as CutSide[]} value={form.side} onChange={(v) => up('side', v)} />
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)} />
      <ToggleRow label="Direction" options={['climb', 'conventional'] as CuttingDirection[]} value={form.direction} onChange={(v) => up('direction', v)} />
      <GenerateBtn
        disabled={selectedPaths.length === 0 || !selectedTool || generating || form.depthMM <= 0}
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
  passAngleDeg: number
  direction: CuttingDirection
}

function PocketForm({ onClose }: { onClose: () => void }) {
  const { tools } = useToolStore()
  const { paths, selectedIds, pushHistoryBoth } = usePathsStore()
  const { addOperation, setSegments, setError, updateOperation } = useToolpathStore()

  const defaultTool = tools[0]
  const [form, setForm] = useState<PocketFormState>({
    toolId: defaultTool?.id ?? '',
    depthMM: defaultTool?.maxDepthMM ?? 10,
    stepDownMM: defaultTool?.stepDownMM ?? 3,
    stepoverPercent: 40,
    passAngleDeg: 0,
    direction: defaultTool?.direction ?? 'climb',
  })
  const [generating, setGenerating] = useState(false)

  const selectedPaths = paths.filter((p) => selectedIds.includes(p.id))
  const groups = groupPathsByContainment(selectedPaths)
  const selectedTool = tools.find((t) => t.id === form.toolId)

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, depthMM: t.maxDepthMM, stepDownMM: t.stepDownMM, direction: t.direction }))
  }

  function up<K extends keyof PocketFormState>(k: K, v: PocketFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleGenerate() {
    if (groups.length === 0 || !selectedTool) return
    pushHistoryBoth()
    setGenerating(true)
    setTimeout(() => {
      for (const { boundary, islands } of groups) {
        const opId = addOperation({
          name: `Pocket: ${boundary.name} (${selectedTool.name})`,
          type: 'pocket',
          toolId: form.toolId,
          pathId: boundary.id,
          islandIds: islands.map((p) => p.id),
          depthMM: form.depthMM,
          stepDownMM: form.stepDownMM,
          stepoverPercent: form.stepoverPercent,
          passAngleDeg: form.passAngleDeg,
          direction: form.direction,
        })
        updateOperation(opId, { status: 'generating' })
        try {
          setSegments(opId, generatePocket(boundary.d, selectedTool, {
            depthMM: form.depthMM,
            stepDownMM: form.stepDownMM,
            stepoverPercent: form.stepoverPercent,
            direction: form.direction,
            islandDs: islands.map((p) => p.d),
            angle: form.passAngleDeg,
          }))
        } catch (err) {
          setError(opId, err instanceof Error ? err.message : 'Generation failed')
        }
      }
      setGenerating(false)
      onClose()
    }, 0)
  }

  return (
    <FormShell title="New Pocket Operation" onClose={onClose}>
      {groups.length === 0 ? (
        <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> Select a closed path first</p>
      ) : (
        <div className="space-y-1">
          {groups.map(({ boundary, islands }, i) => (
            <div key={boundary.id}>
              {groups.length > 1 && (
                <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Pocket {i + 1}</label>
              )}
              <div className="space-y-0.5">
                <PathChip path={boundary} label="boundary" />
                {islands.map((p) => <PathChip key={p.id} path={p} label="island" />)}
              </div>
            </div>
          ))}
        </div>
      )}
      <ToolSelector tools={tools.filter((t) => t.type === 'endmill' || t.type === 'ballnose')} value={form.toolId} onChange={handleToolChange} />
      {/* Stepover */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          Stepover <span className="text-gray-500 dark:text-neutral-400 normal-case">{form.stepoverPercent}%</span>
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
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          Pass Angle <span className="text-gray-500 dark:text-neutral-400 normal-case">{form.passAngleDeg}°</span>
        </label>
        <input
          type="range" min={0} max={180} step={5}
          value={form.passAngleDeg}
          onChange={(e) => up('passAngleDeg', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)} />
      <ToggleRow label="Direction" options={['climb', 'conventional'] as CuttingDirection[]} value={form.direction} onChange={(v) => up('direction', v)} />
      <GenerateBtn
        disabled={groups.length === 0 || !selectedTool || generating || form.depthMM <= 0}
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
  const { paths, selectedIds, pushHistoryBoth } = usePathsStore()
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

    pushHistoryBoth()
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
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Mode</label>
        <div className="flex gap-1">
          {(['peck', 'helical'] as const).map((m) => (
            <button key={m} onClick={() => { if (m !== form.drillMode) toggleDrillMode() }}
              className={[
                'flex-1 py-1 text-body rounded border transition-colors capitalize',
                form.drillMode === m
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-gray-50 dark:bg-neutral-900 border-gray-300 dark:border-neutral-700 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200',
              ].join(' ')}>
              {m === 'peck' ? 'Peck at Points' : 'Helical (Circle)'}
            </button>
          ))}
        </div>
      </div>

      {/* Peck: place points */}
      {form.drillMode === 'peck' && (
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Drill Points</label>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (activeTool === 'drill') { setActiveTool('select') }
                else { setActiveTool('drill') }
              }}
              className={[
                'flex items-center gap-1.5 px-2 py-1 rounded text-body border transition-colors',
                activeTool === 'drill'
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-gray-100 dark:bg-neutral-800 border-gray-300 dark:border-neutral-700 text-gray-700 dark:text-neutral-300 hover:bg-gray-200 dark:hover:bg-neutral-700',
              ].join(' ')}
            >
              <Crosshair size={ICON.xs} />
              {activeTool === 'drill' ? 'Placing…' : 'Place Points'}
            </button>
            {pendingDrillPoints.length > 0 && (
              <span className="text-body text-gray-700 dark:text-neutral-300">
                {pendingDrillPoints.length} point{pendingDrillPoints.length !== 1 ? 's' : ''}
              </span>
            )}
            {pendingDrillPoints.length > 0 && (
              <button onClick={clearDrillPoints} className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-neutral-700 text-gray-400 dark:text-neutral-500 hover:text-gray-700 dark:hover:text-neutral-300">
                <X size={ICON.xs} />
              </button>
            )}
          </div>
          {pendingDrillPoints.length === 0 && (
            <p className="text-label text-gray-400 dark:text-neutral-500 mt-1">Click on canvas to place drill points.</p>
          )}
          {isDrillToolSelected && (
            <p className="text-label text-amber-400 mt-1 flex items-center gap-1">
              <AlertCircle size={ICON.xs} /> Peck drilling with an end mill — ensure the tool is suitable.
            </p>
          )}
        </div>
      )}

      {/* Helical: show circle info */}
      {form.drillMode === 'helical' && (
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Source Circle</label>
          {circleInfo ? (
            <div className="text-body text-gray-800 dark:text-neutral-200 bg-gray-100 dark:bg-neutral-800 rounded px-2 py-1 space-y-0.5">
              <div>Center: ({circleInfo.cx.toFixed(1)}, {circleInfo.cy.toFixed(1)}) mm</div>
              <div>Hole Ø: {(circleInfo.radiusMM * 2).toFixed(2)} mm</div>
              {helicalRadius !== null && helicalRadius > 0 && (
                <div className="text-gray-500 dark:text-neutral-400">Tool path Ø: {(helicalRadius * 2).toFixed(2)} mm</div>
              )}
              {helicalRadius !== null && helicalRadius <= 0 && (
                <div className="text-amber-400">Tool is wider than hole — will center-drill instead.</div>
              )}
            </div>
          ) : (
            <p className="text-body text-amber-400 flex items-center gap-1">
              <AlertCircle size={ICON.sm} /> Select a circular path first
            </p>
          )}
          {isDrillToolSelected && (
            <p className="text-label text-amber-400 mt-1 flex items-center gap-1">
              <AlertCircle size={ICON.xs} /> Drill bits cannot do helical drilling — use an end mill.
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
    <div className="border border-gray-200 dark:border-neutral-600 rounded-lg mx-3 mt-3 mb-2 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-gray-100 dark:bg-neutral-800 border-b border-gray-200 dark:border-neutral-600">
        <span className="text-body font-semibold text-gray-700 dark:text-neutral-300">{title}</span>
        <button onClick={onClose} className="text-gray-400 dark:text-neutral-500 hover:text-gray-700 dark:hover:text-neutral-300 text-sm leading-none">✕</button>
      </div>
      <div className="p-3 space-y-2.5">{children}</div>
    </div>
  )
}

function PathChip({ path, label }: { path: ImportedPath; label: string }) {
  return (
    <div className="text-body text-gray-800 dark:text-neutral-200 bg-gray-100 dark:bg-neutral-800 rounded px-2 py-1 flex items-center gap-1.5">
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: path.color }} />
      {path.name}
      <span className="text-gray-400 dark:text-neutral-500">({label})</span>
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
      <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Tool</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500"
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
      <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">{label}</label>
      <div className="flex gap-1">
        {options.map((o) => (
          <button key={o} onClick={() => onChange(o)}
            className={[
              'flex-1 py-1 text-body rounded border transition-colors capitalize',
              value === o
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-gray-50 dark:bg-neutral-900 border-gray-300 dark:border-neutral-700 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200',
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
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">{lbl}</label>
          <div className="flex items-center gap-1">
            <input type="number" value={val} min={0.01} step={0.5}
              onChange={(e) => fn(parseFloat(e.target.value) || 0)}
              className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
            />
            <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function GenerateBtn({ disabled, generating, onClick }: { disabled: boolean; generating: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="w-full py-1.5 rounded text-body font-medium bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5">
      {generating && <Loader2 size={ICON.sm} className="animate-spin" />}
      {generating ? 'Generating…' : 'Generate Toolpath'}
    </button>
  )
}

// ─── V-Carve form ────────────────────────────────────────────────────────────

interface VCarveFormState {
  toolId: string
  angleDeg: number
  maxDepthMM: number
}

function VCarveForm({ onClose }: { onClose: () => void }) {
  const { tools } = useToolStore()
  const { paths, selectedIds, pushHistoryBoth } = usePathsStore()
  const { addOperation, setSegments, setError, updateOperation } = useToolpathStore()

  const vbits = tools.filter((t) => t.type === 'vbit')
  const defaultTool = vbits[0] ?? tools[0]
  const [form, setForm] = useState<VCarveFormState>({
    toolId: defaultTool?.id ?? '',
    angleDeg: defaultTool?.vbitAngleDeg ?? 60,
    maxDepthMM: defaultTool?.maxDepthMM ?? 10,
  })
  const [generating, setGenerating] = useState(false)

  const selectedPaths = paths.filter((p) => selectedIds.includes(p.id))
  const groups = groupPathsByContainment(selectedPaths)
  const selectedTool = tools.find((t) => t.id === form.toolId)

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, maxDepthMM: t.maxDepthMM, angleDeg: t.vbitAngleDeg ?? f.angleDeg }))
  }

  function up<K extends keyof VCarveFormState>(k: K, v: VCarveFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleGenerate() {
    if (groups.length === 0 || !selectedTool) return
    pushHistoryBoth()
    setGenerating(true)
    setTimeout(async () => {
      for (const { boundary, islands } of groups) {
        const opId = addOperation({
          name: `V-Carve: ${boundary.name} (${selectedTool.name})`,
          type: 'vcarve',
          toolId: form.toolId,
          pathId: boundary.id,
          islandIds: islands.map((p) => p.id),
          maxDepthMM: form.maxDepthMM,
          angleDeg: form.angleDeg,
        })
        updateOperation(opId, { status: 'generating' })
        try {
          setSegments(opId, await generateVCarve(boundary.d, selectedTool, {
            angleDeg: form.angleDeg,
            maxDepthMM: form.maxDepthMM,
            islandDs: islands.map((p) => p.d),
          }))
        } catch (err) {
          setError(opId, err instanceof Error ? err.message : 'Generation failed')
        }
      }
      setGenerating(false)
      onClose()
    }, 0)
  }

  return (
    <FormShell title="New V-Carve Operation" onClose={onClose}>
      {groups.length === 0 ? (
        <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> Select a closed path first</p>
      ) : (
        <div className="space-y-1">
          {groups.map(({ boundary, islands }, i) => (
            <div key={boundary.id}>
              {groups.length > 1 && (
                <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Shape {i + 1}</label>
              )}
              <div className="space-y-0.5">
                <PathChip path={boundary} label="boundary" />
                {islands.map((p) => <PathChip key={p.id} path={p} label="island" />)}
              </div>
            </div>
          ))}
        </div>
      )}
      <ToolSelector tools={vbits.length > 0 ? vbits : tools} value={form.toolId} onChange={handleToolChange} />
      {selectedTool?.type !== 'vbit' && (
        <p className="text-label text-amber-400 flex items-center gap-1">
          <AlertCircle size={ICON.xs} /> V-carve requires a V-bit tool.
        </p>
      )}
      {/* V-bit angle */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          V-Bit Angle <span className="text-gray-500 dark:text-neutral-400 normal-case">{form.angleDeg}°</span>
        </label>
        <input
          type="range" min={10} max={120} step={5}
          value={form.angleDeg}
          onChange={(e) => up('angleDeg', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
        <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">Full included angle of the V-bit.</p>
      </div>
      {/* Max depth */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Max Depth</label>
        <div className="flex items-center gap-1">
          <input type="number" value={form.maxDepthMM} min={0.1} step={0.5}
            onChange={(e) => up('maxDepthMM', parseFloat(e.target.value) || 0)}
            className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
          />
          <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
        </div>
        <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">
          Bit cuts at most {((form.maxDepthMM) * Math.tan((form.angleDeg / 2) * Math.PI / 180) * 2).toFixed(2)} mm wide at full depth.
        </p>
      </div>
      <GenerateBtn
        disabled={groups.length === 0 || !selectedTool || generating || form.maxDepthMM <= 0 || selectedTool.type !== 'vbit'}
        generating={generating}
        onClick={handleGenerate}
      />
    </FormShell>
  )
}

// ─── Inlay form ───────────────────────────────────────────────────────────────

interface InlayFormState {
  vbitToolId: string
  pocketToolId: string
  angleDeg: number
  pocketDepthMM: number
  stepDownMM: number
  stepoverPercent: number
  glueLineMM: number
  clearanceMM: number
}

function InlayForm({ onClose }: { onClose: () => void }) {
  const { tools } = useToolStore()
  const { paths, selectedIds, pushHistoryBoth } = usePathsStore()
  const { addOperation, setSegments, setError, updateOperation } = useToolpathStore()

  const vbits = tools.filter((t) => t.type === 'vbit')
  const endmills = tools.filter((t) => t.type === 'endmill' || t.type === 'ballnose')
  const defaultVbit = vbits[0] ?? tools[0]
  const defaultEndmill = endmills[0] ?? tools[0]

  const [form, setForm] = useState<InlayFormState>({
    vbitToolId: defaultVbit?.id ?? '',
    pocketToolId: defaultEndmill?.id ?? '',
    angleDeg: defaultVbit?.vbitAngleDeg ?? 60,
    pocketDepthMM: 5,
    stepDownMM: defaultEndmill?.stepDownMM ?? 3,
    stepoverPercent: 40,
    glueLineMM: 0.2,
    clearanceMM: 0.1,
  })
  const [generating, setGenerating] = useState(false)

  const vbitTool = tools.find((t) => t.id === form.vbitToolId)
  const pocketTool = tools.find((t) => t.id === form.pocketToolId)
  const boundaryPath = paths.find((p) => p.id === selectedIds[0])
  const islandPaths = paths.filter((p) => selectedIds.slice(1).includes(p.id))

  function up<K extends keyof InlayFormState>(k: K, v: InlayFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleGenerate() {
    if (!boundaryPath || !vbitTool || !pocketTool) return
    pushHistoryBoth()
    setGenerating(true)

    const islandIds = islandPaths.map((p) => p.id)
    const islandDs = islandPaths.map((p) => p.d)
    const inlayParams = {
      angleDeg: form.angleDeg,
      pocketDepthMM: form.pocketDepthMM,
      stepDownMM: form.stepDownMM,
      stepoverPercent: form.stepoverPercent,
      glueLineMM: form.glueLineMM,
      clearanceMM: form.clearanceMM,
      islandDs,
    }

    const femaleId = addOperation({
      name: `Inlay Female: ${boundaryPath.name}`,
      type: 'inlay',
      role: 'female',
      toolId: form.vbitToolId,
      pathId: boundaryPath.id,
      islandIds,
      pocketToolId: form.pocketToolId,
      angleDeg: form.angleDeg,
      pocketDepthMM: form.pocketDepthMM,
      stepDownMM: form.stepDownMM,
      stepoverPercent: form.stepoverPercent,
      glueLineMM: form.glueLineMM,
      clearanceMM: form.clearanceMM,
    })
    const maleId = addOperation({
      name: `Inlay Male: ${boundaryPath.name}`,
      type: 'inlay',
      role: 'male',
      toolId: form.vbitToolId,
      pathId: boundaryPath.id,
      islandIds,
      pocketToolId: form.pocketToolId,
      angleDeg: form.angleDeg,
      pocketDepthMM: form.pocketDepthMM,
      stepDownMM: form.stepDownMM,
      stepoverPercent: form.stepoverPercent,
      glueLineMM: form.glueLineMM,
      clearanceMM: form.clearanceMM,
    })
    updateOperation(femaleId, { status: 'generating' })
    updateOperation(maleId, { status: 'generating' })

    setTimeout(async () => {
      try {
        setSegments(femaleId, await generateInlayFemale(boundaryPath.d, pocketTool, vbitTool, inlayParams))
      } catch (err) {
        setError(femaleId, err instanceof Error ? err.message : 'Generation failed')
      }
      try {
        setSegments(maleId, await generateInlayMale(boundaryPath.d, pocketTool, vbitTool, inlayParams))
      } catch (err) {
        setError(maleId, err instanceof Error ? err.message : 'Generation failed')
      }
      setGenerating(false)
      onClose()
    }, 0)
  }

  const canGenerate = !!boundaryPath && !!vbitTool && !!pocketTool && !generating &&
    form.pocketDepthMM > 0 && vbitTool.type === 'vbit'

  return (
    <FormShell title="New Inlay Operation" onClose={onClose}>
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Path</label>
        {boundaryPath ? (
          <PathChip path={boundaryPath} label="inlay shape" />
        ) : (
          <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> Select a closed path first</p>
        )}
      </div>
      {islandPaths.length > 0 && (
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Islands</label>
          <div className="space-y-0.5">
            {islandPaths.map((p) => <PathChip key={p.id} path={p} label="island" />)}
          </div>
        </div>
      )}
      {/* V-bit */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">V-Bit (Finishing)</label>
        <select
          value={form.vbitToolId}
          onChange={(e) => up('vbitToolId', e.target.value)}
          className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500"
        >
          {(vbits.length > 0 ? vbits : tools).map((t) => (
            <option key={t.id} value={t.id}>{t.name} (Ø{t.diameterMM}mm)</option>
          ))}
        </select>
        {vbitTool?.type !== 'vbit' && (
          <p className="text-label text-amber-400 mt-0.5 flex items-center gap-1">
            <AlertCircle size={ICON.xs} /> Select a V-bit tool.
          </p>
        )}
      </div>
      {/* Pocket tool */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">End Mill (Roughing / Profile)</label>
        <select
          value={form.pocketToolId}
          onChange={(e) => {
            const t = tools.find((x) => x.id === e.target.value)
            if (t) up('stepDownMM', t.stepDownMM)
            up('pocketToolId', e.target.value)
          }}
          className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500"
        >
          {(endmills.length > 0 ? endmills : tools).map((t) => (
            <option key={t.id} value={t.id}>{t.name} (Ø{t.diameterMM}mm)</option>
          ))}
        </select>
      </div>
      {/* V-bit angle */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          V-Bit Angle <span className="text-gray-500 dark:text-neutral-400 normal-case">{form.angleDeg}°</span>
        </label>
        <input type="range" min={10} max={120} step={5} value={form.angleDeg}
          onChange={(e) => up('angleDeg', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>
      {/* Depth */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Inlay Depth</label>
          <div className="flex items-center gap-1">
            <input type="number" value={form.pocketDepthMM} min={0.5} step={0.5}
              onChange={(e) => up('pocketDepthMM', parseFloat(e.target.value) || 0)}
              className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
            />
            <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
          </div>
        </div>
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Step Down</label>
          <div className="flex items-center gap-1">
            <input type="number" value={form.stepDownMM} min={0.1} step={0.5}
              onChange={(e) => up('stepDownMM', parseFloat(e.target.value) || 0)}
              className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
            />
            <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
          </div>
        </div>
      </div>
      {/* Stepover */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          Stepover <span className="text-gray-500 dark:text-neutral-400 normal-case">{form.stepoverPercent}%</span>
        </label>
        <input type="range" min={10} max={90} step={5} value={form.stepoverPercent}
          onChange={(e) => up('stepoverPercent', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>
      {/* Glue + clearance */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Glue Gap</label>
          <div className="flex items-center gap-1">
            <input type="number" value={form.glueLineMM} min={0} step={0.05}
              onChange={(e) => up('glueLineMM', parseFloat(e.target.value) || 0)}
              className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
            />
            <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
          </div>
        </div>
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Clearance</label>
          <div className="flex items-center gap-1">
            <input type="number" value={form.clearanceMM} min={0} step={0.05}
              onChange={(e) => up('clearanceMM', parseFloat(e.target.value) || 0)}
              className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
            />
            <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
          </div>
        </div>
      </div>
      <p className="text-label text-gray-400 dark:text-neutral-500">
        Generates Female (socket) + Male (plug) operations. Machine each on separate stock.
      </p>
      <GenerateBtn disabled={!canGenerate} generating={generating} onClick={handleGenerate} />
    </FormShell>
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
  const { pushHistoryBoth } = usePathsStore()
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
    pushHistoryBoth()
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
      <div className="text-label text-gray-400 dark:text-neutral-500 bg-gray-50 dark:bg-neutral-900 rounded px-2 py-1.5">
        Covers workpiece: {widthMM} × {heightMM} mm
      </div>
      <ToolSelector
        tools={endMills.length > 0 ? endMills : tools}
        value={form.toolId}
        onChange={handleToolChange}
      />
      {/* Stepover */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          Stepover <span className="text-gray-500 dark:text-neutral-400 normal-case">{form.stepoverPercent}%</span>
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
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          Pass Angle <span className="text-gray-500 dark:text-neutral-400 normal-case">{form.passAngleDeg}°</span>
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

type OpType = 'profile' | 'pocket' | 'drill' | 'surface' | 'vcarve' | 'inlay'
type FormState = null | 'menu' | OpType

function AddOperationMenu({ onSelect }: { onSelect: (t: OpType) => void }) {
  return (
    <div className="mx-3 mt-3 mb-2">
      <div className="p-2 grid grid-cols-3 gap-1.5">
        {([
          ['profile', 'Profile', 'Cut along path edge', <Circle size={ICON.md} />],
          ['pocket', 'Pocket', 'Clear inside boundary', <Target size={ICON.md} />],
          ['drill', 'Drill', 'Peck or helical drill', <CircleDot size={ICON.md} />],
          ['surface', 'Surface', 'Flatten workpiece top', <Layers size={ICON.md} />],
          ['vcarve', 'V-Carve', 'V-bit depth-varying carve', <Star size={ICON.md} />],
          //['inlay', 'Inlay', 'Female socket + male plug', <Package size={ICON.md} />],
        ] as [OpType, string, string, React.ReactNode][]).map(([type, name, desc, icon]) => (
          <button key={type} onClick={() => onSelect(type)}
            title={desc}
            className="flex flex-col items-center gap-1 px-2 py-2.5 rounded border border-gray-200 dark:border-neutral-600 bg-gray-50 dark:bg-neutral-900 hover:bg-gray-100 dark:hover:bg-neutral-800 text-gray-500 dark:text-neutral-400 hover:text-white transition-colors">
            <span className="text-body font-medium">{name}</span>
            {icon}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export default function MachinePanel() {
  const { operations, deleteOperation, toggleVisibility, moveOperation } = useToolpathStore()
  const { pushHistoryBoth } = usePathsStore()
  const { tools } = useToolStore()
  const [activeForm, setActiveForm] = useState<FormState>('menu')

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
    if (op.type === 'vcarve') return `${toolName} · ${op.angleDeg}° · max ${op.maxDepthMM}mm`
    if (op.type === 'inlay') {
      const pocketTool = tools.find((t) => t.id === op.pocketToolId)
      return `${toolName} + ${pocketTool?.name ?? '?'} · ${op.angleDeg}° · ${op.pocketDepthMM}mm · ${op.role}`
    }
    return toolName
  }

  const closeForm = () => setActiveForm('menu')

  return (
    <div className="flex flex-col h-full">
      {/* Form area */}
      {activeForm === 'menu' ? (
        <AddOperationMenu onSelect={(t) => setActiveForm(t)} />
      ) : activeForm === 'profile' ? (
        <ProfileForm onClose={closeForm} />
      ) : activeForm === 'pocket' ? (
        <PocketForm onClose={closeForm} />
      ) : activeForm === 'drill' ? (
        <DrillForm onClose={closeForm} />
      ) : activeForm === 'surface' ? (
        <SurfaceForm onClose={closeForm} />
      ) : activeForm === 'vcarve' ? (
        <VCarveForm onClose={closeForm} />
      ) : activeForm === 'inlay' ? (
        <InlayForm onClose={closeForm} />
      ) : null}

      {/* Operations list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {operations.length === 0 ? (
          <div className="px-3 py-6 text-body text-gray-400 dark:text-neutral-500 text-center">
            <Cpu size={ICON.lg} className="mx-auto mb-2 opacity-30" />
            No operations yet.
          </div>
        ) : (
          <ul className="space-y-1">
            {operations.map((op) => (
              <li key={op.id} className="rounded border border-gray-200 dark:border-neutral-700 bg-gray-50/50 dark:bg-neutral-900/50 overflow-hidden">
                <div className="flex items-center gap-1.5 px-2 py-2">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: op.color }} />
                  {STATUS_ICON[op.status]}
                  <span className="flex-1 text-body text-gray-800 dark:text-neutral-200 truncate min-w-0" title={op.name}>{op.name}</span>
                  <button title="Move up" onClick={() => moveOperation(op.id, 'up')}
                    className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-neutral-700 text-gray-400 dark:text-neutral-500 hover:text-gray-700 dark:hover:text-neutral-300">
                    <ChevronUp size={ICON.sm} />
                  </button>
                  <button title="Move down" onClick={() => moveOperation(op.id, 'down')}
                    className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-neutral-700 text-gray-400 dark:text-neutral-500 hover:text-gray-700 dark:hover:text-neutral-300">
                    <ChevronDown size={ICON.sm} />
                  </button>
                  <button title={op.visible ? 'Hide' : 'Show'} onClick={() => toggleVisibility(op.id)}
                    className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-neutral-700 text-gray-400 dark:text-neutral-500 hover:text-gray-700 dark:hover:text-neutral-300">
                    {op.visible ? <Eye size={ICON.sm} /> : <EyeOff size={ICON.sm} />}
                  </button>
                  <button title="Delete" onClick={() => { pushHistoryBoth(); deleteOperation(op.id) }}
                    className="p-0.5 rounded hover:bg-red-900/30 text-gray-400 dark:text-neutral-500 hover:text-red-400">
                    <Trash2 size={ICON.sm} />
                  </button>
                </div>
                <div className="px-2 pb-1.5 flex items-center gap-2">
                  <span className="text-label text-gray-400 dark:text-neutral-500 flex-1 capitalize">{op.type} · {opDescription(op)}</span>
                  {(op.status === 'needs-update' || op.status === 'error') && (
                    <button onClick={() => handleRegenerate(op.id)} className="text-label text-blue-400 hover:text-blue-300">
                      Regenerate
                    </button>
                  )}
                </div>
                {op.status === 'error' && op.errorMessage && (
                  <p className="px-2 pb-1.5 text-label text-red-400">{op.errorMessage}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
