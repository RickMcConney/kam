import { create } from 'zustand'
import type { SnapshotRecord } from '../io/autosave'

interface RestoreState {
  /** The snapshot being offered back, or null when there is nothing to restore. */
  offer: SnapshotRecord | null
  setOffer: (rec: SnapshotRecord) => void
  clearOffer: () => void
}

// Drives the boot-time "restore unsaved work" prompt. Its own store (like
// saveDialogStore) so App can seed it from an async IndexedDB read without
// threading the record through props.
export const useRestoreStore = create<RestoreState>()((set) => ({
  offer: null,
  setOffer: (rec) => set({ offer: rec }),
  clearOffer: () => set({ offer: null }),
}))
