// ─── Profile form ─────────────────────────────────────────────────────────────
import { FormShell, PathChip, ToolSelector, ToggleRow, DepthRow, GenerateBtn, useSessionOps, StartRow, useStartZ } from './shared'
import { resolveStartZ, type StartFrom } from '../../cam/startHeight'
import { useState } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore, type CuttingDirection } from '../../store/toolStore'
import { useToolpathStore, type CutSide, type AnyOperation, type ProfileOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useSelectedPaths } from '../../store/pathsStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { runInWorkerFor } from '../../workers/workerClient'
import { entryHintAt } from '../../cam/startOptimizer'
import { effectiveStepDownMM } from '../../cam/feeds'

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
  const { addOperation, setSegments, setError, updateOperation, deleteOperation } = useToolpathStore()
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
    stepDownMM: defaultTool?.stepDownMM ?? 3,
    direction: (defaultTool?.direction ?? 'climb') as CuttingDirection,
    rampIn: false,
    // Deliberately not carried over from the saved defaults — see PocketForm.
    startFrom: { mode: 'auto' } as StartFrom,
  }, tools), startFrom: { mode: 'auto' } })
  const [generating, setGenerating] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const session = useSessionOps()

  const selectedPaths = editOp
    ? paths.filter((p) => p.id === editOp.pathId)
    : selPaths
  const selectedTool = tools.find((t) => t.id === form.toolId)
  // Outside cuts reach a full diameter past the path (radius of offset + radius of tool),
  // centerline half that, inside not at all.
  const cutMarginMM = form.side === 'outside' ? (selectedTool?.diameterMM ?? 0)
    : form.side === 'centerline' ? (selectedTool?.diameterMM ?? 0) / 2 : 0
  const startZ = useStartZ(form.startFrom, selectedPaths[0]?.d ?? '', cutMarginMM, editOp?.id)
  const updating = !editOp && selectedPaths.length > 0 && selectedPaths.every((p) => session.liveOpId(p.id))

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
        // Chain to where the previous operation finishes, at generation time.
        const hint = entryHintAt(editOp.id)
        updateOperation(editOp.id, {
          entryHint: hint,
          toolId: form.toolId, side: form.side, depthMM: form.depthMM,
          stepDownMM: form.stepDownMM, direction: form.direction, rampIn: form.rampIn,
          startFrom: form.startFrom, status: 'generating',
        } as Partial<AnyOperation>)
        try {
          setSegments(editOp.id, await runInWorkerFor(editOp.id, 'generateProfile', selectedPaths[0].d, tool, {
            side: form.side, depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(tool, form.stepDownMM, form.depthMM),
            direction: form.direction, rampIn: form.rampIn, startNear: hint, safeHeightMM,
            startZMM: startZFor(selectedPaths[0].d, editOp.id),
          }))
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Generation failed'
          setError(editOp.id, msg)
          setErrorMsg(msg)
          failed = true
        }
      } else {
        for (const path of selectedPaths) {
          // Re-Generate on a path this form already generated for updates that op in place.
          const existingId = session.liveOpId(path.id)
          const name = `Profile: ${path.name} (${tool.name})`
          const opId = existingId ?? addOperation({
            name,
            type: 'profile',
            toolId: form.toolId,
            pathId: path.id,
            side: form.side,
            depthMM: form.depthMM,
            stepDownMM: form.stepDownMM,
            direction: form.direction,
            rampIn: form.rampIn,
            startFrom: form.startFrom,
          })
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
      <StartRow value={form.startFrom} onChange={(v) => up('startFrom', v)} resolved={startZ} opId={editOp?.id} />
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)}
        maxDepthMM={selectedTool?.maxDepthMM} tool={selectedTool} startZMM={startZ.zMM} />
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
    </FormShell>
  )
}
