import { create } from 'zustand'
import { flattenPath, type Pt2 } from '../cam/pathFlattener'
import { uid } from '../uid'

export interface Tab {
  id: string
  pathId: string
  t: number        // 0..1 arc-length fraction along the source design path
  lengthMM: number
  heightMM: number // height above cut bottom (G-code lifts to -(depth - heightMM))
}

interface TabState {
  tabs: Tab[]
  // Replace all tabs for a path with evenly-spaced new ones, snapped to segment midpoints
  applyTabs: (pathId: string, count: number, d: string, lengthMM: number, heightMM: number) => void
  deleteTab: (id: string) => void
  deletePathTabs: (pathId: string) => void
  updateTabT: (id: string, t: number) => void
  getPathTabs: (pathId: string) => Tab[]
  replaceTabs: (tabs: Tab[]) => void  // used by project load
}

export const useTabStore = create<TabState>()((set, get) => ({
  tabs: [],

  applyTabs: (pathId, count, d, lengthMM, heightMM) => {
    const existing = get().tabs.filter((t) => t.pathId !== pathId)
    const newTabs: Tab[] = []

    // Build arc-length index across all subpaths (same structure as designPathAtT in profile.ts)
    const subpaths = flattenPath(d, 0.05)
    interface SubSeg { pts: Pt2[]; startLen: number; cumLens: number[]; segLen: number }
    const subSegs: SubSeg[] = []
    let totalLen = 0
    for (const sp of subpaths) {
      const cumLens: number[] = [0]
      for (let i = 1; i < sp.length; i++) {
        cumLens.push(cumLens[i - 1] + Math.hypot(sp[i][0] - sp[i - 1][0], sp[i][1] - sp[i - 1][1]))
      }
      const segLen = cumLens[cumLens.length - 1]
      subSegs.push({ pts: sp, startLen: totalLen, cumLens, segLen })
      totalLen += segLen
    }

    for (let i = 0; i < count; i++) {
      const initialT = (i + 0.5) / count
      let snappedT = initialT

      if (totalLen > 1e-6) {
        const target = initialT * totalLen
        outer: for (const ss of subSegs) {
          const localTarget = target - ss.startLen
          if (localTarget > ss.segLen && ss !== subSegs[subSegs.length - 1]) continue
          for (let j = 1; j < ss.pts.length; j++) {
            if (ss.cumLens[j] >= localTarget - 1e-10 || j === ss.pts.length - 1) {
              const midLen = ss.startLen + (ss.cumLens[j - 1] + ss.cumLens[j]) / 2
              snappedT = midLen / totalLen
              break outer
            }
          }
        }
      }

      newTabs.push({
        id: uid('tab'),
        pathId,
        t: snappedT,
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
