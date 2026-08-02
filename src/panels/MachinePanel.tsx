import { ProfileForm, TrochoidalForm, PocketForm, DrillForm, VCarveForm, PhotoVCarveForm, InlayForm, Profile3dForm, SurfaceForm, BooleanForm, OffsetForm, PatternForm, TabsForm, NodeEditForm } from './machine'
import { useState, useEffect } from 'react'
import { useToolpathStore } from '../store/toolpathStore'
import { useTimelineStore } from '../timeline/timelineStore'
import type { BooleanEditCtx } from './machine/BooleanForm'
import type { OffsetEditCtx } from './machine/OffsetForm'
import type { PatternEditCtx } from './machine/PatternForm'
import { OP_TYPE_COLORS } from '../colors'
import { ICON } from '../theme'
import { Circle, CircleDot, Target, Layers, Star, SquaresUnite, SquareSquare, LayoutGrid, RectangleEllipsis, VectorSquare, Box, RefreshCw, Image as ImageIcon } from 'lucide-react'
import { useUIStore } from '../store/uiStore'

// Exported for reuse (TimelinePanel chips use the same per-op icons as this menu)
export const InlayIcon = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 1h20a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-6v2H8V8H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z" />
    <path d="M2 14h6v2h8v-2h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" />
  </svg>
)

// ─── Operation type selector ──────────────────────────────────────────────────

type OpType = 'profile' | 'trochoidal' | 'pocket' | 'drill' | 'surface' | 'vcarve' | 'photovcarve' | 'inlay' | 'profile3d' | 'boolean' | 'offset' | 'pattern' | 'tabs' | 'nodeedit'
type FormState = null | 'menu' | OpType

const opBtnCls = 'flex flex-col items-center gap-0.5 py-1.5 rounded text-body transition-colors border border-gray-200 dark:border-neutral-600 hover:border-gray-300 dark:hover:border-neutral-500'

