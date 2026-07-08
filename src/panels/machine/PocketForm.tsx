// ─── Pocket form ──────────────────────────────────────────────────────────────
import { FormShell, PathChip, ToolSelector, ToggleRow, DepthRow, GenerateBtn } from './shared'
import { useState } from 'react'
import { NumericInput } from '../../components/NumericInput'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore, type CuttingDirection } from '../../store/toolStore'
import { useToolpathStore, type AnyOperation, type PocketOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { runInWorker } from '../../workers/workerClient'
import type { PocketStrategy } from '../../cam/pocket'
import { effectiveStepDownMM } from '../../cam/feeds'
import { groupPathsByContainment } from './containment'

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
