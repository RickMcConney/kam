import { useState } from 'react'
import { ICON } from '../theme'
import { Eye, EyeOff, Trash2, Layers, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { usePathsStore } from '../store/pathsStore'
import { useToolpathStore } from '../store/toolpathStore'
import type { AnyOperation } from '../store/toolpathStore'
import { ProfileForm, PocketForm, DrillForm, SurfaceForm, VCarveForm, InlayForm } from './MachinePanel'

const STATUS_ICON = {
  pending: <span className="w-1.5 h-1.5 rounded-full bg-gray-300 dark:bg-neutral-600 flex-shrink-0" />,
  generating: <Loader2 size={ICON.xs} className="animate-spin text-blue-400 flex-shrink-0" />,
  done: <CheckCircle2 size={ICON.xs} className="text-green-400 flex-shrink-0" />,
  'needs-update': <AlertCircle size={ICON.xs} className="text-amber-400 flex-shrink-0" />,
  error: <AlertCircle size={ICON.xs} className="text-red-400 flex-shrink-0" />,
}

function OperationEditForm({ op, onClose }: { op: AnyOperation; onClose: () => void }) {
  if (op.type === 'profile') return <ProfileForm onClose={onClose} editOp={op} />
  if (op.type === 'pocket') return <PocketForm onClose={onClose} editOp={op} />
  if (op.type === 'drill') return <DrillForm onClose={onClose} editOp={op} />
  if (op.type === 'surface') return <SurfaceForm onClose={onClose} editOp={op} />
  if (op.type === 'vcarve') return <VCarveForm onClose={onClose} editOp={op} />
  if (op.type === 'inlay') return <InlayForm onClose={onClose} editOp={op} />
  return null
}

export default function PathsPanel() {
  const { paths, selectedIds, selectPath, toggleVisibility, deletePath, pushHistoryBoth } = usePathsStore()
  const { operations, toggleVisibility: toggleOpVisibility, deleteOperation } = useToolpathStore()
  const [editingOpId, setEditingOpId] = useState<string | null>(null)

  const editingOp = operations.find((o) => o.id === editingOpId) ?? null

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Path list */}
      <p className="px-3 pt-2 pb-1 text-label font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider">Paths</p>
      {paths.length === 0 ? (
        <div className="px-3 py-6 text-body text-gray-400 dark:text-neutral-500 text-center">
          <Layers size={ICON.lg} className="mx-auto mb-2 opacity-30" />
          No paths yet. Use the Import button in the toolbar.
        </div>
      ) : (
        <ul className="px-2 pb-2 space-y-0.5">
          {paths.map((p) => (
            <li
              key={p.id}
              className={[
                'flex items-center gap-1.5 px-2 py-1.5 rounded cursor-pointer group',
                selectedIds.includes(p.id) ? 'bg-blue-600/20 text-blue-300' : 'hover:bg-gray-200/50 dark:hover:bg-neutral-700/50',
              ].join(' ')}
              onClick={(e) => selectPath(selectedIds.includes(p.id) && selectedIds.length === 1 ? null : p.id, e.shiftKey)}
            >
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
              <span className="flex-1 text-body truncate text-gray-800 dark:text-neutral-200">{p.name}</span>
              <button
                title={p.visible ? 'Hide path' : 'Show path'}
                onClick={(e) => { e.stopPropagation(); toggleVisibility(p.id) }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 transition-opacity"
              >
                {p.visible ? <Eye size={ICON.sm} /> : <EyeOff size={ICON.sm} />}
              </button>
              <button
                title="Delete path"
                onClick={(e) => { e.stopPropagation(); deletePath(p.id) }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-900/40 text-gray-500 dark:text-neutral-400 hover:text-red-400 transition-opacity"
              >
                <Trash2 size={ICON.sm} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Toolpaths section */}
      {operations.length > 0 && (
        <div className="border-t border-gray-300 dark:border-neutral-700 mt-1">
          <p className="px-3 py-1.5 text-label font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider">Toolpaths</p>
          <ul className="px-2 pb-1 space-y-0.5">
            {operations.map((op) => (
              <li
                key={op.id}
                className={[
                  'flex items-center gap-1.5 px-2 py-1.5 rounded cursor-pointer group',
                  op.id === editingOpId
                    ? 'bg-blue-600/20 text-blue-300'
                    : 'hover:bg-gray-200/50 dark:hover:bg-neutral-700/50',
                ].join(' ')}
                onClick={() => setEditingOpId(op.id === editingOpId ? null : op.id)}
              >
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: op.color }} />
                {STATUS_ICON[op.status]}
                <span className="flex-1 text-body truncate text-gray-700 dark:text-neutral-300" title={op.name}>{op.name}</span>
                <button
                  title={op.visible ? 'Hide' : 'Show'}
                  onClick={(e) => { e.stopPropagation(); toggleOpVisibility(op.id) }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 transition-opacity"
                >
                  {op.visible ? <Eye size={ICON.sm} /> : <EyeOff size={ICON.sm} />}
                </button>
                <button
                  title="Delete"
                  onClick={(e) => { e.stopPropagation(); pushHistoryBoth(); deleteOperation(op.id); if (op.id === editingOpId) setEditingOpId(null) }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-900/40 text-gray-500 dark:text-neutral-400 hover:text-red-400 transition-opacity"
                >
                  <Trash2 size={ICON.sm} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Inline operation editor */}
      {editingOp && (
        <OperationEditForm op={editingOp} onClose={() => setEditingOpId(null)} />
      )}
    </div>
  )
}
