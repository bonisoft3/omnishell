import assert from "node:assert/strict";
import { observationIdentity, observationSnapshot, observeActor } from "./observe-actor.js";
const binding = { table: "progress", field: "status", match: { id: "set_id", run: "run" }, event: "signal:progress." };
const form = { set_id: "deck", run: "run-2" };
const identity = observationIdentity(binding, form)!;
const rows = (status: string, txid: string, run = "run-2") => [{ id: "deck", run, status, txid }];

Deno.test("snapshot observations correlate instances and reject older or repeated revisions", () => {
  const cursors = new Map();
  assert.equal(observationSnapshot(binding, identity, rows("done", "7", "run-1"), cursors), undefined);
  const reply = observationSnapshot(binding, identity, rows("done", "8"), cursors)!;
  assert.deepEqual(reply.event, { type: "signal:progress.done", value: "done" });
  reply.acknowledge();
  assert.equal(observationSnapshot(binding, identity, rows("drafting", "7"), cursors), undefined);
  assert.equal(observationSnapshot(binding, identity, rows("done", "8"), cursors), undefined);
  assert.equal(observationSnapshot(binding, identity, rows("partial", "8"), cursors)!.event.type, "signal:progress.partial");
});
Deno.test("unacknowledged delivery remains eligible and malformed sources fail loudly", () => {
  const cursors = new Map();
  assert.ok(observationSnapshot(binding, identity, rows("done", "8"), cursors));
  assert.ok(observationSnapshot(binding, identity, rows("done", "8"), cursors));
  assert.throws(() => observationSnapshot(binding, identity, undefined, cursors), /needs a read/);
  assert.throws(() => observationSnapshot(binding, identity, [...rows("done", "8"), ...rows("done", "8")], cursors), /more than one/);
});
Deno.test("missing-only observation requires acceptance identity", () => {
  const deleted = { table: "deck", match: { id: "set_id" }, missing: "signal:deck.removed", require: ["run"] };
  assert.equal(observationIdentity(deleted, { ...form, run: "" }), undefined);
  assert.equal(observationSnapshot(deleted, observationIdentity(deleted, form)!, [], new Map())!.event.type, "signal:deck.removed");
  assert.equal(observationSnapshot(deleted, observationIdentity(deleted, form)!, [{ id: "deck" }], new Map()), undefined);
});
Deno.test("an invoked source subscribes before reading, discards a late old binding, and stops its subscription", async () => {
  let row = { ...form }, wake: (() => void) | undefined, release!: (rows: object[]) => void;
  const calls: string[] = [], events: object[] = [], pending = new Set<Promise<unknown>>();
  let first = true;
  const actor = observeActor(binding, {
    store: {
      subscribe: (_table: string, cb: () => void) => { calls.push("subscribe"); wake = cb; return () => { calls.push("stop"); wake = undefined; }; },
      query: async () => {
        calls.push("read");
        if (first) { first = false; return await new Promise<object[]>((resolve) => { release = resolve; }); }
        return [{ id: row.set_id, run: row.run, status: "done", txid: "10" }];
      },
    },
    readRow: () => row,
    send: async (event: object, attached: () => boolean) => { if (!attached()) return false; events.push(event); return true; },
    track: (p: Promise<unknown>) => { pending.add(p); p.finally(() => pending.delete(p)); return p; },
    failed: (error: unknown) => { throw error; },
  });
  actor.update();
  row = { set_id: "new-deck", run: "run-3" };
  actor.update();
  release(rows("failed", "9"));
  while (pending.size) await Promise.all(pending);
  assert.deepEqual(calls, ["subscribe", "read", "read"]);
  assert.deepEqual(events, [{ type: "signal:progress.done", value: "done" }]);
  row = { ...form };
  actor.update();
  while (pending.size) await Promise.all(pending);
  row = { set_id: "new-deck", run: "run-3" };
  actor.update();
  while (pending.size) await Promise.all(pending);
  assert.equal(events.length, 3, "each attachment reads its current snapshot, including a previously observed instance");
  actor.stop();
  assert.equal(wake, undefined);
});
Deno.test("absence uses one confirmed read instead of inferring deletion from a local snapshot", async () => {
  const options: object[] = [], events: object[] = [], pending: Promise<unknown>[] = [];
  const actor = observeActor({ table: "deck", match: { id: "set_id" }, require: ["run"], missing: "signal:removed" }, {
    store: { subscribe: () => () => {}, query: async (_table: string, _order: unknown, opts: object) => { options.push(opts); return []; } },
    readRow: () => form, send: async (event: object) => { events.push(event); return true; },
    track: (p: Promise<unknown>) => { pending.push(p); return p; }, failed: (error: unknown) => { throw error; },
  });
  actor.update(); await Promise.all(pending); actor.stop();
  assert.deepEqual(options, [{ filter: "id=eq.deck", current: true, confirmed: true }]);
  assert.deepEqual(events, [{ type: "signal:removed" }]);
});
Deno.test("hatch lint preserves snake_case and numbered correlation props", async () => {
  const { hatchSites, hatchLint } = await import("./lint.ts");
  const sites = hatchSites('<div data-live="form" data-reads="draft"><div data-hatch="drafting" data-prop-set_id="{set_id}" data-prop-run2="{run}"></div></div>');
  assert.deepEqual(sites[0].props, ["set_id", "run2"]);
  assert.deepEqual(hatchLint(sites, { drafting: { ports: { reads: ["form"], raises: [] }, memo: { table: "draft", key: ["set_id", "run2"], columns: ["set_id", "run2"] } } }), []);
});
