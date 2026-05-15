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
import { WorkpieceLayer } from './layers/WorkpieceLayer'
import { OriginLayer } from './layers/OriginLayer'
import {  RULER_H, RULER_W } from './layers/RulerLayer'
import { DesignLayer } from './layers/DesignLayer'
import { ToolpathLayer } from './layers/ToolpathLayer'
import { SelectionLayer, SelectionHandleLayer } from './layers/SelectionLayer'
import { ShapePreviewLayer } from './layers/ShapePreviewLayer'
import { PenLayer, penNodesToPathD } from './layers/PenLayer'
import { SimulationLayer } from './layers/SimulationLayer'
import SimulationPlayer from '../sim/SimulationPlayer'
import { useSimStore } from '../store/simStore'
import type { HandleType, LiveTransform } from './types'
import { getBBox, getMultiBBox, translateD, scaleAroundD, rotateAroundD } from './selectionUtils'
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
import { parseDToNodes, nodesToD, removeNode, insertNodeOnSegment, splitCompoundPath } from './nodeUtils'
import type { PathNode } from './nodeUtils'

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
  const [toolpathTooltip, setToolpathTooltip] = useState<{ name: string; depth: string; x: number; y: number } | null>(null)
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
  const nodeEditPathId = useUIStore((s) => s.nodeEditPathId)

  // Node edit state — live editable copy of the path's nodes
  const [editNodes, setEditNodes] = useState<PathNode[]>([])
  const [editClosed, setEditClosed] = useState(false)
  const editNodesRef = useRef<PathNode[]>([])
  const editClosedRef = useRef(false)
  useEffect(() => { editNodesRef.current = editNodes }, [editNodes])
  useEffect(() => { editClosedRef.current = editClosed }, [editClosed])

  const editDragInitRef = useRef<{ initialNodes: PathNode[]; startCNC: { x: number; y: number } } | null>(null)
  const hoveredEditNodeRef = useRef<number | null>(null)
  const [hoveredEditNode, setHoveredEditNode] = useState<number | null>(null)

  const setMode2 = useCallback((m: CanvasMode) => {
    modeRef.current = m
  }, [])

  const handleToolpathHover = useCallback(
    (info: { name: string; depth: string } | null, stageX: number, stageY: number) => {
      setToolpathTooltip(info ? { ...info, x: stageX, y: stageY } : null)
    },
    []
  )

  const handleCanvasDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (!file) return
    if (!file.name.endsWith('.svg') && file.type !== 'image/svg+xml') return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const result = importSvg(ev.target?.result as string, { workpieceMM: { w: widthMM, h: heightMM } })
        if (result.paths.length > 0) {
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

  const commitEditNodes = useCallback((nodes: PathNode[]) => {
    const { nodeEditPathId: pid } = useUIStore.getState()
    if (!pid || nodes.length < 2) return
    const d = nodesToD(nodes, editClosedRef.current)
    usePathsStore.getState().batchUpdatePaths([{ id: pid, d, shapeParams: null }])
    regenerateAffected(pid)
  }, [])

  const exitNodeEdit = useCallback(() => {
    const { nodeEditPathId: pid, setNodeEditPathId } = useUIStore.getState()
    if (!pid) return
    commitEditNodes(editNodesRef.current)
    setNodeEditPathId(null)
    setEditNodes([])
    setEditClosed(false)
  }, [commitEditNodes])

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
      if (e.code === 'Space' && !useSimStore.getState().gcode) { e.preventDefault(); spaceHeldRef.current = true }
      if (e.shiftKey) shiftHeldRef.current = true
      if ((e.key === 'Delete' || e.key === 'Backspace') && hoveredEditNodeRef.current !== null) {
        const { nodeEditPathId: pid } = useUIStore.getState()
        if (pid) {
          e.stopImmediatePropagation()
          e.preventDefault()
          const idx = hoveredEditNodeRef.current
          setEditNodes((prev) => {
            const next = removeNode(prev, idx)
            const d = nodesToD(next, editClosedRef.current)
            usePathsStore.getState().batchUpdatePaths([{ id: pid, d, shapeParams: null }])
            regenerateAffected(pid)
            return next
          })
          hoveredEditNodeRef.current = null
          setHoveredEditNode(null)
        }
      }

      if (e.code === 'Escape') {
        const { nodeEditPathId: neid } = useUIStore.getState()
        if (neid) {
          exitNodeEdit()
          return
        }
        const { activeTool, setActiveTool, clearDrillPoints, penNodes: nodes, clearPenNodes } = useUIStore.getState()
        if (activeTool === 'pen') {
          if (nodes.length >= 2) {
            const d = penNodesToPathD(nodes, false)
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
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp) }
  }, [setMode2, exitNodeEdit])

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
    setViewport((vp) => {
      const newScale = Math.min(Math.max(vp.scale * factor, 0.01), 500)
      const ratio = newScale / vp.scale
      return {
        scale: newScale,
        x: pointer.x - (pointer.x - vp.x) * ratio,
        y: pointer.y + (vp.y - pointer.y) * ratio,
      }
    })
  }, [setViewport])

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
    const cnc = screenToCNC(pointer.x, pointer.y, vp)
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
  }, [setMode2])

  // Parse path nodes when entering node edit mode
  useEffect(() => {
    if (!nodeEditPathId) { setEditNodes([]); setEditClosed(false); return }
    const path = usePathsStore.getState().paths.find((p) => p.id === nodeEditPathId)
    if (!path) { setEditNodes([]); return }
    const { nodes, closed } = parseDToNodes(path.d)
    setEditNodes(nodes)
    setEditClosed(closed)
  }, [nodeEditPathId])

  const handleNodeMouseDown = useCallback((nodeIdx: number, kind: 'anchor' | 'handle-in' | 'handle-out', e: Konva.KonvaEventObject<MouseEvent>) => {
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
  }, [setMode2])

  const handleSegmentMouseDown = useCallback((segIdx: number, cncX: number, cncY: number) => {
    const { nodeEditPathId: pid } = useUIStore.getState()
    if (!pid) return
    const next = insertNodeOnSegment(editNodesRef.current, segIdx, cncX, cncY, editClosedRef.current)
    setEditNodes(next)
    commitEditNodes(next)
  }, [commitEditNodes])

  const handlePathDblClick = useCallback((id: string) => {
    const path = usePathsStore.getState().paths.find((p) => p.id === id)
    if (!path) return
    const subDs = splitCompoundPath(path.d)
    if (subDs.length > 1) {
      usePathsStore.getState().splitPath(id, subDs)
      return
    }
    const { setNodeEditPathId } = useUIStore.getState()
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
      const dhx = initHandle.x - anchor.x
      const dhy = initHandle.y - anchor.y
      const newHx = cncMouse.x - anchor.x
      const newHy = cncMouse.y - anchor.y

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
      const delta = currentAngle - m.initAngle
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

    if (m.type === 'pendraw') {
      const asx = vp.x + m.anchorCNC.x * vp.scale
      const asy = vp.y - m.anchorCNC.y * vp.scale
      if (Math.hypot(pointer.x - asx, pointer.y - asy) > MOVE_THRESHOLD_PX) {
        didDragRef.current = true
      }
      if (didDragRef.current && !m.closing) {
        setLivePen({ anchor: m.anchorCNC, handle: cncMouse })
      }
    }

    if (m.type === 'nodedit-drag' && editDragInitRef.current) {
      didDragRef.current = true
      const init = editDragInitRef.current
      const dx = cncMouse.x - init.startCNC.x
      const dy = cncMouse.y - init.startCNC.y
      setEditNodes(init.initialNodes.map((n, i) => {
        if (i !== m.nodeIdx) return n
        if (m.kind === 'anchor') {
          return {
            ...n,
            x: n.x + dx,
            y: n.y + dy,
            handleIn: n.handleIn ? { x: n.handleIn.x + dx, y: n.handleIn.y + dy } : undefined,
            handleOut: n.handleOut ? { x: n.handleOut.x + dx, y: n.handleOut.y + dy } : undefined,
          }
        }
        if (m.kind === 'handle-in') {
          return { ...n, handleIn: { x: (n.handleIn?.x ?? n.x) + dx, y: (n.handleIn?.y ?? n.y) + dy } }
        }
        return { ...n, handleOut: { x: (n.handleOut?.x ?? n.x) + dx, y: (n.handleOut?.y ?? n.y) + dy } }
      }))
    }
  }, [setCursorMM, setViewport, setLiveRotationAngle])

  const handleMouseUp = useCallback((_e: Konva.KonvaEventObject<MouseEvent>) => {
    const m = modeRef.current
    const vp = viewportRef.current

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
          const newD = scaleAroundD(path.d, ax, ay, sx, sy)
          const newShapeParams = path.shapeParams
            ? scaleShapeParams(path.shapeParams, ax, ay, sx, sy)
            : undefined
          // null means computed but not representable → clear shapeParams
          return [{ id, d: newD, shapeParams: newShapeParams === null ? null : newShapeParams }]
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

      const { activeTool, shapeToolConfig, setActiveTool } = useUIStore.getState()
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
        setActiveTool('select')

        // If text font wasn't loaded yet, update d once it loads
        if (params.type === 'text' && !d) {
          import('../shapes/textGenerator').then(({ loadFont }) => {
            loadFont(params.fontFamily).then(() => {
              const newD = generateShapeD(params)
              if (newD) usePathsStore.getState().batchUpdatePaths([{ id, d: newD }])
            })
          })
        }
      }
      return
    }

    if (m.type === 'nodedit-drag') {
      setMode2({ type: 'idle' })
      editDragInitRef.current = null
      commitEditNodes(editNodesRef.current)
      return
    }

    if (m.type === 'pendraw') {
      setMode2({ type: 'idle' })

      if (m.closing) {
        const { penNodes: nodes, clearPenNodes } = useUIStore.getState()
        if (nodes.length >= 2) {
          const d = penNodesToPathD(nodes, true)
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

      const { addPenNode } = useUIStore.getState()
      const newNode: PenNode = { x: m.anchorCNC.x, y: m.anchorCNC.y }
      if (didDragRef.current && livePen?.handle) {
        const dx = livePen.handle.x - m.anchorCNC.x
        const dy = livePen.handle.y - m.anchorCNC.y
        newNode.outHandle = livePen.handle
        newNode.inHandle = { x: m.anchorCNC.x - dx, y: m.anchorCNC.y - dy }
      }
      addPenNode(newNode)
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
          useUIStore.getState().addDrillPoint(cnc)
        }
      }
    }

    setMode2({ type: 'idle' })
  }, [liveTransform, livePen, dragBox, setMode2, setSelectedIds, setLiveRotationAngle, commitEditNodes])

  const activeTool = useUIStore((s) => s.activeTool)

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
          <GridLayer viewport={viewport} />
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
            />
          )}
          <ToolpathLayer viewport={viewport} onHover={handleToolpathHover} />
          <SimulationLayer viewport={viewport} />
          <ShapePreviewLayer viewport={viewport} d={liveShapeD} />
          {activeTool === 'pen' && (
            <PenLayer viewport={viewport} penNodes={penNodes} livePen={livePen} penClosing={penClosing} />
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

      {/* Toolpath hover tooltip */}
      {toolpathTooltip && (
        <div
          className="absolute pointer-events-none z-10 bg-panel/90 border border-ridge text-bright text-body rounded px-2 py-1 shadow-lg whitespace-nowrap"
          style={{ left: toolpathTooltip.x + 12, top: toolpathTooltip.y - 8 }}
        >
          <div className="font-medium">{toolpathTooltip.name}</div>
          {toolpathTooltip.depth && <div className="text-dim">{toolpathTooltip.depth}</div>}
        </div>
      )}

      {/* Drag-box selection overlay */}
      {dragBox && dragBoxStyle && (
        <div
          className="absolute border border-blue-400 bg-blue-400/10 pointer-events-none"
          style={dragBoxStyle}
        />
      )}

      {/* Node edit indicator */}
      {nodeEditPathId && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-emerald-700/90 text-white text-body px-3 py-1 rounded-full pointer-events-none">
          {hoveredEditNode !== null
            ? 'Delete key to remove point'
            : 'Drag points or handles · Click segment to insert · Esc to finish'}
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
              ? 'Pen Tool — click to start, drag to curve'
              : 'Click to add point, drag to curve, click first point to close, Esc to finish'}
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
