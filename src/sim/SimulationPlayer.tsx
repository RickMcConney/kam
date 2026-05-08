import { useEffect } from 'react'
import { Play, Pause, Square, FileText, X } from 'lucide-react'
import { useSimStore, type SimSpeed } from '../store/simStore'
import { getCurrentSegIdx, interpolatePos, formatSimTime } from './gcodeParser'

const SPEEDS: SimSpeed[] = [1, 5, 20, 100]

export default function SimulationPlayer() {
  const playing = useSimStore((s) => s.playing)
  const speed = useSimStore((s) => s.speed)
  const elapsedTimeS = useSimStore((s) => s.elapsedTimeS)
  const totalTimeS = useSimStore((s) => s.totalTimeS)
  const segments = useSimStore((s) => s.segments)
  const gcode = useSimStore((s) => s.gcode)
  const gcodeViewerOpen = useSimStore((s) => s.gcodeViewerOpen)
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

  return (
    <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-1.5 select-none">
      {/* Stats bar */}
      <div className="bg-neutral-900/95 border border-neutral-700 rounded-md px-3 py-1 text-xs font-mono text-neutral-300 flex gap-3 whitespace-nowrap pointer-events-none">
        <span>Line: {currentLineNum}</span>
        <span>Z: {pos ? pos.z.toFixed(3) : '—'}</span>
        {curSeg && (
          <span className={curSeg.rapid ? 'text-neutral-500' : ''}>
            {curSeg.rapid ? 'RAPID' : `F: ${Math.round(curSeg.feedRateMmMin)}`}
          </span>
        )}
        <span className="text-neutral-400">{formatSimTime(elapsedTimeS)} / {formatSimTime(totalTimeS)}</span>
      </div>

      {/* Controls */}
      <div className="bg-neutral-900/95 border border-neutral-700 rounded-xl px-3 py-1.5 flex items-center gap-2 shadow-xl">
        {/* Stop */}
        <button
          title="Stop"
          onClick={stop}
          className="text-neutral-400 hover:text-neutral-100 transition-colors p-0.5"
        >
          <Square size={13} />
        </button>

        {/* Play / Pause */}
        <button
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          onClick={() => (playing ? pause() : play())}
          className="w-7 h-7 rounded-full bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center transition-colors"
        >
          {playing ? <Pause size={12} /> : <Play size={12} className="ml-0.5" />}
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
                'text-xs px-1.5 py-0.5 rounded transition-colors',
                speed === s ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:text-neutral-200',
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
            gcodeViewerOpen ? 'text-blue-400' : 'text-neutral-400 hover:text-neutral-100',
          ].join(' ')}
        >
          <FileText size={14} />
        </button>

        <div className="w-px h-4 bg-neutral-700 mx-0.5" />

        {/* Close simulation */}
        <button
          title="Close simulation"
          onClick={clearSim}
          className="text-neutral-500 hover:text-neutral-200 transition-colors p-0.5"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  )
}
