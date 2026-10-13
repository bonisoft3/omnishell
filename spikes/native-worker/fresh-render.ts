export type Document = { html: string; status: 200 | 404; etag: string };
export type Revision = string | number;
export type Selection<S> =
	& { revision: Revision }
	& (
		| { document: Document }
		| { snapshot: S }
	);

export interface Authority<S> {
	// Selection and snapshot capture must be one synchronous, consistent read.
	select(key: string): Selection<S>;
	// Publish only if revision is still current; an old request may finish later.
	publish(key: string, revision: Revision, document: Document): void;
}

import { RenderCapacity, renderQueue } from '../../server/render-queue.ts';
export { RenderCapacity, renderQueue };

const etagOf = async (html: string) => {
	const hash = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html)),
	);
	return '"' +
		Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('') +
		'"';
};

export function freshRenderer<S>(
	authority: Authority<S>,
	render: (snapshot: S) => Promise<{ html: string; status: 200 | 404 }>,
	serially: ReturnType<typeof renderQueue>,
	release: string,
) {
	const drawing = new Map<string, Promise<Document>>();
	return async (request: Request, address: string): Promise<Response> => {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response(null, {
				status: 405,
				headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
			});
		}
		const key = JSON.stringify([release, address]);
		const selected = authority.select(key);
		let document: Document;
		let source = 'stored';
		if ('document' in selected) document = selected.document;
		else {
			const flight = JSON.stringify([key, selected.revision]);
			let pending = drawing.get(flight);
			source = pending ? 'joined' : 'rendered';
			if (!pending) {
				try {
					pending = serially(async () => {
						const drawn = await render(selected.snapshot);
						const document = { ...drawn, etag: await etagOf(drawn.html) };
						authority.publish(key, selected.revision, document);
						return document;
					}).finally(() => drawing.delete(flight));
				} catch (error) {
					if (!(error instanceof RenderCapacity)) throw error;
					return new Response('render queue full\n', {
						status: 503,
						headers: {
							'Cache-Control': 'no-store',
							'Retry-After': '1',
						},
					});
				}
				drawing.set(flight, pending);
			}
			document = await pending;
		}
		const headers = {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'public, no-cache, must-revalidate',
			ETag: document.etag,
			'X-Data-Revision': String(selected.revision),
			'X-Render-Source': source,
		};
		const matches = request.headers.get('if-none-match')?.split(',')
			.some((tag) =>
				tag.trim() === '*' || tag.trim().replace(/^W\//, '') === document.etag
			);
		if (document.status === 200 && matches) {
			return new Response(null, { status: 304, headers });
		}
		return new Response(request.method === 'HEAD' ? null : document.html, {
			status: document.status,
			headers,
		});
	};
}
