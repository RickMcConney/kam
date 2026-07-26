// ─── Pattern form ─────────────────────────────────────────────────────────────
import { FormShell, PathChip, ToggleRow, GenerateBtn } from './shared'
import { useState } from 'react'
import { NumericInput } from '../../components/NumericInput'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore, type ImportedPath } from '../../store/pathsStore'
import { useSelectedPaths } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import { useTimelineStore } from '../../timeline/timelineStore'
import { regenerateAffectedMany } from '../../cam/regenerate'
import { useWorkpieceStore, fromMM, toMM } from '../../store/workpieceStore'
import { computePatternInstances, applyPatternInstance, type PatternParams } from '../../tools/patternOp'
import { uid } from '../../uid'

interface PatternLinParams { rows: number; cols: number; xSpacingMM: number; ySpacingMM: number }
interface PatternCirParams { count: number; radiusMM: number; startAngleDeg: number; endAngleDeg: number; rotateItems: boolean }
interface PatternFormState {
  mode: 'linear' | 'circular'
  linParams: PatternLinParams
  cirParams: PatternCirParams
}

// Edit mode (timeline pattern-chip click): recompute the pattern from its
// recorded sources with new parameters, amending the chip. Result path ids
// are reused index-by-index so ops on existing copies survive count changes
// where possible.
export interface PatternEditCtx {
  eventId: string
  resultIds: string[]
  sourceIds: string[]
  params: PatternParams
}

