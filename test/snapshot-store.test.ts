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
