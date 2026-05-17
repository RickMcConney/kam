import { regenerateOperation } from './regenerate'
import { useToolpathStore } from '../store/toolpathStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'

export async function optimizeStartPoints(): Promise<void> {
  const { widthMM, heightMM, origin } = useWorkpieceStore.getState()
  const org = originWorldXY(origin, widthMM, heightMM)
  let cx = org.x, cy = org.y

  const operations = useToolpathStore.getState().operations

  for (const op of operations) {
    if (op.status !== 'done') continue

    if (op.type === 'surface' || op.type === 'inlay') {
      const exitSeg = [...op.segments].reverse().find((s) => s.rapid)
      if (exitSeg) { cx = exitSeg.x; cy = exitSeg.y }
      continue
    }

    if (op.type === 'vcarve') {
      useToolpathStore.getState().updateOperation(op.id, { entryHint: { x: cx, y: cy } })
      await regenerateOperation(op.id)
      const updated = useToolpathStore.getState().operations.find((o) => o.id === op.id)
      const exitSeg = updated ? [...updated.segments].reverse().find((s) => s.rapid) : null
      if (exitSeg) { cx = exitSeg.x; cy = exitSeg.y }
      continue
    }

    // profile / pocket / drill: find nearest cut point to estimate exit after rotation
    let nearX = cx, nearY = cy, bestDist = Infinity
    for (const seg of op.segments) {
      if (!seg.rapid) {
        const d = (seg.x - cx) ** 2 + (seg.y - cy) ** 2
        if (d < bestDist) { bestDist = d; nearX = seg.x; nearY = seg.y }
      }
    }

    useToolpathStore.getState().updateOperation(op.id, { entryHint: { x: cx, y: cy } })
    await regenerateOperation(op.id)

    // Read the actual exit from freshly generated segments
    const updated = useToolpathStore.getState().operations.find((o) => o.id === op.id)
    const exitSeg = updated ? [...updated.segments].reverse().find((s) => s.rapid) : null
    if (exitSeg) { cx = exitSeg.x; cy = exitSeg.y }
    else { cx = nearX; cy = nearY }
  }
}
