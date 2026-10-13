import { extname } from 'node:path';
const [publicDir, keyFile, certFile] = Deno.args;
if (!publicDir || !keyFile || !certFile) throw new Error('preview.ts <public-directory> <TLS-key> <TLS-cert>');
const live = 'https://golaberto.davi-d2c.workers.dev';
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
Deno.serve({ hostname: '127.0.0.1', port: 20220, key: await Deno.readTextFile(keyFile), cert: await Deno.readTextFile(certFile) }, async request => {
  const url = new URL(request.url);
  if (/^\/(auth|crud|electric)(\/|$)/.test(url.pathname)) {
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('accept-encoding', 'identity');
    const response = await fetch(live + url.pathname + url.search, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body });
    const outgoing = new Headers(response.headers);
    for (const name of ['content-length', 'content-encoding', 'transfer-encoding']) outgoing.delete(name);
    return new Response(response.body, { status: response.status, headers: outgoing });
  }
  if (request.headers.get('sec-fetch-mode') === 'navigate') return fetch('http://127.0.0.1:20218/');
  if (decodeURIComponent(url.pathname).split('/').some(part => part === '..')) return new Response('bad path', { status: 400 });
  try {
    return new Response(await Deno.readFile(publicDir + decodeURIComponent(url.pathname)), { headers: { 'content-type': mime[extname(url.pathname)] ?? 'application/octet-stream' } });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return new Response('not found', { status: 404 });
  }
});
