import { useCallback, useEffect, useRef, useState } from 'react'
import { useRefState } from './useRefState'
import { usePathsStore } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { regenerateAffected } from '../cam/regenerate'
import { parseDToNodes, nodesToD, type PathNode } from './nodeUtils'
import type { CrossPathEntry } from './layers/NodeEditLayer'

// One point-edit session: the live editable node copy, weld/connect gesture
// state, the session-local undo stack, and the commit/exit + store-sync
// lifecycle. Extracted from CanvasStage (tofix.md R3); the mouse/keyboard
// gesture handlers stay in CanvasStage and drive this state.

// Local undo entry. `globalStep: true` marks gestures that also wrote one
// atomic global history entry (cross-path join, loop split, trim split) —
// crossing such an entry replays the paired global undo/redo so the other
// path involved is restored in the same step.
export type NodeEditEntry = { nodes: PathNode[]; closed: boolean; globalStep?: boolean }

// Other-path nodes eligible as weld/connect targets: every node of a closed
// path, only the two endpoints of an open one. Soft-hidden paths (hidden:
// true) are invisible on canvas and must not attract welds (bugs.md B1).
export function collectCrossPathEntries(excludePathId: string | null): CrossPathEntry[] {
  const { paths } = usePathsStore.getState()
  const entries: CrossPathEntry[] = []
  for (const p of paths) {
    if (p.id === excludePathId || !p.visible || p.hidden) continue
    const parsed = parseDToNodes(p.d)
    if (parsed.nodes.length < 2) continue
    if (parsed.closed) {
      for (let j = 0; j < parsed.nodes.length; j++) {
        entries.push({ pathId: p.id, nodeIdx: j, x: parsed.nodes[j].x, y: parsed.nodes[j].y, nodes: parsed.nodes, closed: true })
      }
    } else {
      entries.push({ pathId: p.id, nodeIdx: 0, x: parsed.nodes[0].x, y: parsed.nodes[0].y, nodes: parsed.nodes, closed: false })
      const last = parsed.nodes.length - 1
      entries.push({ pathId: p.id, nodeIdx: last, x: parsed.nodes[last].x, y: parsed.nodes[last].y, nodes: parsed.nodes, closed: false })
    }
  }
  return entries
}

