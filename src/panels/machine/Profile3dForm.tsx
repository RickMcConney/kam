// ─── 3D Profile form ──────────────────────────────────────────────────────────
import { FormShell, AutoStepField, GenerateBtn, useSessionOps, toolsOfType, pickToolId, LengthInput, FormError, useGenerateError } from './shared'
import { useState, useEffect } from 'react'
import { NumericInput } from '../../components/NumericInput'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useToolStore } from '../../store/toolStore'
import { useToolpathStore, type AnyOperation, type Profile3dOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { runInWorkerFor, isWorkCancelled } from '../../workers/workerClient'
import { effectiveStepDownMM } from '../../cam/feeds'
import { parseStlGeometry, base64ToArrayBuffer } from '../../importers/stlImporter'
import { getBBox } from '../../canvas/selectionUtils'

interface Profile3dFormState {
  toolId: string
  stepoverPercent: number
  rasterAngleDeg: number
  maxDepthMM: number
  pathId: string
  roughingToolId: string        // '' = no roughing pass
  roughingStepoverPercent: number
  roughingStepDownMM: number
  roughingStockAllowanceMM: number
  roughingRasterAngleDeg: number | ''  // '' = auto (finishing angle + 90)
}

export function Profile3dForm({ onClose, editOp }: { onClose: () => void; editOp?: Profile3dOperation }) {
  const { tools } = useToolStore()
  const { paths } = usePathsStore()
  const { addOperation, setSegments, updateOperation } = useToolpathStore()
  const { load, save } = useFormDefaultsStore()
  const { safeHeightMM, autoFeedEnabled, thicknessMM, units } = useWorkpieceStore()

  // Ball nose for BOTH slots, and no fall-back to the whole library. The finishing bit is
  // gated on it by `canGenerate`; the roughing bit is ball-only by construction, since
  // profile3d models the rougher as a sphere (`roughingBallRadius`) and skips the entire
  // roughing pass when that is undefined — a flat rougher would silently become a
  // single-pass finish rather than an error.
  const ballNoseTools = toolsOfType(tools, ['ballnose'])
  const defaultTool = ballNoseTools[0]
  const stlPaths = paths.filter((p) => !!p.stlSrc)

  const [form, setForm] = useState<Profile3dFormState>(() => {
    const base: Profile3dFormState = editOp ? {
      toolId: editOp.toolId,
    stepoverPercent: editOp.stepoverPercent,
    rasterAngleDeg: editOp.rasterAngleDeg,
    maxDepthMM: editOp.maxDepthMM,
    pathId: editOp.pathId,
    roughingToolId: editOp.roughingToolId ?? '',
    roughingStepoverPercent: editOp.roughingStepoverPercent ?? 60,
    roughingStepDownMM: editOp.roughingStepDownMM ?? 2,
    roughingStockAllowanceMM: editOp.roughingStockAllowanceMM ?? 0.3,
    roughingRasterAngleDeg: editOp.roughingRasterAngleDeg ?? '',
  } : mergeWithDefaults(load('profile3d'), {
    toolId: defaultTool?.id ?? '',
    stepoverPercent: 20,
    rasterAngleDeg: 0,
    // Default to the full stock thickness; the tool's max Z is only a warning.
    maxDepthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    pathId: stlPaths[0]?.id ?? '',
    roughingToolId: '',
    roughingStepoverPercent: 60,
    roughingStepDownMM: 2,
    roughingStockAllowanceMM: 0.3,
    roughingRasterAngleDeg: '' as number | '',
  }, tools)
    return { ...base,
      toolId: pickToolId(base.toolId, ballNoseTools),
      // '' is "no roughing pass" — an explicit choice, not a stale id.
      roughingToolId: base.roughingToolId === '' ? '' : pickToolId(base.roughingToolId, ballNoseTools) }
  })
  const [generating, setGenerating] = useState(false)
  const [errorMsg, reportError, clearError] = useGenerateError()
  const session = useSessionOps()

  // Sync pathId: saved defaults use session-specific path IDs that become stale on reload.
  // Also handles importing an STL after the form is already open.
  useEffect(() => {
    if (!stlPaths.find((p) => p.id === form.pathId)) {
      const first = stlPaths[0]
      if (first) setForm((f) => ({ ...f, pathId: first.id }))
    }
  }, [stlPaths.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedTool = tools.find((t) => t.id === form.toolId)
  const selectedPath = paths.find((p) => p.id === form.pathId)
  const roughingTool = form.roughingToolId ? tools.find((t) => t.id === form.roughingToolId) : undefined
  const hasRoughing = !!form.roughingToolId

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId }))
  }

  function up<K extends keyof Profile3dFormState>(k: K, v: Profile3dFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleGenerate() {
    if (!selectedTool || !selectedPath || !selectedPath.stlSrc || !selectedPath.stlModelBounds) return
    setGenerating(true)
    clearError()
    // Re-Generate for a model this form already generated for updates that op in place.
    const existingId = editOp ? undefined : session.liveOpId(form.pathId)

    setTimeout(async () => {
      try {
        const buf = base64ToArrayBuffer(selectedPath.stlSrc!)
        const geo = parseStlGeometry(buf)
        const positions = new Float32Array(geo.attributes.position.array)
        const indices = geo.index ? new Uint32Array(geo.index.array) : null
        geo.dispose()
        const cncBbox = getBBox(selectedPath.d)
        if (!cncBbox) throw new Error('Could not read the STL outline — the model may be empty')

        const params = {
          stepoverPercent: form.stepoverPercent,
          rasterAngleDeg: form.rasterAngleDeg,
          maxDepthMM: form.maxDepthMM,
          roughingBallRadius: roughingTool?.type === 'ballnose' ? roughingTool.diameterMM / 2 : undefined,
          roughingStepoverPercent: hasRoughing ? form.roughingStepoverPercent : undefined,
          roughingStepDownMM: hasRoughing && roughingTool ? effectiveStepDownMM(roughingTool, form.roughingStepDownMM, form.maxDepthMM) : undefined,
          roughingStockAllowanceMM: hasRoughing ? form.roughingStockAllowanceMM : undefined,
          roughingRasterAngleDeg: hasRoughing && form.roughingRasterAngleDeg !== '' ? form.roughingRasterAngleDeg : undefined,
          roughingToolId: hasRoughing ? form.roughingToolId : undefined,
          finishingToolId: form.toolId,
          safeHeightMM,
        }
        const segments = await runInWorkerFor(editOp?.id ?? existingId, 'generateProfile3d', positions, indices, selectedPath.stlModelBounds!, cncBbox, selectedTool, params)

        const opName = hasRoughing
          ? `3D Profile: ${selectedPath.name} (rough: ${roughingTool?.name ?? ''} / finish: ${selectedTool.name})`
          : `3D Profile: ${selectedPath.name} (${selectedTool.name})`

        const roughingRasterAngle = hasRoughing && form.roughingRasterAngleDeg !== '' ? form.roughingRasterAngleDeg : undefined
        const updateId = editOp?.id ?? existingId
        if (updateId) {
          updateOperation(updateId, {
            toolId: form.toolId,
            stepoverPercent: form.stepoverPercent,
            rasterAngleDeg: form.rasterAngleDeg, maxDepthMM: form.maxDepthMM,
            roughingToolId: hasRoughing ? form.roughingToolId : undefined,
            roughingStepoverPercent: hasRoughing ? form.roughingStepoverPercent : undefined,
            roughingStepDownMM: hasRoughing ? form.roughingStepDownMM : undefined,
            roughingStockAllowanceMM: hasRoughing ? form.roughingStockAllowanceMM : undefined,
            roughingRasterAngleDeg: roughingRasterAngle,
            name: opName, status: 'generating',
          } as Partial<AnyOperation>)
          setSegments(updateId, segments)
        } else {
          const newOpId = addOperation({
            name: opName,
            type: 'profile3d',
            toolId: form.toolId,
            pathId: form.pathId,
            stepoverPercent: form.stepoverPercent,
            rasterAngleDeg: form.rasterAngleDeg,
            maxDepthMM: form.maxDepthMM,
            roughingToolId: hasRoughing ? form.roughingToolId : undefined,
            roughingStepoverPercent: hasRoughing ? form.roughingStepoverPercent : undefined,
            roughingStepDownMM: hasRoughing ? form.roughingStepDownMM : undefined,
            roughingStockAllowanceMM: hasRoughing ? form.roughingStockAllowanceMM : undefined,
            roughingRasterAngleDeg: roughingRasterAngle,
          })
          updateOperation(newOpId, { status: 'generating' })
          setSegments(newOpId, segments)
          session.remember(form.pathId, newOpId)
        }
        save('profile3d', form)
      } catch (err) {
        if (!isWorkCancelled(err)) {
          const failId = editOp?.id ?? existingId
          if (failId) reportError(failId, err)
        }
      } finally {
        setGenerating(false)
      }
    }, 0)
  }

  const canGenerate = !!selectedTool && selectedTool.type === 'ballnose' && !!selectedPath?.stlSrc && !generating && form.maxDepthMM > 0

  return (
    <FormShell title={editOp ? 'Edit 3D Profile' : 'New 3D Profile'} onClose={onClose}>
      {/* STL source path */}
      <div>
        <label htmlFor="p3d-stl-model" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">STL Model</label>
        {stlPaths.length === 0 ? (
          <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1">
            <AlertCircle size={ICON.sm} /> Import an STL file first
          </p>
        ) : (
          <select id="p3d-stl-model"
            value={form.pathId}
            onChange={(e) => up('pathId', e.target.value)}
            className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500"
          >
            {stlPaths.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Strategy */}
      {/* ── Roughing pass (optional) ─────────────────────────────────────────── */}
      <div className="border border-gray-400 dark:border-neutral-700 rounded p-2 space-y-2">
        <div>
          <label htmlFor="p3d-roughing-tool-optional" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
            Roughing Tool <span className="normal-case text-gray-600 dark:text-neutral-400">(optional)</span>
          </label>
          <select id="p3d-roughing-tool-optional"
            value={form.roughingToolId}
            onChange={(e) => up('roughingToolId', e.target.value)}
            className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500"
          >
            <option value="">— None (single-pass) —</option>
            {ballNoseTools.map((t) => (
              <option key={t.id} value={t.id}>{t.name} (Ø{fmtLen(t.diameterMM, units)})</option>
            ))}
          </select>
        </div>

        {hasRoughing && (
          <>
            <div>
              <label htmlFor="p3d-roughing-stepover" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
                Roughing Stepover
              </label>
              <div className="flex items-center gap-1">
                <NumericInput id="p3d-roughing-stepover"
                  value={form.roughingStepoverPercent}
                  min={5} max={100} step={5}
                  onChange={(v) => up('roughingStepoverPercent', v)}
                  className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
                />
                <span className="text-label text-gray-600 dark:text-neutral-400">%</span>
                {roughingTool && (
                  <span className="text-label text-gray-600 dark:text-neutral-400 ml-1">
                    ({fmtLen(roughingTool.diameterMM * form.roughingStepoverPercent / 100, units)})
                  </span>
                )}
              </div>
            </div>
            {autoFeedEnabled && roughingTool ? (
              <AutoStepField label="Roughing Step Down" valueMM={effectiveStepDownMM(roughingTool, form.roughingStepDownMM, form.maxDepthMM)} />
            ) : (
              <div>
                <label htmlFor="p3d-roughing-step-down" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
                  Roughing Step Down
                </label>
                <LengthInput id="p3d-roughing-step-down" valueMM={form.roughingStepDownMM} minMM={0.1} maxMM={50} stepMM={0.5}
                  onChangeMM={(v) => up('roughingStepDownMM', v)} />
              </div>
            )}
            <div>
              <label htmlFor="p3d-roughing-angle" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
                Roughing Angle
              </label>
              <div className="flex items-center gap-1">
                <input id="p3d-roughing-angle"
                  type="number"
                  value={form.roughingRasterAngleDeg === '' ? '' : form.roughingRasterAngleDeg}
                  min={-180} max={180} step={15}
                  placeholder={`auto (${form.rasterAngleDeg + 90}°)`}
                  onChange={(e) => up('roughingRasterAngleDeg', e.target.value === '' ? '' : Number(e.target.value))}
                  className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
                />
                <span className="text-label text-gray-600 dark:text-neutral-400">°</span>
              </div>
            </div>
            <div>
              <label htmlFor="p3d-stock-allowance" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
                Stock Allowance
              </label>
              <LengthInput id="p3d-stock-allowance" valueMM={form.roughingStockAllowanceMM} minMM={0} maxMM={2} stepMM={0.1}
                onChangeMM={(v) => up('roughingStockAllowanceMM', v)} />
            </div>
            <p className="text-label text-blue-400 dark:text-blue-500">
              Roughing makes multiple passes at increasing depth; finishing cleans up to final surface
            </p>
          </>
        )}
      </div>

      {/* ── Finishing bit ────────────────────────────────────────────────────── */}
      <div>
        <label htmlFor="p3d-f7" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          {hasRoughing ? 'Finishing Tool' : 'Tool'}
        </label>
        <select id="p3d-f7"
          value={form.toolId}
          onChange={(e) => handleToolChange(e.target.value)}
          disabled={ballNoseTools.length === 0}
          className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 disabled:opacity-60"
        >
          {ballNoseTools.length === 0 && <option value="">No ball nose — add one in the Tool Library</option>}
          {ballNoseTools.map((t) => (
            <option key={t.id} value={t.id}>{t.name} (Ø{fmtLen(t.diameterMM, units)})</option>
          ))}
        </select>
      </div>
      {selectedTool && selectedTool.type !== 'ballnose' && (
        <p className="text-label text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <AlertCircle size={ICON.xs} /> Ball nose tool recommended for 3D profiling
        </p>
      )}

      {/* Stepover */}
      <div>
        <label htmlFor="p3d-xy" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">
          {hasRoughing ? 'Finishing Stepover' : 'Stepover'} (XY)
        </label>
        <div className="flex items-center gap-1">
          <NumericInput id="p3d-xy"
            value={form.stepoverPercent}
            min={1} max={100} step={5}
            onChange={(v) => up('stepoverPercent', v)}
            className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
          />
          <span className="text-label text-gray-600 dark:text-neutral-400">%</span>
          {selectedTool && (
            <span className="text-label text-gray-600 dark:text-neutral-400 ml-1">
              ({fmtLen(selectedTool.diameterMM * form.stepoverPercent / 100, units)})
            </span>
          )}
        </div>
      </div>

      {/* Raster angle */}
      <div>
        <label htmlFor="p3d-angle" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Angle</label>
        <div className="flex items-center gap-1">
          <NumericInput id="p3d-angle"
            value={form.rasterAngleDeg}
            min={-90} max={90} step={15}
            onChange={(v) => up('rasterAngleDeg', v)}
            className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
          />
          <span className="text-label text-gray-600 dark:text-neutral-400">°</span>
        </div>
      </div>

      {/* Max depth */}
      <div>
        <label htmlFor="p3d-max-depth" className="block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1">Max Depth</label>
        <LengthInput id="p3d-max-depth" valueMM={form.maxDepthMM} minMM={0.1} stepMM={0.5}
          onChangeMM={(v) => up('maxDepthMM', v)} />
        {selectedTool && form.maxDepthMM > selectedTool.maxDepthMM && (
          <p className="text-label text-amber-600 dark:text-amber-500 flex items-center gap-1 mt-0.5">
            <AlertCircle size={10} className="shrink-0" />
            Exceeds tool Max Z ({fmtLen(selectedTool.maxDepthMM, units)})
          </p>
        )}
      </div>

      <FormError msg={errorMsg} />
      <GenerateBtn
        disabled={!canGenerate}
        generating={generating}
        onClick={handleGenerate}
        label={editOp ? 'Regenerate Toolpath' : session.liveOpId(form.pathId) ? 'Update Toolpath' : 'Generate Toolpath'}
      />
    </FormShell>
  )
}
