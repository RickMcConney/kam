import { useEffect, useState } from 'react'
import { ICON } from '../../theme'
import { Square, Circle, Ellipse, Hexagon, Star as StarIcon, PenTool, Type, Squircle, Heart, Pill, Signpost, Shield, Orbit, Grid3x3, CookingPot, Cog, Cloud, Dices, ChevronDown } from 'lucide-react'
import { useUIStore } from '../../store/uiStore'
import { useWorkpieceStore, fromMM, toMM, fmtLen } from '../../store/workpieceStore'
import { spirographTurns, spirographRadii, spirographCentrePen, type ShapeType, type ShapeToolConfig } from '../../shapes/shapeGenerators'
import { mazeGrid } from '../../shapes/mazeGenerator'
import { gearDims, gearHub, gearLabel, pinionDims, pinionLabel, TOOTH_LABEL_SIZE } from '../../shapes/gearGenerator'
import { camDims } from '../../shapes/camGenerator'
import { BOARD_EDGE_LABEL, BOARD_HANDLE_LABELS, BOARD_HANDLE_HAS_INSET, BOARD_HANDLE_DEFAULTS } from '../../shapes/cuttingBoardGenerator'
import { loadFont, isFontLoaded, SINGLE_LINE_FONT_FAMILY } from '../../shapes/textGenerator'
import { PATH_COLOR } from '../../colors'
import { NumericInput } from '../../components/NumericInput'
import FontSelect from '../../components/FontSelect'


const LS_TEXT_KEY = 'kam:textConfig'

const SHAPES: { type: ShapeType; label: string; icon: React.ReactNode }[] = [
  { type: 'rectangle', label: 'Rect',    icon: <Square size={ICON.md} /> },
  { type: 'roundrect',   label: 'Round',   icon: <Squircle size={ICON.md} /> },
  { type: 'inroundrect', label: 'Sign',    icon: <Signpost size={ICON.md} /> },
  { type: 'circle',    label: 'Circle',  icon: <Circle size={ICON.md} /> },
  { type: 'ellipse',   label: 'Ellipse', icon: <Ellipse size={ICON.md} /> },
  { type: 'polygon',   label: 'Polygon', icon: <Hexagon size={ICON.md} /> },
  { type: 'star',      label: 'Star',    icon: <StarIcon size={ICON.md} /> },
  { type: 'heart',     label: 'Heart',   icon: <Heart size={ICON.md} /> },
  { type: 'slot',      label: 'Slot',    icon: <Pill size={ICON.md} /> },
  { type: 'shield',    label: 'Shield',  icon: <Shield size={ICON.md} /> },
  { type: 'spirograph', label: 'Spiro',  icon: <Orbit size={ICON.md} /> },
  { type: 'maze',      label: 'Maze',    icon: <Grid3x3 size={ICON.md} /> },
  { type: 'board',     label: 'Board',   icon: <CookingPot size={ICON.md} /> },
  { type: 'gear',      label: 'Gear',    icon: <Cog size={ICON.md} /> },
  { type: 'cam',       label: 'Cam',     icon: <Cloud size={ICON.md} /> },
]

const SHAPE_META: Record<string, { label: string; icon: React.ReactNode }> = Object.fromEntries(
  SHAPES.map((s) => [s.type, { label: s.label, icon: s.icon }])
)

const inputCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-1.5 py-0.5 text-body text-gray-800 dark:text-neutral-200 font-mono w-0'
const labelCls = 'text-gray-400 dark:text-neutral-500 text-label w-14 flex-shrink-0'

function NumInput({ label, valueMM, units, onChange, min = 0.1, step, integer }: {
  label: string; valueMM: number; units: string; onChange: (mm: number) => void
  min?: number; step?: number; integer?: boolean
}) {
  const display = integer ? valueMM : fromMM(valueMM, units as 'mm' | 'in')
  const s = step ?? (integer ? 1 : units === 'in' ? 0.0625 : 1)

  return (
    <div className="flex items-center gap-1.5">
      <span className={labelCls}>{label}</span>
      <NumericInput
        value={display}
        min={min}
        step={s}
        integer={integer}
        unit={integer ? undefined : units}
        onChange={(v) => onChange(integer ? v : toMM(v, units as 'mm' | 'in'))}
        className={inputCls}
      />
    </div>
  )
}

const selectCls = inputCls + ' cursor-pointer'

