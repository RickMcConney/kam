import { generatePeckDrill, generateHelicalDrills, type HoleSpec } from './drill'
import { perfLog } from '../debug'
import { runInWorkerFor, isWorkCancelled } from '../workers/workerClient'
import { useToolpathStore, refsPathId } from '../store/toolpathStore'
import { usePathsStore } from '../store/pathsStore'
import { useToolStore, type Tool } from '../store/toolStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useTabStore } from '../store/tabStore'
import { useSimStore } from '../store/simStore'
import { useUIStore } from '../store/uiStore'
import { getBBox, extractCircles, extractRectInfo } from '../canvas/selectionUtils'
import { loadImageLuminance } from '../io/imageLuminance'
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
        allowanceMM: op.allowanceMM,
        startZMM,
      }, pathTabs.length > 0 ? pathTabs : undefined))

    } else if (op.type === 'pocket') {
      const boundary = paths.find((p) => p.id === op.pathId)
      if (!boundary) throw new Error('Boundary path not found')
      const islandDs = op.islandIds.flatMap((id) => {
        const p = paths.find((x) => x.id === id)
        return p ? [p.d] : []
      })
      const pocket = await runInWorkerFor(opId, 'generatePocket', boundary.d, tool, {
        strategy: op.strategy ?? 'raster',
        depthMM: op.depthMM, stepDownMM: effectiveStepDownMM(tool, op.stepDownMM, op.depthMM),
        stepoverPercent: op.stepoverPercent, direction: op.direction,
        islandDs, angle: op.passAngleDeg, autoAngle: op.autoAngle, startNear: op.entryHint, rampIn: op.rampIn,
        finishAllowanceMM: op.allowanceMM,
        startZMM,
        safeHeightMM,
      })
      setSegments(opId, pocket.segments)
      // No op-name prefix: StatusBar truncates, and a name like
      // 'Pocket: Path 1 (1/8" End Mill)' consumes the whole line before the note starts.
      for (const note of pocket.notes) useUIStore.getState().showStatus(note, 'warn')

    } else if (op.type === 'drill') {
      // Both modes re-read their holes from the source path when they have one, so a
      // hole that moves takes its drilling with it. `extractCircles` returns one per
      // SUBPATH: a pinion's pin ring is eight holes under one id, not one hole the
      // size of the ring.
      const srcPath = op.pathId ? paths.find((p) => p.id === op.pathId) : undefined
      const circles = srcPath ? extractCircles(srcPath) : []
      if (op.drillMode === 'helical') {
        let holes: HoleSpec[] = circles
        if (holes.length === 0) {
          // No source (deleted, or edited into something that is not round): fall back
          // to what the op stored — the list, or the single hole of an older op.
          holes = op.helicalHoles?.length
            ? op.helicalHoles
            : [{ cx: op.helicalCenterX ?? 0, cy: op.helicalCenterY ?? 0, radiusMM: (op.helicalRadius ?? 0) + tool.diameterMM / 2 }]
        } else {
          // Persist what was derived (yes, regenerate writes op params here): the edit
          // view displays it, and it is the fallback above once the source is gone.
          // Singular fields stay in step for the first hole so an older reader still
          // sees something sane.
          updateOperation(opId, {
            helicalHoles: holes,
            helicalCenterX: holes[0].cx, helicalCenterY: holes[0].cy,
            helicalRadius: Math.max(0, holes[0].radiusMM - tool.diameterMM / 2),
          } as Parameters<typeof updateOperation>[1], { record: false })
        }
        setSegments(opId, generateHelicalDrills(holes, tool, {
          depthMM: op.depthMM, stepDownMM: effectiveStepDownMM(tool, op.stepDownMM, op.depthMM),
          startNear: op.entryHint, safeHeightMM, startZMM,
        }))
      } else {
        // Derived, but NOT written back: `points` is the recorded payload of a
        // clicked-points peck op, so it stays out of DERIVED_OP_KEYS and writing it
        // here without recording would make the live op differ from its replay.
        // Nothing else reads it — segments are what cut — so recomputing each time is
        // enough.
        const points = circles.length > 0 ? circles.map((c) => ({ x: c.cx, y: c.cy })) : op.points
        setSegments(opId, generatePeckDrill(points, tool, {
          depthMM: op.depthMM, stepDownMM: effectiveStepDownMM(tool, op.stepDownMM, op.depthMM), startNear: op.entryHint, safeHeightMM, startZMM,
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

    } else if (op.type === 'photovcarve') {
      const imgPath = paths.find((p) => p.id === op.pathId)
      if (!imgPath) throw new Error('Image path not found')
      if (!imgPath.imageSrc) throw new Error('Path is not an image import')
      const rect = extractRectInfo(imgPath.d)
      if (!rect) throw new Error('Image path is no longer a rectangle')
      // Decoded here rather than in the worker: pixel decoding needs a canvas, and the
      // loader caches by data URL so a regenerate sweep decodes each photo once.
      const image = await loadImageLuminance(imgPath.imageSrc)
      setSegments(opId, await runInWorkerFor(opId, 'generatePhotoVCarve', image, rect, tool, {
        angleDeg: op.angleDeg, passAngleDeg: op.passAngleDeg,
        // Depths are relative to the surface the photo is carved into, so a picture in a
        // pocket floor cuts the same greyscale band there that it would on bare stock.
        minDepthMM: op.minDepthMM, maxDepthMM: op.maxDepthMM, zStartMM: startZMM, safeHeightMM,
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
      // islandDs and islandPlugDs are indexed in parallel, so a deleted island drops both.
      const islandEntries = op.islandIds.flatMap((id, i) => {
        const p = paths.find((x) => x.id === id)
        if (!p) return []
        const plugs = (op.islandPlugIds?.[i] ?? []).flatMap((pid) => {
          const q = paths.find((x) => x.id === pid)
          return q ? [q.d] : []
        })
        return [{ d: p.d, plugs }]
      })
      const inlayParams = {
        angleDeg: op.angleDeg, pocketDepthMM: op.pocketDepthMM,
        stepDownMM: effectiveStepDownMM(pocketTool, op.stepDownMM, op.pocketDepthMM), stepoverPercent: op.stepoverPercent,
        glueLineMM: op.glueLineMM, clearanceMM: op.clearanceMM,
        rampIn: op.rampIn, mirrorX: op.mirrorX, mirrorAxisX: op.mirrorAxisX,
        islandDs: islandEntries.map((e) => e.d),
        islandPlugDs: islandEntries.map((e) => e.plugs),
        // Male, inverted grouping: the background outline and the other plugs standing in
        // it. A deleted field simply drops the clearance rather than failing the op.
        fieldD: op.fieldId ? paths.find((p) => p.id === op.fieldId)?.d : undefined,
        fieldPlugDs: (op.fieldPlugIds ?? []).flatMap((id) => {
          const p = paths.find((x) => x.id === id)
          return p ? [p.d] : []
        }),
        safeHeightMM,
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
    const msg = err instanceof Error ? err.message : 'Generation failed'
    setError(opId, msg)
    // Nobody clicked anything, so there is no form banner to carry this: an edit to a
    // path silently broke an operation that was already generated. The status bar is the
    // only place the user will see it.
    useUIStore.getState().showStatus(`${op.name}: ${msg}`, 'error')
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
    useSimStore.getState().invalidateSim()
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
  if (operations.length > 0) useSimStore.getState().invalidateSim()
  for (const op of operations) regenerateOperation(op.id)
}
