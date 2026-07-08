// ─── Inlay form ───────────────────────────────────────────────────────────────
import { FormShell, PathChip, AutoStepField, GenerateBtn } from './shared'
import { useState } from 'react'
import { NumericInput } from '../../components/NumericInput'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore, type Tool } from '../../store/toolStore'
import { useToolpathStore, INLAY_NO_FINISH, type AnyOperation, type InlayOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { runInWorker } from '../../workers/workerClient'
import { effectiveStepDownMM } from '../../cam/feeds'
import { groupPathsByContainment } from './containment'

interface InlayFormState {
  vbitToolId: string
  pocketToolId: string
  pocketDepthMM: number
  stepDownMM: number
  stepoverPercent: number
  glueLineMM: number
  clearanceMM: number
  role: 'female' | 'male'
  rampIn: boolean
  mirrorX: boolean
}

export function InlayForm({ onClose, editOp }: { onClose: () => void; editOp?: InlayOperation }) {
  const { tools } = useToolStore()
  const { paths, selectedIds, pushHistoryBoth } = usePathsStore()
  const { addOperation, setSegments, setError, updateOperation, operations } = useToolpathStore()
  const { load, save } = useFormDefaultsStore()
  const { safeHeightMM, autoFeedEnabled } = useWorkpieceStore()

  const vbits = tools.filter((t) => t.type === 'vbit')
  const endmills = tools.filter((t) => t.type === 'endmill' || t.type === 'ballnose')
  const defaultVbit = vbits[0] ?? tools[0]
  const defaultEndmill = endmills[0] ?? tools[0]

  const [form, setForm] = useState<InlayFormState>(() => editOp ? {
    vbitToolId: editOp.vbitToolId, pocketToolId: editOp.pocketToolId,
    pocketDepthMM: editOp.pocketDepthMM,
    stepDownMM: editOp.stepDownMM, stepoverPercent: editOp.stepoverPercent,
    glueLineMM: editOp.glueLineMM, clearanceMM: editOp.clearanceMM,
    role: editOp.role, rampIn: editOp.rampIn ?? false, mirrorX: editOp.mirrorX ?? false,
  } : mergeWithDefaults(load('inlay'), {
    vbitToolId: defaultVbit?.id ?? '',
    pocketToolId: defaultEndmill?.id ?? '',
    pocketDepthMM: 5,
    stepDownMM: defaultEndmill?.stepDownMM ?? 3,
    stepoverPercent: 40,
    glueLineMM: 0.2,
    clearanceMM: 0.1,
    role: 'female' as const,
    rampIn: false,
    mirrorX: false,
  }, tools))
  const [generating, setGenerating] = useState(false)

  // Finish = "None": roughing tool only, no separate wall-finish pass. Female → flat-walled
  // pocket; male → flat-walled plug freed by the roughing bit. One operation, no pairing.
  const finishIsNone = form.vbitToolId === INLAY_NO_FINISH
  const vbitTool = finishIsNone ? null : tools.find((t) => t.id === form.vbitToolId)
  const pocketTool = tools.find((t) => t.id === form.pocketToolId)
  const editBoundary = editOp ? paths.find((p) => p.id === editOp.pathId) : null
  const editIslands = editOp ? paths.filter((p) => editOp.islandIds.includes(p.id)) : []
  const groups = editOp && editBoundary
    ? [{ boundary: editBoundary, islands: editIslands }]
    : groupPathsByContainment(paths.filter((p) => selectedIds.includes(p.id)))

  function up<K extends keyof InlayFormState>(k: K, v: InlayFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleGenerate() {
    if (groups.length === 0 || !pocketTool || (!vbitTool && !finishIsNone)) return
    pushHistoryBoth()
    setGenerating(true)

    // After the guard, the wall tool is present unless finishIsNone (roughing-only); the
    // finishIsNone path returns early below, so non-None branches always have a real tool.
    const wallTool: Tool | null = vbitTool ?? null
    const angleDeg = vbitTool?.vbitAngleDeg ?? 60
    const baseParams = {
      angleDeg,
      pocketDepthMM: form.pocketDepthMM,
      stepDownMM: effectiveStepDownMM(pocketTool, form.stepDownMM, form.pocketDepthMM),
      stepoverPercent: form.stepoverPercent,
      glueLineMM: form.glueLineMM,
      clearanceMM: form.clearanceMM,
      rampIn: form.rampIn,
      mirrorX: form.mirrorX,
      safeHeightMM,
    }
    const sharedOpFields = {
      pocketToolId: form.pocketToolId,
      vbitToolId: form.vbitToolId,
      angleDeg,
      pocketDepthMM: form.pocketDepthMM,
      stepDownMM: form.stepDownMM,
      stepoverPercent: form.stepoverPercent,
      glueLineMM: form.glueLineMM,
      clearanceMM: form.clearanceMM,
      rampIn: form.rampIn,
      mirrorX: form.mirrorX,
    }

    if (editOp && editBoundary) {
      const inlayParams = { ...baseParams, islandDs: editIslands.map((p) => p.d) }
      // Update both the edited op and its linked counterpart with new params.
      const linkedOp = editOp.linkedOpId
        ? (operations.find((o) => o.id === editOp.linkedOpId) as InlayOperation | undefined)
        : undefined
      const sharedUpdate = {
        ...sharedOpFields,
        toolId: editOp.phase === 'vbit' ? form.vbitToolId : form.pocketToolId,
        status: 'generating' as const,
      }
      updateOperation(editOp.id, sharedUpdate as Partial<AnyOperation>)
      if (linkedOp) {
        updateOperation(linkedOp.id, {
          ...sharedOpFields,
          toolId: linkedOp.phase === 'vbit' ? form.vbitToolId : form.pocketToolId,
          status: 'generating',
        } as Partial<AnyOperation>)
      }
      setTimeout(async () => {
        try {
          const result = editOp.role === 'female'
            ? await runInWorker('generateInlayFemale', editBoundary.d, pocketTool, wallTool, inlayParams)
            : await runInWorker('generateInlayMale', editBoundary.d, pocketTool, wallTool, inlayParams)
          setSegments(editOp.id, editOp.phase === 'vbit' ? result.vbitSegs : result.endmillSegs)
          if (linkedOp) {
            setSegments(linkedOp.id, editOp.phase === 'vbit' ? result.endmillSegs : result.vbitSegs)
          }

        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Generation failed'
          setError(editOp.id, msg)
          if (linkedOp) setError(linkedOp.id, msg)
        }
        setGenerating(false)
        save('inlay', form)
      }, 0)
      return
    }

    // Finish = None (roughing-only): one end-mill op per group, no finish phase and no
    // pairing. Female → the raster pocket forms the flat-walled socket; male → the roughing
    // bit profiles the flat-walled plug and pockets any island sockets. All segs are endmill.
    if (finishIsNone) {
      const role = form.role
      const roleLabel = role === 'female' ? 'Female' : 'Male'
      const opBase = { type: 'inlay' as const, role, ...sharedOpFields }
      const ids = groups.map(({ boundary, islands }) => {
        const id = addOperation({ ...opBase, phase: 'endmill', toolId: form.pocketToolId,
          pathId: boundary.id, islandIds: islands.map((p) => p.id),
          name: `Inlay ${roleLabel} (End Mill): ${boundary.name}` })
        updateOperation(id, { status: 'generating' })
        return id
      })
      setTimeout(async () => {
        for (let i = 0; i < groups.length; i++) {
          const { boundary, islands } = groups[i]
          const inlayParams = { ...baseParams, islandDs: islands.map((p) => p.d) }
          try {
            const result = role === 'female'
              ? await runInWorker('generateInlayFemale', boundary.d, pocketTool, null, inlayParams)
              : await runInWorker('generateInlayMale', boundary.d, pocketTool, null, inlayParams)
            setSegments(ids[i], result.endmillSegs)
          } catch (err) {
            setError(ids[i], err instanceof Error ? err.message : 'Generation failed')
          }
        }
        setGenerating(false)
        save('inlay', form)
      }, 0)
      return
    }

    // For new ops: create all first-phase ops first, then all second-phase ops, so
    // the operations list naturally orders roughing before finishing.
    // Female (any): endmill (roughing pocket) first, vbit/finish (walls) second.
    // Male V-bit: vbit (bevel profile) first, endmill (release cut) second.
    // Male endmill-only: endmill (roughing release) first, vbit/finish (release) second.
    const role = form.role
    const isEndmillOnly = vbitTool?.type !== 'vbit'
    const firstPhase  = (role === 'female' || isEndmillOnly) ? 'endmill' : 'vbit'   as 'vbit' | 'endmill'
    const secondPhase = (role === 'female' || isEndmillOnly) ? 'vbit'    : 'endmill' as 'vbit' | 'endmill'
    const firstToolId  = firstPhase  === 'vbit' ? form.vbitToolId : form.pocketToolId
    const secondToolId = secondPhase === 'vbit' ? form.vbitToolId : form.pocketToolId
    const roleLabel = role === 'female' ? 'Female' : 'Male'
    const phaseLabel = (phase: 'vbit' | 'endmill') => phase === 'vbit' ? 'V-bit' : 'End Mill'

    const opBase = { type: 'inlay' as const, role, ...sharedOpFields }

    // Create all first-phase ops, then all second-phase ops.
    const firstIds = groups.map(({ boundary, islands }) => {
      const id = addOperation({ ...opBase, phase: firstPhase, toolId: firstToolId,
        pathId: boundary.id, islandIds: islands.map((p) => p.id),
        name: `Inlay ${roleLabel} (${phaseLabel(firstPhase)}): ${boundary.name}` })
      updateOperation(id, { status: 'generating' })
      return id
    })
    const secondIds = groups.map(({ boundary, islands }) => {
      const id = addOperation({ ...opBase, phase: secondPhase, toolId: secondToolId,
        pathId: boundary.id, islandIds: islands.map((p) => p.id),
        name: `Inlay ${roleLabel} (${phaseLabel(secondPhase)}): ${boundary.name}` })
      updateOperation(id, { status: 'generating' })
      return id
    })

    // Link paired ops so edit/regenerate can update both together.
    for (let i = 0; i < groups.length; i++) {
      updateOperation(firstIds[i],  { linkedOpId: secondIds[i]  } as Partial<AnyOperation>)
      updateOperation(secondIds[i], { linkedOpId: firstIds[i]   } as Partial<AnyOperation>)
    }

    setTimeout(async () => {
      for (let i = 0; i < groups.length; i++) {
        const { boundary, islands } = groups[i]
        const inlayParams = { ...baseParams, islandDs: islands.map((p) => p.d) }
        try {
          const result = role === 'female'
            ? await runInWorker('generateInlayFemale', boundary.d, pocketTool, wallTool, inlayParams)
            : await runInWorker('generateInlayMale', boundary.d, pocketTool, wallTool, inlayParams)
          setSegments(firstIds[i],  firstPhase  === 'vbit' ? result.vbitSegs : result.endmillSegs)
          setSegments(secondIds[i], secondPhase === 'vbit' ? result.vbitSegs : result.endmillSegs)

        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Generation failed'
          setError(firstIds[i], msg)
          setError(secondIds[i], msg)
        }
      }
      setGenerating(false)
      save('inlay', form)
    }, 0)
  }

  const isEndmillMode = !!vbitTool && vbitTool.type !== 'vbit'
  const canGenerate = groups.length > 0 && (!!vbitTool || finishIsNone) && !!pocketTool && !generating && form.pocketDepthMM > 0
  const isMale = editOp ? editOp.role === 'male' : form.role === 'male'

  return (
    <FormShell title={editOp ? `Edit Inlay (${editOp.role})` : 'New Inlay Operation'} onClose={onClose}>
      <div>
        {groups.length === 0 ? (
          <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> Select a closed path first</p>
        ) : (
          <div className="space-y-1">
            {groups.map(({ boundary, islands }, i) => (
              <div key={boundary.id}>
                {groups.length > 1 && (
                  <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
                    Shape {i + 1}
                  </label>
                )}
                <div className="space-y-0.5">
                  <PathChip path={boundary} label="boundary" />
                  {islands.map((p) => <PathChip key={p.id} path={p} label="island" />)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {/* Roughing tool */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">End Mill (Roughing / Profile)</label>
        <select
          value={form.pocketToolId}
          onChange={(e) => {
            const t = tools.find((x) => x.id === e.target.value)
            if (t) up('stepDownMM', t.stepDownMM)
            up('pocketToolId', e.target.value)
          }}
          className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500"
        >
          {(endmills.length > 0 ? endmills : tools).map((t) => (
            <option key={t.id} value={t.id}>{t.name} (Ø{t.diameterMM}mm)</option>
          ))}
        </select>
      </div>
      {/* Finish tool */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Finish Tool</label>
        <select
          value={form.vbitToolId}
          onChange={(e) => up('vbitToolId', e.target.value)}
          className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500"
        >
          {/* Skip the wall-finish pass — the roughing bit alone forms the socket / plug walls. */}
          <option value={INLAY_NO_FINISH}>None — roughing only</option>
          {tools.map((t) => (
            <option key={t.id} value={t.id}>{t.name} (Ø{t.diameterMM}mm)</option>
          ))}
        </select>
        {finishIsNone && (
          <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">No finish pass — flat walls left by the roughing bit (corners at its radius).</p>
        )}
        {vbitTool?.type === 'vbit' && (
          <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">V-bit — sloped bevel walls</p>
        )}
        {vbitTool && vbitTool.type !== 'vbit' && (
          <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">End mill — flat walls, corners auto-rounded to Ø{vbitTool.diameterMM}mm</p>
        )}
      </div>
      {vbitTool?.type === 'vbit' && (
        <p className="text-label text-gray-400 dark:text-neutral-500">
          V-bit angle: {vbitTool.vbitAngleDeg ?? 60}° (set on tool)
        </p>
      )}
      {/* Depth */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Inlay Depth</label>
          <div className="flex items-center gap-1">
            <NumericInput value={form.pocketDepthMM} min={0.5} step={0.5}
              onChange={(v) => up('pocketDepthMM', v)}
              className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
            />
            <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
          </div>
        </div>
        {autoFeedEnabled && pocketTool ? (
          <AutoStepField label="Step Down" valueMM={effectiveStepDownMM(pocketTool, form.stepDownMM, form.pocketDepthMM)} />
        ) : (
          <div>
            <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Step Down</label>
            <div className="flex items-center gap-1">
              <NumericInput value={form.stepDownMM} min={0.1} step={0.5}
                onChange={(v) => up('stepDownMM', v)}
                className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
              />
              <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
            </div>
          </div>
        )}
      </div>
      {/* Stepover */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          Stepover <span className="text-gray-500 dark:text-neutral-400 normal-case">{form.stepoverPercent}%</span>
        </label>
        <input type="range" min={10} max={90} step={5} value={form.stepoverPercent}
          onChange={(e) => up('stepoverPercent', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>
      {/* Glue + clearance */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Glue Gap</label>
          <div className="flex items-center gap-1">
            <NumericInput value={form.glueLineMM} min={0} step={0.05}
              onChange={(v) => up('glueLineMM', v)}
              className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
            />
            <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
          </div>
        </div>
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Clearance</label>
          <div className="flex items-center gap-1">
            <NumericInput value={form.clearanceMM} min={-1} max={1} step={0.05}
              onChange={(v) => up('clearanceMM', v)}
              className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
            />
            <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
          </div>
        </div>
      </div>
      {!editOp && (
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Generate</label>
          <div className="flex gap-1">
            {(['female', 'male'] as const).map((r) => (
              <button key={r} onClick={() => up('role', r)}
                className={[
                  'flex-1 py-1 text-body rounded border transition-colors capitalize',
                  form.role === r
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-gray-50 dark:bg-neutral-900 border-gray-300 dark:border-neutral-700 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200',
                ].join(' ')}>
                {r === 'female' ? 'Female' : 'Male'}
              </button>
            ))}
          </div>
          <p className="text-label text-gray-400 dark:text-neutral-500 mt-1">
            {isEndmillMode
              ? (form.role === 'female' ? 'Socket only — flat pocket, corners rounded to bit radius.' : 'Plug only — flat-sided plug, corners rounded to bit radius.')
              : (form.role === 'female' ? 'Socket only — pocket + V-carved walls.' : 'Plug only — V-carved bevel + profile cutout.')}
          </p>
        </div>
      )}
      {/* Ramp In — angled/helical entry on roughing pockets and end-mill finish passes */}
      <div className="flex items-center gap-2">
        <input type="checkbox" id="inlay-ramp-in" checked={form.rampIn}
          onChange={(e) => up('rampIn', e.target.checked)} className="accent-blue-500" />
        <label htmlFor="inlay-ramp-in" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
          Ramp In <span className="text-gray-500 dark:text-neutral-500 normal-case">(2× dia, 50% feed)</span>
        </label>
      </div>

      {/* Mirror option — male plug only */}
      {isMale && (
        <div className="flex items-center gap-2">
          <input type="checkbox" id="inlay-mirror" checked={form.mirrorX}
            onChange={(e) => up('mirrorX', e.target.checked)} className="accent-blue-500" />
          <label htmlFor="inlay-mirror" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">
            Mirror <span className="text-gray-500 dark:text-neutral-500 normal-case">(flip horizontally — for asymmetric shapes inserted reversed)</span>
          </label>
        </div>
      )}
      <GenerateBtn disabled={!canGenerate} generating={generating} onClick={handleGenerate}
        label={editOp
          ? `Regenerate ${editOp.role === 'female' ? 'Female' : 'Male'}`
          : `Generate ${form.role === 'female' ? 'Female' : 'Male'}${groups.length > 1 ? ` (${groups.length * (finishIsNone ? 1 : 2)} ops)` : ''}`} />
    </FormShell>
  )
}
