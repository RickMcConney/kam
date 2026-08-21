// The clock designer.
//
// Everything mechanical is in shapes/clockTrain.ts; this panel is the numbers a
// clockmaker actually dials in, the readouts that say what came of them, and the
// button that lays the parts out on the stock.
//
// The one design decision worth restating here: it emits FIVE INDEPENDENT
// SHAPES, one chip each, not a single "clock" shape. A wheel's bore, hub, spoke
// count, backlash and markings are all things a maker changes per wheel once the
// train is settled, and a shape is one set of parameters. So the clock passes
// each wheel only what the train forces on it — its tooth count, the pins of the
// pinion it drives, the module and the cycloidal profile — and takes everything
// else from the user's own Gear and Escapement defaults. After the click there
// is no clock left in the document, only five ordinary shapes that happen to
// mesh, each editable through its own chip in the usual way.

import { useEffect, useMemo, useState } from 'react'
import { Clock, Info } from 'lucide-react'
import { ICON } from '../../theme'
import { useUIStore } from '../../store/uiStore'
import { usePathsStore } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { regenerateAffectedMany } from '../../cam/regenerate'
import { generateShapeParts, translateShapeParams } from '../../shapes/shapeGenerators'
import { loadFont, SINGLE_LINE_FONT_FAMILY } from '../../shapes/textGenerator'
import {
  DEFAULT_CLOCK_SPEC, designClock, layoutClock,
  type ClockPart, type ClockPartParams, type ClockSpec,
} from '../../shapes/clockTrain'
import { nextPathColor, type ImportedPath } from '../../importers/svgImporter'
import { uid } from '../../uid'
import { NumInput, PlainInput, Check, noteCls } from './shared'
import { clockReadout } from '../clockReadout'
import { TONE_BTN } from '../readout'

const LS_CLOCK_KEY = 'kam:clockSpec'

// Margin from the stock edge, and daylight between parts. Both generous: these
// are big wheels, and a clock that lands overlapping its own stock edge is more
// annoying to fix than one that needs nudging in.
// Kept off the stock edges when deciding how wide a row may get, and daylight
// between parts. The block itself is centred, so the margin only decides where
// rows wrap.
const MARGIN = 10
const GAP = 12

