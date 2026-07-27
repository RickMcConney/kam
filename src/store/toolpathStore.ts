import { create } from 'zustand'
import { OP_TYPE_COLORS } from '../colors'
import { uid } from '../uid'
import { useTimelineStore } from '../timeline/timelineStore'
import { serializeOp, DERIVED_OP_KEYS, type SerializedOperation } from '../timeline/events'
import type { CuttingDirection } from './toolStore'
export type CutSide = 'inside' | 'outside' | 'centerline'
type OperationStatus = 'pending' | 'generating' | 'done' | 'needs-update' | 'error'

export interface MotionSegment {
  x: number
  y: number
  z: number
  rapid: boolean
  travel?: boolean      // stay-down micro-lift transition (not cutting, not full safe-height rapid)
  arc?: { cx: number; cy: number; cw: boolean }  // absolute arc center + direction; G2=cw, G3=ccw
  toolChange?: string  // toolId: emit tool-change gcode at this point, no movement
  feedScale?: number   // multiplier applied to computed feed rate (default 1.0)
}

interface DrillPoint {
  x: number
  y: number
}

interface BaseOperation {
  id: string
  name: string
  toolId: string
  status: OperationStatus
  segments: MotionSegment[]
  color: string
  visible: boolean
  errorMessage?: string
  entryHint?: { x: number; y: number }
}

export interface ProfileOperation extends BaseOperation {
  type: 'profile'
  pathId: string
  side: CutSide
  depthMM: number
  stepDownMM: number
  direction: CuttingDirection
  rampIn: boolean
}

export interface PocketOperation extends BaseOperation {
  type: 'pocket'
  pathId: string
  islandIds: string[]
  depthMM: number
  stepDownMM: number
  stepoverPercent: number
  passAngleDeg: number
  direction: CuttingDirection
  strategy: 'raster' | 'contour' | 'adaptive' | 'morph' | 'adaptive2'
  rampIn: boolean
  allowanceMM?: number   // finish allowance: stock left on all walls (negative grows the pocket)
}

export interface DrillOperation extends BaseOperation {
  type: 'drill'
  drillMode: 'peck' | 'helical'
  points: DrillPoint[]
  pathId?: string
  helicalCenterX?: number
  helicalCenterY?: number
  helicalRadius?: number
  depthMM: number
  stepDownMM: number
}

export interface SurfaceOperation extends BaseOperation {
  type: 'surface'
  depthMM: number
  stepDownMM: number
  stepoverPercent: number
  passAngleDeg: number
}

export interface VCarveOperation extends BaseOperation {
  type: 'vcarve'
  pathId: string
  islandIds: string[]
  maxDepthMM: number
  angleDeg: number
}

// vbitToolId sentinel: skip the finish/wall pass entirely (female roughing-only —
// just the raster pocket, no separate wall-finish contour). Only valid for female.
export const INLAY_NO_FINISH = 'none'

export interface InlayOperation extends BaseOperation {
  type: 'inlay'
  role: 'female' | 'male'
  phase: 'vbit' | 'endmill'  // which tool phase this operation represents
  pathId: string
  islandIds: string[]
  pocketToolId: string    // flat end mill ID (always the endmill, regardless of phase)
  vbitToolId: string      // vbit ID (always the vbit, regardless of phase)
  angleDeg: number
  pocketDepthMM: number
  stepDownMM: number
  stepoverPercent: number
  glueLineMM: number
  clearanceMM: number
  rampIn: boolean         // ramp/helical entry on roughing pockets instead of straight plunge
  mirrorX?: boolean       // male only: mirror shape around vertical axis before cutting
  linkedOpId?: string     // ID of the paired phase operation
}

export interface Profile3dOperation extends BaseOperation {
  type: 'profile3d'
  pathId: string
  stepoverPercent: number
  rasterAngleDeg: number
  maxDepthMM: number
  roughingToolId?: string
  roughingStepoverPercent?: number
  roughingStepDownMM?: number
  roughingStockAllowanceMM?: number
  roughingRasterAngleDeg?: number
}

export interface TrochoidalOperation extends BaseOperation {
  type: 'trochoidal'
  pathId: string
  side: CutSide
  depthMM: number
  stepDownMM: number
  direction: CuttingDirection
  trochStepMM: number
  trochRadiusMM: number
  finishingPass: boolean
  rampIn: boolean
}

export interface GcodeOperation extends BaseOperation {
  type: 'gcode'
  filename: string
}

export const GCODE_IMPORT_TOOL_ID = '__gcode_import__'

export type AnyOperation = ProfileOperation | PocketOperation | DrillOperation | SurfaceOperation | VCarveOperation | InlayOperation | Profile3dOperation | TrochoidalOperation | GcodeOperation

type AddPayload =
  | Omit<ProfileOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<PocketOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<DrillOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<SurfaceOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<VCarveOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<InlayOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<Profile3dOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<TrochoidalOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<GcodeOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>

