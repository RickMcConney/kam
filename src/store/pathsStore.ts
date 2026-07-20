import { create } from 'zustand'
import type { ImportedPath } from '../importers/svgImporter'
import { translateD } from '../canvas/selectionUtils'
import { generateShapeD, translateShapeParams, type ShapeParams } from '../shapes/shapeGenerators'
import { useToolpathStore, type AnyOperation, refsPathId } from './toolpathStore'
import { useTabStore } from './tabStore'
import { useTimelineStore } from '../timeline/timelineStore'
import { serializeOp, type PathsAddSource, type PathEditGesture, type OffsetEventMeta, type PatternEventMeta } from '../timeline/events'
import type { BooleanOpType } from '../tools/booleanOps'
import { uid } from '../uid'

export type { ImportedPath }

export type PathUpdate = { id: string; d: string; shapeParams?: ShapeParams | null; name?: string; hidden?: boolean }

export type PathsAddMeta = { source?: PathsAddSource; label?: string; offset?: OffsetEventMeta; pattern?: PatternEventMeta }

interface PathsState {
  paths: ImportedPath[]
  selectedIds: string[]
  collapsedGroups: Set<string>

  addPaths: (newPaths: ImportedPath[], meta?: PathsAddMeta) => void
  deletePath: (id: string) => void
  deleteGroup: (groupId: string) => void
  toggleVisibility: (id: string) => void
  toggleGroupVisibility: (groupId: string) => void
  toggleGroupCollapsed: (groupId: string) => void
  selectPath: (id: string | null, extend?: boolean) => void
  setSelectedIds: (ids: string[]) => void
  deleteSelected: () => void
  updatePathD: (id: string, newD: string) => void
  batchUpdatePaths: (updates: PathUpdate[], gesture?: PathEditGesture) => void
  // Atomic update + add + delete in ONE history entry. Use for gestures that
  // touch multiple paths at once (node-edit join/weld) so a single undo reverts
  // the whole gesture. Deleted paths' operations and tabs are cleaned up.
  applyPathEdit: (edit: { updates?: PathUpdate[]; add?: ImportedPath[]; deleteIds?: string[]; label?: string; gesture?: PathEditGesture; selectAfter?: string[]; boolOp?: BooleanOpType }) => void
  // Raw, NON-recording path rewrite for edit-in-place flows that amend the
  // timeline themselves (e.g. BooleanForm edit mode) — never use for normal
  // edits, which must record events.
  rewritePathRaw: (id: string, upd: { d: string; name?: string }) => void
  // Raw, NON-recording bulk update+add+delete (Offset/Pattern chip edit —
  // pattern cardinality changes add/remove result paths). Cleans up ops, tabs,
  // and selection for deleted ids like applyPathEdit, but records nothing.
  rewriteGeneratedRaw: (edit: { updates?: { id: string; d: string; name?: string }[]; add?: ImportedPath[]; deleteIds?: string[] }) => void
  updateShapeParams: (id: string, params: ShapeParams) => void
  duplicateSelected: (offsetMM?: number) => void
  splitPath: (id: string, subDs: string[]) => void
  showPath: (id: string) => void
  replacePaths: (paths: ImportedPath[]) => void
}

// Undo/redo lives in the timeline (src/timeline/timelineStore.ts): every
// mutating action here records a TimelineEvent, and undo/redo scrub the
// timeline cursor. There is no separate history stack anymore.

