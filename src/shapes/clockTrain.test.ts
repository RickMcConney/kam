import { describe, it, expect } from 'vitest'
import {
  CLOCK_PART_ORDER, TRAIN_PART_ORDER, DEFAULT_CLOCK_SPEC, G_MM, clockRoot, defaultLinkAngles, clockAssemblyFromPaths, clockPlate, clockPose,
  designClock, escapeRevSeconds, layoutClock,
  pendulumLengthMM, solveDrive, solveTrain, trainRatio,
  dragLinkAngle,
  type ClockAssembly, type ClockPlate,
} from './clockTrain'
import { gearMesh } from './gearGenerator'
import { generatePendulumParts, pendulumBeat } from './pendulumGenerator'
import { DEFAULT_SHAPE_CONFIG, generateShapeParts } from './shapeGenerators'
import { getMultiBBox } from '../canvas/selectionUtils'

const BASE = {
  gear: DEFAULT_SHAPE_CONFIG.gear,
  escapement: DEFAULT_SHAPE_CONFIG.escapement,
  pendulum: DEFAULT_SHAPE_CONFIG.pendulum,
}
/** The going train only — the pendulum hangs off the anchor and is on no arbor,
 *  so it is not part of what stands up as a plate. */
const trainOf = (d: ReturnType<typeof designClock>): ClockAssembly =>
  d.parts.filter((p) => p.params.type !== 'pendulum')
    .map((p) => ({ key: p.key, params: p.params as ClockAssembly[number]['params'] }))

describe('pendulum', () => {
  it('gives the seconds pendulum for a one-second beat', () => {
    // The classic 994 mm. The beat is HALF a period, so this is a 2 s pendulum.
    expect(pendulumLengthMM(1)).toBeCloseTo(993.6, 1)
  })

  it('scales as the square of the beat', () => {
    expect(pendulumLengthMM(2) / pendulumLengthMM(1)).toBeCloseTo(4, 6)
  })
})

describe('escape wheel', () => {
  it('turns once a minute on a seconds pendulum with 30 teeth', () => {
    // Half a tooth per beat, so 30 teeth is 60 beats.
    expect(escapeRevSeconds(1, 30)).toBe(60)
  })

})

describe('going train', () => {
  it('is 60:1 at the default spec', () => {
    // Escape wheel once a minute, great wheel once an hour.
    expect(trainRatio(DEFAULT_CLOCK_SPEC)).toBeCloseTo(60, 9)
  })

  it('solves the default clock as 48 / 48 / 45 on 12-pin pinions', () => {
    const t = solveTrain(60, 12)
    expect(t.exact).toBe(true)
    expect(t.meshes.map((m) => m.teeth)).toEqual([48, 48, 45])
    expect(t.meshes.map((m) => m.pins)).toEqual([12, 12, 12])
    expect(t.errorSecPerDay).toBeCloseTo(0, 9)
  })

  it('keeps the biggest reduction at the great wheel', () => {
    for (const ratio of [40, 48, 60, 64, 72, 90, 120]) {
      const t = solveTrain(ratio, 12)
      const rs = t.meshes.map((m) => m.teeth / m.pins)
      expect(rs[0]).toBeGreaterThanOrEqual(rs[1])
      expect(rs[1]).toBeGreaterThanOrEqual(rs[2])
    }
  })

  it('hits every reachable ratio exactly — a train that is close is not a clock', () => {
    for (const ratio of [30, 40, 48, 60, 64, 72, 80, 90, 96, 120]) {
      const t = solveTrain(ratio, 12)
      expect(t.exact).toBe(true)
      expect(t.actualRatio).toBeCloseTo(ratio, 9)
    }
  })

  it('respects the pin floor', () => {
    for (const pins of [8, 10, 12, 14]) {
      const t = solveTrain(60, pins)
      for (const m of t.meshes) expect(m.pins).toBeGreaterThanOrEqual(pins)
    }
  })

  it('prefers the fewest pins when several trains are exact', () => {
    // 60:1 is reachable on plain 12-pin pinions, so nothing should go fatter.
    expect(solveTrain(60, 12).meshes.every((m) => m.pins === 12)).toBe(true)
  })

  it('reports the rate error rather than pretending, when nothing is exact', () => {
    // 600/11 needs an 11 somewhere in the pinions and cannot get one.
    const t = solveTrain(600 / 11, 12)
    expect(t.exact).toBe(false)
    expect(Math.abs(t.errorSecPerDay)).toBeGreaterThan(0)
    // Still the best available — well under a minute a day.
    expect(Math.abs(t.errorSecPerDay)).toBeLessThan(60)
  })

  it('signs the error the way a clock reads it — a slow train loses', () => {
    const slow = solveTrain(60, 12)
    // A train geared 1% slower than needed makes the hands lose ~864 s/day.
    const t = { ...slow, actualRatio: 60 * 1.01 }
    expect(86400 * (t.targetRatio / t.actualRatio - 1)).toBeLessThan(0)
  })
})

