import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useSimStore } from '../store/simStore'
import { useToolpathStore } from '../store/toolpathStore'
import { useWorkpieceStore, zDatumOffsetMM, type Material } from '../store/workpieceStore'
import { useToolStore } from '../store/toolStore'
import { usePathsStore } from '../store/pathsStore'
import { getCurrentSegIdx, interpolatePos, segTool, type SimSegment } from '../sim/gcodeParser'
import { flattenPath } from '../cam/pathFlattener'
import { getBBox } from '../canvas/selectionUtils'
import { SIM_CUT_COLOR_THREE, THREE_BG_COLOR_THREE, MATERIAL_COLORS } from '../colors'
import { VoxelMaterial } from './VoxelMaterial'
import { HeightfieldMaterial } from './HeightfieldMaterial'
import SimulationPlayer from '../sim/SimulationPlayer'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'
import { parseStlGeometry, base64ToArrayBuffer } from '../importers/stlImporter'
import type { StlModelBounds } from '../importers/stlImporter'

// ─── coordinate mapping ──────────────────────────────────────────────────────
//
// CNC space: X right, Y away-from-viewer (up in 2D canvas), Z up (into material = negative)
// Three.js:  X right, Y up, Z toward viewer
//
// Mapping: threeX = cncX,  threeY = thicknessMM + cncZ,  threeZ = -cncY

function cncToThree(x: number, y: number, z: number, T: number): [number, number, number] {
  return [x, T + z, -y]
}

// Converts datum-relative sim segment Z back to top-referenced (Z=0 = stock top,
// negative = in material). Uses genZOff — the offset captured at G-code generation
// time — so results stay correct even if zOrigin changes without regenerating.
function normalizeSimZ(segments: SimSegment[], zOff: number): SimSegment[] {
  if (!zOff) return segments
  return segments.map((s) => ({ ...s, z: s.z - zOff, prevZ: s.prevZ - zOff }))
}

// ─── helpers ────────────────────────────────────────────────────────────────

function buildCNCAxes(size: number): THREE.LineSegments {
  const pos = new Float32Array([
    0, 0, 0,   size, 0,    0,
    0, 0, 0,   0,    0,   -size,
    0, 0, 0,   0,    size,  0,
  ])
  const col = new Float32Array([
    1, 0, 0,   1, 0, 0,
    0, 1, 0,   0, 1, 0,
    0, 0, 1,   0, 0, 1,
  ])
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('color',    new THREE.BufferAttribute(col, 3))
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }))
}

function materialColor(mat: Material): number {
  return MATERIAL_COLORS[mat]?.three ?? 0xc8c8c8
}

// Builds a tool indicator mesh/group.
// V-bit:    sharp cone tip + cylindrical shank (cone height derived from included angle)
// Ball nose: hemisphere tip + cylindrical shank
// Flat/drill: plain cylinder
function buildToolMesh(type: string, diamMM: number, vbitAngleDeg = 60): THREE.Object3D {
  const r = diamMM / 2
  const shankH = diamMM * 4
  const mat = new THREE.MeshLambertMaterial({ color: 0xaaaaaa, transparent: true, opacity: 0.85 })

  if (type === 'vbit' || type === 'drill') {
    const halfAngle = (vbitAngleDeg / 2) * Math.PI / 180
    const coneH = r / Math.tan(halfAngle)
    const group = new THREE.Group()

    // Cone: Three.js ConeGeometry apex is at +Y/2 by default.
    // rotateX(π) flips apex to -Y/2, then translate puts apex at Y=0 and base at Y=coneH.
    const coneGeo = new THREE.ConeGeometry(r, coneH, 24)
    coneGeo.rotateX(Math.PI)
    coneGeo.translate(0, coneH / 2, 0)
    group.add(new THREE.Mesh(coneGeo, mat))

    // Shank cylinder sitting on top of the cone base
    const shankGeo = new THREE.CylinderGeometry(r, r, shankH, 24)
    shankGeo.translate(0, coneH + shankH / 2, 0)
    group.add(new THREE.Mesh(shankGeo, mat))

    return group
  }

  if (type === 'ball') {
    const group = new THREE.Group()

    // Lower hemisphere: thetaStart=π/2 → equator (Y=0), thetaLength=π/2 → south pole (Y=-r).
    // translate(0, r, 0) moves south pole to Y=0 and equator to Y=r.
    const hemiGeo = new THREE.SphereGeometry(r, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2)
    hemiGeo.translate(0, r, 0)
    group.add(new THREE.Mesh(hemiGeo, mat))

    // Shank cylinder from equator (Y=r) upward
    const shankGeo = new THREE.CylinderGeometry(r, r, shankH, 24)
    shankGeo.translate(0, r + shankH / 2, 0)
    group.add(new THREE.Mesh(shankGeo, mat))

    return group
  }

  // Flat end mill: plain cylinder, bottom at Y=0
  const length = r * 2 + shankH
  const geo = new THREE.CylinderGeometry(r, r, length, 24)
  geo.translate(0, length / 2, 0)
  return new THREE.Mesh(geo, mat)
}

