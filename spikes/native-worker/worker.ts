import { fixture, renderQueries } from './document.ts';
import { renderQueue } from './fresh-render.ts';

const serially = renderQueue(64);
let requests = 0;
export default {
	fetch() {
		return serially(async () => {
			const started = performance.now();
			const result = await renderQueries(fixture.queries);
			return new Response(result.html, {
				status: result.status,
				headers: {
					'content-type': 'text/html; charset=utf-8',
					'server-timing': `render;dur=${performance.now() - started}`,
					'x-spike-request': String(++requests),
					'cache-control': 'no-store',
				},
			});
		});
	},
};