describe('drive wheel', () => {
  it('gives about the run asked for at the default spec', () => {
    const d = solveDrive(DEFAULT_CLOCK_SPEC, 12)
    expect(d.turns).toBeCloseTo(1000 / (Math.PI * 40), 6)
    expect(d.runHours).toBeGreaterThan(22)
    expect(d.runHours).toBeLessThan(26)
    expect(d.clampedSmall).toBe(false)
  })

  it('runs longer per turn as the drum shrinks', () => {
    const fat = solveDrive({ ...DEFAULT_CLOCK_SPEC, drumDia: 60 }, 12)
    const thin = solveDrive({ ...DEFAULT_CLOCK_SPEC, drumDia: 25 }, 12)
    expect(thin.turns).toBeGreaterThan(fat.turns)
    // Same run asked for, so the thinner drum needs less wheel.
    expect(thin.teeth).toBeLessThan(fat.teeth)
  })

  it('says so when the run asked for needs a wheel smaller than a wheel can be', () => {
    const d = solveDrive({ ...DEFAULT_CLOCK_SPEC, runHours: 2 }, 12)
    expect(d.clampedSmall).toBe(true)
    // Held at the floor, so it runs LONGER than asked — never shorter.
    expect(d.runHours).toBeGreaterThan(2)
  })
})

