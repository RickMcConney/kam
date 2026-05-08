import { usePathsStore } from '../store/pathsStore'
import { regenerateAffected } from '../cam/regenerate'
import { useCanvasStore } from '../store/canvasStore'
import { useUIStore } from '../store/uiStore'
import { useWorkpieceStore, fromMM, toMM } from '../store/workpieceStore'
import { getMultiBBox } from '../canvas/selectionUtils'
import type { ShapeParams } from '../shapes/shapeGenerators'

function ReadField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-neutral-500 text-[10px] w-5 flex-shrink-0">{label}</span>
      <span className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-1.5 py-0.5 text-xs text-neutral-200 font-mono tabular-nums">
        {value}
      </span>
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
      <span className="text-neutral-500 text-[10px] w-5 flex-shrink-0">{label}</span>
      <input
        type="number"
        value={+display.toFixed(integer ? 0 : 4)}
        min={min}
        step={step}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (!isNaN(v) && v >= min) onChange(integer ? v : toMM(v, units as 'mm' | 'in'))
        }}
        className="flex-1 bg-neutral-900 border border-neutral-600 rounded px-1.5 py-0.5 text-xs text-neutral-200 font-mono w-0 focus:outline-none focus:border-blue-500"
      />
      {!integer && <span className="text-neutral-500 text-[10px] flex-shrink-0">{units}</span>}
    </div>
  )
}

function ShapeParamsEditor({
  id,
  params,
  units,
}: {
  id: string
  params: ShapeParams
  units: string
}) {
  const updateShapeParams = usePathsStore((s) => s.updateShapeParams)

  const update = (newParams: ShapeParams) => { updateShapeParams(id, newParams); regenerateAffected(id) }
  const u = units

  switch (params.type) {
    case 'rectangle':
      return (
        <>
          <EditField label="X" valueMM={params.x} units={u} onChange={(x) => update({ ...params, x })} min={-10000} />
          <EditField label="Y" valueMM={params.y} units={u} onChange={(y) => update({ ...params, y })} min={-10000} />
          <EditField label="W" valueMM={params.w} units={u} onChange={(w) => update({ ...params, w })} />
          <EditField label="H" valueMM={params.h} units={u} onChange={(h) => update({ ...params, h })} />
        </>
      )
    case 'roundrect':
      return (
        <>
          <EditField label="X" valueMM={params.x} units={u} onChange={(x) => update({ ...params, x })} min={-10000} />
          <EditField label="Y" valueMM={params.y} units={u} onChange={(y) => update({ ...params, y })} min={-10000} />
          <EditField label="W" valueMM={params.w} units={u} onChange={(w) => update({ ...params, w })} />
          <EditField label="H" valueMM={params.h} units={u} onChange={(h) => update({ ...params, h })} />
          <EditField label="R" valueMM={params.r} units={u} onChange={(r) => update({ ...params, r })} min={0} />
        </>
      )
    case 'circle':
      return (
        <>
          <EditField label="CX" valueMM={params.cx} units={u} onChange={(cx) => update({ ...params, cx })} min={-10000} />
          <EditField label="CY" valueMM={params.cy} units={u} onChange={(cy) => update({ ...params, cy })} min={-10000} />
          <EditField label="R" valueMM={params.radius} units={u} onChange={(radius) => update({ ...params, radius })} />
        </>
      )
    case 'ellipse':
      return (
        <>
          <EditField label="CX" valueMM={params.cx} units={u} onChange={(cx) => update({ ...params, cx })} min={-10000} />
          <EditField label="CY" valueMM={params.cy} units={u} onChange={(cy) => update({ ...params, cy })} min={-10000} />
          <EditField label="RX" valueMM={params.rx} units={u} onChange={(rx) => update({ ...params, rx })} />
          <EditField label="RY" valueMM={params.ry} units={u} onChange={(ry) => update({ ...params, ry })} />
        </>
      )
    case 'polygon':
      return (
        <>
          <EditField label="CX" valueMM={params.cx} units={u} onChange={(cx) => update({ ...params, cx })} min={-10000} />
          <EditField label="CY" valueMM={params.cy} units={u} onChange={(cy) => update({ ...params, cy })} min={-10000} />
          <EditField label="R" valueMM={params.radius} units={u} onChange={(radius) => update({ ...params, radius })} />
          <EditField label="N" valueMM={params.sides} units="" min={3} integer onChange={(sides) => update({ ...params, sides: Math.max(3, Math.round(sides)) })} />
        </>
      )
    case 'star':
      return (
        <>
          <EditField label="CX" valueMM={params.cx} units={u} onChange={(cx) => update({ ...params, cx })} min={-10000} />
          <EditField label="CY" valueMM={params.cy} units={u} onChange={(cy) => update({ ...params, cy })} min={-10000} />
          <EditField label="OR" valueMM={params.outerRadius} units={u} onChange={(outerRadius) => update({ ...params, outerRadius })} />
          <EditField label="IR" valueMM={params.innerRadius} units={u} onChange={(innerRadius) => update({ ...params, innerRadius })} />
          <EditField label="N" valueMM={params.points} units="" min={3} integer onChange={(points) => update({ ...params, points: Math.max(3, Math.round(points)) })} />
        </>
      )
  }
}

export default function PropertiesPanel() {
  const { paths, selectedIds } = usePathsStore()
  const liveRotationAngle = useCanvasStore((s) => s.liveRotationAngle)
  const { units } = useWorkpieceStore()
  const nodeEditPathId = useUIStore((s) => s.nodeEditPathId)
  const setNodeEditPathId = useUIStore((s) => s.setNodeEditPathId)
  const selectedPaths = paths.filter((p) => selectedIds.includes(p.id))

  if (selectedPaths.length === 0) return null

  const bbox = getMultiBBox(selectedPaths.map((p) => p.d))
  if (!bbox) return null

  const fmt = (n: number) => n.toFixed(2)
  const fmtAngle = (n: number) => `${n.toFixed(1)}°`

  const singleShape = selectedPaths.length === 1 && selectedPaths[0].shapeParams
    ? selectedPaths[0]
    : null

  return (
    <div className="border-t border-neutral-700 px-3 py-2 flex-shrink-0">
      <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-1.5">
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
        <ReadField
          label="∠"
          value={liveRotationAngle !== null ? fmtAngle(liveRotationAngle) : '0.0°'}
        />
      </div>

      {selectedPaths.length === 1 && (
        <button
          onClick={() => {
            const id = selectedPaths[0].id
            setNodeEditPathId(nodeEditPathId === id ? null : id)
          }}
          className={[
            'mt-2 w-full text-[10px] py-1 rounded border transition-colors',
            nodeEditPathId === selectedPaths[0].id
              ? 'border-emerald-500 bg-emerald-500/20 text-emerald-400'
              : 'border-neutral-600 text-neutral-400 hover:border-neutral-500 hover:text-neutral-300',
          ].join(' ')}
        >
          {nodeEditPathId === selectedPaths[0].id ? 'Exit Point Edit' : 'Edit Points'}
        </button>
      )}
    </div>
  )
}
