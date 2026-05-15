import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type CommentStyle = 'semicolon' | 'parenthesis' | 'none'

export interface PostProcessorProfile {
  id: string
  name: string
  unitMode: 'mm' | 'in'
  commentStyle: CommentStyle
  startGcode: string
  endGcode: string
  toolChangeGcode: string
  spindleOnTemplate: string
  spindleOffGcode: string
  rapidTemplate: string
  cutTemplate: string
  arcCWTemplate: string
  arcCCWTemplate: string
  outputArcs: boolean
}

const GRBL_MM: PostProcessorProfile = {
  id: 'grbl-mm',
  name: 'Grbl (mm)',
  unitMode: 'mm',
  commentStyle: 'parenthesis',
  startGcode: 'G21\nG90\nG17',
  endGcode: 'M5\nG0 Z10.000\nG0 X0 Y0\nM30',
  toolChangeGcode: 'M5',
  spindleOnTemplate: 'M3 S{s}',
  spindleOffGcode: 'M5',
  rapidTemplate: 'G0 X{x} Y{y} Z{z}',
  cutTemplate: 'G1 X{x} Y{y} Z{z} F{f}',
  arcCWTemplate: 'G2 X{x} Y{y} I{i} J{j} F{f}',
  arcCCWTemplate: 'G3 X{x} Y{y} I{i} J{j} F{f}',
  outputArcs: false,
}

const GRBL_IN: PostProcessorProfile = {
  id: 'grbl-in',
  name: 'Grbl (inches)',
  unitMode: 'in',
  commentStyle: 'parenthesis',
  startGcode: 'G20\nG90\nG17',
  endGcode: 'M5\nG0 Z0.400\nG0 X0 Y0\nM30',
  toolChangeGcode: 'M5',
  spindleOnTemplate: 'M3 S{s}',
  spindleOffGcode: 'M5',
  rapidTemplate: 'G0 X{x} Y{y} Z{z}',
  cutTemplate: 'G1 X{x} Y{y} Z{z} F{f}',
  arcCWTemplate: 'G2 X{x} Y{y} I{i} J{j} F{f}',
  arcCCWTemplate: 'G3 X{x} Y{y} I{i} J{j} F{f}',
  outputArcs: false,
}

let _idCounter = 0

interface PostProcessorState {
  profiles: PostProcessorProfile[]
  activeId: string
  setActiveId: (id: string) => void
  addProfile: () => void
  duplicateProfile: (id: string) => void
  deleteProfile: (id: string) => void
  updateProfile: (id: string, updates: Partial<Omit<PostProcessorProfile, 'id'>>) => void
  replaceState: (profiles: PostProcessorProfile[], activeId: string) => void
  getActiveProfile: () => PostProcessorProfile
}

export const usePostProcessorStore = create<PostProcessorState>()(
  persist(
    (set, get) => ({
      profiles: [GRBL_MM, GRBL_IN],
      activeId: 'grbl-mm',

      setActiveId: (id) => set({ activeId: id }),

      addProfile: () => {
        const id = `pp-${++_idCounter}-${Date.now()}`
        const newProfile: PostProcessorProfile = { ...GRBL_MM, id, name: 'New Profile' }
        set((s) => ({ profiles: [...s.profiles, newProfile], activeId: id }))
      },

      duplicateProfile: (id) => {
        const src = get().profiles.find((p) => p.id === id)
        if (!src) return
        const newId = `pp-${++_idCounter}-${Date.now()}`
        const dup: PostProcessorProfile = { ...src, id: newId, name: `${src.name} copy` }
        set((s) => ({ profiles: [...s.profiles, dup], activeId: newId }))
      },

      deleteProfile: (id) =>
        set((s) => {
          if (s.profiles.length <= 1) return s
          const profiles = s.profiles.filter((p) => p.id !== id)
          return { profiles, activeId: s.activeId === id ? profiles[0].id : s.activeId }
        }),

      updateProfile: (id, updates) =>
        set((s) => ({
          profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...updates } : p)),
        })),

      replaceState: (profiles, activeId) => set({ profiles, activeId }),

      getActiveProfile: () => {
        const { profiles, activeId } = get()
        return profiles.find((p) => p.id === activeId) ?? profiles[0]
      },
    }),
    { name: 'freazykam-postprocessors' }
  )
)
