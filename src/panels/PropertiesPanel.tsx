import { useEffect, useMemo, useRef, useState } from 'react'
import { Dices } from 'lucide-react'
import { usePathsStore, useSelectedPaths, outerGroupOf } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { splitCompoundPath } from '../canvas/nodeUtils'
import { regenerateAffectedMany } from '../cam/regenerate'
import { useCanvasStore } from '../store/canvasStore'
import { useWorkpieceStore, fromMM, toMM } from '../store/workpieceStore'
import { getMultiBBox, applyTransformStep, placementMat, type TransformStep } from '../canvas/selectionUtils'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'
import { spirographLoops, SPIRO_RATIO_RANGE, scaleShapeParams, translateShapeParams, type ShapeParams } from '../shapes/shapeGenerators'
import { loadFont, isFontLoaded, SINGLE_LINE_FONT_FAMILY } from '../shapes/textGenerator'
import { carriedPinion, gearDims, gearHub, gearLabel, gearMesh, pinionDims, pinionLabel, TOOTH_LABEL_SIZE } from '../shapes/gearGenerator'
import { camDims } from '../shapes/camGenerator'
import type { EscapementSpec } from '../shapes/escapementGenerator'
import EscapementInfoButton from './EscapementInfoButton'
import { pendulumDims } from '../shapes/pendulumGenerator'
import { BOARD_EDGE_LABEL, BOARD_HANDLE_LABELS, BOARD_HANDLE_HAS_INSET, BOARD_HANDLE_DEFAULTS } from '../shapes/cuttingBoardGenerator'
import { NumericInput } from '../components/NumericInput'
import FontSelect from '../components/FontSelect'

const fieldCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-600 rounded px-1.5 py-0.5 text-body text-gray-800 dark:text-neutral-200 font-mono w-0 focus:outline-none focus:border-blue-500'
const labelCls = 'text-gray-400 dark:text-neutral-500 text-label w-5 flex-shrink-0'

function ReadField({ label, value, units }: { label: string; value: string; units?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={labelCls}>{label}</span>
      <span className={fieldCls + ' tabular-nums'}>{value}</span>
      {units && <span className="flex-shrink-0 text-label text-gray-400 dark:text-neutral-500 select-none">{units}</span>}
    </div>
  )
}

function EditField({
  label,
  valueMM,
  units,
  onChange,
  min = 0.001,
  integer,
}: {
  label: string
  valueMM: number
  units: string
  onChange: (mm: number) => void
  min?: number
  integer?: boolean
}) {
  const display = integer ? valueMM : fromMM(valueMM, units as 'mm' | 'in')
  const step = integer ? 1 : units === 'in' ? 0.0625 : 1

  return (
    <div className="flex items-center gap-1.5">
      <span className={labelCls}>{label}</span>
      <NumericInput
        value={display}
        min={min}
        step={step}
        integer={integer}
        unit={integer ? undefined : units}
        onChange={(v) => onChange(integer ? v : toMM(v, units as 'mm' | 'in'))}
        className={fieldCls}
      />
    </div>
  )
}

// Unitless numeric field (scale/skew ratios, angles) — bypasses EditField's
// mm/inch conversion since these values aren't lengths.
function RawField({ label, value, onChange, suffix, step = 0.01, min, max }: {
  label: string
  value: number
  onChange: (v: number) => void
  suffix?: string
  step?: number
  min?: number
  max?: number
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={labelCls}>{label}</span>
      <NumericInput value={value} min={min} max={max} step={step} unit={suffix} onChange={onChange} className={fieldCls} />
    </div>
  )
}

// The net transform, as fixed values a user can type into directly instead
// of needing to drag on canvas — dx/dy/angle/sx/sy always shown (0/0/0/1/1
// when absent). kx/ky only appear when the chip actually has shear (rare
// enough that showing it unconditionally would just be clutter), and a
// mirror flip is a separate button (see applyMirrorToChip), not a field.
//
// Each field is read from — and, when reconstructed, written back to — its
// OWN step's stored pivot (cx/cy for rotate, ax/ay for scale/skew), never a
// freshly-computed one. That's what makes the fields independent: editing
// SX only ever changes that scale step's sx, never its anchor, never the
// translate step, never the rotate step — so "dx=100, set it to 105" really
// does just move it 5mm, and doesn't ride along with whatever else changed.
// A pivot is only ever computed fresh (from `defaultPivot`/`defaultSkewPivot`
// — the selection's bbox from just BEFORE this chip started, NOT its
// current/live bbox, which would drift every time dx/dy changes) the first
// time that step kind is introduced; from then on it's whatever got stored.

// One heading per section, so "the thing" and "where it sits" read as two
// groups rather than one long column of fields. Only drawn when there IS a
// shape section — a pen path has one group and needs no label to separate it
// from nothing.
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-label font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider mt-2 mb-1">
      {children}
    </p>
  )
}

// `baseAngle` is how far the shape ALREADY stands turned — read back out of its
// placement recipe. The field used to be a pure nudge: type 10, it turned 10°
// more, and snapped back to 0, so a shape rotated 37° reported 0° and the one
// number the drawing cannot show had nowhere to be read. Now that a rotation
// spills into `placement` instead of being baked away, the angle is recoverable,
// so the field states it and a typed value is the angle to STAND AT. What it
// hands `onApply` is still the delta, which is what a transform step is.
//
// A path with no parameters has no placement and no way to know: `baseAngle` is
// 0 for it and the field behaves exactly as it always did.
function RotationField({ liveAngle, baseAngle, onApply }: { liveAngle: number | null; baseAngle: number; onApply: (deg: number) => void }) {
  const shown = String(+baseAngle.toFixed(2))
  const [text, setText] = useState(shown)
  // Guard against double-commit: Enter calls commit() then blur() which re-triggers onBlur.
  const committedRef = useRef(false)
  // Follows the shape: after a canvas rotate lands, the field must read the new
  // angle rather than whatever was last typed into it.
  useEffect(() => { setText(shown) }, [shown])

  function commit(currentText: string) {
    if (committedRef.current) return
    committedRef.current = true
    const v = parseFloat(currentText)
    if (!isNaN(v) && Math.abs(v - baseAngle) > 0.0001) onApply(v - baseAngle)
    setText(shown)
  }

  if (liveAngle !== null) {
    return <ReadField label="∠" value={(baseAngle + liveAngle).toFixed(1)} units="°" />
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className={labelCls}>∠</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(e) => { committedRef.current = false; setText(e.target.value) }}
        onFocus={(e) => { committedRef.current = false; e.target.select() }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(e.currentTarget.value); e.currentTarget.blur() }
          if (e.key === 'Escape') { committedRef.current = true; setText(shown); e.currentTarget.blur() }
          if (e.key === 'ArrowUp') { e.preventDefault(); setText(String((parseFloat(e.currentTarget.value) || 0) + 1)) }
          if (e.key === 'ArrowDown') { e.preventDefault(); setText(String((parseFloat(e.currentTarget.value) || 0) - 1)) }
        }}
        className={fieldCls}
      />
      <span className="text-gray-400 dark:text-neutral-500 text-label flex-shrink-0">°</span>
    </div>
  )
}

