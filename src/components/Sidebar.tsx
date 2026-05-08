import { Pencil, Cpu, Layers } from 'lucide-react'
import { ICON } from '../theme'
import { useUIStore, type SidebarTab } from '../store/uiStore'
import { usePathsStore } from '../store/pathsStore'
import WorkpiecePanel from '../panels/WorkpiecePanel'
import PathsPanel from '../panels/PathsPanel'
import MachinePanel from '../panels/MachinePanel'
import PropertiesPanel from '../panels/PropertiesPanel'
import ShapePanel from '../panels/draw/ShapePanel'

const TABS: { id: SidebarTab; label: string; icon: React.ReactNode }[] = [
  { id: 'draw', label: 'Draw', icon: <Pencil size={ICON.md} /> },
  { id: 'machine', label: 'Machine', icon: <Cpu size={ICON.md} /> },
  { id: 'paths', label: 'Paths', icon: <Layers size={ICON.md} /> },
]

function TabContent({ tab }: { tab: SidebarTab }) {
  if (tab === 'draw') return <><ShapePanel /><WorkpiecePanel /></>
  if (tab === 'machine') return <MachinePanel />
  return <PathsPanel />
}

export default function Sidebar() {
  const { sidebarTab, setSidebarTab } = useUIStore()
  const selectedIds = usePathsStore((s) => s.selectedIds)

  return (
    <div className="w-72 bg-gray-100 dark:bg-neutral-800 border-r border-gray-300 dark:border-neutral-700 flex flex-col flex-shrink-0 overflow-hidden">
      {/* Tab bar */}
      <div className="flex border-b border-gray-300 dark:border-neutral-700 flex-shrink-0">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setSidebarTab(tab.id)}
            title={tab.label}
            className={[
              'flex-1 flex flex-col items-center gap-0.5 py-2 text-body transition-colors border-b-2',
              sidebarTab === tab.id
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200',
            ].join(' ')}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        <TabContent tab={sidebarTab} />
      </div>

      {/* Properties panel — shown when paths are selected */}
      {selectedIds.length > 0 && <PropertiesPanel />}
    </div>
  )
}
