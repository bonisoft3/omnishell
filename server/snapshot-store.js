import {
	columnOrder,
	compareBy,
	createStore,
} from "../interpreter/data-sync.js";
import {
	canCoalesceSchemaEq,
	COALESCE_CONTROLS,
	coalesceReads,
	normalizeFilterValue,
	parseEmbeds,
	preservesRows,
} from "../interpreter/fragment.js";
import { carriers } from "../interpreter/vendor/mecha-client.js";

function effectiveOrder(order, eqCols) {
	if (!order) return order;
	const filtered = order.split(",").map((term) => term.trim()).filter((term) => {
		const col = term.split(".")[0];
		return !eqCols.has(col);
	});
	return filtered.length ? filtered.join(",") : null;
}

function embedKey(embed) {
	return embed.alias;
}

function sameEmbed(a, b) {
	return a.alias === b.alias && a.rel === b.rel && a.spread === b.spread &&
		a.hints.length === b.hints.length &&
		a.hints.every((h, i) => h === b.hints[i]) &&
		a.cols.length === b.cols.length &&
		a.cols.every((c, i) => c === b.cols[i]) &&
		a.embeds.length === b.embeds.length &&
		a.embeds.every((e, i) => sameEmbed(e, b.embeds[i]));
}

function selectProjector(prior, win, tableFields) {
	if (prior.select === win.select) return (row) => row;
	if (
		win.select === "id" &&
		(prior.tree.cols.includes("*") || prior.tree.cols.includes("id")) &&
		!prior.tree.cols.some((col) => /^id\s*:/.test(col)) &&
		!prior.tree.embeds.some((embed) => embed.spread || embed.alias === "id")
	) {
		return (row) => ({ id: row.id });
	}
	if (
		tableFields &&
		prior.tree.cols.length === 1 && prior.tree.cols[0] === "*" &&
		win.tree.cols.length === 1 && win.tree.cols[0] === "*" &&
		!prior.tree.embeds.some((e) => e.spread) &&
		!win.tree.embeds.some((e) => e.spread) &&
		win.tree.embeds.every((we) =>
			prior.tree.embeds.some((pe) => sameEmbed(pe, we))
		)
	) {
		const omit = prior.tree.embeds
			.filter((pe) => !win.tree.embeds.some((we) => sameEmbed(pe, we)))
			.map(embedKey);
		if (omit.every((k) => !tableFields.has(k))) {
			return (row) => {
				const copy = { ...row };
				for (const k of omit) delete copy[k];
				return copy;
			};
		}
	}
	return null;
}

// Only live tables re-sort locally across different orders: the browser's
// maintainedView orders them with compareBy, whereas server tables refresh via
// /crud under PostgreSQL's ICU collation.
function canSortLocally(prior, win, tableFields, tableSchema) {
	if (!tableFields || tableSchema?.durability !== "live") return false;
	if (!prior.tree.cols.includes("*")) return false;
	if (!win.order) return true;
	const shadowed = new Set();
	for (const col of prior.tree.cols) {
		const m = col.match(/^([^:]+):/);
		if (m) shadowed.add(m[1].trim());
	}
	for (const embed of prior.tree.embeds) {
		if (embed.spread) return false;
		shadowed.add(embedKey(embed));
	}
	return win.order.split(",").every((term) => {
		const col = term.trim().split(".")[0];
		return tableFields.has(col) && !shadowed.has(col);
	});
}

function pageWindow(url) {
	if (!preservesRows(url.searchParams.get("select") ?? "*")) return null;
	const filters = [];
	const eqCols = new Set();
	for (const [k, v] of url.searchParams) {
		if (COALESCE_CONTROLS.has(k)) continue;
		if (k.includes(".")) return null;
		const norm = normalizeFilterValue(v);
		if (norm.startsWith("eq.")) eqCols.add(k);
		filters.push([k, norm]);
	}
	filters.sort(([a, av], [b, bv]) =>
		a.localeCompare(b) || av.localeCompare(bv)
	);
	const limitRaw = url.searchParams.get("limit");
	const offsetRaw = url.searchParams.get("offset") ?? "0";
	if (!/^\d+$/.test(offsetRaw)) return null;
	const offset = Number(offsetRaw);
	let limit;
	if (limitRaw === null) {
		if (offset !== 0) return null;
		limit = Infinity;
	} else {
		if (!/^\d+$/.test(limitRaw)) return null;
		limit = Number(limitRaw);
		if (
			!Number.isSafeInteger(limit + 1) || !Number.isSafeInteger(offset + limit)
		) return null;
	}
	if ([...COALESCE_CONTROLS].some((key) => url.searchParams.getAll(key).length > 1)) {
		return null;
	}
	const select = url.searchParams.get("select") ?? "*";
	const tree = parseEmbeds(select);
	if (tree === null) return null;
	const cols = tree.cols;
	const order = url.searchParams.get("order");
	return {
		select,
		tree,
		order,
		effectiveOrder: effectiveOrder(order, eqCols),
		widen: Number.isFinite(limit) &&
			/[?&]limit=\d+(?:&|$)/.test(url.search) && limit > 1 &&
			(cols.includes("*") || cols.includes("id")) &&
			!cols.some((col) => /^id\s*:/.test(col)) &&
			!tree.embeds.some((embed) => embed.spread || embed.alias === "id"),
		key: `${url.pathname}?${JSON.stringify(filters)}`,
		offset,
		limit,
	};
}

