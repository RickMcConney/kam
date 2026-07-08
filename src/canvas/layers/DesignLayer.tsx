import { useEffect, useState, memo } from 'react'
import { Group, Path, Image as KonvaImage, Text as KonvaText } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { usePathsStore } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import { canvasTheme } from '../../theme'
import type { LiveTransform } from '../types'
import type { ImportedPath } from '../../store/pathsStore'
import { parseD } from '../../importers/svgImporter'
import { getBBox } from '../selectionUtils'
import { parseStlGeometry, base64ToArrayBuffer } from '../../importers/stlImporter'
import { buildHeightMap } from '../../cam/profile3d'

interface Props {
  viewport: Viewport
  liveTransform: LiveTransform | null
  excludePathId?: string | null
}

// Extract geometric properties from a rectangular d string (possibly rotated after baking).
// d must start M p0 L p1 L p2 L p3 (Z). Returns null if the d doesn't look like a rectangle.
function extractRectInfo(d: string): {
  p0: { x: number; y: number } // first corner (conceptual bottom-left when rotation=0)
  widthMM: number               // length of the p0→p1 edge
  heightMM: number              // length of the p1→p2 edge
  rotationDeg: number           // angle of p0→p1 edge, CCW from +X in CNC Y-up
} | null {
  const cmds = parseD(d)
  const pts: { x: number; y: number }[] = []
  for (const cmd of cmds) {
    if (cmd.t === 'M' || cmd.t === 'L') {
      pts.push({ x: cmd.x, y: cmd.y })
      if (pts.length === 4) break
    }
  }
  if (pts.length < 4) return null
  const widthMM = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
  const heightMM = Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y)
  if (widthMM < 0.001 || heightMM < 0.001) return null
  const rotationDeg = (Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * 180) / Math.PI
  return { p0: pts[0], widthMM, heightMM, rotationDeg }
}

// ── Live-transform → Konva node attrs ─────────────────────────────────────────
// Maps an unbaked LiveTransform (drag/resize/rotate/skew in progress) onto the
// Konva node attributes that preview it. Identity attrs when lt is null.

interface LiveNodeAttrs {
  x: number; y: number
  scaleX: number; scaleY: number
  offsetX: number; offsetY: number
  rotation: number
  skewX: number; skewY: number
}

function liveTransformToNodeAttrs(lt: LiveTransform | null): LiveNodeAttrs {
  const a: LiveNodeAttrs = {
    x: 0, y: 0, scaleX: 1, scaleY: 1,
    offsetX: 0, offsetY: 0, rotation: 0, skewX: 0, skewY: 0,
  }
  if (!lt) return a
  if (lt.kind === 'translate') {
    a.x = lt.dx; a.y = lt.dy
  } else if (lt.kind === 'scale') {
    a.offsetX = lt.ax; a.offsetY = lt.ay
    a.x = lt.ax; a.y = lt.ay
    a.scaleX = lt.sx; a.scaleY = lt.sy
  } else if (lt.kind === 'rotate') {
    a.offsetX = lt.cx; a.offsetY = lt.cy
    a.x = lt.cx; a.y = lt.cy
    a.rotation = lt.angle
  } else if (lt.kind === 'skew') {
    a.offsetX = lt.ax; a.offsetY = lt.ay
    a.x = lt.ax; a.y = lt.ay
    a.skewX = lt.kx; a.skewY = lt.ky
  }
  return a
}

// Screen-constant stroke width, compensated during a live scale so the outline
// doesn't fatten/thin with the preview scale.
function liveStrokeWidth(lt: LiveTransform | null, attrs: LiveNodeAttrs, isSelected: boolean, scale: number): number {
  const base = (isSelected ? 2 : 1.5) / scale
  return lt?.kind === 'scale'
    ? base / Math.sqrt(Math.abs(attrs.scaleX * attrs.scaleY))
    : base
}