function ShapeParamsEditor({ id, params, units, fromCenter }: { id: string; params: ShapeParams; units: string; fromCenter?: boolean }) {
  const updateShapeParams = usePathsStore((s) => s.updateShapeParams)
  // Subscribed rather than read once, so the escapement's Animate button knows
  // to say Stop. Hooks cannot live inside the switch below.
  const meshAnimPathId = useUIStore((s) => s.meshAnimPathId)
  // Running the assembled clock and folding its linkage used to be offered here,
  // on every wheel — but both are questions about the WHOLE clock, not about the
  // wheel that happens to be selected, so five wheels each showed the same pair
  // of buttons and they read as five different animations. They live in
  // ClockPanel now, reached from the clock's own chip. The per-shape "Animate in
  // mesh" below stays: that IS a question about this wheel, against its own
  // lantern or its own anchor.
  // A multi-part shape (a gear) regenerates every path in its group, so every
  // one of their operations is stale — not just this path's. Read the paths back
  // AFTER the edit so a part that just appeared is included.
  const groupIds = () => {
    const st = usePathsStore.getState()
    const self = st.paths.find((p) => p.id === id)
    if (!self || self.shapePart === undefined) return [id]
    return st.paths.filter((p) => p.groupId === self.groupId && p.shapePart !== undefined).map((p) => p.id)
  }
  const update = (newParams: ShapeParams) => { updateShapeParams(id, newParams); regenerateAffectedMany(groupIds()) }
  // A slider fires on every pixel of the drag. The geometry update is cheap and
  // has to be live to be worth dragging, but `regenerateAffected` queues a
  // worker toolpath job per call — so the drag updates `d` only, and the
  // regenerate waits for the release.
  const updateLive = (newParams: ShapeParams) => updateShapeParams(id, newParams)
  const u = units

  // SIZE for the box-shaped params — rectangle, roundrect, inroundrect, maze,
  // board — which all state their extent as w/h. POSITION is deliberately not
  // here: it belongs to the Transform section, for every path, stated once, as
  // the centre. A rectangle used to report the low corner its params happen to
  // store, which is the right anchor only while the shape grows from a corner —
  // set to grow from its middle, its X/Y slid every time its width was typed
  // while the shape stayed put. And it disagreed with the circles and polygons
  // beside it, which have always said CX/CY.
  //
  // A plain function, not a component: a component declared inside another one
  // is a new type on every render, so React remounts it and the field being
  // typed into loses focus.
  const boxSize = <P extends ShapeParams & { x: number; y: number; w: number; h: number }>(
    p: P, set: (patch: Partial<P>) => void,
  ) => (<>
    <EditField label="W" valueMM={p.w} units={u}
      onChange={(w) => set((fromCenter ? { w, x: p.x + (p.w - w) / 2 } : { w }) as Partial<P>)} />
    <EditField label="H" valueMM={p.h} units={u}
      onChange={(h) => set((fromCenter ? { h, y: p.y + (p.h - h) / 2 } : { h }) as Partial<P>)} />
  </>)

  switch (params.type) {
    case 'rectangle':
      return (<>
        {boxSize(params, (patch) => update({ ...params, ...patch }))}
      </>)
    case 'roundrect':
    case 'inroundrect':
      return (<>
        {boxSize(params, (patch) => update({ ...params, ...patch }))}
        <EditField label="R" valueMM={params.r} units={u} onChange={(r) => update({ ...params, r })} min={0} />
      </>)
    case 'circle':
      return (<>
        <EditField label="R" valueMM={params.radius} units={u} onChange={(radius) => update({ ...params, radius })} />
      </>)
    case 'ellipse':
      return (<>
        <EditField label="RX" valueMM={params.rx} units={u} onChange={(rx) => update({ ...params, rx })} />
        <EditField label="RY" valueMM={params.ry} units={u} onChange={(ry) => update({ ...params, ry })} />
      </>)
    case 'shield':
      return (<>
        <EditField label="W"  valueMM={params.w}  units={u} onChange={(w)  => update({ ...params, w })} />
        <EditField label="H"  valueMM={params.h}  units={u} onChange={(h)  => update({ ...params, h })} />
      </>)
    case 'spirograph':
      return (<>
        <EditField label="R"     valueMM={params.radius} units={u} onChange={(radius) => update({ ...params, radius })} />
        {/* Loops and pen position both span the grid — a slider reads the pattern
            far better than typing it, and both the loop count and p = loops−1
            (centre-filling) are places you find by dragging. The ratio is a whole
            number, so every notch on the loops slider is a different rosette. */}
        <div className="col-span-2 flex items-center gap-1.5">
          <span className={labelCls}>Loops</span>
          <input
            type="range" min={SPIRO_RATIO_RANGE.min} max={SPIRO_RATIO_RANGE.max} step={1}
            value={spirographLoops(params.ratio)}
            onChange={(e) => {
              const ratio = spirographLoops(parseFloat(e.target.value))
              updateLive({ ...params, ratio, p: Math.min(params.p, ratio) })
            }}
            onPointerUp={() => regenerateAffectedMany(groupIds())}
            onKeyUp={() => regenerateAffectedMany(groupIds())}
            className="flex-1 w-0 accent-blue-500"
          />
          <span className="text-gray-500 dark:text-neutral-400 text-label font-mono tabular-nums w-8 text-right flex-shrink-0">{spirographLoops(params.ratio)}</span>
        </div>
        <div className="col-span-2 flex items-center gap-1.5">
          <span className={labelCls}>p</span>
          <input
            type="range" min={0} max={spirographLoops(params.ratio)} step={0.01} value={params.p}
            onChange={(e) => updateLive({ ...params, p: parseFloat(e.target.value) })}
            onPointerUp={() => regenerateAffectedMany(groupIds())}
            onKeyUp={() => regenerateAffectedMany(groupIds())}
            className="flex-1 w-0 accent-blue-500"
          />
          <span className="text-gray-500 dark:text-neutral-400 text-label font-mono tabular-nums w-8 text-right flex-shrink-0">{params.p.toFixed(2)}</span>
        </div>
      </>)
    case 'maze':
      return (<>
        {boxSize(params, (patch) => update({ ...params, ...patch }))}
        {/* Corridor spacing, not corridor count — the wall left standing is
            spacing − cutter diameter, so this is the field set from the bit. */}
        <EditField label="Sp" valueMM={params.spacing} units={u} onChange={(spacing) => update({ ...params, spacing })} />
        <EditField label="Cnr" valueMM={params.corner} units={u} min={0} onChange={(corner) => update({ ...params, corner })} />
        <div className="col-span-2 flex items-center gap-1.5">
          <span className={labelCls}>Sd</span>
          <NumericInput value={params.seed} min={1} max={999999} step={1} integer
            onChange={(seed) => update({ ...params, seed: Math.max(1, Math.round(seed)) })}
            className={fieldCls} />
          <button
            onClick={() => update({ ...params, seed: 1 + Math.floor(Math.random() * 999999) })}
            title="New maze"
            className="p-1 rounded text-gray-400 dark:text-neutral-500 hover:text-gray-700 dark:hover:text-neutral-200 hover:bg-gray-200/70 dark:hover:bg-neutral-700 flex-shrink-0"
          >
            <Dices size={14} />
          </button>
        </div>
        {/* Braiding reopens dead ends into loops — a drag, like the spirograph
            pen, because it is a look you find rather than a number you know. */}
        <div className="col-span-2 flex items-center gap-1.5">
          <span className={labelCls}>Lp</span>
          <input
            type="range" min={0} max={1} step={0.05} value={params.loops}
            onChange={(e) => updateLive({ ...params, loops: parseFloat(e.target.value) })}
            onPointerUp={() => regenerateAffectedMany(groupIds())}
            onKeyUp={() => regenerateAffectedMany(groupIds())}
            className="flex-1 w-0 accent-blue-500"
          />
          <span className="text-gray-500 dark:text-neutral-400 text-label font-mono tabular-nums w-8 text-right flex-shrink-0">{Math.round(params.loops * 100)}%</span>
        </div>
      </>)
    case 'board': {
      const edgeLabel = BOARD_EDGE_LABEL[params.shape]
      const handleLabels = BOARD_HANDLE_LABELS[params.handle]
      return (<>
        {boxSize(params, (patch) => update({ ...params, ...patch }))}
        <div className="col-span-2 flex items-center gap-1.5">
          <span className={labelCls}>Sh</span>
          <select value={params.shape} onChange={(e) => update({ ...params, shape: e.target.value as typeof params.shape })}
            className={fieldCls + ' cursor-pointer'}>
            <option value="rect">Rectangle</option>
            <option value="oval">Oval</option>
            <option value="barrel">Barrel</option>
          </select>
        </div>
        {edgeLabel && <EditField label={edgeLabel === 'Bow' ? 'Bow' : 'Cnr'} valueMM={params.corner} units={u} min={0} onChange={(corner) => update({ ...params, corner })} />}
        {edgeLabel && <span />}
        <div className="col-span-2 flex items-center gap-1.5">
          <span className={labelCls}>Hdl</span>
          <select
            value={params.handle}
            onChange={(e) => {
              const handle = e.target.value as typeof params.handle
              // Reseed the sizes — see BOARD_HANDLE_DEFAULTS; a paddle's neck
              // read as a slot is not a handle at all.
              update({ ...params, handle, ...BOARD_HANDLE_DEFAULTS[handle] })
            }}
            className={fieldCls + ' cursor-pointer'}>
            <option value="none">None</option>
            <option value="paddle">Paddle</option>
            <option value="grips">Side slots</option>
            <option value="slot">End slot</option>
          </select>
        </div>
        {handleLabels && (<>
          <EditField label="HW" valueMM={params.handleW} units={u} onChange={(handleW) => update({ ...params, handleW })} />
          <EditField label="HL" valueMM={params.handleL} units={u} onChange={(handleL) => update({ ...params, handleL })} />
        </>)}
        {BOARD_HANDLE_HAS_INSET[params.handle] && (<>
          <EditField label="Gap" valueMM={params.handleInset} units={u} onChange={(handleInset) => update({ ...params, handleInset })} />
          <span />
        </>)}
        {!BOARD_HANDLE_HAS_INSET[params.handle] && (
          <label className="flex items-center gap-1.5 cursor-pointer">
            <span className={labelCls}>Hole</span>
            <input type="checkbox" checked={params.hole} onChange={(e) => update({ ...params, hole: e.target.checked })}
              className="accent-blue-500 w-3.5 h-3.5" />
          </label>
        )}
        {!BOARD_HANDLE_HAS_INSET[params.handle] && params.hole
          ? <EditField label="Ø" valueMM={params.holeDia} units={u} onChange={(holeDia) => update({ ...params, holeDia })} />
          : <span />}
        <label className="flex items-center gap-1.5 cursor-pointer">
          <span className={labelCls}>Grv</span>
          <input type="checkbox" checked={params.groove} onChange={(e) => update({ ...params, groove: e.target.checked })}
            className="accent-blue-500 w-3.5 h-3.5" />
        </label>
        {params.groove
          ? <EditField label="In" valueMM={params.grooveInset} units={u} onChange={(grooveInset) => update({ ...params, grooveInset })} />
          : <span />}
      </>)
    }
    case 'gear': {
      const cyc = params.toothProfile === 'cycloidal'
        ? { mateTeeth: params.mateTeeth, pinDia: params.pinDia } : undefined
      const d = gearDims(params.module, params.teeth, params.pressureAngle, params.backlash, cyc)
      // The pinion this wheel CARRIES, if any — its holes are a second floor
      // under the hub, so the readout must ask for it or it reports a hub the
      // generator has already grown past.
      const carried = carriedPinion(params)
      const hub = gearHub(params.module, params.teeth, params.bore, params.hubDia, params.spokes, carried?.hubDia ?? 0)
      const lab = gearLabel(params)
      const pin = pinionDims(params)
      const pinLab = pinionLabel(params)
      const mesh = gearMesh(params)
      const running = meshAnimPathId === id
      const rootDeepened = !!cyc && d.rootDia < params.module * (params.teeth - 2.5) - 0.01
      const N = (mm: number) => fromMM(mm, u as 'mm' | 'in').toFixed(2)
      // Regenerating a gear REPLACES its paths, so an edit made before the
      // single-stroke face has loaded would drop the number the gear already
      // carries (generateGearParts cannot emit what it cannot set). Wait for the
      // font — a no-op once it is cached, which is the same thing the text shape
      // does for the same reason.
      const updateGear = (p: ShapeParams) => {
        if (p.type === 'gear' && p.toothLabel) loadFont(SINGLE_LINE_FONT_FAMILY).then(() => update(p))
        else update(p)
      }
      return (<>
        <EditField label="Mod" valueMM={params.module} units={u} min={0.05} onChange={(module) => updateGear({ ...params, module })} />
        <EditField label="N"   valueMM={params.teeth} units="" min={4} integer onChange={(teeth) => updateGear({ ...params, teeth: Math.max(4, Math.round(teeth)) })} />
        {/* Involute or cycloidal. A cycloidal face is cut for ONE mate, so the
            pinion is a parameter of the wheel; pressure angle has no meaning in a
            cycloidal mesh and its field goes away with the profile. */}
        <label className="flex items-center gap-1.5 col-span-2">
          <span className={labelCls}>Prf</span>
          <select value={params.toothProfile ?? 'involute'} className={fieldCls}
            onChange={(e) => updateGear({ ...params, toothProfile: e.target.value as 'involute' | 'cycloidal' })}>
            <option value="involute">Involute</option>
            <option value="cycloidal">Cycloidal (clock)</option>
          </select>
        </label>
        {/* Cycloidal takes the lantern it is cut for — pin count and pin diameter
            — in place of a pressure angle, which a cycloidal mesh does not have. */}
        {cyc
          ? <EditField label="Pin" valueMM={params.mateTeeth} units="" min={2} integer onChange={(mateTeeth) => updateGear({ ...params, mateTeeth: Math.max(2, Math.round(mateTeeth)) })} />
          : <RawField  label="PA"  value={params.pressureAngle} min={5} max={35} step={0.5} suffix="°" onChange={(pressureAngle) => updateGear({ ...params, pressureAngle })} />}
        {cyc && <EditField label="PØ" valueMM={params.pinDia} units={u} min={0.1} onChange={(pinDia) => updateGear({ ...params, pinDia })} />}
        {/* The same field, and it means two different things. On a cycloidal
            wheel the mate SHAPES the teeth — the face is conjugate to one
            particular lantern. On an involute gear it changes nothing that gets
            cut; it only says what to run the preview against, which is the one
            way to see whether the pair the gear is for actually meshes. */}
        {!cyc && <EditField label="Mate" valueMM={params.mateTeeth} units="" min={4} integer onChange={(mateTeeth) => updateGear({ ...params, mateTeeth: Math.max(4, Math.round(mateTeeth)) })} />}
        {/* Spelt out rather than abbreviated: a tick called "Pnn" would be the "Ltn"
            mistake again. */}
        {cyc && <label className="flex items-center gap-1.5 col-span-2 cursor-pointer">
          <input type="checkbox" checked={!!params.emitPinion}
            onChange={(e) => updateGear({ ...params, emitPinion: e.target.checked })}
            className="accent-blue-500 w-3.5 h-3.5" />
          <span className="text-label text-gray-400 dark:text-neutral-500">Emit the lantern pinion</span>
        </label>}
        <EditField label="Ø"   valueMM={params.bore} units={u} min={0} onChange={(bore) => updateGear({ ...params, bore })} />
        <EditField label="Hub" valueMM={params.hubDia} units={u} min={0} onChange={(hubDia) => updateGear({ ...params, hubDia })} />
        <EditField label="Spk" valueMM={params.spokes} units="" min={0} integer onChange={(spokes) => updateGear({ ...params, spokes: Math.max(0, Math.round(spokes)) })} />
        <EditField label="Lash" valueMM={params.backlash} units={u} min={0} onChange={(backlash) => updateGear({ ...params, backlash })} />
        {/* Engraved, not cut: its own path, deleted or given an engrave op on
            its own. */}
        <label className="flex items-center gap-1.5 cursor-pointer">
          <span className={labelCls}>#</span>
          <input type="checkbox" checked={!!params.toothLabel}
            onChange={(e) => updateGear({ ...params, toothLabel: e.target.checked })}
            className="accent-blue-500 w-3.5 h-3.5" />
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <span className={labelCls}>P○</span>
          <input type="checkbox" checked={params.pitchCircle}
            onChange={(e) => updateGear({ ...params, pitchCircle: e.target.checked })}
            className="accent-blue-500 w-3.5 h-3.5" />
        </label>
        {/* Base Ø is m·z·cos α — derived from the three above it, so it is a
            readout, not a field. */}
        <div className="col-span-2 text-label text-gray-400 dark:text-neutral-500 leading-tight">
          {cyc ? <>Pitch {N(d.pitchDia)} · Describing {N(d.describingDia)}</> : <>Pitch {N(d.pitchDia)} · Base {N(d.baseDia)}</>}
          <br />
          OD {fromMM(d.outsideDia, u as 'mm' | 'in').toFixed(2)} · Root {fromMM(d.rootDia, u as 'mm' | 'in').toFixed(2)} {u}
          <br />
          Meshes at {fromMM(d.pitchDia / 2, u as 'mm' | 'in').toFixed(2)} + partner pitch radius
          <br />
          Tooth {fromMM(d.toothThickness, u as 'mm' | 'in').toFixed(2)} at pitch
          {hub.grown && <><br /><span className="text-blue-400">Hub grown to {fromMM(hub.dia, u as 'mm' | 'in').toFixed(2)} for {params.spokes} spokes.</span></>}
          {params.spokes >= 2 && !hub.spoked && <><br /><span className="text-yellow-500">
            {hub.maxSpokes >= 2 ? `Max ${hub.maxSpokes} spokes here — cut solid.` : 'No room for spokes — cut solid.'}
          </span></>}
          {params.toothLabel && lab && <><br />Engraves &ldquo;{lab.text}&rdquo;{lab.sizeMM < TOOTH_LABEL_SIZE - 0.05 && <span className="text-blue-400"> at {fromMM(lab.sizeMM, u as 'mm' | 'in').toFixed(2)} — all the spoke takes</span>}</>}
          {params.toothLabel && !lab && isFontLoaded(SINGLE_LINE_FONT_FAMILY) && <><br /><span className="text-yellow-500">No room beside the bore for a legible marking — none engraved.</span></>}
          {params.pitchCircle && <><br /><span className="text-yellow-500">Pitch circle is a reference — delete before cutting.</span></>}
          {d.pointed && <><br /><span className="text-yellow-500">Teeth pointed — OD reduced.</span></>}
          {!cyc && d.undercut && <><br /><span className="text-gray-400 dark:text-neutral-500">Undercut — roots hobbed, flank waisted below the base circle.</span></>}
          {cyc && d.pinTooFat && <><br /><span className="text-red-400">
            Ø{N(params.pinDia)} pins take the whole {N(d.circularPitch)} pitch — no tooth left to drive with. Thinner pins, or a bigger module.
          </span></>}
          {rootDeepened && <><br /><span className="text-blue-400">Root cut to {N(d.rootDia)} to clear the pins.</span></>}
          {cyc && <><br />Cut for a {params.mateTeeth}-pin lantern at Ø{N(params.pinDia)}.</>}
          {/* The pinion on this wheel's OWN arbor, which it carries: the wheel is
              one of that lantern's two cheeks, so only one loose cheek is cut. */}
          {carried && <>
            <br />Carries {carried.pins} pins on Ø{N(carried.pinCircleDia)} through its hub — this wheel is
            one cheek of that pinion, so cut ONE loose cheek for the far ends.
            {carried.gap < 1 && <><br /><span className="text-yellow-500">
              Only {N(Math.max(0, carried.gap))} between those holes — fewer or thinner pins.
            </span></>}
            {carried.pinCircleDia / 2 - carried.pinDia / 2 < params.bore / 2 + 1 && <><br /><span className="text-red-400">
              Those holes break into the Ø{N(params.bore)} arbor hole — a bigger pin circle, or a smaller bore.
            </span></>}
          </>}
          {cyc && params.emitPinion && pin && <>
            <br />Pinion cheek {N(pin.cheekDia)}, pins on {N(pin.pinCircleDia)} — cut TWO, the wheel runs between them.
            <br />Arbors {N(pin.centreDistance)} apart = {N(d.pitchDia / 2)} wheel pitch radius + {N(pin.pinCircleDia / 2)} arbor to pin centre. Drawn clear, not at that spacing.
            {params.toothLabel && pinLab && <><br />Cheek engraves &ldquo;{pinLab.text}&rdquo; — add to the wheel&apos;s.</>}
            {pin.pinGap < 1 && <><br /><span className="text-yellow-500">
              Only {N(Math.max(0, pin.pinGap))} between pin holes — fewer or thinner pins.
            </span></>}
          </>}
          {/* What the Animate button will show, and the one number it makes
              visible: the play the pair has before the drive takes up. */}
          <br />Runs {mesh.ratio.toFixed(3)}:1 against {cyc
            ? `its ${mesh.mateTeeth}-pin lantern`
            : `a ${mesh.mateTeeth}-tooth gear`} at {N(mesh.centreDistance)} centres
          <br />Play at the mesh {N(mesh.playAtPitch)}

        </div>
        {/* A gear is drawn alone and its lantern is drawn clear of it, so the one
            thing the drawing cannot show is whether they run together. This puts
            the mate at the real centre distance and turns the pair. A preview
            only — nothing is written. */}
        <button
          type="button"
          onClick={() => useUIStore.getState().setMeshAnim(running ? null : id)}
          className={`col-span-2 rounded px-2 py-1 text-label ${running
            ? 'bg-red-500/80 hover:bg-red-500 text-white'
            : 'bg-blue-500/80 hover:bg-blue-500 text-white'}`}
        >
          {running ? 'Stop' : 'Animate in mesh'}
        </button>
      </>)
    }
    case 'escapement': {
      const dead = params.escType === 'deadbeat'
      const running = meshAnimPathId === id
      return (<>
        <label className="flex items-center gap-1.5 col-span-2">
          <span className={labelCls}>Type</span>
          <select value={params.escType} className={fieldCls}
            onChange={(ev) => update({ ...params, escType: ev.target.value as 'deadbeat' | 'recoil' })}>
            <option value="deadbeat">Deadbeat (Graham)</option>
            <option value="recoil">Recoil (anchor)</option>
          </select>
        </label>
        <EditField label="N"    valueMM={params.teeth} units="" min={6} integer onChange={(teeth) => update({ ...params, teeth: Math.max(6, Math.round(teeth)) })} />
        <EditField label="Wh Ø" valueMM={params.wheelDia} units={u} min={4} onChange={(wheelDia) => update({ ...params, wheelDia })} />
        <EditField label="Th H" valueMM={params.toothDepth} units={u} min={0.5} onChange={(toothDepth) => update({ ...params, toothDepth })} />
        {/* Drop is at the WHEEL, lift at the ANCHOR. */}
        <RawField label="Drop" value={params.drop} min={0.2} max={10} step={0.25} suffix="°" onChange={(drop) => update({ ...params, drop })} />
        <RawField label="Lift" value={params.lift} min={0.5} max={12} step={0.25} suffix="°" onChange={(lift) => update({ ...params, lift })} />
        {dead
          ? <RawField label="Lock" value={params.lock} min={0} max={10} step={0.25} suffix="°" onChange={(lock) => update({ ...params, lock })} />
          : <RawField label="Rcl"  value={params.recoilArc} min={0.5} max={20} step={0.5} suffix="°" onChange={(recoilArc) => update({ ...params, recoilArc })} />}
        {dead && <RawField label="Draw" value={params.draw} min={0} max={10} step={0.5} suffix="°" onChange={(draw) => update({ ...params, draw })} />}
        <EditField label="ArmW" valueMM={params.armWidth} units={u} min={1} onChange={(armWidth) => update({ ...params, armWidth })} />
        <EditField label="Ø"    valueMM={params.bore} units={u} min={0} onChange={(bore) => update({ ...params, bore })} />
        <EditField label="Hub"  valueMM={params.hubDia} units={u} min={0} onChange={(hubDia) => update({ ...params, hubDia })} />
        <EditField label="Spk"  valueMM={params.spokes} units="" min={0} integer onChange={(spokes) => update({ ...params, spokes: Math.max(0, Math.round(spokes)) })} />
        <EditField label="Arb"  valueMM={params.anchorBore} units={u} min={0} onChange={(anchorBore) => update({ ...params, anchorBore })} />
        {/* Geometry, not a view option: the teeth lean the way the wheel runs. */}
        <label className="flex items-center gap-1.5 cursor-pointer">
          <span className={labelCls}>CW</span>
          <input type="checkbox" checked={params.clockwise}
            onChange={(ev) => update({ ...params, clockwise: ev.target.checked })}
            className="accent-blue-500 w-3.5 h-3.5" />
        </label>
        {/* The readout used to sit here, a dozen lines of numbers in the
            smallest type the app has, wrapped under the very controls being
            clicked. It is a window now — see EscapementInfoPanel — and this
            button carries its status so nothing fatal can hide in it. */}
        <EscapementInfoButton spec={params as unknown as EscapementSpec} />
        {/* The parts are drawn clear of each other, so the one thing the drawing
            cannot show is whether they bind. This puts them at the real centre
            distance and runs them. A preview only — nothing is written. */}
        <button
          type="button"
          onClick={() => useUIStore.getState().setMeshAnim(running ? null : id)}
          className={`col-span-2 rounded px-2 py-1 text-label ${running
            ? 'bg-red-500/80 hover:bg-red-500 text-white'
            : 'bg-blue-500/80 hover:bg-blue-500 text-white'}`}
        >
          {running ? 'Stop' : 'Animate in mesh'}
        </button>
      </>)
    }
    case 'pendulum': {
      const dm = pendulumDims(params)
      const L = (mm: number) => fromMM(mm, u as 'mm' | 'in').toFixed(2)
      return (<>
        {/* CX/CY is the SUSPENSION POINT, not the middle of the drawing — a
            pendulum is placed by where it hangs from. */}
        <EditField label="Len"   valueMM={params.length} units={u} min={1} onChange={(length) => update({ ...params, length })} />
        <EditField label="Rod W" valueMM={params.rodWidth} units={u} min={0.5} onChange={(rodWidth) => update({ ...params, rodWidth })} />
        <EditField label="Bob W" valueMM={params.bobRx * 2} units={u} min={1} onChange={(w) => update({ ...params, bobRx: w / 2 })} />
        <EditField label="Bob H" valueMM={params.bobRy * 2} units={u} min={1} onChange={(h) => update({ ...params, bobRy: h / 2 })} />
        <EditField label="Hole"  valueMM={params.bore} units={u} min={0} onChange={(bore) => update({ ...params, bore })} />
        <div className="col-span-2 text-label text-gray-400 dark:text-neutral-500 leading-snug">
          Beats {dm.beatSeconds.toFixed(4)} s · period {dm.periodSeconds.toFixed(4)} s
          <br />
          Rod {L(dm.rodLength)} {u} overall · Len is the hole to the BOB CENTRE
          <br />
          A real rod runs a little fast — regulate by raising the bob.
          {dm.boreTooBig && <><br /><span className="text-yellow-500">Hole clamped to leave a shoulder on the rod.</span></>}
          {dm.bobTooSmall && <><br /><span className="text-yellow-500">Bob is no wider than the rod.</span></>}
        </div>
      </>)
    }
    case 'cam': {
      const dm = camDims(params)
      const N = (mm: number) => fromMM(mm, u as 'mm' | 'in').toFixed(2)
      return (<>
        <EditField label="Base" valueMM={params.baseDia} units={u} min={1} onChange={(baseDia) => update({ ...params, baseDia })} />
        <EditField label="Rise" valueMM={params.riseMM} units={u} min={0.1} onChange={(riseMM) => update({ ...params, riseMM })} />
        <RawField  label="Swp"  value={params.sweepDeg} min={5} max={360} step={5} suffix="°" onChange={(sweepDeg) => update({ ...params, sweepDeg })} />
        <EditField label="Ø"    valueMM={params.boreDia} units={u} min={0} onChange={(boreDia) => update({ ...params, boreDia })} />
        <EditField label="Lvr"  valueMM={params.handleLength} units={u} min={1} onChange={(handleLength) => update({ ...params, handleLength })} />
        <EditField label="LvrW" valueMM={params.handleWidth} units={u} min={0.5} onChange={(handleWidth) => update({ ...params, handleWidth })} />
        {/* Rise is per REVOLUTION — the spiral's slope. What it lifts is that over
            its own sweep, which is the number worth reading back. */}
        <div className="col-span-2 text-label text-gray-400 dark:text-neutral-500 leading-tight">
          Stroke {N(dm.usableStroke)} over {params.sweepDeg}° · {N(dm.liftPerDeg)} {u}/°
          <br />
          Base {N(dm.baseDia)} → crest {N(dm.maxDia)}
          <br />
          Pressure angle {dm.pressureAngleDeg.toFixed(1)}° base / {dm.pressureAngleAtCrestDeg.toFixed(1)}° crest
          {dm.wontHold && <><br /><span className="text-yellow-500">
            Friction may not hold {dm.pressureAngleDeg.toFixed(1)}° — bigger base, or less rise.
          </span></>}
          {dm.handleTooShort && <><br /><span className="text-yellow-500">Lever inside the crest — no leverage.</span></>}
        </div>
      </>)
    }
    case 'polygon':
      return (<>
        <EditField label="R" valueMM={params.radius} units={u} onChange={(radius) => update({ ...params, radius })} />
        <EditField label="N" valueMM={params.sides} units="" min={3} integer onChange={(sides) => update({ ...params, sides: Math.max(3, Math.round(sides)) })} />
      </>)
    case 'star':
      return (<>
        <EditField label="OR" valueMM={params.outerRadius} units={u} onChange={(outerRadius) => update({ ...params, outerRadius })} />
        <EditField label="IR" valueMM={params.innerRadius} units={u} onChange={(innerRadius) => update({ ...params, innerRadius })} />
        <EditField label="N" valueMM={params.points} units="" min={3} integer onChange={(points) => update({ ...params, points: Math.max(3, Math.round(points)) })} />
      </>)
    case 'heart':
      return (<>
        <EditField label="R" valueMM={params.curveRadius} units={u} onChange={(curveRadius) => update({ ...params, curveRadius })} />
        <EditField label="Ang" valueMM={params.angle} units="" integer min={1} onChange={(angle) => update({ ...params, angle: Math.min(179, Math.max(1, Math.round(angle))) })} />
      </>)
    case 'slot':
      return (<>
        <EditField label="Len" valueMM={params.length} units={u} onChange={(length) => update({ ...params, length: Math.max(length, params.width) })} />
        <EditField label="W"   valueMM={params.width}  units={u} onChange={(width)  => update({ ...params, width: Math.min(width, params.length) })} />
      </>)
    case 'text': {
      const updateText = (newParams: ShapeParams) => {
        if (newParams.type === 'text') loadFont(newParams.fontFamily).then(() => update(newParams))
      }
      return (<>
        <div className="flex items-center gap-1.5 col-span-2">
          <span className={labelCls}>T</span>
          <input type="text" value={params.text} onChange={(e) => updateText({ ...params, text: e.target.value })} className={fieldCls} />
        </div>
        <EditField label="Sz" valueMM={params.fontSize} units={u} min={0.1} onChange={(fontSize) => updateText({ ...params, fontSize })} />
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Fnt</span>
          <FontSelect
            value={params.fontFamily}
            previewText={params.text}
            onChange={(family) => updateText({ ...params, fontFamily: family })}
            className="flex-1 w-0"
          />
        </div>
      </>)
    }
  }
}


