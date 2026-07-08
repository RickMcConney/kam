// ─── Drill form ───────────────────────────────────────────────────────────────
import { FormShell, ToolSelector, DepthRow, GenerateBtn } from './shared'
import { useState, useEffect } from 'react'
import { ICON } from '../../theme'
import { AlertCircle, X } from 'lucide-react'
import { useToolStore } from '../../store/toolStore'
import { useToolpathStore, type AnyOperation, type DrillOperation } from '../../store/toolpathStore'
import { useFormDefaultsStore, mergeWithDefaults } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { useUIStore } from '../../store/uiStore'
import { generatePeckDrill, generateHelicalDrill } from '../../cam/drill'
import { effectiveStepDownMM } from '../../cam/feeds'
import { extractCircle } from '../../canvas/selectionUtils'

interface DrillFormState {
  toolId: string
  drillMode: 'peck' | 'helical'
  depthMM: number
  stepDownMM: number
}

export function DrillForm({ onClose, editOp }: { onClose: () => void; editOp?: DrillOperation }) {
  const { tools } = useToolStore()
  const { paths, selectedIds, pushHistoryBoth } = usePathsStore()
  const { addOperation, setSegments, setError, updateOperation } = useToolpathStore()
  const { activeTool, setActiveTool, pendingDrillPoints, clearDrillPoints } = useUIStore()
  const { load, save } = useFormDefaultsStore()
  const { safeHeightMM, thicknessMM } = useWorkpieceStore()

  const defaultTool = tools[0]
  const [form, setForm] = useState<DrillFormState>(() => editOp ? {
    toolId: editOp.toolId, drillMode: editOp.drillMode,
    depthMM: editOp.depthMM, stepDownMM: editOp.stepDownMM,
  } : mergeWithDefaults(load('drill'), {
    toolId: defaultTool?.id ?? '',
    drillMode: 'peck' as const,
    // Default to the full stock thickness; the tool's max Z is only a warning.
    depthMM: thicknessMM > 0 ? thicknessMM : (defaultTool?.maxDepthMM ?? 10),
    stepDownMM: defaultTool?.stepDownMM ?? 3,
  }, tools))
  const [generating, setGenerating] = useState(false)

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

  const selectedTool = tools.find((t) => t.id === form.toolId)

  // For helical: all selected circular paths
  const selectedCircles = editOp ? [] : paths
    .filter((p) => selectedIds.includes(p.id))
    .flatMap((p) => {
      const circle = extractCircle(p)
      return circle ? [{ path: p, circle }] : []
    })

  // For edit mode: reconstruct helical info from stored op params
  const editHelicalInfo = editOp?.drillMode === 'helical' && editOp.helicalCenterX !== undefined ? {
    cx: editOp.helicalCenterX!,
    cy: editOp.helicalCenterY!,
    radius: editOp.helicalRadius ?? 0,
  } : null

  function handleToolChange(toolId: string) {
    const t = tools.find((x) => x.id === toolId)
    if (t) setForm((f) => ({ ...f, toolId, stepDownMM: t.stepDownMM }))
  }

  function up<K extends keyof DrillFormState>(k: K, v: DrillFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleClose() {
    if (activeTool === 'drill') { setActiveTool('select'); clearDrillPoints() }
    onClose()
  }

  function handleGenerate() {
    if (!selectedTool) return
    pushHistoryBoth()
    setGenerating(true)

    if (editOp) {
      updateOperation(editOp.id, {
        toolId: form.toolId, depthMM: form.depthMM, stepDownMM: form.stepDownMM, status: 'generating',
      } as Partial<AnyOperation>)
      setTimeout(() => {
        try {
          let segs
          if (editOp.drillMode === 'helical' && editHelicalInfo) {
            segs = generateHelicalDrill(editHelicalInfo.cx, editHelicalInfo.cy, editHelicalInfo.radius, selectedTool, {
              depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(selectedTool, form.stepDownMM, form.depthMM), safeHeightMM,
            })
          } else {
            segs = generatePeckDrill(editOp.points, selectedTool, {
              depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(selectedTool, form.stepDownMM, form.depthMM), safeHeightMM,
            })
          }
          setSegments(editOp.id, segs)
        } catch (err) {
          setError(editOp.id, err instanceof Error ? err.message : 'Generation failed')
        }
        setGenerating(false)
        save('drill', form)
      }, 0)
      return
    }

    if (form.drillMode === 'peck' && pendingDrillPoints.length === 0) { setGenerating(false); return }
    if (form.drillMode === 'helical' && selectedCircles.length === 0) { setGenerating(false); return }

    setTimeout(() => {
      if (form.drillMode === 'helical') {
        for (const { path, circle } of selectedCircles) {
          const r = Math.max(0, circle.radiusMM - selectedTool.diameterMM / 2)
          const opId = addOperation({
            name: `Helical Drill: ${path.name} (${selectedTool.name})`,
            type: 'drill',
            toolId: form.toolId,
            drillMode: 'helical',
            points: [],
            pathId: path.id,
            helicalCenterX: circle.cx,
            helicalCenterY: circle.cy,
            helicalRadius: r,
            depthMM: form.depthMM,
            stepDownMM: form.stepDownMM,
          })
          updateOperation(opId, { status: 'generating' })
          try {
            setSegments(opId, generateHelicalDrill(circle.cx, circle.cy, r, selectedTool, {
              depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(selectedTool, form.stepDownMM, form.depthMM), safeHeightMM,
            }))
          } catch (err) {
            setError(opId, err instanceof Error ? err.message : 'Generation failed')
          }
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
        })
        updateOperation(opId, { status: 'generating' })
        try {
          setSegments(opId, generatePeckDrill(pendingDrillPoints, selectedTool, {
            depthMM: form.depthMM, stepDownMM: effectiveStepDownMM(selectedTool, form.stepDownMM, form.depthMM), safeHeightMM,
          }))
        } catch (err) {
          setError(opId, err instanceof Error ? err.message : 'Generation failed')
        }
      }
      setGenerating(false)
      save('drill', form)
      clearDrillPoints()
    }, 0)
  }

  const isNonDrillTool = !!selectedTool && selectedTool.type !== 'drill'
  const isDrillTool = selectedTool?.type === 'drill'
  const peckReady = editOp ? editOp.points.length > 0 : pendingDrillPoints.length > 0
  const helicalReady = editOp ? !!editHelicalInfo : selectedCircles.length > 0
  const canGenerate = !!selectedTool && !generating && form.depthMM > 0 &&
    ((form.drillMode === 'peck' && peckReady) || (form.drillMode === 'helical' && helicalReady && !isDrillTool))

  return (
    <FormShell title={editOp ? 'Edit Drill' : 'New Drill Operation'} onClose={handleClose}>
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
                  : 'bg-gray-50 dark:bg-neutral-900 border-gray-300 dark:border-neutral-700 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200',
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
              {editOp.points.length} stored point{editOp.points.length !== 1 ? 's' : ''}
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
          ) : (
            <p className="text-label text-gray-400 dark:text-neutral-500">Click on the canvas to place drill points.</p>
          )}
          {isNonDrillTool && (
            <p className="text-label text-amber-400 mt-1 flex items-center gap-1">
              <AlertCircle size={ICON.xs} /> Peck drilling with an end mill — ensure the tool is suitable.
            </p>
          )}
        </div>
      )}

      {/* Helical: list all selected circles */}
      {form.drillMode === 'helical' && (
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
            Source Circles {!editOp && selectedCircles.length > 1 && <span className="normal-case text-gray-500 dark:text-neutral-400">({selectedCircles.length} selected — one operation each)</span>}
          </label>
          {editOp && editHelicalInfo ? (
            <div className="text-body text-gray-800 dark:text-neutral-200 bg-gray-100 dark:bg-neutral-800 rounded px-2 py-1 space-y-0.5">
              <div>Center: ({editHelicalInfo.cx.toFixed(1)}, {editHelicalInfo.cy.toFixed(1)}) mm</div>
              <div>Tool path Ø: {(editHelicalInfo.radius * 2).toFixed(2)} mm</div>
            </div>
          ) : selectedCircles.length > 0 ? (
            <div className="space-y-0.5">
              {selectedCircles.map(({ path, circle }) => {
                const r = Math.max(0, circle.radiusMM - (selectedTool?.diameterMM ?? 0) / 2)
                return (
                  <div key={path.id} className="text-body text-gray-800 dark:text-neutral-200 bg-gray-100 dark:bg-neutral-800 rounded px-2 py-1">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: path.color }} />
                      {path.name}
                    </div>
                    <div className="text-gray-500 dark:text-neutral-400 text-label mt-0.5">
                      Hole Ø {(circle.radiusMM * 2).toFixed(2)} mm
                      {r > 0 ? ` · Tool path Ø ${(r * 2).toFixed(2)} mm` : ' · center-drill (tool wider than hole)'}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-body text-amber-400 flex items-center gap-1">
              <AlertCircle size={ICON.sm} /> Select one or more circular paths first
            </p>
          )}
          {isDrillTool && (
            <p className="text-label text-amber-400 mt-1 flex items-center gap-1">
              <AlertCircle size={ICON.xs} /> Drill bits cannot do helical drilling — use an end mill.
            </p>
          )}
        </div>
      )}

      <ToolSelector tools={tools} value={form.toolId} onChange={handleToolChange} />
      <DepthRow depthMM={form.depthMM} stepDownMM={form.stepDownMM}
        onDepth={(v) => up('depthMM', v)} onStep={(v) => up('stepDownMM', v)}
        maxDepthMM={selectedTool?.maxDepthMM} tool={selectedTool} />
      <GenerateBtn
        disabled={!canGenerate}
        generating={generating}
        onClick={handleGenerate}
        label={editOp ? 'Regenerate Toolpath' : 'Generate Toolpath'}
      />
    </FormShell>
  )
}
