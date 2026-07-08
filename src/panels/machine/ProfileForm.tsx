// ─── Profile form ─────────────────────────────────────────────────────────────
import { FormShell, PathChip, ToolSelector, ToggleRow, DepthRow, GenerateBtn } from './shared'
import { useState } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore, type CuttingDirection } from '../../store/toolStore'
import { useToolpathStore, type CutSide, type AnyOperation, type ProfileOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { runInWorker } from '../../workers/workerClient'
import { effectiveStepDownMM } from '../../cam/feeds'

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
