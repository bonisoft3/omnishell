import { DurableObject } from 'cloudflare:workers';
import { fixture, renderQueries } from './document.ts';
import { type Document, freshRenderer, renderQueue } from './fresh-render.ts';

const serially = renderQueue(16);
export type Queries = Record<string, unknown[]>;

export class RenderingAuthority extends DurableObject {
	sql = this.ctx.storage.sql;
	renderer;

	constructor(ctx, env) {
		super(ctx, env);
		if (typeof env.RELEASE !== 'string' || !env.RELEASE) {
			throw new Error('RELEASE is required');
		}
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(`
        CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS queries (key TEXT PRIMARY KEY, rows TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, html TEXT NOT NULL, status INTEGER NOT NULL, etag TEXT NOT NULL);
        INSERT OR IGNORE INTO state VALUES (1, 0);
      `);
			if (this.revision() === 0) {
				for (const [key, rows] of Object.entries(fixture.queries)) {
					this.sql.exec(
						'INSERT INTO queries VALUES (?, ?)',
						key,
						JSON.stringify(rows),
					);
				}
				this.sql.exec('UPDATE state SET revision = 1 WHERE id = 1');
			}
		});
		this.renderer = freshRenderer<Queries>(
			{
				select: (key) =>
					this.ctx.storage.transactionSync(() => {
						const revision = this.revision();
						const [document] = this.sql.exec(
							'SELECT html, status, etag FROM documents WHERE key = ? AND revision = ?',
							key,
							revision,
						).toArray();
						if (document) return { revision, document: document as Document };
						// Fully consume SQLite cursors before the first await: cursors are not snapshots.
						const snapshot = Object.fromEntries(
							this.sql.exec('SELECT key, rows FROM queries').toArray()
								.map((row) => [row.key, JSON.parse(row.rows as string)]),
						);
						return { revision, snapshot };
					}),
				publish: (key, revision, document) =>
					this.ctx.storage.transactionSync(() => {
						if (this.revision() !== revision) return;
						// One fixture route and one current release; bound retained HTML across deploys.
						this.sql.exec('DELETE FROM documents');
						this.sql.exec(
							'INSERT INTO documents VALUES (?, ?, ?, ?, ?)',
							key,
							revision,
							document.html,
							document.status,
							document.etag,
						);
					}),
			},
			(snapshot) => this.renderSnapshot(snapshot),
			serially,
			env.RELEASE,
		);
	}

	async renderSnapshot(snapshot: Queries) {
		return await renderQueries(snapshot) as { html: string; status: 200 | 404 };
	}

	revision(): number {
		return this.sql.exec('SELECT revision FROM state WHERE id = 1').one()
			.revision as number;
	}

	commit(expected: number, changes: Queries): number {
		return this.ctx.storage.transactionSync(() => {
			if (this.revision() !== expected) throw new Error('revision conflict');
			for (const [key, rows] of Object.entries(changes)) {
				if (!Array.isArray(rows)) throw new Error('rows must be an array');
				if (
					!this.sql.exec('SELECT key FROM queries WHERE key = ?', key).toArray()
						.length
				) {
					throw new Error(`uncaptured query: ${key}`);
				}
				this.sql.exec(
					'UPDATE queries SET rows = ? WHERE key = ?',
					JSON.stringify(rows),
					key,
				);
			}
			this.sql.exec('UPDATE state SET revision = revision + 1 WHERE id = 1');
			this.sql.exec('DELETE FROM documents');
			return this.revision();
		});
	}

	fetch(request: Request) {
		const url = new URL(request.url);
		if (url.pathname !== fixture.pathname || url.search) {
			return new Response('route outside captured fixture\n', {
				status: 404,
				headers: { 'Cache-Control': 'no-store' },
			});
		}
		return this.renderer(request, fixture.origin + fixture.pathname);
	}
}

export default {
	fetch(request, env) {
		return env.RENDERER.get(env.RENDERER.idFromName('public')).fetch(request);
	},
};
