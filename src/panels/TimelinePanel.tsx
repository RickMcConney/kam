import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown, ChevronUp,
  Shapes, Wrench, Square, Squircle, Signpost, Circle, Ellipse, Hexagon,
  Star, Heart, Pill, Shield, Orbit, Grid3x3, CookingPot, Cog, Snail, Type, PenTool, Copy, Import, SquaresUnite,
  SquareSquare, LayoutGrid, Target, CircleDot, Layers, Box, RefreshCw, FileCode,
  X, Image as ImageIcon, Anchor, Weight, Clock, RectangleEllipsis, VectorSquare, Group, TrainTrack,
} from 'lucide-react'
import { usePathsStore, clearCorners, outerGroupOf, type ImportedPath } from '../store/pathsStore'
import { useToolpathStore, type AnyOperation } from '../store/toolpathStore'
import { useTabStore, type Tab } from '../store/tabStore'
import { shapeDisplayName } from '../shapes/shapeGenerators'
import { useUIStore } from '../store/uiStore'
import { OP_TYPE_COLORS } from '../colors'
import { InlayIcon } from './MachinePanel'
import { BottomTabs } from './BottomTabs'
import { regenerateAffected } from '../cam/regenerate'

// The object strip docked under the 2D canvas: ONE CHIP PER THING IN THE
// DOCUMENT — every path (a group counts once), every clock, every operation —
// derived from the stores rather than from the event log.
//
// It used to be a history: one chip per recorded event, with a cursor to scrub.
// In practice a few paths get drawn and then moved and rearranged as they are
// cut, so the strip filled with Move chips and the objects were lost among
// them; and an edit to a gear regenerated its pinion, which the strip then
// showed as yet another entry rather than as the same pinion. Derived from the
// objects, an edit changes a chip instead of adding one, and a thing that has
// been deleted has no chip at all.
//
// The chips are a click target for editing, not a record of what happened, so
// nothing here moves the undo cursor — see the click handler.

type ChipIcon = React.ComponentType<{ size?: number; style?: React.CSSProperties }>

// Same icons as the shape panel (ShapePanel SHAPES) …
const SHAPE_ICONS: Record<string, ChipIcon> = {
  rectangle: Square, roundrect: Squircle, inroundrect: Signpost, circle: Circle,
  ellipse: Ellipse, polygon: Hexagon, star: Star, heart: Heart, slot: Pill,
  shield: Shield, spirograph: Orbit, maze: Grid3x3, board: CookingPot, gear: Cog,
  cam: Snail, escapement: Anchor, pendulum: Weight, track: TrainTrack, text: Type,
}

// … and the CAM operations menu (MachinePanel AddOperationMenu)
const OP_ICONS: Record<string, ChipIcon> = {
  profile: Circle, trochoidal: RefreshCw, pocket: Target, drill: CircleDot,
  surface: Layers, vcarve: Star, inlay: InlayIcon, profile3d: Box, gcode: FileCode,
  photovcarve: ImageIcon,
}

// What a BATCH of operations is called. One operation carries its own name, which
// names the path it cuts; a batch cut several, so it is named for the kind of cut.
const OP_TYPE_NAMES: Record<string, string> = {
  profile: 'Profile', trochoidal: 'Trochoidal', pocket: 'Pocket', drill: 'Drill',
  surface: 'Surface', vcarve: 'V-Carve', inlay: 'Inlay', profile3d: '3D Profile',
  gcode: 'G-code', photovcarve: 'Photo V-Carve',
}

const FAMILY_STYLE: Record<ObjectChip['family'], string> = {
  path: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/40',
  clock: 'bg-teal-500/15 text-teal-600 dark:text-teal-400 border-teal-500/40',
  // Tabs and corner treatments belong TO a path — they follow it in the strip
  // and share a colour, so they read as attached rather than as things of their
  // own. They are still chips, because each carries parameters worth reopening.
  attached: 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/40',
  op: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/40',
}

