import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { usePathsStore, useSelectedPaths } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { useTimelineStore, bboxBeforeEvent } from '../timeline/timelineStore'
import { splitCompoundPath } from '../canvas/nodeUtils'
import { regenerateAffected, regenerateAffectedMany } from '../cam/regenerate'
import { useCanvasStore } from '../store/canvasStore'
import { useWorkpieceStore, fromMM, toMM } from '../store/workpieceStore'
import { getMultiBBox, applyTransformStep, type TransformStep } from '../canvas/selectionUtils'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'
import type { ShapeParams } from '../shapes/shapeGenerators'
import { loadFont } from '../shapes/textGenerator'
import { NumericInput } from '../components/NumericInput'
import FontSelect from '../components/FontSelect'

const fieldCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-200 dark:border-neutral-600 rounded px-1.5 py-0.5 text-body text-gray-800 dark:text-neutral-200 font-mono w-0 focus:outline-none focus:border-blue-500'
const labelCls = 'text-gray-400 dark:text-neutral-500 text-label w-5 flex-shrink-0'

function ReadField({ label, value, units }: { label: string; value: string; units?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={labelCls}>{label}</span>
      <span className={fieldCls + ' tabular-nums'}>{value}</span>
      {units && <span className="text-gray-400 dark:text-neutral-500 text-label flex-shrink-0">{units}</span>}
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
        onChange={(v) => onChange(integer ? v : toMM(v, units as 'mm' | 'in'))}
        className={fieldCls}
      />
      {!integer && <span className="text-gray-400 dark:text-neutral-500 text-label flex-shrink-0">{units}</span>}
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
      <NumericInput value={value} min={min} max={max} step={step} onChange={onChange} className={fieldCls} />
      {suffix && <span className="text-gray-400 dark:text-neutral-500 text-label flex-shrink-0">{suffix}</span>}
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
interface TransformFields {
  dx: number; dy: number
  angle: number; cx: number; cy: number
  sx: number; sy: number; ax: number; ay: number
  kx: number; ky: number; skx: number; sky: number
}

function fieldsFromSteps(
  steps: TransformStep[],
  defaultPivot: { x: number; y: number },
  defaultSkewPivot: { x: number; y: number },
): TransformFields {
  const translate = steps.find((s) => s.kind === 'translate')
  const rotate = steps.find((s) => s.kind === 'rotate')
  const scale = steps.find((s) => s.kind === 'scale')
  const skew = steps.find((s) => s.kind === 'skew')
  return {
    dx: translate?.kind === 'translate' ? translate.dx : 0,
    dy: translate?.kind === 'translate' ? translate.dy : 0,
    angle: rotate?.kind === 'rotate' ? rotate.angle : 0,
    cx: rotate?.kind === 'rotate' ? rotate.cx : defaultPivot.x,
    cy: rotate?.kind === 'rotate' ? rotate.cy : defaultPivot.y,
    sx: scale?.kind === 'scale' ? scale.sx : 1,
    sy: scale?.kind === 'scale' ? scale.sy : 1,
    ax: scale?.kind === 'scale' ? scale.ax : defaultPivot.x,
    ay: scale?.kind === 'scale' ? scale.ay : defaultPivot.y,
    kx: skew?.kind === 'skew' ? skew.kx : 0,
    ky: skew?.kind === 'skew' ? skew.ky : 0,
    skx: skew?.kind === 'skew' ? skew.ax : defaultSkewPivot.x,
    sky: skew?.kind === 'skew' ? skew.ay : defaultSkewPivot.y,
  }
}

// Rebuilds the step list from fields — same fixed fold order every time
// (scale, skew, rotate, mirror, translate) — using each field's OWN carried
// pivot, never a recomputed one.
// `mirrors` carries through unchanged — a numeric field edit shouldn't drop
// an already-applied mirror (or two, if the user mirrored twice; that's not
// consolidated back to zero mirrors, just two steps that cancel out).
function stepsFromFields(f: TransformFields, mirrors: TransformStep[]): TransformStep[] {
  const steps: TransformStep[] = []
  if (f.sx !== 1 || f.sy !== 1) steps.push({ kind: 'scale', ax: f.ax, ay: f.ay, sx: f.sx, sy: f.sy })
  if (f.kx !== 0 || f.ky !== 0) steps.push({ kind: 'skew', ax: f.skx, ay: f.sky, kx: f.kx, ky: f.ky })
  if (f.angle !== 0) steps.push({ kind: 'rotate', cx: f.cx, cy: f.cy, angle: f.angle })
  steps.push(...mirrors)
  steps.push({ kind: 'translate', dx: f.dx, dy: f.dy })
  return steps
}

function TransformFieldsEditor({ fields, units, onChange }: {
  fields: TransformFields
  units: string
  onChange: (f: TransformFields) => void
}) {
  return (<>
    <EditField label="dX" valueMM={fields.dx} units={units} min={-1e6} onChange={(dx) => onChange({ ...fields, dx })} />
    <EditField label="dY" valueMM={fields.dy} units={units} min={-1e6} onChange={(dy) => onChange({ ...fields, dy })} />
    <RawField label="∠" value={fields.angle} step={1} min={-360000} max={360000} onChange={(angle) => onChange({ ...fields, angle })} suffix="°" />
    <span />
    <RawField label="SX" value={fields.sx} min={-1e6} onChange={(sx) => onChange({ ...fields, sx })} suffix="×" />
    <RawField label="SY" value={fields.sy} min={-1e6} onChange={(sy) => onChange({ ...fields, sy })} suffix="×" />
    {(fields.kx !== 0 || fields.ky !== 0) && (<>
      <RawField label="KX" value={fields.kx} min={-1e6} onChange={(kx) => onChange({ ...fields, kx })} />
      <RawField label="KY" value={fields.ky} min={-1e6} onChange={(ky) => onChange({ ...fields, ky })} />
    </>)}
  </>)
}

function RotationField({ liveAngle, onApply }: { liveAngle: number | null; onApply: (deg: number) => void }) {
  const [text, setText] = useState('0')
  // Guard against double-commit: Enter calls commit() then blur() which re-triggers onBlur.
  const committedRef = useRef(false)

  function commit(currentText: string) {
    if (committedRef.current) return
    committedRef.current = true
    const v = parseFloat(currentText)
    if (!isNaN(v) && Math.abs(v) > 0.0001) onApply(v)
    setText('0')
  }

  if (liveAngle !== null) {
    return <ReadField label="∠" value={liveAngle.toFixed(1)} units="°" />
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
          if (e.key === 'Escape') { committedRef.current = true; setText('0'); e.currentTarget.blur() }
          if (e.key === 'ArrowUp') { e.preventDefault(); setText(String((parseFloat(e.currentTarget.value) || 0) + 1)) }
          if (e.key === 'ArrowDown') { e.preventDefault(); setText(String((parseFloat(e.currentTarget.value) || 0) - 1)) }
        }}
        className={fieldCls}
      />
      <span className="text-gray-400 dark:text-neutral-500 text-label flex-shrink-0">°</span>
    </div>
  )
}

