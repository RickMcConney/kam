import { ProfileForm, TrochoidalForm, PocketForm, DrillForm, VCarveForm, InlayForm, Profile3dForm, SurfaceForm, BooleanForm, OffsetForm, PatternForm, TabsForm, NodeEditForm } from './machine'
import { useState, useEffect } from 'react'
import { OP_TYPE_COLORS } from '../colors'
import { ICON } from '../theme'
import { Circle, CircleDot, Target, Layers, Star, SquaresUnite, SquareSquare, LayoutGrid, RectangleEllipsis, VectorSquare, Box, RefreshCw } from 'lucide-react'
import { useUIStore } from '../store/uiStore'

const InlayIcon = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 1h20a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-6v2H8V8H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z" />
    <path d="M2 14h6v2h8v-2h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" />
  </svg>
)

// ─── Operation type selector ──────────────────────────────────────────────────

type OpType = 'profile' | 'trochoidal' | 'pocket' | 'drill' | 'surface' | 'vcarve' | 'inlay' | 'profile3d' | 'boolean' | 'offset' | 'pattern' | 'tabs' | 'nodeedit'
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

  useEffect(() => () => { setMachineFormActive(false); setTabsFormActive(false) }, [setMachineFormActive, setTabsFormActive])
  useEffect(() => { setTabsFormActive(activeForm === 'tabs') }, [activeForm, setTabsFormActive])
  useEffect(() => { if (!machineFormActive) setActiveForm('menu') }, [machineFormActive])

  const openForm = (t: FormState) => { setActiveForm(t); setMachineFormActive(true); setActiveTool('select') }
  const closeForm = () => { setActiveForm('menu'); setMachineFormActive(false) }

  return (
    <div className={fill ? 'flex-1 overflow-y-auto' : ''}>
      {activeForm === 'menu' ? (
        <AddOperationMenu onSelect={openForm} />
      ) : activeForm === 'profile' ? (
        <ProfileForm onClose={closeForm} />
      ) : activeForm === 'trochoidal' ? (
        <TrochoidalForm onClose={closeForm} />
      ) : activeForm === 'pocket' ? (
        <PocketForm onClose={closeForm} />
      ) : activeForm === 'drill' ? (
        <DrillForm onClose={closeForm} />
      ) : activeForm === 'profile3d' ? (
        <Profile3dForm onClose={closeForm} />
      ) : activeForm === 'surface' ? (
        <SurfaceForm onClose={closeForm} />
      ) : activeForm === 'vcarve' ? (
        <VCarveForm onClose={closeForm} />
      ) : activeForm === 'inlay' ? (
        <InlayForm onClose={closeForm} />
      ) : activeForm === 'boolean' ? (
        <BooleanForm onClose={closeForm} />
      ) : activeForm === 'offset' ? (
        <OffsetForm onClose={closeForm} />
      ) : activeForm === 'pattern' ? (
        <PatternForm onClose={closeForm} />
      ) : activeForm === 'tabs' ? (
        <TabsForm onClose={closeForm} />
      ) : activeForm === 'nodeedit' ? (
        <NodeEditForm onClose={closeForm} />
      ) : null}
    </div>
  )
}
