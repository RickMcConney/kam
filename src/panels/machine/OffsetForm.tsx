// ─── Offset form ──────────────────────────────────────────────────────────────
import { FormShell, PathChip, ToggleRow, GenerateBtn, LengthInput } from './shared'
import { useState } from 'react'
import { ICON } from '../../theme'
import { AlertCircle } from 'lucide-react'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore, type ImportedPath } from '../../store/pathsStore'
import { useSelectedPaths } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import { useTimelineStore } from '../../timeline/timelineStore'
import { regenerateAffectedMany } from '../../cam/regenerate'
import { applyOffset, type OffsetCornerStyle } from '../../tools/offsetOp'
import { nextPathColor } from '../../importers/svgImporter'
import { uid } from '../../uid'

interface OffsetFormState {
  distanceMM: number
  cornerStyle: OffsetCornerStyle
}

// Edit mode (timeline offset-chip click): recompute the SAME offset paths
// from their recorded sources with new parameters, amending the chip.
export interface OffsetEditCtx {
  eventId: string
  pairs: { sourceId: string; resultId: string }[]
  distanceMM: number
  cornerStyle: OffsetCornerStyle
}

export function OffsetForm({ onClose, editCtx }: { onClose: () => void; editCtx?: OffsetEditCtx }) {
  const { paths, addPaths } = usePathsStore()
  const selPaths = useSelectedPaths()
  const { load, save } = useFormDefaultsStore()

  const [form, setForm] = useState<OffsetFormState>(() => {
    if (editCtx) return { distanceMM: editCtx.distanceMM, cornerStyle: editCtx.cornerStyle }
    const saved = load('offset') as { distanceMM?: number; cornerStyle?: OffsetCornerStyle } | null
    return {
      distanceMM: saved?.distanceMM ?? 5,
      cornerStyle: saved?.cornerStyle ?? 'miter',
    }
  })
  const [error, setError] = useState<string | null>(null)

  const livePairs = editCtx
    ? editCtx.pairs.filter((pair) =>
        paths.some((p) => p.id === pair.sourceId) && paths.some((p) => p.id === pair.resultId))
    : []
  const sourcePaths = editCtx
    ? livePairs.flatMap((pair) => { const p = paths.find((x) => x.id === pair.sourceId); return p ? [p] : [] })
    : selPaths
  const canApply = editCtx ? livePairs.length >= 1 : sourcePaths.length >= 1

  function up<K extends keyof OffsetFormState>(k: K, v: OffsetFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleApply() {
    setError(null)

    if (editCtx) {
      // Rework in place: recompute each result from its source, amend the chip.
      const updates: { id: string; d: string }[] = []
      for (const pair of livePairs) {
        const src = paths.find((p) => p.id === pair.sourceId)!
        const d = applyOffset(src.d, { distanceMM: form.distanceMM, cornerStyle: form.cornerStyle })
        if (!d) { setError(`Offset produced no geometry for ${src.name}`); return }
        updates.push({ id: pair.resultId, d })
      }
      usePathsStore.getState().rewriteGeneratedRaw({ updates })
      const tl = useTimelineStore.getState()
      const ev = tl.events.find((e) => e.id === editCtx.eventId)
      if (ev?.kind === 'paths.add') {
        const dById = new Map(updates.map((u) => [u.id, u.d]))
        tl.amendAddEvent(editCtx.eventId, {
          paths: ev.paths.map((p) => dById.has(p.id) ? { ...p, d: dById.get(p.id)! } : p),
          offset: { pairs: editCtx.pairs, distanceMM: form.distanceMM, cornerStyle: form.cornerStyle },
        })
      }
      regenerateAffectedMany(updates.map((u) => u.id))
      useUIStore.getState().showStatus('Offset updated', 'info')
      save('offset', form)
      return
    }

    const pairs: { sourceId: string; resultId: string }[] = []
    const newPaths: ImportedPath[] = []
    for (const p of sourcePaths) {
      const resultD = applyOffset(p.d, { distanceMM: form.distanceMM, cornerStyle: form.cornerStyle })
      if (!resultD) continue
      const id = uid('path-offset')
      pairs.push({ sourceId: p.id, resultId: id })
      newPaths.push({ id, name: `${p.name} offset`, d: resultD, visible: true, color: nextPathColor() })
    }
    if (newPaths.length === 0) { setError('Offset produced no geometry'); return }
    addPaths(newPaths, {
      source: 'offset',
      offset: { pairs, distanceMM: form.distanceMM, cornerStyle: form.cornerStyle },
    })
    usePathsStore.getState().setSelectedIds(newPaths.map((p) => p.id))
    save('offset', form)
  }

  const inputCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0'

  return (
    <FormShell title={editCtx ? 'Edit Offset' : 'Offset'} onClose={onClose}>
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
          {editCtx ? 'Source paths' : 'Paths'}
        </label>
        {canApply ? (
          <div className="space-y-0.5">
            {sourcePaths.map((p) => <PathChip key={p.id} path={p} label={editCtx ? 'source' : 'selected'} />)}
          </div>
        ) : (
          <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1">
            <AlertCircle size={ICON.sm} /> {editCtx ? 'Source or result paths no longer exist' : 'Select a path first'}
          </p>
        )}
      </div>
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Distance</label>
        <LengthInput valueMM={form.distanceMM} stepMM={0.5}
          onChangeMM={(v) => up('distanceMM', v)} className={inputCls} />
        <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">Positive = outset, negative = inset</p>
      </div>
      <ToggleRow label="Corner Style" options={['miter', 'round', 'square'] as OffsetCornerStyle[]} value={form.cornerStyle} onChange={(v) => up('cornerStyle', v)} />
      {error && <p className="text-body text-red-600 dark:text-red-400 flex items-start gap-1.5"><AlertCircle size={ICON.sm} className="mt-0.5 shrink-0" />{error}</p>}
      <GenerateBtn disabled={!canApply} generating={false} onClick={handleApply} label={editCtx ? 'Update Offset' : 'Apply Offset'} />
    </FormShell>
  )
}