interface ObjectChip {
  key: string
  label: string
  Icon: ChipIcon
  color?: string
  family: 'path' | 'clock' | 'attached' | 'op'
  /** Paths this chip stands for — a whole group, or one loose path. */
  pathIds: string[]
  /** Operations this chip stands for — a whole batch, or one lone operation. */
  opIds?: string[]
  clockId?: string
  /** Which machine form this chip reopens, for the ones attached to a path. */
  form?: 'tabs' | 'nodeedit'
  /** The generated path whose form this chip reopens, if it has one. */
  editPathId?: string
}

// How a path is drawn and named in the strip, matching how the same thing is
// drawn elsewhere in the app.
function pathVisual(p: ImportedPath): { label: string; Icon: ChipIcon; color?: string } {
  const def = p.definition
  if (def) {
    if (def.kind === 'boolean') return { label: 'Boolean', Icon: SquaresUnite, color: OP_TYPE_COLORS.boolean }
    if (def.kind === 'offset') return { label: 'Offset', Icon: SquareSquare, color: OP_TYPE_COLORS.offset }
    if (def.kind === 'pattern') return { label: 'Pattern', Icon: LayoutGrid, color: OP_TYPE_COLORS.pattern }
    if (def.kind === 'duplicate') return { label: p.name, Icon: Copy }
  }
  if (p.shapeParams) {
    return {
      label: p.groupName ?? shapeDisplayName(p.shapeParams.type),
      Icon: SHAPE_ICONS[p.shapeParams.type] ?? Shapes,
    }
  }
  if (p.imageSrc) return { label: p.name, Icon: ImageIcon }
  if (p.groupName) return { label: p.groupName, Icon: Import }
  if (p.id.startsWith('pen')) return { label: p.name, Icon: PenTool }
  return { label: p.name, Icon: Shapes }
}

// One chip per object, in document order, then one per operation in PROGRAM
// order. A group — a multi-part shape, an SVG import — is ONE chip: it is one
// thing to the user, and its parts are what the paths list is for.
export function buildChips(paths: ImportedPath[], ops: AnyOperation[], tabs: Tab[] = []): ObjectChip[] {
  const out: ObjectChip[] = []
  const seenGroup = new Set<string>()
  const seenClock = new Set<string>()
  const seenDef = new Set<string>()
  const seenUserGroup = new Set<string>()

  for (const p of paths) {
    // A clock gets a chip of its own, at the position of its first part, which
    // reopens the designer on the spec every part carries. Its five wheels keep
    // their own chips too — each is a separately editable shape.
    if (p.clockId && !seenClock.has(p.clockId)) {
      seenClock.add(p.clockId)
      out.push({ key: `clock:${p.clockId}`, label: 'Clock', Icon: Clock, family: 'clock', pathIds: [], clockId: p.clockId })
    }
    // A user group is ONE thing — that is what grouping means — so it is one
    // chip standing for every member, at the position of the first. Its members'
    // own chips go while it lasts and come back when it is ungrouped.
    const ugroup = outerGroupOf(p)
    if (ugroup) {
      if (seenUserGroup.has(ugroup)) continue
      seenUserGroup.add(ugroup)
      // The OUTERMOST group only: an inner one is not a thing on its own until
      // the outer is ungrouped, at which point its chip appears.
      const members = paths.filter((q) => outerGroupOf(q) === ugroup)
      out.push({
        key: `ugroup:${ugroup}`, label: `Group \u00d7${members.length}`, Icon: Group,
        family: 'path', pathIds: members.map((m) => m.id),
      })
      for (const m of members) out.push(...attachedChips(m, tabs))
      continue
    }
    if (p.groupId) {
      if (seenGroup.has(p.groupId)) continue
      seenGroup.add(p.groupId)
      const members = paths.filter((q) => q.groupId === p.groupId)
      const editable = members.find((m) => m.definition && m.definition.kind !== 'duplicate')
      out.push({ key: p.groupId, ...pathVisual(p), family: 'path', pathIds: members.map((m) => m.id), editPathId: editable?.id })
      for (const m of members) out.push(...attachedChips(m, tabs))
    } else if (defGroupId(p)) {
      // ONE CHIP PER GENERATOR CLICK, for the same reason a batch of operations
      // gets one: a pattern of six copies, or an offset of four selected paths,
      // is ONE set of parameters to go back and change — and the form edits the
      // whole set through the definition id every copy shares. Six chips said
      // there were six patterns to edit. A DUPLICATE is deliberately not grouped
      // (`defGroupId` excludes it): a copy is its own object from the moment it
      // is made, with no form behind it.
      const defId = defGroupId(p)!
      if (seenDef.has(defId)) continue
      seenDef.add(defId)
      const members = paths.filter((q) => defGroupId(q) === defId)
      const vis = pathVisual(p)
      out.push({
        key: `def:${defId}`, ...vis,
        label: members.length === 1 ? vis.label : `${vis.label} \u00d7${members.length}`,
        family: 'path', pathIds: members.map((m) => m.id), editPathId: p.id,
      })
      for (const m of members) out.push(...attachedChips(m, tabs))
    } else {
      out.push({
        key: p.id, ...pathVisual(p), family: 'path', pathIds: [p.id],
        editPathId: undefined,
      })
      out.push(...attachedChips(p, tabs))
    }
  }

  // ONE CHIP PER GENERATE CLICK, not per operation. Profiling five selected paths
  // makes five operations — the program has to say so, since each is its own run of
  // the tool — but it was ONE decision, and the forms already edit the whole batch
  // through `batchOf`. Five chips said otherwise: they read as five things to go and
  // change the depth on. Grouped exactly as `batchOf` groups (batchId AND type, so a
  // chip never spans two kinds of form), and drawn at the first member's position.
  const seenBatch = new Set<string>()
  for (const op of ops) {
    const batchKey = op.batchId ? `${op.batchId}:${op.type}` : null
    if (!batchKey) {
      out.push({
        key: op.id, label: op.name, Icon: OP_ICONS[op.type] ?? Wrench,
        color: OP_TYPE_COLORS[op.type], family: 'op', pathIds: [], opIds: [op.id],
      })
      continue
    }
    if (seenBatch.has(batchKey)) continue
    seenBatch.add(batchKey)
    const members = ops.filter((o) => o.batchId === op.batchId && o.type === op.type)
    out.push({
      key: `batch:${batchKey}`,
      label: members.length === 1 ? op.name : `${OP_TYPE_NAMES[op.type] ?? op.type} ×${members.length}`,
      Icon: OP_ICONS[op.type] ?? Wrench,
      color: OP_TYPE_COLORS[op.type], family: 'op', pathIds: [],
      opIds: members.map((o) => o.id),
    })
  }
  return out
}

