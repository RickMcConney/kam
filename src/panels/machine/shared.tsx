// Shared widgets used by the operation forms (extracted from MachinePanel — tofix.md R1).
// ─── Shared sub-components ───────────────────────────────────────────────────
import { useMemo, useState } from 'react'
import { NumericInput } from '../../components/NumericInput'
import { ICON } from '../../theme'
import { AlertCircle, Loader2 } from 'lucide-react'
import type { Tool } from '../../store/toolStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { useGenProgressStore } from '../../store/genProgressStore'
import { useToolpathStore } from '../../store/toolpathStore'
import { effectiveStepDownMM } from '../../cam/feeds'
import { resolveStartZ, listFlatFloorOps, type StartFrom, type StartZ } from '../../cam/startHeight'
import { usePathsStore, type ImportedPath } from '../../store/pathsStore'

// Tracks operations created by this form instance, keyed by target (path/group id), so a
// repeat Generate on the same target updates the existing operation instead of adding a
// duplicate. The map survives selection changes but not closing the form; entries whose
// operation has since been deleted (or undone away) are treated as absent.
export function useSessionOps() {
  const operations = useToolpathStore((s) => s.operations)
  const [byKey, setByKey] = useState<Record<string, string>>({})
  return {
    liveOpId: (key: string): string | undefined => {
      const id = byKey[key]
      return id && operations.some((o) => o.id === id) ? id : undefined
    },
    remember: (key: string, opId: string) => setByKey((m) => ({ ...m, [key]: opId })),
  }
}

export function FormShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="border border-gray-200 dark:border-neutral-600 rounded-lg mx-3 mt-3 mb-2 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-gray-100 dark:bg-neutral-800 border-b border-gray-200 dark:border-neutral-600">
        <span className="text-body font-semibold text-gray-700 dark:text-neutral-300">{title}</span>
        <button onClick={onClose} className="text-gray-400 dark:text-neutral-500 hover:text-gray-700 dark:hover:text-neutral-300 text-sm leading-none">✕</button>
      </div>
      <div className="p-3 space-y-2.5">{children}</div>
    </div>
  )
}

// `label` is only for a distinction the list can't otherwise show — "island" against a
// boundary. Plain membership needs no label: everything in the list is selected, so
// saying so on every row is noise.
export function PathChip({ path, label }: { path: ImportedPath; label?: string }) {
  return (
    <div className="text-body text-gray-800 dark:text-neutral-200 bg-gray-100 dark:bg-neutral-800 rounded px-2 py-1 flex items-center gap-1.5">
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: path.color }} />
      <span className="truncate">{path.name}</span>
      {label && <span className="text-gray-400 dark:text-neutral-500 flex-shrink-0">({label})</span>}
    </div>
  )
}

// The path list every operation form ends with: same header, same divider, same placement
// under the Generate button, whatever the form. Forms differ only in the chips they put
// inside — a pocket labels its islands, a profile has nothing to add.
export function PathListSection({ count, children }: { count: number; children: React.ReactNode }) {
  if (count === 0) return null
  return (
    <div className="pt-1 border-t border-gray-200 dark:border-neutral-700">
      <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
        Paths{count > 1 && <span className="normal-case text-gray-500 dark:text-neutral-400"> ({count})</span>}
      </label>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}


export function ToolSelector({ tools, value, onChange }: {
  tools: Tool[]
  value: string
  onChange: (id: string) => void
}) {
  return (
    <div>
      <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Tool</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500"
      >
        {tools.map((t) => (
          <option key={t.id} value={t.id}>{t.name} (Ø{t.diameterMM}mm)</option>
        ))}
      </select>
    </div>
  )
}

export function ToggleRow<T extends string>({ label, options, value, onChange, labels }: {
  label: string
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  labels?: Partial<Record<T, string>>
}) {
  return (
    <div>
      <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">{label}</label>
      <div className="flex gap-1">
        {options.map((o) => (
          <button key={o} onClick={() => onChange(o)}
            className={[
              'flex-1 py-1 text-body rounded border transition-colors capitalize',
              value === o
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-gray-50 dark:bg-neutral-900 border-gray-300 dark:border-neutral-700 text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200',
            ].join(' ')}>
            {labels?.[o] ?? o}
          </button>
        ))}
      </div>
    </div>
  )
}



// Read-only display for an auto-calculated step-down (shown when auto feed is on).
export function AutoStepField({ label, valueMM }: { label: string; valueMM: number }) {
  return (
    <div>
      <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
        {label} <span className="text-blue-500 dark:text-blue-400 normal-case">(auto)</span>
      </label>
      <div className="flex items-center gap-1">
        <div className="flex-1 bg-gray-100 dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-500 dark:text-neutral-400 min-w-0 font-mono">
          {valueMM.toFixed(2)}
        </div>
        <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
      </div>
    </div>
  )
}

// Resolves the surface an operation starts from, live, as the form is edited. Cheap —
// preceding flat-floor ops only, bbox-rejected before any polygon work (see startHeight.ts).
export function useStartZ(
  startFrom: StartFrom | undefined,
  footprintD: string,
  cutMarginMM: number,
  opId?: string,
): StartZ {
  const operations = useToolpathStore((s) => s.operations)
  const paths = usePathsStore((s) => s.paths)
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)
  return useMemo(
    () => resolveStartZ({ startFrom, footprintD, cutMarginMM, opId }, operations, paths, { widthMM, heightMM }),
    [startFrom, footprintD, cutMarginMM, opId, operations, paths, widthMM, heightMM],
  )
}

