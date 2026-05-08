import { create } from 'zustand'

interface CanvasStore {
  cursorMM: { x: number; y: number } | null
  zoomPct: number
  liveRotationAngle: number | null
  setCursorMM: (pos: { x: number; y: number } | null) => void
  setZoomPct: (pct: number) => void
  setLiveRotationAngle: (angle: number | null) => void
}

export const useCanvasStore = create<CanvasStore>()((set) => ({
  cursorMM: null,
  zoomPct: 100,
  liveRotationAngle: null,
  setCursorMM: (pos) => set({ cursorMM: pos }),
  setZoomPct: (pct) => set({ zoomPct: pct }),
  setLiveRotationAngle: (angle) => set({ liveRotationAngle: angle }),
}))
