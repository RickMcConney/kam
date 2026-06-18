import { useState, useEffect } from 'react'
import { NumericInput } from '../components/NumericInput'
import { OP_TYPE_COLORS } from '../colors'
import { ICON } from '../theme'
import {
  AlertCircle, Loader2, Trash2,
  X, Circle, CircleDot, Target, Layers,
  Star, SquaresUnite, SquareSquare, LayoutGrid, RectangleEllipsis, VectorSquare, Box, RefreshCw,
} from 'lucide-react'
import { useToolStore, type Tool, type CuttingDirection } from '../store/toolStore'
import { useToolpathStore, INLAY_NO_FINISH, type CutSide, type AnyOperation, type ProfileOperation, type PocketOperation, type DrillOperation, type SurfaceOperation, type VCarveOperation, type InlayOperation, type Profile3dOperation, type TrochoidalOperation } from '../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../store/formDefaultsStore'
import { usePathsStore } from '../store/pathsStore'
import { useWorkpieceStore, fromMM, toMM } from '../store/workpieceStore'
import { applyBooleanOp, type BooleanOpType } from '../tools/booleanOps'
import { applyOffset, type OffsetCornerStyle } from '../tools/offsetOp'
import { applyCornerTreatment, type CornerTreatmentType } from '../tools/cornerTreatment'
import { computePatternInstances, applyPatternInstance } from '../tools/patternOp'
import { nextPathColor } from '../importers/svgImporter'
import { useTabStore } from '../store/tabStore'
import { regenerateAffected } from '../cam/regenerate'
import { runInWorker } from '../workers/workerClient'
import { useUIStore } from '../store/uiStore'
import { flattenPath } from '../cam/pathFlattener'
import { type PocketStrategy } from '../cam/pocket'
import { generatePeckDrill, generateHelicalDrill } from '../cam/drill'
import { generateSurface } from '../cam/surfacing'
import { effectiveStepDownMM, trochoidalEngagementFraction } from '../cam/feeds'
import { parseStlGeometry, base64ToArrayBuffer } from '../importers/stlImporter'
import { getBBox, extractCircle } from '../canvas/selectionUtils'
import type { ImportedPath } from '../store/pathsStore'

const InlayIcon = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 1h20a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-6v2H8V8H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z" />
    <path d="M2 14h6v2h8v-2h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" />
  </svg>
)

// ─── Helpers ─────────────────────────────────────────────────────────────────

const flattenCache = new Map<string, [number, number][]>()
function flattenCached(d: string): [number, number][] {
  if (!flattenCache.has(d)) {
    const pts = flattenPath(d, 0.1)
    flattenCache.set(d, (pts[0] ?? []) as [number, number][])
  }
  return flattenCache.get(d)!
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

  function getPoly(p: ImportedPath): [number, number][] {
    return flattenCached(p.d)
  }

  // For each path find its smallest (most direct) containing path among the selection
  const parentId = new Map<string, string>()
  for (const inner of selectedPaths) {
    const poly = getPoly(inner)
    if (poly.length < 1) continue
    const px = poly.reduce((s, p) => s + p[0], 0) / poly.length
    const py = poly.reduce((s, p) => s + p[1], 0) / poly.length
    for (const outer of selectedPaths) {
      if (outer.id === inner.id) continue
      const outerPoly = getPoly(outer)
      if (outerPoly.length < 3) continue
      if (!ptInPoly(px, py, outerPoly)) continue
      // Require inner's bbox to fit entirely within outer's bbox.
      // Overlapping (non-nested) shapes each extend beyond the other's bbox, so
      // neither qualifies as a child and no cycle is created.
      const innerBBox = getBBox(inner.d)
      const outerBBox = getBBox(outer.d)
      if (!innerBBox || !outerBBox ||
          innerBBox.minX < outerBBox.minX || innerBBox.maxX > outerBBox.maxX ||
          innerBBox.minY < outerBBox.minY || innerBBox.maxY > outerBBox.maxY) continue
      // Prefer the smallest container (direct parent over grandparent)
      const existing = parentId.get(inner.id)
      if (!existing) {
        parentId.set(inner.id, outer.id)
      } else {
        const bCur = getBBox(selectedPaths.find(p => p.id === existing)!.d)
        const bNew = getBBox(outer.d)
        if (bCur && bNew) {
          const curw = bCur.maxX - bCur.minX;
          const curh = bCur.maxY - bCur.minY;
          const neww = bNew.maxX - bNew.minX;
          const newh = bNew.maxY - bNew.minY;
          if (neww * newh < curw * curh) parentId.set(inner.id, outer.id)
        }
      }
    }
  }

  const boundaries = selectedPaths.filter(p => !parentId.has(p.id))
  return boundaries.map(b => ({
    boundary: b,
    islands: selectedPaths.filter(p => parentId.get(p.id) === b.id),
  }))
}


// ─── Profile form ─────────────────────────────────────────────────────────────

interface ProfileFormState {
  toolId: string
  side: CutSide
  depthMM: number
  stepDownMM: number
  direction: CuttingDirection
  rampIn: boolean
}

export function ProfileForm({ onClose, editOp }: { onClose: () => void; editOp?: ProfileOperation }) {
  const { tools } = useToolStore()
  const { paths, selectedIds, pushHistoryBoth } = usePathsStore()
  const { addOperation, setSegments, setError, updateOperation, deleteOperation } = useToolpathStore()
  const { load, save } = useFormDefaultsStore()
  const { safeHeightMM, thicknessMM } = useWorkpieceStore()

  const defaultTool = tools[0]
  const [form, setForm] = useState<ProfileFormState>(() => editOp ? {
    toolId: editOp.toolId, side: editOp.side, depthMM: editOp.depthMM,
    stepDownMM: editOp.stepDownMM, direction: editOp.direction, rampIn: editOp.rampIn ?? false,
  } : mergeWithDefaults(load('profile'), {
    toolId: defaultTool?.id ?? '',
    side: 'outside' as CutSide,
    // A profile typically cuts the part free, so default to the full stock
    // thickness rather than the tool's max flute depth.
    depthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    stepDownMM: defaultTool?.stepDownMM ?? 3,
    direction: (defaultTool?.direction ?? 'climb') as CuttingDirection,
    rampIn: false,
  }, tools))
  const [generating, setGenerating] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const selectedPaths = editOp
    ? paths.filter((p) => p.id === editOp.pathId)
    : paths.filter((p) => selectedIds.includes(p.id))
  const selectedTool = tools.find((t) => t.id === form.toolId)

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, stepDownMM: t.stepDownMM, direction: t.direction }))
  }

  function up<K extends keyof ProfileFormState>(k: K, v: ProfileFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function handleGenerate() {
    if (selectedPaths.length === 0 || !selectedTool) return
    const tool = selectedTool
    pushHistoryBoth()
    setGenerating(true)
    setErrorMsg(null)
    let failed = false
    try {
      if (editOp) {
        updateOperation(editOp.id, {
          toolId: form.toolId, side: form.side, depthMM: form.depthMM,
          stepDownMM: form.stepDownMM, direction: form.direction, rampIn: form.rampIn, status: 'generating',
        } as Partial<AnyOperation>)
        try {
          setSegments(editOp.id, await runInWorker('generateProfile', selectedPaths[0].d, tool, {
            side: form.side, depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(tool, form.stepDownMM, form.depthMM),
            direction: form.direction, rampIn: form.rampIn, safeHeightMM,
          }))
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Generation failed'
          setError(editOp.id, msg)
          setErrorMsg(msg)
          failed = true
        }
      } else {
        for (const path of selectedPaths) {
          const opId = addOperation({
            name: `Profile: ${path.name} (${tool.name})`,
            type: 'profile',
            toolId: form.toolId,
            pathId: path.id,
            side: form.side,
            depthMM: form.depthMM,
            stepDownMM: form.stepDownMM,
            direction: form.direction,
            rampIn: form.rampIn,
          })
          updateOperation(opId, { status: 'generating' })
          try {
            setSegments(opId, await runInWorker('generateProfile', path.d, tool, {
              side: form.side, depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(tool, form.stepDownMM, form.depthMM),
              direction: form.direction, rampIn: form.rampIn, safeHeightMM,
            }))
          } catch (err) {
            deleteOperation(opId)
            setErrorMsg(err instanceof Error ? err.message : 'Generation failed')
            failed = true
          }
        }
      }
    } finally {
      setGenerating(false)
      if (!failed) { save('profile', form) }
    }
  }

  return (
    <FormShell title={editOp ? 'Edit Profile' : 'New Profile Operation'} onClose={onClose}>
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          Paths {!editOp && selectedPaths.length > 1 && <span className="normal-case text-gray-500 dark:text-neutral-400">({selectedPaths.length} selected — one operation each)</span>}
        </label>
        {selectedPaths.length > 0 ? (
          <div className="space-y-0.5">
            {selectedPaths.map((p) => <PathChip key={p.id} path={p} label="selected" />)}
          </div>
        ) : (
          <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> {editOp ? 'Path not found' : 'Select a path on the canvas first'}</p>
        )}
      </div>
      <ToolSelector tools={tools} value={form.toolId} onChange={handleToolChange} />
      <ToggleRow label="Cut Side" options={['inside', 'outside', 'centerline'] as CutSide[]} value={form.side} onChange={(v) => up('side', v)} />
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)}
        maxDepthMM={selectedTool?.maxDepthMM} tool={selectedTool} />
      <ToggleRow label="Direction" options={['climb', 'conventional'] as CuttingDirection[]} value={form.direction} onChange={(v) => up('direction', v)} />
      <div className="flex items-center gap-2">
        <input type="checkbox" id="profile-ramp-in" checked={form.rampIn}
          onChange={(e) => up('rampIn', e.target.checked)} className="accent-blue-500" />
        <label htmlFor="profile-ramp-in" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
          Ramp In <span className="text-gray-500 dark:text-neutral-500 normal-case">(2× dia, 50% feed)</span>
        </label>
      </div>
      {errorMsg && (
        <p className="text-body text-red-400 flex items-start gap-1.5">
          <AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{errorMsg}
        </p>
      )}
      <GenerateBtn
        disabled={selectedPaths.length === 0 || !selectedTool || generating || form.depthMM <= 0}
        generating={generating}
        onClick={handleGenerate}
        label={editOp ? 'Regenerate Toolpath' : 'Generate Toolpath'}
      />
    </FormShell>
  )
}

// ─── Trochoidal form ──────────────────────────────────────────────────────────

interface TrochoidalFormState {
  toolId: string
  side: CutSide
  depthMM: number
  stepDownMM: number
  direction: CuttingDirection
  trochStepMM: number
  trochRadiusMM: number
  finishingPass: boolean
  rampIn: boolean
}

