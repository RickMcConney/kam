import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_SHAPE_CONFIG, type ShapeToolConfig, type ShapeType } from '../shapes/shapeGenerators'
import type { PenCurveType } from '../cam/penCurves'

export type { PenCurveType }

export type SidebarTab = 'draw' | 'paths'
export type StatusKind = 'info' | 'warn' | 'error'

// Transient message shown in the StatusBar (import failures, sim warnings, …).
// `seq` bumps on every showStatus so an identical repeated message still
// restarts the auto-dismiss timer.
export interface StatusMessage {
  text: string
  kind: StatusKind
  seq: number
}
export type WorkspaceTab = '2d' | '3d' | 'tools' | 'postprocessor'
export type ActiveTool = 'select' | 'drill' | 'pen' | ShapeType

export type PenNode = {
  x: number
  y: number
  outHandle?: { x: number; y: number }
  inHandle?: { x: number; y: number }
  corner?: boolean
}

interface UIState {
  sidebarTab: SidebarTab
  workspaceTab: WorkspaceTab
  snapEnabled: boolean
  activeTool: ActiveTool
  shapeToolConfig: ShapeToolConfig
  lastShapeType: ShapeType
  pendingDrillPoints: { x: number; y: number }[]
  penNodes: PenNode[]
  penCurveType: PenCurveType
  nodeEditPathId: string | null
  darkMode: boolean
  machineFormActive: boolean
  tabsFormActive: boolean
  shapesPanelOpen: boolean
  setupPanelOpen: boolean
  helpOpen: boolean
  // Local undo/redo for point-edit sessions — registered by CanvasStage, used by Toolbar + App
  nodeEditUndo: (() => void) | null
  nodeEditRedo: (() => void) | null
  nodeEditCanUndo: boolean
  nodeEditCanRedo: boolean
  statusMessage: StatusMessage | null
  showStatus: (text: string, kind?: StatusKind) => void
  clearStatus: () => void
  // DXF file waiting on the units-prompt dialog (no $INSUNITS in the file).
  // Lives here so both import entry points (toolbar button, canvas drop) can
  // trigger the dialog; DxfUnitsDialog renders when non-null.
  pendingDxfImport: { text: string; name: string } | null
  setPendingDxfImport: (p: { text: string; name: string } | null) => void
  setMachineFormActive: (active: boolean) => void
  setTabsFormActive: (active: boolean) => void
  setShapesPanelOpen: (open: boolean) => void
  setSetupPanelOpen: (open: boolean) => void
  setHelpOpen: (open: boolean) => void
  setSidebarTab: (tab: SidebarTab) => void
  setWorkspaceTab: (tab: WorkspaceTab) => void
  toggleSnap: () => void
  setSnap: (enabled: boolean) => void
  setActiveTool: (tool: ActiveTool) => void
  setShapeToolConfig: (config: ShapeToolConfig) => void
  setLastShapeType: (type: ShapeType) => void
  addDrillPoint: (pt: { x: number; y: number }) => void
  setDrillPoints: (pts: { x: number; y: number }[]) => void
  clearDrillPoints: () => void
  setPenCurveType: (type: PenCurveType) => void
  addPenNode: (node: PenNode) => void
  setPenNodes: (nodes: PenNode[]) => void
  clearPenNodes: () => void
  setNodeEditPathId: (id: string | null) => void
  toggleDarkMode: () => void
  setNodeEditUndoRedo: (undo: (() => void) | null, redo: (() => void) | null) => void
  setNodeEditHistoryFlags: (canUndo: boolean, canRedo: boolean) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
  sidebarTab: 'draw',
  workspaceTab: '2d',
  snapEnabled: true,
  activeTool: 'select',
  shapeToolConfig: DEFAULT_SHAPE_CONFIG,
  lastShapeType: 'rectangle',
  pendingDrillPoints: [],
  penNodes: [],
  penCurveType: 'catmull-rom',
  nodeEditPathId: null,
  darkMode: true,
  machineFormActive: false,
  tabsFormActive: false,
  shapesPanelOpen: false,
  setupPanelOpen: false,
  helpOpen: false,
  nodeEditUndo: null,
  nodeEditRedo: null,
  nodeEditCanUndo: false,
  nodeEditCanRedo: false,
  statusMessage: null,
  showStatus: (text, kind = 'info') =>
    set((s) => ({ statusMessage: { text, kind, seq: (s.statusMessage?.seq ?? 0) + 1 } })),
  clearStatus: () => set({ statusMessage: null }),
  pendingDxfImport: null,
  setPendingDxfImport: (p) => set({ pendingDxfImport: p }),
  setMachineFormActive: (active) => set({ machineFormActive: active }),
  setTabsFormActive: (active) => set({ tabsFormActive: active }),
  setShapesPanelOpen: (open) => set({ shapesPanelOpen: open }),
  setSetupPanelOpen: (open) => set({ setupPanelOpen: open }),
  setHelpOpen: (open) => set({ helpOpen: open }),
  setSidebarTab: (tab) => set({ sidebarTab: tab, activeTool: 'select' }),
  setWorkspaceTab: (tab) => set({ workspaceTab: tab }),
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
  setSnap: (enabled) => set({ snapEnabled: enabled }),
  setActiveTool: (tool) => set({ activeTool: tool, nodeEditPathId: null }),
  setShapeToolConfig: (config) => set({ shapeToolConfig: config }),
  setLastShapeType: (type) => set({ lastShapeType: type }),
  addDrillPoint: (pt) => set((s) => ({ pendingDrillPoints: [...s.pendingDrillPoints, pt] })),
  setDrillPoints: (pts) => set({ pendingDrillPoints: pts }),
  clearDrillPoints: () => set({ pendingDrillPoints: [] }),
  setPenCurveType: (type) => set({ penCurveType: type }),
  addPenNode: (node) => set((s) => ({ penNodes: [...s.penNodes, node] })),
  setPenNodes: (nodes) => set({ penNodes: nodes }),
  clearPenNodes: () => set({ penNodes: [] }),
  setNodeEditPathId: (id) => set({ nodeEditPathId: id }),
  toggleDarkMode: () => set((s) => ({ darkMode: !s.darkMode })),
  setNodeEditUndoRedo: (undo, redo) => set({ nodeEditUndo: undo, nodeEditRedo: redo, nodeEditCanUndo: false, nodeEditCanRedo: false }),
  setNodeEditHistoryFlags: (canUndo, canRedo) => set({ nodeEditCanUndo: canUndo, nodeEditCanRedo: canRedo }),
    }),
    {
      name: 'freazykam-ui',
      partialize: (s) => ({ penCurveType: s.penCurveType, lastShapeType: s.lastShapeType }),
    }
  )
)