// The paths ONE generator call produced share their definition's id (see
// ImportedPath.definition), which is exactly what a form's edit mode re-runs
// over — so they are one chip. A duplicate is excluded: it carries a definition
// only to record where it came from, and has no form to reopen.
function defGroupId(p: ImportedPath): string | null {
  const def = p.definition
  return def && def.kind !== 'duplicate' ? def.id : null
}

// What is attached to one path: its holding tabs, its corner treatments. Each
// sits straight after the path it belongs to, so the strip reads as the thing
// and then what has been done to it.
function attachedChips(p: ImportedPath, tabs: Tab[]): ObjectChip[] {
  const out: ObjectChip[] = []
  const n = tabs.filter((t) => t.pathId === p.id).length
  if (n > 0) out.push({
    key: `tabs:${p.id}`, label: n === 1 ? 'Tab' : `Tabs ×${n}`, Icon: RectangleEllipsis,
    color: OP_TYPE_COLORS.tabs, family: 'attached', pathIds: [p.id], form: 'tabs',
  })
  const t = p.corners?.treatments.length ?? 0
  if (t > 0) out.push({
    key: `corners:${p.id}`, label: t === 1 ? 'Corner' : `Corners ×${t}`, Icon: VectorSquare,
    family: 'attached', pathIds: [p.id], form: 'nodeedit',
  })
  return out
}

