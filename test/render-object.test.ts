import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

type RenderTask = (render: (request: Request, reader: { read(path: string): Promise<unknown[]> }, stream?: { onHead?: (info: { status: number; gone: boolean }) => void; onChunk?: (chunk: string) => void }) => Promise<{ html: string; status: number }>, request: Request, revision: string, reader: { read(path: string): Promise<unknown[]> }) => { response: Promise<Response>; rendered: Promise<void>; finished: Promise<void> }

async function withRenderer(run: (task: RenderTask) => Promise<void>) {
  const dir = await Deno.makeTempDir()
  try {
    const source = await Deno.readTextFile(new URL('../server/render-object.ts', import.meta.url))
    await Deno.writeTextFile(join(dir, 'render-object.ts'), source.replace(
      "import { DurableObject } from 'cloudflare:workers'",
      'class DurableObject { ctx: { waitUntil?: (p: Promise<unknown>) => void } = {} }',
    ))
    await Deno.copyFile(new URL('../server/render-queue.ts', import.meta.url), join(dir, 'render-queue.ts'))
    const { renderTask } = await import(pathToFileURL(join(dir, 'render-object.ts')).href)
    await run(renderTask)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

Deno.test('snapshot waits for nested reads but not an unconsumed response', () => withRenderer(async renderTask => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const reading = new Promise<void>(resolve => { entered = resolve })
  const task = renderTask(async (_request, reader, stream) => {
    stream?.onHead?.({ status: 200, gone: false })
    stream?.onChunk?.('head')
    await reader.read('nested')
    stream?.onChunk?.('tail')
    return { html: 'headtail', status: 200 }
  }, new Request('https://example.com/'), 'revision', { read: async () => { entered(); await gate; return [] } })
  const response = await task.response
  await reading
  let rendered = false
  task.rendered.then(() => { rendered = true })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(rendered, false)
  release()
  await task.rendered
  let finished = false
  task.finished.then(() => { finished = true })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(finished, false)
  assert.equal(await response.text(), 'headtail')
  await task.finished
}))

Deno.test('a nested read failure rejects render and transport and aborts the response', () => withRenderer(async renderTask => {
  const task = renderTask(async (_request, reader, stream) => {
    stream?.onHead?.({ status: 200, gone: false })
    await reader.read('nested')
    return { html: '', status: 200 }
  }, new Request('https://example.com/'), 'revision', { read: async () => { throw new Error('nested read failed') } })
  const response = await task.response
  await assert.rejects(task.rendered, /nested read failed/)
  await assert.rejects(task.finished, /nested read failed/)
  await assert.rejects(response.text(), /nested read failed/)
}))

Deno.test('a pre-head failure reaches all lifecycle consumers', () => withRenderer(async renderTask => {
  const task = renderTask(async () => { throw new Error('draw failed') }, new Request('https://example.com/'), 'revision', { read: async () => [] })
  await assert.rejects(task.rendered, /draw failed/)
  await assert.rejects(task.response, /draw failed/)
  await assert.rejects(task.finished, /draw failed/)
}))
