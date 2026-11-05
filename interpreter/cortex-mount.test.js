import assert from "node:assert/strict";
import { parseHTML } from "npm:linkedom@0.18.4";
import { batched } from "./batched-store.js";

Deno.test({
  name: "a mounted chart invokes correlated observation and detaches without stopping backend rows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { interpretScreen } = await import("./screen.js");
    const { document, Event } = parseHTML("<!doctype html><html><head></head><body><div id='shell'></div></body></html>");
    const previousDocument = globalThis.document;
    const previousFetch = globalThis.fetch;
    globalThis.document = document;
    const chart = { field: "status", initial: "idle", states: {
      idle: { on: { click: { target: "generating", assign: { set_id: "", run: "" } } } },
      generating: { invoke: { id: "progress", src: "progress" }, on: { leave: "idle", "signal:progress.done": { target: "done", reenter: false } } },
      done: { invoke: { id: "progress", src: "progress" }, on: { "signal:progress.failed": { target: "failed", reenter: false } } }, failed: {},
    } };
    const html = `<section class="screen" data-screen="generate">
      <div id="intent-seat" data-on-mutation="create" hidden data-live="form" data-filter="id=eq.draft"><template data-item><span></span></template></div>
      <button id="form-seat" data-live="form" data-filter="id=eq.draft" data-status="{status}" data-run="{run}" data-machine='${JSON.stringify(chart)}'>Create</button>
    </section>`;
    const handler = `(state, event) => {
      if (event.type === "mutation") {
        const form = state.items[0];
        return form?.status === "generating" && !form.set_id ? { updates: [], then: { type: "mint", uuid: true } } : { updates: [] };
      }
      if (event.type !== "mint" || typeof event.uuid !== "string") throw new Error("expected a minted UUID");
      return { updates: [
        { op: "put", entity: "jobs", id: "deck", row: { id: "deck", status: "running" } },
        { op: "put", entity: "form", id: "draft", row: { id: "draft", set_id: "deck", run: "run-1" } }
      ] };
    }`;
    globalThis.fetch = (url) => {
      const path = String(url);
      if (path.endsWith("generate.html")) return Promise.resolve(new Response(html));
      if (path.endsWith("generate.css")) return Promise.resolve(new Response(""));
      if (path.endsWith("create.js")) return Promise.resolve(new Response(handler));
      throw new Error(`unexpected fetch ${path}`);
    };
    const tables = { form: [{ id: "draft", status: "idle", set_id: "", run: "" }], jobs: [], progress: [] };
    const subscribers = new Map();
    const writes = [];
    const notify = (table) => { for (const cb of subscribers.get(table) ?? []) cb(); };
    let gateProgress;
    const base = {
      query: async (table, _order, opts) => {
        const rows = tables[table].map((row) => ({ ...row }));
        if (table === "progress" && opts?.current && gateProgress && ++gateProgress.calls === 1) {
          gateProgress.entered();
          await gateProgress.wait;
        }
        return rows;
      },
      subscribe: (table, cb, options = {}) => {
        const watched = [table, ...(options.reads ?? [])].map((name) => {
          const listeners = subscribers.get(name) ?? new Set();
          subscribers.set(name, listeners);
          listeners.add(cb);
          return listeners;
        });
        return () => watched.forEach((listeners) => listeners.delete(cb));
      },
      put: async (table, row, _refused, absent) => {
        const at = tables[table].findIndex((held) => held.id === row.id);
        if (at === -1) tables[table].push({ ...absent, ...row });
        else tables[table][at] = { ...tables[table][at], ...row };
        writes.push({ table, row: { ...row } });
        notify(table);
      },
    };
    const options = {
      schema: Object.fromEntries(Object.keys(tables).map((table) => [table, { fields: [{ name: "id", type: "string", pk: true }] }])),
      actors: { progress: { via: "observe", table: "progress", field: "status", match: { id: "set_id", run: "run" }, event: "signal:progress." } },
    };
    const route = { screen: "generate", files: { html: "generate.html", css: "generate.css", handlers: ["create.js"] }, states: ["populated"] };
    let screen;
    try {
      screen = await interpretScreen(document.getElementById("shell"), "http://localhost/", route, batched(base), {}, options);
      await screen.settle();
      assert.equal(subscribers.get("progress")?.size ?? 0, 0);
      document.getElementById("form-seat").dispatchEvent(new Event("click"));
      await screen.settle();
      assert.equal(tables.form[0].set_id, "deck");
      assert.equal(subscribers.get("progress").size, 1);
      assert.equal(writes.filter((w) => w.table === "jobs").length, 1);
      notify("form");
      await screen.settle();
      assert.equal(writes.filter((w) => w.table === "jobs").length, 1);
      tables.progress.push({ id: "deck", run: "run-1", status: "done", txid: "4" });
      notify("progress");
      await screen.settle();
      assert.equal(tables.form[0].status, "done");
      assert.equal(document.getElementById("form-seat").getAttribute("data-status"), "done");

      // A snapshot already read for one run cannot settle a later attachment.
      let release, entered;
      const waiting = new Promise((resolve) => { entered = resolve; });
      gateProgress = { calls: 0, entered, wait: new Promise((resolve) => { release = resolve; }) };
      tables.progress[0] = { ...tables.progress[0], status: "failed", txid: "5" };
      notify("progress");
      await waiting;
      tables.form[0] = { ...tables.form[0], status: "generating", set_id: "new-deck", run: "run-2" };
      notify("form");
      for (let i = 0; i < 100 && document.getElementById("form-seat").getAttribute("data-run") !== "run-2"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.equal(document.getElementById("form-seat").getAttribute("data-run"), "run-2");
      gateProgress = undefined;
      release();
      await screen.settle();
      assert.equal(tables.form[0].status, "generating");
      assert.equal(tables.form[0].run, "run-2");
      screen.pause();
      assert.equal(subscribers.get("progress").size, 0);
      const before = writes.length;
      tables.progress[0] = { ...tables.progress[0], status: "failed", txid: "5" };
      notify("progress");
      await screen.settle();
      assert.equal(writes.length, before);
      assert.equal(tables.jobs[0].status, "running");
      await screen.resume();
      await screen.settle();
      assert.equal(subscribers.get("progress").size, 1);
      document.getElementById("form-seat").dispatchEvent(new Event("leave"));
      await screen.settle();
      assert.equal(subscribers.get("progress").size, 0);
      tables.progress[0] = { id: "new-deck", run: "run-2", status: "done", txid: "6" };
      notify("progress");
      await screen.settle();
      assert.equal(tables.form[0].status, "idle");
    } finally {
      screen?.stop();
      globalThis.document = previousDocument;
      globalThis.fetch = previousFetch;
    }
  },
});

