import { describe, it, expect, afterEach } from 'vitest'
import { runInWorkerFor, __setWorkerFactoryForTests } from './workerClient'

// The public signature ties `fn` to a real handler and its argument types; these
// tests only exercise scheduling, so they go through one loosened alias rather
// than constructing valid Tool/params payloads for a handler that never runs.
const run = runInWorkerFor as unknown as
  (opId: string | undefined, fn: string, ...args: unknown[]) => Promise<unknown>

// Covers the pool's SCHEDULING POLICY, not the generation code it runs:
//  - two jobs for the same opId never overlap, and resolve in submission order
//    (the guarantee that stops a slow earlier run overwriting a fresh later one
//     via setSegments — the single-worker client had it for free)
//  - jobs for different opIds run concurrently
// Real Workers aren't available under the node test environment, so a fake
// worker stands in and completion is driven manually.

interface Posted { id: number; fn: string; args: unknown[] }

function makeFakePool() {
  // Every fake worker created, in creation order.
  const workers: {
    posted: Posted[]
    onmessage: ((e: { data: { id: number; result?: unknown; error?: string } }) => void) | null
    onerror: ((e: { message?: string }) => void) | null
    terminated: boolean
  }[] = []

  __setWorkerFactoryForTests(() => {
    const w = {
      posted: [] as Posted[],
      onmessage: null as never,
      onerror: null as never,
      terminated: false,
      postMessage(msg: Posted) { w.posted.push(msg) },
      terminate() { w.terminated = true },
    }
    workers.push(w as never)
    return w as never
  })

  // Every job the pool has dispatched, across all workers.
  const dispatched = () => workers.flatMap((w) => w.posted.map((p) => ({ w, p })))

  // Complete a dispatched job by id.
  const complete = (id: number, result: unknown) => {
    for (const w of workers) {
      if (w.posted.some((p) => p.id === id)) {
        w.onmessage?.({ data: { id, result } })
        return true
      }
    }
    return false
  }

  return { workers, dispatched, complete }
}

afterEach(() => { __setWorkerFactoryForTests(null) })

describe('worker pool scheduling', () => {
  it('runs jobs for different operations concurrently', async () => {
    const pool = makeFakePool()
    const p1 = run('opA', 'gen')
    const p2 = run('opB', 'gen')

    // Both in flight at once — distinct keys don't block each other.
    expect(pool.dispatched()).toHaveLength(2)

    const [d1, d2] = pool.dispatched()
    pool.complete(d2.p.id, 'B')
    pool.complete(d1.p.id, 'A')
    await expect(p1).resolves.toBe('A')
    await expect(p2).resolves.toBe('B')
  })

  it('serializes jobs for the SAME operation and preserves submission order', async () => {
    const pool = makeFakePool()
    const order: string[] = []
    const first = run('opA', 'gen')
      .then((v) => { order.push(v as string) })
    const second = run('opA', 'gen')
      .then((v) => { order.push(v as string) })

    // Only the first is dispatched; the second is held back on the shared key
    // even though the pool has idle capacity.
    expect(pool.dispatched()).toHaveLength(1)

    const firstId = pool.dispatched()[0].p.id
    pool.complete(firstId, 'first')
    await first

    // Finishing the first releases the key and dispatches the second.
    expect(pool.dispatched()).toHaveLength(2)
    const secondId = pool.dispatched().find((d) => d.p.id !== firstId)!.p.id
    pool.complete(secondId, 'second')
    await second

    expect(order).toEqual(['first', 'second'])
  })

  it('does not spawn a worker when every queued job is blocked on an active key', () => {
    const pool = makeFakePool()
    void run('opA', 'gen')
    void run('opA', 'gen')
    void run('opA', 'gen')

    // One worker for the one runnable job — the two blocked jobs must not each
    // cause a thread to be spawned just to sit idle.
    expect(pool.workers).toHaveLength(1)
  })

  it('rejects the in-flight job and drops the slot when a worker errors', async () => {
    const pool = makeFakePool()
    const p = run('opA', 'gen')
    const w = pool.workers[0]
    w.onerror?.({ message: 'boom' })
    await expect(p).rejects.toThrow('boom')
    expect(w.terminated).toBe(true)

    // The key is released, so a resubmission for the same op can run.
    const p2 = run('opA', 'gen')
    const d = pool.dispatched().filter((x) => !x.w.terminated)
    expect(d).toHaveLength(1)
    pool.complete(d[0].p.id, 'ok')
    await expect(p2).resolves.toBe('ok')
  })
})
