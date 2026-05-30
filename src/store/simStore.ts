import { create } from 'zustand'
import { parseGcode, getCurrentSegIdx, type SimSegment, type ToolState } from '../sim/gcodeParser'

export type SimSpeed = 1 | 5 | 20 | 100

interface SimState {
  gcode: string
  gcodeLines: string[]
  segments: SimSegment[]
  toolStates: ToolState[]
  totalTimeS: number
  playing: boolean
  speed: SimSpeed
  elapsedTimeS: number
  gcodeViewerOpen: boolean

  loadGcode: (text: string) => void
  play: () => void
  pause: () => void
  stop: () => void
  seekToTime: (t: number) => void
  setSpeed: (s: SimSpeed) => void
  advanceTime: (dtS: number) => void
  toggleGcodeViewer: () => void
  clearSim: () => void
  currentLineIdx: () => number
}

export const useSimStore = create<SimState>()((set, get) => ({
  gcode: '',
  gcodeLines: [],
  segments: [],
  toolStates: [],
  totalTimeS: 0,
  playing: false,
  speed: 20,
  elapsedTimeS: 0,
  gcodeViewerOpen: false,

  loadGcode: (text) => {
    const parsed = parseGcode(text)
    set({
      gcode: text,
      gcodeLines: parsed.lines,
      segments: parsed.segments,
      toolStates: parsed.toolStates,
      totalTimeS: parsed.totalTimeS,
      elapsedTimeS: 0,
      playing: false,
    })
  },

  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
  stop: () => set({ playing: false, elapsedTimeS: 0 }),

  seekToTime: (t) =>
    set((s) => ({ elapsedTimeS: Math.max(0, Math.min(t, s.totalTimeS)) })),

  setSpeed: (speed) => set({ speed }),

  advanceTime: (dtS) =>
    set((s) => {
      if (!s.playing) return s
      const newTime = s.elapsedTimeS + dtS
      if (newTime >= s.totalTimeS) return { elapsedTimeS: s.totalTimeS, playing: false }
      return { elapsedTimeS: newTime }
    }),

  toggleGcodeViewer: () => set((s) => ({ gcodeViewerOpen: !s.gcodeViewerOpen })),

  clearSim: () =>
    set({ gcode: '', gcodeLines: [], segments: [], toolStates: [], totalTimeS: 0, elapsedTimeS: 0, playing: false }),

  currentLineIdx: () => {
    const { segments, elapsedTimeS } = get()
    const idx = getCurrentSegIdx(segments, elapsedTimeS)
    return idx >= 0 ? (segments[idx]?.lineIdx ?? -1) : -1
  },
}))
