import { useEffect } from 'react'
import { ICON } from '../theme'
import { Play, Pause, Square, FileText, X } from 'lucide-react'
import { useSimStore, type SimSpeed } from '../store/simStore'
import { useWorkpieceStore, MATERIAL_INFO } from '../store/workpieceStore'
import { spindleDialLabel } from '../store/spindle'
import type { ToolType } from '../store/toolStore'
import { targetChipLoad, rigidityFeedFactor } from '../cam/feeds'
import { getCurrentSegIdx, interpolatePos, segTool, formatSimTime } from './gcodeParser'

const SPEEDS: SimSpeed[] = [1, 5, 20, 100]

// Chip-load bands: actual / target ratio → color + meaning.
const CHIP_STATUS = {
  rubbing: { color: '#ef4444', label: 'rubbing · too hot' },   // too low
  good:    { color: '#22c55e', label: 'sweet spot' },
  heavy:   { color: '#3b82f6', label: 'chips too large' },     // too high
  none:    { color: '#9ca3af', label: '' },
} as const

function chipStatus(actual: number | null, target: number): keyof typeof CHIP_STATUS {
  if (actual === null || target <= 0) return 'none'
  const r = actual / target
  if (r < 0.75) return 'rubbing'
  if (r > 1.4) return 'heavy'
  return 'good'
}

