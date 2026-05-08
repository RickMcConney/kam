# Product Requirements Document: FreazyKam

## 1. Product Summary

FreazyKam is a browser-based CNC CAM application for makers, woodworkers, and hobby CNC users. The product enables users to create or import 2D vector designs, configure a workpiece and CNC tools, generate CNC toolpaths, preview and simulate machining, and export G-code without requiring accounts, server processing, or installed desktop software.

The application must prioritize an end-to-end CNC preparation workflow that is approachable for non-expert users while still exposing enough controls for practical CNC routing, carving, drilling, surfacing, inlay, and basic 3D surface machining tasks.

## 2. Product Goals

1. [ ] **REQ-001:** Allow users to complete the full CAM workflow locally in a modern browser.
2. [ ] **REQ-002:** Support importing existing artwork and creating basic designs directly in the app.
3. [ ] **REQ-003:** Provide practical CNC operation types for common woodworking and hobby CNC jobs.
4. [ ] **REQ-004:** Make generated toolpaths inspectable before export through 2D and 3D visualization.
5. [ ] **REQ-005:** Persist user configuration locally so recurring projects and tool settings are efficient.
6. [ ] **REQ-006:** Export machine-ready G-code with configurable controller profiles.

## 3. Non-Goals

1. [ ] **REQ-007:** The product is not a cloud CAM service and must not require a backend for core workflows.
2. [ ] **REQ-008:** The product is not a general-purpose CAD system; design creation should focus on CNC-ready shapes, text, edits, and transformations.
3. [ ] **REQ-009:** The product is not a full industrial machining suite; advanced multi-axis machining and professional post-processing are outside the core scope.
4. [ ] **REQ-010:** The product is not responsible for guaranteeing physical machine safety; it must provide clear previews, constraints, and export settings, but users remain responsible for machine setup and validation.

## 4. Requirement Language

Completion tracking uses Markdown task-list syntax. Change `[ ]` to `[x]` on any requirement line when that requirement is complete.

1. [ ] **REQ-011:** Requirements using “shall” describe core product behavior expected in a rebuild of the current application.
2. [ ] **REQ-012:** Requirements using “should” describe recommended product behavior, gaps, or hardening work that may not be fully present in the current application but is important to the intended product.
3. [ ] **REQ-013:** Requirements using “may” describe optional behavior that can improve usability without being required for the core workflow.

## 5. Target Users

1. [ ] **REQ-014:** Hobby CNC router owners preparing SVG artwork for cutting or carving.
2. [ ] **REQ-015:** Woodworkers creating signs, plaques, inlays, and routed parts.
3. [ ] **REQ-016:** Makers who need quick, local CAM generation without installing desktop CAM software.
4. [ ] **REQ-017:** CNC users who want to test tool libraries, feeds, speeds, and G-code output before running a job.

## 6. Core Workflow Requirements

### 6.1 New Project and Workpiece Setup

1. [ ] **REQ-018:** The application shall allow users to define the stock/workpiece width, length, and thickness.
2. [ ] **REQ-019:** The application shall allow users to choose whether measurements are displayed in millimeters or inches.
3. [ ] **REQ-020:** The application shall allow users to choose the X/Y workpiece origin from common positions such as corners, edges, and center points.
4. [ ] **REQ-021:** The application shall display the workpiece boundary in the 2D view when enabled.
5. [ ] **REQ-022:** The application shall allow users to choose a material or wood species that influences visual appearance and feed/speed guidance.
6. [ ] **REQ-023:** The application shall persist workpiece settings locally across browser sessions.
7. [ ] **REQ-024:** The application shall expose table or machine travel limits for width, length, and cutting depth.
8. [ ] **REQ-025:** The application shall treat the top of the workpiece as the default Z-zero reference for CAM setup and G-code generation unless a future machine profile explicitly supports a different Z reference.

### 6.2 Design Import

1. [ ] **REQ-026:** The application shall allow users to import SVG files as CNC design geometry.
2. [ ] **REQ-027:** The application shall parse SVG paths into editable and machinable vector paths.
3. [ ] **REQ-028:** The application shall preserve imported design names when available and provide generated names when needed.
4. [ ] **REQ-029:** The application shall support importing reference images that can be placed on the workpiece as visual guides.
5. [ ] **REQ-030:** The application shall support importing DXF geometry for workflows that start from CAD exchange files.
6. [ ] **REQ-031:** The application shall support importing STL models for 3D surface-following workflows.
7. [ ] **REQ-032:** The application shall support importing existing G-code for inspection and simulation.
8. [ ] **REQ-033:** The application shall keep all imported files local to the browser and shall not upload user files for core import workflows.

### 6.3 Design Creation

1. [ ] **REQ-034:** The application shall provide drawing tools that create CNC-ready vector geometry directly on the 2D work area.
2. [ ] **REQ-035:** The application shall provide pen-style path drawing for straight-line paths and anchor-based curves.
3. [ ] **REQ-036:** The application shall provide geometric shape creation for common CNC-ready shapes.
4. [ ] **REQ-037:** The application shall provide pattern tools for duplicating geometry in linear and circular arrangements.
5. [ ] **REQ-038:** The application shall provide text creation using selectable local fonts.
6. [ ] **REQ-039:** The application shall allow created objects to retain enough creation properties to be edited later.
7. [ ] **REQ-040:** The application shall provide AI-assisted SVG design generation when the user supplies an API key and prompt.

