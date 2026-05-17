import { useState } from 'react'
import { ICON } from '../theme'
import { Eye, EyeOff, Trash2, Layers, CheckCircle2, AlertCircle, Loader2, ChevronRight, ChevronDown, FolderOpen, Folder, ArrowUp, ArrowDown } from 'lucide-react'
import { usePathsStore } from '../store/pathsStore'
import { useToolpathStore } from '../store/toolpathStore'
import type { AnyOperation } from '../store/toolpathStore'
import { useToolStore } from '../store/toolStore'
import { OP_TYPE_COLORS } from '../colors'
import { ProfileForm, PocketForm, DrillForm, SurfaceForm, VCarveForm, InlayForm } from './MachinePanel'

const STATUS_ICON = {
  pending: <span className="w-1.5 h-1.5 rounded-full bg-gray-300 dark:bg-neutral-600 flex-shrink-0" />,
  generating: <Loader2 size={ICON.xs} className="animate-spin text-blue-400 flex-shrink-0" />,
  done: <CheckCircle2 size={ICON.xs} className="text-green-400 flex-shrink-0" />,
  'needs-update': <AlertCircle size={ICON.xs} className="text-amber-400 flex-shrink-0" />,
  error: <AlertCircle size={ICON.xs} className="text-red-400 flex-shrink-0" />,
}