export default function SimulationPlayer() {
  const playing = useSimStore((s) => s.playing)
  const speed = useSimStore((s) => s.speed)
  const elapsedTimeS = useSimStore((s) => s.elapsedTimeS)
  const totalTimeS = useSimStore((s) => s.totalTimeS)
  const segments = useSimStore((s) => s.segments)
  const genZOff = useSimStore((s) => s.genZOff)
  const toolStates = useSimStore((s) => s.toolStates)
  const gcode = useSimStore((s) => s.gcode)
  const gcodeViewerOpen = useSimStore((s) => s.gcodeViewerOpen)
  const material = useWorkpieceStore((s) => s.material)
  const machineRigidity = useWorkpieceStore((s) => s.machineRigidity)
  const minSpindleRpm = useWorkpieceStore((s) => s.minSpindleRpm)
  const spindleType = useWorkpieceStore((s) => s.spindleType)
  const { play, pause, stop, seekToTime, setSpeed, toggleGcodeViewer, clearSim } = useSimStore()

  // Animation loop — reads fresh store state each frame to avoid stale closures
  useEffect(() => {
    if (!playing) return
    let rafId = 0
    let lastTs: number | null = null

    function tick(ts: number) {
      if (lastTs !== null) {
        const dt = (ts - lastTs) / 1000
        const state = useSimStore.getState()
        if (!state.playing) return   // simulation ended or paused, stop loop
        state.advanceTime(dt * state.speed)
      }
      lastTs = ts
      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [playing])

  if (!gcode) return null

  const progress = totalTimeS > 0 ? elapsedTimeS / totalTimeS : 0
  const segIdx = getCurrentSegIdx(segments, elapsedTimeS)
  const curSeg = segIdx >= 0 ? segments[segIdx] : null
  const pos = interpolatePos(segments, elapsedTimeS)
  const currentLineNum = curSeg ? curSeg.lineIdx + 1 : 0

  // Spindle speed (read from the G-code) + chip-load feedback for the current move.
  const ts = curSeg ? segTool(curSeg, toolStates) : null
  const spindleRpm = ts?.spindleRpm ?? 0
  const toolType: ToolType = ts?.toolBallNose ? 'ballnose'
    : ts?.toolVbitHalfAngleTan !== undefined ? 'vbit' : 'endmill'
  const targetFz = ts ? targetChipLoad(toolType, ts.toolDiameterMM, MATERIAL_INFO[material].hardness) : 0
  // Chip-load color applies only to steady side-cutting: the tip must be below the
  // material top (z < 0, not cutting air) AND not descending. Descending moves —
  // ramp-in, plunges, helical entries — run a deliberately reduced feed and have
  // light engagement, so judging them as steady-state would falsely read "rubbing".
  const descending = !!curSeg && curSeg.z < curSeg.prevZ - 1e-3
  // pos.z is datum-relative; subtract genZOff to get top-referenced Z for the in-material check.
  const cutting = !!curSeg && !curSeg.rapid && !!pos && (pos.z - genZOff) < -0.001 && !descending
  const actualFz = ts && cutting && spindleRpm > 0 && ts.fluteCount > 0
    ? curSeg!.feedRateMmMin / (spindleRpm * ts.fluteCount)
    : null
  // Display the intrinsic target, but judge the color against the rigidity-adjusted
  // aim — so a hobby machine running its lighter feed still reads "sweet spot".
  const aimFz = targetFz * rigidityFeedFactor(machineRigidity)
  const status = chipStatus(actualFz, aimFz)
  const chip = CHIP_STATUS[status]
  // For manual feeds, suggest the feed that puts chip load in the sweet spot at the
  // current spindle & flute count, with the RPM direction as an alternative lever.
  const sweetFeed = ts ? Math.round(aimFz * spindleRpm * ts.fluteCount) : 0
  const suggestion =
    status === 'rubbing' && sweetFeed > 0 ? `raise feed to ~${sweetFeed} mm/min (or lower RPM / fewer flutes)` :
    status === 'heavy'   && sweetFeed > 0 ? `lower feed to ~${sweetFeed} mm/min (or raise RPM / more flutes)` : ''

  // Surface-speed (Vc) check: metals carry a safe cutting-speed ceiling. If the
  // programmed spindle drives the edge past it — typically because the machine's
  // minimum RPM is still too fast for the bit diameter — the cut runs hot (built-up
  // edge on aluminum, edge wear on brass). Flag it so the spindle reads red.
  const vcCeilingMMin = MATERIAL_INFO[material].maxSurfaceSpeedMMin
  const dia = ts?.toolDiameterMM ?? 0
  const surfaceSpeedMMin = dia > 0 && spindleRpm > 0 ? (Math.PI * dia * spindleRpm) / 1000 : 0
  // Compare on whole m/min so a 1-rpm integer rounding in the G-code (≈0.01 m/min)
  // doesn't flag a spindle that's sitting right on the ceiling.
  const spindleTooFast = !!vcCeilingMMin && Math.round(surfaceSpeedMMin) > vcCeilingMMin

  // When the spindle reads red, explain *why* and whether the user can fix it:
  //  • safeRpm   — fastest spindle that keeps this bit under the material's Vc limit.
  //  • machine-constrained — even the machine's slowest spindle is over the limit,
  //    so no RPM helps; only a smaller bit (or a lower-min spindle) will.
  const safeRpm = vcCeilingMMin && dia > 0 ? Math.floor((vcCeilingMMin * 1000) / (Math.PI * dia)) : 0
  const maxBitMM = vcCeilingMMin && minSpindleRpm > 0 ? (vcCeilingMMin * 1000) / (Math.PI * minSpindleRpm) : 0
  const machineConstrained = spindleTooFast && safeRpm > 0 && safeRpm < minSpindleRpm
  const spindleHint = !spindleTooFast ? '' : machineConstrained
    ? `${MATERIAL_INFO[material].label} should stay under ${vcCeilingMMin} m/min, but a Ø${dia.toFixed(2)} mm bit reaches that at ${safeRpm} rpm — below your machine's ${minSpindleRpm} rpm minimum. The spindle can't slow down enough, so lowering RPM won't help: use a bit ≤ ${maxBitMM.toFixed(1)} mm, or fit a spindle that runs slower.`
    : `${MATERIAL_INFO[material].label} should stay under ${vcCeilingMMin} m/min. Lower the spindle to ≤ ${safeRpm} rpm for this Ø${dia.toFixed(2)} mm bit (or turn on auto-feed to set it automatically).`

  return (
    <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-1.5 select-none">
      {/* Stats bar */}
      <div className="bg-gray-50/95 dark:bg-neutral-900/95 border border-gray-300 dark:border-neutral-700 rounded-md px-3 py-1 text-body font-mono text-gray-700 dark:text-neutral-300 flex gap-3 whitespace-nowrap pointer-events-none">
        <span>Line: {currentLineNum}</span>
        <span>Z: {pos ? pos.z.toFixed(3) : '—'}</span>
        {curSeg && (
          <span className={curSeg.rapid ? 'text-gray-400 dark:text-neutral-500' : ''}>
            {curSeg.rapid ? 'RAPID' : `F: ${Math.round(curSeg.feedRateMmMin)}`}
          </span>
        )}
        <span className="text-gray-500 dark:text-neutral-400">{formatSimTime(elapsedTimeS)} / {formatSimTime(totalTimeS)}</span>
      </div>

      {/* Controls */}
      <div className="bg-gray-50/95 dark:bg-neutral-900/95 border border-gray-300 dark:border-neutral-700 rounded-xl px-3 py-1.5 flex items-center gap-2 shadow-xl">
        {/* Stop */}
        <button
          title="Stop"
          onClick={stop}
          className="text-gray-500 dark:text-neutral-400 hover:text-gray-900 dark:hover:text-neutral-100 transition-colors p-0.5"
        >
          <Square size={ICON.sm} />
        </button>

        {/* Play / Pause */}
        <button
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          onClick={() => (playing ? pause() : play())}
          className="w-7 h-7 rounded-full bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center transition-colors"
        >
          {playing ? <Pause size={ICON.sm} /> : <Play size={ICON.sm} className="ml-0.5" />}
        </button>

        {/* Seek slider */}
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(progress * 1000)}
          onChange={(e) => seekToTime((parseInt(e.target.value) / 1000) * totalTimeS)}
          className="w-36 h-1 accent-blue-500 cursor-pointer"
        />

        {/* Speed */}
        <div className="flex items-center gap-0.5">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={[
                'text-body px-1.5 py-0.5 rounded transition-colors',
                speed === s ? 'bg-blue-600 text-white' : 'text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200',
              ].join(' ')}
            >
              {s}×
            </button>
          ))}
        </div>

        {/* G-code viewer toggle */}
        <button
          title="Toggle G-code viewer"
          onClick={toggleGcodeViewer}
          className={[
            'p-0.5 transition-colors',
            gcodeViewerOpen ? 'text-blue-400' : 'text-gray-500 dark:text-neutral-400 hover:text-gray-900 dark:hover:text-neutral-100',
          ].join(' ')}
        >
          <FileText size={ICON.md} />
        </button>

        <div className="w-px h-4 bg-gray-200 dark:bg-neutral-700 mx-0.5" />

        {/* Close simulation */}
        <button
          title="Close simulation"
          onClick={clearSim}
          className="text-gray-400 dark:text-neutral-500 hover:text-gray-800 dark:hover:text-neutral-200 transition-colors p-0.5"
        >
          <X size={ICON.sm} />
        </button>
      </div>

      {/* Spindle + chip-load feedback */}
      {curSeg && (
        <div className="bg-gray-50/95 dark:bg-neutral-900/95 border border-gray-300 dark:border-neutral-700 rounded-md px-3 py-1 text-body font-mono text-gray-700 dark:text-neutral-300 flex items-center gap-3 whitespace-nowrap pointer-events-none">
          <span
            className={spindleTooFast ? 'text-red-500 font-semibold' : ''}
            title={spindleHint || undefined}
          >
            Spindle: {spindleRpm > 0 ? Math.round(spindleRpm) : '—'}
            {spindleDialLabel(spindleType, spindleRpm) && ` · ${spindleDialLabel(spindleType, spindleRpm)}`}
            {spindleTooFast && ` (${Math.round(surfaceSpeedMMin)} m/min)`}
          </span>
          <span className="flex items-center gap-1.5">
            Chip
            <span style={{ color: chip.color }}>●</span>
            {actualFz !== null ? actualFz.toFixed(3) : '—'} / {targetFz > 0 ? targetFz.toFixed(3) : '—'} mm
          </span>
          {chip.label && (
            <span className="flex items-center gap-1.5">
              <span style={{ color: chip.color }}>{chip.label}</span>
              {suggestion && <span className="text-gray-500 dark:text-neutral-400">· {suggestion}</span>}
            </span>
          )}
        </div>
      )}

      {/* Surface-speed warning — explains the red spindle and how (or whether) to fix it */}
      {spindleTooFast && spindleHint && (
        <div className="max-w-md bg-red-50/95 dark:bg-red-950/90 border border-red-300 dark:border-red-800 rounded-md px-3 py-1.5 text-body text-red-700 dark:text-red-300 text-center whitespace-normal pointer-events-none">
          ⚠ Spindle too fast — {spindleHint}
        </div>
      )}
    </div>
  )
}
