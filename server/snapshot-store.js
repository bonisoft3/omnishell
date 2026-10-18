import { createStore } from "../interpreter/data-sync.js";

// Remote reads share the authority's transaction. Browser-owned collections
// are new for every render; handlers may derive rows without writing the database.
export function snapshotStore(cfg, appBase, reader) {
	const failures = [];
	const reads = new Map();
	const schema = Object.fromEntries(
		Object.entries(cfg.schema).map((
			[table, value],
		) => [
			table,
			cfg.local?.[table] ? value : { ...value, durability: "server" },
		]),
	);
	// Every read a render makes reads its snapshot (render.ts says why).
	const store = createStore(appBase.origin, {
		...cfg,
		tables: [],
		schema,
		appBase,
		keepReads: false,
	}, {
		async request(input, init) {
			try {
				if ((init?.method ?? "GET") !== "GET") {
					throw new Error("public rendering cannot write remote data");
				}
				const url = new URL(input);
				if (
					url.origin !== appBase.origin || !url.pathname.startsWith("/crud/")
				) {
					throw new Error(`unexpected snapshot address: ${url}`);
				}
				const rows = await reader.read(
					url.pathname.slice("/crud".length) + url.search,
				);
				const body = JSON.stringify(rows);
				reads.set(url.pathname + url.search, body);
				return new Response(body, {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			} catch (error) {
				failures.push(error);
				throw error;
			}
		},
		schedule(fn) {
			const timer = setTimeout(fn, 0);
			return () => clearTimeout(timer);
		},
	});
	return {
		...store,
		reads,
		assertHealthy() {
			if (failures.length) {
				throw new AggregateError(failures, "public snapshot read failed");
			}
		},
	};
}
