import * as THREE from 'three'
import { segTool, type SimSegment, type ToolState } from '../sim/gcodeParser'
import type { ZOrigin } from '../store/workpieceStore'
import { Z_DATUM_COLOR_THREE } from '../colors'
import { WOOD_TILE_MM } from './woodTexture'

// ─── Heightfield material-removal simulation (alternate to VoxelMaterial) ──────
//
// Instead of a quadtree of instanced boxes, the stock is a single regular grid of
// height samples (`topZ`, one per vertex). A static displaced plane reads those
// heights from a float DataTexture in the vertex shader; surface normals are
// computed per-vertex from neighbouring texels so shading stays smooth at any
// resolution. Cutting just lowers `topZ` cells under the tool footprint and the
// dirty texture is re-uploaded — no geometry is ever rebuilt.
//
// The per-cell carve math (flat / ball / V-bit) is the same closest-point model
// VoxelMaterial uses, evaluated over a uniform grid rather than variable leaves.
// Coordinate convention matches ThreeView: workpiece bottom at three-space Y=0,
// top at Y=thickness; threeZ = -cncY. `topZ` holds material height above the
// bottom (0 … thickness), exactly like VoxelMaterial's `leaf.height`.

function isCuttingSeg(seg: SimSegment): boolean {
  return !seg.rapid && (seg.prevZ < 0 || seg.z < 0)
}

// The surface uses a stock MeshLambertMaterial (same as the voxel meshes) so its
// lighting matches the voxel renderer. onBeforeCompile injects the heightfield
// displacement and per-vertex normals, and samples the planar world-mm-mapped
// wood texture for the diffuse colour — carved surfaces read as wood too,
// distinguished by depth and lighting rather than a highlight colour.
function patchSurfaceShader(
  mat: THREE.MeshLambertMaterial,
  texture: THREE.DataTexture,
  NX: number, NY: number,
  sx: number, sy: number,
  T: number,
  woodTex: THREE.Texture,
) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uHeight = { value: texture }
    shader.uniforms.uTexel = { value: new THREE.Vector2(1 / NX, 1 / NY) }
    shader.uniforms.uSpacing = { value: new THREE.Vector2(sx, sy) }
    shader.uniforms.uWoodTex = { value: woodTex }
    shader.uniforms.uWoodScale = { value: 1 / WOOD_TILE_MM }
    shader.uniforms.uThickness = { value: T }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
        uniform sampler2D uHeight;
        uniform vec2 uTexel;     // 1/NX, 1/NY
        uniform vec2 uSpacing;   // sample spacing in world mm (sx, sy)
        attribute vec2 aHUv;     // texel-centre UV for this vertex
        varying float vH;
        varying vec2 vWUv;       // planar wood UV in mm: (localX, localY)`)
      // Per-vertex normal from neighbouring texels (smooth shading at any res).
      // Tangents in three-space: +u → +X, +v(row) → +cncY → -threeZ.
      .replace('#include <beginnormal_vertex>', /* glsl */ `
        float _hL = texture2D(uHeight, aHUv - vec2(uTexel.x, 0.0)).r;
        float _hR = texture2D(uHeight, aHUv + vec2(uTexel.x, 0.0)).r;
        float _hD = texture2D(uHeight, aHUv - vec2(0.0, uTexel.y)).r;
        float _hU = texture2D(uHeight, aHUv + vec2(0.0, uTexel.y)).r;
        vec3 objectNormal = normalize(cross(
          vec3(2.0 * uSpacing.x, _hR - _hL, 0.0),
          vec3(0.0, _hU - _hD, -2.0 * uSpacing.y)));`)
      // Displace the flat plane vertex up to its sampled height.
      .replace('#include <begin_vertex>', /* glsl */ `
        float _h = texture2D(uHeight, aHUv).r;
        vec3 transformed = vec3(position.x, _h, position.z);
        vH = _h;
        vWUv = vec2(position.x, -position.z);`)

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
        uniform sampler2D uWoodTex;
        uniform float uWoodScale;
        uniform float uThickness;
        varying float vH;
        varying vec2 vWUv;`)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
        // Cut all the way through the stock (height collapsed to 0) → drop the
        // fragment so the scene background shows through the hole instead of a floor.
        if (vH <= 0.001) discard;
        vec3 _wood = texture2D(uWoodTex, vWUv * uWoodScale).rgb;
        // Freshly machined surfaces read lighter than the oxidized/aged outer
        // face: slightly desaturate, then gamma-lift carved fragments. The
        // gamma curve lightens dark species (walnut, cherry) strongly while
        // barely moving already-pale stock (maple), so the carve stays visible
        // on any wood without washing light ones out.
        if (vH < uThickness - 0.001) {
          float _lum = dot(_wood, vec3(0.299, 0.587, 0.114));
          _wood = mix(_wood, vec3(_lum), 0.2);
          _wood = pow(_wood, vec3(0.5));
        }
        diffuseColor.rgb = _wood;`)
  }
}

