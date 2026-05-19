import { create } from 'zustand'
import { DEFAULT_SHAPE_CONFIG, type ShapeToolConfig, type ShapeType } from '../shapes/shapeGenerators'

export type SidebarTab = 'draw' | 'paths'
export type WorkspaceTab = '2d' | '3d' | 'tools' | 'postprocessor' | 'setup'
export type ActiveTool = 'select' | 'drill' | 'pen' | ShapeType

export type PenNode = {
  x: number
  y: number
  outHandle?: { x: number; y: number }
  inHandle?: { x: number; y: number }
}

interface UIState {
  sidebarTab: SidebarTab
  workspaceTab: WorkspaceTab
  snapEnabled: boolean
  activeTool: ActiveTool
  shapeToolConfig: ShapeToolConfig
  pendingDrillPoints: { x: number; y: number }[]
  penNodes: PenNode[]
  nodeEditPathId: string | null
  darkMode: boolean
  machineFormActive: boolean
  tabsFormActive: boolean
  shapesPanelOpen: boolean
  helpOpen: boolean
  // Local undo/redo for point-edit sessions — registered by CanvasStage, used by Toolbar + App
  nodeEditUndo: (() => void) | null
  nodeEditRedo: (() => void) | null
  nodeEditCanUndo: boolean
  nodeEditCanRedo: boolean
  setMachineFormActive: (active: boolean) => void
  setTabsFormActive: (active: boolean) => void
  setShapesPanelOpen: (open: boolean) => void
  setHelpOpen: (open: boolean) => void
  setSidebarTab: (tab: SidebarTab) => void
  setWorkspaceTab: (tab: WorkspaceTab) => void
  toggleSnap: () => void
  setSnap: (enabled: boolean) => void
  setActiveTool: (tool: ActiveTool) => void
  setShapeToolConfig: (config: ShapeToolConfig) => void
  addDrillPoint: (pt: { x: number; y: number }) => void
  clearDrillPoints: () => void
  addPenNode: (node: PenNode) => void
  clearPenNodes: () => void
  setNodeEditPathId: (id: string | null) => void
  toggleDarkMode: () => void
  setNodeEditUndoRedo: (undo: (() => void) | null, redo: (() => void) | null) => void
  setNodeEditHistoryFlags: (canUndo: boolean, canRedo: boolean) => void
}

export const useUIStore = create<UIState>()((set) => ({
  sidebarTab: 'draw',
  workspaceTab: '2d',
  snapEnabled: true,
  activeTool: 'select',
  shapeToolConfig: DEFAULT_SHAPE_CONFIG,
  pendingDrillPoints: [],
  penNodes: [],
  nodeEditPathId: null,
  darkMode: true,
  machineFormActive: false,
  tabsFormActive: false,
  shapesPanelOpen: false,
  helpOpen: false,
  nodeEditUndo: null,
  nodeEditRedo: null,
  nodeEditCanUndo: false,
  nodeEditCanRedo: false,
  setMachineFormActive: (active) => set({ machineFormActive: active }),
  setTabsFormActive: (active) => set({ tabsFormActive: active }),
  setShapesPanelOpen: (open) => set({ shapesPanelOpen: open }),
  setHelpOpen: (open) => set({ helpOpen: open }),
  setSidebarTab: (tab) => set({ sidebarTab: tab, activeTool: 'select' }),
  setWorkspaceTab: (tab) => set({ workspaceTab: tab }),
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
  setSnap: (enabled) => set({ snapEnabled: enabled }),
  setActiveTool: (tool) => set({ activeTool: tool, nodeEditPathId: null }),
  setShapeToolConfig: (config) => set({ shapeToolConfig: config }),
  addDrillPoint: (pt) => set((s) => ({ pendingDrillPoints: [...s.pendingDrillPoints, pt] })),
  clearDrillPoints: () => set({ pendingDrillPoints: [] }),
  addPenNode: (node) => set((s) => ({ penNodes: [...s.penNodes, node] })),
  clearPenNodes: () => set({ penNodes: [] }),
  setNodeEditPathId: (id) => set({ nodeEditPathId: id }),
  toggleDarkMode: () => set((s) => ({ darkMode: !s.darkMode })),
  setNodeEditUndoRedo: (undo, redo) => set({ nodeEditUndo: undo, nodeEditRedo: redo, nodeEditCanUndo: false, nodeEditCanRedo: false }),
  setNodeEditHistoryFlags: (canUndo, canRedo) => set({ nodeEditCanUndo: canUndo, nodeEditCanRedo: canRedo }),
}))
