import { create } from 'zustand'
import { parseGcode, getCurrentSegIdx, type SimSegment, type ToolState } from '../sim/gcodeParser'
import { useWorkpieceStore, zDatumOffsetMM } from './workpieceStore'
import { useUIStore } from './uiStore'

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
  // Z datum offset that was in effect when this G-code was generated.
  // Stored here so normalization (segments → top-referenced) uses the correct
  // offset even if the user later changes zOrigin without regenerating.
  genZOff: number

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
  genZOff: 0,

  loadGcode: (text) => {
    const { zOrigin, thicknessMM, safeHeightMM } = useWorkpieceStore.getState()
    const genZOff = zDatumOffsetMM(zOrigin, thicknessMM)
    // Parser's initial cz must match the machine-coord safe height so the tool
    // starts at the right position when elapsedTimeS = 0 (reset to start).
    const parsed = parseGcode(text, safeHeightMM + genZOff)
    // App-generated G-code never triggers these; imported external files can.
    if (parsed.warnings.length > 0)
      useUIStore.getState().showStatus(`G-code simulation: ${parsed.warnings.join('; ')}`, 'warn')
    set({
      gcode: text,
      gcodeLines: parsed.lines,
      segments: parsed.segments,
      toolStates: parsed.toolStates,
      totalTimeS: parsed.totalTimeS,
      // A loaded program shows its RESULT: the finished part, every cut made. That is
      // what the user opened the simulator to see, and watching it happen is the second
      // question, not the first — so playback starts from the answer and Play rewinds to
      // the start (see `play`). Both views derive the material state from elapsedTimeS
      // alone, so parking it at the end is the whole of "render the final result"; the
      // 3D carve that backs it is spread over frames (HeightfieldMaterial.applyUpTo).
      elapsedTimeS: parsed.totalTimeS,
      playing: false,
      genZOff,
    })
  },

  // Play from the start when the run is sitting at its end — which is where a freshly
  // loaded program sits, and where a finished one is left. Pressing Play on a finished
  // run is only ever a request to watch it happen. A paused run mid-way resumes.
  play: () =>
    set((s) => (s.totalTimeS > 0 && s.elapsedTimeS >= s.totalTimeS
      ? { playing: true, elapsedTimeS: 0 }
      : { playing: true })),
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
    set({ gcode: '', gcodeLines: [], segments: [], toolStates: [], totalTimeS: 0, elapsedTimeS: 0, playing: false, genZOff: 0 }),

  currentLineIdx: () => {
    const { segments, elapsedTimeS } = get()
    const idx = getCurrentSegIdx(segments, elapsedTimeS)
    return idx >= 0 ? (segments[idx]?.lineIdx ?? -1) : -1
  },
}))
