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

Deno.test({
	name: "concurrent single-tick eq reads coalesce into one in.(...) snapshot query while recording per-item #pronto-reads keys",
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		await withBrowser({ fetch: () => { throw new Error("snapshot reads must use the supplied reader"); } }, async () => {
			const paths: string[] = [];
			const store = snapshotStore(
				{
					tables: ["standing", "chance"],
					carriers: FIXTURE_CARRIERS,
					schema: {
						standing: {
							durability: "live",
							fields: [
								{ name: "id", type: "string" },
								{ name: "group_id", type: "string" },
								{ name: "points", type: "number" },
							],
						},
						chance: {
							durability: "live",
							fields: [
								{ name: "id", type: "string" },
								{ name: "group_id", type: "string" },
								{ name: "tier", type: "string" },
								{ name: "pct", type: "number" },
							],
						},
					},
				},
				new URL("https://snapshot.test/"),
				{
					read(path: string) {
						paths.push(path);
						if (path.startsWith("/standing?")) {
							return Promise.resolve([
								{ id: "s1", group_id: "g1", points: 9 },
								{ id: "s2", group_id: "g1", points: 6 },
								{ id: "s3", group_id: "g2", points: 7 },
							]);
						}
						if (path.startsWith("/chance?")) {
							return Promise.resolve([
								{ id: "c1", group_id: "g1", tier: "1", pct: 80 },
								{ id: "c2", group_id: "g2", tier: "1", pct: 65 },
								{ id: "c3", group_id: "g1", tier: "2", pct: 20 },
								{ id: "c4", group_id: "g2", tier: "2", pct: 35 },
							]);
						}
						return Promise.resolve([]);
					},
				},
			);
			try {
				const [g1, g1Dup, g2, g3, c1, c4] = await Promise.all([
					store.query("standing", "points.desc", { filter: "group_id=eq.g1" }),
					store.query("standing", "points.desc", { filter: "group_id=eq.g1" }),
					store.query("standing", "points.desc", { filter: "group_id=eq.g2" }),
					store.query("standing", "points.desc", { filter: "group_id=eq.g3" }),
					store.query("chance", null, { filter: "group_id=eq.g1&tier=eq.1" }),
					store.query("chance", null, { filter: "group_id=eq.g2&tier=eq.2" }),
				]);
				assertEquals(g1, [
					{ id: "s1", group_id: "g1", points: 9 },
					{ id: "s2", group_id: "g1", points: 6 },
				]);
				assertEquals(g1Dup, g1);
				assertEquals(g2, [{ id: "s3", group_id: "g2", points: 7 }]);
				assertEquals(g3, []);
				assertEquals(c1, [{ id: "c1", group_id: "g1", tier: "1", pct: 80 }]);
				assertEquals(c4, [{ id: "c4", group_id: "g2", tier: "2", pct: 35 }]);
				assertEquals(paths, [
					'/standing?select=*&order=points.desc&group_id=in.%28%22g1%22%2C%22g2%22%2C%22g3%22%29',
					'/chance?select=*&group_id=in.%28%22g1%22%2C%22g2%22%29&tier=in.%28%221%22%2C%222%22%29',
				]);
				assertEquals(
					JSON.parse(store.reads.get("/crud/standing?select=*&order=points.desc&group_id=eq.g1")!),
					g1,
				);
				assertEquals(
					JSON.parse(store.reads.get("/crud/standing?select=*&order=points.desc&group_id=eq.g2")!),
					g2,
				);
				assertEquals(
					JSON.parse(store.reads.get("/crud/standing?select=*&order=points.desc&group_id=eq.g3")!),
					[],
				);
				assertEquals(
					JSON.parse(store.reads.get("/crud/chance?select=*&group_id=eq.g1&tier=eq.1")!),
					c1,
				);
			} finally {
				await store.close();
			}
		});
	},
});