export function TrochoidalForm({ onClose, editOp }: { onClose: () => void; editOp?: TrochoidalOperation }) {
  const { tools } = useToolStore()
  const { paths, selectedIds, pushHistoryBoth } = usePathsStore()
  const { addOperation, setSegments, setError, updateOperation, deleteOperation } = useToolpathStore()
  const { load, save } = useFormDefaultsStore()
  const { safeHeightMM, thicknessMM } = useWorkpieceStore()

  const defaultTool = tools[0]
  const [form, setForm] = useState<TrochoidalFormState>(() => editOp ? {
    toolId: editOp.toolId, side: editOp.side, depthMM: editOp.depthMM,
    stepDownMM: editOp.stepDownMM, direction: editOp.direction,
    trochStepMM: editOp.trochStepMM, trochRadiusMM: editOp.trochRadiusMM,
    finishingPass: editOp.finishingPass, rampIn: editOp.rampIn ?? false,
  } : mergeWithDefaults(load('trochoidal'), {
    toolId: defaultTool?.id ?? '',
    side: 'outside' as CutSide,
    // Default to the full stock thickness; the tool's max Z is only a warning.
    depthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    stepDownMM: defaultTool?.stepDownMM ?? 3,
    direction: (defaultTool?.direction ?? 'climb') as CuttingDirection,
    trochStepMM: (defaultTool?.diameterMM ?? 6) * 0.15,
    trochRadiusMM: (defaultTool?.diameterMM ?? 6) * 0.5,
    finishingPass: true,
    rampIn: false,
  }, tools))
  const [generating, setGenerating] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const selectedPaths = editOp
    ? paths.filter((p) => p.id === editOp.pathId)
    : paths.filter((p) => selectedIds.includes(p.id))
  const selectedTool = tools.find((t) => t.id === form.toolId)

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({
      ...f, toolId,
      stepDownMM: t.stepDownMM,
      direction: t.direction,
      trochStepMM: parseFloat((t.diameterMM * 0.15).toFixed(3)),
      trochRadiusMM: parseFloat((t.diameterMM * 0.5).toFixed(3)),
    }))
  }

  function up<K extends keyof TrochoidalFormState>(k: K, v: TrochoidalFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function handleGenerate() {
    if (selectedPaths.length === 0 || !selectedTool) return
    const tool = selectedTool
    pushHistoryBoth()
    setGenerating(true)
    setErrorMsg(null)
    let failed = false
    try {
      if (editOp) {
        updateOperation(editOp.id, {
          toolId: form.toolId, side: form.side, depthMM: form.depthMM,
          stepDownMM: form.stepDownMM, direction: form.direction,
          trochStepMM: form.trochStepMM, trochRadiusMM: form.trochRadiusMM,
          finishingPass: form.finishingPass, rampIn: form.rampIn, status: 'generating',
        } as Partial<AnyOperation>)
        try {
          setSegments(editOp.id, await runInWorker('generateTrochoidal', selectedPaths[0].d, tool, {
            side: form.side, depthMM: form.depthMM,
            stepDownMM: effectiveStepDownMM(tool, form.stepDownMM, form.depthMM, trochoidalEngagementFraction(tool, form.trochStepMM)),
            direction: form.direction, trochStepMM: form.trochStepMM,
            trochRadiusMM: form.trochRadiusMM, finishingPass: form.finishingPass,
            rampIn: form.rampIn, safeHeightMM,
          }))
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Generation failed'
          setError(editOp.id, msg)
          setErrorMsg(msg)
          failed = true
        }
      } else {
        for (const path of selectedPaths) {
          const opId = addOperation({
            name: `Trochoidal: ${path.name} (${tool.name})`,
            type: 'trochoidal',
            toolId: form.toolId,
            pathId: path.id,
            side: form.side,
            depthMM: form.depthMM,
            stepDownMM: form.stepDownMM,
            direction: form.direction,
            trochStepMM: form.trochStepMM,
            trochRadiusMM: form.trochRadiusMM,
            finishingPass: form.finishingPass,
            rampIn: form.rampIn,
          })
          updateOperation(opId, { status: 'generating' })
          try {
            setSegments(opId, await runInWorker('generateTrochoidal', path.d, tool, {
              side: form.side, depthMM: form.depthMM,
              stepDownMM: effectiveStepDownMM(tool, form.stepDownMM, form.depthMM, trochoidalEngagementFraction(tool, form.trochStepMM)),
              direction: form.direction, trochStepMM: form.trochStepMM,
              trochRadiusMM: form.trochRadiusMM, finishingPass: form.finishingPass,
              rampIn: form.rampIn, safeHeightMM,
            }))
          } catch (err) {
            deleteOperation(opId)
            setErrorMsg(err instanceof Error ? err.message : 'Generation failed')
            failed = true
          }
        }
      }
    } finally {
      setGenerating(false)
      if (!failed) { save('trochoidal', form) }
    }
  }

  return (
    <FormShell title={editOp ? 'Edit Trochoidal' : 'New Trochoidal Operation'} onClose={onClose}>
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          Paths {!editOp && selectedPaths.length > 1 && <span className="normal-case text-gray-500 dark:text-neutral-400">({selectedPaths.length} selected — one operation each)</span>}
        </label>
        {selectedPaths.length > 0 ? (
          <div className="space-y-0.5">
            {selectedPaths.map((p) => <PathChip key={p.id} path={p} label="selected" />)}
          </div>
        ) : (
          <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> {editOp ? 'Path not found' : 'Select a path on the canvas first'}</p>
        )}
      </div>
      <ToolSelector tools={tools} value={form.toolId} onChange={handleToolChange} />
      <ToggleRow label="Cut Side" options={['inside', 'outside', 'centerline'] as CutSide[]} value={form.side} onChange={(v) => up('side', v)} />
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)}
        maxDepthMM={selectedTool?.maxDepthMM} tool={selectedTool}
        engagementFraction={selectedTool ? trochoidalEngagementFraction(selectedTool, form.trochStepMM) : undefined} />
      <ToggleRow label="Direction" options={['climb', 'conventional'] as CuttingDirection[]} value={form.direction} onChange={(v) => up('direction', v)} />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Loop Amplitude</label>
          <div className="flex items-center gap-1">
            <NumericInput value={form.trochRadiusMM} min={0.1} step={0.1}
              onChange={(v) => up('trochRadiusMM', v)}
              className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
            />
            <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
          </div>
        </div>
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Step / Loop</label>
          <div className="flex items-center gap-1">
            <NumericInput value={form.trochStepMM} min={0.01} step={0.05}
              onChange={(v) => up('trochStepMM', v)}
              className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
            />
            <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
          </div>
        </div>
      </div>
      <p className="text-label text-gray-400 dark:text-neutral-500 -mt-1">
        Cuts {(form.trochRadiusMM * 2).toFixed(2)} mm wide · {selectedTool ? Math.round(form.trochStepMM / selectedTool.diameterMM * 100) : '—'}% tool dia per loop
      </p>
      <div className="flex items-center gap-2">
        <input type="checkbox" id="troch-ramp-in" checked={form.rampIn}
          onChange={(e) => up('rampIn', e.target.checked)} className="accent-blue-500" />
        <label htmlFor="troch-ramp-in" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
          Ramp In <span className="text-gray-500 dark:text-neutral-500 normal-case">(spiral down over 2× dia, 50% feed)</span>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <input type="checkbox" id="troch-finishing" checked={form.finishingPass}
          onChange={(e) => up('finishingPass', e.target.checked)} className="accent-blue-500" />
        <label htmlFor="troch-finishing" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
          Finishing pass <span className="text-gray-500 dark:text-neutral-500 normal-case">(clean sweep after loops)</span>
        </label>
      </div>
      {errorMsg && (
        <p className="text-body text-red-400 flex items-start gap-1.5">
          <AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{errorMsg}
        </p>
      )}
      <GenerateBtn
        disabled={selectedPaths.length === 0 || !selectedTool || generating || form.depthMM <= 0}
        generating={generating}
        onClick={handleGenerate}
        label={editOp ? 'Regenerate Toolpath' : 'Generate Toolpath'}
      />
    </FormShell>
  )
}

// ─── Pocket form ──────────────────────────────────────────────────────────────

interface PocketFormState {
  toolId: string
  strategy: PocketStrategy
  depthMM: number
  stepDownMM: number
  stepoverPercent: number
  passAngleDeg: number
  direction: CuttingDirection
  rampIn: boolean
  allowanceMM: number
}

