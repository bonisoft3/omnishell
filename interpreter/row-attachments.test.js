import assert from "node:assert/strict";
import { parseHTML } from "npm:linkedom@0.18.4";
import { createRowAttachments } from "./row-attachments.js";
import { batched } from "./batched-store.js";

Deno.test("leases count independently and register and unregister while active", () => {
  const binding = { via: "rows", screen: "any", lifetime: "attachment", charts: { basic: { field: "status", states: {} } } };
  const hub = createRowAttachments({ rows: binding });
  const seen = [];
  const first = hub.attach(binding, { src: "rows" });
  const unregister = hub.register("rows", { start: () => seen.push("start"), stop: () => seen.push("stop") });
  const second = hub.attach(binding, { src: "rows" });
  first(); first();
  assert.equal(hub.active("rows"), true);
  unregister(); unregister();
  assert.deepEqual(seen, ["start", "stop"]);
  second();
  assert.equal(hub.active("rows"), false);
  hub.validate("rows", "any", { states: {}, field: "status" });
  assert.throws(() => hub.validate("rows", "any", { field: "other", states: {} }), /undeclared chart/);
  assert.throws(() => hub.validate("rows", "other", { field: "status", states: {} }), /wrong screen/);
  assert.throws(() => hub.active("missing"), /Undeclared/);
  assert.throws(() => hub.register("missing", { start() {}, stop() {} }), /Undeclared/);
  assert.throws(() => hub.register("rows", { start() {}, stop() {} }, "other"), /wrong screen/);
  assert.throws(() => hub.attach({ ...binding, screen: "other" }, { src: "rows" }), /wrong screen/);
});

Deno.test({
  name: "mounted row machines run only under their attachment and invalidate old work",
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    await import("./vendor/ses.umd.min.js");
    const { interpretScreen } = await import("./screen.js");
    const { document, Event } = parseHTML("<!doctype html><html><head></head><body><div id='shell'></div></body></html>");
    const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
    globalThis.document = document;
    const chart = { field: "status", initial: "idle", states: {
      idle: { on: { click: "watching" } },
      watching: { invoke: { src: "watch" }, after: { 70: "timed" }, on: { "signal:done": "done" } },
      done: {}, timed: {},
    } };
    const chartGroup = [chart, { field: "phase", initial: "rest", states: { rest: {} } }];
    const html = `<section class="screen"><button id="seat" data-live="form" data-filter="id=eq.draft" data-status="{status}" data-cortex="rowFamily" data-machine-ref="main">Go</button><button id="second" data-live="form2" data-filter="id=eq.other" data-cortex="rowFamily" data-machine='${JSON.stringify(chartGroup)}'>Go</button></section>`;
    globalThis.fetch = url => Promise.resolve(new Response(String(url).endsWith(".css") ? "" : html));
    const tables = { form: [{ id: "draft", status: "idle", key: "job" }], form2: [{ id: "other", status: "idle", key: "job2" }], jobs: [{ id: "job", status: "done" }, { id: "job2", status: "waiting" }] };
    const listeners = new Map(), writes = [];
    let hold, entered;
    const notify = table => { for (const f of listeners.get(table) ?? []) f(); };
    const base = {
      query: async table => {
        const rows = tables[table].map(row => ({ ...row }));
        if (table === "jobs" && hold) { entered(); await hold; }
        return rows;
      },
      subscribe(table, fn) {
        const set = listeners.get(table) ?? new Set(); listeners.set(table, set); set.add(fn);
        return () => set.delete(fn);
      },
      async put(table, row, _refused, absent) {
        const index = tables[table].findIndex(item => item.id === row.id);
        if (index < 0) tables[table].push({ ...absent, ...row });
        else tables[table][index] = { ...tables[table][index], ...row };
        writes.push({ table, row }); notify(table);
      },
    };
    const hub = createRowAttachments({ rowFamily: { via: "rows", screen: "sample", lifetime: "attachment", charts: { main: chartGroup } } });
    const chartBindings = { rowFamily: { via: "rows", screen: "sample", lifetime: "attachment", charts: { main: chartGroup } } };
    const opts = { chartBindings, rowAttachments: hub, actors: { watch: { via: "observe", table: "jobs", field: "status", match: { id: "key" }, event: "signal:" } } };
    const route = { screen: "sample", files: { html: "sample.html", css: "sample.css", handlers: [] } };
    let screen;
    try {
      screen = await interpretScreen(document.getElementById("shell"), "http://localhost/", route, batched(base), {}, opts);
      await screen.settle();
      document.getElementById("seat").dispatchEvent(new Event("click"));
      await screen.settle();
      assert.equal(tables.form[0].status, "idle");
      let release;
      const started = new Promise(resolve => { entered = resolve; });
      hold = new Promise(resolve => { release = resolve; });
      const detach = hub.attach({ via: "rows", screen: "sample", lifetime: "attachment" }, { src: "rowFamily" });
      document.getElementById("seat").dispatchEvent(new Event("click"));
      await started;
      document.getElementById("second").dispatchEvent(new Event("click"));
      while (tables.form2[0].status !== "watching") await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(listeners.get("jobs").size, 2);
      assert.equal(tables.form[0].status, "watching");
      detach();
      assert.equal(listeners.get("jobs").size, 0);
      release(); hold = undefined;
      await new Promise(resolve => setTimeout(resolve, 90));
      await screen.settle();
      assert.equal(tables.form[0].status, "watching");
      document.getElementById("seat").dispatchEvent(new Event("click"));
      await screen.settle();
      assert.equal(tables.form[0].status, "watching");
      const again = hub.attach({ via: "rows", screen: "sample", lifetime: "attachment" }, { src: "rowFamily" });
      await screen.settle();
      assert.equal(tables.form[0].status, "done");
      assert.equal(tables.form2[0].status, "watching");
      assert.deepEqual(writes.map(w => w.row.status), ["watching", "watching", "done"]);
      screen.pause();
      again();
      tables.form[0] = { ...tables.form[0], status: "watching" };
      tables.jobs[0].status = "waiting";
      const pausedLease = hub.attach({ via: "rows", screen: "sample", lifetime: "attachment" }, { src: "rowFamily" });
      await new Promise(resolve => setTimeout(resolve, 90));
      assert.equal(tables.form[0].status, "watching");
      assert.equal(listeners.get("jobs").size, 0);
      await screen.resume();
      await new Promise(resolve => setTimeout(resolve, 90));
      await screen.settle();
      assert.equal(tables.form[0].status, "timed");
      pausedLease();
      screen.stop();
      tables.form[0].status = "idle";
      const wrongHub = createRowAttachments({ rowFamily: { via: "rows", screen: "sample", lifetime: "attachment", charts: { wrong: { field: "other", initial: "idle", states: { idle: {} } } } } });
      await assert.rejects(() => interpretScreen(document.getElementById("shell"), "http://localhost/", route, batched(base), {}, { chartBindings, rowAttachments: wrongHub }), /undeclared chart/);
      screen = await interpretScreen(document.getElementById("shell"), "http://localhost/", route, batched(base), {}, { chartBindings, mountUnits: false });
      await screen.settle();
      document.getElementById("seat").dispatchEvent(new Event("click"));
      await screen.settle();
      assert.equal(tables.form[0].status, "watching");
    } finally {
      screen?.stop(); globalThis.document = previousDocument; globalThis.fetch = previousFetch;
    }
  },
});

