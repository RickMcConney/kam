# 2. The canvas

Chapter 1 drew two circles by typing a radius and clicking. That is the easy case. This
chapter is about the rest: getting around a drawing, selecting exactly what you mean,
moving and sizing things precisely, drawing freehand, and reshaping a path point by
point.

Everything here happens in the **2D View**, and nothing here cuts anything — this is the
drawing half of the app. Cutting is chapter 4 onward.

---

## Getting around

| Action | How |
|---|---|
| Zoom | Scroll wheel, centred on the cursor |
| Pan | Middle-mouse drag, or hold **Space** and drag |
| Snap to grid | **S** toggles it — the status bar shows `SNAP` in blue when it's on |
| Units | The **mm / in** toggle in the toolbar |

The grid spacing is shown bottom-right, and the status bar along the bottom always
reports the current mode, the stock, and the machine rigidity — so if a click isn't doing
what you expect, look there first. `Mode: Select` means clicks select; `Mode: Circle`
means the next click places a circle.

The **mm / in** toggle changes only what you see and type. Millimetres are what the
project actually stores, so switching units never moves anything, never introduces
rounding, and a file saved by someone working in inches opens correctly for someone
working in mm.

---

## Selecting

Clicking is the obvious half. The part worth learning is the drag box, because it asks
one of two genuinely different questions and **the direction you drag chooses which**.

| Gesture | Selects |
|---|---|
| Click a path | That path — or the whole group it belongs to |
| Shift-click | Adds or removes one path from the selection |
| **Alt-click** | The single path *inside* a group, ignoring the group |
| Drag right → | Everything the box **touches** (dashed outline) |
| Drag ← left | Only what lies **wholly inside** it (solid outline) |
| Click empty canvas | Deselects |
| **Escape** | Deselects, or cancels whatever tool is armed |

The two box directions matter on a crowded drawing. *Everything this box runs across*
picks a row of parts out of a nest. *These, and nothing they overlap* picks one wheel out
from under the arbor crossing it. The outline tells you which you're about to get, and it
is the only thing on screen saying so:

| Dragged **right** → **dashed** box, takes what it touches | Dragged **left** ← **solid** box, takes only what's wholly inside |
|---|---|
| ![A dashed drag box over the polygon, clipping the top of the heart](images/02-dragbox-touch.png) | ![A solid drag box drawn around the star alone](images/02-dragbox-enclose.png) |
| Catches the polygon **and** the heart — the box crosses it | Catches the star only |

<!-- CROP · identical framing from two 1× full-screen captures, 525 px wide. -->

The test is on each object's bounding box, not its outline — so an L-shaped path counts as
touched by a box sitting in the crook of its own bounding box.

An enclosing box treats a group as one object: a group half inside the box is not
selected at all, rather than coming back as the handful of its parts that happened to
fall inside.

### The Paths list

The sidebar's **Paths** tab lists everything in the project by name, which is the reliable
way to grab something small, something buried under something else, or one path inside a
group.

![The Paths tab: the path list at the top, the Properties panel for the selected circle below it](images/02-paths-panel.png)

*Selecting a path in the list selects it on the canvas, and its properties appear
underneath.*

<!-- FULL APP · 1600 px wide. Paths tab, one of two circles selected. -->

---

## The Properties panel

Select something and the Properties panel appears under the paths list, in two sections
that answer two different questions:

- **Shape** — *what this thing is.* A circle's radius, a gear's module and tooth count, a
  star's point count. These are the parameters the object was generated from, and editing
  one regenerates the object.
- **Transform** — *where it is and how big.* Centre, width and height, rotation angle.
  These are absolute: type `75` into CX and the object's centre goes to X 75, it doesn't
  move by 75.

A path that came from an SVG or the pen tool has no Shape section — there are no
parameters to recover, only geometry — so it shows Transform alone.

Below them:

- **Mirror X** / **Mirror Y** flip the selection about its own centre.
- **Resize from centre** decides whether dragging a corner handle grows the object
  outward from its middle or from the opposite corner. It rides with the object, so you
  can change your mind later.

---

## Moving, scaling and rotating

Select something and handles appear around it.

| Handle | Does |
|---|---|
| Drag the object itself | Move |
| Corner handle | Scale — about the centre or the opposite corner, per **Resize from centre** |
| Edge handle | Scale in one axis only |
| The handle above the box | Rotate |
| **Alt** + corner handle | Skew (shear) instead of scale |

For anything that needs to be exact, type it into the Transform fields rather than
dragging. Dragging is for arranging; the fields are for dimensions.

