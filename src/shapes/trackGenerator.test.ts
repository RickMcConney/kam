// The only useful question about a piece of track is whether it connects to the
// next one, and neither half of a joint looks wrong on its own — so the fit is
// tested by BUTTING two pieces and asking clipper whether they overlap, the same
// way the inlay is judged. Everything else here is a dimension a workshop would
// measure off the finished piece.

import { describe, it, expect } from 'vitest'
import polygonClipping from 'polygon-clipping'
import { generateTrackParts, trackDims, BRIO, type TrackSpec } from './trackGenerator'
import { flattenPath, signedArea } from '../cam/pathFlattener'

const std: TrackSpec = {
  cx: 0, cy: 0, kind: 'straight', length: 144,
  radius: BRIO.radius, sweepDeg: BRIO.sweepDeg,
  hand: 'left', crotch: BRIO.crotch,
  width: BRIO.width, gauge: BRIO.gauge, grooveW: BRIO.grooveW, grooveMode: 'centreline',
  endA: 'female', endB: 'male', endC: 'male',
  pegDia: BRIO.pegDia, neckW: BRIO.neckW, neckL: BRIO.neckL,
  holeClear: BRIO.holeClear, throatClear: BRIO.throatClear,
}

function part(s: TrackSpec, key: string): string {
  const p = generateTrackParts(s).find((q) => q.key === key)
  if (!p) throw new Error(`no ${key} part`)
  return p.d
}

function rings(d: string): [number, number][][] {
  return flattenPath(d, 0.02) as [number, number][][]
}

function bbox(d: string) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const r of rings(d)) for (const [x, y] of r) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 }
}

function shift(d: string, dx: number): [number, number][][] {
  return rings(d).map((r) => r.map(([x, y]) => [x + dx, y] as [number, number]))
}

/** Area two outlines have in common — nought for a joint that goes together. */
function overlapArea(a: [number, number][][], b: [number, number][][]): number {
  const out = polygonClipping.intersection(a.map((r) => [r]) as never, b.map((r) => [r]) as never)
  let area = 0
  for (const poly of out) for (const ring of poly) area += Math.abs(signedArea(ring as [number, number][]))
  return area
}

/**
 * Piece 1's peg pushed into piece 2's socket with the end faces touching, which
 * is where a joint sits when the layout is pushed together. The shift is worked
 * out from `pegReach` alone — the two bboxes and the length of the peg — so it
 * is measuring the geometry rather than restating it.
 */
function buttedJoint(s: TrackSpec) {
  const male = { ...s, endA: 'plain' as const, endB: 'male' as const }
  const female = { ...s, endA: 'female' as const, endB: 'plain' as const }
  const dm = trackDims(s)
  const a = part(male, 'body'), b = part(female, 'body')
  const faceOfMale = bbox(a).x1 - dm.pegReach
  return { a: rings(a), b: shift(b, faceOfMale - bbox(b).x0), dm }
}

/**
 * Where the arc centre landed once the piece was re-centred on its own bbox.
 * A sector spanning ±θ/2 reaches `ro` at angle 0 and only `ri·cos(θ/2)` at its
 * ends, so its box gives the centre away in closed form — and on a symmetric
 * piece (both ends alike) the pegs move only the Y extent, which is centred
 * anyway. The test above checks that reading before relying on it.
 */
function arcCentre(s: TrackSpec) {
  const half = ((s.sweepDeg / 2) * Math.PI) / 180
  const ri = s.radius - s.width / 2, ro = s.radius + s.width / 2
  return { x: -(ri * Math.cos(half) + ro) / 2, y: 0 }
}

function rotate(rs: [number, number][][], c: { x: number; y: number }, a: number): [number, number][][] {
  const ca = Math.cos(a), sa = Math.sin(a)
  return rs.map((r) => r.map(([x, y]) => {
    const dx = x - c.x, dy = y - c.y
    return [c.x + dx * ca - dy * sa, c.y + dx * sa + dy * ca] as [number, number]
  }))
}

