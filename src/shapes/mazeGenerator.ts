// ─── Maze (centreline skeleton) ───────────────────────────────────────────────
//
// For a marble run. What this emits is the SKELETON, not the walls: one open
// polyline down the middle of every corridor. Carve those grooves with a ball
// nose and the walls are whatever stock is left standing between them — so the
// groove IS the corridor, and the tool diameter IS the corridor width.
//
// That makes `spacing` the parameter with a machining consequence. Two parallel
// corridors one grid pitch apart leave a wall of
//
//     wall = spacing − toolDiameter
//
// so a 6 mm ball at 12 mm spacing leaves 6 mm of stock, while the same ball at
// 7 mm leaves a 1 mm fin that snaps off the first time a marble hits it. The
// user sets `spacing` from the bit; the generator then fits a whole number of
// cells across w × h and uses the resulting pitch — which is only ever rounded
// UP from `spacing` (`cols−1 = floor(w/spacing)`), because a maze one cell
// coarser than asked for is a disappointment and one cell finer is a broken
// wall. Same reasoning caps the cell count: the guard drops cells, never adds.
//
// Corners are filleted (`corner`) so a marble carries speed through a turn
// instead of stopping dead in a square one. The radius is clamped to half the
// grid pitch — a bigger fillet would swing the corridor's centreline out into
// the neighbouring corridor and cut through the wall between them.
//
// The maze is a randomised-DFS spanning tree over the cell grid: it produces
// long winding corridors with few junctions, which is what a marble run wants
// (a Prim/Kruskal maze is short and bushy). `seed` makes it reproducible;
// `loops` reopens that fraction of the dead ends into loops.

function f(n: number): string { return String(+n.toFixed(4)) }

// A 200×200 mm board at 3 mm spacing is ~4500 cells; past this the d-string is
// bigger than the toolpath is useful.
const MAZE_MAX_CELLS = 6000

export interface MazeGrid {
  cols: number
  rows: number
  /** Actual centreline pitch — always ≥ the requested spacing. */
  dx: number
  dy: number
}

export function mazeGrid(w: number, h: number, spacing: number): MazeGrid {
  const W = Math.max(0.1, w), H = Math.max(0.1, h)
  const s = Math.max(0.1, spacing)
  let cols = Math.max(2, Math.floor(W / s) + 1)
  let rows = Math.max(2, Math.floor(H / s) + 1)
  if (cols * rows > MAZE_MAX_CELLS) {
    const k = Math.sqrt(MAZE_MAX_CELLS / (cols * rows))
    cols = Math.max(2, Math.floor(cols * k))
    rows = Math.max(2, Math.floor(rows * k))
  }
  return { cols, rows, dx: W / (cols - 1), dy: H / (rows - 1) }
}

// Seeded PRNG — the same seed must redraw the same maze, every session and on
// every reload of a .fkam, since only the seed is stored.
function mulberry32(seed: number): () => number {
  let a = (Math.floor(Math.abs(seed)) || 1) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Edges are held in one flat array: the (cols−1)×rows horizontal links first,
// then the cols×(rows−1) vertical ones. `dir` is 0=−x, 1=+x, 2=−y, 3=+y.
function makeEdgeIndex(cols: number, rows: number) {
  const hCount = (cols - 1) * rows
  return {
    count: hCount + cols * (rows - 1),
    step: [-1, 1, -cols, cols],
    at(i: number, j: number, dir: number): number {
      switch (dir) {
        case 0: return i > 0 ? j * (cols - 1) + (i - 1) : -1
        case 1: return i < cols - 1 ? j * (cols - 1) + i : -1
        case 2: return j > 0 ? hCount + (j - 1) * cols + i : -1
        default: return j < rows - 1 ? hCount + j * cols + i : -1
      }
    },
  }
}

/** Open-corridor flags, one per potential link between adjacent cells. */
function carveMaze(cols: number, rows: number, seed: number, loops: number): Uint8Array {
  const idx = makeEdgeIndex(cols, rows)
  const open = new Uint8Array(idx.count)
  const total = cols * rows
  const rnd = mulberry32(seed)

  // Randomised depth-first search, iterative — a 6000-cell grid would blow the
  // JS stack recursing.
  const visited = new Uint8Array(total)
  const start = Math.min(total - 1, Math.floor(rnd() * total))
  const stack = [start]
  visited[start] = 1
  const choices = new Int32Array(4)
  while (stack.length) {
    const cur = stack[stack.length - 1]
    const i = cur % cols, j = (cur - i) / cols
    let n = 0
    for (let dir = 0; dir < 4; dir++) {
      if (idx.at(i, j, dir) < 0) continue
      if (!visited[cur + idx.step[dir]]) choices[n++] = dir
    }
    if (n === 0) { stack.pop(); continue }
    const dir = choices[Math.min(n - 1, Math.floor(rnd() * n))]
    open[idx.at(i, j, dir)] = 1
    const next = cur + idx.step[dir]
    visited[next] = 1
    stack.push(next)
  }

  // Braid: reopen dead ends into loops. Walked in row-major order so the result
  // stays a pure function of the seed.
  if (loops > 0) {
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        let deg = 0, n = 0
        for (let dir = 0; dir < 4; dir++) {
          const e = idx.at(i, j, dir)
          if (e < 0) continue
          if (open[e]) deg++
          else choices[n++] = dir
        }
        if (deg !== 1 || n === 0) continue
        if (rnd() >= loops) continue
        open[idx.at(i, j, choices[Math.min(n - 1, Math.floor(rnd() * n))])] = 1
      }
    }
  }
  return open
}