// Remote reads share the authority's transaction. Browser-owned collections
// are new for every render; handlers may derive rows without writing the database.
export function snapshotStore(cfg, appBase, reader) {
	const failures = [];
	const reads = new Map();
	const inFlight = new Map();
	const pages = new Map();
	let boundCarriers;
	const carrier = () => (boundCarriers ??= carriers(cfg.carriers));
	const fieldOrders = new Map();
	const orderOf = (table) => {
		let order = fieldOrders.get(table);
		if (!order) {
			order = columnOrder(
				carrier().compareCarrier,
				cfg.schema?.[table]?.fields,
			);
			fieldOrders.set(table, order);
		}
		return order;
	};
	const readCoalesced = coalesceReads(
		(url) => reader.read(url.pathname.slice("/crud".length) + url.search),
		canCoalesceSchemaEq(cfg.schema, cfg.carriers),
	);
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
				const readPath = url.pathname + url.search;
				let bodyPromise = inFlight.get(readPath);
				if (!bodyPromise) {
					const win = pageWindow(url);
					const priors = win ? (pages.get(win.key) ?? []) : [];
					const table = url.pathname.slice("/crud/".length);
					const declaredFields = cfg.schema?.[table]?.fields;
					const tableFields = declaredFields
						? new Set(declaredFields.map((f) => f.name))
						: null;
					const task = (async () => {
						for (const prior of priors.slice()) {
							const priorAsked = prior.widen ? prior.limit + 1 : prior.limit;
							const project = selectProjector(prior, win, tableFields);
							if (win.offset >= prior.offset + prior.limit) {
								const rows = await prior.promise;
								if (rows.length < priorAsked) return [];
								if (
									prior.widen && win.limit === 1 && win.select === "id" &&
									win.offset === prior.offset + prior.limit &&
									win.effectiveOrder === prior.effectiveOrder
								) {
									const extra = rows[prior.limit];
									if (extra === undefined) return [];
									if (Object.hasOwn(extra, "id")) return [{ id: extra.id }];
								}
								continue;
							}
							if (!project) continue;
							if (
								win.effectiveOrder === prior.effectiveOrder &&
								win.offset >= prior.offset
							) {
								const neededEnd = win.offset + win.limit + (win.widen ? 1 : 0);
								const priorEnd = prior.offset + prior.limit +
									(prior.widen ? 1 : 0);
								if (
									neededEnd <= priorEnd ||
									(prior.settledRows !== undefined &&
										prior.settledRows.length < priorAsked)
								) {
									const rows = await prior.promise;
									if (neededEnd <= priorEnd || rows.length < priorAsked) {
										const slice = rows.slice(
											win.offset - prior.offset,
											win.offset - prior.offset + win.limit +
												(win.widen ? 1 : 0),
										);
										if (
											win.select !== "id" ||
											slice.every((r) => Object.hasOwn(r, "id"))
										) {
											return slice.map(project);
										}
									}
								}
							}
							if (
								prior.offset === 0 &&
								(prior.limit === Infinity ||
									(prior.settledRows !== undefined &&
										prior.settledRows.length < priorAsked)) &&
								canSortLocally(prior, win, tableFields, cfg.schema?.[table])
							) {
								const rows = await prior.promise;
								if (
									(prior.limit === Infinity || rows.length < priorAsked) &&
									(win.select !== "id" ||
										rows.every((r) => Object.hasOwn(r, "id")))
								) {
									const sorted = [...rows];
									if (win.order) {
										sorted.sort(compareBy(win.order, orderOf(table)));
									}
									return sorted
										.slice(
											win.offset,
											win.offset + win.limit + (win.widen ? 1 : 0),
										)
										.map(project);
								}
							}
						}
						const target = win?.widen
							? new URL(
								url.pathname +
									url.search.replace(/([?&]limit=)\d+(?=&|$)/, `$1${win.limit + 1}`),
								url.origin,
							)
							: url;
						return await readCoalesced(target);
					})();
					const entry = win && win.limit > 1
						? { ...win, promise: task, settledRows: undefined }
						: null;
					if (entry) {
						priors.push(entry);
						pages.set(win.key, priors);
					}
					bodyPromise = task.then((result) => {
						if (entry) entry.settledRows = result;
						const rows = win?.widen ? result.slice(0, win.limit) : result;
						const body = JSON.stringify(rows);
						reads.set(readPath, body);
						return body;
					});
					inFlight.set(readPath, bodyPromise);
				}
				const body = await bodyPromise;
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
		async close() {
			await store.close();
			reads.clear();
			inFlight.clear();
			pages.clear();
		},
		assertHealthy() {
			if (failures.length) {
				throw new AggregateError(failures, "public snapshot read failed");
			}
		},
	};
}
