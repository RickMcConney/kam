import { useEffect, useState, memo } from 'react'
import { Group, Path, Image as KonvaImage } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { usePathsStore } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import { canvasTheme } from '../../theme'
import type { LiveTransform } from '../types'
import type { ImportedPath } from '../../store/pathsStore'
import { parseD } from '../../importers/svgImporter'

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

  let nodeX = 0, nodeY = 0, nodeScaleX = 1, nodeScaleY = 1
  let nodeOffsetX = 0, nodeOffsetY = 0, nodeRotation = 0
  if (lt) {
    if (lt.kind === 'translate') {
      nodeX = lt.dx; nodeY = lt.dy
    } else if (lt.kind === 'scale') {
      nodeOffsetX = lt.ax; nodeOffsetY = lt.ay
      nodeX = lt.ax; nodeY = lt.ay
      nodeScaleX = lt.sx; nodeScaleY = lt.sy
    } else if (lt.kind === 'rotate') {
      nodeOffsetX = lt.cx; nodeOffsetY = lt.cy
      nodeX = lt.cx; nodeY = lt.cy
      nodeRotation = lt.angle
    }
  }

  const baseStroke = (isSelected ? 2 : 1.5) / scale
  const strokeWidth = lt?.kind === 'scale'
    ? baseStroke / Math.sqrt(Math.abs(nodeScaleX * nodeScaleY))
    : baseStroke

  const rect = extractRectInfo(p.d)

  return (
    <Group
      x={nodeX} y={nodeY}
      scaleX={nodeScaleX} scaleY={nodeScaleY}
      offsetX={nodeOffsetX} offsetY={nodeOffsetY}
      rotation={nodeRotation}
      listening={false}
    >
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

// ── Main layer ────────────────────────────────────────────────────────────────
export function DesignLayer({ viewport, liveTransform, excludePathId }: Props) {
  const { paths, selectedIds } = usePathsStore()
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

        // Normal vector path
        const lt = liveTransform && liveTransform.pathIds.has(p.id) ? liveTransform : null

        let nodeX = 0, nodeY = 0
        let nodeScaleX = 1, nodeScaleY = 1
        let nodeOffsetX = 0, nodeOffsetY = 0
        let nodeRotation = 0

        if (lt) {
          if (lt.kind === 'translate') {
            nodeX = lt.dx
            nodeY = lt.dy
          } else if (lt.kind === 'scale') {
            nodeOffsetX = lt.ax
            nodeOffsetY = lt.ay
            nodeX = lt.ax
            nodeY = lt.ay
            nodeScaleX = lt.sx
            nodeScaleY = lt.sy
          } else if (lt.kind === 'rotate') {
            nodeOffsetX = lt.cx
            nodeOffsetY = lt.cy
            nodeX = lt.cx
            nodeY = lt.cy
            nodeRotation = lt.angle
          }
        }

        const baseStroke = (isSelected ? 2 : 1.5) / scale
        const strokeWidth = lt?.kind === 'scale'
          ? baseStroke / Math.sqrt(Math.abs(nodeScaleX * nodeScaleY))
          : baseStroke

        return (
          <Path
            key={p.id}
            data={p.d}
            stroke={isSelected ? C.path.selected : p.color}
            strokeWidth={strokeWidth}
            listening={false}
            x={nodeX}
            y={nodeY}
            scaleX={nodeScaleX}
            scaleY={nodeScaleY}
            offsetX={nodeOffsetX}
            offsetY={nodeOffsetY}
            rotation={nodeRotation}
          />
        )
      })}
    </Group>
  )
}
