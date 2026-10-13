import worker, {
	type Queries,
	RenderingAuthority as Base,
} from './durable-worker.ts';

export class RenderingAuthority extends Base {
	born = crypto.randomUUID();
	renders = 0;
	paused: { started: boolean; wait: Promise<void>; resume: () => void } | null =
		null;
	failNext = false;

	override async renderSnapshot(snapshot: Queries) {
		this.renders++;
		const pause = this.paused;
		if (pause) {
			pause.started = true;
			await pause.wait;
		}
		if (this.failNext) {
			this.failNext = false;
			throw new Error('injected render failure');
		}
		return super.renderSnapshot(snapshot);
	}

	inspect() {
		return {
			revision: this.revision(),
			renders: this.renders,
			born: this.born,
			paused: this.paused?.started ?? false,
			documents: this.sql.exec('SELECT revision, etag FROM documents')
				.toArray(),
		};
	}

	queries() {
		return Object.fromEntries(
			this.sql.exec('SELECT key, rows FROM queries').toArray()
				.map((row) => [row.key, JSON.parse(row.rows as string)]),
		);
	}

	pause() {
		if (this.paused) throw new Error('already paused');
		const { promise, resolve } = Promise.withResolvers<void>();
		this.paused = { started: false, wait: promise, resume: resolve };
	}

	resume() {
		if (!this.paused) throw new Error('not paused');
		const pause = this.paused;
		this.paused = null;
		pause.resume();
	}

	fail() {
		this.failNext = true;
	}
	evict() {
		this.ctx.abort(new Error('spike eviction'));
	}
}

// This entrypoint is only for the local test harness; release uses durable-worker.
export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (!url.pathname.startsWith('/_spike/')) return worker.fetch(request, env);
		if (
			!env.TEST_TOKEN ||
			request.headers.get('authorization') !== `Bearer ${env.TEST_TOKEN}`
		) {
			return new Response(null, {
				status: 403,
				headers: { 'Cache-Control': 'no-store' },
			});
		}
		const object = env.RENDERER.get(env.RENDERER.idFromName('public'));
		if (url.pathname === '/_spike/state' && request.method === 'GET') {
			return Response.json(await object.inspect(), {
				headers: { 'Cache-Control': 'no-store' },
			});
		}
		if (url.pathname === '/_spike/queries' && request.method === 'GET') {
			return Response.json(await object.queries(), {
				headers: { 'Cache-Control': 'no-store' },
			});
		}
		if (request.method !== 'POST') return new Response(null, { status: 405 });
		switch (url.pathname) {
			case '/_spike/commit': {
				const { expected, changes } = await request.json();
				return Response.json({
					revision: await object.commit(expected, changes),
				});
			}
			case '/_spike/pause':
				await object.pause();
				break;
			case '/_spike/resume':
				await object.resume();
				break;
			case '/_spike/fail':
				await object.fail();
				break;
			case '/_spike/evict':
				await object.evict();
				break;
			default:
				return new Response(null, { status: 404 });
		}
		return new Response(null, { status: 204 });
	},
};
