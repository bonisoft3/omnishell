import { DurableObject } from 'cloudflare:workers'
import { RenderCapacity, renderQueue } from './render-queue.ts'

const serially = renderQueue(16)
interface Reader { read(path: string): Promise<unknown[]> }
interface StreamHooks {
  onHead?: (info: { status: number; gone: boolean }) => void
  onChunk?: (chunk: string) => void
}

export function renderObject(render: (request: Request, reader: Reader, stream?: StreamHooks) => Promise<{ html: string; status: number }>, version = '') {
  return class Renderer extends DurableObject {
    async render(request: Request, revision: string, reader: Reader): Promise<Response> {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
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
        let result
        try {
          result = await serially(() => render(request, reader))
        } catch (error) {
          if (!(error instanceof RenderCapacity)) throw error
          return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' } })
        }
        const headers = headersFor(result.status)
        if (result.status === 200 && matches) return new Response(null, { status: 304, headers })
        return new Response(null, { status: result.status, headers })
      }
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
      const writer = writable.getWriter()
      let resolveResponse!: (res: Response) => void
      let rejectResponse!: (err: unknown) => void
      const responsePromise = new Promise<Response>((resolve, reject) => {
        resolveResponse = resolve
        rejectResponse = reject
      })
      let settledResponse = false
      let notModified = false
      let streamFailed = false
      let writeChain: Promise<unknown> = Promise.resolve()
      const writeChunk = (bytes: Uint8Array) => {
        if (notModified || streamFailed) return
        writeChain = writeChain.then(() => {
          if (notModified || streamFailed) return
          return writer.write(bytes).catch(() => { streamFailed = true })
        })
      }
      const streamTask = (async () => {
        let streamed = false
        const result = await serially(() => render(request, reader, {
          onHead: ({ status }) => {
            if (settledResponse) return
            settledResponse = true
            const headers = headersFor(status)
            if (status === 200 && matches) {
              notModified = true
              writer.close().catch(() => {})
              resolveResponse(new Response(null, { status: 304, headers }))
              return
            }
            resolveResponse(new Response(readable, { status, headers }))
          },
          onChunk: (chunk) => {
            streamed = true
            writeChunk(encoder.encode(chunk))
          },
        }))
        if (!settledResponse) {
          settledResponse = true
          await writer.close().catch(() => {})
          const headers = headersFor(result.status)
          if (result.status === 200 && matches) {
            resolveResponse(new Response(null, { status: 304, headers }))
            return
          }
          resolveResponse(new Response(result.html, { status: result.status, headers }))
          return
        }
        if (notModified || streamFailed) return
        if (!streamed && !(result.status === 200 && matches)) {
          writeChunk(encoder.encode(result.html))
        }
        await writeChain
        await writer.close().catch(() => {})
      })().catch((error) => {
        writer.abort(error).catch(() => {})
        if (!settledResponse) {
          settledResponse = true
          if (error instanceof RenderCapacity) {
            resolveResponse(new Response('render queue full\n', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' } }))
          } else {
            rejectResponse(error)
          }
          return
        }
        throw error
      })
      this.ctx?.waitUntil?.(streamTask)
      return responsePromise
    }
  }
}
