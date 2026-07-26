import { describe, it, expect, beforeEach } from 'vitest'
import { generateGcode } from './gcode'
import { parseGcode } from '../sim/gcodeParser'
import { useWorkpieceStore } from '../store/workpieceStore'
import type { PostProcessorProfile } from '../store/postProcessorStore'
import type { Tool } from '../store/toolStore'
import type { AnyOperation, MotionSegment, ProfileOperation } from '../store/toolpathStore'

// Deterministic post: RS274 motion grammar (same as the Grbl preset), semicolon
// comments, no unit/homing boilerplate beyond G21/G90.
const POST: PostProcessorProfile = {
  id: 'test-post',
  name: 'Test Post',
  unitMode: 'mm',
  commentStyle: 'semicolon',
  startGcode: 'G21\nG90',
  endGcode: 'M5\nG0 Z10\nM30',
  toolChangeGcode: 'M5\nM0',
  spindleOnTemplate: 'M3 S{s}',
  spindleOffGcode: 'M5',
  rapidTemplate: 'G0 X{x} Y{y} Z{z}',
  cutTemplate: 'G1 X{x} Y{y} Z{z} F{f}',
  arcCWTemplate: 'G2 X{x} Y{y} Z{z} I{i} J{j} F{f}',
  arcCCWTemplate: 'G3 X{x} Y{y} Z{z} I{i} J{j} F{f}',
  outputArcs: true,
}

const TOOL: Tool = {
  id: 't1', name: 'Test End Mill', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, stepDownMM: 3, maxDepthMM: 25, direction: 'climb',
}
const TOOL2: Tool = {
  id: 't2', name: 'Small End Mill', type: 'endmill', diameterMM: 3.175, fluteCount: 2,
  rpm: 24000, xyFeedMmMin: 600, zFeedMmMin: 200, stepDownMM: 1.5, maxDepthMM: 15, direction: 'climb',
}
const TOOLS = { t1: TOOL, t2: TOOL2 }

function makeOp(segments: MotionSegment[], overrides: Partial<ProfileOperation> = {}): AnyOperation {
  return {
    id: 'op1', name: 'Profile 1', type: 'profile', toolId: 't1', pathId: 'p1',
    side: 'outside', depthMM: 5, stepDownMM: 3, direction: 'climb', rampIn: false,
    status: 'done', segments, color: '#fff', visible: true,
    ...overrides,
  }
}

const cut = (x: number, y: number, z: number, extra: Partial<MotionSegment> = {}): MotionSegment =>
  ({ x, y, z, rapid: false, ...extra })
const rapid = (x: number, y: number, z: number): MotionSegment => ({ x, y, z, rapid: true })

const gen = (ops: AnyOperation[], post: PostProcessorProfile = POST) =>
  generateGcode(ops, TOOLS, 'test-project', post)

beforeEach(() => {
  // Pin every workpiece/machine field the emitter reads. autoFeedEnabled=false +
  // maxFeedMmMin=0 (no cap) make feedsForTool return the tool's stored feeds verbatim.
  useWorkpieceStore.setState({
    widthMM: 100, heightMM: 80, thicknessMM: 12,
    origin: 'bottom-left', zOrigin: 'top', spindleType: 'vfd',
    autoFeedEnabled: false, maxFeedMmMin: 0,
  })
})

describe('generateGcode — header and footer', () => {
  it('emits project comments, start gcode, spindle-on, and end gcode', () => {
    const g = gen([makeOp([rapid(0, 0, 5), cut(0, 0, -1), cut(10, 0, -1)])])
    const lines = g.split('\n')
    expect(lines[0]).toBe('; test-project')
    expect(g).toContain('; Post-processor: Test Post')
    expect(g).toContain('; Origin: bottom-left  offset X0.000 Y0.000')
    expect(lines).toContain('G21')
    expect(lines).toContain('G90')
    expect(lines).toContain('M3 S18000')
    expect(lines[lines.length - 1]).toBe('M30')
    // tool comment carries the metadata the sim parser reads back
    expect(g).toContain('dia 6.000mm  flutes:2')
  })

  it('emits only a comment and M30 when there is nothing to export', () => {
    const hidden = makeOp([cut(0, 0, -1), cut(10, 0, -1)], { visible: false })
    const g = gen([hidden])
    expect(g).toContain('; No toolpaths to export.')
    expect(g.split('\n')[g.split('\n').length - 1]).toBe('M30')
    expect(g).not.toContain('G1 ')
  })
})

