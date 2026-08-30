import { useEffect, useRef } from 'react'
import { RotateCcw } from 'lucide-react'
import { useRestoreStore } from '../store/restoreStore'
import { armAutosave, clearSnapshot, snapshotData, type SnapshotMeta } from '../io/autosave'
import { loadProject } from '../io/projectLoad'
import { useUIStore } from '../store/uiStore'
import { useTimelineStore } from '../timeline/timelineStore'

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'less than a minute ago'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m > 1 ? 's' : ''} ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`
  const d = Math.round(h / 24)
  return `${d} day${d > 1 ? 's' : ''} ago`
}

function contents(meta: SnapshotMeta): string {
  const bits = [
    `${meta.pathCount} path${meta.pathCount === 1 ? '' : 's'}`,
    `${meta.opCount} operation${meta.opCount === 1 ? '' : 's'}`,
  ]
  return bits.join(', ')
}

// Shown at startup when IndexedDB holds a snapshot of a document that was never
// saved — the tab was discarded, reloaded or crashed out from under the user.
// Nothing else may run before this is answered: autosave stays disarmed until
// one of the two buttons is pressed, so the offer cannot be overwritten by the
// empty document sitting behind the dialog. See io/autosave.ts.
export default function RestoreDialog() {
  const offer = useRestoreStore((s) => s.offer)
  const clearOffer = useRestoreStore((s) => s.clearOffer)
  const restoreRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (offer) setTimeout(() => restoreRef.current?.focus(), 0)
  }, [offer])

  if (!offer) return null

  function restore() {
    if (!offer) return
    try {
      // No file name — the snapshot's own `name` is the authority here, since it
      // is the name the project already had when it was lost.
      loadProject(snapshotData(offer))
      // loadProject marks the document clean — correct for a file on disk, wrong
      // here. This one matches nothing on disk, so it stays unsaved until the
      // user actually saves it; otherwise the next snapshot is written clean and
      // a second discard loses the work for good.
      useTimelineStore.getState().markUnsaved()
      useUIStore.getState().showStatus(
        `Restored ${offer.name} from the last session — toolpaths are regenerating.`,
        'info',
      )
    } catch (err) {
      console.error('[autosave] restore failed', err)
      useUIStore.getState().showStatus('Could not restore the last session — the backup was unreadable.', 'error')
      void clearSnapshot()
    }
    clearOffer()
    armAutosave()
  }

  function discard() {
    void clearSnapshot()
    clearOffer()
    armAutosave()
  }

  return (
    // No click-outside dismiss and no Escape: leaving it unanswered would leave
    // autosave disarmed for the rest of the session.
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-neutral-800 rounded-lg shadow-2xl border border-gray-200 dark:border-neutral-700 w-[460px] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-200 dark:border-neutral-700">
          <RotateCcw size={18} className="text-blue-500" />
          <h2 className="text-base font-semibold text-gray-900 dark:text-neutral-100">Restore unsaved work</h2>
        </div>

        {/* Body */}
        <div className="px-5 py-4 flex flex-col gap-3">
          <p className="text-sm text-gray-700 dark:text-neutral-300">
            FreazyKam closed with unsaved changes — the browser reloaded the tab, most
            likely after putting it to sleep in the background.
          </p>
          <div className="rounded bg-gray-100 dark:bg-neutral-700/60 px-3 py-2 text-sm">
            <div className="font-medium text-gray-900 dark:text-neutral-100">{offer.name}</div>
            <div className="text-gray-600 dark:text-neutral-400">
              {contents(offer)} · backed up {ago(offer.savedAt)}
            </div>
          </div>
          <p className="text-xs text-gray-500 dark:text-neutral-400">
            Toolpaths are regenerated after restoring, so they may take a moment to reappear.
          </p>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-200 dark:border-neutral-700">
          <button
            onClick={discard}
            className="px-3 py-1.5 text-sm rounded text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700 transition-colors"
          >
            Discard
          </button>
          <button
            ref={restoreRef}
            onClick={restore}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            Restore
          </button>
        </div>
      </div>
    </div>
  )
}
