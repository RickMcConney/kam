
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
  toolDiameterMM: number
  toolVbitHalfAngleTan?: number  // set for V-bit segments; tan(halfAngle)
  toolBallNose?: boolean         // set for ball nose segments
}

export interface ParsedGcode {
  lines: string[]
  segments: SimSegment[]
  totalTimeS: number
}

const RAPID_MM_PER_MIN = 5000
const MM_PER_INCH = 25.4

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
  toolDiameterMM: number,
  toolVbitHalfAngleTan?: number,
  toolBallNose?: boolean,
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
  const steps = Math.max(4, Math.ceil(sweep / (5 * Math.PI / 180)))
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
      toolDiameterMM,
      toolVbitHalfAngleTan,
      toolBallNose,
    })
    cumT += dur
    px = nx; py = ny; pz = nz
  }
  return segs
}

export function parseGcode(text: string): ParsedGcode {
  const rawLines = text.split('\n')
  const segs: SimSegment[] = []

  let cx = 0, cy = 0, cz = 5
  let feedRate = 1000
  let unitScale = 1
  let motionMode = 0  // 0 = G0, 1 = G1, 2 = G2, 3 = G3
  let toolDiameterMM = 3.0
  let toolVbitHalfAngleTan: number | undefined
  let toolBallNose: boolean | undefined
  let cumT = 0

  for (let li = 0; li < rawLines.length; li++) {
    const raw = rawLines[li]

    // Parse tool diameter from comments: "; Tool: ... dia 6.350mm ..." or "(Tool: ... dia 6.350mm ...)"
    const diamMatch = raw.match(/dia\s+([\d.]+)\s*mm/i)
    if (diamMatch) {
      toolDiameterMM = parseFloat(diamMatch[1])
      toolVbitHalfAngleTan = undefined  // reset; overwritten below if vbit-angle present
      toolBallNose = undefined           // reset; overwritten below if ballnose present
    }

    // Parse V-bit half-angle tangent: "; vbit-angle:30.0" (half-angle in degrees)
    const vbitMatch = raw.match(/vbit-angle:([\d.]+)/i)
    if (vbitMatch) toolVbitHalfAngleTan = Math.tan(parseFloat(vbitMatch[1]) * (Math.PI / 180))


    // Parse ball nose marker: "; ballnose"
    if (/\bballnose\b/i.test(raw)) toolBallNose = true

    const pairs = parseWords(raw)
    if (pairs.length === 0) continue

    const get = (key: string) => pairs.find(([k]) => k === key)?.[1]
    const gWords = pairs.filter(([k]) => k === 'G').map(([, v]) => v)

    if (gWords.some((v) => Math.abs(v - 20) < 0.001)) unitScale = MM_PER_INCH
    if (gWords.some((v) => Math.abs(v - 21) < 0.001)) unitScale = 1

    // G0-G3 motion mode
    const gm = gWords.find((v) => v >= 0 && v <= 3)
    if (gm !== undefined) motionMode = gm

    const f = get('F')
    if (f !== undefined) feedRate = f * unitScale

    const hasX = get('X') !== undefined
    const hasY = get('Y') !== undefined
    const hasZ = get('Z') !== undefined
    if (!hasX && !hasY && !hasZ) continue

    const toMM = (value: number | undefined, fallback: number) =>
      value === undefined ? fallback : value * unitScale

    const nx = toMM(get('X'), cx)
    const ny = toMM(get('Y'), cy)
    const nz = toMM(get('Z'), cz)
    const ii = (get('I') ?? 0) * unitScale
    const jj = (get('J') ?? 0) * unitScale

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
          toolDiameterMM,
          toolVbitHalfAngleTan,
          toolBallNose,
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
          toolDiameterMM,
          toolVbitHalfAngleTan,
          toolBallNose,
        })
        cumT += dur
      }
    } else if (motionMode === 2 || motionMode === 3) {
      const arcSegs = arcToSegments(cx, cy, nx, ny, ii, jj, motionMode === 2, cz, nz, Math.max(feedRate, 1), li, cumT, toolDiameterMM, toolVbitHalfAngleTan, toolBallNose)
      segs.push(...arcSegs)
      if (arcSegs.length > 0) {
        const last = arcSegs[arcSegs.length - 1]
        cumT = last.startTimeS + last.durationS
      }
    }

    cx = nx; cy = ny; cz = nz
  }

  return { lines: rawLines, segments: segs, totalTimeS: cumT }
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