// The stock bottom over the cut region is a separate flat plane at Y=0 (reusing the
// surface grid, undisplaced). It carries the wood colour like the rest of the block,
// but discards wherever the column is fully cut so a through-hole becomes a real hole
// rather than exposing a wood-coloured floor.
function patchFloorShader(mat: THREE.MeshLambertMaterial, texture: THREE.DataTexture) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uHeight = { value: texture }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
        uniform sampler2D uHeight;
        attribute vec2 aHUv;
        varying float vH;`)
      .replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
        vH = texture2D(uHeight, aHUv).r;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
        varying float vH;`)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
        if (vH <= 0.001) discard;`)
  }
}

// The static stock (walls + aprons) uses the wood texture via the standard
// Lambert map path (planar mm UVs baked in buildStock). This patch adds the
// Z0-datum highlight: each vertex carries aDatum (1 at the datum edge, 0 at the
// far edge; 0 on flat faces) and the fragment lerps the textured diffuse toward
// the datum color with squared falloff, matching the skirt's gradient.
function patchStockShader(mat: THREE.MeshLambertMaterial, datumColor: number) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDatum = { value: new THREE.Color(datumColor) }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
        attribute float aDatum;
        varying float vDatum;`)
      .replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
        vDatum = aDatum;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
        uniform vec3 uDatum;
        varying float vDatum;`)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, uDatum, vDatum * vDatum);`)
  }
}

// The boundary skirt is a vertical curtain whose bottom vertices sit at Y=0 and
// whose top vertices ride the sampled heightfield, so the stock edge follows the
// carve. Per-vertex aTop selects bottom (0) vs. top (sampled height); the diffuse
// is the same wood→datum gradient as the static walls, keyed on world Y. Columns
// cut clean through (sampled height ≈ 0) are discarded so the hole stays open.
function patchSkirtShader(
  mat: THREE.MeshLambertMaterial,
  texture: THREE.DataTexture,
  T: number,
  woodTex: THREE.Texture,
  datumColor: number,
  datumTop: boolean,
) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uHeight = { value: texture }
    shader.uniforms.uWoodTex = { value: woodTex }
    shader.uniforms.uWoodScale = { value: 1 / WOOD_TILE_MM }
    shader.uniforms.uDatum = { value: new THREE.Color(datumColor) }
    shader.uniforms.uThickness = { value: T }
    shader.uniforms.uDatumTop = { value: datumTop ? 1 : 0 }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
        uniform sampler2D uHeight;
        attribute vec2 aHUv;     // texel-centre UV of the edge sample this vertex rides
        attribute float aTop;    // 1 = top (ride height), 0 = bottom (stay at Y=0)
        varying float vH;
        varying float vWorldY;
        varying vec2 vWUv;       // wall wood UV in mm: (along-edge, height) — matches buildStock's wall UVs`)
      .replace('#include <begin_vertex>', /* glsl */ `
        float _h = texture2D(uHeight, aHUv).r;
        float _y = aTop > 0.5 ? _h : 0.0;
        vec3 transformed = vec3(position.x, _y, position.z);
        vH = _h;
        vWorldY = _y;
        vWUv = vec2(position.x - position.z, _y);`)

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
        uniform sampler2D uWoodTex;
        uniform float uWoodScale;
        uniform vec3 uDatum;
        uniform float uThickness;
        uniform float uDatumTop;
        varying float vH;
        varying float vWorldY;
        varying vec2 vWUv;`)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
        if (vH <= 0.001) discard;
        float _f = uDatumTop > 0.5 ? vWorldY / uThickness : (uThickness - vWorldY) / uThickness;
        _f = clamp(_f, 0.0, 1.0);
        vec3 _wood = texture2D(uWoodTex, vWUv * uWoodScale).rgb;
        diffuseColor.rgb = mix(_wood, uDatum, _f * _f);`)
  }
}

