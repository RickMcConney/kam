import { useToolpathStore } from '../store/toolpathStore'
import { useToolStore } from '../store/toolStore'
import { usePostProcessorStore } from '../store/postProcessorStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { feedsForTool } from './feeds'
import { generateGcode } from './gcode'
import { parseGcode } from '../sim/gcodeParser'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'

export interface PreflightWarning {
  level: 'warn' | 'info'
  text: string
}

export interface PreflightTool {
  name: string
  diameterMM: number
  rpm: number
}

export interface ExportPreflight {
  hasToolpaths: boolean
  units: 'mm' | 'in'
  machine: {
    profileName: string
    outputUnits: 'mm' | 'in'
    origin: string
    safeHeightMM: number
    maxFeedMmMin: number
    minSpindleRpm: number
    maxSpindleRpm: number
    rigidity: number
  }
  job: {
    operationCount: number
    tools: PreflightTool[]
    spindleSpeeds: number[]
    extents: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } | null
    deepestCutMM: number
    estimatedTimeS: number
  }
  warnings: PreflightWarning[]
}

// Gather a summary + safety warnings for the toolpaths about to be exported.
// Mirrors the operation filter used by generateGcode so the report matches the
// file that will actually be written.
export function buildExportPreflight(): ExportPreflight {
  const { operations } = useToolpathStore.getState()
  const { tools } = useToolStore.getState()
  const toolsById = Object.fromEntries(tools.map((t) => [t.id, t]))
  const profile = usePostProcessorStore.getState().getActiveProfile()
  const wp = useWorkpieceStore.getState()
  const {
    widthMM, heightMM, thicknessMM, origin, units,
    maxFeedMmMin, minSpindleRpm, maxSpindleRpm, safeHeightMM, machineRigidity,
    tableLimitWidthMM, tableLimitHeightMM, tableLimitDepthMM,
  } = wp

  const fmt = (mm: number) => (units === 'in' ? `${(mm / 25.4).toFixed(3)}"` : `${mm.toFixed(1)} mm`)

  const doneOps = operations.filter(
    (o) => o.visible && o.status === 'done' && o.segments.length > 0 && o.type !== 'gcode'
  )

  // Distinct tools in order of first use (roughing tool first for 3D profiles).
  const usedToolIds: string[] = []
  const addTool = (id?: string) => {
    if (id && toolsById[id] && !usedToolIds.includes(id)) usedToolIds.push(id)
  }
  for (const op of doneOps) {
    if (op.type === 'profile3d' && op.roughingToolId) addTool(op.roughingToolId)
    addTool(op.toolId)
  }
  const toolList: PreflightTool[] = usedToolIds.map((id) => {
    const t = toolsById[id]
    return { name: t.name, diameterMM: t.diameterMM, rpm: feedsForTool(t).rpm }
  })
  const spindleSpeeds = [...new Set(toolList.map((t) => t.rpm))].sort((a, b) => a - b)
  const tooFastTools = usedToolIds.filter((id) => feedsForTool(toolsById[id]).spindleTooFast)

  // Extents in machine coordinates (relative to the work origin, matching the
  // exported G-code). Span is origin-independent so it's used for table checks.
  const org = originWorldXY(origin, widthMM, heightMM)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
  // Raw workpiece-coord extents (stock is [0,W] × [0,H]) for the out-of-stock check.
  let wpMinX = Infinity, wpMaxX = -Infinity, wpMinY = Infinity, wpMaxY = -Infinity
  for (const op of doneOps) {
    for (const s of op.segments) {
      const mx = s.x - org.x, my = s.y - org.y
      if (mx < minX) minX = mx
      if (mx > maxX) maxX = mx
      if (my < minY) minY = my
      if (my > maxY) maxY = my
      if (s.z < minZ) minZ = s.z
      if (s.z > maxZ) maxZ = s.z
      if (s.x < wpMinX) wpMinX = s.x
      if (s.x > wpMaxX) wpMaxX = s.x
      if (s.y < wpMinY) wpMinY = s.y
      if (s.y > wpMaxY) wpMaxY = s.y
    }
  }
  const hasExtents = doneOps.length > 0 && Number.isFinite(minX)
  const extents = hasExtents ? { minX, maxX, minY, maxY, minZ, maxZ } : null
  const deepestCutMM = hasExtents ? Math.max(0, -minZ) : 0
  const spanX = hasExtents ? maxX - minX : 0
  const spanY = hasExtents ? maxY - minY : 0

  // Run-time estimate: generate the G-code and run it through the same parser the
  // simulator uses (programmed feeds + a fixed rapid rate). It ignores accel/decel,
  // so it's a floor — real cuts on a hobby machine run a bit longer.
  const estimatedTimeS = doneOps.length > 0
    ? parseGcode(generateGcode(operations, toolsById, 'estimate', profile)).totalTimeS
    : 0

  const warnings: PreflightWarning[] = []

  // Toolpath crosses the stock edge — the bit will cut into the spoilboard or air.
  const tol = 0.01
  if (hasExtents && (wpMinX < -tol || wpMinY < -tol || wpMaxX > widthMM + tol || wpMaxY > heightMM + tol)) {
    warnings.push({
      level: 'warn',
      text: `Toolpath extends outside the workpiece bounds (${fmt(widthMM)} × ${fmt(heightMM)} stock). ` +
        `The tool will cut beyond the stock — reposition the geometry or enlarge the workpiece.`,
    })
  }

  if (spindleSpeeds.length > 1) {
    warnings.push({
      level: 'info',
      text: `This job uses ${spindleSpeeds.length} different spindle speeds (${spindleSpeeds.join(', ')} RPM). ` +
        `If your machine can't set spindle speed from G-code, set it by hand at each change.`,
    })
  }

  if (toolList.length > 1) {
    warnings.push({
      level: 'info',
      text: `This job uses ${toolList.length} tools — ${toolList.length - 1} tool change(s) required. ` +
        `Swap the tool and re-zero Z when the program pauses.`,
    })
  }

  if (tableLimitWidthMM > 0 && spanX > tableLimitWidthMM) {
    warnings.push({ level: 'warn', text: `Toolpath X span ${fmt(spanX)} exceeds the table travel of ${fmt(tableLimitWidthMM)}.` })
  }
  if (tableLimitHeightMM > 0 && spanY > tableLimitHeightMM) {
    warnings.push({ level: 'warn', text: `Toolpath Y span ${fmt(spanY)} exceeds the table travel of ${fmt(tableLimitHeightMM)}.` })
  }
  if (tableLimitDepthMM > 0 && deepestCutMM > tableLimitDepthMM) {
    warnings.push({ level: 'warn', text: `Deepest cut ${fmt(deepestCutMM)} exceeds the max Z travel of ${fmt(tableLimitDepthMM)}.` })
  }

  if (deepestCutMM > thicknessMM + 1e-3) {
    warnings.push({
      level: 'info',
      text: `Deepest cut ${fmt(deepestCutMM)} goes through the ${fmt(thicknessMM)} stock — use a spoilboard or tabs to hold the part.`,
    })
  }

  if (tooFastTools.length > 0) {
    warnings.push({
      level: 'warn',
      text: `The spindle can't run slow enough for the material's safe surface speed on ${tooFastTools.length} tool(s) — ` +
        `risk of overheating/built-up edge. Use a smaller bit or a slower spindle.`,
    })
  }

  if (profile.unitMode !== units) {
    warnings.push({
      level: 'info',
      text: `Display units (${units}) differ from the post-processor output units (${profile.unitMode}). The file will be in ${profile.unitMode}.`,
    })
  }

  return {
    hasToolpaths: doneOps.length > 0,
    units,
    machine: {
      profileName: profile.name,
      outputUnits: profile.unitMode,
      origin,
      safeHeightMM,
      maxFeedMmMin,
      minSpindleRpm,
      maxSpindleRpm,
      rigidity: machineRigidity,
    },
    job: {
      operationCount: doneOps.length,
      tools: toolList,
      spindleSpeeds,
      extents,
      deepestCutMM,
      estimatedTimeS,
    },
    warnings,
  }
}