const OP_TYPE_LABELS: Record<string, string> = {
  profile: 'Profile',
  pocket:  'Pocket',
  drill:   'Drill',
  surface: 'Surface',
  vcarve:  'V-Carve',
  inlay:   'Inlay',
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
  const {
    paths, selectedIds, collapsedGroups,
    selectPath, toggleVisibility, deletePath,
    toggleGroupVisibility, toggleGroupCollapsed, deleteGroup,
    pushHistoryBoth, showPath,
  } = usePathsStore()
  const { operations, toggleVisibility: toggleOpVisibility, deleteOperation, replaceOperations } = useToolpathStore()
  const toolsById = useToolStore((s) => Object.fromEntries(s.tools.map((t) => [t.id, t])))
  const [editingOpId, setEditingOpId] = useState<string | null>(null)
  const [collapsedOpGroups, setCollapsedOpGroups] = useState<Set<string>>(new Set())
  const [confirmDeleteGroupId, setConfirmDeleteGroupId] = useState<string | null>(null)

  const editingOp = operations.find((o) => o.id === editingOpId) ?? null

  function toggleOpGroup(toolId: string) {
    setCollapsedOpGroups((prev) => {
      const next = new Set(prev)
      if (next.has(toolId)) next.delete(toolId)
      else next.add(toolId)
      return next
    })
  }

  // Group operations by toolId, preserving first-occurrence order for G-code grouping
  const opGroupOrder: string[] = []
  const opGroupMap = new Map<string, AnyOperation[]>()
  for (const op of operations) {
    if (!opGroupMap.has(op.toolId)) {
      opGroupMap.set(op.toolId, [])
      opGroupOrder.push(op.toolId)
    }
    opGroupMap.get(op.toolId)!.push(op)
  }

  function moveGroup(toolId: string, dir: 'up' | 'down') {
    const idx = opGroupOrder.indexOf(toolId)
    const newIdx = dir === 'up' ? idx - 1 : idx + 1
    if (newIdx < 0 || newIdx >= opGroupOrder.length) return
    const newOrder = [...opGroupOrder]
    ;[newOrder[idx], newOrder[newIdx]] = [newOrder[newIdx], newOrder[idx]]
    replaceOperations(newOrder.flatMap((tid) => opGroupMap.get(tid)!))
  }

  function moveWithinGroup(opId: string, toolId: string, dir: 'up' | 'down') {
    const groupOps = [...(opGroupMap.get(toolId) ?? [])]
    const idx = groupOps.findIndex((o) => o.id === opId)
    const newIdx = dir === 'up' ? idx - 1 : idx + 1
    if (newIdx < 0 || newIdx >= groupOps.length) return
    ;[groupOps[idx], groupOps[newIdx]] = [groupOps[newIdx], groupOps[idx]]
    replaceOperations(opGroupOrder.flatMap((tid) => tid === toolId ? groupOps : opGroupMap.get(tid)!))
  }

  function toggleGroupVisible(toolId: string, groupOps: AnyOperation[]) {
    const allVisible = groupOps.every((o) => o.visible)
    replaceOperations(operations.map((o) =>
      o.toolId === toolId ? { ...o, visible: !allVisible } as AnyOperation : o
    ))
  }

  function confirmDeleteGroup(toolId: string, groupOps: AnyOperation[]) {
    replaceOperations(operations.filter((o) => o.toolId !== toolId))
    if (groupOps.some((o) => o.id === editingOpId)) setEditingOpId(null)
    setConfirmDeleteGroupId(null)
  }

  // Separate grouped vs ungrouped paths; preserve original order within groups
  const groupOrder: string[] = []
  const groupMap = new Map<string, typeof paths>()
  const ungrouped: typeof paths = []

  for (const p of paths) {
    if (p.groupId) {
      if (!groupMap.has(p.groupId)) {
        groupMap.set(p.groupId, [])
        groupOrder.push(p.groupId)
      }
      groupMap.get(p.groupId)!.push(p)
    } else {
      ungrouped.push(p)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Inline operation editor — pinned to top so it's always visible */}
      {editingOp && (
        <OperationEditForm key={editingOp.id} op={editingOp} onClose={() => setEditingOpId(null)} />
      )}

      {/* Path list */}
      <p className="px-3 pt-2 pb-1 text-label font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider">Paths</p>

      {paths.length === 0 ? (
        <div className="px-3 py-6 text-body text-gray-400 dark:text-neutral-500 text-center">
          <Layers size={ICON.lg} className="mx-auto mb-2 opacity-30" />
          No paths yet. Use the Import button in the toolbar.
        </div>
      ) : (
        <ul className="px-2 pb-2 space-y-0.5">
          {/* SVG import groups */}
          {groupOrder.map((groupId) => {
            const members = groupMap.get(groupId)!
            const collapsed = collapsedGroups.has(groupId)
            const groupName = members[0].groupName ?? groupId
            const allVisible = members.every((p) => p.visible)
            const anySelected = members.some((p) => selectedIds.includes(p.id))

            return (
              <li key={groupId}>
                {/* Folder header row */}
                <div
                  className={[
                    'flex items-center gap-1 px-1 py-1 rounded cursor-pointer group select-none',
                    anySelected ? 'bg-blue-600/10' : 'hover:bg-gray-200/50 dark:hover:bg-neutral-700/50',
                  ].join(' ')}
                  onClick={() => toggleGroupCollapsed(groupId)}
                >
                  <span className="text-gray-400 dark:text-neutral-500 flex-shrink-0">
                    {collapsed ? <ChevronRight size={ICON.sm} /> : <ChevronDown size={ICON.sm} />}
                  </span>
                  <span className="text-gray-400 dark:text-neutral-500 flex-shrink-0">
                    {collapsed ? <Folder size={ICON.sm} /> : <FolderOpen size={ICON.sm} />}
                  </span>
                  <span className="flex-1 text-body truncate text-gray-700 dark:text-neutral-300 font-medium" title={groupName}>
                    {groupName}
                  </span>
                  <span className="text-xs text-gray-400 dark:text-neutral-500 flex-shrink-0 mr-1">
                    {members.length}
                  </span>
                  <button
                    title={allVisible ? 'Hide group' : 'Show group'}
                    onClick={(e) => { e.stopPropagation(); toggleGroupVisibility(groupId) }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 transition-opacity"
                  >
                    {allVisible ? <Eye size={ICON.sm} /> : <EyeOff size={ICON.sm} />}
                  </button>
                  <button
                    title="Delete group"
                    onClick={(e) => { e.stopPropagation(); deleteGroup(groupId) }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-900/40 text-gray-500 dark:text-neutral-400 hover:text-red-400 transition-opacity"
                  >
                    <Trash2 size={ICON.sm} />
                  </button>
                </div>

                {/* Member paths */}
                {!collapsed && (
                  <ul className="ml-5 space-y-0.5 mt-0.5">
                    {members.map((p) => (
                      <li
                        key={p.id}
                        className={[
                          'flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer group',
                          selectedIds.includes(p.id) ? 'bg-blue-600/20 text-blue-300' : 'hover:bg-gray-200/50 dark:hover:bg-neutral-700/50',
                        ].join(' ')}
                        onClick={(e) => selectPath(selectedIds.includes(p.id) && selectedIds.length === 1 ? null : p.id, e.shiftKey)}
                      >
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
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
              </li>
            )
          })}

          {/* Ungrouped paths (shapes, pen tool, etc.) */}
          {ungrouped.map((p) => (
            <li
              key={p.id}
              className={[
                'flex items-center gap-1.5 px-2 py-1.5 rounded cursor-pointer group',
                p.hidden ? 'opacity-40' : '',
                selectedIds.includes(p.id) ? 'bg-blue-600/20 text-blue-300' : 'hover:bg-gray-200/50 dark:hover:bg-neutral-700/50',
              ].join(' ')}
              onClick={(e) => selectPath(selectedIds.includes(p.id) && selectedIds.length === 1 ? null : p.id, e.shiftKey)}
            >
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
              <span className="flex-1 text-body truncate text-gray-800 dark:text-neutral-200">{p.name}</span>
              {p.hidden && (
                <button
                  title="Restore (un-hide from boolean op)"
                  onClick={(e) => { e.stopPropagation(); showPath(p.id) }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-amber-400 transition-opacity"
                >
                  <Eye size={ICON.sm} />
                </button>
              )}
              {!p.hidden && (
                <button
                  title={p.visible ? 'Hide path' : 'Show path'}
                  onClick={(e) => { e.stopPropagation(); toggleVisibility(p.id) }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 transition-opacity"
                >
                  {p.visible ? <Eye size={ICON.sm} /> : <EyeOff size={ICON.sm} />}
                </button>
              )}
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
          <div className="flex items-center px-3 py-1.5">
            <p className="flex-1 text-label font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider">Toolpaths</p>
          </div>
          <ul className="px-2 pb-1 space-y-0.5">
            {opGroupOrder.map((toolId) => {
              const groupOps = opGroupMap.get(toolId)!
              const collapsed = collapsedOpGroups.has(toolId)
              const tool = toolsById[toolId]
              const toolLabel = tool ? tool.name : 'Unknown Tool'
              const toolDia = tool ? `Ø${tool.diameterMM}mm` : ''
              const allVisible = groupOps.every((o) => o.visible)
              const groupIdx = opGroupOrder.indexOf(toolId)

              const isConfirming = confirmDeleteGroupId === toolId

              return (
                <li key={toolId}>
                  {/* Tool group header */}
                  {isConfirming ? (
                    <div className="flex items-center gap-2 px-2 py-1 rounded bg-red-950/40 border border-red-800/40 select-none">
                      <Trash2 size={ICON.sm} className="text-red-400 flex-shrink-0" />
                      <span className="flex-1 text-body text-red-300 truncate">
                        Delete {groupOps.length} op{groupOps.length !== 1 ? 's' : ''} from &ldquo;{toolLabel}&rdquo;?
                      </span>
                      <button
                        onClick={() => setConfirmDeleteGroupId(null)}
                        className="px-1.5 py-0.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200 flex-shrink-0"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => confirmDeleteGroup(toolId, groupOps)}
                        className="px-1.5 py-0.5 text-xs rounded bg-red-700 hover:bg-red-600 text-white flex-shrink-0"
                      >
                        Delete
                      </button>
                    </div>
                  ) : (
                  <div
                    className="flex items-center gap-1 px-1 py-1 rounded cursor-pointer group select-none hover:bg-gray-200/50 dark:hover:bg-neutral-700/50"
                    onClick={() => toggleOpGroup(toolId)}
                  >
                    <span className="text-gray-400 dark:text-neutral-500 flex-shrink-0">
                      {collapsed ? <ChevronRight size={ICON.sm} /> : <ChevronDown size={ICON.sm} />}
                    </span>
                    <span className="text-gray-400 dark:text-neutral-500 flex-shrink-0">
                      {collapsed ? <Folder size={ICON.sm} /> : <FolderOpen size={ICON.sm} />}
                    </span>
                    <span className="flex-1 text-body font-medium text-gray-700 dark:text-neutral-300 truncate" title={toolLabel}>{toolLabel}</span>
                    {toolDia && <span className="text-xs text-gray-400 dark:text-neutral-500 flex-shrink-0">{toolDia}</span>}
                    <span className="text-xs text-gray-400 dark:text-neutral-500 flex-shrink-0 ml-1">{groupOps.length}</span>
                    {/* Group action buttons */}
                    <div className="opacity-0 group-hover:opacity-100 flex transition-opacity flex-shrink-0">
                      <button
                        title="Move group up"
                        disabled={groupIdx === 0}
                        onClick={(e) => { e.stopPropagation(); moveGroup(toolId, 'up') }}
                        className="p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ArrowUp size={ICON.sm} />
                      </button>
                      <button
                        title="Move group down"
                        disabled={groupIdx === opGroupOrder.length - 1}
                        onClick={(e) => { e.stopPropagation(); moveGroup(toolId, 'down') }}
                        className="p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ArrowDown size={ICON.sm} />
                      </button>
                      <button
                        title={allVisible ? 'Hide group' : 'Show group'}
                        onClick={(e) => { e.stopPropagation(); toggleGroupVisible(toolId, groupOps) }}
                        className="p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200"
                      >
                        {allVisible ? <Eye size={ICON.sm} /> : <EyeOff size={ICON.sm} />}
                      </button>
                      <button
                        title="Delete group"
                        onClick={(e) => { e.stopPropagation(); setConfirmDeleteGroupId(toolId) }}
                        className="p-0.5 rounded hover:bg-red-900/40 text-gray-500 dark:text-neutral-400 hover:text-red-400"
                      >
                        <Trash2 size={ICON.sm} />
                      </button>
                    </div>
                  </div>
                  )}

                  {/* Operations within this tool group */}
                  {!collapsed && (
                    <ul className="ml-5 space-y-0.5 mt-0.5">
                      {groupOps.map((op) => {
                        const groupIdx = groupOps.indexOf(op)
                        const typeColor = OP_TYPE_COLORS[op.type] ?? '#94a3b8'
                        const typeLabel = OP_TYPE_LABELS[op.type] ?? op.type
                        return (
                          <li
                            key={op.id}
                            className={[
                              'flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer group',
                              op.id === editingOpId
                                ? 'bg-blue-600/20 text-blue-300'
                                : 'hover:bg-gray-200/50 dark:hover:bg-neutral-700/50',
                            ].join(' ')}
                            onClick={() => setEditingOpId(op.id === editingOpId ? null : op.id)}
                          >
                            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: typeColor }} />
                            {STATUS_ICON[op.status]}
                            <span className="flex-1 text-body truncate text-gray-700 dark:text-neutral-300" title={op.name}>{op.name}</span>
                            <span className="text-xs text-gray-400 dark:text-neutral-600 flex-shrink-0">{typeLabel}</span>
                            {/* Reorder within group */}
                            <div className="opacity-0 group-hover:opacity-100 flex transition-opacity flex-shrink-0">
                              <button
                                title="Move up within group"
                                disabled={groupIdx === 0}
                                onClick={(e) => { e.stopPropagation(); moveWithinGroup(op.id, toolId, 'up') }}
                                className="p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 disabled:opacity-30 disabled:cursor-not-allowed"
                              >
                                <ArrowUp size={ICON.sm} />
                              </button>
                              <button
                                title="Move down within group"
                                disabled={groupIdx === groupOps.length - 1}
                                onClick={(e) => { e.stopPropagation(); moveWithinGroup(op.id, toolId, 'down') }}
                                className="p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 disabled:opacity-30 disabled:cursor-not-allowed"
                              >
                                <ArrowDown size={ICON.sm} />
                              </button>
                            </div>
                            <button
                              title={op.visible ? 'Hide' : 'Show'}
                              onClick={(e) => { e.stopPropagation(); toggleOpVisibility(op.id) }}
                              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 transition-opacity flex-shrink-0"
                            >
                              {op.visible ? <Eye size={ICON.sm} /> : <EyeOff size={ICON.sm} />}
                            </button>
                            <button
                              title="Delete"
                              onClick={(e) => { e.stopPropagation(); pushHistoryBoth(); deleteOperation(op.id); if (op.id === editingOpId) setEditingOpId(null) }}
                              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-900/40 text-gray-500 dark:text-neutral-400 hover:text-red-400 transition-opacity flex-shrink-0"
                            >
                              <Trash2 size={ICON.sm} />
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

    </div>
  )
}