### 6.4 Object Selection and Editing

1. [ ] **REQ-041:** The application shall allow users to select one or more design objects and toolpaths in the 2D view.
2. [ ] **REQ-042:** The application shall allow selected objects to be moved, transformed, edited, hidden, shown, and deleted.
3. [ ] **REQ-043:** The application shall show selected object properties in an editable panel when applicable.
4. [ ] **REQ-044:** The application shall provide path-level editing for vector geometry.
5. [ ] **REQ-045:** The application shall provide transformation tools for moving, scaling, rotating, and positioning geometry.
6. [ ] **REQ-046:** The application shall provide undo and redo for user-editing actions.
7. [ ] **REQ-047:** The application shall maintain a visible paths or objects tree for managing project contents.

### 6.5 Canvas Navigation and Interaction

1. [ ] **REQ-048:** The application shall provide a 2D work area that supports zooming and panning.
2. [ ] **REQ-049:** The application shall support mouse-based panning without changing the active drawing or editing tool.
3. [ ] **REQ-050:** The application shall support touch input for single-touch editing and two-finger pan/zoom on tablets and mobile devices.
4. [ ] **REQ-051:** The application shall support grid display and grid snapping, with the ability to disable snapping.
5. [ ] **REQ-052:** The application shall visually indicate hover, selection, drag, and edit handles on the canvas.
6. [ ] **REQ-053:** The application shall keep canvas interactions in real-world workpiece coordinates so drawn and imported geometry corresponds to CNC output dimensions.

## 7. Design Tool Requirements

### 7.1 Selection Tool

1. [ ] **REQ-054:** The application shall allow click selection of visible paths and image references.
2. [ ] **REQ-055:** The application shall allow multi-selection and deselection.
3. [ ] **REQ-056:** The application shall allow drag-box selection.
4. [ ] **REQ-057:** The application shall differentiate selection-box behavior by drag direction, including containment-style and touch/intersection-style selection.
5. [ ] **REQ-058:** The application shall allow selected geometry to be dragged directly on the canvas.
6. [ ] **REQ-059:** The application shall constrain drag movement horizontally or vertically when the user uses the relevant modifier key.
7. [ ] **REQ-060:** The application shall regenerate dependent toolpaths when source geometry is moved.

### 7.2 Move and Transform Tool

1. [ ] **REQ-061:** The application shall show a transform box around selected geometry.
2. [ ] **REQ-062:** The application shall allow selected geometry to be moved, scaled, rotated, mirrored horizontally, mirrored vertically, and skewed.
3. [ ] **REQ-063:** The application shall support uniform scaling with a modifier key.
4. [ ] **REQ-064:** The application shall support rotation around an adjustable pivot point.
5. [ ] **REQ-065:** The application shall display live transform feedback such as current dimensions, rotation angle, or skew angle during manipulation.
6. [ ] **REQ-066:** The application shall update object bounds and dependent CNC data after transformations.
7. [ ] **REQ-067:** The application shall keep associated tabs aligned with transformed geometry.
8. [ ] **REQ-068:** The application shall allow transform values to be edited through a properties panel where practical.

### 7.3 Point Editing Tool

1. [ ] **REQ-069:** The application shall allow users to edit individual vector path points.
2. [ ] **REQ-070:** The application shall show point handles for the selected path, including a distinct first-point marker.
3. [ ] **REQ-071:** The application shall allow point handles to be dragged to new positions.
4. [ ] **REQ-072:** The application shall allow adding a point on an existing segment.
5. [ ] **REQ-073:** The application shall allow deleting a hovered point while preserving minimum valid point counts.
6. [ ] **REQ-074:** The application shall allow the user to set a different first point for a path.
7. [ ] **REQ-075:** The application shall allow open paths to be closed by joining compatible endpoints.
8. [ ] **REQ-076:** The application shall provide smoothing that adjusts existing points without adding new points.
9. [ ] **REQ-077:** The application shall provide corner modification operations for selected points or all points, including outside radius, inside radius, miter/chamfer, and dogbone relief.
10. [ ] **REQ-078:** The application shall preserve tabs and re-snap them to edited path geometry where applicable.
11. [ ] **REQ-079:** The application shall regenerate dependent toolpaths after path edits.

### 7.4 Pen and Curve Drawing

1. [ ] **REQ-080:** The application shall allow users to draw straight-line paths by clicking sequential corner points.
2. [ ] **REQ-081:** The application shall allow users to finish open paths and close paths by clicking near the first point.
3. [ ] **REQ-082:** The application shall allow users to draw smooth curves from anchor points.
4. [ ] **REQ-083:** The application shall provide curve fitting modes including Catmull-Rom, Bezier-style, cubic spline, and arc-fit interpolation.
5. [ ] **REQ-084:** The application shall allow users to mark curve anchors as corners.
6. [ ] **REQ-085:** The application shall allow existing pen and curve paths to be re-edited by moving, inserting, and deleting anchors.
7. [ ] **REQ-086:** The application shall provide live previews while drawing or inserting points.

### 7.5 Shape Creation

