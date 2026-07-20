import { useProjectStore } from '../store/projectStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useToolStore } from '../store/toolStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolpathStore } from '../store/toolpathStore'
import { usePostProcessorStore } from '../store/postProcessorStore'
import { useTabStore } from '../store/tabStore'
import { useTimelineStore, nearestCheckpoint } from '../timeline/timelineStore'
import { sanitizeFileName } from './filename'

// v2: adds the `timeline` block (event log + cursor + genesis checkpoint) so
// the operation history survives save/load. The materialized paths/operations/
// tabs snapshot is still written — v1-era readers and the loader's fallback
// path (corrupt/newer timeline) use it.
const PROJECT_VERSION = 2

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
  const { events, cursor } = useTimelineStore.getState()

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
    timeline: {
      events,
      cursor,
      genesis: nearestCheckpoint(0).state,
    },
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
