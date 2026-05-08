import { Plus, Trash2 } from 'lucide-react'
import { ICON } from '../theme'
import { useToolStore, type Tool, type ToolType, type CuttingDirection } from '../store/toolStore'

const COLUMNS: { key: keyof Omit<Tool, 'id'>; label: string; title: string; width: string; unit?: string }[] = [
  { key: 'name',        label: 'Name',    title: 'Tool name',                 width: 'w-40' },
  { key: 'type',        label: 'Type',    title: 'Tool type',                 width: 'w-28' },
  { key: 'diameterMM',  label: 'Ø mm',    title: 'Diameter (mm)',             width: 'w-20' },
  { key: 'fluteCount',  label: 'Flutes',  title: 'Number of flutes',          width: 'w-16' },
  { key: 'rpm',         label: 'RPM',     title: 'Spindle speed (RPM)',       width: 'w-20' },
  { key: 'xyFeedMmMin', label: 'XY Feed', title: 'XY feed rate (mm/min)',     width: 'w-20' },
  { key: 'zFeedMmMin',  label: 'Z Feed',  title: 'Plunge feed rate (mm/min)', width: 'w-20' },
  { key: 'stepDownMM',  label: 'Step↓',   title: 'Step-down per pass (mm)',   width: 'w-18' },
  { key: 'maxDepthMM',  label: 'Max Z',   title: 'Maximum cut depth (mm)',    width: 'w-18' },
  { key: 'direction',   label: 'Dir',     title: 'Cutting direction',         width: 'w-28' },
]

const cellCls = 'bg-transparent border-0 text-body text-gray-800 dark:text-neutral-200 w-full focus:outline-none focus:ring-1 focus:ring-blue-500 rounded px-1 py-0.5'

function ToolRow({ tool }: { tool: Tool }) {
  const { updateTool, deleteTool, tools } = useToolStore()
  const up = (updates: Partial<Omit<Tool, 'id'>>) => updateTool(tool.id, updates)
  const canDelete = tools.length > 1

  return (
    <tr className="border-b border-gray-300/60 dark:border-neutral-700/60 hover:bg-gray-100/40 dark:hover:bg-neutral-800/40 group">
      <td className="px-2 py-1">
        <input type="text" value={tool.name} onChange={(e) => up({ name: e.target.value })} className={cellCls} />
      </td>
      <td className="px-2 py-1">
        <select value={tool.type} onChange={(e) => up({ type: e.target.value as ToolType })}
          className={cellCls + ' bg-gray-100 dark:bg-neutral-800'}>
          <option value="endmill">End Mill</option>
          <option value="ballnose">Ball Nose</option>
          <option value="vbit">V-Bit</option>
          <option value="drill">Drill</option>
        </select>
      </td>
      <td className="px-2 py-1">
        <input type="number" value={tool.diameterMM} min={0.1} step={0.001}
          onChange={(e) => up({ diameterMM: parseFloat(e.target.value) || 0 })}
          className={cellCls + ' text-right'} />
      </td>
      <td className="px-2 py-1">
        <input type="number" value={tool.fluteCount} min={1} step={1}
          onChange={(e) => up({ fluteCount: Math.max(1, Math.round(parseFloat(e.target.value) || 1)) })}
          className={cellCls + ' text-right'} />
      </td>
      <td className="px-2 py-1">
        <input type="number" value={tool.rpm} min={100} step={100}
          onChange={(e) => up({ rpm: parseFloat(e.target.value) || 0 })}
          className={cellCls + ' text-right'} />
      </td>
      <td className="px-2 py-1">
        <input type="number" value={tool.xyFeedMmMin} min={0} step={10}
          onChange={(e) => up({ xyFeedMmMin: parseFloat(e.target.value) || 0 })}
          className={cellCls + ' text-right'} />
      </td>
      <td className="px-2 py-1">
        <input type="number" value={tool.zFeedMmMin} min={1} step={10}
          onChange={(e) => up({ zFeedMmMin: parseFloat(e.target.value) || 0 })}
          className={cellCls + ' text-right'} />
      </td>
      <td className="px-2 py-1">
        <input type="number" value={tool.stepDownMM} min={0.01} step={0.1}
          onChange={(e) => up({ stepDownMM: parseFloat(e.target.value) || 0 })}
          className={cellCls + ' text-right'} />
      </td>
      <td className="px-2 py-1">
        <input type="number" value={tool.maxDepthMM} min={0.01} step={0.5}
          onChange={(e) => up({ maxDepthMM: parseFloat(e.target.value) || 0 })}
          className={cellCls + ' text-right'} />
      </td>
      <td className="px-2 py-1">
        <select value={tool.direction} onChange={(e) => up({ direction: e.target.value as CuttingDirection })}
          className={cellCls + ' bg-gray-100 dark:bg-neutral-800'}>
          <option value="climb">Climb</option>
          <option value="conventional">Conventional</option>
        </select>
      </td>
      <td className="px-2 py-1 text-center">
        <button onClick={() => canDelete && deleteTool(tool.id)} disabled={!canDelete}
          title={canDelete ? 'Delete tool' : 'Cannot delete the last tool'}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-400 dark:text-neutral-500 hover:text-red-400 hover:bg-red-900/20 disabled:opacity-20 disabled:cursor-not-allowed transition-colors">
          <Trash2 size={ICON.sm} />
        </button>
      </td>
    </tr>
  )
}

export default function ToolLibraryPanel() {
  const { tools, addTool } = useToolStore()

  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-neutral-900">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-300 dark:border-neutral-700 flex-shrink-0">
        <span className="text-body font-semibold text-gray-500 dark:text-neutral-400 uppercase tracking-wider">
          Tool Library — {tools.length} tool{tools.length !== 1 ? 's' : ''}
        </span>
        <button onClick={addTool}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-body bg-gray-200 dark:bg-neutral-700 hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-700 dark:text-neutral-300 transition-colors">
          <Plus size={ICON.sm} />
          Add Tool
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-body" style={{ minWidth: '860px' }}>
          <thead>
            <tr className="border-b border-gray-200 dark:border-neutral-600 sticky top-0 bg-gray-100 dark:bg-neutral-800">
              {COLUMNS.map((col) => (
                <th key={col.key} title={col.title}
                  className="px-2 py-1.5 text-left text-label font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider whitespace-nowrap select-none">
                  {col.label}
                  {(col.key === 'diameterMM' || col.key === 'stepDownMM' || col.key === 'maxDepthMM') && (
                    <span className="ml-0.5 text-gray-400 dark:text-neutral-500 normal-case font-normal tracking-normal">mm</span>
                  )}
                  {(col.key === 'xyFeedMmMin' || col.key === 'zFeedMmMin') && (
                    <span className="ml-0.5 text-gray-400 dark:text-neutral-500 normal-case font-normal tracking-normal">mm/m</span>
                  )}
                </th>
              ))}
              <th className="px-2 py-1.5 w-8" />
            </tr>
          </thead>
          <tbody>
            {tools.map((tool) => <ToolRow key={tool.id} tool={tool} />)}
          </tbody>
        </table>
      </div>
    </div>
  )
}