const TARGET_CELL_MM = 0.05            // desired sample spacing where cuts happen
const MAX_SAMPLES = 4_000_000          // cap total grid samples (texture + vertices)
const MAX_AXIS = 4096                  // hard cap on samples per axis

interface CutBounds { x0: number; y0: number; x1: number; y1: number; empty: boolean }

function segMaxRadius(seg: SimSegment, toolStates: ToolState[]): number {
  const ts = segTool(seg, toolStates)
  if (ts.toolVbitHalfAngleTan) return Math.max(Math.abs(seg.prevZ), Math.abs(seg.z)) * ts.toolVbitHalfAngleTan
  return ts.toolDiameterMM / 2
}

// Bounding box (workpiece-local mm) of every cutting move's footprint, padded and
// clamped to the stock. The heightfield only grids this region so resolution can
// concentrate where material is actually removed instead of being spread evenly
// over the whole stock. `empty` = no cuts inside the stock (grid the whole block
// coarsely — it stays flat anyway).
function computeCutBounds(
  segments: SimSegment[], toolStates: ToolState[],
  orgX: number, orgY: number, W: number, H: number,
): CutBounds {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const seg of segments) {
    if (seg.rapid || (seg.prevZ >= 0 && seg.z >= 0)) continue
    const ax = seg.prevX + orgX, ay = seg.prevY + orgY
    const bx = seg.x + orgX, by = seg.y + orgY
    const r = segMaxRadius(seg, toolStates)
    const sx0 = Math.min(ax, bx) - r, sx1 = Math.max(ax, bx) + r
    const sy0 = Math.min(ay, by) - r, sy1 = Math.max(ay, by) + r
    if (sx1 <= 0 || sx0 >= W || sy1 <= 0 || sy0 >= H) continue  // wholly off the stock
    x0 = Math.min(x0, sx0); y0 = Math.min(y0, sy0)
    x1 = Math.max(x1, sx1); y1 = Math.max(y1, sy1)
  }
  if (!isFinite(x0)) return { x0: 0, y0: 0, x1: W, y1: H, empty: true }
  const pad = 1.0  // keep a flat-stock margin around the cuts so edges meet the apron cleanly
  return {
    x0: Math.max(0, x0 - pad), y0: Math.max(0, y0 - pad),
    x1: Math.min(W, x1 + pad), y1: Math.min(H, y1 + pad),
    empty: false,
  }
}

export class HeightfieldMaterial {
  readonly group: THREE.Group
  readonly topZ: Float32Array
  readonly cellMM: number              // effective sample spacing (for logging)
  anyCarved = false

  private readonly _NX: number
  private readonly _NY: number
  private readonly _sx: number          // sample spacing X (mm)
  private readonly _sy: number          // sample spacing Y (mm)
  private readonly _gx0: number         // grid origin X in workpiece-local mm
  private readonly _gy0: number         // grid origin Y in workpiece-local mm
  private readonly _T: number
  private readonly _orgX: number
  private readonly _orgY: number
  private readonly _toolStates: ToolState[]
  private readonly _texture: THREE.DataTexture
  private readonly _surfaceGeo: THREE.BufferGeometry
  private readonly _surfaceMat: THREE.MeshLambertMaterial
  private readonly _floorMat: THREE.MeshLambertMaterial
  private readonly _stockGeo: THREE.BufferGeometry
  private readonly _stockMat: THREE.MeshLambertMaterial
  private readonly _skirtGeo: THREE.BufferGeometry | null
  private readonly _skirtMat: THREE.MeshLambertMaterial | null

  private _dirty = false
  private _lastFullIdx = -1
  private _lastPartialIdx = -1
  private _lastPartialT = 0

