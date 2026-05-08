import { Square, Circle, Hexagon, Star as StarIcon, PenTool } from 'lucide-react'
import { useUIStore } from '../../store/uiStore'
import { useWorkpieceStore, fromMM, toMM } from '../../store/workpieceStore'
import type { ShapeType, ShapeToolConfig } from '../../shapes/shapeGenerators'

function RoundRectIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1.5" y="2.5" width="11" height="9" rx="2.5" />
    </svg>
  )
}

function EllipseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <ellipse cx="7" cy="7" rx="5.5" ry="3.5" />
    </svg>
  )
}

const SHAPES: { type: ShapeType; label: string; icon: React.ReactNode }[] = [
  { type: 'rectangle', label: 'Rect', icon: <Square size={14} /> },
  { type: 'roundrect', label: 'Round', icon: <RoundRectIcon /> },
  { type: 'circle', label: 'Circle', icon: <Circle size={14} /> },
  { type: 'ellipse', label: 'Ellipse', icon: <EllipseIcon /> },
  { type: 'polygon', label: 'Polygon', icon: <Hexagon size={14} /> },
  { type: 'star', label: 'Star', icon: <StarIcon size={14} /> },
]

function NumInput({
  label,
  valueMM,
  units,
  onChange,
  min = 0.1,
  step,
  integer,
}: {
  label: string
  valueMM: number
  units: string
  onChange: (mm: number) => void
  min?: number
  step?: number
  integer?: boolean
}) {
  const display = integer ? valueMM : fromMM(valueMM, units as 'mm' | 'in')
  const s = step ?? (integer ? 1 : units === 'in' ? 0.0625 : 1)

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-neutral-500 text-[10px] w-12 flex-shrink-0">{label}</span>
      <input
        type="number"
        value={+display.toFixed(integer ? 0 : 4)}
        min={min}
        step={s}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (!isNaN(v) && v >= min) {
            onChange(integer ? v : toMM(v, units as 'mm' | 'in'))
          }
        }}
        className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-1.5 py-0.5 text-xs text-neutral-200 font-mono w-0"
      />
      {!integer && <span className="text-neutral-500 text-[10px] flex-shrink-0">{units}</span>}
    </div>
  )
}

function ShapeConfig({ type, config, onChange, units }: {
  type: ShapeType
  config: ShapeToolConfig
  onChange: (c: ShapeToolConfig) => void
  units: string
}) {
  const c = config
  const u = units

  switch (type) {
    case 'rectangle':
      return (
        <div className="space-y-1">
          <NumInput label="Width" valueMM={c.rectangle.w} units={u} onChange={(w) => onChange({ ...c, rectangle: { ...c.rectangle, w } })} />
          <NumInput label="Height" valueMM={c.rectangle.h} units={u} onChange={(h) => onChange({ ...c, rectangle: { ...c.rectangle, h } })} />
        </div>
      )
    case 'roundrect':
      return (
        <div className="space-y-1">
          <NumInput label="Width" valueMM={c.roundrect.w} units={u} onChange={(w) => onChange({ ...c, roundrect: { ...c.roundrect, w } })} />
          <NumInput label="Height" valueMM={c.roundrect.h} units={u} onChange={(h) => onChange({ ...c, roundrect: { ...c.roundrect, h } })} />
          <NumInput label="Radius" valueMM={c.roundrect.r} units={u} min={0} onChange={(r) => onChange({ ...c, roundrect: { ...c.roundrect, r } })} />
        </div>
      )
    case 'circle':
      return (
        <div className="space-y-1">
          <NumInput label="Radius" valueMM={c.circle.radius} units={u} onChange={(radius) => onChange({ ...c, circle: { radius } })} />
        </div>
      )
    case 'ellipse':
      return (
        <div className="space-y-1">
          <NumInput label="Width" valueMM={c.ellipse.rx * 2} units={u} onChange={(w) => onChange({ ...c, ellipse: { ...c.ellipse, rx: w / 2 } })} />
          <NumInput label="Height" valueMM={c.ellipse.ry * 2} units={u} onChange={(h) => onChange({ ...c, ellipse: { ...c.ellipse, ry: h / 2 } })} />
        </div>
      )
    case 'polygon':
      return (
        <div className="space-y-1">
          <NumInput label="Radius" valueMM={c.polygon.radius} units={u} onChange={(radius) => onChange({ ...c, polygon: { ...c.polygon, radius } })} />
          <NumInput label="Sides" valueMM={c.polygon.sides} units="" min={3} integer onChange={(sides) => onChange({ ...c, polygon: { ...c.polygon, sides: Math.max(3, Math.round(sides)) } })} />
        </div>
      )
    case 'star':
      return (
        <div className="space-y-1">
          <NumInput label="Outer R" valueMM={c.star.outerRadius} units={u} onChange={(r) => onChange({ ...c, star: { ...c.star, outerRadius: r } })} />
          <NumInput label="Inner R" valueMM={c.star.innerRadius} units={u} onChange={(r) => onChange({ ...c, star: { ...c.star, innerRadius: r } })} />
          <NumInput label="Points" valueMM={c.star.points} units="" min={3} integer onChange={(pts) => onChange({ ...c, star: { ...c.star, points: Math.max(3, Math.round(pts)) } })} />
        </div>
      )
  }
}

export default function ShapePanel() {
  const { activeTool, setActiveTool, shapeToolConfig, setShapeToolConfig } = useUIStore()
  const { units } = useWorkpieceStore()

  return (
    <>
    <div className="px-3 py-2 space-y-2 border-b border-neutral-700">
      <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Draw</p>
      <div className="grid grid-cols-3 gap-1">
        <button
          onClick={() => setActiveTool(activeTool === 'pen' ? 'select' : 'pen')}
          title="Pen Tool — click to add points, drag for curves"
          className={[
            'flex flex-col items-center gap-0.5 py-1.5 rounded text-xs transition-colors border',
            activeTool === 'pen'
              ? 'border-violet-500 bg-violet-500/20 text-violet-400'
              : 'border-neutral-600 text-neutral-400 hover:border-neutral-500 hover:text-neutral-300',
          ].join(' ')}
        >
          <PenTool size={14} />
          <span className="text-[10px]">Pen</span>
        </button>
      </div>
    </div>
    <div className="px-3 py-2 space-y-2 border-b border-neutral-700">
      <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Shapes</p>
      <div className="grid grid-cols-3 gap-1">
        {SHAPES.map(({ type, label, icon }) => (
          <button
            key={type}
            onClick={() => {
              setActiveTool(activeTool === type ? 'select' : type)
            }}
            title={label}
            className={[
              'flex flex-col items-center gap-0.5 py-1.5 rounded text-xs transition-colors border',
              activeTool === type
                ? 'border-blue-500 bg-blue-500/20 text-blue-400'
                : 'border-neutral-600 text-neutral-400 hover:border-neutral-500 hover:text-neutral-300',
            ].join(' ')}
          >
            {icon}
            <span className="text-[10px]">{label}</span>
          </button>
        ))}
      </div>

      {activeTool !== 'select' && activeTool !== 'pen' && (
        <div className="space-y-1.5 pt-0.5">
          <p className="text-[10px] text-neutral-500 font-medium capitalize">
            {activeTool} defaults
          </p>
          <ShapeConfig
            type={activeTool as ShapeType}
            config={shapeToolConfig}
            onChange={setShapeToolConfig}
            units={units}
          />
        </div>
      )}
    </div>
    </>
  )
}