describe('generateGcode — motion emission', () => {
  it('emits rapids via G0 and cuts via G1 with 2-decimal mm coords', () => {
    const g = gen([makeOp([rapid(10, 10, 5), cut(10, 10, -2), cut(20, 10, -2)])])
    expect(g).toContain('G0 X10.00 Y10.00 Z5.00')
    expect(g).toContain('G1 X20.00 Y10.00 Z-2.00 F1000')
  })

  it('uses plunge feed for pure-Z descents and xy feed for lateral cuts', () => {
    const g = gen([makeOp([rapid(10, 10, 5), cut(10, 10, -2), cut(20, 10, -2)])])
    expect(g).toContain('G1 X10.00 Y10.00 Z-2.00 F300')  // zFeedMmMin
    expect(g).toContain('G1 X20.00 Y10.00 Z-2.00 F1000') // xyFeedMmMin
  })

  it('applies feedScale to the cut feed', () => {
    const g = gen([makeOp([rapid(0, 0, 5), cut(0, 0, -1), cut(15, 0, -1, { feedScale: 0.5 })])])
    expect(g).toContain('G1 X15.00 Y0.00 Z-1.00 F500')
  })

  it('skips zero-motion duplicate segments', () => {
    const g = gen([makeOp([rapid(0, 0, 5), cut(0, 0, -1), cut(10, 0, -1), cut(10, 0, -1)])])
    const dupLines = g.split('\n').filter((l) => l.startsWith('G1 X10.00 Y0.00'))
    expect(dupLines.length).toBe(1)
  })
})

describe('generateGcode — arcs', () => {
  it('emits G3 for a CCW arc with I/J measured from the arc start point', () => {
    const g = gen([makeOp([
      rapid(10, 0, 5),
      cut(10, 0, -1),
      cut(-10, 0, -1, { arc: { cx: 0, cy: 0, cw: false } }),
    ])])
    expect(g).toContain('G3 X-10.00 Y0.00 Z-1.00 I-10.00 J0.00 F1000')
  })

  it('emits a full-circle arc even though start equals end', () => {
    const g = gen([makeOp([
      rapid(10, 0, 5),
      cut(10, 0, -1),
      cut(10, 0, -1, { arc: { cx: 0, cy: 0, cw: true } }),
    ])])
    expect(g).toContain('G2 X10.00 Y0.00 Z-1.00 I-10.00 J0.00 F1000')
  })

  it('runs helical arcs (Z changing) at plunge feed', () => {
    const g = gen([makeOp([
      rapid(10, 0, 5),
      cut(10, 0, 0),
      cut(10, 0, -3, { arc: { cx: 0, cy: 0, cw: true } }),
    ])])
    expect(g).toContain('G2 X10.00 Y0.00 Z-3.00 I-10.00 J0.00 F300')
  })

  it('expands arcs to G1 chords when the post cannot output arcs', () => {
    const g = gen([makeOp([
      rapid(10, 0, 5),
      cut(10, 0, -1),
      cut(-10, 0, -1, { arc: { cx: 0, cy: 0, cw: false } }),
    ])], { ...POST, outputArcs: false })
    expect(g).not.toContain('G2 ')
    expect(g).not.toContain('G3 ')
    const chords = g.split('\n').filter((l) => l.startsWith('G1 ') && !l.includes('Z-1.00 F300'))
    expect(chords.length).toBeGreaterThan(10)
    // last chord lands on the arc endpoint
    expect(chords[chords.length - 1]).toContain('X-10.00 Y0.00')
  })
})

describe('generateGcode — origin and Z datum', () => {
  it('shifts XY by the workpiece origin offset', () => {
    useWorkpieceStore.setState({ origin: 'center' }) // org = (50, 40)
    const g = gen([makeOp([rapid(60, 50, 5), cut(60, 50, -1), cut(50, 40, -1)])])
    expect(g).toContain('G0 X10.00 Y10.00 Z5.00')
    expect(g).toContain('G1 X0.00 Y0.00 Z-1.00')
    expect(g).toContain('; Origin: center  offset X50.000 Y40.000')
  })

  it('bottom-of-stock Z origin lifts emitted Z by the stock thickness', () => {
    useWorkpieceStore.setState({ zOrigin: 'bottom' }) // thickness 12 → zOff +12
    const g = gen([makeOp([rapid(0, 0, 5), cut(0, 0, 0), cut(10, 0, -12)])])
    expect(g).toContain('G0 X0.00 Y0.00 Z17.00')  // 5 + 12
    expect(g).toContain('G1 X0.00 Y0.00 Z12.00')  // top surface
    expect(g).toContain('G1 X10.00 Y0.00 Z0.00')  // stock bottom = Z0
    // hardcoded retract in endGcode is shifted too
    expect(g).toContain('G0 Z22.00')
  })

  it('converts coordinates and feeds to inches in an inch post', () => {
    const g = gen(
      [makeOp([rapid(25.4, 0, 25.4), cut(25.4, 0, -25.4), cut(50.8, 0, -25.4)])],
      { ...POST, unitMode: 'in', startGcode: 'G20\nG90' },
    )
    expect(g).toContain('G0 X1.000 Y0.000 Z1.000')
    expect(g).toContain('G1 X2.000 Y0.000 Z-1.000 F39') // 1000 mm/min ≈ 39.37 in/min
  })
})

