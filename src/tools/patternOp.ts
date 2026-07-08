// Pattern tools: linear grid and circular array.
// Each returns a list of (d, dx, dy, angleDeg) transforms to apply to source paths.

import { translateD, rotateAroundD } from '../canvas/selectionUtils'
import { getBBox } from '../canvas/selectionUtils'

interface LinearPatternParams {
  type: 'linear'
  rows: number
  cols: number
  xSpacingMM: number
  ySpacingMM: number
}

interface CircularPatternParams {
  type: 'circular'
  count: number
  radiusMM: number
  startAngleDeg: number
  endAngleDeg: number  // if == startAngleDeg + 360, full circle
  rotateItems: boolean // whether each item is rotated to face outward
}

export type PatternParams = LinearPatternParams | CircularPatternParams

export interface PatternInstance {
  dx: number
  dy: number
  angleDeg: number  // extra rotation (0 for linear, tangent for circular if rotateItems)
  row?: number
  col?: number
  index?: number
}

// Returns transforms for all pattern instances (including the original at [0]).
// Caller is responsible for applying them to each source path.
export function computePatternInstances(params: PatternParams): PatternInstance[] {
  if (params.type === 'linear') {
    const instances: PatternInstance[] = []
    for (let row = 0; row < params.rows; row++) {
      for (let col = 0; col < params.cols; col++) {
        instances.push({
          dx: col * params.xSpacingMM,
          dy: row * params.ySpacingMM,
          angleDeg: 0,
          row,
          col,
        })
      }
    }
    return instances
  } else {
    // Circular pattern
    const { count, radiusMM, startAngleDeg, endAngleDeg, rotateItems } = params
    if (count <= 0) return []
    const isFullCircle = Math.abs((endAngleDeg - startAngleDeg) % 360) < 0.01 || count === 1
    const instances: PatternInstance[] = []
    const totalAngle = isFullCircle ? 360 : (endAngleDeg - startAngleDeg)
    const step = count > 1 ? totalAngle / count : 0

    for (let i = 0; i < count; i++) {
      const angleDeg = startAngleDeg + i * step
      const rad = angleDeg * Math.PI / 180
      const dx = radiusMM * Math.cos(rad)
      const dy = radiusMM * Math.sin(rad)
      instances.push({
        dx,
        dy,
        angleDeg: rotateItems ? angleDeg : 0,
        index: i,
      })
    }
    return instances
  }
}

// Apply a single PatternInstance transform to a d string.
// For circular patterns with rotation, rotates around the item's center.
export function applyPatternInstance(d: string, inst: PatternInstance): string {
  let result = translateD(d, inst.dx, inst.dy)
  if (inst.angleDeg !== 0) {
    // Find center of translated path and rotate around it
    const bbox = getBBox(result)
    if (bbox) {
      result = rotateAroundD(result, bbox.cx, bbox.cy, inst.angleDeg)
    }
  }
  return result
}
