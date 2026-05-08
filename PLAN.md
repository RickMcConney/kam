# FreazyKam Implementation Plan

## Context

FreazyKam is a browser-based CNC CAM application (PRD.md in `/Users/rick/kam`). It is a greenfield project with no existing code. The user wants to run the app as early as possible and give feedback at each phase before adding more functionality. The plan is organized as sequential milestones — each one leaves the app in a fully runnable, demonstrable state.

---

## Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Bundler | Vite | Sub-second HMR, ESM-native |
| UI framework | React + TypeScript | Ecosystem maturity, react-konva bindings |
| 2D canvas | Konva.js + react-konva | Scene graph, selection handles, layers, events |
| 3D view | Three.js | Industry standard for WebGL, STL loaders included |
| Boolean ops / offset | js-angusj-clipper (WASM) | Powers profile, pocket, offset, boolean tools |
| SVG parsing | Browser DOMParser + custom path-to-point converter | No extra dep for SVG; Konva renders SVG natively |
| DXF import | dxf-parser (npm) | Mature, widely used |
| STL import | Three.js STLLoader | Already in dep tree |
| Text to paths | opentype.js | Converts TrueType glyphs to CNC-ready bezier paths |
| Persistence | localStorage + IndexedDB (for large blobs) | Local-only, no backend |
| Styling | Tailwind CSS | Utility-first, good for dense UI panels |

---

## Phased Milestones

Each phase produces a runnable app. Ship phase, get feedback, continue.

---

### Phase 1 — App Shell (Day 1, immediately runnable)

**Goal:** The app loads. You can see the layout and set up a workpiece.

**Deliverables:**
- `npm create vite@latest freazykam -- --template react-ts`
- Tailwind CSS configured
- App layout: top toolbar, left sidebar (fixed width, resizable later), main canvas area, status bar
- Sidebar has three tab placeholders: **Draw**, **Machine**, **Paths**
- Top toolbar buttons (non-functional icons): New, Open, Save, Import, Export G-code, Undo, Redo, Snap, Options, Help
- **Workpiece panel** in sidebar Draw tab:
  - Width, height, thickness inputs
  - Units toggle (mm / inches)
  - Origin selector (9-point grid: corners, edges, center)
  - Material dropdown (hardcoded list: Pine, Oak, MDF, Plywood, Aluminum, Other)
- Workpiece settings persisted to `localStorage`
- Status bar showing app version and current mode
- Project name shown in toolbar ("Untitled Project")

**Acceptance check:** App loads, workpiece panel works, settings survive page refresh.

**Critical files to create:**
- `src/main.tsx` — entry point
- `src/App.tsx` — root layout
- `src/components/Toolbar.tsx`
- `src/components/Sidebar.tsx`
- `src/components/StatusBar.tsx`
- `src/panels/WorkpiecePanel.tsx`
- `src/store/workpieceStore.ts` — Zustand or React context
- `src/store/persistenceStore.ts` — localStorage helpers

---

### Phase 2 — 2D Canvas + Workpiece View (Day 1-2)

**Goal:** A pannable, zoomable 2D canvas shows the workpiece boundary and grid.

**Deliverables:**
- Konva.js Stage mounted in main area, fills available space
- Workpiece rectangle rendered at correct real-world coordinates
- Grid lines rendered at configurable spacing (default 10mm / 0.5in)
- Mouse wheel zoom centered on cursor
- Middle-mouse-drag pan (and space+drag)
- Origin indicator (crosshair) at configured workpiece origin point
- Toolbar snap toggle (S key) enables/disables grid snap indicator
- View controls: zoom-to-fit button

**Acceptance check:** Workpiece visible, grid shows, zoom/pan smooth, origin visible.

**Critical files:**
- `src/canvas/CanvasStage.tsx` — Konva Stage wrapper
- `src/canvas/layers/WorkpieceLayer.tsx` — workpiece rect + origin
- `src/canvas/layers/GridLayer.tsx` — grid lines
- `src/hooks/useCanvasViewport.ts` — zoom/pan state

---

### Phase 3 — SVG Import & Path Display (Day 2-3)

**Goal:** Import an SVG and see its paths on the canvas. First real content.

**Deliverables:**
- File input (drag-drop + button) accepts `.svg`
- SVG parser: `DOMParser` → extract `<path>`, `<rect>`, `<circle>`, `<ellipse>`, `<line>`, `<polyline>`, `<polygon>` → convert to flat array of point arrays (absolute coordinates)
- Paths rendered on canvas as Konva `Line` / `Path` nodes
- Scale: SVG real-world dimensions mapped to workpiece units; prompt user for PPI if not inferrable
- **Paths sidebar tab** shows imported path list with:
  - Path name (from SVG `id` or generated)
  - Eye icon to toggle visibility
  - Trash icon to delete
