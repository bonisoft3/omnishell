import assert from 'node:assert/strict'
import { parseHTML } from 'linkedom'
import { appRenderer } from '../server/worker-document.ts'

Deno.test('native SSR renders an app without locale configuration and preserves its declared language', async () => {
  const keys = ['fetch', 'location', 'sessionStorage', 'CSS', 'requestAnimationFrame', '__mechaClient', '__prontoViews']
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  const cfg = {
    app: 'Plain app', tables: [], schema: {},
    routes: [{ path: '/', screen: 'home', nav: { strip: false }, files: { html: 'home.html', css: 'home.css', handlers: [] } }],
  }
  try {
    const render = appRenderer({
      '/shell/shell.json': JSON.stringify(cfg),
      '/index.html': '<html lang="en"><head></head><body><main id="app"></main><script type="module" src="./boot.js"></script></body></html>',
      '/home.html': '<section class="screen" data-screen="home"><h1>Welcome</h1></section>',
      '/home.css': 'h1 { color: black }',
    }, 'https://app.example')
    const result = await render(new Request('https://app.example/', { headers: { 'accept-language': 'pt-BR' } }), {
      read() { throw new Error('a static screen must not read the database') },
    })
    assert.equal(result.status, 200)
    const { document } = parseHTML(result.html)
    assert.equal(document.documentElement.lang, 'en')
    assert.equal(document.querySelector('[data-served] h1')?.textContent, 'Welcome')
    assert.equal(document.querySelector('link[rel="canonical"]')?.getAttribute('href'), 'https://app.example/')
    assert.equal(document.querySelector('meta[name="pronto-words"]'), null)
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