describe('the emitted clock', () => {
  const design = designClock(DEFAULT_CLOCK_SPEC, BASE)

  it('is a drive wheel, three going wheels, an escapement and a pendulum', () => {
    expect(design.parts.map((p) => p.key)).toEqual(CLOCK_PART_ORDER)
    expect(design.parts.map((p) => p.name))
      .toEqual(['Drive Wheel', 'Great Wheel', 'Second Wheel', 'Third Wheel', 'Escapement', 'Pendulum'])
  })

  it('carries the tooth counts Rick specified', () => {
    const teeth = trainOf(design).map((p) => p.params.teeth)
    expect(teeth.slice(1)).toEqual([48, 48, 45, 30])
  })

  it('cuts the pendulum to the length the beat demands', () => {
    const pend = design.parts.find((p) => p.key === 'pendulum')!.params
    if (pend.type !== 'pendulum') throw new Error('not a pendulum')
    // Round-trips through the pendulum's own formula, so the two files cannot
    // disagree about g or about the beat being HALF a period.
    expect(pendulumBeat(pend.length)).toBeCloseTo(DEFAULT_CLOCK_SPEC.beatSeconds, 9)
    expect(pend.length).toBeCloseTo(pendulumLengthMM(DEFAULT_CLOCK_SPEC.beatSeconds), 9)
    // And it takes the user's Pendulum defaults for everything else.
    expect(pend.bobRx).toBe(DEFAULT_SHAPE_CONFIG.pendulum.bobRx)
    expect(pend.rodWidth).toBe(DEFAULT_SHAPE_CONFIG.pendulum.rodWidth)
  })

  it('cuts every wheel cycloidal with a lantern pinion — an involute wheel is not conjugate to a pin', () => {
    for (const p of design.parts) {
      if (p.params.type !== 'gear') continue
      expect(p.params.toothProfile).toBe('cycloidal')
      expect(p.params.emitPinion).toBe(true)
      expect(p.params.mateTeeth).toBeGreaterThanOrEqual(DEFAULT_CLOCK_SPEC.minPins)
    }
  })

  it('overrides only the counts, module and profile — the rest is the user default', () => {
    const g = design.parts[1].params
    if (g.type !== 'gear') throw new Error('great wheel is not a gear')
    expect(g.bore).toBe(DEFAULT_SHAPE_CONFIG.gear.bore)
    expect(g.hubDia).toBe(DEFAULT_SHAPE_CONFIG.gear.hubDia)
    expect(g.spokes).toBe(DEFAULT_SHAPE_CONFIG.gear.spokes)
    expect(g.backlash).toBe(DEFAULT_SHAPE_CONFIG.gear.backlash)
    expect(g.pinDia).toBe(DEFAULT_SHAPE_CONFIG.gear.pinDia)
    const e = design.parts[4].params
    if (e.type !== 'escapement') throw new Error('last part is not an escapement')
    expect(e.escType).toBe(DEFAULT_SHAPE_CONFIG.escapement.escType)
    expect(e.toothDepth).toBe(DEFAULT_SHAPE_CONFIG.escapement.toothDepth)
  })

  it('gives each arbor the period the train says it should have', () => {
    // Escape wheel once a minute, great wheel once an hour — the whole point.
    const by = Object.fromEntries(design.parts.map((p) => [p.key, p.revSeconds]))
    expect(by.escapement).toBeCloseTo(60, 6)
    expect(by.great).toBeCloseTo(3600, 6)
    // And each wheel is slower than the one it drives.
    expect(by.drive).toBeGreaterThan(by.great)
    expect(by.great).toBeGreaterThan(by.second)
    expect(by.second).toBeGreaterThan(by.third)
    expect(by.third).toBeGreaterThan(by.escapement)
  })

  it('draws every part, and lays them out clear of each other', () => {
    const placed = layoutClock(design.parts, { x: 0, y: 0 }, 600, 12)
    const boxes = placed.map((p) => {
      const geo = generateShapeParts(p.params)
      expect(geo && geo.length).toBeGreaterThan(0)
      return getMultiBBox(geo!.map((g) => g.d))!
    })
    for (const b of boxes) expect(b).toBeTruthy()
    // No two parts overlap — they are things to be cut, not an assembly drawing.
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j]
        const overlaps = a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY
        expect(overlaps, `${placed[i].name} overlaps ${placed[j].name}`).toBe(false)
      }
    }
  })

  it('wraps into rows instead of running off the stock', () => {
    const wide = layoutClock(design.parts, { x: 0, y: 0 }, 5000, 12)
    const narrow = layoutClock(design.parts, { x: 0, y: 0 }, 400, 12)
    const extent = (parts: typeof design.parts) => {
      const b = getMultiBBox(parts.flatMap((p) => generateShapeParts(p.params)!.map((g) => g.d)))!
      return { w: b.maxX - b.minX, h: b.maxY - b.minY }
    }
    expect(extent(narrow).w).toBeLessThan(extent(wide).w)
    expect(extent(narrow).h).toBeGreaterThan(extent(wide).h)
  })
})

