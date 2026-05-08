import { create } from 'zustand'
import type { CuttingDirection } from './toolStore'

export type CutSide = 'inside' | 'outside' | 'centerline'
export type OperationStatus = 'pending' | 'generating' | 'done' | 'needs-update' | 'error'

export interface MotionSegment {
  x: number
  y: number
  z: number
  rapid: boolean
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
}

export interface ProfileOperation extends BaseOperation {
  type: 'profile'
  pathId: string
  side: CutSide
  depthMM: number
  stepDownMM: number
  direction: CuttingDirection
}

export interface PocketOperation extends BaseOperation {
  type: 'pocket'
  pathId: string
  islandIds: string[]
  depthMM: number
  stepDownMM: number
  stepoverPercent: number
  direction: CuttingDirection
}

export interface DrillOperation extends BaseOperation {
  type: 'drill'
  drillMode: 'peck' | 'helical'
  points: DrillPoint[]
  // helical only:
  pathId?: string
  helicalCenterX?: number
  helicalCenterY?: number
  helicalRadius?: number
  depthMM: number
  stepDownMM: number
}

export type AnyOperation = ProfileOperation | PocketOperation | DrillOperation

type AddPayload =
  | Omit<ProfileOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<PocketOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>
  | Omit<DrillOperation, 'id' | 'status' | 'segments' | 'color' | 'visible'>

const OP_COLORS = ['#f97316', '#06b6d4', '#10b981', '#8b5cf6', '#ec4899', '#eab308']
let _colorIdx = 0
let _idCounter = 0

interface ToolpathState {
  operations: AnyOperation[]
  addOperation: (op: AddPayload) => string
  updateOperation: (id: string, updates: Partial<AnyOperation>) => void
  deleteOperation: (id: string) => void
  setSegments: (id: string, segments: MotionSegment[]) => void
  setError: (id: string, error: string) => void
  toggleVisibility: (id: string) => void
  markNeedsUpdate: (pathId: string) => void
}

function refsPathId(op: AnyOperation, pathId: string): boolean {
  if (op.type === 'profile') return op.pathId === pathId
  if (op.type === 'pocket') return op.pathId === pathId || op.islandIds.includes(pathId)
  if (op.type === 'drill') return op.pathId === pathId
  return false
}

export const useToolpathStore = create<ToolpathState>()((set) => ({
  operations: [],

  addOperation: (op) => {
    const id = `op-${++_idCounter}`
    const color = OP_COLORS[_colorIdx++ % OP_COLORS.length]
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

  markNeedsUpdate: (pathId) =>
    set((s) => ({
      operations: s.operations.map((o) =>
        o.status === 'done' && refsPathId(o, pathId) ? { ...o, status: 'needs-update' } as AnyOperation : o
      ),
    })),
}))
