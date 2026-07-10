import { getBBox } from './selectionUtils'

// Object snapping: while dragging a selection, its bbox edges/centers snap to
// the bbox edges/centers of every other on-canvas path plus the workpiece
// bounds. Targets are collected once at drag start; each mousemove frame then
// only scans a small number array per axis.

export interface SnapTargets { xs: number[]; ys: number[] }

// `paths` must already be filtered to on-canvas paths excluding the dragged ones.
export function collectSnapTargets(
  paths: { d: string }[],
  workpiece: { widthMM: number; heightMM: number },
): SnapTargets {
  const xs: number[] = [0, workpiece.widthMM, workpiece.widthMM / 2]
  const ys: number[] = [0, workpiece.heightMM, workpiece.heightMM / 2]
  for (const p of paths) {
    const b = getBBox(p.d)
    if (!b) continue
    xs.push(b.minX, b.maxX, b.cx)
    ys.push(b.minY, b.maxY, b.cy)
  }
  return { xs, ys }
}

// `edges` are the dragged bbox's candidate values on one axis at the current
// drag delta. Returns the correction to add to that delta plus the matched
// target value (where the alignment guide is drawn), or null when nothing is
// within `tolMM`.
export function snapAxisDelta(
  edges: number[],
  targets: number[],
  tolMM: number,
): { correction: number; guide: number } | null {
  let best: { correction: number; guide: number } | null = null
  let bestDist = tolMM
  for (const e of edges) {
    for (const t of targets) {
      const dist = Math.abs(t - e)
      if (dist < bestDist) {
        bestDist = dist
        best = { correction: t - e, guide: t }
      }
    }
  }
  return best
}
