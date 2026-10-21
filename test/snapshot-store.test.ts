import {
	assertEquals,
	assertRejects,
	assertThrows,
} from "jsr:@std/assert@1.0.19";
import { snapshotStore } from "../server/snapshot-store.js";
import { FIXTURE_CARRIERS } from "../interpreter/fixture-types.js";
import { withBrowser } from "../interpreter/smoke-browser.js";

Deno.test({
	name: "snapshot renders isolate tab state and refuse remote mutations",
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		await withBrowser({
			fetch: () => {
				throw new Error("snapshot reads must use the supplied reader");
			},
		}, async () => {
			const fields = [{ name: "id", type: "string" }, {
				name: "name",
				type: "string",
			}];
			const cfg = {
				tables: ["card"],
				local: { view: "tab" },
				carriers: FIXTURE_CARRIERS,
				schema: {
					card: { durability: "live", fields },
					view: { durability: "tab", fields },
				},
				seed: { view: [{ id: "selection", name: "initial" }] },
			};
			const paths: string[] = [];
			const reader = {
				read(path: string) {
					paths.push(path);
					return Promise.resolve([{ id: "1", name: "public" }]);
				},
			};
			const first = snapshotStore(
				cfg,
				new URL("https://snapshot.test/"),
				reader,
			);
			const second = snapshotStore(
				cfg,
				new URL("https://snapshot.test/"),
				reader,
			);
			try {
				assertEquals(await first.query("card", null, { filter: "id=eq.1" }), [{
					id: "1",
					name: "public",
				}]);
				assertEquals(paths, ["/card?select=*&id=eq.1"]);
				await first.patch("view", [{
					key: "selection",
					changes: { name: "changed" },
				}]);
				assertEquals((await first.query("view"))[0].name, "changed");
				assertEquals((await second.query("view"))[0].name, "initial");
				await assertRejects(
					() =>
						first.patch("card", [{ key: "1", changes: { name: "forbidden" } }]),
					Error,
					"cannot write",
				);
				assertThrows(() => first.assertHealthy(), AggregateError);
				second.assertHealthy();
			} finally {
				await first.close();
				await second.close();
			}
		});
	},
});

Deno.test({
	name: "a rendered error state cannot hide a failed snapshot read",
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		await withBrowser({
			fetch: () => {
				throw new Error("snapshot reads must use the supplied reader");
			},
		}, async () => {
			const store = snapshotStore(
				{ tables: ["card"], schema: { card: { durability: "live" } } },
				new URL("https://snapshot.test/"),
				{
					read() {
						throw new Error("authority unavailable");
					},
				},
			);
			try {
				await assertRejects(
					() => store.query("card"),
					Error,
					"authority unavailable",
				);
				assertThrows(() => store.assertHealthy(), AggregateError);
			} finally {
				await store.close();
			}
		});
	},
});

Deno.test({
	name:
		"an underfull page read answers its next-page probe without a second snapshot read",
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		await withBrowser({
			fetch: () => {
				throw new Error("snapshot reads must use the supplied reader");
			},
		}, async () => {
			const paths: string[] = [];
			const store = snapshotStore(
				{ tables: ["card"], schema: { card: { durability: "live" } } },
				new URL("https://snapshot.test/"),
				{
					read(path: string) {
						paths.push(path);
						return Promise.resolve([{ id: "1", name: "only" }]);
					},
				},
			);
			try {
				const [page, probe] = await Promise.all([
					store.query("card", "id.desc", {
						filter: "owner_id=eq.1&status=eq.active&offset=0&limit=40",
						select: "*,owner:owner_id(name)",
					}),
					store.query("card", "id.desc", {
						filter: "status=eq.active&owner_id=eq.1&offset=40&limit=1",
						select: "id",
					}),
				]);
				assertEquals(page, [{ id: "1", name: "only" }]);
				assertEquals(probe, []);
				assertEquals(paths, [
					"/card?select=*,owner:owner_id(name)&order=id.desc&owner_id=eq.1&status=eq.active&offset=0&limit=41",
				]);
				assertEquals(
					store.reads.get(
						"/crud/card?select=id&order=id.desc&status=eq.active&owner_id=eq.1&offset=40&limit=1",
					),
					"[]",
				);
			} finally {
				await store.close();
			}
		});
	},
});

Deno.test({
	name:
		"snapshot page lookahead preserves rows, carried keys, and probe matching",
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		await withBrowser({
			fetch: () => {
				throw new Error("unexpected fetch");
			},
		}, async () => {
			for (const count of [39, 40, 41]) {
				const paths: string[] = [];
				const source = Array.from(
					{ length: count },
					(_, id) => ({ id: String(id), name: `row ${id}` }),
				);
				const store = snapshotStore(
					{ tables: ["card"], schema: { card: { durability: "live" } } },
					new URL("https://snapshot.test/"),
					{
						read(path: string) {
							paths.push(path);
							return Promise.resolve(source);
						},
					},
				);
				try {
					const [page, probe] = await Promise.all([
						store.query("card", "name.asc,id.desc", {
							select: "*",
							filter: "a=eq.x%26y&b=eq.z&offset=0&limit=40",
						}),
						store.query("card", "name.asc,id.desc", {
							select: "id",
							filter: "b=eq.z&a=eq.x%26y&offset=40&limit=1",
						}),
					]);
					assertEquals(page, source.slice(0, 40));
					assertEquals(probe, count === 41 ? [{ id: "40" }] : []);
					assertEquals(paths, [
						"/card?select=*&order=name.asc,id.desc&a=eq.x%26y&b=eq.z&offset=0&limit=41",
					]);
					assertEquals([...store.reads.entries()], [
						[
							"/crud/card?select=*&order=name.asc,id.desc&a=eq.x%26y&b=eq.z&offset=0&limit=40",
							JSON.stringify(source.slice(0, 40)),
						],
						[
							"/crud/card?select=id&order=name.asc,id.desc&b=eq.z&a=eq.x%26y&offset=40&limit=1",
							JSON.stringify(probe),
						],
					]);
					store.assertHealthy();
				} finally {
					await store.close();
				}
			}
		});
	},
});

