// ─── V-Carve form ────────────────────────────────────────────────────────────
import { FormShell, PathChip, PathListSection, ToolSelector, GenerateBtn, useSessionOps, StartRow, useStartZ, toolsOfType, pickToolId, LengthInput, FormError, useGenerateError, discardFailedOps } from './shared'
import { resolveStartZ, type StartFrom } from '../../cam/startHeight'
import { useState } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore } from '../../store/toolStore'
import { useToolpathStore, batchOf, type AnyOperation, type VCarveOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useSelectedPaths } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { runInWorkerFor, isWorkCancelled } from '../../workers/workerClient'
import { entryHintAt } from '../../cam/startOptimizer'
import { groupPathsByContainment } from './containment'

interface VCarveFormState {
  toolId: string
  maxDepthMM: number
  startFrom: StartFrom
}

export function VCarveForm({ onClose, editOp }: { onClose: () => void; editOp?: VCarveOperation }) {
  const { tools } = useToolStore()
  const { paths } = usePathsStore()
  const selPaths = useSelectedPaths()
  const { addOperations, setSegments, updateOperation, operations } = useToolpathStore()
  const { load, save } = useFormDefaultsStore()
  const { safeHeightMM, thicknessMM, widthMM, heightMM, units } = useWorkpieceStore()

  // Nothing but a V-bit carves a V: the cone angle IS the op, and Generate below is already
  // gated on it. The list used to fall back to every tool when the library had no V-bit,
  // which offered drills for a cut they can't make.
  const vbits = toolsOfType(tools, ['vbit'])
  const defaultTool = vbits[0]
  const [form, setForm] = useState<VCarveFormState>(() => {
    const base = editOp
      ? { toolId: editOp.toolId, maxDepthMM: editOp.maxDepthMM, startFrom: editOp.startFrom ?? { mode: 'stock' as const } }
      : { ...mergeWithDefaults(load('vcarve'), {
          toolId: defaultTool?.id ?? '',
          // Default to the full stock thickness; the tool's max Z is only a warning.
          maxDepthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
          // Deliberately not carried over from the saved defaults — see PocketForm.
          startFrom: { mode: 'auto' } as StartFrom,
        }, tools), startFrom: { mode: 'auto' as const } }
    return { ...base, toolId: pickToolId(base.toolId, vbits) }
  })
  const [generating, setGenerating] = useState(false)
  const [errorMsg, reportError, clearError] = useGenerateError()
  const session = useSessionOps()

  // Editing covers every operation created by the same Generate click — see PocketForm.
  const editBatch = editOp ? (batchOf(editOp, operations) as VCarveOperation[]) : []
  const editGroups = editBatch.flatMap((op) => {
    const boundary = paths.find((p) => p.id === op.pathId)
    return boundary
      ? [{ op, boundary, islands: paths.filter((p) => op.islandIds.includes(p.id)) }]
      : []
  })
  const groups = editOp
    ? editGroups
    : groupPathsByContainment(selPaths).map((g) => ({ ...g, op: undefined }))
  const selectedTool = tools.find((t) => t.id === form.toolId)
  // Angle always comes from the selected V-bit — it's a property of the grind, not the op.
  const angleDeg = selectedTool?.vbitAngleDeg ?? 60
  // Margin 0: a v-carve is bounded by the outline it carves — the widest part of the cone
  // lands ON the outline, never outside it.
  // See PocketForm: ops this session already generated are not cuts preceding themselves.
  const selfOpId = editOp?.id ?? session.firstLiveOpId()
  const startZ = useStartZ(form.startFrom, groups[0]?.boundary.d ?? '', 0, selfOpId)
  const updating = !editOp && groups.length > 0 && groups.every(({ boundary }) => session.liveOpId(boundary.id))

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId }))
  }

  function up<K extends keyof VCarveFormState>(k: K, v: VCarveFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function handleGenerate() {
    clearError()
    // Ids this click CREATES. A Generate that fails leaves nothing behind, so these are
    // thrown away again at the end; an operation that already existed is never touched.
    const createdIds: string[] = []
    if (groups.length === 0 || !selectedTool) return
    const tool = selectedTool
    setGenerating(true)
    // generateVCarve measures depth from stock top (`zStartMM` shifts the datum down and
    // `maxDepthMM` caps the TOTAL) — that convention is load-bearing for the male-inlay
    // path, so the conversion from "depth below the start surface" happens here.
    const startZFor = (d: string, opId?: string) => -resolveStartZ(
      { startFrom: form.startFrom, footprintD: d, cutMarginMM: 0, opId },
      useToolpathStore.getState().operations, usePathsStore.getState().paths,
      { widthMM, heightMM },
    ).zMM
    try {
      if (editOp) {
        for (const { op, boundary, islands } of editGroups) {
          // Chain to where the previous operation finishes, at generation time.
          const hint = entryHintAt(op.id)
          updateOperation(op.id, {
            entryHint: hint,
            toolId: form.toolId, angleDeg, maxDepthMM: form.maxDepthMM,
            startFrom: form.startFrom, status: 'generating',
          } as Partial<AnyOperation>)
          try {
            const zStartMM = startZFor(boundary.d, op.id)
            setSegments(op.id, await runInWorkerFor(op.id, 'generateVCarve', boundary.d, tool, {
              angleDeg, maxDepthMM: form.maxDepthMM + zStartMM, zStartMM,
              islandDs: islands.map((p) => p.d), startNear: hint, safeHeightMM,
            }))
          } catch (err) {
            if (isWorkCancelled(err)) break
            reportError(op.id, err)
          }
        }
      } else {
        // One addOperations call for the whole selection — see PocketForm.
        const newPayloads: Parameters<typeof addOperations>[0] = []
        const slots = groups.map(({ boundary, islands }) => {
          const existingId = session.liveOpId(boundary.id)
          if (existingId) return existingId
          return newPayloads.push({
            name: `V-Carve: ${boundary.name} (${tool.name})`,
            type: 'vcarve',
            toolId: form.toolId,
            pathId: boundary.id,
            islandIds: islands.map((p) => p.id),
            maxDepthMM: form.maxDepthMM,
            angleDeg,
            startFrom: form.startFrom,
          }) - 1
        })
        const newIds = addOperations(newPayloads)
        for (let gi = 0; gi < groups.length; gi++) {
          const { boundary, islands } = groups[gi]
          const slot = slots[gi]
          const existingId = typeof slot === 'string' ? slot : undefined
          const opId = existingId ?? newIds[slot as number]
          const name = `V-Carve: ${boundary.name} (${tool.name})`
          if (!existingId) { session.remember(boundary.id, opId); createdIds.push(opId) }
          const hint = entryHintAt(opId)
          updateOperation(opId, existingId ? {
            entryHint: hint,
            name, toolId: form.toolId, islandIds: islands.map((p) => p.id),
            maxDepthMM: form.maxDepthMM, angleDeg,
            startFrom: form.startFrom, status: 'generating',
          } as Partial<AnyOperation> : { status: 'generating' })
          try {
            const zStartMM = startZFor(boundary.d, opId)
            setSegments(opId, await runInWorkerFor(opId, 'generateVCarve', boundary.d, tool, {
              angleDeg, maxDepthMM: form.maxDepthMM + zStartMM, zStartMM,
              islandDs: islands.map((p) => p.d), startNear: hint, safeHeightMM,
            }))
          } catch (err) {
            if (isWorkCancelled(err)) break
            reportError(opId, err)
          }
        }
      }
    } finally {
      discardFailedOps(createdIds)
      setGenerating(false)
      save('vcarve', form)
    }
  }

  return (
    <FormShell title={editOp ? `Edit V-Carve${groups.length > 1 ? ` — ${groups.length} paths` : ''}` : 'New V-Carve'} onClose={onClose}>
      {groups.length === 0 && (
        <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> {editOp ? 'Path not found' : 'Select a closed path first'}</p>
      )}
      <ToolSelector tools={vbits} value={form.toolId} onChange={handleToolChange} />
      {selectedTool?.type !== 'vbit' && (
        <p className="text-label text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <AlertCircle size={ICON.xs} /> V-Carve requires a V-bit tool.
        </p>
      )}
      {selectedTool?.type === 'vbit' && (
        <p className="text-label text-gray-400 dark:text-neutral-500">
          V-bit angle: {angleDeg}° (set on tool)
        </p>
      )}
      <StartRow value={form.startFrom} onChange={(v) => up('startFrom', v)} resolved={startZ} opId={selfOpId} />
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Max Depth</label>
        <LengthInput valueMM={form.maxDepthMM} minMM={0.1} stepMM={0.5}
          onChangeMM={(v) => up('maxDepthMM', v)} />
        {/* Reach from stock top: starting on a pocket floor adds that much to the total. */}
        {selectedTool && form.maxDepthMM - startZ.zMM > selectedTool.maxDepthMM && (
          <p className="text-label text-amber-600 dark:text-amber-500 flex items-center gap-1 mt-0.5">
            <AlertCircle size={10} className="shrink-0" />
            Exceeds tool Max Z ({fmtLen(selectedTool.maxDepthMM, units)})
          </p>
        )}
        <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">
          Cuts at most {fmtLen((form.maxDepthMM) * Math.tan((angleDeg / 2) * Math.PI / 180) * 2, units)} wide at full depth.
        </p>
      </div>
      <FormError msg={errorMsg} />
      <GenerateBtn
        disabled={groups.length === 0 || !selectedTool || generating || form.maxDepthMM <= 0 || selectedTool.type !== 'vbit'}
        generating={generating}
        onClick={handleGenerate}
        label={editOp ? 'Regenerate Toolpath' : updating ? 'Update Toolpath' : 'Generate Toolpath'}
      />
      {/* Below the button — see PathListSection. Islands keep their label because that
          is a real distinction; nothing else needs one. */}
      <PathListSection count={groups.reduce((n, g) => n + 1 + g.islands.length, 0)}>
        {groups.map(({ boundary, islands }) => (
          <div key={boundary.id} className="space-y-0.5">
            <PathChip path={boundary} />
            {islands.map((p) => <PathChip key={p.id} path={p} label="island" />)}
          </div>
        ))}
      </PathListSection>
    </FormShell>
  )
}
