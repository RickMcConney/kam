// Shared CAM geometry helpers. Canonical home for utilities that were once
// duplicated across the per-operation modules (see tofix.md R2). Note:
// adaptiveClearing.ts is deliberately excluded from this consolidation — it is
// a faithful FreeCAD port and must stay byte-for-byte comparable (tofix.md H6).

// Z levels for multi-pass cutting: -step, -2·step, … then exactly -depth.
// Step is clamped to the UI's 0.01 mm minimum so a zero/negative/NaN value
// (hand-edited or corrupted .fkam project) can't loop forever or allocate
// unboundedly (tofix.md B7).
export function zPasses(depthMM: number, stepDownMM: number): number[] {
  const step = Math.max(0.01, Number.isFinite(stepDownMM) ? Math.abs(stepDownMM) : 0)
  const depth = Number.isFinite(depthMM) ? Math.abs(depthMM) : 0
  const passes: number[] = []
  let z = -step
  while (z > -depth) { passes.push(z); z -= step }
  passes.push(-depth)
  return passes
}
