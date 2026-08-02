import { create } from 'zustand'
import { uid } from '../uid'
import { hydrateOp, labelFor, sameOpSettings, serializeOp, KNOWN_EVENT_KINDS, TRANSFORM_GESTURES, type Checkpoint, type SerializedOperation, type TimelineEvent, type TimelineEventPayload } from './events'
import { replay } from './applyEvent'
import type { ImportedPath, PathUpdate } from '../store/pathsStore'
import { usePathsStore } from '../store/pathsStore'
import type { ShapeParams } from '../shapes/shapeGenerators'
import { useToolpathStore, pathIdsOf, type AnyOperation } from '../store/toolpathStore'
import { abortGeneration } from '../workers/abortGeneration'
import { useTabStore, type Tab } from '../store/tabStore'
import { useUIStore } from '../store/uiStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import type { OffsetEventMeta, PatternEventMeta, WorkpieceEventChanges } from './events'
import type { BooleanOpType } from '../tools/booleanOps'
import { applyTransformSteps, consolidateSteps, gestureForSteps, getBBox, getMultiBBox, type BBox, type TransformStep } from '../canvas/selectionUtils'

// The operation timeline: an append-only event log ("the program") with a
// cursor. Every project mutation records one TimelineEvent; undo/redo and the
// TimelinePanel scrub the cursor. Replay correctness can be checked any time
// with window.__fkamReplayCheck().

const CHECKPOINT_INTERVAL = 25
const COALESCE_MS = 800
// Auto-compaction: past this many events, the oldest are folded into one
// snapshot(compaction) event so the log (memory + .fkam size) stays bounded.
const COMPACT_THRESHOLD = 500
const COMPACT_KEEP = 250

// Checkpoints are derived caches, not UI state — kept out of the reactive store.
// Key = seq the checkpoint captures state AFTER (0 = genesis).
const checkpoints = new Map<number, Checkpoint>()
checkpoints.set(0, { paths: [], operations: [], tabs: [] })

// The boot genesis above can't capture the workpiece: this module evaluates
// inside an import cycle with the stores, so reading them here would hit
// uninitialized bindings. Backfill once the module graph has finished loading
// (before any user interaction) — otherwise scrubbing back past the first
// workpiece.set event has no baseline to restore and leaves the new value.
const backfillGenesis = () => {
  const g = checkpoints.get(0)
  if (!g || g.workpiece) return
  // Async module loaders (vitest/vite-node) flush microtasks between module
  // evaluations, so this can fire while the cycle's bindings are still
  // undefined — retry on the next tick until the stores exist.
  if (!useWorkpieceStore || !usePathsStore || !useToolpathStore || !useTabStore) {
    setTimeout(backfillGenesis, 0)
    return
  }
  if (useTimelineStore.getState().events.length === 0) {
    checkpoints.set(0, captureCheckpoint())
  }
}
queueMicrotask(backfillGenesis)

function captureWorkpiece(): Required<WorkpieceEventChanges> {
  const { widthMM, heightMM, thicknessMM, units, origin, zOrigin, material } = useWorkpieceStore.getState()
  return { widthMM, heightMM, thicknessMM, units, origin, zOrigin, material }
}

function captureCheckpoint(): Checkpoint {
  return {
    paths: usePathsStore.getState().paths,
    operations: useToolpathStore.getState().operations.map(serializeOp),
    tabs: useTabStore.getState().tabs,
    workpiece: captureWorkpiece(),
  }
}

// Drop every checkpoint at or after `seq` — they captured states derived from
// event content that has just changed. Callers that rewrite an event pass that
// event's seq (its own snapshot is now stale too); `dropAfter` is for the one
// caller that only invalidates strictly-later checkpoints (record's
// insert/truncate, where the cursor's own checkpoint is still valid).
//
// Genesis (seq 0) is never dropped by the `>= seq` form since every real event
// seq is >= 1; the amend-genesis paths clear everything above 0 explicitly.
function invalidateCheckpointsFrom(seq: number, dropAfter = false): void {
  for (const k of checkpoints.keys()) {
    if (dropAfter ? k > seq : k >= seq) checkpoints.delete(k)
  }
}

export function nearestCheckpoint(seq: number): { seq: number; state: Checkpoint } {
  let best = 0
  for (const k of checkpoints.keys()) {
    if (k <= seq && k > best) best = k
  }
  return { seq: best, state: checkpoints.get(best)! }
}

// Bounding box of the given paths' geometry BEFORE event `seq` (i.e. as of
// seq-1) — the stable reference a transform chip's editor uses as the
// default pivot for a scale/rotate/skew step it's introducing for the first
// time. Deliberately NOT the paths' current/live bbox: that moves every time
// an existing field (dx/dy in particular) is edited, which would make a
// freshly-introduced step's pivot drift on every render — the exact
// instability this function exists to avoid.
export function bboxBeforeEvent(seq: number, pathIds: string[]): BBox | null {
  const { events } = useTimelineStore.getState()
  const cp = nearestCheckpoint(seq - 1)
  const before = replay(cp.state, events.slice(cp.seq), seq - 1)
  const ds = pathIds.flatMap((id) => {
    const p = before.paths.find((pp) => pp.id === id)
    return p ? [p.d] : []
  })
  return getMultiBBox(ds)
}

export interface RecordMeta {
  label?: string
  gestureId?: string
  // Override the captured selection. Needed when the selection change lands
  // AFTER the recording store action (CanvasStage does addPaths → selectPath),
  // and for add-events generally: scrubbing to one should select what it created.
  selectionAfter?: string[]
}

export type ScrubIntent = 'undo' | 'browse'

// How the cursor last moved into the past — set by scrubTo, read by record()
// to choose truncate vs insert. Not reactive state; no UI depends on it.
let lastScrubIntent: ScrubIntent = 'undo'