function disposeObject3D(obj: THREE.Object3D) {
  obj.traverse(child => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose()
      if (Array.isArray(child.material)) child.material.forEach((m: THREE.Material) => m.dispose())
      else (child.material as THREE.Material).dispose()
    }
  })
}

// ─── voxel sync ──────────────────────────────────────────────────────────────

const _m    = new THREE.Matrix4()
const _mp   = new THREE.Vector3()
const _mr   = new THREE.Quaternion()
const _ms   = new THREE.Vector3()
const _zero = new THREE.Matrix4().makeScale(0, 0, 0)

const SYNC_BATCH = 200_000

// Updates two instanced meshes per dirty leaf:
//   woodMesh — uncut voxels at full height (all faces wood)
//   cutMesh  — carved voxels at reduced height (yellow top+sides, wood bottom)
function syncDirtyInstances(
  voxelMat: VoxelMaterial,
  woodMesh: THREE.InstancedMesh,
  cutMesh: THREE.InstancedMesh,
): boolean {
  const dl = voxelMat.dirtyList
  if (dl.length === 0) return false

  const T = voxelMat.thicknessMM
  const { leaves } = voxelMat
  let count = 0

  while (dl.length > 0 && count < SYNC_BATCH) {
    const idx = dl.pop()!
    const leaf = leaves[idx]
    const isCut = leaf.height < T - 0.001

    if (leaf.height < 0.001) {
      woodMesh.setMatrixAt(idx, _zero)
      cutMesh.setMatrixAt(idx, _zero)
    } else if (isCut) {
      woodMesh.setMatrixAt(idx, _zero)
      _mp.set(leaf.cx, leaf.height / 2, -leaf.cy)
      _ms.set(leaf.cw, leaf.height, leaf.ch)
      _m.compose(_mp, _mr, _ms)
      cutMesh.setMatrixAt(idx, _m)
    } else {
      _mp.set(leaf.cx, leaf.height / 2, -leaf.cy)
      _ms.set(leaf.cw, leaf.height, leaf.ch)
      _m.compose(_mp, _mr, _ms)
      woodMesh.setMatrixAt(idx, _m)
      cutMesh.setMatrixAt(idx, _zero)
    }

    leaf.dirty = false
    count++
  }

  woodMesh.instanceMatrix.needsUpdate = true
  cutMesh.instanceMatrix.needsUpdate  = true
  return true
}

// ─── scene refs ──────────────────────────────────────────────────────────────

// Material-removal simulation strategy. 'voxel' = quadtree instanced boxes
// (VoxelMaterial); 'heightfield' = GPU displaced plane (HeightfieldMaterial).
type SimStrategy = 'voxel' | 'heightfield'

interface StlGeoCacheEntry {
  geo: THREE.BufferGeometry              // raw parsed geometry, not modified
  stlSrcLen: number                      // detect changes by length
  bakedGeo: THREE.BufferGeometry | null  // vertex-transformed geometry, keyed by bakedKey
  bakedKey: string                       // `${path.d}|${T}` — invalidate on placement or thickness change
}

interface SceneRefs {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  workpieceGroup: THREE.Group
  toolpathGroup: THREE.Group
  shapesGroup: THREE.Group
  toolMesh: THREE.Object3D | null
  axesHelper: THREE.Object3D
  gridHelper: THREE.LineSegments
  voxelWoodMesh: THREE.InstancedMesh | null  // uncut voxels, all-wood
  voxelCutMesh:  THREE.InstancedMesh | null  // carved voxels, yellow top/sides + wood bottom
  voxelMat: VoxelMaterial | null
  heightfield: HeightfieldMaterial | null    // alternate GPU heightfield strategy
  simSegments: SimSegment[]                  // top-referenced copy for applyUpTo (uses genZOff)
  simStrategy: SimStrategy
  stlGeoCache: Map<string, StlGeoCacheEntry>  // path.id → parsed raw geometry
  rafId: number
  fpsSamples: number[]
  lastFrameTs: number
  renderNeeded: boolean
  activeToolKey: string  // encodes type+diam+angle; rebuild mesh when it changes
  machineVoxelBudget: number  // 0 = uncalibrated; >0 = voxels/frame this machine can sustain at 30fps
  fpsAdapted: boolean         // true after one adaptation for current gcode
}

// ─── component ───────────────────────────────────────────────────────────────