// Decompose the corridor graph into trails — walks that use every link exactly
// once — instead of emitting one subpath per link. A trail is a continuous cut:
// it keeps the tool down through junctions and, with `d` carrying the corner
// arcs, is what lets a turn come out filleted at all (a per-link subpath has no
// next segment to fillet against).
function buildTrails(cols: number, rows: number, open: Uint8Array): number[][] {
  const idx = makeEdgeIndex(cols, rows)
  const total = cols * rows
  const used = new Uint8Array(idx.count)
  const deg = new Int32Array(total)   // unused open links at each cell
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let d = 0
      for (let dir = 0; dir < 4; dir++) {
        const e = idx.at(i, j, dir)
        if (e >= 0 && open[e]) d++
      }
      deg[j * cols + i] = d
    }
  }

  // Start every trail at a dead end so it runs end-to-end rather than stopping
  // halfway down a corridor and stranding the rest as a second cut. Cells that
  // BECOME dead ends as trails are consumed are queued the same way.
  const leaves: number[] = []
  for (let n = 0; n < total; n++) if (deg[n] === 1) leaves.push(n)

  const walk = (start: number): number[] => {
    const pts = [start]
    let cur = start, prevStep = 0
    for (;;) {
      const i = cur % cols, j = (cur - i) / cols
      let pick = -1, pickEdge = -1
      for (let dir = 0; dir < 4; dir++) {
        const e = idx.at(i, j, dir)
        if (e < 0 || !open[e] || used[e]) continue
        // Prefer carrying straight on through a junction, so the trail's
        // corners land where the maze actually turns.
        if (pick < 0 || idx.step[dir] === prevStep) { pick = dir; pickEdge = e }
        if (idx.step[dir] === prevStep) break
      }
      if (pick < 0) return pts
      used[pickEdge] = 1
      const next = cur + idx.step[pick]
      deg[cur]--; deg[next]--
      if (deg[next] === 1) leaves.push(next)
      prevStep = idx.step[pick]
      pts.push(next)
      cur = next
    }
  }

  const trails: number[][] = []
  while (leaves.length) {
    const n = leaves.pop()!
    if (deg[n] !== 1) continue
    const t = walk(n)
    if (t.length > 1) trails.push(t)
  }
  // Anything left is a loop (only reachable with braiding on).
  for (let n = 0; n < total; n++) {
    while (deg[n] > 0) {
      const t = walk(n)
      if (t.length < 2) break
      trails.push(t)
    }
  }
  return trails
}

// Drop cells the trail passes straight through — a run of collinear steps is
// one segment, so fillets are only inserted at genuine turns.
function collapseStraights(nodes: number[]): number[] {
  const out = [nodes[0]]
  for (let k = 1; k < nodes.length - 1; k++) {
    if (nodes[k + 1] - nodes[k] !== nodes[k] - nodes[k - 1]) out.push(nodes[k])
  }
  out.push(nodes[nodes.length - 1])
  return out
}

