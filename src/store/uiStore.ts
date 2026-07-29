import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_SHAPE_CONFIG, type ShapeToolConfig, type ShapeType } from '../shapes/shapeGenerators'
import type { PenCurveType } from '../cam/penCurves'


export type SidebarTab = 'draw' | 'paths'
type StatusKind = 'info' | 'warn' | 'error'

// Transient message shown in the StatusBar (import failures, sim warnings, …).
// `seq` bumps on every showStatus so an identical repeated message still
// restarts the auto-dismiss timer.
interface StatusMessage {
  text: string
  kind: StatusKind
  seq: number
}
export type WorkspaceTab = '2d' | '3d' | 'tools' | 'postprocessor'
type ActiveTool = 'select' | 'drill' | 'pen' | ShapeType

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
  // Corner-pick mode for the Corner Treatment form: while non-null, treatable
  // corners render as clickable markers; selectedCorners holds the node indices
  // the treatment applies to (empty = all corners). Markers come from
  // cornerPickBaseD — a snapshot of the path taken when the session started —
  // so corners stay pickable after a treatment replaces their geometry;
  // treatedCorners marks which of them currently carry a treatment.
  cornerPickPathId: string | null
  cornerPickBaseD: string | null
  selectedCorners: number[]
  treatedCorners: number[]
  darkMode: boolean
  machineFormActive: boolean
  tabsFormActive: boolean
  shapesPanelOpen: boolean
  setupPanelOpen: boolean
  helpOpen: boolean
  timelineOpen: boolean
  // Which strip the bottom bar shows: history (timeline) or the ordered program
  // (operations). They are different orderings of different things — see OperationsPanel.
  bottomTab: 'timeline' | 'operations'
  // Ask MachinePanel to open an operation's edit form (set by TimelinePanel
  // when an op chip is clicked, consumed + cleared by MachinePanel).
  requestEditOpId: string | null
  // Ask MachinePanel to open a generator form (boolean/offset/pattern) in edit
  // mode for a timeline event (by event id — seqs shift under inserts/removals).
  requestEditEventId: string | null
  // Ask MachinePanel to open a specific form (timeline tabs/corner chips —
  // those forms edit the current selection, which the chip click sets).
  requestMachineForm: string | null
  // Bumped when a path chip is clicked so PropertiesPanel briefly highlights —
  // it's the editor for the chip's shape/text parameters.
  propertiesFlashSeq: number
  // Set by a timeline chip click for a move/scale/rotate/skew/mirror (or
  // merged 'transform') paths.edit event: PropertiesPanel shows that event's
  // recorded TransformStep values (editable) instead of the selection's
  // plain shape/position fields. PropertiesPanel itself clears this back to
  // null once the timeline cursor or selection no longer matches the event
  // (scrubbing away, selecting something else, recording a new edit).
  transformEditEventId: string | null
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
  setTimelineOpen: (open: boolean) => void
  setBottomTab: (tab: 'timeline' | 'operations') => void
  setRequestEditOpId: (id: string | null) => void
  setRequestEditEventId: (id: string | null) => void
  setTransformEditEventId: (id: string | null) => void
  setRequestMachineForm: (form: string | null) => void
  flashProperties: () => void
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
  setCornerPickSession: (id: string | null, baseD: string | null) => void
  setTreatedCorners: (idxs: number[]) => void
  toggleCorner: (idx: number) => void
  clearSelectedCorners: () => void
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
  cornerPickPathId: null,
  cornerPickBaseD: null,
  selectedCorners: [],
  treatedCorners: [],
  darkMode: true,
  machineFormActive: false,
  tabsFormActive: false,
  shapesPanelOpen: false,
  setupPanelOpen: false,
  helpOpen: false,
  timelineOpen: true,
  bottomTab: 'timeline' as const,
  requestEditOpId: null,
  requestEditEventId: null,
  requestMachineForm: null,
  propertiesFlashSeq: 0,
  transformEditEventId: null,
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
  setTimelineOpen: (open) => set({ timelineOpen: open }),
  setBottomTab: (tab) => set({ bottomTab: tab }),
  setRequestEditOpId: (id) => set({ requestEditOpId: id }),
  setRequestEditEventId: (id) => set({ requestEditEventId: id }),
  setTransformEditEventId: (id) => set({ transformEditEventId: id }),
  setRequestMachineForm: (form) => set({ requestMachineForm: form }),
  flashProperties: () => set((s) => ({ propertiesFlashSeq: s.propertiesFlashSeq + 1 })),
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
  setCornerPickSession: (id, baseD) =>
    set({ cornerPickPathId: id, cornerPickBaseD: baseD, selectedCorners: [], treatedCorners: [] }),
  setTreatedCorners: (idxs) => set({ treatedCorners: idxs }),
  toggleCorner: (idx) =>
    set((s) => ({
      selectedCorners: s.selectedCorners.includes(idx)
        ? s.selectedCorners.filter((i) => i !== idx)
        : [...s.selectedCorners, idx],
    })),
  clearSelectedCorners: () => set({ selectedCorners: [] }),
  toggleDarkMode: () => set((s) => ({ darkMode: !s.darkMode })),
  setNodeEditUndoRedo: (undo, redo) => set({ nodeEditUndo: undo, nodeEditRedo: redo, nodeEditCanUndo: false, nodeEditCanRedo: false }),
  setNodeEditHistoryFlags: (canUndo, canRedo) => set({ nodeEditCanUndo: canUndo, nodeEditCanRedo: canRedo }),
    }),
    {
      name: 'freazykam-ui',
      partialize: (s) => ({ penCurveType: s.penCurveType, lastShapeType: s.lastShapeType, timelineOpen: s.timelineOpen, bottomTab: s.bottomTab }),
    }
  )
)
