# FreazyKam

**Browser-based CNC CAM application for makers, woodworkers, and hobby CNC users.**

[**Launch App →**](https://rickmcconney.github.io/kam/)

---

## What It Does

FreazyKam runs entirely in your browser — no account, no server, no install. You design or import 2D vector geometry, configure your tool library and workpiece, generate CNC toolpaths, preview the simulation, and export machine-ready G-code.

---

## Features

### Design Import
- **SVG** — paths, shapes, groups, nested transforms, real-world dimensions
- **DXF** — LINE, LWPOLYLINE, ARC, CIRCLE, SPLINE, ELLIPSE entities; prompts for units when missing
- **STL** — binary and ASCII for 3D surface machining workflows
- **Images** — PNG, JPEG, WebP as visual canvas references
- **G-code** — `.gcode`, `.nc`, `.ngc`, `.tap` for inspection and simulation

### Drawing Tools
- **Shapes** — rectangle, rounded rect, inner-rounded rect, circle, ellipse, polygon, star, heart, slot, shield
- **Text** — vector text paths via opentype.js; choose from bundled or web fonts
- **Pen tool** — click for straight segments, click-drag for Bezier curves; Escape to finish open path, click near first node to close
- **Point editing** — double-click any path; drag anchors and handles, click segment to insert, hover + Delete to remove

### Object Editing
- Move, scale (uniform and non-uniform), rotate with on-canvas handles
- Boolean operations: union, intersection, subtract
- Offset tool: inset/outset with round, miter, or square corners
- Corner treatment: outer radius, inner radius, chamfer, dogbone
- Linear and circular pattern tools
- Holding tabs: configure count, length, height; drag individual tabs along path
- Undo/redo for all geometry and toolpath actions

### CAM Operations
| Operation | Description |
|---|---|
| Profile | Inside / outside / centerline cut with climb or conventional direction, ramp-in |
| Pocket | Raster or contour clearing strategy, island support, ramp-in |
| Drill | Peck drilling at placed points or helical drilling from circular paths |
| Surface | Full-workpiece facing passes |
| V-Carve | Medial-axis depth from V-bit geometry, island/letter-hole support |
| Inlay | Female socket (pocket + V-carved walls) and male plug generation |
| 3D Profile | Raster surface following from imported STL with optional roughing pass |

### Preview & Simulation
- **2D simulation** — play, pause, stop, speed control, seek slider, current G-code line, Z depth, elapsed/total time
- **3D view** — orbit, pan, zoom; workpiece box with material appearance; toolpath visualization; material removal animation
- **G-code viewer** — line-synchronized highlight during simulation

### Export
- G-code export with configurable post-processor profiles
- Supports multiple profiles (Grbl, custom); placeholders for `{x}`, `{y}`, `{z}`, `{f}`, `{s}`
- Arc output (G2/G3) optional per profile
- Separate G-code unit mode (mm or inches) independent of display units
- Saves as `.fkam` project files (JSON) for round-trip editing

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
Clipper2-ts (offset/polygon ops) · polygon-clipping (boolean ops) · opentype.js (text) · dxf-parser

---

## Running Locally

```bash
npm install
npm run dev        # dev server with hot reload
npm run build      # type-check + production build
npm run preview    # serve production build locally
```

No backend required. All data stays in your browser.
