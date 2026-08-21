import { flattenPath } from '../cam/pathFlattener'
import { parseD, stringifyD, applyMat, type Mat6, type ImportedPath } from '../importers/svgImporter'
import { splitCompoundPath } from './nodeUtils'
import { generateShapeD, translateShapeParams, scaleShapeParams, shapeDisplayName, type ShapeParams } from '../shapes/shapeGenerators'
import type { PathEditGesture } from '../timeline/events'

export interface BBox {
  minX: number; minY: number; maxX: number; maxY: number
  width: number; height: number; cx: number; cy: number
}

export function getBBox(d: string): BBox | null {
  const subpaths = flattenPath(d, 0.5)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const sp of subpaths) {
    for (const [x, y] of sp) {
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }
  }
  if (!isFinite(minX)) return null
  const width = maxX - minX, height = maxY - minY
  return { minX, minY, maxX, maxY, width, height, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
}

export function getMultiBBox(ds: string[]): BBox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const d of ds) {
    const b = getBBox(d)
    if (!b) continue
    if (b.minX < minX) minX = b.minX; if (b.maxX > maxX) maxX = b.maxX
    if (b.minY < minY) minY = b.minY; if (b.maxY > maxY) maxY = b.maxY
  }
  if (!isFinite(minX)) return null
  const width = maxX - minX, height = maxY - minY
  return { minX, minY, maxX, maxY, width, height, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
}

function translateMat(dx: number, dy: number): Mat6 {
  return [1, 0, 0, 1, dx, dy]
}

// CCW rotation in CNC Y-up space
function rotateMat(cx: number, cy: number, angleDeg: number): Mat6 {
  const r = angleDeg * Math.PI / 180
  const cos = Math.cos(r), sin = Math.sin(r)
  return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy]
}

function scaleMat(ax: number, ay: number, sx: number, sy: number): Mat6 {
  return [sx, 0, 0, sy, ax - sx * ax, ay - sy * ay]
}

// kx = horizontal shear (X shift per unit Y), ky = vertical shear (Y shift per unit X), both around (ax, ay)
function skewMat(kx: number, ky: number, ax: number, ay: number): Mat6 {
  return [1, ky, kx, 1, -kx * ay, -ky * ax]
}

// axis 'x' negates X (horizontal flip); axis 'y' negates Y (vertical flip)
function mirrorMat(axis: 'x' | 'y', cx: number, cy: number): Mat6 {
  return scaleMat(cx, cy, axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1)
}

export function translateD(d: string, dx: number, dy: number): string {
  return stringifyD(applyMat(parseD(d), translateMat(dx, dy)))
}

export function scaleAroundD(d: string, ax: number, ay: number, sx: number, sy: number): string {
  return stringifyD(applyMat(parseD(d), scaleMat(ax, ay, sx, sy)))
}

export function rotateAroundD(d: string, cx: number, cy: number, angleDeg: number): string {
  return stringifyD(applyMat(parseD(d), rotateMat(cx, cy, angleDeg)))
}

export function mirrorD(d: string, axis: 'x' | 'y', cx: number, cy: number): string {
  return stringifyD(applyMat(parseD(d), mirrorMat(axis, cx, cy)))
}

export function skewAroundD(d: string, kx: number, ky: number, ax: number, ay: number): string {
  return stringifyD(applyMat(parseD(d), skewMat(kx, ky, ax, ay)))
}

// A geometric transform gesture's inputs, kept separate from its baked
// result. Timeline paths.edit events for move/scale/rotate/skew/mirror store
// these (timeline/events.ts's PathUpdate.transforms) so replay can recompute
// d/shapeParams against whatever the path's CURRENT geometry is at that point
// in the fold — composable on top of upstream edits — instead of stamping
// back a stale absolute d baked at record time against the OLD geometry.
export type TransformStep =
  | { kind: 'translate'; dx: number; dy: number }
  | { kind: 'scale'; sx: number; sy: number; ax: number; ay: number }
  | { kind: 'rotate'; angle: number; cx: number; cy: number }
  | { kind: 'skew'; kx: number; ky: number; ax: number; ay: number }
  | { kind: 'mirror'; axis: 'x' | 'y'; cx: number; cy: number }

