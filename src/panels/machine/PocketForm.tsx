// ─── Pocket form ──────────────────────────────────────────────────────────────
import { FormShell, PathChip, PathListSection, ToolSelector, ToggleRow, DepthRow, GenerateBtn, useSessionOps, StartRow, useStartZ } from './shared'
import { resolveStartZ, type StartFrom } from '../../cam/startHeight'
import { useState } from 'react'
import { NumericInput } from '../../components/NumericInput'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore, type CuttingDirection } from '../../store/toolStore'
import { useToolpathStore, batchOf, type AnyOperation, type PocketOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useSelectedPaths } from '../../store/pathsStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { runInWorkerFor, isWorkCancelled } from '../../workers/workerClient'
import type { PocketStrategy } from '../../cam/pocket'
import { effectiveStepDownMM, seedStepDownMM } from '../../cam/feeds'
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
  // Which half of a nested selection to clear. Grouping only — it decides how many
  // operations Generate creates, and is not carried on the operations themselves.
  // Unchecked (the default) clears from the outermost outline inward; checked starts one
  // level in and clears what the other reading calls holes.
  invert: boolean
}

export function PocketForm({ onClose, editOp }: { onClose: () => void; editOp?: PocketOperation }) {
  const { tools } = useToolStore()
  const { paths } = usePathsStore()
  const selPaths = useSelectedPaths()
  const { addOperations, setSegments, setError, updateOperation, replaceGeneratedOperations, operations } = useToolpathStore()
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
    invert: false,
  } : { ...mergeWithDefaults(load('pocket'), {
    toolId: defaultTool?.id ?? '',
    // 'hybrid' — shown as "Auto". Note this is only the default for a FIRST pocket: the
    // form-defaults store replays whatever was last used after that.
    strategy: 'hybrid' as PocketStrategy,
    // Default to the full stock thickness; the tool's max Z is only a warning.
    depthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    stepDownMM: seedStepDownMM(defaultTool),
    stepoverPercent: 40,
    passAngleDeg: 0,
    autoAngle: true,
    direction: 'climb' as CuttingDirection,
    rampIn: false,
    allowanceMM: 0,
    // Never restored from the saved form defaults: a start reference belongs to the
    // operation it was chosen for, and replaying an old one onto a new pocket is exactly
    // the "silently starts 2 mm down over solid stock" case this design exists to avoid.
    startFrom: { mode: 'auto' } as StartFrom,
    // Not restored from the saved defaults either, and for the same reason: it belongs to
    // the selection it was chosen for. Replaying an inverted pocket onto an un-nested
    // selection would silently produce no operations at all.
    invert: false,
  }, tools), startFrom: { mode: 'auto' }, invert: false })
  const [generating, setGenerating] = useState(false)
  const session = useSessionOps()

  // Editing covers every operation created by the same Generate click, not just the one
  // that was clicked: applying one pocket to five selected paths is one decision, so
  // changing its depth afterwards should be one edit rather than five identical ones.
  const editBatch = editOp ? (batchOf(editOp, operations) as PocketOperation[]) : []
  const editGroups = editBatch.flatMap((op) => {
    const boundary = paths.find((p) => p.id === op.pathId)
    return boundary
      ? [{ op, boundary, islands: paths.filter((p) => op.islandIds.includes(p.id)) }]
      : []
  })
  const groups = editOp
    ? editGroups
    : groupPathsByContainment(selPaths, { invert: form.invert })
        .map((g) => ({ ...g, op: undefined }))
  // Only worth asking about when the selection actually nests. Once inverted the checkbox
  // has to stay up regardless — that grouping can legitimately have no islands at all
  // (four nested rectangles give a bare middle one), and hiding the row would strand the
  // user with no way to uncheck it.
  const nested = form.invert || groups.some((g) => g.islands.length > 0)
  const selectedTool = tools.find((t) => t.id === form.toolId)
  // One resolve per form render, shared by the Start row and every group generated below.
  // Multi-group selections all share the first group's footprint here; each group re-resolves
  // for real at generation time.
  // Margin 0: a pocket's cutter stays a full radius INSIDE its boundary, so the cleared
  // area never reaches past the path.
  // The ops this form already made are about to be REPLACED by the next Generate, so
  // they must not count as cuts preceding themselves — otherwise a lone 5 mm pocket
  // reads its own floor and the Start row shows Z −5 instead of stock top.
  const selfOpId = editOp?.id ?? session.firstLiveOpId()
  const startZ = useStartZ(form.startFrom, groups[0]?.boundary.d ?? '', 0, selfOpId)
  // Ops this session made from paths that are STILL selected. Scoped to the selection on
  // purpose: re-reading the same paths a different way (Invert Pocket) should replace what
  // it made, but selecting different paths and generating again is a new operation, not a
  // revision of the last one, so ops for deselected paths are left alone.
  const selectedIds = new Set(selPaths.map((p) => p.id))
  const sessionOps = editOp ? [] : session.liveEntries().filter((e) => selectedIds.has(e.key))
  // Boundaries this session already covers but that the current grouping no longer has —
  // inverting turns every boundary into an island and vice versa. Replaced on
  // the next Generate rather than left behind as a second set of pockets.
  const staleOps = sessionOps.filter((e) => !groups.some((g) => g.boundary.id === e.key))
  // "Update" as soon as this session owns anything in the selection, not only when every
  // current boundary has an op: after a toggle, none of them do yet.
  const updating = !editOp && groups.length > 0 && sessionOps.length > 0
  const adaptiveStrategy = form.strategy === 'adaptive' || form.strategy === 'adaptive2' || form.strategy === 'hybrid'
  const autoPassAngle = form.strategy === 'hybrid' && form.autoAngle

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, stepDownMM: seedStepDownMM(t) }))
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
      if (editOp) {
        for (const { op, boundary, islands } of editGroups) {
          // Chain each op to where the previous one finishes, at generation time — so no
          // regeneration is needed before simulating or exporting.
          const hint = entryHintAt(op.id)
          updateOperation(op.id, {
            entryHint: hint,
            toolId: form.toolId, strategy: form.strategy,
            depthMM: form.depthMM, stepDownMM: form.stepDownMM,
            stepoverPercent: form.stepoverPercent, passAngleDeg: form.passAngleDeg,
            direction: form.direction, rampIn: form.rampIn, allowanceMM: form.allowanceMM,
            startFrom: form.startFrom, status: 'generating',
          } as Partial<AnyOperation>)
          try {
            setSegments(op.id, await runInWorkerFor(op.id, 'generatePocket', boundary.d, tool, {
              strategy: form.strategy,
              depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(tool, form.stepDownMM, form.depthMM),
              stepoverPercent: form.stepoverPercent, direction: form.direction,
              islandDs: islands.map((p) => p.d), angle: form.passAngleDeg, autoAngle: form.autoAngle, rampIn: form.rampIn,
              finishAllowanceMM: form.allowanceMM, startNear: hint,
              startZMM: startZFor(boundary.d, op.id),
              safeHeightMM,
            }))
          } catch (err) {
            // A cancel abandons the whole Generate, not just this group — carrying on
            // would immediately queue the next one against the state the user just left.
            if (isWorkCancelled(err)) break
            setError(op.id, err instanceof Error ? err.message : 'Generation failed')
          }
        }
      } else {
        // Every new op goes in ONE addOperations call: a Generate over several selected
        // paths is a single decision, so it is a single timeline chip carrying a shared
        // batchId — which is what lets the edit above cover all of them at once.
        const newPayloads: Parameters<typeof addOperations>[0] = []
        const slots = groups.map(({ boundary, islands }) => {
          // Re-Generate on a boundary this form already generated updates that op in place.
          const existingId = session.liveOpId(boundary.id)
          if (existingId) return existingId
          return newPayloads.push({
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
            autoAngle: form.autoAngle,
            direction: form.direction,
            rampIn: form.rampIn,
            allowanceMM: form.allowanceMM,
            startFrom: form.startFrom,
          }) - 1
        })
        // Boundaries this session made that the current grouping no longer has — switching
        // Invert Pocket turns every boundary into an island and vice versa, so the whole
        // set is replaced. That is a revision of the Generate that made them, not a
        // deletion and a fresh call, so it amends that one chip instead of adding two more
        // (which is what changing a depth or a strategy already does).
        const newIds = staleOps.length > 0
          ? replaceGeneratedOperations({
              anchorId: staleOps[0].opId,
              deleteIds: staleOps.map((e) => e.opId),
              add: newPayloads,
            })
          : addOperations(newPayloads)
        if (staleOps.length > 0) session.forget(staleOps.map((e) => e.key))
        for (let gi = 0; gi < groups.length; gi++) {
          const { boundary, islands } = groups[gi]
          const slot = slots[gi]
          const existingId = typeof slot === 'string' ? slot : undefined
          const opId = existingId ?? newIds[slot as number]
          const name = `Pocket: ${boundary.name} (${tool.name})`
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
            if (isWorkCancelled(err)) break
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
    <FormShell title={editOp ? `Edit Pocket${groups.length > 1 ? ` — ${groups.length} paths` : ''}` : 'New Pocket Operation'} onClose={onClose}>
      {groups.length === 0 && (
        <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> {editOp ? 'Path not found' : 'Select a closed path first'}</p>
      )}
      <ToolSelector tools={tools.filter((t) => t.type === 'endmill' || t.type === 'ballnose')} value={form.toolId} onChange={handleToolChange} />
      {/* Nested outlines alternate solid/hole, so there are two valid readings of the same
          selection and only the user knows which one is the part. */}
      {!editOp && nested && (
        <div className="flex items-center gap-2">
          <input type="checkbox" id="pocket-invert" checked={form.invert}
            onChange={(e) => up('invert', e.target.checked)} className="accent-blue-500" />
          <label htmlFor="pocket-invert" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
            Invert Pocket
          </label>
        </div>
      )}
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
      <StartRow value={form.startFrom} onChange={(v) => up('startFrom', v)} resolved={startZ} opId={selfOpId} />
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