// ── Single image-backed path ──────────────────────────────────────────────────
// Renders the raster image inside the bounding-box rectangle path.
// Placement proof:
//   - Layer applies scaleY = -viewport.scale (Y-flip)
//   - ImgGroup sits at p0 (the first corner) with the baked rotation applied
//   - FlipGroup (scaleY=-1) cancels the layer's Y-flip so pixels are right-side-up
//   - Image at y = -heightMM means Konva's top-left corner is at y=-h; after
//     FlipGroup that becomes y=+h in outer-local-space → maps to p3 (top-left corner) ✓
//   - Image at y = 0 maps to p0 (bottom-left corner) ✓

interface ImagePathProps {
  p: ImportedPath
  isSelected: boolean
  liveTransform: LiveTransform | null
  scale: number
  darkMode: boolean
}

const ImagePath = memo(function ImagePath({
  p, isSelected, liveTransform, scale, darkMode,
}: ImagePathProps) {
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null)
  const C = canvasTheme(darkMode)

  useEffect(() => {
    const img = new window.Image()
    img.onload = () => setImgEl(img)
    img.src = p.imageSrc!
    return () => { img.onload = null }
  }, [p.imageSrc])

  const lt = liveTransform?.pathIds.has(p.id) ? liveTransform : null
  const attrs = liveTransformToNodeAttrs(lt)
  const strokeWidth = liveStrokeWidth(lt, attrs, isSelected, scale)

  const rect = extractRectInfo(p.d)

  return (
    <Group {...attrs} listening={false}>
      {/* Image: sits at p0, rotated along the first edge, Y-un-flipped */}
      {imgEl && rect && (
        <Group x={rect.p0.x} y={rect.p0.y} rotation={rect.rotationDeg} listening={false}>
          <Group scaleY={-1}>
            <KonvaImage
              image={imgEl}
              x={0}
              y={-rect.heightMM}
              width={rect.widthMM}
              height={rect.heightMM}
              opacity={0.75}
            />
          </Group>
        </Group>
      )}
      {/* Dashed bounding-box outline */}
      <Path
        data={p.d}
        stroke={isSelected ? C.path.selected : p.color}
        strokeWidth={strokeWidth}
        dash={[6 / scale, 4 / scale]}
        listening={false}
      />
    </Group>
  )
})

// ── STL bounding-box path ─────────────────────────────────────────────────────

interface StlPathProps {
  p: ImportedPath
  isSelected: boolean
  liveTransform: LiveTransform | null
  scale: number
  darkMode: boolean
}

const HM_SIZE = 256

function buildHeightMapCanvas(p: ImportedPath): HTMLCanvasElement | null {
  if (!p.stlSrc || !p.stlModelBounds) return null
  const bbox = getBBox(p.d)
  if (!bbox) return null

  const buf = base64ToArrayBuffer(p.stlSrc)
  const geo = parseStlGeometry(buf)
  const positions = new Float32Array(geo.attributes.position.array)
  const indices = geo.index ? new Uint32Array(geo.index.array) : null
  geo.dispose()

  const grid = buildHeightMap(positions, indices, p.stlModelBounds, bbox, HM_SIZE, HM_SIZE)

  let minZ = 0
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== -Infinity && grid[i] < minZ) minZ = grid[i]
  }
  const range = Math.abs(minZ) || 1

  const canvas = document.createElement('canvas')
  canvas.width = HM_SIZE
  canvas.height = HM_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const imgData = ctx.createImageData(HM_SIZE, HM_SIZE)

  for (let iy = 0; iy < HM_SIZE; iy++) {
    const gridIy = HM_SIZE - 1 - iy  // flip Y: canvas top = CNC maxY
    for (let ix = 0; ix < HM_SIZE; ix++) {
      const h = grid[gridIy * HM_SIZE + ix]
      const pi = (iy * HM_SIZE + ix) * 4
      if (h === -Infinity) {
        imgData.data[pi + 3] = 0  // transparent outside model footprint
      } else {
        const t = (h - minZ) / range  // 0 = deepest, 1 = surface
        imgData.data[pi]     = Math.round(30  + t * 190)  // R 30→220
        imgData.data[pi + 1] = Math.round(20  + t * 140)  // G 20→160
        imgData.data[pi + 2] = Math.round(10  + t * 70)   // B 10→80
        imgData.data[pi + 3] = 230
      }
    }
  }
  ctx.putImageData(imgData, 0, 0)
  return canvas
}

