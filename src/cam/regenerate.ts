import { generateProfile } from './profile'
import { generatePocket } from './pocket'
import { generatePeckDrill, generateHelicalDrill } from './drill'
import { generateSurface } from './surfacing'
import { useToolpathStore } from '../store/toolpathStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolStore } from '../store/toolStore'
import { useWorkpieceStore } from '../store/workpieceStore'

export function regenerateOperation(opId: string): void {
  const { operations, updateOperation, setSegments, setError } = useToolpathStore.getState()
  const { paths } = usePathsStore.getState()
  const { tools } = useToolStore.getState()

  const op = operations.find((o) => o.id === opId)
  if (!op) return
  const tool = tools.find((t) => t.id === op.toolId)
  if (!tool) return

  updateOperation(opId, { status: 'generating' })
  setTimeout(() => {
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
          islandDs,
        }))
      } else if (op.type === 'drill') {
        if (op.drillMode === 'helical' && op.helicalCenterX !== undefined && op.helicalCenterY !== undefined && op.helicalRadius !== undefined) {
          setSegments(opId, generateHelicalDrill(op.helicalCenterX, op.helicalCenterY, op.helicalRadius, tool, {
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
      }
    } catch (err) {
      setError(opId, err instanceof Error ? err.message : 'Generation failed')
    }
  }, 0)
}

function affectsOp(op: { type: string; pathId?: string; islandIds?: string[] }, pathId: string): boolean {
  if (op.type === 'profile' || op.type === 'drill') return op.pathId === pathId
  if (op.type === 'pocket') return op.pathId === pathId || (op.islandIds?.includes(pathId) ?? false)
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