1. [ ] **REQ-087:** The application shall allow users to create common CNC-ready shapes from a properties panel and canvas placement.
2. [ ] **REQ-088:** Supported shape types shall include belt, circle, ellipse, heart, polygon, rectangle, rounded rectangle, sign, and star.
3. [ ] **REQ-089:** Shape dimensions and numeric parameters shall be editable before creation.
4. [ ] **REQ-090:** Created shapes shall retain their creation parameters so they can be edited later.
5. [ ] **REQ-091:** Shape units shall respect the user’s current display unit setting.

### 7.6 Text Creation

1. [ ] **REQ-092:** The application shall allow users to create text as vector paths suitable for CNC operations.
2. [ ] **REQ-093:** The application shall allow users to enter text content, choose a font, and set font size.
3. [ ] **REQ-094:** The application shall support multiple local TrueType fonts.
4. [ ] **REQ-095:** The application shall convert text outlines into one or more machinable paths.
5. [ ] **REQ-096:** Text objects shall retain their text, font, size, and placement so they can be edited later.

### 7.7 Boolean, Offset, Pattern, and Tabs

1. [ ] **REQ-097:** The application shall provide boolean tools for combining or modifying overlapping vector shapes.
2. [ ] **REQ-098:** Boolean operations shall include union, intersection, and subtraction.
3. [ ] **REQ-099:** Boolean operations shall preserve the original selected shapes by hiding or otherwise retaining them when a new result is produced.
4. [ ] **REQ-100:** The application shall provide an offset tool for creating inset or outset copies of selected geometry.
5. [ ] **REQ-101:** Offset generation shall allow users to set distance, direction, and corner style.
6. [ ] **REQ-102:** Offset corner styles shall include round, miter, and square.
7. [ ] **REQ-103:** The application shall provide pattern tools for duplicating geometry in repeatable layouts.
8. [ ] **REQ-104:** Pattern generation shall support linear grid arrays with configurable rows, columns, and X/Y spacing.
9. [ ] **REQ-105:** Pattern generation shall support circular arrays with configurable count, radius, start angle, optional end angle, and optional per-item rotation.
10. [ ] **REQ-106:** Generated offset and pattern geometry shall retain source and creation settings so users can reapply or edit the generated result.
11. [ ] **REQ-107:** The application shall provide tab editing for adding and adjusting holding tabs on profile-cut geometry.
12. [ ] **REQ-108:** The tab editor shall allow users to configure tab length, tab height, and number of tabs.
13. [ ] **REQ-109:** The tab editor shall generate tabs around selected paths and allow individual tabs to be dragged along the path boundary.
14. [ ] **REQ-110:** The tab editor shall allow individual hovered tabs to be deleted and all tabs to be removed.
15. [ ] **REQ-111:** Tabs shall be represented visually in previews and shall affect profile G-code so material is left uncut at tab positions.

### 7.8 AI-Assisted Design

1. [ ] **REQ-112:** The application shall allow users to generate SVG linework from a natural-language prompt using an external AI service.
2. [ ] **REQ-113:** The application shall require the user to provide their own API key for AI generation.
3. [ ] **REQ-114:** The application shall store the API key locally in the browser and shall not hard-code API keys.
4. [ ] **REQ-115:** AI-generated output shall be imported as editable vector geometry.
5. [ ] **REQ-116:** The application shall notify the user when generation fails, returns unusable data, or cannot be parsed.

## 8. CNC Toolpath Requirements

### 8.1 General Toolpath Management

1. [ ] **REQ-117:** The application shall allow users to generate toolpaths from selected design geometry.
2. [ ] **REQ-118:** The application shall show generated toolpaths in the project tree grouped by tool.
3. [ ] **REQ-119:** The application shall allow toolpaths to be renamed, selected, reordered, hidden, shown, and deleted.
4. [ ] **REQ-120:** The application shall allow toolpath groups by tool to be reordered.
5. [ ] **REQ-121:** The application shall visually display generated toolpaths in the 2D view.
6. [ ] **REQ-122:** Toolpaths shall retain their source geometry references and generation properties when possible.
7. [ ] **REQ-123:** When source geometry changes, dependent toolpaths shall be regenerated or marked for update.
8. [ ] **REQ-124:** The application shall allow users to edit an existing toolpath’s settings and update it without recreating unrelated toolpaths.
9. [ ] **REQ-125:** Toolpath generation shall validate required inputs such as selected tool, depth, step down, and stepover before creating output.
10. [ ] **REQ-126:** Toolpath names shall be editable and may be automatically suggested from operation type and depth.

### 8.2 Tool Library

1. [ ] **REQ-127:** The application shall provide a tool library for CNC cutting tools.
2. [ ] **REQ-128:** Supported tool types shall include end mill, ball nose, V-bit, and drill.
3. [ ] **REQ-129:** Each tool shall have editable name, type, diameter, flute count, spindle RPM, XY feed, Z feed, V-bit angle where relevant, cutting direction, cutting depth, step down, and stepover where relevant.
4. [ ] **REQ-130:** The application shall provide sensible default tools for first-time users.
5. [ ] **REQ-131:** The tool library shall persist locally across browser sessions.
6. [ ] **REQ-132:** Users shall be able to add tools and delete tools, while preserving at least one available tool.
7. [ ] **REQ-133:** Tool dimensions and feed values shall display in the selected unit system while preserving consistent internal units.
8. [ ] **REQ-134:** Tool depth and step down may be defined relative to workpiece thickness, and those values shall update when workpiece thickness changes.

### 8.3 Feed, Speed, and Material Guidance

