// ─── Surface form ─────────────────────────────────────────────────────────────
import { FormShell, ToolSelector, DepthRow, GenerateBtn, useSessionOps } from './shared'
import { useState } from 'react'
import { useToolStore } from '../../store/toolStore'
import { useToolpathStore, type AnyOperation, type SurfaceOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { runInWorkerFor } from '../../workers/workerClient'
import { effectiveStepDownMM } from '../../cam/feeds'

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
  const session = useSessionOps()
  const selectedTool = tools.find((t) => t.id === form.toolId)
  const updating = !editOp && !!session.liveOpId('surface')

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, stepDownMM: t.stepDownMM }))
  }

  function up<K extends keyof SurfaceFormState>(k: K, v: SurfaceFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function handleGenerate() {
    if (!selectedTool) return
    const tool = selectedTool
    setGenerating(true)
    if (editOp) {
      updateOperation(editOp.id, {
        toolId: form.toolId, depthMM: form.depthMM, stepDownMM: form.stepDownMM,
        stepoverPercent: form.stepoverPercent, passAngleDeg: form.passAngleDeg, status: 'generating',
      } as Partial<AnyOperation>)
      try {
        setSegments(editOp.id, await runInWorkerFor(editOp.id, 'generateSurface', tool, {
          widthMM, heightMM,
          depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(tool, form.stepDownMM, form.depthMM),
          stepoverPercent: form.stepoverPercent, passAngleDeg: form.passAngleDeg,
          safeHeightMM,
        }))
      } catch (err) {
        setError(editOp.id, err instanceof Error ? err.message : 'Generation failed')
      }
      setGenerating(false)
      save('surface', form)
      return
    }
    // Re-Generate after this form already made a surface op updates it in place.
    const existingId = session.liveOpId('surface')
    const name = `Surface (${selectedTool.name})`
    const opId = existingId ?? addOperation({
      name,
      type: 'surface',
      toolId: form.toolId,
      depthMM: form.depthMM,
      stepDownMM: form.stepDownMM,
      stepoverPercent: form.stepoverPercent,
      passAngleDeg: form.passAngleDeg,
    })
    if (!existingId) session.remember('surface', opId)
    updateOperation(opId, existingId ? {
      name, toolId: form.toolId, depthMM: form.depthMM, stepDownMM: form.stepDownMM,
      stepoverPercent: form.stepoverPercent, passAngleDeg: form.passAngleDeg, status: 'generating',
    } as Partial<AnyOperation> : { status: 'generating' })
    try {
      setSegments(opId, await runInWorkerFor(opId, 'generateSurface', tool, {
        widthMM, heightMM,
        depthMM: form.depthMM,
        stepDownMM: effectiveStepDownMM(tool, form.stepDownMM, form.depthMM),
        stepoverPercent: form.stepoverPercent,
        passAngleDeg: form.passAngleDeg,
        safeHeightMM,
      }))
    } catch (err) {
      setError(opId, err instanceof Error ? err.message : 'Generation failed')
    }
    setGenerating(false)
    save('surface', form)
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
        label={editOp ? 'Regenerate Toolpath' : updating ? 'Update Toolpath' : 'Generate Toolpath'}
      />
    </FormShell>
  )
}