// A trail that ENDS on a junction stops at the cell centre, but the trail
// running through that junction was filleted — its arc leaves the corridor a
// tangent length short of the centre, so the two cuts stop `t` apart and the
// stock between them is only grazed by the shoulder of the ball, standing proud
// as a ridge across the mouth of the branch.
//
// Backing the branch's end up by exactly that tangent length closes it: the
// fillet's tangent point IS the branch's line, so the extended tip lands on the
// arc and the two grooves meet at full depth. All turns here are 90°, so the
// tangent length is just the fillet radius.
//
// The extension only ever runs BACK down a corridor that is already open (a
// junction's third arm is always the reverse of one of the turning trail's two
// arms), which is what keeps it from cutting into a wall — at a true dead end
// the reverse direction is solid and nothing is extended.
function extendIntoJunction(
  pts: { x: number; y: number }[], nodes: number[], cols: number,
  idx: ReturnType<typeof makeEdgeIndex>, open: Uint8Array, r: number,
): void {
  if (r < 1e-9 || pts.length < 2) return
  for (const end of [0, pts.length - 1]) {
    const inward = end === 0 ? 1 : pts.length - 2
    const a = nodes[end], b = nodes[inward]
    const ia = a % cols, ja = (a - ia) / cols
    const ib = b % cols, jb = (b - ib) / cols
    // Direction from the endpoint back out of the trail — the reverse of its
    // first (or last) step.
    const back = ja === jb ? (ib > ia ? 0 : 1) : (jb > ja ? 2 : 3)
    const e = idx.at(ia, ja, back)
    if (e < 0 || !open[e]) continue
    const len = Math.hypot(pts[end].x - pts[inward].x, pts[end].y - pts[inward].y)
    if (len < 1e-9) continue
    pts[end] = {
      x: pts[end].x + ((pts[end].x - pts[inward].x) / len) * r,
      y: pts[end].y + ((pts[end].y - pts[inward].y) / len) * r,
    }
  }
}

// One open subpath, corners replaced by tangent arcs of radius `r`.
function trailD(pts: { x: number; y: number }[], r: number): string {
  if (pts.length < 2) return ''
  const parts = [`M${f(pts[0].x)},${f(pts[0].y)}`]
  for (let k = 1; k < pts.length - 1; k++) {
    const p = pts[k], a = pts[k - 1], b = pts[k + 1]
    const lu = Math.hypot(p.x - a.x, p.y - a.y)
    const lv = Math.hypot(b.x - p.x, b.y - p.y)
    if (lu < 1e-9 || lv < 1e-9) continue
    const ux = (p.x - a.x) / lu, uy = (p.y - a.y) / lu
    const vx = (b.x - p.x) / lv, vy = (b.y - p.y) / lv
    const cross = ux * vy - uy * vx
    const phi = Math.atan2(Math.abs(cross), ux * vx + uy * vy)  // turn angle, 0…π
    if (phi < 1e-6) continue
    // Tangent length of a fillet of radius r across a turn of φ. Halving the
    // adjacent runs keeps two fillets on one segment from overlapping.
    const t = Math.min(r * Math.tan(phi / 2), lu / 2, lv / 2)
    if (t < 1e-4) { parts.push(`L${f(p.x)},${f(p.y)}`); continue }
    const rr = t / Math.tan(phi / 2)
    parts.push(`L${f(p.x - ux * t)},${f(p.y - uy * t)}`)
    // sweep=1 is CCW in CNC Y-up (see roundrect in shapeGenerators.ts), and a
    // positive cross product is a left turn.
    parts.push(`A${f(rr)},${f(rr)},0,0,${cross > 0 ? 1 : 0},${f(p.x + vx * t)},${f(p.y + vy * t)}`)
  }
  const last = pts[pts.length - 1]
  parts.push(`L${f(last.x)},${f(last.y)}`)
  return parts.join(' ')
}

export function generateMazeD(p: {
  x: number; y: number; w: number; h: number
  spacing: number; corner: number; seed: number; loops: number
}): string {
  const { cols, rows, dx, dy } = mazeGrid(p.w, p.h, p.spacing)
  const open = carveMaze(cols, rows, p.seed, Math.max(0, Math.min(1, p.loops)))
  // Half the pitch is the hard ceiling: a wider arc leaves the corridor.
  const r = Math.max(0, Math.min(p.corner, Math.min(dx, dy) / 2))

  const idx = makeEdgeIndex(cols, rows)
  const subpaths: string[] = []
  for (const trail of buildTrails(cols, rows, open)) {
    const nodes = collapseStraights(trail)
    const pts = nodes.map((n) => {
      const i = n % cols
      return { x: p.x + i * dx, y: p.y + ((n - i) / cols) * dy }
    })
    extendIntoJunction(pts, nodes, cols, idx, open, r)
    const d = trailD(pts, r)
    if (d) subpaths.push(d)
  }
  // Open subpaths, no Z — this is a skeleton of corridors, not an outline.
  return subpaths.join(' ')
}