Deno.test({
	name:
		"snapshot probes do not reuse incompatible orders, filters, projections, or row-changing selects",
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		await withBrowser({
			fetch: () => {
				throw new Error("unexpected fetch");
			},
		}, async () => {
			for (
				const scenario of [
					{
						select: "*",
						order: "id.asc",
						probeOrder: "id.desc",
						filter: "a=eq.x",
						probeFilter: "a=eq.x",
						widened: true,
					},
					{
						select: "*",
						order: "id.asc",
						probeOrder: "id.asc",
						filter: "a=eq.x%26b%3Deq.y",
						probeFilter: "a=eq.x&b=eq.y",
						widened: true,
					},
					...[
						"name",
						"other:id",
						"*,id:name",
						"*,owner!inner(name)",
						"total:points.sum()::int",
						"*,owner(total:points.sum())",
					].map((select) => ({
						select,
						order: "id.asc",
						probeOrder: "id.asc",
						filter: "a=eq.x",
						probeFilter: "a=eq.x",
						widened: false,
					})),
				]
			) {
				const paths: string[] = [];
				const store = snapshotStore(
					{ tables: ["card"], schema: { card: { durability: "live" } } },
					new URL("https://snapshot.test/"),
					{
						read(path: string) {
							paths.push(path);
							return Promise.resolve(
								path.includes("offset=40")
									? [{ id: "probe" }]
									: Array.from({ length: 41 }, (_, id) => ({ id: String(id) })),
							);
						},
					},
				);
				try {
					const [, probe] = await Promise.all([
						store.query("card", scenario.order, {
							select: scenario.select,
							filter: `${scenario.filter}&offset=0&limit=40`,
						}),
						store.query("card", scenario.probeOrder, {
							select: "id",
							filter: `${scenario.probeFilter}&offset=40&limit=1`,
						}),
					]);
					assertEquals(probe, [{ id: "probe" }], JSON.stringify(scenario));
					assertEquals(paths.length, 2);
					assertEquals(
						new URL(paths[0], "https://snapshot.test").searchParams.get(
							"limit",
						),
						scenario.widened ? "41" : "40",
					);
				} finally {
					await store.close();
				}
			}
		});
	},
});

Deno.test({
	name: "failed lookahead rejects both reads and cannot produce carried data",
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		await withBrowser({
			fetch: () => {
				throw new Error("unexpected fetch");
			},
		}, async () => {
			const paths: string[] = [];
			const store = snapshotStore(
				{ tables: ["card"], schema: { card: { durability: "live" } } },
				new URL("https://snapshot.test/"),
				{
					read(path: string) {
						paths.push(path);
						return Promise.reject(new Error("authority unavailable"));
					},
				},
			);
			try {
				const results = await Promise.allSettled([
					store.query("card", "id.asc", {
						select: "*",
						filter: "offset=0&limit=40",
					}),
					store.query("card", "id.asc", {
						select: "id",
						filter: "offset=40&limit=1",
					}),
				]);
				assertEquals(results.map((result) => result.status), [
					"rejected",
					"rejected",
				]);
				assertEquals(paths.length, 1);
				assertEquals(store.reads.size, 0);
				assertThrows(() => store.assertHealthy(), AggregateError);
			} finally {
				await store.close();
			}
		});
	},
});

Deno.test({
	name:
		"later page requests cannot await themselves and missing extra-row ids require a real probe",
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		await withBrowser({
			fetch: () => {
				throw new Error("unexpected fetch");
			},
		}, async () => {
			const paths: string[] = [];
			const store = snapshotStore(
				{ tables: ["card"], schema: { card: { durability: "live" } } },
				new URL("https://snapshot.test/"),
				{
					read(path: string) {
						paths.push(path);
						const url = new URL(path, "https://snapshot.test");
						if (url.searchParams.get("limit") === "1") {
							return Promise.resolve([{ id: "real" }]);
						}
						return Promise.resolve(
							Array.from(
								{ length: 3 },
								(_, i) => i === 2 ? { name: "missing id" } : { id: String(i) },
							),
						);
					},
				},
			);
			try {
				const [first, second] = await Promise.all([
					store.query("card", "id.asc", {
						select: "*",
						filter: "offset=0&limit=2",
					}),
					store.query("card", "id.asc", {
						select: "*",
						filter: "offset=2&limit=2",
					}),
				]);
				assertEquals(first.length, 2);
				assertEquals(second.length, 2);
				assertEquals(
					await store.query("card", "id.asc", {
						select: "id",
						filter: "offset=4&limit=1",
					}),
					[{ id: "real" }],
				);
				assertEquals(paths.length, 3);
				store.assertHealthy();
			} finally {
				await store.close();
			}
		});
	},
});
