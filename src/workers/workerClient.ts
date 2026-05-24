import type { WorkerHandlers } from './worker'

let _worker: Worker | null = null
let _nextId = 0
const _pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function getWorker(): Worker {
  if (!_worker) {
    _worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    _worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const { id, result, error } = e.data
      const p = _pending.get(id)
      if (!p) return
      _pending.delete(id)
      if (error !== undefined) p.reject(new Error(error))
      else p.resolve(result)
    }
    _worker.onerror = (ev) => {
      for (const p of _pending.values()) p.reject(new Error(ev.message ?? 'Worker error'))
      _pending.clear()
      _worker = null
    }
  }
  return _worker
}

export function runInWorker<K extends keyof WorkerHandlers>(
  fn: K,
  ...args: Parameters<WorkerHandlers[K]>
): Promise<Awaited<ReturnType<WorkerHandlers[K]>>> {
  return new Promise((resolve, reject) => {
    const id = _nextId++
    _pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    getWorker().postMessage({ id, fn, args })
  })
}
