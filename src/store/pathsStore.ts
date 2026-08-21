import { useMemo } from 'react'
import { create } from 'zustand'
import type { ImportedPath, PathDefinition } from '../importers/svgImporter'
import type { ClockSpec } from '../shapes/clockTrain'
import { translateD, applyPlacementD, placementMat, foldPlacement, isPlacementOnly, type TransformStep } from '../canvas/selectionUtils'
import { generateShapeD, generateShapeParts, shapeDisplayName, translateShapeParams, type ShapeParams } from '../shapes/shapeGenerators'
import { useToolpathStore, refsPathId, remapOpsForSplit } from './toolpathStore'
import { useTabStore } from './tabStore'
import { useTimelineStore } from '../timeline/timelineStore'
import { serializeOp, type PathsAddSource, type PathEditGesture } from '../timeline/events'
import type { CornerTreatmentType } from '../tools/cornerTreatment'
import { uid } from '../uid'

export type { ImportedPath }

// `transforms`: the geometric-transform recipe that produced `d`/`shapeParams`
// (move/scale/rotate/skew/mirror only) — see selectionUtils.ts's
// applyTransformStep. `corner`: the per-corner treatment recipe (gesture
// 'corner' only) — see tools/cornerTreatment.ts's applyCornerTreatments.
// `d`/`shapeParams` remain the immediately-applied baked value for live
// editing and for gestures with no recipe concept (points/join/weld/trim/
// text/boolean); timeline replay prefers a recipe when present so it
// recomposes against the CURRENT geometry at that point in history instead
// of stamping back a stale absolute value.
export type PathUpdate = {
  id: string
  d: string
  shapeParams?: ShapeParams | null
  name?: string
  hidden?: boolean
  transforms?: TransformStep[]
  corner?: { idx: number; type: CornerTreatmentType; radiusMM: number }[]
  // The untreated outline `corner` was cut from. Stored with it so the
  // treatment stays a recipe rather than baked geometry — see
  // ImportedPath.corners.
  cornerBaseD?: string
  fromCenter?: boolean
}