export default function ThreeView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<SceneRefs | null>(null)
  const fpsRef = useRef<HTMLSpanElement>(null)

  const [showAxes, setShowAxes] = useState(false)
  const [showToolpaths, setShowToolpaths] = useState(false)
  const [showWorkpiece, setShowWorkpiece] = useState(true)
  const [showTool, setShowTool] = useState(true)
  const [showShapes, setShowShapes] = useState(true)
  const [followTool, setFollowTool] = useState(false)

  const showAxesRef      = useRef(showAxes)
  const showToolpathsRef = useRef(showToolpaths)
  const showWorkpieceRef = useRef(showWorkpiece)
  const showToolRef      = useRef(showTool)
  const showShapesRef    = useRef(showShapes)
  const followToolRef    = useRef(followTool)
  showAxesRef.current      = showAxes
  showToolpathsRef.current = showToolpaths
  showWorkpieceRef.current = showWorkpiece
  showToolRef.current      = showTool
  showShapesRef.current    = showShapes
  followToolRef.current    = followTool

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setSize(container.clientWidth, container.clientHeight)
    renderer.setClearColor(THREE_BG_COLOR_THREE)
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(THREE_BG_COLOR_THREE)

    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const sun = new THREE.DirectionalLight(0xffffff, 1.0)
    sun.position.set(1, 2, 1)
    scene.add(sun)

    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 5000)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.1
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    }

    const workpieceGroup = new THREE.Group()
    const toolpathGroup  = new THREE.Group()
    const shapesGroup    = new THREE.Group()
    scene.add(workpieceGroup)
    scene.add(toolpathGroup)
    scene.add(shapesGroup)

    const axesHelper = buildCNCAxes(40)
    scene.add(axesHelper)

    const gridHelper = buildRectGrid(200, 200, 20)
    gridHelper.position.y = -0.5
    scene.add(gridHelper)

    const refs: SceneRefs = {
      renderer, scene, camera, controls,
      workpieceGroup, toolpathGroup, shapesGroup,
      toolMesh: null,
      axesHelper,
      gridHelper,
      voxelWoodMesh: null,
      voxelCutMesh:  null,
      voxelMat: null,
      heightfield: null,
      simSegments: [],
      // Heightfield is the active strategy. The voxel path (VoxelMaterial,
      // rebuildVoxels, syncDirtyInstances) is retained but inactive — set this to
      // 'voxel' to bring it back.
      simStrategy: 'heightfield',
      stlGeoCache: new Map(),
      rafId: 0,
      fpsSamples: [],
      lastFrameTs: 0,
      renderNeeded: true,
      activeToolKey: '',
      machineVoxelBudget: 0,
      fpsAdapted: false,
    }
    sceneRef.current = refs

    controls.addEventListener('change', () => { refs.renderNeeded = true })

    rebuildWorkpiece(refs)
    rebuildToolpaths(refs)
    rebuildShapes(refs)
    fitCamera(refs)

    const ro = new ResizeObserver(() => {
      const w = container.clientWidth, h = container.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      refs.renderNeeded = true
    })
    ro.observe(container)

    function animate(now: number) {
      refs.rafId = requestAnimationFrame(animate)

      const dt = now - refs.lastFrameTs
      refs.lastFrameTs = now
      if (dt > 0 && dt < 500) {
        refs.fpsSamples.push(1000 / dt)
        if (refs.fpsSamples.length > 30) refs.fpsSamples.shift()
        if (refs.fpsSamples.length === 30 && fpsRef.current) {
          const avg = refs.fpsSamples.reduce((a, b) => a + b, 0) / 30
          fpsRef.current.textContent = `${Math.round(avg)} fps`
          if (!refs.fpsAdapted && refs.voxelMat && useSimStore.getState().playing) {
            refs.fpsAdapted = true
            const measured = Math.floor(refs.voxelMat.leaves.length * avg / 30)
            if (avg < 30) {
              // Too slow — rebuild immediately at a lower budget.
              refs.machineVoxelBudget = Math.max(1000, measured)
              console.log(`[voxel] slow: fps ${Math.round(avg)}, voxels ${refs.voxelMat.leaves.length}, budget ↓ ${refs.machineVoxelBudget}`)
              refs.fpsSamples = []
              rebuildVoxels(refs)
              refs.renderNeeded = true
            } else if (refs.machineVoxelBudget === 0) {
              // First calibration — set from current measurement.
              refs.machineVoxelBudget = measured
              console.log(`[voxel] calibrated: fps ${Math.round(avg)}, voxels ${refs.voxelMat.leaves.length}, budget → ${refs.machineVoxelBudget}`)
            } else if (measured > refs.machineVoxelBudget) {
              // Headroom available — grow budget (capped at 2×) for future jobs.
              refs.machineVoxelBudget = Math.min(refs.machineVoxelBudget * 2, measured)
              console.log(`[voxel] fast: fps ${Math.round(avg)}, voxels ${refs.voxelMat.leaves.length}, budget ↑ ${refs.machineVoxelBudget}`)
            }
          }
        }
      }

      const axVis = showAxesRef.current
      const tpVis = showToolpathsRef.current
      const wpVis = showWorkpieceRef.current
      const shVis = showShapesRef.current
      if (refs.axesHelper.visible     !== axVis) { refs.axesHelper.visible     = axVis; refs.renderNeeded = true }
      if (refs.toolpathGroup.visible  !== tpVis) { refs.toolpathGroup.visible  = tpVis; refs.renderNeeded = true }
      if (refs.workpieceGroup.visible !== wpVis) { refs.workpieceGroup.visible = wpVis; refs.renderNeeded = true }
      if (refs.voxelWoodMesh && refs.voxelWoodMesh.visible !== wpVis) { refs.voxelWoodMesh.visible = wpVis; refs.renderNeeded = true }
      if (refs.voxelCutMesh  && refs.voxelCutMesh.visible  !== wpVis) { refs.voxelCutMesh.visible  = wpVis; refs.renderNeeded = true }
      if (refs.heightfield   && refs.heightfield.group.visible !== wpVis) { refs.heightfield.group.visible = wpVis; refs.renderNeeded = true }
      if (refs.shapesGroup.visible    !== shVis) { refs.shapesGroup.visible    = shVis; refs.renderNeeded = true }

      const sim = useSimStore.getState()

      if (sim.gcode && sim.segments.length > 0) {
        const segIdx = getCurrentSegIdx(sim.segments, sim.elapsedTimeS)
        const pos    = interpolatePos(sim.segments, sim.elapsedTimeS)
        const wp     = useWorkpieceStore.getState()
        const T      = wp.thicknessMM
        const org    = originWorldXY(wp.origin, wp.widthMM, wp.heightMM)
        // Use the offset captured at G-code generation time (not the current workpiece
        // zOrigin) so the tool stays correct even if zOrigin changed without regenerating.
        const zOff   = sim.genZOff

        // Rebuild tool mesh if the current segment uses a different tool type/size
        const activeSeg = sim.segments[segIdx]
        if (activeSeg) {
          const ts = segTool(activeSeg, sim.toolStates)
          let tType = 'flat', tDiam = ts.toolDiameterMM, tAngle = 60
          if (ts.toolVbitHalfAngleTan) {
            tType  = 'vbit'
            tAngle = Math.atan(ts.toolVbitHalfAngleTan) * (180 / Math.PI) * 2
          } else if (ts.toolBallNose) {
            tType = 'ball'
          }
          const key = `${tType}|${tDiam}|${tAngle}`
          if (key !== refs.activeToolKey) {
            buildToolIndicatorForParams(refs, tType, tDiam, tAngle)
            refs.activeToolKey = key
          }
        }

        if (refs.toolMesh) {
          const toolVis = showToolRef.current
          if (refs.toolMesh.visible !== toolVis) { refs.toolMesh.visible = toolVis; refs.renderNeeded = true }
          if (pos && toolVis) {
            const [tx, ty, tz] = cncToThree(pos.x + org.x, pos.y + org.y, pos.z - zOff, T)
            refs.toolMesh.position.set(tx, ty, tz)
            refs.renderNeeded = true
          }
        }

        if (followToolRef.current && pos) {
          const [tx, ty, tz] = cncToThree(pos.x + org.x, pos.y + org.y, pos.z - zOff, T)
          refs.controls.target.set(tx, ty, tz)
        }

        if (refs.heightfield) {
          const seg = sim.segments[segIdx]
          const t = seg && seg.durationS > 1e-9
            ? Math.max(0, Math.min(1, (sim.elapsedTimeS - seg.startTimeS) / seg.durationS))
            : 1
          // Voxel strategy retained but inactive:
          // if (refs.voxelMat) refs.voxelMat.applyUpTo(sim.segments, segIdx, t)
          refs.heightfield.applyUpTo(refs.simSegments, segIdx, t)
        }
      } else {
        if (refs.toolMesh && refs.toolMesh.visible) { refs.toolMesh.visible = false; refs.renderNeeded = true }

        // Voxel strategy retained but inactive:
        // if (refs.voxelMat && (refs.voxelWoodMesh || refs.voxelCutMesh)) {
        //   if (refs.voxelMat.anyCarved) refs.voxelMat.reset()
        // }
        if (refs.heightfield && refs.heightfield.anyCarved) refs.heightfield.reset()
      }

      // Inert while heightfield is active (voxelMat is never built); kept so the
      // voxel path stays wired up for an easy switch back.
      if (refs.voxelMat && refs.voxelWoodMesh && refs.voxelCutMesh) {
        if (syncDirtyInstances(refs.voxelMat, refs.voxelWoodMesh, refs.voxelCutMesh)) refs.renderNeeded = true
      }
      if (refs.heightfield) {
        if (refs.heightfield.flushToGPU()) refs.renderNeeded = true
      }

      controls.update()

      if (refs.renderNeeded) {
        renderer.render(scene, camera)
        refs.renderNeeded = false
      }
    }
    refs.rafId = requestAnimationFrame(animate)

    const unsubWP = useWorkpieceStore.subscribe(() => {
      rebuildWorkpiece(refs)
      fitCamera(refs)
      refs.renderNeeded = true
    })
    const unsubTP = useToolpathStore.subscribe(() => {
      rebuildToolpaths(refs)
      refs.renderNeeded = true
    })
    const unsubSim = useSimStore.subscribe((state, prev) => {
      if (state.gcode !== prev.gcode) {
        refs.fpsAdapted = false
        refs.fpsSamples = []
        rebuildSim(refs)
        buildToolIndicator(refs)
        refs.renderNeeded = true
      }
    })
    const unsubPaths = usePathsStore.subscribe(() => {
      rebuildShapes(refs)
    })

    return () => {
      cancelAnimationFrame(refs.rafId)
      ro.disconnect()
      unsubWP(); unsubTP(); unsubSim(); unsubPaths()
      if (refs.voxelWoodMesh) { refs.voxelWoodMesh.geometry.dispose(); (refs.voxelWoodMesh.material as THREE.Material).dispose() }
      if (refs.voxelCutMesh) { refs.voxelCutMesh.geometry.dispose(); (refs.voxelCutMesh.material as THREE.Material).dispose() }
      if (refs.heightfield) refs.heightfield.dispose()
      if (refs.toolMesh) disposeObject3D(refs.toolMesh)
      for (const entry of refs.stlGeoCache.values()) { entry.geo.dispose(); entry.bakedGeo?.dispose() }
      refs.stlGeoCache.clear()
      renderer.dispose()
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement)
    }
  }, [])

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden">
      <SimulationPlayer />
      <span ref={fpsRef} className="absolute top-2 left-2 text-xs text-neutral-500 pointer-events-none select-none" />

      <div className="absolute top-2 right-2 z-10 flex flex-col gap-1">
        {([
          ['Axes',        showAxes,      setShowAxes],
          ['Toolpaths',   showToolpaths, setShowToolpaths],
          ['Workpiece',   showWorkpiece, setShowWorkpiece],
          ['Tool',        showTool,      setShowTool],
          ['Shapes',      showShapes,    setShowShapes],
          ['Follow Tool', followTool,    setFollowTool],
        ] as [string, boolean, (v: boolean) => void][]).map(([label, val, set]) => (
          <button
            key={label}
            onClick={() => set(!val)}
            className={[
              'px-2 py-0.5 text-xs rounded border transition-colors',
              val
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-neutral-800/80 border-neutral-600 text-neutral-400',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── scene builder helpers ───────────────────────────────────────────────────

// Rounds a raw step to the nearest human-readable value (1, 2, 5, 10, 20, 50…)
function niceStep(raw: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const n = raw / mag
  if (n < 1.5) return mag
  if (n < 3.5) return 2 * mag
  if (n < 7.5) return 5 * mag
  return 10 * mag
}

// Builds a rectangular grid (W×H workpiece, 1 step margin each side) as LineSegments.
// Unlike GridHelper, this is not square so it fits non-square workpieces without
// over-extending in the shorter dimension.
function buildRectGrid(W: number, H: number, step: number): THREE.LineSegments {
  const pts: number[] = []
  const x0 = -step,    x1 = W + step
  const z0 = -(H + step), z1 = step
  for (let z = z0; z <= z1 + step * 1e-6; z += step) {
    pts.push(x0, 0, z,  x1, 0, z)
  }
  for (let x = x0; x <= x1 + step * 1e-6; x += step) {
    pts.push(x, 0, z0,  x, 0, z1)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3))
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x2a2a2a }))
}

function clearGroup(group: THREE.Group) {
  while (group.children.length) {
    const child = group.children[0] as THREE.Mesh
    if (!child.userData.cachedGeo) child.geometry?.dispose()
    if (Array.isArray(child.material)) child.material.forEach(m => m.dispose())
    else (child.material as THREE.Material)?.dispose()
    group.remove(child)
  }
}

function rebuildWorkpiece(refs: SceneRefs) {
  clearGroup(refs.workpieceGroup)

  const wp  = useWorkpieceStore.getState()
  const { widthMM: W, heightMM: H, thicknessMM: T, origin } = wp
  const org = originWorldXY(origin, W, H)

  // Pin the origin gizmo at the chosen Z datum: top surface (Y=T) for top-of-stock,
  // stock bottom (Y=0) for bottom-of-stock.
  refs.axesHelper.position.set(org.x, T - zDatumOffsetMM(wp.zOrigin, T), -org.y)

  refs.scene.remove(refs.gridHelper)
  refs.gridHelper.geometry.dispose()
  ;(refs.gridHelper.material as THREE.Material).dispose()
  const step = niceStep(Math.max(W, H) / 10)
  refs.gridHelper = buildRectGrid(W, H, step)
  refs.gridHelper.position.y = -0.5
  refs.scene.add(refs.gridHelper)

  rebuildSim(refs)
  buildToolIndicator(refs)
}

// Build the simulation material for the active strategy, tearing down the other.
// refs.simStrategy is fixed to 'heightfield' (the toggle was removed); the 'voxel'
// branch is retained so the older path can be re-enabled by changing that field.
function rebuildSim(refs: SceneRefs) {
  if (refs.simStrategy === 'heightfield') {
    disposeVoxels(refs)
    rebuildHeightfield(refs)
  } else {
    disposeHeightfield(refs)
    rebuildVoxels(refs)
  }
}

function disposeVoxels(refs: SceneRefs) {
  if (refs.voxelWoodMesh) {
    refs.scene.remove(refs.voxelWoodMesh)
    refs.voxelWoodMesh.geometry.dispose()
    ;(refs.voxelWoodMesh.material as THREE.Material).dispose()
    refs.voxelWoodMesh = null
  }
  if (refs.voxelCutMesh) {
    refs.scene.remove(refs.voxelCutMesh)
    refs.voxelCutMesh.geometry.dispose()
    ;(refs.voxelCutMesh.material as THREE.Material).dispose()
    refs.voxelCutMesh = null
  }
  refs.voxelMat = null
}

function disposeHeightfield(refs: SceneRefs) {
  if (refs.heightfield) {
    refs.scene.remove(refs.heightfield.group)
    refs.heightfield.dispose()
    refs.heightfield = null
  }
}

function rebuildHeightfield(refs: SceneRefs) {
  disposeHeightfield(refs)

  const wp  = useWorkpieceStore.getState()
  const { widthMM: W, heightMM: H, thicknessMM: T, material, origin, zOrigin } = wp
  const org = originWorldXY(origin, W, H)
  const { segments: rawSegs, toolStates, genZOff } = useSimStore.getState()
  const segments = normalizeSimZ(rawSegs, genZOff)
  refs.simSegments = segments

  const hf = new HeightfieldMaterial(W, H, T, segments, toolStates, org.x, org.y, materialColor(material), SIM_CUT_COLOR_THREE, zOrigin)
  refs.heightfield = hf
  refs.scene.add(hf.group)
  console.log(`[heightfield] built ${hf.topZ.length.toLocaleString()} samples @ ${hf.cellMM.toFixed(3)}mm cell`)
}

function rebuildVoxels(refs: SceneRefs) {
  disposeVoxels(refs)

  const wp  = useWorkpieceStore.getState()
  const { widthMM: W, heightMM: H, thicknessMM: T, material, origin } = wp
  const org = originWorldXY(origin, W, H)

  const { segments: rawSegs, toolStates, genZOff } = useSimStore.getState()
  const segments = normalizeSimZ(rawSegs, genZOff)

  // Target 0.05 mm cells; the budget refinement in VoxelMaterial will scale up
  // if the actual voxel count would exceed 2M.
  const hasAnyCut = segments.some(s => !s.rapid && (s.prevZ < 0 || s.z < 0))
  const minCellMM = hasAnyCut ? 0.01 : Math.min(W, H) / 8
  const voxelBudget = refs.machineVoxelBudget > 0 ? refs.machineVoxelBudget : undefined

  const voxelMat = new VoxelMaterial(W, H, T, segments, toolStates, org.x, org.y, minCellMM, voxelBudget)
  refs.voxelMat  = voxelMat
  const N = voxelMat.leaves.length
  console.log(`[voxel] built ${N.toLocaleString()} voxels @ ${voxelMat.effectiveCellMM.toFixed(3)}mm cell | machine budget: ${refs.machineVoxelBudget > 0 ? refs.machineVoxelBudget.toLocaleString() : 'uncalibrated'}`)

  // Wood mesh: all faces wood — for uncut voxels
  const woodColor = materialColor(material)
  const woodMat   = new THREE.MeshLambertMaterial({ color: woodColor })
  const woodMesh  = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), woodMat, N)
  woodMesh.frustumCulled = false

  // Cut mesh: yellow/gold for carved voxel surfaces
  const yellowMat = new THREE.MeshLambertMaterial({ color: SIM_CUT_COLOR_THREE })
  const cutMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), yellowMat, N)
  cutMesh.frustumCulled = false

  for (const leaf of voxelMat.leaves) {
    _mp.set(leaf.cx, leaf.height / 2, -leaf.cy)
    _ms.set(leaf.cw, leaf.height, leaf.ch)
    _m.compose(_mp, _mr, _ms)
    woodMesh.setMatrixAt(leaf.instanceIdx, _m)
    cutMesh.setMatrixAt(leaf.instanceIdx, _zero)
    leaf.dirty = false
  }
  woodMesh.instanceMatrix.needsUpdate = true
  cutMesh.instanceMatrix.needsUpdate  = true

  refs.voxelWoodMesh = woodMesh
  refs.voxelCutMesh  = cutMesh
  refs.scene.add(woodMesh)
  refs.scene.add(cutMesh)
}