function ShapeParamsEditor({ id, params, units, orgWorld }: { id: string; params: ShapeParams; units: string; orgWorld: { x: number; y: number } }) {
  const updateShapeParams = usePathsStore((s) => s.updateShapeParams)
  const update = (newParams: ShapeParams) => { updateShapeParams(id, newParams); regenerateAffected(id) }
  const u = units
  const ox = orgWorld.x, oy = orgWorld.y

  switch (params.type) {
    case 'rectangle':
      return (<>
        <EditField label="X" valueMM={params.x - ox} units={u} onChange={(x) => update({ ...params, x: x + ox })} min={-10000} />
        <EditField label="Y" valueMM={params.y - oy} units={u} onChange={(y) => update({ ...params, y: y + oy })} min={-10000} />
        <EditField label="W" valueMM={params.w} units={u} onChange={(w) => update({ ...params, w })} />
        <EditField label="H" valueMM={params.h} units={u} onChange={(h) => update({ ...params, h })} />
      </>)
    case 'roundrect':
    case 'inroundrect':
      return (<>
        <EditField label="X" valueMM={params.x - ox} units={u} onChange={(x) => update({ ...params, x: x + ox })} min={-10000} />
        <EditField label="Y" valueMM={params.y - oy} units={u} onChange={(y) => update({ ...params, y: y + oy })} min={-10000} />
        <EditField label="W" valueMM={params.w} units={u} onChange={(w) => update({ ...params, w })} />
        <EditField label="H" valueMM={params.h} units={u} onChange={(h) => update({ ...params, h })} />
        <EditField label="R" valueMM={params.r} units={u} onChange={(r) => update({ ...params, r })} min={0} />
      </>)
    case 'circle':
      return (<>
        <EditField label="CX" valueMM={params.cx - ox} units={u} onChange={(cx) => update({ ...params, cx: cx + ox })} min={-10000} />
        <EditField label="CY" valueMM={params.cy - oy} units={u} onChange={(cy) => update({ ...params, cy: cy + oy })} min={-10000} />
        <EditField label="R" valueMM={params.radius} units={u} onChange={(radius) => update({ ...params, radius })} />
      </>)
    case 'ellipse':
      return (<>
        <EditField label="CX" valueMM={params.cx - ox} units={u} onChange={(cx) => update({ ...params, cx: cx + ox })} min={-10000} />
        <EditField label="CY" valueMM={params.cy - oy} units={u} onChange={(cy) => update({ ...params, cy: cy + oy })} min={-10000} />
        <EditField label="RX" valueMM={params.rx} units={u} onChange={(rx) => update({ ...params, rx })} />
        <EditField label="RY" valueMM={params.ry} units={u} onChange={(ry) => update({ ...params, ry })} />
      </>)
    case 'shield':
      return (<>
        <EditField label="CX" valueMM={params.cx - ox} units={u} onChange={(cx) => update({ ...params, cx: cx + ox })} min={-10000} />
        <EditField label="CY" valueMM={params.cy - oy} units={u} onChange={(cy) => update({ ...params, cy: cy + oy })} min={-10000} />
        <EditField label="W"  valueMM={params.w}  units={u} onChange={(w)  => update({ ...params, w })} />
        <EditField label="H"  valueMM={params.h}  units={u} onChange={(h)  => update({ ...params, h })} />
      </>)
    case 'polygon':
      return (<>
        <EditField label="CX" valueMM={params.cx - ox} units={u} onChange={(cx) => update({ ...params, cx: cx + ox })} min={-10000} />
        <EditField label="CY" valueMM={params.cy - oy} units={u} onChange={(cy) => update({ ...params, cy: cy + oy })} min={-10000} />
        <EditField label="R" valueMM={params.radius} units={u} onChange={(radius) => update({ ...params, radius })} />
        <EditField label="N" valueMM={params.sides} units="" min={3} integer onChange={(sides) => update({ ...params, sides: Math.max(3, Math.round(sides)) })} />
      </>)
    case 'star':
      return (<>
        <EditField label="CX" valueMM={params.cx - ox} units={u} onChange={(cx) => update({ ...params, cx: cx + ox })} min={-10000} />
        <EditField label="CY" valueMM={params.cy - oy} units={u} onChange={(cy) => update({ ...params, cy: cy + oy })} min={-10000} />
        <EditField label="OR" valueMM={params.outerRadius} units={u} onChange={(outerRadius) => update({ ...params, outerRadius })} />
        <EditField label="IR" valueMM={params.innerRadius} units={u} onChange={(innerRadius) => update({ ...params, innerRadius })} />
        <EditField label="N" valueMM={params.points} units="" min={3} integer onChange={(points) => update({ ...params, points: Math.max(3, Math.round(points)) })} />
      </>)
    case 'heart':
      return (<>
        <EditField label="CX" valueMM={params.cx - ox} units={u} onChange={(cx) => update({ ...params, cx: cx + ox })} min={-10000} />
        <EditField label="CY" valueMM={params.cy - oy} units={u} onChange={(cy) => update({ ...params, cy: cy + oy })} min={-10000} />
        <EditField label="R" valueMM={params.curveRadius} units={u} onChange={(curveRadius) => update({ ...params, curveRadius })} />
        <EditField label="Ang" valueMM={params.angle} units="" integer min={1} onChange={(angle) => update({ ...params, angle: Math.min(179, Math.max(1, Math.round(angle))) })} />
      </>)
    case 'slot':
      return (<>
        <EditField label="CX"  valueMM={params.cx - ox}     units={u} onChange={(cx)     => update({ ...params, cx: cx + ox })} min={-10000} />
        <EditField label="CY"  valueMM={params.cy - oy}     units={u} onChange={(cy)     => update({ ...params, cy: cy + oy })} min={-10000} />
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
        <EditField label="X" valueMM={params.x - ox} units={u} onChange={(x) => updateText({ ...params, x: x + ox })} min={-10000} />
        <EditField label="Y" valueMM={params.y - oy} units={u} onChange={(y) => updateText({ ...params, y: y + oy })} min={-10000} />
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
  const selectedIds = usePathsStore((s) => s.selectedIds)
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

  // A move/scale/rotate/skew/mirror (or merged 'transform') timeline chip is
  // selected: show its recorded TransformStep recipe instead of the plain
  // shape/position fields below. Valid only while the cursor still sits on
  // this exact event AND the selection still matches its updated paths —
  // either changing invalidates it back to null (scrub away, select
  // something else, record a new edit).
  const events = useTimelineStore((s) => s.events)
  const cursor = useTimelineStore((s) => s.cursor)
  const transformEditEventId = useUIStore((s) => s.transformEditEventId)
  const setTransformEditEventId = useUIStore((s) => s.setTransformEditEventId)
  const transformEventRaw = transformEditEventId ? events.find((e) => e.id === transformEditEventId) : undefined
  const activeTransformEvent = transformEventRaw && transformEventRaw.kind === 'paths.edit' &&
    transformEventRaw.seq === cursor &&
    transformEventRaw.updates.length > 0 && transformEventRaw.updates.every((u) => u.transforms?.length) &&
    [...transformEventRaw.updates.map((u) => u.id)].sort().join(',') === [...selectedIds].sort().join(',')
    ? transformEventRaw
    : null
  useEffect(() => {
    if (transformEditEventId && !activeTransformEvent) setTransformEditEventId(null)
  }, [transformEditEventId, activeTransformEvent, setTransformEditEventId])

  // The stable reference for any step the active chip doesn't have YET — the
  // selection's bbox as it was just before this chip started, not its current
  // one (see fieldsFromSteps' doc comment for why that matters).
  //
  // Memoized because bboxBeforeEvent replays the timeline from the nearest
  // checkpoint (up to 25 events, and applyEvent re-runs clipper booleans, path
  // offsets and pattern instancing as it folds). Editing any field in this
  // chip calls amendTransformSteps → new events array → re-render, so an
  // unmemoized call put that replay on the keystroke path. The value is
  // deliberately independent of this chip's own payload, so amending it must
  // not recompute; a change to an EARLIER chip requires selecting a different
  // path first, which nulls activeTransformEvent and re-runs this anyway.
  const preChipBBoxRaw = useMemo(
    () => activeTransformEvent
      ? bboxBeforeEvent(activeTransformEvent.seq, activeTransformEvent.updates.map((u) => u.id))
      : null,
    [activeTransformEvent?.id, activeTransformEvent?.seq],
  )

  if (selectedPaths.length === 0) return null
  const bbox = getMultiBBox(selectedPaths.map((p) => p.d))
  if (!bbox) return null

  const fmt = (n: number) => n.toFixed(2)
  const singleShape = selectedPaths.length === 1 && selectedPaths[0].shapeParams ? selectedPaths[0] : null

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

  // Opens the transform editor below for the chip this gesture just
  // wrote/merged into, so it's visible immediately rather than only after a
  // later, unrelated timeline click.
  function openTransformEditorForTip() {
    const tl = useTimelineStore.getState()
    const ev = tl.events[tl.cursor - 1]
    if (ev && ev.kind === 'paths.edit' && ev.updates.every((u) => u.transforms?.length)) {
      setTransformEditEventId(ev.id)
    }
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
      openTransformEditorForTip()
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
      openTransformEditorForTip()
    }
  }

  if (activeTransformEvent) {
    const eventId = activeTransformEvent.id
    const rawSteps = activeTransformEvent.updates[0].transforms!
    const mirrorSteps = rawSteps.filter((s) => s.kind === 'mirror')
    const preChipBBox = preChipBBoxRaw ?? bbox
    const fields = fieldsFromSteps(
      rawSteps,
      { x: preChipBBox.cx, y: preChipBBox.cy },
      { x: preChipBBox.cx, y: preChipBBox.minY },
    )
    // Mirroring the CURRENTLY-VISIBLE shape about its own live center, while
    // leaving dX/dY exactly as they were: naively appending a mirror step
    // and re-consolidating (Gram-Schmidt over the whole chain) is what the
    // scale/rotate merge fix uses, but it has no way to prefer one valid
    // decomposition's translate value over another equally-correct one — it
    // was flipping dX's sign, which is legal geometry but not what "mirror
    // it" means to someone reading the dX field. So instead: keep every
    // existing step (scale/skew/rotate/mirror) frozen exactly as they are,
    // and insert the new mirror — pivoted at (live bbox − existing dx/dy) —
    // right before the UNCHANGED translate. That pivot choice is exactly
    // the one where "mirror about where it currently sits" and "keep dX/dY
    // fixed" are simultaneously true (verified algebraically and
    // numerically, including with an existing scale in the chain).
    const applyMirrorToChip = (axis: 'x' | 'y') => {
      const existingTranslate = rawSteps.find((s) => s.kind === 'translate')
      const tx = existingTranslate?.kind === 'translate' ? existingTranslate.dx : 0
      const ty = existingTranslate?.kind === 'translate' ? existingTranslate.dy : 0
      const mirror: TransformStep = { kind: 'mirror', axis, cx: bbox.cx - tx, cy: bbox.cy - ty }
      const nonTranslate = rawSteps.filter((s) => s.kind !== 'translate')
      const newSteps: TransformStep[] = [...nonTranslate, mirror, { kind: 'translate', dx: tx, dy: ty }]
      useTimelineStore.getState().amendTransformSteps(eventId, newSteps)
    }
    return (
      <div className={[
        'border-t border-gray-300 dark:border-neutral-700 px-3 py-2 flex-shrink-0 transition-shadow duration-300',
        flashing ? 'ring-2 ring-inset ring-blue-500' : '',
      ].join(' ')}>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-label font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider">
            {activeTransformEvent.label}
          </p>
          <button
            onClick={() => setTransformEditEventId(null)}
            title="Back to shape properties"
            className="text-gray-400 dark:text-neutral-500 hover:text-gray-700 dark:hover:text-neutral-300"
          >
            <X size={12} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <TransformFieldsEditor
            fields={fields}
            units={units}
            onChange={(newFields) => {
              const newSteps = stepsFromFields(newFields, mirrorSteps)
              useTimelineStore.getState().amendTransformSteps(eventId, newSteps)
            }}
          />
        </div>
        <div className="mt-1.5 flex gap-1.5">
          <button
            onClick={() => applyMirrorToChip('x')}
            title="Mirror horizontally (flip left/right)"
            className="flex-1 text-label py-1 rounded border transition-colors border-gray-200 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300"
          >
            <span className="inline-block">↔</span> Mirror X
          </button>
          <button
            onClick={() => applyMirrorToChip('y')}
            title="Mirror vertically (flip up/down)"
            className="flex-1 text-label py-1 rounded border transition-colors border-gray-200 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300"
          >
            <span className="inline-block rotate-90">↔</span> Mirror Y
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={[
      'border-t border-gray-300 dark:border-neutral-700 px-3 py-2 flex-shrink-0 transition-shadow duration-300',
      flashing ? 'ring-2 ring-inset ring-blue-500' : '',
    ].join(' ')}>
      <p className="text-label font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1.5">
        {selectedPaths.length === 1 ? selectedPaths[0].name : `${selectedPaths.length} paths`}
      </p>

      {singleShape?.shapeParams && liveRotationAngle === null && liveBBox === null ? (
        <div className="grid grid-cols-2 gap-1.5">
          <ShapeParamsEditor id={singleShape.id} params={singleShape.shapeParams} units={units} orgWorld={orgWorld} />
        </div>
      ) : (() => {
        // Corner-based shapes (rect/roundrect/text) show minX/minY; all others show bbox center
        const cornerBased = !singleShape?.shapeParams ||
          ['rectangle', 'roundrect', 'inroundrect', 'text'].includes(singleShape.shapeParams.type)
        const liveXLabel = cornerBased ? 'X' : 'CX'
        const liveYLabel = cornerBased ? 'Y' : 'CY'
        const liveX = cornerBased ? displayBBox!.minX : displayBBox!.minX + displayBBox!.width / 2
        const liveY = cornerBased ? displayBBox!.minY : displayBBox!.minY + displayBBox!.height / 2
        return (
          <div className="grid grid-cols-2 gap-1.5 space-y-0">
            <ReadField label={liveXLabel} value={fmt(liveX - orgWorld.x)} units="mm" />
            <ReadField label={liveYLabel} value={fmt(liveY - orgWorld.y)} units="mm" />
            <ReadField label="W" value={fmt(displayBBox!.width)} units="mm" />
            <ReadField label="H" value={fmt(displayBBox!.height)} units="mm" />
          </div>
        )
      })()}

      <div className="mt-1.5">
        <RotationField liveAngle={liveRotationAngle} onApply={applyRotation} />
      </div>

      <div className="mt-1.5 flex gap-1.5">
        <button
          onClick={() => applyMirror('x')}
          title="Mirror horizontally (flip left/right)"
          className="flex-1 text-label py-1 rounded border transition-colors border-gray-200 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300"
        >
          <span className="inline-block">↔</span> Mirror X
        </button>
        <button
          onClick={() => applyMirror('y')}
          title="Mirror vertically (flip up/down)"
          className="flex-1 text-label py-1 rounded border transition-colors border-gray-200 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300"
        >
          <span className="inline-block rotate-90">↔</span> Mirror Y
        </button>
      </div>

      {selectedPaths.length === 1 && (() => {
        const p = selectedPaths[0]
        const isCompound = splitCompoundPath(p.d).length > 1
        if (!isCompound) return null
        return (
          <button
            onClick={() => usePathsStore.getState().splitPath(p.id, splitCompoundPath(p.d))}
            className="mt-2 w-full text-label py-1 rounded border transition-colors border-gray-200 dark:border-neutral-600 text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300"
          >
            Split Paths
          </button>
        )
      })()}
    </div>
  )
}