export type PathsAddMeta = { source?: PathsAddSource; label?: string }

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
  applyPathEdit: (edit: { updates?: PathUpdate[]; add?: ImportedPath[]; deleteIds?: string[]; label?: string; gesture?: PathEditGesture; selectAfter?: string[] }) => void
  // Raw, NON-recording path rewrite for edit-in-place flows that amend the
  // timeline themselves (e.g. BooleanForm edit mode) — never use for normal
  // edits, which must record events.
  rewritePathRaw: (id: string, upd: { d: string; name?: string }) => void
  // Raw, NON-recording bulk update+add+delete (Offset/Pattern chip edit —
  // pattern cardinality changes add/remove result paths). Cleans up ops, tabs,
  // and selection for deleted ids like applyPathEdit, but records nothing.
  rewriteGeneratedRaw: (edit: { updates?: { id: string; d: string; name?: string; shapeParams?: ShapeParams | null; definition?: PathDefinition; clockSpec?: ClockSpec }[]; add?: ImportedPath[]; deleteIds?: string[] }) => void
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
        return {
          ...p, d: upd.d,
          ...(upd.name !== undefined ? { name: upd.name } : {}),
          ...(upd.shapeParams !== undefined ? { shapeParams: upd.shapeParams ?? undefined } : {}),
          ...(upd.definition !== undefined ? { definition: upd.definition } : {}),
          ...(upd.clockSpec !== undefined ? { clockSpec: upd.clockSpec } : {}),
        }
      })
    set({
      paths: add.length > 0 ? [...paths, ...add] : paths,
      ...(deleteIds.length > 0
        ? { selectedIds: s.selectedIds.filter((sid) => !deleteIds.includes(sid)) }
        : {}),
    })
  },

  applyPathEdit: ({ updates = [], add = [], deleteIds = [], label, gesture, selectAfter }) => {
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
    const map = new Map(updates.map((u) => [u.id, u]))
    const paths = s.paths
      .filter((p) => !deleteIds.includes(p.id))
      .map((p) => {
        const upd = map.get(p.id)
        if (!upd) return p
        const newPath = { ...p, d: upd.d }
        // Repositioning one part of a multi-part shape is recorded as that
        // part's PLACEMENT. Its params are the whole GROUP's definition, so
        // translating them here made the group's copies disagree and the next
        // parameter step regenerated everything from one of them, throwing the
        // arrangement away — and a rotate cleared them outright, which took the
        // part out of the group for good. Neither now happens: the definition
        // is untouched and the offset from it is remembered.
        if (p.shapePart !== undefined && isPlacementOnly(upd.transforms)) {
          newPath.placement = foldPlacement(p, upd.transforms!)
        } else if (upd.shapeParams !== undefined) {
          newPath.shapeParams = upd.shapeParams ?? undefined
        }
        // Corner treatments are a recipe over an untreated outline, so they
        // survive exactly as long as that outline still describes this path:
        //  - an edit carrying a `corner` recipe REPLACES them (the form always
        //    sends the full cumulative map, never a delta);
        //  - a pure transform CARRIES them, base outline and radii together, so
        //    moving a treated path does not cost it its chip;
        //  - anything else that rewrites `d` — node edits, weld, trim, boolean —
        //    DROPS them, because `treatments` is keyed by corner index into the
        //    base outline and those indices now point at different corners.
        if (upd.corner) {
          const baseD = upd.cornerBaseD ?? p.corners?.baseD
          newPath.corners = baseD && upd.corner.length > 0
            ? { baseD, treatments: upd.corner.map((c) => [c.idx, { type: c.type, radiusMM: c.radiusMM }]) }
            : undefined
        } else if (p.corners && upd.transforms?.length) {
          newPath.corners = transformCorners(p.corners, upd.transforms)
        } else if (p.corners && upd.d !== p.d) {
          newPath.corners = undefined
        }
        if (upd.name !== undefined) {
          newPath.name = upd.name
        }
        if (upd.hidden !== undefined) {
          newPath.hidden = upd.hidden
        }
        if (upd.fromCenter !== undefined) {
          newPath.fromCenter = upd.fromCenter
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
      },
      { label, selectionAfter: selectAfter },
    )
  },

  updateShapeParams: (id, params) => {
    const s0 = get()
    const self = s0.paths.find((p) => p.id === id)
    // A multi-part shape (a gear's teeth/bore/spokes) is several paths sharing
    // one set of params, so editing any one of them has to regenerate all of
    // them — and add or drop paths as parts appear and vanish, since turning the
    // spokes to 0 or the bore to 0 removes a part outright.
    const parts = self?.shapePart !== undefined ? generateShapeParts(params) : null
    if (self && parts) {
      const siblings = s0.paths.filter((p) => p.groupId === self.groupId && p.shapePart !== undefined)
      const byPart = new Map(siblings.map((p) => [p.shapePart!, p]))
      const updates: PathUpdate[] = []
      const add: ImportedPath[] = []
      for (const pt of parts) {
        const existing = byPart.get(pt.part)
        // Generated geometry is where the definition NOMINALLY puts this part;
        // carrying it out to where the user actually dragged it is what keeps a
        // gear's pinion still on the far side of the stock after the module is
        // stepped.
        if (existing) updates.push({ id: existing.id, d: applyPlacementD(pt.d, existing.placement), shapeParams: params })
        else add.push({
          id: uid('shape'), name: `${self.groupName ?? self.name} ${pt.label}`, d: pt.d,
          visible: true, color: self.color, shapeParams: params, shapePart: pt.part,
          groupId: self.groupId, groupName: self.groupName,
          // A part that appears mid-edit (spokes turned back on) belongs to the
          // same clock wheel as its siblings — without this the link is on some
          // of a group's paths and not others.
          clockId: self.clockId, clockPart: self.clockPart, clockSpec: self.clockSpec,
        })
      }
      const live = new Set(parts.map((pt) => pt.part))
      const deleteIds = siblings.filter((p) => !live.has(p.shapePart!)).map((p) => p.id)
      // A params edit is an argument edit to the call that created the shape, so it
      // AMENDS that chip rather than appending one — stepping a gear's bore must not
      // leave a chip per keystroke, the same rule single-path shapes already follow
      // through amendPathDefinition. The amend needs the group as it will BE, since
      // it rewrites the chip's path list wholesale; the live paths then move without
      // recording. Falling back to applyPathEdit keeps one atomic entry (and its op
      // cleanup) when there is no chip to amend.
      const nextGroup = parts.map((pt) => {
        const existing = byPart.get(pt.part)
        return existing
          ? { ...existing, d: applyPlacementD(pt.d, existing.placement), shapeParams: params }
          : add.find((a) => a.shapePart === pt.part)!
      })
      // `amendShapeGroup` takes the dropped ids too: it can fold a vanishing part
      // into an existing group edit (whose deleteIds replay the op/tab cleanup),
      // and refuses when the only chip is the placement — which is the one case
      // that has to record, and which then becomes the chip every later edit
      // amends.
      const tl = useTimelineStore.getState()
      if (self.groupId && tl.amendShapeGroup(self.groupId, nextGroup, deleteIds)) {
        // The chip now holds the whole group, so the live paths move without
        // recording — and rewriteGeneratedRaw's ops/tabs cleanup for a dropped
        // part is exactly what that chip's deleteIds replay.
        get().rewriteGeneratedRaw({
          updates: updates.map((u) => ({ id: u.id, d: u.d!, shapeParams: params })),
          add, deleteIds,
        })
      } else {
        // One atomic edit: one timeline entry, and operations on a part that has
        // gone away are cleaned up with it. Named for the THING, like every other
        // chip — and this entry is what later edits amend, so it is the one the
        // user will keep seeing.
        get().applyPathEdit({ updates, add, deleteIds, label: shapeDisplayName(params.type) })
      }
      return
    }
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
    // How each operation follows the split — cloned, remapped or dropped — is
    // decided by `remapOpsForSplit`, which is pure and tested. One undo of the
    // paths.split event puts any of it back.
    const { ops: newOps, changed: opsChanged } =
      remapOpsForSplit(opsBefore, id, newPaths.map((p) => p.id))
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
    const defId = uid('def')
    const newPaths: ImportedPath[] = s.paths
      .filter((p) => s.selectedIds.includes(p.id))
      .map((p) => ({
        ...p,
        id: uid('path-dup'),
        name: `${p.name} copy`,
        d: translateD(p.d, offsetMM, offsetMM),
        shapeParams: p.shapeParams ? translateShapeParams(p.shapeParams, offsetMM, offsetMM) : undefined,
        // A copy is its own object from here on: it must not inherit the
        // source's provenance, only record that it came from it.
        definition: { id: defId, kind: 'duplicate' as const, sourceId: p.id, offsetMM },
      }))
    set({
      paths: [...s.paths, ...newPaths],
      selectedIds: newPaths.map((p) => p.id),
    })
    useTimelineStore.getState().record({ kind: 'paths.add', paths: newPaths, source: 'duplicate' })
  },

  replacePaths: (paths) => set({ paths, selectedIds: [] }),
}))

