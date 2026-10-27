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
    assert.equal(document.getElementById('pronto-reads'), null)
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

import { FIXTURE_CARRIERS } from '../interpreter/fixture-types.js'
import { stripProgressiveReads, takeProgressiveReads } from '../interpreter/data-sync.js'

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

Deno.test('native SSR streams top-down chunks and progressive prefetch reads before nested regions settle', async () => {
  const keys = ['fetch', 'location', 'sessionStorage', 'CSS', 'requestAnimationFrame', '__mechaClient', '__prontoViews']
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  const cfg = {
    app: 'Team app',
    tables: ['team', 'match'],
    carriers: FIXTURE_CARRIERS,
    schema: {
      team: { fields: [{ name: 'id', type: 'text' }, { name: 'name', type: 'text' }] },
      match: { fields: [{ name: 'id', type: 'text' }, { name: 'team_id', type: 'text' }, { name: 'score', type: 'text' }] },
    },
    routes: [{ path: '/team/:id', screen: 'team', states: ['loading', 'empty', 'populated', 'gone'], nav: { strip: false }, files: { html: 'team.html', css: 'team.css', handlers: [] } }],
  }
  try {
    const render = appRenderer({
      '/shell/shell.json': JSON.stringify(cfg),
      '/index.html': '<html lang="en"><head><style>div > h1 { color: black }</style></head><body><main id="app"></main><script>window.__ok = 1 < 2 && true</script><script type="module" src="./boot.js"></script></body></html>',
      '/team.html': '<section class="screen" data-screen="team"><div data-live="team" data-filter="id=eq.{param.id}" data-empty="Not found"><h1 data-text="{name}"></h1><ul data-live="match" data-filter="team_id=eq.{id}" data-empty="No matches"><template data-item><li class="match-row" data-text="{score}"></li></template></ul></div></section>',
      '/team.css': 'h1 { color: black }',
    }, 'https://app.example')

    let releaseMatches!: (rows: unknown[]) => void
    const matchesGate = new Promise<unknown[]>(resolve => { releaseMatches = resolve })
    const chunks: string[] = []
    const statuses: number[] = []
    const progressiveBatches: Map<string, string>[] = []
    let scanBuf = ''

    const renderPromise = render(
      new Request('https://app.example/team/fla', { headers: { 'X-Pronto-Prefetch': '1' } }),
      {
        async read(path) {
          if (path.startsWith('/team?')) return [{ id: 'fla', name: 'Flamengo' }]
          if (path.startsWith('/match?')) return await matchesGate
          return []
        },
      },
      {
        onHead: ({ status }) => { statuses.push(status) },
        onChunk: chunk => {
          chunks.push(chunk)
          const taken = takeProgressiveReads(scanBuf + chunk)
          scanBuf = taken.rest
          if (taken.reads.size) progressiveBatches.push(taken.reads)
        },
      },
    )

    for (let i = 0; i < 20 && chunks.length === 0; i++) {
      await new Promise(r => setTimeout(r, 5))
    }
    assert.deepEqual(statuses, [200])
    assert.equal(chunks.length >= 1, true, 'head and top-level team region must stream before nested match read resolves')
    const earlyHtml = chunks.join('')
    assert.equal(earlyHtml.includes('div > h1 { color: black }'), true, 'raw style text must not HTML-escape >')
    assert.equal(earlyHtml.includes('>Flamengo</h1>'), true)
    assert.equal(earlyHtml.includes('2x0'), false)
    assert.equal(progressiveBatches.length, 1)
    assert.deepEqual(JSON.parse(progressiveBatches[0].get('/crud/team?select=*&id=eq.fla')!), [{ id: 'fla', name: 'Flamengo' }])

    releaseMatches([{ id: 'm1', team_id: 'fla', score: '2x0' }])
    const final = await renderPromise
    assert.equal(final.status, 200)
    assert.equal(stripProgressiveReads(chunks.join('')), final.html)
    assert.equal(final.html.includes('window.__ok = 1 < 2 && true'), true, 'raw script text must not HTML-escape < or &')
    assert.equal(final.html.includes('2x0'), true)
    assert.equal(progressiveBatches.length, 2)
    assert.deepEqual(JSON.parse(progressiveBatches[1].get('/crud/match?select=*&team_id=eq.fla')!), [{ id: 'm1', team_id: 'fla', score: '2x0' }])

    // A nested h1[data-live] inside a parent data-live region must not deadlock headFlushed.
    const nestedH1Render = appRenderer({
      '/shell/shell.json': JSON.stringify(cfg),
      '/index.html': '<html lang="en"><head></head><body><main id="app"></main><script type="module" src="./boot.js"></script></body></html>',
      '/team.html': '<section class="screen" data-screen="team"><div data-live="team" data-filter="id=eq.{param.id}" data-empty="Not found"><h1 data-live="match" data-filter="team_id=eq.{id}"><template data-item><span data-text="{score}"></span></template></h1></div></section>',
      '/team.css': 'h1 { color: black }',
    }, 'https://app.example')
    const nestedResult = await nestedH1Render(
      new Request('https://app.example/team/fla'),
      {
        async read(path) {
          if (path.startsWith('/team?')) return [{ id: 'fla', name: 'Flamengo' }]
          if (path.startsWith('/match?')) return [{ id: 'm1', team_id: 'fla', score: '2x0' }]
          return []
        },
      },
      { onHead: () => {}, onChunk: () => {} },
    )
    assert.equal(nestedResult.status, 200)
    assert.equal(nestedResult.html.includes('2x0'), true)

    // A 404 render during streaming reports { status: 404, gone: true } to onHead and emits the 404 HTML without #pronto-reads.
    const goneHead: { status: number; gone: boolean }[] = []
    const goneChunks: string[] = []
    const goneResult = await render(
      new Request('https://app.example/team/missing'),
      { async read() { return [] } },
      {
        onHead: info => { goneHead.push(info) },
        onChunk: chunk => { goneChunks.push(chunk) },
      },
    )
    assert.equal(goneResult.status, 404)
    assert.deepEqual(goneHead, [{ status: 404, gone: true }])
    assert.equal(goneChunks.join(''), goneResult.html)
    assert.equal(goneResult.html.includes('id="pronto-reads"'), false)

    // A failed top-level snapshot read during streaming rejects before onHead or onChunk is called.
    let headCalled = false
    let chunkCalled = false
    await assert.rejects(
      () =>
        render(
          new Request('https://app.example/team/fla'),
          {
            async read() {
              throw new Error('database snapshot failed')
            },
          },
          {
            onHead: () => { headCalled = true },
            onChunk: () => { chunkCalled = true },
          },
        ),
      /database snapshot failed/,
    )
    assert.equal(headCalled, false)
    assert.equal(chunkCalled, false)

    // When a nested region's snapshot read fails after the parent region has streamed,
    // streamDocument rejects immediately rather than hanging on _prontoOwnReady.
    await assert.rejects(
      () =>
        render(
          new Request('https://app.example/team/fla'),
          {
            async read(path) {
              if (path.startsWith('/team?')) return [{ id: 'fla', name: 'Flamengo' }]
              throw new Error('nested match read failed')
            },
          },
          { onHead: () => {}, onChunk: () => {} },
        ),
      /nested match read failed/,
    )

    // When a screen has a data-on-mutation fold that writes another region's table,
    // streamDocument holds streaming until derivations settle so the streamed HTML matches final.html.
    const foldCfg = {
      ...cfg,
      routes: [
        {
          path: '/fold',
          screen: 'fold',
          title: 'Fold',
          ssr: 'ssr',
          nav: { strip: false },
          files: {
            html: './fold.html',
            css: './team.css',
            handlers: ['./copy-fold.js'],
          },
        },
      ],
      tables: ['team', 'match'],
      local: { match: 'tab' },
      schema: {
        team: { fields: [{ name: 'id', type: 'string' }, { name: 'name', type: 'string' }] },
        match: { fields: [{ name: 'id', type: 'string' }, { name: 'team_id', type: 'string' }, { name: 'score', type: 'string' }] },
      },
    }
    const foldRender = appRenderer({
      '/shell/shell.json': JSON.stringify(foldCfg),
      '/index.html': '<html lang="en"><head></head><body><main id="app"></main><script type="module" src="./boot.js"></script></body></html>',
      '/fold.html': '<section class="screen" data-screen="fold"><ul data-live="match"><template data-item><li data-text="{score}"></li></template></ul><div data-live="team" data-on-mutation="copy-fold" data-reads="team,match"><template data-item><span data-text="{name}"></span></template></div></section>',
      '/team.css': 'h1 { color: black }',
      '/copy-fold.js': 'const reduce = (state) => state.rows.match.some((r) => r.id === "m-fla") ? { updates: [] } : { updates: state.rows.team.map((r) => ({ op: "put", entity: "match", id: "m-" + r.id, row: { team_id: r.id, score: "folded-" + r.name } })) }; reduce;',
    }, 'https://app.example')
    const foldChunks: string[] = []
    const foldResult = await foldRender(
      new Request('https://app.example/fold'),
      {
        async read(path) {
          if (path.startsWith('/team?')) return [{ id: 'fla', name: 'Flamengo' }]
          return []
        },
      },
      { onHead: () => {}, onChunk: (c) => foldChunks.push(c) },
    )
    assert.equal(foldResult.status, 200)
    assert.equal(foldResult.html.includes('folded-Flamengo'), true)
    assert.equal(foldChunks.join(''), foldResult.html)

    // Role source strings evaluated without pre-compiled factories must not leak module-level `let` state across renders.
    const statefulFoldRender = appRenderer({
      '/shell/shell.json': JSON.stringify(foldCfg),
      '/index.html': '<html lang="en"><head></head><body><main id="app"></main><script type="module" src="./boot.js"></script></body></html>',
      '/fold.html': '<section class="screen" data-screen="fold"><ul data-live="match"><template data-item><li data-text="{score}"></li></template></ul><div data-live="team" data-on-mutation="copy-fold" data-reads="team,match"><template data-item><span data-text="{name}"></span></template></div></section>',
      '/team.css': 'h1 { color: black }',
      '/copy-fold.js': 'let seen = false; const reduce = (state) => { if (seen || state.rows.match.some((r) => r.id === "m-fla")) return { updates: [] }; seen = true; return { updates: state.rows.team.map((r) => ({ op: "put", entity: "match", id: "m-" + r.id, row: { team_id: r.id, score: "once-" + r.name } })) }; }; reduce;',
    }, 'https://app.example')
    const firstStateful = await statefulFoldRender(new Request('https://app.example/fold'), {
      async read(path) { return path.startsWith('/team?') ? [{ id: 'fla', name: 'Flamengo' }] : [] },
    })
    const secondStateful = await statefulFoldRender(new Request('https://app.example/fold'), {
      async read(path) { return path.startsWith('/team?') ? [{ id: 'fla', name: 'Flamengo' }] : [] },
    })
    assert.equal(firstStateful.html.includes('once-Flamengo'), true)
    assert.equal(secondStateful.html.includes('once-Flamengo'), true)

    // Content-addressed #pronto-assets paths resolve against canonical asset keys without duplicating _immutable-* entries in assets.json.
    const immutableRender = appRenderer({
      '/shell/shell.json': JSON.stringify(cfg),
      '/index.html': `<html lang="en"><head></head><body><main id="app"></main><script id="pronto-assets" type="application/json">${JSON.stringify({ imports: { '/team.html': '/_immutable-1234abcd-team.html.txt', '/team.css': '/_immutable-5678ef01-team.css' } })}</script><script type="module" src="./boot.js"></script></body></html>`,
      '/team.html': '<section class="screen" data-screen="team"><div data-live="team" data-filter="id=eq.{param.id}" data-empty="Not found"><h1 data-text="{name}"></h1></div></section>',
      '/team.css': 'h1 { color: black }',
    }, 'https://app.example')
    const immutableResult = await immutableRender(new Request('https://app.example/team/fla'), {
      async read() { return [{ id: 'fla', name: 'Flamengo' }] },
    })
    assert.equal(immutableResult.status, 200)
    assert.equal(immutableResult.html.includes('>Flamengo</h1>'), true)
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