Deno.test({
	name:
		"overlapping window, superset-embed, single-value in.(...), and complete-rowset re-sort reads coalesce while recording per-query #pronto-reads keys",
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		await withBrowser({ fetch: () => { throw new Error("snapshot reads must use the supplied reader"); } }, async () => {
			const paths: string[] = [];
			const store = snapshotStore(
				{
					tables: ["zone", "team_campaign_point", "standing"],
					carriers: FIXTURE_CARRIERS,
					schema: {
						zone: {
							durability: "live",
							fields: [
								{ name: "id", type: "string" },
								{ name: "group_id", type: "string" },
								{ name: "first", type: "number" },
								{ name: "last", type: "number" },
							],
						},
						team_campaign_point: {
							durability: "live",
							fields: [
								{ name: "id", type: "string" },
								{ name: "group_id", type: "string" },
								{ name: "team_id", type: "string" },
								{ name: "sequence", type: "number" },
							],
						},
						standing: {
							durability: "live",
							fields: [
								{ name: "id", type: "string" },
								{ name: "group_id", type: "string" },
								{ name: "position", type: "number" },
								{ name: "team_id", type: "string" },
								{ name: "team_name", type: "string" },
							],
						},
					},
				},
				new URL("https://snapshot.test/"),
				{
					read(path: string) {
						paths.push(path);
						if (path.startsWith("/zone?")) {
							return Promise.resolve([
								{ id: "z1", group_id: "g1", first: 1, last: 4 },
								{ id: "z2", group_id: "g1", first: 5, last: 6 },
							]);
						}
						if (path.startsWith("/team_campaign_point?")) {
							return Promise.resolve([
								{
									id: "p1",
									group_id: "g1",
									team_id: "t1",
									sequence: 1,
									team: { name: "Talleres" },
									game: { slug: "game-1" },
								},
								{
									id: "p2",
									group_id: "g1",
									team_id: "t1",
									sequence: 2,
									team: { name: "Talleres" },
									game: { slug: "game-2" },
								},
							]);
						}
						if (path.startsWith("/standing?")) {
							return Promise.resolve([
								{
									id: "s1",
									group_id: "g1",
									position: 1,
									team_id: "t-boca",
									team_name: "Boca Juniors",
									team: { slug: "boca", logo_key: "b" },
								},
								{
									id: "s2",
									group_id: "g1",
									position: 2,
									team_id: "t-aldosivi",
									team_name: "Aldosivi",
									team: { slug: "aldosivi", logo_key: "a" },
								},
							]);
						}
						return Promise.resolve([]);
					},
				},
			);
			try {
				const [
					zones50,
					zones250,
					campaignChart,
					campaignTable,
					campaignProbe,
					standingByPos,
					standingByName,
				] = await Promise.all([
					store.query("zone", "first.asc,last.asc,id.asc", {
						filter: "group_id=eq.g1&limit=50",
					}),
					store.query("zone", "first.asc,last.asc,id.asc", {
						filter: "group_id=eq.g1&limit=250",
					}),
					store.query("team_campaign_point", "sequence.asc,team_id.asc", {
						select: "*,team(name),game(slug)",
						filter: "group_id=eq.g1&team_id=in.(t1,t1)&limit=800",
					}),
					store.query("team_campaign_point", "sequence.asc", {
						select: "*,game(slug)",
						filter: "group_id=eq.g1&team_id=eq.t1&offset=0&limit=40",
					}),
					store.query("team_campaign_point", "sequence.asc", {
						select: "id",
						filter: "group_id=eq.g1&team_id=eq.t1&offset=40&limit=1",
					}),
					store.query("standing", "position.asc,id.asc", {
						select: "*,team(slug,logo_key)",
						filter: "group_id=eq.g1",
					}),
					store.query("standing", "team_name.asc,team_id.asc", {
						select: "*,team(slug,logo_key)",
						filter: "group_id=eq.g1&limit=250",
					}),
				]);
				assertEquals(zones50.length, 2);
				assertEquals(zones250.length, 2);
				assertEquals(campaignChart.length, 2);
				assertEquals(campaignTable, [
					{
						id: "p1",
						group_id: "g1",
						team_id: "t1",
						sequence: 1,
						game: { slug: "game-1" },
					},
					{
						id: "p2",
						group_id: "g1",
						team_id: "t1",
						sequence: 2,
						game: { slug: "game-2" },
					},
				]);
				assertEquals(campaignProbe, []);
				assertEquals(standingByPos.map((r: { id: string }) => r.id), ["s1", "s2"]);
				assertEquals(standingByName.map((r: { id: string }) => r.id), ["s2", "s1"]);
				assertEquals(paths, [
					"/zone?select=*&order=first.asc,last.asc,id.asc&group_id=eq.g1&limit=251",
					"/team_campaign_point?select=*,team(name),game(slug)&order=sequence.asc,team_id.asc&group_id=eq.g1&team_id=in.(t1,t1)&limit=801",
					"/standing?select=*,team(slug,logo_key)&order=position.asc,id.asc&group_id=eq.g1",
				]);
				assertEquals(
					JSON.parse(
						store.reads.get(
							"/crud/team_campaign_point?select=*,game(slug)&order=sequence.asc&group_id=eq.g1&team_id=eq.t1&offset=0&limit=40",
						)!,
					),
					campaignTable,
				);
				assertEquals(
					JSON.parse(
						store.reads.get(
							"/crud/standing?select=*,team(slug,logo_key)&order=team_name.asc,team_id.asc&group_id=eq.g1&limit=250",
						)!,
					),
					standingByName,
				);
				store.assertHealthy();
			} finally {
				await store.close();
			}
		});
	},
});