function Select<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: [T, string][]; onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={labelCls}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className={selectCls}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  )
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 cursor-pointer">
      <span className={labelCls}>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="accent-blue-500 w-3.5 h-3.5" />
    </label>
  )
}

function ShapeConfig({ type, config, onChange, units }: {
  type: ShapeType; config: ShapeToolConfig; onChange: (c: ShapeToolConfig) => void; units: string
}) {
  const c = config
  const u = units

  switch (type) {
    case 'rectangle':
      return (<div className="space-y-1">
        <NumInput label="Width"  valueMM={c.rectangle.w} units={u} onChange={(w) => onChange({ ...c, rectangle: { ...c.rectangle, w } })} />
        <NumInput label="Height" valueMM={c.rectangle.h} units={u} onChange={(h) => onChange({ ...c, rectangle: { ...c.rectangle, h } })} />
      </div>)
    case 'roundrect':
      return (<div className="space-y-1">
        <NumInput label="Width"  valueMM={c.roundrect.w} units={u} onChange={(w) => onChange({ ...c, roundrect: { ...c.roundrect, w } })} />
        <NumInput label="Height" valueMM={c.roundrect.h} units={u} onChange={(h) => onChange({ ...c, roundrect: { ...c.roundrect, h } })} />
        <NumInput label="Radius" valueMM={c.roundrect.r} units={u} min={0} onChange={(r) => onChange({ ...c, roundrect: { ...c.roundrect, r } })} />
      </div>)
    case 'inroundrect':
      return (<div className="space-y-1">
        <NumInput label="Width"  valueMM={c.inroundrect.w} units={u} onChange={(w) => onChange({ ...c, inroundrect: { ...c.inroundrect, w } })} />
        <NumInput label="Height" valueMM={c.inroundrect.h} units={u} onChange={(h) => onChange({ ...c, inroundrect: { ...c.inroundrect, h } })} />
        <NumInput label="Radius" valueMM={c.inroundrect.r} units={u} min={0} onChange={(r) => onChange({ ...c, inroundrect: { ...c.inroundrect, r } })} />
      </div>)
    case 'circle':
      return (<div className="space-y-1">
        <NumInput label="Radius" valueMM={c.circle.radius} units={u} onChange={(radius) => onChange({ ...c, circle: { radius } })} />
      </div>)
    case 'ellipse':
      return (<div className="space-y-1">
        <NumInput label="Width"  valueMM={c.ellipse.rx * 2} units={u} onChange={(w) => onChange({ ...c, ellipse: { ...c.ellipse, rx: w / 2 } })} />
        <NumInput label="Height" valueMM={c.ellipse.ry * 2} units={u} onChange={(h) => onChange({ ...c, ellipse: { ...c.ellipse, ry: h / 2 } })} />
      </div>)
    case 'polygon':
      return (<div className="space-y-1">
        <NumInput label="Radius" valueMM={c.polygon.radius} units={u} onChange={(radius) => onChange({ ...c, polygon: { ...c.polygon, radius } })} />
        <NumInput label="Sides"  valueMM={c.polygon.sides} units="" min={3} integer onChange={(sides) => onChange({ ...c, polygon: { ...c.polygon, sides: Math.max(3, Math.round(sides)) } })} />
      </div>)
    case 'star':
      return (<div className="space-y-1">
        <NumInput label="Outer R" valueMM={c.star.outerRadius} units={u} onChange={(r) => onChange({ ...c, star: { ...c.star, outerRadius: r } })} />
        <NumInput label="Inner R" valueMM={c.star.innerRadius} units={u} onChange={(r) => onChange({ ...c, star: { ...c.star, innerRadius: r } })} />
        <NumInput label="Points"  valueMM={c.star.points} units="" min={3} integer onChange={(pts) => onChange({ ...c, star: { ...c.star, points: Math.max(3, Math.round(pts)) } })} />
      </div>)
    case 'heart':
      return (<div className="space-y-1">
        <NumInput label="Radius" valueMM={c.heart.curveRadius} units={u} onChange={(curveRadius) => onChange({ ...c, heart: { ...c.heart, curveRadius } })} />
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Angle</span>
          <NumericInput
            value={c.heart.angle}
            min={1} max={179} step={5}
            onChange={(angle) => onChange({ ...c, heart: { ...c.heart, angle } })}
            className={inputCls}
          />
          <span className="text-gray-400 dark:text-neutral-500 text-label flex-shrink-0">°</span>
        </div>
      </div>)
    case 'slot':
      return (<div className="space-y-1">
        <NumInput label="Length" valueMM={c.slot.length} units={u} onChange={(length) => onChange({ ...c, slot: { ...c.slot, length: Math.max(length, c.slot.width) } })} />
        <NumInput label="Width"  valueMM={c.slot.width}  units={u} onChange={(width)  => onChange({ ...c, slot: { ...c.slot, width: Math.min(width, c.slot.length) } })} />
      </div>)
    case 'shield':
      return (<div className="space-y-1">
        <NumInput label="Width"  valueMM={c.shield.w} units={u} onChange={(w) => onChange({ ...c, shield: { ...c.shield, w } })} />
        <NumInput label="Height" valueMM={c.shield.h} units={u} onChange={(h) => onChange({ ...c, shield: { ...c.shield, h } })} />
      </div>)
    case 'spirograph': {
      const { radius, ratio, p } = c.spirograph
      const { R, r } = spirographRadii(radius, ratio, p)
      return (<div className="space-y-1">
        <NumInput label="Radius" valueMM={radius} units={u}
          onChange={(radius) => onChange({ ...c, spirograph: { ...c.spirograph, radius } })} />
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Ratio R/r</span>
          <NumericInput value={ratio} min={1.01} max={50} step={0.05}
            onChange={(ratio) => onChange({ ...c, spirograph: { ...c.spirograph, ratio, p: Math.min(p, ratio) } })}
            className={inputCls} />
        </div>
        {/* max = ratio leaves headroom past spirographCentrePen(ratio) — where the
            curve fills right to the middle — without much dead travel beyond it,
            since the hole re-opens on the far side. */}
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Pen p</span>
          <input
            type="range" min={0} max={ratio} step={0.01} value={p}
            onChange={(e) => onChange({ ...c, spirograph: { ...c.spirograph, p: parseFloat(e.target.value) } })}
            className="flex-1 w-0 accent-blue-500"
          />
          <span className="text-gray-500 dark:text-neutral-400 text-label font-mono tabular-nums w-8 text-right flex-shrink-0">{p.toFixed(2)}</span>
        </div>
        <p className="text-label text-gray-400 dark:text-neutral-500">
          Ring {fmtLen(R, u as 'mm' | 'in')} / wheel {fmtLen(r, u as 'mm' | 'in')}
          <br />
          {spirographTurns(ratio)} turns · centre at p {spirographCentrePen(ratio).toFixed(2)}
        </p>
      </div>)
    }
    case 'maze': {
      const { w, h, spacing, corner, seed, loops } = c.maze
      const g = mazeGrid(w, h, spacing)
      const set = (patch: Partial<ShapeToolConfig['maze']>) => onChange({ ...c, maze: { ...c.maze, ...patch } })
      return (<div className="space-y-1">
        <NumInput label="Width"   valueMM={w} units={u} onChange={(w) => set({ w })} />
        <NumInput label="Height"  valueMM={h} units={u} onChange={(h) => set({ h })} />
        <NumInput label="Spacing" valueMM={spacing} units={u} onChange={(spacing) => set({ spacing })} />
        <NumInput label="Corner"  valueMM={corner} units={u} min={0} onChange={(corner) => set({ corner })} />
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Seed</span>
          <NumericInput value={seed} min={1} max={999999} step={1} integer
            onChange={(seed) => set({ seed: Math.max(1, Math.round(seed)) })}
            className={inputCls} />
          <button
            onClick={() => set({ seed: 1 + Math.floor(Math.random() * 999999) })}
            title="New maze"
            className="p-1 rounded text-gray-400 dark:text-neutral-500 hover:text-gray-700 dark:hover:text-neutral-200 hover:bg-gray-200/70 dark:hover:bg-neutral-700 flex-shrink-0"
          >
            <Dices size={ICON.sm} />
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Loops</span>
          <input type="range" min={0} max={1} step={0.05} value={loops}
            onChange={(e) => set({ loops: parseFloat(e.target.value) })}
            className="flex-1 w-0 accent-blue-500" />
          <span className="text-gray-500 dark:text-neutral-400 text-label font-mono tabular-nums w-8 text-right flex-shrink-0">{Math.round(loops * 100)}%</span>
        </div>
        {/* The pitch is what the walls are actually left at — it rounds up from
            Spacing to fit whole cells, so show it rather than the request. */}
        <p className="text-label text-gray-400 dark:text-neutral-500">
          {g.cols} × {g.rows} cells · pitch {fmtLen(g.dx, u as 'mm' | 'in')} × {fmtLen(g.dy, u as 'mm' | 'in')}
          <br />
          Wall = pitch − cutter Ø
        </p>
      </div>)
    }
    case 'board': {
      const b = c.board
      const set = (patch: Partial<ShapeToolConfig['board']>) => onChange({ ...c, board: { ...c.board, ...patch } })
      const edgeLabel = BOARD_EDGE_LABEL[b.shape]
      const handleLabels = BOARD_HANDLE_LABELS[b.handle]
      return (<div className="space-y-1">
        <Select label="Shape" value={b.shape}
          options={[['rect', 'Rectangle'], ['oval', 'Oval'], ['barrel', 'Barrel']]}
          onChange={(shape) => set({ shape })} />
        <NumInput label="Width"  valueMM={b.w} units={u} onChange={(w) => set({ w })} />
        <NumInput label="Height" valueMM={b.h} units={u} onChange={(h) => set({ h })} />
        {edgeLabel && <NumInput label={edgeLabel} valueMM={b.corner} units={u} min={0} onChange={(corner) => set({ corner })} />}
        <Select label="Handle" value={b.handle}
          options={[['none', 'None'], ['paddle', 'Paddle'], ['grips', 'Side slots'], ['slot', 'End slot']]}
          onChange={(handle) => set({ handle, ...BOARD_HANDLE_DEFAULTS[handle] })} />
        {handleLabels && (<>
          <NumInput label={handleLabels[0]} valueMM={b.handleW} units={u} onChange={(handleW) => set({ handleW })} />
          <NumInput label={handleLabels[1]} valueMM={b.handleL} units={u} onChange={(handleL) => set({ handleL })} />
        </>)}
        {BOARD_HANDLE_HAS_INSET[b.handle] &&
          <NumInput label="Edge gap" valueMM={b.handleInset} units={u} onChange={(handleInset) => set({ handleInset })} />}
        {/* A hand slot IS the hole, so a hanging hole would just be a second one
            competing for the same end of the board. */}
        {!BOARD_HANDLE_HAS_INSET[b.handle] && (<>
          <Check label="Hole" checked={b.hole} onChange={(hole) => set({ hole })} />
          {b.hole && <NumInput label="Hole Ø" valueMM={b.holeDia} units={u} onChange={(holeDia) => set({ holeDia })} />}
        </>)}
        <Check label="Groove" checked={b.groove} onChange={(groove) => set({ groove })} />
        {b.groove && <NumInput label="Inset" valueMM={b.grooveInset} units={u} onChange={(grooveInset) => set({ grooveInset })} />}
        <p className="text-label text-gray-400 dark:text-neutral-500">
          Size is the cutting field; a paddle adds to it.
          <br />
          Double-click to split outline / groove / hole.
        </p>
      </div>)
    }
    case 'gear': {
      const g = c.gear
      const set = (patch: Partial<ShapeToolConfig['gear']>) => onChange({ ...c, gear: { ...c.gear, ...patch } })
      const cyc = g.toothProfile === 'cycloidal' ? { mateTeeth: g.mateTeeth, pinDia: g.pinDia } : undefined
      const pin = pinionDims({ ...g, cx: 0, cy: 0 })
      const pinLab = pinionLabel({ ...g, cx: 0, cy: 0 })
      const d = gearDims(g.module, g.teeth, g.pressureAngle, g.backlash, cyc)
      const hub = gearHub(g.module, g.teeth, g.bore, g.hubDia, g.spokes)
      // A pin has to pass through the tooth space, or the pair cannot turn at all.
      const pinFits = !cyc || g.pinDia < d.spaceAtPitch - 0.05
      // The root was driven below the ISO dedendum to clear a fat pin.
      const rootDeepened = !!cyc && d.rootDia < g.module * (g.teeth - 2.5) - 0.01
      const L = (mm: number) => fmtLen(mm, u as 'mm' | 'in')
      // The marking runs out along the right-hand spoke at whatever size that
      // takes — ask the generator rather than restating its rules. Position is
      // irrelevant to the fit.
      const lab = gearLabel({ ...g, cx: 0, cy: 0 })
      const labFontReady = isFontLoaded(SINGLE_LINE_FONT_FAMILY)
      return (<div className="space-y-1">
        <NumInput label="Module"  valueMM={g.module} units={u} min={0.05} onChange={(module) => set({ module })} />
        <NumInput label="Teeth"   valueMM={g.teeth} units="" min={4} integer onChange={(teeth) => set({ teeth: Math.max(4, Math.round(teeth)) })} />
        <Select label="Profile" value={g.toothProfile}
          options={[['involute', 'Involute'], ['cycloidal', 'Cycloidal (clock)']]}
          onChange={(toothProfile) => set({ toothProfile })} />
        {/* A cycloidal face is cut for ONE mate — the describing circle comes from
            the pinion's pitch circle — so the pinion is a parameter of the wheel,
            not a separate design. Pressure angle has no meaning here: it varies
            through a cycloidal mesh, so the field goes away with the profile. */}
        {cyc ? (<>
          <NumInput label="Pins"   valueMM={g.mateTeeth} units="" min={2} integer onChange={(mateTeeth) => set({ mateTeeth: Math.max(2, Math.round(mateTeeth)) })} />
          <NumInput label="Pin Ø"  valueMM={g.pinDia} units={u} min={0.1} onChange={(pinDia) => set({ pinDia })} />
          {/* The mate, drawn from these same numbers — cheek, pin holes, arbor. */}
          <Check label="Pinion" checked={g.emitPinion} onChange={(emitPinion) => set({ emitPinion })} />
        </>) : (
          <div className="flex items-center gap-1.5">
            <span className={labelCls}>Pressure</span>
            <NumericInput value={g.pressureAngle} min={5} max={35} step={0.5}
              onChange={(pressureAngle) => set({ pressureAngle })} className={inputCls} />
            <span className="text-gray-400 dark:text-neutral-500 text-label flex-shrink-0">°</span>
          </div>
        )}
        <NumInput label="Bore Ø"  valueMM={g.bore} units={u} min={0} onChange={(bore) => set({ bore })} />
        {/* A floor, not a fixed size — it grows to seat the spokes. */}
        <NumInput label="Hub Ø"   valueMM={g.hubDia} units={u} min={0} onChange={(hubDia) => set({ hubDia })} />
        <NumInput label="Spokes"  valueMM={g.spokes} units="" min={0} integer onChange={(spokes) => set({ spokes: Math.max(0, Math.round(spokes)) })} />
        {/* Play at the MESH, so the same figure on both gears of a pair gives
            exactly that much — each is thinned by half. */}
        <NumInput label="Backlash" valueMM={g.backlash} units={u} min={0} step={0.05} onChange={(backlash) => set({ backlash })} />
        {/* Engraved, not cut — its own path, so it takes an engrave op or gets
            deleted without touching the gear. */}
        <Check label="Count #" checked={g.toothLabel} onChange={(toothLabel) => set({ toothLabel })} />
        <Check label="Pitch ○" checked={g.pitchCircle} onChange={(pitchCircle) => set({ pitchCircle })} />
        {/* Base Ø is m·z·cos α — derived, never dialled in, so it is shown
            rather than offered as a field. */}
        <p className="text-label text-gray-400 dark:text-neutral-500">
          {cyc
            ? <>Pitch {L(d.pitchDia)} · Describing {L(d.describingDia)}</>
            : <>Pitch {L(d.pitchDia)} · Base {L(d.baseDia)}</>}
          <br />
          Outside {L(d.outsideDia)} · Root {L(d.rootDia)}
          <br />
          Meshes at centre distance {L(d.pitchDia / 2)} + partner&apos;s pitch radius
          <br />
          Tooth {L(d.toothThickness)} at pitch{g.backlash > 0 ? ` (${L(Math.PI * g.module / 2)} nominal)` : ''}
        </p>
        {hub.grown && <p className="text-label text-blue-400">Hub grown to {L(hub.dia)} to seat {g.spokes} spokes.</p>}
        {g.spokes >= 2 && !hub.spoked && (
          <p className="text-label text-yellow-500">
            {hub.maxSpokes >= 2 ? `No room for ${g.spokes} spokes — this gear takes ${hub.maxSpokes}. Cut solid.`
                                : 'No room for a spoke web on this gear — cut solid.'}
          </p>
        )}
        {g.toothLabel && lab && (lab.sizeMM < TOOTH_LABEL_SIZE - 0.05
          ? <p className="text-label text-blue-400">Engraves &ldquo;{lab.text}&rdquo; at {L(lab.sizeMM)} — all the spoke will take.</p>
          : <p className="text-label text-gray-400 dark:text-neutral-500">Engraves &ldquo;{lab.text}&rdquo; along the right-hand spoke.</p>)}
        {g.toothLabel && !lab && labFontReady &&
          <p className="text-label text-yellow-500">No room beside the bore for a legible marking — none engraved.</p>}
        {g.pitchCircle && <p className="text-label text-yellow-500">
          Pitch circle{cyc && g.emitPinion ? 's are references' : ' is a reference'} — delete {cyc && g.emitPinion ? 'them' : 'it'} before cutting.
          {cyc && g.emitPinion ? ' They run through the pin centres and are tangent at the right spacing.' : ''}
        </p>}
        {d.pointed && <p className="text-label text-yellow-500">Teeth come to a point — OD reduced.</p>}
        {!cyc && d.undercut && <p className="text-label text-yellow-500">Under {Math.ceil(2 / Math.sin((g.pressureAngle * Math.PI) / 180) ** 2)} teeth at {g.pressureAngle}° — roots cut radially, not undercut.</p>}
        {cyc && !pinFits && <p className="text-label text-red-400">
          Ø{L(g.pinDia)} pins cannot pass a {L(d.spaceAtPitch)} tooth space — this pair will not turn. Smaller pins, or more module.
        </p>}
        {rootDeepened && <p className="text-label text-blue-400">Root cut to {L(d.rootDia)} to clear the pins.</p>}
        {cyc && <p className="text-label text-gray-400 dark:text-neutral-500">
          Faces cut for this {g.mateTeeth}-pin lantern pinion at Ø{L(g.pinDia)} — another pinion wants another wheel.
        </p>}
        {cyc && g.emitPinion && pin && <p className="text-label text-gray-400 dark:text-neutral-500">
          Pinion: cheek {L(pin.cheekDia)} · pins on {L(pin.pinCircleDia)}
          <br />
          Cut TWO cheeks — the wheel runs between them, so it must be thinner than their gap.
          <br />
          {/* The question this answers: the pinion's own radius for layout is arbor
              to pin CENTRE, i.e. half the pin circle — not the cheek. */}
          Arbors sit {L(pin.centreDistance)} apart: {L(d.pitchDia / 2)} wheel pitch radius + {L(pin.pinCircleDia / 2)} arbor-to-pin-centre. Drawn clear, not at that spacing.
          {g.toothLabel && pinLab && <><br />Cheek engraves &ldquo;{pinLab.text}&rdquo; — add it to the wheel&apos;s to get that spacing.</>}
        </p>}
        {cyc && g.emitPinion && pin && pin.pinGap < 1 && <p className="text-label text-yellow-500">
          Only {L(Math.max(0, pin.pinGap))} of wood between pin holes — fewer pins, or thinner ones.
        </p>}
      </div>)
    }
    case 'cam': {
      const m = c.cam
      const set = (patch: Partial<ShapeToolConfig['cam']>) => onChange({ ...c, cam: { ...c.cam, ...patch } })
      const dm = camDims({ ...m, cx: 0, cy: 0 })
      const L = (mm: number) => fmtLen(mm, u as 'mm' | 'in')
      return (<div className="space-y-1">
        <NumInput label="Base Ø"  valueMM={m.baseDia} units={u} min={1} onChange={(baseDia) => set({ baseDia })} />
        {/* The rise per REVOLUTION sets the spiral's slope; what this cam can
            actually lift is that × sweep/360, which the readout gives. */}
        <NumInput label="Rise/rev" valueMM={m.riseMM} units={u} min={0.1} onChange={(riseMM) => set({ riseMM })} />
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Sweep</span>
          <NumericInput value={m.sweepDeg} min={5} max={360} step={5}
            onChange={(sweepDeg) => set({ sweepDeg })} className={inputCls} />
          <span className="text-gray-400 dark:text-neutral-500 text-label flex-shrink-0">°</span>
        </div>
        <NumInput label="Bore Ø"  valueMM={m.boreDia} units={u} min={0} onChange={(boreDia) => set({ boreDia })} />
        <NumInput label="Lever"   valueMM={m.handleLength} units={u} min={1} onChange={(handleLength) => set({ handleLength })} />
        <NumInput label="Lever W" valueMM={m.handleWidth} units={u} min={0.5} onChange={(handleWidth) => set({ handleWidth })} />
        <p className="text-label text-gray-400 dark:text-neutral-500">
          Stroke {L(dm.usableStroke)} over {m.sweepDeg}° · {L(dm.liftPerDeg)}/°
          <br />
          Base {L(dm.baseDia)} → crest {L(dm.maxDia)}
          <br />
          Pressure angle {dm.pressureAngleDeg.toFixed(1)}° at the base, {dm.pressureAngleAtCrestDeg.toFixed(1)}° at the crest
          <br />
          Double-click to split outline / bore.
        </p>
        {/* Friction is what holds a cam: tan φ under µ, and wood on wood is µ≈0.3
            (17°). Past 10° there is no margin left for a clamp. */}
        {dm.wontHold && <p className="text-label text-yellow-500">
          {dm.pressureAngleDeg.toFixed(1)}° at the base circle — friction may not hold it. Bigger base Ø, or less rise.
        </p>}
        {dm.handleTooShort && <p className="text-label text-yellow-500">
          Lever is inside the crest ({L(dm.maxDia / 2)}) — no leverage. Make it longer.
        </p>}
      </div>)
    }
    case 'text':
      return (<div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Text</span>
          <input type="text" value={c.text.text} placeholder="Enter text…"
            onChange={(e) => onChange({ ...c, text: { ...c.text, text: e.target.value } })}
            className={inputCls} />
        </div>
        <NumInput label="Size" valueMM={c.text.fontSize} units={u} min={0.1} onChange={(fontSize) => onChange({ ...c, text: { ...c.text, fontSize } })} />
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Font</span>
          <FontSelect
            value={c.text.fontFamily}
            previewText={c.text.text}
            onChange={(family) => onChange({ ...c, text: { ...c.text, fontFamily: family } })}
            className="flex-1 w-0"
          />
        </div>
      </div>)
  }
}

