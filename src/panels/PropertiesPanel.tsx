import { useRef, useState } from 'react'
import { usePathsStore } from '../store/pathsStore'
import { splitCompoundPath } from '../canvas/nodeUtils'
import { regenerateAffected } from '../cam/regenerate'
import { useCanvasStore } from '../store/canvasStore'
import { useWorkpieceStore, fromMM, toMM } from '../store/workpieceStore'
import { getMultiBBox, rotateAroundD, mirrorD } from '../canvas/selectionUtils'
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
  const { paths, selectedIds } = usePathsStore()
  const liveRotationAngle = useCanvasStore((s) => s.liveRotationAngle)
  const liveBBox = useCanvasStore((s) => s.liveBBox)
  const { units, origin, widthMM, heightMM } = useWorkpieceStore()
  const orgWorld = originWorldXY(origin, widthMM, heightMM)
  const selectedPaths = paths.filter((p) => selectedIds.includes(p.id))

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

  function applyRotation(angle: number) {
    if (!bbox) return
    const cx = (bbox.minX + bbox.maxX) / 2
    const cy = (bbox.minY + bbox.maxY) / 2
    const { paths: allPaths, batchUpdatePaths } = usePathsStore.getState()
    const updates = selectedPaths
      .map((p) => allPaths.find((ap) => ap.id === p.id))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => ({ id: p.id, d: rotateAroundD(p.d, cx, cy, angle), shapeParams: null as null }))
    if (updates.length) {
      batchUpdatePaths(updates)
      for (const { id } of selectedPaths) regenerateAffected(id)
    }
  }

  function applyMirror(axis: 'x' | 'y') {
    if (!bbox) return
    const cx = (bbox.minX + bbox.maxX) / 2
    const cy = (bbox.minY + bbox.maxY) / 2
    const { paths: allPaths, batchUpdatePaths } = usePathsStore.getState()
    const updates = selectedPaths
      .map((p) => allPaths.find((ap) => ap.id === p.id))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => ({ id: p.id, d: mirrorD(p.d, axis, cx, cy), shapeParams: null as null }))
    if (updates.length) {
      batchUpdatePaths(updates)
      for (const { id } of selectedPaths) regenerateAffected(id)
    }
  }

  return (
    <div className="border-t border-gray-300 dark:border-neutral-700 px-3 py-2 flex-shrink-0">
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