function AddOperationMenu({ onSelect }: { onSelect: (t: OpType) => void }) {
  return (
    <div className="px-3 py-2 space-y-2 border-b border-gray-300 dark:border-neutral-700">
      <p className="text-label font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider">CAM Operations</p>
      <div className="grid grid-cols-3 gap-1">
        {([
          ['profile', 'Profile', 'Cut along path edge', <Circle size={ICON.md} />],
          ['trochoidal', 'Trochoidal', 'Looping cuts along path — reduces engagement, ideal for hard materials', <RefreshCw size={ICON.md} />],
          ['pocket', 'Pocket', 'Clear inside boundary', <Target size={ICON.md} />],
          ['drill', 'Drill', 'Peck or helical drill', <CircleDot size={ICON.md} />],
          ['surface', 'Surface', 'Flatten workpiece top', <Layers size={ICON.md} />],
          ['vcarve', 'V-Carve', 'V-bit depth-varying carve', <Star size={ICON.md} />],
          ['photovcarve', 'Photo V-Carve', 'Raster a photo as V-grooves — dark areas cut deeper', <ImageIcon size={ICON.md} />],
          ['inlay', 'Inlay', 'V-carved sloped walls with flat pocket bottom', <InlayIcon size={ICON.md} />],
          ['profile3d', '3D Profile', 'Follow STL relief surface with ball nose', <Box size={ICON.md} />],
        ] as [OpType, string, string, React.ReactNode][]).map(([type, name, desc, icon]) => (
          <button key={type} onClick={() => onSelect(type)} title={desc} className={opBtnCls}>
            <span style={{ color: OP_TYPE_COLORS[type] }}>{icon}</span>
            <span className="text-label text-gray-500 dark:text-neutral-400">{name}</span>
          </button>
        ))}
      </div>
      <p className="text-label font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider">Path Tools</p>
      <div className="grid grid-cols-3 gap-1">
        {([
          ['boolean', 'Boolean', 'Union, intersect, or subtract paths', <SquaresUnite size={ICON.md} />],
          ['offset', 'Offset', 'Inset or outset path by distance', <SquareSquare size={ICON.md} />],
          ['pattern', 'Pattern', 'Linear or circular array', <LayoutGrid size={ICON.md} />],
          ['tabs', 'Tabs', 'Add holding tabs to keep part from moving', <RectangleEllipsis size={ICON.md} />],
          ['nodeedit', 'Corners', 'Apply corner treatments: round, chamfer, dogbone', <VectorSquare size={ICON.md} />],
        ] as [OpType, string, string, React.ReactNode][]).map(([type, name, desc, icon]) => (
          <button key={type} onClick={() => onSelect(type)} title={desc} className={opBtnCls}>
            <span style={{ color: OP_TYPE_COLORS[type as string] ?? '#94a3b8' }}>{icon}</span>
            <span className="text-label text-gray-500 dark:text-neutral-400">{name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export default function MachinePanel({ fill = false }: { fill?: boolean }) {
  const { machineFormActive, setMachineFormActive, setActiveTool, setTabsFormActive } = useUIStore()
  const [activeForm, setActiveForm] = useState<FormState>('menu')
  // Editing an EXISTING operation in this panel (timeline op-chip click):
  // the matching form opens with editOp so its parameters can be amended.
  const [editOpId, setEditOpId] = useState<string | null>(null)
  const editOp = useToolpathStore((s) => s.operations.find((o) => o.id === editOpId)) ?? null

  useEffect(() => () => { setMachineFormActive(false); setTabsFormActive(false) }, [setMachineFormActive, setTabsFormActive])
  useEffect(() => { setTabsFormActive(activeForm === 'tabs') }, [activeForm, setTabsFormActive])
  // Editing an EXISTING generator chip (boolean/offset/pattern): the form
  // opens with the event's inputs and amends the chip on apply.
  const [editBool, setEditBool] = useState<BooleanEditCtx | null>(null)
  const [editOffset, setEditOffset] = useState<OffsetEditCtx | null>(null)
  const [editPattern, setEditPattern] = useState<PatternEditCtx | null>(null)
  const clearEditCtx = () => { setEditOpId(null); setEditBool(null); setEditOffset(null); setEditPattern(null) }

  useEffect(() => () => { setMachineFormActive(false); setTabsFormActive(false) }, [setMachineFormActive, setTabsFormActive])
  useEffect(() => { setTabsFormActive(activeForm === 'tabs') }, [activeForm, setTabsFormActive])
  useEffect(() => { if (!machineFormActive) { setActiveForm('menu'); clearEditCtx() } }, [machineFormActive]) // eslint-disable-line react-hooks/exhaustive-deps

  const startForm = (t: FormState) => {
    setActiveForm(t)
    setMachineFormActive(true)
    setActiveTool('select')
  }

  // Consume "open this op's edit form" requests (timeline op-chip clicks)
  const requestEditOpId = useUIStore((s) => s.requestEditOpId)
  useEffect(() => {
    if (!requestEditOpId) return
    useUIStore.getState().setRequestEditOpId(null)
    const op = useToolpathStore.getState().operations.find((o) => o.id === requestEditOpId)
    if (!op || op.type === 'gcode') return // imported G-code has no editable form
    clearEditCtx()
    setEditOpId(op.id)
    startForm(op.type as FormState)
  }, [requestEditOpId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Consume "edit this generator chip" requests (boolean/offset/pattern chips)
  const requestEditEventId = useUIStore((s) => s.requestEditEventId)
  useEffect(() => {
    if (!requestEditEventId) return
    useUIStore.getState().setRequestEditEventId(null)
    const ev = useTimelineStore.getState().events.find((e) => e.id === requestEditEventId)
    if (!ev) return
    clearEditCtx()
    if (ev.kind === 'paths.edit' && ev.add?.length) {
      setEditBool({
        eventId: ev.id,
        opType: ev.boolOp ?? 'union',
        sourceIds: ev.updates.map((u) => u.id),
        resultId: ev.add[0].id,
      })
      startForm('boolean')
    } else if (ev.kind === 'paths.add' && ev.offset) {
      setEditOffset({ eventId: ev.id, ...ev.offset })
      startForm('offset')
    } else if (ev.kind === 'paths.add' && ev.pattern) {
      setEditPattern({ eventId: ev.id, resultIds: ev.paths.map((p) => p.id), ...ev.pattern })
      startForm('pattern')
    }
  }, [requestEditEventId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Consume "open this form" requests (timeline tabs/corner chips — the chip
  // click already selected the relevant path; these forms edit the selection)
  const requestMachineForm = useUIStore((s) => s.requestMachineForm)
  useEffect(() => {
    if (!requestMachineForm) return
    useUIStore.getState().setRequestMachineForm(null)
    clearEditCtx()
    startForm(requestMachineForm as FormState)
  }, [requestMachineForm]) // eslint-disable-line react-hooks/exhaustive-deps

  const openForm = (t: FormState) => { clearEditCtx(); startForm(t) }
  const closeForm = () => { clearEditCtx(); setActiveForm('menu'); setMachineFormActive(false) }

  return (
    <div className={fill ? 'flex-1 overflow-y-auto' : ''}>
      {activeForm === 'menu' ? (
        <AddOperationMenu onSelect={openForm} />
      ) : activeForm === 'profile' ? (
        <ProfileForm key={editOpId ?? 'new'} onClose={closeForm} editOp={editOp?.type === 'profile' ? editOp : undefined} />
      ) : activeForm === 'trochoidal' ? (
        <TrochoidalForm key={editOpId ?? 'new'} onClose={closeForm} editOp={editOp?.type === 'trochoidal' ? editOp : undefined} />
      ) : activeForm === 'pocket' ? (
        <PocketForm key={editOpId ?? 'new'} onClose={closeForm} editOp={editOp?.type === 'pocket' ? editOp : undefined} />
      ) : activeForm === 'drill' ? (
        <DrillForm key={editOpId ?? 'new'} onClose={closeForm} editOp={editOp?.type === 'drill' ? editOp : undefined} />
      ) : activeForm === 'profile3d' ? (
        <Profile3dForm key={editOpId ?? 'new'} onClose={closeForm} editOp={editOp?.type === 'profile3d' ? editOp : undefined} />
      ) : activeForm === 'surface' ? (
        <SurfaceForm key={editOpId ?? 'new'} onClose={closeForm} editOp={editOp?.type === 'surface' ? editOp : undefined} />
      ) : activeForm === 'vcarve' ? (
        <VCarveForm key={editOpId ?? 'new'} onClose={closeForm} editOp={editOp?.type === 'vcarve' ? editOp : undefined} />
      ) : activeForm === 'photovcarve' ? (
        <PhotoVCarveForm key={editOpId ?? 'new'} onClose={closeForm} editOp={editOp?.type === 'photovcarve' ? editOp : undefined} />
      ) : activeForm === 'inlay' ? (
        <InlayForm key={editOpId ?? 'new'} onClose={closeForm} editOp={editOp?.type === 'inlay' ? editOp : undefined} />
      ) : activeForm === 'boolean' ? (
        <BooleanForm key={editBool?.eventId ?? 'new'} onClose={closeForm} editCtx={editBool ?? undefined} />
      ) : activeForm === 'offset' ? (
        <OffsetForm key={editOffset?.eventId ?? 'new'} onClose={closeForm} editCtx={editOffset ?? undefined} />
      ) : activeForm === 'pattern' ? (
        <PatternForm key={editPattern?.eventId ?? 'new'} onClose={closeForm} editCtx={editPattern ?? undefined} />
      ) : activeForm === 'tabs' ? (
        <TabsForm onClose={closeForm} />
      ) : activeForm === 'nodeedit' ? (
        <NodeEditForm onClose={closeForm} />
      ) : null}
    </div>
  )
}
