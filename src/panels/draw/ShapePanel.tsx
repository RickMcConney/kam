import { useEffect, useState } from 'react'
import { ICON } from '../../theme'
import { Square, Circle, Ellipse, Hexagon, Star as StarIcon, PenTool, Type, Squircle } from 'lucide-react'
import { useUIStore } from '../../store/uiStore'
import { useWorkpieceStore, fromMM, toMM } from '../../store/workpieceStore'
import type { ShapeType, ShapeToolConfig } from '../../shapes/shapeGenerators'
import { AVAILABLE_FONTS, loadFont, isFontLoaded } from '../../shapes/textGenerator'
import { PATH_COLOR } from '../../colors'
import { NumericInput } from '../../components/NumericInput'


const SHAPES: { type: ShapeType; label: string; icon: React.ReactNode }[] = [
  { type: 'rectangle', label: 'Rect',    icon: <Square size={ICON.md} /> },
  { type: 'roundrect', label: 'Round',   icon: <Squircle size={ICON.md} /> },
  { type: 'circle',    label: 'Circle',  icon: <Circle size={ICON.md} /> },
  { type: 'ellipse',   label: 'Ellipse', icon: <Ellipse size={ICON.md} /> },
  { type: 'polygon',   label: 'Polygon', icon: <Hexagon size={ICON.md} /> },
  { type: 'star',      label: 'Star',    icon: <StarIcon size={ICON.md} /> },
  { type: 'text',      label: 'Text',    icon: <Type size={ICON.md} /> },
]

const inputCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-1.5 py-0.5 text-body text-gray-800 dark:text-neutral-200 font-mono w-0'
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
        onChange={(v) => onChange(integer ? v : toMM(v, units as 'mm' | 'in'))}
        className={inputCls}
      />
      {!integer && <span className="text-gray-400 dark:text-neutral-500 text-label flex-shrink-0">{units}</span>}
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
          <select value={c.text.fontFamily} onChange={(e) => onChange({ ...c, text: { ...c.text, fontFamily: e.target.value } })}
            className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-1 py-0.5 text-body text-gray-800 dark:text-neutral-200 w-0">
            {AVAILABLE_FONTS.map((f) => <option key={f.family} value={f.family}>{f.label}</option>)}
          </select>
        </div>
      </div>)
  }
}

const toolBtnCls = (active: boolean) =>
  [
    'flex flex-col items-center gap-0.5 py-1.5 rounded text-body transition-colors border',
    active
      ? 'border-blue-500 bg-blue-500/20'
      : 'border-gray-200 dark:border-neutral-600 hover:border-gray-300 dark:hover:border-neutral-500',
  ].join(' ')


// ─── Main ShapePanel ──────────────────────────────────────────────────────────

export default function ShapePanel() {
  const { activeTool, setActiveTool, shapeToolConfig, setShapeToolConfig } = useUIStore()
  const { units } = useWorkpieceStore()

  const [fontReady, setFontReady] = useState(() => isFontLoaded(shapeToolConfig.text.fontFamily))

  useEffect(() => {
    if (activeTool !== 'text') return
    const family = shapeToolConfig.text.fontFamily
    if (isFontLoaded(family)) { setFontReady(true); return }
    setFontReady(false)
    loadFont(family).then(() => setFontReady(true))
  }, [activeTool, shapeToolConfig.text.fontFamily])

  useEffect(() => { loadFont(shapeToolConfig.text.fontFamily) }, [shapeToolConfig.text.fontFamily])

  return (
    <>
      <div className="px-3 py-2 space-y-2 border-b border-gray-300 dark:border-neutral-700">
        <p className="text-label font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider">Draw</p>
        <div className="grid grid-cols-3 gap-1">
          <button onClick={() => setActiveTool(activeTool === 'pen' ? 'select' : 'pen')}
            title="Pen Tool — click to add points, drag for curves"
            className={toolBtnCls(activeTool === 'pen')}>
            <span style={{ color: PATH_COLOR }}><PenTool size={ICON.md} /></span>
            <span className="text-label text-gray-500 dark:text-neutral-400">Pen</span>
          </button>
        </div>
      </div>

      <div className="px-3 py-2 space-y-2 border-b border-gray-300 dark:border-neutral-700">
        <p className="text-label font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider">Shapes</p>
        <div className="grid grid-cols-3 gap-1">
          {SHAPES.map(({ type, label, icon }) => (
            <button key={type} onClick={() => setActiveTool(activeTool === type ? 'select' : type)}
              title={label} className={toolBtnCls(activeTool === type)}>
              <span style={{ color: PATH_COLOR }}>{icon}</span>
              <span className="text-label text-gray-500 dark:text-neutral-400">{label}</span>
            </button>
          ))}
        </div>

        {activeTool !== 'select' && activeTool !== 'pen' && (
          <div className="space-y-1.5 pt-0.5">
            <p className="text-label text-gray-400 dark:text-neutral-500 font-medium capitalize">
              {activeTool} defaults
            </p>
            {activeTool === 'text' && !fontReady && (
              <p className="text-label text-yellow-500">Loading font…</p>
            )}
            <ShapeConfig type={activeTool as ShapeType} config={shapeToolConfig} onChange={setShapeToolConfig} units={units} />
          </div>
        )}
      </div>

    </>
  )
}
