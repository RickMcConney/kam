import { create } from 'zustand'
import { DEFAULT_SHAPE_CONFIG, type ShapeToolConfig, type ShapeType } from '../shapes/shapeGenerators'

export type SidebarTab = 'draw' | 'machine' | 'paths'
export type WorkspaceTab = '2d' | '3d' | 'tools'
export type ActiveTool = 'select' | 'drill' | ShapeType

interface UIState {
  sidebarTab: SidebarTab
  workspaceTab: WorkspaceTab
  snapEnabled: boolean
  activeTool: ActiveTool
  shapeToolConfig: ShapeToolConfig
  pendingDrillPoints: { x: number; y: number }[]
  setSidebarTab: (tab: SidebarTab) => void
  setWorkspaceTab: (tab: WorkspaceTab) => void
  toggleSnap: () => void
  setSnap: (enabled: boolean) => void
  setActiveTool: (tool: ActiveTool) => void
  setShapeToolConfig: (config: ShapeToolConfig) => void
  addDrillPoint: (pt: { x: number; y: number }) => void
  clearDrillPoints: () => void
}

export const useUIStore = create<UIState>()((set) => ({
  sidebarTab: 'draw',
  workspaceTab: '2d',
  snapEnabled: true,
  activeTool: 'select',
  shapeToolConfig: DEFAULT_SHAPE_CONFIG,
  pendingDrillPoints: [],
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  setWorkspaceTab: (tab) => set({ workspaceTab: tab }),
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
  setSnap: (enabled) => set({ snapEnabled: enabled }),
  setActiveTool: (tool) => set({ activeTool: tool }),
  setShapeToolConfig: (config) => set({ shapeToolConfig: config }),
  addDrillPoint: (pt) => set((s) => ({ pendingDrillPoints: [...s.pendingDrillPoints, pt] })),
  clearDrillPoints: () => set({ pendingDrillPoints: [] }),
}))
