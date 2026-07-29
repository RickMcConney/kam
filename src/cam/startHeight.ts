// Start-cut height — "which surface does this operation begin from?"
//
// Engraving letters into the floor of a 2 mm pocket has to start at Z = -2, not at the
// stock top. Rather than ask the user for a number (wrong by 2 mm in the wrong direction
// is a full-depth plunge into solid stock), an operation stores a REFERENCE — `StartFrom`
// — and the height is resolved from the operations that precede it, every time it
// generates. Change the pocket's depth later and the engraving follows it.
//
// SAFETY INVARIANT: no operation ever ADDS material, so any op this resolver ignores can
// only make the answer HIGHER than the real surface. Too high costs an air pass; too low
// is a crash. That is what lets the candidate filter below be as crude as it likes —
// preceding ops only, flat floors only, bbox rejection — without ever being unsafe.
//
// Deliberately NOT modelled (each one errs high, i.e. safe): v-carve and 3D surfaces
// (not flat), drilled holes (not a surface the cutter rides on), profile slots (a
// tool-width band, rarely what anything starts from), imported G-code (opaque).
// The stock model in the simulator is the backstop that sees all of those.
import polygonClipping, { type MultiPolygon, type Ring } from 'polygon-clipping'
import { inflatePathsD, JoinType, EndType } from 'clipper2-ts'
import { classifySubpaths } from './geom'
import { flattenPath, splitSelfIntersecting, ensureWinding, type Pt2 } from './pathFlattener'
import type { AnyOperation } from '../store/toolpathStore'
import type { ImportedPath } from '../store/pathsStore'

export type StartFrom =
  | { mode: 'auto' }                      // resolve from preceding operations (default)
  | { mode: 'stock' }                     // stock top, Z = 0
  | { mode: 'op'; opId: string }          // the floor of one named operation
  | { mode: 'manual'; zMM: number }       // an explicit Z the user typed

export interface StartZ {
  /** Absolute CNC Z of the surface the cut starts from — 0 at stock top, negative below. */
  zMM: number
  /** Operation the height came from, when it came from one. */
  sourceOpId?: string
  /** Provenance, for the form: "Stock top", "Floor of Pocket: Rect", "Custom". */
  label: string
}

export const STOCK_TOP: StartZ = { zMM: 0, label: 'Stock top' }

// Slivers this small are float noise from the clipper, not real uncovered ground.
const EPS_AREA_MM2 = 0.01

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function ringOf(pts: Pt2[]): Ring {
  const ring = pts.map(([x, y]) => [x, y] as [number, number])
  if (ring.length > 1) {
    const [x0, y0] = ring[0]
    const [xl, yl] = ring[ring.length - 1]
    if (Math.abs(x0 - xl) < 1e-9 && Math.abs(y0 - yl) < 1e-9) ring.pop()
  }
  return ring
}

// A path's filled area as a MultiPolygon. classifySubpaths resolves which subpaths are
// holes, so a compound path (text, a glyph with counters) contributes its counters as
// holes rather than as extra filled blobs.
function areaOfD(d: string): MultiPolygon {
  const rings = splitSelfIntersecting(flattenPath(d, 0.1))
  return classifySubpaths(rings)
    .map(({ outer, holes }) => [ringOf(outer), ...holes.map(ringOf)].filter(r => r.length >= 3))
    .filter(poly => poly.length > 0)
}

function bboxOf(mp: MultiPolygon): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const poly of mp) for (const ring of poly) for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

function areaOf(mp: MultiPolygon): number {
  let total = 0
  for (const poly of mp) for (const ring of poly) {
    let a = 0
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1])
    }
    total += Math.abs(a) / 2
  }
  return total
}

function rectPoly(minX: number, minY: number, maxX: number, maxY: number): MultiPolygon {
  return [[[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]]]
}

