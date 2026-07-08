// ─── Boolean form ────────────────────────────────────────────────────────────
import { FormShell, PathChip, ToggleRow, GenerateBtn } from './shared'
import { useState } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { applyBooleanOp, type BooleanOpType } from '../../tools/booleanOps'
import { nextPathColor } from '../../importers/svgImporter'
import { uid } from '../../uid'

interface BooleanFormState {
  opType: BooleanOpType
}

export function BooleanForm({ onClose }: { onClose: () => void }) {
  const { paths, selectedIds, addPaths, hidePathIds, pushHistoryBoth } = usePathsStore()
  const { load, save } = useFormDefaultsStore()

  const [form, setForm] = useState<BooleanFormState>(() => {
    const saved = load('boolean') as { opType?: BooleanOpType } | null
    return { opType: saved?.opType ?? 'union' }
  })
  const [error, setError] = useState<string | null>(null)

  const selectedPaths = paths.filter((p) => selectedIds.includes(p.id))
  const canApply = selectedPaths.length >= 2

  function handleApply() {
    setError(null)
    const result = applyBooleanOp(form.opType, selectedPaths.map((p) => p.d))
    if ('error' in result) { setError(result.error); return }
    if (!result.resultD) { setError('Result is empty'); return }
    pushHistoryBoth()
    const label = form.opType.charAt(0).toUpperCase() + form.opType.slice(1)
    const newPath = {
      id: uid('path-bool'),
      name: `${label} result`,
      d: result.resultD,
      visible: true,
      color: nextPathColor(),
    }
    addPaths([newPath])
    hidePathIds(selectedIds)
    usePathsStore.getState().setSelectedIds([newPath.id])
    save('boolean', form)
  }

  return (
    <FormShell title="Boolean Operation" onClose={onClose}>
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          Paths {selectedPaths.length > 0 && <span className="normal-case text-gray-500 dark:text-neutral-400">({selectedPaths.length} selected)</span>}
        </label>
        {canApply ? (
          <div className="space-y-0.5">
            {selectedPaths.map((p, i) => <PathChip key={p.id} path={p} label={i === 0 ? 'primary' : 'operand'} />)}
          </div>
        ) : (
          <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> Select 2+ paths on the canvas first</p>
        )}
      </div>
      <ToggleRow label="Operation" options={['union', 'intersect', 'subtract'] as BooleanOpType[]} value={form.opType} onChange={(v) => setForm((f) => ({ ...f, opType: v }))} />
      {error && <p className="text-body text-red-400 flex items-start gap-1.5"><AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{error}</p>}
      <GenerateBtn disabled={!canApply} generating={false} onClick={handleApply} label="Apply Boolean" />
    </FormShell>
  )
}
