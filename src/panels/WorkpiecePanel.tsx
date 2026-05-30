import { useState } from 'react'
import { ICON } from '../theme'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  useWorkpieceStore,
  MATERIAL_INFO,
  type OriginPosition,
  type Units,
  type Material,
  fromMM,
  toMM,
} from '../store/workpieceStore'
import { NumericInput } from '../components/NumericInput'

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

  return (
    <div className="flex items-center gap-2 mb-1.5">
      <label className="text-gray-500 dark:text-neutral-400 text-body w-24 shrink-0">{label}</label>
      <div className="relative flex-1">
        <NumericInput
          value={displayVal}
          min={min}
          step={step}
          onChange={(v) => onChange(toMM(v, units))}
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

const MATERIALS = (Object.keys(MATERIAL_INFO) as Material[]).map((value) => ({
  value,
  label: MATERIAL_INFO[value].label,
}))

const RIGIDITY_LABELS: Record<number, string> = {
  1: 'Hobby (light gantry)',
  2: 'Light hobby',
  3: 'Prosumer',
  4: 'Heavy / industrial',
  5: 'Commercial CNC',
}

export default function WorkpiecePanel() {
  const {
    widthMM, heightMM, thicknessMM, units, origin, material,
    tableLimitWidthMM, tableLimitHeightMM, tableLimitDepthMM, safeHeightMM,
    machineRigidity, maxFeedMmMin, minSpindleRpm, maxSpindleRpm, autoFeedEnabled,
    setWidth, setHeight, setThickness, setOrigin, setMaterial,
    setTableLimitWidth, setTableLimitHeight, setTableLimitDepth, setSafeHeight,
    setMachineRigidity, setMaxFeed, setMinSpindleRpm, setMaxSpindleRpm, setAutoFeedEnabled,
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
              {m.label} (hardness {MATERIAL_INFO[m.value].hardness.toFixed(1)})
            </option>
          ))}
        </select>
        <p className="text-body text-gray-400 dark:text-neutral-500 mt-1.5">
          Hardness factor: {MATERIAL_INFO[material].hardness.toFixed(1)}
          <span className="text-gray-400 dark:text-neutral-600"> (used for auto feeds &amp; speeds)</span>
        </p>
      </Section>

      <Section title="Feeds &amp; Speeds">
        <label className="flex items-center gap-2 mb-3 cursor-pointer">
          <input
            type="checkbox"
            checked={autoFeedEnabled}
            onChange={(e) => setAutoFeedEnabled(e.target.checked)}
            className="accent-blue-500"
          />
          <span className="text-body text-gray-700 dark:text-neutral-300">
            Auto feed &amp; speeds
          </span>
        </label>
        <p className="text-body text-gray-400 dark:text-neutral-500 mb-3 -mt-1.5">
          When on, cutting feed and step-down are computed from material, tool and
          rigidity. If the machine can't feed fast enough for the target chip load,
          the spindle speed is lowered instead (a warning is added to the G-code —
          set it by hand if your machine has no spindle control). When off, the
          tool's own feeds and your step-down are used.
        </p>

        <div className="mb-3">
          <label className="block text-gray-500 dark:text-neutral-400 text-body mb-1">Machine Rigidity</label>
          <select
            value={machineRigidity}
            onChange={(e) => setMachineRigidity(parseInt(e.target.value))}
            className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-200 dark:border-neutral-600 rounded px-2 py-1.5 text-body text-gray-900 dark:text-neutral-100 focus:border-blue-500 focus:outline-none"
          >
            {[1, 2, 3, 4, 5].map((r) => (
              <option key={r} value={r}>
                {r} · {RIGIDITY_LABELS[r]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-gray-500 dark:text-neutral-400 text-body w-24 shrink-0">Max Feed Rate</label>
          <div className="relative flex-1">
            <NumericInput
              value={fromMM(maxFeedMmMin, units)}
              min={1}
              step={units === 'in' ? 1 : 50}
              onChange={(v) => setMaxFeed(toMM(v, units))}
              className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-200 dark:border-neutral-600 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:border-blue-500 focus:outline-none pr-14 font-mono"
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-body text-gray-400 dark:text-neutral-500 pointer-events-none">
              {units}/min
            </span>
          </div>
        </div>
        <p className="text-body text-gray-400 dark:text-neutral-500 mt-1">
          Hard ceiling — generated feeds never exceed this, even when auto is off.
        </p>

        {([
          ['Min Spindle', minSpindleRpm, setMinSpindleRpm] as const,
          ['Max Spindle', maxSpindleRpm, setMaxSpindleRpm] as const,
        ]).map(([label, value, onChange]) => (
          <div key={label} className="flex items-center gap-2 mt-3">
            <label className="text-gray-500 dark:text-neutral-400 text-body w-24 shrink-0">{label}</label>
            <div className="relative flex-1">
              <NumericInput
                value={value}
                min={1000}
                step={1000}
                onChange={onChange}
                className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-200 dark:border-neutral-600 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:border-blue-500 focus:outline-none pr-12 font-mono"
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-body text-gray-400 dark:text-neutral-500 pointer-events-none">
                rpm
              </span>
            </div>
          </div>
        ))}
        <p className="text-body text-gray-400 dark:text-neutral-500 mt-1">
          Auto mode picks a spindle speed in this range — as fast as needed to reach the
          max feed (shorter jobs). Set the min to your spindle's real floor (routers ≈10000)
          and lower the max if a material burns at high speed.
        </p>
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
        <DimInput
          label="Safe Height"
          valueMM={safeHeightMM}
          units={units}
          onChange={setSafeHeight}
          min={0.1}
        />
      </Section>
    </div>
  )
}