> **Rotating or non-uniformly scaling a generated shape gives up its parameters.** A
> circle stretched into an oval can no longer be described by a radius, so its Shape
> section goes away and it becomes an ordinary path. Moving it, or scaling it evenly,
> keeps the parameters intact. If you want an ellipse, draw an ellipse.

**Gear, Escapement, Pendulum and Track refuse drag-scaling entirely** — they don't even
draw resize handles. Their size comes from module and tooth count, from the beat, or from
the piece they must connect to. Change those numbers in the Shape section instead.

---

## Groups

Select several paths and press **Ctrl+G** (or **Group** in the Properties panel) to tie
them together. After that, clicking any member selects the whole group, and they move,
scale, rotate and delete as one thing. The Objects strip shows them as a single chip.

- **Ctrl+Shift+G** ungroups.
- **Alt-click** reaches a single path inside a group without ungrouping.
- Groups nest. Group a group with a shape, and ungrouping once gives you back that group
  and that shape — one level at a time, not a pile of loose paths.

---

## The pen tool

**Pen** in the Draw menu places points; the tool decides what curve runs through them.

- **Click** places a point.
- **Click-drag** in Bezier mode pulls out curve handles.
- **Alt-click** makes the incoming segment straight, whatever mode you're in.
- **Click near the first point** closes the path.
- **Escape** finishes it open — two points minimum.
- **Ctrl+Z** takes back the last point placed, without leaving the tool.

Five curve modes sit under the tool, and they change what the *same set of points* means:

| Mode | Gives you |
|---|---|
| **Linear** | Straight segments — a polyline |
| **Bezier** | Handles you pull out yourself; total control, most work |
| **C-Rom** | A smooth curve through every point, computed for you (the default) |
| **Spline** | A smoother cubic spline through every point |
| **Arc** | Fitted circular arcs — the one to use when the shape genuinely is arcs |

Except in Bezier mode you don't drag handles at all; you place points and the curve
follows. Change mode after the fact and the same points give a different path.

---

## Point editing

**Double-click any path** to edit it point by point. This works on anything — a pen path,
an imported SVG, a shape whose parameters you've given up.

| Action | Does |
|---|---|
| Drag an anchor | Moves the point and both its handles |
| Drag a handle | Reshapes the curve without moving the point |
| **Alt-click** a point | Toggles it between a corner and a curve |
| Click a segment | Inserts a new point there |
| Hover a point + **Delete** | Removes it — the point under the cursor turns red |
| **Escape**, or click away | Commits and exits |

![A heart in point-edit mode: anchor points on the outline, handle lines and grey handle dots, the first point drawn in white](images/02-point-edit.png)

*Anchors sit on the path; the grey dots on stalks are the Bezier handles that set the
curve into and out of each one. The first point is drawn in white, so you can always tell
where the path starts — which matters when you care where a cut begins. The banner names
the gestures, and the status bar reads `Mode: Edit Points` until you finish.*

<!-- CROP · canvas plus the hint banner, from a 2× capture, 1000 px wide. -->

**Ctrl+Z inside a point-edit session undoes just that session's edits**, one at a time,
before it starts eating anything else. You can go into a path, make a mess, back out of
it, and leave without having disturbed the rest of the project.

---

## Reshaping with Path Tools

The **Path Tools** group makes new geometry from existing geometry. All four are
re-editable afterwards from their chip in the Objects strip — the chip holds the
parameters, so you can change your mind rather than undoing and redoing.

| Tool | Does | Needs |
|---|---|---|
| **Boolean** | Union, intersect, subtract | Two or more overlapping paths |
| **Offset** | Grows or shrinks a path by a distance, with round, miter or square corners | One path |
| **Pattern** | Linear or circular arrays | One path or group |
| **Corners** | Applies a corner treatment to the corners you pick | One path |

**Corners** is the one worth knowing about before you need it. It offers **Outer Round**,
**Inner Round**, **Chamfer**, **Dogbone** and **None**, and you choose which corners get
it rather than treating them all.

**Dogbone** is the CNC-specific one. A round cutter cannot cut a sharp internal corner —
it leaves a radius, and a square peg then won't seat in the socket you just cut. A dogbone
overcuts a small circular notch into the corner so the mating part fits. Its radius field
asks for the **tool radius**, not a decorative size, because that is what decides how much
must be relieved.

---

## Next

- **[3. Stock, origin and tools](03-stock-and-tools.md)** — the tool library, feeds and speeds
- **[4. Operations](04-operations.md)** — turning geometry into toolpaths