// Compose two Mat6es where `m1` is applied first, then `m2` — i.e. the
// single matrix equivalent to point => m2(m1(point)).
function composeMat6(m1: Mat6, m2: Mat6): Mat6 {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a2 * a1 + c2 * b1, b2 * a1 + d2 * b1,
    a2 * c1 + c2 * d1, b2 * c1 + d2 * d1,
    a2 * e1 + c2 * f1 + e2, b2 * e1 + d2 * f1 + f2,
  ]
}

function matForStep(step: TransformStep): Mat6 {
  switch (step.kind) {
    case 'translate': return translateMat(step.dx, step.dy)
    case 'rotate': return rotateMat(step.cx, step.cy, step.angle)
    case 'scale': return scaleMat(step.ax, step.ay, step.sx, step.sy)
    case 'skew': return skewMat(step.kx, step.ky, step.ax, step.ay)
    case 'mirror': return mirrorMat(step.axis, step.cx, step.cy)
  }
}

// A chain of transform steps composes into ONE affine map, which always has
// exactly one canonical decomposition into scale, shear, rotation, optional
// reflection, and a net translation — so a merged chip like
// Move→Rotate→Scale→Move has one true set of net parameters, not four
// independent ones. Standard QR-style (Gram-Schmidt) decomposition of the
// composed matrix's linear part.
//
// Scale/rotate/mirror pivot at the selection's OWN bounding-box center
// (`bbox`) — not the CNC origin — so "rotate in place" actually looks and
// edits like rotating in place; skew pivots at the bbox's bottom edge (its
// horizontal shear has a fixed line, and the object's base is the more
// useful thing to hold still than its center). Whatever position error
// these anchor choices would otherwise introduce is folded into the final
// translate step, so the result is exact regardless of which points are
// chosen — see the two composeMat6 calls below: build the transform WITHOUT
// its translate, then the translate is just "what's left over" between that
// and the true composed translation.
//
// `bbox` is only a FALLBACK pivot, used when `steps` introduces a scale/
// rotate/skew for the first time. When `steps` already contains one (e.g.
// merging a fresh drag into a chip that already has a scale step), that
// step's own ax/ay or cx/cy is reused instead — re-anchoring an EXISTING
// scale/rotate to a fresh bbox (which has already moved by whatever this
// chip's translate so far amounts to) double-counts that movement once
// scaled: e.g. a chip already at scale=2, dx=100 merging a further +1mm
// drag would come out as dx=202, not 101, because the "current" bbox center
// used as the new pivot is itself 100mm downstream of the pivot the
// existing scale was actually anchored to.
export function consolidateSteps(steps: TransformStep[], bbox: BBox): TransformStep[] {
  if (steps.length === 0) return steps
  let m: Mat6 = [1, 0, 0, 1, 0, 0]
  for (const step of steps) m = composeMat6(m, matForStep(step))
  const [a, b, c, d, e, f] = m

  const det = a * d - b * c
  const mirror = det < 0
  // factor out a Y-axis reflection so the rest decomposes as a proper rotation
  const rb = mirror ? -b : b, rd = mirror ? -d : d

  const EPS = 1e-9
  const scaleX = Math.hypot(a, rb)
  if (scaleX < EPS) return steps
  const a1 = a / scaleX, b1 = rb / scaleX
  // Gram-Schmidt: project out the (now-unit) first axis to get the second's
  // perpendicular component — its length is scaleY, the leftover dot product
  // is the shear.
  const shearRaw = a1 * c + b1 * rd
  const c2 = c - shearRaw * a1, d2 = rd - shearRaw * b1
  const scaleY = Math.hypot(c2, d2)
  if (scaleY < EPS) return steps
  let angleDeg = Math.atan2(b1, a1) * 180 / Math.PI
  const kx = shearRaw / scaleY // reproduces shearRaw via Scale(scaleX,scaleY) then Skew(kx, 0), both about the same anchor

  // Any reflection has two equally valid representations 180° apart:
  // Mirror('y') at this angle, or Mirror('x') at angle-180 (since
  // Mirror('x') = Rotate(180)∘Mirror('y')). Always normalizing to 'y' would
  // show a spurious ~180° rotation for a plain axis-'x' mirror with no
  // actual rotation involved — pick whichever axis needs the SMALLER
  // rotation so "just mirrored" reads as just mirrored.
  let mirrorAxis: 'x' | 'y' = 'y'
  if (mirror) {
    const norm180 = (deg: number) => ((deg + 180) % 360 + 360) % 360 - 180
    const altAngle = norm180(angleDeg - 180)
    if (Math.abs(altAngle) < Math.abs(angleDeg)) { mirrorAxis = 'x'; angleDeg = altAngle }
  }

  const existingScale = steps.find((s) => s.kind === 'scale')
  const existingRotate = steps.find((s) => s.kind === 'rotate')
  const existingSkew = steps.find((s) => s.kind === 'skew')
  const scalePivot = existingScale?.kind === 'scale' ? { x: existingScale.ax, y: existingScale.ay }
    : existingRotate?.kind === 'rotate' ? { x: existingRotate.cx, y: existingRotate.cy }
    : { x: bbox.cx, y: bbox.cy }
  const skewPivot = existingSkew?.kind === 'skew' ? { x: existingSkew.ax, y: existingSkew.ay } : { x: bbox.cx, y: bbox.minY }

  const result: TransformStep[] = []
  if (Math.abs(scaleX - 1) > EPS || Math.abs(scaleY - 1) > EPS) {
    result.push({ kind: 'scale', ax: scalePivot.x, ay: scalePivot.y, sx: scaleX, sy: scaleY })
  }
  if (Math.abs(kx) > EPS) result.push({ kind: 'skew', ax: skewPivot.x, ay: skewPivot.y, kx, ky: 0 })
  if (Math.abs(angleDeg) > EPS) result.push({ kind: 'rotate', cx: scalePivot.x, cy: scalePivot.y, angle: angleDeg })
  if (mirror) result.push({ kind: 'mirror', axis: mirrorAxis, cx: scalePivot.x, cy: scalePivot.y })

  // The steps above reproduce the target linear part exactly (pivot choice
  // never affects the linear part — only its translation offset), so the
  // remaining translation is just the difference between what they produce
  // and the true composed translation.
  let partial: Mat6 = [1, 0, 0, 1, 0, 0]
  for (const step of result) partial = composeMat6(partial, matForStep(step))
  result.push({ kind: 'translate', dx: e - partial[4], dy: f - partial[5] })
  return result
}