// A clock's spec, carried by every one of its parts (see ImportedPath.clockSpec).
// Any part will do — they are stamped together and restamped together.
export function clockSpecOf(paths: ImportedPath[], clockId: string | null | undefined): ClockSpec | undefined {
  if (!clockId) return undefined
  return paths.find((p) => p.clockId === clockId && p.clockSpec)?.clockSpec
}

// Restamp a clock's spec across all of its parts. Deliberately NOT recorded: it
// is a property of the parts, not an edit in its own right, and the arrangement
// it usually carries moves no geometry at all.
export function setClockSpec(clockId: string, spec: ClockSpec): void {
  const paths = usePathsStore.getState().paths.filter((p) => p.clockId === clockId)
  if (paths.length === 0) return
  usePathsStore.getState().rewriteGeneratedRaw({
    updates: paths.map((p) => ({ id: p.id, d: p.d, clockSpec: spec })),
  })
}

// Carry a corner recipe through a transform: the base outline moves with the
// path and the radii scale with it. √|det| is the uniform scale factor — exact
// for move/rotate/mirror/uniform-scale, which is every transform that leaves a
// corner recognisably the same corner. Under skew or a non-uniform scale it is
// only the best available answer, and NodeEditForm's own validity check
// (does the recipe still reproduce `d`?) is the authority when the form reopens.
function transformCorners(
  corners: NonNullable<ImportedPath['corners']>,
  steps: TransformStep[],
): NonNullable<ImportedPath['corners']> {
  const m = placementMat(steps)
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1
  return {
    baseD: applyPlacementD(corners.baseD, steps),
    treatments: corners.treatments.map(([i, t]) => [i, { ...t, radiusMM: t.radiusMM * scale }]),
  }
}

/** Undo a path's corner treatments, restoring the outline they were cut from. */
export function clearCorners(pathId: string): void {
  const p = usePathsStore.getState().paths.find((q) => q.id === pathId)
  if (!p?.corners) return
  usePathsStore.getState().applyPathEdit({
    updates: [{ id: p.id, d: p.corners.baseD, corner: [] }],
    label: 'Remove corners',
    gesture: 'corner',
  })
}

// The selected paths, in canvas z-order. Every operation form and the
// properties panel needs this, and each used to spell out
// `paths.filter((p) => selectedIds.includes(p.id))` — an O(paths × selection)
// scan re-run on every render.
//
// Memoized rather than selected inline: a selector that builds a new array
// would hand useSyncExternalStore a fresh reference on every store read, so
// the component would re-render on unrelated store changes.
export function useSelectedPaths(): ImportedPath[] {
  const paths = usePathsStore((s) => s.paths)
  const selectedIds = usePathsStore((s) => s.selectedIds)
  return useMemo(() => {
    const sel = new Set(selectedIds)
    return paths.filter((p) => sel.has(p.id))
  }, [paths, selectedIds])
}

// The selected paths in the order they were PICKED, not in z-order — `selectPath`
// appends each extend-click, so `selectedIds` already records it.
//
// For an operation whose operands are interchangeable (union, intersection, a
// properties edit) z-order is the better reading and `useSelectedPaths` is the
// one to use. This is for the ones where the FIRST pick means something: a
// subtraction keeps path 1 and cuts the rest away from it, and taking that from
// z-order silently subtracts the wrong way round whenever the tool happens to sit
// below the workpiece in the list. A rubber-band selection has no pick order to
// record, so it still lands in z-order; the form shows the roles so it is visible
// either way.
export function useSelectedPathsInOrder(): ImportedPath[] {
  const paths = usePathsStore((s) => s.paths)
  const selectedIds = usePathsStore((s) => s.selectedIds)
  return useMemo(() => {
    const byId = new Map(paths.map((p) => [p.id, p]))
    return selectedIds.flatMap((id) => { const p = byId.get(id); return p ? [p] : [] })
  }, [paths, selectedIds])
}