  constructor(
    W: number, H: number, T: number,
    segments: SimSegment[],
    toolStates: ToolState[],
    orgX: number, orgY: number,
    woodTex: THREE.Texture,
    zOrigin: ZOrigin = 'top',
  ) {
    this._T = T
    this._orgX = orgX
    this._orgY = orgY
    this._toolStates = toolStates

    // Grid only the region that actually gets cut, so resolution concentrates
    // there rather than being spread over the whole stock.
    const bounds = computeCutBounds(segments, toolStates, orgX, orgY, W, H)
    const gx0 = bounds.x0, gy0 = bounds.y0
    const regionW = Math.max(bounds.x1 - bounds.x0, 1e-3)
    const regionH = Math.max(bounds.y1 - bounds.y0, 1e-3)
    this._gx0 = gx0
    this._gy0 = gy0

    // Cell size = target resolution, but coarsened if the cut region is large
    // enough that the target would blow the sample budget. With no cuts, a coarse
    // whole-stock grid (it only ever shows flat stock).
    const targetCell = bounds.empty ? Math.max(W, H) / 4 : TARGET_CELL_MM
    const byBudget = Math.sqrt((regionW * regionH) / MAX_SAMPLES)
    const cell = Math.max(targetCell, byBudget, 0.01)
    const NX = Math.max(2, Math.min(MAX_AXIS, Math.round(regionW / cell) + 1))
    const NY = Math.max(2, Math.min(MAX_AXIS, Math.round(regionH / cell) + 1))
    this._NX = NX
    this._NY = NY
    this._sx = regionW / (NX - 1)
    this._sy = regionH / (NY - 1)
    this.cellMM = (this._sx + this._sy) / 2

    this.topZ = new Float32Array(NX * NY).fill(T)

    // Heightfield texture (one float per sample), nearest-sampled and texel-aligned.
    this._texture = new THREE.DataTexture(this.topZ, NX, NY, THREE.RedFormat, THREE.FloatType)
    this._texture.magFilter = THREE.NearestFilter
    this._texture.minFilter = THREE.NearestFilter
    this._texture.wrapS = THREE.ClampToEdgeWrapping
    this._texture.wrapT = THREE.ClampToEdgeWrapping
    this._texture.needsUpdate = true

    // Static displaced plane over the cut region: vertex (i,j) at world
    // (gx0+i·sx, 0, -(gy0+j·sy)), uv at the matching texel centre so nearest
    // sampling fetches that sample exactly.
    const positions = new Float32Array(NX * NY * 3)
    const uvs = new Float32Array(NX * NY * 2)
    const woodUvs = new Float32Array(NX * NY * 2)   // planar mm/tile mapping for the floor's standard map
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const k = j * NX + i
        positions[k * 3] = gx0 + i * this._sx
        positions[k * 3 + 1] = 0
        positions[k * 3 + 2] = -(gy0 + j * this._sy)
        uvs[k * 2] = (i + 0.5) / NX
        uvs[k * 2 + 1] = (j + 0.5) / NY
        woodUvs[k * 2] = (gx0 + i * this._sx) / WOOD_TILE_MM
        woodUvs[k * 2 + 1] = (gy0 + j * this._sy) / WOOD_TILE_MM
      }
    }
    const indexCount = (NX - 1) * (NY - 1) * 6
    const indices = indexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount)
    let o = 0
    for (let j = 0; j < NY - 1; j++) {
      for (let i = 0; i < NX - 1; i++) {
        const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1
        indices[o++] = a; indices[o++] = c; indices[o++] = b
        indices[o++] = b; indices[o++] = c; indices[o++] = d
      }
    }
    this._surfaceGeo = new THREE.BufferGeometry()
    this._surfaceGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this._surfaceGeo.setAttribute('aHUv', new THREE.BufferAttribute(uvs, 2))
    this._surfaceGeo.setAttribute('uv', new THREE.BufferAttribute(woodUvs, 2))
    this._surfaceGeo.setIndex(new THREE.BufferAttribute(indices, 1))

    this._surfaceMat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide })
    patchSurfaceShader(this._surfaceMat, this._texture, NX, NY, this._sx, this._sy, T, woodTex)

    // Flat bottom of the stock over the cut region — reuses the surface grid
    // (undisplaced at Y=0) and punches through where the cut goes clean through.
    this._floorMat = new THREE.MeshLambertMaterial({ map: woodTex, side: THREE.DoubleSide })
    patchFloorShader(this._floorMat, this._texture)

    // Static stock geometry (wood): perimeter walls + bottom face, plus a flat
    // "apron" filling the uncut stock area around the gridded cut region so the
    // block still reads as full-size solid stock. All faces carry planar world-mm
    // UVs into the wood texture; the side walls additionally carry an aDatum
    // factor that fades the datum-highlight color in at the Z0 edge (top surface
    // or stock bottom, per zOrigin), giving a visual cue of where Z0 sits.
    this._stockMat = new THREE.MeshLambertMaterial({ map: woodTex, side: THREE.DoubleSide })
    patchStockShader(this._stockMat, Z_DATUM_COLOR_THREE)
    this._stockGeo = buildStock(W, H, T, bounds.x0, bounds.y0, bounds.x1, bounds.y1, zOrigin)

    // Heightfield-driven "skirt" along any stock edge the cut region reaches (a
    // surfacing pass or a pocket overlapping the boundary). Its top edge samples
    // the same heightfield as the surface, so it drops with the carve instead of
    // leaving a full-height vertical lip where the static wall was omitted.
    this._skirtGeo = buildSkirt(NX, NY, this._sx, this._sy, gx0, gy0, W, H)
    if (this._skirtGeo) {
      this._skirtMat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide })
      patchSkirtShader(this._skirtMat, this._texture, T, woodTex, Z_DATUM_COLOR_THREE, zOrigin === 'top')
    } else {
      this._skirtMat = null
    }

    this.group = new THREE.Group()
    this.group.add(new THREE.Mesh(this._surfaceGeo, this._surfaceMat))
    this.group.add(new THREE.Mesh(this._surfaceGeo, this._floorMat))
    this.group.add(new THREE.Mesh(this._stockGeo, this._stockMat))
    if (this._skirtGeo && this._skirtMat) {
      this.group.add(new THREE.Mesh(this._skirtGeo, this._skirtMat))
    }
  }

  reset() {
    this.topZ.fill(this._T)
    this._dirty = true
    this.anyCarved = false
    this._lastFullIdx = -1
    this._lastPartialIdx = -1
    this._lastPartialT = 0
  }

  // Mirrors VoxelMaterial.applyUpTo: incrementally carve completed segments plus
  // the partial current one, resetting if playback scrubbed backwards.
  applyUpTo(segments: SimSegment[], segIdx: number, t: number): boolean {
    if (segments.length === 0) return false

    const goingBack = segIdx < this._lastPartialIdx ||
      (segIdx === this._lastPartialIdx && t < this._lastPartialT - 1e-6)
    if (goingBack) this.reset()

    for (let i = this._lastFullIdx + 1; i < segIdx && i < segments.length; i++) {
      const s = segments[i]
      if (isCuttingSeg(s)) {
        const ts = segTool(s, this._toolStates)
        this._carve(s.prevX, s.prevY, s.x, s.y, s.prevZ, s.z, ts.toolVbitHalfAngleTan, ts.toolBallNose, ts.toolDiameterMM)
      }
    }
    this._lastFullIdx = segIdx - 1

    const seg = segIdx < segments.length ? segments[segIdx] : null
    if (seg && isCuttingSeg(seg)) {
      const startT = segIdx === this._lastPartialIdx ? this._lastPartialT : 0
      if (t > startT + 1e-6) {
        const x0 = seg.prevX + (seg.x - seg.prevX) * startT
        const y0 = seg.prevY + (seg.y - seg.prevY) * startT
        const x1 = seg.prevX + (seg.x - seg.prevX) * t
        const y1 = seg.prevY + (seg.y - seg.prevY) * t
        const pz0 = seg.prevZ + (seg.z - seg.prevZ) * startT
        const pz1 = seg.prevZ + (seg.z - seg.prevZ) * t
        const ts = segTool(seg, this._toolStates)
        this._carve(x0, y0, x1, y1, pz0, pz1, ts.toolVbitHalfAngleTan, ts.toolBallNose, ts.toolDiameterMM)
      }
    }
    this._lastPartialIdx = segIdx
    this._lastPartialT = t

    return this._dirty
  }

  // Re-upload the heightfield texture if it changed this frame. Returns whether
  // anything was uploaded (so the caller can flag a re-render).
  flushToGPU(): boolean {
    if (!this._dirty) return false
    this._texture.needsUpdate = true
    this._dirty = false
    return true
  }

  dispose() {
    this._surfaceGeo.dispose()
    this._surfaceMat.dispose()
    this._floorMat.dispose()
    this._stockGeo.dispose()
    this._stockMat.dispose()
    this._skirtGeo?.dispose()
    this._skirtMat?.dispose()
    this._texture.dispose()
  }

  private _carve(
    ax: number, ay: number, bx: number, by: number,
    prevZ: number, endZ: number,
    vbitTan?: number,
    ballNose?: boolean,
    toolDiameterMM = 0,
  ) {
    const dz = endZ - prevZ
    const r = vbitTan
      ? Math.max(Math.abs(prevZ), Math.abs(endZ)) * vbitTan
      : toolDiameterMM / 2
    if (r <= 0) return

    // Deepest achievable height (tip, deepest Z) — cells already at/below skip.
    const flatH = Math.max(0, this._T + Math.min(prevZ, endZ))

    ax += this._orgX; ay += this._orgY
    bx += this._orgX; by += this._orgY
    const dx = bx - ax, dy = by - ay
    const lenSq = dx * dx + dy * dy

    // Samples are points on an (sx, sy) grid: a sample within half a cell
    // diagonal of the swept edge represents material the cut at least partly
    // removed. Without this coverage margin, two passes whose footprints
    // exactly touch (inside + outside profile on the same path) leave a chain
    // of full-height single-cell spikes wherever a sample center lands
    // epsilon outside both footprints — a ~µm-wide real sliver rendered as a
    // cell-wide wall. Leftovers wider than a cell still show.
    const covEps = 0.5 * Math.hypot(this._sx, this._sy)
    const rPad = r + covEps

    const { _NX: NX, _NY: NY, _sx: sx, _sy: sy, _gx0: gx0, _gy0: gy0, topZ } = this
    const iMin = Math.max(0, Math.floor((Math.min(ax, bx) - rPad - gx0) / sx))
    const iMax = Math.min(NX - 1, Math.ceil((Math.max(ax, bx) + rPad - gx0) / sx))
    const jMin = Math.max(0, Math.floor((Math.min(ay, by) - rPad - gy0) / sy))
    const jMax = Math.min(NY - 1, Math.ceil((Math.max(ay, by) + rPad - gy0) / sy))

    for (let j = jMin; j <= jMax; j++) {
      const py = gy0 + j * sy
      const rowBase = j * NX
      for (let i = iMin; i <= iMax; i++) {
        const idx = rowBase + i
        const cur = topZ[idx]
        if (cur <= flatH) continue
        const px = gx0 + i * sx

        const ex = px - ax, ey = py - ay
        const proj = ex * dx + ey * dy
        // Vertical segment (peck-drill plunge): no XY travel to parameterize,
        // so evaluate at the deepest end — the tip reaches min(prevZ, endZ)
        // over the whole footprint. Falling back to t=0 (start Z) left the
        // final peck depth uncarved, so drills never punched through.
        const tc_raw = lenSq < 1e-8 ? (dz < 0 ? 1 : 0) : proj / lenSq
        const dist0sq = ex * ex + ey * ey
        const perp_sq = Math.max(0, dist0sq - tc_raw * proj)

        let newH: number
        if (vbitTan) {
          const evalF = (tRaw: number): number => {
            const tt = Math.max(0, Math.min(1, tRaw))
            const dt = tt - tc_raw
            return (prevZ + tt * dz) + Math.sqrt(dt * dt * lenSq + perp_sq) / vbitTan
          }
          let fMin = Math.min(evalF(0), evalF(1), evalF(Math.max(0, Math.min(1, tc_raw))))
          const discrim = lenSq * (lenSq - dz * dz * vbitTan * vbitTan)
          if (discrim > 1e-12 && perp_sq > 1e-12) {
            const t_opt = tc_raw - dz * vbitTan * Math.sqrt(perp_sq) / Math.sqrt(discrim)
            fMin = Math.min(fMin, evalF(t_opt))
          }
          newH = Math.max(0, this._T + fMin)
        } else if (ballNose) {
          const tc = Math.max(0, Math.min(1, tc_raw))
          const z_tc = prevZ + tc * dz
          if (z_tc >= 0) continue
          const br = toolDiameterMM / 2
          const dt = tc - tc_raw
          const dist = Math.sqrt(dt * dt * lenSq + perp_sq)
          // Rim cells inside the coverage margin carve to the sphere equator
          // (the max(0, …) clamp degrades to exactly that past dist = br).
          if (dist > br + covEps) continue
          newH = Math.max(0, this._T + z_tc + br - Math.sqrt(Math.max(0, br * br - dist * dist)))
        } else {
          const tc = Math.max(0, Math.min(1, tc_raw))
          const z_tc = prevZ + tc * dz
          if (z_tc >= 0) continue
          const dt = tc - tc_raw
          const dist = Math.sqrt(dt * dt * lenSq + perp_sq)
          if (dist > rPad) continue
          newH = Math.max(0, this._T + z_tc)
        }

        if (cur > newH) {
          topZ[idx] = newH
          this._dirty = true
          this.anyCarved = true
        }
      }
    }
  }
}

