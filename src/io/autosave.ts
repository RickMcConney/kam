import { buildProjectData } from './projectSave'
import type { ProjectData } from './projectLoad'
import { usePathsStore } from '../store/pathsStore'
import { useToolpathStore } from '../store/toolpathStore'
import { useTabStore } from '../store/tabStore'
import { useProjectStore } from '../store/projectStore'
import { useTimelineStore } from '../timeline/timelineStore'

// ─────────────────────────────────────────────────────────────────────────────
// Crash / tab-discard recovery.
//
// The document stores (paths, toolpaths, tabs, timeline, project) are NOT
// persisted — only the machine-local ones (ui, workpiece, tools, post-
// processors, form defaults) are, so any page load comes back with the stock
// and the tool library intact and the drawing gone. That reads as "my paths
// vanished" rather than "the app restarted", which is what makes it alarming.
//
// The page load itself is usually not the user's doing: Chrome's Memory Saver
// discards background tabs under memory pressure and re-navigates the URL when
// you focus them again, and this app is a fat target for that heuristic (a live
// WebGL context, several Konva canvases plus the cut-trail raster, and a worker
// pool sized to hardwareConcurrency). The dev server's full-reload does the
// same thing.
//
// So: mirror buildProjectData() into IndexedDB, and offer it back on boot.
//
// IndexedDB, not localStorage: a project with any real number of paths blows
// past the ~5 MB localStorage quota, and localStorage writes are synchronous on
// the main thread.
//
// visibilitychange is the hook that matters. `beforeunload` does NOT fire when
// a tab is discarded, and by the time `freeze` fires the page can no longer
// finish async work. `visibilitychange → hidden` fires the moment you switch
// away — minutes before any discard — which leaves the IDB write all the time
// it needs.
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = 'freazykam'
const DB_VERSION = 1
const STORE = 'autosave'
const KEY = 'session'

// Long enough that a drag or a burst of generation writes lands as one snapshot;
// short enough that little is lost. The flush on hide covers the tab-switch case
// regardless, so this only bounds what a hard crash costs.
const DEBOUNCE_MS = 3000

/** Everything the restore prompt needs, so boot never parses the payload. */
export interface SnapshotMeta {
  savedAt: number
  /** Was the document unsaved when this was written? A clean one is not offered back. */
  dirty: boolean
  name: string
  pathCount: number
  opCount: number
}

export type SnapshotRecord = SnapshotMeta & { json: string }

// ─── IndexedDB ───────────────────────────────────────────────────────────────
// Hand-rolled rather than a dependency: one store, one key, three operations.
// Every failure path resolves to null instead of rejecting — a browser with
// storage blocked (private mode, "block third-party cookies" on some setups)
// must lose autosave, not the app.

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  return dbPromise
}