describe('the assembled clock', () => {
  const design = designClock(DEFAULT_CLOCK_SPEC, BASE)
  const plate = clockPlate(trainOf(design))!

  it('stands every arbor at the spacing its own mesh runs at', () => {
    // Not the drawn positions — the pitch circles tangent, which is the number
    // the plate is drilled from.
    for (let k = 0; k < plate.arbors.length - 1; k++) {
      const a = plate.arbors[k], b = plate.arbors[k + 1]
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(a.centreDistance, 9)
      expect(a.centreDistance).toBeCloseTo(gearMesh(trainOf(design)[k].params as never).centreDistance, 9)
    }
  })

  it('climbs — weight at the bottom, escapement at the top', () => {
    for (let k = 0; k < plate.arbors.length - 1; k++) {
      expect(plate.arbors[k + 1].y).toBeGreaterThan(plate.arbors[k].y)
    }
    // And the pallet arbor is above the escape wheel, where the generator draws it.
    expect(plate.anchor.y).toBeGreaterThan(plate.arbors[plate.arbors.length - 1].y)
  })

  it('turns every arbor at exactly its train ratio off the escape wheel', () => {
    // The train is rigid: the only kinematics in a clock are the escapement's,
    // and each mesh both reduces AND reverses.
    const a = clockPose(trainOf(design), plate, 0)
    const b = clockPose(trainOf(design), plate, 1)
    const escStep = b.wheelDeg[4] - a.wheelDeg[4]
    let want = 1
    for (let k = 3; k >= 0; k--) {
      want *= -1 / gearMesh(trainOf(design)[k].params as never).ratio
      expect((b.wheelDeg[k] - a.wheelDeg[k]) / escStep).toBeCloseTo(want, 9)
    }
  })

  it('advances the escape wheel exactly one tooth per period', () => {
    const a = clockPose(trainOf(design), plate, 0)
    const b = clockPose(trainOf(design), plate, 1)
    expect(Math.abs(b.wheelDeg[4] - a.wheelDeg[4])).toBeCloseTo(360 / DEFAULT_CLOCK_SPEC.escapeTeeth, 9)
  })

  it('phases each mesh for the angle it actually sits at, not for +x', () => {
    // The formula reduces to gearPose when the mate lies along +x, which is the
    // one case gearMesh solves directly — so that is the anchor for the rest.
    const flat = { ...plate, arbors: plate.arbors.map((a) => ({ ...a, toNext: 0 })) }
    const pose = clockPose(trainOf(design), flat, 0.37)
    for (let k = 3; k >= 0; k--) {
      const mesh = gearMesh(trainOf(design)[k].params as never)
      expect(pose.pinionDeg[k + 1]).toBeCloseTo(mesh.matePhaseDeg - pose.wheelDeg[k] * mesh.ratio, 9)
    }
  })
})

describe('finding a clock again', () => {
  const design = designClock(DEFAULT_CLOCK_SPEC, BASE)
  const paths = design.parts.flatMap((p, i) => [
    { clockId: 'c1', clockPart: p.key, shapeParams: p.params, id: `a${i}` },
    // Every wheel is several paths sharing one set of params — teeth, bore,
    // spokes — so the reader must take one, not all of them.
    { clockId: 'c1', clockPart: p.key, shapeParams: p.params, id: `b${i}` },
  ])

  it('reads one part per wheel, in train order', () => {
    const asm = clockAssemblyFromPaths(paths, 'c1')
    expect(asm.map((a) => a.key)).toEqual(TRAIN_PART_ORDER)
  })

  it('ignores other clocks and unmarked paths', () => {
    const noise = [...paths,
      { clockId: 'c2', clockPart: 'great', shapeParams: design.parts[1].params, id: 'x' },
      { shapeParams: design.parts[1].params, id: 'y' }]
    expect(clockAssemblyFromPaths(noise, 'c1')).toHaveLength(5)
    expect(clockAssemblyFromPaths(noise, 'c2')).toHaveLength(1)
  })

  it('returns a short list when a wheel has been deleted, rather than a hole', () => {
    const asm = clockAssemblyFromPaths(paths.filter((p) => p.clockPart !== 'second'), 'c1')
    expect(asm.map((a) => a.key)).toEqual(['drive', 'great', 'third', 'escapement'])
  })

  it('reads the wheel as it stands NOW, not as it was designed', () => {
    const edited = paths.map((p) =>
      p.clockPart === 'great' && p.shapeParams.type === 'gear'
        ? { ...p, shapeParams: { ...p.shapeParams, teeth: 60 } }
        : p)
    const asm = clockAssemblyFromPaths(edited, 'c1')
    expect(asm[1].params.teeth).toBe(60)
  })
})