// Grow a filled area outwards by `delta`. Rings go in with the winding Clipper expects
// (outers CCW, holes CW) and come back as a flat ring list, which classifySubpaths
// re-nests into outer/hole polygons — the same containment pass the rest of the CAM uses.
function inflateArea(mp: MultiPolygon, delta: number): MultiPolygon | null {
  if (delta <= 1e-9 || mp.length === 0) return mp
  const input = mp.flatMap((poly) =>
    poly.map((ring, i) => {
      const pts = ring.map(([x, y]) => [x, y] as Pt2)
      const oriented = ensureWinding(pts, i === 0)   // ring 0 is the outer, the rest are holes
      return oriented.map(([x, y]) => ({ x, y }))
    })
  )
  const grown = safeClip(() => {
    const out = inflatePathsD(input, delta, JoinType.Round, EndType.Polygon, 4, 6)
    const rings = out.map((p) => p.map(({ x, y }) => [x, y] as Pt2)).filter((p) => p.length >= 3)
    return classifySubpaths(rings)
      .map(({ outer, holes }) => [ringOf(outer), ...holes.map(ringOf)].filter((r) => r.length >= 3))
      .filter((poly) => poly.length > 0)
  })
  // No fallback to the un-grown area on failure — a smaller footprint is EASIER to cover,
  // which would hand back a deeper start than the geometry justifies. null → stock top.
  return grown
}

// Clipper calls throw on degenerate input; a failure here must fall back to "stock top",
// never to a deeper guess.
function safeClip(fn: () => MultiPolygon): MultiPolygon | null {
  try { return fn() } catch { return null }
}

// ─── Candidate floors ─────────────────────────────────────────────────────────

export interface Floor { z: number; area: MultiPolygon; opId: string; opName: string }

/** Shared across a batch of resolves so a run of ops doesn't re-walk the same floors. */
export type StartZCache = Map<string, Floor | null>
export const makeStartZCache = (): StartZCache => new Map()

interface Ctx {
  ops: AnyOperation[]
  paths: ImportedPath[]
  pathById: Map<string, ImportedPath>
  stock: Stock
  /** Memoised floors for this resolve — floors recurse, and a chain would re-walk otherwise. */
  cache: Map<string, Floor | null>
}

/**
 * The flat floor an operation leaves behind, or null if it doesn't leave one.
 *
 * Depth is measured from wherever THAT operation started, so this recurses: a 2 mm pocket
 * cut in the floor of another 2 mm pocket leaves its floor at −4, not −2. The recursion
 * terminates because an op's own start only ever looks at ops strictly before it.
 *
 * The region is the op's nominal cleared area, NOT its tool-reachable opening — a pocket
 * with a radius bigger than an inside corner leaves stock there that this over-reports.
 * That's the one place the resolver can read low, and it needs the footprint to reach
 * into a corner the previous tool couldn't; the simulator's stock model is what catches it.
 */
function floorOf(op: AnyOperation, ctx: Ctx): Floor | null {
  const cached = ctx.cache.get(op.id)
  if (cached !== undefined) return cached
  ctx.cache.set(op.id, null)   // in-progress marker: a cyclic reference reads as "no floor"
  const floor = computeFloor(op, ctx)
  ctx.cache.set(op.id, floor)
  return floor
}

function computeFloor(op: AnyOperation, ctx: Ctx): Floor | null {
  const common = { opId: op.id, opName: op.name }

  if (op.type === 'pocket' || (op.type === 'inlay' && op.role === 'female' && op.phase === 'endmill')) {
    const boundary = ctx.pathById.get(op.pathId)
    if (!boundary) return null
    const depth = op.type === 'pocket' ? op.depthMM : op.pocketDepthMM
    let area = areaOfD(boundary.d)
    if (area.length === 0) return null
    const islands = op.islandIds.flatMap((id) => { const p = ctx.pathById.get(id); return p ? areaOfD(p.d) : [] })
    if (islands.length > 0) {
      const cut = safeClip(() => polygonClipping.difference(area, ...islands))
      if (!cut) return null
      area = cut
    }
    // Same inputs the op's own generation used (margin 0, its own boundary) — so the
    // floor reported here is the Z its G-code actually reaches.
    const ownStart = resolveStartZ(
      { startFrom: op.startFrom, footprintD: boundary.d, cutMarginMM: 0, opId: op.id },
      ctx.ops, ctx.paths, ctx.stock, ctx.cache,
    ).zMM
    return { ...common, z: ownStart - Math.abs(depth), area }
  }

  // Surfacing always runs from the stock top — it has no start reference of its own.
  if (op.type === 'surface') {
    return { ...common, z: -Math.abs(op.depthMM), area: rectPoly(0, 0, ctx.stock.widthMM, ctx.stock.heightMM) }
  }

  return null
}