- Click a path on canvas or in tree to select it (highlighted border)
- `Delete`/`Backspace` key deletes selected path
- Undo/redo for import and delete (simple history stack)

**Acceptance check:** Import a real SVG, paths appear at correct scale, tree shows them, toggle/delete works.

**Critical files:**
- `src/importers/svgImporter.ts`
- `src/canvas/layers/DesignLayer.tsx`
- `src/panels/PathsPanel.tsx`
- `src/store/pathsStore.ts`
- `src/hooks/useHistory.ts`

---

### Phase 4 — Tool Library + Profile Toolpath + G-code Export (Day 3-5)

**Goal:** The first end-to-end CNC workflow: import SVG → select path → generate profile toolpath → export G-code.

**Deliverables:**
- **Tool Library** (main workspace third tab):
  - Default tools: 1/4" End Mill, 1/8" End Mill, 60° V-bit, 1/4" Ball Nose, 3mm Drill
  - Fields per tool: name, type, diameter, flute count, RPM, XY feed, Z feed, step down, depth, cutting direction
  - Add / delete tools (min 1 required)
  - Tools persisted to `localStorage`
- **Machine sidebar tab** — "Add Operation" button → Profile operation form:
  - Select tool (dropdown from library)
  - Cut side: Inside / Outside / Centerline
  - Total depth, step down
  - Number of passes
  - Direction: Climb / Conventional
  - "Generate" button
- **Profile toolpath generation** (`src/cam/profile.ts`):
  - Use js-angusj-clipper to offset selected path by `tool.diameter/2` (inside or outside)
  - Produce pass array: Z levels from 0 to depth in step-down increments
  - Output: array of `{x, y, z, rapid: boolean}` motion segments
- Toolpath rendered on canvas (dashed line, different color from design)
- **Paths panel** shows toolpath under "Toolpaths" section grouped by tool
- **Basic post-processor** (hardcoded Grbl profile initially):
  - Start G-code: `G21; G90; G17`
  - Motion: `G0` rapid, `G1 Fxxx` cut
  - Spindle: `M3 Sxxx` / `M5`
  - Safe height retract between passes
- Export G-code button triggers browser download of `.gcode` file
- G-code contains header comment with project name

**Acceptance check:** Full workflow — SVG in → profile → `.gcode` downloaded → open in text editor and verify it looks correct.

**Critical files:**
- `src/cam/profile.ts`
- `src/cam/gcode.ts`
- `src/panels/MachinePanel.tsx`
- `src/panels/ToolLibraryPanel.tsx`
- `src/store/toolStore.ts`
- `src/store/toolpathStore.ts`
- `src/postprocessors/grbl.ts`

---

### Phase 5 — Selection Tool + Basic Transform (Day 5-6)

**Goal:** Select, move, scale, rotate geometry on the canvas.

**Deliverables:**
- Selection tool (default tool): click selects a path, drag-box selects multiple
- Selected paths show bounding-box with corner/edge handles
- Drag selected geometry to move it
- Scale handles (corner drag = uniform with Shift, non-uniform default)
- Rotate handle (top center)
- Transform values shown in properties panel (x, y, width, height, angle)
- Constrain drag to H or V axis with Shift key
- Moving/scaling a path marks dependent toolpaths as "needs update" (yellow warning icon in tree)
- Ctrl/Cmd+D duplicates selected paths

**Acceptance check:** Can move and scale imported SVG paths; toolpath update warning appears.

**Critical files:**
- `src/canvas/tools/SelectionTool.tsx`
- `src/panels/PropertiesPanel.tsx`
- `src/canvas/layers/SelectionLayer.tsx`

---

### Phase 6 — Basic Shape Creation (Day 6-7)

**Goal:** Draw rectangles, circles, and polygons directly in the app.

**Deliverables:**
- Draw sidebar tab includes shape palette: Rectangle, Rounded Rectangle, Circle, Ellipse, Polygon, Star
- Selecting a shape shows its parameter panel (width, height, corner radius, sides, etc.)
- Place on canvas by clicking (placed at center of current view) or drag-to-size
- Shape retains its creation parameters for re-editing
- Units respect workpiece unit setting
- Created shapes appear in Paths panel tree

**Acceptance check:** Create a rectangle, resize it in the properties panel, verify it updates on canvas.

