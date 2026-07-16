
export interface SimSegment {
  x: number
  y: number
  z: number
  prevX: number
  prevY: number
  prevZ: number
  rapid: boolean
  feedRateMmMin: number
  lineIdx: number       // 0-based line index in the gcode text
  durationS: number     // seconds to traverse this segment
  startTimeS: number    // cumulative elapsed time at the start of this segment
  toolStateIdx: number  // index into ParsedGcode.toolStates (flyweight; see ToolState)
}

// Tool/spindle parameters change only at tool changes, so rather than repeat them
// on every segment we keep a small deduplicated table and store just an index on
// each segment. Resolve with `segTool(seg, toolStates)`.
export interface ToolState {
  toolDiameterMM: number
  toolVbitHalfAngleTan?: number  // set for V-bit segments; tan(halfAngle)
  toolBallNose?: boolean         // set for ball nose segments
  toolDrill?: boolean            // set for drill-bit segments (118° point)
  spindleRpm: number             // active spindle speed (S word); 0 if none seen
  fluteCount: number             // from "flutes:N" comment; defaults to 2
}

export interface ParsedGcode {
  lines: string[]
  segments: SimSegment[]
  totalTimeS: number
  toolStates: ToolState[]
  // Deduplicated notes about G-code features the simulator can't honor
  // (non-XY arc planes, absolute arc centers, malformed arcs). Empty for
  // anything this app generates itself; imported external G-code may hit them.
  warnings: string[]
}

const RAPID_MM_PER_MIN = 5000
const MM_PER_INCH = 25.4

const FALLBACK_TOOL_STATE: ToolState = { toolDiameterMM: 3.0, spindleRpm: 0, fluteCount: 2 }

// Resolve a segment's tool parameters from the flyweight table.
export function segTool(seg: SimSegment, toolStates: ToolState[]): ToolState {
  return toolStates[seg.toolStateIdx] ?? FALLBACK_TOOL_STATE
}

function parseWords(line: string): Array<[string, number]> {
  const clean = line.replace(/;.*$/, '').replace(/\([^)]*\)/g, '').trim()
  const pairs: Array<[string, number]> = []
  const re = /([A-Za-z])\s*(-?\d*\.?\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(clean)) !== null) {
    pairs.push([m[1].toUpperCase(), parseFloat(m[2])])
  }
  return pairs
}

function arcToSegments(
  x0: number, y0: number,
  x1: number, y1: number,
  ii: number, jj: number,
  cw: boolean,
  z0: number,  // start Z (for helical interpolation)
  z1: number,  // end Z
  feedMmMin: number,
  lineIdx: number,
  startTimeS: number,
  toolStateIdx: number,
): SimSegment[] {
  const cx = x0 + ii
  const cy = y0 + jj
  const r = Math.hypot(ii, jj)
  if (r < 0.001) return []

  let a0 = Math.atan2(y0 - cy, x0 - cx)
  let a1 = Math.atan2(y1 - cy, x1 - cx)

  if (cw) { if (a1 >= a0) a1 -= 2 * Math.PI }
  else { if (a1 <= a0) a1 += 2 * Math.PI }

  const sweep = Math.abs(a1 - a0)
  // Chord count from sagitta tolerance, not a fixed angular step. The
  // heightfield sim carves the chords, not the true arc: at a fixed 5°/chord
  // the sagitta grows with radius (≈ r·0.001), so on a larger circle the
  // inside profile's cut edge fell visibly short of the line the outside
  // profile cut to, leaving an uncut ring at the tangency. 0.01 mm keeps the
  // chord error well inside the carve's half-cell coverage margin.
  const ARC_SAGITTA_TOL_MM = 0.01
  const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - ARC_SAGITTA_TOL_MM / r)))
  const steps = Math.max(4, Math.min(4096, Math.ceil(sweep / Math.max(maxStep, 1e-4))))
  const segs: SimSegment[] = []
  let px = x0, py = y0, pz = z0
  let cumT = startTimeS

  for (let k = 1; k <= steps; k++) {
    const t = k / steps
    const a = a0 + (a1 - a0) * t
    const nx = cx + r * Math.cos(a)
    const ny = cy + r * Math.sin(a)
    const nz = z0 + (z1 - z0) * t  // interpolate Z linearly along the arc (helical support)
    const dist = Math.hypot(nx - px, ny - py, nz - pz)
    const dur = dist / (feedMmMin / 60)
    segs.push({
      x: nx, y: ny, z: nz,
      prevX: px, prevY: py, prevZ: pz,
      rapid: false,
      feedRateMmMin: feedMmMin,
      lineIdx,
      durationS: dur,
      startTimeS: cumT,
      toolStateIdx,
    })
    cumT += dur
    px = nx; py = ny; pz = nz
  }
  return segs
}