interface TimelineState {
  events: TimelineEvent[]
  cursor: number    // seq of last applied event; invariant: events[i].seq === i + 1
  savedSeq: number  // seq at last project save (dirty = cursor !== savedSeq)

  record: (payload: TimelineEventPayload, meta?: RecordMeta) => void
  // Rebuild the log as an empty program whose genesis is the CURRENT store
  // state. Used by new project, and by project load when the file carries no
  // usable timeline (v1 files, corrupt/newer-version logs).
  resetToCurrentState: () => void
  markSaved: () => void
  // Install a timeline from a saved project (v2 .fkam). The stores must
  // already hold the state at `cursor` (the file's snapshot block) — nothing is
  // replayed here. Returns false when the timeline is invalid or from a newer
  // version, in which case the caller should resetToCurrentState() instead.
  loadTimeline: (genesis: Checkpoint, events: TimelineEvent[], cursor: number) => boolean

  // Time travel: restore project state as of event `seq` (0 = genesis).
  // Replays from the nearest checkpoint, preserves toolpath segments for ops
  // whose settings + source geometry are unchanged, and schedules debounced
  // regeneration for the rest.
  //
  // `intent` decides what a NEW edit does while the cursor sits in the past:
  //   'undo'   — classic undo semantics: the edit truncates the future
  //   'browse' — timeline browsing: the edit is INSERTED at the cursor and the
  //              later events are kept, renumbered, and replayable on top
  //              (self-contained payloads make this safe: events about other
  //              paths/ops apply unchanged; events whose target was removed
  //              no-op).
  scrubTo: (seq: number, intent?: ScrubIntent) => void
  // Delete one event from the timeline: later events are renumbered and state
  // is re-derived by replaying without it. NOT undoable — it edits the history
  // itself, not the project.
  removeEvent: (seq: number) => void
  // Fold events 1..uptoSeq (clamped to the cursor — ghosts are never baked in)
  // into a single snapshot(compaction) event. Auto-invoked past
  // COMPACT_THRESHOLD; flattenHistory() is the manual "compact everything up
  // to here" action. NOT undoable.
  compact: (uptoSeq: number) => void
  flattenHistory: () => void

  // Edit-in-place: parameter changes (shape/text params, op settings) are
  // argument edits to the call that created the thing — they AMEND the payload
  // of the last event ≤ cursor that wrote the target instead of appending a
  // new chip. Replay stays consistent because nothing between that event and
  // the cursor touches those fields (it wouldn't be the last writer otherwise).
  // Returns false when no defining event exists (caller falls back to
  // recording a normal event). NOT undoable — the chip IS the record.
  amendPathDefinition: (pathId: string, upd: { d: string; shapeParams?: ShapeParams | null; name?: string }) => boolean
  amendOpSettings: (opId: string, updates: Partial<SerializedOperation>) => boolean
  // Re-Generate that changes WHICH operations a form produced, not just their settings:
  // PocketForm's Invert Pocket toggle re-reads the same selection into a different set of
  // boundaries. Same reasoning as amendOpSettings — it is an argument edit to the call
  // that created them — but the op set itself changes, so the op.add chip's payload is
  // rewritten wholesale instead of merged field-by-field. Returns false when no defining
  // op.add exists (loaded/compacted project), and the caller records delete+add normally.
  amendOpAddEvent: (anchorOpId: string, patch: { removeIds: string[]; add: SerializedOperation[] }) => boolean
  // BooleanForm edit mode: rewrite a boolean chip's op type + result geometry.
  // Keyed by event id (seqs shift on insert/remove/compact while the form is
  // open). The live result path is rewritten by the caller (rewritePathRaw).
  amendBooleanEvent: (eventId: string, patch: { boolOp: BooleanOpType; resultD: string; resultName: string }) => boolean
  // Offset/Pattern edit modes: replace a paths.add chip's generated paths and
  // generator metadata wholesale. The live paths are rewritten by the caller
  // (rewriteGeneratedRaw).
  amendAddEvent: (eventId: string, patch: { paths: ImportedPath[]; offset?: OffsetEventMeta; pattern?: PatternEventMeta }) => boolean
  // Tab edits are in-place: the last tabs.apply chip (or snapshot/genesis
  // entry) that defined this path's tabs gets its payload replaced with the
  // path's CURRENT tabs. Returns false when a legacy tabs.moveT/tabs.delete
  // chip sits in between (amending beneath it would be overridden on replay) —
  // the caller then records a normal event.
  amendTabsForPath: (pathId: string, tabs: Tab[]) => boolean
  // PropertiesPanel's transform-chip editor: replace a move/scale/rotate/
  // skew/mirror (or merged 'transform') event's TransformStep recipe,
  // recomposing every affected path from its state just BEFORE this event —
  // not its current state — so this stays a true in-place edit of that one
  // historical step rather than stacking a new transform on top. Returns
  // false when the event isn't a transform-recipe paths.edit event.
  amendTransformSteps: (eventId: string, steps: TransformStep[]) => boolean
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
}

