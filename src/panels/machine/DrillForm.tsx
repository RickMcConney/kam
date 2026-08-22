// ─── Drill form ───────────────────────────────────────────────────────────────
import { FormShell, ToolSelector, DepthRow, GenerateBtn, useSessionOps, StartRow, useStartZ, toolsOfType, pickToolId, FormError, useGenerateError, discardFailedOps } from './shared'
import { useState, useEffect, useRef } from 'react'
import { ICON } from '../../theme'
import { AlertCircle, X } from 'lucide-react'
import { useToolStore } from '../../store/toolStore'
import { useToolpathStore, batchOf, type AnyOperation, type DrillOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { entryHintAt } from '../../cam/startOptimizer'
import { useUIStore } from '../../store/uiStore'
import { generatePeckDrill, generateHelicalDrills } from '../../cam/drill'
import { effectiveStepDownMM, seedStepDownMM } from '../../cam/feeds'
import { extractCircles } from '../../canvas/selectionUtils'
import { resolveStartZForOp, type StartFrom } from '../../cam/startHeight'

interface DrillFormState {
  toolId: string
  drillMode: 'peck' | 'helical'
  depthMM: number
  stepDownMM: number
  startFrom: StartFrom
}

export function DrillForm({ onClose, editOp }: { onClose: () => void; editOp?: DrillOperation }) {
  const { tools } = useToolStore()
  const { paths, selectedIds } = usePathsStore()
  const { addOperation, addOperations, setSegments, updateOperation, operations } = useToolpathStore()
  const { activeTool, setActiveTool, pendingDrillPoints, clearDrillPoints } = useUIStore()
  const { load, save } = useFormDefaultsStore()
  const { safeHeightMM, thicknessMM, units, widthMM, heightMM } = useWorkpieceStore()

  const defaultTool = tools[0]
  const [form, setForm] = useState<DrillFormState>(() => editOp ? {
    toolId: editOp.toolId, drillMode: editOp.drillMode,
    depthMM: editOp.depthMM, stepDownMM: editOp.stepDownMM,
    startFrom: editOp.startFrom ?? { mode: 'auto' as const },
  } : mergeWithDefaults(load('drill'), {
    toolId: defaultTool?.id ?? '',
    drillMode: 'peck' as const,
    startFrom: { mode: 'auto' as const } as StartFrom,
    // Default to the full stock thickness; the tool's max Z is only a warning.
    depthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    stepDownMM: seedStepDownMM(defaultTool),
  }, tools))
  const [generating, setGenerating] = useState(false)
  const [errorMsg, reportError, clearError] = useGenerateError()
  const session = useSessionOps()

  // Auto-enter/exit drill-placing mode based on selected mode
  useEffect(() => {
    if (editOp) return
    if (form.drillMode === 'peck') {
      setActiveTool('drill')
    } else {
      setActiveTool('select')
      clearDrillPoints()
    }
  }, [form.drillMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Peck plunges straight down the axis, so any tool that can plunge is fair game — a drill
  // bit above all. Helical bores the hole with the SIDE of the tool while it ramps, which
  // is an end mill's job: a drill bit has no side edge (the form already refused to
  // generate one), and a V-bit or ball nose would cut a cone or a rounded bottom rather
  // than a straight-walled hole.
  const helicalTools = toolsOfType(tools, ['endmill'])
  const drillTools = form.drillMode === 'helical' ? helicalTools : tools

  // The two modes keep SEPARATE tool selections. Switching to helical with a drill bit
  // selected would otherwise leave the dropdown pointing at a tool it no longer lists, so
  // it re-points to an end mill — but the drill bit is the right answer for peck, and
  // having to re-pick it on the way back is the same annoyance in reverse. So the peck
  // choice is parked on the way out and restored on the way back. Step-down rides on the
  // tool, so it is re-seeded with it. Runs on mount too, which covers an op loaded with a
  // tool its mode doesn't accept.
  const peckToolIdRef = useRef(form.toolId)
  useEffect(() => {
    const id = form.drillMode === 'helical'
      ? pickToolId(form.toolId, helicalTools)
      : (pickToolId(peckToolIdRef.current, tools) || form.toolId)
    if (form.drillMode === 'helical') peckToolIdRef.current = form.toolId
    if (id === form.toolId) return
    const t = tools.find((x) => x.id === id)
    setForm((f) => ({ ...f, toolId: id, ...(t ? { stepDownMM: seedStepDownMM(t) } : {}) }))
  }, [form.drillMode]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedTool = tools.find((t) => t.id === form.toolId)

  // Every circle in every selected path, kept grouped BY path: one operation per
  // path, boring all of that path's holes. A path is not one hole — a pinion's pin
  // ring is eight circles under one id — and the op stays tied to its path so a hole
  // that moves takes its drilling with it.
  const selectedHoles = editOp ? [] : paths
    .filter((p) => selectedIds.includes(p.id))
    .flatMap((p) => {
      const holes = extractCircles(p)
      return holes.length > 0 ? [{ path: p, holes }] : []
    })
  const holeCount = selectedHoles.reduce((n, g) => n + g.holes.length, 0)

  // Editing covers every operation created by the same Generate click — drilling the
  // holes of five selected paths at once is one decision, so changing the depth or the
  // tool afterwards is one edit. See ProfileForm; `batchOf` is the shared rule.
  const editBatch = editOp ? (batchOf(editOp, operations) as DrillOperation[]) : []

  // The holes one op stored. `helicalHoles` is the list; the singular fields are what
  // an op saved before that list carries.
  function holesOf(op: DrillOperation): { cx: number; cy: number; radiusMM: number }[] | null {
    if (op.drillMode !== 'helical') return null
    if (op.helicalHoles?.length) return op.helicalHoles
    if (op.helicalCenterX === undefined) return null
    return [{
      cx: op.helicalCenterX, cy: op.helicalCenterY ?? 0,
      radiusMM: (op.helicalRadius ?? 0) + (tools.find((t) => t.id === op.toolId)?.diameterMM ?? 0) / 2,
    }]
  }
  const editHoles = editOp ? holesOf(editOp) : null
  const editHoleCount = editBatch.reduce((n, op) => n + (holesOf(op)?.length ?? op.points.length), 0)

  // See PocketForm: ops this session already generated are not cuts preceding themselves.
  const selfOpId = editOp?.id ?? session.firstLiveOpId()
  const startZ = useStartZ(form.startFrom, selectedHoles[0]?.path.d ?? '', 0, selfOpId)

  // The real answer, per operation, at generation time. Resolved THROUGH the op rather
  // than from a d string, because a drill op's footprint is either its source path's
  // circles or — for hand-placed peck points — a disc per point, and startInputForOp is
  // the one place that knows which.
  const startZOf = (opId: string) => {
    const ops = useToolpathStore.getState().operations
    const op = ops.find((o) => o.id === opId)
    if (!op) return 0
    return resolveStartZForOp(op, ops, usePathsStore.getState().paths, { widthMM, heightMM }, tools).zMM
  }

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, stepDownMM: seedStepDownMM(t) }))
  }

  function up<K extends keyof DrillFormState>(k: K, v: DrillFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleClose() {
    if (activeTool === 'drill') { setActiveTool('select'); clearDrillPoints() }
    onClose()
  }

  // Points are cleared after generating, so with no new points pending a re-Generate
  // updates the peck op this form created, reusing its stored points. Placing new
  // points switches back to creating a fresh operation.
  const sessionPeckOp = !editOp && form.drillMode === 'peck' && pendingDrillPoints.length === 0
    ? (operations.find((o) => o.id === session.liveOpId('peck')) as DrillOperation | undefined)
    : undefined

  function handleGenerate() {
    clearError()
    // Ids this click CREATES. A Generate that fails leaves nothing behind, so these are
    // thrown away again at the end; an operation that already existed is never touched.
    const createdIds: string[] = []
    if (!selectedTool) return
    setGenerating(true)

    if (editOp) {
      // Every op of the batch takes the edit — one form, one depth, one tool, however
      // many paths the Generate click covered. Each keeps its OWN holes or points: they
      // are what that op was built from, and the form never edits them.
      for (const op of editBatch) {
        // Chain to where the previous operation finishes, at generation time. Peck
        // ordering uses it; the helical mode ignores it, but recording it still keeps the
        // operation from being regenerated for a hint before the next simulate.
        const hint = entryHintAt(op.id)
        updateOperation(op.id, {
          entryHint: hint,
          toolId: form.toolId, depthMM: form.depthMM, stepDownMM: form.stepDownMM,
          startFrom: form.startFrom, status: 'generating',
        } as Partial<AnyOperation>)
      }
      setTimeout(() => {
        for (const op of editBatch) {
          const hint = entryHintAt(op.id)
          const holes = holesOf(op)
          try {
            const segs = op.drillMode === 'helical' && holes
              ? generateHelicalDrills(holes, selectedTool, {
                  depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(selectedTool, form.stepDownMM, form.depthMM),
                  startNear: hint, safeHeightMM, startZMM: startZOf(op.id),
                })
              : generatePeckDrill(op.points, selectedTool, {
                  depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(selectedTool, form.stepDownMM, form.depthMM),
                  startNear: hint, safeHeightMM, startZMM: startZOf(op.id),
                })
            setSegments(op.id, segs)
          } catch (err) {
            reportError(op.id, err)
          }
        }
        setGenerating(false)
        save('drill', form)
      }, 0)
      return
    }

    if (form.drillMode === 'peck' && pendingDrillPoints.length === 0 && !sessionPeckOp
      && selectedHoles.length === 0) { setGenerating(false); return }
    if (form.drillMode === 'helical' && selectedHoles.length === 0) { setGenerating(false); return }

    setTimeout(() => {
      if (form.drillMode === 'helical') {
        // One addOperations call for the whole selection: one shared batchId, so one
        // chip in the strip and one thing to edit later. See ProfileForm.
        const newPayloads: Parameters<typeof addOperations>[0] = []
        const slots = selectedHoles.map(({ path, holes }) => {
          // Re-Generate on a path this form already generated updates that op in place.
          const existingId = session.liveOpId(path.id)
          if (existingId) return existingId
          const suffix = holes.length > 1 ? ` ×${holes.length}` : ''
          return newPayloads.push({
            name: `Helical Drill: ${path.name} (${selectedTool.name})${suffix}`,
            type: 'drill',
            toolId: form.toolId,
            drillMode: 'helical',
            points: [],
            pathId: path.id,
            helicalHoles: holes,
            helicalCenterX: holes[0].cx,
            helicalCenterY: holes[0].cy,
            helicalRadius: Math.max(0, holes[0].radiusMM - selectedTool.diameterMM / 2),
            depthMM: form.depthMM,
            stepDownMM: form.stepDownMM,
            startFrom: form.startFrom,
          }) - 1
        })
        const newIds = addOperations(newPayloads)
        for (let hi = 0; hi < selectedHoles.length; hi++) {
          const { path, holes } = selectedHoles[hi]
          const suffix = holes.length > 1 ? ` ×${holes.length}` : ''
          const slot = slots[hi]
          const existingId = typeof slot === 'string' ? slot : undefined
          const opId = existingId ?? newIds[slot as number]
          const name = `Helical Drill: ${path.name} (${selectedTool.name})${suffix}`
          if (!existingId) { session.remember(path.id, opId); createdIds.push(opId) }
          const hint = entryHintAt(opId)
          updateOperation(opId, existingId ? {
            entryHint: hint,
            name, toolId: form.toolId,
            helicalHoles: holes,
            helicalCenterX: holes[0].cx, helicalCenterY: holes[0].cy,
            helicalRadius: Math.max(0, holes[0].radiusMM - selectedTool.diameterMM / 2),
            depthMM: form.depthMM, stepDownMM: form.stepDownMM,
            startFrom: form.startFrom, status: 'generating',
          } as Partial<AnyOperation> : { entryHint: hint, status: 'generating' })
          try {
            setSegments(opId, generateHelicalDrills(holes, selectedTool, {
              depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(selectedTool, form.stepDownMM, form.depthMM),
              startNear: hint, safeHeightMM, startZMM: startZOf(opId),
            }))
          } catch (err) {
            reportError(opId, err)
          }
        }
      } else if (pendingDrillPoints.length === 0 && !sessionPeckOp && selectedHoles.length > 0) {
        // Peck at the centre of every circle in the selection — the same reading of a
        // path as helical: one operation per path, tied to it by `pathId`, so holes
        // that move take their drilling with them.
        // One addOperations call for the whole selection — see the helical branch above.
        const newPayloads: Parameters<typeof addOperations>[0] = []
        const slots = selectedHoles.map(({ path, holes }) => {
          const existingId = session.liveOpId(path.id)
          if (existingId) return existingId
          return newPayloads.push({
            name: `Peck Drill: ${path.name} (${selectedTool.name}) ×${holes.length}`,
            type: 'drill',
            toolId: form.toolId,
            drillMode: 'peck',
            points: holes.map((h) => ({ x: h.cx, y: h.cy })),
            pathId: path.id,
            depthMM: form.depthMM,
            stepDownMM: form.stepDownMM,
            startFrom: form.startFrom,
          }) - 1
        })
        const newIds = addOperations(newPayloads)
        for (let hi = 0; hi < selectedHoles.length; hi++) {
          const { path, holes } = selectedHoles[hi]
          const points = holes.map((h) => ({ x: h.cx, y: h.cy }))
          const slot = slots[hi]
          const existingId = typeof slot === 'string' ? slot : undefined
          const opId = existingId ?? newIds[slot as number]
          const name = `Peck Drill: ${path.name} (${selectedTool.name}) ×${points.length}`
          if (!existingId) { session.remember(path.id, opId); createdIds.push(opId) }
          const hint = entryHintAt(opId)
          updateOperation(opId, existingId ? {
            entryHint: hint, name, toolId: form.toolId, points,
            depthMM: form.depthMM, stepDownMM: form.stepDownMM,
            startFrom: form.startFrom, status: 'generating',
          } as Partial<AnyOperation> : { entryHint: hint, status: 'generating' })
          try {
            setSegments(opId, generatePeckDrill(points, selectedTool, {
              depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(selectedTool, form.stepDownMM, form.depthMM),
              startNear: hint, safeHeightMM, startZMM: startZOf(opId),
            }))
          } catch (err) {
            reportError(opId, err)
          }
        }
      } else if (sessionPeckOp) {
        const hint = entryHintAt(sessionPeckOp.id)
        updateOperation(sessionPeckOp.id, {
          entryHint: hint,
          name: `Peck Drill (${selectedTool.name}) ×${sessionPeckOp.points.length}`,
          toolId: form.toolId, depthMM: form.depthMM, stepDownMM: form.stepDownMM,
          startFrom: form.startFrom, status: 'generating',
        } as Partial<AnyOperation>)
        try {
          setSegments(sessionPeckOp.id, generatePeckDrill(sessionPeckOp.points, selectedTool, {
            depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(selectedTool, form.stepDownMM, form.depthMM),
            startNear: hint, safeHeightMM, startZMM: startZOf(sessionPeckOp.id),
          }))
        } catch (err) {
          reportError(sessionPeckOp.id, err)
        }
      } else {
        const opId = addOperation({
          name: `Peck Drill (${selectedTool.name}) ×${pendingDrillPoints.length}`,
          type: 'drill',
          toolId: form.toolId,
          drillMode: 'peck',
          points: [...pendingDrillPoints],
          depthMM: form.depthMM,
          stepDownMM: form.stepDownMM,
          startFrom: form.startFrom,
        })
        session.remember('peck', opId)
        createdIds.push(opId)
        const hint = entryHintAt(opId)
        updateOperation(opId, { entryHint: hint, status: 'generating' })
        try {
          setSegments(opId, generatePeckDrill(pendingDrillPoints, selectedTool, {
            depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(selectedTool, form.stepDownMM, form.depthMM),
            startNear: hint, safeHeightMM, startZMM: startZOf(opId),
          }))
        } catch (err) {
          reportError(opId, err)
        }
      }
      discardFailedOps(createdIds)
      setGenerating(false)
      save('drill', form)
      clearDrillPoints()
    }, 0)
  }

  // Peck accepts anything that can plunge, but only a drill bit leaves a proper hole — so
  // the warning names what the SELECTED tool will actually do rather than calling every
  // non-drill an end mill.
  const peckToolWarning = !selectedTool || selectedTool.type === 'drill' ? null
    : selectedTool.type === 'endmill' ? 'Peck drilling with an end mill — it must be centre-cutting to plunge.'
    : selectedTool.type === 'ballnose' ? 'Peck drilling with a ball nose — leaves a round-bottomed hole.'
    : 'Peck drilling with a V-bit — cuts a cone, not a straight-walled hole.'
  const isDrillTool = selectedTool?.type === 'drill'
  const peckReady = editOp ? editBatch.some((op) => op.points.length > 0)
    : pendingDrillPoints.length > 0 || !!sessionPeckOp || selectedHoles.length > 0
  const helicalReady = editOp ? editBatch.some((op) => !!holesOf(op)) : selectedHoles.length > 0
  const canGenerate = !!selectedTool && !generating && form.depthMM > 0 &&
    ((form.drillMode === 'peck' && peckReady) || (form.drillMode === 'helical' && helicalReady && !isDrillTool))
  const peckFromCircles = form.drillMode === 'peck' && !editOp
    && pendingDrillPoints.length === 0 && !sessionPeckOp && selectedHoles.length > 0
  const updating = !editOp && (form.drillMode === 'peck'
    ? !!sessionPeckOp || (peckFromCircles && selectedHoles.every(({ path }) => session.liveOpId(path.id)))
    : selectedHoles.length > 0 && selectedHoles.every(({ path }) => session.liveOpId(path.id)))

  return (
    <FormShell title={editOp ? `Edit Drill${editBatch.length > 1 ? ` — ${editBatch.length} paths` : ''}` : 'New Drill'} onClose={handleClose}>
      {/* Mode toggle — read-only when editing */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Mode</label>
        <div className="flex gap-1">
          {(['peck', 'helical'] as const).map((m) => (
            <button key={m} onClick={() => { if (!editOp && m !== form.drillMode) up('drillMode', m) }}
              className={[
                'flex-1 py-1 text-body rounded border transition-colors capitalize',
                form.drillMode === m
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-gray-50 dark:bg-neutral-900 border-gray-400 dark:border-neutral-700 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200',
                editOp ? 'opacity-60 cursor-default' : '',
              ].join(' ')}>
              {m === 'peck' ? 'Peck at Points' : 'Helical (Circle)'}
            </button>
          ))}
        </div>
      </div>

      {/* Peck: auto-placing — just show count + clear */}
      {form.drillMode === 'peck' && (
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Drill Points</label>
          {editOp ? (
            <p className="text-body text-gray-700 dark:text-neutral-300 bg-gray-100 dark:bg-neutral-800 rounded px-2 py-1">
              {editHoleCount} stored point{editHoleCount !== 1 ? 's' : ''}
              {editBatch.length > 1 ? ` on ${editBatch.length} paths` : ''}
            </p>
          ) : pendingDrillPoints.length > 0 ? (
            <div className="flex items-center gap-2">
              <span className="text-body text-gray-700 dark:text-neutral-300">
                {pendingDrillPoints.length} point{pendingDrillPoints.length !== 1 ? 's' : ''}
              </span>
              <button onClick={clearDrillPoints} className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-neutral-700 text-gray-400 dark:text-neutral-500 hover:text-gray-700 dark:hover:text-neutral-300">
                <X size={ICON.xs} />
              </button>
            </div>
          ) : sessionPeckOp ? (
            <p className="text-label text-gray-400 dark:text-neutral-500">
              {sessionPeckOp.points.length} point{sessionPeckOp.points.length !== 1 ? 's' : ''} in the generated operation — Update regenerates them, or click the canvas to start a new set.
            </p>
          ) : peckFromCircles ? (
            <p className="text-label text-gray-400 dark:text-neutral-500">
              {holeCount} hole centre{holeCount !== 1 ? 's' : ''} from {selectedHoles.length === 1 ? selectedHoles[0].path.name : `${selectedHoles.length} selected paths`} — or click the canvas to place points instead.
            </p>
          ) : (
            <p className="text-label text-gray-400 dark:text-neutral-500">Click on the canvas to place drill points — a click near a circle uses its centre.</p>
          )}
          {peckToolWarning && (
            <p className="text-label text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1">
              <AlertCircle size={ICON.xs} /> {peckToolWarning}
            </p>
          )}
        </div>
      )}

      {/* Helical: list all selected circles */}
      {form.drillMode === 'helical' && (
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
            Source Circles {!editOp && holeCount > 0 && <span className="normal-case text-gray-500 dark:text-neutral-400">
              ({holeCount} hole{holeCount !== 1 ? 's' : ''}{selectedHoles.length > 1 ? ` on ${selectedHoles.length} paths — one operation each` : ''})
            </span>}
          </label>
          {editOp && editHoles ? (
            <div className="text-body text-gray-800 dark:text-neutral-200 bg-gray-100 dark:bg-neutral-800 rounded px-2 py-1 space-y-0.5">
              <div>
                {editHoleCount} hole{editHoleCount !== 1 ? 's' : ''}
                {editBatch.length > 1 ? ` on ${editBatch.length} paths` : `, Ø${fmtLen(editHoles[0].radiusMM * 2, units)}`}
              </div>
              {editBatch.length === 1 && editHoles.length === 1
                ? <div>Center: ({fmtLen(editHoles[0].cx, units, 1)}, {fmtLen(editHoles[0].cy, units, 1)})</div>
                : <div className="text-gray-500 dark:text-neutral-400 text-label">Re-read from the source path{editBatch.length > 1 ? 's' : ''} on every regenerate.</div>}
            </div>
          ) : selectedHoles.length > 0 ? (
            <div className="space-y-0.5">
              {selectedHoles.map(({ path, holes }) => {
                // Every subpath of one path is one operation, so the sizes it spans
                // matter: a set that mixes diameters bores each at its own radius.
                const dias = [...new Set(holes.map((h) => +(h.radiusMM * 2).toFixed(2)))]
                const r0 = Math.max(0, holes[0].radiusMM - (selectedTool?.diameterMM ?? 0) / 2)
                return (
                  <div key={path.id} className="text-body text-gray-800 dark:text-neutral-200 bg-gray-100 dark:bg-neutral-800 rounded px-2 py-1">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: path.color }} />
                      {path.name}
                      {holes.length > 1 && <span className="text-gray-500 dark:text-neutral-400 text-label">×{holes.length}</span>}
                    </div>
                    <div className="text-gray-500 dark:text-neutral-400 text-label mt-0.5">
                      Hole Ø {dias.length === 1 ? fmtLen(holes[0].radiusMM * 2, units) : dias.map((v) => fmtLen(v, units)).join(', ')}
                      {r0 > 0 ? ` · Toolpath Ø ${fmtLen(r0 * 2, units)}` : ' · center-drill (tool wider than hole)'}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1">
              <AlertCircle size={ICON.sm} /> Select one or more circular paths first
            </p>
          )}
          {helicalTools.length === 0 && (
            <p className="text-label text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1">
              <AlertCircle size={ICON.xs} /> Helical drilling needs an end mill — add one in the Tool Library.
            </p>
          )}
        </div>
      )}

      <ToolSelector tools={drillTools} value={form.toolId} onChange={handleToolChange} />
      <StartRow value={form.startFrom} onChange={(v) => up('startFrom', v)} resolved={startZ} opId={selfOpId} />
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)}
        maxDepthMM={selectedTool?.maxDepthMM} tool={selectedTool} startZMM={startZ.zMM} />
      <FormError msg={errorMsg} />
      <GenerateBtn
        disabled={!canGenerate}
        generating={generating}
        onClick={handleGenerate}
        label={editOp ? 'Regenerate Toolpath' : updating ? 'Update Toolpath' : 'Generate Toolpath'}
      />
    </FormShell>
  )
}