export const usePathsStore = create<PathsState>()((set, get) => ({
  paths: [],
  selectedIds: [],
  collapsedGroups: new Set<string>(),

  addPaths: (newPaths, meta) => {
    set((s) => ({
      paths: [...s.paths, ...newPaths],
    }))
    useTimelineStore.getState().record(
      {
        kind: 'paths.add',
        paths: newPaths,
        source: meta?.source,
        ...(meta?.offset ? { offset: meta.offset } : {}),
        ...(meta?.pattern ? { pattern: meta.pattern } : {}),
      },
      // Scrubbing to an add-event selects what it created (the caller's own
      // selectPath often runs after this record — see RecordMeta.selectionAfter)
      { label: meta?.label, selectionAfter: newPaths.map((p) => p.id) },
    )
  },

  // The delete actions all delegate to applyPathEdit — it owns the snapshot-
  // before-cleanup invariant (history, ops, tabs, selection) so the sequence
  // exists in exactly one place (bugs.md R1).
  deletePath: (id) => get().applyPathEdit({ deleteIds: [id] }),

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
    s.applyPathEdit({ deleteIds: ids })
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
    s.applyPathEdit({ deleteIds: s.selectedIds })
  },

  updatePathD: (id, newD) => get().applyPathEdit({ updates: [{ id, d: newD }] }),

  batchUpdatePaths: (updates, gesture) => get().applyPathEdit({ updates, gesture }),

  rewritePathRaw: (id, upd) => set((s) => ({
    paths: s.paths.map((p) => p.id === id ? { ...p, d: upd.d, ...(upd.name !== undefined ? { name: upd.name } : {}) } : p),
  })),

  rewriteGeneratedRaw: ({ updates = [], add = [], deleteIds = [] }) => {
    const s = get()
    if (deleteIds.length > 0) {
      const opsBefore = useToolpathStore.getState().operations
      const tabsBefore = useTabStore.getState().tabs
      const newOps = opsBefore.filter((op) => !deleteIds.some((id) => refsPathId(op, id)))
      if (newOps.length !== opsBefore.length) useToolpathStore.getState().replaceOperations(newOps)
      const newTabs = tabsBefore.filter((t) => !deleteIds.includes(t.pathId))
      if (newTabs.length !== tabsBefore.length) useTabStore.getState().replaceTabs(newTabs)
    }
    const map = new Map(updates.map((u) => [u.id, u]))
    const paths = s.paths
      .filter((p) => !deleteIds.includes(p.id))
      .map((p) => {
        const upd = map.get(p.id)
        if (!upd) return p
        return { ...p, d: upd.d, ...(upd.name !== undefined ? { name: upd.name } : {}) }
      })
    set({
      paths: add.length > 0 ? [...paths, ...add] : paths,
      ...(deleteIds.length > 0
        ? { selectedIds: s.selectedIds.filter((sid) => !deleteIds.includes(sid)) }
        : {}),
    })
  },

  applyPathEdit: ({ updates = [], add = [], deleteIds = [], label, gesture, selectAfter, boolOp }) => {
    if (updates.length === 0 && add.length === 0 && deleteIds.length === 0) return
    const s = get()
    if (deleteIds.length > 0) {
      const opsBefore = useToolpathStore.getState().operations
      const tabsBefore = useTabStore.getState().tabs
      const newOps = opsBefore.filter((op) => !deleteIds.some((id) => refsPathId(op, id)))
      if (newOps.length !== opsBefore.length) useToolpathStore.getState().replaceOperations(newOps)
      const newTabs = tabsBefore.filter((t) => !deleteIds.includes(t.pathId))
      if (newTabs.length !== tabsBefore.length) useTabStore.getState().replaceTabs(newTabs)
    }
    const map = new Map(updates.map(({ id, d, shapeParams, name, hidden }) => [id, { d, shapeParams, name, hidden }]))
    const paths = s.paths
      .filter((p) => !deleteIds.includes(p.id))
      .map((p) => {
        const upd = map.get(p.id)
        if (!upd) return p
        const newPath = { ...p, d: upd.d }
        if (upd.shapeParams !== undefined) {
          newPath.shapeParams = upd.shapeParams ?? undefined
        }
        if (upd.name !== undefined) {
          newPath.name = upd.name
        }
        if (upd.hidden !== undefined) {
          newPath.hidden = upd.hidden
        }
        return newPath
      })
    set({
      paths: add.length > 0 ? [...paths, ...add] : paths,
      // Only touch selection when the caller asks (selectAfter) or something
      // was deleted — a fresh array reference here would needlessly re-render
      // every selectedIds subscriber on plain batch updates.
      ...(selectAfter
        ? { selectedIds: selectAfter }
        : deleteIds.length > 0
          ? { selectedIds: s.selectedIds.filter((sid) => !deleteIds.includes(sid)) }
          : {}),
    })
    useTimelineStore.getState().record(
      {
        kind: 'paths.edit',
        updates,
        ...(add.length > 0 ? { add } : {}),
        ...(deleteIds.length > 0 ? { deleteIds } : {}),
        ...(gesture ? { gesture } : {}),
        ...(boolOp ? { boolOp } : {}),
      },
      { label, selectionAfter: selectAfter },
    )
  },

  updateShapeParams: (id, params) => {
    const d = generateShapeD(params)
    set((s) => ({
      paths: s.paths.map((p) => p.id === id ? { ...p, d, shapeParams: params } : p),
    }))
    // Parameter edits amend the chip that created/last-defined the shape —
    // changing text or a star's point count is an argument edit to that call,
    // not a new timeline entry. Fallback records normally if no definer exists.
    const tl = useTimelineStore.getState()
    if (!tl.amendPathDefinition(id, { d, shapeParams: params })) {
      tl.record({ kind: 'shape.params', pathId: id, params })
    }
  },

  // Soft-HIDING is not a standalone action anymore — the boolean op (its only
  // user) hides originals inside its atomic applyPathEdit via PathUpdate.hidden.
  // Un-hiding from the paths panel stays a user-visible event.
  showPath: (id) => {
    set((s) => ({
      paths: s.paths.map((p) => p.id === id ? { ...p, hidden: false } : p),
    }))
    useTimelineStore.getState().record({ kind: 'paths.setHidden', ids: [id], hidden: false })
  },

  splitPath: (id, subDs) => {
    const s = get()
    if (subDs.length <= 1) return
    const idx = s.paths.findIndex((p) => p.id === id)
    if (idx === -1) return
    const orig = s.paths[idx]
    const newPaths: ImportedPath[] = subDs.map((subD, i) => ({
      id: uid('path-split'),
      name: `${orig.name} ${i + 1}`,
      d: subD,
      color: orig.color,
      visible: orig.visible,
      hidden: orig.hidden,
      groupId: orig.groupId,
      groupName: orig.groupName,
    }))
    const opsBefore = useToolpathStore.getState().operations
    const tabsBefore = useTabStore.getState().tabs
    // Operations that referenced the split path only as an ISLAND keep working:
    // swap the old id for all sub-path ids — the combined island geometry is
    // unchanged, so the generated toolpath is identical. Operations that used it
    // as their source/boundary can't reference multiple paths — drop them, same
    // as deletePath (fully restored by one undo of the paths.split event).
    const newIslandIds = newPaths.map((p) => p.id)
    let opsChanged = false
    const newOps = opsBefore.flatMap((op): AnyOperation[] => {
      if (!refsPathId(op, id)) return [op]
      opsChanged = true
      if ((op.type === 'pocket' || op.type === 'vcarve' || op.type === 'inlay') && op.pathId !== id) {
        return [{ ...op, islandIds: op.islandIds.flatMap((iid) => (iid === id ? newIslandIds : [iid])) }]
      }
      return []
    })
    if (opsChanged) useToolpathStore.getState().replaceOperations(newOps)
    // Tab positions are arc-length fractions along the whole compound path — they
    // don't map onto the sub-paths, so drop them.
    const newTabs = tabsBefore.filter((t) => t.pathId !== id)
    if (newTabs.length !== tabsBefore.length) useTabStore.getState().replaceTabs(newTabs)
    set({
      paths: [...s.paths.slice(0, idx), ...newPaths, ...s.paths.slice(idx + 1)],
      selectedIds: newPaths.map((p) => p.id),
    })
    useTimelineStore.getState().record({
      kind: 'paths.split',
      pathId: id,
      subPaths: newPaths,
      opsAfter: opsChanged ? newOps.map(serializeOp) : null,
    })
  },

  duplicateSelected: (offsetMM = 5) => {
    const s = get()
    if (s.selectedIds.length === 0) return
    const newPaths: ImportedPath[] = s.paths
      .filter((p) => s.selectedIds.includes(p.id))
      .map((p) => ({
        ...p,
        id: uid('path-dup'),
        name: `${p.name} copy`,
        d: translateD(p.d, offsetMM, offsetMM),
        shapeParams: p.shapeParams ? translateShapeParams(p.shapeParams, offsetMM, offsetMM) : undefined,
      }))
    set({
      paths: [...s.paths, ...newPaths],
      selectedIds: newPaths.map((p) => p.id),
    })
    useTimelineStore.getState().record({ kind: 'paths.add', paths: newPaths, source: 'duplicate' })
  },

  replacePaths: (paths) => set({ paths, selectedIds: [] }),
}))