describe('the pendulum and the clock agree', () => {
  it('uses the same g — the two files each state it, so nothing links them but this', () => {
    // pendulumLengthMM and pendulumBeat are inverses ONLY if g matches. A silent
    // divergence would cut every clock's rod to the wrong length.
    for (const beat of [0.25, 0.5, 1, 1.5, 2]) {
      expect(pendulumBeat(pendulumLengthMM(beat))).toBeCloseTo(beat, 9)
    }
    expect(G_MM).toBe(9806.65)
  })

  it('hangs its bob with the major axis ACROSS the rod', () => {
    // A bob is a lens seen edge-on. Only the default's orientation is pinned —
    // both radii stay free.
    expect(DEFAULT_SHAPE_CONFIG.pendulum.bobRx).toBeGreaterThan(DEFAULT_SHAPE_CONFIG.pendulum.bobRy)
    const pend = designClock(DEFAULT_CLOCK_SPEC, BASE).parts.find((p) => p.key === 'pendulum')!.params
    if (pend.type !== 'pendulum') throw new Error('not a pendulum')
    expect(pend.bobRx).toBeGreaterThan(pend.bobRy)
  })

  it('puts the suspension point at cx,cy and everything else below it', () => {
    // What lets the preview hang it off the pallet arbor with a plain place-and-
    // rock, and what keeps the hanging hole still when the bob is resized.
    const spec = { ...DEFAULT_SHAPE_CONFIG.pendulum, cx: 0, cy: 0 }
    const box = getMultiBBox(generatePendulumParts(spec).map((p) => p.d))!
    expect(box.maxY).toBeCloseTo(spec.rodWidth, 6)   // a rod's width of stock above the hole
    expect(box.minY).toBeLessThan(-spec.length)      // and the bob well below it
    const fat = getMultiBBox(generatePendulumParts({ ...spec, bobRx: 200 }).map((p) => p.d))!
    expect(fat.maxY).toBeCloseTo(box.maxY, 6)
  })
})

describe('the linkage', () => {
  const design = designClock(DEFAULT_CLOCK_SPEC, BASE)
  const asm = trainOf(design)
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y)

  const ANGLE_SETS: [string, number[] | undefined][] = [
    ['default (absent)', undefined],
    ['the stated default', defaultLinkAngles()],
    ['straight up', [90, 90, 90, 90]],
    ['folded right back', [90, 270, 90, 270]],
    ['flat across', [0, 0, 0, 0]],
    ['a jumble', [12, 205, 331, 77]],
    ['negative and past 360', [-40, 400, -180, 725]],
    ['short — only two given', [30, 200]],
    ['sparse — a hole in the middle', [30, undefined as unknown as number, 200, 10]],
    ['nonsense entries', [NaN, Infinity, 45, null as unknown as number]],
  ]

  it('holds every link at the centre distance its mesh runs at, whatever the angles', () => {
    // The lengths are FORCED — only the angles are the user's. This is the whole
    // invariant of the linkage, and it must survive any input at all.
    for (const [name, angles] of ANGLE_SETS) {
      const plate = clockPlate(asm, angles)!
      for (let k = 0; k < plate.arbors.length - 1; k++) {
        const got = dist(plate.arbors[k], plate.arbors[k + 1])
        expect(got, `${name}: link ${k}`).toBeCloseTo(plate.arbors[k].centreDistance, 9)
        expect(plate.arbors[k].centreDistance).toBeCloseTo(gearMesh(asm[k].params as never).centreDistance, 9)
      }
    }
  })

  it('never emits a NaN, however broken the angles', () => {
    // An undefined or nonsense angle does not draw a slightly wrong plate — it
    // NaNs every coordinate and the clock silently stops rendering. Same trap as
    // cycOf and toothCurve.
    for (const [name, angles] of ANGLE_SETS) {
      const plate = clockPlate(asm, angles)!
      for (const a of plate.arbors) {
        expect(Number.isFinite(a.x), `${name}: x`).toBe(true)
        expect(Number.isFinite(a.y), `${name}: y`).toBe(true)
        expect(Number.isFinite(a.toNext), `${name}: toNext`).toBe(true)
      }
      for (const v of [plate.anchor.x, plate.anchor.y, plate.bbox.minX, plate.bbox.maxY]) {
        expect(Number.isFinite(v), name).toBe(true)
      }
    }
  })

  it('roots the chain at the ESCAPE arbor, at the origin', () => {
    // The escapement is what does not move: its anchor sits +y from its wheel and
    // the pendulum hangs off that, so a link angle must never tip it.
    for (const [name, angles] of ANGLE_SETS) {
      const plate = clockPlate(asm, angles)!
      const esc = plate.arbors[plate.arbors.length - 1]
      expect(esc.key, name).toBe('escapement')
      expect(esc.x, name).toBeCloseTo(0, 9)
      expect(esc.y, name).toBeCloseTo(0, 9)
      // …and the anchor is always straight above it, at the escapement's own
      // centre distance, whatever the train is doing.
      expect(plate.anchor.x, name).toBeCloseTo(0, 9)
      expect(plate.anchor.y, name).toBeGreaterThan(0)
    }
  })

  it('moves the DRIVE end when an angle changes, and nothing on the escape side', () => {
    // Dragging joint k changes angles[k] alone; everything toward the drive wheel
    // translates rigidly and everything toward the escapement stays put.
    const base = clockPlate(asm, defaultLinkAngles())!
    for (let k = 0; k < 4; k++) {
      const bent = defaultLinkAngles()
      bent[k] += 25
      const p = clockPlate(asm, bent)!
      for (let i = k + 1; i < p.arbors.length; i++) {
        expect(dist(p.arbors[i], base.arbors[i]), `link ${k}, arbor ${i}`).toBeCloseTo(0, 9)
      }
      expect(dist(p.arbors[k], base.arbors[k])).toBeGreaterThan(0.1)
    }
  })

  it('defaults per element rather than throwing the given angles away', () => {
    const short = clockPlate(asm, [30, 200])!
    const full = clockPlate(asm, [30, 200, ...defaultLinkAngles().slice(2)])!
    for (let i = 0; i < short.arbors.length; i++) {
      expect(short.arbors[i].x).toBeCloseTo(full.arbors[i].x, 9)
      expect(short.arbors[i].y).toBeCloseTo(full.arbors[i].y, 9)
    }
  })
})