export default function PropertiesPanel() {
  const liveRotationAngle = useCanvasStore((s) => s.liveRotationAngle)
  const liveBBox = useCanvasStore((s) => s.liveBBox)
  // Brief highlight when a timeline path-chip is clicked — this panel is where
  // that chip's shape/text parameters get amended.
  const flashSeq = useUIStore((s) => s.propertiesFlashSeq)
  const [flashing, setFlashing] = useState(false)
  useEffect(() => {
    if (flashSeq === 0) return
    setFlashing(true)
    const t = setTimeout(() => setFlashing(false), 1200)
    return () => clearTimeout(t)
  }, [flashSeq])
  const { units, origin, widthMM, heightMM } = useWorkpieceStore()
  const orgWorld = originWorldXY(origin, widthMM, heightMM)
  const selectedPaths = useSelectedPaths()

  if (selectedPaths.length === 0) return null
  const bbox = getMultiBBox(selectedPaths.map((p) => p.d))
  if (!bbox) return null

  const fmt = (n: number) => n.toFixed(2)
  // A multi-part shape (a gear) IS one shape — its parts share one set of params
  // and editing any of them regenerates the whole group. So a selection sitting
  // entirely inside one group is that shape, not a multi-select: without this,
  // clicking a gear's timeline chip (which selects every part) showed the generic
  // multi-path panel instead of the gear's parameters.
  const groupShape = selectedPaths.length > 1 && selectedPaths[0].groupId
    && selectedPaths.every((p) =>
      p.groupId === selectedPaths[0].groupId && p.shapePart !== undefined && p.shapeParams)
    ? selectedPaths[0] : null
  const singleShape = (selectedPaths.length === 1 && selectedPaths[0].shapeParams ? selectedPaths[0] : null)
    ?? groupShape

  // During a drag, compute the live bbox for display:
  // - translate/scale: CanvasStage pushes the exact bbox into the store
  // - rotate: derive from the original bbox + live angle (center stays fixed, AABB formula)
  const displayBBox = liveBBox ?? (liveRotationAngle !== null && bbox ? (() => {
    const { cx, cy, width, height } = bbox
    const rad = liveRotationAngle * Math.PI / 180
    const ca = Math.abs(Math.cos(rad)), sa = Math.abs(Math.sin(rad))
    const hw = width / 2, hh = height / 2
    const nHW = hw * ca + hh * sa, nHH = hw * sa + hh * ca
    return { minX: cx - nHW, minY: cy - nHH, width: nHW * 2, height: nHH * 2 }
  })() : bbox)

  // The shape's OWN fields, moved by the gesture in flight — so the panel needs
  // no second copy of X/Y/W/H underneath, which is where the duplication came
  // from (and they disagreed, the stored params being pre-gesture). The live
  // step is React state inside CanvasStage rather than a store field, but for a
  // drag and a resize the two bounding boxes say everything about it: the same
  // axis-aligned scale-then-translate that carries `bbox` onto `liveBBox`
  // carries the parameters with it. Scale about the box's own corner (so that
  // corner is fixed) and then translate it onto the live one — exact, and no
  // dividing to recover an anchor.
  //
  // A rotate has no liveBBox and needs none: it SPILLS into the placement, so
  // the definition genuinely does not change and the live angle is reported by
  // RotationField below. Same for a scale a shape cannot express, where
  // `scaleShapeParams` returns null and the stored params stand.
  const liveShapeParams = useMemo(() => {
    const params = singleShape?.shapeParams
    if (!params || !liveBBox || !bbox || bbox.width === 0 || bbox.height === 0) return params
    const sx = liveBBox.width / bbox.width
    const sy = liveBBox.height / bbox.height
    const scaled = Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9
      ? params
      : scaleShapeParams(params, bbox.minX, bbox.minY, sx, sy)
    if (!scaled) return params
    return translateShapeParams(scaled, liveBBox.minX - bbox.minX, liveBBox.minY - bbox.minY)
  }, [singleShape?.shapeParams, liveBBox, bbox])

  // How far the selection already stands turned, out of its placement recipe:
  // the angle of the transformed x-axis. Exact for a chain of rotates, mirrors
  // and uniform scales; for one carrying a skew or a stretch it is the nearest
  // honest single number, which is what a one-field readout can say anyway.
  // Only for a lone path — two paths can stand at two angles.
  // OVER THE WHOLE SELECTION, not a lone path — a MULTI-PART shape is several
  // paths, so `length !== 1` meant a gear, a cam, an escapement and a clock
  // wheel all reported 0° while standing visibly turned. They are rotated
  // together, so their parts carry the same angle and the selection has one
  // answer; a part dragged off on its own keeps that angle too, since a drag
  // adds a translate and turns nothing. Two paths at genuinely DIFFERENT angles
  // have no single answer, and 0 is what the field can honestly say.
  const placedAngle = useMemo(() => {
    const angles = selectedPaths.map((p) => {
      if (!p.placement?.length) return 0
      const [a, b] = placementMat(p.placement)
      return Math.atan2(b, a) * 180 / Math.PI
    })
    if (angles.length === 0) return 0
    const first = angles[0]
    if (angles.some((d) => Math.abs(d - first) > 1e-6)) return 0
    return Math.abs(first) < 1e-9 ? 0 : first
  }, [selectedPaths])

  // The Transform section's fields are absolute — the position and size the
  // selection should HAVE — but a transform step is a delta, so each converts
  // one into the other against the live bbox. Same road as a canvas drag, so a
  // typed move and a dragged one leave the same recipe behind.
  function applyTransform(step: TransformStep, gesture: 'move' | 'scale') {
    const { paths: allPaths, batchUpdatePaths } = usePathsStore.getState()
    const updates = selectedPaths
      .map((p) => allPaths.find((ap) => ap.id === p.id))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => {
        const r = applyTransformStep(p, step)
        return { id: p.id, d: r.d, shapeParams: r.shapeParams, name: r.name, transforms: [step] }
      })
    if (updates.length) {
      batchUpdatePaths(updates, gesture)
      regenerateAffectedMany(updates.map((u) => u.id))
    }
  }

  function applyTranslate(dx: number, dy: number) {
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return
    applyTransform({ kind: 'translate', dx, dy }, 'move')
  }

  // Resizing holds the selection's top-left corner still, which is the corner a
  // typed width grows away from — matching the default drag, where the anchor is
  // the handle opposite the one being pulled.
  function applyResize(w: number, h: number) {
    if (!bbox || bbox.width === 0 || bbox.height === 0) return
    const sx = w / bbox.width, sy = h / bbox.height
    if (Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9) return
    applyTransform({ kind: 'scale', sx, sy, ax: bbox.minX, ay: bbox.maxY }, 'scale')
  }

  function applyRotation(angle: number) {
    if (!bbox) return
    const cx = (bbox.minX + bbox.maxX) / 2
    const cy = (bbox.minY + bbox.maxY) / 2
    const step: TransformStep = { kind: 'rotate', angle, cx, cy }
    const { paths: allPaths, batchUpdatePaths } = usePathsStore.getState()
    const updates = selectedPaths
      .map((p) => allPaths.find((ap) => ap.id === p.id))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => {
        const r = applyTransformStep(p, step)
        return { id: p.id, d: r.d, shapeParams: r.shapeParams, transforms: [step] }
      })
    if (updates.length) {
      batchUpdatePaths(updates, 'rotate')
      regenerateAffectedMany(updates.map((u) => u.id))
    }
  }

  function applyMirror(axis: 'x' | 'y') {
    if (!bbox) return
    const cx = (bbox.minX + bbox.maxX) / 2
    const cy = (bbox.minY + bbox.maxY) / 2
    const step: TransformStep = { kind: 'mirror', axis, cx, cy }
    const { paths: allPaths, batchUpdatePaths } = usePathsStore.getState()
    const updates = selectedPaths
      .map((p) => allPaths.find((ap) => ap.id === p.id))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => {
        const r = applyTransformStep(p, step)
        return { id: p.id, d: r.d, shapeParams: r.shapeParams, transforms: [step] }
      })
    if (updates.length) {
      batchUpdatePaths(updates, 'mirror')
      regenerateAffectedMany(updates.map((u) => u.id))
    }
  }

  // How this object grows — outward from its middle, or from a fixed corner.
  // Reads the PATH, not its shapeParams: it has to survive a gesture that leaves
  // the parameters describing an untransformed definition, and it also lets an
  // imported outline with no parameters at all carry the setting. It is rendered
  // ONCE now, at the end of the one panel body — there used to be a second copy
  // in the transform-recipe editor, because that editor replaced this whole body
  // and a setting whose subject is what the NEXT resize does is useless if it
  // vanishes the moment you resize. With that editor gone, so is the second copy.
  //
  // Over the whole selection: ticked when they ALL are, and toggling sets them
  // all, which matches how the resize itself treats a group.
  const fromCentreRow = selectedPaths.length > 0 ? (
    <label
      className="col-span-2 flex items-center gap-1.5 cursor-pointer pt-1"
      title="Resize about the middle instead of holding the opposite corner still"
    >
      <input
        type="checkbox"
        className="accent-blue-500 w-3.5 h-3.5"
        checked={selectedPaths.every((p) => p.fromCenter)}
        onChange={(e) => usePathsStore.getState().batchUpdatePaths(
          selectedPaths.map((p) => ({ id: p.id, d: p.d, fromCenter: e.target.checked })))}
      />
      <span className="text-label text-gray-500 dark:text-neutral-400">Resize from centre</span>
    </label>
  ) : null

  return (
    // GROWS DOWNWARD, and that is the whole of these three classes.
    //
    // It used to be the last child of a column whose other half was `flex-1`, so
    // its box was pinned to the BOTTOM of the sidebar and every line it gained
    // pushed its own top edge — and every field on it — upward. Which is fine
    // until a field publishes a warning: the panel gets a line taller mid-click,
    // the spinner arrow slides out from under the pointer, and the next click
    // lands on nothing. Anything that appears and disappears with a value does
    // it — the red errors, the yellow notes, the blue hub line.
    //
    // So the panel takes the free space instead (`flex-1`) and scrolls INSIDE it
    // (`min-h-0 overflow-y-auto`). Its top edge is then fixed by whatever sits
    // above, which does not move, and a warning grows into the space below.
    <div className={[
      'border-t border-gray-300 dark:border-neutral-700 px-3 py-2 flex-1 min-h-0 overflow-y-auto transition-shadow duration-300',
      flashing ? 'ring-2 ring-inset ring-blue-500' : '',
    ].join(' ')}>
      <p className="text-label font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1.5">
        {selectedPaths.length === 1 ? selectedPaths[0].name : `${selectedPaths.length} paths`}
      </p>

      {/* ONE PANEL, TWO SECTIONS: what the thing IS, then where it SITS.
          There used to be four presentations of this — the shape's own fields,
          a read-only bbox block for a path that had none, the rotation field and
          mirror buttons, and a whole separate transform-recipe body that
          REPLACED all of them. The fourth existed only because a rotate, a skew
          or a scale used to destroy `shapeParams`, leaving its recipe as the
          sole surviving record; parameters now spill into `placement` instead,
          so that case no longer exists and the recipe editor had become an
          orphan (the object strip is one chip per THING and carries no transform
          chip, so nothing could even reopen it — it only ever appeared by
          opening itself over whatever the user was working on).

          The Transform section shows only what the Shape section does not
          already state, which is what keeps a rectangle from listing X, Y, W and
          H twice. The test is `x`/`cx` and `w`/`h` in the params — a question
          asked of the object, so no per-type list can fall out of date as shapes
          are added. Everything here is live during a gesture and editable when
          not, for a pen path exactly as for a gear. */}
      {liveShapeParams && singleShape && (
        <>
          <SectionLabel>Shape</SectionLabel>
          <div className="grid grid-cols-2 gap-1.5">
            <ShapeParamsEditor id={singleShape.id} params={liveShapeParams} units={units} fromCenter={singleShape.fromCenter} />
          </div>
        </>
      )}

      {(() => {
        const params = liveShapeParams
        const statesSize = !!params && 'w' in params && 'h' in params
        // POSITION IS ALWAYS HERE, ALWAYS THE CENTRE, and never in the Shape
        // section. Every shape used to state its own, in whatever terms its
        // params happened to store — a rectangle its low corner, a circle its
        // centre — so the same question was answered two ways depending on what
        // was selected, and the rectangle's answer moved when its width was
        // typed. Where a thing sits is a property of the placement, not of the
        // shape; one field, one meaning, one place, for a pen path exactly as
        // for a gear. Taken from the bbox, so it is what is actually drawn: on
        // a gear that includes the pinion beside it, which is the extent the
        // stock has to hold.
        const posX = displayBBox!.minX + displayBBox!.width / 2
        const posY = displayBBox!.minY + displayBBox!.height / 2
        const live = liveRotationAngle !== null || liveBBox !== null
        return (
          <>
            {params && <SectionLabel>Transform</SectionLabel>}
            <div className="grid grid-cols-2 gap-1.5 space-y-0">
              {live ? (<>
                <ReadField label="CX" value={fmt(posX - orgWorld.x)} units="mm" />
                <ReadField label="CY" value={fmt(posY - orgWorld.y)} units="mm" />
              </>) : (<>
                <EditField label="CX" valueMM={posX - orgWorld.x} units={units} min={-1e6}
                  onChange={(v) => applyTranslate(v + orgWorld.x - posX, 0)} />
                <EditField label="CY" valueMM={posY - orgWorld.y} units={units} min={-1e6}
                  onChange={(v) => applyTranslate(0, v + orgWorld.y - posY)} />
              </>)}
              {!statesSize && (live ? (<>
                <ReadField label="W" value={fmt(displayBBox!.width)} units="mm" />
                <ReadField label="H" value={fmt(displayBBox!.height)} units="mm" />
              </>) : (<>
                <EditField label="W" valueMM={displayBBox!.width} units={units}
                  onChange={(v) => applyResize(v, displayBBox!.height)} />
                <EditField label="H" valueMM={displayBBox!.height} units={units}
                  onChange={(v) => applyResize(displayBBox!.width, v)} />
              </>))}
            </div>
          </>
        )
      })()}

      <div className="mt-1.5">
        <RotationField liveAngle={liveRotationAngle} baseAngle={placedAngle} onApply={applyRotation} />
      </div>

      <div className="mt-1.5 flex gap-1.5">
        <button
          onClick={() => applyMirror('x')}
          title="Mirror horizontally (flip left/right)"
          className="flex-1 text-label py-1 rounded border transition-colors border-gray-400 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300"
        >
          <span className="inline-block">↔</span> Mirror X
        </button>
        <button
          onClick={() => applyMirror('y')}
          title="Mirror vertically (flip up/down)"
          className="flex-1 text-label py-1 rounded border transition-colors border-gray-400 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300"
        >
          <span className="inline-block rotate-90">↔</span> Mirror Y
        </button>
      </div>

      {/* Group / Ungroup — tie the selection together so it clicks, drags and
          deletes as one thing, or dissolve the groups it touches. Alt-click on
          the canvas (or the paths list) still reaches a single member. */}
      {(() => {
        const gid0 = outerGroupOf(selectedPaths[0])
        const isWholeGroup = !!gid0 && selectedPaths.every((p) => outerGroupOf(p) === gid0)
          && usePathsStore.getState().paths.filter((p) => outerGroupOf(p) === gid0).length === selectedPaths.length
        const canGroup = selectedPaths.length > 1 && !isWholeGroup
        const canUngroup = selectedPaths.some((p) => outerGroupOf(p))
        if (!canGroup && !canUngroup) return null
        return (
          <div className="mt-1.5 flex gap-1.5">
            {canGroup && (
              <button
                onClick={() => usePathsStore.getState().groupSelected()}
                title="Group the selected paths so they select and move as one"
                className="flex-1 text-label py-1 rounded border transition-colors border-gray-400 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300"
              >
                Group
              </button>
            )}
            {canUngroup && (
              <button
                onClick={() => usePathsStore.getState().ungroupSelected()}
                title="Break the group up into its separate paths"
                className="flex-1 text-label py-1 rounded border transition-colors border-gray-400 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300"
              >
                Ungroup
              </button>
            )}
          </div>
        )
      })()}

      {selectedPaths.length === 1 && (() => {
        const p = selectedPaths[0]
        const isCompound = splitCompoundPath(p.d).length > 1
        if (!isCompound) return null
        return (
          <button
            onClick={() => usePathsStore.getState().splitPath(p.id, splitCompoundPath(p.d))}
            className="mt-2 w-full text-label py-1 rounded border transition-colors border-gray-400 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300"
          >
            Split Paths
          </button>
        )
      })()}

      {/* Last, matching where the transform-recipe body puts it — a control that
          jumped position when the panel swapped bodies read as a different
          control. */}
      {fromCentreRow && <div className="grid grid-cols-2">{fromCentreRow}</div>}
    </div>
  )
}
