import { generateProfile } from './profile'
import { generatePocket } from './pocket'
import { generatePeckDrill, generateHelicalDrill } from './drill'
import { generateSurface } from './surfacing'
import { generateVCarve } from './vcarve'
import { generateInlayFemale, generateInlayMale } from './inlay'
import { generateProfile3d } from './profile3d'
import { useToolpathStore } from '../store/toolpathStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolStore } from '../store/toolStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useTabStore } from '../store/tabStore'
import { useSimStore } from '../store/simStore'
import { getBBox, extractCircle } from '../canvas/selectionUtils'
import { parseStlGeometry, base64ToArrayBuffer } from '../importers/stlImporter'

export function regenerateOperation(opId: string): Promise<void> {
  const { operations, updateOperation, setSegments, setError } = useToolpathStore.getState()
  const { paths } = usePathsStore.getState()
  const { tools } = useToolStore.getState()

  const op = operations.find((o) => o.id === opId)
  if (!op) return Promise.resolve()
  const tool = tools.find((t) => t.id === op.toolId)
  if (!tool) return Promise.resolve()

  updateOperation(opId, { status: 'generating' })
  return new Promise((resolve) => {
  setTimeout(async () => {
    try {
      if (op.type === 'profile') {
        const path = paths.find((p) => p.id === op.pathId)
        if (!path) throw new Error('Source path not found')
        const pathTabs = useTabStore.getState().getPathTabs(op.pathId)
        setSegments(opId, generateProfile(path.d, tool, {
          side: op.side, depthMM: op.depthMM, stepDownMM: op.stepDownMM, direction: op.direction,
          startNear: op.entryHint, rampIn: op.rampIn,
        }, pathTabs.length > 0 ? pathTabs : undefined))
      } else if (op.type === 'pocket') {
        const boundary = paths.find((p) => p.id === op.pathId)
        if (!boundary) throw new Error('Boundary path not found')
        const islandDs = op.islandIds.flatMap((id) => {
          const p = paths.find((x) => x.id === id)
          return p ? [p.d] : []
        })
        setSegments(opId, generatePocket(boundary.d, tool, {
          strategy: op.strategy ?? 'raster',
          depthMM: op.depthMM, stepDownMM: op.stepDownMM,
          stepoverPercent: op.stepoverPercent, direction: op.direction,
          islandDs, angle: op.passAngleDeg, startNear: op.entryHint, rampIn: op.rampIn,
        }))
      } else if (op.type === 'drill') {
        if (op.drillMode === 'helical') {
          let cx = op.helicalCenterX ?? 0
          let cy = op.helicalCenterY ?? 0
          let r = op.helicalRadius ?? 0
          if (op.pathId) {
            const path = paths.find((p) => p.id === op.pathId)
            if (path) {
              const circle = extractCircle(path)
              if (circle) {
                cx = circle.cx
                cy = circle.cy
                r = Math.max(0, circle.radiusMM - tool.diameterMM / 2)
                updateOperation(opId, { helicalCenterX: cx, helicalCenterY: cy, helicalRadius: r } as Parameters<typeof updateOperation>[1])
              }
            }
          }
          setSegments(opId, generateHelicalDrill(cx, cy, r, tool, {
            depthMM: op.depthMM, stepDownMM: op.stepDownMM,
          }))
        } else {
          setSegments(opId, generatePeckDrill(op.points, tool, {
            depthMM: op.depthMM, stepDownMM: op.stepDownMM, startNear: op.entryHint,
          }))
        }
      } else if (op.type === 'surface') {
        const { widthMM, heightMM, origin } = useWorkpieceStore.getState()
        setSegments(opId, generateSurface(tool, {
          widthMM, heightMM, origin,
          depthMM: op.depthMM, stepDownMM: op.stepDownMM,
          stepoverPercent: op.stepoverPercent, passAngleDeg: op.passAngleDeg,
        }))
      } else if (op.type === 'vcarve') {
        const path = paths.find((p) => p.id === op.pathId)
        if (!path) throw new Error('Source path not found')
        const islandDs = op.islandIds.flatMap((id) => {
          const p = paths.find((x) => x.id === id)
          return p ? [p.d] : []
        })
        setSegments(opId, await generateVCarve(path.d, tool, {
          angleDeg: op.angleDeg, maxDepthMM: op.maxDepthMM, islandDs,
          startNear: op.entryHint,
        }))
      } else if (op.type === 'profile3d') {
        const stlPath = paths.find((p) => p.id === op.pathId)
        if (!stlPath) throw new Error('STL path not found')
        if (!stlPath.stlSrc || !stlPath.stlModelBounds) throw new Error('Path is not an STL import')
        const buf = base64ToArrayBuffer(stlPath.stlSrc)
        const geo = parseStlGeometry(buf)
        const positions = new Float32Array(geo.attributes.position.array)
        const indices = geo.index ? new Uint32Array(geo.index.array) : null
        geo.dispose()
        const cncBbox = getBBox(stlPath.d)
        if (!cncBbox) throw new Error('Could not compute STL bounding box')
        const roughingTool = op.roughingToolId ? tools.find((t) => t.id === op.roughingToolId) : undefined
        setSegments(opId, generateProfile3d(positions, indices, stlPath.stlModelBounds, cncBbox, tool, {
          stepoverPercent: op.stepoverPercent,
          rasterAngleDeg: op.rasterAngleDeg,
          maxDepthMM: op.maxDepthMM,
          roughingBallRadius: roughingTool?.type === 'ballnose' ? roughingTool.diameterMM / 2 : undefined,
          roughingStepoverPercent: op.roughingStepoverPercent,
          roughingStepDownMM: op.roughingStepDownMM,
          roughingStockAllowanceMM: op.roughingStockAllowanceMM,
          roughingToolId: op.roughingToolId,
          finishingToolId: op.toolId,
        }))
      } else if (op.type === 'inlay') {
        const path = paths.find((p) => p.id === op.pathId)
        if (!path) throw new Error('Source path not found')
        const pocketTool = tools.find((t) => t.id === op.pocketToolId)
        if (!pocketTool) throw new Error('Pocket/profile tool not found')
        const islandDs = op.islandIds.flatMap((id) => {
          const p = paths.find((x) => x.id === id)
          return p ? [p.d] : []
        })
        const inlayParams = {
          angleDeg: op.angleDeg, pocketDepthMM: op.pocketDepthMM,
          stepDownMM: op.stepDownMM, stepoverPercent: op.stepoverPercent,
          glueLineMM: op.glueLineMM, clearanceMM: op.clearanceMM, islandDs,
        }
        if (op.role === 'female') {
          setSegments(opId, await generateInlayFemale(path.d, pocketTool, tool, inlayParams))
        } else {
          setSegments(opId, await generateInlayMale(path.d, pocketTool, tool, inlayParams))
        }
      }
    } catch (err) {
      setError(opId, err instanceof Error ? err.message : 'Generation failed')
    } finally {
      resolve()
    }
  }, 0)
  })
}

function affectsOp(op: { type: string; pathId?: string; islandIds?: string[] }, pathId: string): boolean {
  if (op.type === 'profile' || op.type === 'drill' || op.type === 'profile3d') return op.pathId === pathId
  if (op.type === 'pocket' || op.type === 'vcarve' || op.type === 'inlay') {
    return op.pathId === pathId || (op.islandIds?.includes(pathId) ?? false)
  }
  return false
}

export function regenerateAffected(pathId: string): void {
  const { operations } = useToolpathStore.getState()
  const affected = operations.filter((op) => affectsOp(op, pathId))
  if (affected.length > 0) {
    if (useSimStore.getState().gcode) useSimStore.getState().clearSim()
    for (const op of affected) regenerateOperation(op.id)
  }
}

export function regenerateAll(): void {
  const { operations } = useToolpathStore.getState()
  if (operations.length > 0 && useSimStore.getState().gcode) useSimStore.getState().clearSim()
  for (const op of operations) {
    regenerateOperation(op.id)
  }
}
