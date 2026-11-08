import { DurableObject } from 'cloudflare:workers'
import { RenderCapacity, renderQueue } from './render-queue.ts'

const serially = renderQueue(16)
interface Reader { read(path: string): Promise<unknown[]> }
interface StreamHooks {
  onHead?: (info: { status: number; gone: boolean }) => void
  onChunk?: (chunk: string) => void
}
type Render = (request: Request, reader: Reader, stream?: StreamHooks) => Promise<{ html: string; status: number }>

export function renderTask(render: Render, request: Request, revision: string, reader: Reader, version = '') {
  let resolveResponse!: (response: Response) => void
  let rejectResponse!: (error: unknown) => void
  let resolveRendered!: () => void
  let rejectRendered!: (error: unknown) => void
  const response = new Promise<Response>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject })
  const rendered = new Promise<void>((resolve, reject) => { resolveRendered = resolve; rejectRendered = reject })
  // The snapshot and transport have independent consumers and can fail before either attaches.
  response.catch(() => {})
  rendered.catch(() => {})
  const finished = (async () => {
    let settledResponse = false
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        settledResponse = true
        resolveResponse(new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } }))
        resolveRendered()
        return
      }
      const encoder = new TextEncoder()
      const identity = JSON.stringify([version, revision, request.url, request.headers.get('accept-language') ?? ''])
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(identity)))
      const etag = '"' + [...hash].map(b => b.toString(16).padStart(2, '0')).join('') + '"'
      const headersFor = (status: number) => ({
        'content-type': 'text/html; charset=utf-8',
        'cache-control': status === 200 ? 'public, no-cache, must-revalidate' : 'no-store',
        vary: 'Accept-Language',
        etag, 'x-data-revision': revision, 'x-render-source': 'rendered',
      })
      const matches = request.headers.get('if-none-match')?.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag)
      if (request.method === 'HEAD') {
        const result = await serially(() => render(request, reader))
        const headers = headersFor(result.status)
        settledResponse = true
        resolveResponse(new Response(null, { status: result.status === 200 && matches ? 304 : result.status, headers }))
        resolveRendered()
        return
      }
      const stream = new TransformStream<Uint8Array, Uint8Array>()
      writer = stream.writable.getWriter()
      const output = writer
      let notModified = false
      let streamFailed = false
      let streamed = false
      let writeChain: Promise<unknown> = Promise.resolve()
      const writeChunk = (bytes: Uint8Array) => {
        if (notModified || streamFailed) return
        writeChain = writeChain.then(() => {
          if (notModified || streamFailed) return
          return output.write(bytes).catch(() => { streamFailed = true })
        })
      }
      const result = await serially(() => render(request, reader, {
        onHead: ({ status }) => {
          if (settledResponse) return
          settledResponse = true
          const headers = headersFor(status)
          if (status === 200 && matches) {
            notModified = true
            output.close().catch(() => {})
            resolveResponse(new Response(null, { status: 304, headers }))
            return
          }
          resolveResponse(new Response(stream.readable, { status, headers }))
        },
        onChunk: chunk => {
          streamed = true
          writeChunk(encoder.encode(chunk))
        },
      }))
      resolveRendered()
      if (!settledResponse) {
        settledResponse = true
        output.close().catch(() => {})
        const headers = headersFor(result.status)
        resolveResponse(result.status === 200 && matches
          ? new Response(null, { status: 304, headers })
          : new Response(result.html, { status: result.status, headers }))
        return
      }
      if (notModified || streamFailed) return
      if (!streamed) writeChunk(encoder.encode(result.html))
      await writeChain
      await output.close().catch(() => {})
    } catch (error) {
      writer?.abort(error).catch(() => {})
      if (!settledResponse && error instanceof RenderCapacity) {
        settledResponse = true
        resolveResponse(new Response(request.method === 'HEAD' ? null : 'render queue full\n', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' } }))
        resolveRendered()
        return
      }
      rejectRendered(error)
      if (!settledResponse) rejectResponse(error)
      throw error
    }
  })()
  finished.catch(() => {})
  return { response, rendered, finished }
}

export function renderObject(render: Render, version = '') {
  return class Renderer extends DurableObject {
    render(request: Request, revision: string, reader: Reader & Disposable & { dup(): Reader & Disposable }): Promise<Response> {
      // The RPC returns at the head; its reader must outlive that call until all nested reads finish.
      // The object frees the snapshot once every stub is gone, and the call's own stub is not
      // released with the call when the answer still streams.
      const retained = reader.dup()
      reader[Symbol.dispose]()
      const task = renderTask(render, request, revision, retained, version)
      const release = () => retained[Symbol.dispose]()
      const released = task.rendered.then(release, release)
      this.ctx?.waitUntil?.(Promise.all([released, task.finished]))
      return task.response
    }
  }
}
