// ─── Tabs form ────────────────────────────────────────────────────────────────
import { FormShell, PathChip, GenerateBtn } from './shared'
import { useState } from 'react'
import { NumericInput } from '../../components/NumericInput'
import { ICON } from '../../theme'
import { AlertCircle, Trash2 } from 'lucide-react'
import { useFormDefaultsStore } from '../../store/formDefaultsStore'
import { usePathsStore } from '../../store/pathsStore'
import { useWorkpieceStore, fromMM, toMM } from '../../store/workpieceStore'
import { useTabStore } from '../../store/tabStore'
import { regenerateAffected } from '../../cam/regenerate'

interface TabsFormState {
  count: number
  lengthMM: number
  heightMM: number
}

export function TabsForm({ onClose }: { onClose: () => void }) {
  const { paths, selectedIds } = usePathsStore()
  const { tabs, applyTabs, deleteTab, deletePathTabs } = useTabStore()
  const { load, save } = useFormDefaultsStore()
  const { units } = useWorkpieceStore()

  const [form, setForm] = useState<TabsFormState>(() => {
    const saved = load('tabs') as { count?: number; lengthMM?: number; heightMM?: number } | null
    return {
      count: saved?.count ?? 4,
      lengthMM: saved?.lengthMM ?? 5,
      heightMM: saved?.heightMM ?? 2,
    }
  })

  const singlePath = selectedIds.length === 1 ? paths.find((p) => p.id === selectedIds[0]) ?? null : null
  const pathTabs = singlePath ? tabs.filter((t) => t.pathId === singlePath.id) : []

  function up<K extends keyof TabsFormState>(k: K, v: TabsFormState[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  function handleApply() {
    if (!singlePath) return
    applyTabs(singlePath.id, form.count, singlePath.d, form.lengthMM, form.heightMM)
    regenerateAffected(singlePath.id)
    save('tabs', form)
  }

  function handleDelete(id: string) {
    deleteTab(id)
    if (singlePath) regenerateAffected(singlePath.id)
  }

  function handleClearAll() {
    if (!singlePath) return
    deletePathTabs(singlePath.id)
    regenerateAffected(singlePath.id)
  }

  const inputCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0'
  const u = units

  return (
    <FormShell title="Holding Tabs" onClose={onClose}>
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Path</label>
        {singlePath ? (
          <PathChip path={singlePath} label="selected" />
        ) : (
          <p className="text-body text-amber-400 flex items-center gap-1"><AlertCircle size={ICON.sm} /> Select a single path on the canvas first</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Count</label>
          <NumericInput value={form.count} min={1} max={20} step={1} integer
            onChange={(v) => up('count', v)}
            className={inputCls} />
        </div>
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Height</label>
          <div className="flex items-center gap-1">
            <NumericInput value={fromMM(form.heightMM, u as 'mm' | 'in')} min={0.1} step={u === 'in' ? 0.0625 : 0.5}
              onChange={(v) => up('heightMM', toMM(v, u as 'mm' | 'in'))}
              className={inputCls} />
            <span className="text-label text-gray-400 dark:text-neutral-500">{u}</span>
          </div>
        </div>
      </div>
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Length</label>
        <div className="flex items-center gap-1">
          <NumericInput value={fromMM(form.lengthMM, u as 'mm' | 'in')} min={0.5} step={u === 'in' ? 0.0625 : 1}
            onChange={(v) => up('lengthMM', toMM(v, u as 'mm' | 'in'))}
            className={inputCls} />
          <span className="text-label text-gray-400 dark:text-neutral-500">{u}</span>
        </div>
        <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">Tab width along the path edge</p>
      </div>
      <GenerateBtn disabled={!singlePath} generating={false} onClick={handleApply} label="Apply Tabs" />
      {pathTabs.length > 0 && (
        <div className="space-y-1">
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider">
            Current Tabs <span className="normal-case text-gray-500 dark:text-neutral-400">({pathTabs.length})</span>
          </label>
          {pathTabs.map((tab, i) => (
            <div key={tab.id} className="flex items-center gap-1.5 text-body text-gray-700 dark:text-neutral-300 bg-gray-50 dark:bg-neutral-900 rounded px-2 py-1">
              <span className="flex-1">Tab {i + 1} — {(tab.t * 100).toFixed(0)}% along path</span>
              <button onClick={() => handleDelete(tab.id)}
                className="p-0.5 rounded hover:bg-red-900/40 text-gray-400 dark:text-neutral-500 hover:text-red-400 transition-colors flex-shrink-0">
                <Trash2 size={ICON.xs} />
              </button>
            </div>
          ))}
          <button onClick={handleClearAll}
            className="w-full py-1 rounded text-label border border-gray-200 dark:border-neutral-600 text-gray-400 dark:text-neutral-500 hover:text-red-400 hover:border-red-400 transition-colors">
            Clear All Tabs
          </button>
        </div>
      )}
    </FormShell>
  )
}
