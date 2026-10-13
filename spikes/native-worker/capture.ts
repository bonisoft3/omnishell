import { parseHTML } from 'npm:linkedom@0.18.4';
import { inhabit } from '../../server/render.ts';
import { controlProperties } from '../../server/linkedom-controls.ts';

const [publicDir, out] = Deno.args;
if (!publicDir || !out) throw new Error('capture.ts <release-public-directory> <output-directory>');
const origin = 'https://golaberto.davi-d2c.workers.dev';
const pathname = '/equipe-campeonato/flamengo-rj/brazil-campeonato-brasileiro-2026';
await Deno.mkdir(out, { recursive: true });
inhabit(origin, error => { throw error; });
await import('../../interpreter/vendor/ses.umd.min.js');
const { ensureSes } = await import('../../interpreter/jessie.js');
await ensureSes();
const { renderDocument } = await import('../../interpreter/document.js');
const { routeAt } = await import('../../interpreter/fragment.js');
const { createStore } = await import('../../interpreter/data-sync.js');
const { compileCatalog } = await import('../../interpreter/vendor/messages.js');
const { templateHash } = await import('../../interpreter/screen.js');
const nativeFetch = globalThis.fetch;
const assets: Record<string, string> = {};
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === origin && /^\/(shell|omnishell|messages)\//.test(url.pathname)) {
    const text = await Deno.readTextFile(publicDir + decodeURIComponent(url.pathname));
    assets[url.pathname] = text;
    return new Response(text);
  }
  if (url.origin !== origin) throw new Error(`unexpected origin: ${url.origin}`);
  const response = await nativeFetch(input, init);
  if (response.status >= 400 && response.status !== 409) throw new Error(`${response.status}: ${url.pathname}: ${await response.text()}`);
  return response;
};
const cfg = JSON.parse(await Deno.readTextFile(publicDir + '/shell/shell.json'));
const session = await (await fetch(origin + '/auth/guest', { method: 'POST' })).json();
sessionStorage.setItem('pronto-token', JSON.stringify(session));
const store = createStore(origin, { ...cfg, appBase: new URL(origin + '/') });
const queries: Record<string, unknown> = {};
const recorded = new Proxy(store, { get(target, key, receiver) {
  if (key !== 'query') return Reflect.get(target, key, receiver);
  return async (...args: unknown[]) => {
    const rows = await target.query(...args);
    queries[JSON.stringify(args)] = structuredClone(rows);
    return rows;
  };
}});
const tag = cfg.i18n.default;
const catalogue = await Deno.readTextFile(publicDir + `/messages/${tag}.json`);
const entry = await Deno.readTextFile(new URL('../../../../apps/golaberto/shell/index.html', import.meta.url));
const found = routeAt(cfg, pathname, '', [tag]);
const started = performance.now();
const result = await renderDocument({ entry, parse: html => {
  const { document } = parseHTML(html);
  controlProperties(document);
  return document;
}, cfg, appBase: new URL(origin + '/'), ...found, store: recorded,
  messages: { [tag]: compileCatalog(JSON.parse(catalogue)) }, words: { [tag]: templateHash(catalogue) },
  rows: true, origin, here: pathname,
});
result.handle.stop();
await Deno.writeTextFile(out + '/reference.html', result.html);
await Deno.writeTextFile(out + '/fixture.json', JSON.stringify({ origin, pathname, entry, cfg, found, tag, catalogue, assets, queries }));
console.log(JSON.stringify({ elapsedMs: performance.now() - started, queries: Object.keys(queries).length, bytes: result.html.length, gone: result.gone }));
Deno.exit(0);