1. [ ] **REQ-135:** The application shall allow users to select a wood species or material profile.
2. [ ] **REQ-136:** The application shall support automatic feed-rate calculation based on tool parameters and selected material when enabled.
3. [ ] **REQ-137:** Automatic feed-rate calculation shall respect configured minimum and maximum feed-rate limits.
4. [ ] **REQ-138:** Users shall be able to override or manually edit feed and speed values per tool.
5. [ ] **REQ-139:** G-code export shall use the selected tool’s spindle speed and feed settings, adjusted by applicable material settings.

### 8.4 Profile Toolpaths

1. [ ] **REQ-140:** The application shall generate profile cuts along selected geometry.
2. [ ] **REQ-141:** Profile operations shall support inside, outside, and centerline cutting.
3. [ ] **REQ-142:** Profile operations shall support climb and conventional cutting direction.
4. [ ] **REQ-143:** Profile operations shall support total depth, step down, number of profile loops, and over/under cut offset.
5. [ ] **REQ-144:** Profile operations shall honor tabs where tabs are present on the source geometry.
6. [ ] **REQ-145:** Profile operations shall support compatible tools including end mills, ball nose bits, and V-bits.

### 8.5 Pocket Toolpaths

1. [ ] **REQ-146:** The application shall generate pocket toolpaths that remove material inside selected closed geometry.
2. [ ] **REQ-147:** Pocket operations shall support islands inside pocket boundaries.
3. [ ] **REQ-148:** Pocket operations shall support adaptive, raster, and contour clearing strategies.
4. [ ] **REQ-149:** Pocket operations shall support climb and conventional cutting direction.
5. [ ] **REQ-150:** Pocket operations shall support total depth, step down, stepover percentage, and infill/raster angle.
6. [ ] **REQ-151:** Pocket operations shall optimize path order to reduce unnecessary travel where practical.
7. [ ] **REQ-152:** Pocket operations shall support compatible tools including end mills and ball nose bits.

### 8.6 V-Carve Toolpaths

1. [ ] **REQ-153:** The application shall generate V-carve toolpaths using V-bit geometry.
2. [ ] **REQ-154:** V-carve operations shall support inside, outside, and center/medial-axis carving strategies.
3. [ ] **REQ-155:** V-carve operations shall support maximum depth and over/under cut.
4. [ ] **REQ-156:** V-carve operations shall adapt depth to local geometry so tapered cuts preserve fine features.
5. [ ] **REQ-157:** V-carve operations shall support grouped text and nested paths so letters with holes and internal features carve correctly.

### 8.7 Inlay Toolpaths

1. [ ] **REQ-158:** The application shall generate inlay workflows for female sockets and male plugs.
2. [ ] **REQ-159:** Inlay generation shall support pocketing and finishing tools.
3. [ ] **REQ-160:** Inlay generation shall support end mill, ball nose, and V-bit finishing workflows where applicable.
4. [ ] **REQ-161:** Inlay settings shall include inlay type, mirror plug option, V-carve strategy, pocketing tool, finishing tool, depth, step down, stepover, clearance, glue gap, infill angle, cutting direction, and optional plug cutout.
5. [ ] **REQ-162:** Female socket generation shall remove material inside the selected boundary and provide an appropriate finishing pass.
6. [ ] **REQ-163:** Male plug generation shall create compatible plug geometry, including optional mirroring and fit clearance.
7. [ ] **REQ-164:** V-bit inlay shall support variable-depth finishing to preserve sharp features.

### 8.8 Drill Toolpaths

1. [ ] **REQ-165:** The application shall generate point drilling operations from user-selected or clicked points.
2. [ ] **REQ-166:** Drill operations shall support depth and step-down settings.
3. [ ] **REQ-167:** The application shall allow snapping a drill point to an existing nearby design point.
4. [ ] **REQ-168:** The application shall detect circular selected geometry and generate helical drilling paths when using a lateral-cutting tool.
5. [ ] **REQ-169:** The application shall prevent or warn against invalid drill workflows, such as helical drilling with a drill bit or helical drilling with a tool larger than the selected circle.
6. [ ] **REQ-170:** The application shall warn users before peck drilling with an end mill.

### 8.9 Surfacing Toolpaths

1. [ ] **REQ-171:** The application shall generate surfacing passes across the configured workpiece.
2. [ ] **REQ-172:** Surfacing operations shall support depth, stepover percentage, and pass angle.
3. [ ] **REQ-173:** Surfacing operations shall update when workpiece dimensions or origin settings change.
4. [ ] **REQ-174:** Surfacing operations shall require an end mill.

### 8.10 3D Profile Toolpaths

1. [ ] **REQ-175:** The application shall support importing STL models for 3D surface-following toolpaths.
2. [ ] **REQ-176:** The application shall generate 3D profile toolpaths using a ball nose tool.
3. [ ] **REQ-177:** 3D profile operations shall support raster and contour/waterline strategies.
4. [ ] **REQ-178:** 3D profile operations shall support maximum depth, step down, stepover percentage, raster angle, and previous/rest tool diameter.
5. [ ] **REQ-179:** 3D profile generation shall support rest-machining behavior where prior larger tools can be considered to avoid unnecessary air cutting.

## 9. G-Code Requirements

### 9.1 G-Code Generation