function Chip({ chip, selected, compact, onDelete }: {
  chip: ObjectChip
  selected: boolean
  compact: boolean
  onDelete: (() => void) | null
}) {
  const { Icon, color } = chip
  return (
    <div
      data-key={chip.key}
      title={chip.label}
      className={[
        'group relative flex items-center gap-1 px-1.5 h-6 rounded border text-[13px] whitespace-nowrap flex-shrink-0',
        FAMILY_STYLE[chip.family],
        selected ? 'ring-2 ring-blue-500' : '',
      ].join(' ')}
    >
      <Icon size={12} style={color ? { color } : undefined} />
      {!compact && <span className="max-w-[110px] truncate">{chip.label}</span>}
      {/* Deleting a chip now means deleting the THING — coherent in a way that
          removing one event from a history never was. Overlays the chip's right
          edge on hover so the layout never shifts. */}
      {onDelete && <button
        title={`Delete ${chip.label}`}
        onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); onDelete() }}
        className="absolute -top-1.5 -right-1.5 z-10 hidden group-hover:flex items-center justify-center w-4 h-4 rounded-full shadow-sm border border-gray-400 dark:border-neutral-400 bg-white dark:bg-neutral-800 text-gray-800 dark:text-neutral-100 hover:text-white hover:bg-red-500 hover:border-red-500"
      >
        <X size={10} />
      </button>}
    </div>
  )
}

