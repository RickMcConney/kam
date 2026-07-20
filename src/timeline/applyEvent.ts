import type { Checkpoint, SerializedOperation, TimelineEvent } from './events'
import { refsPathId, type AnyOperation } from '../store/toolpathStore'
import { generateShapeD } from '../shapes/shapeGenerators'

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
    case 'paths.add':
      return { ...state, paths: [...state.paths, ...ev.paths] }

    case 'paths.edit': {
      const deleteIds = ev.deleteIds ?? []
      const map = new Map(ev.updates.map((u) => [u.id, u]))
      let paths = state.paths
        .filter((p) => !deleteIds.includes(p.id))
        .map((p) => {
          const upd = map.get(p.id)
          if (!upd) return p
          const np = { ...p, d: upd.d }
          if (upd.shapeParams !== undefined) np.shapeParams = upd.shapeParams ?? undefined
          if (upd.name !== undefined) np.name = upd.name
          if (upd.hidden !== undefined) np.hidden = upd.hidden
          return np
        })
      if (ev.add && ev.add.length > 0) paths = [...paths, ...ev.add]
      let operations = state.operations
      let tabs = state.tabs
      if (deleteIds.length > 0) {
        operations = operations.filter((op) => !deleteIds.some((id) => refsPath(op, id)))
        tabs = tabs.filter((t) => !deleteIds.includes(t.pathId))
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

    case 'paths.setHidden':
      return {
        ...state,
        paths: state.paths.map((p) => ev.ids.includes(p.id) ? { ...p, hidden: ev.hidden } : p),
      }

    case 'shape.params':
      return {
        ...state,
        paths: state.paths.map((p) =>
          p.id === ev.pathId ? { ...p, d: generateShapeD(ev.params), shapeParams: ev.params } : p
        ),
      }

    case 'op.add':
      return { ...state, operations: [...state.operations, ev.op] }

    case 'op.update':
      return {
        ...state,
        operations: state.operations.map((o) =>
          o.id === ev.opId ? { ...o, ...ev.updates } as SerializedOperation : o
        ),
      }

    case 'op.delete':
      return { ...state, operations: state.operations.filter((o) => !ev.opIds.includes(o.id)) }

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

    case 'tabs.delete':
      return { ...state, tabs: state.tabs.filter((t) => !ev.tabIds.includes(t.id)) }

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
