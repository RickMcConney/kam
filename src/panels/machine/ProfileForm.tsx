// ─── Profile form ─────────────────────────────────────────────────────────────
import { FormShell, PathChip, PathListSection, ToolSelector, ToggleRow, DepthRow, GenerateBtn, useSessionOps, StartRow, useStartZ } from './shared'
import { resolveStartZ, type StartFrom } from '../../cam/startHeight'
import { useState } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore, type CuttingDirection } from '../../store/toolStore'
import { useToolpathStore, batchOf, type CutSide, type AnyOperation, type ProfileOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useSelectedPaths } from '../../store/pathsStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { runInWorkerFor, isWorkCancelled } from '../../workers/workerClient'
import { entryHintAt } from '../../cam/startOptimizer'
import { effectiveStepDownMM, seedStepDownMM } from '../../cam/feeds'
import { toolRadiusAtHeight } from '../../cam/geom'

interface ProfileFormState {
  toolId: string
  side: CutSide
  depthMM: number
  stepDownMM: number
  direction: CuttingDirection
  rampIn: boolean
  startFrom: StartFrom
}

export function ProfileForm({ onClose, editOp }: { onClose: () => void; editOp?: ProfileOperation }) {
  const { tools } = useToolStore()
  const { paths } = usePathsStore()
  const selPaths = useSelectedPaths()
  const { addOperations, setSegments, setError, updateOperation, deleteOperation, operations } = useToolpathStore()
  const { load, save } = useFormDefaultsStore()
  const { safeHeightMM, thicknessMM, widthMM, heightMM } = useWorkpieceStore()

  const defaultTool = tools[0]
  const [form, setForm] = useState<ProfileFormState>(() => editOp ? {
    toolId: editOp.toolId, side: editOp.side, depthMM: editOp.depthMM,
    stepDownMM: editOp.stepDownMM, direction: editOp.direction, rampIn: editOp.rampIn ?? false,
    // Legacy ops stay on stock top — see PocketForm.
    startFrom: editOp.startFrom ?? { mode: 'stock' },
  } : { ...mergeWithDefaults(load('profile'), {
    toolId: defaultTool?.id ?? '',
    side: 'outside' as CutSide,
    // A profile typically cuts the part free, so default to the full stock
    // thickness rather than the tool's max flute depth.
    depthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    stepDownMM: seedStepDownMM(defaultTool),
    direction: 'climb' as CuttingDirection,
    rampIn: false,
    // Deliberately not carried over from the saved defaults — see PocketForm.
    startFrom: { mode: 'auto' } as StartFrom,
  }, tools), startFrom: { mode: 'auto' } })
  const [generating, setGenerating] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const session = useSessionOps()

  // Editing covers every operation created by the same Generate click — profiling five
  // selected paths at once is one decision, so changing the depth afterwards is one edit.
  const editBatch = editOp ? (batchOf(editOp, operations) as ProfileOperation[]) : []
  const editPairs = editBatch.flatMap((op) => {
    const path = paths.find((p) => p.id === op.pathId)
    return path ? [{ op, path }] : []
  })
  const selectedPaths = editOp ? editPairs.map((e) => e.path) : selPaths
  const selectedTool = tools.find((t) => t.id === form.toolId)
  // Outside cuts reach a full diameter past the path (radius of offset + radius of tool),
  // centerline half that, inside not at all.
  const cutMarginMM = form.side === 'outside' ? (selectedTool?.diameterMM ?? 0)
    : form.side === 'centerline' ? (selectedTool?.diameterMM ?? 0) / 2 : 0
  // See PocketForm: ops this session already generated are not cuts preceding themselves.
  const selfOpId = editOp?.id ?? session.firstLiveOpId()
  const startZ = useStartZ(form.startFrom, selectedPaths[0]?.d ?? '', cutMarginMM, selfOpId)
  // A tapered/round tool that never reaches full diameter at this depth offsets by less
  // than its radius, so the wall it leaves is a taper that meets the path at the surface.
  // Say so — otherwise the toolpath just looks like it's in the wrong place.
  const cutRadiusMM = selectedTool ? toolRadiusAtHeight(selectedTool, form.depthMM) : 0
  const taperHint = selectedTool && form.side !== 'centerline'
    && cutRadiusMM < selectedTool.diameterMM / 2 - 1e-6
    ? `Offset ${cutRadiusMM.toFixed(2)} mm — the ${selectedTool.type === 'vbit' ? 'V' : 'ball'} profile at ${form.depthMM} mm deep, so the cut meets the path at the start surface and the wall below is tapered.`
    : null
  const updating = !editOp && selectedPaths.length > 0 && selectedPaths.every((p) => session.liveOpId(p.id))

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, stepDownMM: seedStepDownMM(t) }))
  }

  function up<K extends keyof ProfileFormState>(k: K, v: ProfileFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function handleGenerate() {
    if (selectedPaths.length === 0 || !selectedTool) return
    const tool = selectedTool
    setGenerating(true)
    setErrorMsg(null)
    // Resolved per path and against live store state — see PocketForm.
    const startZFor = (d: string, opId?: string) => resolveStartZ(
      { startFrom: form.startFrom, footprintD: d, cutMarginMM, opId },
      useToolpathStore.getState().operations, usePathsStore.getState().paths,
      { widthMM, heightMM },
    ).zMM
    let failed = false
    try {
      if (editOp) {
        for (const { op, path } of editPairs) {
          // Chain to where the previous operation finishes, at generation time.
          const hint = entryHintAt(op.id)
          updateOperation(op.id, {
            entryHint: hint,
            toolId: form.toolId, side: form.side, depthMM: form.depthMM,
            stepDownMM: form.stepDownMM, direction: form.direction, rampIn: form.rampIn,
            startFrom: form.startFrom, status: 'generating',
          } as Partial<AnyOperation>)
          try {
            setSegments(op.id, await runInWorkerFor(op.id, 'generateProfile', path.d, tool, {
              side: form.side, depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(tool, form.stepDownMM, form.depthMM),
              direction: form.direction, rampIn: form.rampIn, startNear: hint, safeHeightMM,
              startZMM: startZFor(path.d, op.id),
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
        // One addOperations call for the whole selection: one timeline chip, one shared
        // batchId, and therefore one thing to edit later.
        const newPayloads: Parameters<typeof addOperations>[0] = []
        const slots = selectedPaths.map((path) => {
          // Re-Generate on a path this form already generated updates that op in place.
          const existingId = session.liveOpId(path.id)
          if (existingId) return existingId
          return newPayloads.push({
            name: `Profile: ${path.name} (${tool.name})`,
            type: 'profile',
            toolId: form.toolId,
            pathId: path.id,
            side: form.side,
            depthMM: form.depthMM,
            stepDownMM: form.stepDownMM,
            direction: form.direction,
            rampIn: form.rampIn,
            startFrom: form.startFrom,
          }) - 1
        })
        const newIds = addOperations(newPayloads)
        for (let pi = 0; pi < selectedPaths.length; pi++) {
          const path = selectedPaths[pi]
          const slot = slots[pi]
          const existingId = typeof slot === 'string' ? slot : undefined
          const opId = existingId ?? newIds[slot as number]
          const name = `Profile: ${path.name} (${tool.name})`
          const hint = entryHintAt(opId)
          updateOperation(opId, existingId ? {
            entryHint: hint,
            name, toolId: form.toolId, side: form.side, depthMM: form.depthMM,
            stepDownMM: form.stepDownMM, direction: form.direction, rampIn: form.rampIn,
            startFrom: form.startFrom, status: 'generating',
          } as Partial<AnyOperation> : { status: 'generating' })
          try {
            setSegments(opId, await runInWorkerFor(opId, 'generateProfile', path.d, tool, {
              side: form.side, depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(tool, form.stepDownMM, form.depthMM),
              direction: form.direction, rampIn: form.rampIn, startNear: hint, safeHeightMM,
              startZMM: startZFor(path.d, opId),
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
      if (!failed) { save('profile', form) }
    }
  }

  return (
    <FormShell title={editOp ? `Edit Profile${selectedPaths.length > 1 ? ` — ${selectedPaths.length} paths` : ''}` : 'New Profile Operation'} onClose={onClose}>
      {selectedPaths.length === 0 && (
        <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> {editOp ? 'Path not found' : 'Select a path on the canvas first'}</p>
      )}
      <ToolSelector tools={tools} value={form.toolId} onChange={handleToolChange} />
      <ToggleRow label="Cut Side" options={['inside', 'outside', 'centerline'] as CutSide[]} value={form.side} onChange={(v) => up('side', v)} />
      <StartRow value={form.startFrom} onChange={(v) => up('startFrom', v)} resolved={startZ} opId={selfOpId} />
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)}
        maxDepthMM={selectedTool?.maxDepthMM} tool={selectedTool} startZMM={startZ.zMM} />
      {taperHint && (
        <p className="text-label text-gray-500 dark:text-neutral-400 normal-case">{taperHint}</p>
      )}
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
        label={editOp ? 'Regenerate Toolpath' : updating ? 'Update Toolpath' : 'Generate Toolpath'}
      />
      {/* Below the button — see PathListSection. */}
      <PathListSection count={selectedPaths.length}>
        {selectedPaths.map((p) => <PathChip key={p.id} path={p} />)}
      </PathListSection>
    </FormShell>
  )
}
