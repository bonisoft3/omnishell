import { parseHTML } from 'linkedom'
import { carryReads, progressiveReadsComment, servedReadsScript } from '../interpreter/data-sync.js'
import { renderDocument } from '../interpreter/document.js'
import { acceptedLanguages, routeAt } from '../interpreter/fragment.js'
import { compileCatalog } from '../interpreter/vendor/messages.js'
import { controlProperties } from './linkedom-controls.ts'
import { snapshotStore } from './snapshot-store.js'

export function appRenderer(assets: Record<string, string>, origin: string) {
  const cfg = JSON.parse(assets['/shell/shell.json'])
  const appBase = new URL(origin + '/')
  Object.assign(globalThis, {
    location: appBase,
    sessionStorage: Object.freeze({ getItem: () => null }),
    CSS: { escape: (value: string) => value },
  })
  const canonical = new Map<string, string>()
  const assetMap = assets['/index.html']?.match(/<script[^>]*\bid=["']pronto-assets["'][^>]*>([\s\S]*?)<\/script>/i)
  if (assetMap) {
    for (const [k, v] of Object.entries((JSON.parse(assetMap[1]).imports ?? {}) as Record<string, string>)) {
      canonical.set(v, k)
    }
  }
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0)
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const key = Object.hasOwn(assets, url.pathname) ? url.pathname : canonical.get(url.pathname)
    if (url.origin !== origin || !key || !Object.hasOwn(assets, key)) throw new Error(`unknown render asset: ${url}`)
    return new Response(assets[key])
  }
  const messages: Record<string, ReturnType<typeof compileCatalog>> = {}
  for (const tag of Object.keys(cfg.i18n?.locales ?? {})) {
    messages[tag] = compileCatalog(JSON.parse(assets[`/messages/${tag}.json`]))
  }
  return async (
    address: string | Request,
    reader: { read(path: string): Promise<unknown[]> },
    stream?: { onHead?: (info: { status: number; gone: boolean }) => void; onChunk?: (chunk: string) => void },
  ) => {
    const url = new URL(typeof address === 'string' ? address : address.url, origin)
    const preferred = typeof address === 'string' ? [] : acceptedLanguages(address.headers.get('accept-language') ?? '')
    const found = routeAt(cfg, url.pathname, url.search, preferred)
    if (!found) throw new Error(`unknown screen: ${url.pathname}`)
    const prefetch = typeof address !== 'string' && address.headers.get('x-pronto-prefetch') === '1'
    const store = snapshotStore(cfg, appBase, reader)
    const sentReads = new Set<string>()
    const drainNewReads = () => {
      if (!prefetch) return ''
      const delta = new Map<string, string>()
      for (const [k, v] of store.reads) {
        if (!sentReads.has(k)) {
          sentReads.add(k)
          delta.set(k, v)
        }
      }
      return progressiveReadsComment(delta)
    }
    let drawn
    try {
      drawn = await renderDocument({
        entry: assets['/index.html'],
        parse: (html) => {
          const document = parseHTML(html).document
          Object.defineProperty(document, 'baseURI', { value: new URL(document.querySelector('base[href]')?.getAttribute('href') ?? '.', appBase).href })
          controlProperties(document)
          return document
        },
        cfg, appBase, ...found, store, messages, rows: true, origin,
        here: url.pathname,
        ...(stream?.onChunk
          ? {
              onHead: stream.onHead,
              onChunk: (chunk: string, meta?: { beforeBodyClose?: boolean }) => {
                if (meta?.beforeBodyClose) {
                  const comment = drainNewReads()
                  const script = store.reads.size > 0 ? servedReadsScript(store.reads) : ''
                  if (comment || script) stream.onChunk!(comment + script)
                  return
                }
                const out = chunk + drainNewReads()
                if (out) stream.onChunk!(out)
              },
            }
          : {}),
      })
      store.assertHealthy()
      return {
        html: drawn.gone ? drawn.html : carryReads(drawn.html, store.reads, servedReadsScript),
        status: drawn.gone ? 404 : 200,
      }
    } finally {
      drawn?.handle.stop()
      await store.close()
    }
  }
}
