import { useState } from 'react'

interface NumericInputProps {
  value: number
  min?: number
  max?: number
  step?: number
  integer?: boolean
  onChange: (v: number) => void
  className?: string
}

// Numeric input that holds local text state while focused so intermediate
// states like "-", "3.", or "" don't reset to the last valid value on every keystroke.
export function NumericInput({ value, min, max, step, integer, onChange, className }: NumericInputProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const editing = draft !== null

  function fmt(v: number) {
    return integer ? String(Math.round(v)) : String(+v.toFixed(4))
  }

  function commit(raw: string) {
    const v = parseFloat(raw)
    if (isNaN(v)) return
    const clamped = min !== undefined
      ? (max !== undefined ? Math.min(max, Math.max(min, v)) : Math.max(min, v))
      : (max !== undefined ? Math.min(max, v) : v)
    onChange(integer ? Math.round(clamped) : clamped)
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      value={editing ? draft : fmt(value)}
      step={step}
      onChange={(e) => {
        const raw = e.target.value
        setDraft(raw)
        // Fire live updates for valid intermediate values so sliders/previews stay responsive
        const v = parseFloat(raw)
        if (!isNaN(v)) {
          const inRange = (min === undefined || v >= min) && (max === undefined || v <= max)
          if (inRange) onChange(integer ? Math.round(v) : v)
        }
      }}
      onFocus={(e) => {
        setDraft(fmt(value))
        e.target.select()
      }}
      onBlur={() => {
        if (draft !== null) commit(draft)
        setDraft(null)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          if (draft !== null) commit(draft)
          setDraft(null)
          ;(e.target as HTMLInputElement).blur()
        }
        if (e.key === 'Escape') {
          setDraft(null)
          ;(e.target as HTMLInputElement).blur()
        }
        // Arrow key stepping
        if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && step !== undefined) {
          e.preventDefault()
          const current = draft !== null ? (parseFloat(draft) ?? value) : value
          const next = e.key === 'ArrowUp' ? current + step : current - step
          const raw = fmt(next)
          setDraft(raw)
          commit(raw)
        }
      }}
      className={className}
    />
  )
}
