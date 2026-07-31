// Path flattening cache + boundary/island containment grouping
// (extracted from MachinePanel — tofix.md R1).
// ─── Helpers ─────────────────────────────────────────────────────────────────
// Keyed by path id, invalidated when the path's d changes. (Keying on the full
// d string never evicted, so the module-level map grew with every transform
// bake for the app's lifetime — tofix.md H2.) Size cap covers deleted paths.
import { pointInPolygon, interiorPoint } from '../../cam/geom'
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

// Groups selected paths into {boundary, islands} pairs by the EVEN-ODD rule, the same rule
// SVG and every CAM package use for nested outlines: the region inside the outermost path
// is solid, the region inside the next one in is a hole, the one inside that is solid
// again. So each nesting level alternates, and a boundary's islands are its DIRECT
// children only.
//
// This matters because nesting is what SVG imports look like — a traced drawing arrives as
// concentric outlines, and the user should be able to select the lot and get one sensible
// set of operations rather than picking out every ring by hand.
//
// `invert` machines the other half: the levels that would have been holes become the
// boundaries. Nothing else changes — same tree, same direct-children islands, just started
// one level in.
export function groupPathsByContainment(
  selectedPaths: ImportedPath[],
  opts: { invert?: boolean } = {},
): { boundary: ImportedPath; islands: ImportedPath[] }[] {
  if (selectedPaths.length === 0) return []
  if (selectedPaths.length === 1) return opts.invert ? [] : [{ boundary: selectedPaths[0], islands: [] }]

  // One pre-pass computes polygon, centroid, and bbox per path from the cached
  // flatten — the nested loops below used to call getBBox (a full re-flatten)
  // per pair, making a few-hundred-path selection quadratic in flattens
  // (bugs.md H2). The machine-panel forms call this during render.
  type PathMeta = {
    subs: [number, number][][]
    // The path's stand-in for containment tests — a point inside its material.
    px: number; py: number
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
    // One point per path, not per pair: this runs during render over every PAIR of
    // selected paths, so the stand-in has to be computed once per path. Vertex mean only
    // as a last resort — an open stroke or a degenerate ring has no interior for a scan
    // line to find, and any point is as good as another there.
    const [px, py] = interiorPoint(subs) ?? [sx / n, sy / n]
    metaById.set(p.id, {
      subs,
      px, py,
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
      if (!insideCompound(im.px, im.py, om.subs)) continue
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

  // Nesting depth = how many selected paths enclose this one. The parent map above is
  // already the whole tree; reading only the roots (depth 0) — which is what this did —
  // machined the outermost region, used its direct children as islands, and silently
  // DROPPED everything deeper. Four nested rectangles produced one pocket and two ignored
  // paths (scratch/pocketerror.fkam).
  const depthOf = new Map<string, number>()
  const depth = (id: string): number => {
    const cached = depthOf.get(id)
    if (cached !== undefined) return cached
    const parent = parentId.get(id)
    // Seed before recursing: the parent chain is acyclic by construction (a child's bbox
    // is strictly inside its parent's), but a 0 here bounds any surprise to a wrong answer
    // rather than a hung render.
    depthOf.set(id, 0)
    const d = parent === undefined ? 0 : depth(parent) + 1
    depthOf.set(id, d)
    return d
  }

  const wantParity = opts.invert ? 1 : 0
  return selectedPaths
    .filter(p => depth(p.id) % 2 === wantParity)
    .map(b => ({
      boundary: b,
      islands: selectedPaths.filter(p => parentId.get(p.id) === b.id),
    }))
}
