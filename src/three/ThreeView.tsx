import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useSimStore } from '../store/simStore'
import { useToolpathStore } from '../store/toolpathStore'
import { useWorkpieceStore, type Material } from '../store/workpieceStore'
import { useToolStore } from '../store/toolStore'
import { getCurrentSegIdx, interpolatePos } from '../sim/gcodeParser'
import { VoxelMaterial } from './VoxelMaterial'
import SimulationPlayer from '../sim/SimulationPlayer'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'

// ─── coordinate mapping ──────────────────────────────────────────────────────
//
// CNC space: X right, Y away-from-viewer (up in 2D canvas), Z up (into material = negative)
// Three.js:  X right, Y up, Z toward viewer
//
// Mapping: threeX = cncX,  threeY = thicknessMM + cncZ,  threeZ = -cncY
//
// Camera at (cx, h, +dist) looking at (cx, T/2, -H/2):
//   screen right = +X = CNC +X  ✓
//   CNC Y=0 (near face) → Three.js Z=0 → appears at bottom  ✓

function cncToThree(x: number, y: number, z: number, T: number): [number, number, number] {
  return [x, T + z, -y]
}

// ─── helpers ────────────────────────────────────────────────────────────────

// Custom axes: red=CNC X (+X), green=CNC Y (Three.js -Z), blue=CNC Z (Three.js +Y)
function buildCNCAxes(size: number): THREE.LineSegments {
  const pos = new Float32Array([
    0, 0, 0,   size, 0,    0,     // X → red
    0, 0, 0,   0,    0,   -size,  // CNC Y → green (Three.js -Z)
    0, 0, 0,   0,    size,  0,    // CNC Z → blue  (Three.js +Y)
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
  const map: Record<Material, number> = {
    pine:     0xd4a86a,
    oak:      0xb5803d,
    maple:    0xe8c98d,
    walnut:   0x6b3d1e,
    cherry:   0x9c4a2e,
    mdf:      0xc8b89a,
    plywood:  0xc9a96a,
    hdpe:     0xe0e0e0,
    aluminum: 0xa8b4b8,
    other:    0xc8c8c8,
  }
  return map[mat] ?? 0xc8c8c8
}

function buildToolMesh(type: string, diamMM: number): THREE.Mesh {
  const r = diamMM / 2
  const length = diamMM * 5
  let geo: THREE.BufferGeometry
  if (type === 'vbit' || type === 'drill') {
    // Cone: tip at Y=0 (cutting point), body extends up to Y=length
    geo = new THREE.ConeGeometry(r, length, 16)
    geo.rotateX(Math.PI)             // flip so tip faces down
    geo.translate(0, length / 2, 0)  // tip at Y=0, base at Y=length
  } else {
    // End mill / ball nose: flat bottom at Y=0, shank extends up to Y=length
    geo = new THREE.CylinderGeometry(r, r, length, 16)
    geo.translate(0, length / 2, 0)  // bottom at Y=0
  }
  const mat = new THREE.MeshPhongMaterial({ color: 0x999999, shininess: 80, transparent: true, opacity: 0.85 })
  return new THREE.Mesh(geo, mat)
}

// ─── voxel sync ──────────────────────────────────────────────────────────────

// Reusable objects to avoid per-frame GC
const _m  = new THREE.Matrix4()
const _mp = new THREE.Vector3()
const _mr = new THREE.Quaternion()
const _ms = new THREE.Vector3()

function syncDirtyInstances(voxelMat: VoxelMaterial, mesh: THREE.InstancedMesh) {
  let updated = false
  for (const leaf of voxelMat.leaves) {
    if (!leaf.dirty) continue
    if (leaf.height < 0.001) {
      _m.makeScale(0, 0, 0)
    } else {
      _mp.set(leaf.cx, leaf.height / 2, -leaf.cy)
      _ms.set(leaf.cw, leaf.height, leaf.ch)
      _m.compose(_mp, _mr, _ms)
    }
    mesh.setMatrixAt(leaf.instanceIdx, _m)
    leaf.dirty = false
    updated = true
  }
  if (updated) mesh.instanceMatrix.needsUpdate = true
}

// ─── scene refs ──────────────────────────────────────────────────────────────

interface SceneRefs {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  workpieceGroup: THREE.Group
  toolpathGroup: THREE.Group
  toolMesh: THREE.Mesh | null
  axesHelper: THREE.Object3D
  gridHelper: THREE.GridHelper
  voxelMesh: THREE.InstancedMesh | null
  voxelMat: VoxelMaterial | null
  rafId: number
  fpsSamples: number[]
  lastFrameTs: number
}

// ─── component ───────────────────────────────────────────────────────────────

export default function ThreeView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<SceneRefs | null>(null)

  const [showAxes, setShowAxes] = useState(true)
  const [showToolpaths, setShowToolpaths] = useState(true)
  const [showWorkpiece, setShowWorkpiece] = useState(true)
  const [showTool, setShowTool] = useState(true)

  const showAxesRef      = useRef(showAxes)
  const showToolpathsRef = useRef(showToolpaths)
  const showWorkpieceRef = useRef(showWorkpiece)
  const showToolRef      = useRef(showTool)
  showAxesRef.current      = showAxes
  showToolpathsRef.current = showToolpaths
  showWorkpieceRef.current = showWorkpiece
  showToolRef.current      = showTool

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // ── renderer ──
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(container.clientWidth, container.clientHeight)
    renderer.setClearColor(0x1a1a1a)
    renderer.shadowMap.enabled = true
    container.appendChild(renderer.domElement)

    // ── scene ──
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1a1a1a)

    // ── lights ──
    scene.add(new THREE.AmbientLight(0xffffff, 0.55))
    const sun = new THREE.DirectionalLight(0xffffff, 1.0)
    sun.position.set(1, 2, 1)
    sun.castShadow = true
    scene.add(sun)
    const fill = new THREE.DirectionalLight(0x88aaff, 0.35)
    fill.position.set(-1, 0.5, -1)
    scene.add(fill)

    // ── camera ──
    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 5000)

    // ── orbit controls ──
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.1
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    }

    // ── groups ──
    const workpieceGroup = new THREE.Group()
    const toolpathGroup  = new THREE.Group()
    scene.add(workpieceGroup)
    scene.add(toolpathGroup)

    // ── axes ──
    const axesHelper = buildCNCAxes(40)
    scene.add(axesHelper)

    // ── grid ──
    const gridHelper = new THREE.GridHelper(600, 60, 0x333333, 0x292929)
    scene.add(gridHelper)

    const refs: SceneRefs = {
      renderer, scene, camera, controls,
      workpieceGroup, toolpathGroup,
      toolMesh: null,
      axesHelper,
      gridHelper,
      voxelMesh: null,
      voxelMat: null,
      rafId: 0,
      fpsSamples: [],
      lastFrameTs: 0,
    }
    sceneRef.current = refs

    rebuildWorkpiece(refs)
    rebuildToolpaths(refs)
    fitCamera(refs)

    // ── resize ──
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth, h = container.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    })
    ro.observe(container)

    // ── RAF loop ──
    function animate(now: number) {
      refs.rafId = requestAnimationFrame(animate)

      const dt = now - refs.lastFrameTs
      refs.lastFrameTs = now
      if (dt > 0 && dt < 500) {
        refs.fpsSamples.push(1000 / dt)
        if (refs.fpsSamples.length > 30) refs.fpsSamples.shift()
      }

      // Visibility
      refs.axesHelper.visible      = showAxesRef.current
      refs.toolpathGroup.visible   = showToolpathsRef.current
      refs.workpieceGroup.visible  = showWorkpieceRef.current
      if (refs.voxelMesh) refs.voxelMesh.visible = showWorkpieceRef.current

      const sim = useSimStore.getState()

      if (sim.gcode && sim.segments.length > 0) {
        const segIdx = getCurrentSegIdx(sim.segments, sim.elapsedTimeS)
        const pos    = interpolatePos(sim.segments, sim.elapsedTimeS)
        const wp     = useWorkpieceStore.getState()
        const T      = wp.thicknessMM
        const org    = originWorldXY(wp.origin, wp.widthMM, wp.heightMM)

        // Tool indicator (MR → WL → Three.js)
        if (refs.toolMesh) {
          refs.toolMesh.visible = showToolRef.current
          if (pos) {
            const [tx, ty, tz] = cncToThree(pos.x + org.x, pos.y + org.y, pos.z, T)
            refs.toolMesh.position.set(tx, ty, tz)
          }
        }

        // Voxel material removal
        if (refs.voxelMat && refs.voxelMesh) {
          const changed = refs.voxelMat.applyUpToSegIdx(sim.segments, segIdx)
          if (changed) syncDirtyInstances(refs.voxelMat, refs.voxelMesh)
        }
      } else {
        if (refs.toolMesh) refs.toolMesh.visible = false

        // Reset voxels when sim is cleared
        if (refs.voxelMat && refs.voxelMesh) {
          const wasNonEmpty = refs.voxelMat.leaves.some(l => l.height < refs.voxelMat!.thicknessMM)
          if (wasNonEmpty) {
            refs.voxelMat.reset()
            syncDirtyInstances(refs.voxelMat, refs.voxelMesh)
          }
        }
      }

      controls.update()
      renderer.render(scene, camera)
    }
    refs.rafId = requestAnimationFrame(animate)

    // ── store subscriptions ──
    const unsubWP = useWorkpieceStore.subscribe(() => {
      rebuildWorkpiece(refs)
      fitCamera(refs)
    })
    const unsubTP = useToolpathStore.subscribe(() => {
      rebuildToolpaths(refs)
    })
    const unsubSim = useSimStore.subscribe((state, prev) => {
      if (state.gcode !== prev.gcode) {
        rebuildVoxels(refs)  // quadtree built from new segments
        const t = useToolStore.getState().tools[0]
        if (t) buildToolIndicator(refs, t.type, t.diameterMM)
      }
    })

    return () => {
      cancelAnimationFrame(refs.rafId)
      ro.disconnect()
      unsubWP(); unsubTP(); unsubSim()
      if (refs.voxelMesh) {
        refs.voxelMesh.geometry.dispose()
        ;(refs.voxelMesh.material as THREE.Material).dispose()
      }
      renderer.dispose()
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement)
    }
  }, [])

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden">
      <SimulationPlayer />

      <div className="absolute top-2 right-2 z-10 flex flex-col gap-1">
        {([
          ['Axes',      showAxes,      setShowAxes],
          ['Toolpaths', showToolpaths, setShowToolpaths],
          ['Workpiece', showWorkpiece, setShowWorkpiece],
          ['Tool',      showTool,      setShowTool],
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

function clearGroup(group: THREE.Group) {
  while (group.children.length) {
    const child = group.children[0] as THREE.Mesh
    child.geometry?.dispose()
    if (Array.isArray(child.material)) child.material.forEach(m => m.dispose())
    else (child.material as THREE.Material)?.dispose()
    group.remove(child)
  }
}

function rebuildWorkpiece(refs: SceneRefs) {
  clearGroup(refs.workpieceGroup)
  if (refs.toolMesh) {
    refs.scene.remove(refs.toolMesh)
    refs.toolMesh.geometry.dispose()
    ;(refs.toolMesh.material as THREE.Material).dispose()
    refs.toolMesh = null
  }

  const wp  = useWorkpieceStore.getState()
  const { widthMM: W, heightMM: H, thicknessMM: T, origin } = wp
  const org = originWorldXY(origin, W, H)

  // Axes at machine zero: Three.js (org.x, T, -org.y)
  refs.axesHelper.position.set(org.x, T, -org.y)
  // Grid at workpiece physical bottom
  refs.gridHelper.position.y = -T

  rebuildVoxels(refs)

  const tool = useToolStore.getState().tools[0]
  if (tool) buildToolIndicator(refs, tool.type, tool.diameterMM)
}

function rebuildVoxels(refs: SceneRefs) {
  // Dispose previous voxel mesh
  if (refs.voxelMesh) {
    refs.scene.remove(refs.voxelMesh)
    refs.voxelMesh.geometry.dispose()
    ;(refs.voxelMesh.material as THREE.Material).dispose()
    refs.voxelMesh = null
  }
  refs.voxelMat = null

  const wp  = useWorkpieceStore.getState()
  const { widthMM: W, heightMM: H, thicknessMM: T, material, origin } = wp
  const org = originWorldXY(origin, W, H)

  const segments = useSimStore.getState().segments

  // Minimum cell = tool_diameter/4, clamped to [0.5, W/8]
  let minDia = Infinity
  for (const seg of segments) {
    if (!seg.rapid && seg.z < 0 && seg.toolDiameterMM < minDia) minDia = seg.toolDiameterMM
  }
  const minCellMM = minDia === Infinity
    ? Math.min(W, H) / 8
    : Math.max(0.25, minDia / 32)  // 1/16 of tool radius

  const voxelMat = new VoxelMaterial(W, H, T, segments, org.x, org.y, minCellMM)
  refs.voxelMat  = voxelMat

  const voxMeshMat = new THREE.MeshPhongMaterial({ color: materialColor(material), shininess: 20 })
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), voxMeshMat, voxelMat.leaves.length)
  mesh.receiveShadow = true

  // Set initial matrices: full-height voxels
  for (const leaf of voxelMat.leaves) {
    _mp.set(leaf.cx, leaf.height / 2, -leaf.cy)
    _ms.set(leaf.cw, leaf.height, leaf.ch)
    _m.compose(_mp, _mr, _ms)
    mesh.setMatrixAt(leaf.instanceIdx, _m)
  }
  mesh.instanceMatrix.needsUpdate = true

  refs.voxelMesh = mesh
  refs.scene.add(mesh)
}

function buildToolIndicator(refs: SceneRefs, toolType: string, diamMM: number) {
  if (refs.toolMesh) {
    refs.scene.remove(refs.toolMesh)
    refs.toolMesh.geometry.dispose()
    ;(refs.toolMesh.material as THREE.Material).dispose()
    refs.toolMesh = null
  }
  const mesh = buildToolMesh(toolType, diamMM)
  mesh.castShadow = true
  mesh.visible = false
  refs.scene.add(mesh)
  refs.toolMesh = mesh
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
      const [px, py, pz] = cncToThree(p.x, p.y, p.z, T)
      const [cx, cy, cz] = cncToThree(c.x, c.y, c.z, T)
      points.push(px, py, pz, cx, cy, cz)
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
  refs.camera.position.set(cx, dist * 0.55, dist * 0.85)
  refs.camera.lookAt(cx, T / 2, cz)
  refs.controls.target.set(cx, T / 2, cz)
  refs.controls.update()
}
