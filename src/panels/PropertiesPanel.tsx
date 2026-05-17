import { usePathsStore } from '../store/pathsStore'
import { splitCompoundPath } from '../canvas/nodeUtils'
import { regenerateAffected } from '../cam/regenerate'
import { useCanvasStore } from '../store/canvasStore'
import { useWorkpieceStore, fromMM, toMM } from '../store/workpieceStore'
import { getMultiBBox } from '../canvas/selectionUtils'
import type { ShapeParams } from '../shapes/shapeGenerators'
import { AVAILABLE_FONTS, loadFont } from '../shapes/textGenerator'
import { NumericInput } from '../components/NumericInput'

const fieldCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-200 dark:border-neutral-600 rounded px-1.5 py-0.5 text-body text-gray-800 dark:text-neutral-200 font-mono w-0 focus:outline-none focus:border-blue-500'
const labelCls = 'text-gray-400 dark:text-neutral-500 text-label w-5 flex-shrink-0'

function ReadField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={labelCls}>{label}</span>
      <span className={fieldCls + ' tabular-nums'}>{value}</span>
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

function ShapeParamsEditor({ id, params, units }: { id: string; params: ShapeParams; units: string }) {
  const updateShapeParams = usePathsStore((s) => s.updateShapeParams)
  const update = (newParams: ShapeParams) => { updateShapeParams(id, newParams); regenerateAffected(id) }
  const u = units

  switch (params.type) {
    case 'rectangle':
      return (<>
        <EditField label="X" valueMM={params.x} units={u} onChange={(x) => update({ ...params, x })} min={-10000} />
        <EditField label="Y" valueMM={params.y} units={u} onChange={(y) => update({ ...params, y })} min={-10000} />
        <EditField label="W" valueMM={params.w} units={u} onChange={(w) => update({ ...params, w })} />
        <EditField label="H" valueMM={params.h} units={u} onChange={(h) => update({ ...params, h })} />
      </>)
    case 'roundrect':
      return (<>
        <EditField label="X" valueMM={params.x} units={u} onChange={(x) => update({ ...params, x })} min={-10000} />
        <EditField label="Y" valueMM={params.y} units={u} onChange={(y) => update({ ...params, y })} min={-10000} />
        <EditField label="W" valueMM={params.w} units={u} onChange={(w) => update({ ...params, w })} />
        <EditField label="H" valueMM={params.h} units={u} onChange={(h) => update({ ...params, h })} />
        <EditField label="R" valueMM={params.r} units={u} onChange={(r) => update({ ...params, r })} min={0} />
      </>)
    case 'circle':
      return (<>
        <EditField label="CX" valueMM={params.cx} units={u} onChange={(cx) => update({ ...params, cx })} min={-10000} />
        <EditField label="CY" valueMM={params.cy} units={u} onChange={(cy) => update({ ...params, cy })} min={-10000} />
        <EditField label="R" valueMM={params.radius} units={u} onChange={(radius) => update({ ...params, radius })} />
      </>)
    case 'ellipse':
      return (<>
        <EditField label="CX" valueMM={params.cx} units={u} onChange={(cx) => update({ ...params, cx })} min={-10000} />
        <EditField label="CY" valueMM={params.cy} units={u} onChange={(cy) => update({ ...params, cy })} min={-10000} />
        <EditField label="RX" valueMM={params.rx} units={u} onChange={(rx) => update({ ...params, rx })} />
        <EditField label="RY" valueMM={params.ry} units={u} onChange={(ry) => update({ ...params, ry })} />
      </>)
    case 'polygon':
      return (<>
        <EditField label="CX" valueMM={params.cx} units={u} onChange={(cx) => update({ ...params, cx })} min={-10000} />
        <EditField label="CY" valueMM={params.cy} units={u} onChange={(cy) => update({ ...params, cy })} min={-10000} />
        <EditField label="R" valueMM={params.radius} units={u} onChange={(radius) => update({ ...params, radius })} />
        <EditField label="N" valueMM={params.sides} units="" min={3} integer onChange={(sides) => update({ ...params, sides: Math.max(3, Math.round(sides)) })} />
      </>)
    case 'star':
      return (<>
        <EditField label="CX" valueMM={params.cx} units={u} onChange={(cx) => update({ ...params, cx })} min={-10000} />
        <EditField label="CY" valueMM={params.cy} units={u} onChange={(cy) => update({ ...params, cy })} min={-10000} />
        <EditField label="OR" valueMM={params.outerRadius} units={u} onChange={(outerRadius) => update({ ...params, outerRadius })} />
        <EditField label="IR" valueMM={params.innerRadius} units={u} onChange={(innerRadius) => update({ ...params, innerRadius })} />
        <EditField label="N" valueMM={params.points} units="" min={3} integer onChange={(points) => update({ ...params, points: Math.max(3, Math.round(points)) })} />
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
        <EditField label="X" valueMM={params.x} units={u} onChange={(x) => updateText({ ...params, x })} min={-10000} />
        <EditField label="Y" valueMM={params.y} units={u} onChange={(y) => updateText({ ...params, y })} min={-10000} />
        <EditField label="Sz" valueMM={params.fontSize} units={u} min={0.1} onChange={(fontSize) => updateText({ ...params, fontSize })} />
        <div className="flex items-center gap-1.5">
          <span className={labelCls}>Fnt</span>
          <select value={params.fontFamily} onChange={(e) => updateText({ ...params, fontFamily: e.target.value })}
            className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-200 dark:border-neutral-600 rounded px-1 py-0.5 text-body text-gray-800 dark:text-neutral-200 w-0 focus:outline-none focus:border-blue-500">
            {AVAILABLE_FONTS.map((f) => <option key={f.family} value={f.family}>{f.label}</option>)}
          </select>
        </div>
      </>)
    }
  }
}


export default function PropertiesPanel() {
  const { paths, selectedIds } = usePathsStore()
  const liveRotationAngle = useCanvasStore((s) => s.liveRotationAngle)
  const { units } = useWorkpieceStore()
  const selectedPaths = paths.filter((p) => selectedIds.includes(p.id))

  if (selectedPaths.length === 0) return null
  const bbox = getMultiBBox(selectedPaths.map((p) => p.d))
  if (!bbox) return null

  const fmt = (n: number) => n.toFixed(2)
  const fmtAngle = (n: number) => `${n.toFixed(1)}°`
  const singleShape = selectedPaths.length === 1 && selectedPaths[0].shapeParams ? selectedPaths[0] : null

  return (
    <div className="border-t border-gray-300 dark:border-neutral-700 px-3 py-2 flex-shrink-0">
      <p className="text-label font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1.5">
        {selectedPaths.length === 1 ? selectedPaths[0].name : `${selectedPaths.length} paths`}
      </p>

      {singleShape?.shapeParams ? (
        <div className="space-y-1">
          <ShapeParamsEditor id={singleShape.id} params={singleShape.shapeParams} units={units} />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1.5 space-y-0">
          <ReadField label="X" value={`${fmt(bbox.minX)} mm`} />
          <ReadField label="Y" value={`${fmt(bbox.minY)} mm`} />
          <ReadField label="W" value={`${fmt(bbox.width)} mm`} />
          <ReadField label="H" value={`${fmt(bbox.height)} mm`} />
        </div>
      )}

      <div className="mt-1.5">
        <ReadField label="∠" value={liveRotationAngle !== null ? fmtAngle(liveRotationAngle) : '0.0°'} />
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
