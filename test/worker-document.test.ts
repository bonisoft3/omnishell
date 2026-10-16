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
    assert.equal(document.getElementById('pronto-reads'), null)
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

import { FIXTURE_CARRIERS } from '../interpreter/fixture-types.js'

Deno.test('native SSR embeds snapshot /crud reads in #pronto-reads and omits them on 404', async () => {
  const keys = ['fetch', 'location', 'sessionStorage', 'CSS', 'requestAnimationFrame', '__mechaClient', '__prontoViews']
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  const cfg = {
    app: 'Team app',
    tables: ['team'],
    carriers: FIXTURE_CARRIERS,
    schema: { team: { fields: [{ name: 'id', type: 'text' }, { name: 'name', type: 'text' }] } },
    routes: [{ path: '/team/:id', screen: 'team', states: ['loading', 'empty', 'populated', 'gone'], nav: { strip: false }, files: { html: 'team.html', css: 'team.css', handlers: [] } }],
  }
  try {
    const render = appRenderer({
      '/shell/shell.json': JSON.stringify(cfg),
      '/index.html': '<html lang="en"><head></head><body><main id="app"></main><script type="module" src="./boot.js"></script></body></html>',
      '/team.html': '<section class="screen" data-screen="team"><div data-live="team" data-filter="id=eq.{param.id}" data-empty="Not found"><h1 data-text="{name}"></h1></div></section>',
      '/team.css': 'h1 { color: black }',
    }, 'https://app.example')
    const ok = await render(new Request('https://app.example/team/fla'), {
      async read(path) {
        assert.equal(path, '/team?select=*&id=eq.fla')
        return [{ id: 'fla', name: 'Flamengo' }]
      },
    })
    assert.equal(ok.status, 200)
    const { document } = parseHTML(ok.html)
    assert.equal(document.querySelector('[data-served] h1')?.textContent, 'Flamengo')
    const reads = JSON.parse(document.getElementById('pronto-reads')?.textContent ?? '{}')
    assert.deepEqual(JSON.parse(reads['/crud/team?select=*&id=eq.fla']), [{ id: 'fla', name: 'Flamengo' }])

    const missing = await render(new Request('https://app.example/team/unknown'), {
      async read() { return [] },
    })
    assert.equal(missing.status, 404)
    assert.equal(parseHTML(missing.html).document.getElementById('pronto-reads'), null)
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