// What a canonical step list should be labeled as in the timeline — 'move'
// etc. when only one KIND of change is actually non-identity, 'transform'
// once more than one is (e.g. mirroring a chip that already had a move).
// consolidateSteps always includes a translate step even when dx/dy end up
// ~0 (so replay has somewhere to put drift-correction), so that one alone
// needs an explicit magnitude check — scale/skew/rotate/mirror are already
// only present in `steps` when genuinely non-identity.
export function gestureForSteps(steps: TransformStep[]): PathEditGesture {
  const EPS = 1e-6
  const kinds = new Set<PathEditGesture>()
  for (const step of steps) {
    if (step.kind === 'translate') {
      if (Math.abs(step.dx) > EPS || Math.abs(step.dy) > EPS) kinds.add('move')
    } else {
      kinds.add(step.kind)
    }
  }
  if (kinds.size === 1) return [...kinds][0]
  return kinds.size === 0 ? 'move' : 'transform'
}

// Apply one transform step to a path's CURRENT d/shapeParams. Shared by every
// live baking site (CanvasStage drag handlers, PropertiesPanel rotate/mirror)
// so they all compute byte-identical results.
export function applyTransformStep(
  path: Pick<ImportedPath, 'd' | 'shapeParams'>,
  step: TransformStep,
): { d: string; shapeParams: ShapeParams | null | undefined; name?: string } {
  switch (step.kind) {
    case 'translate': {
      const d = translateD(path.d, step.dx, step.dy)
      const shapeParams = path.shapeParams ? translateShapeParams(path.shapeParams, step.dx, step.dy) : undefined
      return { d, shapeParams }
    }
    case 'scale': {
      const newShapeParams = path.shapeParams
        ? scaleShapeParams(path.shapeParams, step.ax, step.ay, step.sx, step.sy)
        : undefined
      // When params are valid, regenerate d from them to preserve exact geometry (arcs stay circular)
      const d = newShapeParams != null
        ? generateShapeD(newShapeParams)
        : scaleAroundD(path.d, step.ax, step.ay, step.sx, step.sy)
      const typeChanged = newShapeParams && path.shapeParams && newShapeParams.type !== path.shapeParams.type
      const name = typeChanged ? shapeDisplayName(newShapeParams!.type) : undefined
      return { d, shapeParams: newShapeParams === null ? null : newShapeParams, name }
    }
    case 'rotate':
      return { d: rotateAroundD(path.d, step.cx, step.cy, step.angle), shapeParams: null }
    case 'skew':
      return { d: skewAroundD(path.d, step.kx, step.ky, step.ax, step.ay), shapeParams: null }
    case 'mirror':
      return { d: mirrorD(path.d, step.axis, step.cx, step.cy), shapeParams: null }
  }
}

