// Field rows shared by the Draw panels (ShapePanel, ClockPanel).
//
// These are the COMPACT rows the draw sidebar uses — a narrow label beside the
// field — which is a different layout from the stacked machine-form fields in
// panels/machine/shared.tsx. Both obey the same rule: every numeric field goes
// through NumericInput, never a bare <input type="number">, or the browser eats
// the '/' keystroke and a typed fraction can never be entered.

import { fromMM, toMM } from '../../store/workpieceStore'
import { NumericInput } from '../../components/NumericInput'

export const inputCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-1.5 py-0.5 text-body text-gray-800 dark:text-neutral-200 font-mono w-0'
export const labelCls = 'text-gray-400 dark:text-neutral-500 text-label w-14 flex-shrink-0'
export const selectCls = inputCls + ' cursor-pointer'
export const noteCls = 'text-label text-gray-400 dark:text-neutral-500'

/**
 * A number field. `integer` marks a COUNT — teeth, spokes, pins — which is
 * unitless and must not be converted; everything else is a length held in mm and
 * shown in the user's units.
 */
export function NumInput({ label, valueMM, units, onChange, min = 0.1, max, step, integer }: {
  label: string; valueMM: number; units: string; onChange: (mm: number) => void
  min?: number; max?: number; step?: number; integer?: boolean
}) {
  const display = integer ? valueMM : fromMM(valueMM, units as 'mm' | 'in')
  const s = step ?? (integer ? 1 : units === 'in' ? 0.0625 : 1)

  return (
    <div className="flex items-center gap-1.5">
      <span className={labelCls}>{label}</span>
      <NumericInput
        value={display}
        min={min}
        max={max}
        step={s}
        integer={integer}
        unit={integer ? undefined : units}
        onChange={(v) => onChange(integer ? v : toMM(v, units as 'mm' | 'in'))}
        className={inputCls}
      />
    </div>
  )
}

/** A plain number field with a trailing unit that is NOT a length — degrees, seconds. */
export function PlainInput({ label, value, unit, onChange, min, max, step }: {
  label: string; value: number; unit?: string; onChange: (v: number) => void
  min?: number; max?: number; step?: number
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={labelCls}>{label}</span>
      <NumericInput value={value} min={min} max={max} step={step} onChange={onChange} className={inputCls} />
      {unit && <span className="text-gray-400 dark:text-neutral-500 text-label flex-shrink-0">{unit}</span>}
    </div>
  )
}

export function Select<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: [T, string][]; onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={labelCls}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className={selectCls}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  )
}

export function Check({ label, checked, onChange, title }: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="flex items-center gap-1.5 cursor-pointer" title={title}>
      <span className={labelCls}>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="accent-blue-500 w-3.5 h-3.5" />
    </label>
  )
}

export const toolBtnCls = (active: boolean) =>
  [
    'flex flex-col items-center gap-0.5 py-1.5 rounded text-body transition-colors border',
    active
      ? 'border-blue-500 bg-blue-500/20'
      : 'border-gray-400 dark:border-neutral-600 hover:bg-gray-100 dark:hover:bg-neutral-700',
  ].join(' ')
