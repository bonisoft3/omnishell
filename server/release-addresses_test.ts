/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import assert from 'node:assert/strict'
import * as path from 'node:path'
import { parseHTML } from 'npm:linkedom@0.18.4'
import { addressRelease } from './release-addresses.ts'

const cfg = { routes: [{ path: '/regras', files: { html: 'shell/screens/regras.html', css: 'shell/screens/regras.css' } }] }
const files: Record<string, string> = {
  'shell/index.html': '<html><head><base href="/shell/"><link rel="stylesheet" href="./shell.css"></head><body><script type="module" src="./boot.js"></script></body></html>',
  // A document prerendered at generate: it boots after first paint.
  'regras/index.html': `<!-- generated -->\n{{- $o := placeholder "http.vars.origin" -}}\n<!doctype html>\n<html><head><base href="/shell/"><link rel="stylesheet" href="./shell.css"></head><body><script type="module" src="/omnishell/interpreter/deferred-boot.js" data-pronto-boot="./boot.js" data-pronto-preloads='[{"rel":"modulepreload","href":"/omnishell/interpreter/shell.js"},{"rel":"preload","as":"fetch","href":"/shell/screens/regras.html"}]'></script></body></html>`,
  'docs/brief.html': '<html><body><h1>Brief</h1></body></html>',
  'shell/boot.js': 'import "/omnishell/interpreter/shell.js";',
  'shell/shell.css': 'body {}',
  'shell/shell.json': JSON.stringify(cfg),
  'shell/screens/regras.html': '<h1>Regras</h1>',
  'shell/screens/regras.css': 'h1 {}',
  'omnishell/interpreter/shell.js': 'export const shell = true;',
  'omnishell/interpreter/deferred-boot.js': 'export {};',
  'offline-first-sw.js': 'self.addEventListener("fetch", () => {});',
}

async function tree() {
  const out = await Deno.makeTempDir({ prefix: 'release-addresses-' })
  for (const [name, body] of Object.entries(files)) {
    await Deno.mkdir(path.dirname(path.join(out, name)), { recursive: true })
    await Deno.writeTextFile(path.join(out, name), body)
  }
  return out
}

Deno.test('every document that boots the runtime carries the release, a deferred boot included', async () => {
  const out = await tree()
  try {
    const release = await addressRelease(out)
    assert.deepEqual(release.entries, ['regras/index.html', 'shell/index.html'])
    const written = await Deno.readTextFile(path.join(out, 'regras/index.html'))
    // A door's template directive sits before the document, where no parser
    // keeps it, and the door fails the page without it.
    assert.ok(written.startsWith('<!-- generated -->\n{{- $o := placeholder "http.vars.origin" -}}\n<!doctype html>'))
    const { document } = parseHTML(written)
    assert.deepEqual(JSON.parse(document.getElementById('pronto-assets')!.textContent!).imports, release.imports)
    const loader = document.querySelector('script[data-pronto-boot]')!
    assert.equal(loader.getAttribute('src'), release.imports['/omnishell/interpreter/deferred-boot.js'])
    assert.equal(loader.getAttribute('data-pronto-boot'), release.imports['/shell/boot.js'])
    assert.deepEqual(JSON.parse(loader.getAttribute('data-pronto-preloads')!).map((link: { href: string }) => link.href),
      [release.imports['/omnishell/interpreter/shell.js'], release.imports['/shell/screens/regras.html']])
    // Deferred, so nothing is preloaded ahead of first paint.
    assert.equal(document.querySelectorAll('link[rel="modulepreload"]').length, 0)
    // The door's policy names the map it must let run.
    const map = document.getElementById('pronto-assets')!.textContent!
    const hash = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(map)))))
    assert.ok(release.scripts.includes(`'sha256-${hash}'`))
    // A page that boots nothing is a file like any other; templates keep their suffix.
    assert.ok(release.imports['/docs/brief.html'])
    assert.ok(release.imports['/shell/screens/regras.html'].endsWith('-regras.html'))
    assert.equal(release.imports['/offline-first-sw.js'], undefined)
  } finally { await Deno.remove(out, { recursive: true }) }
})
