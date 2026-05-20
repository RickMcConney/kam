import { create } from 'zustand'
import type { ImportedPath } from '../importers/svgImporter'
import { translateD } from '../canvas/selectionUtils'
import { generateShapeD, translateShapeParams, type ShapeParams } from '../shapes/shapeGenerators'
import { useToolpathStore, type AnyOperation, refsPathId } from './toolpathStore'
import { useTabStore, type Tab } from './tabStore'

export type { ImportedPath }

type HistoryEntry = { paths: ImportedPath[]; operations: AnyOperation[]; selectedIds: string[]; tabs: Tab[] }

interface PathsState {
  paths: ImportedPath[]
  selectedIds: string[]
  collapsedGroups: Set<string>

  past: HistoryEntry[]
  future: HistoryEntry[]

  addPaths: (newPaths: ImportedPath[]) => void
  deletePath: (id: string) => void
  deleteGroup: (groupId: string) => void
  toggleVisibility: (id: string) => void
  toggleGroupVisibility: (groupId: string) => void
  toggleGroupCollapsed: (groupId: string) => void
  selectPath: (id: string | null, extend?: boolean) => void
  setSelectedIds: (ids: string[]) => void
  deleteSelected: () => void
  updatePathD: (id: string, newD: string) => void
  batchUpdatePaths: (updates: { id: string; d: string; shapeParams?: ShapeParams | null; name?: string }[]) => void
  updateShapeParams: (id: string, params: ShapeParams) => void
  duplicateSelected: (offsetMM?: number) => void
  splitPath: (id: string, subDs: string[]) => void
  hidePathIds: (ids: string[]) => void
  showPath: (id: string) => void
  undo: () => void
  redo: () => void
  replacePaths: (paths: ImportedPath[]) => void
  pushHistoryBoth: () => void
  canUndo: () => boolean
  canRedo: () => boolean
}

function pushHistory(past: HistoryEntry[], paths: ImportedPath[], selectedIds: string[]): HistoryEntry[] {
  return [...past.slice(-49), {
    paths,
    operations: useToolpathStore.getState().operations,
    selectedIds,
    tabs: useTabStore.getState().tabs,
  }]
}

let _dupCounter = 0