1. [ ] **REQ-180:** The application shall export generated visible toolpaths as G-code.
2. [ ] **REQ-181:** G-code export shall include startup commands, spindle commands, motion commands, tool changes, operation commands, retractions, and shutdown commands.
3. [ ] **REQ-182:** The application shall retract to a configurable safe height between operations.
4. [ ] **REQ-183:** The application shall apply backlash compensation where configured.
5. [ ] **REQ-184:** The application shall detect table-limit violations before export and warn the user.
6. [ ] **REQ-185:** The application shall allow the user to continue export after acknowledging table-limit warnings.
7. [ ] **REQ-186:** Exported G-code shall include project or file name comments where comments are enabled.
8. [ ] **REQ-187:** G-code generation shall support profile, pocket, surfacing, drilling, helical drilling, V-carve, inlay, and 3D profile toolpaths.
9. [ ] **REQ-188:** G-code generation shall support optional arc output using G2/G3 where arcs can be detected and the selected post processor enables arcs.

### 9.2 Post-Processor Profiles

1. [ ] **REQ-189:** The application shall provide configurable G-code post-processor profiles.
2. [ ] **REQ-190:** Users shall be able to create, select, save, and delete post-processor profiles.
3. [ ] **REQ-191:** At least one post-processor profile shall always remain available.
4. [ ] **REQ-192:** Post-processor profiles shall include start G-code, end G-code, tool-change G-code, spindle on/off commands, rapid move template, cut move template, clockwise arc template, counter-clockwise arc template, comment style, comments enabled flag, arc-output enabled flag, and G-code unit mode.
5. [ ] **REQ-193:** G-code unit mode shall be independent of display units and support millimeters and inches.
6. [ ] **REQ-194:** Post-processor profiles shall support placeholders for axis coordinates, feed rate, and spindle speed.
7. [ ] **REQ-195:** Post-processor profiles should support axis inversion and axis reordering for machines that need customized coordinate output.
8. [ ] **REQ-196:** Post-processor profiles shall persist locally and shall be saved with project files.

### 9.3 File Export

1. [ ] **REQ-197:** The application shall allow users to save G-code files with common CNC extensions such as `.gcode`, `.nc`, `.ngc`, or `.tap`.
2. [ ] **REQ-198:** The application shall support modern browser save-file dialogs when available.
3. [ ] **REQ-199:** The application shall provide a download fallback when direct save-file access is unavailable.
4. [ ] **REQ-200:** The application shall prevent G-code export when no toolpaths exist and notify the user.

## 10. Project and File Management Requirements

1. [ ] **REQ-201:** The application shall allow users to start a new project.
2. [ ] **REQ-202:** The application shall allow users to save and load project files as JSON.
3. [ ] **REQ-203:** Saved projects shall include design geometry, reference images, generated toolpaths, workpiece origin, tool library, application options, selected/current G-code profile, and imported 3D model state where applicable.
4. [ ] **REQ-204:** Project loading shall restore the visible project tree, tools, options, G-code profile, workpiece view, and toolpaths.
5. [ ] **REQ-205:** The application shall show the current project name in the workspace.
6. [ ] **REQ-206:** The application shall support browser download fallback for project saving when direct file saving is unavailable.
7. [ ] **REQ-207:** The application shall provide undo and redo for project editing actions.

## 11. Preview, Simulation, and Inspection Requirements

### 11.1 2D Workspace Preview

1. [ ] **REQ-208:** The application shall display design geometry, reference images, STL height maps, workpiece bounds, origin, grid, generated toolpaths, tabs, and selection states in a 2D workspace.
2. [ ] **REQ-209:** The application shall visually distinguish original design geometry from generated CNC toolpaths.
3. [ ] **REQ-210:** The application shall visually distinguish rapid moves, cutting moves, selected paths, hidden paths, editable points, transform handles, and drill points.
4. [ ] **REQ-211:** The application shall allow users to toggle grid, origin, workpiece, snapping, and object visibility without changing underlying geometry.
5. [ ] **REQ-212:** The application shall keep the workpiece centered or otherwise easy to locate when starting a new project or changing view settings.
6. [ ] **REQ-213:** The application shall render reference images with user-adjustable placement and visibility.
7. [ ] **REQ-214:** The application shall draw STL height information on the 2D workspace so users can relate a 3D model to its machinable footprint.

### 11.2 2D G-Code Simulation

1. [ ] **REQ-215:** The application shall allow users to simulate generated or imported G-code in the 2D view.
2. [ ] **REQ-216:** The 2D simulation shall provide play, pause, stop, speed, progress, and seek controls.
3. [ ] **REQ-217:** The 2D simulation shall display the current G-code line, feed rate, elapsed time, total estimated time, and current Z depth.
4. [ ] **REQ-218:** The 2D simulation shall animate tool position along rapid and cutting moves.
5. [ ] **REQ-219:** The 2D simulation shall account for active tool shape when visualizing cut width, including wider effective cuts for V-bit depth changes.
6. [ ] **REQ-220:** The 2D simulation shall synchronize current motion with the G-code viewer line highlight.
7. [ ] **REQ-221:** The 2D simulation shall fail gracefully with a user-visible message when no valid G-code or movements are available.

### 11.3 3D Preview and Material Simulation

