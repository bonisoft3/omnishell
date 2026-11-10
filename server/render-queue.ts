export class RenderCapacity extends Error {}

/** The interpreter's ambient document is shared by every object in an isolate. */
export function renderQueue(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid render queue limit')
  let running = false
  let closed = false
  const waiting: { run: () => void; reject: (error: Error) => void }[] = []
  function pump() {
    if (running || closed) return
    const next = waiting.shift()
    if (!next) return
    running = true
    next.run()
  }
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    if (closed) throw new RenderCapacity('render queue reset')
    if (waiting.length + Number(running) >= limit) throw new RenderCapacity('render queue full')
    return new Promise<T>((resolve, reject) => {
      waiting.push({ reject, run: () => {
        Promise.resolve().then(run).then(resolve, reject).finally(() => { running = false; pump() })
      } })
      pump()
    })
  }
  enqueue.close = () => {
    closed = true
    for (const pending of waiting.splice(0)) pending.reject(new RenderCapacity('render queue reset'))
  }
  return enqueue
}
