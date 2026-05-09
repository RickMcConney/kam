import { flattenPath, type Pt2 } from './pathFlattener'
import type { MotionSegment } from '../store/toolpathStore'
import type { Tool } from '../store/toolStore'
import type { PocketParams } from './pocket'

const SAFE_Z = 5.0

function zPasses(depthMM: number, stepDownMM: number): number[] {
    const passes: number[] = []
    const step = Math.abs(stepDownMM)
    let z = -step
    while (z > -depthMM) { passes.push(z); z -= step }
    passes.push(-Math.abs(depthMM))
    return passes
}

/**
 * Checks if a segment defined by (p1, p2) intersects any edge of the shape paths.
 * @param p1 - Start of the test segment [x, y].
 * @param p2 - End of the test segment [x, y].
 * @param paths - Array of closed paths (the shape boundaries).
 */
export function doesSegmentCrossBorder(p1: Pt2, p2: Pt2, paths: Pt2[][]): boolean {
    for (const path of paths) {
        for (let i = 0; i < path.length; i++) {
            const b1 = path[i];
            const b2 = path[(i + 1) % path.length];

            if (segmentsIntersect(p1, p2, b1, b2)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Standard 2D segment intersection using cross products.
 */
function segmentsIntersect(a: Pt2, b: Pt2, c: Pt2, d: Pt2): boolean {
    const det = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
    if (det === 0) return false; // Parallel lines

    const lambda = ((d[1] - c[1]) * (d[0] - a[0]) + (c[0] - d[0]) * (d[1] - a[1])) / det;
    const gamma = ((a[1] - b[1]) * (d[0] - a[0]) + (b[0] - a[0]) * (d[1] - a[1])) / det;

    // Intersection occurs if both lambda and gamma are between 0 and 1
    return (0 < lambda && lambda < 1) && (0 < gamma && gamma < 1);
}

function addContour(pts: Pt2[], z: number, segs: MotionSegment[], boundary: Pt2[]) {
    if (pts.length < 2) return
    const [sx, sy] = pts[0]
    const [ex, ey] = pts[1]

    segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
    segs.push({ x: sx, y: sy, z, rapid: false })
    for (let i = 1; i < pts.length; i++) {
        let a = pts[i-1], b = pts[i]
        if( doesSegmentCrossBorder(a, b, [boundary]) )        {
            segs.push({ x: a[0], y: a[1], z: SAFE_Z, rapid: true })
            segs.push({ x: b[0], y: b[1], z: SAFE_Z, rapid: true })
            segs.push({ x: b[0], y: b[1], z, rapid: false })
        }
        else
        {
            segs.push({ x: b[0], y: b[1], z, rapid: false })
        }

    }
    //segs.push({ x: sx, y: sy, z, rapid: false })
    //segs.push({ x: sx, y: sy, z: SAFE_Z, rapid: true })
}

export function generatePocket(
    boundaryD: string,
    tool: Tool,
    params: PocketParams
): MotionSegment[] {

    const subpaths = flattenPath(boundaryD, 0.05)
    if (subpaths.length === 0) throw new Error('No geometry found in boundary path')
    const boundary = subpaths[0]
    if (boundary.length < 3) throw new Error('Boundary path must be a closed polygon')

    const stepoverMM = tool.diameterMM * (params.stepoverPercent / 100)
    if (stepoverMM < 0.01) throw new Error('Stepover too small')

    const segs: MotionSegment[] = []
    const infill: Pt2[] = generateInfillWithBoundary([boundary], tool.diameterMM, params.stepoverPercent, params.angle)
    const zLevels = zPasses(params.depthMM, params.stepDownMM)
    segs.push({ x: 0, y: 0, z: SAFE_Z, rapid: true })

    for (const zDepth of zLevels) {
        addContour(infill, zDepth, segs, boundary)
    }
    return segs
}
/** 
 * Standard Shoelace formula. 
 * Screen coords (Y-down): Positive = CW, Negative = CCW.
 */
function getArea(path: Pt2[]): number {
    let area = 0;
    for (let i = 0; i < path.length; i++) {
        const p1 = path[i];
        const p2 = path[(i + 1) % path.length];
        area += (p2[0] - p1[0]) * (p2[1] + p1[1]);
    }
    return area;
}

export function generateInfillWithBoundary(
    paths: Pt2[][],
    diameter: number,
    stepover: number,
    angleDeg: number
): Pt2[] {
    const wallClearance = diameter / 2;
    const spacing = diameter * (stepover / 100);
    const angleRad = (angleDeg * Math.PI) / 180;

    // 1. Offset Paths Inward with Miter Compensation
    const offsetPaths: Pt2[][] = paths.map(path => {
        const area = getArea(path);
        const normalized = area > 0 ? path : [...path].reverse(); // Force CW for [dy, -dx] logic

        const offset: Pt2[] = [];
        const len = normalized.length;
        for (let i = 0; i < len; i++) {
            const prev = normalized[(i - 1 + len) % len];
            const curr = normalized[i];
            const next = normalized[(i + 1) % len];

            // Inward normals for Edges
            const dx1 = curr[0] - prev[0], dy1 = curr[1] - prev[1];
            const dx2 = next[0] - curr[0], dy2 = next[1] - curr[1];
            const l1 = Math.hypot(dx1, dy1) || 1;
            const l2 = Math.hypot(dx2, dy2) || 1;

            const n1: Pt2 = [dy1 / l1, -dx1 / l1];
            const n2: Pt2 = [dy2 / l2, -dx2 / l2];

            // Miter vector (average of normals)
            const mx = n1[0] + n2[0];
            const my = n1[1] + n2[1];
            const mLenSq = mx * mx + my * my;

            /**
             * Miter Scale: 1 / cos(half_angle) 
             * This ensures the distance from the point to BOTH edges is exactly wallClearance.
             */
            let miterScale = 2 / mLenSq;
            if (miterScale > 4) miterScale = 4; // Cap spikes on sharp star tips

            offset.push([
                curr[0] + mx * miterScale * wallClearance,
                curr[1] + my * miterScale * wallClearance
            ]);
        }
        return offset;
    });

    // 2. Scanline Generation (Remains same logic, fixed for Pt2 indexing)
    const cosA = Math.cos(-angleRad), sinA = Math.sin(-angleRad);
    const rotated = offsetPaths.map(p => p.map(pt => ({
        x: pt[0] * cosA - pt[1] * sinA,
        y: pt[0] * sinA + pt[1] * cosA
    })));

    const segments: { p1: Pt2, p2: Pt2 }[] = [];
    const flat = rotated.flat();
    if (flat.length === 0) return [];

    const minY = Math.min(...flat.map(p => p.y));
    const maxY = Math.max(...flat.map(p => p.y));
    const cosR = Math.cos(angleRad), sinR = Math.sin(angleRad);

    for (let y = minY + spacing / 2; y <= maxY; y += spacing) {
        let hits: number[] = [];
        for (const poly of rotated) {
            for (let i = 0; i < poly.length; i++) {
                const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
                if ((p1.y <= y && p2.y > y) || (p2.y <= y && p1.y > y)) {
                    hits.push(p1.x + (y - p1.y) * (p2.x - p1.x) / (p2.y - p1.y));
                }
            }
        }
        hits.sort((a, b) => a - b);
        for (let i = 0; i < hits.length; i += 2) {
            if (hits[i + 1] !== undefined) {
                segments.push({
                    p1: [hits[i] * cosR - y * sinR, hits[i] * sinR + y * cosR],
                    p2: [hits[i + 1] * cosR - y * sinR, hits[i + 1] * sinR + y * cosR]
                });
            }
        }
    }

    // 3. Optimization & Final Assembly
    const result: Pt2[] = [];
    let cur: Pt2 = segments[0].p1;

    while (segments.length > 0) {
        let idx = -1, dist = Infinity, rev = false;
        for (let i = 0; i < segments.length; i++) {
            const dS = Math.hypot(segments[i].p1[0] - cur[0], segments[i].p1[1] - cur[1]);
            const dE = Math.hypot(segments[i].p2[0] - cur[0], segments[i].p2[1] - cur[1]);
            if (dS < dist) { dist = dS; idx = i; rev = false; }
            if (dE < dist) { dist = dE; idx = i; rev = true; }
        }
        const seg = segments.splice(idx, 1)[0];
        result.push(rev ? seg.p2 : seg.p1, rev ? seg.p1 : seg.p2);
        cur = result[result.length - 1];
    }

    offsetPaths.forEach(p => {
        p.forEach(pt => result.push(pt));
        if (p.length > 0) result.push(p[0]);
    });

    return result;
}