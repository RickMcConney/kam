// ─── Pattern form ─────────────────────────────────────────────────────────────
import { FormShell, PathChip, ToggleRow, GenerateBtn } from './shared'
import { useState } from 'react'
import { NumericInput } from '../../components/NumericInput'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useWorkpieceStore, fromMM, toMM } from '../../store/workpieceStore'
import { computePatternInstances, applyPatternInstance } from '../../tools/patternOp'
import { uid } from '../../uid'

interface PatternLinParams { rows: number; cols: number; xSpacingMM: number; ySpacingMM: number }
interface PatternCirParams { count: number; radiusMM: number; startAngleDeg: number; endAngleDeg: number; rotateItems: boolean }
interface PatternFormState {
  mode: 'linear' | 'circular'
  linParams: PatternLinParams
  cirParams: PatternCirParams
}

export function PatternForm({ onClose }: { onClose: () => void }) {
  const { paths, selectedIds, addPaths, pushHistoryBoth } = usePathsStore()
  const { load, save } = useFormDefaultsStore()
  const { units } = useWorkpieceStore()

  const [form, setForm] = useState<PatternFormState>(() => {
    const saved = load('pattern') as Partial<PatternFormState> | null
    return {
      mode: saved?.mode ?? 'linear',
      linParams: saved?.linParams ?? { rows: 2, cols: 3, xSpacingMM: 20, ySpacingMM: 20 },
      cirParams: saved?.cirParams ?? { count: 6, radiusMM: 30, startAngleDeg: 0, endAngleDeg: 360, rotateItems: true },
    }
  })
  const [error, setError] = useState<string | null>(null)

  const selectedPaths = paths.filter((p) => selectedIds.includes(p.id))
  const canApply = selectedPaths.length >= 1

  function upLin<K extends keyof PatternLinParams>(k: K, v: PatternLinParams[K]) {
    setForm((f) => ({ ...f, linParams: { ...f.linParams, [k]: v } }))
  }
  function upCir<K extends keyof PatternCirParams>(k: K, v: PatternCirParams[K]) {
    setForm((f) => ({ ...f, cirParams: { ...f.cirParams, [k]: v } }))
  }

  function handleApply() {
    setError(null)
    const params = form.mode === 'linear'
      ? { type: 'linear' as const, ...form.linParams }
      : { type: 'circular' as const, ...form.cirParams }
    const instances = computePatternInstances(params)
    if (instances.length === 0) { setError('Pattern produced no instances'); return }
    const instancesToCreate = form.mode === 'linear' ? instances.slice(1) : instances
    const newPaths: Parameters<typeof addPaths>[0] = []
    for (const inst of instancesToCreate) {
      for (const src of selectedPaths) {
        newPaths.push({
          id: uid('path-pattern'),
          name: `${src.name} ${inst.index !== undefined ? inst.index + 1 : `r${inst.row}c${inst.col}`}`,
          d: applyPatternInstance(src.d, inst),
          visible: true,
          color: src.color,
        })
      }
    }
    if (newPaths.length === 0) { setError('Pattern produced no geometry'); return }
    pushHistoryBoth()
    addPaths(newPaths)
    save('pattern', form)
  }

  const inputCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0'
  const u = units

  return (
    <FormShell title="Pattern" onClose={onClose}>
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Paths</label>
        {canApply ? (
          <div className="space-y-0.5">
            {selectedPaths.map((p) => <PathChip key={p.id} path={p} label="selected" />)}
          </div>
        ) : (
          <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> Select a path first</p>
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
      <GenerateBtn disabled={!canApply} generating={false} onClick={handleApply} label="Apply Pattern" />
    </FormShell>
  )
}