// Folds a sequence of steps, threading the intermediate d/shapeParams through
// each one — used when a "Transform" chip merges several gesture kinds.
export function applyTransformSteps(
  path: Pick<ImportedPath, 'd' | 'shapeParams'>,
  steps: TransformStep[],
): { d: string; shapeParams: ShapeParams | null | undefined; name?: string } {
  let cur: Pick<ImportedPath, 'd' | 'shapeParams'> = path
  let name: string | undefined
  for (const step of steps) {
    const r = applyTransformStep(cur, step)
    cur = { d: r.d, shapeParams: r.shapeParams ?? undefined }
    if (r.name !== undefined) name = r.name
  }
  return { d: cur.d, shapeParams: cur.shapeParams, name }
}

// ── Placement ────────────────────────────────────────────────────────────────
// A multi-part shape (a gear and its pinion) regenerates every part from ONE
// shared set of params, so a part that has been dragged somewhere has nowhere
// to record that fact — its own copy of the params used to be translated, the
// group's copies then disagreed, and the next parameter step regenerated the
// whole group from one of them and threw the arrangement away.
//
// ImportedPath.placement is that missing slot: where the part sits relative to
// where its definition nominally puts it. `d` remains the baked result of
// definition-then-placement, so no reader downstream (CAM, canvas, sim) is
// aware of the split — only the writers are.

// Repositioning gestures, which move a part without changing what it IS.
// Scale is deliberately absent: scaling a gear scales its module, so it edits
// the DEFINITION and goes on rewriting shapeParams as it always has.
const PLACEMENT_KINDS: ReadonlySet<TransformStep['kind']> = new Set(['translate', 'rotate', 'mirror', 'skew'])

export function isPlacementOnly(steps: TransformStep[] | undefined): boolean {
  return !!steps && steps.length > 0 && steps.every((s) => PLACEMENT_KINDS.has(s.kind))
}

// The single affine map a placement recipe amounts to.
export function placementMat(steps: TransformStep[] | undefined): Mat6 {
  let m: Mat6 = [1, 0, 0, 1, 0, 0]
  if (steps) for (const step of steps) m = composeMat6(m, matForStep(step))
  return m
}

// Carry freshly generated definition geometry out to where the part actually
// sits. Geometry only — a placement never touches params, which is the whole
// point of keeping the two apart.
export function applyPlacementD(d: string, steps: TransformStep[] | undefined): string {
  if (!steps || steps.length === 0) return d
  return stringifyD(applyMat(parseD(d), placementMat(steps)))
}

// Fold a new repositioning gesture into a part's existing placement, keeping
// it consolidated so a session of dragging stays one canonical recipe rather
// than an ever-growing list (see consolidateSteps).
export function foldPlacement(
  path: Pick<ImportedPath, 'd' | 'placement'>,
  steps: TransformStep[],
): TransformStep[] {
  const chained = [...(path.placement ?? []), ...steps]
  // consolidateSteps only consults the bbox as a FALLBACK pivot, for a
  // scale/rotate/skew appearing in the chain for the first time; every step
  // reaching here already carries its own pivot, so this is belt-and-braces.
  const bbox = getBBox(path.d)
  return bbox ? consolidateSteps(chained, bbox) : chained
}