export default function ClockPanel() {
  const setClockPanelOpen = useUIStore((s) => s.setClockPanelOpen)
  const clockInfoOpen = useUIStore((s) => s.clockInfoOpen)
  const setClockInfoOpen = useUIStore((s) => s.setClockInfoOpen)
  const shapeToolConfig = useUIStore((s) => s.shapeToolConfig)
  const showStatus = useUIStore((s) => s.showStatus)
  // Set when a clock chip was clicked: the panel then REWRITES that clock's
  // parts rather than emitting a second one, which is what lets a beat or a
  // tooth count be tried without starting the project over.
  const clockEditId = useUIStore((s) => s.clockEditId)
  // Both previews are addressed by a PATH — the canvas layers pick the clock up
  // from whichever path they are handed — so any part of this clock will do.
  // The RUNNING test is keyed on the CLOCK rather than on that path, so the
  // buttons say Stop for a clock already running whichever of its parts was
  // handed over. Selectors return primitives: a fresh object or function from a
  // zustand selector compares unequal every render.
  const clockAnimPathId = useUIStore((s) => s.clockAnimPathId)
  const clockLinkPathId = useUIStore((s) => s.clockLinkPathId)
  const setClockAnim = useUIStore((s) => s.setClockAnim)
  const setClockLink = useUIStore((s) => s.setClockLink)
  const anyClockPathId = usePathsStore((s) => s.paths.find((p) => p.clockId === clockEditId)?.id ?? null)
  const animClockId = usePathsStore((s) => s.paths.find((p) => p.id === clockAnimPathId)?.clockId ?? null)
  const linkClockId = usePathsStore((s) => s.paths.find((p) => p.id === clockLinkPathId)?.clockId ?? null)
  const clockRunning = !!clockEditId && animClockId === clockEditId
  const clockArranging = !!clockEditId && linkClockId === clockEditId
  const { units, widthMM, heightMM } = useWorkpieceStore()
  const [spec, setSpec] = useState<ClockSpec>(DEFAULT_CLOCK_SPEC)
  const [reLayout, setReLayout] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // Editing an existing clock starts from ITS spec — carried by its own parts —
    // not from whatever was last typed into a fresh one.
    if (clockEditId) {
      const own = usePathsStore.getState().paths.find((p) => p.clockId === clockEditId && p.clockSpec)
      if (own?.clockSpec) { setSpec({ ...DEFAULT_CLOCK_SPEC, ...own.clockSpec }); return }
    }
    const saved = localStorage.getItem(LS_CLOCK_KEY)
    if (!saved) return
    try {
      // Merged over the defaults, so a spec saved before a field existed still
      // loads — the same rule project files follow.
      setSpec({ ...DEFAULT_CLOCK_SPEC, ...JSON.parse(saved) })
    } catch {}
  }, [clockEditId])

  const set = (patch: Partial<ClockSpec>) => {
    const next = { ...spec, ...patch }
    setSpec(next)
    // Only a NEW clock's numbers become the remembered defaults. An edit belongs
    // to that clock and is carried on its chip.
    if (!clockEditId) localStorage.setItem(LS_CLOCK_KEY, JSON.stringify(next))
  }

  // The whole design. Cheap apart from the tooth geometry, which `designClock`
  // does not touch — it only builds parameters.
  const base = useMemo(
    () => ({ gear: shapeToolConfig.gear, escapement: shapeToolConfig.escapement, pendulum: shapeToolConfig.pendulum }),
    [shapeToolConfig.gear, shapeToolConfig.escapement, shapeToolConfig.pendulum],
  )
  const design = useMemo(() => designClock(spec, base), [spec, base])

  const L = (mm: number) => fmtLen(mm, units)

  // Everything derived lives in the floating readout now; the panel keeps only
  // its TONE, for the button that stands for it.
  const readout = useMemo(
    () => clockReadout(spec, base, { widthMM, heightMM }, L),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec, base, widthMM, heightMM, units],
  )
  const problems = readout.sections.flatMap((sec) => sec.lines).filter((l) => l.tone === 'error' || l.tone === 'warn').length
  const summary = problems === 0 ? 'Numbers' : `Numbers · ${problems} to check`

  // The window follows the spec being designed, which lives here rather than in
  // any store — so it is published for the window to read, and withdrawn when
  // this panel unmounts so a stale draft cannot outlive the designer.
  const setClockDraft = useUIStore((s) => s.setClockDraft)
  useEffect(() => { setClockDraft(spec) }, [spec, setClockDraft])
  useEffect(() => () => setClockDraft(null), [setClockDraft])

  // Arranging is a canvas MODE — dragging moves link joints instead of selecting
  // — and its only way out is the button above, so it ends when this panel does.
  // Leaving it on with the panel shut would leave the canvas behaving oddly with
  // nothing on screen to explain why. The ANIMATION is left running on purpose:
  // it is a preview, it changes no interaction, and the clock's chip brings the
  // Stop button back in one click — the same way a gear's mesh preview outlives
  // the selection that started it.
  useEffect(() => () => {
    const ui = useUIStore.getState()
    if (ui.clockLinkPathId) ui.setClockLink(null)
  }, [])

  // Where a fresh clock's parts land: CENTRED on the stock, rows running right
  // and wrapping downward. Centred rather than packed into a corner because
  // these are big — an m4 48-tooth wheel is 200 mm across against a 300 mm
  // stock, so most parts take a row to themselves and a corner-anchored pack
  // comes out as a column against one edge, trailing off the bottom.
  //
  // THE STOCK'S CENTRE IN PATH SPACE IS SIMPLY (w/2, h/2). The stock rectangle
  // is drawn at x=0,y=0,w,h (WorkpieceLayer), so path space always has the stock
  // at [0,w]×[0,h] whatever the XY origin says — `originWorldXY` is a DISPLAY and
  // G-code offset, applied on the way out, and every one of its other callers is
  // an emitter or a readout. Subtracting it here moved the whole clock by −origin:
  // to the left of the stock for a corner origin, onto the lower-left corner for
  // a centred one.
  const layout = () => layoutClock(
    design.parts,
    { x: widthMM / 2, y: heightMM / 2 },
    Math.max(50, widthMM - 2 * MARGIN),
    GAP,
  )

  /** Every path of one clock part, so its whole group can be regenerated. */
  const groupOf = (pathId: string) => {
    const st = usePathsStore.getState()
    const self = st.paths.find((p) => p.id === pathId)
    if (!self) return [pathId]
    return st.paths.filter((p) => p.groupId === self.groupId && p.shapePart !== undefined).map((p) => p.id)
  }

  const emitPart = (part: ClockPart, clockId: string): string[] => {
    const geo = generateShapeParts(part.params)
    if (!geo || geo.length === 0) return []
    const groupId = uid('shape-group')
    const color = nextPathColor()
    const made: ImportedPath[] = geo.map((g) => ({
      id: uid('shape'), name: `${part.name} ${g.label}`, d: g.d,
      visible: true, color, shapeParams: part.params, shapePart: g.part,
      groupId, groupName: part.name,
      clockId, clockPart: part.key, clockSpec: spec,
    }))
    // One addPaths per part, so each wheel gets its OWN chip — that chip is then
    // what every later parameter edit on that wheel amends (updateShapeParams →
    // amendShapeGroup), exactly as a hand-drawn gear's does. One call for all of
    // them would give one chip that owns the lot.
    usePathsStore.getState().addPaths(made, { source: 'shape', label: part.name })
    return made.map((p) => p.id)
  }

  const run = async () => {
    setBusy(true)
    try {
      // A gear's tooth-count marking is set in the single-stroke face, which is
      // fetched on demand — a gear generated before it lands simply has no
      // marking part. Four wheels are worth waiting for it once.
      if (shapeToolConfig.gear.toothLabel) await loadFont(SINGLE_LINE_FONT_FAMILY)

      const { setSelectedIds, updateShapeParams } = usePathsStore.getState()
      const selected: string[] = []

      if (clockEditId) {
        // ── Rewrite an existing clock ──────────────────────────────────────
        // Each part goes through `updateShapeParams`, which regenerates its whole
        // group (adding and dropping paths as parts appear and vanish) and
        // AMENDS that part's own chip. So re-running is an argument edit to the
        // calls that made the clock, not a second clock — no chip piles up and
        // no operation loses its path.
        //
        // `laid` is computed once whether or not it is used for the parts that
        // already exist: a part that has to be ADDED has nowhere of its own to
        // stay, so it always takes a laid-out position.
        const laid = layout()
        let rebuilt = 0, added = 0
        for (let i = 0; i < design.parts.length; i++) {
          const part = design.parts[i]
          const existing = usePathsStore.getState().paths
            .find((p) => p.clockId === clockEditId && p.clockPart === part.key)
          if (!existing) {
            // Deleted, or a part this clock predates (a pendulum on a clock made
            // before there were pendulums). A new chip is the only thing an edit
            // may legitimately add.
            emitPart(laid[i], clockEditId)
            added++
            continue
          }
          // Held where it already sits unless a re-layout was asked for: a maker
          // who has arranged the parts on the stock should not lose that to a
          // spinner step.
          const old = existing.shapeParams
          const params = reLayout || !old || !('cx' in old)
            ? laid[i].params
            : translateShapeParams(part.params, old.cx, old.cy) as ClockPartParams
          updateShapeParams(existing.id, params)
          const ids = groupOf(existing.id)
          regenerateAffectedMany(ids)
          selected.push(...ids)
          rebuilt++
        }
        // Every part carries the spec, so re-running restamps all of them —
        // including parts of groups that updateShapeParams has just rewritten.
        // Not recorded: the parts' own chips already record the rebuild, and the
        // spec is a property of them rather than an edit in its own right.
        const clockPaths = usePathsStore.getState().paths.filter((p) => p.clockId === clockEditId)
        usePathsStore.getState().rewriteGeneratedRaw({
          updates: clockPaths.map((p) => ({ id: p.id, d: p.d, clockSpec: spec })),
        })
        // Selection is only meaningful for parts that were rewritten; a run that
        // rebuilt nothing left the document alone but for whatever it added.
        if (selected.length > 0) setSelectedIds(selected)
        setClockPanelOpen(false)
        showStatus(rebuilt === 0
          ? `No parts of that clock are in the document — ${added} rebuilt from scratch.`
          : `Clock updated — ${rebuilt} parts rebuilt${added > 0 ? `, ${added} added` : ''}.`)
        return
      }

      // ── A fresh clock ────────────────────────────────────────────────────
      // Links the parts back together. NOT a container: they stay ordinary
      // independent shapes and nothing regenerates through it. It exists so the
      // set can be found again — to be stood up in mesh, and to be redesigned.
      const clockId = uid('clock')
      for (const part of layout()) selected.push(...emitPart(part, clockId))
      setSelectedIds(selected)
      setClockPanelOpen(false)
      showStatus(`Clock added — ${design.parts.length} parts. Click the Clock chip to redesign it.`)
    } catch (err) {
      showStatus(`Could not build the clock: ${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-300 dark:border-neutral-700 flex-shrink-0">
        <span className="flex items-center gap-1.5 text-body font-semibold text-gray-700 dark:text-neutral-300">
          <Clock size={ICON.sm} /> {clockEditId ? 'Edit clock' : 'Clock'}
        </span>
        <button
          onClick={() => setClockPanelOpen(false)}
          className="text-gray-400 dark:text-neutral-500 hover:text-gray-700 dark:hover:text-neutral-300 text-sm leading-none"
        >
          ✕
        </button>
      </div>

      {/* Inputs only. Everything derived went to the floating readout — see
          clockReadout.ts — which is what stopped this list pushing the button
          that builds the clock off the bottom of the tab. */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <div className="space-y-1">
          <p className={noteCls + ' font-medium uppercase tracking-wider'}>Pendulum</p>
          {/* The beat is HALF a period — the number a clock is described by. */}
          <PlainInput label="Beat" value={spec.beatSeconds} unit="s" min={0.1} max={4} step={0.05}
            onChange={(beatSeconds) => set({ beatSeconds })} />
          <NumInput label="Esc teeth" valueMM={spec.escapeTeeth} units="" min={6} integer
            onChange={(t) => set({ escapeTeeth: Math.max(6, Math.round(t)) })} />
        </div>

        <div className="space-y-1">
          <p className={noteCls + ' font-medium uppercase tracking-wider'}>Going train</p>
          <NumInput label="Min pins" valueMM={spec.minPins} units="" min={6} integer
            onChange={(p) => set({ minPins: Math.max(6, Math.round(p)) })} />
          <PlainInput label="Great" value={spec.greatWheelMin} unit="min/rev" min={1} max={1440} step={1}
            onChange={(greatWheelMin) => set({ greatWheelMin })} />
          <NumInput label="Module" valueMM={spec.module} units={units} min={0.5} step={0.25}
            onChange={(module) => set({ module })} />
        </div>

        <div className="space-y-1">
          <p className={noteCls + ' font-medium uppercase tracking-wider'}>Weight drive</p>
          <PlainInput label="Run" value={spec.runHours} unit="h" min={1} max={200} step={1}
            onChange={(runHours) => set({ runHours })} />
          <NumInput label="Drop" valueMM={spec.fallMM} units={units} min={50}
            onChange={(fallMM) => set({ fallMM })} />
          <NumInput label="Drum Ø" valueMM={spec.drumDia} units={units} min={5}
            onChange={(drumDia) => set({ drumDia })} />
        </div>

        {/* One button standing for the whole readout, in the colour of its WORST
            line — so a fatal warning is visible even with the window shut, which
            is what makes moving the text out of the sidebar safe. */}
        <button
          onClick={() => setClockInfoOpen(!clockInfoOpen)}
          className={`w-full flex items-center justify-center gap-1.5 py-1 rounded border text-label transition-colors ${TONE_BTN[readout.tone]}`}
        >
          <Info size={ICON.sm} />
          {clockInfoOpen ? 'Hide numbers' : summary}
        </button>

        {/* Running the assembled clock, and folding the train to fit a plate.
            Both are questions about the WHOLE clock rather than about any one
            wheel, so they live here rather than on each wheel's properties —
            where they appeared five times over and read as five different
            animations. Only for a clock that EXISTS: there is nothing to stand
            up until it has been added. */}
        {clockEditId && <div className="space-y-1">
          <p className={noteCls + ' font-medium uppercase tracking-wider'}>Assembly</p>
          <button
            onClick={() => setClockLink(clockArranging ? null : anyClockPathId)}
            disabled={!anyClockPathId}
            className={`w-full py-1.5 rounded text-body text-white disabled:opacity-40 transition-colors ${clockArranging
              ? 'bg-red-500/80 hover:bg-red-500'
              : 'bg-amber-600/80 hover:bg-amber-600'}`}
          >
            {clockArranging ? 'Done arranging' : 'Arrange linkage'}
          </button>
          <button
            onClick={() => setClockAnim(clockRunning ? null : anyClockPathId)}
            disabled={!anyClockPathId}
            className={`w-full py-1.5 rounded text-body text-white disabled:opacity-40 transition-colors ${clockRunning
              ? 'bg-red-500/80 hover:bg-red-500'
              : 'bg-emerald-600/80 hover:bg-emerald-600'}`}
          >
            {clockRunning ? 'Stop clock' : 'Animate whole clock'}
          </button>
        </div>}

        {/* Changing the module or the tooth counts changes every wheel's size,
            so a re-layout is usually what is wanted — but a maker who has
            arranged the parts on the stock should be able to keep that. */}
        {clockEditId && <Check label="Re-lay" checked={reLayout} onChange={setReLayout} />}
        {clockEditId && <p className={noteCls}>
          {reLayout
            ? 'Parts will be laid out afresh on the stock.'
            : 'Parts stay where they are — bigger wheels may overlap.'}
        </p>}
        <button
          onClick={run}
          disabled={busy}
          className="w-full py-1.5 rounded text-body bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors"
        >
          {busy ? 'Building…' : clockEditId ? 'Update clock' : 'Add clock'}
        </button>
      </div>
    </div>
  )
}