**Critical files:**
- `src/canvas/tools/ShapeTool.tsx`
- `src/shapes/` — shape generators (rect, circle, polygon, etc.)
- `src/panels/draw/ShapePanel.tsx`

---

### Phase 7 — Pocket & Drill Toolpaths (Day 7-9)

**Goal:** Two more core CAM operations: pocket clearing and drilling.

**Deliverables:**
- **Pocket operation** (`src/cam/pocket.ts`):
  - Raster (zigzag) clearing strategy initially (adaptive deferred to later)
  - Uses Clipper offset to shrink boundary by stepover until no area remains
  - Supports depth, step-down, stepover %
  - Climb/conventional direction
  - Island support (paths inside the selected boundary are treated as obstacles)
- **Drill operation** (`src/cam/drill.ts`):
  - Click to place drill points in a drill tool mode
  - Snap to existing nearby design points
  - Detect circular selected geometry → offer helical drilling if using end mill
  - Peck drilling depth/step-down settings
  - Warning when drill bit used for helical drilling
- Both appear in Machine panel operations list and Paths tree
- Both included in G-code export

**Acceptance check:** Pocket a rectangle, drill a circle, export G-code with both operations.

**Critical files:**
- `src/cam/pocket.ts`
- `src/cam/drill.ts`
- `src/canvas/tools/DrillTool.tsx`

---

### Phase 8 — Project Save/Load + Post-Processor Profiles (Day 9-10)

**Goal:** Save and reload work; configure G-code output per machine.

**Deliverables:**
- Project save: JSON file download containing paths, toolpaths, workpiece settings, tool library, options, active post-processor
- Project load: File input restores all state
- Project name editable in toolbar
- **Post-processor profiles panel** (in Options or Tool Library tab):
  - Fields: start G-code, end G-code, tool-change G-code, spindle on/off templates, rapid template, cut template, arc templates (G2/G3), comment style, unit mode (mm/in), arc output toggle
  - Placeholder substitution: `{x}` `{y}` `{z}` `{f}` `{s}`
  - Default "Grbl (mm)" and "Grbl (inches)" profiles pre-loaded
  - Add / duplicate / delete profiles (min 1)
  - Profiles persisted to `localStorage` and included in project saves
- Ctrl/Cmd+S saves project, Ctrl/Cmd+O opens project

**Acceptance check:** Save project, reload page, open project — everything restored exactly.

**Critical files:**
- `src/io/projectSave.ts`
- `src/io/projectLoad.ts`
- `src/panels/PostProcessorPanel.tsx`
- `src/store/postProcessorStore.ts`

---

### Phase 9 — Surfacing Toolpath + 2D Toolpath Visualization Polish (Day 10-11)

**Goal:** Surface the workpiece; improve toolpath display quality.

**Deliverables:**
- **Surfacing operation** (`src/cam/surfacing.ts`):
  - Covers full workpiece XY area
  - Depth, stepover %, pass angle settings
  - Requires end mill
  - Updates when workpiece dimensions or origin change
- 2D canvas toolpath display improvements:
  - Rapid moves shown as dashed gray lines
  - Cutting moves shown in operation color
  - Tool start/end markers
  - Hover tooltip showing operation name and depth
- Toolpath visibility toggles work per-operation
- Toolpath order in tree defines G-code export order (drag-to-reorder deferred or simple up/down arrows)

**Acceptance check:** Generate surface pass, verify raster pattern on canvas, export G-code.

---

### Phase 10 — 2D G-code Simulation (Day 11-13)

**Goal:** Simulate the generated G-code in the 2D view with play/pause controls.

**Deliverables:**
- G-code parser (`src/sim/gcodeParser.ts`): parses G0/G1/G2/G3, M3/M5, F, S, Z — outputs motion segment array
- Simulation player:
  - Play / Pause / Stop buttons (shown in status bar or floating above canvas)
  - Playback speed: 1x, 5x, 20x, 100x
  - Progress slider (seek)
  - Current G-code line number, feed rate, elapsed time, total estimated time, current Z
- Animation: tool position dot travels along segments at scaled speed
- G-code line highlight in viewer (expandable panel at bottom)
- V-bit cut width widens with depth in 2D visualization
- Works for both generated G-code and imported G-code files (`.gcode`, `.nc`, `.ngc`, `.tap`)

**Acceptance check:** Run simulation, pause, seek to middle, verify line highlight and tool position sync.

**Critical files:**
- `src/sim/gcodeParser.ts`
- `src/sim/SimulationPlayer.tsx`
- `src/panels/GcodeViewer.tsx`
- `src/canvas/layers/SimulationLayer.tsx`

---