// Apply a live transform to a single CNC-space point
export function transformPoint(
  x: number, y: number,
  transform: { kind: 'translate'; dx: number; dy: number }
           | { kind: 'scale'; sx: number; sy: number; ax: number; ay: number }
           | { kind: 'rotate'; angle: number; cx: number; cy: number }
           | { kind: 'skew'; kx: number; ky: number; ax: number; ay: number }
): { x: number; y: number } {
  switch (transform.kind) {
    case 'translate':
      return { x: x + transform.dx, y: y + transform.dy }
    case 'scale':
      return { x: transform.ax + transform.sx * (x - transform.ax), y: transform.ay + transform.sy * (y - transform.ay) }
    case 'rotate': {
      const r = transform.angle * Math.PI / 180
      const cos = Math.cos(r), sin = Math.sin(r)
      const dx = x - transform.cx, dy = y - transform.cy
      return { x: transform.cx + cos * dx - sin * dy, y: transform.cy + sin * dx + cos * dy }
    }
    case 'skew':
      return {
        x: x + transform.kx * (y - transform.ay),
        y: transform.ky * (x - transform.ax) + y,
      }
  }
}

/** The placement of an image- or STL-backed path's bounding rectangle. */
export interface RectInfo {
  p0: { x: number; y: number } // first corner (conceptual bottom-left when rotation = 0)
  widthMM: number              // length of the p0→p1 edge
  heightMM: number             // length of the p1→p2 edge
  rotationDeg: number          // angle of the p0→p1 edge, CCW from +X in CNC Y-up
}

// An image-backed path IS a rectangle — importFile writes four corners — and its picture
// is pinned to those corners: bottom edge along p0→p1, top edge one heightMM away on the
// CCW side. Both the canvas (DesignLayer) and the photo V-carve toolpath read the
// placement through this one function, so what is carved is what is drawn, rotation
// included. Returns null for anything that isn't four corners.
export function extractRectInfo(d: string): RectInfo | null {
  const cmds = parseD(d)
  const pts: { x: number; y: number }[] = []
  for (const cmd of cmds) {
    if (cmd.t === 'M' || cmd.t === 'L') {
      pts.push({ x: cmd.x, y: cmd.y })
      if (pts.length === 4) break
    }
  }
  if (pts.length < 4) return null
  const widthMM = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
  const heightMM = Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y)
  if (widthMM < 0.001 || heightMM < 0.001) return null
  const rotationDeg = (Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * 180) / Math.PI
  return { p0: pts[0], widthMM, heightMM, rotationDeg }
}

export interface CircleInfo { cx: number; cy: number; radiusMM: number }

/** One subpath's circle, from its bounding box. Null unless it is round. */
function circleFromD(d: string): CircleInfo | null {
  const bb = getBBox(d)
  if (!bb) return null
  const rx = (bb.maxX - bb.minX) / 2
  const ry = (bb.maxY - bb.minY) / 2
  if (Math.max(rx, ry) < 0.001) return null
  if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.08) {
    return { cx: bb.cx, cy: bb.cy, radiusMM: (rx + ry) / 2 }
  }
  return null
}

/**
 * EVERY circle in a path — one per subpath.
 *
 * A path is not one hole. A gear's pin holes, a bolt circle, an SVG whose circles
 * came in as a single compound path: all of them are N round subpaths under one id,
 * and the drill modes want each. Deriving the circle from the WHOLE path's bounding
 * box instead is not a near miss, it is a hole the size of the whole ring drilled at
 * its centre — which is exactly what a pinion's eight pin holes came out as.
 *
 * `shapeParams` is trusted only when the path really is one subpath: a gear's parts
 * all carry the gear's params, so a params check alone would call the pin-hole ring
 * a circle.
 */
export function extractCircles(path: ImportedPath): CircleInfo[] {
  const subDs = splitCompoundPath(path.d)
  if (subDs.length <= 1) {
    if (path.shapeParams?.type === 'circle') {
      return [{ cx: path.shapeParams.cx, cy: path.shapeParams.cy, radiusMM: path.shapeParams.radius }]
    }
    if (path.shapeParams?.type === 'ellipse') {
      const { cx, cy, rx, ry } = path.shapeParams
      if (Math.abs(rx - ry) / Math.max(rx, ry, 0.001) < 0.05) return [{ cx, cy, radiusMM: (rx + ry) / 2 }]
    }
  }
  return subDs.flatMap((d) => {
    const c = circleFromD(d)
    return c ? [c] : []
  })
}