function mergePathUpdate(older: PathUpdate, newer: PathUpdate): PathUpdate {
  // Transform recipes concatenate (older steps first) rather than the newer
  // one winning — replay needs the FULL step chain to recompose correctly
  // against whatever the base geometry is at that point; dropping the older
  // steps would reintroduce the stale-absolute-d bug for merged chips. The
  // concatenated chain then collapses to its canonical net scale/skew/
  // rotate/mirror/translate parameters, pivoted at the path's own (current,
  // fully-baked) bounding box — see consolidateSteps. Gestures with no
  // recipe concept (corner/points/join/…) never set `transforms`, so this
  // stays undefined for them, same as before.
  const transforms = (older.transforms?.length || newer.transforms?.length)
    ? consolidateSteps(
        [...(older.transforms ?? []), ...(newer.transforms ?? [])],
        getBBox(newer.d) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0, cx: 0, cy: 0 },
      )
    : undefined
  return {
    id: newer.id,
    d: newer.d,
    // undefined means "leave untouched" — the older event's value survives.
    // `corner` is newer-wins-outright (not concatenated like transforms) —
    // NodeEditForm always sends the full current per-corner map, not a delta.
    shapeParams: newer.shapeParams !== undefined ? newer.shapeParams : older.shapeParams,
    name: newer.name !== undefined ? newer.name : older.name,
    hidden: newer.hidden !== undefined ? newer.hidden : older.hidden,
    corner: newer.corner !== undefined ? newer.corner : older.corner,
    ...(transforms ? { transforms } : {}),
  }
}

// Merge a rapid-fire follow-up event into the tip event (numeric spinners,
// tab drags) so the timeline records gestures, not keystrokes. Returns the
// merged event, or null when the pair is not coalescible.
function coalesce(last: TimelineEvent, payload: TimelineEventPayload): TimelineEvent | null {
  if (last.kind !== payload.kind) return null
  switch (payload.kind) {
    case 'op.update': {
      if (last.kind !== 'op.update' || last.opId !== payload.opId) return null
      return { ...last, updates: { ...last.updates, ...payload.updates } }
    }
    case 'tabs.moveT': {
      if (last.kind !== 'tabs.moveT' || last.tabId !== payload.tabId) return null
      return { ...last, t01: payload.t01 }
    }
    case 'shape.params': {
      if (last.kind !== 'shape.params' || last.pathId !== payload.pathId) return null
      return { ...last, params: payload.params }
    }
    case 'op.setVisible': {
      if (last.kind !== 'op.setVisible') return null
      const sameIds = last.opIds.length === payload.opIds.length &&
        [...last.opIds].sort().join() === [...payload.opIds].sort().join()
      // Toggling the same operations again just overwrites the earlier answer; toggling
      // MORE operations the same way extends the set. Anything else (different ops, other
      // direction) is a separate decision and gets its own entry.
      if (!sameIds && last.visible !== payload.visible) return null
      const opIds = sameIds ? payload.opIds : [...new Set([...last.opIds, ...payload.opIds])]
      const merged = { ...last, opIds, visible: payload.visible }
      return { ...merged, label: labelFor(merged) }
    }
    case 'op.reorder': {
      if (last.kind !== 'op.reorder') return null
      // The payload is the COMPLETE order, so the newer one wins outright and every
      // intermediate arrangement is dead weight — the same reason workpiece.set merges.
      return { ...last, order: payload.order }
    }
    case 'workpiece.set': {
      if (last.kind !== 'workpiece.set') return null
      const changes = { ...last.changes, ...payload.changes }
      // Recompute the label — merging can widen it (width-only → Stock Size → Workpiece)
      return { ...last, changes, label: labelFor({ kind: 'workpiece.set', changes }) }
    }
    case 'paths.edit': {
      if (last.kind !== 'paths.edit') return null
      // A chain of pure-geometry transforms (Move/Scale/Rotate/Skew/Mirror) on
      // the same path set merges even when the gesture kind changes — only
      // the net geometry matters, so Move-then-Rotate-then-Move collapses to
      // one "Transform" chip. Anything else (corner/points/join/weld/trim/
      // text/boolean, or an untagged edit) still requires an exact gesture
      // match, matching the old keystroke-rate-only behavior.
      const bothTransforms = last.gesture !== undefined && payload.gesture !== undefined &&
        TRANSFORM_GESTURES.has(last.gesture) && TRANSFORM_GESTURES.has(payload.gesture)
      if (!bothTransforms && last.gesture !== payload.gesture) return null
      const pureLast = !(last.add?.length) && !(last.deleteIds?.length)
      const pureNew = !(payload.add?.length) && !(payload.deleteIds?.length)
      if (!pureLast || !pureNew) return null
      const lastIds = last.updates.map((u) => u.id).sort().join(' ')
      const newIds = payload.updates.map((u) => u.id).sort().join(' ')
      if (lastIds !== newIds) return null
      const olderById = new Map(last.updates.map((u) => [u.id, u]))
      const gesture = bothTransforms && last.gesture !== payload.gesture ? 'transform' : payload.gesture
      return {
        ...last,
        gesture,
        updates: payload.updates.map((u) => mergePathUpdate(olderById.get(u.id)!, u)),
        label: labelFor({ ...payload, gesture }),
      }
    }
    default:
      return null
  }
}

// Paths an op's toolpath depends on — used to decide whether generated
// segments survive a scrub.
function tabsByPath(tabs: Tab[]): Map<string, Tab[]> {
  const m = new Map<string, Tab[]>()
  for (const t of tabs) {
    const a = m.get(t.pathId)
    if (a) a.push(t)
    else m.set(t.pathId, [t])
  }
  return m
}

// Debounced regeneration after scrubbing — rapid scrubs (drag across the
// timeline) only regenerate once the cursor settles.
// ─── Parked segments ──────────────────────────────────────────────────────────
//
// restoreStateAt keeps generated segments by reading the LIVE operation, which covers
// scrubbing over unrelated events but not over the event that ADDED the operation. Scrub
// back past a pocket's op.add and the op leaves the state entirely; come forward again and
// there is nothing live to read, so every operation regenerates for a cursor move that
// changed nothing — 26 pockets on an imported drawing, reappearing smallest-first because
// the regen fans out across the worker pool.
//
// So operations that are about to leave the state are parked here together with the
// geometry they were generated from, and are looked up again on the way forward. Validity
// is decided by exactly the same three tests as the live path (same settings, same source
// path d, same tabs), just measured against the snapshot taken when the entry was parked —
// so a park can never resurrect segments that no longer describe the operation.
interface ParkedOp {
  op: AnyOperation
  pathD: Map<string, string>
  tabsByPath: Map<string, Tab[]>
}
const parkedOps = new Map<string, ParkedOp>()
// Segment arrays are the big things in this app (a 600 mm pocket is ~34 k of them), so the
// park is capped and evicts least-recently-parked first. Overflowing only costs a
// regeneration — the same thing that happened before the park existed.
const PARK_LIMIT = 64

