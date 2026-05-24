import { generateProfile } from '../cam/profile'
import { generatePocket } from '../cam/pocket'
import { generateVCarve } from '../cam/vcarve'
import { generateProfile3d } from '../cam/profile3d'
import { generateInlayFemale, generateInlayMale } from '../cam/inlay'

const handlers = {
  generateProfile,
  generatePocket,
  generateVCarve,
  generateProfile3d,
  generateInlayFemale,
  generateInlayMale,
} as const

export type WorkerHandlers = typeof handlers

self.onmessage = async (e: MessageEvent<{ id: number; fn: keyof WorkerHandlers; args: unknown[] }>) => {
  const { id, fn, args } = e.data
  try {
    const handler = handlers[fn] as (...a: unknown[]) => unknown
    const result = await handler(...args)
    self.postMessage({ id, result })
  } catch (err) {
    self.postMessage({ id, error: String(err) })
  }
}
