import { regenerateAll } from '../cam/regenerate'
import { useProjectStore } from '../store/projectStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useToolStore } from '../store/toolStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolpathStore } from '../store/toolpathStore'
import { usePostProcessorStore, type PostProcessorProfile } from '../store/postProcessorStore'
import { useSimStore } from '../store/simStore'
import { useUIStore } from '../store/uiStore'
import { useCanvasStore } from '../store/canvasStore'
import { useTabStore, type Tab } from '../store/tabStore'
import { clearFileHandles } from './fileSystem'
import type { ImportedPath } from '../store/pathsStore'
import type { AnyOperation } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import type { Units, OriginPosition, Material } from '../store/workpieceStore'

interface SavedWorkpiece {
  widthMM: number
  heightMM: number
  thicknessMM: number
  units: Units
  origin: OriginPosition
  material: Material
  tableLimitWidthMM: number
  tableLimitHeightMM: number
  tableLimitDepthMM: number
  machineRigidity?: number
  maxFeedMmMin?: number
  minSpindleRpm?: number
  maxSpindleRpm?: number
  autoFeedEnabled?: boolean
}

interface ProjectData {
  version: number
  name: string
  workpiece: SavedWorkpiece
  tools: Tool[]
  paths: ImportedPath[]
  operations: AnyOperation[]
  postProcessors?: {
    profiles: PostProcessorProfile[]
    activeId: string
  }
  tabs?: Tab[]
}

export function loadProject(data: ProjectData) {
  const wp = data.workpiece ?? {}
  const wps = useWorkpieceStore.getState()
  wps.setWidth(wp.widthMM ?? 300)
  wps.setHeight(wp.heightMM ?? 200)
  wps.setThickness(wp.thicknessMM ?? 18)
  wps.setUnits(wp.units ?? 'mm')
  wps.setOrigin(wp.origin ?? 'bottom-left')
  wps.setMaterial(wp.material ?? 'mdf')
  wps.setTableLimitWidth(wp.tableLimitWidthMM ?? 800)
  wps.setTableLimitHeight(wp.tableLimitHeightMM ?? 600)
  wps.setTableLimitDepth(wp.tableLimitDepthMM ?? 70)
  wps.setMachineRigidity(wp.machineRigidity ?? 3)
  wps.setMaxFeed(wp.maxFeedMmMin ?? 3000)
  wps.setMinSpindleRpm(wp.minSpindleRpm ?? 8000)
  wps.setMaxSpindleRpm(wp.maxSpindleRpm ?? 24000)
  wps.setAutoFeedEnabled(wp.autoFeedEnabled ?? false)

  if (Array.isArray(data.tools) && data.tools.length > 0) {
    useToolStore.getState().setTools(data.tools)
  }
  usePathsStore.getState().replacePaths(data.paths ?? [])
  useToolpathStore.getState().replaceOperations(data.operations ?? [])
  useProjectStore.getState().setName(data.name ?? 'Untitled Project')

  if (data.postProcessors?.profiles?.length) {
    usePostProcessorStore.getState().replaceState(
      data.postProcessors.profiles,
      data.postProcessors.activeId,
    )
  }

  useTabStore.getState().replaceTabs(data.tabs ?? [])

  useProjectStore.getState().markClean()
  // Drop any prior file handle so a later Ctrl+S prompts for this project's own
  // file rather than overwriting whatever was saved before.
  clearFileHandles()
  regenerateAll()
}

export function newProject() {
  useSimStore.getState().clearSim()
  useUIStore.getState().setWorkspaceTab('2d')
  useUIStore.getState().setSidebarTab('draw')
  useUIStore.getState().setShapesPanelOpen(false)
  useUIStore.getState().setMachineFormActive(false)
  useUIStore.getState().setTabsFormActive(false)
  useUIStore.getState().setHelpOpen(false)
  usePathsStore.getState().replacePaths([])
  useToolpathStore.getState().replaceOperations([])
  useTabStore.getState().replaceTabs([])
  useProjectStore.getState().setName('Untitled Project')
  useProjectStore.getState().markClean()
  clearFileHandles()
  useCanvasStore.getState().requestFit()
  // Workpiece settings (size, origin, thickness, material) are persisted in
  // localStorage and intentionally kept across new projects.
}

export function openProjectFile(): Promise<void> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.fkam,.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) { resolve(); return }
      try {
        const text = await file.text()
        const data = JSON.parse(text) as ProjectData
        loadProject(data)
        resolve()
      } catch (err) {
        console.error('Project load failed:', err)
        reject(err)
      }
    }
    input.click()
  })
}