const StlPath = memo(function StlPath({ p, isSelected, liveTransform, scale, darkMode }: StlPathProps) {
  const C = canvasTheme(darkMode)
  const lt = liveTransform?.pathIds.has(p.id) ? liveTransform : null
  const [hmCanvas, setHmCanvas] = useState<HTMLCanvasElement | null>(null)

  // Build height map on a deferred timer so the first render isn't blocked
  useEffect(() => {
    setHmCanvas(null)
    const timer = setTimeout(() => {
      setHmCanvas(buildHeightMapCanvas(p))
    }, 0)
    return () => clearTimeout(timer)
  }, [p.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const attrs = liveTransformToNodeAttrs(lt)
  const strokeWidth = liveStrokeWidth(lt, attrs, isSelected, scale)

  const rect = extractRectInfo(p.d)
  const labelSize = 10 / scale

  return (
    <Group {...attrs} listening={false}>
      {/* Height map image — same Y-flip placement as ImagePath */}
      {hmCanvas && rect && (
        <Group x={rect.p0.x} y={rect.p0.y} rotation={rect.rotationDeg} listening={false}>
          <Group scaleY={-1}>
            <KonvaImage
              image={hmCanvas}
              x={0}
              y={-rect.heightMM}
              width={rect.widthMM}
              height={rect.heightMM}
              listening={false}
            />
          </Group>
        </Group>
      )}
      {/* Dashed bounding-box outline */}
      <Path
        data={p.d}
        stroke={isSelected ? C.path.selected : p.color}
        strokeWidth={strokeWidth}
        dash={[6 / scale, 4 / scale]}
        listening={false}
      />
      {/* "STL" label in un-flipped space */}
      {rect && (
        <Group x={rect.p0.x} y={rect.p0.y} rotation={rect.rotationDeg} listening={false}>
          <Group scaleY={-1}>
            <KonvaText
              text="STL"
              x={4 / scale}
              y={4 / scale}
              fontSize={labelSize}
              fill={isSelected ? C.path.selected : p.color}
              opacity={0.8}
              listening={false}
            />
          </Group>
        </Group>
      )}
    </Group>
  )
})

// ── Main layer ────────────────────────────────────────────────────────────────
export function DesignLayer({ viewport, liveTransform, excludePathId }: Props) {
  // Individual selectors — whole-store destructuring re-rendered this layer on
  // every store change, including pure undo-stack pushes (tofix.md H3).
  const paths = usePathsStore((s) => s.paths)
  const selectedIds = usePathsStore((s) => s.selectedIds)
  const darkMode = useUIStore((s) => s.darkMode)
  const C = canvasTheme(darkMode)
  const { scale } = viewport

  return (
    <Group listening={false}>
      {paths.filter((p) => p.visible && !p.hidden && p.id !== excludePathId).map((p) => {
        const isSelected = selectedIds.includes(p.id)

        // Image-backed paths get special rendering
        if (p.imageSrc) {
          return (
            <ImagePath
              key={p.id}
              p={p}
              isSelected={isSelected}
              liveTransform={liveTransform}
              scale={scale}
              darkMode={darkMode}
            />
          )
        }

        // STL-backed paths: dashed bounding box + label
        if (p.stlSrc) {
          return (
            <StlPath
              key={p.id}
              p={p}
              isSelected={isSelected}
              liveTransform={liveTransform}
              scale={scale}
              darkMode={darkMode}
            />
          )
        }

        // Normal vector path
        const lt = liveTransform && liveTransform.pathIds.has(p.id) ? liveTransform : null
        const attrs = liveTransformToNodeAttrs(lt)
        const strokeWidth = liveStrokeWidth(lt, attrs, isSelected, scale)

        return (
          <Path
            key={p.id}
            data={p.d}
            stroke={isSelected ? C.path.selected : p.color}
            strokeWidth={strokeWidth}
            listening={false}
            {...attrs}
          />
        )
      })}
    </Group>
  )
}