// ─── Resolution ───────────────────────────────────────────────────────────────

export interface Stock { widthMM: number; heightMM: number }

/** Preceding ops that leave a flat floor — the pickable entries in the Start dropdown. */
export function listFlatFloorOps(
  ops: AnyOperation[],
  paths: ImportedPath[],
  stock: Stock,
  opId?: string,
): { opId: string; name: string; zMM: number }[] {
  const ctx = makeCtx(ops, paths, stock)
  const endIdx = opId ? ops.findIndex((o) => o.id === opId) : -1
  const preceding = endIdx >= 0 ? ops.slice(0, endIdx) : ops
  return preceding.flatMap((op) => {
    const floor = floorOf(op, ctx)
    return floor && floor.z < 0 ? [{ opId: floor.opId, name: floor.opName, zMM: floor.z }] : []
  })
}

function makeCtx(ops: AnyOperation[], paths: ImportedPath[], stock: Stock, cache?: Map<string, Floor | null>): Ctx {
  return { ops, paths, pathById: new Map(paths.map((p) => [p.id, p])), stock, cache: cache ?? new Map() }
}

export interface ResolveInput {
  startFrom?: StartFrom
  /** Boundary path of the operation being generated. */
  footprintD: string
  /**
   * How far the cut reaches BEYOND that path — 0 for a pocket or a v-carve (both stay
   * inside their outline), the tool diameter for an outside profile, the radius for a
   * centerline one. It grows the footprint polygon, so it must be the real overhang and
   * not just "the tool radius": every mm here is a mm of extra ground that has to be
   * covered before auto will start below stock top.
   */
  cutMarginMM: number
  /** Id of the op being generated; it and everything after it are ignored. Omit for a new op. */
  opId?: string
}

/**
 * Resolve the Z the cut starts from. Never throws: anything it can't work out returns
 * stock top, which is always the safe answer.
 */