function park(op: AnyOperation, curPathD: Map<string, string>, curTabs: Map<string, Tab[]>) {
  // Snapshot only what this op depends on, not the whole document.
  const pathD = new Map<string, string>()
  for (const id of pathIdsOf(serializeOp(op))) {
    const d = curPathD.get(id)
    if (d !== undefined) pathD.set(id, d)
  }
  const tabsFor = new Map<string, Tab[]>()
  const pid = (op as { pathId?: string }).pathId
  if (pid) tabsFor.set(pid, curTabs.get(pid) ?? [])

  parkedOps.delete(op.id)   // re-insert so Map order is least-recent-first
  parkedOps.set(op.id, { op, pathD, tabsByPath: tabsFor })
  while (parkedOps.size > PARK_LIMIT) {
    const oldest = parkedOps.keys().next()
    if (oldest.done) break
    parkedOps.delete(oldest.value)
  }
}

/** Dropped when the timeline itself is replaced — a different project's ops are not ours. */
function clearParkedOps() { parkedOps.clear() }

let regenTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRegen() {
  if (regenTimer) clearTimeout(regenTimer)
  regenTimer = setTimeout(() => {
    regenTimer = null
    // Dynamic import avoids a module cycle (regenerate → stores → timelineStore)
    void import('../cam/regenerate').then(({ regenerateOperation }) => {
      for (const op of useToolpathStore.getState().operations) {
        if (op.status === 'needs-update') void regenerateOperation(op.id)
      }
    })
  }, 300)
}

// Write the project state as of event `seq` (folded over `events`) into the
// stores. Shared by scrubTo and removeEvent — the latter re-derives the SAME
// cursor position over a changed event list, so this never early-outs on
// cursor equality. Does not touch the timeline store itself.
function restoreStateAt(seq: number, events: TimelineEvent[]): void {
  const cp = nearestCheckpoint(seq)
  const state = replay(cp.state, events.slice(cp.seq), seq)

  // Preserve generated segments where the op's settings, source paths, and
  // (for profile ops) tabs are unchanged — scrubbing over unrelated events
  // must not throw away seconds-long adaptive/vcarve generations.
  //
  // The settings comparison MUST go through sameOpSettings: live ops carry
  // entryHint/visible/helical* that no event records, so a raw compare against
  // the replayed op reports "changed" for every op as soon as the project has
  // been simulated or exported once — defeating this whole block.
  const currentOps = new Map(useToolpathStore.getState().operations.map((o) => [o.id, o]))
  const curPathD = new Map(usePathsStore.getState().paths.map((p) => [p.id, p.d]))
  const newPathD = new Map(state.paths.map((p) => [p.id, p.d]))
  // Group tabs by path once rather than re-filtering both arrays per operation.
  const curTabsByPath = tabsByPath(useTabStore.getState().tabs)
  const newTabsByPath = tabsByPath(state.tabs)

  // Do this operation's existing segments still describe `sop`? `pathD`/`tabs` are the
  // geometry the candidate was generated against — the live stores for a live op, the
  // snapshot taken at park time for one coming back out of the park.
  const stillValid = (
    cand: AnyOperation, pathD: Map<string, string>, tabs: Map<string, Tab[]>, sop: SerializedOperation,
  ): boolean =>
    cand.status === 'done' &&
    sameOpSettings(serializeOp(cand), sop) &&
    pathIdsOf(sop).every((id) => newPathD.has(id) && pathD.get(id) === newPathD.get(id)) &&
    ((sop.type !== 'profile' && sop.type !== 'trochoidal') ||
      JSON.stringify(tabs.get(sop.pathId) ?? []) === JSON.stringify(newTabsByPath.get(sop.pathId) ?? []))

  const hydrated: AnyOperation[] = state.operations.map((sop) => {
    const cur = currentOps.get(sop.id)
    const parked = parkedOps.get(sop.id)
    const keep =
      cur && stillValid(cur, curPathD, curTabsByPath, sop) ? cur
      : parked && stillValid(parked.op, parked.pathD, parked.tabsByPath, sop) ? parked.op
      : null
    if (keep) {
      // Visibility is deliberately outside sameOpSettings (a toggle must not read as a
      // settings change and discard segments), so the replayed value is applied here by
      // hand — otherwise scrubbing across an op.setVisible would keep the live one and
      // the operation would stay hidden, or reappear, against its own history.
      const wantVisible = (sop as { visible?: boolean }).visible ?? true
      return keep.visible === wantVisible ? keep : { ...keep, visible: wantVisible }
    }
    return hydrateOp(sop)
  })

  // Park the finished operations this state DROPS, before they are overwritten.
  const surviving = new Set(state.operations.map((o) => o.id))
  for (const op of currentOps.values()) {
    if (surviving.has(op.id) || op.status !== 'done' || op.segments.length === 0) continue
    park(op, curPathD, curTabsByPath)
  }

  const pathIds = new Set(state.paths.map((p) => p.id))
  // Selection is view state, not document state, and selecting is not a recorded event —
  // so `selectionAfter` is only ever the selection as it stood at some OTHER edit. Replaying
  // it over a step that did not change which paths exist throws away a selection the user
  // made by hand since: generate an inlay over two selected paths, undo it, and the ops go
  // (right) but the selection collapses to whatever was selected at the previous recorded
  // event — usually the single path that was added last — so the paths have to be picked
  // again before the operation can be retried.
  //
  // Restore it only when the set of paths itself differs, which is the case it exists for:
  // scrubbing to an era with different paths, or undoing an add/delete, where carrying the
  // current selection forward would be meaningless. A pure `d` change (move, scale, node
  // edit) keeps the same ids and so keeps the selection, which is what you want anyway —
  // undoing a move should leave the thing you moved selected.
  const curPaths = usePathsStore.getState()
  const samePathSet = curPaths.paths.length === state.paths.length
    && curPaths.paths.every((p) => pathIds.has(p.id))
  const selection = (samePathSet
    ? curPaths.selectedIds
    : (seq > 0 ? events[seq - 1].selectionAfter : []))
    .filter((id) => pathIds.has(id))

  usePathsStore.setState({ paths: state.paths, selectedIds: selection })
  useToolpathStore.setState({ operations: hydrated })
  useTabStore.setState({ tabs: state.tabs })

  // Restore workpiece fields when the checkpoint era carries them (timelines
  // from before Phase 6 don't — leave the workpiece as-is then). setState
  // bypasses the recording setters; the surface-op auto-regen subscription
  // (App.useSurfaceWorkpieceSync) fires only on actual width/height/origin
  // changes, which is exactly when surface toolpaths need a rebuild.
  const wp = state.workpiece
  if (wp) {
    const cur = useWorkpieceStore.getState()
    const changed = (Object.keys(wp) as (keyof WorkpieceEventChanges)[])
      .some((k) => wp[k] !== undefined && cur[k] !== wp[k])
    if (changed) useWorkpieceStore.setState({ ...wp })
  }

  if (hydrated.some((o) => o.status === 'needs-update')) scheduleRegen()
}