1. [ ] **REQ-222:** The application shall provide a 3D view of the workpiece, axes, toolpaths, cutting tool, imported STL models, and simulated material removal.
2. [ ] **REQ-223:** The 3D view shall allow users to orbit, pan, and zoom around the workpiece.
3. [ ] **REQ-224:** The 3D view shall use the configured workpiece dimensions, origin position, thickness, and selected wood species appearance.
4. [ ] **REQ-225:** The 3D view shall provide play, pause, stop, speed, progress, and seek controls for generated or imported G-code simulation.
5. [ ] **REQ-226:** The 3D view shall allow users to independently show or hide axes, toolpath visualization, the workpiece, and STL models.
6. [ ] **REQ-227:** The 3D simulation shall remove visual material from the stock during cutting moves.
7. [ ] **REQ-228:** Material removal visualization shall support flat end mills, ball nose tools, V-bits, and drills.
8. [ ] **REQ-229:** The 3D simulation shall reset material state when a simulation is restarted or the project changes.
9. [ ] **REQ-230:** The 3D view shall update when workpiece dimensions, toolpaths, STL transforms, or visibility settings change.
10. [ ] **REQ-231:** The 3D simulation shall provide current line, feed rate, elapsed time, and total estimated time information.

### 11.4 G-Code Viewer

1. [ ] **REQ-232:** The application shall provide a readable G-code viewer for generated or imported G-code.
2. [ ] **REQ-233:** The G-code viewer shall show line numbers and preserve the full G-code text.
3. [ ] **REQ-234:** The G-code viewer shall highlight the line currently being simulated.
4. [ ] **REQ-235:** The user shall be able to click or seek to a G-code line to move simulation progress.
5. [ ] **REQ-236:** The G-code viewer shall remain performant for large G-code files.
6. [ ] **REQ-237:** The G-code viewer shall be available for both generated G-code and imported G-code files.

## 12. Import Detail Requirements

### 12.1 SVG Import

1. [ ] **REQ-238:** The application shall import SVG paths, basic shapes, groups, nested transforms, and reusable symbol content where practical.
2. [ ] **REQ-239:** The application shall convert supported SVG geometry into CNC-ready vector paths.
3. [ ] **REQ-240:** The application shall preserve grouping or source identity where practical so imported paths can be managed together.
4. [ ] **REQ-241:** The application shall support SVG files that specify real-world dimensions.
5. [ ] **REQ-242:** The application shall infer SVG pixel density when possible and ask the user for pixels-per-inch when required for accurate scaling.
6. [ ] **REQ-243:** The application shall warn the user when no supported SVG geometry is found.
7. [ ] **REQ-244:** The application shall keep imported SVG scale consistent with workpiece units.

### 12.2 DXF Import

1. [ ] **REQ-245:** The application shall import supported 2D DXF drawing entities as CNC-ready vector paths.
2. [ ] **REQ-246:** The application shall ask the user to choose drawing units when the DXF unit context is missing or ambiguous.
3. [ ] **REQ-247:** Supported DXF unit choices shall include millimeters, centimeters, inches, and meters.
4. [ ] **REQ-248:** The application shall orient imported DXF geometry consistently with the 2D workspace coordinate system.
5. [ ] **REQ-249:** The application shall warn users when a DXF file contains no supported geometry or cannot be parsed.

### 12.3 Image Import

1. [ ] **REQ-250:** The application shall import common raster image files as visual references.
2. [ ] **REQ-251:** Supported image formats shall include PNG and JPEG.
3. [ ] **REQ-252:** Imported images shall be represented in the project tree so they can be selected, moved, hidden, shown, and deleted.
4. [ ] **REQ-253:** Imported images shall remain local to the browser.
5. [ ] **REQ-254:** The application should support image tracing to create vector geometry from raster artwork when the tracing dependency is available.

### 12.4 STL Import

1. [ ] **REQ-255:** The application shall import binary and ASCII STL files for 3D model workflows.
2. [ ] **REQ-256:** Imported STL models shall be positioned on the workpiece and represented by a selectable 2D bounding path.
3. [ ] **REQ-257:** Users shall be able to move, scale, hide, show, and delete imported STL models through the same object management workflows used for 2D paths where practical.
4. [ ] **REQ-258:** STL models shall appear in the 3D view and may appear as a height-map overlay in the 2D view.
5. [ ] **REQ-259:** STL model data shall be included in project saves and restored on project load.
6. [ ] **REQ-260:** The application shall warn users when an STL file cannot be parsed.

### 12.5 G-Code Import

1. [ ] **REQ-261:** The application shall import existing G-code files for viewing and simulation.
2. [ ] **REQ-262:** Supported import extensions shall include `.gcode`, `.nc`, `.ngc`, and `.tap`.
3. [ ] **REQ-263:** Imported G-code shall be shown in the G-code viewer.
4. [ ] **REQ-264:** Imported G-code shall be usable in the 2D and 3D simulation views where the parser can understand the motion commands.
5. [ ] **REQ-265:** Imported G-code shall not require a project’s generated toolpaths to be present.

## 13. User Interface and Workspace Requirements

### 13.1 Application Shell

