// ─── Trochoidal form ──────────────────────────────────────────────────────────
import { FormShell, PathChip, PathListSection, ToolSelector, ToggleRow, DepthRow, GenerateBtn, useSessionOps, toolsOfType, pickToolId, LengthInput } from './shared'
import { useState } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore, type CuttingDirection } from '../../store/toolStore'
import { useToolpathStore, batchOf, type CutSide, type AnyOperation, type TrochoidalOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useSelectedPaths } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { runInWorkerFor, isWorkCancelled } from '../../workers/workerClient'
import { entryHintAt } from '../../cam/startOptimizer'
import { effectiveStepDownMM, trochoidalEngagementFraction, seedStepDownMM } from '../../cam/feeds'

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
  const { paths } = usePathsStore()
  const selPaths = useSelectedPaths()
  const { addOperations, setSegments, setError, updateOperation, deleteOperation, operations } = useToolpathStore()
  const { load, save } = useFormDefaultsStore()
  const { safeHeightMM, thicknessMM, units } = useWorkpieceStore()

  // Trochoidal cuts the whole width with the side of the tool — a drill can't, and a
  // V-bit's width changes with depth, so the trochoid radius wouldn't mean anything.
  const cutters = toolsOfType(tools, ['endmill', 'ballnose'])
  const defaultTool = cutters[0]
  const [form, setForm] = useState<TrochoidalFormState>(() => {
    const base = editOp ? {
      toolId: editOp.toolId, side: editOp.side, depthMM: editOp.depthMM,
      stepDownMM: editOp.stepDownMM, direction: editOp.direction,
      trochStepMM: editOp.trochStepMM, trochRadiusMM: editOp.trochRadiusMM,
      finishingPass: editOp.finishingPass, rampIn: editOp.rampIn ?? false,
    } : mergeWithDefaults(load('trochoidal'), {
      toolId: defaultTool?.id ?? '',
      side: 'outside' as CutSide,
      // Default to the full stock thickness; the tool's max Z is only a warning.
      depthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
      stepDownMM: seedStepDownMM(defaultTool),
      direction: 'climb' as CuttingDirection,
      trochStepMM: (defaultTool?.diameterMM ?? 6) * 0.15,
      trochRadiusMM: (defaultTool?.diameterMM ?? 6) * 0.5,
      finishingPass: true,
      rampIn: false,
    }, tools)
    return { ...base, toolId: pickToolId(base.toolId, cutters) }
  })
  const [generating, setGenerating] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const session = useSessionOps()

  // Editing covers every operation created by the same Generate click — see PocketForm.
  const editBatch = editOp ? (batchOf(editOp, operations) as TrochoidalOperation[]) : []
  const editPairs = editBatch.flatMap((op) => {
    const path = paths.find((p) => p.id === op.pathId)
    return path ? [{ op, path }] : []
  })
  const selectedPaths = editOp ? editPairs.map((e) => e.path) : selPaths
  const selectedTool = tools.find((t) => t.id === form.toolId)
  const updating = !editOp && selectedPaths.length > 0 && selectedPaths.every((p) => session.liveOpId(p.id))

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({
      ...f, toolId,
      stepDownMM: seedStepDownMM(t),
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
    setGenerating(true)
    setErrorMsg(null)
    let failed = false
    try {
      if (editOp) {
        for (const { op, path } of editPairs) {
          // Chain to where the previous operation finishes, at generation time.
          const hint = entryHintAt(op.id)
          updateOperation(op.id, {
            entryHint: hint,
            toolId: form.toolId, side: form.side, depthMM: form.depthMM,
            stepDownMM: form.stepDownMM, direction: form.direction,
            trochStepMM: form.trochStepMM, trochRadiusMM: form.trochRadiusMM,
            finishingPass: form.finishingPass, rampIn: form.rampIn, status: 'generating',
          } as Partial<AnyOperation>)
          try {
            setSegments(op.id, await runInWorkerFor(op.id, 'generateTrochoidal', path.d, tool, {
              side: form.side, depthMM: form.depthMM,
              stepDownMM: effectiveStepDownMM(tool, form.stepDownMM, form.depthMM, trochoidalEngagementFraction(tool, form.trochStepMM)),
              direction: form.direction, trochStepMM: form.trochStepMM,
              trochRadiusMM: form.trochRadiusMM, finishingPass: form.finishingPass,
              rampIn: form.rampIn, startNear: hint, safeHeightMM,
            }))
          } catch (err) {
            // A cancel abandons the whole Generate, not just this path.
            if (isWorkCancelled(err)) break
            const msg = err instanceof Error ? err.message : 'Generation failed'
            setError(op.id, msg)
            setErrorMsg(msg)
            failed = true
          }
        }
      } else {
        // One addOperations call for the whole selection — see PocketForm.
        const newPayloads: Parameters<typeof addOperations>[0] = []
        const slots = selectedPaths.map((path) => {
          const existingId = session.liveOpId(path.id)
          if (existingId) return existingId
          return newPayloads.push({
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
          }) - 1
        })
        const newIds = addOperations(newPayloads)
        for (let pi = 0; pi < selectedPaths.length; pi++) {
          const path = selectedPaths[pi]
          const slot = slots[pi]
          const existingId = typeof slot === 'string' ? slot : undefined
          const opId = existingId ?? newIds[slot as number]
          const name = `Trochoidal: ${path.name} (${tool.name})`
          const hint = entryHintAt(opId)
          updateOperation(opId, existingId ? {
            entryHint: hint,
            name, toolId: form.toolId, side: form.side, depthMM: form.depthMM,
            stepDownMM: form.stepDownMM, direction: form.direction,
            trochStepMM: form.trochStepMM, trochRadiusMM: form.trochRadiusMM,
            finishingPass: form.finishingPass, rampIn: form.rampIn, status: 'generating',
          } as Partial<AnyOperation> : { status: 'generating' })
          try {
            setSegments(opId, await runInWorkerFor(opId, 'generateTrochoidal', path.d, tool, {
              side: form.side, depthMM: form.depthMM,
              stepDownMM: effectiveStepDownMM(tool, form.stepDownMM, form.depthMM, trochoidalEngagementFraction(tool, form.trochStepMM)),
              direction: form.direction, trochStepMM: form.trochStepMM,
              trochRadiusMM: form.trochRadiusMM, finishingPass: form.finishingPass,
              rampIn: form.rampIn, startNear: hint, safeHeightMM,
            }))
            if (!existingId) session.remember(path.id, opId)
          } catch (err) {
            // Cancelled ops keep their slot (cancelGenerating marks them needs-update)
            // rather than being deleted — Generate again picks them straight back up.
            if (isWorkCancelled(err)) break
            const msg = err instanceof Error ? err.message : 'Generation failed'
            if (existingId) setError(opId, msg)
            else deleteOperation(opId)
            setErrorMsg(msg)
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
    <FormShell title={editOp ? `Edit Trochoidal${selectedPaths.length > 1 ? ` — ${selectedPaths.length} paths` : ''}` : 'New Trochoidal'} onClose={onClose}>
      {selectedPaths.length === 0 && (
        <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> {editOp ? 'Path not found' : 'Select a path first'}</p>
      )}
      <ToolSelector tools={cutters} value={form.toolId} onChange={handleToolChange} />
      <ToggleRow label="Cut Side" options={['inside', 'outside', 'centerline'] as CutSide[]} value={form.side} onChange={(v) => up('side', v)} />
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)}
        maxDepthMM={selectedTool?.maxDepthMM} tool={selectedTool}
        engagementFraction={selectedTool ? trochoidalEngagementFraction(selectedTool, form.trochStepMM) : undefined} />
      <ToggleRow label="Direction" options={['climb', 'conventional'] as CuttingDirection[]} value={form.direction} onChange={(v) => up('direction', v)} />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Loop Amplitude</label>
          <LengthInput valueMM={form.trochRadiusMM} minMM={0.1} stepMM={0.1}
            onChangeMM={(v) => up('trochRadiusMM', v)} />
        </div>
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Step / Loop</label>
          <LengthInput valueMM={form.trochStepMM} minMM={0.01} stepMM={0.05}
            onChangeMM={(v) => up('trochStepMM', v)} />
        </div>
      </div>
      <p className="text-label text-gray-400 dark:text-neutral-500 -mt-1">
        Cuts {fmtLen(form.trochRadiusMM * 2, units)} wide · {selectedTool ? Math.round(form.trochStepMM / selectedTool.diameterMM * 100) : '—'}% tool dia per loop
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
        <p className="text-body text-red-600 dark:text-red-400 flex items-start gap-1.5">
          <AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{errorMsg}
        </p>
      )}
      <GenerateBtn
        disabled={selectedPaths.length === 0 || !selectedTool || generating || form.depthMM <= 0}
        generating={generating}
        onClick={handleGenerate}
        label={editOp ? 'Regenerate Toolpath' : updating ? 'Update Toolpath' : 'Generate Toolpath'}
      />
      {/* Below the button — see PathListSection. */}
      <PathListSection count={selectedPaths.length}>
        {selectedPaths.map((p) => <PathChip key={p.id} path={p} />)}
      </PathListSection>
    </FormShell>
  )
}
