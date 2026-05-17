import { create } from 'zustand'

export interface Tab {
  id: string
  pathId: string
  t: number        // 0..1 arc-length fraction along the source design path
  lengthMM: number
  heightMM: number // height above cut bottom (G-code lifts to -(depth - heightMM))
}

let _tabCounter = 0

interface TabState {
  tabs: Tab[]
  // Replace all tabs for a path with evenly-spaced new ones
  applyTabs: (pathId: string, count: number, lengthMM: number, heightMM: number) => void
  deleteTab: (id: string) => void
  deletePathTabs: (pathId: string) => void
  updateTabT: (id: string, t: number) => void
  getPathTabs: (pathId: string) => Tab[]
  replaceTabs: (tabs: Tab[]) => void  // used by project load
}

export const useTabStore = create<TabState>()((set, get) => ({
  tabs: [],

  applyTabs: (pathId, count, lengthMM, heightMM) => {
    const existing = get().tabs.filter((t) => t.pathId !== pathId)
    const newTabs: Tab[] = []
    for (let i = 0; i < count; i++) {
      newTabs.push({
        id: `tab-${++_tabCounter}`,
        pathId,
        t: (i + 0.5) / count,
        lengthMM,
        heightMM,
      })
    }
    set({ tabs: [...existing, ...newTabs] })
  },

  deleteTab: (id) => set((s) => ({ tabs: s.tabs.filter((t) => t.id !== id) })),

  deletePathTabs: (pathId) => set((s) => ({ tabs: s.tabs.filter((t) => t.pathId !== pathId) })),

  updateTabT: (id, t) =>
    set((s) => ({ tabs: s.tabs.map((tab) => tab.id === id ? { ...tab, t: Math.max(0, Math.min(1, t)) } : tab) })),

  getPathTabs: (pathId) => get().tabs.filter((t) => t.pathId === pathId),

  replaceTabs: (tabs) => set({ tabs }),
}))
