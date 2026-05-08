import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ToolType = 'endmill' | 'ballnose' | 'vbit' | 'drill'
export type CuttingDirection = 'climb' | 'conventional'

export interface Tool {
  id: string
  name: string
  type: ToolType
  diameterMM: number
  fluteCount: number
  rpm: number
  xyFeedMmMin: number
  zFeedMmMin: number
  stepDownMM: number
  maxDepthMM: number
  direction: CuttingDirection
}

const DEFAULT_TOOLS: Tool[] = [
  { id: 'default-1', name: '1/4" End Mill',   type: 'endmill',  diameterMM: 6.35,  fluteCount: 2, rpm: 18000, xyFeedMmMin: 2500, zFeedMmMin: 500, stepDownMM: 3.0, maxDepthMM: 25.0, direction: 'climb' },
  { id: 'default-2', name: '1/8" End Mill',   type: 'endmill',  diameterMM: 3.175, fluteCount: 2, rpm: 24000, xyFeedMmMin: 1500, zFeedMmMin: 300, stepDownMM: 1.5, maxDepthMM: 15.0, direction: 'climb' },
  { id: 'default-3', name: '60° V-Bit',       type: 'vbit',     diameterMM: 6.35,  fluteCount: 2, rpm: 18000, xyFeedMmMin: 2000, zFeedMmMin: 400, stepDownMM: 2.0, maxDepthMM: 10.0, direction: 'climb' },
  { id: 'default-4', name: '1/4" Ball Nose',  type: 'ballnose', diameterMM: 6.35,  fluteCount: 2, rpm: 18000, xyFeedMmMin: 2000, zFeedMmMin: 400, stepDownMM: 2.0, maxDepthMM: 20.0, direction: 'climb' },
  { id: 'default-5', name: '3mm Drill',       type: 'drill',    diameterMM: 3.0,   fluteCount: 2, rpm: 12000, xyFeedMmMin: 0,    zFeedMmMin: 200, stepDownMM: 3.0, maxDepthMM: 20.0, direction: 'climb' },
]

let _idCounter = 100

interface ToolState {
  tools: Tool[]
  selectedToolId: string | null
  addTool: () => void
  updateTool: (id: string, updates: Partial<Omit<Tool, 'id'>>) => void
  deleteTool: (id: string) => void
  selectTool: (id: string | null) => void
  setTools: (tools: Tool[]) => void
}

export const useToolStore = create<ToolState>()(
  persist(
    (set) => ({
      tools: DEFAULT_TOOLS,
      selectedToolId: DEFAULT_TOOLS[0].id,

      addTool: () => {
        const id = `tool-${++_idCounter}`
        const t: Tool = { id, name: 'New End Mill', type: 'endmill', diameterMM: 6.35, fluteCount: 2, rpm: 18000, xyFeedMmMin: 2000, zFeedMmMin: 500, stepDownMM: 3.0, maxDepthMM: 20.0, direction: 'climb' }
        set((s) => ({ tools: [...s.tools, t], selectedToolId: id }))
      },

      updateTool: (id, updates) =>
        set((s) => ({ tools: s.tools.map((t) => t.id === id ? { ...t, ...updates } : t) })),

      deleteTool: (id) =>
        set((s) => {
          if (s.tools.length <= 1) return s
          const tools = s.tools.filter((t) => t.id !== id)
          return { tools, selectedToolId: s.selectedToolId === id ? tools[0]?.id ?? null : s.selectedToolId }
        }),

      selectTool: (id) => set({ selectedToolId: id }),

      setTools: (tools) =>
        set({ tools, selectedToolId: tools[0]?.id ?? null }),
    }),
    { name: 'freazykam-tools' }
  )
)