function buildToolIndicatorForParams(refs: SceneRefs, toolType: string, diamMM: number, vbitAngleDeg: number) {
  if (refs.toolMesh) {
    refs.scene.remove(refs.toolMesh)
    disposeObject3D(refs.toolMesh)
    refs.toolMesh = null
  }
  const mesh = buildToolMesh(toolType, diamMM, vbitAngleDeg)
  mesh.visible = false
  refs.scene.add(mesh)
  refs.toolMesh = mesh
}

// Build the tool indicator from the first non-rapid sim segment, or fall back
// to the first tool in the library.
function buildToolIndicator(refs: SceneRefs) {
  refs.activeToolKey = ''

  const { segments, toolStates } = useSimStore.getState()
  let toolType = 'flat', diamMM = 3, vbitAngleDeg = 60

  for (const seg of segments) {
    if (!seg.rapid) {
      const ts = segTool(seg, toolStates)
      diamMM = ts.toolDiameterMM
      if (ts.toolVbitHalfAngleTan) {
        toolType = 'vbit'
        vbitAngleDeg = Math.atan(ts.toolVbitHalfAngleTan) * (180 / Math.PI) * 2
      } else if (ts.toolBallNose) {
        toolType = 'ball'
      }
      break
    }
  }

  if (!segments.length) {
    const t = useToolStore.getState().tools[0]
    if (!t) return
    toolType = t.type
    diamMM   = t.diameterMM
    if (t.type === 'vbit') vbitAngleDeg = (t as any).vbitAngleDeg ?? 60
  }

  buildToolIndicatorForParams(refs, toolType, diamMM, vbitAngleDeg)
}