describe('BRIO track — the published dimensions come out of the generator', () => {
  it('a straight piece is 40 wide and as long as its length plus one peg', () => {
    const b = bbox(part(std, 'body'))
    expect(b.h).toBeCloseTo(40, 3)
    expect(b.w).toBeCloseTo(144 + 18.5, 3)   // 7 mm neck + Ø11.5 head reaches 18.5
  })

  it('the length is the PITCH — face to face, what the piece adds to a layout', () => {
    expect(trackDims(std).pitch).toBeCloseTo(144, 6)
    expect(bbox(part({ ...std, endA: 'plain', endB: 'plain' }, 'body')).w).toBeCloseTo(144, 3)
  })

  it('the socket is Ø16 with an 8 mm throat 5 mm long, derived from the peg', () => {
    const dm = trackDims(std)
    expect(dm.socketDia).toBeCloseTo(16, 6)
    expect(dm.throatW).toBeCloseTo(8, 6)
    expect(dm.throatL).toBeCloseTo(4.75, 6)   // the guide's "5 mm long throat"
  })

  it('the grooves sit 26 apart and leave 4 mm of rail outside each one', () => {
    const dm = trackDims(std)
    expect(dm.railMargin).toBeCloseTo(4, 6)
    const g = bbox(part(std, 'groove'))
    expect(g.y0).toBeCloseTo(-13, 3)
    expect(g.y1).toBeCloseTo(13, 3)
  })

  it('the grooves run the full body, face to face, so a flange crosses the joint', () => {
    expect(bbox(part(std, 'groove')).w).toBeCloseTo(144, 3)
  })

  it('a curve quotes its radius to the CENTRELINE, and eight 45s close a circle', () => {
    const dm = trackDims({ ...std, kind: 'curve' })
    expect(dm.innerRadius).toBeCloseTo(162, 6)
    expect(dm.outerRadius).toBeCloseTo(202, 6)
    expect(dm.perCircle).toBeCloseTo(8, 6)
    expect(dm.closesCircle).toBe(true)
    expect(trackDims({ ...std, kind: 'curve', sweepDeg: 50 }).closesCircle).toBe(false)
  })
})

describe('BRIO track — the outline is one region a profile can follow', () => {
  for (const [name, s] of [
    ['socket and peg', std],
    ['two pegs', { ...std, endA: 'male' as const }],
    ['two sockets', { ...std, endB: 'female' as const }],
    ['curved', { ...std, kind: 'curve' as const }],
  ] as [string, TrackSpec][]) {
    it(`${name} leaves a single closed ring, not a body with a disc beside it`, () => {
      const r = rings(part(s, 'body'))
      expect(r).toHaveLength(1)
      expect(signedArea(r[0])).toBeGreaterThan(0)
    })
  }

  it('emits the grooves as their own part — a different tool from the outline', () => {
    expect(generateTrackParts(std).map((p) => p.key)).toEqual(['body', 'groove'])
  })

  it('groove centrelines are open and groove outlines are closed 6 mm rings', () => {
    const line = part(std, 'groove')
    expect(line).not.toContain('Z')
    const ring = part({ ...std, grooveMode: 'outline' }, 'groove')
    const r = rings(ring)
    expect(r).toHaveLength(2)
    for (const g of r) expect(Math.abs(signedArea(g))).toBeCloseTo(144 * 6, 1)
  })
})