### Phase 11 — Text + Pen Drawing + Point Editing (Day 13-16)

**Goal:** Create CNC geometry directly in the app without needing an external SVG tool.

**Deliverables:**
- **Text tool** (`src/canvas/tools/TextTool.tsx`):
  - opentype.js converts TrueType → bezier path array
  - Font selector (bundle 3-4 fonts: a sans, a serif, a script)
  - Font size, content editable in panel
  - Text retains text/font/size for later re-editing
- **Pen tool** (`src/canvas/tools/PenTool.tsx`):
  - Click to add straight-line points
  - Click near first point to close path
  - Drag point during placement for curve control handles (Bezier)
  - Press Escape to finish open path
- **Point edit tool** (`src/canvas/tools/PointEditTool.tsx`):
  - Show all points on selected path
  - Drag points to new positions
  - Click segment to insert new point
  - Hover over point + Delete key to remove point
  - First-point marker, re-assign first point
  - Close open path by joining endpoints
- Dependent toolpaths marked for update after point edits

**Acceptance check:** Type text, convert to paths, see it on canvas, use pen to draw a shape, edit its points.

---

### Phase 12 — Boolean Ops, Offset, Patterns, Tabs (Day 16-19)

**Goal:** Complete vector editing toolkit.

**Deliverables:**
- **Boolean tools** (Clipper.js): Union, Intersection, Subtract on selected paths
  - Original paths hidden (not deleted) when boolean result is produced
- **Offset tool**: inset/outset by distance, corner style (round/miter/square)
- **Pattern tools**:
  - Linear grid: rows, columns, X spacing, Y spacing
  - Circular array: count, radius, start/end angle, per-item rotation
  - Generated pattern retains source + parameters for re-edit
- **Tab editor**:
  - Apply tabs to a selected path
  - Configure tab count, length, height
  - Tabs shown as markers on path in canvas
  - Drag individual tabs along path boundary
  - Delete individual tab or all tabs
  - Profile toolpath G-code raises Z at tab positions

**Acceptance check:** Boolean union two shapes, apply tabs to a profile cut, export G-code — verify tab gaps in G-code.

**Critical files:**
- `src/tools/booleanOps.ts`
- `src/tools/offsetOp.ts`
- `src/tools/patternOp.ts`
- `src/canvas/tools/TabEditor.tsx`
- `src/store/tabStore.ts`

---

### Phase 13 — DXF Import + Image Import (Day 19-20)

**Goal:** Support the two remaining common import formats.

**Deliverables:**
- **DXF import** (`src/importers/dxfImporter.ts`):
  - Uses `dxf-parser` npm package
  - Supported entities: LINE, LWPOLYLINE, POLYLINE, ARC, CIRCLE, SPLINE, ELLIPSE
  - Prompt user for units when DXF `$INSUNITS` is absent or ambiguous
  - Warn when no supported geometry found
- **Image import** (`src/importers/imageImporter.ts`):
  - Accept PNG, JPEG via drag-drop or file input
  - Display as non-selectable reference layer on canvas
  - Appear in Paths panel with visibility toggle
  - Position/scale image via transform handles
  - Stored as base64 in project save

**Acceptance check:** Import a DXF and an image reference, verify both appear on canvas.

---

### Phase 14 — V-Carve + Inlay Toolpaths (Day 20-24)

**Goal:** The most complex CAM operations: V-carving and inlay.

**Deliverables:**
- **V-carve toolpath** (`src/cam/vcarve.ts`):
  - Medial axis transform of selected closed paths using Clipper offset shrinking
  - V-bit depth computed from local width and bit angle
  - Maximum depth limit
  - Supports grouped text with holes (inner contours treated as islands)
  - Inside / outside / center strategies
- **Inlay toolpath** (`src/cam/inlay.ts`):
  - Female socket: pocket + V-carve finishing pass
  - Male plug: mirrored geometry with clearance offset
  - Settings: glue gap, clearance, pocketing tool, finishing tool
- Both appear in Machine panel and G-code export

**Acceptance check:** V-carve text, verify depth varies by character stroke width in 2D simulation.

---

### Phase 15 — 3D View + Simulation (Day 24-29)

**Goal:** 3D workpiece view with material removal animation.

**Deliverables:**
- Three.js scene in a new main workspace tab ("3D View")
- Workpiece box rendered with wood-grain texture based on selected material
- XYZ axes indicator
- Orbit (left-drag), pan (right-drag), zoom (wheel)
- Toolpaths rendered as 3D line geometry
- CNC tool model (cylinder for end mill, cone for V-bit) shown at current position
- **Material removal simulation**:
  - Height-map (2.5D) approach: workpiece divided into NxN voxel grid
  - Each cutting move subtracts tool shape from height map
  - Rendered as subdivided plane with vertex heights
  - Play/pause/seek controls synchronized with 2D simulation
  - Reset on simulation restart or project change
  - Voxel density adaptive (reduce if performance drops below 30fps)
