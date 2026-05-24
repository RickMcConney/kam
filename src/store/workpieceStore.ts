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
    }),
    { name: 'freazykam-workpiece' }
  )
)