export const usePathsStore = create<PathsState>()((set, get) => ({
  paths: [],
  selectedIds: [],
  collapsedGroups: new Set<string>(),
  past: [],
  future: [],

  addPaths: (newPaths) => set((s) => ({
    past: pushHistory(s.past, s.paths, s.selectedIds),
    future: [],
    paths: [...s.paths, ...newPaths],
  })),

  deletePath: (id) => {
    const s = get()
    const ops = useToolpathStore.getState().operations
    const newOps = ops.filter((op) => !refsPathId(op, id))
    if (newOps.length !== ops.length) useToolpathStore.getState().replaceOperations(newOps)
    set({
      past: pushHistory(s.past, s.paths, s.selectedIds),
      future: [],
      paths: s.paths.filter((p) => p.id !== id),
      selectedIds: s.selectedIds.filter((sid) => sid !== id),
    })
  },

  toggleVisibility: (id) => set((s) => ({
    paths: s.paths.map((p) => p.id === id ? { ...p, visible: !p.visible } : p),
  })),

  toggleGroupVisibility: (groupId) => set((s) => {
    const groupPaths = s.paths.filter((p) => p.groupId === groupId)
    const allVisible = groupPaths.every((p) => p.visible)
    return { paths: s.paths.map((p) => p.groupId === groupId ? { ...p, visible: !allVisible } : p) }
  }),

  toggleGroupCollapsed: (groupId) => set((s) => {
    const next = new Set(s.collapsedGroups)
    if (next.has(groupId)) next.delete(groupId); else next.add(groupId)
    return { collapsedGroups: next }
  }),

  deleteGroup: (groupId) => {
    const s = get()
    const ids = s.paths.filter((p) => p.groupId === groupId).map((p) => p.id)
    if (ids.length === 0) return
    const ops = useToolpathStore.getState().operations
    const newOps = ops.filter((op) => !ids.some((id) => refsPathId(op, id)))
    if (newOps.length !== ops.length) useToolpathStore.getState().replaceOperations(newOps)
    set((s) => ({
      past: pushHistory(s.past, s.paths, s.selectedIds),
      future: [],
      paths: s.paths.filter((p) => p.groupId !== groupId),
      selectedIds: s.selectedIds.filter((sid) => !ids.includes(sid)),
    }))
  },

  selectPath: (id, extend = false) => set((s) => {
    if (id === null) return { selectedIds: [] }
    if (extend) {
      const already = s.selectedIds.includes(id)
      return { selectedIds: already ? s.selectedIds.filter((sid) => sid !== id) : [...s.selectedIds, id] }
    }
    return { selectedIds: [id] }
  }),

  setSelectedIds: (ids) => set({ selectedIds: ids }),

  deleteSelected: () => {
    const s = get()
    if (s.selectedIds.length === 0) return
    const ops = useToolpathStore.getState().operations
    const newOps = ops.filter((op) => !s.selectedIds.some((id) => refsPathId(op, id)))
    if (newOps.length !== ops.length) useToolpathStore.getState().replaceOperations(newOps)
    set({
      past: pushHistory(s.past, s.paths, s.selectedIds),
      future: [],
      paths: s.paths.filter((p) => !s.selectedIds.includes(p.id)),
      selectedIds: [],
    })
  },

  updatePathD: (id, newD) => set((s) => ({
    past: pushHistory(s.past, s.paths, s.selectedIds),
    future: [],
    paths: s.paths.map((p) => p.id === id ? { ...p, d: newD } : p),
  })),

  batchUpdatePaths: (updates) => set((s) => {
    const map = new Map(updates.map(({ id, d, shapeParams, name }) => [id, { d, shapeParams, name }]))
    return {
      past: pushHistory(s.past, s.paths, s.selectedIds),
      future: [],
      paths: s.paths.map((p) => {
        const upd = map.get(p.id)
        if (!upd) return p
        const newPath = { ...p, d: upd.d }
        if (upd.shapeParams !== undefined) {
          newPath.shapeParams = upd.shapeParams ?? undefined
        }
        if (upd.name !== undefined) {
          newPath.name = upd.name
        }
        return newPath
      }),
    }
  }),

  updateShapeParams: (id, params) => set((s) => {
    const d = generateShapeD(params)
    return {
      past: pushHistory(s.past, s.paths, s.selectedIds),
      future: [],
      paths: s.paths.map((p) => p.id === id ? { ...p, d, shapeParams: params } : p),
    }
  }),

  hidePathIds: (ids) => set((s) => ({
    paths: s.paths.map((p) => ids.includes(p.id) ? { ...p, hidden: true } : p),
  })),

  showPath: (id) => set((s) => ({
    paths: s.paths.map((p) => p.id === id ? { ...p, hidden: false } : p),
  })),

  splitPath: (id, subDs) => set((s) => {
    const idx = s.paths.findIndex((p) => p.id === id)
    if (idx === -1) return s
    const orig = s.paths[idx]
    const newPaths: ImportedPath[] = subDs.map((subD, i) => ({
      id: `path-split-${++_dupCounter}-${Date.now()}-${i}`,
      name: `${orig.name} ${i + 1}`,
      d: subD,
      color: orig.color,
      visible: orig.visible,
      groupId: orig.groupId,
      groupName: orig.groupName,
    }))
    const paths = [...s.paths.slice(0, idx), ...newPaths, ...s.paths.slice(idx + 1)]
    return {
      past: pushHistory(s.past, s.paths, s.selectedIds),
      future: [],
      paths,
      selectedIds: newPaths.map((p) => p.id),
    }
  }),

  duplicateSelected: (offsetMM = 5) => set((s) => {
    if (s.selectedIds.length === 0) return s
    const newPaths: ImportedPath[] = s.paths
      .filter((p) => s.selectedIds.includes(p.id))
      .map((p) => ({
        ...p,
        id: `path-dup-${++_dupCounter}-${Date.now()}`,
        name: `${p.name} copy`,
        d: translateD(p.d, offsetMM, offsetMM),
        shapeParams: p.shapeParams ? translateShapeParams(p.shapeParams, offsetMM, offsetMM) : undefined,
      }))
    return {
      past: pushHistory(s.past, s.paths, s.selectedIds),
      future: [],
      paths: [...s.paths, ...newPaths],
      selectedIds: newPaths.map((p) => p.id),
    }
  }),

  undo: () => {
    const s = get()
    if (s.past.length === 0) return
    const prev = s.past[s.past.length - 1]
    const currentOps = useToolpathStore.getState().operations
    const currentTabs = useTabStore.getState().tabs
    useToolpathStore.getState().replaceOperations(prev.operations)
    useTabStore.getState().replaceTabs(prev.tabs)
    const prevIds = new Set(prev.paths.map((p) => p.id))
    const restoredSelection = prev.selectedIds.filter((id) => prevIds.has(id))
    set({
      past: s.past.slice(0, -1),
      future: [{ paths: s.paths, operations: currentOps, selectedIds: s.selectedIds, tabs: currentTabs }, ...s.future.slice(0, 49)],
      paths: prev.paths,
      selectedIds: restoredSelection,
    })
  },

  redo: () => {
    const s = get()
    if (s.future.length === 0) return
    const next = s.future[0]
    const currentOps = useToolpathStore.getState().operations
    const currentTabs = useTabStore.getState().tabs
    useToolpathStore.getState().replaceOperations(next.operations)
    useTabStore.getState().replaceTabs(next.tabs)
    const nextIds = new Set(next.paths.map((p) => p.id))
    const restoredSelection = next.selectedIds.filter((id) => nextIds.has(id))
    set({
      past: [...s.past.slice(-49), { paths: s.paths, operations: currentOps, selectedIds: s.selectedIds, tabs: currentTabs }],
      future: s.future.slice(1),
      paths: next.paths,
      selectedIds: restoredSelection,
    })
  },

  replacePaths: (paths) => set({ paths, selectedIds: [], past: [], future: [] }),

  pushHistoryBoth: () => {
    const s = get()
    set({
      past: pushHistory(s.past, s.paths, s.selectedIds),
      future: [],
    })
  },

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,
}))
