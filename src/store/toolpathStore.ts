import { create } from 'zustand'
import { OP_TYPE_COLORS } from '../colors'
import type { CuttingDirection } from './toolStore'
import type { OriginPosition } from './workpieceStore'
export type CutSide = 'inside' | 'outside' | 'centerline'
export type OperationStatus = 'pending' | 'generating' | 'done' | 'needs-update' | 'error'

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

export interface DrillPoint {
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
  strategy: 'raster' | 'contour' | 'adaptive'
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

let _idCounter = 0

interface ToolpathState {
  operations: AnyOperation[]
  addOperation: (op: AddPayload) => string
  updateOperation: (id: string, updates: Partial<AnyOperation>) => void
  deleteOperation: (id: string) => void
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

export const useToolpathStore = create<ToolpathState>()((set) => ({
  operations: [],

  addOperation: (op) => {
    const id = `op-${++_idCounter}`
    const color = OP_TYPE_COLORS[op.type] ?? '#94a3b8'
    set((s) => ({
      operations: [...s.operations, { ...op, id, status: 'pending', segments: [], color, visible: true } as AnyOperation],
    }))
    return id
  },

  updateOperation: (id, updates) =>
    set((s) => ({ operations: s.operations.map((o) => o.id === id ? { ...o, ...updates } as AnyOperation : o) })),

  deleteOperation: (id) =>
    set((s) => ({ operations: s.operations.filter((o) => o.id !== id) })),

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

  moveOperation: (id, dir) =>
    set((s) => {
      const idx = s.operations.findIndex((o) => o.id === id)
      if (idx < 0) return s
      const newIdx = dir === 'up' ? idx - 1 : idx + 1
      if (newIdx < 0 || newIdx >= s.operations.length) return s
      const ops = [...s.operations]
      const [removed] = ops.splice(idx, 1)
      ops.splice(newIdx, 0, removed)
      return { operations: ops }
    }),

  replaceOperations: (operations) => set({ operations }),

  markNeedsUpdate: (pathId) =>
    set((s) => ({
      operations: s.operations.map((o) =>
        o.status === 'done' && refsPathId(o, pathId) ? { ...o, status: 'needs-update' } as AnyOperation : o
      ),
    })),
}))

// Re-export OriginPosition so callers can get it from one place
export type { OriginPosition }
