import { DurableObject } from 'cloudflare:workers';
import { parseHTML } from 'linkedom';
import { renderDocument } from '../../interpreter/document.js';
import { type Document, freshRenderer, renderQueue } from './fresh-render.ts';

const origin = 'https://public-snapshot.test';
const route = {
	screen: 'board',
	path: '/board',
	nav: { label: 'Board' },
	files: { html: 'board.html', css: 'board.css' },
};
const cfg = {
	app: 'Public snapshot',
	tables: ['board', 'note'],
	routes: [route],
};
const entry =
	'<!doctype html><html><head><title>Public snapshot</title></head><body><div id="app"></div><script type="module" src="/boot.js"></script></body></html>';
const markup =
	'<main><section data-live="board" data-filter="id=eq.1" data-singleton><h1 data-text="{title}"></h1></section><section data-live="note"><template data-item><p data-text="{body}"></p></template></section></main>';
const serially = renderQueue(16);
globalThis.location = new URL(origin);
globalThis.CSS = { escape: (value) => value };
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.fetch = async (input) => {
	const url = new URL(String(input));
	if (url.origin !== origin) {
		throw new Error(`unexpected render origin: ${url}`);
	}
	if (url.pathname === '/board.html') return new Response(markup);
	if (url.pathname === '/board.css') return new Response('');
	throw new Error(`unknown render asset: ${url}`);
};

interface Reader {
	read(path: string): Promise<unknown[]>;
}

async function render(reader: Reader) {
	const failures: unknown[] = [];
	const reject = () => {
		throw new Error('public rendering cannot write');
	};
	const store = {
		async query(table, order, opts = {}) {
			const search = new URLSearchParams(opts.filter);
			search.set('select', opts.select ?? '*');
			if (order ?? opts.order) search.set('order', order ?? opts.order);
			try {
				return await reader.read(`/${table}?${search}`);
			} catch (error) {
				// A region may display its read error; such a document must not be retained.
				failures.push(error);
				throw error;
			}
		},
		// The read transaction is immutable for the entire render.
		subscribe() {
			return () => {};
		},
		upsert: reject,
		upsertBy: reject,
		dropWhere: reject,
	};
	const drawn = await renderDocument({
		entry,
		parse: (html) => parseHTML(html).document,
		cfg,
		route,
		appBase: new URL(origin + '/'),
		store,
		messages: {},
		rows: true,
		origin,
		here: '/board',
	});
	drawn.handle.stop();
	if (failures.length) {
		throw new AggregateError(failures, 'public snapshot read failed');
	}
	return { html: drawn.html, status: drawn.gone ? 404 : 200 } as {
		html: string;
		status: 200 | 404;
	};
}

export class DocumentRenderer extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		if (typeof env.RELEASE !== 'string' || !env.RELEASE) {
			throw new Error('RELEASE is required');
		}
		this.ctx.storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, revision TEXT NOT NULL, html TEXT NOT NULL, status INTEGER NOT NULL, etag TEXT NOT NULL)',
		);
	}

	render(request: Request, revision: string, reader: Reader) {
		const sql = this.ctx.storage.sql;
		const handle = freshRenderer<Reader>(
			{
				select: (key) => {
					const [document] = sql.exec(
						'SELECT html, status, etag FROM documents WHERE key = ? AND revision = ?',
						key,
						revision,
					).toArray();
					return document
						? { revision, document: document as Document }
						: { revision, snapshot: reader };
				},
				publish: (key, revision, document) =>
					this.ctx.storage.transactionSync(() => {
						// The database holds its serialized read transaction through this RPC.
						sql.exec('DELETE FROM documents');
						sql.exec(
							'INSERT INTO documents VALUES (?, ?, ?, ?, ?)',
							key,
							revision,
							document.html,
							document.status,
							document.etag,
						);
					}),
			},
			render,
			serially,
			this.env.RELEASE,
		);
		return handle(request, origin + '/board');
	}
}

export default {
	fetch() {
		return new Response(null, { status: 404 });
	},
};
