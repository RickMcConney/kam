# FreazyKam — Claude Context

Browser-based CNC CAM app. Vite + React 19 + TypeScript. Full plan in `PLAN.md`, PRD in `PRD.md`.

---

## Coordinate Systems — Read This First

Two coordinate spaces exist simultaneously. Confusing them is the most common bug source.

**CNC space (mm, Y-up)**
- All path data (`ImportedPath.d`), bounding boxes, toolpath segments, and workpiece dimensions live here.
- Origin is bottom-left of workpiece by default.
- Positive Y goes **up**.

**Screen space (px, Y-down)**
- Konva stage pixels. Origin is top-left of the Stage element.
- `stage.getPointerPosition()` returns these coordinates.
- **Never use `e.evt.clientX/Y` for CNC math** — those are browser-viewport pixels that include the sidebar/toolbar offset.

**The Y-flip**
Every Konva Layer that renders CNC geometry uses `scaleY={-scale}` (e.g. `<Layer x={vp.x} y={vp.y} scaleX={scale} scaleY={-scale}>`). This flips Y so CNC Y-up renders correctly on screen.

Converting between spaces:
```
CNC → screen:  sx = vp.x + cncX * vp.scale
               sy = vp.y - cncY * vp.scale   // note the minus

screen → CNC:  cncX = (sx - vp.x) / vp.scale
               cncY = (vp.y - sy) / vp.scale  // note vp.y - sy
```
`screenToCNC(sx, sy, vp)` in `CanvasStage.tsx` does this.