describe('where the clock sits on the stock', () => {
  const design = designClock(DEFAULT_CLOCK_SPEC, BASE)
  const asm = trainOf(design)
  const esc = asm[asm.length - 1].params

  it('is X-centred, and puts the escapement\'s TOP at the top of the stock', () => {
    // The root is the escape ARBOR, and the anchor stands above it, so what is
    // pinned to the stock's top edge is the escapement's whole extent — not the
    // arbor. On a short stock that puts the arbor low; on a tall one, high.
    const geo = generateShapeParts({ ...(esc as Extract<typeof esc, { type: 'escapement' }>), cx: 0, cy: 0 })!
    const escTop = getMultiBBox(geo.map((g) => g.d))!.maxY
    for (const [W, H] of [[300, 200], [1220, 2440], [600, 600]] as const) {
      const r = clockRoot(W, H, esc)
      expect(r.x).toBeCloseTo(W / 2, 9)
      expect(r.y + escTop).toBeCloseTo(H - 10, 9)   // ROOT_MARGIN
    }
  })

  it('is TOP-anchored and not centred — a taller stock moves it by the full height', () => {
    // The sharp version of the rule: centring would move the root by HALF the
    // height difference, top-anchoring by all of it.
    const a = clockRoot(300, 200, esc)
    const b = clockRoot(300, 600, esc)
    expect(b.y - a.y).toBeCloseTo(400, 9)
    expect(b.x).toBeCloseTo(a.x, 9)
  })

  it('does not depend on the arrangement — it cannot drift as the user drags', () => {
    // A pure function of the stock and the ESCAPEMENT. If this ever starts
    // reading the assembly, the clock slides under the cursor mid-drag.
    const a = clockRoot(300, 200, esc)
    const b = clockRoot(300, 200, esc)
    expect(a).toEqual(b)
    // Bending the train every which way must not move it.
    for (const angles of [[0, 0, 0, 0], [90, 270, 12, 331]]) {
      clockPlate(asm, angles)
      expect(clockRoot(300, 200, esc)).toEqual(a)
    }
  })

  it('leaves room for the escapement above the escape arbor', () => {
    // The root IS the escape arbor, and the anchor stands above it — so the
    // margin has to clear the whole escapement, not just the wheel.
    const plate = clockPlate(asm)!
    const r = clockRoot(300, 200, esc)
    expect(r.y + plate.anchor.y).toBeLessThan(200)
  })
})