export function parseGcode(text: string, initialZMM = 5): ParsedGcode {
  const rawLines = text.split('\n')
  const segs: SimSegment[] = []

  let cx = 0, cy = 0, cz = initialZMM
  let feedRate = 1000
  let unitScale = 1
  let motionMode = 0  // 0 = G0, 1 = G1, 2 = G2, 3 = G3
  let absolute = true // G90 (default) vs G91 incremental distance mode
  const warnings = new Set<string>()
  let toolDiameterMM = 3.0
  let toolVbitHalfAngleTan: number | undefined
  let toolBallNose: boolean | undefined
  let toolDrill: boolean | undefined
  let spindleRpm = 0
  let fluteCount = 2
  let cumT = 0

  // Deduplicated flyweight table of tool/spindle states. Segments store an index
  // into this (toolStateIdx). syncToolState() finds-or-creates the entry matching
  // the current parser state and points curStateIdx at it.
  const toolStates: ToolState[] = [{ toolDiameterMM, spindleRpm, fluteCount }]
  let curStateIdx = 0
  const matchesCur = (t: ToolState) =>
    t.toolDiameterMM === toolDiameterMM && t.toolVbitHalfAngleTan === toolVbitHalfAngleTan &&
    t.toolBallNose === toolBallNose && t.toolDrill === toolDrill &&
    t.spindleRpm === spindleRpm && t.fluteCount === fluteCount
  const syncToolState = () => {
    if (matchesCur(toolStates[curStateIdx])) return
    const found = toolStates.findIndex(matchesCur)
    if (found >= 0) { curStateIdx = found; return }
    curStateIdx = toolStates.length
    toolStates.push({ toolDiameterMM, toolVbitHalfAngleTan, toolBallNose, toolDrill, spindleRpm, fluteCount })
  }

  for (let li = 0; li < rawLines.length; li++) {
    const raw = rawLines[li]

    // Parse tool diameter from comments: "; Tool: ... dia 6.350mm ..." or "(Tool: ... dia 6.350mm ...)"
    const diamMatch = raw.match(/dia\s+([\d.]+)\s*mm/i)
    if (diamMatch) {
      toolDiameterMM = parseFloat(diamMatch[1])
      toolVbitHalfAngleTan = undefined  // reset; overwritten below if vbit-angle present
      toolBallNose = undefined           // reset; overwritten below if ballnose present
      toolDrill = undefined              // reset; overwritten below if drillbit present
    }

    // Parse V-bit half-angle tangent: "; vbit-angle:30.0" (half-angle in degrees)
    const vbitMatch = raw.match(/vbit-angle:([\d.]+)/i)
    if (vbitMatch) toolVbitHalfAngleTan = Math.tan(parseFloat(vbitMatch[1]) * (Math.PI / 180))


    // Parse ball nose marker: "; ballnose"
    if (/\bballnose\b/i.test(raw)) toolBallNose = true

    // Parse drill-bit marker: "; drillbit" (distinct token — op descriptions
    // like "peck drill · 5mm" contain the bare word "drill" for any tool type)
    const drillMatch = /\bdrillbit\b/i.test(raw)
    if (drillMatch) toolDrill = true

    // Parse flute count: "; ... flutes:2"
    const fluteMatch = raw.match(/flutes:(\d+)/i)
    if (fluteMatch) fluteCount = Math.max(1, parseInt(fluteMatch[1]))

    // Fold any tool-comment changes on this line into the flyweight table.
    if (diamMatch || vbitMatch || fluteMatch || drillMatch || /\bballnose\b/i.test(raw)) syncToolState()

    const pairs = parseWords(raw)
    if (pairs.length === 0) continue

    const get = (key: string) => pairs.find(([k]) => k === key)?.[1]
    const gWords = pairs.filter(([k]) => k === 'G').map(([, v]) => v)

    if (gWords.some((v) => Math.abs(v - 20) < 0.001)) unitScale = MM_PER_INCH
    if (gWords.some((v) => Math.abs(v - 21) < 0.001)) unitScale = 1

    // Distance mode. Note the tolerance: G90.1/G91.1 (arc-center distance
    // mode) must NOT match here — they're handled as a warning below.
    if (gWords.some((v) => Math.abs(v - 90) < 0.001)) absolute = true
    if (gWords.some((v) => Math.abs(v - 91) < 0.001)) absolute = false

    // Features the simulator doesn't honor — flag instead of silently mis-simulating.
    if (gWords.some((v) => Math.abs(v - 18) < 0.001 || Math.abs(v - 19) < 0.001))
      warnings.add('G18/G19 arc planes are not supported — arcs simulate in the XY plane')
    if (gWords.some((v) => Math.abs(v - 90.1) < 0.001))
      warnings.add('G90.1 absolute arc centers are not supported — arcs may render incorrectly')
    if (gWords.some((v) => Math.abs(v - 41) < 0.001 || Math.abs(v - 42) < 0.001))
      warnings.add('G41/G42 cutter compensation is ignored')

    // G0-G3 motion mode
    const gm = gWords.find((v) => v >= 0 && v <= 3)
    if (gm !== undefined) motionMode = gm

    const f = get('F')
    if (f !== undefined) feedRate = f * unitScale

    const s = get('S')
    if (s !== undefined) { spindleRpm = s; syncToolState() }

    const hasX = get('X') !== undefined
    const hasY = get('Y') !== undefined
    const hasZ = get('Z') !== undefined
    if (!hasX && !hasY && !hasZ) continue

    // Axis words: absolute (G90) coordinates, or deltas from the current
    // position in G91 incremental mode.
    const toMM = (value: number | undefined, fallback: number, current: number) =>
      value === undefined ? fallback : absolute ? value * unitScale : current + value * unitScale

    const nx = toMM(get('X'), cx, cx)
    const ny = toMM(get('Y'), cy, cy)
    const nz = toMM(get('Z'), cz, cz)

    // Arc center offsets. I/J are always relative to the start point (Grbl
    // G91.1 default). R-format arcs derive the center from the radius using
    // Grbl's formula: positive R = minor arc (≤180°), negative R = major arc.
    let ii = (get('I') ?? 0) * unitScale
    let jj = (get('J') ?? 0) * unitScale
    const rWord = get('R')
    if ((motionMode === 2 || motionMode === 3) && rWord !== undefined
        && get('I') === undefined && get('J') === undefined) {
      let r = rWord * unitScale
      const dx = nx - cx, dy = ny - cy
      const chord = Math.hypot(dx, dy)
      if (chord < 0.0001) {
        warnings.add('R-format arc with coincident start/end point skipped (use I/J for full circles)')
        continue
      }
      const disc = 4 * r * r - dx * dx - dy * dy
      if (disc < -0.0001) {
        warnings.add('R-format arc radius smaller than half the chord — arc flattened')
      }
      let h = -Math.sqrt(Math.max(0, disc)) / chord
      if (motionMode === 3) h = -h
      if (r < 0) { h = -h; r = -r }
      ii = 0.5 * (dx - dy * h)
      jj = 0.5 * (dy + dx * h)
    }

    if (motionMode === 0) {
      const dist = Math.hypot(nx - cx, ny - cy, nz - cz)
      if (dist > 0.0001) {
        const dur = dist / (RAPID_MM_PER_MIN / 60)
        segs.push({
          x: nx, y: ny, z: nz,
          prevX: cx, prevY: cy, prevZ: cz,
          rapid: true,
          feedRateMmMin: RAPID_MM_PER_MIN,
          lineIdx: li,
          durationS: dur,
          startTimeS: cumT,
          toolStateIdx: curStateIdx,
        })
        cumT += dur
      }
    } else if (motionMode === 1) {
      const dist = Math.hypot(nx - cx, ny - cy, nz - cz)
      if (dist > 0.0001) {
        const feed = Math.max(feedRate, 1)
        const dur = dist / (feed / 60)
        segs.push({
          x: nx, y: ny, z: nz,
          prevX: cx, prevY: cy, prevZ: cz,
          rapid: false,
          feedRateMmMin: feed,
          lineIdx: li,
          durationS: dur,
          startTimeS: cumT,
          toolStateIdx: curStateIdx,
        })
        cumT += dur
      }
    } else if (motionMode === 2 || motionMode === 3) {
      if (get('I') === undefined && get('J') === undefined && rWord === undefined)
        warnings.add('G2/G3 arc without I/J or R words — treated as no motion')
      const arcSegs = arcToSegments(cx, cy, nx, ny, ii, jj, motionMode === 2, cz, nz, Math.max(feedRate, 1), li, cumT, curStateIdx)
      segs.push(...arcSegs)
      if (arcSegs.length > 0) {
        const last = arcSegs[arcSegs.length - 1]
        cumT = last.startTimeS + last.durationS
      }
    }

    cx = nx; cy = ny; cz = nz
  }

  return { lines: rawLines, segments: segs, totalTimeS: cumT, toolStates, warnings: [...warnings] }
}

export function getCurrentSegIdx(segments: SimSegment[], elapsedTimeS: number): number {
  if (segments.length === 0) return -1
  let lo = 0, hi = segments.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (segments[mid].startTimeS <= elapsedTimeS) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function interpolatePos(
  segments: SimSegment[],
  elapsedTimeS: number,
): { x: number; y: number; z: number } | null {
  if (segments.length === 0) return null
  const idx = getCurrentSegIdx(segments, elapsedTimeS)
  if (idx < 0) return null
  const seg = segments[idx]
  if (seg.durationS <= 0) return { x: seg.x, y: seg.y, z: seg.z }
  const t = Math.max(0, Math.min(1, (elapsedTimeS - seg.startTimeS) / seg.durationS))
  return {
    x: seg.prevX + (seg.x - seg.prevX) * t,
    y: seg.prevY + (seg.y - seg.prevY) * t,
    z: seg.prevZ + (seg.z - seg.prevZ) * t,
  }
}

export function formatSimTime(s: number): string {
  const m = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  return `${m}:${ss.toString().padStart(2, '0')}`
}