// Resolves on transaction COMPLETE, not on request success. A request succeeds
// before the transaction commits, and the whole point of the hide-flush is that
// the bytes are on disk before the tab is discarded — so the write is not done
// until the commit says so.
function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDB().then((db) => {
    if (!db) return null
    return new Promise<T | null>((resolve) => {
      let result: T | null = null
      try {
        const t = db.transaction(STORE, mode)
        const req = run(t.objectStore(STORE))
        req.onsuccess = () => { result = req.result }
        t.oncomplete = () => resolve(result)
        // Quota exceeded lands here. Nothing to do but keep the old snapshot.
        t.onerror = () => resolve(null)
        t.onabort = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  })
}

export function readSnapshot(): Promise<SnapshotRecord | null> {
  return tx<SnapshotRecord>('readonly', (s) => s.get(KEY) as IDBRequest<SnapshotRecord>)
    .then((r) => r ?? null)
}

export function clearSnapshot(): Promise<void> {
  return tx('readwrite', (s) => s.delete(KEY) as IDBRequest<undefined>).then(() => undefined)
}

/** Parse a snapshot's payload back into the same shape a .fkam file carries. */
export function snapshotData(rec: SnapshotRecord): ProjectData {
  return JSON.parse(rec.json) as ProjectData
}

// ─── The autosave loop ───────────────────────────────────────────────────────

// Writes are gated until the boot-time restore decision has been made. Without
// this, mounting over a fresh empty document would immediately overwrite the
// snapshot we are about to offer back.
let armed = false
let timer: ReturnType<typeof setTimeout> | undefined
let writing = false
let pending = false
// Fingerprint of the last payload written, so an unchanged document is not
// re-written. buildProjectData strips computed segments and flattens status, so
// every snapshot taken during a long generation is byte-identical to the one
// taken before it started — and the worker reports progress often enough that
// this would otherwise push the whole project to disk repeatedly for nothing.
// A hash rather than the string itself: holding a second copy of a multi-MB
// payload alive between writes is exactly the memory pressure that gets this
// tab discarded in the first place.
let lastHash = ''

function fingerprint(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${s.length}:${(h >>> 0).toString(36)}`
}

export function armAutosave() {
  armed = true
}

async function flush() {
  if (!armed) return
  // One write at a time: a hide-flush landing on top of a debounce-flush would
  // otherwise race, and the loser could be the newer of the two.
  if (writing) { pending = true; return }
  writing = true
  try {
    const paths = usePathsStore.getState().paths
    const ops = useToolpathStore.getState().operations
    // Once armed, an empty document means the user emptied it (New Project, or
    // deleting everything) — so drop the snapshot rather than prompting on the
    // next boot to restore work that was deliberately abandoned.
    if (paths.length === 0 && ops.length === 0) {
      lastHash = ''
      await clearSnapshot()
      return
    }
    const data = buildProjectData() // already strips computed segments
    // The one real cost in here. Storing the object directly would skip it, but
    // structured clone would throw on anything non-cloneable that ever ends up
    // on a path, and a string is exactly the .fkam bytes — same format, no
    // second serialization path to keep in step.
    const json = JSON.stringify(data)
    const tl = useTimelineStore.getState()
    // `dirty` is part of the identity: a save changes nothing in the payload but
    // must still be recorded, or a saved project stays on offer as unsaved work.
    const hash = `${fingerprint(json)}:${tl.cursor !== tl.savedSeq}`
    if (hash === lastHash) return
    const rec: SnapshotRecord = {
      savedAt: Date.now(),
      dirty: tl.cursor !== tl.savedSeq,
      name: data.name,
      pathCount: paths.length,
      opCount: ops.length,
      json,
    }
    await tx('readwrite', (s) => s.put(rec, KEY) as IDBRequest<IDBValidKey>)
    lastHash = hash
  } catch (err) {
    console.warn('[autosave] snapshot write failed', err)
  } finally {
    writing = false
    if (pending) { pending = false; void flush() }
  }
}

type Watchable<T> = { subscribe: (l: (s: T, p: T) => void) => () => void }

/** Fire `onChange` only when `pick` actually changes identity. */
function watch<T>(store: Watchable<T>, pick: (s: T) => unknown, onChange: () => void) {
  return store.subscribe((s, p) => { if (pick(s) !== pick(p)) onChange() })
}

export function installAutosave(): () => void {
  const schedule = () => {
    if (!armed) return
    clearTimeout(timer)
    timer = setTimeout(() => { void flush() }, DEBOUNCE_MS)
  }

  const unsubs = [
    watch(usePathsStore, (s) => s.paths, schedule),
    watch(useToolpathStore, (s) => s.operations, schedule),
    watch(useTabStore, (s) => s.tabs, schedule),
    watch(useProjectStore, (s) => s.name, schedule),
    // Not a document change, but it flips `dirty` — rewrite so a project saved
    // and then discarded is not offered back as unsaved work.
    watch(useTimelineStore, (s) => s.savedSeq, schedule),
  ]
  // Workpiece and tools are deliberately not watched: both are persisted to
  // localStorage on their own, so they survive the reload that loses everything
  // else, and buildProjectData picks up their current values on the next write.

  const onHide = () => {
    if (document.visibilityState !== 'hidden') return
    clearTimeout(timer)
    void flush()
  }
  const onPageHide = () => { clearTimeout(timer); void flush() }

  document.addEventListener('visibilitychange', onHide)
  window.addEventListener('pagehide', onPageHide)

  return () => {
    armed = false
    clearTimeout(timer)
    for (const u of unsubs) u()
    document.removeEventListener('visibilitychange', onHide)
    window.removeEventListener('pagehide', onPageHide)
  }
}