1. [ ] **REQ-266:** The application shall provide a top toolbar for new project, open project, save project, import file, export G-code, undo, redo, snap toggle, options, and help.
2. [ ] **REQ-267:** The application shall provide a left sidebar with tabs for drawing tools, machining operations, and project paths.
3. [ ] **REQ-268:** The application shall provide main workspace tabs for 2D view, 3D view, and tool library.
4. [ ] **REQ-269:** The application shall show a project name indicator in the workspace.
5. [ ] **REQ-270:** The application shall show a status bar with the current mode and application version.
6. [ ] **REQ-271:** The application shall allow the sidebar width to be resized.
7. [ ] **REQ-272:** The application shall use recognizable icons and tooltips for major commands.
8. [ ] **REQ-273:** The application shall notify users about successful actions, warnings, errors, and invalid operation choices.

### 13.2 Sidebar and Project Tree

1. [ ] **REQ-274:** The application shall list imported and created design paths in a project tree.
2. [ ] **REQ-275:** The application shall list generated toolpaths in a separate project tree section grouped by cutting tool.
3. [ ] **REQ-276:** The application shall support collapsible groups for logical path collections such as imported SVG groups, text groups, pattern groups, and tool folders.
4. [ ] **REQ-277:** The project tree shall allow users to select items, toggle visibility, rename applicable items, delete items, and open relevant properties.
5. [ ] **REQ-278:** The project tree shall provide context menu actions for groups and toolpath folders, including show all, hide all, delete group contents, and reorder where applicable.
6. [ ] **REQ-279:** Toolpath order in the tree shall define machining/export order.
7. [ ] **REQ-280:** The application shall keep tree selection and canvas selection synchronized.

### 13.3 Properties Panels

1. [ ] **REQ-281:** The application shall show contextual properties for the active drawing tool or machining operation.
2. [ ] **REQ-282:** The application shall show edit properties for selected objects that were created by editable tools.
3. [ ] **REQ-283:** The application shall show editable settings for an existing toolpath when the user opens a toolpath for editing.
4. [ ] **REQ-284:** Properties panels shall validate required fields before applying changes.
5. [ ] **REQ-285:** Properties panels shall remember recent/default values for repeated operation use.
6. [ ] **REQ-286:** Properties panels shall use appropriate controls for dimensions, numbers, text, choices, checkboxes, radio options, and larger text templates.
7. [ ] **REQ-287:** Unit-aware fields shall display values in the user’s selected display unit while preserving consistent CNC output units.

### 13.4 Help and Guidance

1. [ ] **REQ-288:** The application shall provide a general help modal covering the main workflow, mouse controls, keyboard shortcuts, tips, and advanced post-processor behavior.
2. [ ] **REQ-289:** The application shall provide contextual step-by-step guidance for tools and operations.
3. [ ] **REQ-290:** Contextual help shall update when the active operation changes.
4. [ ] **REQ-291:** Users shall be able to navigate help steps forward, backward, and reset to the first step.
5. [ ] **REQ-292:** The application shall allow tooltips to be enabled or disabled through options.

### 13.5 Keyboard and Mouse Shortcuts

1. [ ] **REQ-293:** The application shall support undo with Ctrl/Cmd+Z.
2. [ ] **REQ-294:** The application shall support redo with Ctrl/Cmd+Y and Ctrl/Cmd+Shift+Z.
3. [ ] **REQ-295:** The application shall support save project with Ctrl/Cmd+S.
4. [ ] **REQ-296:** The application shall support import/open with Ctrl/Cmd+O.
5. [ ] **REQ-297:** The application shall support paste/duplicate with Ctrl/Cmd+V when paths are selected.
6. [ ] **REQ-298:** The application shall support deleting selected objects with Delete or Backspace.
7. [ ] **REQ-299:** The application shall support snap-to-grid toggling with the S key.
8. [ ] **REQ-300:** Keyboard shortcuts shall not trigger while the user is typing in inputs, textareas, or select controls.
9. [ ] **REQ-301:** Mouse wheel shall zoom the 2D workspace.
10. [ ] **REQ-302:** Middle mouse drag shall pan the 2D workspace.

## 14. Options and Persistence Requirements

1. [ ] **REQ-303:** The application shall persist user options locally in the browser.
2. [ ] **REQ-304:** Options shall include display unit, safe height, toolpath tolerance, Z backlash compensation, table travel limits, automatic feed-rate behavior, minimum and maximum feed rates, tooltip enablement, grid display, origin display, grid size, snap-to-grid, workpiece display, workpiece dimensions, workpiece origin position, and material/wood species.
3. [ ] **REQ-305:** The application shall provide an options dialog for editing non-hidden application options.
4. [ ] **REQ-306:** The application shall provide a reset-to-defaults flow with confirmation before changing existing option values.
5. [ ] **REQ-307:** The application shall apply option changes to the active workspace without requiring a page reload where practical.
6. [ ] **REQ-308:** Local persistence shall include tools, options, G-code profiles, current selected G-code profile, and reusable operation defaults.
7. [ ] **REQ-309:** New projects shall reset project geometry and toolpaths while restoring persisted user preferences and tool library defaults.

## 15. Data Safety, Validation, and Error Handling Requirements

