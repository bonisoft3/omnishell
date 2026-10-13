import { DurableObject } from 'cloudflare:workers'
import { RenderCapacity, renderQueue } from './render-queue.ts'

const serially = renderQueue(16)
interface Reader { read(path: string): Promise<unknown[]> }

export function renderObject(render: (request: Request, reader: Reader) => Promise<{ html: string; status: number }>) {
  return class Renderer extends DurableObject {
    async render(request: Request, revision: string, reader: Reader): Promise<Response> {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
      let result
      try {
        result = await serially(() => render(request, reader))
      } catch (error) {
        if (!(error instanceof RenderCapacity)) throw error
        return new Response('render queue full\n', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' } })
      }
      const bytes = new TextEncoder().encode(result.html)
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      const etag = '"' + [...hash].map(b => b.toString(16).padStart(2, '0')).join('') + '"'
      const headers = {
        'content-type': 'text/html; charset=utf-8',
        // SQL can depend on time without a write. Until dependencies cover that,
        // every navigation renders from its current public transaction.
        'cache-control': 'public, no-cache, must-revalidate',
        vary: 'Accept-Language',
        etag, 'x-data-revision': revision, 'x-render-source': 'rendered',
      }
      const matches = request.headers.get('if-none-match')?.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag)
      if (result.status === 200 && matches) return new Response(null, { status: 304, headers })
      return new Response(request.method === 'HEAD' ? null : bytes, { status: result.status, headers })
    }
  }
}