function rebuildShapes(refs: SceneRefs) {
  clearGroup(refs.shapesGroup)

  const paths = usePathsStore.getState().paths
  const T = useWorkpieceStore.getState().thicknessMM
  const surfaceY = T + 0.15

  // Prune deleted STL paths from the geometry cache
  const stlPathIds = new Set(paths.filter(p => p.stlSrc).map(p => p.id))
  for (const [id, entry] of refs.stlGeoCache) {
    if (!stlPathIds.has(id)) {
      entry.geo.dispose()
      entry.bakedGeo?.dispose()
      refs.stlGeoCache.delete(id)
    }
  }

  for (const path of paths) {
    if (!path.visible) continue

    if (path.stlSrc && path.stlModelBounds) {
      let cached = refs.stlGeoCache.get(path.id)
      if (!cached || cached.stlSrcLen !== path.stlSrc.length) {
        cached?.geo.dispose()
        cached?.bakedGeo?.dispose()
        try {
          const buf = base64ToArrayBuffer(path.stlSrc)
          const geo = parseStlGeometry(buf)
          cached = { geo, stlSrcLen: path.stlSrc.length, bakedGeo: null, bakedKey: '' }
          refs.stlGeoCache.set(path.id, cached)
        } catch {
          continue
        }
      }
      const bakedKey = `${path.d}|${T}`
      if (!cached.bakedGeo || cached.bakedKey !== bakedKey) {
        cached.bakedGeo?.dispose()
        cached.bakedGeo = buildStlGeo(cached.geo, path.stlModelBounds, path.d, T)
        cached.bakedKey = bakedKey
      }
      if (!cached.bakedGeo) continue
      const mesh = new THREE.Mesh(cached.bakedGeo, new THREE.MeshLambertMaterial({
        color: new THREE.Color(path.color),
        side: THREE.DoubleSide,
      }))
      mesh.userData.cachedGeo = true
      refs.shapesGroup.add(mesh)
      continue
    }

    const polylines = flattenPath(path.d, 0.3)
    const lineMat = new THREE.LineBasicMaterial({ color: new THREE.Color(path.color) })
    for (const pts of polylines) {
      if (pts.length < 2) continue
      const positions = new Float32Array(pts.length * 3)
      for (let i = 0; i < pts.length; i++) {
        positions[i * 3]     = pts[i][0]
        positions[i * 3 + 1] = surfaceY
        positions[i * 3 + 2] = -pts[i][1]
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      refs.shapesGroup.add(new THREE.Line(geo, lineMat))
    }
  }

  refs.renderNeeded = true
}

// Bake an STL's raw geometry into Three.js coordinates, scaled to match the
// 2D bounding rect (d string) in CNC space.  Result is cached; only rebuilt
// when path.d or workpiece thickness changes.
// Coordinate mapping: threeX = cncX, threeY = T + cncZ, threeZ = -cncY
function buildStlGeo(
  rawGeo: THREE.BufferGeometry,
  bounds: StlModelBounds,
  d: string,
  T: number,
): THREE.BufferGeometry | null {
  const bbox = getBBox(d)
  if (!bbox) return null

  const modelW = bounds.maxX - bounds.minX
  const modelH = bounds.maxY - bounds.minY
  if (modelW < 0.001 || modelH < 0.001) return null

  const scaleX = bbox.width / modelW
  const scaleY = bbox.height / modelH
  const scaleZ = (scaleX + scaleY) / 2

  const modelCX = (bounds.minX + bounds.maxX) / 2
  const modelCY = (bounds.minY + bounds.maxY) / 2

  const positions = rawGeo.attributes.position
  const count = positions.count
  const newPos = new Float32Array(count * 3)

  for (let i = 0; i < count; i++) {
    const stlX = positions.getX(i)
    const stlY = positions.getY(i)
    const stlZ = positions.getZ(i)
    const cncX = (stlX - modelCX) * scaleX + bbox.cx
    const cncY = (stlY - modelCY) * scaleY + bbox.cy
    const cncZ = (stlZ - bounds.maxZ) * scaleZ
    newPos[i * 3]     = cncX
    newPos[i * 3 + 1] = T + cncZ
    newPos[i * 3 + 2] = -cncY
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(newPos, 3))
  if (rawGeo.index) geo.setIndex(rawGeo.index.clone())
  geo.computeVertexNormals()
  return geo
}

// Expands an arc segment to [x,y,z][] points for 3D display (step every 5°).
// Z is linearly interpolated from pz to ez to correctly show helical descents.
function expandArc3D(
  px: number, py: number, pz: number,
  ex: number, ey: number, ez: number,
  arcCx: number, arcCy: number, cw: boolean,
): [number, number, number][] {
  const r = Math.hypot(px - arcCx, py - arcCy)
  if (r < 0.001) return [[ex, ey, ez]]
  let a0 = Math.atan2(py - arcCy, px - arcCx)
  let a1 = Math.atan2(ey - arcCy, ex - arcCx)
  const isFullCircle = Math.abs(px - ex) < 0.001 && Math.abs(py - ey) < 0.001
  if (isFullCircle) a1 = a0 + (cw ? -2 * Math.PI : 2 * Math.PI)
  else if (cw) { if (a1 >= a0) a1 -= 2 * Math.PI }
  else { if (a1 <= a0) a1 += 2 * Math.PI }
  const steps = Math.max(8, Math.ceil(Math.abs(a1 - a0) / (5 * Math.PI / 180)))
  const pts: [number, number, number][] = []
  for (let k = 1; k <= steps; k++) {
    const t = k / steps
    const a = a0 + (a1 - a0) * t
    pts.push([arcCx + r * Math.cos(a), arcCy + r * Math.sin(a), pz + (ez - pz) * t])
  }
  return pts
}

function rebuildToolpaths(refs: SceneRefs) {
  clearGroup(refs.toolpathGroup)

  const ops = useToolpathStore.getState().operations
  const wp  = useWorkpieceStore.getState()
  const T   = wp.thicknessMM

  for (const op of ops) {
    if (!op.visible || op.segments.length < 2) continue

    const points: number[] = []
    for (let i = 1; i < op.segments.length; i++) {
      const p = op.segments[i - 1]
      const c = op.segments[i]

      if (c.arc) {
        const arcPts = expandArc3D(p.x, p.y, p.z, c.x, c.y, c.z, c.arc.cx, c.arc.cy, c.arc.cw)
        let lpx = p.x, lpy = p.y, lpz = p.z
        for (const [ax, ay, az] of arcPts) {
          const [fx, fy, fz] = cncToThree(lpx, lpy, lpz, T)
          const [tx, ty, tz] = cncToThree(ax, ay, az, T)
          points.push(fx, fy, fz, tx, ty, tz)
          lpx = ax; lpy = ay; lpz = az
        }
      } else {
        const [px, py, pz] = cncToThree(p.x, p.y, p.z, T)
        const [cx, cy, cz] = cncToThree(c.x, c.y, c.z, T)
        points.push(px, py, pz, cx, cy, cz)
      }
    }
    if (points.length === 0) continue

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3))
    const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(op.color) })
    refs.toolpathGroup.add(new THREE.LineSegments(geo, mat))
  }
}

function fitCamera(refs: SceneRefs) {
  const wp = useWorkpieceStore.getState()
  const { widthMM: W, heightMM: H, thicknessMM: T } = wp
  const cx   = W / 2
  const cz   = -H / 2
  const dist = Math.hypot(W, H) * 1.4
  refs.camera.near = dist * 0.001
  refs.camera.far  = dist * 10
  refs.camera.updateProjectionMatrix()
  refs.camera.position.set(cx, dist * 0.55, dist * 0.85)
  refs.camera.lookAt(cx, T / 2, cz)
  refs.controls.target.set(cx, T / 2, cz)
  refs.controls.update()
}
