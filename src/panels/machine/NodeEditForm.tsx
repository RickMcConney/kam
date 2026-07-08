// ─── Node Edit / Corner Treatment form ───────────────────────────────────────
import { FormShell, PathChip } from './shared'
import { useState, useEffect } from 'react'
import { NumericInput } from '../../components/NumericInput'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { applyCornerTreatment, type CornerTreatmentType } from '../../tools/cornerTreatment'
import { regenerateAffected } from '../../cam/regenerate'
import { useUIStore } from '../../store/uiStore'

interface NodeEditFormState {
  treatmentType: CornerTreatmentType
  radiusMM: number
}

const CORNER_TREATMENTS: { type: CornerTreatmentType; label: string; desc: string; preview: string }[] = [
  { type: 'outerRound', label: 'Outer Round', desc: 'Arc rounding the outside of the corner', preview: '╮' },
  { type: 'innerRound', label: 'Inner Round', desc: 'Concave arc curving into the corner (fillet)', preview: '⌒' },
  { type: 'chamfer',    label: 'Chamfer',     desc: 'Straight bevel cut across the corner', preview: '╱' },
  { type: 'dogbone',    label: 'Dogbone',     desc: 'Circular notch for CNC internal corners', preview: '⦿' },
]

export function NodeEditForm({ onClose }: { onClose: () => void }) {
  const { paths, selectedIds, batchUpdatePaths, pushHistoryBoth } = usePathsStore()
  const { setNodeEditPathId } = useUIStore()
  const { load, save } = useFormDefaultsStore()

  const [form, setForm] = useState<NodeEditFormState>(() => {
    const saved = load('nodeedit') as NodeEditFormState | null
    return {
      treatmentType: (saved?.treatmentType ?? 'chamfer') as CornerTreatmentType,
      radiusMM: saved?.radiusMM ?? 2,
    }
  })

  // Clear any active node-edit overlay when this panel closes
  useEffect(() => () => { setNodeEditPathId(null) }, [])

  const selectedPaths = paths.filter((p) => selectedIds.includes(p.id))
  const activePath = selectedPaths.length === 1 ? selectedPaths[0] : null

  function handleApply() {
    if (!activePath) return
    pushHistoryBoth()
    const newD = applyCornerTreatment(activePath.d, { type: form.treatmentType, radiusMM: form.radiusMM })
    if (newD === activePath.d) return
    batchUpdatePaths([{ id: activePath.id, d: newD, shapeParams: null }])
    regenerateAffected(activePath.id)
    save('nodeedit', form)
  }

  function up<K extends keyof NodeEditFormState>(k: K, v: NodeEditFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  return (
    <FormShell title="Corner Treatment" onClose={onClose}>
      {/* Selected path */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Path</label>
        {activePath ? (
          <PathChip path={activePath} label="selected" />
        ) : (
          <p className="text-body text-amber-400 flex items-center gap-1">
            <AlertCircle size={ICON.sm} /> Select exactly one path on canvas
          </p>
        )}
      </div>

      {/* Corner treatment section */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Corner Treatment</label>
        <div className="grid grid-cols-2 gap-1">
          {CORNER_TREATMENTS.map(({ type, label, desc }) => (
            <button
              key={type}
              title={desc}
              onClick={() => up('treatmentType', type)}
              className={[
                'py-1.5 px-2 rounded border text-body text-left transition-colors',
                form.treatmentType === type
                  ? 'border-blue-500 bg-blue-500/20 text-blue-300'
                  : 'border-gray-200 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:border-gray-300 dark:hover:border-neutral-500',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Radius */}
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          {form.treatmentType === 'dogbone' ? 'Tool Radius' : 'Radius'} (mm)
        </label>
        <NumericInput
          value={form.radiusMM}
          min={0.01}
          step={0.5}
          onChange={(v) => up('radiusMM', v)}
          className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 font-mono focus:outline-none focus:border-blue-500"
        />
        <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">
          Applied to all sharp corner nodes. Use Undo to revert.
        </p>
      </div>

      <button
        disabled={!activePath}
        onClick={handleApply}
        className="w-full py-1.5 rounded text-body font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-blue-600 hover:bg-blue-500 text-white"
      >
        Apply to All Corners
      </button>
    </FormShell>
  )
}
