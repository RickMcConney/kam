// Path flattening cache + boundary/island containment grouping
// (extracted from MachinePanel — tofix.md R1).
// ─── Helpers ─────────────────────────────────────────────────────────────────
// Keyed by path id, invalidated when the path's d changes. (Keying on the full
// d string never evicted, so the module-level map grew with every transform
// bake for the app's lifetime — tofix.md H2.) Size cap covers deleted paths.
import { pointInPolygon } from '../../cam/geom'
import { flattenPath } from '../../cam/pathFlattener'
import type { ImportedPath } from '../../store/pathsStore'

// ALL subpaths are kept, not just the first: a compound path (text, a glyph with
// counters, a multi-loop import) was previously represented by whichever subpath
// happened to come first, so its bbox and containment tests described one letter
// instead of the whole object.
const flattenCache = new Map<string, { d: string; subs: [number, number][][] }>()
function flattenCached(p: ImportedPath): [number, number][][] {
  const entry = flattenCache.get(p.id)
  if (entry && entry.d === p.d) return entry.subs
  if (flattenCache.size > 500) flattenCache.clear()
  const subs = flattenPath(p.d, 0.1) as [number, number][][]
  flattenCache.set(p.id, { d: p.d, subs })
  return subs
}

// Even-odd containment against a compound path: inside when an odd number of its
// subpaths contain the point, so a point sitting in a glyph's counter reads as
// OUTSIDE the glyph rather than inside it.
function insideCompound(x: number, y: number, subs: [number, number][][]): boolean {
  let crossings = 0
  for (const sub of subs) {
    if (sub.length >= 3 && pointInPolygon(x, y, sub)) crossings++
  }
  return crossings % 2 === 1
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

  // One pre-pass computes polygon, centroid, and bbox per path from the cached
  // flatten — the nested loops below used to call getBBox (a full re-flatten)
  // per pair, making a few-hundred-path selection quadratic in flattens
  // (bugs.md H2). The machine-panel forms call this during render.
  type PathMeta = {
    subs: [number, number][][]
    cx: number; cy: number
    minX: number; minY: number; maxX: number; maxY: number
    bboxArea: number
  }
  const metaById = new Map<string, PathMeta>()
  for (const p of selectedPaths) {
    const subs = flattenCached(p)
    let n = 0, sx = 0, sy = 0
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const sub of subs) {
      for (const [x, y] of sub) {
        n++; sx += x; sy += y
        if (x < minX) minX = x; if (x > maxX) maxX = x
        if (y < minY) minY = y; if (y > maxY) maxY = y
      }
    }
    if (n < 1) continue
    metaById.set(p.id, {
      subs,
      cx: sx / n, cy: sy / n,
      minX, minY, maxX, maxY,
      bboxArea: (maxX - minX) * (maxY - minY),
    })
  }

  // For each path find its smallest (most direct) containing path among the selection
  const parentId = new Map<string, string>()
  for (const inner of selectedPaths) {
    const im = metaById.get(inner.id)
    if (!im) continue
    for (const outer of selectedPaths) {
      if (outer.id === inner.id) continue
      const om = metaById.get(outer.id)
      if (!om || !om.subs.some(s => s.length >= 3)) continue
      if (!insideCompound(im.cx, im.cy, om.subs)) continue
      // Require inner's bbox to fit entirely within outer's bbox.
      // Overlapping (non-nested) shapes each extend beyond the other's bbox, so
      // neither qualifies as a child and no cycle is created.
      if (im.minX < om.minX || im.maxX > om.maxX ||
          im.minY < om.minY || im.maxY > om.maxY) continue
      // Prefer the smallest container (direct parent over grandparent)
      const existing = parentId.get(inner.id)
      const existingMeta = existing ? metaById.get(existing) : undefined
      if (!existingMeta || om.bboxArea < existingMeta.bboxArea) {
        parentId.set(inner.id, outer.id)
      }
    }
  }

  const boundaries = selectedPaths.filter(p => !parentId.has(p.id))
  return boundaries.map(b => ({
    boundary: b,
    islands: selectedPaths.filter(p => parentId.get(p.id) === b.id),
  }))
}