describe('BRIO track — the joint', () => {
  it('a peg butted into the next piece’s socket touches nothing', () => {
    const { a, b } = buttedJoint(std)
    expect(overlapArea(a, b)).toBeLessThan(0.01)
  })

  it('and it really is IN the socket — the peg passes the mating end face', () => {
    const { a, b, dm } = buttedJoint(std)
    let maleTip = -Infinity, femaleFace = Infinity
    for (const r of a) for (const [x] of r) maleTip = Math.max(maleTip, x)
    for (const r of b) for (const [x] of r) femaleFace = Math.min(femaleFace, x)
    expect(maleTip - femaleFace).toBeCloseTo(dm.pegReach, 3)
  })

  // The test above passes for a peg that merely misses the wood — including one
  // hanging in free air — so this is the mutation that proves it bites: take the
  // slack out and the two pieces have to foul each other.
  it('and fouls it once the clearances are taken away', () => {
    const tight = { ...std, holeClear: -0.5, throatClear: -0.5 }
    const { a, b } = buttedJoint(tight)
    expect(overlapArea(a, b)).toBeGreaterThan(1)
  })

  it('the head has 2.25 mm all round and the neck 1 mm a side', () => {
    const dm = trackDims(std)
    expect(dm.headClearance).toBeCloseTo(2.25, 6)
    expect(dm.neckClearance).toBeCloseTo(1, 6)
  })

  it('holds on a curve too, where the joint runs down the TANGENT', () => {
    const s = { ...std, kind: 'curve' as const }
    const dm = trackDims(s)
    const c = arcCentre(s)
    // The guard on the closed form above: the piece's widest point is a point
    // ON the outer arc, so the bbox really does give the arc centre away.
    expect(bbox(part({ ...s, endA: 'male', endB: 'male' }, 'body')).x1 - c.x).toBeCloseTo(dm.outerRadius, 2)

    // Two pieces in a ring: the second is the first turned by one sweep about
    // the arc centre, which is what laying eight of them on the floor does. A
    // connector cut square to the piece instead of square to the RADIAL face
    // would show up here as an overlap, and nowhere else.
    const male = rings(part({ ...s, endA: 'male', endB: 'male' }, 'body'))
    const female = rings(part({ ...s, endA: 'female', endB: 'female' }, 'body'))
    const turned = rotate(female, c, (s.sweepDeg * Math.PI) / 180)
    expect(overlapArea(male, turned)).toBeLessThan(0.01)

    // …and the peg really does stand on the tangent rather than on the radius:
    // its tip is `pegReach` along the tangent from where the centreline arc
    // meets the end face, which is a different point from `pegReach` along the
    // radius by 3.6 mm at this radius — enough to jam a joint, not enough to
    // see on the canvas.
    // Measured in the end's own frame: how far the piece reaches along the
    // TANGENT past where the centreline meets the face, and how wide it is
    // across that. A peg laid on the radius instead would read short here.
    const a1 = ((s.sweepDeg / 2) * Math.PI) / 180
    const ox = c.x + s.radius * Math.cos(a1), oy = c.y + s.radius * Math.sin(a1)
    const ux = -Math.sin(a1), uy = Math.cos(a1)
    let reach = 0, across = 0
    for (const r of male) for (const [x, y] of r) {
      const u = (x - ox) * ux + (y - oy) * uy
      if (u > reach) reach = u
      if (u > s.neckL) across = Math.max(across, Math.abs(-(x - ox) * uy + (y - oy) * ux))
    }
    expect(reach).toBeCloseTo(dm.pegReach, 1)
    // The head is sampled as an inscribed polyline, so it measures a chord
    // tolerance under Ø rather than over it — never over.
    expect(across * 2).toBeLessThanOrEqual(s.pegDia)
    expect(across * 2).toBeGreaterThan(s.pegDia - 0.2)
  })
})

describe('BRIO track — what the panel warns about', () => {
  it('says nothing at the standard numbers', () => {
    const dm = trackDims(std)
    expect([dm.grooveOffTrack, dm.socketBreachesGroove, dm.socketsTooDeep, dm.pegTooThin]).toEqual([false, false, false, false])
  })

  it('catches a socket cut into the groove when the gauge is closed up', () => {
    expect(trackDims({ ...std, gauge: 20 }).socketBreachesGroove).toBe(true)
  })

  it('catches grooves laid off the edge of a narrow piece', () => {
    expect(trackDims({ ...std, width: 28 }).grooveOffTrack).toBe(true)
  })

  it('catches two sockets meeting in the middle of a short piece', () => {
    expect(trackDims({ ...std, endB: 'female', length: 40 }).socketsTooDeep).toBe(true)
  })
})

// ─── The turnout ──────────────────────────────────────────────────────────────

const tn: TrackSpec = { ...std, kind: 'turnout', endA: 'female', endB: 'male', endC: 'male' }

