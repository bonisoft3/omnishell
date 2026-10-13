import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { seed } from '../../../../libraries/mecha/packages/mecha-edge/test/seed.ts';
import { load } from '../../../../libraries/mecha/packages/pglite-workerd/load.ts';

const [endpoint, output] = Deno.args;
if (!output) throw new Error('live-check.ts <local-endpoint> <report>');
const target = new URL(endpoint);
if (
	target.protocol !== 'http:' ||
	!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
	target.pathname !== '/' || target.search || target.hash || target.username ||
	target.password
) {
	throw new Error(
		'live-check requires a local HTTP origin; it resets the database',
	);
}
const root = await Deno.makeTempDir({ prefix: 'live-ssr-' });
const pgdata = `${root}/pgdata`;
await seed(pgdata);
const db = await PGlite.create({ dataDir: pgdata });
await db.exec(`GRANT INSERT, UPDATE, DELETE ON board TO app_user;
  CREATE POLICY writes ON board FOR ALL USING (true) WITH CHECK (true);
  CHECKPOINT;`);
await db.close();
const checks: string[] = [];
const importing = (route, init) =>
	fetch(`${endpoint}/import/${route}`, {
		...init,
		headers: { authorization: 'Bearer local-live-import' },
	});
const page = async (headers = {}) => {
	const start = performance.now();
	const response = await fetch(endpoint + '/board', { headers });
	const html = await response.text();
	return {
		status: response.status,
		headers: response.headers,
		html,
		ms: performance.now() - start,
	};
};
try {
	const reset = await importing('reset', { method: 'POST' });
	assert.ok(reset.ok, await reset.text());
	await load(pgdata, importing, { log: () => {} });
	const initial = await page();
	assert.equal(
		initial.status,
		200,
		initial.html.match(/Error: [^<\n]+/)?.[0] ?? initial.html.slice(-500),
	);
	assert.match(initial.html, /Brasileirão 2026/);
	assert.match(initial.html, /data-served/);
	assert.equal(initial.headers.get('x-render-source'), 'rendered');
	assert.equal(initial.headers.get('set-cookie'), null);
	const hit = await page();
	assert.equal(hit.html, initial.html);
	assert.equal(hit.headers.get('x-render-source'), 'stored');
	assert.equal(
		hit.headers.get('x-data-revision'),
		initial.headers.get('x-data-revision'),
	);
	assert.equal(
		(await page({ 'if-none-match': initial.headers.get('etag')! })).status,
		304,
	);
	checks.push(
		'anonymous M-SSR reads real PGlite through RPC; unchanged revision reuses HTML and answers 304',
	);

	const guest =
		await (await fetch(endpoint + '/auth/guest', { method: 'POST' })).json();
	const write = async (path: string, method: string, body?: unknown) => {
		const response = await fetch(`${endpoint}/crud/${path}`, {
			method,
			headers: {
				authorization: `Bearer ${guest.token}`,
				'content-type': 'application/json',
				prefer: 'return=representation',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		assert.ok(response.ok, await response.text());
	};
	await write('note', 'POST', { body: 'PRIVATE-MUST-NOT-RENDER' });
	await write('board?id=eq.1', 'PATCH', { title: 'Fresh public title' });
	const updated = await page({ 'if-none-match': initial.headers.get('etag')! });
	assert.equal(updated.status, 200, updated.html);
	assert.match(updated.html, /Fresh public title/);
	assert.doesNotMatch(updated.html, /PRIVATE-MUST-NOT-RENDER/);
	assert.notEqual(
		updated.headers.get('x-data-revision'),
		initial.headers.get('x-data-revision'),
	);
	checks.push(
		'ordinary authenticated CRUD commit invalidates anonymous HTML; private row excluded by RLS',
	);

	await write('board?id=eq.1', 'PATCH', { title: 'Concurrent fresh readers' });
	const concurrent = await Promise.all(Array.from({ length: 8 }, () => page()));
	assert.ok(
		concurrent.every((result) =>
			result.status === 200 && result.html.includes('Concurrent fresh readers')
		),
	);
	assert.equal(
		concurrent.filter((result) =>
			result.headers.get('x-render-source') === 'rendered'
		).length,
		1,
	);
	checks.push(
		'eight concurrent navigations after a write produce one fresh render',
	);

	await write('board?id=eq.1', 'DELETE');
	assert.doesNotMatch((await page()).html, /Concurrent fresh readers/);
	await write('board', 'POST', { id: 1, title: 'Inserted fresh title' });
	const inserted = await page();
	assert.match(inserted.html, /Inserted fresh title/);
	checks.push('deletion and insertion change the rendered data');

	const resetAgain = await importing('reset', { method: 'POST' });
	assert.ok(resetAgain.ok, await resetAgain.text());
	await load(pgdata, importing, { log: () => {} });
	const replaced = await page();
	assert.equal(replaced.status, 200, replaced.html);
	assert.match(replaced.html, /Brasileirão 2026/);
	assert.notEqual(
		replaced.headers.get('x-data-revision'),
		initial.headers.get('x-data-revision'),
	);
	assert.notEqual(
		replaced.headers.get('x-data-revision'),
		inserted.headers.get('x-data-revision'),
	);
	assert.equal(replaced.headers.get('x-render-source'), 'rendered');
	checks.push(
		'restoring the original database cannot reuse a document from the previous directory generation',
	);

	const samples = [];
	for (let i = 0; i < 30; i++) {
		const response = await page();
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('x-render-source'), 'stored');
		samples.push(response.ms);
	}
	samples.sort((a, b) => a - b);
	const report = {
		checks,
		initialMs: initial.ms,
		freshAfterWriteMs: updated.ms,
		validatedReuse: {
			requests: samples.length,
			medianMs: samples[15],
			p95Ms: samples[28],
		},
		scope:
			'Two local Workers with separate database and rendering Durable Objects, actual PGlite SQL, RLS, RPC and M-SSR. Small public/private test schema, not Golaberto route coverage or remote Free-plan validation.',
	};
	await Deno.writeTextFile(output, JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report, null, 2));
} finally {
	await Deno.remove(root, { recursive: true });
}