1. [ ] **REQ-310:** The application shall keep all core user data local to the browser unless the user explicitly invokes an external AI service.
2. [ ] **REQ-311:** The application shall not hard-code third-party API keys.
3. [ ] **REQ-312:** The application shall prevent destructive actions such as deleting tools, G-code profiles, or grouped paths without appropriate confirmation where data loss is likely.
4. [ ] **REQ-313:** The application shall prevent deletion of the final remaining cutting tool.
5. [ ] **REQ-314:** The application shall prevent deletion of the final remaining G-code profile.
6. [ ] **REQ-315:** The application shall validate toolpath inputs before generation and show actionable error messages.
7. [ ] **REQ-316:** The application shall warn users when an operation requires a selected path, selected STL model, selected point, compatible tool, or closed geometry and that requirement is not met.
8. [ ] **REQ-317:** The application shall warn users when export or simulation cannot proceed because no G-code or toolpaths are available.
9. [ ] **REQ-318:** The application shall preserve undo/redo history for geometry and toolpath editing actions where practical.
10. [ ] **REQ-319:** The application shall avoid silently losing imported files, selected geometry, or tool settings during project save/load, undo/redo, and new-project flows.

## 16. Performance Requirements

1. [ ] **REQ-320:** The application shall remain responsive while editing practical hobby-CNC projects with many vector paths and generated toolpaths.
2. [ ] **REQ-321:** The application shall avoid rendering all G-code lines into the DOM at once for large files.
3. [ ] **REQ-322:** The application shall support large G-code simulation by precomputing or caching motion data where practical.
4. [ ] **REQ-323:** The application shall keep 2D canvas redraws responsive during panning, zooming, selection, and toolpath display.
5. [ ] **REQ-324:** The 3D material-removal simulation shall adapt voxel detail or update frequency to preserve interactive performance.
6. [ ] **REQ-325:** Long-running imports, AI generation, STL processing, and toolpath generation shall provide feedback or fail gracefully.
7. [ ] **REQ-326:** The application should avoid blocking the browser for extended periods during complex pocketing, V-carving, STL slicing, or 3D simulation setup.

## 17. Additional Requirements for Missing or Incomplete Functionality

These requirements describe product behavior that is implied by the app’s goals but appears missing, incomplete, or not consistently covered by the current code.

### 17.1 Safety and Machine Setup

1. [ ] **REQ-327:** The application should provide an explicit pre-export checklist for origin, units, safe height, material thickness, selected post processor, and visible toolpaths.
2. [ ] **REQ-328:** The application should show a clear warning that simulation is not a substitute for dry runs and machine-specific validation.
3. [ ] **REQ-329:** The application should provide a configurable retract height and optional parking position per machine profile.
4. [ ] **REQ-330:** The application should support unit mismatch warnings when display units, imported file units, and G-code profile units differ.
5. [ ] **REQ-331:** The application should warn when a requested cut depth exceeds workpiece thickness unless the user explicitly acknowledges through-cut behavior.

### 17.2 Toolpath Quality and Diagnostics

1. [ ] **REQ-332:** The application should detect and report open paths used with operations that require closed boundaries.
2. [ ] **REQ-333:** The application should detect self-intersections, duplicate points, tiny segments, invalid offsets, and other geometry issues that can produce unreliable toolpaths.
3. [ ] **REQ-334:** The application should visually mark geometry that failed toolpath generation.
4. [ ] **REQ-335:** The application should show a toolpath summary before export, including operation count, tool changes, estimated run time, min/max XYZ extents, and deepest cut.
5. [ ] **REQ-336:** The application should provide warnings for feed, speed, step-down, and stepover values outside typical ranges for the selected tool and material.
6. [ ] **REQ-337:** The application should support explicit roughing and finishing passes for profile, pocket, and 3D workflows.

### 17.3 Project Recovery and Portability

1. [ ] **REQ-338:** The application should autosave recoverable project state locally.
2. [ ] **REQ-339:** The application should prompt users to recover unsaved work after a browser crash or accidental reload.
3. [ ] **REQ-340:** Project files should include a schema version so future versions can migrate old project data.
4. [ ] **REQ-341:** Project load should validate the file structure and report incompatible or corrupted project files with actionable messages.
5. [ ] **REQ-342:** The application should support exporting a self-contained project package that includes referenced raster images, imported STL data, and optionally imported G-code used for inspection.
6. [ ] **REQ-343:** The application should preserve imported G-code in saved projects when the user has loaded G-code for inspection or simulation.

### 17.4 Accessibility and Responsive Use

1. [ ] **REQ-344:** The application should be usable on common laptop and desktop screen sizes without overlapping panels or inaccessible controls.
2. [ ] **REQ-345:** The application should provide keyboard-accessible commands for major toolbar and sidebar actions.
3. [ ] **REQ-346:** The application should provide accessible labels for icon-only buttons and canvas-adjacent controls.
4. [ ] **REQ-347:** The application should preserve readable contrast for selected geometry, toolpaths, warnings, and 3D controls.
5. [ ] **REQ-348:** The application should provide touch-friendly controls for tablet workflows beyond basic canvas pan, zoom, and tap interactions.

### 17.5 Testing and Acceptance

1. [ ] **REQ-349:** The application should include a manual acceptance test suite using sample SVG, DXF, STL, image, and G-code files.
2. [ ] **REQ-350:** Acceptance tests should verify project save/load round trips for all supported object types.
3. [ ] **REQ-351:** Acceptance tests should verify that generated G-code respects selected units, origin position, safe height, post-processor templates, tool order, and hidden toolpaths.
4. [ ] **REQ-352:** Acceptance tests should verify that 2D and 3D simulations can start, pause, seek, and stop without corrupting project state.
5. [ ] **REQ-353:** Acceptance tests should verify that editing source geometry regenerates or invalidates dependent toolpaths in a user-visible way.