// "Start" picker: a reference, not a raw number. Auto is the default and needs no input;
// the resolved height is always shown next to it so the value is visible and explained.
export function StartRow({ value, onChange, resolved, opId }: {
  value?: StartFrom
  onChange: (v: StartFrom) => void
  resolved: StartZ
  opId?: string
}) {
  const operations = useToolpathStore((s) => s.operations)
  const paths = usePathsStore((s) => s.paths)
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)
  const candidates = useMemo(
    () => listFlatFloorOps(operations, paths, { widthMM, heightMM }, opId),
    [operations, paths, widthMM, heightMM, opId],
  )

  const mode = value ?? { mode: 'auto' as const }
  const selected = mode.mode === 'op' ? `op:${mode.opId}` : mode.mode

  return (
    <div>
      <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">
        Start <span className={`normal-case ${resolved.zMM < 0 ? 'text-blue-500 dark:text-blue-400' : 'text-gray-500 dark:text-neutral-400'}`}>
          Z {resolved.zMM.toFixed(2)} mm
        </span>
      </label>
      <div className="flex items-center gap-1">
        <select
          value={selected}
          onChange={(e) => {
            const v = e.target.value
            if (v.startsWith('op:')) onChange({ mode: 'op', opId: v.slice(3) })
            else if (v === 'manual') onChange({ mode: 'manual', zMM: resolved.zMM })
            else onChange({ mode: v as 'auto' | 'stock' })
          }}
          className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
        >
          <option value="auto">Auto (from earlier cuts)</option>
          <option value="stock">Stock top</option>
          {candidates.map((c) => (
            <option key={c.opId} value={`op:${c.opId}`}>Floor of {c.name} ({c.zMM.toFixed(2)})</option>
          ))}
          <option value="manual">Custom…</option>
        </select>
        {mode.mode === 'manual' && (
          <>
            <NumericInput value={mode.zMM} max={0} step={0.5}
              onChange={(v) => onChange({ mode: 'manual', zMM: Math.min(0, v) })}
              className="w-20 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
            />
            <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
          </>
        )}
      </div>
      {/* Where the number came from. On auto this is the debugging line: it says which
          operation's floor was picked, or why none was — "nothing cut here yet" (no
          overlapping earlier cut) vs "reaches uncut stock" (overlapping, but this cut
          extends past its edge). */}
      {mode.mode === 'auto' && (
        <p className="text-label text-gray-400 dark:text-neutral-500 mt-0.5">{resolved.label}</p>
      )}
      {mode.mode === 'manual' && mode.zMM < 0 && (
        <p className="text-label text-amber-500 flex items-center gap-1 mt-0.5">
          <AlertCircle size={10} className="shrink-0" />
          Nothing checks this — over uncut stock the first pass cuts full depth.
        </p>
      )}
    </div>
  )
}

