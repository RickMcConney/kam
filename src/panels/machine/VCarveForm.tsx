// ─── V-Carve form ────────────────────────────────────────────────────────────
import { FormShell, PathChip, ToolSelector, GenerateBtn, useSessionOps } from './shared'
import { useState } from 'react'
import { NumericInput } from '../../components/NumericInput'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore } from '../../store/toolStore'
import { useToolpathStore, type AnyOperation, type VCarveOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useSelectedPaths } from '../../store/pathsStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { runInWorkerFor } from '../../workers/workerClient'
import { groupPathsByContainment } from './containment'

interface VCarveFormState {
  toolId: string
  maxDepthMM: number
}

export function VCarveForm({ onClose, editOp }: { onClose: () => void; editOp?: VCarveOperation }) {
  const { tools } = useToolStore()
  const { paths } = usePathsStore()
  const selPaths = useSelectedPaths()
  const { addOperation, setSegments, setError, updateOperation } = useToolpathStore()
  const { load, save } = useFormDefaultsStore()
  const { safeHeightMM, thicknessMM } = useWorkpieceStore()

  const vbits = tools.filter((t) => t.type === 'vbit')
  const defaultTool = vbits[0] ?? tools[0]
  const [form, setForm] = useState<VCarveFormState>(() => editOp
    ? { toolId: editOp.toolId, maxDepthMM: editOp.maxDepthMM }
    : mergeWithDefaults(load('vcarve'), {
        toolId: defaultTool?.id ?? '',
        // Default to the full stock thickness; the tool's max Z is only a warning.
        maxDepthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
      }, tools)
  )
  const [generating, setGenerating] = useState(false)
  const session = useSessionOps()

  const editBoundary = editOp ? paths.find((p) => p.id === editOp.pathId) : null
  const editIslands = editOp ? paths.filter((p) => editOp.islandIds.includes(p.id)) : []
  const groups = editOp && editBoundary
    ? [{ boundary: editBoundary, islands: editIslands }]
    : groupPathsByContainment(selPaths)
  const selectedTool = tools.find((t) => t.id === form.toolId)
  // Angle always comes from the selected V-bit — it's a property of the grind, not the op.
  const angleDeg = selectedTool?.vbitAngleDeg ?? 60
  const updating = !editOp && groups.length > 0 && groups.every(({ boundary }) => session.liveOpId(boundary.id))

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId }))
  }

  function up<K extends keyof VCarveFormState>(k: K, v: VCarveFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function handleGenerate() {
    if (groups.length === 0 || !selectedTool) return
    const tool = selectedTool
    setGenerating(true)
    try {
      if (editOp && editBoundary) {
        updateOperation(editOp.id, {
          toolId: form.toolId, angleDeg, maxDepthMM: form.maxDepthMM, status: 'generating',
        } as Partial<AnyOperation>)
        try {
          setSegments(editOp.id, await runInWorkerFor(editOp.id, 'generateVCarve', editBoundary.d, tool, {
            angleDeg, maxDepthMM: form.maxDepthMM,
            islandDs: editIslands.map((p) => p.d), safeHeightMM,
          }))
        } catch (err) {
          setError(editOp.id, err instanceof Error ? err.message : 'Generation failed')
        }
      } else {
        for (const { boundary, islands } of groups) {
          // Re-Generate on a boundary this form already generated for updates that op in place.
          const existingId = session.liveOpId(boundary.id)
          const name = `V-Carve: ${boundary.name} (${tool.name})`
          const opId = existingId ?? addOperation({
            name,
            type: 'vcarve',
            toolId: form.toolId,
            pathId: boundary.id,
            islandIds: islands.map((p) => p.id),
            maxDepthMM: form.maxDepthMM,
            angleDeg,
          })
          if (!existingId) session.remember(boundary.id, opId)
          updateOperation(opId, existingId ? {
            name, toolId: form.toolId, islandIds: islands.map((p) => p.id),
            maxDepthMM: form.maxDepthMM, angleDeg, status: 'generating',
          } as Partial<AnyOperation> : { status: 'generating' })
          try {
            setSegments(opId, await runInWorkerFor(opId, 'generateVCarve', boundary.d, tool, {
              angleDeg, maxDepthMM: form.maxDepthMM,
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
      {selectedTool?.type === 'vbit' && (
        <p className="text-label text-gray-400 dark:text-neutral-500">
          V-bit angle: {angleDeg}° (set on tool)
        </p>
      )}
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
          Bit cuts at most {((form.maxDepthMM) * Math.tan((angleDeg / 2) * Math.PI / 180) * 2).toFixed(2)} mm wide at full depth.
        </p>
      </div>
      <GenerateBtn
        disabled={groups.length === 0 || !selectedTool || generating || form.maxDepthMM <= 0 || selectedTool.type !== 'vbit'}
        generating={generating}
        onClick={handleGenerate}
        label={editOp ? 'Regenerate Toolpath' : updating ? 'Update Toolpath' : 'Generate Toolpath'}
      />
    </FormShell>
  )
}