Deno.test({
	name: "embeds with the same alias but different embedded columns do not reuse a narrower projection",
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		await withBrowser({ fetch: () => { throw new Error("snapshot reads must use the supplied reader"); } }, async () => {
			const paths: string[] = [];
			const store = snapshotStore(
				{
					tables: ["standing"],
					carriers: FIXTURE_CARRIERS,
					schema: {
						standing: {
							durability: "live",
							fields: [
								{ name: "id", type: "string" },
								{ name: "group_id", type: "string" },
							],
						},
					},
				},
				new URL("https://snapshot.test/"),
				{
					read(path: string) {
						paths.push(path);
						if (path.includes("team(name)")) {
							return Promise.resolve([{ id: "s1", group_id: "g1", team: { name: "Talleres" } }]);
						}
						return Promise.resolve([{ id: "s1", group_id: "g1", team: { slug: "talleres" } }]);
					},
				},
			);
			try {
				const [byName, bySlug] = await Promise.all([
					store.query("standing", "id.asc", {
						select: "*,team(name)",
						filter: "group_id=eq.g1",
					}),
					store.query("standing", "id.asc", {
						select: "*,team(slug)",
						filter: "group_id=eq.g1",
					}),
				]);
				assertEquals(byName, [{ id: "s1", group_id: "g1", team: { name: "Talleres" } }]);
				assertEquals(bySlug, [{ id: "s1", group_id: "g1", team: { slug: "talleres" } }]);
				assertEquals(paths.length, 2);
				store.assertHealthy();
			} finally {
				await store.close();
			}
		});
	},
});

