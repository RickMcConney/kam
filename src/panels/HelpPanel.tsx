import { X } from 'lucide-react'
import { useUIStore } from '../store/uiStore'

type Section = {
  title: string
  rows: { keys: string[]; desc: string }[]
}

const SHORTCUTS: Section[] = [
  {
    title: 'File',
    rows: [
      { keys: ['Ctrl+N'], desc: 'New project' },
      { keys: ['Ctrl+O'], desc: 'Open project' },
      { keys: ['Ctrl+S'], desc: 'Save project' },
    ],
  },
  {
    title: 'Edit',
    rows: [
      { keys: ['Ctrl+Z'], desc: 'Undo' },
      { keys: ['Ctrl+Y'], desc: 'Redo' },
      { keys: ['Ctrl+D'], desc: 'Duplicate selected' },
      { keys: ['Delete', 'Backspace'], desc: 'Delete selected' },
      { keys: ['Escape'], desc: 'Deselect / cancel operation' },
    ],
  },
  {
    title: 'Canvas',
    rows: [
      { keys: ['Scroll'], desc: 'Zoom in / out' },
      { keys: ['Middle mouse', 'Space+drag'], desc: 'Pan' },
      { keys: ['S'], desc: 'Toggle snap to grid' },
    ],
  },
  {
    title: 'Point Edit',
    rows: [
      { keys: ['Double-click path'], desc: 'Enter point edit mode' },
      { keys: ['Click segment'], desc: 'Insert node' },
      { keys: ['Hover node + Delete'], desc: 'Remove node' },
      { keys: ['Escape'], desc: 'Commit and exit point edit' },
    ],
  },
]

const FEATURES = [
  {
    title: 'Select tool',
    desc: 'Click to select, drag empty area to box-select. Shift-click to toggle membership in a multi-selection. Drag handles to move, scale, or rotate. Hold Alt while dragging a corner handle to skew (shear) instead of scale.',
  },
  {
    title: 'Shape tools',
    desc: 'Pick a shape from the Draw panel. Click the canvas to place it at the default size, or drag to size it interactively. Edit parameters in the Properties panel.',
  },
  {
    title: 'Pen tool',
    desc: 'Click to place nodes. In Bezier mode, drag to pull out curve handles. In all other modes curves are computed automatically from node positions. Hold Alt while clicking to make the incoming segment a straight line. Click near the first node to close the path, or press Escape to finish an open path (2+ nodes required). Ctrl+Z to undo the last placed node.',
  },
  {
    title: 'Point edit',
    desc: 'Double-click any path to edit its nodes directly. Drag anchors or handles to reshape. Click on a segment to insert a new node. Hover an anchor and press Delete to remove it.',
  },
  {
    title: 'Import',
    desc: 'Supported formats: SVG, DXF, STL (projected outline), PNG/JPG/WebP (placed as a boundary rectangle), and G-code (for simulation replay).',
  },
  {
    title: 'Toolpaths',
    desc: 'Select paths, then open the Machine panel to add Profile, Pocket, Drill, Surfacing, or 3D Profile operations. Run Simulate to preview the motion, or Export G-code to download Grbl-compatible output.',
  },
  {
    title: 'Timeline',
    desc: 'The strip under the canvas records every action — shapes, edits, CAM operations, tabs, and workpiece changes — as chips. Click or drag across chips to travel to any point in time; the timeline is saved with the project. Undo (Ctrl+Z) steps back and discards the future when you make a new edit; clicking the timeline instead INSERTS new edits, keeping later events replayable on top. Hover a chip and click its ✕ to remove that action from history, or use the fold button to flatten old history into a snapshot. Both are permanent.',
  },
]

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-block px-1.5 py-0.5 rounded text-xs font-mono bg-gray-100 dark:bg-neutral-700 border border-gray-300 dark:border-neutral-600 text-gray-800 dark:text-neutral-200">
      {children}
    </kbd>
  )
}

export default function HelpPanel() {
  const { helpOpen, setHelpOpen } = useUIStore()
  if (!helpOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={() => setHelpOpen(false)}
    >
      <div
        className="bg-white dark:bg-neutral-800 rounded-lg shadow-2xl border border-gray-200 dark:border-neutral-700 w-[680px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-neutral-700 flex-shrink-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-neutral-100">FreakyKam Help</h2>
          <button
            onClick={() => setHelpOpen(false)}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-neutral-200 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto px-6 py-5 flex flex-col gap-6">

          {/* Keyboard shortcuts */}
          <section>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-neutral-300 mb-3 uppercase tracking-wide">
              Keyboard Shortcuts
            </h3>
            <div className="grid grid-cols-2 gap-x-8 gap-y-5">
              {SHORTCUTS.map((section) => (
                <div key={section.title}>
                  <div className="text-xs font-medium text-gray-500 dark:text-neutral-500 mb-1.5">{section.title}</div>
                  <table className="w-full text-sm">
                    <tbody>
                      {section.rows.map((row) => (
                        <tr key={row.desc} className="align-top">
                          <td className="pr-3 pb-1 whitespace-nowrap">
                            <span className="flex gap-1 flex-wrap">
                              {row.keys.map((k) => <Kbd key={k}>{k}</Kbd>)}
                            </span>
                          </td>
                          <td className="pb-1 text-gray-600 dark:text-neutral-400">{row.desc}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </section>

          {/* Feature overview */}
          <section>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-neutral-300 mb-3 uppercase tracking-wide">
              Features
            </h3>
            <div className="grid grid-cols-2 gap-x-8 gap-y-3">
              {FEATURES.map((f) => (
                <div key={f.title}>
                  <div className="text-sm font-medium text-gray-800 dark:text-neutral-200 mb-0.5">{f.title}</div>
                  <div className="text-xs text-gray-500 dark:text-neutral-400 leading-relaxed">{f.desc}</div>
                </div>
              ))}
            </div>
          </section>

          {/* Coordinate system note */}
          <section className="bg-gray-50 dark:bg-neutral-700/40 rounded-md px-4 py-3">
            <div className="text-xs font-medium text-gray-600 dark:text-neutral-300 mb-1">Coordinate system</div>
            <p className="text-xs text-gray-500 dark:text-neutral-400 leading-relaxed">
              All dimensions are in CNC space (mm, Y-up, origin at workpiece bottom-left by default).
              The canvas applies a Y-flip so positive Y appears upward on screen, matching conventional
              CAD orientation.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
