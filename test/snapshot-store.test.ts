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
		await withBrowser({ fetch: () => { throw new Error("snapshot reads must use the supplied reader"); } }, async () => {
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
		await withBrowser({ fetch: () => { throw new Error("snapshot reads must use the supplied reader"); } }, async () => {
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
	name: "an underfull page read answers its next-page probe without a second snapshot read",
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		await withBrowser({ fetch: () => { throw new Error("snapshot reads must use the supplied reader"); } }, async () => {
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
					"/card?select=*,owner:owner_id(name)&order=id.desc&owner_id=eq.1&status=eq.active&offset=0&limit=40",
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
	name: "full pages, inner embeds, and aggregates still read the next-page probe from the snapshot",
	sanitizeOps: false,
	sanitizeResources: false,
	async fn() {
		await withBrowser({ fetch: () => { throw new Error("snapshot reads must use the supplied reader"); } }, async () => {
			const paths: string[] = [];
			const store = snapshotStore(
				{ tables: ["card"], schema: { card: { durability: "live" } } },
				new URL("https://snapshot.test/"),
				{
					read(path: string) {
						paths.push(path);
						if (path.includes("offset=0&limit=2")) {
							return Promise.resolve([{ id: "1" }, { id: "2" }]);
						}
						if (path.includes("offset=2&limit=1")) {
							return Promise.resolve([{ id: "3" }]);
						}
						return Promise.resolve([{ id: "1" }]);
					},
				},
			);
			try {
				const [fullPage, fullProbe] = await Promise.all([
					store.query("card", "id.desc", {
						filter: "owner_id=eq.full&offset=0&limit=2",
						select: "id",
					}),
					store.query("card", "id.desc", {
						filter: "owner_id=eq.full&offset=2&limit=1",
						select: "id",
					}),
				]);
				assertEquals(fullPage.length, 2);
				assertEquals(fullProbe, [{ id: "3" }]);

				const [page2, probe2] = await Promise.all([
					store.query("card", "id.desc", {
						filter: "owner_id=eq.full&offset=2&limit=2",
						select: "id",
					}),
					store.query("card", "id.desc", {
						filter: "owner_id=eq.full&offset=4&limit=1",
						select: "id",
					}),
				]);
				assertEquals(page2, [{ id: "1" }]);
				assertEquals(probe2, []);

				await Promise.all([
					store.query("card", "id.desc", {
						filter: "owner_id=eq.inner&offset=0&limit=40",
						select: "*,owner!inner(name)",
					}),
					store.query("card", "id.desc", {
						filter: "owner_id=eq.inner&offset=40&limit=1",
						select: "id",
					}),
				]);

				await Promise.all([
					store.query("card", null, {
						filter: "owner_id=eq.agg&offset=0&limit=40",
						select: "total:points.sum()::int",
					}),
					store.query("card", null, {
						filter: "owner_id=eq.agg&offset=40&limit=1",
						select: "id",
					}),
				]);

				await Promise.all([
					store.query("card", "id.desc", {
						filter: "a=eq.x%26b%3Deq.y&offset=0&limit=40",
						select: "id",
					}),
					store.query("card", "id.desc", {
						filter: "a=eq.x&b=eq.y&offset=40&limit=1",
						select: "id",
					}),
				]);

				assertEquals(paths, [
					"/card?select=id&order=id.desc&owner_id=eq.full&offset=0&limit=2",
					"/card?select=id&order=id.desc&owner_id=eq.full&offset=2&limit=1",
					"/card?select=id&order=id.desc&owner_id=eq.full&offset=2&limit=2",
					"/card?select=*,owner!inner(name)&order=id.desc&owner_id=eq.inner&offset=0&limit=40",
					"/card?select=id&order=id.desc&owner_id=eq.inner&offset=40&limit=1",
					"/card?select=total:points.sum()::int&owner_id=eq.agg&offset=0&limit=40",
					"/card?select=id&owner_id=eq.agg&offset=40&limit=1",
					"/card?select=id&order=id.desc&a=eq.x%26b%3Deq.y&offset=0&limit=40",
					"/card?select=id&order=id.desc&a=eq.x&b=eq.y&offset=40&limit=1",
				]);
			} finally {
				await store.close();
			}
		});
	},
});