export function useNodeEditSession() {
  const nodeEditPathId = useUIStore((s) => s.nodeEditPathId)

  // Live editable copy of the path's nodes
  const [editNodes, editNodesRef, setEditNodes] = useRefState<PathNode[]>([])
  const [editClosed, editClosedRef, setEditClosed] = useRefState(false)

  const prevNodeEditPathIdRef = useRef<string | null>(null)
  const editDragInitRef = useRef<{ initialNodes: PathNode[]; startCNC: { x: number; y: number } } | null>(null)
  const [hoveredEditNode, hoveredEditNodeRef, setHoveredEditNode] = useRefState<number | null>(null)
  const [dragNodeIdx, setDragNodeIdx] = useState<number | null>(null)
  const [hoverSegIdx, hoverSegIdxRef, setHoverSegIdx] = useRefState<number | null>(null)
  const [weldTargetIdx, weldTargetIdxRef, setWeldTargetIdx] = useRefState<number | null>(null)
  const [connectSource, connectSourceRef, setConnectSource] = useRefState<number | null>(null)
  const [connectPreviewTo, setConnectPreviewTo] = useState<{ x: number; y: number } | null>(null)
  const [connectSnapTargetIdx, setConnectSnapTargetIdx] = useState<number | null>(null)
  const crossPathEntriesRef = useRef<CrossPathEntry[]>([])
  const [crossPathCandidates, setCrossPathCandidates] = useState<CrossPathEntry[]>([])
  const [crossPathWeldTarget, crossPathWeldTargetRef, setCrossPathWeldTarget] = useRefState<CrossPathEntry | null>(null)
  const localPast = useRef<NodeEditEntry[]>([])
  const localFuture = useRef<NodeEditEntry[]>([])

  // The eight-line "clear connect state" block used to be repeated at six call
  // sites — the canonical version.
  const clearConnectState = useCallback(() => {
    setConnectSource(null)
    setConnectPreviewTo(null)
    setConnectSnapTargetIdx(null)
    setCrossPathWeldTarget(null)
    setCrossPathCandidates([])
    crossPathEntriesRef.current = []
  }, [setConnectSource, setCrossPathWeldTarget])

  // Snapshot the PRE-gesture nodes+closed. `globalStep: true` for gestures that
  // also write one atomic global history entry (join/split) — see NodeEditEntry.
  const pushLocalUndo = useCallback((nodes: PathNode[], closed: boolean, globalStep = false) => {
    localPast.current = [...localPast.current, { nodes, closed, globalStep }]
    localFuture.current = []
    useUIStore.getState().setNodeEditHistoryFlags(true, false)
  }, [])

  // True while THIS component is writing to the paths store mid-session (join/
  // split gestures and their local undo/redo), so the external-change
  // subscription below doesn't re-parse our own writes.
  const selfWriteRef = useRef(false)

  const localUndo = useCallback(() => {
    if (localPast.current.length === 0) return
    const entry = localPast.current[localPast.current.length - 1]
    localFuture.current = [
      { nodes: editNodesRef.current, closed: editClosedRef.current, globalStep: entry.globalStep },
      ...localFuture.current,
    ]
    localPast.current = localPast.current.slice(0, -1)
    if (entry.globalStep) {
      // Replay the gesture's atomic global entry: restores the joined-away /
      // split-off path and the edited path's stored d in one step. Guarded so
      // the store subscription doesn't clobber the local restore below.
      selfWriteRef.current = true
      usePathsStore.getState().undo()
      selfWriteRef.current = false
    }
    setEditNodes(entry.nodes)
    setEditClosed(entry.closed)
    useUIStore.getState().setNodeEditHistoryFlags(localPast.current.length > 0, true)
  }, [])

  const localRedo = useCallback(() => {
    if (localFuture.current.length === 0) return
    const entry = localFuture.current[0]
    localPast.current = [
      ...localPast.current,
      { nodes: editNodesRef.current, closed: editClosedRef.current, globalStep: entry.globalStep },
    ]
    localFuture.current = localFuture.current.slice(1)
    if (entry.globalStep) {
      selfWriteRef.current = true
      usePathsStore.getState().redo()
      selfWriteRef.current = false
    }
    setEditNodes(entry.nodes)
    setEditClosed(entry.closed)
    useUIStore.getState().setNodeEditHistoryFlags(true, localFuture.current.length > 0)
  }, [])

  const commitEditNodes = useCallback((pid: string, nodes: PathNode[]) => {
    if (!pid) return
    const path = usePathsStore.getState().paths.find((p) => p.id === pid)
    if (!path) return // path removed while editing (e.g. global undo) — nothing to commit
    if (nodes.length < 2) {
      usePathsStore.getState().deletePath(pid)
      return
    }
    const d = nodesToD(nodes, editClosedRef.current)
    if (d === path.d) return // unchanged (e.g. join already wrote this d) — no history entry
    usePathsStore.getState().batchUpdatePaths([{ id: pid, d, shapeParams: null }])
    regenerateAffected(pid)
  }, [])

  const exitNodeEdit = useCallback(() => {
    const { nodeEditPathId: pid, setNodeEditPathId } = useUIStore.getState()
    if (!pid) return
    setNodeEditPathId(null)  // useEffect handles commit + cleanup
  }, [])

  // Parse path nodes when entering node edit mode; commit + clean up on exit
  useEffect(() => {
    const prevId = prevNodeEditPathIdRef.current
    prevNodeEditPathIdRef.current = nodeEditPathId
    localPast.current = []
    localFuture.current = []
    if (!nodeEditPathId) {
      // Commit using the captured id — nodeEditPathId is already null in the store at this point
      if (prevId) commitEditNodes(prevId, editNodesRef.current)
      setEditNodes([])
      setEditClosed(false)
      clearConnectState()
      useUIStore.getState().setNodeEditUndoRedo(null, null)
      useUIStore.getState().setNodeEditHistoryFlags(false, false)
      return
    }
    const path = usePathsStore.getState().paths.find((p) => p.id === nodeEditPathId)
    if (!path) { setEditNodes([]); return }
    const { nodes, closed } = parseDToNodes(path.d)
    setEditNodes(nodes)
    setEditClosed(closed)
    useUIStore.getState().setNodeEditUndoRedo(localUndo, localRedo)
  }, [nodeEditPathId, localUndo, localRedo, commitEditNodes]) // eslint-disable-line react-hooks/exhaustive-deps

  // While a node-edit session is active, a global undo/redo can rewrite or remove
  // the edited path underneath us (e.g. undoing a cross-path join restores both
  // source paths). Re-sync the live editNodes from the store, or leave the
  // session if the path no longer exists. Our own mid-session writes are skipped
  // via selfWriteRef.
  useEffect(() => {
    if (!nodeEditPathId) return
    return usePathsStore.subscribe((s, prev) => {
      if (selfWriteRef.current) return
      if (s.paths === prev.paths) return
      const cur = s.paths.find((p) => p.id === nodeEditPathId)
      if (!cur) {
        // Path gone (undo past its creation / join) — abandon the session.
        // commitEditNodes finds no path on exit, so nothing is written back.
        useUIStore.getState().setNodeEditPathId(null)
        return
      }
      const prevPath = prev.paths.find((p) => p.id === nodeEditPathId)
      if (prevPath && prevPath.d === cur.d) return
      const { nodes, closed } = parseDToNodes(cur.d)
      setEditNodes(nodes)
      setEditClosed(closed)
      // Local snapshots and connect state reference the pre-undo geometry — drop them.
      localPast.current = []
      localFuture.current = []
      useUIStore.getState().setNodeEditHistoryFlags(false, false)
      clearConnectState()
    })
  }, [nodeEditPathId]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    editNodes, editNodesRef, setEditNodes,
    editClosed, editClosedRef, setEditClosed,
    hoveredEditNode, hoveredEditNodeRef, setHoveredEditNode,
    dragNodeIdx, setDragNodeIdx,
    hoverSegIdx, hoverSegIdxRef, setHoverSegIdx,
    weldTargetIdx, weldTargetIdxRef, setWeldTargetIdx,
    connectSource, connectSourceRef, setConnectSource,
    connectPreviewTo, setConnectPreviewTo,
    connectSnapTargetIdx, setConnectSnapTargetIdx,
    crossPathEntriesRef, crossPathCandidates, setCrossPathCandidates,
    crossPathWeldTarget, crossPathWeldTargetRef, setCrossPathWeldTarget,
    editDragInitRef, selfWriteRef,
    pushLocalUndo, localUndo, localRedo,
    commitEditNodes, exitNodeEdit, clearConnectState,
  }
}
