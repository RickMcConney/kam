// Everything the clock designer says about a clock, as data.
//
// Same move as the escapement's (see readout.ts): the numbers were a full page of
// the app's smallest type inside a 320 px sidebar, above the very controls being
// stepped — and they pushed the Add/Update button off the bottom of the tab. They
// are built once here, shown at body size in a floating window, and stood for in
// the sidebar by one button carrying the worst tone.

import {
  clockPlate, clockWheelClashes, designClock, TRAIN_WHEELS,
  type ClockAssembly, type ClockBase, type ClockSpec,
} from '../shapes/clockTrain'
import { gearDims, pinionDims } from '../shapes/gearGenerator'
import { escapementDims } from '../shapes/escapementGenerator'
import { pendulumDims } from '../shapes/pendulumGenerator'
import { worstTone, type ReadoutLine, type Tone } from './readout'

/** Seconds as the interval a clockmaker would say out loud. */
export function fmtPeriod(sec: number): string {
  if (sec < 90) return `${+sec.toFixed(2)} s`
  const min = sec / 60
  if (min < 90) return `${+min.toFixed(2)} min`
  return `${+(min / 60).toFixed(2)} h`
}

/** One row of the parts table: how big a wheel is, and how far to the next arbor. */
export interface ClockPartRow {
  name: string
  counts: string
  size: number
  centre: number
  drives: string
  period: number
}

export interface ClockReadout {
  sections: { title: string; lines: ReadoutLine[] }[]
  rows: ClockPartRow[]
  /** Frame the arrangement needs, if the train could be laid out. */
  frame: { w: number; h: number } | null
  tone: Tone
}