- Show/hide toggles for: axes, toolpaths, workpiece, STL models

**Acceptance check:** Run simulation in 3D, watch material removal, orbit around the workpiece.

**Critical files:**
- `src/three/Scene.tsx`
- `src/three/Workpiece.tsx`
- `src/three/MaterialRemoval.ts`
- `src/three/SimulationCamera.tsx`

---

### Phase 16 — STL Import + 3D Profile Toolpath (Day 29-33)

**Goal:** Support 3D relief machining from imported models.

**Deliverables:**
- **STL import** (`src/importers/stlImporter.ts`):
  - Three.js STLLoader handles binary + ASCII
  - STL placed on workpiece; selectable 2D bounding rectangle in canvas
  - Height map extracted for 2D overlay display
  - STL shown in 3D view
  - Transform: move, scale, hide/show/delete
  - Included in project save/load
  - Warn when file cannot be parsed
- **3D Profile toolpath** (`src/cam/profile3d.ts`):
  - Ball nose tool required
  - Raster and contour/waterline strategies
  - Max depth, step-down, stepover %, raster angle
  - Rest-machining: exclude areas already cut by larger prior tool

**Acceptance check:** Import a simple STL, generate a raster 3D profile toolpath, run simulation.

---

### Phase 17 — AI Design Generation (Day 33-34)

**Goal:** Generate SVG linework from a natural-language prompt using Claude API.

**Deliverables:**
- Options panel: API key input (stored in `localStorage`, never hard-coded)
- AI Design panel in Draw tab:
  - Prompt textarea
  - Generate button
  - Loading state with cancel
  - Error message on failure or unparseable response
- On success: SVG response parsed and imported as editable vector geometry
- Works with Anthropic Claude API (model: `claude-sonnet-4-6`)

**Acceptance check:** Enter API key, generate a design from prompt, edit result on canvas.

---

### Phase 18 — Safety, Polish & Hardening (Day 34-38)

**Goal:** Pre-export checklist, warnings, autosave, accessibility, performance.

**Deliverables:**
- Pre-export checklist modal: origin, units, safe height, material thickness, post-processor, visible toolpaths
- Simulation is not a substitute for dry-run warning (dismissible, shown once)
- Unit mismatch warnings (display units vs G-code profile units vs imported file units)
- Cut depth exceeds workpiece thickness warning
- Toolpath diagnostics: open paths used with pocket (requires closed boundary), self-intersections
- Feed/speed out-of-range warnings for selected material
- Toolpath summary before export: operation count, tool changes, estimated time, XYZ extents, deepest cut
- Autosave to `localStorage` every 60 seconds; recovery prompt on next load
- Project schema version in save file for future migration
- Keyboard accessibility for toolbar + sidebar actions (tab order, aria-labels)
- Accessible labels for icon-only buttons
- Resizable sidebar (drag handle)
- Image tracing if `potrace-wasm` is available

**Acceptance check:** Trigger each warning, verify autosave recovery, verify no overlapping panels on 1280px screen.

---

## Verification Plan (End-to-End)

1. **Minimum workflow:** Import SVG → profile toolpath → export G-code → verify in Grbl simulator
2. **Project round-trip:** Save project → reload page → load project → verify all paths, tools, toolpaths, and settings restored
3. **Simulation:** Generate multi-operation G-code → 2D simulate (play, pause, seek) → 3D simulate (material removal visible)
4. **Design creation:** Create text, rectangle, circular pattern → boolean union → pocket toolpath → export
5. **V-carve:** Import text SVG → V-carve → verify depth varies in 2D simulation
6. **STL:** Import simple STL → generate 3D raster profile → simulate
7. **DXF/image:** Import DXF → verify geometry; import image → verify non-machinable reference layer
8. **Safety:** Attempt export with no toolpaths (should warn); set cut depth > workpiece thickness (should warn)

---

## Key Library Versions (lock at project creation)

```json
{
  "vite": "^5",
  "react": "^18",
  "konva": "^9",
  "react-konva": "^18",
  "three": "^0.165",
  "js-angusj-clipper": "^1",
  "dxf-parser": "^1",
  "opentype.js": "^1",
  "tailwindcss": "^3",
  "zustand": "^4"
}
```