export function PocketForm({ onClose, editOp }: { onClose: () => void; editOp?: PocketOperation }) {
  const { tools } = useToolStore()
  const { paths, selectedIds, pushHistoryBoth } = usePathsStore()
  const { addOperation, setSegments, setError, updateOperation } = useToolpathStore()
  const { load, save } = useFormDefaultsStore()
  const { safeHeightMM, thicknessMM } = useWorkpieceStore()

  const defaultTool = tools[0]
  const [form, setForm] = useState<PocketFormState>(() => editOp ? {
    toolId: editOp.toolId, strategy: editOp.strategy ?? 'raster',
    depthMM: editOp.depthMM, stepDownMM: editOp.stepDownMM,
    stepoverPercent: editOp.stepoverPercent, passAngleDeg: editOp.passAngleDeg,
    direction: editOp.direction, rampIn: editOp.rampIn ?? false,
    allowanceMM: editOp.allowanceMM ?? 0,
  } : mergeWithDefaults(load('pocket'), {
    toolId: defaultTool?.id ?? '',
    strategy: 'raster' as PocketStrategy,
    // Default to the full stock thickness; the tool's max Z is only a warning.
    depthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    stepDownMM: defaultTool?.stepDownMM ?? 3,
    stepoverPercent: 40,
    passAngleDeg: 0,
    direction: (defaultTool?.direction ?? 'climb') as CuttingDirection,
    rampIn: false,
    allowanceMM: 0,
  }, tools))
  const [generating, setGenerating] = useState(false)

  const editBoundary = editOp ? paths.find((p) => p.id === editOp.pathId) : null
  const editIslands = editOp ? paths.filter((p) => editOp.islandIds.includes(p.id)) : []
  const groups = editOp && editBoundary
    ? [{ boundary: editBoundary, islands: editIslands }]
    : groupPathsByContainment(paths.filter((p) => selectedIds.includes(p.id)))
  const selectedTool = tools.find((t) => t.id === form.toolId)

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, stepDownMM: t.stepDownMM, direction: t.direction }))
  }

  function handleStrategyChange(strategy: PocketStrategy) {
    const adaptive = strategy === 'adaptive' || strategy === 'adaptive2'
    setForm((f) => ({
      ...f,
      strategy,
      stepoverPercent: adaptive
        ? Math.min(Math.max(f.stepoverPercent, 5), 60)
        : Math.min(Math.max(f.stepoverPercent, 10), 90),
    }))
  }

  function up<K extends keyof PocketFormState>(k: K, v: PocketFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function handleGenerate() {
    if (groups.length === 0 || !selectedTool) return
    const tool = selectedTool
    pushHistoryBoth()
    setGenerating(true)
    // Run the (potentially slow, e.g. adaptive) pocket generation off the main thread so the
    // browser stays responsive — same worker pattern as regenerate.ts. Awaiting the worker also
    // lets React paint the 'generating' state, so the old setTimeout(…,0) yield is unnecessary.
    try {
      if (editOp && editBoundary) {
        updateOperation(editOp.id, {
          toolId: form.toolId, strategy: form.strategy,
          depthMM: form.depthMM, stepDownMM: form.stepDownMM,
          stepoverPercent: form.stepoverPercent, passAngleDeg: form.passAngleDeg,
          direction: form.direction, rampIn: form.rampIn, allowanceMM: form.allowanceMM, status: 'generating',
        } as Partial<AnyOperation>)
        try {
          setSegments(editOp.id, await runInWorker('generatePocket', editBoundary.d, tool, {
            strategy: form.strategy,
            depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(tool, form.stepDownMM, form.depthMM),
            stepoverPercent: form.stepoverPercent, direction: form.direction,
            islandDs: editIslands.map((p) => p.d), angle: form.passAngleDeg, rampIn: form.rampIn,
            finishAllowanceMM: form.allowanceMM,
            safeHeightMM,
          }))
        } catch (err) {
          setError(editOp.id, err instanceof Error ? err.message : 'Generation failed')
        }
      } else {
        for (const { boundary, islands } of groups) {
          const opId = addOperation({
            name: `Pocket: ${boundary.name} (${tool.name})`,
            type: 'pocket',
            toolId: form.toolId,
            strategy: form.strategy,
            pathId: boundary.id,
            islandIds: islands.map((p) => p.id),
            depthMM: form.depthMM,
            stepDownMM: form.stepDownMM,
            stepoverPercent: form.stepoverPercent,
            passAngleDeg: form.passAngleDeg,
            direction: form.direction,
            rampIn: form.rampIn,
            allowanceMM: form.allowanceMM,
          })
          updateOperation(opId, { status: 'generating' })
          try {
            setSegments(opId, await runInWorker('generatePocket', boundary.d, tool, {
              strategy: form.strategy,
              depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(tool, form.stepDownMM, form.depthMM),
              stepoverPercent: form.stepoverPercent, direction: form.direction,
              islandDs: islands.map((p) => p.d), angle: form.passAngleDeg, rampIn: form.rampIn,
              finishAllowanceMM: form.allowanceMM,
              safeHeightMM,
            }))
          } catch (err) {
            setError(opId, err instanceof Error ? err.message : 'Generation failed')
          }
        }
      }
    } finally {
      setGenerating(false)
      save('pocket', form)
    }
  }

  return (
    <FormShell title={editOp ? 'Edit Pocket' : 'New Pocket Operation'} onClose={onClose}>
      {groups.length === 0 ? (
        <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> {editOp ? 'Path not found' : 'Select a closed path first'}</p>
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
      {/* 'adaptive' (the old Adaptive2d port) stays hidden — too slow; 'adaptive2' is the fast
          raster-marching engine and is what the UI shows as "adaptive". */}
      <ToggleRow label="Strategy" options={['raster', 'contour', 'spiral', 'morph', 'adaptive2'] as PocketStrategy[]} value={form.strategy} onChange={handleStrategyChange} labels={{ adaptive2: 'adaptive' }} />
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          {form.strategy === 'adaptive' || form.strategy === 'adaptive2' ? 'Engagement' : 'Stepover'} <span className="text-gray-500 dark:text-neutral-400 normal-case">{form.stepoverPercent}%</span>
        </label>
        <input
          type="range" min={form.strategy === 'adaptive' || form.strategy === 'adaptive2' ? 5 : 10} max={form.strategy === 'adaptive' || form.strategy === 'adaptive2' ? 60 : 90} step={5}
          value={form.stepoverPercent}
          onChange={(e) => up('stepoverPercent', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>
      {/* Pass angle — only relevant for raster strategy */}
      {form.strategy === 'raster' && (
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
      )}
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)}
        maxDepthMM={selectedTool?.maxDepthMM} tool={selectedTool} />
      <ToggleRow label="Direction" options={['climb', 'conventional'] as CuttingDirection[]} value={form.direction} onChange={(v) => up('direction', v)} />
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Allowance</label>
        <div className="flex items-center gap-1">
          <NumericInput value={form.allowanceMM} min={-5} max={5} step={0.05}
            onChange={(v) => up('allowanceMM', v)}
            className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
          />
          <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
        </div>
        <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">Stock left on walls; negative grows the pocket.</p>
      </div>
      <div className="flex items-center gap-2">
        <input type="checkbox" id="pocket-ramp-in" checked={form.rampIn}
          onChange={(e) => up('rampIn', e.target.checked)} className="accent-blue-500" />
        <label htmlFor="pocket-ramp-in" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
          Ramp In <span className="text-gray-500 dark:text-neutral-500 normal-case">(2× dia, 50% feed)</span>
        </label>
      </div>
      <GenerateBtn
        disabled={groups.length === 0 || !selectedTool || generating || form.depthMM <= 0}
        generating={generating}
        onClick={handleGenerate}
        label={editOp ? 'Regenerate Toolpath' : 'Generate Toolpath'}
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

export function DrillForm({ onClose, editOp }: { onClose: () => void; editOp?: DrillOperation }) {
  const { tools } = useToolStore()
  const { paths, selectedIds, pushHistoryBoth } = usePathsStore()
  const { addOperation, setSegments, setError, updateOperation } = useToolpathStore()
  const { activeTool, setActiveTool, pendingDrillPoints, clearDrillPoints } = useUIStore()
  const { load, save } = useFormDefaultsStore()
  const { safeHeightMM, thicknessMM } = useWorkpieceStore()

  const defaultTool = tools[0]
  const [form, setForm] = useState<DrillFormState>(() => editOp ? {
    toolId: editOp.toolId, drillMode: editOp.drillMode,
    depthMM: editOp.depthMM, stepDownMM: editOp.stepDownMM,
  } : mergeWithDefaults(load('drill'), {
    toolId: defaultTool?.id ?? '',
    drillMode: 'peck' as const,
    // Default to the full stock thickness; the tool's max Z is only a warning.
    depthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    stepDownMM: defaultTool?.stepDownMM ?? 3,
  }, tools))
  const [generating, setGenerating] = useState(false)

  // Auto-enter/exit drill-placing mode based on selected mode
  useEffect(() => {
    if (editOp) return
    if (form.drillMode === 'peck') {
      setActiveTool('drill')
    } else {
      setActiveTool('select')
      clearDrillPoints()
    }
  }, [form.drillMode]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedTool = tools.find((t) => t.id === form.toolId)

  // For helical: all selected circular paths
  const selectedCircles = editOp ? [] : paths
    .filter((p) => selectedIds.includes(p.id))
    .flatMap((p) => {
      const circle = extractCircle(p)
      return circle ? [{ path: p, circle }] : []
    })

  // For edit mode: reconstruct helical info from stored op params
  const editHelicalInfo = editOp?.drillMode === 'helical' && editOp.helicalCenterX !== undefined ? {
    cx: editOp.helicalCenterX!,
    cy: editOp.helicalCenterY!,
    radius: editOp.helicalRadius ?? 0,
  } : null

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, stepDownMM: t.stepDownMM }))
  }

  function up<K extends keyof DrillFormState>(k: K, v: DrillFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleClose() {
    if (activeTool === 'drill') { setActiveTool('select'); clearDrillPoints() }
    onClose()
  }

  function handleGenerate() {
    if (!selectedTool) return
    pushHistoryBoth()
    setGenerating(true)

    if (editOp) {
      updateOperation(editOp.id, {
        toolId: form.toolId, depthMM: form.depthMM, stepDownMM: form.stepDownMM, status: 'generating',
      } as Partial<AnyOperation>)
      setTimeout(() => {
        try {
          let segs
          if (editOp.drillMode === 'helical' && editHelicalInfo) {
            segs = generateHelicalDrill(editHelicalInfo.cx, editHelicalInfo.cy, editHelicalInfo.radius, selectedTool, {
              depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(selectedTool, form.stepDownMM, form.depthMM), safeHeightMM,
            })
          } else {
            segs = generatePeckDrill(editOp.points, selectedTool, {
              depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(selectedTool, form.stepDownMM, form.depthMM), safeHeightMM,
            })
          }
          setSegments(editOp.id, segs)
        } catch (err) {
          setError(editOp.id, err instanceof Error ? err.message : 'Generation failed')
        }
        setGenerating(false)
        save('drill', form)
      }, 0)
      return
    }

    if (form.drillMode === 'peck' && pendingDrillPoints.length === 0) { setGenerating(false); return }
    if (form.drillMode === 'helical' && selectedCircles.length === 0) { setGenerating(false); return }

    setTimeout(() => {
      if (form.drillMode === 'helical') {
        for (const { path, circle } of selectedCircles) {
          const r = Math.max(0, circle.radiusMM - selectedTool.diameterMM / 2)
          const opId = addOperation({
            name: `Helical Drill: ${path.name} (${selectedTool.name})`,
            type: 'drill',
            toolId: form.toolId,
            drillMode: 'helical',
            points: [],
            pathId: path.id,
            helicalCenterX: circle.cx,
            helicalCenterY: circle.cy,
            helicalRadius: r,
            depthMM: form.depthMM,
            stepDownMM: form.stepDownMM,
          })
          updateOperation(opId, { status: 'generating' })
          try {
            setSegments(opId, generateHelicalDrill(circle.cx, circle.cy, r, selectedTool, {
              depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(selectedTool, form.stepDownMM, form.depthMM), safeHeightMM,
            }))
          } catch (err) {
            setError(opId, err instanceof Error ? err.message : 'Generation failed')
          }
        }
      } else {
        const opId = addOperation({
          name: `Peck Drill (${selectedTool.name}) ×${pendingDrillPoints.length}`,
          type: 'drill',
          toolId: form.toolId,
          drillMode: 'peck',
          points: [...pendingDrillPoints],
          depthMM: form.depthMM,
          stepDownMM: form.stepDownMM,
        })
        updateOperation(opId, { status: 'generating' })
        try {
          setSegments(opId, generatePeckDrill(pendingDrillPoints, selectedTool, {
            depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(selectedTool, form.stepDownMM, form.depthMM), safeHeightMM,
          }))
        } catch (err) {
          setError(opId, err instanceof Error ? err.message : 'Generation failed')
        }
      }
      setGenerating(false)
      save('drill', form)
      clearDrillPoints()
    }, 0)
  }

  const isNonDrillTool = !!selectedTool && selectedTool.type !== 'drill'
  const isDrillTool = selectedTool?.type === 'drill'
  const peckReady = editOp ? editOp.points.length > 0 : pendingDrillPoints.length > 0
  const helicalReady = editOp ? !!editHelicalInfo : selectedCircles.length > 0
  const canGenerate = !!selectedTool && !generating && form.depthMM > 0 &&
    ((form.drillMode === 'peck' && peckReady) || (form.drillMode === 'helical' && helicalReady && !isDrillTool))

  return (
    <FormShell title={editOp ? 'Edit Drill' : 'New Drill Operation'} onClose={handleClose}>
      {/* Mode toggle — read-only when editing */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Mode</label>
        <div className="flex gap-1">
          {(['peck', 'helical'] as const).map((m) => (
            <button key={m} onClick={() => { if (!editOp && m !== form.drillMode) up('drillMode', m) }}
              className={[
                'flex-1 py-1 text-body rounded border transition-colors capitalize',
                form.drillMode === m
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-gray-50 dark:bg-neutral-900 border-gray-300 dark:border-neutral-700 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200',
                editOp ? 'opacity-60 cursor-default' : '',
              ].join(' ')}>
              {m === 'peck' ? 'Peck at Points' : 'Helical (Circle)'}
            </button>
          ))}
        </div>
      </div>

      {/* Peck: auto-placing — just show count + clear */}
      {form.drillMode === 'peck' && (
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Drill Points</label>
          {editOp ? (
            <p className="text-body text-gray-700 dark:text-neutral-300 bg-gray-100 dark:bg-neutral-800 rounded px-2 py-1">
              {editOp.points.length} stored point{editOp.points.length !== 1 ? 's' : ''}
            </p>
          ) : pendingDrillPoints.length > 0 ? (
            <div className="flex items-center gap-2">
              <span className="text-body text-gray-700 dark:text-neutral-300">
                {pendingDrillPoints.length} point{pendingDrillPoints.length !== 1 ? 's' : ''}
              </span>
              <button onClick={clearDrillPoints} className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-neutral-700 text-gray-400 dark:text-neutral-500 hover:text-gray-700 dark:hover:text-neutral-300">
                <X size={ICON.xs} />
              </button>
            </div>
          ) : (
            <p className="text-label text-gray-400 dark:text-neutral-500">Click on the canvas to place drill points.</p>
          )}
          {isNonDrillTool && (
            <p className="text-label text-amber-400 mt-1 flex items-center gap-1">
              <AlertCircle size={ICON.xs} /> Peck drilling with an end mill — ensure the tool is suitable.
            </p>
          )}
        </div>
      )}

      {/* Helical: list all selected circles */}
      {form.drillMode === 'helical' && (
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
            Source Circles {!editOp && selectedCircles.length > 1 && <span className="normal-case text-gray-500 dark:text-neutral-400">({selectedCircles.length} selected — one operation each)</span>}
          </label>
          {editOp && editHelicalInfo ? (
            <div className="text-body text-gray-800 dark:text-neutral-200 bg-gray-100 dark:bg-neutral-800 rounded px-2 py-1 space-y-0.5">
              <div>Center: ({editHelicalInfo.cx.toFixed(1)}, {editHelicalInfo.cy.toFixed(1)}) mm</div>
              <div>Tool path Ø: {(editHelicalInfo.radius * 2).toFixed(2)} mm</div>
            </div>
          ) : selectedCircles.length > 0 ? (
            <div className="space-y-0.5">
              {selectedCircles.map(({ path, circle }) => {
                const r = Math.max(0, circle.radiusMM - (selectedTool?.diameterMM ?? 0) / 2)
                return (
                  <div key={path.id} className="text-body text-gray-800 dark:text-neutral-200 bg-gray-100 dark:bg-neutral-800 rounded px-2 py-1">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: path.color }} />
                      {path.name}
                    </div>
                    <div className="text-gray-500 dark:text-neutral-400 text-label mt-0.5">
                      Hole Ø {(circle.radiusMM * 2).toFixed(2)} mm
                      {r > 0 ? ` · Tool path Ø ${(r * 2).toFixed(2)} mm` : ' · center-drill (tool wider than hole)'}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-body text-amber-400 flex items-center gap-1">
              <AlertCircle size={ICON.sm} /> Select one or more circular paths first
            </p>
          )}
          {isDrillTool && (
            <p className="text-label text-amber-400 mt-1 flex items-center gap-1">
              <AlertCircle size={ICON.xs} /> Drill bits cannot do helical drilling — use an end mill.
            </p>
          )}
        </div>
      )}

      <ToolSelector tools={tools} value={form.toolId} onChange={handleToolChange} />
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)}
        maxDepthMM={selectedTool?.maxDepthMM} tool={selectedTool} />
      <GenerateBtn
        disabled={!canGenerate}
        generating={generating}
        onClick={handleGenerate}
        label={editOp ? 'Regenerate Toolpath' : 'Generate Toolpath'}
      />
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

function ToggleRow<T extends string>({ label, options, value, onChange, labels }: {
  label: string
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  labels?: Partial<Record<T, string>>
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
            {labels?.[o] ?? o}
          </button>
        ))}
      </div>
    </div>
  )
}



// Read-only display for an auto-calculated step-down (shown when auto feed is on).
function AutoStepField({ label, valueMM }: { label: string; valueMM: number }) {
  return (
    <div>
      <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
        {label} <span className="text-blue-500 dark:text-blue-400 normal-case">(auto)</span>
      </label>
      <div className="flex items-center gap-1">
        <div className="flex-1 bg-gray-100 dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-500 dark:text-neutral-400 min-w-0 font-mono">
          {valueMM.toFixed(2)}
        </div>
        <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
      </div>
    </div>
  )
}

function DepthRow({ depthMM, stepDownMM, onDepth, onStep, maxDepthMM, tool, engagementFraction }: {
  depthMM: number; stepDownMM: number
  onDepth: (v: number) => void; onStep: (v: number) => void
  maxDepthMM?: number
  tool?: Tool
  // Radial engagement (WOC / D); low values (trochoidal) let the auto step-down go deeper.
  // Omit for full-slot ops so the displayed value matches the generated one.
  engagementFraction?: number
}) {
  // When auto feed is on the step-down is computed and shown read-only. The parent
  // form subscribes to the whole workpiece store, so this recomputes live as the
  // user changes rigidity / material / max feed.
  const autoFeedEnabled = useWorkpieceStore((s) => s.autoFeedEnabled)
  const thicknessMM = useWorkpieceStore((s) => s.thicknessMM)
  const autoStepDownMM = autoFeedEnabled && tool ? effectiveStepDownMM(tool, stepDownMM, depthMM, engagementFraction) : null
  const depthExceeds = maxDepthMM != null && depthMM > maxDepthMM
  // Guard against plunging past the bottom of the stock into the spoilboard.
  const pastStockMM = thicknessMM > 0 ? depthMM - thicknessMM : 0
  const cutsPastStock = pastStockMM > 0.001
  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Depth</label>
        <div className="flex items-center gap-1">
          <NumericInput value={depthMM} min={0.01} step={0.5}
            onChange={(v) => onDepth(v)}
            className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
          />
          <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
        </div>
        {depthExceeds && (
          <p className="text-label text-amber-500 flex items-center gap-1 mt-0.5">
            <AlertCircle size={10} className="shrink-0" />
            Exceeds tool max ({maxDepthMM} mm)
          </p>
        )}
        {cutsPastStock && (
          <p className="text-label text-amber-500 flex items-center gap-1 mt-0.5">
            <AlertCircle size={10} className="shrink-0" />
            {pastStockMM.toFixed(2)} mm past stock bottom ({thicknessMM} mm)
          </p>
        )}
      </div>
      {autoStepDownMM != null ? (
        <AutoStepField label="Step Down" valueMM={autoStepDownMM} />
      ) : (
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Step Down</label>
          <div className="flex items-center gap-1">
            <NumericInput value={stepDownMM} min={0.01} step={0.5}
              onChange={(v) => onStep(v)}
              className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
            />
            <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
          </div>
        </div>
      )}
    </div>
  )
}

function GenerateBtn({ disabled, generating, onClick, label = 'Generate Toolpath' }: { disabled: boolean; generating: boolean; onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="w-full py-1.5 rounded text-body font-medium bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5">
      {generating && <Loader2 size={ICON.sm} className="animate-spin" />}
      {generating ? 'Generating…' : label}
    </button>
  )
}

// ─── V-Carve form ────────────────────────────────────────────────────────────

interface VCarveFormState {
  toolId: string
  angleDeg: number
  maxDepthMM: number
}

export function VCarveForm({ onClose, editOp }: { onClose: () => void; editOp?: VCarveOperation }) {
  const { tools } = useToolStore()
  const { paths, selectedIds, pushHistoryBoth } = usePathsStore()
  const { addOperation, setSegments, setError, updateOperation } = useToolpathStore()
  const { load, save } = useFormDefaultsStore()
  const { safeHeightMM, thicknessMM } = useWorkpieceStore()

  const vbits = tools.filter((t) => t.type === 'vbit')
  const defaultTool = vbits[0] ?? tools[0]
  const [form, setForm] = useState<VCarveFormState>(() => editOp
    ? { toolId: editOp.toolId, angleDeg: editOp.angleDeg, maxDepthMM: editOp.maxDepthMM }
    : mergeWithDefaults(load('vcarve'), {
        toolId: defaultTool?.id ?? '',
        angleDeg: defaultTool?.vbitAngleDeg ?? 60,
        // Default to the full stock thickness; the tool's max Z is only a warning.
        maxDepthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
      }, tools)
  )
  const [generating, setGenerating] = useState(false)

  const editBoundary = editOp ? paths.find((p) => p.id === editOp.pathId) : null
  const editIslands = editOp ? paths.filter((p) => editOp.islandIds.includes(p.id)) : []
  const groups = editOp && editBoundary
    ? [{ boundary: editBoundary, islands: editIslands }]
    : groupPathsByContainment(paths.filter((p) => selectedIds.includes(p.id)))
  const selectedTool = tools.find((t) => t.id === form.toolId)

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, angleDeg: t.vbitAngleDeg ?? f.angleDeg }))
  }

  function up<K extends keyof VCarveFormState>(k: K, v: VCarveFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function handleGenerate() {
    if (groups.length === 0 || !selectedTool) return
    const tool = selectedTool
    pushHistoryBoth()
    setGenerating(true)
    try {
      if (editOp && editBoundary) {
        updateOperation(editOp.id, {
          toolId: form.toolId, angleDeg: form.angleDeg, maxDepthMM: form.maxDepthMM, status: 'generating',
        } as Partial<AnyOperation>)
        try {
          setSegments(editOp.id, await runInWorker('generateVCarve', editBoundary.d, tool, {
            angleDeg: form.angleDeg, maxDepthMM: form.maxDepthMM,
            islandDs: editIslands.map((p) => p.d), safeHeightMM,
          }))
        } catch (err) {
          setError(editOp.id, err instanceof Error ? err.message : 'Generation failed')
        }
      } else {
        for (const { boundary, islands } of groups) {
          const opId = addOperation({
            name: `V-Carve: ${boundary.name} (${tool.name})`,
            type: 'vcarve',
            toolId: form.toolId,
            pathId: boundary.id,
            islandIds: islands.map((p) => p.id),
            maxDepthMM: form.maxDepthMM,
            angleDeg: form.angleDeg,
          })
          updateOperation(opId, { status: 'generating' })
          try {
            setSegments(opId, await runInWorker('generateVCarve', boundary.d, tool, {
              angleDeg: form.angleDeg, maxDepthMM: form.maxDepthMM,
              islandDs: islands.map((p) => p.d), safeHeightMM,
            }))
          } catch (err) {
            setError(opId, err instanceof Error ? err.message : 'Generation failed')
          }
        }
      }
    } finally {
      setGenerating(false)
      save('vcarve', form)
    }
  }

  return (
    <FormShell title={editOp ? 'Edit V-Carve' : 'New V-Carve Operation'} onClose={onClose}>
      {groups.length === 0 ? (
        <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> {editOp ? 'Path not found' : 'Select a closed path first'}</p>
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
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Max Depth</label>
        <div className="flex items-center gap-1">
          <NumericInput value={form.maxDepthMM} min={0.1} step={0.5}
            onChange={(v) => up('maxDepthMM', v)}
            className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
          />
          <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
        </div>
        {selectedTool && form.maxDepthMM > selectedTool.maxDepthMM && (
          <p className="text-label text-amber-500 flex items-center gap-1 mt-0.5">
            <AlertCircle size={10} className="shrink-0" />
            Exceeds tool max ({selectedTool.maxDepthMM} mm)
          </p>
        )}
        <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">
          Bit cuts at most {((form.maxDepthMM) * Math.tan((form.angleDeg / 2) * Math.PI / 180) * 2).toFixed(2)} mm wide at full depth.
        </p>
      </div>
      <GenerateBtn
        disabled={groups.length === 0 || !selectedTool || generating || form.maxDepthMM <= 0 || selectedTool.type !== 'vbit'}
        generating={generating}
        onClick={handleGenerate}
        label={editOp ? 'Regenerate Toolpath' : 'Generate Toolpath'}
      />
    </FormShell>
  )
}

// ─── Inlay form ───────────────────────────────────────────────────────────────

interface InlayFormState {
  vbitToolId: string
  pocketToolId: string
  pocketDepthMM: number
  stepDownMM: number
  stepoverPercent: number
  glueLineMM: number
  clearanceMM: number
  role: 'female' | 'male'
  rampIn: boolean
  mirrorX: boolean
}

export function InlayForm({ onClose, editOp }: { onClose: () => void; editOp?: InlayOperation }) {
  const { tools } = useToolStore()
  const { paths, selectedIds, pushHistoryBoth } = usePathsStore()
  const { addOperation, setSegments, setError, updateOperation, operations } = useToolpathStore()
  const { load, save } = useFormDefaultsStore()
  const { safeHeightMM, autoFeedEnabled } = useWorkpieceStore()

  const vbits = tools.filter((t) => t.type === 'vbit')
  const endmills = tools.filter((t) => t.type === 'endmill' || t.type === 'ballnose')
  const defaultVbit = vbits[0] ?? tools[0]
  const defaultEndmill = endmills[0] ?? tools[0]

  const [form, setForm] = useState<InlayFormState>(() => editOp ? {
    vbitToolId: editOp.vbitToolId, pocketToolId: editOp.pocketToolId,
    pocketDepthMM: editOp.pocketDepthMM,
    stepDownMM: editOp.stepDownMM, stepoverPercent: editOp.stepoverPercent,
    glueLineMM: editOp.glueLineMM, clearanceMM: editOp.clearanceMM,
    role: editOp.role, rampIn: editOp.rampIn ?? false, mirrorX: editOp.mirrorX ?? false,
  } : mergeWithDefaults(load('inlay'), {
    vbitToolId: defaultVbit?.id ?? '',
    pocketToolId: defaultEndmill?.id ?? '',
    pocketDepthMM: 5,
    stepDownMM: defaultEndmill?.stepDownMM ?? 3,
    stepoverPercent: 40,
    glueLineMM: 0.2,
    clearanceMM: 0.1,
    role: 'female' as const,
    rampIn: false,
    mirrorX: false,
  }, tools))
  const [generating, setGenerating] = useState(false)

  // Finish = "None": roughing tool only, no separate wall-finish pass. Female → flat-walled
  // pocket; male → flat-walled plug freed by the roughing bit. One operation, no pairing.
  const finishIsNone = form.vbitToolId === INLAY_NO_FINISH
  const vbitTool = finishIsNone ? null : tools.find((t) => t.id === form.vbitToolId)
  const pocketTool = tools.find((t) => t.id === form.pocketToolId)
  const editBoundary = editOp ? paths.find((p) => p.id === editOp.pathId) : null
  const editIslands = editOp ? paths.filter((p) => editOp.islandIds.includes(p.id)) : []
  const groups = editOp && editBoundary
    ? [{ boundary: editBoundary, islands: editIslands }]
    : groupPathsByContainment(paths.filter((p) => selectedIds.includes(p.id)))

  function up<K extends keyof InlayFormState>(k: K, v: InlayFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleGenerate() {
    if (groups.length === 0 || !pocketTool || (!vbitTool && !finishIsNone)) return
    pushHistoryBoth()
    setGenerating(true)

    // After the guard, the wall tool is present unless finishIsNone (roughing-only); the
    // finishIsNone path returns early below, so non-None branches always have a real tool.
    const wallTool: Tool | null = vbitTool ?? null
    const angleDeg = vbitTool?.vbitAngleDeg ?? 60
    const baseParams = {
      angleDeg,
      pocketDepthMM: form.pocketDepthMM,
      stepDownMM: effectiveStepDownMM(pocketTool, form.stepDownMM, form.pocketDepthMM),
      stepoverPercent: form.stepoverPercent,
      glueLineMM: form.glueLineMM,
      clearanceMM: form.clearanceMM,
      rampIn: form.rampIn,
      mirrorX: form.mirrorX,
      safeHeightMM,
    }
    const sharedOpFields = {
      pocketToolId: form.pocketToolId,
      vbitToolId: form.vbitToolId,
      angleDeg,
      pocketDepthMM: form.pocketDepthMM,
      stepDownMM: form.stepDownMM,
      stepoverPercent: form.stepoverPercent,
      glueLineMM: form.glueLineMM,
      clearanceMM: form.clearanceMM,
      rampIn: form.rampIn,
      mirrorX: form.mirrorX,
    }

    if (editOp && editBoundary) {
      const inlayParams = { ...baseParams, islandDs: editIslands.map((p) => p.d) }
      // Update both the edited op and its linked counterpart with new params.
      const linkedOp = editOp.linkedOpId
        ? (operations.find((o) => o.id === editOp.linkedOpId) as InlayOperation | undefined)
        : undefined
      const sharedUpdate = {
        ...sharedOpFields,
        toolId: editOp.phase === 'vbit' ? form.vbitToolId : form.pocketToolId,
        status: 'generating' as const,
      }
      updateOperation(editOp.id, sharedUpdate as Partial<AnyOperation>)
      if (linkedOp) {
        updateOperation(linkedOp.id, {
          ...sharedOpFields,
          toolId: linkedOp.phase === 'vbit' ? form.vbitToolId : form.pocketToolId,
          status: 'generating',
        } as Partial<AnyOperation>)
      }
      setTimeout(async () => {
        try {
          const result = editOp.role === 'female'
            ? await runInWorker('generateInlayFemale', editBoundary.d, pocketTool, wallTool, inlayParams)
            : await runInWorker('generateInlayMale', editBoundary.d, pocketTool, wallTool, inlayParams)
          setSegments(editOp.id, editOp.phase === 'vbit' ? result.vbitSegs : result.endmillSegs)
          if (linkedOp) {
            setSegments(linkedOp.id, editOp.phase === 'vbit' ? result.endmillSegs : result.vbitSegs)
          }

        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Generation failed'
          setError(editOp.id, msg)
          if (linkedOp) setError(linkedOp.id, msg)
        }
        setGenerating(false)
        save('inlay', form)
      }, 0)
      return
    }

    // Finish = None (roughing-only): one end-mill op per group, no finish phase and no
    // pairing. Female → the raster pocket forms the flat-walled socket; male → the roughing
    // bit profiles the flat-walled plug and pockets any island sockets. All segs are endmill.
    if (finishIsNone) {
      const role = form.role
      const roleLabel = role === 'female' ? 'Female' : 'Male'
      const opBase = { type: 'inlay' as const, role, ...sharedOpFields }
      const ids = groups.map(({ boundary, islands }) => {
        const id = addOperation({ ...opBase, phase: 'endmill', toolId: form.pocketToolId,
          pathId: boundary.id, islandIds: islands.map((p) => p.id),
          name: `Inlay ${roleLabel} (End Mill): ${boundary.name}` })
        updateOperation(id, { status: 'generating' })
        return id
      })
      setTimeout(async () => {
        for (let i = 0; i < groups.length; i++) {
          const { boundary, islands } = groups[i]
          const inlayParams = { ...baseParams, islandDs: islands.map((p) => p.d) }
          try {
            const result = role === 'female'
              ? await runInWorker('generateInlayFemale', boundary.d, pocketTool, null, inlayParams)
              : await runInWorker('generateInlayMale', boundary.d, pocketTool, null, inlayParams)
            setSegments(ids[i], result.endmillSegs)
          } catch (err) {
            setError(ids[i], err instanceof Error ? err.message : 'Generation failed')
          }
        }
        setGenerating(false)
        save('inlay', form)
      }, 0)
      return
    }

    // For new ops: create all first-phase ops first, then all second-phase ops, so
    // the operations list naturally orders roughing before finishing.
    // Female (any): endmill (roughing pocket) first, vbit/finish (walls) second.
    // Male V-bit: vbit (bevel profile) first, endmill (release cut) second.
    // Male endmill-only: endmill (roughing release) first, vbit/finish (release) second.
    const role = form.role
    const isEndmillOnly = vbitTool?.type !== 'vbit'
    const firstPhase  = (role === 'female' || isEndmillOnly) ? 'endmill' : 'vbit'   as 'vbit' | 'endmill'
    const secondPhase = (role === 'female' || isEndmillOnly) ? 'vbit'    : 'endmill' as 'vbit' | 'endmill'
    const firstToolId  = firstPhase  === 'vbit' ? form.vbitToolId : form.pocketToolId
    const secondToolId = secondPhase === 'vbit' ? form.vbitToolId : form.pocketToolId
    const roleLabel = role === 'female' ? 'Female' : 'Male'
    const phaseLabel = (phase: 'vbit' | 'endmill') => phase === 'vbit' ? 'V-bit' : 'End Mill'

    const opBase = { type: 'inlay' as const, role, ...sharedOpFields }

    // Create all first-phase ops, then all second-phase ops.
    const firstIds = groups.map(({ boundary, islands }) => {
      const id = addOperation({ ...opBase, phase: firstPhase, toolId: firstToolId,
        pathId: boundary.id, islandIds: islands.map((p) => p.id),
        name: `Inlay ${roleLabel} (${phaseLabel(firstPhase)}): ${boundary.name}` })
      updateOperation(id, { status: 'generating' })
      return id
    })
    const secondIds = groups.map(({ boundary, islands }) => {
      const id = addOperation({ ...opBase, phase: secondPhase, toolId: secondToolId,
        pathId: boundary.id, islandIds: islands.map((p) => p.id),
        name: `Inlay ${roleLabel} (${phaseLabel(secondPhase)}): ${boundary.name}` })
      updateOperation(id, { status: 'generating' })
      return id
    })

    // Link paired ops so edit/regenerate can update both together.
    for (let i = 0; i < groups.length; i++) {
      updateOperation(firstIds[i],  { linkedOpId: secondIds[i]  } as Partial<AnyOperation>)
      updateOperation(secondIds[i], { linkedOpId: firstIds[i]   } as Partial<AnyOperation>)
    }

    setTimeout(async () => {
      for (let i = 0; i < groups.length; i++) {
        const { boundary, islands } = groups[i]
        const inlayParams = { ...baseParams, islandDs: islands.map((p) => p.d) }
        try {
          const result = role === 'female'
            ? await runInWorker('generateInlayFemale', boundary.d, pocketTool, wallTool, inlayParams)
            : await runInWorker('generateInlayMale', boundary.d, pocketTool, wallTool, inlayParams)
          setSegments(firstIds[i],  firstPhase  === 'vbit' ? result.vbitSegs : result.endmillSegs)
          setSegments(secondIds[i], secondPhase === 'vbit' ? result.vbitSegs : result.endmillSegs)

        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Generation failed'
          setError(firstIds[i], msg)
          setError(secondIds[i], msg)
        }
      }
      setGenerating(false)
      save('inlay', form)
    }, 0)
  }

  const isEndmillMode = !!vbitTool && vbitTool.type !== 'vbit'
  const canGenerate = groups.length > 0 && (!!vbitTool || finishIsNone) && !!pocketTool && !generating && form.pocketDepthMM > 0
  const isMale = editOp ? editOp.role === 'male' : form.role === 'male'

  return (
    <FormShell title={editOp ? `Edit Inlay (${editOp.role})` : 'New Inlay Operation'} onClose={onClose}>
      <div>
        {groups.length === 0 ? (
          <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> Select a closed path first</p>
        ) : (
          <div className="space-y-1">
            {groups.map(({ boundary, islands }, i) => (
              <div key={boundary.id}>
                {groups.length > 1 && (
                  <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
                    Shape {i + 1}
                  </label>
                )}
                <div className="space-y-0.5">
                  <PathChip path={boundary} label="boundary" />
                  {islands.map((p) => <PathChip key={p.id} path={p} label="island" />)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {/* Roughing tool */}
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
      {/* Finish tool */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Finish Tool</label>
        <select
          value={form.vbitToolId}
          onChange={(e) => up('vbitToolId', e.target.value)}
          className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500"
        >
          {/* Skip the wall-finish pass — the roughing bit alone forms the socket / plug walls. */}
          <option value={INLAY_NO_FINISH}>None — roughing only</option>
          {tools.map((t) => (
            <option key={t.id} value={t.id}>{t.name} (Ø{t.diameterMM}mm)</option>
          ))}
        </select>
        {finishIsNone && (
          <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">No finish pass — flat walls left by the roughing bit (corners at its radius).</p>
        )}
        {vbitTool?.type === 'vbit' && (
          <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">V-bit — sloped bevel walls</p>
        )}
        {vbitTool && vbitTool.type !== 'vbit' && (
          <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">End mill — flat walls, corners auto-rounded to Ø{vbitTool.diameterMM}mm</p>
        )}
      </div>
      {vbitTool?.type === 'vbit' && (
        <p className="text-label text-gray-400 dark:text-neutral-500">
          V-bit angle: {vbitTool.vbitAngleDeg ?? 60}° (set on tool)
        </p>
      )}
      {/* Depth */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Inlay Depth</label>
          <div className="flex items-center gap-1">
            <NumericInput value={form.pocketDepthMM} min={0.5} step={0.5}
              onChange={(v) => up('pocketDepthMM', v)}
              className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
            />
            <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
          </div>
        </div>
        {autoFeedEnabled && pocketTool ? (
          <AutoStepField label="Step Down" valueMM={effectiveStepDownMM(pocketTool, form.stepDownMM, form.pocketDepthMM)} />
        ) : (
          <div>
            <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Step Down</label>
            <div className="flex items-center gap-1">
              <NumericInput value={form.stepDownMM} min={0.1} step={0.5}
                onChange={(v) => up('stepDownMM', v)}
                className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
              />
              <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
            </div>
          </div>
        )}
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
            <NumericInput value={form.glueLineMM} min={0} step={0.05}
              onChange={(v) => up('glueLineMM', v)}
              className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
            />
            <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
          </div>
        </div>
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Clearance</label>
          <div className="flex items-center gap-1">
            <NumericInput value={form.clearanceMM} min={-1} max={1} step={0.05}
              onChange={(v) => up('clearanceMM', v)}
              className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
            />
            <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
          </div>
        </div>
      </div>
      {!editOp && (
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Generate</label>
          <div className="flex gap-1">
            {(['female', 'male'] as const).map((r) => (
              <button key={r} onClick={() => up('role', r)}
                className={[
                  'flex-1 py-1 text-body rounded border transition-colors capitalize',
                  form.role === r
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-gray-50 dark:bg-neutral-900 border-gray-300 dark:border-neutral-700 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200',
                ].join(' ')}>
                {r === 'female' ? 'Female' : 'Male'}
              </button>
            ))}
          </div>
          <p className="text-label text-gray-400 dark:text-neutral-500 mt-1">
            {isEndmillMode
              ? (form.role === 'female' ? 'Socket only — flat pocket, corners rounded to bit radius.' : 'Plug only — flat-sided plug, corners rounded to bit radius.')
              : (form.role === 'female' ? 'Socket only — pocket + V-carved walls.' : 'Plug only — V-carved bevel + profile cutout.')}
          </p>
        </div>
      )}
      {/* Ramp In — angled/helical entry on roughing pockets and end-mill finish passes */}
      <div className="flex items-center gap-2">
        <input type="checkbox" id="inlay-ramp-in" checked={form.rampIn}
          onChange={(e) => up('rampIn', e.target.checked)} className="accent-blue-500" />
        <label htmlFor="inlay-ramp-in" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
          Ramp In <span className="text-gray-500 dark:text-neutral-500 normal-case">(2× dia, 50% feed)</span>
        </label>
      </div>

      {/* Mirror option — male plug only */}
      {isMale && (
        <div className="flex items-center gap-2">
          <input type="checkbox" id="inlay-mirror" checked={form.mirrorX}
            onChange={(e) => up('mirrorX', e.target.checked)} className="accent-blue-500" />
          <label htmlFor="inlay-mirror" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
            Mirror <span className="text-gray-500 dark:text-neutral-500 normal-case">(flip horizontally — for asymmetric shapes inserted reversed)</span>
          </label>
        </div>
      )}
      <GenerateBtn disabled={!canGenerate} generating={generating} onClick={handleGenerate}
        label={editOp
          ? `Regenerate ${editOp.role === 'female' ? 'Female' : 'Male'}`
          : `Generate ${form.role === 'female' ? 'Female' : 'Male'}${groups.length > 1 ? ` (${groups.length * (finishIsNone ? 1 : 2)} ops)` : ''}`} />
    </FormShell>
  )
}

// ─── Surface form ─────────────────────────────────────────────────────────────

// ─── 3D Profile form ──────────────────────────────────────────────────────────

interface Profile3dFormState {
  toolId: string
  stepoverPercent: number
  rasterAngleDeg: number
  maxDepthMM: number
  pathId: string
  roughingToolId: string        // '' = no roughing pass
  roughingStepoverPercent: number
  roughingStepDownMM: number
  roughingStockAllowanceMM: number
  roughingRasterAngleDeg: number | ''  // '' = auto (finishing angle + 90)
}

export function Profile3dForm({ onClose, editOp }: { onClose: () => void; editOp?: Profile3dOperation }) {
  const { tools } = useToolStore()
  const { paths, pushHistoryBoth } = usePathsStore()
  const { addOperation, setSegments, setError, updateOperation } = useToolpathStore()
  const { load, save } = useFormDefaultsStore()
  const { safeHeightMM, autoFeedEnabled, thicknessMM } = useWorkpieceStore()

  const ballNoseTools = tools.filter((t) => t.type === 'ballnose')
  const defaultTool = ballNoseTools[0] ?? tools[0]
  const stlPaths = paths.filter((p) => !!p.stlSrc)

  const [form, setForm] = useState<Profile3dFormState>(() => editOp ? {
    toolId: editOp.toolId,
    stepoverPercent: editOp.stepoverPercent,
    rasterAngleDeg: editOp.rasterAngleDeg,
    maxDepthMM: editOp.maxDepthMM,
    pathId: editOp.pathId,
    roughingToolId: editOp.roughingToolId ?? '',
    roughingStepoverPercent: editOp.roughingStepoverPercent ?? 60,
    roughingStepDownMM: editOp.roughingStepDownMM ?? 2,
    roughingStockAllowanceMM: editOp.roughingStockAllowanceMM ?? 0.3,
    roughingRasterAngleDeg: editOp.roughingRasterAngleDeg ?? '',
  } : mergeWithDefaults(load('profile3d'), {
    toolId: defaultTool?.id ?? '',
    stepoverPercent: 20,
    rasterAngleDeg: 0,
    // Default to the full stock thickness; the tool's max Z is only a warning.
    maxDepthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    pathId: stlPaths[0]?.id ?? '',
    roughingToolId: '',
    roughingStepoverPercent: 60,
    roughingStepDownMM: 2,
    roughingStockAllowanceMM: 0.3,
    roughingRasterAngleDeg: '' as number | '',
  }, tools))
  const [generating, setGenerating] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Sync pathId: saved defaults use session-specific path IDs that become stale on reload.
  // Also handles importing an STL after the form is already open.
  useEffect(() => {
    if (!stlPaths.find((p) => p.id === form.pathId)) {
      const first = stlPaths[0]
      if (first) setForm((f) => ({ ...f, pathId: first.id }))
    }
  }, [stlPaths.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedTool = tools.find((t) => t.id === form.toolId)
  const selectedPath = paths.find((p) => p.id === form.pathId)
  const roughingTool = form.roughingToolId ? tools.find((t) => t.id === form.roughingToolId) : undefined
  const hasRoughing = !!form.roughingToolId

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId }))
  }

  function up<K extends keyof Profile3dFormState>(k: K, v: Profile3dFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleGenerate() {
    if (!selectedTool || !selectedPath || !selectedPath.stlSrc || !selectedPath.stlModelBounds) return
    pushHistoryBoth()
    setGenerating(true)
    setErrorMsg(null)

    setTimeout(async () => {
      try {
        const buf = base64ToArrayBuffer(selectedPath.stlSrc!)
        const geo = parseStlGeometry(buf)
        const positions = new Float32Array(geo.attributes.position.array)
        const indices = geo.index ? new Uint32Array(geo.index.array) : null
        geo.dispose()
        const cncBbox = getBBox(selectedPath.d)
        if (!cncBbox) throw new Error('Could not compute bounding box')

        const params = {
          stepoverPercent: form.stepoverPercent,
          rasterAngleDeg: form.rasterAngleDeg,
          maxDepthMM: form.maxDepthMM,
          roughingBallRadius: roughingTool?.type === 'ballnose' ? roughingTool.diameterMM / 2 : undefined,
          roughingStepoverPercent: hasRoughing ? form.roughingStepoverPercent : undefined,
          roughingStepDownMM: hasRoughing && roughingTool ? effectiveStepDownMM(roughingTool, form.roughingStepDownMM, form.maxDepthMM) : undefined,
          roughingStockAllowanceMM: hasRoughing ? form.roughingStockAllowanceMM : undefined,
          roughingRasterAngleDeg: hasRoughing && form.roughingRasterAngleDeg !== '' ? form.roughingRasterAngleDeg : undefined,
          roughingToolId: hasRoughing ? form.roughingToolId : undefined,
          finishingToolId: form.toolId,
          safeHeightMM,
        }
        const segments = await runInWorker('generateProfile3d', positions, indices, selectedPath.stlModelBounds!, cncBbox, selectedTool, params)

        const opName = hasRoughing
          ? `3D Profile: ${selectedPath.name} (rough: ${roughingTool?.name ?? ''} / finish: ${selectedTool.name})`
          : `3D Profile: ${selectedPath.name} (${selectedTool.name})`

        const roughingRasterAngle = hasRoughing && form.roughingRasterAngleDeg !== '' ? form.roughingRasterAngleDeg : undefined
        if (editOp) {
          updateOperation(editOp.id, {
            toolId: form.toolId,
            stepoverPercent: form.stepoverPercent,
            rasterAngleDeg: form.rasterAngleDeg, maxDepthMM: form.maxDepthMM,
            roughingToolId: hasRoughing ? form.roughingToolId : undefined,
            roughingStepoverPercent: hasRoughing ? form.roughingStepoverPercent : undefined,
            roughingStepDownMM: hasRoughing ? form.roughingStepDownMM : undefined,
            roughingStockAllowanceMM: hasRoughing ? form.roughingStockAllowanceMM : undefined,
            roughingRasterAngleDeg: roughingRasterAngle,
            name: opName, status: 'generating',
          } as Partial<AnyOperation>)
          setSegments(editOp.id, segments)
        } else {
          const newOpId = addOperation({
            name: opName,
            type: 'profile3d',
            toolId: form.toolId,
            pathId: form.pathId,
            stepoverPercent: form.stepoverPercent,
            rasterAngleDeg: form.rasterAngleDeg,
            maxDepthMM: form.maxDepthMM,
            roughingToolId: hasRoughing ? form.roughingToolId : undefined,
            roughingStepoverPercent: hasRoughing ? form.roughingStepoverPercent : undefined,
            roughingStepDownMM: hasRoughing ? form.roughingStepDownMM : undefined,
            roughingStockAllowanceMM: hasRoughing ? form.roughingStockAllowanceMM : undefined,
            roughingRasterAngleDeg: roughingRasterAngle,
          })
          updateOperation(newOpId, { status: 'generating' })
          setSegments(newOpId, segments)
        }
        save('profile3d', form)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Generation failed'
        setErrorMsg(msg)
        if (editOp) setError(editOp.id, msg)
      } finally {
        setGenerating(false)
      }
    }, 0)
  }

  const canGenerate = !!selectedTool && selectedTool.type === 'ballnose' && !!selectedPath?.stlSrc && !generating && form.maxDepthMM > 0

  return (
    <FormShell title={editOp ? 'Edit 3D Profile' : 'New 3D Profile Operation'} onClose={onClose}>
      {/* STL source path */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">STL Model</label>
        {stlPaths.length === 0 ? (
          <p className="text-body text-amber-400 flex items-center gap-1">
            <AlertCircle size={ICON.sm} /> Import an STL file first
          </p>
        ) : (
          <select
            value={form.pathId}
            onChange={(e) => up('pathId', e.target.value)}
            className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500"
          >
            {stlPaths.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Strategy */}
      {/* ── Roughing pass (optional) ─────────────────────────────────────────── */}
      <div className="border border-gray-200 dark:border-neutral-700 rounded p-2 space-y-2">
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
            Roughing Bit <span className="normal-case text-gray-400 dark:text-neutral-600">(optional)</span>
          </label>
          <select
            value={form.roughingToolId}
            onChange={(e) => up('roughingToolId', e.target.value)}
            className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500"
          >
            <option value="">— None (single-pass) —</option>
            {ballNoseTools.map((t) => (
              <option key={t.id} value={t.id}>{t.name} (Ø{t.diameterMM}mm)</option>
            ))}
          </select>
        </div>

        {hasRoughing && (
          <>
            <div>
              <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
                Roughing Stepover
              </label>
              <div className="flex items-center gap-1">
                <NumericInput
                  value={form.roughingStepoverPercent}
                  min={5} max={100} step={5}
                  onChange={(v) => up('roughingStepoverPercent', v)}
                  className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
                />
                <span className="text-label text-gray-400 dark:text-neutral-500">%</span>
                {roughingTool && (
                  <span className="text-label text-gray-400 dark:text-neutral-500 ml-1">
                    ({(roughingTool.diameterMM * form.roughingStepoverPercent / 100).toFixed(2)} mm)
                  </span>
                )}
              </div>
            </div>
            {autoFeedEnabled && roughingTool ? (
              <AutoStepField label="Roughing Step-Down" valueMM={effectiveStepDownMM(roughingTool, form.roughingStepDownMM, form.maxDepthMM)} />
            ) : (
              <div>
                <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
                  Roughing Step-Down
                </label>
                <div className="flex items-center gap-1">
                  <NumericInput
                    value={form.roughingStepDownMM}
                    min={0.1} max={50} step={0.5}
                    onChange={(v) => up('roughingStepDownMM', v)}
                    className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
                  />
                  <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
                </div>
              </div>
            )}
            <div>
              <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
                Roughing Angle
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  value={form.roughingRasterAngleDeg === '' ? '' : form.roughingRasterAngleDeg}
                  min={-180} max={180} step={15}
                  placeholder={`auto (${form.rasterAngleDeg + 90}°)`}
                  onChange={(e) => up('roughingRasterAngleDeg', e.target.value === '' ? '' : Number(e.target.value))}
                  className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
                />
                <span className="text-label text-gray-400 dark:text-neutral-500">°</span>
              </div>
            </div>
            <div>
              <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
                Stock Allowance
              </label>
              <div className="flex items-center gap-1">
                <NumericInput
                  value={form.roughingStockAllowanceMM}
                  min={0} max={2} step={0.1}
                  onChange={(v) => up('roughingStockAllowanceMM', v)}
                  className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
                />
                <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
              </div>
            </div>
            <p className="text-label text-blue-400 dark:text-blue-500">
              Roughing makes multiple passes at increasing depth; finishing cleans up to final surface
            </p>
          </>
        )}
      </div>

      {/* ── Finishing bit ────────────────────────────────────────────────────── */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          {hasRoughing ? 'Finishing Bit' : 'Tool'}
        </label>
        <select
          value={form.toolId}
          onChange={(e) => handleToolChange(e.target.value)}
          className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500"
        >
          {(ballNoseTools.length > 0 ? ballNoseTools : tools).map((t) => (
            <option key={t.id} value={t.id}>{t.name} (Ø{t.diameterMM}mm)</option>
          ))}
        </select>
      </div>
      {selectedTool && selectedTool.type !== 'ballnose' && (
        <p className="text-label text-amber-400 flex items-center gap-1">
          <AlertCircle size={ICON.xs} /> Ball nose tool recommended for 3D profiling
        </p>
      )}

      {/* Stepover */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          {hasRoughing ? 'Finishing Stepover' : 'Stepover'} (XY)
        </label>
        <div className="flex items-center gap-1">
          <NumericInput
            value={form.stepoverPercent}
            min={1} max={100} step={5}
            onChange={(v) => up('stepoverPercent', v)}
            className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
          />
          <span className="text-label text-gray-400 dark:text-neutral-500">%</span>
          {selectedTool && (
            <span className="text-label text-gray-400 dark:text-neutral-500 ml-1">
              ({(selectedTool.diameterMM * form.stepoverPercent / 100).toFixed(2)} mm)
            </span>
          )}
        </div>
      </div>

      {/* Raster angle */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Raster Angle</label>
        <div className="flex items-center gap-1">
          <NumericInput
            value={form.rasterAngleDeg}
            min={-90} max={90} step={15}
            onChange={(v) => up('rasterAngleDeg', v)}
            className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
          />
          <span className="text-label text-gray-400 dark:text-neutral-500">°</span>
        </div>
      </div>

      {/* Max depth */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Max Depth</label>
        <div className="flex items-center gap-1">
          <NumericInput
            value={form.maxDepthMM}
            min={0.1} step={0.5}
            onChange={(v) => up('maxDepthMM', v)}
            className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
          />
          <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
        </div>
        {selectedTool && form.maxDepthMM > selectedTool.maxDepthMM && (
          <p className="text-label text-amber-500 flex items-center gap-1 mt-0.5">
            <AlertCircle size={10} className="shrink-0" />
            Exceeds tool max ({selectedTool.maxDepthMM} mm)
          </p>
        )}
      </div>

      {errorMsg && (
        <p className="text-body text-red-400 flex items-start gap-1.5">
          <AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{errorMsg}
        </p>
      )}
      <GenerateBtn
        disabled={!canGenerate}
        generating={generating}
        onClick={handleGenerate}
        label={editOp ? 'Regenerate Toolpath' : 'Generate Toolpath'}
      />
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

export function SurfaceForm({ onClose, editOp }: { onClose: () => void; editOp?: SurfaceOperation }) {
  const { tools } = useToolStore()
  const { widthMM, heightMM, safeHeightMM } = useWorkpieceStore()
  const { pushHistoryBoth } = usePathsStore()
  const { addOperation, setSegments, setError, updateOperation } = useToolpathStore()
  const { load, save } = useFormDefaultsStore()

  const endMills = tools.filter((t) => t.type === 'endmill' || t.type === 'ballnose')
  const defaultTool = endMills[0] ?? tools[0]
  const [form, setForm] = useState<SurfaceFormState>(() => editOp ? {
    toolId: editOp.toolId, depthMM: editOp.depthMM, stepDownMM: editOp.stepDownMM,
    stepoverPercent: editOp.stepoverPercent, passAngleDeg: editOp.passAngleDeg,
  } : mergeWithDefaults(load('surface'), {
    toolId: defaultTool?.id ?? '',
    depthMM: defaultTool?.stepDownMM ?? 1,
    stepDownMM: defaultTool?.stepDownMM ?? 1,
    stepoverPercent: 40,
    passAngleDeg: 0,
  }, tools))
  const [generating, setGenerating] = useState(false)
  const selectedTool = tools.find((t) => t.id === form.toolId)

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, stepDownMM: t.stepDownMM }))
  }

  function up<K extends keyof SurfaceFormState>(k: K, v: SurfaceFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleGenerate() {
    if (!selectedTool) return
    pushHistoryBoth()
    setGenerating(true)
    if (editOp) {
      updateOperation(editOp.id, {
        toolId: form.toolId, depthMM: form.depthMM, stepDownMM: form.stepDownMM,
        stepoverPercent: form.stepoverPercent, passAngleDeg: form.passAngleDeg, status: 'generating',
      } as Partial<AnyOperation>)
      setTimeout(() => {
        try {
          setSegments(editOp.id, generateSurface(selectedTool, {
            widthMM, heightMM,
            depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(selectedTool, form.stepDownMM, form.depthMM),
            stepoverPercent: form.stepoverPercent, passAngleDeg: form.passAngleDeg,
            safeHeightMM,
          }))
        } catch (err) {
          setError(editOp.id, err instanceof Error ? err.message : 'Generation failed')
        }
        setGenerating(false)
        save('surface', form)
      }, 0)
      return
    }
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
          widthMM, heightMM,
          depthMM: form.depthMM,
          stepDownMM: effectiveStepDownMM(selectedTool, form.stepDownMM, form.depthMM),
          stepoverPercent: form.stepoverPercent,
          passAngleDeg: form.passAngleDeg,
          safeHeightMM,
        }))
      } catch (err) {
        setError(opId, err instanceof Error ? err.message : 'Generation failed')
      }
      setGenerating(false)
      save('surface', form)
    }, 0)
  }

  return (
    <FormShell title={editOp ? 'Edit Surface' : 'New Surface Operation'} onClose={onClose}>
      <div className="text-label text-gray-400 dark:text-neutral-500 bg-gray-50 dark:bg-neutral-900 rounded px-2 py-1.5">
        Covers workpiece: {widthMM} × {heightMM} mm
      </div>
      <ToolSelector
        tools={endMills.length > 0 ? endMills : tools}
        value={form.toolId}
        onChange={handleToolChange}
      />
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
        maxDepthMM={selectedTool?.maxDepthMM}
        tool={selectedTool}
      />
      <GenerateBtn
        disabled={!selectedTool || generating || form.depthMM <= 0}
        generating={generating}
        onClick={handleGenerate}
        label={editOp ? 'Regenerate Toolpath' : 'Generate Toolpath'}
      />
    </FormShell>
  )
}

// ─── Boolean form ────────────────────────────────────────────────────────────

interface BooleanFormState {
  opType: BooleanOpType
}

export function BooleanForm({ onClose }: { onClose: () => void }) {
  const { paths, selectedIds, addPaths, hidePathIds, pushHistoryBoth } = usePathsStore()
  const { load, save } = useFormDefaultsStore()

  const [form, setForm] = useState<BooleanFormState>(() => {
    const saved = load('boolean') as { opType?: BooleanOpType } | null
    return { opType: saved?.opType ?? 'union' }
  })
  const [error, setError] = useState<string | null>(null)

  const selectedPaths = paths.filter((p) => selectedIds.includes(p.id))
  const canApply = selectedPaths.length >= 2

  function handleApply() {
    setError(null)
    const result = applyBooleanOp(form.opType, selectedPaths.map((p) => p.d))
    if ('error' in result) { setError(result.error); return }
    if (!result.resultD) { setError('Result is empty'); return }
    pushHistoryBoth()
    const label = form.opType.charAt(0).toUpperCase() + form.opType.slice(1)
    const newPath = {
      id: `path-bool-${Date.now()}`,
      name: `${label} result`,
      d: result.resultD,
      visible: true,
      color: nextPathColor(),
    }
    addPaths([newPath])
    hidePathIds(selectedIds)
    usePathsStore.getState().setSelectedIds([newPath.id])
    save('boolean', form)
  }

  return (
    <FormShell title="Boolean Operation" onClose={onClose}>
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          Paths {selectedPaths.length > 0 && <span className="normal-case text-gray-500 dark:text-neutral-400">({selectedPaths.length} selected)</span>}
        </label>
        {canApply ? (
          <div className="space-y-0.5">
            {selectedPaths.map((p, i) => <PathChip key={p.id} path={p} label={i === 0 ? 'primary' : 'operand'} />)}
          </div>
        ) : (
          <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> Select 2+ paths on the canvas first</p>
        )}
      </div>
      <ToggleRow label="Operation" options={['union', 'intersect', 'subtract'] as BooleanOpType[]} value={form.opType} onChange={(v) => setForm((f) => ({ ...f, opType: v }))} />
      {error && <p className="text-body text-red-400 flex items-start gap-1.5"><AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{error}</p>}
      <GenerateBtn disabled={!canApply} generating={false} onClick={handleApply} label="Apply Boolean" />
    </FormShell>
  )
}

// ─── Offset form ──────────────────────────────────────────────────────────────

interface OffsetFormState {
  distanceMM: number
  cornerStyle: OffsetCornerStyle
}

export function OffsetForm({ onClose }: { onClose: () => void }) {
  const { paths, selectedIds, addPaths, pushHistoryBoth } = usePathsStore()
  const { load, save } = useFormDefaultsStore()
  const { units } = useWorkpieceStore()

  const [form, setForm] = useState<OffsetFormState>(() => {
    const saved = load('offset') as { distanceMM?: number; cornerStyle?: OffsetCornerStyle } | null
    return {
      distanceMM: saved?.distanceMM ?? 5,
      cornerStyle: saved?.cornerStyle ?? 'miter',
    }
  })
  const [error, setError] = useState<string | null>(null)

  const selectedPaths = paths.filter((p) => selectedIds.includes(p.id))
  const canApply = selectedPaths.length >= 1

  function up<K extends keyof OffsetFormState>(k: K, v: OffsetFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleApply() {
    setError(null)
    const newPaths = selectedPaths.map((p) => {
      const resultD = applyOffset(p.d, { distanceMM: form.distanceMM, cornerStyle: form.cornerStyle })
      if (!resultD) return null
      return {
        id: `path-offset-${Date.now()}-${Math.random()}`,
        name: `${p.name} offset`,
        d: resultD,
        visible: true,
        color: nextPathColor(),
      }
    }).filter(Boolean) as Parameters<typeof addPaths>[0]
    if (newPaths.length === 0) { setError('Offset produced no geometry'); return }
    pushHistoryBoth()
    addPaths(newPaths)
    usePathsStore.getState().setSelectedIds(newPaths.map((p) => p.id))
    save('offset', form)
  }

  const inputCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0'

  return (
    <FormShell title="Offset Path" onClose={onClose}>
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Paths</label>
        {canApply ? (
          <div className="space-y-0.5">
            {selectedPaths.map((p) => <PathChip key={p.id} path={p} label="selected" />)}
          </div>
        ) : (
          <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> Select a path first</p>
        )}
      </div>
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Distance</label>
        <div className="flex items-center gap-1">
          <NumericInput
            value={fromMM(form.distanceMM, units as 'mm' | 'in')}
            step={units === 'in' ? 0.0625 : 0.5}
            onChange={(v) => up('distanceMM', toMM(v, units as 'mm' | 'in'))}
            className={inputCls}
          />
          <span className="text-label text-gray-400 dark:text-neutral-500">{units}</span>
        </div>
        <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">Positive = outset, negative = inset</p>
      </div>
      <ToggleRow label="Corner Style" options={['miter', 'round', 'square'] as OffsetCornerStyle[]} value={form.cornerStyle} onChange={(v) => up('cornerStyle', v)} />
      {error && <p className="text-body text-red-400 flex items-start gap-1.5"><AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{error}</p>}
      <GenerateBtn disabled={!canApply} generating={false} onClick={handleApply} label="Apply Offset" />
    </FormShell>
  )
}

// ─── Pattern form ─────────────────────────────────────────────────────────────

interface PatternLinParams { rows: number; cols: number; xSpacingMM: number; ySpacingMM: number }
interface PatternCirParams { count: number; radiusMM: number; startAngleDeg: number; endAngleDeg: number; rotateItems: boolean }
interface PatternFormState {
  mode: 'linear' | 'circular'
  linParams: PatternLinParams
  cirParams: PatternCirParams
}

export function PatternForm({ onClose }: { onClose: () => void }) {
  const { paths, selectedIds, addPaths, pushHistoryBoth } = usePathsStore()
  const { load, save } = useFormDefaultsStore()
  const { units } = useWorkpieceStore()

  const [form, setForm] = useState<PatternFormState>(() => {
    const saved = load('pattern') as Partial<PatternFormState> | null
    return {
      mode: saved?.mode ?? 'linear',
      linParams: saved?.linParams ?? { rows: 2, cols: 3, xSpacingMM: 20, ySpacingMM: 20 },
      cirParams: saved?.cirParams ?? { count: 6, radiusMM: 30, startAngleDeg: 0, endAngleDeg: 360, rotateItems: true },
    }
  })
  const [error, setError] = useState<string | null>(null)

  const selectedPaths = paths.filter((p) => selectedIds.includes(p.id))
  const canApply = selectedPaths.length >= 1

  function upLin<K extends keyof PatternLinParams>(k: K, v: PatternLinParams[K]) {
    setForm((f) => ({ ...f, linParams: { ...f.linParams, [k]: v } }))
  }
  function upCir<K extends keyof PatternCirParams>(k: K, v: PatternCirParams[K]) {
    setForm((f) => ({ ...f, cirParams: { ...f.cirParams, [k]: v } }))
  }

  function handleApply() {
    setError(null)
    const params = form.mode === 'linear'
      ? { type: 'linear' as const, ...form.linParams }
      : { type: 'circular' as const, ...form.cirParams }
    const instances = computePatternInstances(params)
    if (instances.length === 0) { setError('Pattern produced no instances'); return }
    const instancesToCreate = form.mode === 'linear' ? instances.slice(1) : instances
    const newPaths: Parameters<typeof addPaths>[0] = []
    for (const inst of instancesToCreate) {
      for (const src of selectedPaths) {
        newPaths.push({
          id: `path-pattern-${Date.now()}-${Math.random()}`,
          name: `${src.name} ${inst.index !== undefined ? inst.index + 1 : `r${inst.row}c${inst.col}`}`,
          d: applyPatternInstance(src.d, inst),
          visible: true,
          color: src.color,
        })
      }
    }
    if (newPaths.length === 0) { setError('Pattern produced no geometry'); return }
    pushHistoryBoth()
    addPaths(newPaths)
    save('pattern', form)
  }

  const inputCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0'
  const u = units

  return (
    <FormShell title="Pattern" onClose={onClose}>
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Paths</label>
        {canApply ? (
          <div className="space-y-0.5">
            {selectedPaths.map((p) => <PathChip key={p.id} path={p} label="selected" />)}
          </div>
        ) : (
          <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> Select a path first</p>
        )}
      </div>
      <ToggleRow label="Mode" options={['linear', 'circular'] as const} value={form.mode} onChange={(v) => setForm((f) => ({ ...f, mode: v }))} />
      {form.mode === 'linear' ? (
        <div className="grid grid-cols-2 gap-2">
          {([
            ['Rows', form.linParams.rows, (v: number) => upLin('rows', Math.max(1, Math.round(v))), 1, 1, ''],
            ['Cols', form.linParams.cols, (v: number) => upLin('cols', Math.max(1, Math.round(v))), 1, 1, ''],
            ['X Gap', fromMM(form.linParams.xSpacingMM, u as 'mm' | 'in'), (v: number) => upLin('xSpacingMM', toMM(v, u as 'mm' | 'in')), 0, u === 'in' ? 0.0625 : 1, u],
            ['Y Gap', fromMM(form.linParams.ySpacingMM, u as 'mm' | 'in'), (v: number) => upLin('ySpacingMM', toMM(v, u as 'mm' | 'in')), 0, u === 'in' ? 0.0625 : 1, u],
          ] as [string, number, (v: number) => void, number, number, string][]).map(([lbl, val, fn, min, step, suffix]) => (
            <div key={lbl}>
              <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">{lbl}</label>
              <div className="flex items-center gap-1">
                <NumericInput value={val} min={min} step={step}
                  onChange={fn}
                  className={inputCls} />
                {suffix && <span className="text-label text-gray-400 dark:text-neutral-500">{suffix}</span>}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            {([
              ['Count', form.cirParams.count, (v: number) => upCir('count', Math.max(2, Math.round(v))), 2, 1, ''],
              ['Radius', fromMM(form.cirParams.radiusMM, u as 'mm' | 'in'), (v: number) => upCir('radiusMM', toMM(v, u as 'mm' | 'in')), 0.1, u === 'in' ? 0.0625 : 1, u],
              ['Start°', form.cirParams.startAngleDeg, (v: number) => upCir('startAngleDeg', v), -360, 5, '°'],
              ['End°',   form.cirParams.endAngleDeg,   (v: number) => upCir('endAngleDeg', v),   -360, 5, '°'],
            ] as [string, number, (v: number) => void, number, number, string][]).map(([lbl, val, fn, min, step, suffix]) => (
              <div key={lbl}>
                <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">{lbl}</label>
                <div className="flex items-center gap-1">
                  <NumericInput value={val} min={min} step={step}
                    onChange={fn}
                    className={inputCls} />
                  {suffix && <span className="text-label text-gray-400 dark:text-neutral-500">{suffix}</span>}
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="pattern-rotate" checked={form.cirParams.rotateItems}
              onChange={(e) => upCir('rotateItems', e.target.checked)} className="accent-blue-500" />
            <label htmlFor="pattern-rotate" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">Items face outward</label>
          </div>
        </div>
      )}
      {error && <p className="text-body text-red-400 flex items-start gap-1.5"><AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{error}</p>}
      <GenerateBtn disabled={!canApply} generating={false} onClick={handleApply} label="Apply Pattern" />
    </FormShell>
  )
}

// ─── Tabs form ────────────────────────────────────────────────────────────────

interface TabsFormState {
  count: number
  lengthMM: number
  heightMM: number
}

export function TabsForm({ onClose }: { onClose: () => void }) {
  const { paths, selectedIds, pushHistoryBoth } = usePathsStore()
  const { tabs, applyTabs, deleteTab, deletePathTabs } = useTabStore()
  const { load, save } = useFormDefaultsStore()
  const { units } = useWorkpieceStore()

  const [form, setForm] = useState<TabsFormState>(() => {
    const saved = load('tabs') as { count?: number; lengthMM?: number; heightMM?: number } | null
    return {
      count: saved?.count ?? 4,
      lengthMM: saved?.lengthMM ?? 5,
      heightMM: saved?.heightMM ?? 2,
    }
  })

  const singlePath = selectedIds.length === 1 ? paths.find((p) => p.id === selectedIds[0]) ?? null : null
  const pathTabs = singlePath ? tabs.filter((t) => t.pathId === singlePath.id) : []

  function up<K extends keyof TabsFormState>(k: K, v: TabsFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleApply() {
    if (!singlePath) return
    pushHistoryBoth()
    applyTabs(singlePath.id, form.count, singlePath.d, form.lengthMM, form.heightMM)
    regenerateAffected(singlePath.id)
    save('tabs', form)
  }

  function handleDelete(id: string) {
    pushHistoryBoth()
    deleteTab(id)
    if (singlePath) regenerateAffected(singlePath.id)
  }

  function handleClearAll() {
    if (!singlePath) return
    pushHistoryBoth()
    deletePathTabs(singlePath.id)
    regenerateAffected(singlePath.id)
  }

  const inputCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0'
  const u = units

  return (
    <FormShell title="Holding Tabs" onClose={onClose}>
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Path</label>
        {singlePath ? (
          <PathChip path={singlePath} label="selected" />
        ) : (
          <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> Select a single path on the canvas first</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Count</label>
          <NumericInput value={form.count} min={1} max={20} step={1} integer
            onChange={(v) => up('count', v)}
            className={inputCls} />
        </div>
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Height</label>
          <div className="flex items-center gap-1">
            <NumericInput value={fromMM(form.heightMM, u as 'mm' | 'in')} min={0.1} step={u === 'in' ? 0.0625 : 0.5}
              onChange={(v) => up('heightMM', toMM(v, u as 'mm' | 'in'))}
              className={inputCls} />
            <span className="text-label text-gray-400 dark:text-neutral-500">{u}</span>
          </div>
        </div>
      </div>
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Length</label>
        <div className="flex items-center gap-1">
          <NumericInput value={fromMM(form.lengthMM, u as 'mm' | 'in')} min={0.5} step={u === 'in' ? 0.0625 : 1}
            onChange={(v) => up('lengthMM', toMM(v, u as 'mm' | 'in'))}
            className={inputCls} />
          <span className="text-label text-gray-400 dark:text-neutral-500">{u}</span>
        </div>
        <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">Tab width along the path edge</p>
      </div>
      <GenerateBtn disabled={!singlePath} generating={false} onClick={handleApply} label="Apply Tabs" />
      {pathTabs.length > 0 && (
        <div className="space-y-1">
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider">
            Current Tabs <span className="normal-case text-gray-500 dark:text-neutral-400">({pathTabs.length})</span>
          </label>
          {pathTabs.map((tab, i) => (
            <div key={tab.id} className="flex items-center gap-1.5 text-body text-gray-700 dark:text-neutral-300 bg-gray-50 dark:bg-neutral-900 rounded px-2 py-1">
              <span className="flex-1">Tab {i + 1} — {(tab.t * 100).toFixed(0)}% along path</span>
              <button onClick={() => handleDelete(tab.id)}
                className="p-0.5 rounded hover:bg-red-900/40 text-gray-400 dark:text-neutral-500 hover:text-red-400 transition-colors flex-shrink-0">
                <Trash2 size={ICON.xs} />
              </button>
            </div>
          ))}
          <button onClick={handleClearAll}
            className="w-full py-1 rounded text-label border border-gray-200 dark:border-neutral-600 text-gray-400 dark:text-neutral-500 hover:text-red-400 hover:border-red-400 transition-colors">
            Clear All Tabs
          </button>
        </div>
      )}
    </FormShell>
  )
}

// ─── Node Edit / Corner Treatment form ───────────────────────────────────────

interface NodeEditFormState {
  treatmentType: CornerTreatmentType
  radiusMM: number
}

const CORNER_TREATMENTS: { type: CornerTreatmentType; label: string; desc: string; preview: string }[] = [
  { type: 'outerRound', label: 'Outer Round', desc: 'Arc rounding the outside of the corner', preview: '╮' },
  { type: 'innerRound', label: 'Inner Round', desc: 'Concave arc curving into the corner (fillet)', preview: '⌒' },
  { type: 'chamfer',    label: 'Chamfer',     desc: 'Straight bevel cut across the corner', preview: '╱' },
  { type: 'dogbone',    label: 'Dogbone',     desc: 'Circular notch for CNC internal corners', preview: '⦿' },
]

export function NodeEditForm({ onClose }: { onClose: () => void }) {
  const { paths, selectedIds, batchUpdatePaths, pushHistoryBoth } = usePathsStore()
  const { setNodeEditPathId } = useUIStore()
  const { load, save } = useFormDefaultsStore()

  const [form, setForm] = useState<NodeEditFormState>(() => {
    const saved = load('nodeedit') as NodeEditFormState | null
    return {
      treatmentType: (saved?.treatmentType ?? 'chamfer') as CornerTreatmentType,
      radiusMM: saved?.radiusMM ?? 2,
    }
  })

  // Clear any active node-edit overlay when this panel closes
  useEffect(() => () => { setNodeEditPathId(null) }, [])

  const selectedPaths = paths.filter((p) => selectedIds.includes(p.id))
  const activePath = selectedPaths.length === 1 ? selectedPaths[0] : null

  function handleApply() {
    if (!activePath) return
    pushHistoryBoth()
    const newD = applyCornerTreatment(activePath.d, { type: form.treatmentType, radiusMM: form.radiusMM })
    if (newD === activePath.d) return
    batchUpdatePaths([{ id: activePath.id, d: newD, shapeParams: null }])
    regenerateAffected(activePath.id)
    save('nodeedit', form)
  }

  function up<K extends keyof NodeEditFormState>(k: K, v: NodeEditFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  return (
    <FormShell title="Corner Treatment" onClose={onClose}>
      {/* Selected path */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Path</label>
        {activePath ? (
          <PathChip path={activePath} label="selected" />
        ) : (
          <p className="text-body text-amber-400 flex items-center gap-1">
            <AlertCircle size={ICON.sm} /> Select exactly one path on canvas
          </p>
        )}
      </div>

      {/* Corner treatment section */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Corner Treatment</label>
        <div className="grid grid-cols-2 gap-1">
          {CORNER_TREATMENTS.map(({ type, label, desc }) => (
            <button
              key={type}
              title={desc}
              onClick={() => up('treatmentType', type)}
              className={[
                'py-1.5 px-2 rounded border text-body text-left transition-colors',
                form.treatmentType === type
                  ? 'border-blue-500 bg-blue-500/20 text-blue-300'
                  : 'border-gray-200 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:border-gray-300 dark:hover:border-neutral-500',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Radius */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          {form.treatmentType === 'dogbone' ? 'Tool Radius' : 'Radius'} (mm)
        </label>
        <NumericInput
          value={form.radiusMM}
          min={0.01}
          step={0.5}
          onChange={(v) => up('radiusMM', v)}
          className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 font-mono focus:outline-none focus:border-blue-500"
        />
        <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">
          Applied to all sharp corner nodes. Use Undo to revert.
        </p>
      </div>

      <button
        disabled={!activePath}
        onClick={handleApply}
        className="w-full py-1.5 rounded text-body font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-blue-600 hover:bg-blue-500 text-white"
      >
        Apply to All Corners
      </button>
    </FormShell>
  )
}

// ─── Operation type selector ──────────────────────────────────────────────────

type OpType = 'profile' | 'trochoidal' | 'pocket' | 'drill' | 'surface' | 'vcarve' | 'inlay' | 'profile3d' | 'boolean' | 'offset' | 'pattern' | 'tabs' | 'nodeedit'
type FormState = null | 'menu' | OpType

const opBtnCls = 'flex flex-col items-center gap-0.5 py-1.5 rounded text-body transition-colors border border-gray-200 dark:border-neutral-600 hover:border-gray-300 dark:hover:border-neutral-500'

function AddOperationMenu({ onSelect }: { onSelect: (t: OpType) => void }) {
  return (
    <div className="px-3 py-2 space-y-2 border-b border-gray-300 dark:border-neutral-700">
      <p className="text-label font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider">CAM Operations</p>
      <div className="grid grid-cols-3 gap-1">
        {([
          ['profile', 'Profile', 'Cut along path edge', <Circle size={ICON.md} />],
          ['trochoidal', 'Trochoidal', 'Looping cuts along path — reduces engagement, ideal for hard materials', <RefreshCw size={ICON.md} />],
          ['pocket', 'Pocket', 'Clear inside boundary', <Target size={ICON.md} />],
          ['drill', 'Drill', 'Peck or helical drill', <CircleDot size={ICON.md} />],
          ['surface', 'Surface', 'Flatten workpiece top', <Layers size={ICON.md} />],
          ['vcarve', 'V-Carve', 'V-bit depth-varying carve', <Star size={ICON.md} />],
          ['inlay', 'Inlay', 'V-carved sloped walls with flat pocket bottom', <InlayIcon size={ICON.md} />],
          ['profile3d', '3D Profile', 'Follow STL relief surface with ball nose', <Box size={ICON.md} />],
        ] as [OpType, string, string, React.ReactNode][]).map(([type, name, desc, icon]) => (
          <button key={type} onClick={() => onSelect(type)} title={desc} className={opBtnCls}>
            <span style={{ color: OP_TYPE_COLORS[type] }}>{icon}</span>
            <span className="text-label text-gray-500 dark:text-neutral-400">{name}</span>
          </button>
        ))}
      </div>
      <p className="text-label font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider">Path Tools</p>
      <div className="grid grid-cols-3 gap-1">
        {([
          ['boolean', 'Boolean', 'Union, intersect, or subtract paths', <SquaresUnite size={ICON.md} />],
          ['offset', 'Offset', 'Inset or outset path by distance', <SquareSquare size={ICON.md} />],
          ['pattern', 'Pattern', 'Linear or circular array', <LayoutGrid size={ICON.md} />],
          ['tabs', 'Tabs', 'Add holding tabs to keep part from moving', <RectangleEllipsis size={ICON.md} />],
          ['nodeedit', 'Corners', 'Apply corner treatments: round, chamfer, dogbone', <VectorSquare size={ICON.md} />],
        ] as [OpType, string, string, React.ReactNode][]).map(([type, name, desc, icon]) => (
          <button key={type} onClick={() => onSelect(type)} title={desc} className={opBtnCls}>
            <span style={{ color: OP_TYPE_COLORS[type as string] ?? '#94a3b8' }}>{icon}</span>
            <span className="text-label text-gray-500 dark:text-neutral-400">{name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export default function MachinePanel({ fill = false }: { fill?: boolean }) {
  const { machineFormActive, setMachineFormActive, setActiveTool, setTabsFormActive } = useUIStore()
  const [activeForm, setActiveForm] = useState<FormState>('menu')

  useEffect(() => () => { setMachineFormActive(false); setTabsFormActive(false) }, [setMachineFormActive, setTabsFormActive])
  useEffect(() => { setTabsFormActive(activeForm === 'tabs') }, [activeForm, setTabsFormActive])
  useEffect(() => { if (!machineFormActive) setActiveForm('menu') }, [machineFormActive])

  const openForm = (t: FormState) => { setActiveForm(t); setMachineFormActive(true); setActiveTool('select') }
  const closeForm = () => { setActiveForm('menu'); setMachineFormActive(false) }

  return (
    <div className={fill ? 'flex-1 overflow-y-auto' : ''}>
      {activeForm === 'menu' ? (
        <AddOperationMenu onSelect={openForm} />
      ) : activeForm === 'profile' ? (
        <ProfileForm onClose={closeForm} />
      ) : activeForm === 'trochoidal' ? (
        <TrochoidalForm onClose={closeForm} />
      ) : activeForm === 'pocket' ? (
        <PocketForm onClose={closeForm} />
      ) : activeForm === 'drill' ? (
        <DrillForm onClose={closeForm} />
      ) : activeForm === 'profile3d' ? (
        <Profile3dForm onClose={closeForm} />
      ) : activeForm === 'surface' ? (
        <SurfaceForm onClose={closeForm} />
      ) : activeForm === 'vcarve' ? (
        <VCarveForm onClose={closeForm} />
      ) : activeForm === 'inlay' ? (
        <InlayForm onClose={closeForm} />
      ) : activeForm === 'boolean' ? (
        <BooleanForm onClose={closeForm} />
      ) : activeForm === 'offset' ? (
        <OffsetForm onClose={closeForm} />
      ) : activeForm === 'pattern' ? (
        <PatternForm onClose={closeForm} />
      ) : activeForm === 'tabs' ? (
        <TabsForm onClose={closeForm} />
      ) : activeForm === 'nodeedit' ? (
        <NodeEditForm onClose={closeForm} />
      ) : null}
    </div>
  )
}