Deno.test("failed attachment startup rolls back every started listener and can retry", () => {
  const binding = { via: "rows", screen: "sample", lifetime: "attachment", charts: { chart: {} } };
  const hub = createRowAttachments({ rows: binding });
  const events = [];
  let fail = true;
  const first = hub.register("rows", { start: () => events.push("first:start"), stop: () => events.push("first:stop") });
  const second = hub.register("rows", { start() { events.push("second:start"); if (fail) throw new Error("startup"); }, stop: () => events.push("second:stop") });
  assert.throws(() => hub.attach(binding, { src: "rows" }), /startup/);
  assert.equal(hub.active("rows"), false);
  assert.deepEqual(events, ["first:start", "second:start", "second:stop", "first:stop"]);
  fail = false;
  const detach = hub.attach(binding, { src: "rows" });
  assert.equal(hub.active("rows"), true);
  detach(); first(); second();
  assert.deepEqual(events.slice(-4), ["first:start", "second:start", "first:stop", "second:stop"]);
});

Deno.test("failed registration cleans partial startup without disturbing the lease", () => {
  const binding = { via: "rows", screen: "sample", lifetime: "attachment", charts: { chart: {} } };
  const hub = createRowAttachments({ rows: binding });
  const detach = hub.attach(binding, { src: "rows" });
  const events = [];
  assert.throws(() => hub.register("rows", { start() { events.push("start"); throw new Error("startup"); }, stop() { events.push("stop"); } }), /startup/);
  assert.equal(hub.active("rows"), true);
  const unregister = hub.register("rows", { start() { events.push("retry"); }, stop() { events.push("release"); } });
  detach(); unregister();
  assert.deepEqual(events, ["start", "stop", "retry", "release"]);
});

Deno.test("startup reports cleanup failures while unwinding every listener", () => {
  const binding = { via: "rows", screen: "sample", lifetime: "attachment", charts: { chart: {} } };
  const hub = createRowAttachments({ rows: binding });
  let stopped = 0;
  hub.register("rows", { start() {}, stop() { stopped++; throw new Error("cleanup"); } });
  hub.register("rows", { start() { throw new Error("startup"); }, stop() { stopped++; } });
  assert.throws(() => hub.attach(binding, { src: "rows" }), error => error instanceof AggregateError && error.errors.length === 2);
  assert.equal(stopped, 2);
  assert.equal(hub.active("rows"), false);
});
