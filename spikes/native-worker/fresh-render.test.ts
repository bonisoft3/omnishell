import { deepStrictEqual as equal, rejects, strictEqual } from 'node:assert';
import {
	type Authority,
	type Document,
	freshRenderer,
	renderQueue,
} from './fresh-render.ts';

const req = (headers = {}, method = 'GET') =>
	new Request('https://example.test/page', { method, headers });
const deferred = () => Promise.withResolvers<void>();
function database() {
	let revision = 1;
	let rows = ['one'];
	const documents = new Map<string, { revision: number; document: Document }>();
	let selects = 0;
	const authority: Authority<string[]> = {
		select(key) {
			selects++;
			const saved = documents.get(key);
			return saved?.revision === revision
				? { revision, document: saved.document }
				: { revision, snapshot: structuredClone(rows) };
		},
		publish(key, rendered, document) {
			if (rendered === revision) documents.set(key, { revision, document });
		},
	};
	return {
		authority,
		documents,
		get selects() {
			return selects;
		},
		commit(next: string[]) {
			rows = next;
			revision++;
			documents.clear();
		},
	};
}
const draw = async (rows: string[]) => ({
	html: rows.join(','),
	status: (rows.length ? 200 : 404) as 200 | 404,
});

Deno.test('every hit and conditional response consults authority; insert and delete invalidate', async () => {
	const db = database();
	let renders = 0;
	const handle = freshRenderer(
		db.authority,
		(rows) => {
			renders++;
			return draw(rows);
		},
		renderQueue(4),
		'release',
	);
	const first = await handle(req(), '/page');
	const etag = first.headers.get('etag')!;
	strictEqual(await first.text(), 'one');
	const unchanged = await handle(
		req({ 'if-none-match': `"other", W/${etag}` }),
		'/page',
	);
	strictEqual(unchanged.status, 304);
	strictEqual(renders, 1);
	strictEqual(db.selects, 2);
	db.commit(['two']);
	const changed = await handle(req({ 'if-none-match': etag }), '/page');
	strictEqual(changed.status, 200);
	strictEqual(await changed.text(), 'two');
	db.commit([]);
	strictEqual((await handle(req(), '/page')).status, 404);
	db.commit(['inserted']);
	strictEqual(await (await handle(req(), '/page')).text(), 'inserted');
});

Deno.test('requests after a commit cannot join an older in-flight render or read mixed rows', async () => {
	const db = database();
	const started = deferred(), resume = deferred();
	const seen: string[][] = [];
	const handle = freshRenderer(
		db.authority,
		async (rows) => {
			seen.push([...rows]);
			if (rows[0] === 'one') {
				started.resolve();
				await resume.promise;
			}
			return draw(rows);
		},
		renderQueue(4),
		'release',
	);
	const old = handle(req(), '/page');
	await started.promise;
	db.commit(['two']);
	const newer = handle(req(), '/page');
	const joiner = handle(req(), '/page');
	resume.resolve();
	strictEqual(await (await old).text(), 'one');
	const [a, b] = await Promise.all([newer, joiner]);
	strictEqual(await a.text(), 'two');
	strictEqual(await b.text(), 'two');
	strictEqual(b.headers.get('x-render-source'), 'joined');
	equal(seen, [['one'], ['two']]);
	strictEqual(
		(await handle(req(), '/page')).headers.get('x-data-revision'),
		'2',
	);
	strictEqual(db.documents.size, 1);
});

Deno.test('obsolete render finishing last cannot replace current materialization', async () => {
	const db = database();
	const started = deferred(), resume = deferred();
	const oldRenderer = freshRenderer(
		db.authority,
		async (rows) => {
			started.resolve();
			await resume.promise;
			return draw(rows);
		},
		renderQueue(2),
		'release',
	);
	const newRenderer = freshRenderer(
		db.authority,
		draw,
		renderQueue(2),
		'release',
	);
	const old = oldRenderer(req(), '/page');
	await started.promise;
	db.commit(['two']);
	strictEqual(await (await newRenderer(req(), '/page')).text(), 'two');
	resume.resolve();
	await old;
	const current = await newRenderer(req(), '/page');
	strictEqual(current.headers.get('x-render-source'), 'stored');
	strictEqual(await current.text(), 'two');
});

Deno.test('failed renders reject every waiter and allow a fresh retry, without stale HTML', async () => {
	const db = database();
	let fail = false;
	const handle = freshRenderer(
		db.authority,
		(rows) => {
			if (fail) throw new Error('render failed');
			return draw(rows);
		},
		renderQueue(4),
		'release',
	);
	await handle(req(), '/page');
	db.commit(['two']);
	fail = true;
	await Promise.all([
		rejects(handle(req(), '/page'), /render failed/),
		rejects(handle(req(), '/page'), /render failed/),
	]);
	strictEqual(db.documents.size, 0);
	fail = false;
	strictEqual(await (await handle(req(), '/page')).text(), 'two');
});

Deno.test('authority failure rejects even with previously materialized HTML', async () => {
	const db = database();
	const handle = freshRenderer(db.authority, draw, renderQueue(2), 'release');
	await handle(req(), '/page');
	db.authority.select = () => {
		throw new Error('authority unavailable');
	};
	await rejects(handle(req(), '/page'), /authority unavailable/);
});

Deno.test('cold renderer reuses persisted document, but changed release and address cannot', async () => {
	const db = database();
	let renders = 0;
	const render = (rows: string[]) => {
		renders++;
		return draw(rows);
	};
	await freshRenderer(db.authority, render, renderQueue(2), 'a')(
		req(),
		'/page',
	);
	const cold = freshRenderer(db.authority, render, renderQueue(2), 'a');
	strictEqual(
		(await cold(req(), '/page')).headers.get('x-render-source'),
		'stored',
	);
	strictEqual(renders, 1);
	await freshRenderer(db.authority, render, renderQueue(2), 'b')(
		req(),
		'/page',
	);
	await cold(req(), '/page?lang=pt');
	strictEqual(renders, 3);
});

Deno.test('shared queue serializes different objects, coalesces duplicates, and bounds work', async () => {
	const serially = renderQueue(1);
	const started = deferred(), resume = deferred();
	const a = freshRenderer(
		database().authority,
		async (rows) => {
			started.resolve();
			await resume.promise;
			return draw(rows);
		},
		serially,
		'a',
	);
	const b = freshRenderer(database().authority, draw, serially, 'a');
	const first = a(req(), '/page');
	await started.promise;
	const joined = a(req(), '/page');
	strictEqual((await b(req(), '/page')).status, 503);
	resume.resolve();
	await Promise.all([first, joined]);
	strictEqual((await b(req(), '/page')).status, 200);
});

Deno.test('HEAD revalidates and has no body; unsupported methods do not touch authority', async () => {
	const db = database();
	const handle = freshRenderer(db.authority, draw, renderQueue(2), 'release');
	const head = await handle(req({}, 'HEAD'), '/page');
	strictEqual(await head.text(), '');
	strictEqual(
		head.headers.get('cache-control'),
		'public, no-cache, must-revalidate',
	);
	strictEqual(
		(await handle(req({ 'if-none-match': '*' }, 'HEAD'), '/page')).status,
		304,
	);
	strictEqual((await handle(req({}, 'POST'), '/page')).status, 405);
	strictEqual(db.selects, 2);
});
