import { create } from 'zustand'
import type { ImportedPath } from '../importers/svgImporter'
import { translateD } from '../canvas/selectionUtils'
import { generateShapeD, translateShapeParams, type ShapeParams } from '../shapes/shapeGenerators'

export type { ImportedPath }

interface PathsState {
  paths: ImportedPath[]
  selectedIds: string[]

  past: ImportedPath[][]
  future: ImportedPath[][]

  addPaths: (newPaths: ImportedPath[]) => void
  deletePath: (id: string) => void
  toggleVisibility: (id: string) => void
  selectPath: (id: string | null, extend?: boolean) => void
  setSelectedIds: (ids: string[]) => void
  deleteSelected: () => void
  updatePathD: (id: string, newD: string) => void
  batchUpdatePaths: (updates: { id: string; d: string; shapeParams?: ShapeParams | null }[]) => void
  updateShapeParams: (id: string, params: ShapeParams) => void
  duplicateSelected: (offsetMM?: number) => void
  undo: () => void
  redo: () => void
  replacePaths: (paths: ImportedPath[]) => void
  canUndo: () => boolean
  canRedo: () => boolean
}

function pushHistory(past: ImportedPath[][], current: ImportedPath[]): ImportedPath[][] {
  return [...past.slice(-49), current]
}

let _dupCounter = 0

export const usePathsStore = create<PathsState>()((set, get) => ({
  paths: [],
  selectedIds: [],
  past: [],
  future: [],

  addPaths: (newPaths) => set((s) => ({
    past: pushHistory(s.past, s.paths),
    future: [],
    paths: [...s.paths, ...newPaths],
  })),

  deletePath: (id) => set((s) => ({
    past: pushHistory(s.past, s.paths),
    future: [],
    paths: s.paths.filter((p) => p.id !== id),
    selectedIds: s.selectedIds.filter((sid) => sid !== id),
  })),

  toggleVisibility: (id) => set((s) => ({
    paths: s.paths.map((p) => p.id === id ? { ...p, visible: !p.visible } : p),
  })),

  selectPath: (id, extend = false) => set((s) => {
    if (id === null) return { selectedIds: [] }
    if (extend) {
      const already = s.selectedIds.includes(id)
      return { selectedIds: already ? s.selectedIds.filter((sid) => sid !== id) : [...s.selectedIds, id] }
    }
    return { selectedIds: [id] }
  }),

  setSelectedIds: (ids) => set({ selectedIds: ids }),

  deleteSelected: () => set((s) => {
    if (s.selectedIds.length === 0) return s
    return {
      past: pushHistory(s.past, s.paths),
      future: [],
      paths: s.paths.filter((p) => !s.selectedIds.includes(p.id)),
      selectedIds: [],
    }
  }),

  updatePathD: (id, newD) => set((s) => ({
    past: pushHistory(s.past, s.paths),
    future: [],
    paths: s.paths.map((p) => p.id === id ? { ...p, d: newD } : p),
  })),

  batchUpdatePaths: (updates) => set((s) => {
    const map = new Map(updates.map(({ id, d, shapeParams }) => [id, { d, shapeParams }]))
    return {
      past: pushHistory(s.past, s.paths),
      future: [],
      paths: s.paths.map((p) => {
        const upd = map.get(p.id)
        if (!upd) return p
        const newPath = { ...p, d: upd.d }
        if (upd.shapeParams !== undefined) {
          // null means clear, object means set new value
          newPath.shapeParams = upd.shapeParams ?? undefined
        }
        return newPath
      }),
    }
  }),

  updateShapeParams: (id, params) => set((s) => {
    const d = generateShapeD(params)
    return {
      past: pushHistory(s.past, s.paths),
      future: [],
      paths: s.paths.map((p) => p.id === id ? { ...p, d, shapeParams: params } : p),
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
      past: pushHistory(s.past, s.paths),
      future: [],
      paths: [...s.paths, ...newPaths],
      selectedIds: newPaths.map((p) => p.id),
    }
  }),

  undo: () => set((s) => {
    if (s.past.length === 0) return s
    const prev = s.past[s.past.length - 1]
    return {
      past: s.past.slice(0, -1),
      future: [s.paths, ...s.future.slice(0, 49)],
      paths: prev,
      selectedIds: [],
    }
  }),

  redo: () => set((s) => {
    if (s.future.length === 0) return s
    const next = s.future[0]
    return {
      past: pushHistory(s.past, s.paths),
      future: s.future.slice(1),
      paths: next,
      selectedIds: [],
    }
  }),

  replacePaths: (paths) => set({ paths, selectedIds: [], past: [], future: [] }),

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,
}))