const toolBtnCls = (active: boolean) =>
  [
    'flex flex-col items-center gap-0.5 py-1.5 rounded text-body transition-colors border',
    active
      ? 'border-blue-500 bg-blue-500/20'
      : 'border-gray-400 dark:border-neutral-600 hover:bg-gray-100 dark:hover:bg-neutral-700',
  ].join(' ')


// ─── Main ShapePanel ──────────────────────────────────────────────────────────

export default function ShapePanel({ fill = false }: { fill?: boolean }) {
  const { activeTool, setActiveTool, shapeToolConfig, setShapeToolConfig, setShapesPanelOpen, penCurveType, setPenCurveType, lastShapeType, setLastShapeType } = useUIStore()
  const { units } = useWorkpieceStore()
  const isShapeTool = SHAPES.some((s) => s.type === activeTool)
  const lastShape = SHAPE_META[lastShapeType] ?? SHAPE_META.rectangle

  const [fontReady, setFontReady] = useState(() => isFontLoaded(shapeToolConfig.text.fontFamily))

  useEffect(() => {
    if (activeTool !== 'text') return
    const family = shapeToolConfig.text.fontFamily
    if (isFontLoaded(family)) { setFontReady(true); return }
    setFontReady(false)
    loadFont(family).then(() => setFontReady(true))
  }, [activeTool, shapeToolConfig.text.fontFamily])

  useEffect(() => { loadFont(shapeToolConfig.text.fontFamily) }, [shapeToolConfig.text.fontFamily])

  // A gear's tooth-count number is set in the single-stroke face, so it has to be
  // in hand before one is drawn — and this panel's fit readout needs a re-render
  // once it is.
  const [countFontReady, setCountFontReady] = useState(() => isFontLoaded(SINGLE_LINE_FONT_FAMILY))
  useEffect(() => {
    if (activeTool !== 'gear' || countFontReady) return
    loadFont(SINGLE_LINE_FONT_FAMILY).then(() => setCountFontReady(true))
  }, [activeTool, countFontReady])

  // Load saved text config on mount
  useEffect(() => {
    const saved = localStorage.getItem(LS_TEXT_KEY)
    if (!saved) return
    try {
      const parsed = JSON.parse(saved)
      setShapeToolConfig({ ...shapeToolConfig, text: { ...shapeToolConfig.text, ...parsed } })
    } catch {}
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const updateConfig = (config: ShapeToolConfig) => {
    setShapeToolConfig(config)
    localStorage.setItem(LS_TEXT_KEY, JSON.stringify(config.text))
  }

  useEffect(() => {
    if (!fill) return
    setActiveTool(lastShapeType)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fill])

  // ── Full-panel shapes selector ─────────────────────────────────────────────
  if (fill) {
    return (
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-300 dark:border-neutral-700 flex-shrink-0">
          <span className="text-body font-semibold text-gray-700 dark:text-neutral-300">Shapes</span>
          <button
            onClick={() => { setShapesPanelOpen(false); if (isShapeTool) setActiveTool('select') }}
            className="text-gray-400 dark:text-neutral-500 hover:text-gray-700 dark:hover:text-neutral-300 text-sm leading-none"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {SHAPES.map(({ type, label, icon }) => (
              <button
                key={type}
                onClick={() => {
                  setActiveTool(type)
                  setLastShapeType(type)
                  setShapesPanelOpen(false)
                }}
                title={label}
                className={toolBtnCls(activeTool === type)}
              >
                <span style={{ color: PATH_COLOR }}>{icon}</span>
                <span className="text-label text-gray-500 dark:text-neutral-400">{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // ── Normal draw tool row ───────────────────────────────────────────────────
  return (
    <div className="px-3 py-2 space-y-2 border-b border-gray-300 dark:border-neutral-700">
      <p className="text-label font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider">Draw</p>
      <div className="grid grid-cols-3 gap-1">
        <button
          onClick={() => setActiveTool(activeTool === 'pen' ? 'select' : 'pen')}
          title="Pen Tool — click to add points, drag for curves"
          className={toolBtnCls(activeTool === 'pen')}
        >
          <span style={{ color: PATH_COLOR }}><PenTool size={ICON.md} /></span>
          <span className="text-label text-gray-500 dark:text-neutral-400">Pen</span>
        </button>
        <button
          onClick={() => setActiveTool(activeTool === 'text' ? 'select' : 'text')}
          title="Text Tool"
          className={toolBtnCls(activeTool === 'text')}
        >
          <span style={{ color: PATH_COLOR }}><Type size={ICON.md} /></span>
          <span className="text-label text-gray-500 dark:text-neutral-400">Text</span>
        </button>
        <div className={`relative ${toolBtnCls(isShapeTool)}`}>
          <button
            onClick={() => setActiveTool(activeTool === lastShapeType ? 'select' : lastShapeType)}
            title={`${lastShape.label} — click the chevron to pick a different shape`}
            className="flex flex-col items-center gap-0.5 w-full"
          >
            <span style={{ color: PATH_COLOR }}>{lastShape.icon}</span>
            <span className="text-label text-gray-500 dark:text-neutral-400">{lastShape.label}</span>
          </button>
          <button
            onClick={() => setShapesPanelOpen(true)}
            title="Pick a different shape"
            className="absolute top-0.5 right-0.5 p-0.5 rounded text-gray-400 dark:text-neutral-500 hover:text-gray-700 dark:hover:text-neutral-200 hover:bg-gray-200/70 dark:hover:bg-neutral-700"
          >
            <ChevronDown size={ICON.sm} />
          </button>
        </div>
      </div>

      {isShapeTool && (
        <div className="space-y-1.5 pt-0.5">
          <p className="text-label text-gray-400 dark:text-neutral-500 font-medium capitalize">{activeTool} defaults</p>
          <ShapeConfig type={activeTool as ShapeType} config={shapeToolConfig} onChange={updateConfig} units={units} />
        </div>
      )}

      {activeTool === 'text' && (
        <div className="space-y-1.5 pt-0.5">
          <p className="text-label text-gray-400 dark:text-neutral-500 font-medium">Text defaults</p>
          {!fontReady && <p className="text-label text-yellow-500">Loading font…</p>}
          <ShapeConfig type="text" config={shapeToolConfig} onChange={updateConfig} units={units} />
        </div>
      )}

      {activeTool === 'pen' && (
        <div className="space-y-1.5 pt-0.5">
          <p className="text-label text-gray-400 dark:text-neutral-500 font-medium">Curve type</p>
          <div className="grid grid-cols-3 gap-1">
            {([
              ['linear',       'Linear' ],
              ['bezier',       'Bezier' ],
              ['catmull-rom',  'C-Rom'  ],
              ['cubic-spline', 'Spline' ],
              ['arc-fit',      'Arc'    ],
            ] as const).map(([type, label]) => (
              <button
                key={type}
                onClick={() => setPenCurveType(type)}
                className={toolBtnCls(penCurveType === type)}
              >
                <span className="text-label">{label}</span>
              </button>
            ))}
          </div>
          <p className="text-label text-gray-400 dark:text-neutral-500">Alt: toggle linear / curve</p>
        </div>
      )}
    </div>
  )
}
