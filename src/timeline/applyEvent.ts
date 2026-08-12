import type { Checkpoint, SerializedOperation, TimelineEvent } from './events'
import { refsPathId, type AnyOperation } from '../store/toolpathStore'
import { generateShapeD, translateShapeParams } from '../shapes/shapeGenerators'
import { applyTransformSteps, translateD } from '../canvas/selectionUtils'
import { applyCornerTreatments } from '../tools/cornerTreatment'
import { applyBooleanOp } from '../tools/booleanOps'
import { applyOffset } from '../tools/offsetOp'
import { computePatternInstances, applyPatternInstance } from '../tools/patternOp'

// Pure event interpreter: fold events over a Checkpoint-shaped state without
// touching any store. Used by the replay checker (compare against live stores)
// and by scrubTo (fold to the target seq, then write the result into the
// stores once). Every mutation here must mirror the recording store action.

export type ReplayState = Checkpoint

// SerializedOperation lacks segments/status, but refsPathId only reads the
// type discriminant + pathId/islandIds — the cast is safe.
const refsPath = (op: SerializedOperation, pathId: string) =>
  refsPathId(op as unknown as AnyOperation, pathId)

export function applyEvent(state: ReplayState, ev: TimelineEvent): ReplayState {
  switch (ev.kind) {
    // The clock designer's chip carries the SPEC, not geometry — the parts it
    // produced were recorded as their own paths.add events right after it. So
    // there is nothing to replay, and that is deliberate: see 'clock.design' in
    // events.ts.
    case 'clock.design': return state
    case 'paths.add': {
      // Offset/pattern results recompute from their source(s)' CURRENT d (as
      // already folded into state.paths by prior events) rather than
      // trusting the baked ev.paths — same reasoning as the boolean fix
      // below. Falls back to the stored path if its source can't be found
      // (legacy save, deleted source) or the instance/source count no
      // longer lines up with how many result paths were recorded.
      let paths = ev.paths
      const offset = ev.offset
      if (offset && offset.pairs.length > 0) {
        const bySource = new Map(state.paths.map((p) => [p.id, p]))
        const sourceOf = new Map(offset.pairs.map((pr) => [pr.resultId, pr.sourceId]))
        paths = paths.map((rp) => {
          const sourceId = sourceOf.get(rp.id)
          const src = sourceId !== undefined && bySource.get(sourceId)
          if (!src) return rp
          const d = applyOffset(src.d, { distanceMM: offset.distanceMM, cornerStyle: offset.cornerStyle })
          return d ? { ...rp, d } : rp
        })
      }
      const pattern = ev.pattern
      if (pattern && pattern.sourceIds.length > 0) {
        const { sourceIds, params } = pattern
        const instances = computePatternInstances(params)
        // Mirrors PatternForm.tsx's handleApply exactly: linear mode skips
        // the first (identity) instance — that "copy" is the source itself,
        // not a new path — circular mode creates one for every instance.
        const instancesToCreate = params.type === 'linear' ? instances.slice(1) : instances
        const bySource = new Map(state.paths.map((p) => [p.id, p]))
        if (instancesToCreate.length * sourceIds.length === paths.length) {
          paths = paths.map((rp, i) => {
            const inst = instancesToCreate[Math.floor(i / sourceIds.length)]
            const src = bySource.get(sourceIds[i % sourceIds.length])
            return src ? { ...rp, d: applyPatternInstance(src.d, inst) } : rp
          })
        }
      }
      const duplicate = ev.duplicate
      if (duplicate && duplicate.pairs.length > 0) {
        const bySource = new Map(state.paths.map((p) => [p.id, p]))
        const sourceOf = new Map(duplicate.pairs.map((pr) => [pr.resultId, pr.sourceId]))
        paths = paths.map((rp) => {
          const sourceId = sourceOf.get(rp.id)
          const src = sourceId !== undefined && bySource.get(sourceId)
          if (!src) return rp
          return {
            ...rp,
            d: translateD(src.d, duplicate.offsetMM, duplicate.offsetMM),
            shapeParams: src.shapeParams ? translateShapeParams(src.shapeParams, duplicate.offsetMM, duplicate.offsetMM) : undefined,
          }
        })
      }
      return { ...state, paths: [...state.paths, ...paths] }
    }

    case 'paths.edit': {
      const deleteIds = new Set(ev.deleteIds ?? [])
      const map = new Map(ev.updates.map((u) => [u.id, u]))
      let paths = state.paths
        .filter((p) => !deleteIds.has(p.id))
        .map((p) => {
          const upd = map.get(p.id)
          if (!upd) return p
          // A transform or corner recipe recomposes against THIS path's
          // current (already-folded) d/shapeParams — correct even when an
          // earlier event in the fold amended this path's definition after
          // the recipe was originally recorded. Gestures with no recipe
          // (points/join/weld/trim/text) and events saved before recipes
          // existed fall back to the stored absolute d/shapeParams, same as
          // before.
          // Corner treatment always clears shapeParams (a treated path is no
          // longer the plain parametric shape it started as), matching what
          // NodeEditForm.tsx bakes at record time.
          const recomposed = upd.transforms?.length ? applyTransformSteps(p, upd.transforms)
            : upd.corner?.length ? { d: applyCornerTreatments(p.d, new Map(upd.corner.map((t) => [t.idx, t]))), shapeParams: null }
            : null
          // Boolean's own updates just hide each source — upd.d is a snapshot
          // of the source's d at record time (PathUpdate requires `d`, but
          // nothing here actually wants to CHANGE it), not a value replay
          // should stamp back. Doing so would silently discard any upstream
          // edit to that source made after this boolean was recorded — the
          // recompute below reads THIS path's current d, so it must survive
          // this step, not get overwritten by the stale one.
          const isBooleanSourceUpdate = ev.boolOp !== undefined
          const np = { ...p, d: recomposed ? recomposed.d : isBooleanSourceUpdate ? p.d : upd.d }
          if (recomposed) {
            np.shapeParams = recomposed.shapeParams ?? undefined
            if ('name' in recomposed && recomposed.name !== undefined) np.name = recomposed.name
          } else {
            if (upd.shapeParams !== undefined) np.shapeParams = upd.shapeParams ?? undefined
            if (upd.name !== undefined) np.name = upd.name
          }
          if (upd.hidden !== undefined) np.hidden = upd.hidden
          return np
        })
      // Boolean results recompute from the sources' CURRENT (just-updated
      // above, e.g. hidden-but-possibly-edited) d rather than trusting the
      // baked ev.add[0].d — otherwise editing a source path upstream of a
      // boolean op and scrubbing forward past it would silently ignore the
      // edit. Falls back to the stored result if the op fails (degenerate
      // geometry) or a source can't be found (legacy save, deleted source).
      let add = ev.add
      if (ev.boolOp && add && add.length > 0) {
        const byId = new Map(paths.map((p) => [p.id, p]))
        const ds = ev.updates.flatMap((u) => {
          const src = byId.get(u.id)
          return src ? [src.d] : []
        })
        if (ds.length >= 2) {
          const result = applyBooleanOp(ev.boolOp, ds)
          if ('resultD' in result) {
            add = [{ ...add[0], d: result.resultD }, ...add.slice(1)]
          }
        }
      }
      if (add && add.length > 0) paths = [...paths, ...add]
      let operations = state.operations
      let tabs = state.tabs
      if (deleteIds.size > 0) {
        // refsPath takes one id at a time, so this stays a per-op scan of the
        // deleted ids — materialize them once rather than per operation.
        const deletedList = [...deleteIds]
        operations = operations.filter((op) => !deletedList.some((id) => refsPath(op, id)))
        tabs = tabs.filter((t) => !deleteIds.has(t.pathId))
      }
      return { paths, operations, tabs }
    }

    case 'paths.split': {
      const idx = state.paths.findIndex((p) => p.id === ev.pathId)
      if (idx === -1) return state
      return {
        paths: [...state.paths.slice(0, idx), ...ev.subPaths, ...state.paths.slice(idx + 1)],
        operations: ev.opsAfter ?? state.operations,
        tabs: state.tabs.filter((t) => t.pathId !== ev.pathId),
      }
    }

    case 'paths.setHidden': {
      const ids = new Set(ev.ids)
      return {
        ...state,
        paths: state.paths.map((p) => ids.has(p.id) ? { ...p, hidden: ev.hidden } : p),
      }
    }

    case 'shape.params':
      return {
        ...state,
        paths: state.paths.map((p) =>
          p.id === ev.pathId ? { ...p, d: generateShapeD(ev.params), shapeParams: ev.params } : p
        ),
      }

    case 'op.add':
      return { ...state, operations: [...state.operations, ev.op, ...(ev.linked ?? [])] }

    case 'op.update':
      return {
        ...state,
        operations: state.operations.map((o) =>
          o.id === ev.opId ? { ...o, ...ev.updates } as SerializedOperation : o
        ),
      }

    case 'op.delete': {
      const opIds = new Set(ev.opIds)
      return { ...state, operations: state.operations.filter((o) => !opIds.has(o.id)) }
    }

    case 'op.setVisible': {
      const ids = new Set(ev.opIds)
      return {
        ...state,
        operations: state.operations.map((o) =>
          ids.has(o.id) ? { ...o, visible: ev.visible } as SerializedOperation : o
        ),
      }
    }

    case 'op.reorder': {
      const byId = new Map(state.operations.map((o) => [o.id, o]))
      const ordered = ev.order.flatMap((id) => {
        const op = byId.get(id)
        if (!op) return []
        byId.delete(id)
        return [op]
      })
      // Ops missing from the order (shouldn't happen) keep their relative order at the end
      return { ...state, operations: [...ordered, ...byId.values()] }
    }

    case 'tabs.apply':
      return { ...state, tabs: [...state.tabs.filter((t) => t.pathId !== ev.pathId), ...ev.tabs] }

    case 'tabs.delete': {
      const tabIds = new Set(ev.tabIds)
      return { ...state, tabs: state.tabs.filter((t) => !tabIds.has(t.id)) }
    }

    case 'tabs.moveT':
      return {
        ...state,
        tabs: state.tabs.map((t) => t.id === ev.tabId ? { ...t, t: ev.t01 } : t),
      }

    case 'workpiece.set':
      return { ...state, workpiece: { ...state.workpiece, ...ev.changes } }

    case 'snapshot':
      return {
        paths: ev.state.paths,
        operations: ev.state.operations,
        tabs: ev.state.tabs,
        workpiece: ev.state.workpiece,
      }
  }
}

export function replay(genesis: Checkpoint, events: TimelineEvent[], uptoSeq?: number): ReplayState {
  let state: ReplayState = genesis
  for (const ev of events) {
    if (uptoSeq !== undefined && ev.seq > uptoSeq) break
    state = applyEvent(state, ev)
  }
  return state
}
