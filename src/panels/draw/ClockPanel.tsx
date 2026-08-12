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
import { Clock } from 'lucide-react'
import { ICON } from '../../theme'
import { useUIStore } from '../../store/uiStore'
import { usePathsStore } from '../../store/pathsStore'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { useTimelineStore } from '../../timeline/timelineStore'
import { regenerateAffectedMany } from '../../cam/regenerate'
import { generateShapeParts, translateShapeParams } from '../../shapes/shapeGenerators'
import { gearDims, pinionDims } from '../../shapes/gearGenerator'
import { escapementDims } from '../../shapes/escapementGenerator'
import { pendulumDims } from '../../shapes/pendulumGenerator'
import { loadFont, SINGLE_LINE_FONT_FAMILY } from '../../shapes/textGenerator'
import {
  DEFAULT_CLOCK_SPEC, clockPlate, clockWheelClashes, designClock, layoutClock, TRAIN_WHEELS,
  type ClockAssembly, type ClockPart, type ClockPartParams, type ClockSpec,
} from '../../shapes/clockTrain'
import { nextPathColor, type ImportedPath } from '../../importers/svgImporter'
import { uid } from '../../uid'
import { NumInput, PlainInput, Check, noteCls } from './shared'

const LS_CLOCK_KEY = 'kam:clockSpec'

// Margin from the stock edge, and daylight between parts. Both generous: these
// are big wheels, and a clock that lands overlapping its own stock edge is more
// annoying to fix than one that needs nudging in.
// Kept off the stock edges when deciding how wide a row may get, and daylight
// between parts. The block itself is centred, so the margin only decides where
// rows wrap.
const MARGIN = 10
const GAP = 12

/** Seconds as the interval a clockmaker would say out loud. */
function fmtPeriod(sec: number): string {
  if (sec < 90) return `${+sec.toFixed(2)} s`
  const min = sec / 60
  if (min < 90) return `${+min.toFixed(2)} min`
  return `${+(min / 60).toFixed(2)} h`
}