export function resolveStartZ(
  input: ResolveInput,
  ops: AnyOperation[],
  paths: ImportedPath[],
  stock: Stock,
  // Threaded through by the recursive floor lookup; callers never pass it.
  cache?: Map<string, Floor | null>,
): StartZ {
  // No reference at all = stock top, NOT auto. Operations saved before start heights
  // existed have no `startFrom`, and a project must emit the same G-code it always did;
  // auto is only ever applied when something explicitly asked for it (the forms write
  // `{ mode: 'auto' }` on every op they create).
  const mode = input.startFrom ?? { mode: 'stock' }
  if (mode.mode === 'stock') return STOCK_TOP
  if (mode.mode === 'manual') {
    return { zMM: Math.min(0, mode.zMM), label: 'Custom' }
  }

  const ctx = makeCtx(ops, paths, stock, cache)
  const endIdx = input.opId ? ops.findIndex((o) => o.id === input.opId) : -1
  const preceding = endIdx >= 0 ? ops.slice(0, endIdx) : ops

  if (mode.mode === 'op') {
    const target = preceding.find((o) => o.id === mode.opId)
    const floor = target ? floorOf(target, ctx) : null
    if (!floor) return STOCK_TOP
    return { zMM: floor.z, sourceOpId: floor.opId, label: `Floor of ${floor.opName}` }
  }

  // ── auto ──
  // Footprint: the path's own filled outline, grown by however far the cut reaches past it.
  // The outline and not its bounding box — a bbox squares off every curve, and the corners
  // it invents stick outside a round pocket even when the real cut is comfortably inside,
  // which silently demoted the answer to stock top.
  const footprint = inflateArea(areaOfD(input.footprintD), Math.max(0, input.cutMarginMM))
  if (!footprint) return STOCK_TOP
  const bb = bboxOf(footprint)
  if (!bb) return STOCK_TOP

  // Candidates: preceding flat-floor ops whose bbox overlaps the footprint. This is the
  // rejection that keeps the whole thing at "free" — the real polygon work below only
  // ever runs on the handful that survive (usually zero or one).
  const candidates: Floor[] = []
  for (const op of preceding) {
    const floor = floorOf(op, ctx)
    if (!floor || floor.z >= 0) continue
    const fb = bboxOf(floor.area)
    if (!fb) continue
    if (fb.maxX < bb.minX || fb.minX > bb.maxX || fb.maxY < bb.minY || fb.minY > bb.maxY) continue
    candidates.push(floor)
  }
  if (candidates.length === 0) {
    return { zMM: 0, label: 'Stock top — nothing cut here yet' }
  }

  // Any part of the footprint over uncut stock and the answer is stock top — the tool
  // would meet full-height material there whatever the rest of it sits over.
  const covered = safeClip(() => polygonClipping.union(candidates[0].area, ...candidates.slice(1).map((c) => c.area)))
  if (!covered) return STOCK_TOP
  const uncovered = safeClip(() => polygonClipping.difference(footprint, covered))
  if (!uncovered) return STOCK_TOP
  if (areaOf(uncovered) > EPS_AREA_MM2) {
    return { zMM: 0, label: `Stock top — ${areaOf(uncovered).toFixed(1)} mm² of this reaches uncut stock` }
  }

  // Residual height at a point is the DEEPEST floor covering it (the last cut wins), and
  // the start height is the highest of those over the footprint. So walk the levels
  // shallowest first and take the first one that still owns ground the footprint touches
  // after the deeper floors have been subtracted from it.
  const levels = [...new Set(candidates.map((c) => c.z))].sort((a, b) => b - a)
  for (const level of levels) {
    const atLevel = candidates.filter((c) => c.z === level)
    const deeper = candidates.filter((c) => c.z < level)
    const union = safeClip(() => polygonClipping.union(atLevel[0].area, ...atLevel.slice(1).map((c) => c.area)))
    if (!union) return STOCK_TOP
    const exclusive = deeper.length === 0
      ? union
      : safeClip(() => polygonClipping.difference(union, ...deeper.map((c) => c.area)))
    if (!exclusive) return STOCK_TOP
    if (exclusive.length === 0) continue
    const hit = safeClip(() => polygonClipping.intersection(exclusive, footprint))
    if (!hit) return STOCK_TOP
    if (areaOf(hit) > EPS_AREA_MM2) {
      const src = atLevel[0]
      return {
        zMM: level,
        sourceOpId: src.opId,
        label: atLevel.length === 1 ? `Floor of ${src.opName}` : `Floor of ${src.opName} +${atLevel.length - 1}`,
      }
    }
  }

  return STOCK_TOP
}

// ─── Per-operation convenience ────────────────────────────────────────────────

/**
 * The resolver inputs for an existing operation, or null when the operation type has no
 * start-height support (drill, surfacing, trochoidal, inlay, 3D, imported G-code — those
 * always run from the stock top).
 *
 * One definition of "what does this op sit on", used by generation, by the stamp that
 * records what generation used, and by the staleness check that compares the two. They
 * cannot drift apart into disagreeing about an op's start height.
 */
export function startInputForOp(
  op: AnyOperation,
  paths: ImportedPath[],
  tools: { id: string; diameterMM: number }[],
): ResolveInput | null {
  if (op.type !== 'pocket' && op.type !== 'vcarve' && op.type !== 'profile') return null
  const path = paths.find((p) => p.id === op.pathId)
  if (!path) return null
  // Pocket and v-carve stay inside their outline; a profile swings the tool outside it.
  let cutMarginMM = 0
  if (op.type === 'profile') {
    const dia = tools.find((t) => t.id === op.toolId)?.diameterMM ?? 0
    cutMarginMM = op.side === 'outside' ? dia : op.side === 'centerline' ? dia / 2 : 0
  }
  return { startFrom: op.startFrom, footprintD: path.d, cutMarginMM, opId: op.id }
}

/** Resolved start Z for an existing operation; 0 for types with no start-height support. */
export function resolveStartZForOp(
  op: AnyOperation,
  ops: AnyOperation[],
  paths: ImportedPath[],
  stock: Stock,
  tools: { id: string; diameterMM: number }[],
  cache?: StartZCache,
): StartZ {
  const input = startInputForOp(op, paths, tools)
  if (!input) return STOCK_TOP
  return resolveStartZ(input, ops, paths, stock, cache)
}
