import { replay } from './applyEvent'
import { nearestCheckpoint, useTimelineStore } from './timelineStore'
import { serializeOp, type SerializedOperation } from './events'
import { usePathsStore, type ImportedPath } from '../store/pathsStore'
import { useToolpathStore } from '../store/toolpathStore'
import { useTabStore } from '../store/tabStore'
import { useWorkpieceStore } from '../store/workpieceStore'

// Dev-only correctness oracle for the timeline (this repo has no test
// framework): replay the event log from genesis and deep-compare the result
// against the live stores. Run window.__fkamReplayCheck() in the console after
// a manual test session — it must report "identical".

// Fields legitimately absent from replayed state:
// - path.visible: eye-icon toggles are view state, not events
// - op.visible: same
// - op.helicalCenterX/Y/helicalRadius: written back by regenerate, not replayed
// - op.entryHint: rewritten by optimizeStartPoints on every sim run / export
function comparablePath(p: ImportedPath) {
  const { visible: _v, ...rest } = p
  return rest
}

function comparableOp(op: SerializedOperation) {
  const { visible: _v, entryHint: _eh, ...rest } = op as SerializedOperation & { visible?: boolean }
  if (rest.type === 'drill') {
    delete rest.helicalCenterX
    delete rest.helicalCenterY
    delete rest.helicalRadius
  }
  return rest
}

function diffKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const out: string[] = []
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k)
  }
  return out
}

export function replayCheck(): boolean {
  const { events, cursor } = useTimelineStore.getState()
  if (cursor !== events.length) {
    console.warn(`[timeline] replayCheck: cursor ${cursor} is not at tip ${events.length} — checking up to cursor`)
  }
  const { state: genesis } = nearestCheckpoint(0)
  const replayed = replay(genesis, events, cursor)

  const live = {
    paths: usePathsStore.getState().paths,
    operations: useToolpathStore.getState().operations.map(serializeOp),
    tabs: useTabStore.getState().tabs,
  }

  const problems: string[] = []

  if (live.paths.length !== replayed.paths.length) {
    problems.push(`paths count: live ${live.paths.length} vs replayed ${replayed.paths.length}`)
  }
  const replayedPaths = new Map(replayed.paths.map((p) => [p.id, p]))
  for (const lp of live.paths) {
    const rp = replayedPaths.get(lp.id)
    if (!rp) { problems.push(`path ${lp.id} (${lp.name}) missing from replay`); continue }
    const d = diffKeys(
      comparablePath(lp) as unknown as Record<string, unknown>,
      comparablePath(rp) as unknown as Record<string, unknown>,
    )
    if (d.length) problems.push(`path ${lp.id} (${lp.name}) differs: ${d.join(', ')}`)
  }
  // Path ORDER matters (z-order / panel order)
  const liveOrder = live.paths.map((p) => p.id).join(' ')
  const repOrder = replayed.paths.map((p) => p.id).join(' ')
  if (liveOrder !== repOrder && live.paths.length === replayed.paths.length) {
    problems.push('path order differs')
  }

  if (live.operations.length !== replayed.operations.length) {
    problems.push(`ops count: live ${live.operations.length} vs replayed ${replayed.operations.length}`)
  }
  const replayedOps = new Map(replayed.operations.map((o) => [o.id, o]))
  for (const lo of live.operations) {
    const ro = replayedOps.get(lo.id)
    if (!ro) { problems.push(`op ${lo.id} (${lo.name}) missing from replay`); continue }
    const d = diffKeys(
      comparableOp(lo) as unknown as Record<string, unknown>,
      comparableOp(ro) as unknown as Record<string, unknown>,
    )
    if (d.length) problems.push(`op ${lo.id} (${lo.name}) differs: ${d.join(', ')}`)
  }
  const liveOpOrder = live.operations.map((o) => o.id).join(' ')
  const repOpOrder = replayed.operations.map((o) => o.id).join(' ')
  if (liveOpOrder !== repOpOrder && live.operations.length === replayed.operations.length) {
    problems.push('op order differs')
  }

  if (JSON.stringify(live.tabs) !== JSON.stringify(replayed.tabs)) {
    problems.push(`tabs differ: live ${live.tabs.length} vs replayed ${replayed.tabs.length}`)
  }

  if (replayed.workpiece) {
    const wps = useWorkpieceStore.getState() as unknown as Record<string, unknown>
    for (const [k, v] of Object.entries(replayed.workpiece)) {
      if (v !== undefined && wps[k] !== v) {
        problems.push(`workpiece.${k}: live ${JSON.stringify(wps[k])} vs replayed ${JSON.stringify(v)}`)
      }
    }
  }

  if (problems.length === 0) {
    console.log(`[timeline] replayCheck: identical ✓ (${events.length} events)`)
    return true
  }
  console.error(`[timeline] replayCheck: ${problems.length} divergence(s) over ${events.length} events`)
  for (const p of problems) console.error('  •', p)
  console.log('[timeline] replayed state:', replayed, 'live state:', live)
  return false
}

declare global {
  interface Window {
    __fkamReplayCheck: () => boolean
    __fkamTimeline: () => { events: unknown[]; cursor: number }
    __fkamScrub: (seq: number) => void
  }
}

window.__fkamReplayCheck = replayCheck
window.__fkamScrub = (seq: number) => useTimelineStore.getState().scrubTo(seq)
window.__fkamTimeline = () => {
  const { events, cursor } = useTimelineStore.getState()
  console.table(events.map((e) => ({ seq: e.seq, kind: e.kind, label: e.label, t: new Date(e.t).toLocaleTimeString() })))
  return { events, cursor }
}
