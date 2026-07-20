import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown, ChevronLeft, ChevronRight, ChevronUp, SkipBack, SkipForward,
  Shapes, Wrench, Package, Square, Squircle, Signpost, Circle, Ellipse, Hexagon,
  Star, Heart, Pill, Shield, Type, PenTool, Copy, Import, SquaresUnite,
  SquareSquare, LayoutGrid, Scissors, Pencil, Trash2, Eye, EyeOff,
  RectangleEllipsis, Target, CircleDot, Layers, Box, RefreshCw, FileCode,
  ArrowUpDown, Move, RotateCw, Scaling, Spline, Combine, FlipHorizontal2,
  VectorSquare, X, FoldHorizontal,
} from 'lucide-react'
import { useTimelineStore } from '../timeline/timelineStore'
import { usePathsStore } from '../store/pathsStore'
import { useTabStore } from '../store/tabStore'
import { familyOf, type EventFamily, type TimelineEvent } from '../timeline/events'
import { useUIStore } from '../store/uiStore'
import { OP_TYPE_COLORS } from '../colors'
import { InlayIcon } from './MachinePanel'

// Operation timeline strip docked under the 2D canvas: one chip per recorded
// event, cursor between chips, click/drag to scrub back to any point in time.
// Chips after the cursor are the ghosted "redo future" — kept and replayed on
// top when edits are inserted via timeline browsing, discarded on undo+edit.

const FAMILY_STYLE: Record<EventFamily, string> = {
  path: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/40',
  op: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/40',
  tab: 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/40',
  project: 'bg-gray-400/15 text-gray-600 dark:text-neutral-400 border-gray-400/40',
}

type ChipIcon = React.ComponentType<{ size?: number; style?: React.CSSProperties }>

// Same icons as the shape panel (ShapePanel SHAPES) …
const SHAPE_ICONS: Record<string, ChipIcon> = {
  rectangle: Square, roundrect: Squircle, inroundrect: Signpost, circle: Circle,
  ellipse: Ellipse, polygon: Hexagon, star: Star, heart: Heart, slot: Pill,
  shield: Shield, text: Type,
}

// … and the CAM operations menu (MachinePanel AddOperationMenu)
const OP_ICONS: Record<string, ChipIcon> = {
  profile: Circle, trochoidal: RefreshCw, pocket: Target, drill: CircleDot,
  surface: Layers, vcarve: Star, inlay: InlayIcon, profile3d: Box, gcode: FileCode,
}

// paths.edit gesture icons — Corner matches the "Corners" path-tool icon
const GESTURE_ICONS: Record<string, ChipIcon> = {
  move: Move, scale: Scaling, rotate: RotateCw, skew: Scaling,
  mirror: FlipHorizontal2, corner: VectorSquare, points: Spline,
  join: Combine, weld: Combine, trim: Scissors, text: Type,
}

// Pick the chip's icon (and optional override color) to match how the same
// thing is drawn elsewhere in the app.
function chipVisual(ev: TimelineEvent): { Icon: ChipIcon; color?: string } {
  switch (ev.kind) {
    case 'paths.add': {
      if (ev.source === 'shape' || ev.source === 'text') {
        const t = ev.paths[0]?.shapeParams?.type
        if (t && SHAPE_ICONS[t]) return { Icon: SHAPE_ICONS[t] }
        if (ev.source === 'text') return { Icon: Type }
      }
      if (ev.source === 'pen') return { Icon: PenTool }
      if (ev.source === 'duplicate') return { Icon: Copy }
      if (ev.source === 'import') return { Icon: Import }
      if (ev.source === 'boolean') return { Icon: SquaresUnite, color: OP_TYPE_COLORS.boolean }
      if (ev.source === 'offset') return { Icon: SquareSquare, color: OP_TYPE_COLORS.offset }
      if (ev.source === 'pattern') return { Icon: LayoutGrid, color: OP_TYPE_COLORS.pattern }
      return { Icon: Shapes }
    }
    case 'paths.edit': {
      if (ev.gesture === 'boolean') return { Icon: SquaresUnite, color: OP_TYPE_COLORS.boolean }
      if (ev.gesture && GESTURE_ICONS[ev.gesture]) return { Icon: GESTURE_ICONS[ev.gesture] }
      const delOnly = (ev.deleteIds?.length ?? 0) > 0 && ev.updates.length === 0 && !(ev.add?.length)
      return { Icon: delOnly ? Trash2 : Pencil }
    }
    case 'paths.split': return { Icon: Scissors }
    case 'paths.setHidden': return { Icon: ev.hidden ? EyeOff : Eye }
    case 'shape.params': return { Icon: SHAPE_ICONS[ev.params.type] ?? Shapes }
    case 'op.add': return { Icon: OP_ICONS[ev.op.type] ?? Wrench, color: OP_TYPE_COLORS[ev.op.type] }
    case 'op.update': return { Icon: OP_ICONS[ev.opType ?? ''] ?? Wrench, color: OP_TYPE_COLORS[ev.opType ?? ''] }
    case 'op.delete': return { Icon: Trash2, color: OP_TYPE_COLORS[ev.opType ?? ''] }
    case 'op.reorder': return { Icon: ArrowUpDown }
    case 'tabs.apply':
    case 'tabs.delete':
    case 'tabs.moveT': return { Icon: RectangleEllipsis, color: OP_TYPE_COLORS.tabs }
    case 'workpiece.set':
    case 'snapshot': return { Icon: Package }
  }
}

