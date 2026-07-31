import { generatePeckDrill, generateHelicalDrill } from './drill'
import { perfLog } from '../debug'
import { runInWorkerFor, isWorkCancelled } from '../workers/workerClient'
import { useToolpathStore, refsPathId } from '../store/toolpathStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolStore, type Tool } from '../store/toolStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useTabStore } from '../store/tabStore'
import { useSimStore } from '../store/simStore'
import { getBBox, extractCircle } from '../canvas/selectionUtils'
import { parseStlGeometry, base64ToArrayBuffer } from '../importers/stlImporter'
import { effectiveStepDownMM, trochoidalEngagementFraction } from './feeds'
import { resolveStartZForOp } from './startHeight'

export async function regenerateOperation(opId: string): Promise<void> {
  const { operations, updateOperation, setSegments, setError } = useToolpathStore.getState()
  const { paths } = usePathsStore.getState()
  const { tools } = useToolStore.getState()
  const { safeHeightMM, widthMM: stockW, heightMM: stockH } = useWorkpieceStore.getState()

  const op = operations.find((o) => o.id === opId)
  if (!op) return
  const tool = tools.find((t) => t.id === op.toolId)
  if (!tool) return

  // Re-resolved rather than stored: the whole point of holding a reference is that a
  // regenerate picks up a changed pocket depth (or a reorder) instead of replaying a
  // stale number. startInputForOp derives the footprint and cut margin from the op, so
  // this is the same value setSegments stamps and revalidateStartHeights compares against
  // — those three cannot disagree about what an op starts from.
  const startZMM = resolveStartZForOp(
    op, operations, paths, { widthMM: stockW, heightMM: stockH }, tools,
  ).zMM

  updateOperation(opId, { status: 'generating' })

  const _t0 = performance.now()
  try {
    if (op.type === 'profile') {
      const path = paths.find((p) => p.id === op.pathId)
      if (!path) throw new Error('Source path not found')
      const pathTabs = useTabStore.getState().getPathTabs(op.pathId)
      setSegments(opId, await runInWorkerFor(opId, 'generateProfile', path.d, tool, {
        side: op.side, depthMM: op.depthMM, stepDownMM: effectiveStepDownMM(tool, op.stepDownMM, op.depthMM), direction: op.direction,
        startNear: op.entryHint, rampIn: op.rampIn, safeHeightMM,
        startZMM,
      }, pathTabs.length > 0 ? pathTabs : undefined))

    } else if (op.type === 'pocket') {
      const boundary = paths.find((p) => p.id === op.pathId)
      if (!boundary) throw new Error('Boundary path not found')
      const islandDs = op.islandIds.flatMap((id) => {
        const p = paths.find((x) => x.id === id)
        return p ? [p.d] : []
      })
      setSegments(opId, await runInWorkerFor(opId, 'generatePocket', boundary.d, tool, {
        strategy: op.strategy ?? 'raster',
        depthMM: op.depthMM, stepDownMM: effectiveStepDownMM(tool, op.stepDownMM, op.depthMM),
        stepoverPercent: op.stepoverPercent, direction: op.direction,
        islandDs, angle: op.passAngleDeg, autoAngle: op.autoAngle, startNear: op.entryHint, rampIn: op.rampIn,
        finishAllowanceMM: op.allowanceMM,
        startZMM,
        safeHeightMM,
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
              // Persist the derived center/radius (yes, regenerate writes op
              // params here): DrillForm's edit view displays them, and the ??
              // fallbacks above keep the op regenerable if the source circle
              // is later deleted or edited into a non-circle.
              updateOperation(opId, { helicalCenterX: cx, helicalCenterY: cy, helicalRadius: r } as Parameters<typeof updateOperation>[1], { record: false })
            }
          }
        }
        setSegments(opId, generateHelicalDrill(cx, cy, r, tool, {
          depthMM: op.depthMM, stepDownMM: effectiveStepDownMM(tool, op.stepDownMM, op.depthMM), safeHeightMM,
        }))
      } else {
        setSegments(opId, generatePeckDrill(op.points, tool, {
          depthMM: op.depthMM, stepDownMM: effectiveStepDownMM(tool, op.stepDownMM, op.depthMM), startNear: op.entryHint, safeHeightMM,
        }))
      }

    } else if (op.type === 'surface') {
      const { widthMM, heightMM } = useWorkpieceStore.getState()
      setSegments(opId, await runInWorkerFor(opId, 'generateSurface', tool, {
        widthMM, heightMM,
        depthMM: op.depthMM, stepDownMM: effectiveStepDownMM(tool, op.stepDownMM, op.depthMM),
        stepoverPercent: op.stepoverPercent, passAngleDeg: op.passAngleDeg,
        safeHeightMM,
      }))

    } else if (op.type === 'vcarve') {
      const path = paths.find((p) => p.id === op.pathId)
      if (!path) throw new Error('Source path not found')
      const islandDs = op.islandIds.flatMap((id) => {
        const p = paths.find((x) => x.id === id)
        return p ? [p.d] : []
      })
      // maxDepthMM caps the TOTAL depth from stock top in generateVCarve, so the start
      // offset is added back onto it — same conversion as VCarveForm.
      const zStartMM = -startZMM
      setSegments(opId, await runInWorkerFor(opId, 'generateVCarve', path.d, tool, {
        angleDeg: op.angleDeg, maxDepthMM: op.maxDepthMM + zStartMM, zStartMM, islandDs,
        startNear: op.entryHint, safeHeightMM,
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
      setSegments(opId, await runInWorkerFor(opId, 'generateProfile3d', positions, indices, stlPath.stlModelBounds, cncBbox, tool, {
        stepoverPercent: op.stepoverPercent,
        rasterAngleDeg: op.rasterAngleDeg,
        maxDepthMM: op.maxDepthMM,
        roughingBallRadius: roughingTool?.type === 'ballnose' ? roughingTool.diameterMM / 2 : undefined,
        roughingStepoverPercent: op.roughingStepoverPercent,
        roughingStepDownMM: roughingTool != null && op.roughingStepDownMM != null
          ? effectiveStepDownMM(roughingTool, op.roughingStepDownMM, op.maxDepthMM)
          : op.roughingStepDownMM,
        roughingStockAllowanceMM: op.roughingStockAllowanceMM,
        roughingRasterAngleDeg: op.roughingRasterAngleDeg,
        roughingToolId: op.roughingToolId,
        finishingToolId: op.toolId,
        safeHeightMM,
      }))

    } else if (op.type === 'trochoidal') {
      const path = paths.find((p) => p.id === op.pathId)
      if (!path) throw new Error('Source path not found')
      const trochTabs = useTabStore.getState().getPathTabs(op.pathId)
      setSegments(opId, await runInWorkerFor(opId, 'generateTrochoidal', path.d, tool, {
        side: op.side, depthMM: op.depthMM,
        stepDownMM: effectiveStepDownMM(tool, op.stepDownMM, op.depthMM, trochoidalEngagementFraction(tool, op.trochStepMM)),
        direction: op.direction, trochStepMM: op.trochStepMM, trochRadiusMM: op.trochRadiusMM,
        finishingPass: op.finishingPass, rampIn: op.rampIn, startNear: op.entryHint, safeHeightMM,
      }, trochTabs.length > 0 ? trochTabs : undefined))

    } else if (op.type === 'inlay') {
      const path = paths.find((p) => p.id === op.pathId)
      if (!path) throw new Error('Source path not found')
      // vbitToolId === 'none' (INLAY_NO_FINISH) → female roughing-only, no finish tool.
      const noFinish = op.vbitToolId === 'none'
      const vbitTool: Tool | null = noFinish ? null : (tools.find((t) => t.id === op.vbitToolId) ?? null)
      const pocketTool = tools.find((t) => t.id === op.pocketToolId)
      if (!noFinish && !vbitTool) throw new Error('V-bit tool not found')  // male/finish always needs it
      if (!pocketTool) throw new Error('Pocket/profile tool not found')
      const islandDs = op.islandIds.flatMap((id) => {
        const p = paths.find((x) => x.id === id)
        return p ? [p.d] : []
      })
      const inlayParams = {
        angleDeg: op.angleDeg, pocketDepthMM: op.pocketDepthMM,
        stepDownMM: effectiveStepDownMM(pocketTool, op.stepDownMM, op.pocketDepthMM), stepoverPercent: op.stepoverPercent,
        glueLineMM: op.glueLineMM, clearanceMM: op.clearanceMM,
        rampIn: op.rampIn, mirrorX: op.mirrorX, islandDs, safeHeightMM,
      }
      const result = op.role === 'female'
        ? await runInWorkerFor(opId, 'generateInlayFemale', path.d, pocketTool, vbitTool, inlayParams)
        : await runInWorkerFor(opId, 'generateInlayMale', path.d, pocketTool, vbitTool, inlayParams)
      setSegments(opId, op.phase === 'vbit' ? result.vbitSegs : result.endmillSegs)
      if (op.linkedOpId) {
        const linkedOp = useToolpathStore.getState().operations.find((o) => o.id === op.linkedOpId)
        if (linkedOp?.type === 'inlay') {
          setSegments(op.linkedOpId, op.phase === 'vbit' ? result.endmillSegs : result.vbitSegs)
        }
      }
    }
    // setSegments stamps `generatedWith` for the plain "no entry hint" case; this path
    // passes op.entryHint into every generator, so correct the stamp to match. Without it
    // the next simulate/export would see a mismatch and regenerate all over again.
    updateOperation(opId, { generatedWith: { entryHint: op.entryHint, safeHeightMM } }, { record: false })
    const _segs = useToolpathStore.getState().operations.find((o) => o.id === opId)?.segments.length ?? 0
    const _label = op.type === 'pocket' ? `pocket/${(op as { strategy?: string }).strategy ?? 'raster'}` : op.type
    perfLog(`[perf] toolpath-gen ${_label}: ${(performance.now() - _t0).toFixed(0)}ms → ${_segs} segs`)
  } catch (err) {
    // A cancelled regenerate is not a failure: abortGeneration has already settled the
    // op's status, and the state it was computing against is gone.
    if (isWorkCancelled(err)) return
    setError(opId, err instanceof Error ? err.message : 'Generation failed')
  }
}

// Regenerate every operation referencing ANY of the given paths, each op once.
// Multi-path gestures (move a pocket boundary + its islands, rotate a
// selection) must use this rather than calling regenerateAffected per path —
// an op referencing several of the paths would otherwise regenerate once per
// path, multiplying seconds-long adaptive/morph generations (bugs.md H1).
export function regenerateAffectedMany(pathIds: string[]): void {
  if (pathIds.length === 0) return
  const { operations } = useToolpathStore.getState()
  const affected = operations.filter((op) => pathIds.some((id) => refsPathId(op, id)))
  if (affected.length > 0) {
    if (useSimStore.getState().gcode) useSimStore.getState().clearSim()
    for (const op of affected) regenerateOperation(op.id)
  }
  // Moving or reshaping a path moves the FLOOR of any pocket built on it, and the ops
  // sitting in that pocket don't reference the path at all — they'd never appear in
  // `affected`. Ops already regenerating above are skipped (only 'done' ops can go stale)
  // and re-stamp themselves when they finish.
  useToolpathStore.getState().revalidateStartHeights()
}

export function regenerateAffected(pathId: string): void {
  regenerateAffectedMany([pathId])
}

export function regenerateAll(): void {
  const { operations } = useToolpathStore.getState()
  if (operations.length > 0 && useSimStore.getState().gcode) useSimStore.getState().clearSim()
  for (const op of operations) regenerateOperation(op.id)
}