export const useTimelineStore = create<TimelineState>()((set, get) => ({
  events: [],
  cursor: 0,
  savedSeq: 0,

  record: (payload, meta) => {
    const s = get()
    const atTip = s.cursor === s.events.length
    const selectionAfter = meta?.selectionAfter ?? [...usePathsStore.getState().selectedIds]
    const now = Date.now()

    // Any change at/before the cursor invalidates checkpoints past it — they
    // captured states derived from the old event content.
    const dropFutureCheckpoints = () => {
      invalidateCheckpointsFrom(s.cursor, true)
    }

    // Coalesce with the event AT the cursor (the one just applied) — covers
    // both tip appends and mid-timeline inserts (spinner edits on an old shape
    // must merge, not insert one event per keystroke). The 800 ms window means
    // a mid-timeline merge target can only be an event we just inserted, never
    // a genuinely old one. Never merge into an event a checkpoint or the last
    // save captured — rewriting it would silently invalidate that snapshot.
    //
    // Exception: a run of pure-geometry transforms (Move/Scale/Rotate/Skew/
    // Mirror) on the same path set merges regardless of elapsed time — a
    // reposition done in several separate drags is still just one net move
    // as long as nothing else happened between them, so the 800 ms window
    // doesn't apply here.
    //
    // Exception: consecutive workpiece.set events merge regardless of
    // elapsed time too — each one just overwrites whichever fields it
    // touched (coalesce's workpiece.set case is a plain object spread), so
    // there's never anything meaningful in an intermediate value; setting
    // width, then later setting height, then later still changing width
    // again should end up as one "Workpiece" chip holding the final values,
    // not three chips where the first two are dead weight.
    const prev = s.cursor > 0 ? s.events[s.cursor - 1] : undefined
    const isTransformChain = prev?.kind === 'paths.edit' && payload.kind === 'paths.edit' &&
      prev.gesture !== undefined && payload.gesture !== undefined &&
      TRANSFORM_GESTURES.has(prev.gesture) && TRANSFORM_GESTURES.has(payload.gesture)
    const isWorkpieceChain = prev?.kind === 'workpiece.set' && payload.kind === 'workpiece.set'
    // Exception: consecutive reorders merge regardless of elapsed time, for the same
    // reason as workpiece.set — each event holds the whole order, so a program dragged
    // into shape over several separate drags is one "Reorder ops" chip rather than one
    // per drag. Anything else happening in between breaks the chain, which is right:
    // that reorder then has work depending on it and deserves its own entry.
    const isReorderChain = prev?.kind === 'op.reorder' && payload.kind === 'op.reorder'
    // Visibility merges on the same terms and for the same reason: each event states the
    // final answer for its operations, so a session of hiding and showing while judging a
    // program is one decision, not one entry per click.
    const isVisibleChain = prev?.kind === 'op.setVisible' && payload.kind === 'op.setVisible'
    if (
      prev &&
      (isTransformChain || isWorkpieceChain || isReorderChain || isVisibleChain || now - prev.t < COALESCE_MS) &&
      prev.seq !== s.savedSeq &&
      !checkpoints.has(prev.seq)
    ) {
      const merged = coalesce(prev, payload)
      if (merged) {
        if (!atTip) dropFutureCheckpoints()
        const events = [...s.events]
        events[s.cursor - 1] = { ...merged, t: now, selectionAfter }
        set({ events })
        return
      }
    }

    const event: TimelineEvent = {
      ...payload,
      seq: s.cursor + 1,
      id: uid('ev'),
      t: now,
      label: meta?.label ?? labelFor(payload),
      selectionAfter,
      ...(meta?.gestureId ? { gestureId: meta.gestureId } : {}),
    }

    if (atTip) {
      set({ events: [...s.events, event], cursor: event.seq })
      if (event.seq % CHECKPOINT_INTERVAL === 0) checkpoints.set(event.seq, captureCheckpoint())
      if (event.seq > COMPACT_THRESHOLD) {
        get().compact(event.seq - COMPACT_KEEP)
        useUIStore.getState().showStatus(`Timeline compacted — oldest ${event.seq - COMPACT_KEEP} events folded into a snapshot`, 'info')
      }
      return
    }

    dropFutureCheckpoints()
    if (lastScrubIntent === 'undo') {
      // Classic undo semantics: the discarded branch is gone. A save that
      // pointed into that branch no longer describes any state we can reach —
      // its seq is about to be reused by different events, so leaving savedSeq
      // alone would let the cursor walk back onto it and report the project as
      // clean while holding completely different content.
      set({
        events: [...s.events.slice(0, s.cursor), event],
        cursor: event.seq,
        ...(s.savedSeq > s.cursor ? { savedSeq: -1 } : {}),
      })
      return
    }

    // Timeline browsing: INSERT the edit and keep the future, renumbered.
    // The later events remain ghost chips — scrub/redo replays them on top of
    // this change. A later event that rewrites the same target still wins when
    // replayed (its payload is materialized), like a later line reassigning a
    // variable.
    const future = s.events.slice(s.cursor).map((ev) => ({ ...ev, seq: ev.seq + 1 }))
    set({
      events: [...s.events.slice(0, s.cursor), event, ...future],
      cursor: event.seq,
      // A save that pointed into the shifted future no longer matches any seq
      ...(s.savedSeq > s.cursor ? { savedSeq: -1 } : {}),
    })
    useUIStore.getState().showStatus('Edit inserted into the timeline — later events are kept and replay on top', 'info')
  },

  resetToCurrentState: () => {
    checkpoints.clear()
    clearParkedOps()
    checkpoints.set(0, captureCheckpoint())
    lastScrubIntent = 'undo'
    set({ events: [], cursor: 0, savedSeq: 0 })
  },

  markSaved: () => set({ savedSeq: get().cursor }),

  loadTimeline: (genesis, events, cursor) => {
    const valid =
      genesis && Array.isArray(genesis.paths) && Array.isArray(genesis.operations) && Array.isArray(genesis.tabs) &&
      Array.isArray(events) &&
      Number.isInteger(cursor) && cursor >= 0 && cursor <= events.length &&
      events.every((ev, i) => ev && ev.seq === i + 1 && KNOWN_EVENT_KINDS.has(ev.kind))
    if (!valid) return false
    clearParkedOps()
    checkpoints.clear()
    checkpoints.set(0, genesis)
    lastScrubIntent = 'undo'
    set({ events, cursor, savedSeq: cursor })
    return true
  },

  scrubTo: (seq, intent = 'browse') => {
    lastScrubIntent = intent
    const s = get()
    const target = Math.max(0, Math.min(s.events.length, Math.round(seq)))
    if (target === s.cursor) return
    // Undo, redo and scrubbing all land here, and all of them replace the geometry any
    // running generation was started from — its result would be written against state
    // that no longer exists. Placed after the no-op check so a scrub that goes nowhere
    // doesn't kill a generation.
    abortGeneration()
    restoreStateAt(target, s.events)
    set({ cursor: target })
  },

  compact: (uptoSeq) => {
    const s = get()
    // Never fold unapplied ghost events into the snapshot
    const upto = Math.min(Math.max(1, Math.round(uptoSeq)), s.cursor)
    if (upto < 1 || s.events.length === 0) return
    if (upto === 1 && s.events[0].kind === 'snapshot') return // already compacted to here
    const cp = nearestCheckpoint(upto)
    const folded = replay(cp.state, s.events.slice(cp.seq), upto)
    const last = s.events[upto - 1]
    const snapEvent: TimelineEvent = {
      kind: 'snapshot',
      state: folded,
      reason: 'compaction',
      seq: 1,
      id: uid('ev'),
      t: last.t,
      label: labelFor({ kind: 'snapshot', state: folded, reason: 'compaction' }),
      selectionAfter: last.selectionAfter,
    }
    const events = [snapEvent, ...s.events.slice(upto).map((ev) => ({ ...ev, seq: ev.seq - upto + 1 }))]
    // Rebase checkpoints: original genesis keeps seq 0 (scrub-to-start still
    // works — the snapshot event restores everything on redo), the folded
    // state becomes checkpoint 1, kept-range checkpoints shift down.
    const genesis = checkpoints.get(0)!
    const kept = [...checkpoints.entries()]
      .filter(([k]) => k > upto)
      .map(([k, v]) => [k - upto + 1, v] as const)
    checkpoints.clear()
    checkpoints.set(0, genesis)
    checkpoints.set(1, folded)
    for (const [k, v] of kept) checkpoints.set(k, v)
    set({
      events,
      cursor: s.cursor - upto + 1,
      // A save inside the folded range no longer matches any seq
      savedSeq: s.savedSeq >= upto ? s.savedSeq - upto + 1 : -1,
    })
  },

  flattenHistory: () => {
    const s = get()
    if (s.cursor < 1) return
    const folded = s.cursor
    get().compact(folded)
    useUIStore.getState().showStatus(`History flattened — ${folded} events folded into one snapshot`, 'info')
  },

  removeEvent: (seq) => {
    const s = get()
    if (!Number.isInteger(seq) || seq < 1 || seq > s.events.length) return
    const removed = s.events[seq - 1]
    if (removed.kind === 'snapshot') {
      useUIStore.getState().showStatus('History-start snapshots hold everything before them and cannot be removed', 'warn')
      return
    }
    // Drop the event and renumber everything after it. Later events that
    // depended on what it created simply no-op on replay (ops referencing a
    // removed path end up in error status — remove those events too).
    const events = [
      ...s.events.slice(0, seq - 1),
      ...s.events.slice(seq).map((ev) => ({ ...ev, seq: ev.seq - 1 })),
    ]
    // Checkpoints at/after the removed event captured states that included it
    invalidateCheckpointsFrom(seq)
    const cursor = s.cursor >= seq ? s.cursor - 1 : s.cursor
    set({
      events,
      cursor,
      // A save at/after the removed event no longer matches any seq
      ...(s.savedSeq >= seq ? { savedSeq: -1 } : {}),
    })
    // Only re-derive state when the removed event was inside the applied range
    if (s.cursor >= seq) restoreStateAt(cursor, events)
    useUIStore.getState().showStatus(`Removed "${removed.label}" from the timeline`, 'info')
  },

  amendPathDefinition: (pathId, upd) => {
    const s = get()
    const amendPath = (p: ImportedPath): ImportedPath => ({
      ...p,
      d: upd.d,
      ...(upd.shapeParams !== undefined ? { shapeParams: upd.shapeParams ?? undefined } : {}),
      ...(upd.name !== undefined ? { name: upd.name } : {}),
    })
    const amendUpdate = (u: PathUpdate): PathUpdate => ({
      ...u,
      d: upd.d,
      ...(upd.shapeParams !== undefined ? { shapeParams: upd.shapeParams } : {}),
      ...(upd.name !== undefined ? { name: upd.name } : {}),
    })

    const commit = (idx: number, amended: TimelineEvent) => {
      const events = [...s.events]
      events[idx] = amended
      // Checkpoints at/after the amended event captured the old payload's state
      invalidateCheckpointsFrom(amended.seq)
      set({ events, ...(s.savedSeq >= amended.seq ? { savedSeq: -1 } : {}) })
    }

    for (let i = s.cursor - 1; i >= 0; i--) {
      const ev = s.events[i]
      if (ev.kind === 'paths.add' && ev.paths.some((p) => p.id === pathId)) {
        commit(i, { ...ev, paths: ev.paths.map((p) => p.id === pathId ? amendPath(p) : p) })
        return true
      }
      if (ev.kind === 'shape.params' && ev.pathId === pathId) {
        if (!upd.shapeParams) return false // a bare-d change can't live in a params event
        commit(i, { ...ev, params: upd.shapeParams })
        return true
      }
      if (ev.kind === 'paths.edit' && ev.updates.some((u) => u.id === pathId)) {
        commit(i, { ...ev, updates: ev.updates.map((u) => u.id === pathId ? amendUpdate(u) : u) })
        return true
      }
      if (ev.kind === 'paths.split' && ev.subPaths.some((p) => p.id === pathId)) {
        commit(i, { ...ev, subPaths: ev.subPaths.map((p) => p.id === pathId ? amendPath(p) : p) })
        return true
      }
      if (ev.kind === 'snapshot' && ev.state.paths.some((p) => p.id === pathId)) {
        commit(i, { ...ev, state: { ...ev.state, paths: ev.state.paths.map((p) => p.id === pathId ? amendPath(p) : p) } })
        return true
      }
    }
    // The path predates recorded history (loaded/compacted project) — amend genesis
    const g = checkpoints.get(0)
    if (g && g.paths.some((p) => p.id === pathId)) {
      const amended = { ...g, paths: g.paths.map((p) => p.id === pathId ? amendPath(p) : p) }
      invalidateCheckpointsFrom(1)
      checkpoints.set(0, amended)
      set({ savedSeq: -1 }) // genesis is part of the saved file
      return true
    }
    return false
  },

  amendOpSettings: (opId, updates) => {
    const s = get()
    const commit = (idx: number, amended: TimelineEvent) => {
      const events = [...s.events]
      events[idx] = amended
      invalidateCheckpointsFrom(amended.seq)
      set({ events, ...(s.savedSeq >= amended.seq ? { savedSeq: -1 } : {}) })
    }

    for (let i = s.cursor - 1; i >= 0; i--) {
      const ev = s.events[i]
      if (ev.kind === 'op.update' && ev.opId === opId) {
        commit(i, { ...ev, updates: { ...ev.updates, ...updates } })
        return true
      }
      if (ev.kind === 'op.add' && ev.op.id === opId) {
        commit(i, { ...ev, op: { ...ev.op, ...updates } as SerializedOperation })
        return true
      }
      // A sibling op created by the same action (inlay's second phase) is defined
      // by this chip too — amend it in place rather than recording a new chip.
      if (ev.kind === 'op.add' && ev.linked?.some((o) => o.id === opId)) {
        commit(i, {
          ...ev,
          linked: ev.linked.map((o) => o.id === opId ? { ...o, ...updates } as SerializedOperation : o),
        })
        return true
      }
      if (ev.kind === 'snapshot' && ev.state.operations.some((o) => o.id === opId)) {
        commit(i, {
          ...ev,
          state: {
            ...ev.state,
            operations: ev.state.operations.map((o) => o.id === opId ? { ...o, ...updates } as SerializedOperation : o),
          },
        })
        return true
      }
    }
    const g = checkpoints.get(0)
    if (g && g.operations.some((o) => o.id === opId)) {
      const amended = {
        ...g,
        operations: g.operations.map((o) => o.id === opId ? { ...o, ...updates } as SerializedOperation : o),
      }
      invalidateCheckpointsFrom(1)
      checkpoints.set(0, amended)
      set({ savedSeq: -1 })
      return true
    }
    return false
  },

  amendOpAddEvent: (anchorOpId, patch) => {
    const s = get()
    for (let i = s.cursor - 1; i >= 0; i--) {
      const ev = s.events[i]
      if (ev.kind !== 'op.add') continue
      const members = [ev.op, ...(ev.linked ?? [])]
      if (!members.some((o) => o.id === anchorOpId)) continue
      const remove = new Set(patch.removeIds)
      const next = [...members.filter((o) => !remove.has(o.id)), ...patch.add]
      // An op.add with nothing in it has no meaning; leave the chip alone and let the
      // caller record the delete and the add as ordinary events.
      if (next.length === 0) return false
      const amended: TimelineEvent = {
        ...ev,
        op: next[0],
        ...(next.length > 1 ? { linked: next.slice(1) } : { linked: undefined }),
      }
      const events = [...s.events]
      events[i] = amended
      invalidateCheckpointsFrom(amended.seq)
      set({ events, ...(s.savedSeq >= amended.seq ? { savedSeq: -1 } : {}) })
      return true
    }
    return false
  },

  amendBooleanEvent: (eventId, patch) => {
    const s = get()
    const idx = s.events.findIndex((ev) => ev.id === eventId)
    if (idx === -1) return false
    const ev = s.events[idx]
    if (ev.kind !== 'paths.edit' || !ev.add?.length) return false
    const amended: TimelineEvent = {
      ...ev,
      boolOp: patch.boolOp,
      add: [{ ...ev.add[0], d: patch.resultD, name: patch.resultName }, ...ev.add.slice(1)],
    }
    const events = [...s.events]
    events[idx] = amended
    invalidateCheckpointsFrom(amended.seq)
    set({ events, ...(s.savedSeq >= amended.seq ? { savedSeq: -1 } : {}) })
    return true
  },

  amendAddEvent: (eventId, patch) => {
    const s = get()
    const idx = s.events.findIndex((ev) => ev.id === eventId)
    if (idx === -1) return false
    const ev = s.events[idx]
    if (ev.kind !== 'paths.add') return false
    const amended: TimelineEvent = {
      ...ev,
      paths: patch.paths,
      ...(patch.offset ? { offset: patch.offset } : {}),
      ...(patch.pattern ? { pattern: patch.pattern } : {}),
      selectionAfter: patch.paths.map((p) => p.id),
    }
    const events = [...s.events]
    events[idx] = amended
    invalidateCheckpointsFrom(amended.seq)
    set({ events, ...(s.savedSeq >= amended.seq ? { savedSeq: -1 } : {}) })
    return true
  },

  amendTabsForPath: (pathId, tabs) => {
    const s = get()
    const commit = (idx: number, amended: TimelineEvent) => {
      const events = [...s.events]
      events[idx] = amended
      invalidateCheckpointsFrom(amended.seq)
      set({ events, ...(s.savedSeq >= amended.seq ? { savedSeq: -1 } : {}) })
    }
    for (let i = s.cursor - 1; i >= 0; i--) {
      const ev = s.events[i]
      // Legacy per-gesture tab chips in the way — amending beneath them would
      // be overridden on replay; bail to normal recording.
      if (ev.kind === 'tabs.moveT' || ev.kind === 'tabs.delete') return false
      if (ev.kind === 'tabs.apply' && ev.pathId === pathId) {
        commit(i, {
          ...ev,
          tabs,
          label: labelFor({ kind: 'tabs.apply', pathId, tabs }),
        })
        return true
      }
      if (ev.kind === 'snapshot' && ev.state.tabs.some((t) => t.pathId === pathId)) {
        commit(i, {
          ...ev,
          state: { ...ev.state, tabs: [...ev.state.tabs.filter((t) => t.pathId !== pathId), ...tabs] },
        })
        return true
      }
    }
    const g = checkpoints.get(0)
    if (g && g.tabs.some((t) => t.pathId === pathId)) {
      checkpoints.set(0, { ...g, tabs: [...g.tabs.filter((t) => t.pathId !== pathId), ...tabs] })
      invalidateCheckpointsFrom(1)
      set({ savedSeq: -1 })
      return true
    }
    return false
  },

  amendTransformSteps: (eventId, steps) => {
    const s = get()
    const idx = s.events.findIndex((ev) => ev.id === eventId)
    if (idx === -1) return false
    const ev = s.events[idx]
    if (ev.kind !== 'paths.edit' || ev.updates.length === 0 || !ev.updates.every((u) => u.transforms?.length)) {
      return false
    }
    // Recompute each path from its state just BEFORE this event (not its
    // current/live state) — the recipe is being edited in place, not
    // stacked, so it must recompose against the same base it always did.
    const beforeSeq = ev.seq - 1
    const cp = nearestCheckpoint(beforeSeq)
    const before = replay(cp.state, s.events.slice(cp.seq), beforeSeq)
    const beforeById = new Map(before.paths.map((p) => [p.id, p]))
    const updates = ev.updates.map((u) => {
      const bp = beforeById.get(u.id)
      if (!bp) return u // path didn't exist yet at this point — leave untouched
      const r = applyTransformSteps(bp, steps)
      return { ...u, d: r.d, shapeParams: r.shapeParams, ...(r.name !== undefined ? { name: r.name } : {}), transforms: steps }
    })
    // The chip's kind/label must track what the steps actually are now —
    // e.g. mirroring a plain Move chip from the editor makes it a Transform
    // chip, same as if that mirror had been dragged in originally.
    const gesture = gestureForSteps(steps)
    const amended: TimelineEvent = { ...ev, updates, gesture, label: labelFor({ ...ev, gesture }) }
    const events = [...s.events]
    events[idx] = amended
    invalidateCheckpointsFrom(ev.seq)
    set({ events, ...(s.savedSeq >= ev.seq ? { savedSeq: -1 } : {}) })
    // This event is currently applied (its effects are part of live state) —
    // re-derive from here so the canvas reflects the edit immediately.
    if (ev.seq <= s.cursor) restoreStateAt(s.cursor, events)
    return true
  },

  undo: () => get().scrubTo(get().cursor - 1, 'undo'),
  redo: () => get().scrubTo(get().cursor + 1, 'undo'),
  canUndo: () => get().cursor > 0,
  canRedo: () => get().cursor < get().events.length,
}))
