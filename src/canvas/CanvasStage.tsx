import { useCallback, useEffect, useRef, useState } from 'react'
import { ICON } from '../theme'
import { Stage, Layer, Group, Circle } from 'react-konva'
import type Konva from 'konva'
import { Maximize2 } from 'lucide-react'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useCanvasStore } from '../store/canvasStore'
import { usePathsStore } from '../store/pathsStore'
import { regenerateAffected } from '../cam/regenerate'
import { flattenPath } from '../cam/pathFlattener'
import type { ImportedPath } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { importSvg, nextPathColor } from '../importers/svgImporter'
import { GridLayer } from './layers/GridLayer'
import { WorkpieceLayer, originWorldXY } from './layers/WorkpieceLayer'
import { majorStepMM, minorStepMM } from './gridUtils'
import { OriginLayer } from './layers/OriginLayer'
import {  RULER_H, RULER_W } from './layers/RulerLayer'
import { DesignLayer } from './layers/DesignLayer'
import { ToolpathLayer } from './layers/ToolpathLayer'
import { SelectionLayer, SelectionHandleLayer } from './layers/SelectionLayer'
import { ShapePreviewLayer } from './layers/ShapePreviewLayer'
import { PenLayer } from './layers/PenLayer'
import { penNodesToPathD, type PenCurveType } from '../cam/penCurves'
import { SimulationLayer } from './layers/SimulationLayer'
import SimulationPlayer from '../sim/SimulationPlayer'
import { useSimStore } from '../store/simStore'
import type { HandleType, LiveTransform } from './types'
import { getBBox, getMultiBBox, translateD, scaleAroundD, rotateAroundD, skewAroundD } from './selectionUtils'
import type { BBox } from './selectionUtils'
import {
  generateShapeD,
  shapeParamsFromDrag,
  shapeParamsFromConfig,
  shapeDisplayName,
  translateShapeParams,
  scaleShapeParams,
  type ShapeType,
} from '../shapes/shapeGenerators'
import type { PenNode } from '../store/uiStore'
import { NodeEditLayer } from './layers/NodeEditLayer'
import { TabLayer } from './layers/TabLayer'
import { parseDToNodes, nodesToD, removeNode, insertNodeOnSegment, splitCompoundPath, weldNodes, deleteSegment, joinPaths, joinPathsConnect, endpointToMidpointWeld, connectEndpointToInterior, toggleNodeCurvature } from './nodeUtils'
import type { PathNode } from './nodeUtils'
import type { CrossPathEntry } from './layers/NodeEditLayer'

export interface Viewport {
  x: number
  y: number
  scale: number
}

// ── Path proximity helpers ────────────────────────────────────────────────────

function ptSegDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax, aby = by - ay
  const len2 = abx * abx + aby * aby
  if (len2 === 0) return (px - ax) ** 2 + (py - ay) ** 2
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2))
  return (px - ax - t * abx) ** 2 + (py - ay - t * aby) ** 2
}

function distToPolylines(px: number, py: number, polys: [number, number][][]): number {
  let minSq = Infinity
  for (const poly of polys) {
    for (let i = 1; i < poly.length; i++) {
      const [ax, ay] = poly[i - 1], [bx, by] = poly[i]
      const d = ptSegDistSq(px, py, ax, ay, bx, by)
      if (d < minSq) minSq = d
    }
  }
  return Math.sqrt(minSq)
}

function closestVisiblePath(
  px: number, py: number,
  paths: ImportedPath[],
  thresholdMM: number,
  cache: Map<string, [number, number][][]>,
): ImportedPath | null {
  let best: ImportedPath | null = null
  let bestDist = thresholdMM
  for (const p of paths) {
    let polys = cache.get(p.d)
    if (!polys) { polys = flattenPath(p.d, 0.5); cache.set(p.d, polys) }
    const dist = distToPolylines(px, py, polys)
    if (dist < bestDist) { bestDist = dist; best = p }
  }
  return best
}

// ─────────────────────────────────────────────────────────────────────────────

function fitViewport(sw: number, sh: number, ww: number, wh: number): Viewport {
  const uw = sw - RULER_W
  const uh = sh - RULER_H
  const scale = Math.min(uw / ww, uh / wh) * 0.85
  return {
    scale,
    x: RULER_W + (uw - ww * scale) / 2,
    y: RULER_H + uh - (uh - wh * scale) / 2,
  }
}

// Smallest zoom (px/mm) allowed: the point where the whole table just fits the
// canvas. Zooming out further is clamped to this so the table can't shrink to a
// speck — the user can pan if they need room past the table edge. Falls back to
// a tiny floor if sizes aren't known yet.
function minZoomScale(sw: number, sh: number, tableW: number, tableH: number): number {
  const uw = sw - RULER_W
  const uh = sh - RULER_H
  if (uw <= 0 || uh <= 0 || tableW <= 0 || tableH <= 0) return 0.01
  return Math.max(0.01, Math.min(uw / tableW, uh / tableH))
}

function screenToCNC(sx: number, sy: number, vp: Viewport): { x: number; y: number } {
  return { x: (sx - vp.x) / vp.scale, y: (vp.y - sy) / vp.scale }
}

type CanvasMode =
  | { type: 'idle' }
  | { type: 'pan' }
  | { type: 'move'; pathIds: string[]; startCNC: { x: number; y: number } }
  | { type: 'resize'; pathIds: string[]; handle: HandleType; anchor: { x: number; y: number }; initHandle: { x: number; y: number }; initBbox: BBox; shiftHeld: boolean }
  | { type: 'rotate'; pathIds: string[]; center: { x: number; y: number }; initAngle: number }
  | { type: 'dragbox'; startScreen: { x: number; y: number } }
  | { type: 'drawshape'; startCNC: { x: number; y: number }; currentCNC: { x: number; y: number } }
  | { type: 'pendraw'; anchorCNC: { x: number; y: number }; closing: boolean }
  | { type: 'nodedit-drag'; nodeIdx: number; kind: 'anchor' | 'handle-in' | 'handle-out' }

const MOVE_THRESHOLD_PX = 4  // pixels before a click is treated as a drag

function snapPoint(
  cnc: { x: number; y: number },
  vp: Viewport,
  units: 'mm' | 'in',
  orgWorld: { x: number; y: number },
): { x: number; y: number } {
  const step = minorStepMM(majorStepMM(vp.scale, units), units)
  if (step <= 0) return cnc
  return {
    x: Math.round((cnc.x - orgWorld.x) / step) * step + orgWorld.x,
    y: Math.round((cnc.y - orgWorld.y) / step) * step + orgWorld.y,
  }
}

function NodeEditDimensionOverlay({
  viewport,
  nodes,
  closed,
  dragNodeIdx,
  hoverSegIdx,
}: {
  viewport: Viewport
  nodes: PathNode[]
  closed: boolean
  dragNodeIdx: number | null
  hoverSegIdx: number | null
}) {
  const { units } = useWorkpieceStore()
  if (nodes.length < 2) return null

  const fmt = (d: number) =>
    units === 'in' ? (d / 25.4).toFixed(3) + '"' : d.toFixed(2) + ' mm'

  const segLabel = (fromIdx: number, toIdx: number) => {
    const a = nodes[fromIdx], b = nodes[toIdx]
    const dist = Math.hypot(b.x - a.x, b.y - a.y)
    if (dist < 0.01) return null
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    return { sx: viewport.x + mx * viewport.scale, sy: viewport.y - my * viewport.scale, text: fmt(dist) }
  }

  const labels: { sx: number; sy: number; text: string }[] = []

  if (dragNodeIdx !== null && nodes[dragNodeIdx]) {
    const prevIdx = dragNodeIdx > 0 ? dragNodeIdx - 1 : closed ? nodes.length - 1 : -1
    if (prevIdx >= 0) {
      const l = segLabel(prevIdx, dragNodeIdx)
      if (l) labels.push(l)
    }
    const nextIdx = dragNodeIdx < nodes.length - 1 ? dragNodeIdx + 1 : closed ? 0 : -1
    if (nextIdx >= 0 && nextIdx !== prevIdx) {
      const l = segLabel(dragNodeIdx, nextIdx)
      if (l) labels.push(l)
    }
  } else if (hoverSegIdx !== null) {
    const toIdx = (hoverSegIdx + 1) % nodes.length
    if (closed || toIdx !== 0) {
      const l = segLabel(hoverSegIdx, toIdx)
      if (l) labels.push(l)
    }
  }

  if (labels.length === 0) return null

  return (
    <>
      {labels.map((l, i) => (
        <div
          key={i}
          className="absolute pointer-events-none bg-black/70 text-white text-xs px-1.5 py-0.5 rounded font-mono whitespace-nowrap z-10"
          style={{ left: l.sx, top: l.sy - 36, transform: 'translateX(-50%)' }}
        >
          {l.text}
        </div>
      ))}
    </>
  )
}

