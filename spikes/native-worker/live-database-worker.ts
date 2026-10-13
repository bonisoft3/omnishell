import { RpcTarget } from 'cloudflare:workers';
import { edgeObject } from '../../../../libraries/mecha/packages/mecha-edge/src/object.ts';
import { edgeWorker } from '../../../../libraries/mecha/packages/mecha-edge/src/worker.ts';
import type { PublicSnapshot } from '../../../../libraries/mecha/packages/mecha-edge/src/public-snapshot.ts';
import assets from './.generated/live-pglite.ts';

class SnapshotReader extends RpcTarget {
	constructor(private snapshot: PublicSnapshot) {
		super();
	}
	read(path: string) {
		return this.snapshot.read(path);
	}
}

const Base = edgeObject({ assets, tables: ['board', 'note'] });
export class Database extends Base {
	override fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname !== '/board') return super.fetch(request);
		if (new URL(request.url).search) {
			return Promise.resolve(new Response(null, { status: 404 }));
		}
		return this.readPublic(async (snapshot) => {
			const object = this.env.RENDERER.get(
				this.env.RENDERER.idFromName('public'),
			);
			return await object.render(
				request,
				snapshot.revision,
				new SnapshotReader(snapshot),
			);
		});
	}
}

export default {
	fetch(request, env, ctx) {
		if (new URL(request.url).pathname === '/board') {
			return env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).fetch(request);
		}
		return edgeWorker.fetch(request, env, ctx);
	},
};