describe('dragging a joint', () => {
  const design = designClock(DEFAULT_CLOCK_SPEC, BASE)
  const asm = trainOf(design)
  const root = { x: 150, y: 100 }
  const world = (p: ClockPlate, i: number) => ({ x: root.x + p.arbors[i].x, y: root.y + p.arbors[i].y })

  /** Apply one drag the way CanvasStage does, and hand back the new plate. */
  const drag = (angles: number[], k: number, cursor: { x: number; y: number }, snap = 0) => {
    const before = clockPlate(asm, angles)!
    const deg = dragLinkAngle(before, root, k, cursor, snap)
    if (deg === null) return null
    const next = angles.slice()
    next[k] = deg
    return { before, after: clockPlate(asm, next)!, next }
  }

  it('puts the joint on the ray from its parent to the cursor, at the link length', () => {
    // The length is the centre distance and is not negotiable, so the joint can
    // only ride its circle — the best it can do is line up with the cursor.
    for (let k = 0; k < 4; k++) {
      for (const cursor of [{ x: 40, y: 300 }, { x: 400, y: -50 }, { x: 150, y: 500 }]) {
        const r = drag(defaultLinkAngles(), k, cursor)!
        const parent = world(r.after, k + 1)
        const got = world(r.after, k)
        const toCursor = Math.atan2(cursor.y - parent.y, cursor.x - parent.x)
        const toJoint = Math.atan2(got.y - parent.y, got.x - parent.x)
        // Same bearing from the parent…
        expect(Math.cos(toCursor - toJoint)).toBeCloseTo(1, 9)
        // …at exactly the link's own length.
        expect(Math.hypot(got.x - parent.x, got.y - parent.y))
          .toBeCloseTo(r.after.arbors[k].centreDistance, 9)
      }
    }
  })

  it('leaves the escapement side untouched and carries the drive side rigidly', () => {
    for (let k = 0; k < 4; k++) {
      const r = drag(defaultLinkAngles(), k, { x: 500, y: 400 })!
      // Nothing from the dragged joint's parent onwards moves…
      for (let i = k + 1; i < r.after.arbors.length; i++) {
        expect(r.after.arbors[i].x).toBeCloseTo(r.before.arbors[i].x, 9)
        expect(r.after.arbors[i].y).toBeCloseTo(r.before.arbors[i].y, 9)
      }
      // …and the drive side keeps its own shape, moving as one piece.
      const dx = r.after.arbors[k].x - r.before.arbors[k].x
      const dy = r.after.arbors[k].y - r.before.arbors[k].y
      for (let i = 0; i < k; i++) {
        expect(r.after.arbors[i].x - r.before.arbors[i].x).toBeCloseTo(dx, 9)
        expect(r.after.arbors[i].y - r.before.arbors[i].y).toBeCloseTo(dy, 9)
      }
    }
  })

  it('changes exactly one angle', () => {
    const base = defaultLinkAngles()
    for (let k = 0; k < 4; k++) {
      const r = drag(base, k, { x: 20, y: 400 })!
      for (let i = 0; i < base.length; i++) {
        if (i === k) continue
        expect(r.next[i]).toBe(base[i])
      }
    }
  })

  it('snaps to 15° when asked, and holds when the cursor is on the parent arbor', () => {
    const r = drag(defaultLinkAngles(), 1, { x: 333, y: 271 }, 15)!
    expect(r.next[1] % 15).toBeCloseTo(0, 9)
    // Every angle is equally good there, so refuse rather than snap to zero.
    const p = clockPlate(asm, defaultLinkAngles())!
    expect(dragLinkAngle(p, root, 1, world(p, 2))).toBeNull()
    // …and the root has no parent to hang from.
    expect(dragLinkAngle(p, root, p.arbors.length - 1, { x: 0, y: 0 })).toBeNull()
  })
})