export function DepthRow({ depthMM, stepDownMM, onDepth, onStep, maxDepthMM, tool, engagementFraction, startZMM = 0 }: {
  depthMM: number; stepDownMM: number
  onDepth: (v: number) => void; onStep: (v: number) => void
  maxDepthMM?: number
  tool?: Tool
  // Radial engagement (WOC / D); low values (trochoidal) let the auto step-down go deeper.
  // Omit for full-slot ops so the displayed value matches the generated one.
  engagementFraction?: number
  // Surface the cut starts from. Depth is measured from there, so both warnings below
  // have to test the TOTAL reach from stock top, not the depth field alone.
  startZMM?: number
}) {
  // When auto feed is on the step-down is computed and shown read-only. The parent
  // form subscribes to the whole workpiece store, so this recomputes live as the
  // user changes rigidity / material / max feed.
  const autoFeedEnabled = useWorkpieceStore((s) => s.autoFeedEnabled)
  const thicknessMM = useWorkpieceStore((s) => s.thicknessMM)
  const autoStepDownMM = autoFeedEnabled && tool ? effectiveStepDownMM(tool, stepDownMM, depthMM, engagementFraction) : null
  // Reach from the stock top: an op starting 2 mm down needs 2 mm more tool than its
  // depth field says, and gets 2 mm closer to the spoilboard.
  const totalDepthMM = Math.abs(Math.min(0, startZMM)) + depthMM
  const depthExceeds = maxDepthMM != null && totalDepthMM > maxDepthMM
  // Guard against plunging past the bottom of the stock into the spoilboard.
  const pastStockMM = thicknessMM > 0 ? totalDepthMM - thicknessMM : 0
  const cutsPastStock = pastStockMM > 0.001
  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Depth</label>
        <div className="flex items-center gap-1">
          <NumericInput value={depthMM} min={0.01} step={0.5}
            onChange={(v) => onDepth(v)}
            className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
          />
          <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
        </div>
        {depthExceeds && (
          <p className="text-label text-amber-500 flex items-center gap-1 mt-0.5">
            <AlertCircle size={10} className="shrink-0" />
            Exceeds tool max ({maxDepthMM} mm)
          </p>
        )}
        {cutsPastStock && (
          <p className="text-label text-amber-500 flex items-center gap-1 mt-0.5">
            <AlertCircle size={10} className="shrink-0" />
            {pastStockMM.toFixed(2)} mm past stock bottom ({thicknessMM} mm)
          </p>
        )}
      </div>
      {autoStepDownMM != null ? (
        <AutoStepField label="Step Down" valueMM={autoStepDownMM} />
      ) : (
        <div>
          <label className="block text-label text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-1">Step Down</label>
          <div className="flex items-center gap-1">
            <NumericInput value={stepDownMM} min={0.01} step={0.5}
              onChange={(v) => onStep(v)}
              className="flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-300 dark:border-neutral-700 rounded px-2 py-1 text-body text-gray-900 dark:text-neutral-100 focus:outline-none focus:border-blue-500 min-w-0"
            />
            <span className="text-label text-gray-400 dark:text-neutral-500">mm</span>
          </div>
        </div>
      )}
    </div>
  )
}

export function GenerateBtn({ disabled, generating, onClick, label = 'Generate Toolpath' }: { disabled: boolean; generating: boolean; onClick: () => void; label?: string }) {
  // Progress is only published once a generation has been running long enough to be worth
  // showing (see genProgressStore); short ones keep the plain spinner.
  const pct = useGenProgressStore((s) => s.overall)
  const stage = useGenProgressStore((s) => s.label)
  const showBar = generating && pct !== null

  return (
    <button onClick={onClick} disabled={disabled}
      className="relative w-full py-1.5 rounded text-body font-medium bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5 overflow-hidden">
      {/* Fill behind the label, so the button itself is the progress bar. */}
      {showBar && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 bg-blue-400/60 transition-[width] duration-150 ease-linear"
          style={{ width: `${Math.round(pct * 100)}%` }}
        />
      )}
      <span className="relative flex items-center gap-1.5">
        {generating && <Loader2 size={ICON.sm} className="animate-spin" />}
        {generating
          ? showBar
            ? `${stage ? `${stage} · ` : ''}${Math.round(pct * 100)}%`
            : 'Generating…'
          : label}
      </span>
    </button>
  )
}
