// The escapement's readout, as DATA rather than as markup.
//
// It had two copies — one in ShapePanel, one in PropertiesPanel — worded
// slightly differently and going out of step every time the geometry moved. It
// now has three consumers (those two plus the info popup), which is one more than
// a duplicated block survives, so the lines are built once here and rendered by
// whoever wants them.
//
// Each line carries a TONE, and that is what lets the panels shrink to a single
// button: the button takes the colour of the worst line, so the status is visible
// without the text, and the text lives in a window big enough to read it.

import { escapementDims, type EscapementSpec } from '../shapes/escapementGenerator'
import type { ReadoutLine, Tone } from './readout'

// Re-exported so the escapement's three consumers keep one import.
export { worstTone, type Tone, type ReadoutLine } from './readout'

/**
 * Everything the panels say about an escapement, in reading order: what it is,
 * then what is wrong with it.
 *
 * `len` formats a length in the user's units — the caller's, because the two
 * panels format to different precisions and this is not the place to decide that.
 */
export function escapementReadout(spec: EscapementSpec, len: (mm: number) => string): ReadoutLine[] {
  const d = escapementDims(spec)
  const dead = spec.escType === 'deadbeat'
  const out: ReadoutLine[] = []
  const say = (text: string, tone: Tone = 'plain') => out.push({ text, tone })

  // The span is derived from the tooth count, so it is a readout now — and worth
  // one, since it fixes the arbor spacing and the whole shape of the anchor.
  say(`Pallets span ${d.span} teeth`)
  // The hole spacing, named as such. It used to share a line with the PALLET
  // RADIUS — "arbors X apart · pallets Y from the arbor" — which is two lengths
  // and three mentions of an arbor, and the two are often close in value: at the
  // default span β is 90°, so ρ = R·tan45 = R exactly and the pallet radius reads
  // like a repeat of a number already on screen. The pallet radius is gone; this
  // is the one a plate is actually laid out from. `escapementDims` still reports
  // it for the harnesses, which measure with it.
  say(`Wheel centre to anchor arbor ${len(d.centreDistance)}`)
  // NOTHING HERE ECHOES AN INPUT. A readout earns its space by saying what the
  // form cannot: the beat and the wheel's share of the impulse were arithmetic on
  // two fields already on screen, and lift / lock / recoil arc were the fields
  // themselves. `noImpulse` still quotes the beat, which is the one moment that
  // budget is worth seeing — when drop has eaten all of it.
  //
  // The inputs a line does still name are named as the REFERENCE something
  // derived is being measured against (the dive against the tooth depth, the
  // half swing against the lift), which is the opposite of echoing them.
  //
  // Spelt out, or the next question is why half of a 3° lift is not the 1.79°:
  // the drop lock has to be picked before the impulse can start.
  say(`Pendulum must swing past ${d.minHalfSwingDeg.toFixed(2)}° each way — half the lift, plus ${(d.minHalfSwingDeg - spec.lift / 2).toFixed(2)}° to unlock`)
  say(`Impulse faces ${len(d.faceWidth)} long at ${d.impulseAngleDeg.toFixed(0)}°`)
  say(`Pallets dive ${len(d.palletDive)} past the tips, into ${len(spec.toothDepth)} of tooth`)
  // The drop lock first: it is what a tooth actually lands on, and the one that
  // decides whether the escapement is dead at all.
  say(dead
    ? `Lands on ${len(d.dropLockDepth)} of lock, runs to ${len(d.lockDepth)}`
    : `Locks ${len(d.lockDepth)} deep`)
  // Where the tooth leaves the gullet, not at the root circle — the gullet is
  // filled well above that, so a thickness taken there is a thickness of solid
  // wheel. The radius rides along as the tightest inside corner on the part.
  say(`Tooth ${len(d.toothBase)} thick where it leaves a ${len(d.gulletRadius)} gullet — ${len(2 * d.gulletRadius)} cutter max`)
  if (!dead) say(`Recoils ${d.recoilRatio.toFixed(2)}° of wheel per 1° of overswing`)
  // No "drawn clear, set the arbors N apart" line: the centre distance is
  // already stated above, and it said the same thing twice.

  if (d.noImpulse) {
    say(`${spec.drop}° of drop uses up the whole ${d.beatDeg.toFixed(2)}° beat — no impulse left.`, 'error')
  }
  if (d.noLock) {
    say(dead
      ? 'Nothing dead under the landing tooth — it arrives on the impulse face, which does not lock it, and the wheel runs straight through. More lock.'
      : 'A tooth never reaches the recoil face — the wheel will run straight through. More recoil arc.', 'error')
  }
  if (d.divesTooDeep) {
    say(`Pallets dive ${len(d.palletDive)} into ${len(spec.toothDepth)} of tooth — the impulse face reaches the tooth it just locked and the pair will bind. Deeper teeth, or less lock/lift.`, 'error')
  }
  if (d.hubFouls) say('Pallet hub reaches into the wheel — smaller arbor, or more teeth.', 'warn')
  if (d.faceTooSteep) {
    say(`Impulse faces at ${d.impulseAngleDeg.toFixed(0)}° are steep — less lift, or more drop.`, 'warn')
  }
  if (d.hub.grown) say(`Hub grown to ${len(d.hub.dia)} to seat ${spec.spokes} spokes.`, 'note')
  if (spec.spokes >= 2 && !d.hub.spoked) {
    say(d.hub.maxSpokes >= 2
      ? `No room for ${spec.spokes} spokes — this wheel takes ${d.hub.maxSpokes}. Cut solid.`
      : 'No room for a spoke web on this wheel — cut solid.', 'warn')
  }
  return out
}