for (const initialState of [undefined, ""]) Deno.test({
  name: `an existing row with ${initialState === undefined ? "missing" : "empty"} state attaches its initial observer and receives facts`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { interpretScreen } = await import("./screen.js");
    const { document } = parseHTML("<html><head></head><body><main id='shell'></main></body></html>");
    const previousDocument = globalThis.document;
    const previousFetch = globalThis.fetch;
    const chart = { field: "status", initial: "waiting", states: {
      waiting: { invoke: { src: "progress" }, on: { "signal:progress.done": "done" } }, done: {},
    } };
    const rows = { form: [{ id: "draft", set_id: "deck", ...(initialState === undefined ? {} : { status: initialState }) }], progress: [{ id: "deck", status: "done" }] };
    const subscriptions = new Map();
    const base = {
      query: async (table) => rows[table].map((row) => ({ ...row })),
      subscribe(table, fn) { const listeners = subscriptions.get(table) ?? new Set(); listeners.add(fn); subscriptions.set(table, listeners); return () => listeners.delete(fn); },
      async put(table, row) { Object.assign(rows[table].find((entry) => entry.id === row.id), row); for (const fn of subscriptions.get(table) ?? []) fn(); },
    };
    globalThis.document = document;
    globalThis.fetch = async (url) => new Response(String(url).endsWith(".css") ? "" : `<section data-screen="generate"><div data-live="form" data-filter="id=eq.draft" data-machine='${JSON.stringify(chart)}'></div></section>`);
    let screen;
    try {
      screen = await interpretScreen(document.getElementById("shell"), "http://localhost/", { screen: "generate", files: { html: "generate.html", css: "generate.css", handlers: [] }, states: ["populated"] }, batched(base), {}, {
        schema: { form: { fields: [{ name: "id", type: "string", pk: true }] }, progress: { fields: [{ name: "id", type: "string", pk: true }] } },
        actors: { progress: { via: "observe", table: "progress", field: "status", match: { id: "set_id" }, event: "signal:progress." } },
      });
      await screen.settle();
      assert.equal(rows.form[0].status, "done");
    } finally {
      await screen?.stop();
      globalThis.document = previousDocument;
      globalThis.fetch = previousFetch;
    }
  },
});

