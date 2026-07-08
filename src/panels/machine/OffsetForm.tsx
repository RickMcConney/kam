// ─── Offset form ──────────────────────────────────────────────────────────────
import { FormShell, PathChip, ToggleRow, GenerateBtn } from './shared'
import { useState } from 'react'
import { NumericInput } from '../../components/NumericInput'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useWorkpieceStore, fromMM, toMM } from '../../store/workpieceStore'
import { applyOffset, type OffsetCornerStyle } from '../../tools/offsetOp'
import { nextPathColor } from '../../importers/svgImporter'
import { uid } from '../../uid'

interface OffsetFormState {
  distanceMM: number
  cornerStyle: OffsetCornerStyle
}

export function OffsetForm({ onClose }: { onClose: () => void }) {
  const { paths, selectedIds, addPaths, pushHistoryBoth } = usePathsStore()
  const { load, save } = useFormDefaultsStore()
  const { units } = useWorkpieceStore()

  const [form, setForm] = useState<OffsetFormState>(() => {
    const saved = load('offset') as { distanceMM?: number; cornerStyle?: OffsetCornerStyle } | null
    return {
      distanceMM: saved?.distanceMM ?? 5,
      cornerStyle: saved?.cornerStyle ?? 'miter',
    }
  })
  const [error, setError] = useState<string | null>(null)

  const selectedPaths = paths.filter((p) => selectedIds.includes(p.id))
  const canApply = selectedPaths.length >= 1

  function up<K extends keyof OffsetFormState>(k: K, v: OffsetFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleApply() {
    setError(null)
    const newPaths = selectedPaths.map((p) => {
      const resultD = applyOffset(p.d, { distanceMM: form.distanceMM, cornerStyle: form.cornerStyle })
      if (!resultD) return null
      return {
        id: uid('path-offset'),
        name: `${p.name} offset`,
        d: resultD,
        visible: true,
        color: nextPathColor(),
      }
    }).filter(Boolean) as Parameters<typeof addPaths>[0]
    if (newPaths.length === 0) { setError('Offset produced no geometry'); return }
    pushHistoryBoth()
    addPaths(newPaths)
    usePathsStore.getState().setSelectedIds(newPaths.map((p) => p.id))
    save('offset', form)
  }

  const inputCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0'

  return (
    <FormShell title="Offset Path" onClose={onClose}>
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
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Distance</label>
        <div className="flex items-center gap-1">
          <NumericInput
            value={fromMM(form.distanceMM, units as 'mm' | 'in')}
            step={units === 'in' ? 0.0625 : 0.5}
            onChange={(v) => up('distanceMM', toMM(v, units as 'mm' | 'in'))}
            className={inputCls}
          />
          <span className="text-label text-gray-400 dark:text-neutral-500">{units}</span>
        </div>
        <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">Positive = outset, negative = inset</p>
      </div>
      <ToggleRow label="Corner Style" options={['miter', 'round', 'square'] as OffsetCornerStyle[]} value={form.cornerStyle} onChange={(v) => up('cornerStyle', v)} />
      {error && <p className="text-body text-red-400 flex items-start gap-1.5"><AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{error}</p>}
      <GenerateBtn disabled={!canApply} generating={false} onClick={handleApply} label="Apply Offset" />
    </FormShell>
  )
}