**Konva node transforms inside the Y-flipped layer**
- `x` / `y` on a Path node are in CNC mm (layer's local space). Setting `x=10` shifts the path 10 mm right. ✓
- `rotation=θ` inside the Y-flipped layer appears as θ° **CCW** on screen (Y-flip reverses the rotation direction). So CNC CCW = screen CCW. ✓
- `offsetX/offsetY + x/y + scaleX/scaleY` scales around a CNC-space pivot. ✓

---

## Viewport

`Viewport = { x, y, scale }` where:
- `x`, `y` — screen position (stage px) where CNC origin `(0, 0)` lands
- `scale` — pixels per mm

Held in `CanvasStage` local state (`viewport` + `viewportRef` for use inside event callbacks).

---

## Layer Stack (top to bottom in `CanvasStage.tsx`)

```
RulerLayer          — rulers along top and left edges (non-interactive)
SelectionHandleLayer — resize/rotate circles (interactive, listening=true)
ShapePreviewLayer   — live dashed preview while dragging a new shape (non-interactive)
OriginLayer         — crosshair at workpiece origin
ToolpathLayer       — generated toolpath lines
DesignLayer         — imported SVG paths and created shapes
SelectionLayer      — dashed bbox outline + rotation handle line (listening=false)
GridLayer           — grid lines
WorkpieceLayer      — workpiece rectangle
```

Layers lower in JSX render on top in Konva. `listening={false}` on non-interactive layers avoids spurious hit-test costs.

---

## Stores

| Store | Persisted | Owns |
|---|---|---|
| `workpieceStore` | ✓ localStorage | Width/height/thickness/units/origin/material |
| `toolStore` | ✓ localStorage | Tool library |
| `pathsStore` | — | Imported paths + created shapes, multi-selection, undo/redo history |
| `toolpathStore` | — | Profile operations and generated motion segments |
| `uiStore` | — | Sidebar tab, workspace tab, snap toggle, active tool, shape tool config |
| `canvasStore` | — | Cursor position (mm), zoom %, live rotation angle |

**`pathsStore` selection is an array** (`selectedIds: string[]`). Never look for `selectedId` (singular) — that was the Phase 3 API and has been removed. Multi-select uses `selectPath(id, extend?)` where `extend=true` toggles membership.

**`batchUpdatePaths(updates)`** — use this (not repeated `updatePathD`) when baking transforms to multiple paths so history gets one entry, not N. Accepts optional `shapeParams?: ShapeParams | null` per update — `null` clears params, `undefined` (omitted) leaves existing params untouched.

**`updateShapeParams(id, params)`** — regenerates `d` from `ShapeParams` and stores both atomically. Use this when editing shape parameters in the PropertiesPanel.

**`uiStore.activeTool`** — `'select' | ShapeType`. When not `'select'`, canvas clicks/drags create a new shape instead of selecting. Switches back to `'select'` automatically after a shape is placed. Set via `setActiveTool(tool)`.

**`uiStore.shapeToolConfig`** — default geometry for each shape type (used for click-to-place sizing). Updated via `setShapeToolConfig(config)`.

---

## Path Data Format

`ImportedPath.d` is an SVG path string in **CNC mm, Y-up** — all coordinates are absolute, all arc sweeps are adjusted for Y-flip at import time. The string only uses uppercase commands (M, L, C, S, Q, T, A, Z). Functions in `svgImporter.ts` are exported for reuse:

```ts
parseD(d)                   → AbsCmd[]
stringifyD(cmds)            → string
applyMat(cmds, mat6)        → AbsCmd[]  // Mat6 = [a,b,c,d,e,f] where x'=ax+cy+e, y'=bx+dy+f
nextPathColor()             → string    // cycles through the shared color palette
```

Transform helpers in `canvas/selectionUtils.ts`:
```ts
getBBox(d)                           → BBox | null
getMultiBBox(ds[])                   → BBox | null
translateD(d, dx, dy)                → string
scaleAroundD(d, ax, ay, sx, sy)      → string
rotateAroundD(d, cx, cy, angleDeg)   → string  // CCW positive in CNC Y-up
transformPoint(x, y, transform)      → {x, y}
```

`flattenPath(d, tolerance)` in `cam/pathFlattener.ts` converts any path to `[x,y][][]` polylines — used for bbox computation and toolpath generation.

**`ImportedPath.shapeParams?: ShapeParams`** — set when a path was created via a shape tool. Stores the canonical geometric parameters so they can be re-edited. Cleared (set to `null` via `batchUpdatePaths`) on rotate or non-uniform scale; translated/scaled in sync on move/uniform scale. If `shapeParams` is absent, the path is treated as a generic imported path.

---

## Shape System (`src/shapes/shapeGenerators.ts`)

Six shape types: `rectangle | roundrect | circle | ellipse | polygon | star`.

```ts
generateShapeD(params: ShapeParams)                      → string  // CNC Y-up d string
shapeParamsFromDrag(type, start, end, config)            → ShapeParams  // from canvas drag
shapeParamsFromConfig(type, cx, cy, config)              → ShapeParams  // for click-to-place
translateShapeParams(params, dx, dy)                     → ShapeParams
scaleShapeParams(params, ax, ay, sx, sy)                 → ShapeParams | null  // null = can't represent
```

**Arc sweep convention in generated shapes:** Generated paths trace their outline **CCW in CNC Y-up**. Rounded-rect corner arcs use `sweep=1` (so they bulge outward when rendered through the `scaleY={-scale}` layer). Circles/ellipses use `sweep=0` — direction is irrelevant since both halves together form the full shape.

---

## Canvas Interaction (CanvasStage.tsx)

Interaction modes tracked in `modeRef` (a ref, not state, to avoid re-renders in callbacks):

```
idle | pan | move | resize | dragbox | rotate | drawshape
```

`liveTransform: LiveTransform | null` (local state) — applied to selected Path nodes as Konva attributes for live preview during drag. Baked to `d` on mouseup via `batchUpdatePaths`. Cleared on mouseup.

`liveShapeD: string | null` (local state) — the in-progress shape `d` string rendered by `ShapePreviewLayer` while dragging. Cleared on mouseup.

**Critical**: all CNC coordinate calculations in event handlers must use `stage.getPointerPosition()` or `e.target.getStage()?.getPointerPosition()` — **not** `e.evt.clientX/Y`. Pan is the only operation that correctly uses `clientX/Y` (because it only needs deltas, and screen pixel deltas == stage pixel deltas).

`didDragRef` — set to `true` once the pointer moves > 4px. Distinguishes click (selection change only) from drag (transform). Reset on each mousedown.

**Shape drawing flow:** When `activeTool !== 'select'`, mousedown on the stage or on any path node starts `drawshape` mode. Mousemove updates `modeRef.current.currentCNC` (direct ref mutation, no state re-render) and `liveShapeD`. Mouseup commits the shape: drag → `shapeParamsFromDrag`, click (no drag) → `shapeParamsFromConfig` using panel defaults. After placement, `activeTool` resets to `'select'`. Escape cancels mid-draw.

---

## Interaction Event Flow

```
Path mousedown     → handlePathMouseDown  → mode = 'move'  (or 'drawshape' if shape tool active)
Handle mousedown   → handleResizeHandleDown / handleRotateHandleDown → mode = 'resize' | 'rotate'
Stage mousedown    → handleStageMouseDown → mode = 'pan' | 'dragbox' | 'drawshape'
Stage mousemove    → handleMouseMove      → update liveTransform or liveShapeD
Stage mouseup      → handleMouseUp        → bake transform, commit selection, or commit shape
```

Children stop bubbling by setting `e.cancelBubble = true` in their mousedown handlers. When a shape tool is active, `handlePathMouseDown` intercepts path clicks and starts `drawshape` instead of selecting.

---

## CAM Pipeline

```
ImportedPath.d  →  flattenPath()  →  offsetPolygon()  →  MotionSegment[]  →  gcode string
```

`profile.ts` generates the motion segments. `gcode.ts` serializes to Grbl-compatible G-code. All coordinates in motion segments are in **CNC mm**.

---

## Phases Completed

- **Phase 1** — App shell, workpiece panel, localStorage persistence
- **Phase 2** — Konva canvas, zoom/pan, grid, rulers, origin indicator
- **Phase 3** — SVG import, path display, paths panel, undo/redo
- **Phase 4** — Tool library, profile toolpath, Grbl G-code export
- **Phase 5** — Selection tool, bounding box handles, move/scale/rotate, drag-box multi-select, PropertiesPanel, Ctrl+D duplicate
- **Phase 6** — Shape palette (rectangle, rounded rect, circle, ellipse, polygon, star); click-to-place and drag-to-size; ShapePanel with per-type defaults; editable ShapeParams in PropertiesPanel; shapeParams kept in sync through translate/scale, cleared on rotate

## Next Phase

**Phase 7** — Pocket & drill toolpaths.