for (const changedIdentity of [true, false]) Deno.test({
  name: changedIdentity ? "an old source read cannot settle a receiver changed before its render wake" : "an observer reduces the current receiver even before its render wake",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { interpretScreen } = await import("./screen.js");
    const { document } = parseHTML("<html><head></head><body><main id='shell'></main></body></html>");
    const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
    const chart = { field: "status", initial: "generating", states: {
      generating: { invoke: { src: "progress" }, on: { "signal:progress.done": { target: "done", guard: "admit", assign: { run: "run-4" } } } }, done: {},
    } };
    const rows = { form: [{ id: "draft", status: "generating", set_id: "old-deck", run: "run-4", allow: "no" }], progress: [{ id: "old-deck", run: "run-4", status: "done" }] };
    const subscribers = new Map();
    let release, entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const hold = new Promise((resolve) => { release = resolve; });
    const base = {
      async query(table, _order, options) {
        const result = rows[table].map((row) => ({ ...row }));
        if (table === "progress" && options?.current) { entered(); await hold; }
        return result;
      },
      subscribe(table, fn) { const group = subscribers.get(table) ?? new Set(); group.add(fn); subscribers.set(table, group); return () => group.delete(fn); },
      async put(table, row) { Object.assign(rows[table].find((held) => held.id === row.id), row); for (const fn of subscribers.get(table) ?? []) fn(); },
    };
    globalThis.document = document;
    globalThis.fetch = async (url) => new Response(String(url).endsWith(".css") ? "" : String(url).endsWith("admit.js") ? '(state) => state.items[0].allow === "yes"' : `<section data-screen="generate"><div data-live="form" data-filter="id=eq.draft" data-reads="form" data-machine='${JSON.stringify(chart)}'></div></section>`);
    let screen;
    try {
      screen = await interpretScreen(document.getElementById("shell"), "http://localhost/", { screen: "generate", files: { html: "generate.html", css: "generate.css", handlers: ["admit.js"] }, states: ["populated"] }, batched(base), {}, {
        schema: { form: { fields: [{ name: "id", type: "string", pk: true }] }, progress: { fields: [{ name: "id", type: "string", pk: true }] } },
        actors: { progress: { via: "observe", table: "progress", field: "status", match: { id: "set_id", run: "run" }, event: "signal:progress." } },
      });
      await started;
      rows.form[0] = changedIdentity
        ? { id: "draft", status: "generating", set_id: "new-deck", run: "run-5", allow: "yes" }
        : { id: "draft", status: "generating", set_id: "old-deck", run: "run-4", allow: "yes" };
      release();
      await screen.settle();
      assert.deepEqual(rows.form[0], changedIdentity
        ? { id: "draft", status: "generating", set_id: "new-deck", run: "run-5", allow: "yes" }
        : { id: "draft", status: "done", set_id: "old-deck", run: "run-4", allow: "yes" });
    } finally {
      release();
      await screen?.stop();
      globalThis.document = previousDocument;
      globalThis.fetch = previousFetch;
    }
  },
});
