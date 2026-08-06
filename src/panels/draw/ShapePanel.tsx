import { useEffect, useState } from 'react'
import { ICON } from '../../theme'
import { Square, Circle, Ellipse, Hexagon, Star as StarIcon, PenTool, Type, Squircle, Heart, Pill, Signpost, Shield, Orbit, ChevronDown } from 'lucide-react'
import { useUIStore } from '../../store/uiStore'
import { useWorkpieceStore, fromMM, toMM, fmtLen } from '../../store/workpieceStore'
import { spirographTurns, spirographRadii, spirographCentrePen, type ShapeType, type ShapeToolConfig } from '../../shapes/shapeGenerators'
import { loadFont, isFontLoaded } from '../../shapes/textGenerator'
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