describe('generateGcode — tool changes', () => {
  it('emits tool-change gcode, new tool comment, and new spindle speed at a toolChange marker', () => {
    const g = gen([makeOp([
      rapid(0, 0, 5),
      cut(0, 0, -1),
      cut(10, 0, -1),
      { x: 10, y: 0, z: 5, rapid: true, toolChange: 't2' },
      rapid(20, 0, 5),
      cut(20, 0, -1),
      cut(30, 0, -1),
    ])])
    const lines = g.split('\n')
    const changeIdx = lines.findIndex((l) => l.includes('dia 3.175mm'))
    expect(changeIdx).toBeGreaterThan(0)
    // M5/M0 pause precedes the new-tool comment; new RPM follows it
    expect(lines.slice(0, changeIdx)).toContain('M3 S18000')
    expect(lines.slice(changeIdx - 3, changeIdx)).toEqual(expect.arrayContaining(['M5', 'M0']))
    expect(lines.slice(changeIdx)).toContain('M3 S24000')
    // cuts after the change use the second tool's feed
    expect(g).toContain('G1 X30.00 Y0.00 Z-1.00 F600')
  })
})

describe('generateGcode — arc reconstruction of dense chords', () => {
  it('collapses collinear chord runs to a single G1 move', () => {
    const segs: MotionSegment[] = [rapid(0, 0, 5), cut(0, 0, -1)]
    for (let x = 1; x <= 50; x++) segs.push(cut(x, 0, -1))
    const g = gen([makeOp(segs)])
    const cuts = g.split('\n').filter((l) => l.startsWith('G1 '))
    expect(cuts.length).toBe(2) // plunge + one straight move
    expect(cuts[1]).toBe('G1 X50.00 Y0.00 Z-1.00 F1000')
  })

  it('collapses chords that approximate a circle into G2/G3 arcs', () => {
    // CCW semicircle r=10 about (30,30), 2° chords
    const segs: MotionSegment[] = [rapid(40, 30, 5), cut(40, 30, -1)]
    for (let a = 2; a <= 180; a += 2) {
      const rad = (a * Math.PI) / 180
      segs.push(cut(30 + 10 * Math.cos(rad), 30 + 10 * Math.sin(rad), -1))
    }
    const g = gen([makeOp(segs)])
    const motion = g.split('\n').filter((l) => /^G[123] /.test(l))
    expect(g).toContain('G3 ')
    expect(motion.length).toBeLessThan(10) // 90 chords compressed
  })

  it('leaves feed-overridden segments unfused to preserve their feed', () => {
    const segs: MotionSegment[] = [rapid(0, 0, 5), cut(0, 0, -1)]
    for (let x = 1; x <= 10; x++) segs.push(cut(x, 0, -1, { feedScale: 0.5 }))
    const g = gen([makeOp(segs)])
    const slow = g.split('\n').filter((l) => l.startsWith('G1 ') && l.endsWith('F500'))
    expect(slow.length).toBe(10)
  })
})

describe('generateGcode — round-trip through the simulator parser', () => {
  it('a square profile parses back to the same corners with no warnings', () => {
    const corners: [number, number][] = [[20, 0], [20, 20], [0, 20], [0, 0]]
    const g = gen([makeOp([
      rapid(0, 0, 5),
      cut(0, 0, -2),
      ...corners.map(([x, y]) => cut(x, y, -2)),
      rapid(0, 0, 5),
    ])])
    const parsed = parseGcode(g, 5)
    expect(parsed.warnings).toEqual([])
    const cutSegs = parsed.segments.filter((s) => !s.rapid)
    // plunge + 4 corners survive (collinear-run thinning keeps corners)
    expect(cutSegs.length).toBe(5)
    for (let i = 0; i < corners.length; i++) {
      expect(cutSegs[i + 1].x).toBeCloseTo(corners[i][0], 2)
      expect(cutSegs[i + 1].y).toBeCloseTo(corners[i][1], 2)
      expect(cutSegs[i + 1].z).toBeCloseTo(-2, 2)
    }
    // tool metadata comment round-trips into the parser's tool table
    expect(parsed.toolStates.some((t) => Math.abs(t.toolDiameterMM - 6) < 1e-6)).toBe(true)
  })

  it('a reconstructed arc parses back onto the original circle', () => {
    const segs: MotionSegment[] = [rapid(40, 30, 5), cut(40, 30, -1)]
    for (let a = 2; a <= 180; a += 2) {
      const rad = (a * Math.PI) / 180
      segs.push(cut(30 + 10 * Math.cos(rad), 30 + 10 * Math.sin(rad), -1))
    }
    const parsed = parseGcode(gen([makeOp(segs)]), 5)
    expect(parsed.warnings).toEqual([])
    const arcPts = parsed.segments.filter((s) => !s.rapid && s.z < 0 && (s.x !== s.prevX || s.y !== s.prevY))
    expect(arcPts.length).toBeGreaterThan(4)
    for (const s of arcPts) {
      expect(Math.hypot(s.x - 30, s.y - 30)).toBeCloseTo(10, 1)
    }
    const end = arcPts[arcPts.length - 1]
    expect(end.x).toBeCloseTo(20, 1)
    expect(end.y).toBeCloseTo(30, 1)
  })
})
