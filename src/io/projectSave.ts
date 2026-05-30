import { useProjectStore } from '../store/projectStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useToolStore } from '../store/toolStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolpathStore } from '../store/toolpathStore'
import { usePostProcessorStore } from '../store/postProcessorStore'
import { useTabStore } from '../store/tabStore'

export const PROJECT_VERSION = 1

export function buildProjectData() {
  const { name } = useProjectStore.getState()
  const {
    widthMM, heightMM, thicknessMM, units, origin, material,
    tableLimitWidthMM, tableLimitHeightMM, tableLimitDepthMM,
    machineRigidity, maxFeedMmMin, minSpindleRpm, maxSpindleRpm, autoFeedEnabled,
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
      widthMM, heightMM, thicknessMM, units, origin, material,
      tableLimitWidthMM, tableLimitHeightMM, tableLimitDepthMM,
      machineRigidity, maxFeedMmMin, minSpindleRpm, maxSpindleRpm, autoFeedEnabled,
    },
    tools,
    paths,
    operations,
    postProcessors: { profiles, activeId },
    tabs,
  }
}

export function saveProject() {
  const data = buildProjectData()
  const safeName = (data.name || 'project').replace(/[^a-zA-Z0-9_-]/g, '_')
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
}
