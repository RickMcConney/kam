# FreazyKam

**Browser-based CNC CAM application for makers, woodworkers, and hobby CNC users.**

[**Launch App →**](https://rickmcconney.github.io/kam/)

---

## What It Does

FreazyKam runs entirely in your browser — no account, no server, no install. You design or import 2D vector geometry, configure your tool library and workpiece, generate CNC toolpaths, preview the simulation, and export machine-ready G-code.

![Design view — canvas, operation forms, and the timeline / operations strips](screen%20shots/design.png)

*Designing and generating toolpaths. The strip along the bottom switches between the project **timeline** (every edit, in the order you made it) and the **operations** list (every toolpath, in the order the machine runs it).*

![3D simulation — material removal against the workpiece](screen%20shots/3d%20sim.png)

*The 3D view simulating material removal, with the carved surface updating as the tool cuts.*

![Photo V-Carve — a photograph rastered as V-grooves](screen%20shots/photo%20vcarve.png)

*A photograph carved as V-grooves whose depth follows image brightness. The 3D view renders the cuts dark, the way the finished board looks once paint is flooded over it and sanded back off the face.*

---

## Features

### Design Import
- **SVG** — paths, shapes, groups, nested transforms, real-world dimensions
- **DXF** — LINE, LWPOLYLINE, ARC, CIRCLE, SPLINE, ELLIPSE entities; prompts for units when missing
- **STL** — binary and ASCII for 3D surface machining workflows
- **Images** — PNG, JPEG, WebP as canvas references, or as the source for a photo V-carve
- **G-code** — `.gcode`, `.nc`, `.ngc`, `.tap` for inspection and simulation

### Drawing Tools
- **Shapes** — rectangle, rounded rect, inner-rounded rect, circle, ellipse, polygon, star, heart, slot, shield
- **Text** — vector text paths via opentype.js; choose from bundled or web fonts, edit the text and font of an existing object at any time
- **Pen tool** — click for straight segments, click-drag for Bezier curves; Escape to finish open path, click near first node to close
- **Point editing** — double-click any path; drag anchors and handles, click segment to insert, hover + Delete to remove

### Object Editing
- Move, scale (uniform and non-uniform), rotate with on-canvas handles
- Boolean operations: union, intersection, subtract
- Offset tool: inset/outset with round, miter or square corners — re-editable from its timeline chip
- Corner treatment: outer radius, inner radius, chamfer, dogbone
- Linear and circular pattern tools — also re-editable from their chip
- Holding tabs: configure count, length, height; drag individual tabs along path
- Undo/redo for everything, backed by the project timeline (below)

### Timeline & Operations

The bar under the canvas holds two strips — they look alike but are different orderings of different things.

**Timeline** is the history: one chip per edit, in the order you made it. Click any chip to scrub the whole project back to that moment, then click forward again. Chips are editable in place — click a shape chip to change its parameters, a boolean chip to switch union/subtract, a pocket chip to change its depth — and the change is applied as an amendment to that step rather than as a new one stacked on top. History is saved in the project file, so it survives a reload.

**Operations** is the program: one chip per toolpath, in the order the machine will run them, which is the order G-code is written in. Operations sharing a tool are drawn as a coloured band, with a marker at every tool change. Drag a chip — or a whole band — to reorder, and *Minimise tool changes* groups each tool's work together in one step. Hover a chip to hide it (hidden operations are excluded from exported G-code) or delete it; click one to select the paths it cuts and open its settings.

### CAM Operations
| Operation | Description |
|---|---|
| Profile | Inside / outside / centerline cut, climb or conventional, ramp-in, holding tabs |
| Pocket | Five clearing strategies (below), island support, finish allowance, ramp-in |
| Trochoidal | Low-engagement slotting with configurable step and loop radius, optional finishing pass |
| Drill | Peck drilling at placed points or helical drilling from circular paths |
| Surface | Full-workpiece facing passes |
| V-Carve | Medial-axis depth from V-bit geometry, island/letter-hole support |
| Photo V-Carve | Rasters a photograph as V-grooves whose depth tracks image brightness |
| Inlay | Female socket (pocket + V-carved walls) and male plug generation |
| 3D Profile | Raster surface following from imported STL with optional roughing pass |

**Pocket strategies**

| Strategy | Best for |
|---|---|
| Auto | Mixed pockets — rasters the open ground, contours around islands, adaptive on the junctions between them. Picks the pass angle per area unless you pin it |
| Raster | Simple open pockets; straight parallel passes at any angle |
| Contour | Concentric offsets following the boundary, so walls and islands are traced |
| Morph | A single continuous spiral morphed between the boundary and the interior |
| Adaptive | Constant tool engagement — heavier depth of cut at lower load, best for harder material and deeper pockets |

Any pocket also gets a **rest-clearing pass**: stock a strategy's passes couldn't reach is cut after them and before the wall pass, so it's a light skim rather than a full-width plunge.

### Start Height

Operations don't have to start at the top of the stock. Engraving letters in the floor of a 2 mm pocket starts 2 mm down, and the **Start** control resolves that for you — it stores a *reference*, not a number, so it re-resolves every time the operation regenerates:

- **Auto** (default) — reads the surface earlier cuts left over this operation's footprint, taking the *highest* remaining material so the tool never starts inside solid stock. If any part of the footprint sits over uncut stock, it stays at the top
- **Stock top** — pin it to Z 0
- **Floor of \<operation\>** — follow a named operation, so changing that pocket's depth moves this cut with it
- **Custom** — an explicit Z

Depths are always measured *from* the start surface, and the tool-reach and past-stock-bottom warnings account for the total. Change a pocket's depth, reorder operations, or move the path a pocket is built on, and anything sitting on that floor is flagged as needing regeneration.

### Feeds, Speeds & Step-Down
- **Auto feed & speeds** — cutting feed, plunge feed, spindle RPM, and step-down computed automatically from material, tool geometry, and machine rigidity
- **Material library** — each material carries a hardness factor that drives the chip-load target
- **Machine rigidity** (1–5) — scales the feed and depth of cut for your machine, from light hobby gantry to rigid industrial
- **Smart spindle RPM** — when the machine can't feed fast enough to hold the target chip load, the spindle is slowed instead of overloading the tool (with a warning emitted in the G-code if you have no spindle control)
- **Whole-division step-down** — depth of cut is snapped to an even division of the total cut depth, capped by tool diameter
- **Max feed ceiling** — a hard limit that generated feeds never exceed, honored even when auto is off
- Toggle off to use each tool's own stored feeds and speeds instead

### Preview & Simulation
- **2D simulation** — play, pause, stop, speed control, seek slider, current G-code line, Z depth, elapsed/total time
- **Chip-load gauge** — live feed-per-tooth readout during steady cutting, color-banded against the target for your machine rigidity, with feed/RPM/flute suggestions to hit the sweet spot
- **3D view** — orbit, pan, zoom; workpiece box with material appearance; toolpath visualization; material removal animation
- **G-code viewer** — line-synchronized highlight during simulation

### Export
- G-code export with configurable post-processor profiles
- Built-in profiles for Grbl (mm and inches), grblHAL, LinuxCNC, Mach3, UCCNC and a generic controller; add your own with placeholders for `{x}`, `{y}`, `{z}`, `{f}`, `{s}`
- Pre-export preflight: cut-time estimate, and warnings for anything that would surprise you at the machine
- Arc output (G2/G3) optional per profile
- Separate G-code unit mode (mm or inches) independent of display units
- Saves as `.fkam` project files (JSON) — geometry, operations, tool library, workpiece **and the full edit history** for round-trip editing

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd+S` | Save project |
| `Ctrl/Cmd+O` | Open project |
| `Ctrl/Cmd+N` | New project |
| `Ctrl/Cmd+Z` | Undo |
| `Ctrl/Cmd+Y` / `Ctrl/Cmd+Shift+Z` | Redo |
| `Ctrl/Cmd+D` | Duplicate selected |
| `Delete` / `Backspace` | Delete selected |
| `S` | Toggle snap to grid |
| `Space` | Play / pause simulation |
| `Escape` | Cancel pen drawing / exit point edit |

---

## Tech Stack

Vite · React 19 · TypeScript · Konva.js · Three.js · Zustand · Tailwind CSS  
Clipper2-ts (offset/polygon ops) · polygon-clipping (boolean ops) · JSPoly (medial axis for V-carving) · opentype.js (text) · dxf-parser

Toolpath generation runs in a Web Worker, so the interface stays responsive while a slow strategy computes.

---

## Running Locally

```bash
npm install
npm run dev        # dev server with hot reload
npm run build      # type-check + production build
npm run preview    # serve production build locally
npm run test:run   # unit tests (Vitest)
```

No backend required. All data stays in your browser.