export function PatternForm({ onClose, editCtx }: { onClose: () => void; editCtx?: PatternEditCtx }) {
  const { paths, addPaths } = usePathsStore()
  const selPaths = useSelectedPaths()
  const { load, save } = useFormDefaultsStore()
  const { units } = useWorkpieceStore()

  const [form, setForm] = useState<PatternFormState>(() => {
    const saved = load('pattern') as Partial<PatternFormState> | null
    const base: PatternFormState = {
      mode: saved?.mode ?? 'linear',
      linParams: saved?.linParams ?? { rows: 2, cols: 3, xSpacingMM: 20, ySpacingMM: 20 },
      cirParams: saved?.cirParams ?? { count: 6, radiusMM: 30, startAngleDeg: 0, endAngleDeg: 360, rotateItems: true },
    }
    if (editCtx) {
      const p = editCtx.params
      if (p.type === 'linear') {
        return { ...base, mode: 'linear', linParams: { rows: p.rows, cols: p.cols, xSpacingMM: p.xSpacingMM, ySpacingMM: p.ySpacingMM } }
      }
      return { ...base, mode: 'circular', cirParams: { count: p.count, radiusMM: p.radiusMM, startAngleDeg: p.startAngleDeg, endAngleDeg: p.endAngleDeg, rotateItems: p.rotateItems } }
    }
    return base
  })
  const [error, setError] = useState<string | null>(null)

  const selectedPaths = editCtx
    ? editCtx.sourceIds.flatMap((id) => { const p = paths.find((x) => x.id === id); return p ? [p] : [] })
    : selPaths
  const canApply = selectedPaths.length >= 1

  function upLin<K extends keyof PatternLinParams>(k: K, v: PatternLinParams[K]) {
    setForm((f) => ({ ...f, linParams: { ...f.linParams, [k]: v } }))
  }
  function upCir<K extends keyof PatternCirParams>(k: K, v: PatternCirParams[K]) {
    setForm((f) => ({ ...f, cirParams: { ...f.cirParams, [k]: v } }))
  }

  function handleApply() {
    setError(null)
    const params: PatternParams = form.mode === 'linear'
      ? { type: 'linear' as const, ...form.linParams }
      : { type: 'circular' as const, ...form.cirParams }
    const instances = computePatternInstances(params)
    if (instances.length === 0) { setError('Pattern produced no instances'); return }
    const instancesToCreate = form.mode === 'linear' ? instances.slice(1) : instances
    const defs: { name: string; d: string; color: string }[] = []
    for (const inst of instancesToCreate) {
      for (const src of selectedPaths) {
        defs.push({
          name: `${src.name} ${inst.index !== undefined ? inst.index + 1 : `r${inst.row}c${inst.col}`}`,
          d: applyPatternInstance(src.d, inst),
          color: src.color,
        })
      }
    }
    if (defs.length === 0) { setError('Pattern produced no geometry'); return }

    if (editCtx) {
      // Rework in place: reuse existing result ids by index (ops on surviving
      // copies keep working), add/remove for count changes, amend the chip.
      const tl = useTimelineStore.getState()
      const ev = tl.events.find((e) => e.id === editCtx.eventId)
      const oldPaths = ev?.kind === 'paths.add' ? ev.paths : []
      const newPaths: ImportedPath[] = defs.map((def, i) => oldPaths[i]
        ? { ...oldPaths[i], d: def.d, name: def.name }
        : { id: uid('path-pattern'), name: def.name, d: def.d, visible: true, color: def.color })
      const deleteIds = oldPaths.slice(defs.length).map((p) => p.id)
      usePathsStore.getState().rewriteGeneratedRaw({
        updates: newPaths.slice(0, Math.min(oldPaths.length, defs.length)).map((p) => ({ id: p.id, d: p.d, name: p.name })),
        add: newPaths.slice(oldPaths.length),
        deleteIds,
      })
      tl.amendAddEvent(editCtx.eventId, {
        paths: newPaths,
        pattern: { sourceIds: editCtx.sourceIds, params },
      })
      usePathsStore.getState().setSelectedIds(newPaths.map((p) => p.id))
      regenerateAffectedMany(newPaths.map((p) => p.id))
      useUIStore.getState().showStatus('Pattern updated', 'info')
      save('pattern', form)
      return
    }

    const newPaths: ImportedPath[] = defs.map((def) => ({
      id: uid('path-pattern'),
      name: def.name,
      d: def.d,
      visible: true,
      color: def.color,
    }))
    addPaths(newPaths, {
      source: 'pattern',
      pattern: { sourceIds: selectedPaths.map((p) => p.id), params },
    })
    save('pattern', form)
  }

  const inputCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0'
  const u = units

  return (
    <FormShell title={editCtx ? 'Edit Pattern' : 'Pattern'} onClose={onClose}>
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          {editCtx ? 'Source paths' : 'Paths'}
        </label>
        {canApply ? (
          <div className="space-y-0.5">
            {selectedPaths.map((p) => <PathChip key={p.id} path={p} label={editCtx ? 'source' : 'selected'} />)}
          </div>
        ) : (
          <p className="text-body text-amber-400 flex items-center gap-1">
            <AlertCircle size={ICON.sm} /> {editCtx ? 'Source paths no longer exist' : 'Select a path first'}
          </p>
        )}
      </div>
      <ToggleRow label="Mode" options={['linear', 'circular'] as const} value={form.mode} onChange={(v) => setForm((f) => ({ ...f, mode: v }))} />
      {form.mode === 'linear' ? (
        <div className="grid grid-cols-2 gap-2">
          {([
            ['Rows', form.linParams.rows, (v: number) => upLin('rows', Math.max(1, Math.round(v))), 1, 1, ''],
            ['Cols', form.linParams.cols, (v: number) => upLin('cols', Math.max(1, Math.round(v))), 1, 1, ''],
            ['X Gap', fromMM(form.linParams.xSpacingMM, u as 'mm' | 'in'), (v: number) => upLin('xSpacingMM', toMM(v, u as 'mm' | 'in')), 0, u === 'in' ? 0.0625 : 1, u],
            ['Y Gap', fromMM(form.linParams.ySpacingMM, u as 'mm' | 'in'), (v: number) => upLin('ySpacingMM', toMM(v, u as 'mm' | 'in')), 0, u === 'in' ? 0.0625 : 1, u],
          ] as [string, number, (v: number) => void, number, number, string][]).map(([lbl, val, fn, min, step, suffix]) => (
            <div key={lbl}>
              <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">{lbl}</label>
              <div className="flex items-center gap-1">
                <NumericInput value={val} min={min} step={step}
                  onChange={fn}
                  className={inputCls} />
                {suffix && <span className="text-label text-gray-400 dark:text-neutral-500">{suffix}</span>}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            {([
              ['Count', form.cirParams.count, (v: number) => upCir('count', Math.max(2, Math.round(v))), 2, 1, ''],
              ['Radius', fromMM(form.cirParams.radiusMM, u as 'mm' | 'in'), (v: number) => upCir('radiusMM', toMM(v, u as 'mm' | 'in')), 0.1, u === 'in' ? 0.0625 : 1, u],
              ['Start°', form.cirParams.startAngleDeg, (v: number) => upCir('startAngleDeg', v), -360, 5, '°'],
              ['End°',   form.cirParams.endAngleDeg,   (v: number) => upCir('endAngleDeg', v),   -360, 5, '°'],
            ] as [string, number, (v: number) => void, number, number, string][]).map(([lbl, val, fn, min, step, suffix]) => (
              <div key={lbl}>
                <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">{lbl}</label>
                <div className="flex items-center gap-1">
                  <NumericInput value={val} min={min} step={step}
                    onChange={fn}
                    className={inputCls} />
                  {suffix && <span className="text-label text-gray-400 dark:text-neutral-500">{suffix}</span>}
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="pattern-rotate" checked={form.cirParams.rotateItems}
              onChange={(e) => upCir('rotateItems', e.target.checked)} className="accent-blue-500" />
            <label htmlFor="pattern-rotate" className="text-body text-gray-700 dark:text-neutral-300 cursor-pointer">Items face outward</label>
          </div>
        </div>
      )}
      {error && <p className="text-body text-red-400 flex items-start gap-1.5"><AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{error}</p>}
      <GenerateBtn disabled={!canApply} generating={false} onClick={handleApply} label={editCtx ? 'Update Pattern' : 'Apply Pattern'} />
    </FormShell>
  )
}
