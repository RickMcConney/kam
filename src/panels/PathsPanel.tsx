import { useRef, useState } from 'react'
import { ICON } from '../theme'
import { Upload, Eye, EyeOff, Trash2, Layers, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { usePathsStore } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useToolpathStore } from '../store/toolpathStore'
import { importSvg } from '../importers/svgImporter'

const STATUS_ICON = {
  pending: <span className="w-1.5 h-1.5 rounded-full bg-gray-300 dark:bg-neutral-600 flex-shrink-0" />,
  generating: <Loader2 size={ICON.xs} className="animate-spin text-blue-400 flex-shrink-0" />,
  done: <CheckCircle2 size={ICON.xs} className="text-green-400 flex-shrink-0" />,
  'needs-update': <AlertCircle size={ICON.xs} className="text-amber-400 flex-shrink-0" />,
  error: <AlertCircle size={ICON.xs} className="text-red-400 flex-shrink-0" />,
}

function PpiPrompt({ onConfirm }: { onConfirm: (ppi: number) => void }) {
  const [val, setVal] = useState('96')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-100 dark:bg-neutral-800 border border-gray-200 dark:border-neutral-600 rounded-lg p-5 w-72 shadow-xl">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-neutral-100 mb-2">SVG Resolution</h3>
        <p className="text-body text-gray-500 dark:text-neutral-400 mb-4">
          This SVG uses pixel units. Enter the resolution (PPI) to convert to real-world mm. Use 96 for screen SVGs or 72 for print.
        </p>
        <div className="flex items-center gap-2 mb-4">
          <input
            type="number"
            min={1}
            max={2400}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            className="flex-1 bg-gray-200 dark:bg-neutral-700 border border-gray-200 dark:border-neutral-600 rounded px-2 py-1 text-sm text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500"
          />
          <span className="text-body text-gray-500 dark:text-neutral-400">PPI</span>
        </div>
        <button
          onClick={() => onConfirm(Math.max(1, parseInt(val) || 96))}
          className="w-full bg-blue-600 hover:bg-blue-500 text-white text-sm rounded py-1.5 transition-colors"
        >
          Import
        </button>
      </div>
    </div>
  )
}

export default function PathsPanel() {
  const { paths, selectedIds, selectPath, toggleVisibility, deletePath, pushHistoryBoth } = usePathsStore()
  const addPaths = usePathsStore((s) => s.addPaths)
  const { operations, toggleVisibility: toggleOpVisibility, deleteOperation } = useToolpathStore()
  const { setSidebarTab } = useUIStore()
  const { widthMM, heightMM } = useWorkpieceStore()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingSvgText, setPendingSvgText] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  function doImport(svgText: string, ppi?: number) {
    try {
      const result = importSvg(svgText, { ppi, workpieceMM: { w: widthMM, h: heightMM } })
      if (result.needsPpiPrompt && ppi === undefined) {
        setPendingSvgText(svgText)
        return
      }
      if (result.paths.length === 0) {
        setError('No supported shapes found in this SVG.')
        return
      }
      addPaths(result.paths)
      setSidebarTab('paths')
      setError(null)
      setPendingSvgText(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import SVG.')
    }
  }

  function handleFile(file: File) {
    if (!file.name.endsWith('.svg') && file.type !== 'image/svg+xml') {
      setError('Only .svg files are supported.')
      return
    }
    const reader = new FileReader()
    reader.onload = (e) => doImport(e.target?.result as string)
    reader.readAsText(file)
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    e.target.value = ''
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Import button + drag zone */}
      <div
        className={[
          'mx-3 mt-3 mb-2 border-2 border-dashed rounded-lg p-3 text-center cursor-pointer transition-colors',
          isDragging
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-gray-200 dark:border-neutral-600 hover:bg-gray-200/30 dark:hover:bg-neutral-700/30',
        ].join(' ')}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        <Upload size={ICON.lg} className="mx-auto mb-1 text-gray-500 dark:text-neutral-400" />
        <p className="text-body text-gray-500 dark:text-neutral-400">Drop SVG or click to import</p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".svg,image/svg+xml"
        className="hidden"
        onChange={handleFileInput}
      />

      {error && (
        <p className="mx-3 mb-2 text-body text-red-400 bg-red-900/20 rounded px-2 py-1">{error}</p>
      )}

      {/* Path list */}
      <div className="flex-1 overflow-y-auto">
        {paths.length === 0 ? (
          <div className="px-3 py-6 text-body text-gray-400 dark:text-neutral-500 text-center">
            <Layers size={ICON.lg} className="mx-auto mb-2 opacity-30" />
            No paths yet. Import an SVG to get started.
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
      </div>

      {/* Toolpaths section */}
      {operations.length > 0 && (
        <div className="border-t border-gray-300 dark:border-neutral-700 mt-1">
          <p className="px-3 py-1.5 text-label font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider">Toolpaths</p>
          <ul className="px-2 pb-2 space-y-0.5">
            {operations.map((op) => (
              <li key={op.id} className="flex items-center gap-1.5 px-2 py-1.5 rounded group hover:bg-gray-200/50 dark:hover:bg-neutral-700/50">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: op.color }} />
                {STATUS_ICON[op.status]}
                <span className="flex-1 text-body truncate text-gray-700 dark:text-neutral-300" title={op.name}>{op.name}</span>
                <button
                  title={op.visible ? 'Hide' : 'Show'}
                  onClick={() => toggleOpVisibility(op.id)}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 transition-opacity"
                >
                  {op.visible ? <Eye size={ICON.sm} /> : <EyeOff size={ICON.sm} />}
                </button>
                <button
                  title="Delete"
                  onClick={() => { pushHistoryBoth(); deleteOperation(op.id) }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-900/40 text-gray-500 dark:text-neutral-400 hover:text-red-400 transition-opacity"
                >
                  <Trash2 size={ICON.sm} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pendingSvgText && (
        <PpiPrompt onConfirm={(ppi) => doImport(pendingSvgText, ppi)} />
      )}
    </div>
  )
}
