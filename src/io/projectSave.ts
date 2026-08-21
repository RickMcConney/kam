import { useProjectStore } from '../store/projectStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useToolStore } from '../store/toolStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolpathStore } from '../store/toolpathStore'
import { usePostProcessorStore } from '../store/postProcessorStore'
import { useTabStore } from '../store/tabStore'
import { useTimelineStore } from '../timeline/timelineStore'
import { sanitizeFileName } from './filename'

// v3: the `timeline` block is GONE. It held an event log so undo history could
// survive save/load, back when undo replayed that log; undo is a snapshot stack
// of live objects now, which no file can hold, so history is session-scoped and
// the block had nothing left to do but bloat the file. What it also carried —
// the parameters generated paths could be re-edited from — moved onto the paths
// themselves, and `io/migrateProvenance.ts` hoists it out of v2 files on load.
const PROJECT_VERSION = 3

export function buildProjectData() {
  const { name } = useProjectStore.getState()
  const {
    widthMM, heightMM, thicknessMM, units, origin, zOrigin, material,
    tableLimitWidthMM, tableLimitHeightMM, tableLimitDepthMM,
    machineRigidity, maxFeedMmMin, minSpindleRpm, maxSpindleRpm, autoFeedEnabled,
    safeHeightMM, spindleType,
  } = useWorkpieceStore.getState()
  const { tools } = useToolStore.getState()
  const { paths } = usePathsStore.getState()
  const { operations: rawOps } = useToolpathStore.getState()
  // Strip computed segments — they're regenerated on load
  const operations = rawOps.map(({ segments: _segs, status: _status, ...op }) => ({
    ...op,
    segments: [] as typeof _segs,
    status: 'needs-update' as const,
  }))
  const { profiles, activeId } = usePostProcessorStore.getState()
  const { tabs } = useTabStore.getState()

  return {
    version: PROJECT_VERSION,
    name,
    workpiece: {
      widthMM, heightMM, thicknessMM, units, origin, zOrigin, material,
      tableLimitWidthMM, tableLimitHeightMM, tableLimitDepthMM,
      machineRigidity, maxFeedMmMin, minSpindleRpm, maxSpindleRpm, autoFeedEnabled,
      safeHeightMM, spindleType,
    },
    tools,
    paths,
    operations,
    postProcessors: { profiles, activeId },
    tabs,
  }
}

// Save the project as a downloadable .fkam file. When `explicitName` is given
// (from the save dialog) it becomes the project's name first, so the toolbar
// header and the embedded project name both reflect it.
export function saveProject(explicitName?: string) {
  if (explicitName !== undefined) useProjectStore.getState().setName(explicitName)
  const data = buildProjectData()
  const safeName = sanitizeFileName(data.name || 'project')
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${safeName}.fkam`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  useProjectStore.getState().markClean()
  useTimelineStore.getState().markSaved()
}