describe('BRIO track — the turnout is two routes out of one toe', () => {
  it('the toe face is shared: both routes start on the same 26 mm gauge', () => {
    // Each route's grooves must leave the toe face exactly where a butted
    // neighbour's do, or the piece is a switch that nothing feeds. All four
    // start there, in coincident pairs, one gauge apart.
    const s = { ...tn, endA: 'plain' as const }
    const toeX = bbox(part(s, 'body')).x0
    const atToe = rings(part(s, 'groove'))
      .map((l) => l.reduce((m, q) => (q[0] < m[0] ? q : m), l[0]))
      .filter((q) => Math.abs(q[0] - toeX) < 0.01)
      .map((q) => q[1])
      .sort((a, b) => a - b)
    expect(atToe).toHaveLength(4)
    expect(atToe[1] - atToe[0]).toBeCloseTo(0, 6)      // straight + branch, one slot
    expect(atToe[3] - atToe[2]).toBeCloseTo(0, 6)
    expect(atToe[2] - atToe[0]).toBeCloseTo(tn.gauge, 6)
  })

  it('grooves BOTH routes end to end — a passive switch has no moving points', () => {
    expect(rings(part(tn, 'groove'))).toHaveLength(4)
  })

  it('the branch heel stands square to its own radial face, one sweep round', () => {
    const dm = trackDims(tn)
    // The heel's centre is `radius·sin θ` along and `radius·(1−cos θ)` aside,
    // and the peg leaves it on the TANGENT — so the piece reaches that much
    // further again in the branch's own direction.
    const th = (tn.sweepDeg * Math.PI) / 180
    const b = bbox(part(tn, 'body'))
    const reach = tn.radius * Math.sin(th) + dm.pegReach * Math.cos(th)
    expect(dm.divergeOffset).toBeCloseTo(tn.radius * (1 - Math.cos(th)), 6)
    // The straight heel's peg still wins on X, so the branch must not exceed it.
    expect(reach).toBeLessThan(b.x1 - b.x0)
  })

  it('the frog falls out of the GAUGE alone — sweep does not move it', () => {
    expect(trackDims(tn).frogDist).toBeCloseTo(Math.sqrt(2 * tn.radius * tn.gauge), 6)
    expect(trackDims({ ...tn, sweepDeg: 60 }).frogDist).toBeCloseTo(trackDims(tn).frogDist, 6)
    expect(trackDims({ ...tn, radius: 300 }).frogDist).toBeGreaterThan(trackDims(tn).frogDist)
  })

  it('leaves one closed ring, both hands, with or without a crotch fillet', () => {
    for (const hand of ['left', 'right'] as const) {
      for (const crotch of [0, 6, 12]) {
        expect(rings(part({ ...tn, hand, crotch }, 'body'))).toHaveLength(1)
      }
    }
  })

  it('the crotch fillet ADDS material and leaves the end faces alone', () => {
    const plain = { ...tn, endA: 'plain' as const, endB: 'plain' as const, endC: 'plain' as const }
    const area = (c: number) => Math.abs(signedArea(rings(part({ ...plain, crotch: c }, 'body'))[0]))
    expect(area(6)).toBeGreaterThan(area(0))
    expect(area(12)).toBeGreaterThan(area(6))
    // A closing leaves convex corners where it found them, so the main leg is
    // still exactly as long as it was asked to be.
    for (const c of [0, 6, 12]) expect(bbox(part({ ...plain, crotch: c }, 'body')).w).toBeCloseTo(tn.length, 2)
  })

  it('a right turnout is the left one flipped, and nothing else', () => {
    const l = rings(part({ ...tn, hand: 'left' }, 'body'))[0]
    const r = rings(part({ ...tn, hand: 'right' }, 'body'))[0]
    expect(r).toHaveLength(l.length)
    // Same set of points, whichever way round the ring each happens to be wound
    // — so it is nearest-neighbour, not index-by-index.
    const A = l.map(([x, y]) => [x, -y] as [number, number])
    let worst = 0
    for (const [ax, ay] of A) {
      let near = Infinity
      for (const [bx, by] of r) near = Math.min(near, Math.hypot(ax - bx, ay - by))
      worst = Math.max(worst, near)
    }
    expect(worst).toBeLessThan(1e-6)
  })

  it('merges the groove OUTLINES into one region with no hole in it', () => {
    // Under an even-odd fill an un-merged crossing at the frog reads as a hole
    // and is left standing — a lump where a flange is already unsupported.
    const merged = polygonClipping.union(
      rings(part({ ...tn, grooveMode: 'outline' }, 'groove')).map((r) => [r]) as never,
    )
    expect(merged).toHaveLength(1)      // all four routes are one connected region
    expect(merged[0]).toHaveLength(1)   // …and that region has no inner ring
  })
})

describe('BRIO track — what the turnout warns about', () => {
  it('says nothing at the standard numbers', () => {
    const dm = trackDims(tn)
    expect([dm.frogPastEnd, dm.frogPastSweep, dm.heelsFoul]).toEqual([false, false, false])
  })

  it('catches a main leg that ends inside the frog', () => {
    expect(trackDims({ ...tn, length: 80 }).frogPastEnd).toBe(true)
  })

  it('catches a branch cut off before the frog, where the routes never part', () => {
    expect(trackDims({ ...tn, sweepDeg: 20 }).frogPastSweep).toBe(true)
  })

  it('catches two heels still inside each other’s stock', () => {
    expect(trackDims({ ...tn, sweepDeg: 30 }).heelsFoul).toBe(true)
    expect(trackDims({ ...tn, sweepDeg: 30 }).divergeOffset).toBeLessThan(tn.width)
  })

  it('leaves the straight-piece warnings alone — they are about the main route', () => {
    const dm = trackDims(tn)
    expect([dm.grooveOffTrack, dm.socketBreachesGroove, dm.socketsTooDeep, dm.pegTooThin]).toEqual([false, false, false, false])
  })
})
