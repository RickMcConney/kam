import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Units = 'mm' | 'in'

export type OriginPosition =
  | 'top-left' | 'top-center' | 'top-right'
  | 'mid-left' | 'center' | 'mid-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right'

export type Material =
  | 'pine' | 'oak' | 'maple' | 'walnut' | 'cherry'
  | 'mdf' | 'plywood' | 'hdpe' | 'aluminum' | 'other'

// Single source of truth for the materials list and their relative machining
// hardness (mdf ≈ 0.8 baseline). Higher = harder = gentler feeds/step-down.
// Used by the WorkpiecePanel dropdown and the feeds/speeds calculation (cam/feeds.ts).
export const MATERIAL_INFO: Record<Material, { label: string; hardness: number }> = {
  pine: { label: 'Pine', hardness: 0.6 },
  oak: { label: 'Oak', hardness: 1.4 },
  maple: { label: 'Maple', hardness: 1.3 },
  walnut: { label: 'Walnut', hardness: 1.2 },
  cherry: { label: 'Cherry', hardness: 1.2 },
  mdf: { label: 'MDF', hardness: 0.8 },
  plywood: { label: 'Plywood', hardness: 0.9 },
  hdpe: { label: 'HDPE', hardness: 0.7 },
  aluminum: { label: 'Aluminum', hardness: 2.5 },
  other: { label: 'Other', hardness: 1.0 },
}

export const MM_PER_INCH = 25.4

export const toMM = (value: number, units: Units): number =>
  units === 'in' ? value * MM_PER_INCH : value

export const fromMM = (value: number, units: Units): number =>
  units === 'in' ? +(value / MM_PER_INCH).toFixed(4) : +value.toFixed(3)

interface WorkpieceState {
  widthMM: number
  heightMM: number
  thicknessMM: number
  units: Units
  origin: OriginPosition
  material: Material
  tableLimitWidthMM: number
  tableLimitHeightMM: number
  tableLimitDepthMM: number
  safeHeightMM: number
  machineRigidity: number      // 1 (hobby) … 5 (commercial CNC)
  maxFeedMmMin: number         // hard ceiling the machine can sustain — never exceeded
  minSpindleRpm: number        // machine's lowest usable spindle speed (clamp floor)
  maxSpindleRpm: number        // machine's top spindle speed — auto may raise rpm up to this
  autoFeedEnabled: boolean     // when true, feeds/step-down are computed (cam/feeds.ts)
  setWidth: (mm: number) => void
  setHeight: (mm: number) => void
  setThickness: (mm: number) => void
  setUnits: (u: Units) => void
  setOrigin: (o: OriginPosition) => void
  setMaterial: (m: Material) => void
  setTableLimitWidth: (mm: number) => void
  setTableLimitHeight: (mm: number) => void
  setTableLimitDepth: (mm: number) => void
  setSafeHeight: (mm: number) => void
  setMachineRigidity: (r: number) => void
  setMaxFeed: (mm: number) => void
  setMinSpindleRpm: (rpm: number) => void
  setMaxSpindleRpm: (rpm: number) => void
  setAutoFeedEnabled: (v: boolean) => void
}

export const useWorkpieceStore = create<WorkpieceState>()(
  persist(
    (set) => ({
      widthMM: 300,
      heightMM: 200,
      thicknessMM: 18,
      units: 'mm',
      origin: 'bottom-left',
      material: 'mdf',
      tableLimitWidthMM: 800,
      tableLimitHeightMM: 600,
      tableLimitDepthMM: 70,
      safeHeightMM: 5,
      machineRigidity: 3,
      maxFeedMmMin: 3000,
      minSpindleRpm: 8000,
      maxSpindleRpm: 24000,
      autoFeedEnabled: false,
      setWidth: (mm) => set({ widthMM: mm }),
      setHeight: (mm) => set({ heightMM: mm }),
      setThickness: (mm) => set({ thicknessMM: mm }),
      setUnits: (u) => set({ units: u }),
      setOrigin: (o) => set({ origin: o }),
      setMaterial: (m) => set({ material: m }),
      setTableLimitWidth: (mm) => set({ tableLimitWidthMM: mm }),
      setTableLimitHeight: (mm) => set({ tableLimitHeightMM: mm }),
      setTableLimitDepth: (mm) => set({ tableLimitDepthMM: mm }),
      setSafeHeight: (mm) => set({ safeHeightMM: mm }),
      setMachineRigidity: (r) => set({ machineRigidity: Math.max(1, Math.min(5, Math.round(r))) }),
      setMaxFeed: (mm) => set({ maxFeedMmMin: mm }),
      setMinSpindleRpm: (rpm) => set({ minSpindleRpm: rpm }),
      setMaxSpindleRpm: (rpm) => set({ maxSpindleRpm: rpm }),
      setAutoFeedEnabled: (v) => set({ autoFeedEnabled: v }),
    }),
    { name: 'freazykam-workpiece' }
  )
)