export default function TimelinePanel() {
  const paths = usePathsStore((s) => s.paths)
  const selectedIds = usePathsStore((s) => s.selectedIds)
  const operations = useToolpathStore((s) => s.operations)
  const tabs = useTabStore((s) => s.tabs)
  const timelineOpen = useUIStore((s) => s.timelineOpen)
  const setTimelineOpen = useUIStore((s) => s.setTimelineOpen)

  const chips = useMemo(() => buildChips(paths, operations, tabs), [paths, operations, tabs])

  const stripRef = useRef<HTMLDivElement>(null)
  const [stripW, setStripW] = useState(0)

  // Track the strip's width so chips can drop their labels before overflowing
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const ro = new ResizeObserver(() => setStripW(strip.clientWidth))
    ro.observe(strip)
    setStripW(strip.clientWidth)
    return () => ro.disconnect()
  }, [timelineOpen])

  // Estimate the width of fully-labeled chips; when they wouldn't fit, ALL chips
  // collapse to icon-only (labels stay in the tooltips). Estimation (13px font ≈
  // 6.8px/char, labels truncate at 110px) rather than measurement keeps this
  // deterministic — no render-measure-rerender loop, no flip-flop at the boundary.
  const labeledW = chips.reduce((w, c) => w + 34 + Math.min(110, c.label.length * 6.8), 8)
  const compact = stripW > 0 && labeledW > stripW

  // Keep the newest chip in view as objects are added
  useEffect(() => {
    const strip = stripRef.current
    if (strip) strip.scrollLeft = strip.scrollWidth
  }, [chips.length])

  const chipAtX = (clientX: number): ObjectChip | null => {
    const strip = stripRef.current
    if (!strip) return null
    let best: string | null = null
    let bestDist = Infinity
    for (const el of strip.querySelectorAll<HTMLElement>('[data-key]')) {
      const r = el.getBoundingClientRect()
      if (clientX >= r.left && clientX <= r.right) { best = el.dataset.key!; bestDist = 0; break }
      const d = clientX < r.left ? r.left - clientX : clientX - r.right
      if (d < bestDist) { bestDist = d; best = el.dataset.key! }
    }
    return chips.find((c) => c.key === best) ?? null
  }

  // True when the pointer is over the strip's horizontal scrollbar (the area
  // below clientHeight) — those clicks must scroll, not select.
  const onScrollbar = (e: React.MouseEvent): boolean => {
    const strip = stripRef.current
    if (!strip) return false
    return e.clientY - strip.getBoundingClientRect().top > strip.clientHeight
  }

  // Clicking a chip selects the thing and opens the editor that made it. It does
  // NOT move the undo cursor: when adjusting an earlier object you want the
  // later ones still on screen as reference, and rewinding hid exactly those.
  const onStripMouseDown = (e: React.MouseEvent) => {
    if (onScrollbar(e)) return
    e.preventDefault()
    const chip = chipAtX(e.clientX)
    if (!chip) return
    const ui = useUIStore.getState()
    // Clear the draw tab first, whatever the chip turns out to be — then exactly
    // one branch below opens what that chip edits. Closing them one at a time at
    // each branch is what let the clock designer stay open over another chip.
    ui.closeDrawPanels()
    ui.setSidebarTab('draw')

    if (chip.opIds) {
      // Any member opens the form; it edits the whole batch through `batchOf`.
      ui.setRequestEditOpId(chip.opIds[0])
      return
    }
    if (chip.clockId) {
      // Reopens the designer on the spec the clock's parts carry, so a different
      // beat or tooth count can be tried on the SAME clock.
      ui.setClockEdit(chip.clockId)
      ui.setClockPanelOpen(true)
      return
    }
    usePathsStore.getState().setSelectedIds(chip.pathIds)
    if (chip.form) {
      // Tabs and Corners edit the SELECTION, which the line above just set.
      ui.setRequestMachineForm(chip.form)
      return
    }
    if (chip.editPathId) {
      // A generated path (offset/pattern/boolean) reopens its generator form in
      // edit mode — change the parameters and the result is reworked in place.
      ui.setRequestEditPathId(chip.editPathId)
      return
    }
    // Everything else is edited in the properties panel — flash it so it is easy
    // to find.
    ui.flashProperties()
  }

  const deleterFor = (chip: ObjectChip): (() => void) | null => {
    // Deleting a batch chip deletes the whole batch — it is the one thing the chip
    // stands for, and one Generate click is what put all of it there.
    if (chip.opIds) return () => useToolpathStore.getState().deleteOperations(chip.opIds!)
    // A clock is five separate shapes; deleting it from one chip would be a much
    // bigger action than the chip looks, so it is left to the parts.
    if (chip.clockId) return null
    // Deleting an attached chip removes what it stands for, not the path: the
    // tabs go, or the corner treatments are undone back to the sharp outline.
    // Both change what the machine would cut, so both regenerate — every edit
    // site owes its toolpaths that.
    if (chip.form === 'tabs') return () => {
      useTabStore.getState().deletePathTabs(chip.pathIds[0])
      regenerateAffected(chip.pathIds[0])
    }
    if (chip.form === 'nodeedit') return () => {
      clearCorners(chip.pathIds[0])
      regenerateAffected(chip.pathIds[0])
    }
    return () => usePathsStore.getState().applyPathEdit({ deleteIds: chip.pathIds, label: `Delete ${chip.label}` })
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
      <div className="border-t border-gray-300 dark:border-neutral-700 bg-gray-200 dark:bg-neutral-800 flex-shrink-0 select-none">
        <button
          className="flex items-center gap-1 px-2 h-7 text-[13px] text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200"
          onClick={() => setTimelineOpen(true)}
          title="Show objects"
        >
          <ChevronUp size={13} />
          Objects{chips.length > 0 ? ` · ${chips.length}` : ''}
        </button>
      </div>
    )
  }

  const btnCls = 'p-1 rounded text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 hover:bg-gray-300 dark:hover:bg-neutral-700 disabled:opacity-30 disabled:pointer-events-none'
  const selSet = new Set(selectedIds)

  return (
    <div className="border-t border-gray-300 dark:border-neutral-700 bg-gray-200 dark:bg-neutral-800 flex-shrink-0 select-none">
      <div className="flex items-center h-14 px-2 gap-1">
        <BottomTabs />
        {/* Mouse handling lives on the container so any point over the strip's
            full height targets the chip at that x position */}
        <div
          ref={stripRef}
          onMouseDown={onStripMouseDown}
          onWheel={onStripWheel}
          className="timeline-strip flex-1 flex items-center gap-1 overflow-x-auto px-1 min-w-0 h-full cursor-pointer"
        >
          {chips.length === 0 && (
            <span className="ml-1.5 text-[13px] text-gray-400 dark:text-neutral-500">
              Nothing yet — draw or import a path and it appears here.
            </span>
          )}
          {chips.map((chip) => (
            <Chip
              key={chip.key}
              chip={chip}
              selected={chip.pathIds.length > 0 && chip.pathIds.every((id) => selSet.has(id))}
              compact={compact}
              onDelete={deleterFor(chip)}
            />
          ))}
        </div>

        <span className="text-[13px] text-gray-500 dark:text-neutral-400 font-mono px-1 flex-shrink-0">
          {chips.length}
        </span>
        <button className={btnCls} title="Hide objects" onClick={() => setTimelineOpen(false)}>
          <ChevronDown size={14} />
        </button>
      </div>
    </div>
  )
}
