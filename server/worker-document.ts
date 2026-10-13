import { parseHTML } from 'linkedom'
import { renderDocument } from '../interpreter/document.js'
import { acceptedLanguages, routeAt } from '../interpreter/fragment.js'
import { compileCatalog } from '../interpreter/vendor/messages.js'
import { templateHash } from '../interpreter/screen.js'
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
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0)
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== origin || !Object.hasOwn(assets, url.pathname)) throw new Error(`unknown render asset: ${url}`)
    return new Response(assets[url.pathname])
  }
  const messages: Record<string, ReturnType<typeof compileCatalog>> = {}, words: Record<string, string> = {}
  for (const tag of Object.keys(cfg.i18n?.locales ?? {})) {
    const text = assets[`/messages/${tag}.json`]
    messages[tag] = compileCatalog(JSON.parse(text))
    words[tag] = templateHash(text)
  }
  return async (address: string | Request, reader: { read(path: string): Promise<unknown[]> }) => {
    const url = new URL(typeof address === 'string' ? address : address.url, origin)
    const preferred = typeof address === 'string' ? [] : acceptedLanguages(address.headers.get('accept-language') ?? '')
    const found = routeAt(cfg, url.pathname, url.search, preferred)
    if (!found) throw new Error(`unknown screen: ${url.pathname}`)
    const store = snapshotStore(cfg, appBase, reader)
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
        cfg, appBase, ...found, store, messages, words, rows: true, origin,
        here: url.pathname,
      })
      store.assertHealthy()
      return { html: drawn.html, status: drawn.gone ? 404 : 200 }
    } finally {
      drawn?.handle.stop()
      await store.close()
    }
  }
}