// Static stock geometry (everything the heightfield surface does NOT draw):
// the 4 perimeter side walls + bottom face of the full stock block, plus a flat
// top "apron" tiling the uncut area between the stock edge and the gridded cut
// region [gx0..gx1]×[gy0..gy1]. Three-space: X = localX, Y = height, Z = -localY.
function buildStock(
  W: number, H: number, T: number,
  gx0: number, gy0: number, gx1: number, gy1: number,
  zOrigin: ZOrigin,
): THREE.BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const datum: number[] = []
  const idx: number[] = []

  // Per-vertex datum factor: 1 at the Z0 edge (y=T for top-origin, y=0 for
  // bottom-origin) fading to 0 at the far edge; patchStockShader applies the
  // squared-falloff lerp toward the datum color. Flat faces (colored=false) stay 0.
  const wallDatum = (y: number): number => (zOrigin === 'bottom' ? (T - y) / T : y / T)
  // Planar world-mm wood UVs: horizontal faces map (localX, localY); vertical
  // walls map (along-edge, height). The wall form (x - z = localX + localY, one
  // term constant per wall) matches the skirt shader's mapping so the textures
  // agree where a static wall meets a skirt strip.
  const s = 1 / WOOD_TILE_MM
  const quad = (
    p0: [number, number, number], p1: [number, number, number],
    p2: [number, number, number], p3: [number, number, number],
    colored = false,
  ) => {
    const b = pos.length / 3
    pos.push(...p0, ...p1, ...p2, ...p3)
    for (const p of [p0, p1, p2, p3]) {
      if (colored) uv.push((p[0] - p[2]) * s, p[1] * s)
      else uv.push(p[0] * s, -p[2] * s)
      datum.push(colored ? wallDatum(p[1]) : 0)
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }

  // Perimeter walls of the full stock — gradient-tinted to mark the Z0 face.
  // Where the gridded cut region reaches a stock edge (no flat pad margin — the
  // cut runs off the boundary), that stretch of wall is omitted here and rebuilt
  // as a heightfield-driven skirt (buildSkirt) whose top follows the carved
  // surface, so no full-height lip is left at the stock edge. Interior cut
  // regions keep their 1 mm pad, so their grid edges stay at full T and the full
  // static wall is correct.
  const eps = 1e-6
  const touchL = gx0 <= eps, touchR = gx1 >= W - eps
  const touchF = gy0 <= eps, touchB = gy1 >= H - eps
  // Vertical wall along footprint segment (x0,v0)→(x1,v1) (world z = -v), full height.
  const wall = (x0: number, v0: number, x1: number, v1: number) => {
    if (Math.abs(x1 - x0) < eps && Math.abs(v1 - v0) < eps) return
    quad([x0, 0, -v0], [x1, 0, -v1], [x1, T, -v1], [x0, T, -v0], true)
  }
  if (touchL) { wall(0, 0, 0, gy0); wall(0, gy1, 0, H) } else wall(0, 0, 0, H)   // left   x=0
  if (touchR) { wall(W, 0, W, gy0); wall(W, gy1, W, H) } else wall(W, 0, W, H)   // right  x=W
  if (touchF) { wall(0, 0, gx0, 0); wall(gx1, 0, W, 0) } else wall(0, 0, W, 0)   // front  z=0
  if (touchB) { wall(0, H, gx0, H); wall(gx1, H, W, H) } else wall(0, H, W, H)   // back   z=-H

  // Flat apron strips, filling the stock minus the cut region. The top apron (y=T)
  // is the uncut surface around the gridded region; the bottom apron (y=0) is the
  // stock underside there. The cut region's top/bottom come from the heightfield
  // surface and floor meshes, so it's left open here (the floor mesh punches the
  // hole on a through-cut).
  const apron = (y: number) => (rx0: number, ry0: number, rx1: number, ry1: number) => {
    if (rx1 - rx0 > 1e-6 && ry1 - ry0 > 1e-6) {
      quad([rx0, y, -ry0], [rx1, y, -ry0], [rx1, y, -ry1], [rx0, y, -ry1])
    }
  }
  for (const y of [T, 0]) {
    const a = apron(y)
    a(0, 0, gx0, H)        // left of region (full height)
    a(gx1, 0, W, H)        // right of region (full height)
    a(gx0, 0, gx1, gy0)    // below region (middle column)
    a(gx0, gy1, gx1, H)    // above region (middle column)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2))
  geo.setAttribute('aDatum', new THREE.BufferAttribute(new Float32Array(datum), 1))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return geo
}

// Heightfield-driven side curtain along each stock edge the grid actually reaches
// (gx0≈0, gx1≈W, gy0≈0, gy1≈H — the edges where buildStock omits the static wall).
// One vertical strip per touched edge: a top vertex (rides the sampled height via
// patchSkirtShader) and a bottom vertex (Y=0) per edge sample, with constant
// outward normals for lighting. Returns null when no edge is reached (interior cut,
// the static walls already cover it). Three-space: X = localX, Z = -localY.
function buildSkirt(
  NX: number, NY: number, sx: number, sy: number,
  gx0: number, gy0: number, W: number, H: number,
): THREE.BufferGeometry | null {
  const eps = 1e-6
  const gx1 = gx0 + (NX - 1) * sx
  const gy1 = gy0 + (NY - 1) * sy
  const touchL = gx0 <= eps, touchR = gx1 >= W - eps
  const touchF = gy0 <= eps, touchB = gy1 >= H - eps
  if (!touchL && !touchR && !touchF && !touchB) return null

  const pos: number[] = []
  const huv: number[] = []
  const top: number[] = []
  const nor: number[] = []
  const idx: number[] = []

  // Add a strip of `count` samples; sampleAt(k) gives the world XZ, the texel UV
  // of that sample, and (nx,nz) is the edge's outward normal.
  const strip = (
    count: number,
    sampleAt: (k: number) => { x: number; z: number; u: number; v: number },
    nx: number, nz: number,
  ) => {
    const base = pos.length / 3
    for (let k = 0; k < count; k++) {
      const s = sampleAt(k)
      pos.push(s.x, 0, s.z); huv.push(s.u, s.v); top.push(0); nor.push(nx, 0, nz)  // bottom
      pos.push(s.x, 0, s.z); huv.push(s.u, s.v); top.push(1); nor.push(nx, 0, nz)  // top
    }
    for (let k = 0; k < count - 1; k++) {
      const b = base + k * 2
      idx.push(b, b + 2, b + 3, b, b + 3, b + 1)
    }
  }

  if (touchL) strip(NY, j => ({ x: gx0, z: -(gy0 + j * sy), u: 0.5 / NX, v: (j + 0.5) / NY }), -1, 0)
  if (touchR) strip(NY, j => ({ x: gx1, z: -(gy0 + j * sy), u: (NX - 0.5) / NX, v: (j + 0.5) / NY }), 1, 0)
  if (touchF) strip(NX, i => ({ x: gx0 + i * sx, z: -gy0, u: (i + 0.5) / NX, v: 0.5 / NY }), 0, 1)
  if (touchB) strip(NX, i => ({ x: gx0 + i * sx, z: -gy1, u: (i + 0.5) / NX, v: (NY - 0.5) / NY }), 0, -1)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('aHUv', new THREE.BufferAttribute(new Float32Array(huv), 2))
  geo.setAttribute('aTop', new THREE.BufferAttribute(new Float32Array(top), 1))
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3))
  geo.setIndex(idx)
  return geo
}
