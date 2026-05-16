import { generateProfile } from './profile'
import { generatePocket } from './raster'
import { generatePeckDrill, generateHelicalDrill } from './drill'
import { generateSurface } from './surfacing'
import { generateVCarve } from './vcarve'
import { generateInlayFemale, generateInlayMale } from './inlay'
import { useToolpathStore } from '../store/toolpathStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolStore } from '../store/toolStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { extractCircle } from '../canvas/selectionUtils'

export function regenerateOperation(opId: string): void {
  const { operations, updateOperation, setSegments, setError } = useToolpathStore.getState()
  const { paths } = usePathsStore.getState()
  const { tools } = useToolStore.getState()

  const op = operations.find((o) => o.id === opId)
  if (!op) return
  const tool = tools.find((t) => t.id === op.toolId)
  if (!tool) return

  updateOperation(opId, { status: 'generating' })
  setTimeout(async () => {
    try {
      if (op.type === 'profile') {
        const path = paths.find((p) => p.id === op.pathId)
        if (!path) throw new Error('Source path not found')
        setSegments(opId, generateProfile(path.d, tool, {
          side: op.side, depthMM: op.depthMM, stepDownMM: op.stepDownMM, direction: op.direction,
        }))
      } else if (op.type === 'pocket') {
        const boundary = paths.find((p) => p.id === op.pathId)
        if (!boundary) throw new Error('Boundary path not found')
        const islandDs = op.islandIds.flatMap((id) => { 
          const p = paths.find((x) => x.id === id)
          return p ? [p.d] : []
        })
        setSegments(opId, generatePocket(boundary.d, tool, {
          depthMM: op.depthMM, stepDownMM: op.stepDownMM,
          stepoverPercent: op.stepoverPercent, direction: op.direction,
          islandDs,angle: 45,
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
            depthMM: op.depthMM, stepDownMM: op.stepDownMM,
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
    }
  }, 0)
}

function affectsOp(op: { type: string; pathId?: string; islandIds?: string[] }, pathId: string): boolean {
  if (op.type === 'profile' || op.type === 'drill') return op.pathId === pathId
  if (op.type === 'pocket' || op.type === 'vcarve' || op.type === 'inlay') {
    return op.pathId === pathId || (op.islandIds?.includes(pathId) ?? false)
  }
  return false
}

export function regenerateAffected(pathId: string): void {
  const { operations } = useToolpathStore.getState()
  for (const op of operations) {
    if (affectsOp(op, pathId)) regenerateOperation(op.id)
  }
}

export function regenerateAll(): void {
  const { operations } = useToolpathStore.getState()
  for (const op of operations) {
    regenerateOperation(op.id)
  }
}