Deno.test({
	name:
		"snapshot store treats a widened query returning fewer than limit + 1 rows as exhausted for local re-sorting",
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		await withBrowser({
			fetch: () => {
				throw new Error("unexpected fetch");
			},
		}, async () => {
			const paths: string[] = [];
			const storeExact = snapshotStore(
				{
					tables: ["standing"],
					carriers: FIXTURE_CARRIERS,
					schema: {
						standing: {
							durability: "live",
							fields: [
								{ name: "id", type: "string" },
								{ name: "group_id", type: "string" },
								{ name: "position", type: "number" },
								{ name: "team_name", type: "string" },
							],
						},
					},
				},
				new URL("https://snapshot.test/"),
				{
					read(path: string) {
						paths.push(path);
						return Promise.resolve([
							{ id: "s1", group_id: "g1", position: 1, team_name: "Boca" },
							{ id: "s2", group_id: "g1", position: 2, team_name: "Aldosivi" },
						]);
					},
				},
			);
			try {
				const [byPos, secondPage, byPosCopy] = await Promise.all([
					storeExact.query("standing", "position.asc,id.asc", {
						filter: "group_id=eq.g1&offset=0&limit=2",
					}),
					storeExact.query("standing", "position.asc,id.asc", {
						filter: "group_id=eq.g1&offset=2&limit=2",
					}),
					storeExact.query("standing", "position.asc,id.asc", {
						filter: "group_id=eq.g1&offset=0&limit=2",
					}),
				]);
				byPosCopy.reverse();
				byPosCopy[0].team_name = "mutated";
				const byName = await storeExact.query("standing", "team_name.asc,id.asc", {
					filter: "group_id=eq.g1&offset=0&limit=2",
				});
				assertEquals(byPos.map((r: { id: string }) => r.id), ["s1", "s2"]);
				assertEquals(byPos[0].team_name, "Boca");
				assertEquals(secondPage, []);
				assertEquals(byName.map((r: { id: string }) => r.id), ["s2", "s1"]);
				assertEquals(paths.length, 1);
				storeExact.assertHealthy();
			} finally {
				await storeExact.close();
			}
		});
	},
});

Deno.test({
	name: "snapshot store does not coalesce eq queries carrying limit across distinct keys and does not locally re-sort server-durability tables",
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		await withBrowser({ fetch: () => { throw new Error("unexpected fetch"); } }, async () => {
			const paths: string[] = [];
			const store = snapshotStore(
				{
					tables: ["standing"],
					carriers: FIXTURE_CARRIERS,
					schema: {
						standing: {
							durability: "server",
							fields: [
								{ name: "id", type: "string" },
								{ name: "group_id", type: "string" },
								{ name: "team_name", type: "string" },
								{ name: "position", type: "number" },
							],
						},
					},
				},
				new URL("https://snapshot.test/"),
				{
					read(path: string) {
						paths.push(path);
						if (path.includes("group_id=eq.g1") && path.includes("limit=1")) {
							return Promise.resolve([{ id: "s1", group_id: "g1", position: 1, team_name: "Boca" }]);
						}
						if (path.includes("group_id=eq.g2") && path.includes("limit=1")) {
							return Promise.resolve([{ id: "s2", group_id: "g2", position: 1, team_name: "River" }]);
						}
						return Promise.resolve([
							{ id: "s1", group_id: "g1", position: 1, team_name: "Boca" },
							{ id: "s3", group_id: "g1", position: 2, team_name: "Aldosivi" },
						]);
					},
				},
			);
			try {
				const [g1Top, g2Top, byPos, byName] = await Promise.all([
					store.query("standing", "position.asc", { filter: "group_id=eq.g1&limit=1" }),
					store.query("standing", "position.asc", { filter: "group_id=eq.g2&limit=1" }),
					store.query("standing", "position.asc,id.asc", { filter: "group_id=eq.g3" }),
					store.query("standing", "team_name.asc,id.asc", { filter: "group_id=eq.g3" }),
				]);
				assertEquals(g1Top.length, 1);
				assertEquals(g2Top.length, 1);
				assertEquals(byPos.length, 2);
				assertEquals(byName.length, 2);
				assertEquals(paths, [
					"/standing?select=*&order=position.asc&group_id=eq.g1&limit=1",
					"/standing?select=*&order=position.asc&group_id=eq.g2&limit=1",
					"/standing?select=*&order=position.asc,id.asc&group_id=eq.g3",
					"/standing?select=*&order=team_name.asc,id.asc&group_id=eq.g3",
				]);
				store.assertHealthy();
			} finally {
				await store.close();
			}
		});
	},
});