interface ToolpathState {
  operations: AnyOperation[]
  // opts.record=false skips timeline recording — for derived/system writes
  // (regenerate's helical-center write-back, G-code import which records its
  // own event after segments are attached).
  addOperation: (op: AddPayload, opts?: { record?: boolean }) => string
  updateOperation: (id: string, updates: Partial<AnyOperation>, opts?: { record?: boolean }) => void
  deleteOperation: (id: string) => void
  // Recorded variants of replaceOperations for user-facing reorder /
  // group-delete (PathsPanel). replaceOperations itself stays raw — it's for
  // load/undo/import machinery and view-state rewrites.
  reorderOperations: (operations: AnyOperation[]) => void
  deleteOperations: (ids: string[]) => void
  setSegments: (id: string, segments: MotionSegment[]) => void
  setError: (id: string, error: string) => void
  toggleVisibility: (id: string) => void
  moveOperation: (id: string, dir: 'up' | 'down') => void
  replaceOperations: (operations: AnyOperation[]) => void
  markNeedsUpdate: (pathId: string) => void
}

export function refsPathId(op: AnyOperation, pathId: string): boolean {
  if (op.type === 'profile') return op.pathId === pathId
  if (op.type === 'trochoidal') return op.pathId === pathId
  if (op.type === 'pocket') return op.pathId === pathId || op.islandIds.includes(pathId)
  if (op.type === 'drill') return op.pathId === pathId
  if (op.type === 'vcarve') return op.pathId === pathId || op.islandIds.includes(pathId)
  if (op.type === 'inlay') return op.pathId === pathId || op.islandIds.includes(pathId)
  if (op.type === 'profile3d') return op.pathId === pathId
  return false
}

export const useToolpathStore = create<ToolpathState>()((set, get) => ({
  operations: [],

  addOperation: (op, opts) => {
    const id = uid('op')
    const color = OP_TYPE_COLORS[op.type] ?? '#94a3b8'
    const newOp = { ...op, id, status: 'pending', segments: [], color, visible: true } as AnyOperation
    set((s) => ({ operations: [...s.operations, newOp] }))
    if (opts?.record !== false) {
      useTimelineStore.getState().record({ kind: 'op.add', op: serializeOp(newOp) })
    }
    return id
  },

  updateOperation: (id, updates, opts) => {
    const opType = get().operations.find((o) => o.id === id)?.type
    set((s) => ({ operations: s.operations.map((o) => o.id === id ? { ...o, ...updates } as AnyOperation : o) }))
    if (opts?.record === false) return
    const recordable = { ...updates } as Record<string, unknown>
    for (const k of DERIVED_OP_KEYS) delete recordable[k]
    if (Object.keys(recordable).length > 0) {
      // Settings edits amend the op's defining chip (usually its op.add) —
      // changing a pocket's depth is an argument edit to that call, not a new
      // timeline entry. Fallback records normally if no definer exists.
      const tl = useTimelineStore.getState()
      if (!tl.amendOpSettings(id, recordable as Partial<SerializedOperation>)) {
        tl.record({ kind: 'op.update', opId: id, opType, updates: recordable as Partial<SerializedOperation> })
      }
    }
  },

  deleteOperation: (id) => {
    const opType = get().operations.find((o) => o.id === id)?.type
    set((s) => ({ operations: s.operations.filter((o) => o.id !== id) }))
    useTimelineStore.getState().record({ kind: 'op.delete', opIds: [id], opType })
  },

  reorderOperations: (operations) => {
    set({ operations })
    useTimelineStore.getState().record({ kind: 'op.reorder', order: operations.map((o) => o.id) })
  },

  deleteOperations: (ids) => {
    if (ids.length === 0) return
    set((s) => ({ operations: s.operations.filter((o) => !ids.includes(o.id)) }))
    useTimelineStore.getState().record({ kind: 'op.delete', opIds: ids })
  },

  setSegments: (id, segments) =>
    set((s) => ({
      operations: s.operations.map((o) =>
        o.id === id ? { ...o, segments, status: 'done', errorMessage: undefined } as AnyOperation : o
      ),
    })),

  setError: (id, error) =>
    set((s) => ({
      operations: s.operations.map((o) =>
        o.id === id ? { ...o, status: 'error', errorMessage: error, segments: [] } as AnyOperation : o
      ),
    })),

  toggleVisibility: (id) =>
    set((s) => ({ operations: s.operations.map((o) => o.id === id ? { ...o, visible: !o.visible } as AnyOperation : o) })),

  moveOperation: (id, dir) => {
    const s = get()
    const idx = s.operations.findIndex((o) => o.id === id)
    if (idx < 0) return
    const newIdx = dir === 'up' ? idx - 1 : idx + 1
    if (newIdx < 0 || newIdx >= s.operations.length) return
    const ops = [...s.operations]
    const [removed] = ops.splice(idx, 1)
    ops.splice(newIdx, 0, removed)
    s.reorderOperations(ops)
  },

  replaceOperations: (operations) => set({ operations }),

  markNeedsUpdate: (pathId) =>
    set((s) => ({
      operations: s.operations.map((o) =>
        o.status === 'done' && refsPathId(o, pathId) ? { ...o, status: 'needs-update' } as AnyOperation : o
      ),
    })),
}))

// Re-export OriginPosition so callers can get it from one place
