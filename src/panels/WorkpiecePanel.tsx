import { useState } from 'react'
import { ICON } from '../theme'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  useWorkpieceStore,
  type OriginPosition,
  type Units,
  type Material,
  fromMM,
  toMM,
} from '../store/workpieceStore'

function DimInput({
  label,
  valueMM,
  units,
  onChange,
  min = 0.1,
}: {
  label: string
  valueMM: number
  units: Units
  onChange: (mm: number) => void
  min?: number
}) {
  const displayVal = fromMM(valueMM, units)
  const step = units === 'in' ? 0.0625 : 1

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value)
    if (!isNaN(v) && v >= min) onChange(toMM(v, units))
  }

  return (
    <div className="flex items-center gap-2 mb-1.5">
      <label className="text-gray-500 dark:text-neutral-400 text-body w-24 shrink-0">{label}</label>
      <div className="relative flex-1">
        <input
          type="number"
          value={displayVal}
          onChange={handleChange}
          min={min}
          step={step}
          className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-200 dark:border-neutral-600 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:border-blue-500 focus:outline-none pr-8 font-mono"
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-body text-gray-400 dark:text-neutral-500 pointer-events-none">
          {units}
        </span>
      </div>
    </div>
  )
}

const ORIGIN_GRID: OriginPosition[][] = [
  ['top-left', 'top-center', 'top-right'],
  ['mid-left', 'center', 'mid-right'],
  ['bottom-left', 'bottom-center', 'bottom-right'],
]

function OriginSelector({
  value,
  onChange,
}: {
  value: OriginPosition
  onChange: (o: OriginPosition) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="inline-grid grid-cols-3 gap-1 p-1.5 bg-gray-50 dark:bg-neutral-900 rounded border border-gray-300 dark:border-neutral-700 w-fit">
        {ORIGIN_GRID.map((row) =>
          row.map((pos) => {
            const active = value === pos
            return (
              <button
                key={pos}
                title={pos.replace(/-/g, ' ')}
                onClick={() => onChange(pos)}
                className={[
                  'w-8 h-8 rounded flex items-center justify-center transition-colors border',
                  active
                    ? 'bg-blue-600 border-blue-400'
                    : 'bg-gray-100 dark:bg-neutral-800 border-gray-200 dark:border-neutral-600 hover:bg-gray-200 dark:hover:bg-neutral-700',
                ].join(' ')}
              >
                <div
                  className={[
                    'w-2 h-2 rounded-full',
                    active ? 'bg-white' : 'bg-gray-300 dark:bg-neutral-600',
                  ].join(' ')}
                />
              </button>
            )
          })
        )}
      </div>
      <p className="text-body text-gray-400 dark:text-neutral-500 capitalize">
        {value.replace(/-/g, ' ')}
      </p>
    </div>
  )
}

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-gray-300 dark:border-neutral-700">
      <button
        className="w-full flex items-center gap-1.5 px-3 py-2 text-body font-semibold text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 uppercase tracking-wider transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown size={ICON.xs} /> : <ChevronRight size={ICON.xs} />}
        {title}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  )
}

const MATERIALS: { value: Material; label: string }[] = [
  { value: 'pine', label: 'Pine' },
  { value: 'oak', label: 'Oak' },
  { value: 'maple', label: 'Maple' },
  { value: 'walnut', label: 'Walnut' },
  { value: 'cherry', label: 'Cherry' },
  { value: 'mdf', label: 'MDF' },
  { value: 'plywood', label: 'Plywood' },
  { value: 'hdpe', label: 'HDPE' },
  { value: 'aluminum', label: 'Aluminum' },
  { value: 'other', label: 'Other' },
]

export default function WorkpiecePanel() {
  const {
    widthMM, heightMM, thicknessMM, units, origin, material,
    tableLimitWidthMM, tableLimitHeightMM, tableLimitDepthMM,
    setWidth, setHeight, setThickness, setOrigin, setMaterial,
    setTableLimitWidth, setTableLimitHeight, setTableLimitDepth,
  } = useWorkpieceStore()

  return (
    <div className="flex flex-col">
      <Section title="Stock Dimensions">
        <DimInput label="Width (X)" valueMM={widthMM} units={units} onChange={setWidth} />
        <DimInput label="Height (Y)" valueMM={heightMM} units={units} onChange={setHeight} />
        <DimInput label="Thickness (Z)" valueMM={thicknessMM} units={units} onChange={setThickness} />
      </Section>

      <Section title="Work Origin">
        <p className="text-body text-gray-400 dark:text-neutral-500 mb-2">
          Select the X=0, Y=0 reference point on the stock.
        </p>
        <OriginSelector value={origin} onChange={setOrigin} />
      </Section>

      <Section title="Material">
        <select
          value={material}
          onChange={(e) => setMaterial(e.target.value as Material)}
          className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-200 dark:border-neutral-600 rounded px-2 py-1.5 text-body text-gray-900 dark:text-neutral-100 focus:border-blue-500 focus:outline-none"
        >
          {MATERIALS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Section>

      <Section title="Machine Travel Limits">
        <p className="text-body text-gray-400 dark:text-neutral-500 mb-2">
          Maximum travel for pre-export validation.
        </p>
        <DimInput
          label="Table Width"
          valueMM={tableLimitWidthMM}
          units={units}
          onChange={setTableLimitWidth}
        />
        <DimInput
          label="Table Height"
          valueMM={tableLimitHeightMM}
          units={units}
          onChange={setTableLimitHeight}
        />
        <DimInput
          label="Max Cut Depth"
          valueMM={tableLimitDepthMM}
          units={units}
          onChange={setTableLimitDepth}
        />
      </Section>
    </div>
  )
}