export function clockReadout(
  spec: ClockSpec,
  base: ClockBase,
  stock: { widthMM: number; heightMM: number },
  len: (mm: number) => string,
): ClockReadout {
  const design = designClock(spec, base)
  const { train, drive } = design

  const rows: ClockPartRow[] = design.parts.map((p) => {
    if (p.params.type === 'gear') {
      const g = p.params
      const d = gearDims(g.module, g.teeth, g.pressureAngle, g.backlash, { mateTeeth: g.mateTeeth, pinDia: g.pinDia })
      const pin = pinionDims(g)
      return {
        name: p.name,
        counts: `${g.teeth}t → ${g.mateTeeth} pins`,
        size: d.outsideDia,
        // Every row's spacing is from THIS arbor to the arbor of what it drives:
        // wheel pitch radius + its pinion's, which is where the pitch circles
        // come tangent.
        centre: pin?.centreDistance ?? 0,
        drives: 'to the next arbor',
        period: p.revSeconds,
      }
    }
    if (p.params.type === 'escapement') {
      const dm = escapementDims(p.params)
      return {
        name: p.name,
        counts: `${p.params.teeth}t · spans ${dm.span}`,
        size: p.params.wheelDia,
        centre: dm.centreDistance,
        drives: 'to the pallet arbor',
        period: p.revSeconds,
      }
    }
    // The pendulum is on no arbor — it HANGS from the pallet arbor — so its
    // spacing column is blank rather than a number that would read as one more
    // hole to drill.
    const pd = pendulumDims(p.params)
    return {
      name: p.name,
      counts: `${len(p.params.length)} long`,
      size: pd.rodLength,
      centre: 0,
      drives: 'hangs from the pallet arbor',
      period: p.revSeconds,
    }
  })

  const escPart = design.parts.find((p) => p.params.type === 'escapement')
  const escDims = escPart?.params.type === 'escapement' ? escapementDims(escPart.params) : null
  const pendPart = design.parts.find((p) => p.params.type === 'pendulum')
  const pendLength = pendPart?.params.type === 'pendulum' ? pendPart.params.length : 0
  const biggest = Math.max(...rows.map((r) => r.size))

  // The frame this arrangement needs — the TRAIN's extent, not the whole
  // assembly's: the pendulum is a metre long and hangs outside the plate.
  const plate = clockPlate(
    design.parts.filter((p) => p.params.type !== 'pendulum') as ClockAssembly,
    spec.linkAngles,
  )
  const clashes = plate ? clockWheelClashes(plate) : []

  const sections: ClockReadout['sections'] = []
  const section = (title: string) => {
    const lines: ReadoutLine[] = []
    sections.push({ title, lines })
    return (text: string, tone: Tone = 'plain') => lines.push({ text, tone })
  }

  // ── The pendulum, and what it forces ──────────────────────────────────────
  const pend = section('Pendulum')
  pend(`Pendulum ${len(design.pendulumMM)} to the centre of oscillation`)
  pend(`Escape wheel turns once every ${fmtPeriod(design.escRevSeconds)}`)
  if (escDims) pend(`Must swing past ${escDims.minHalfSwingDeg.toFixed(2)}° each way to unlock`)
  // The rod is cut to the length the beat demands; the bob's size and the rod's
  // width are the user's Pendulum defaults, untouched.
  pend(`Rod cut to ${len(pendLength)}, hole to bob centre — regulate by raising the bob.`)
  // The escapement takes the user's Escapement defaults with only its tooth count
  // changed, and that alone can break an otherwise fine escapement — so the fatal
  // readouts are repeated here rather than left to be found on the chip afterwards.
  if (escDims?.divesTooDeep) pend(
    `Pallets dive ${len(escDims.palletDive)} into the teeth and the pair will bind. `
    + 'Deeper teeth or less lock/lift in the Escapement defaults.', 'error')
  if (escDims?.noImpulse) pend(
    `Drop uses up the whole ${escDims.beatDeg.toFixed(2)}° beat at ${spec.escapeTeeth} teeth — no impulse left.`, 'error')
  if (escDims?.noLock) pend(
    'Nothing left for a tooth to lock on — less clearance, or more lock, in the Escapement defaults.', 'error')

  // ── The going train ───────────────────────────────────────────────────────
  const going = section('Going train')
  going(`${TRAIN_WHEELS} wheels, ${train.meshes.length} meshes at ${+train.actualRatio.toFixed(4)}:1`)
  going(`${train.meshes.map((m) => `${m.teeth}/${m.pins}`).join(' · ')} · escape ${spec.escapeTeeth}`)
  if (train.exact) going("Train is exact — the rate is the pendulum's alone.")
  else going(
    `No exact train at these numbers: the hands ${train.errorSecPerDay < 0 ? 'lose' : 'gain'} `
    + `${Math.abs(train.errorSecPerDay).toFixed(1)} s a day, which no regulating will fix. `
    + 'Try a different escape tooth count or minimum pin count.', 'error')

  // ── The weight ────────────────────────────────────────────────────────────
  const weight = section('Weight drive')
  weight(`${drive.teeth}/${drive.pins} onto the great wheel · ${drive.turns.toFixed(1)} turns of cord`)
  weight(`Runs ${drive.runHours.toFixed(1)} h per wind. Wind the cord on a ${len(spec.drumDia)} drum on this arbor.`)
  if (drive.clampedSmall) weight(
    `A ${spec.runHours} h run wants a drive wheel smaller than its own pinion. Held at ${drive.teeth} teeth, `
    + `so it runs ${drive.runHours.toFixed(1)} h — for a shorter run use a fatter drum or less drop.`, 'warn')

  // ── What will be cut ──────────────────────────────────────────────────────
  const parts = section('Parts')
  if (plate) parts(
    `Frame ${len(plate.bbox.maxX - plate.bbox.minX)} × ${len(plate.bbox.maxY - plate.bbox.minY)} as arranged `
    + '— select a wheel and press Arrange linkage to fold the train.')
  parts("The last column is that arbor to the next one — the escapement's is its wheel to the pallet arbor. "
    + 'Parts are laid out CLEAR of each other, never in mesh, so drill the plate from those spacings rather '
    + 'than from the drawing.')
  if (clashes.length > 0) parts(
    `${clashes.length} pair${clashes.length > 1 ? 's' : ''} of non-neighbouring wheels overlap in this `
    + 'arrangement. Neighbours always do (they run at different depths); these have no reason to.', 'warn')
  if (biggest > Math.min(stock.widthMM, stock.heightMM)) parts(
    `The largest part is ${len(biggest)} across on ${len(stock.widthMM)} × ${len(stock.heightMM)} stock — it `
    + 'will overhang. A smaller module, a shorter beat, or bigger stock.', 'warn')
  parts('Wheels take your Gear defaults (bore, hub, spokes, pin Ø, backlash) and the escapement takes your '
    + 'Escapement defaults. Only the counts, module and cycloidal profile come from here — tweak each part '
    + 'afterwards through its own chip.', 'note')
  parts('Select any wheel afterwards and press Animate whole clock to stand the train up at those spacings '
    + 'and run it, and click the Clock chip to come back here and try a different beat on the same clock.', 'note')

  return {
    sections,
    rows,
    frame: plate ? { w: plate.bbox.maxX - plate.bbox.minX, h: plate.bbox.maxY - plate.bbox.minY } : null,
    tone: worstTone(sections.flatMap((s) => s.lines)),
  }
}
