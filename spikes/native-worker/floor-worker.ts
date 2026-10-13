import renderer from './worker.ts';
import { parseHTML } from 'linkedom';
import reference from './.generated/reference.json';
import modes from './floor-modes.json';

// Each mode is an ablation, not a production option. In particular, fixture
// writes already materialized by capture can conceal missing machine work.
const referenceDocument = parseHTML(reference).document;
let turn = Promise.resolve();
export default {
  fetch(request) {
    const mode = new URL(request.url).searchParams.get('mode') ?? 'full';
    if (!Object.hasOwn(modes, mode)) return new Response('unknown floor mode', { status: 400 });
    const next = turn.then(async () => {
      globalThis.__floor = modes[mode].flags;
      const response = mode === 'static' ? new Response(reference)
        : mode === 'serialize-only' ? new Response('<!doctype html>\n' + referenceDocument.documentElement.outerHTML + '\n')
        : await renderer.fetch(request);
      response.headers.set('x-spike-floor-mode', mode);
      response.headers.set('cache-control', 'no-store');
      response.headers.set('content-type', 'text/html; charset=utf-8');
      return response;
    });
    turn = next.then(() => {}, () => {});
    return next;
  },
};