function timeAgo(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

// Chips are visual only — scrub hits are handled by the strip container, so
// the pointer works anywhere over the strip's full height, not just the chip band.
function Chip({ ev, past, isCursor, compact }: {
  ev: TimelineEvent
  past: boolean
  isCursor: boolean
  compact: boolean
}) {
  const { Icon, color } = chipVisual(ev)
  return (
    <div
      data-seq={ev.seq}
      title={`${ev.seq}. ${ev.label} · ${timeAgo(ev.t)}`}
      className={[
        'group relative flex items-center gap-1 px-1.5 h-6 rounded border text-[13px] whitespace-nowrap flex-shrink-0 transition-opacity',
        FAMILY_STYLE[familyOf(ev.kind)],
        past ? 'opacity-100' : 'opacity-35',
        isCursor ? 'ring-2 ring-blue-500' : '',
      ].join(' ')}
    >
      <Icon size={12} style={color ? { color } : undefined} />
      {!compact && <span className="max-w-[110px] truncate">{ev.label}</span>}
      {/* Remove-from-timeline: overlays the chip's right edge on hover so the
          layout never shifts. stopPropagation keeps the strip from scrubbing.
          Snapshot chips hold everything before them — not removable. */}
      {ev.kind !== 'snapshot' && <button
        title={`Remove "${ev.label}" from the timeline`}
        onMouseDown={(e) => {
          e.stopPropagation()
          e.preventDefault()
          useTimelineStore.getState().removeEvent(ev.seq)
        }}
        className="absolute -top-1.5 -right-1.5 z-10 hidden group-hover:flex items-center justify-center w-4 h-4 rounded-full border border-gray-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-gray-500 dark:text-neutral-400 hover:text-red-500 dark:hover:text-red-400 hover:border-red-400"
      >
        <X size={10} />
      </button>}
    </div>
  )
}

export default function TimelinePanel() {
  const events = useTimelineStore((s) => s.events)
  const cursor = useTimelineStore((s) => s.cursor)
  const scrubTo = useTimelineStore((s) => s.scrubTo)
  const timelineOpen = useUIStore((s) => s.timelineOpen)
  const setTimelineOpen = useUIStore((s) => s.setTimelineOpen)
  // Two-click confirm for the (irreversible) flatten action
  const [confirmFlatten, setConfirmFlatten] = useState(false)
  useEffect(() => {
    if (!confirmFlatten) return
    const t = setTimeout(() => setConfirmFlatten(false), 3000)
    return () => clearTimeout(t)
  }, [confirmFlatten])

  const stripRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const [stripW, setStripW] = useState(0)

  // Release drag-scrub on mouseup anywhere
  useEffect(() => {
    const up = () => { draggingRef.current = false }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  // Track the strip's width so chips can drop their labels before overflowing
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const ro = new ResizeObserver(() => setStripW(strip.clientWidth))
    ro.observe(strip)
    setStripW(strip.clientWidth)
    return () => ro.disconnect()
  }, [timelineOpen])

  // Estimate the width of fully-labeled chips; when they wouldn't fit, ALL
  // chips collapse to icon-only (labels stay in the tooltips) so more history
  // fits before the scrollbar has to appear. Estimation (13px font ≈ 6.8px/char,
  // labels truncate at 110px) rather than measurement keeps this deterministic —
  // no render-measure-rerender loop and no flip-flopping at the boundary.
  const GENESIS_W = 16
  const labeledW = events.reduce(
    (w, ev) => w + 34 + Math.min(110, ev.label.length * 6.8),
    GENESIS_W + 8,
  )
  const compact = stripW > 0 && labeledW > stripW

  // Keep the cursor chip visible as events append / cursor moves
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const el = strip.querySelector<HTMLElement>(`[data-seq="${cursor}"]`)
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    else if (cursor === events.length) strip.scrollLeft = strip.scrollWidth
  }, [cursor, events.length])

  // Map a pointer x-position to a seq: the chip (or genesis dot) under the
  // pointer, else the nearest one. Lets the whole strip height — gaps between
  // chips and the space past the last chip included — act as the scrub target.
  const seqAtX = (clientX: number): number | null => {
    const strip = stripRef.current
    if (!strip) return null
    let best: number | null = null
    let bestDist = Infinity
    for (const el of strip.querySelectorAll<HTMLElement>('[data-seq]')) {
      const r = el.getBoundingClientRect()
      if (clientX >= r.left && clientX <= r.right) return Number(el.dataset.seq)
      const d = clientX < r.left ? r.left - clientX : clientX - r.right
      if (d < bestDist) { bestDist = d; best = Number(el.dataset.seq) }
    }
    return best
  }

  // True when the pointer is over the strip's horizontal scrollbar (the area
  // below clientHeight) — those clicks must scroll, not scrub.
  const onScrollbar = (e: React.MouseEvent): boolean => {
    const strip = stripRef.current
    if (!strip) return false
    return e.clientY - strip.getBoundingClientRect().top > strip.clientHeight
  }

  const onStripMouseDown = (e: React.MouseEvent) => {
    if (onScrollbar(e)) return
    e.preventDefault()
    draggingRef.current = true
    const seq = seqAtX(e.clientX)
    if (seq === null) return
    scrubTo(seq)
    // Clicking a chip also surfaces the matching editor so its parameters can
    // be amended in place: op chips open the operation's edit form, path-
    // creating chips open the properties panel (selection is already restored
    // by the scrub), workpiece chips open the Setup panel. Deliberate clicks
    // only — drag-scrubs passing over chips don't flip panels.
    const ev = seq > 0 ? events[seq - 1] : undefined
    if (!ev) return
    const ui = useUIStore.getState()
    const opId = ev.kind === 'op.add' ? ev.op.id : ev.kind === 'op.update' ? ev.opId : null
    if (opId) {
      // Stay on the Draw tab — MachinePanel opens the op's form there
      ui.setSetupPanelOpen(false)
      ui.setShapesPanelOpen(false)
      ui.setSidebarTab('draw')
      ui.setRequestEditOpId(opId)
    } else if (ev.kind === 'tabs.apply' || ev.kind === 'tabs.delete' || ev.kind === 'tabs.moveT') {
      // Tab chips open the Tabs form — it edits the selected path's tabs
      const pathId = ev.kind === 'tabs.apply'
        ? ev.pathId
        : ev.kind === 'tabs.moveT'
          ? useTabStore.getState().tabs.find((t) => t.id === ev.tabId)?.pathId
          : undefined
      if (pathId && usePathsStore.getState().paths.some((p) => p.id === pathId)) {
        usePathsStore.getState().setSelectedIds([pathId])
      }
      ui.setSetupPanelOpen(false)
      ui.setShapesPanelOpen(false)
      ui.setSidebarTab('draw')
      ui.setRequestMachineForm('tabs')
    } else if (ev.kind === 'paths.edit' && ev.gesture === 'corner') {
      // Corner chips open the Corners form for the treated path
      const pathId = ev.updates[0]?.id
      if (pathId && usePathsStore.getState().paths.some((p) => p.id === pathId)) {
        usePathsStore.getState().setSelectedIds([pathId])
      }
      ui.setSetupPanelOpen(false)
      ui.setShapesPanelOpen(false)
      ui.setSidebarTab('draw')
      ui.setRequestMachineForm('nodeedit')
    } else if (
      (ev.kind === 'paths.edit' && ev.gesture === 'boolean') ||
      (ev.kind === 'paths.add' && (ev.offset || ev.pattern))
    ) {
      // Generator chips (boolean/offset/pattern) open their form in edit
      // mode — change the parameters and the chip is reworked in place.
      // (Offset/pattern chips from before generator metadata existed fall
      // through to the generic path branch below.)
      ui.setSetupPanelOpen(false)
      ui.setShapesPanelOpen(false)
      ui.setSidebarTab('draw')
      ui.setRequestEditEventId(ev.id)
    } else if (ev.kind === 'paths.add' || ev.kind === 'paths.edit' || ev.kind === 'paths.split' || ev.kind === 'shape.params') {
      ui.setSetupPanelOpen(false)
      ui.setMachineFormActive(false)
      ui.setShapesPanelOpen(false)
      ui.setSidebarTab('draw')
      // Apply the chip's selection even when the cursor didn't move (scrubTo
      // no-ops on same-seq clicks) — the properties panel needs a selection.
      const { paths, setSelectedIds } = usePathsStore.getState()
      const pathIds = new Set(paths.map((p) => p.id))
      const sel = ev.selectionAfter.filter((id) => pathIds.has(id))
      if (sel.length > 0) setSelectedIds(sel)
      // The properties editor (bottom of sidebar) IS where this chip's shape/
      // text parameters are amended — flash it so it's easy to find.
      ui.flashProperties()
    } else if (ev.kind === 'workpiece.set') {
      ui.setSetupPanelOpen(true)
    }
  }

  const onStripMouseMove = (e: React.MouseEvent) => {
    if (!draggingRef.current) return
    const seq = seqAtX(e.clientX)
    if (seq !== null) scrubTo(seq)
  }

  // Plain vertical wheel scrolls the strip horizontally — no need to aim for
  // the scrollbar at all (trackpad horizontal pans keep working natively).
  const onStripWheel = (e: React.WheelEvent) => {
    const strip = stripRef.current
    if (!strip) return
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) strip.scrollLeft += e.deltaY
  }

  if (!timelineOpen) {
    return (
      <div className="flex items-center h-[22px] px-2 gap-2 border-t border-gray-300 dark:border-neutral-700 bg-gray-100 dark:bg-neutral-800 flex-shrink-0 select-none">
        <button
          onClick={() => setTimelineOpen(true)}
          className="flex items-center gap-1 text-[13px] text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200"
          title="Show timeline"
        >
          <ChevronUp size={13} />
          Timeline{events.length > 0 ? ` · ${cursor}/${events.length}` : ''}
        </button>
      </div>
    )
  }

  const btnCls = 'p-1 rounded text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-30 disabled:pointer-events-none'

  return (
    <div className="border-t border-gray-300 dark:border-neutral-700 bg-gray-100 dark:bg-neutral-800 flex-shrink-0 select-none">
      <div className="flex items-center h-11 px-2 gap-1">
        {/* Transport */}
        <button className={btnCls} title="Back to start" disabled={cursor === 0} onClick={() => scrubTo(0)}>
          <SkipBack size={14} />
        </button>
        <button className={btnCls} title="Step back" disabled={cursor === 0} onClick={() => scrubTo(cursor - 1)}>
          <ChevronLeft size={14} />
        </button>
        <button className={btnCls} title="Step forward" disabled={cursor === events.length} onClick={() => scrubTo(cursor + 1)}>
          <ChevronRight size={14} />
        </button>
        <button className={btnCls} title="Jump to latest" disabled={cursor === events.length} onClick={() => scrubTo(events.length)}>
          <SkipForward size={14} />
        </button>

        {/* Chip strip — mouse handling lives on the container so any point over
            the strip's full height scrubs to the chip at that x position */}
        <div
          ref={stripRef}
          onMouseDown={onStripMouseDown}
          onMouseMove={onStripMouseMove}
          onWheel={onStripWheel}
          className="timeline-strip flex-1 flex items-center gap-1 overflow-x-auto px-1 min-w-0 h-full cursor-pointer"
        >
          {/* Genesis dot — scrub to the empty/loaded start state */}
          <div
            data-seq={0}
            title="Project start"
            className={[
              'w-3 h-3 rounded-full border flex-shrink-0 border-gray-400 dark:border-neutral-500',
              cursor === 0 ? 'bg-blue-500 ring-2 ring-blue-500/50' : 'bg-gray-300 dark:bg-neutral-600',
            ].join(' ')}
          />
          {events.map((ev) => (
            <Chip key={ev.id} ev={ev} past={ev.seq <= cursor} isCursor={ev.seq === cursor} compact={compact} />
          ))}
        </div>

        {/* Position + flatten + collapse */}
        <span className="text-[13px] text-gray-500 dark:text-neutral-400 font-mono px-1 flex-shrink-0">
          {cursor}/{events.length}
        </span>
        <button
          className={confirmFlatten
            ? 'p-1 rounded text-red-500 dark:text-red-400 bg-red-500/10 hover:bg-red-500/20'
            : btnCls}
          title={confirmFlatten
            ? 'Click again to flatten — folds all events up to the cursor into one snapshot (cannot be undone)'
            : 'Flatten history up to the cursor'}
          disabled={cursor < 1 || (cursor === 1 && events[0]?.kind === 'snapshot')}
          onClick={() => {
            if (!confirmFlatten) { setConfirmFlatten(true); return }
            setConfirmFlatten(false)
            useTimelineStore.getState().flattenHistory()
          }}
        >
          <FoldHorizontal size={14} />
        </button>
        <button className={btnCls} title="Hide timeline" onClick={() => setTimelineOpen(false)}>
          <ChevronDown size={14} />
        </button>
      </div>
    </div>
  )
}
