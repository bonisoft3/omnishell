export class RenderCapacity extends Error {}

/** The interpreter's ambient document is shared by every object in an isolate. */
export function renderQueue(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid render queue limit')
  let turn: Promise<unknown> = Promise.resolve()
  let waiting = 0
  return <T>(run: () => Promise<T>): Promise<T> => {
    if (waiting >= limit) throw new RenderCapacity('render queue full')
    waiting++
    const next = turn.then(run).finally(() => { waiting-- })
    turn = next.then(() => {}, () => {})
    return next
  }
}
