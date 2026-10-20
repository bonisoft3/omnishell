import { createStore } from "../interpreter/data-sync.js";
import { parseEmbeds } from "../interpreter/fragment.js";

const CONTROLS = new Set(["select", "order", "limit", "offset"]);
const AGGREGATE = /\b(?:count|sum|avg|max|min)\(\)/;

function preservesRows(select) {
	const tree = parseEmbeds(select ?? "*");
	if (tree === null || tree.cols.some((c) => AGGREGATE.test(c))) return false;
	const walk = (embeds) =>
		embeds.every((e) =>
			!e.hints.includes("inner") && !e.cols.some((c) => AGGREGATE.test(c)) &&
			walk(e.embeds)
		);
	return walk(tree.embeds);
}

function pageWindow(url) {
	if (!preservesRows(url.searchParams.get("select") ?? "*")) return null;
	const filters = [];
	for (const [k, v] of url.searchParams) {
		if (CONTROLS.has(k)) continue;
		if (k.includes(".")) return null;
		filters.push([k, v]);
	}
	filters.sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
	const limitRaw = url.searchParams.get("limit");
	const offsetRaw = url.searchParams.get("offset") ?? "0";
	if (
		limitRaw === null || !/^\d+$/.test(limitRaw) || !/^\d+$/.test(offsetRaw)
	) {
		return null;
	}
	return {
		key: `${url.pathname}?${JSON.stringify(filters)}`,
		offset: Number(offsetRaw),
		limit: Number(limitRaw),
	};
}

// Remote reads share the authority's transaction. Browser-owned collections
// are new for every render; handlers may derive rows without writing the database.
export function snapshotStore(cfg, appBase, reader) {
	const failures = [];
	const reads = new Map();
	const pages = new Map();
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
				const win = pageWindow(url);
				const priors = win ? (pages.get(win.key) ?? []) : [];
				const task = (async () => {
					for (const prior of priors) {
						if (
							win.offset >= prior.offset + prior.limit &&
							(await prior.promise).length < prior.limit
						) {
							return [];
						}
					}
					return await reader.read(
						url.pathname.slice("/crud".length) + url.search,
					);
				})();
				if (win && win.limit > 1) {
					priors.push({ offset: win.offset, limit: win.limit, promise: task });
					pages.set(win.key, priors);
				}
				const rows = await task;
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
