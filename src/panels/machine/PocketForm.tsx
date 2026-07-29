// ─── Pocket form ──────────────────────────────────────────────────────────────
import { FormShell, PathChip, ToolSelector, ToggleRow, DepthRow, GenerateBtn, useSessionOps, StartRow, useStartZ } from './shared'
import { resolveStartZ, type StartFrom } from '../../cam/startHeight'
import { useState } from 'react'
import { NumericInput } from '../../components/NumericInput'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore, type CuttingDirection } from '../../store/toolStore'
import { useToolpathStore, type AnyOperation, type PocketOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useSelectedPaths } from '../../store/pathsStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { runInWorkerFor } from '../../workers/workerClient'
import type { PocketStrategy } from '../../cam/pocket'
import { effectiveStepDownMM } from '../../cam/feeds'
import { groupPathsByContainment } from './containment'
import { entryHintAt } from '../../cam/startOptimizer'

interface PocketFormState {
  toolId: string
  strategy: PocketStrategy
  depthMM: number
  stepDownMM: number
  stepoverPercent: number
  passAngleDeg: number
  autoAngle: boolean
  direction: CuttingDirection
  rampIn: boolean
  allowanceMM: number
  startFrom: StartFrom
}

export function PocketForm({ onClose, editOp }: { onClose: () => void; editOp?: PocketOperation }) {
  const { tools } = useToolStore()
  const { paths } = usePathsStore()
  const selPaths = useSelectedPaths()
  const { addOperation, setSegments, setError, updateOperation } = useToolpathStore()
  const { load, save } = useFormDefaultsStore()
  const { safeHeightMM, thicknessMM, widthMM, heightMM } = useWorkpieceStore()

  const defaultTool = tools[0]
  const [form, setForm] = useState<PocketFormState>(() => editOp ? {
    toolId: editOp.toolId, strategy: editOp.strategy ?? 'raster',
    depthMM: editOp.depthMM, stepDownMM: editOp.stepDownMM,
    stepoverPercent: editOp.stepoverPercent, passAngleDeg: editOp.passAngleDeg,
    autoAngle: editOp.autoAngle ?? true,
    direction: editOp.direction, rampIn: editOp.rampIn ?? false,
    allowanceMM: editOp.allowanceMM ?? 0,
    // Legacy ops (saved before start heights existed) stay on stock top rather than
    // silently deepening when re-generated; new ops default to auto.
    startFrom: editOp.startFrom ?? { mode: 'stock' },
  } : { ...mergeWithDefaults(load('pocket'), {
    toolId: defaultTool?.id ?? '',
    // 'hybrid' — shown as "Auto". Note this is only the default for a FIRST pocket: the
    // form-defaults store replays whatever was last used after that.
    strategy: 'hybrid' as PocketStrategy,
    // Default to the full stock thickness; the tool's max Z is only a warning.
    depthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    stepDownMM: defaultTool?.stepDownMM ?? 3,
    stepoverPercent: 40,
    passAngleDeg: 0,
    autoAngle: true,
    direction: (defaultTool?.direction ?? 'climb') as CuttingDirection,
    rampIn: false,
    allowanceMM: 0,
    // Never restored from the saved form defaults: a start reference belongs to the
    // operation it was chosen for, and replaying an old one onto a new pocket is exactly
    // the "silently starts 2 mm down over solid stock" case this design exists to avoid.
    startFrom: { mode: 'auto' } as StartFrom,
  }, tools), startFrom: { mode: 'auto' } })
  const [generating, setGenerating] = useState(false)
  const session = useSessionOps()

  const editBoundary = editOp ? paths.find((p) => p.id === editOp.pathId) : null
  const editIslands = editOp ? paths.filter((p) => editOp.islandIds.includes(p.id)) : []
  const groups = editOp && editBoundary
    ? [{ boundary: editBoundary, islands: editIslands }]
    : groupPathsByContainment(selPaths)
  const selectedTool = tools.find((t) => t.id === form.toolId)
  // One resolve per form render, shared by the Start row and every group generated below.
  // Multi-group selections all share the first group's footprint here; each group re-resolves
  // for real at generation time.
  // Margin 0: a pocket's cutter stays a full radius INSIDE its boundary, so the cleared
  // area never reaches past the path.
  const startZ = useStartZ(form.startFrom, groups[0]?.boundary.d ?? '', 0, editOp?.id)
  const updating = !editOp && groups.length > 0 && groups.every(({ boundary }) => session.liveOpId(boundary.id))
  const adaptiveStrategy = form.strategy === 'adaptive' || form.strategy === 'adaptive2' || form.strategy === 'hybrid'
  const autoPassAngle = form.strategy === 'hybrid' && form.autoAngle

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, stepDownMM: t.stepDownMM, direction: t.direction }))
  }

  function handleStrategyChange(strategy: PocketStrategy) {
    const adaptive = strategy === 'adaptive' || strategy === 'adaptive2' || strategy === 'hybrid'
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
    setGenerating(true)
    // Resolved per group and against live store state, since each group has its own
    // footprint and the ops added earlier in this loop count as preceding.
    const startZFor = (boundaryD: string, opId?: string) => resolveStartZ(
      { startFrom: form.startFrom, footprintD: boundaryD, cutMarginMM: 0, opId },
      useToolpathStore.getState().operations, usePathsStore.getState().paths,
      { widthMM, heightMM },
    ).zMM
    // Run the (potentially slow, e.g. adaptive) pocket generation off the main thread so the
    // browser stays responsive — same worker pattern as regenerate.ts. Awaiting the worker also
    // lets React paint the 'generating' state, so the old setTimeout(…,0) yield is unnecessary.
    try {
      if (editOp && editBoundary) {
        // Chain this op to where the previous one finishes, at generation time — so no
        // regeneration is needed before simulating or exporting.
        const hint = entryHintAt(editOp.id)
        updateOperation(editOp.id, {
          entryHint: hint,
          toolId: form.toolId, strategy: form.strategy,
          depthMM: form.depthMM, stepDownMM: form.stepDownMM,
          stepoverPercent: form.stepoverPercent, passAngleDeg: form.passAngleDeg,
          direction: form.direction, rampIn: form.rampIn, allowanceMM: form.allowanceMM,
          startFrom: form.startFrom, status: 'generating',
        } as Partial<AnyOperation>)
        try {
          setSegments(editOp.id, await runInWorkerFor(editOp.id, 'generatePocket', editBoundary.d, tool, {
            strategy: form.strategy,
            depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(tool, form.stepDownMM, form.depthMM),
            stepoverPercent: form.stepoverPercent, direction: form.direction,
            islandDs: editIslands.map((p) => p.d), angle: form.passAngleDeg, autoAngle: form.autoAngle, rampIn: form.rampIn,
            finishAllowanceMM: form.allowanceMM, startNear: hint,
            startZMM: startZFor(editBoundary.d, editOp.id),
            safeHeightMM,
          }))
        } catch (err) {
          setError(editOp.id, err instanceof Error ? err.message : 'Generation failed')
        }
      } else {
        for (const { boundary, islands } of groups) {
          // Re-Generate on a boundary this form already generated for updates that op in place.
          const existingId = session.liveOpId(boundary.id)
          const name = `Pocket: ${boundary.name} (${tool.name})`
          const opId = existingId ?? addOperation({
            name,
            type: 'pocket',
            toolId: form.toolId,
            strategy: form.strategy,
            pathId: boundary.id,
            islandIds: islands.map((p) => p.id),
            depthMM: form.depthMM,
            stepDownMM: form.stepDownMM,
            stepoverPercent: form.stepoverPercent,
            passAngleDeg: form.passAngleDeg,
            autoAngle: form.autoAngle,
            direction: form.direction,
            rampIn: form.rampIn,
            allowanceMM: form.allowanceMM,
            startFrom: form.startFrom,
          })
          if (!existingId) session.remember(boundary.id, opId)
          const hint = entryHintAt(opId)
          updateOperation(opId, existingId ? {
            entryHint: hint,
            name, toolId: form.toolId, strategy: form.strategy,
            islandIds: islands.map((p) => p.id),
            depthMM: form.depthMM, stepDownMM: form.stepDownMM,
            stepoverPercent: form.stepoverPercent, passAngleDeg: form.passAngleDeg, autoAngle: form.autoAngle,
            direction: form.direction, rampIn: form.rampIn, allowanceMM: form.allowanceMM,
            startFrom: form.startFrom, status: 'generating',
          } as Partial<AnyOperation> : { entryHint: hint, status: 'generating' })
          try {
            setSegments(opId, await runInWorkerFor(opId, 'generatePocket', boundary.d, tool, {
              strategy: form.strategy,
              depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(tool, form.stepDownMM, form.depthMM),
              stepoverPercent: form.stepoverPercent, direction: form.direction,
              islandDs: islands.map((p) => p.d), angle: form.passAngleDeg, autoAngle: form.autoAngle, rampIn: form.rampIn,
              finishAllowanceMM: form.allowanceMM, startNear: hint,
              startZMM: startZFor(boundary.d, opId),
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
      {/* 'hybrid' is shown as "Auto" — it picks per area: raster the open ground, contour
          around islands, adaptive on the junctions between them. Listed first as the one to
          reach for by default.
          'adaptive' (the old Adaptive2d port) stays hidden — too slow; 'adaptive2' is the
          fast raster-marching engine and is what the UI shows as "adaptive".
          The ids are what saved projects store, so they stay as they are. */}
      <ToggleRow label="Strategy" options={['hybrid', 'raster', 'contour', 'morph', 'adaptive2'] as PocketStrategy[]} value={form.strategy} onChange={handleStrategyChange} labels={{ hybrid: 'auto', adaptive2: 'adaptive' }} />
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          {form.strategy === 'adaptive' || form.strategy === 'adaptive2' || form.strategy === 'hybrid' ? 'Engagement' : 'Stepover'} <span className="text-gray-500 dark:text-neutral-400 normal-case">{form.stepoverPercent}%</span>
        </label>
        <input
          type="range" min={adaptiveStrategy ? 5 : 10} max={adaptiveStrategy ? 60 : 90} step={5}
          value={form.stepoverPercent}
          onChange={(e) => up('stepoverPercent', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>
      {/* Pass angle — the raster strategy, and Auto where it drives the raster sub-areas.
          Auto picks the angle per area that makes its passes longest; pin it when the cut
          direction matters for its own sake (grain, for instance). */}
      {(form.strategy === 'raster' || form.strategy === 'hybrid') && (
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
            Pass Angle <span className="text-gray-500 dark:text-neutral-400 normal-case">{autoPassAngle ? 'auto' : `${form.passAngleDeg}°`}</span>
          </label>
          {form.strategy === 'hybrid' && (
            <div className="flex items-center gap-2 mb-1">
              <input type="checkbox" id="pocket-auto-angle" checked={form.autoAngle}
                onChange={(e) => up('autoAngle', e.target.checked)} className="accent-blue-500" />
              <label htmlFor="pocket-auto-angle" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
                Auto <span className="text-gray-500 dark:text-neutral-500">(longest passes per area)</span>
              </label>
            </div>
          )}
          <input
            type="range" min={0} max={180} step={5}
            value={form.passAngleDeg}
            disabled={autoPassAngle}
            onChange={(e) => up('passAngleDeg', parseInt(e.target.value))}
            className="w-full accent-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
          />
        </div>
      )}
      <StartRow value={form.startFrom} onChange={(v) => up('startFrom', v)} resolved={startZ} opId={editOp?.id} />
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)}
        maxDepthMM={selectedTool?.maxDepthMM} tool={selectedTool} startZMM={startZ.zMM} />
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
        label={editOp ? 'Regenerate Toolpath' : updating ? 'Update Toolpath' : 'Generate Toolpath'}
      />
    </FormShell>
  )
}
