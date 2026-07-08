// Path flattening cache + boundary/island containment grouping
// (extracted from MachinePanel — tofix.md R1).
// ─── Helpers ─────────────────────────────────────────────────────────────────
// Keyed by path id, invalidated when the path's d changes. (Keying on the full
// d string never evicted, so the module-level map grew with every transform
// bake for the app's lifetime — tofix.md H2.) Size cap covers deleted paths.
import { pointInPolygon } from '../../cam/geom'
import { flattenPath } from '../../cam/pathFlattener'
import { getBBox } from '../../canvas/selectionUtils'
import type { ImportedPath } from '../../store/pathsStore'

const flattenCache = new Map<string, { d: string; pts: [number, number][] }>()
function flattenCached(p: ImportedPath): [number, number][] {
  const entry = flattenCache.get(p.id)
  if (entry && entry.d === p.d) return entry.pts
  if (flattenCache.size > 500) flattenCache.clear()
  const pts = (flattenPath(p.d, 0.1)[0] ?? []) as [number, number][]
  flattenCache.set(p.id, { d: p.d, pts })
  return pts
}

// ─── Containment grouping ─────────────────────────────────────────────────────

// Groups selected paths into {boundary, islands} pairs.
// A path is an island if its first point lies inside another selected path.
// Paths not contained in any other become independent boundaries.
export function groupPathsByContainment(
  selectedPaths: ImportedPath[]
): { boundary: ImportedPath; islands: ImportedPath[] }[] {
  if (selectedPaths.length === 0) return []
  if (selectedPaths.length === 1) return [{ boundary: selectedPaths[0], islands: [] }]

  function getPoly(p: ImportedPath): [number, number][] {
    return flattenCached(p)
  }

  // For each path find its smallest (most direct) containing path among the selection
  const parentId = new Map<string, string>()
  for (const inner of selectedPaths) {
    const poly = getPoly(inner)
    if (poly.length < 1) continue
    const px = poly.reduce((s, p) => s + p[0], 0) / poly.length
    const py = poly.reduce((s, p) => s + p[1], 0) / poly.length
    for (const outer of selectedPaths) {
      if (outer.id === inner.id) continue
      const outerPoly = getPoly(outer)
      if (outerPoly.length < 3) continue
      if (!pointInPolygon(px, py, outerPoly)) continue
      // Require inner's bbox to fit entirely within outer's bbox.
      // Overlapping (non-nested) shapes each extend beyond the other's bbox, so
      // neither qualifies as a child and no cycle is created.
      const innerBBox = getBBox(inner.d)
      const outerBBox = getBBox(outer.d)
      if (!innerBBox || !outerBBox ||
          innerBBox.minX < outerBBox.minX || innerBBox.maxX > outerBBox.maxX ||
          innerBBox.minY < outerBBox.minY || innerBBox.maxY > outerBBox.maxY) continue
      // Prefer the smallest container (direct parent over grandparent)
      const existing = parentId.get(inner.id)
      if (!existing) {
        parentId.set(inner.id, outer.id)
      } else {
        const bCur = getBBox(selectedPaths.find(p => p.id === existing)!.d)
        const bNew = getBBox(outer.d)
        if (bCur && bNew) {
          const curw = bCur.maxX - bCur.minX;
          const curh = bCur.maxY - bCur.minY;
          const neww = bNew.maxX - bNew.minX;
          const newh = bNew.maxY - bNew.minY;
          if (neww * newh < curw * curh) parentId.set(inner.id, outer.id)
        }
      }
    }
  }

  const boundaries = selectedPaths.filter(p => !parentId.has(p.id))
  return boundaries.map(b => ({
    boundary: b,
    islands: selectedPaths.filter(p => parentId.get(p.id) === b.id),
  }))
}