function PenLengthOverlay({ viewport, draggingHandle }: { viewport: Viewport; draggingHandle: boolean }) {
  const activeTool = useUIStore((s) => s.activeTool)
  const penNodes = useUIStore((s) => s.penNodes)
  const snapEnabled = useUIStore((s) => s.snapEnabled)
  const cursorMM = useCanvasStore((s) => s.cursorMM)
  const { units, origin, widthMM, heightMM } = useWorkpieceStore()

  if (activeTool !== 'pen' || penNodes.length === 0 || !cursorMM || draggingHandle) return null

  let cursor = cursorMM
  if (snapEnabled) {
    const org = originWorldXY(origin, widthMM, heightMM)
    cursor = snapPoint(cursorMM, viewport, units, org)
  }

  const last = penNodes[penNodes.length - 1]
  const dist = Math.hypot(cursor.x - last.x, cursor.y - last.y)
  if (dist < 0.01) return null

  const sx = viewport.x + cursor.x * viewport.scale
  const sy = viewport.y - cursor.y * viewport.scale
  const label = units === 'in'
    ? (dist / 25.4).toFixed(3) + '"'
    : dist.toFixed(2) + ' mm'

  return (
    <div
      className="absolute pointer-events-none bg-black/70 text-white text-xs px-1.5 py-0.5 rounded font-mono whitespace-nowrap z-10"
      style={{ left: sx + 14, top: sy - 22 }}
    >
      {label}
    </div>
  )
}

export default function CanvasStage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [viewport, setViewportState] = useState<Viewport>({ x: 0, y: 0, scale: 2 })
  const viewportRef = useRef<Viewport>(viewport)
  const spaceHeldRef = useRef(false)
  const shiftHeldRef = useRef(false)

  const modeRef = useRef<CanvasMode>({ type: 'idle' })
  const [liveTransform, setLiveTransform] = useState<LiveTransform | null>(null)
  const [dragBox, setDragBox] = useState<{ sx: number; sy: number; ex: number; ey: number } | null>(null)
  const [liveShapeD, setLiveShapeD] = useState<string | null>(null)
  const [livePen, setLivePen] = useState<{ anchor: { x: number; y: number }; handle: { x: number; y: number } | null } | null>(null)
  const penClosingRef = useRef(false)
  const [penClosing, setPenClosing] = useState(false)
  const altDownRef = useRef(false)
  const [altDown, setAltDown] = useState(false)
  const didDragRef = useRef(false)
  const flatCache = useRef(new Map<string, [number, number][][]>())

  const { widthMM, heightMM } = useWorkpieceStore()
  // Use individual selectors for actions — Zustand action refs are stable so these never trigger re-renders
  const setCursorMM = useCanvasStore((s) => s.setCursorMM)
  const setZoomPct = useCanvasStore((s) => s.setZoomPct)
  const setLiveRotationAngle = useCanvasStore((s) => s.setLiveRotationAngle)
  const { paths, selectedIds, selectPath, setSelectedIds } = usePathsStore()
  const addPaths = usePathsStore((s) => s.addPaths)
  const setSidebarTab = useUIStore((s) => s.setSidebarTab)
  const pendingDrillPoints = useUIStore((s) => s.pendingDrillPoints)
  const penNodes = useUIStore((s) => s.penNodes)
  const penCurveType = useUIStore((s) => s.penCurveType)
  const nodeEditPathId = useUIStore((s) => s.nodeEditPathId)
  const effectiveCurveType: PenCurveType = altDown
    ? (penCurveType === 'linear' ? 'catmull-rom' : 'linear')
    : penCurveType

  // Node edit state — live editable copy of the path's nodes
  const [editNodes, setEditNodes] = useState<PathNode[]>([])
  const [editClosed, setEditClosed] = useState(false)
  const editNodesRef = useRef<PathNode[]>([])
  const editClosedRef = useRef(false)
  useEffect(() => { editNodesRef.current = editNodes }, [editNodes])
  useEffect(() => { editClosedRef.current = editClosed }, [editClosed])

  const prevNodeEditPathIdRef = useRef<string | null>(null)
  const editDragInitRef = useRef<{ initialNodes: PathNode[]; startCNC: { x: number; y: number } } | null>(null)
  const hoveredEditNodeRef = useRef<number | null>(null)
  const [hoveredEditNode, setHoveredEditNode] = useState<number | null>(null)
  const [dragNodeIdx, setDragNodeIdx] = useState<number | null>(null)
  const [hoverSegIdx, setHoverSegIdx] = useState<number | null>(null)
  const hoverSegIdxRef = useRef<number | null>(null)
  const [weldTargetIdx, setWeldTargetIdx] = useState<number | null>(null)
  const weldTargetIdxRef = useRef<number | null>(null)
  const [connectSource, setConnectSource] = useState<number | null>(null)
  const connectSourceRef = useRef<number | null>(null)
  const [connectPreviewTo, setConnectPreviewTo] = useState<{ x: number; y: number } | null>(null)
  const [connectSnapTargetIdx, setConnectSnapTargetIdx] = useState<number | null>(null)
  const crossPathEntriesRef = useRef<CrossPathEntry[]>([])
  const [crossPathCandidates, setCrossPathCandidates] = useState<CrossPathEntry[]>([])
  const [crossPathWeldTarget, setCrossPathWeldTarget] = useState<CrossPathEntry | null>(null)
  const crossPathWeldTargetRef = useRef<CrossPathEntry | null>(null)
  const localPast = useRef<PathNode[][]>([])
  const localFuture = useRef<PathNode[][]>([])
  const drillPast = useRef<{ x: number; y: number }[][]>([])
  const penPast = useRef<PenNode[][]>([])
  const penFuture = useRef<PenNode[][]>([])

  const pushLocalUndo = useCallback((snapshot: PathNode[]) => {
    localPast.current = [...localPast.current, snapshot]
    localFuture.current = []
    useUIStore.getState().setNodeEditHistoryFlags(true, false)
  }, [])

  const localUndo = useCallback(() => {
    if (localPast.current.length === 0) return
    const prev = localPast.current[localPast.current.length - 1]
    localFuture.current = [editNodesRef.current, ...localFuture.current]
    localPast.current = localPast.current.slice(0, -1)
    setEditNodes(prev)
    editNodesRef.current = prev
    useUIStore.getState().setNodeEditHistoryFlags(localPast.current.length > 0, true)
  }, [])

  const localRedo = useCallback(() => {
    if (localFuture.current.length === 0) return
    const next = localFuture.current[0]
    localPast.current = [...localPast.current, editNodesRef.current]
    localFuture.current = localFuture.current.slice(1)
    setEditNodes(next)
    editNodesRef.current = next
    useUIStore.getState().setNodeEditHistoryFlags(true, localFuture.current.length > 0)
  }, [])

  const drillUndo = useCallback(() => {
    if (drillPast.current.length === 0) return
    const prev = drillPast.current[drillPast.current.length - 1]
    drillPast.current = drillPast.current.slice(0, -1)
    useUIStore.getState().setDrillPoints(prev)
  }, [])

  const penUndoFn = useCallback(() => {
    if (penPast.current.length === 0) return
    const prev = penPast.current[penPast.current.length - 1]
    penFuture.current = [useUIStore.getState().penNodes, ...penFuture.current]
    penPast.current = penPast.current.slice(0, -1)
    useUIStore.getState().setPenNodes(prev)
    useUIStore.getState().setNodeEditHistoryFlags(penPast.current.length > 0, true)
  }, [])

  const penRedoFn = useCallback(() => {
    if (penFuture.current.length === 0) return
    const next = penFuture.current[0]
    penPast.current = [...penPast.current, useUIStore.getState().penNodes]
    penFuture.current = penFuture.current.slice(1)
    useUIStore.getState().setPenNodes(next)
    useUIStore.getState().setNodeEditHistoryFlags(true, penFuture.current.length > 0)
  }, [])

  const setMode2 = useCallback((m: CanvasMode) => {
    modeRef.current = m
  }, [])

  const snapCNC = useCallback((cnc: { x: number; y: number }): { x: number; y: number } => {
    const { snapEnabled } = useUIStore.getState()
    if (!snapEnabled) return cnc
    const { units, origin, widthMM, heightMM } = useWorkpieceStore.getState()
    const org = originWorldXY(origin, widthMM, heightMM)
    return snapPoint(cnc, viewportRef.current, units, org)
  }, [])

  // Snap to nearest visible path vertex within 10 screen px, then fall back to grid snap.
  const snapDrillPoint = useCallback((cnc: { x: number; y: number }): { x: number; y: number } => {
    const vp = viewportRef.current
    const radiusCNC = 10 / vp.scale
    const { paths: allPaths } = usePathsStore.getState()
    let bestDist = radiusCNC
    let best: { x: number; y: number } | null = null
    for (const p of allPaths) {
      if (!p.visible) continue
      let polys = flatCache.current.get(p.d)
      if (!polys) { polys = flattenPath(p.d, 0.5); flatCache.current.set(p.d, polys) }
      for (const poly of polys) {
        for (const [vx, vy] of poly) {
          const d = Math.hypot(vx - cnc.x, vy - cnc.y)
          if (d < bestDist) { bestDist = d; best = { x: vx, y: vy } }
        }
      }
    }
    if (best) return best
    return snapCNC(cnc)
  }, [snapCNC])

const handleCanvasDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (!file) return
    if (!file.name.endsWith('.svg') && file.type !== 'image/svg+xml') return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const result = importSvg(ev.target?.result as string, {})
        if (result.paths.length > 0) {
          const bbox = getMultiBBox(result.paths.map(p => p.d))
          if (bbox) {
            const dx = widthMM / 2 - (bbox.minX + bbox.maxX) / 2
            const dy = heightMM / 2 - (bbox.minY + bbox.maxY) / 2
            if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001)
              for (const path of result.paths) path.d = translateD(path.d, dx, dy)
          }
          addPaths(result.paths)
          setSidebarTab('paths')
        }
      } catch { /* ignore */ }
    }
    reader.readAsText(file)
  }, [addPaths, setSidebarTab, widthMM, heightMM])

  const setViewport = useCallback((v: Viewport | ((p: Viewport) => Viewport)) => {
    const next = typeof v === 'function' ? v(viewportRef.current) : v
    viewportRef.current = next
    setViewportState(next)
    setZoomPct(next.scale)
  }, [setZoomPct])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) setSize({ width, height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fitRequest = useCanvasStore((s) => s.fitRequest)
  const didFitRef = useRef(false)
  useEffect(() => {
    if (size.width > 100 && !didFitRef.current) {
      didFitRef.current = true
      setViewport(fitViewport(size.width, size.height, widthMM, heightMM))
    }
  }, [size, widthMM, heightMM, setViewport])

  useEffect(() => {
    if (fitRequest === 0 || size.width <= 100) return
    setViewport(fitViewport(size.width, size.height, widthMM, heightMM))
  }, [fitRequest, size, widthMM, heightMM, setViewport])

  const fitToWorkpiece = useCallback(() => {
    setViewport(fitViewport(size.width, size.height, widthMM, heightMM))
  }, [size, widthMM, heightMM, setViewport])

  const commitEditNodes = useCallback((pid: string, nodes: PathNode[]) => {
    if (!pid) return
    if (nodes.length < 2) {
      usePathsStore.getState().deletePath(pid)
      return
    }
    const d = nodesToD(nodes, editClosedRef.current)
    usePathsStore.getState().batchUpdatePaths([{ id: pid, d, shapeParams: null }])
    regenerateAffected(pid)
  }, [])

  const exitNodeEdit = useCallback(() => {
    const { nodeEditPathId: pid, setNodeEditPathId } = useUIStore.getState()
    if (!pid) return
    setNodeEditPathId(null)  // useEffect handles commit + cleanup
  }, [])

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
      if (e.code === 'Space' && !useSimStore.getState().gcode) { e.preventDefault(); spaceHeldRef.current = true }
      if (e.shiftKey) shiftHeldRef.current = true
      if (e.key === 'Alt') {
        if (useUIStore.getState().activeTool === 'pen') e.preventDefault()
        altDownRef.current = true
        setAltDown(true)
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const { nodeEditPathId: pid } = useUIStore.getState()
        if (pid) {
          if (hoveredEditNodeRef.current !== null) {
            // Delete hovered node
            e.stopImmediatePropagation()
            e.preventDefault()
            const idx = hoveredEditNodeRef.current
            pushLocalUndo(editNodesRef.current)
            const next = removeNode(editNodesRef.current, idx)
            editNodesRef.current = next
            setEditNodes(next)
            hoveredEditNodeRef.current = null
            setHoveredEditNode(null)
          } else if (hoverSegIdxRef.current !== null) {
            // Trim hovered segment
            e.stopImmediatePropagation()
            e.preventDefault()
            const segIdx = hoverSegIdxRef.current
            const old = editNodesRef.current
            pushLocalUndo(old)
            const result = deleteSegment(old, segIdx, editClosedRef.current)
            setEditNodes(result.nodes)
            editNodesRef.current = result.nodes
            if (result.closed !== editClosedRef.current) {
              editClosedRef.current = result.closed
              setEditClosed(result.closed)
            }
            if (result.secondPath) {
              // Split: create a new path for the second segment
              const { nodeEditPathId: currentPid } = useUIStore.getState()
              const secondD = nodesToD(result.secondPath, false)
              if (secondD && currentPid) {
                const newId = `trim-${Date.now()}`
                const { paths: allPaths } = usePathsStore.getState()
                const srcPath = allPaths.find((p) => p.id === currentPid)
                usePathsStore.getState().addPaths([{
                  id: newId,
                  name: srcPath?.name ?? 'Path',
                  d: secondD,
                  visible: true,
                  color: srcPath?.color ?? nextPathColor(),
                }])
              }
            }
            setHoverSegIdx(null)
            hoverSegIdxRef.current = null
          }
        }
      }

      if (e.code === 'Escape') {
        const { nodeEditPathId: neid } = useUIStore.getState()
        if (neid) {
          if (connectSourceRef.current !== null) {
            connectSourceRef.current = null
            setConnectSource(null)
            setConnectPreviewTo(null)
            setConnectSnapTargetIdx(null)
            crossPathWeldTargetRef.current = null
            setCrossPathWeldTarget(null)
            setCrossPathCandidates([])
            crossPathEntriesRef.current = []
          } else {
            exitNodeEdit()
          }
          return
        }
        const { activeTool, setActiveTool, clearDrillPoints, penNodes: nodes, clearPenNodes, penCurveType: ct } = useUIStore.getState()
        if (activeTool === 'pen') {
          if (nodes.length >= 2) {
            const d = penNodesToPathD(nodes, false, ct)
            if (d) {
              const id = `pen-${Date.now()}`
              usePathsStore.getState().addPaths([{ id, name: 'Pen Path', d, visible: true, color: nextPathColor() }])
              usePathsStore.getState().selectPath(id)
            }
          }
          clearPenNodes()
          setActiveTool('select')
          setLivePen(null)
          setPenClosing(false)
          penClosingRef.current = false
          setMode2({ type: 'idle' })
        } else if (activeTool !== 'select') {
          if (activeTool === 'drill') clearDrillPoints()
          setActiveTool('select')
          setLiveShapeD(null)
          setMode2({ type: 'idle' })
        }
      }
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeldRef.current = false
      if (!e.shiftKey) shiftHeldRef.current = false
      if (e.key === 'Alt') { altDownRef.current = false; setAltDown(false) }
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp) }
  }, [setMode2, exitNodeEdit, pushLocalUndo])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const prevent = (e: WheelEvent) => e.preventDefault()
    el.addEventListener('wheel', prevent, { passive: false })
    return () => el.removeEventListener('wheel', prevent)
  }, [])

  const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    const pointer = stageRef.current?.getPointerPosition()
    if (!pointer) return
    const factor = e.evt.deltaY < 0 ? 1.12 : 1 / 1.12
    // Cap zoom-out at the table size + margin so the user can't lose the table.
    const { tableLimitWidthMM, tableLimitHeightMM } = useWorkpieceStore.getState()
    const minScale = minZoomScale(size.width, size.height, tableLimitWidthMM, tableLimitHeightMM)
    setViewport((vp) => {
      const newScale = Math.min(Math.max(vp.scale * factor, minScale), 500)
      const ratio = newScale / vp.scale
      return {
        scale: newScale,
        x: pointer.x - (pointer.x - vp.x) * ratio,
        y: pointer.y + (vp.y - pointer.y) * ratio,
      }
    })
  }, [setViewport, size])

  // Start drawing a shape from the given CNC point (used by both stage and path mousedown when shape tool active)
  const startDrawShape = useCallback((pointer: { x: number; y: number }) => {
    const vp = viewportRef.current
    const cnc = screenToCNC(pointer.x, pointer.y, vp)
    didDragRef.current = false
    setMode2({ type: 'drawshape', startCNC: cnc, currentCNC: cnc })
  }, [setMode2])

  // Start placing a pen node from the given screen pointer position
  const startPenDraw = useCallback((pointer: { x: number; y: number }) => {
    const vp = viewportRef.current
    const cnc = snapCNC(screenToCNC(pointer.x, pointer.y, vp))
    const { penNodes: nodes } = useUIStore.getState()

    if (nodes.length >= 2) {
      const first = nodes[0]
      const fsx = vp.x + first.x * vp.scale
      const fsy = vp.y - first.y * vp.scale
      if (Math.hypot(pointer.x - fsx, pointer.y - fsy) < 10) {
        didDragRef.current = false
        setMode2({ type: 'pendraw', anchorCNC: cnc, closing: true })
        return
      }
    }

    didDragRef.current = false
    setMode2({ type: 'pendraw', anchorCNC: cnc, closing: false })
    setLivePen({ anchor: cnc, handle: null })
  }, [setMode2, snapCNC])

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
      connectSourceRef.current = null
      setConnectSource(null)
      setConnectPreviewTo(null)
      setConnectSnapTargetIdx(null)
      crossPathWeldTargetRef.current = null
      setCrossPathWeldTarget(null)
      setCrossPathCandidates([])
      crossPathEntriesRef.current = []
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
  }, [nodeEditPathId, localUndo, localRedo, commitEditNodes])

  // Register drill-local undo only while there are pending drill points to undo.
  // When points are empty (e.g. after generation or after undoing all), unregister so
  // the toolbar button and keyboard shortcut fall through to the global path undo.
  const activeTool = useUIStore((s) => s.activeTool)
  useEffect(() => {
    if (activeTool === 'drill' && pendingDrillPoints.length > 0) {
      useUIStore.getState().setNodeEditUndoRedo(drillUndo, null)
      useUIStore.getState().setNodeEditHistoryFlags(true, false)
    } else {
      drillPast.current = []
      if (useUIStore.getState().nodeEditUndo === drillUndo) {
        useUIStore.getState().setNodeEditUndoRedo(null, null)
        useUIStore.getState().setNodeEditHistoryFlags(false, false)
      }
    }
  }, [activeTool, pendingDrillPoints.length, drillUndo])

  useEffect(() => {
    if (activeTool === 'pen') {
      useUIStore.getState().setNodeEditUndoRedo(penUndoFn, penRedoFn)
      useUIStore.getState().setNodeEditHistoryFlags(false, false)
    } else {
      penPast.current = []
      penFuture.current = []
      if (useUIStore.getState().nodeEditUndo === penUndoFn) {
        useUIStore.getState().setNodeEditUndoRedo(null, null)
        useUIStore.getState().setNodeEditHistoryFlags(false, false)
      }
    }
  }, [activeTool, penUndoFn, penRedoFn])

  const handleNodeMouseDown = useCallback((nodeIdx: number, kind: 'anchor' | 'handle-in' | 'handle-out', e: Konva.KonvaEventObject<MouseEvent>) => {
    if (kind === 'anchor' && (e.evt.altKey || altDownRef.current)) {
      e.cancelBubble = true
      e.evt.preventDefault()
      const old = editNodesRef.current
      const next = toggleNodeCurvature(old, nodeIdx, editClosedRef.current)
      pushLocalUndo(old)
      setEditNodes(next)
      editNodesRef.current = next
      return
    }

    const vp = viewportRef.current
    const pointer = e.target.getStage()?.getPointerPosition()
    if (!pointer) return
    const cnc = { x: (pointer.x - vp.x) / vp.scale, y: (vp.y - pointer.y) / vp.scale }

    editDragInitRef.current = {
      initialNodes: editNodesRef.current.map((n) => ({
        ...n,
        handleIn: n.handleIn ? { ...n.handleIn } : undefined,
        handleOut: n.handleOut ? { ...n.handleOut } : undefined,
      })),
      startCNC: cnc,
    }
    didDragRef.current = false
    setMode2({ type: 'nodedit-drag', nodeIdx, kind })
    setDragNodeIdx(kind === 'anchor' ? nodeIdx : null)

    // Gather cross-path weld candidates when dragging an endpoint of an open path
    crossPathEntriesRef.current = []
    crossPathWeldTargetRef.current = null
    setCrossPathWeldTarget(null)
    if (kind === 'anchor' && !editClosedRef.current) {
      const curNodes = editNodesRef.current
      if (nodeIdx === 0 || nodeIdx === curNodes.length - 1) {
        const { nodeEditPathId: pid } = useUIStore.getState()
        const { paths: allPaths } = usePathsStore.getState()
        const entries: CrossPathEntry[] = []
        for (const p of allPaths) {
          if (p.id === pid || !p.visible) continue
          const parsed = parseDToNodes(p.d)
          if (parsed.nodes.length < 2) continue
          if (parsed.closed) {
            // All nodes of a closed path are valid weld targets
            for (let j = 0; j < parsed.nodes.length; j++) {
              entries.push({ pathId: p.id, nodeIdx: j, x: parsed.nodes[j].x, y: parsed.nodes[j].y, nodes: parsed.nodes, closed: true })
            }
          } else {
            // Only the two endpoints of an open path
            entries.push({ pathId: p.id, nodeIdx: 0, x: parsed.nodes[0].x, y: parsed.nodes[0].y, nodes: parsed.nodes, closed: false })
            const last = parsed.nodes.length - 1
            entries.push({ pathId: p.id, nodeIdx: last, x: parsed.nodes[last].x, y: parsed.nodes[last].y, nodes: parsed.nodes, closed: false })
          }
        }
        crossPathEntriesRef.current = entries
        setCrossPathCandidates(entries)
      }
    } else {
      setCrossPathCandidates([])
    }
  }, [setMode2])

  const handleSegmentMouseDown = useCallback((segIdx: number, cncX: number, cncY: number) => {
    const { nodeEditPathId: pid } = useUIStore.getState()
    if (!pid) return
    const old = editNodesRef.current
    const next = insertNodeOnSegment(old, segIdx, cncX, cncY, editClosedRef.current)
    pushLocalUndo(old)
    setEditNodes(next)
    editNodesRef.current = next
  }, [pushLocalUndo])

  const handlePathDblClick = useCallback((id: string) => {
    const path = usePathsStore.getState().paths.find((p) => p.id === id)
    if (!path) return
    const subDs = splitCompoundPath(path.d)
    if (subDs.length > 1) {
      usePathsStore.getState().splitPath(id, subDs)
      return
    }
    const { setNodeEditPathId, setActiveTool } = useUIStore.getState()
    setActiveTool('select')
    usePathsStore.getState().selectPath(id)
    setNodeEditPathId(id)
  }, [])

  const handleHoveredNodeChange = useCallback((idx: number | null) => {
    hoveredEditNodeRef.current = idx
    setHoveredEditNode(idx)
  }, [])

  const handleStageDblClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0) return
    const { activeTool, nodeEditPathId: neid } = useUIStore.getState()
    if (activeTool !== 'select') return
    const pointer = stageRef.current?.getPointerPosition()
    if (!pointer) return
    const vp = viewportRef.current
    const cnc = screenToCNC(pointer.x, pointer.y, vp)
    const { paths } = usePathsStore.getState()
    const candidates = paths.filter((p) => p.visible && p.id !== neid)
    const hit = closestVisiblePath(cnc.x, cnc.y, candidates, 8 / vp.scale, flatCache.current)
    if (hit) handlePathDblClick(hit.id)
  }, [handlePathDblClick])

  // Called by SelectionLayer resize handles
  const handleResizeHandleDown = useCallback((handle: HandleType, e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0) return

    const { paths: allPaths, selectedIds: ids } = usePathsStore.getState()
    const selected = allPaths.filter((p) => ids.includes(p.id))
    const bbox = getMultiBBox(selected.map((p) => p.d))
    if (!bbox) return

    const { minX, minY, maxX, maxY, cx, cy } = bbox
    const midX = cx, midY = cy

    // Anchor = opposite corner/edge in CNC space
    const anchorMap: Record<HandleType, { x: number; y: number }> = {
      tl: { x: maxX, y: minY }, tr: { x: minX, y: minY },
      bl: { x: maxX, y: maxY }, br: { x: minX, y: maxY },
      t:  { x: midX, y: minY }, b:  { x: midX, y: maxY },
      l:  { x: maxX, y: midY }, r:  { x: minX, y: midY },
    }
    const handlePosMap: Record<HandleType, { x: number; y: number }> = {
      tl: { x: minX, y: maxY }, tr: { x: maxX, y: maxY },
      bl: { x: minX, y: minY }, br: { x: maxX, y: minY },
      t:  { x: midX, y: maxY }, b:  { x: midX, y: minY },
      l:  { x: minX, y: midY }, r:  { x: maxX, y: midY },
    }

    didDragRef.current = false
    setMode2({
      type: 'resize',
      pathIds: ids,
      handle,
      anchor: anchorMap[handle],
      initHandle: handlePosMap[handle],
      initBbox: bbox,
      shiftHeld: e.evt.shiftKey,
    })
  }, [setMode2])

  // Called by SelectionLayer rotation handle
  const handleRotateHandleDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0) return

    const vp = viewportRef.current
    const { paths: allPaths, selectedIds: ids } = usePathsStore.getState()
    const selected = allPaths.filter((p) => ids.includes(p.id))
    const bbox = getMultiBBox(selected.map((p) => p.d))
    if (!bbox) return

    const pointer = e.target.getStage()?.getPointerPosition()
    if (!pointer) return
    const cncMouse = screenToCNC(pointer.x, pointer.y, vp)
    const initAngle = Math.atan2(cncMouse.y - bbox.cy, cncMouse.x - bbox.cx) * 180 / Math.PI

    didDragRef.current = false
    setMode2({ type: 'rotate', pathIds: ids, center: { x: bbox.cx, y: bbox.cy }, initAngle })
  }, [setMode2])

  const panStartRef = useRef({ mouseX: 0, mouseY: 0, vpX: 0, vpY: 0 })

  const handleStageMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (connectSourceRef.current !== null) {
      if (crossPathWeldTargetRef.current !== null) {
        // Snapped to a cross-path node — let mouseup complete the connection
        didDragRef.current = false
        return
      }
      connectSourceRef.current = null
      setConnectSource(null)
      setConnectPreviewTo(null)
      setConnectSnapTargetIdx(null)
      crossPathWeldTargetRef.current = null
      setCrossPathWeldTarget(null)
      setCrossPathCandidates([])
      crossPathEntriesRef.current = []
    }
    if (e.evt.button === 1 || spaceHeldRef.current) {
      e.evt.preventDefault()
      const vp = viewportRef.current
      panStartRef.current = { mouseX: e.evt.clientX, mouseY: e.evt.clientY, vpX: vp.x, vpY: vp.y }
      setMode2({ type: 'pan' })
      return
    }
    if (e.evt.button !== 0) return

    const { activeTool, nodeEditPathId: neid } = useUIStore.getState()

    // Pen tool — start placing a node
    if (activeTool === 'pen') {
      const stagePointer = stageRef.current?.getPointerPosition()
      if (stagePointer) startPenDraw(stagePointer)
      return
    }

    // Drill tool: capture click for placement in mouseup, don't deselect or start dragbox
    if (activeTool === 'drill') {
      didDragRef.current = false
      setMode2({ type: 'idle' })
      return
    }

    // Shape draw tool active
    if (activeTool !== 'select') {
      const stagePointer = stageRef.current?.getPointerPosition()
      if (stagePointer) startDrawShape(stagePointer)
      return
    }

    const stagePointer = stageRef.current?.getPointerPosition()
    if (!stagePointer) return
    const vp = viewportRef.current
    const cnc = screenToCNC(stagePointer.x, stagePointer.y, vp)

    // Find the closest visible path within 8 screen pixels
    const { paths } = usePathsStore.getState()
    const candidates = paths.filter((p) => p.visible && p.id !== neid)
    const hit = closestVisiblePath(cnc.x, cnc.y, candidates, 8 / vp.scale, flatCache.current)

    if (hit) {
      if (neid && neid !== hit.id) exitNodeEdit()
      const { selectedIds: currentIds } = usePathsStore.getState()
      if (e.evt.shiftKey) {
        usePathsStore.getState().selectPath(hit.id, true)
      } else if (!currentIds.includes(hit.id)) {
        usePathsStore.getState().selectPath(hit.id, false)
      }
      didDragRef.current = false
      setMode2({ type: 'move', pathIds: usePathsStore.getState().selectedIds, startCNC: cnc })
    } else {
      if (neid) { exitNodeEdit(); return }
      selectPath(null)
      didDragRef.current = false
      setMode2({ type: 'dragbox', startScreen: { x: stagePointer.x, y: stagePointer.y } })
      setDragBox({ sx: stagePointer.x, sy: stagePointer.y, ex: stagePointer.x, ey: stagePointer.y })
    }
  }, [selectPath, setMode2, startDrawShape, startPenDraw, exitNodeEdit])

  const handleMouseMove = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = stageRef.current
    const vp = viewportRef.current

    // Stage pointer position is in Konva stage coords (same as container coords)
    const pointer = stage?.getPointerPosition()

    if (pointer) {
      setCursorMM({ x: (pointer.x - vp.x) / vp.scale, y: (vp.y - pointer.y) / vp.scale })
    }

    const m = modeRef.current

    if (m.type === 'pan') {
      // Pan uses clientX/Y deltas — both are in screen pixels so delta is correct
      const { mouseX, mouseY, vpX, vpY } = panStartRef.current
      setViewport((v) => ({ ...v, x: vpX + (e.evt.clientX - mouseX), y: vpY + (e.evt.clientY - mouseY) }))
      return
    }

    if (!pointer) return
    const cncMouse = screenToCNC(pointer.x, pointer.y, vp)

    if (m.type === 'move') {
      const dx = cncMouse.x - m.startCNC.x
      const dy = cncMouse.y - m.startCNC.y
      // Threshold check in stage pixels
      const startScreenX = vp.x + m.startCNC.x * vp.scale
      const startScreenY = vp.y - m.startCNC.y * vp.scale
      if (Math.hypot(pointer.x - startScreenX, pointer.y - startScreenY) > MOVE_THRESHOLD_PX) {
        didDragRef.current = true
      }
      if (didDragRef.current) {
        let finalDx = dx, finalDy = dy
        if (shiftHeldRef.current) {
          if (Math.abs(dx) > Math.abs(dy)) finalDy = 0
          else finalDx = 0
        }
        setLiveTransform({ kind: 'translate', pathIds: new Set(m.pathIds), dx: finalDx, dy: finalDy })
      }
      return
    }

    if (m.type === 'resize') {
      didDragRef.current = true
      const { anchor, initHandle, pathIds, handle, shiftHeld } = m
      const snappedMouse = snapCNC(cncMouse)
      const dhx = initHandle.x - anchor.x
      const dhy = initHandle.y - anchor.y
      const newHx = snappedMouse.x - anchor.x
      const newHy = snappedMouse.y - anchor.y

      // Alt + corner handle = skew (shear) instead of scale
      const isCorner = handle === 'tl' || handle === 'tr' || handle === 'bl' || handle === 'br'
      if ((altDownRef.current || e.evt.altKey) && isCorner) {
        const dx = newHx - dhx
        const dy = newHy - dhy
        const kx = Math.abs(dx) >= Math.abs(dy) && dhy !== 0 ? dx / dhy : 0
        const ky = Math.abs(dy) >  Math.abs(dx) && dhx !== 0 ? dy / dhx : 0
        setLiveTransform({ kind: 'skew', pathIds: new Set(pathIds), kx, ky, ax: anchor.x, ay: anchor.y })
        return
      }

      let sx = dhx !== 0 ? newHx / dhx : 1
      let sy = dhy !== 0 ? newHy / dhy : 1

      // Edge handles constrain one axis
      if (handle === 't' || handle === 'b') sx = 1
      if (handle === 'l' || handle === 'r') sy = 1

      // Uniform scale for corners with Shift
      if (shiftHeld && !['t','b','l','r'].includes(handle)) {
        const s = Math.sign(sx) * Math.hypot(newHx, newHy) / Math.hypot(dhx, dhy)
        sx = s; sy = Math.sign(sy) * Math.abs(s)
      }

      // Prevent degenerate scales
      if (Math.abs(sx) < 0.001) sx = Math.sign(sx) * 0.001
      if (Math.abs(sy) < 0.001) sy = Math.sign(sy) * 0.001

      setLiveTransform({ kind: 'scale', pathIds: new Set(pathIds), sx, sy, ax: anchor.x, ay: anchor.y })
      return
    }

    if (m.type === 'rotate') {
      didDragRef.current = true
      const currentAngle = Math.atan2(cncMouse.y - m.center.y, cncMouse.x - m.center.x) * 180 / Math.PI
      let delta = currentAngle - m.initAngle
      if (useUIStore.getState().snapEnabled) delta = Math.round(delta / 5) * 5
      setLiveTransform({ kind: 'rotate', pathIds: new Set(m.pathIds), angle: delta, cx: m.center.x, cy: m.center.y })
      setLiveRotationAngle(delta)
      return
    }

    if (m.type === 'dragbox') {
      setDragBox((db) => db ? { ...db, ex: pointer.x, ey: pointer.y } : null)
    }

    if (m.type === 'drawshape') {
      const startScreenX = vp.x + m.startCNC.x * vp.scale
      const startScreenY = vp.y - m.startCNC.y * vp.scale
      if (Math.hypot(pointer.x - startScreenX, pointer.y - startScreenY) > MOVE_THRESHOLD_PX) {
        didDragRef.current = true
      }
      // Update currentCNC in the mode ref (no state re-render needed — liveShapeD handles rendering)
      modeRef.current = { ...m, currentCNC: cncMouse }

      if (didDragRef.current) {
        const { activeTool, shapeToolConfig } = useUIStore.getState()
        if (activeTool !== 'select') {
          const params = shapeParamsFromDrag(activeTool as ShapeType, m.startCNC, cncMouse, shapeToolConfig)
          setLiveShapeD(generateShapeD(params))
        }
      }
    }

    // Update pen close-hover indicator (highlight first node when hovering near it)
    if (m.type !== 'pendraw') {
      const { activeTool: at, penNodes: nodes } = useUIStore.getState()
      if (at === 'pen' && nodes.length >= 2) {
        const first = nodes[0]
        const fsx = vp.x + first.x * vp.scale
        const fsy = vp.y - first.y * vp.scale
        const close = Math.hypot(pointer.x - fsx, pointer.y - fsy) < 10
        if (close !== penClosingRef.current) {
          penClosingRef.current = close
          setPenClosing(close)
        }
      } else if (penClosingRef.current) {
        penClosingRef.current = false
        setPenClosing(false)
      }
    }

    // Connect mode preview: show dashed line from source to nearest snappable node
    if (m.type === 'idle' && connectSourceRef.current !== null) {
      const srcIdx = connectSourceRef.current
      const nodes = editNodesRef.current
      if (nodes[srcIdx]) {
        const snapMM = 16 / vp.scale
        let bestDist = snapMM
        let snapSameIdx: number | null = null
        let snapCrossEntry: CrossPathEntry | null = null
        let snapPos = cncMouse

        for (let j = 0; j < nodes.length; j++) {
          if (j === srcIdx) continue
          const dist = Math.hypot(cncMouse.x - nodes[j].x, cncMouse.y - nodes[j].y)
          if (dist < bestDist) {
            bestDist = dist
            snapSameIdx = j
            snapPos = { x: nodes[j].x, y: nodes[j].y }
          }
        }

        for (const entry of crossPathEntriesRef.current) {
          const dist = Math.hypot(cncMouse.x - entry.x, cncMouse.y - entry.y)
          if (dist < bestDist) {
            bestDist = dist
            snapCrossEntry = entry
            snapSameIdx = null
            snapPos = { x: entry.x, y: entry.y }
          }
        }

        setConnectPreviewTo(snapPos)
        setConnectSnapTargetIdx(snapSameIdx)
        crossPathWeldTargetRef.current = snapCrossEntry
        setCrossPathWeldTarget(snapCrossEntry)
      }
    }

    if (m.type === 'pendraw') {
      const asx = vp.x + m.anchorCNC.x * vp.scale
      const asy = vp.y - m.anchorCNC.y * vp.scale
      if (Math.hypot(pointer.x - asx, pointer.y - asy) > MOVE_THRESHOLD_PX) {
        didDragRef.current = true
      }
      if (didDragRef.current && !m.closing) {
        // Only track drag handles in bezier mode; other modes auto-compute curves
        if (useUIStore.getState().penCurveType === 'bezier') {
          setLivePen({ anchor: m.anchorCNC, handle: cncMouse })
        }
      }
    }

    if (m.type === 'nodedit-drag' && editDragInitRef.current) {
      didDragRef.current = true
      const init = editDragInitRef.current
      const dx = cncMouse.x - init.startCNC.x
      const dy = cncMouse.y - init.startCNC.y
      const WELD_THRESHOLD_MM = 16 / viewportRef.current.scale
      let newWeldTarget: number | null = null
      let newCrossTarget: CrossPathEntry | null = null
      const updatedNodes = init.initialNodes.map((n, i) => {
        if (i !== m.nodeIdx) return n
        if (m.kind === 'anchor') {
          const snapped = snapCNC({ x: n.x + dx, y: n.y + dy })
          const sdx = snapped.x - n.x
          const sdy = snapped.y - n.y
          // Check for same-path weld snap first
          for (let j = 0; j < init.initialNodes.length; j++) {
            if (j === m.nodeIdx) continue
            const other = init.initialNodes[j]
            const distSq = (snapped.x - other.x) ** 2 + (snapped.y - other.y) ** 2
            if (distSq < WELD_THRESHOLD_MM ** 2) {
              newWeldTarget = j
              const wdx = other.x - n.x
              const wdy = other.y - n.y
              return { ...n, x: other.x, y: other.y,
                handleIn: n.handleIn ? { x: n.handleIn.x + wdx, y: n.handleIn.y + wdy } : undefined,
                handleOut: n.handleOut ? { x: n.handleOut.x + wdx, y: n.handleOut.y + wdy } : undefined,
              }
            }
          }
          // Check for cross-path weld snap (only available for endpoints of open paths)
          for (const entry of crossPathEntriesRef.current) {
            const distSq = (snapped.x - entry.x) ** 2 + (snapped.y - entry.y) ** 2
            if (distSq < WELD_THRESHOLD_MM ** 2) {
              newCrossTarget = entry
              const wdx = entry.x - n.x
              const wdy = entry.y - n.y
              return { ...n, x: entry.x, y: entry.y,
                handleIn: n.handleIn ? { x: n.handleIn.x + wdx, y: n.handleIn.y + wdy } : undefined,
                handleOut: n.handleOut ? { x: n.handleOut.x + wdx, y: n.handleOut.y + wdy } : undefined,
              }
            }
          }
          return {
            ...n,
            x: snapped.x,
            y: snapped.y,
            handleIn: n.handleIn ? { x: n.handleIn.x + sdx, y: n.handleIn.y + sdy } : undefined,
            handleOut: n.handleOut ? { x: n.handleOut.x + sdx, y: n.handleOut.y + sdy } : undefined,
          }
        }
        if (m.kind === 'handle-in') {
          const handleIn = { x: (n.handleIn?.x ?? n.x) + dx, y: (n.handleIn?.y ?? n.y) + dy }
          const handleOut = (altDownRef.current || e.evt.altKey) && n.handleOut
            ? { x: 2 * n.x - handleIn.x, y: 2 * n.y - handleIn.y }
            : n.handleOut
          return { ...n, handleIn, handleOut }
        }
        const handleOut = { x: (n.handleOut?.x ?? n.x) + dx, y: (n.handleOut?.y ?? n.y) + dy }
        const handleIn = (altDownRef.current || e.evt.altKey) && n.handleIn
          ? { x: 2 * n.x - handleOut.x, y: 2 * n.y - handleOut.y }
          : n.handleIn
        return { ...n, handleIn, handleOut }
      })
      weldTargetIdxRef.current = newWeldTarget
      setWeldTargetIdx(newWeldTarget)
      crossPathWeldTargetRef.current = newCrossTarget
      setCrossPathWeldTarget(newCrossTarget)
      setEditNodes(updatedNodes)
    }
  }, [setCursorMM, setViewport, setLiveRotationAngle, snapCNC])

  const handleMouseUp = useCallback((_e: Konva.KonvaEventObject<MouseEvent>) => {
    const m = modeRef.current
    const vp = viewportRef.current

    // Complete cross-path connection from connect mode (user clicked while snapped to other-path node)
    if (connectSourceRef.current !== null && crossPathWeldTargetRef.current !== null && m.type === 'idle') {
      const cs = connectSourceRef.current
      const crossTarget = crossPathWeldTargetRef.current
      const nodes = editNodesRef.current
      pushLocalUndo(nodes)
      const joined = joinPathsConnect(
        nodes, cs,
        crossTarget.nodes, crossTarget.nodeIdx, crossTarget.closed,
      )
      if (joined) {
        const newD = nodesToD(joined, false)
        const { nodeEditPathId: pid } = useUIStore.getState()
        if (pid && newD) {
          usePathsStore.getState().batchUpdatePaths([{ id: pid, d: newD }])
          usePathsStore.getState().deletePath(crossTarget.pathId)
          regenerateAffected(pid)
          setEditNodes(joined)
          editNodesRef.current = joined
          editClosedRef.current = false
          setEditClosed(false)
        }
      }
      connectSourceRef.current = null
      setConnectSource(null)
      setConnectPreviewTo(null)
      setConnectSnapTargetIdx(null)
      crossPathWeldTargetRef.current = null
      setCrossPathWeldTarget(null)
      setCrossPathCandidates([])
      crossPathEntriesRef.current = []
      return
    }

    if (m.type === 'pan') {
      setMode2({ type: 'idle' })
      return
    }

    if (m.type === 'move' && didDragRef.current) {
      const lt = liveTransform
      if (lt && lt.kind === 'translate') {
        const { dx, dy } = lt
        const { paths: allPaths, batchUpdatePaths } = usePathsStore.getState()
        const updates = m.pathIds.flatMap((id) => {
          const path = allPaths.find((p) => p.id === id)
          if (!path) return []
          const newD = translateD(path.d, dx, dy)
          if (path.shapeParams) {
            return [{ id, d: newD, shapeParams: translateShapeParams(path.shapeParams, dx, dy) }]
          }
          return [{ id, d: newD }]
        })
        if (updates.length) { batchUpdatePaths(updates); for (const id of m.pathIds) regenerateAffected(id) }
      }
      setLiveTransform(null)
      setMode2({ type: 'idle' })
      return
    }

    if (m.type === 'resize' && didDragRef.current) {
      const lt = liveTransform
      if (lt && lt.kind === 'scale') {
        const { sx, sy, ax, ay } = lt
        const { paths: allPaths, batchUpdatePaths } = usePathsStore.getState()
        const updates = m.pathIds.flatMap((id) => {
          const path = allPaths.find((p) => p.id === id)
          if (!path) return []
          const newShapeParams = path.shapeParams
            ? scaleShapeParams(path.shapeParams, ax, ay, sx, sy)
            : undefined
          // When params are valid, regenerate d from them to preserve exact geometry (arcs stay circular)
          const newD = (newShapeParams != null && newShapeParams !== undefined)
            ? generateShapeD(newShapeParams)
            : scaleAroundD(path.d, ax, ay, sx, sy)
          const typeChanged = newShapeParams && path.shapeParams && newShapeParams.type !== path.shapeParams.type
          const name = typeChanged ? shapeDisplayName(newShapeParams!.type) : undefined
          return [{ id, d: newD, shapeParams: newShapeParams === null ? null : newShapeParams, name }]
        })
        if (updates.length) { batchUpdatePaths(updates); for (const id of m.pathIds) regenerateAffected(id) }
      } else if (lt && lt.kind === 'skew') {
        const { kx, ky, ax, ay } = lt
        const { paths: allPaths, batchUpdatePaths } = usePathsStore.getState()
        const updates = m.pathIds.flatMap((id) => {
          const path = allPaths.find((p) => p.id === id)
          if (!path) return []
          return [{ id, d: skewAroundD(path.d, kx, ky, ax, ay), shapeParams: null as null }]
        })
        if (updates.length) { batchUpdatePaths(updates); for (const id of m.pathIds) regenerateAffected(id) }
      }
      setLiveTransform(null)
      setMode2({ type: 'idle' })
      return
    }

    if (m.type === 'rotate' && didDragRef.current) {
      const lt = liveTransform
      if (lt && lt.kind === 'rotate') {
        const { angle, cx, cy } = lt
        const { paths: allPaths, batchUpdatePaths } = usePathsStore.getState()
        const updates = m.pathIds.flatMap((id) => {
          const path = allPaths.find((p) => p.id === id)
          if (!path) return []
          return [{ id, d: rotateAroundD(path.d, cx, cy, angle), shapeParams: null as null }]
        })
        if (updates.length) { batchUpdatePaths(updates); for (const id of m.pathIds) regenerateAffected(id) }
      }
      setLiveTransform(null)
      setLiveRotationAngle(null)
      setMode2({ type: 'idle' })
      return
    }

    if (m.type === 'move' && !didDragRef.current) {
      // Pure click without drag — selection already updated on mousedown
      setMode2({ type: 'idle' })
      return
    }

    if (m.type === 'dragbox') {
      if (dragBox) {
        const { sx, sy, ex, ey } = dragBox
        const x1 = Math.min(sx, ex), x2 = Math.max(sx, ex)
        const y1 = Math.min(sy, ey), y2 = Math.max(sy, ey)

        if (Math.hypot(ex - sx, ey - sy) > MOVE_THRESHOLD_PX) {
          // Convert drag box to CNC bounds
          const cncMin = screenToCNC(x1, y2, vp)  // y2 is lower on screen = lower CNC y
          const cncMax = screenToCNC(x2, y1, vp)  // y1 is higher on screen = higher CNC y

          const { paths: allPaths } = usePathsStore.getState()
          const intersecting = allPaths.filter((p) => {
            if (!p.visible) return false
            const bb = getBBox(p.d)
            if (!bb) return false
            return bb.minX <= cncMax.x && bb.maxX >= cncMin.x && bb.minY <= cncMax.y && bb.maxY >= cncMin.y
          })
          setSelectedIds(intersecting.map((p) => p.id))
        }
      }
      setDragBox(null)
      setMode2({ type: 'idle' })
      return
    }

    if (m.type === 'drawshape') {
      setLiveShapeD(null)
      setMode2({ type: 'idle' })

      const { activeTool, shapeToolConfig } = useUIStore.getState()
      if (activeTool !== 'select') {
        const shapeType = activeTool as ShapeType
        const params = didDragRef.current
          ? shapeParamsFromDrag(shapeType, m.startCNC, m.currentCNC, shapeToolConfig)
          : shapeParamsFromConfig(shapeType, m.startCNC.x, m.startCNC.y, shapeToolConfig)

        const id = `shape-${Date.now()}`
        const { addPaths: add, selectPath: sel } = usePathsStore.getState()
        const d = generateShapeD(params)
        add([{ id, name: shapeDisplayName(shapeType), d, visible: true, color: nextPathColor(), shapeParams: params }])
        sel(id)

        // If text font wasn't loaded yet, update d once it loads
        if (params.type === 'text' && !d) {
          import('../shapes/textGenerator').then(({ loadFont }) => {
            loadFont(params.fontFamily).then(() => {
              const newD = generateShapeD(params)
              if (newD) usePathsStore.getState().batchUpdatePaths([{ id, d: newD }])
            })
          })
        }
        useUIStore.getState().setActiveTool('select')
      }
      return
    }

    if (m.type === 'nodedit-drag') {
      setMode2({ type: 'idle' })
      const initSnap = editDragInitRef.current?.initialNodes
      editDragInitRef.current = null
      setDragNodeIdx(null)
      setCrossPathCandidates([])
      crossPathEntriesRef.current = []
      const crossTgt = crossPathWeldTargetRef.current
      crossPathWeldTargetRef.current = null
      setCrossPathWeldTarget(null)
      const tgt = weldTargetIdxRef.current
      weldTargetIdxRef.current = null
      setWeldTargetIdx(null)

      if (crossTgt !== null && didDragRef.current) {
        // Cross-path join: merge the current path with another path at their endpoints
        if (initSnap) pushLocalUndo(initSnap)
        const joined = joinPaths(
          editNodesRef.current, m.nodeIdx, editClosedRef.current,
          crossTgt.nodes, crossTgt.nodeIdx, crossTgt.closed,
        )
        if (joined) {
          const newD = nodesToD(joined, false)
          const { nodeEditPathId: pid } = useUIStore.getState()
          if (pid && newD) {
            usePathsStore.getState().batchUpdatePaths([{ id: pid, d: newD }])
            usePathsStore.getState().deletePath(crossTgt.pathId)
            regenerateAffected(pid)
            setEditNodes(joined)
            editNodesRef.current = joined
            editClosedRef.current = false
            setEditClosed(false)
          }
        }
      } else if (tgt !== null && didDragRef.current) {
        if (initSnap) pushLocalUndo(initSnap)
        const curNodes = editNodesRef.current
        const curClosed = editClosedRef.current
        const n = curNodes.length
        const srcIsEndpoint = !curClosed && (m.nodeIdx === 0 || m.nodeIdx === n - 1)
        const tgtIsEndpoint = tgt === 0 || tgt === n - 1
        const lollipop = srcIsEndpoint && !tgtIsEndpoint
          ? endpointToMidpointWeld(curNodes, m.nodeIdx, tgt) : null

        if (lollipop) {
          // Endpoint-to-midpoint: create a closed loop and keep the remainder
          const { loopNodes, remainNodes } = lollipop
          const loopD = nodesToD(loopNodes, true)
          const remainD = nodesToD(remainNodes, false)
          const { nodeEditPathId: pid } = useUIStore.getState()
          if (pid && remainD) {
            const { paths: allPaths } = usePathsStore.getState()
            const srcPath = allPaths.find((p) => p.id === pid)
            usePathsStore.getState().batchUpdatePaths([{ id: pid, d: remainD }])
            if (loopD) {
              usePathsStore.getState().addPaths([{
                id: `weld-loop-${Date.now()}`,
                name: srcPath?.name ?? 'Path',
                d: loopD,
                visible: true,
                color: srcPath?.color ?? nextPathColor(),
              }])
            }
            regenerateAffected(pid)
            setEditNodes(remainNodes)
            editNodesRef.current = remainNodes
            editClosedRef.current = false
            setEditClosed(false)
          }
        } else {
          // Standard same-path weld (endpoint→endpoint close, or mid→any merge)
          const result = weldNodes(curNodes, m.nodeIdx, tgt, curClosed)
          setEditNodes(result.nodes)
          editNodesRef.current = result.nodes
          if (result.closed !== curClosed) {
            editClosedRef.current = result.closed
            setEditClosed(result.closed)
          }
        }
      } else if (initSnap && didDragRef.current) {
        pushLocalUndo(initSnap)
      }

      // No-drag on an anchor: toggle connect mode or complete connection
      if (!didDragRef.current && m.kind === 'anchor') {
        const cs = connectSourceRef.current
        const nodes = editNodesRef.current
        const closed = editClosedRef.current
        const n = nodes.length
        const mIsEndpoint = !closed && (m.nodeIdx === 0 || m.nodeIdx === n - 1)

        const clearConnect = () => {
          connectSourceRef.current = null
          setConnectSource(null)
          setConnectPreviewTo(null)
          setConnectSnapTargetIdx(null)
          crossPathWeldTargetRef.current = null
          setCrossPathWeldTarget(null)
          setCrossPathCandidates([])
          crossPathEntriesRef.current = []
        }

        if (cs !== null && cs !== m.nodeIdx) {
          if (mIsEndpoint) {
            // Connect source endpoint to other endpoint → close path
            pushLocalUndo(nodes)
            editClosedRef.current = true
            setEditClosed(true)
            clearConnect()
          } else {
            // Connect source endpoint to interior node — split into closed loop + open remainder,
            // both nodes preserved (no merging, no deletion)
            const result = connectEndpointToInterior(nodes, cs, m.nodeIdx)
            if (result) {
              pushLocalUndo(nodes)
              const { loopNodes, remainNodes } = result
              const loopD = nodesToD(loopNodes, true)
              const remainD = nodesToD(remainNodes, false)
              const { nodeEditPathId: pid } = useUIStore.getState()
              if (pid && remainD) {
                const { paths: allPaths } = usePathsStore.getState()
                const srcPath = allPaths.find((p) => p.id === pid)
                usePathsStore.getState().batchUpdatePaths([{ id: pid, d: remainD }])
                if (loopD) {
                  usePathsStore.getState().addPaths([{
                    id: `connect-loop-${Date.now()}`,
                    name: srcPath?.name ?? 'Path',
                    d: loopD,
                    visible: true,
                    color: srcPath?.color ?? nextPathColor(),
                  }])
                }
                regenerateAffected(pid)
                setEditNodes(remainNodes)
                editNodesRef.current = remainNodes
                editClosedRef.current = false
                setEditClosed(false)
              }
              clearConnect()
            }
            // else: degenerate (adjacent endpoints only, nothing to split) — stay in connect mode
          }
        } else if (cs === m.nodeIdx) {
          // Cancel: click source again
          clearConnect()
        } else if (cs === null && mIsEndpoint) {
          // Enter connect mode — populate cross-path candidates
          connectSourceRef.current = m.nodeIdx
          setConnectSource(m.nodeIdx)
          const { nodeEditPathId: pid } = useUIStore.getState()
          const { paths: allPaths } = usePathsStore.getState()
          const entries: CrossPathEntry[] = []
          for (const p of allPaths) {
            if (p.id === pid || !p.visible) continue
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
          crossPathEntriesRef.current = entries
          setCrossPathCandidates(entries)
        }
        // else: non-endpoint click with no connect mode active → do nothing
      }

      return
    }

    if (m.type === 'pendraw') {
      setMode2({ type: 'idle' })

      if (m.closing) {
        const { penNodes: nodes, clearPenNodes, penCurveType: ct } = useUIStore.getState()
        if (nodes.length >= 2) {
          const closeNodes = altDownRef.current
            ? [{ ...nodes[0], corner: true }, ...nodes.slice(1)]
            : nodes
          const d = penNodesToPathD(closeNodes, true, ct)
          if (d) {
            const id = `pen-${Date.now()}`
            const { addPaths: add, selectPath: sel } = usePathsStore.getState()
            add([{ id, name: 'Pen Path', d, visible: true, color: nextPathColor() }])
            sel(id)
          }
        }
        clearPenNodes()
        useUIStore.getState().setActiveTool('select')
        setLivePen(null)
        penClosingRef.current = false
        setPenClosing(false)
        return
      }

      const { addPenNode, penCurveType: ct } = useUIStore.getState()
      const newNode: PenNode = { x: m.anchorCNC.x, y: m.anchorCNC.y }
      if (ct === 'bezier' && didDragRef.current && livePen?.handle) {
        const dx = livePen.handle.x - m.anchorCNC.x
        const dy = livePen.handle.y - m.anchorCNC.y
        newNode.outHandle = livePen.handle
        newNode.inHandle = { x: m.anchorCNC.x - dx, y: m.anchorCNC.y - dy }
      } else if (ct !== 'linear' && altDownRef.current) {
        // Alt held: mark incoming segment as linear (corner). Only affects the segment
        // ending at this node — the outgoing segment uses normal curve logic.
        newNode.corner = true
      }
      penPast.current = [...penPast.current, [...useUIStore.getState().penNodes]]
      penFuture.current = []
      addPenNode(newNode)
      useUIStore.getState().setNodeEditHistoryFlags(true, false)
      setLivePen(null)
      return
    }

    // Drill tool: place a point on any non-drag click
    {
      const { activeTool: curTool } = useUIStore.getState()
      if (curTool === 'drill' && !didDragRef.current) {
        const pointer = stageRef.current?.getPointerPosition()
        if (pointer) {
          const cnc = screenToCNC(pointer.x, pointer.y, viewportRef.current)
          const { pendingDrillPoints } = useUIStore.getState()
          drillPast.current = [...drillPast.current, pendingDrillPoints]
          useUIStore.getState().addDrillPoint(snapDrillPoint(cnc))
        }
      }
    }

    setMode2({ type: 'idle' })
  }, [liveTransform, livePen, dragBox, setMode2, setSelectedIds, setLiveRotationAngle, commitEditNodes, pushLocalUndo])

  const getCursor = () => {
    if (nodeEditPathId) return 'default'
    if (activeTool === 'drill') return 'crosshair'
    if (activeTool === 'pen') return 'crosshair'
    if (activeTool !== 'select') return 'crosshair'
    switch (modeRef.current.type) {
      case 'pan': return 'grabbing'
      case 'move': return 'move'
      case 'resize': return 'crosshair'
      case 'rotate': return 'crosshair'
      case 'dragbox': return 'crosshair'
      default: return spaceHeldRef.current ? 'grab' : 'default'
    }
  }

  // dragBox coords are in Konva stage space = container-relative pixels, no offset needed
  const dragBoxStyle = dragBox ? {
    left: Math.min(dragBox.sx, dragBox.ex),
    top: Math.min(dragBox.sy, dragBox.ey),
    width: Math.abs(dragBox.ex - dragBox.sx),
    height: Math.abs(dragBox.ey - dragBox.sy),
  } : null

  const selectedPaths = paths.filter((p) => selectedIds.includes(p.id))

  return (
    <div
      ref={containerRef}
      data-testid="canvas-stage"
      className="w-full h-full relative overflow-hidden select-none"
      style={{ cursor: getCursor() }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleCanvasDrop}
    >
      {size.width > 0 && size.height > 0 && <Stage
        ref={stageRef}
        width={size.width}
        height={size.height}
        onWheel={handleWheel}
        onMouseDown={handleStageMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => setCursorMM(null)}
        onDblClick={handleStageDblClick}
      >
        {/* Layer 1: All CNC-space content (Y-flipped). Groups render in z-order within this single canvas. */}
        <Layer x={viewport.x} y={viewport.y} scaleX={viewport.scale} scaleY={-viewport.scale}>
          <WorkpieceLayer viewport={viewport} />
          <GridLayer viewport={viewport} stageWidth={size.width} stageHeight={size.height} />
          <DesignLayer
            viewport={viewport}
            liveTransform={liveTransform}
            excludePathId={nodeEditPathId}
          />
          {nodeEditPathId && (
            <NodeEditLayer
              viewport={viewport}
              nodes={editNodes}
              closed={editClosed}
              hoveredNodeIdx={hoveredEditNode}
              onNodeMouseDown={handleNodeMouseDown}
              onSegmentMouseDown={handleSegmentMouseDown}
              onHoveredNodeChange={handleHoveredNodeChange}
              onHoverSegChange={(idx) => { hoverSegIdxRef.current = idx; setHoverSegIdx(idx) }}
              weldTargetIdx={weldTargetIdx}
              crossPathCandidates={crossPathCandidates}
              crossPathWeldTarget={crossPathWeldTarget}
              connectSourceIdx={connectSource}
              connectPreviewTo={connectPreviewTo}
              connectSnapTargetIdx={connectSnapTargetIdx}
            />
          )}
          <ToolpathLayer viewport={viewport} />
          <TabLayer viewport={viewport} />
          <SimulationLayer viewport={viewport} />
          <ShapePreviewLayer viewport={viewport} d={liveShapeD} />
          {activeTool === 'pen' && (
            <PenLayer
              viewport={viewport}
              penNodes={penClosing && altDown && penNodes.length >= 1
                ? [{ ...penNodes[0], corner: true }, ...penNodes.slice(1)]
                : penNodes}
              livePen={livePen}
              penClosing={penClosing}
              curveType={effectiveCurveType}
            />
          )}
          {activeTool === 'drill' && pendingDrillPoints.length > 0 && (
            <Group listening={false}>
              {pendingDrillPoints.map((pt, i) => (
                <Circle
                  key={i}
                  x={pt.x}
                  y={pt.y}
                  radius={3 / viewport.scale}
                  fill="#f97316"
                  stroke="#ffffff"
                  strokeWidth={1 / viewport.scale}
                  listening={false}
                />
              ))}
            </Group>
          )}
        </Layer>

        {/* Layer 2: Screen-space overlay — origin indicator, selection outline, rulers. */}
        <Layer listening={false}>
          <OriginLayer viewport={viewport} />
          {!nodeEditPathId && selectedPaths.length > 0 && (
            <SelectionLayer
              viewport={viewport}
              selectedPaths={selectedPaths}
              liveTransform={liveTransform}
            />
          )}
          {/* <RulerLayer viewport={viewport} stageWidth={size.width} stageHeight={size.height} /> */}
        </Layer>

        {/* Layer 3: Interactive handles — selection resize/rotate circles. */}
        <Layer>
          {!nodeEditPathId && selectedPaths.length > 0 && (
            <SelectionHandleLayer
              viewport={viewport}
              selectedPaths={selectedPaths}
              liveTransform={liveTransform}
              onResizeHandleDown={handleResizeHandleDown}
              onRotateHandleDown={handleRotateHandleDown}
            />
          )}
        </Layer>
      </Stage>}


      {/* Drag-box selection overlay */}
      {dragBox && dragBoxStyle && (
        <div
          className="absolute border border-blue-400 bg-blue-400/10 pointer-events-none"
          style={dragBoxStyle}
        />
      )}

      <PenLengthOverlay viewport={viewport} draggingHandle={livePen !== null} />
      <NodeEditDimensionOverlay viewport={viewport} nodes={editNodes} closed={editClosed} dragNodeIdx={dragNodeIdx} hoverSegIdx={hoverSegIdx} />

      {/* Node edit indicator */}
      {nodeEditPathId && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-emerald-700/90 text-white text-body px-3 py-1 rounded-full pointer-events-none">
          {connectSource !== null
            ? 'Click any node to connect · Esc to cancel'
            : hoveredEditNode !== null
              ? 'Delete key to remove point'
              : hoverSegIdx !== null
                ? 'Click to insert point · Delete key to delete segment'
              : 'Drag points or handles · Alt-click node to toggle curve · Click segment to insert · Esc to finish'}
        </div>
      )}

      {/* Tool active indicator */}
      {activeTool === 'drill' && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-blue-600/90 text-white text-body px-3 py-1 rounded-full pointer-events-none">
          Drill Point Mode — click to place points, Esc to exit
        </div>
      )}
      {activeTool === 'pen' && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-violet-600/90 text-white text-body px-3 py-1 rounded-full pointer-events-none">
          {penClosing
            ? 'Click to close path'
            : penNodes.length === 0
              ? penCurveType === 'bezier'
                ? 'Pen Tool — click for corner, drag to curve'
                : 'Pen Tool — click to place nodes'
              : penCurveType === 'bezier'
                ? 'Click to add point, drag to curve, Alt for straight segment, click first point to close, Esc to finish'
                : 'Click to add point, Alt for straight segment, click first point to close, Esc to finish'}
        </div>
      )}
      {activeTool !== 'select' && activeTool !== 'drill' && activeTool !== 'pen' && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-blue-600/90 text-white text-body px-3 py-1 rounded-full pointer-events-none">
          Drawing {activeTool === 'roundrect' ? 'Rounded Rect' : activeTool.charAt(0).toUpperCase() + activeTool.slice(1)} — click to place, drag to size, Esc to cancel
        </div>
      )}

      <SimulationPlayer />

      <button
        onClick={fitToWorkpiece}
        title="Zoom to fit workpiece"
        className="absolute bottom-3 right-3 bg-panel hover:bg-raised border border-ridge rounded p-1.5 text-norm transition-colors"
      >
        <Maximize2 size={ICON.md} />
      </button>
    </div>
  )
}