export default function ClockPanel() {
  const setClockPanelOpen = useUIStore((s) => s.setClockPanelOpen)
  const shapeToolConfig = useUIStore((s) => s.shapeToolConfig)
  const showStatus = useUIStore((s) => s.showStatus)
  // Set when a clock chip was clicked: the panel then REWRITES that clock's
  // parts rather than emitting a second one, which is what lets a beat or a
  // tooth count be tried without starting the project over.
  const clockEditId = useUIStore((s) => s.clockEditId)
  const { units, widthMM, heightMM } = useWorkpieceStore()
  const [spec, setSpec] = useState<ClockSpec>(DEFAULT_CLOCK_SPEC)
  const [reLayout, setReLayout] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // Editing an existing clock starts from ITS spec — the one recorded on its
    // chip — not from whatever was last typed into a fresh one.
    if (clockEditId) {
      const ev = useTimelineStore.getState().events.find(
        (e) => e.kind === 'clock.design' && e.clockId === clockEditId)
      if (ev && ev.kind === 'clock.design') { setSpec({ ...DEFAULT_CLOCK_SPEC, ...ev.spec }); return }
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
  const { train, drive } = design

  // Per-part numbers for the table: how big each wheel is, and how far its arbor
  // sits from the next one. Both come from the same functions the shape panels
  // read, so the table can never disagree with what is drawn.
  const rows = useMemo(() => design.parts.map((p) => {
    if (p.params.type === 'gear') {
      const g = p.params
      const d = gearDims(g.module, g.teeth, g.pressureAngle, g.backlash, { mateTeeth: g.mateTeeth, pinDia: g.pinDia })
      const pin = pinionDims(g)
      return {
        name: p.name,
        counts: `${g.teeth}t → ${g.mateTeeth} pins`,
        size: d.outsideDia,
        // Every row's spacing is from THIS arbor to the arbor of what it drives:
        // wheel pitch radius + its pinion's, which is where the pitch circles
        // come tangent.
        centre: pin?.centreDistance ?? 0,
        drives: 'to the next arbor',
        period: p.revSeconds,
      }
    }
    if (p.params.type === 'escapement') {
      const dm = escapementDims(p.params)
      return {
        name: p.name,
        counts: `${p.params.teeth}t · span ${p.params.span}`,
        size: p.params.wheelDia,
        centre: dm.centreDistance,
        drives: 'to the pallet arbor',
        period: p.revSeconds,
      }
    }
    // The pendulum is on no arbor — it HANGS from the pallet arbor — so its
    // spacing column is blank rather than a number that would read as one more
    // hole to drill.
    const pd = pendulumDims(p.params)
    return {
      name: p.name,
      counts: `${fmtLen(p.params.length, units)} long`,
      size: pd.rodLength,
      centre: 0,
      drives: 'hangs from the pallet arbor',
      period: p.revSeconds,
    }
  }), [design, units])

  const escPart = design.parts.find((p) => p.params.type === 'escapement')
  const escDims = escPart?.params.type === 'escapement' ? escapementDims(escPart.params) : null
  const pendPart = design.parts.find((p) => p.params.type === 'pendulum')
  const pendLength = pendPart?.params.type === 'pendulum' ? pendPart.params.length : 0
  const biggest = Math.max(...rows.map((r) => r.size))

  // The frame this arrangement needs — the TRAIN's extent, not the whole
  // assembly's: the pendulum is a metre long and hangs outside the plate.
  const plate = useMemo(() => clockPlate(
    design.parts.filter((p) => p.params.type !== 'pendulum') as ClockAssembly,
    spec.linkAngles,
  ), [design, spec.linkAngles])
  const clashes = plate ? clockWheelClashes(plate) : []

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
      clockId, clockPart: part.key,
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

      const tl = useTimelineStore.getState()
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
        // The chip carries the SPEC, so a new spec replaces it in place.
        if (!tl.amendClockSpec(clockEditId, spec)) {
          tl.record({ kind: 'clock.design', clockId: clockEditId, spec })
        }
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
      // Recorded BEFORE the parts, so undo reaches it only once everything it
      // led to is already gone — which is what makes a chip that replays to
      // nothing harmless. See 'clock.design' in timeline/events.ts.
      tl.record({ kind: 'clock.design', clockId, spec })
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

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* ── The pendulum, and what it forces ────────────────────────────── */}
        <div className="space-y-1">
          <p className={noteCls + ' font-medium uppercase tracking-wider'}>Pendulum</p>
          {/* The beat is HALF a period — the number a clock is described by. */}
          <PlainInput label="Beat" value={spec.beatSeconds} unit="s" min={0.1} max={4} step={0.05}
            onChange={(beatSeconds) => set({ beatSeconds })} />
          <NumInput label="Esc teeth" valueMM={spec.escapeTeeth} units="" min={6} integer
            onChange={(t) => set({ escapeTeeth: Math.max(6, Math.round(t)) })} />
          <p className={noteCls}>
            Pendulum {L(design.pendulumMM)} to the centre of oscillation
            <br />
            Escape wheel turns once every {fmtPeriod(design.escRevSeconds)}
            {escDims && <><br />Must swing past {escDims.minHalfSwingDeg.toFixed(2)}° each way to unlock</>}
            <br />
            {/* The rod is cut to the length the beat demands; the bob's size and
                the rod's width are the user's Pendulum defaults, untouched. */}
            Rod cut to {L(pendLength)}, hole to bob centre — regulate by raising the bob.
          </p>
          {/* The escapement takes the user's Escapement defaults with only its
              tooth count and span changed, and those two can break an otherwise
              fine escapement — so the fatal readouts are repeated here rather
              than left for the user to find on the chip afterwards. */}
          {escDims?.divesTooDeep && <p className="text-label text-red-400">
            Pallets dive {L(escDims.palletDive)} into the teeth and the pair will bind. Deeper teeth
            or less lock/lift in the Escapement defaults.
          </p>}
          {escDims?.noImpulse && <p className="text-label text-red-400">
            Drop uses up the whole {escDims.beatDeg.toFixed(2)}° beat at {spec.escapeTeeth} teeth — no impulse left.
          </p>}
          {escDims?.noLock && <p className="text-label text-red-400">
            Nothing left for a tooth to lock on — less clearance, or more lock, in the Escapement defaults.
          </p>}
        </div>

        {/* ── The going train ─────────────────────────────────────────────── */}
        <div className="space-y-1">
          <p className={noteCls + ' font-medium uppercase tracking-wider'}>Going train</p>
          <NumInput label="Min pins" valueMM={spec.minPins} units="" min={6} integer
            onChange={(p) => set({ minPins: Math.max(6, Math.round(p)) })} />
          <PlainInput label="Great" value={spec.greatWheelMin} unit="min/rev" min={1} max={1440} step={1}
            onChange={(greatWheelMin) => set({ greatWheelMin })} />
          <NumInput label="Module" valueMM={spec.module} units={units} min={0.5} step={0.25}
            onChange={(module) => set({ module })} />
          <p className={noteCls}>
            {TRAIN_WHEELS} wheels, {train.meshes.length} meshes at {+train.actualRatio.toFixed(4)}:1
            <br />
            {train.meshes.map((m) => `${m.teeth}/${m.pins}`).join(' · ')} · escape {spec.escapeTeeth}
          </p>
          {train.exact
            ? <p className={noteCls}>Train is exact — the rate is the pendulum&apos;s alone.</p>
            : <p className="text-label text-red-400">
                No exact train at these numbers: the hands {train.errorSecPerDay < 0 ? 'lose' : 'gain'}{' '}
                {Math.abs(train.errorSecPerDay).toFixed(1)} s a day, which no regulating will fix.
                Try a different escape tooth count or minimum pin count.
              </p>}
        </div>

        {/* ── The weight ──────────────────────────────────────────────────── */}
        <div className="space-y-1">
          <p className={noteCls + ' font-medium uppercase tracking-wider'}>Weight drive</p>
          <PlainInput label="Run" value={spec.runHours} unit="h" min={1} max={200} step={1}
            onChange={(runHours) => set({ runHours })} />
          <NumInput label="Drop" valueMM={spec.fallMM} units={units} min={50}
            onChange={(fallMM) => set({ fallMM })} />
          <NumInput label="Drum Ø" valueMM={spec.drumDia} units={units} min={5}
            onChange={(drumDia) => set({ drumDia })} />
          <p className={noteCls}>
            {drive.teeth}/{drive.pins} onto the great wheel · {drive.turns.toFixed(1)} turns of cord
            <br />
            Runs {drive.runHours.toFixed(1)} h per wind. Wind the cord on a {L(spec.drumDia)} drum on this arbor.
          </p>
          {drive.clampedSmall && <p className="text-label text-yellow-500">
            A {spec.runHours} h run wants a drive wheel smaller than its own pinion. Held at {drive.teeth} teeth,
            so it runs {drive.runHours.toFixed(1)} h — for a shorter run use a fatter drum or less drop.
          </p>}
        </div>

        {/* ── What will be cut ────────────────────────────────────────────── */}
        <div className="space-y-1">
          <p className={noteCls + ' font-medium uppercase tracking-wider'}>Parts</p>
          <table className="w-full text-label text-gray-500 dark:text-neutral-400 tabular-nums">
            <thead className="text-gray-400 dark:text-neutral-500">
              <tr>
                <th className="text-left font-normal pr-1">Part</th>
                <th className="text-left font-normal pr-1">Counts</th>
                <th className="text-right font-normal pr-1">Size</th>
                <th className="text-right font-normal pr-1">One turn</th>
                <th className="text-right font-normal">Arbor</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td className="pr-1 text-gray-700 dark:text-neutral-300">{r.name}</td>
                  <td className="pr-1">{r.counts}</td>
                  <td className="pr-1 text-right">{L(r.size)}</td>
                  <td className="pr-1 text-right">{fmtPeriod(r.period)}</td>
                  <td className="text-right" title={`Arbor to arbor, ${r.drives}`}>{L(r.centre)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={noteCls}>
            {plate && <>Frame {L(plate.bbox.maxX - plate.bbox.minX)} × {L(plate.bbox.maxY - plate.bbox.minY)} as
            arranged — select a wheel and press <em>Arrange linkage</em> to fold the train.<br /></>}
            The last column is that arbor to the next one — the escapement&apos;s is its wheel to
            the pallet arbor. Parts are laid out CLEAR of each other, never in mesh, so drill the
            plate from those spacings rather than from the drawing.
          </p>
          {clashes.length > 0 && <p className="text-label text-yellow-500">
            {clashes.length} pair{clashes.length > 1 ? 's' : ''} of non-neighbouring wheels overlap in this
            arrangement. Neighbours always do (they run at different depths); these have no reason to.
          </p>}
          {biggest > Math.min(widthMM, heightMM) && <p className="text-label text-yellow-500">
            The largest part is {L(biggest)} across on {L(widthMM)} × {L(heightMM)} stock — it will
            overhang. A smaller module, a shorter beat, or bigger stock.
          </p>}
          <p className={noteCls}>
            Wheels take your Gear defaults (bore, hub, spokes, pin Ø, backlash) and the escapement
            takes your Escapement defaults. Only the counts, module and cycloidal profile come from
            here — tweak each part afterwards through its own chip.
            <br />
            Select any wheel afterwards and press <em>Animate whole clock</em> to stand the train
            up at those spacings and run it, and click the <em>Clock</em> chip in the timeline to
            come back here and try a different beat on the same clock.
          </p>
        </div>

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
