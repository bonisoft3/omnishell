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
    const handler = `({ context, event }) => {
      if (event.type === "mutation") {
        const form = context.items[0];
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
      answer: (table) => tables[table].map((row) => ({ ...row })),
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
      answer: (table) => rows[table].map((row) => ({ ...row })),
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
      answer: (table) => rows[table].map((row) => ({ ...row })),
      async query(table, _order, options) {
        const result = rows[table].map((row) => ({ ...row }));
        if (table === "progress" && options?.current) { entered(); await hold; }
        return result;
      },
      subscribe(table, fn) { const group = subscribers.get(table) ?? new Set(); group.add(fn); subscribers.set(table, group); return () => group.delete(fn); },
      async put(table, row) { Object.assign(rows[table].find((held) => held.id === row.id), row); for (const fn of subscribers.get(table) ?? []) fn(); },
    };
    globalThis.document = document;
    globalThis.fetch = async (url) => new Response(String(url).endsWith(".css") ? "" : String(url).endsWith("admit.js") ? '({ context }) => context.items[0].allow === "yes"' : `<section data-screen="generate"><div data-live="form" data-filter="id=eq.draft" data-reads="form" data-machine='${JSON.stringify(chart)}'></div></section>`);
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

// A chart observing a row that stands at `asking`, mounted on the state that
// invokes the observation. `told` counts the signal arrows the chart took.
async function observing(states, run, inner = "", root = {}, form = [{ id: "draft", status: "waiting", ask: "q1", flag: "on" }]) {
  await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
  const { interpretScreen } = await import("./screen.js");
  const { document, Event } = parseHTML("<html><head></head><body><main id='shell'></main></body></html>");
  const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
  const chart = { field: "status", initial: "waiting", ...root, states };
  const rows = { form, quote: [{ id: "q1", status: "asking", txid: "4" }, { id: "q2", status: "asking", txid: "4" }], first: [], second: [] };
  const subscribers = new Map();
  const notify = (table) => { for (const fn of subscribers.get(table) ?? []) fn(); };
  // A write to a held table waits for its release, as one the store is still
  // preparing does.
  const gates = new Map();
  // One read held back, as a refresh whose query is slow: later reads pass it.
  let slow;
  // The next write to the chart's table is refused before the store applies it.
  let refuse = false;
  // What the store holds to call later, as one that refuses after accepting:
  // each accepted write's refusal callback, newest last.
  const refusals = [];
  // The next read of the chart's row fails.
  let failRead = false;
  const base = {
    query: async (table, _order, options) => {
      if (table === "form" && slow) { const wait = slow; slow = undefined; await wait; }
      if (table === "form" && options?.current && failRead) { failRead = false; throw new Error("read failed"); }
      return rows[table].map((row) => ({ ...row }));
    },
    // The store answering at once from what it holds, as the tab's store does.
    answer: (table) => rows[table]?.map((row) => ({ ...row })),
    subscribe(table, fn) { const group = subscribers.get(table) ?? new Set(); group.add(fn); subscribers.set(table, group); return () => group.delete(fn); },
    async put(table, row, refused) {
      if (table === "form") refusals.push(refused);
      await gates.get(table);
      if (table === "form" && refuse) { refuse = false; throw Object.assign(new Error("refused"), { name: "NonRetriableError" }); }
      Object.assign(rows[table].find((held) => held.id === row.id), row);
      notify(table);
    },
    async create(table, row) { await gates.get(table); rows[table].push({ ...row }); notify(table); },
  };
  const trace = [];
  globalThis.__prontoMachineTrace = trace;
  globalThis.document = document;
  globalThis.fetch = async (url) => new Response(String(url).endsWith(".css") ? "" : String(url).endsWith("row-is.js") ? "({ context }, params) => Object.entries(params).every(([column, value]) => context.items[0][column] === value)" : `<section data-screen="home"><div id="seat" data-live="form" data-filter="id=eq.draft" data-machine='${JSON.stringify(chart)}'>${inner}</div></section>`);
  let screen;
  try {
    screen = await interpretScreen(document.getElementById("shell"), "http://localhost/", { screen: "home", files: { html: "home.html", css: "home.css", handlers: ["row-is.js"] }, states: ["populated"] }, batched(base), {}, {
      schema: Object.fromEntries(Object.keys(rows).map((table) => [table, { fields: [{ name: "id", type: "string", pk: true }] }])),
      actors: { quote: { via: "observe", table: "quote", field: "status", match: { id: "ask" }, event: "signal:quote." } },
    });
    await run({
      screen, rows,
      told: () => trace.filter((step) => step.key.startsWith("signal:")).length,
      ticked: () => trace.filter((step) => step.key.startsWith("after:")).length,
      fire: (type) => document.getElementById("seat").dispatchEvent(new Event(type)),
      answer(status) { rows.quote[0] = { ...rows.quote[0], status, txid: String(Number(rows.quote[0].txid) + 1) }; notify("quote"); },
      seat: () => document.getElementById("seat"),
      took: () => trace.map((step) => step.key),
      // The row moved by somebody else: a fold, another tab.
      move(columns) { rows.form[0] = { ...rows.form[0], ...columns }; notify("form"); },
      hold(table) { let release; gates.set(table, new Promise((resolve) => { release = () => { gates.delete(table); resolve(); }; })); return release; },
      holdRead() { let release; slow = new Promise((resolve) => { release = resolve; }); return release; },
      refuseNext() { refuse = true; },
      observers: () => subscribers.get("quote")?.size ?? 0,
      // The last accepted write to the chart's row withdrawn after the fact.
      withdrawLast(columns) {
        rows.form[0] = { ...rows.form[0], ...columns };
        refusals.at(-1)(Object.assign(new Error("refused"), { name: "NonRetriableError" }));
        notify("form");
      },
      failNextRead() { failRead = true; },
      reorder(list) { rows.form = list.map((row) => ({ ...row })); notify("form"); },
      until: async (met) => { for (let i = 0; i < 300 && !met(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); },
    });
  } finally {
    try { await screen?.stop(); } finally {
      delete globalThis.__prontoMachineTrace;
      globalThis.document = previousDocument;
      globalThis.fetch = previousFetch;
    }
  }
}

// Each of these restarted its observation by what the observation said: the
// fresh one read the same row, said it again, and the page never came to rest.
// A lint on the first shape would have passed the other two.
for (const [name, states, told] of [
  ["re-enters its own state", { waiting: { invoke: { src: "quote" }, on: { "signal:quote.asking": { target: "waiting", reenter: true }, "signal:quote.quoted": "quoted" } }, quoted: {} }, 1],
  ["leaves and returns through an always hop", {
    waiting: { invoke: { src: "quote" }, on: { "signal:quote.asking": "hop", "signal:quote.quoted": "quoted" } },
    hop: { always: [{ target: "waiting" }] }, quoted: {},
  }, 1],
  ["moves to a second state invoking the same source", {
    waiting: { invoke: { src: "quote" }, on: { "signal:quote.asking": "polling", "signal:quote.quoted": "quoted" } },
    polling: { invoke: { src: "quote" }, on: { "signal:quote.asking": "waiting", "signal:quote.quoted": "quoted" } }, quoted: {},
  }, 1],
  ["keeps its state entered", { waiting: { invoke: { src: "quote" }, on: { "signal:quote.asking": { target: "waiting", reenter: false }, "signal:quote.quoted": "quoted" } }, quoted: {} }, 1],
  ["draws no arrow for what the row says", { waiting: { invoke: { src: "quote" }, on: { "signal:quote.quoted": "quoted" } }, quoted: {} }, 0],
]) Deno.test({
  name: `an observation is told once to a chart that ${name}, and its next answer is still heard`,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => observing(states, async ({ screen, rows, told: taken, answer }) => {
    await screen.settle();
    assert.equal(taken(), told);
    answer("quoted");
    await screen.settle();
    assert.equal(rows.form[0].status, "quoted");
  }),
});

// What an observation says is withheld only from the run it caused. Any other
// way back into the state is a restart somebody asked for, and it reads the row.
Deno.test({
  name: "an observation restarted by a gesture, by a timer or by a later return says the row again",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const heard = { "signal:quote.asking": { target: "waiting", reenter: false } };
    await observing({ waiting: { invoke: { src: "quote" }, on: { ...heard, click: { target: "waiting", reenter: true } } } }, async ({ screen, told, fire }) => {
      await screen.settle();
      assert.equal(told(), 1);
      fire("click");
      await screen.settle();
      assert.equal(told(), 2);
    });
    await observing({ waiting: { invoke: { src: "quote" }, on: { ...heard, leave: "idle" } }, idle: { on: { enter: "waiting" } } }, async ({ screen, told, fire }) => {
      await screen.settle();
      fire("leave");
      await screen.settle();
      assert.equal(told(), 1);
      fire("enter");
      await screen.settle();
      assert.equal(told(), 2);
    });
    await observing({ waiting: { invoke: { src: "quote" }, on: heard, after: { 20: { target: "waiting", reenter: true } } } }, async ({ screen, told }) => {
      await screen.settle();
      for (let i = 0; i < 200 && told() < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(told(), 2);
    });
  },
});

Deno.test({
  name: "observations that keep restarting each other over unchanged rows end in a named error",
  sanitizeOps: false,
  sanitizeResources: false,
  // Each delivery moves the identity the next observer reads by, so neither
  // was started by a snapshot of its own row and both read afresh, forever.
  fn: () => observing({
    waiting: { invoke: { src: "quote" }, on: { "signal:quote.asking": { target: "other", assign: { ask: "q2" } } } },
    other: { invoke: { src: "quote" }, on: { "signal:quote.asking": { target: "waiting", assign: { ask: "q1" } } } },
  }, async ({ screen, told }) => {
    await assert.rejects(() => screen.settle(), /observation "quote" told form\.status "signal:quote\.asking" 8 times with its source unchanged/);
    assert.equal(told(), 16);
  }),
});

Deno.test({
  name: "a metronome over a state holding an observation keeps firing",
  sanitizeOps: false,
  sanitizeResources: false,
  // Each tick restarts the observation, whose delivery arrives while the
  // tick's write is still going out: the timer belongs to the state, and the
  // delivery's turn must not take it away, or it dies after one beat.
  fn: () => observing({ waiting: {
    invoke: { src: "quote" },
    on: { "signal:quote.asking": { target: "waiting", reenter: false } },
    after: { 20: { target: "waiting", reenter: true } },
  } }, async ({ screen, ticked }) => {
    await screen.settle();
    for (let i = 0; i < 200 && ticked() < 4; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(ticked() >= 4, `the timer fired ${ticked()} time(s)`);
  }),
});

// A column somebody else writes reaches the chart's `always` guards on its
// next row, on a list region as on a slot.
for (const [shape, inner] of [["slot", '<button id="go">Go</button>'], ["list", '<template data-item><button id="go">Go</button></template>']]) Deno.test({
  name: `an outside write reaches an always guard after the chart has moved, on a ${shape} region`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { interpretScreen } = await import("./screen.js");
    const { document, Event } = parseHTML("<html><head></head><body><main id='shell'></main></body></html>");
    const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
    const chart = { field: "status", initial: "idle", states: {
      idle: { on: { click: "running" } },
      running: { always: [{ guard: { type: "row-is", params: { ended: "done" } }, target: "done" }] }, done: {},
    } };
    const rows = { job: [{ id: "one", status: "idle", ended: "" }] };
    const subscribers = new Map();
    const notify = (table) => { for (const fn of subscribers.get(table) ?? []) fn(); };
    const base = {
      answer: (table) => rows[table].map((row) => ({ ...row })),
      query: async (table) => rows[table].map((row) => ({ ...row })),
      subscribe(table, fn) { const group = subscribers.get(table) ?? new Set(); group.add(fn); subscribers.set(table, group); return () => group.delete(fn); },
      async put(table, row) { Object.assign(rows[table].find((held) => held.id === row.id), row); notify(table); },
    };
    globalThis.document = document;
    globalThis.fetch = async (url) => new Response(String(url).endsWith(".css") ? "" : String(url).endsWith("row-is.js") ? "({ context }, params) => Object.entries(params).every(([column, value]) => context.items[0][column] === value)" : `<section data-screen="home"><div data-live="job" data-filter="id=eq.one" data-machine='${JSON.stringify(chart)}'>${inner}</div></section>`);
    let screen;
    try {
      screen = await interpretScreen(document.getElementById("shell"), "http://localhost/", { screen: "home", files: { html: "home.html", css: "home.css", handlers: ["row-is.js"] }, states: ["populated"] }, batched(base), {}, {
        schema: { job: { fields: [{ name: "id", type: "string", pk: true }] } },
      });
      await screen.settle();
      document.getElementById("go").dispatchEvent(new Event("click", { bubbles: true }));
      await screen.settle();
      assert.equal(rows.job[0].status, "running");
      rows.job[0] = { ...rows.job[0], ended: "done" };
      notify("job");
      await screen.settle();
      assert.equal(rows.job[0].status, "done");
    } finally {
      await screen?.stop();
      globalThis.document = previousDocument;
      globalThis.fetch = previousFetch;
    }
  },
});

// A write and its effects are still going out while a timer, an
// acknowledgement or a refresh arrives. What follows holds each to what is its
// own.
const effect = (entity) => ({ op: "create", entity, values: { id: "one" } });

Deno.test({
  name: "a timer's way into a second observing state is told the row while a delivery's effect is still going out",
  sanitizeOps: false,
  sanitizeResources: false,
  // The delivery re-enters `waiting` and waits on its effect. The timer that
  // then enters `polling` was not caused by that delivery, so the observer it
  // starts owes the chart the row, which is what selects `done`.
  fn: () => observing({
    waiting: { invoke: { src: "quote" }, on: { "signal:quote.asking": { target: "waiting", reenter: true, effect: effect("first") } }, after: { 50: "polling" } },
    polling: { invoke: { src: "quote" }, on: { "signal:quote.asking": "done" } }, done: {},
  }, async ({ screen, rows, hold, until, told }) => {
    const release = hold("first");
    await until(() => rows.form[0].status !== "waiting" && told() >= 2);
    release();
    await screen.settle();
    assert.equal(rows.form[0].status, "done");
  }),
});

Deno.test({
  name: "effects finishing late do not take the timer from the state the chart has since entered",
  sanitizeOps: false,
  sanitizeResources: false,
  // The click's run enters `pending` and is still writing its second effect
  // when the first one's acknowledgement enters `done` and arms its timer.
  fn: () => observing({
    waiting: { on: { click: { target: "pending", effect: [effect("first"), effect("second")] } } },
    pending: { on: { sync_ack: "done" } },
    done: { after: { 100: "complete" } }, complete: {},
  }, async ({ screen, rows, hold, until, fire }) => {
    await screen.settle();
    const release = hold("second");
    fire("click");
    await until(() => rows.form[0].status === "done");
    assert.equal(rows.form[0].status, "done");
    release();
    await until(() => rows.form[0].status === "complete");
    assert.equal(rows.form[0].status, "complete");
  }),
});

Deno.test({
  name: "a polling timer keeps an observation's repeats from counting as a loop, across a rewire",
  sanitizeOps: false,
  sanitizeResources: false,
  // The outside move rewires the region, and the timer it arms belongs to the
  // new wiring while the observers were made by the first: what they count
  // and what the timer clears has to be the chart's, not a wiring's.
  fn: () => observing({
    waiting: { invoke: { src: "quote" }, on: { "signal:quote.asking": { target: "waiting", reenter: false } } },
    polling: { invoke: { src: "quote" }, on: { "signal:quote.asking": { target: "polling", reenter: false } }, after: { 20: { target: "polling", reenter: true } } },
  }, async ({ screen, move, until, ticked, told }) => {
    await screen.settle();
    move({ status: "polling" });
    await until(() => ticked() >= 12);
    await screen.settle();
    assert.ok(ticked() >= 12 && told() >= 12, `${ticked()} tick(s), told ${told()} time(s)`);
  }),
});

for (const [shape, inner] of [["slot", ""], ["list", "<template data-item><span></span></template>"]]) Deno.test({
  name: `a row read while the chart's own write is going out does not take it back, on a ${shape} region`,
  sanitizeOps: false,
  sanitizeResources: false,
  // The row the region reads is older than the chart's move, and judged by
  // that row the timer of the state it left would still fire.
  fn: () => observing({
    waiting: { on: { click: "pending" }, after: { 40: "timeout" } }, pending: {}, timeout: {},
  }, async ({ screen, rows, hold, move, fire, took }) => {
    await screen.settle();
    const release = hold("form");
    fire("click");
    await new Promise((resolve) => setTimeout(resolve, 5));
    move({});
    await new Promise((resolve) => setTimeout(resolve, 120));
    release();
    await screen.settle();
    assert.deepEqual(took(), ["click"]);
    assert.equal(rows.form[0].status, "pending");
  }, inner),
});

Deno.test({
  name: "what a chart remembers of an observation is its current snapshot, not its history",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => observing({ waiting: { invoke: { src: "quote" } } }, async ({ screen, seat, answer }) => {
    await screen.settle();
    for (let i = 0; i < 20; i++) { answer(`step-${i}`); await screen.settle(); }
    assert.equal(seat()._prontoMachine_status_chart.heard.size, 1);
  }),
});

// A row somebody else moved is the chart entering a state as surely as an
// arrow of its own, whatever of the chart's is still going out.
Deno.test({
  name: "an observer started by an outside move is told the row while a delivery's effect is still going out",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => observing({
    waiting: { invoke: { src: "quote" }, on: { "signal:quote.asking": { target: "pending", effect: effect("first") } } },
    pending: {}, polling: { invoke: { src: "quote" }, on: { "signal:quote.asking": "done" } }, done: {},
  }, async ({ screen, rows, hold, move, until }) => {
    const release = hold("first");
    await until(() => rows.form[0].status === "pending");
    move({ status: "polling" });
    await until(() => rows.form[0].status === "done");
    release();
    await screen.settle();
    assert.equal(rows.form[0].status, "done");
  }),
});

Deno.test({
  name: "effects finishing late do not take the timer from a state an outside move entered",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => observing({
    waiting: { on: { click: { target: "pending", effect: effect("first") } } }, pending: {},
    done: { on: { sync_ack: { assign: { ask: "acknowledged" } } }, after: { 100: "complete" } }, complete: {},
  }, async ({ screen, rows, hold, move, until, fire }) => {
    await screen.settle();
    const release = hold("first");
    fire("click");
    await until(() => rows.form[0].status === "pending");
    move({ status: "done" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await until(() => rows.form[0].status === "complete");
    assert.equal(rows.form[0].status, "complete");
    assert.equal(rows.form[0].ask, "acknowledged");
  }),
});

Deno.test({
  name: "an observation restarted by each new outside fact is not a loop",
  sanitizeOps: false,
  sanitizeResources: false,
  // A fold keeps changing a column the chart's `always` arrows read, and each
  // way back into `waiting` starts an observer that says the unchanged row.
  fn: () => observing({
    waiting: { invoke: { src: "quote" }, on: { "signal:quote.asking": { target: "waiting", reenter: false } }, always: [{ guard: { type: "row-is", params: { flag: "off" } }, target: "idle" }] },
    idle: { always: [{ guard: { type: "row-is", params: { flag: "on" } }, target: "waiting" }] },
  }, async ({ screen, rows, move, told }) => {
    await screen.settle();
    for (let i = 0; i < 10; i++) {
      move({ flag: "off" });
      await screen.settle();
      assert.equal(rows.form[0].status, "idle");
      move({ flag: "on" });
      await screen.settle();
      assert.equal(rows.form[0].status, "waiting");
    }
    assert.equal(told(), 11);
  }),
});

Deno.test({
  name: "effects finishing late do not take the timer from a state the chart first met in a delivery",
  sanitizeOps: false,
  sanitizeResources: false,
  // The row is moved to `done` while the refresh that would show it is still
  // reading, so the first the chart sees of it is the row an observation's
  // delivery is handed. That arrow enters nothing; the entry is the move.
  fn: () => observing({
    waiting: { after: { 30: { target: "pending", effect: effect("first") } } }, pending: {},
    done: { after: { 100: "complete" } }, complete: {},
  }, async ({ screen, rows, hold, holdRead, move, answer, until }) => {
    const release = hold("first");
    await until(() => rows.form[0].status === "pending");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const read = holdRead();
    move({ status: "done" });
    answer("noted");
    await until(() => rows.form[0].ask === "noted");
    assert.equal(rows.form[0].ask, "noted");
    read();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await until(() => rows.form[0].status === "complete");
    assert.equal(rows.form[0].status, "complete");
    await screen.settle();
  }, "", { invoke: { src: "quote" }, on: { "signal:quote.noted": { assign: { ask: "noted" } } } }),
});

// A chart takes its next turn from the row the store holds, so nothing it
// concludes rests on a write the store refused.
Deno.test({
  name: "after a refused write the chart's next gesture is taken from the row the store holds",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => observing({
    waiting: { on: { click: "moved" } },
    moved: { on: { click: { target: "further", effect: effect("first") } } }, further: {},
  }, async ({ screen, rows, hold, fire, refuseNext }) => {
    await screen.settle();
    const release = hold("form");
    refuseNext();
    fire("click");
    fire("click");
    release();
    await screen.settle();
    assert.equal(rows.form[0].status, "moved");
    assert.equal(rows.first.length, 0);
  }),
});

Deno.test({
  name: "a timer that came due while the chart waited is spent if the chart re-entered its state first",
  sanitizeOps: false,
  sanitizeResources: false,
  // The chart waits for the store to hold its write; meanwhile a reset is
  // queued and the old timer comes due behind it.
  fn: () => observing({
    waiting: { after: { 100: "timeout" }, on: { reset: "waiting", poke: { assign: { flag: "poked" } } } }, timeout: {},
  }, async ({ screen, rows, hold, fire }) => {
    await screen.settle();
    const release = hold("form");
    fire("poke");
    await new Promise((resolve) => setTimeout(resolve, 10));
    fire("reset");
    await new Promise((resolve) => setTimeout(resolve, 130));
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(rows.form[0].status, "waiting");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(rows.form[0].status, "timeout");
  }),
});

Deno.test({
  name: "every observer of a source a delivery restarts is told what it said",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => observing({
    waiting: { invoke: [{ src: "quote", id: "one" }, { src: "quote", id: "two" }], on: { "signal:quote.asking": { target: "waiting", reenter: true }, "signal:quote.quoted": "quoted" } },
    quoted: {},
  }, async ({ screen, rows, told, answer }) => {
    await screen.settle();
    assert.ok(told() <= 2, `told ${told()} times`);
    answer("quoted");
    await screen.settle();
    assert.equal(rows.form[0].status, "quoted");
  }),
});

Deno.test({
  name: "a delivery arriving after its region is gone moves nothing and restarts nothing",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { interpretScreen } = await import("./screen.js");
    const { document, Event } = parseHTML("<html><head></head><body><main id='shell'></main></body></html>");
    const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
    const chart = { field: "status", initial: "idle", states: {
      idle: { on: { click: "watching" } },
      watching: { invoke: { src: "quote" }, after: { 60: "late" }, on: { "signal:quote.noted": { assign: { ask: "noted" } } } },
      late: {},
    } };
    const rows = { parent: [{ id: "draft" }], form: [{ id: "draft", status: "idle", ask: "q1" }], quote: [{ id: "q1", status: "asking", txid: "1" }] };
    const subscribers = new Map();
    const notify = (table) => { for (const fn of subscribers.get(table) ?? []) fn(); };
    let held, entered;
    const base = {
      answer: (table) => rows[table].map((row) => ({ ...row })),
      async query(table, _order, options) {
        const result = rows[table].map((row) => ({ ...row }));
        if (table === "quote" && held) { const wait = held; held = undefined; entered(); await wait; }
        return result;
      },
      subscribe(table, fn) { const group = subscribers.get(table) ?? new Set(); group.add(fn); subscribers.set(table, group); return () => group.delete(fn); },
      async put(table, row) { Object.assign(rows[table].find((item) => item.id === row.id), row); notify(table); },
    };
    globalThis.document = document;
    globalThis.fetch = async (url) => new Response(String(url).endsWith(".css") ? "" : `<section data-screen="home"><ul data-live="parent"><template data-item><li><div id="seat" data-live="form" data-filter="id=eq.{id}" data-machine='${JSON.stringify(chart)}'></div></li></template></ul></section>`);
    const store = batched(base);
    let screen;
    try {
      screen = await interpretScreen(document.getElementById("shell"), "http://localhost/", { screen: "home", files: { html: "home.html", css: "home.css", handlers: [] }, states: ["populated"] }, store, {}, {
        schema: Object.fromEntries(Object.keys(rows).map((table) => [table, { fields: [{ name: "id", type: "string", pk: true }] }])),
        actors: { quote: { via: "observe", table: "quote", field: "status", match: { id: "ask" }, event: "signal:quote." } },
      });
      await screen.settle();
      document.getElementById("seat").dispatchEvent(new Event("click"));
      await screen.settle();
      assert.equal(rows.form[0].status, "watching");
      // The observer's read of its source is held while the item holding the
      // chart goes.
      let release;
      held = new Promise((resolve) => { release = resolve; });
      const reading = new Promise((resolve) => { entered = resolve; });
      rows.quote[0] = { ...rows.quote[0], status: "noted", txid: "2" };
      notify("quote");
      store.flushNotifications?.();
      await reading;
      rows.parent = [];
      notify("parent");
      // Not settle: it would wait on the held read.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(subscribers.get("quote")?.size ?? 0, 0);
      release();
      await screen.settle();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(subscribers.get("quote")?.size ?? 0, 0, "no observer restarted");
      assert.equal(rows.form[0].status, "watching", "no timer of the gone chart fired");
      assert.equal(rows.form[0].ask, "q1");
    } finally {
      await screen?.stop();
      globalThis.document = previousDocument;
      globalThis.fetch = previousFetch;
    }
  },
});

Deno.test({
  name: "an arrow with effects and no write performs its effects",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => observing({ waiting: { on: { click: { effect: effect("first") } } } }, async ({ screen, rows, fire }) => {
    await screen.settle();
    fire("click");
    await screen.settle();
    assert.equal(rows.first.length, 1);
    assert.equal(rows.form[0].status, "waiting");
  }),
});

Deno.test({
  name: "a write withdrawn after a read already showed it still stops the effects not yet sent",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => observing({
    waiting: { on: { click: { target: "moved", effect: [effect("first"), effect("second")] } } }, moved: {},
  }, async ({ screen, rows, hold, until, fire, move, withdrawLast }) => {
    await screen.settle();
    const release = hold("first");
    fire("click");
    await until(() => rows.form[0].status === "moved");
    // A read begun after the write landed takes it out of the overlay.
    move({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    withdrawLast({ status: "waiting" });
    release();
    await screen.settle().catch(() => {});
    assert.equal(rows.first.length, 1, "the effect already sent may finish");
    assert.equal(rows.second.length, 0, "the one after it is not sent");
  }),
});

Deno.test({
  name: "a list's chart judges the row in hand, not another row's columns over it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => observing({
    waiting: { on: { click: "moved" } },
    moved: { on: { go: [{ guard: { type: "row-is", params: { flag: "two" } }, target: "wrong" }] } }, wrong: {},
  }, async ({ screen, rows, hold, fire, reorder }) => {
    await screen.settle();
    const release = hold("form");
    fire("click");
    await new Promise((resolve) => setTimeout(resolve, 10));
    reorder([{ ...rows.form[1] }, { ...rows.form[0] }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    fire("go");
    release();
    await screen.settle();
    assert.ok(rows.form.every((row) => row.status !== "wrong"), JSON.stringify(rows.form));
  }, "<template data-item><span></span></template>", {}, [{ id: "draft", status: "waiting", ask: "q1", flag: "one" }, { id: "other", status: "waiting", ask: "q1", flag: "two" }]),
});

Deno.test({
  name: "a failed read after a refusal ends the chart's wait",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => observing({
    waiting: { on: { poke: { assign: { flag: "poked" } }, click: "moved" } }, moved: {},
  }, async ({ screen, rows, fire, refuseNext, failNextRead, until }) => {
    await screen.settle();
    refuseNext();
    failNextRead();
    fire("poke");
    await new Promise((resolve) => setTimeout(resolve, 10));
    fire("click");
    await until(() => rows.form[0].status === "moved");
    assert.equal(rows.form[0].status, "moved");
    await screen.settle().catch(() => {});
  }),
});

Deno.test({
  name: "a timer queued for one row is spent when its turn meets another",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => observing({
    waiting: { on: { poke: { assign: { flag: "poked" } } }, after: { 120: "timeout" } }, timeout: {},
  }, async ({ screen, rows, hold, fire, reorder }) => {
    await screen.settle();
    const release = hold("form");
    fire("poke");
    await new Promise((resolve) => setTimeout(resolve, 140));
    reorder([{ ...rows.form[1] }, { ...rows.form[0] }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(rows.form.find((row) => row.id === "other").status, "waiting", "the new receiver gets its own full interval");
    await new Promise((resolve) => setTimeout(resolve, 140));
    assert.equal(rows.form.find((row) => row.id === "other").status, "timeout");
  }, "<template data-item><span></span></template>", {}, [{ id: "draft", status: "waiting", ask: "q1" }, { id: "other", status: "waiting", ask: "q1" }]),
});

Deno.test({
  name: "an acknowledgement reaches only the row whose arrow sent the effect",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => observing({
    waiting: { on: { click: { target: "pending", effect: effect("first") } } },
    pending: { on: { sync_ack: "done" } }, done: {},
  }, async ({ screen, rows, hold, fire, reorder }) => {
    await screen.settle();
    const release = hold("first");
    fire("click");
    await new Promise((resolve) => setTimeout(resolve, 20));
    reorder([{ ...rows.form[1], status: "pending" }, { ...rows.form[0] }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await screen.settle();
    assert.equal(rows.form.find((row) => row.id === "other").status, "pending");
  }, "<template data-item><span></span></template>", {}, [{ id: "draft", status: "waiting", ask: "q1" }, { id: "other", status: "waiting", ask: "q1" }]),
});

Deno.test({
  name: "a list emptied of its row leaves its chart nothing to time or observe",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => observing({
    waiting: { invoke: { src: "quote" }, after: { 60: "timeout" } }, timeout: {},
  }, async ({ screen, seat, reorder, rows }) => {
    await screen.settle();
    reorder([]);
    await screen.settle();
    const chart = seat()._prontoMachine_status_chart;
    assert.deepEqual([chart.standing, chart.receiver], [undefined, undefined]);
    reorder([{ id: "draft", status: "waiting", ask: "q1" }]);
    await screen.settle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(rows.form[0].status, "timeout", "the row back is entered afresh");
  }, "<template data-item><span></span></template>"),
});

Deno.test({
  name: "a row with no state stands in the initial state's initial child, timers and observers included",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => observing({
    waiting: { initial: "child", states: { child: { invoke: { src: "quote" }, after: { 30: "done" }, on: { "signal:quote.quoted": "done" } } } },
    done: {},
  }, async ({ screen, rows }) => {
    await screen.settle();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(rows.form[0].status, "done");
  }, "", {}, [{ id: "draft", ask: "q1" }]),
});

Deno.test({
  name: "a chart on a region the tab can never answer is refused, naming the nesting that works",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { interpretScreen } = await import("./screen.js");
    const { document } = parseHTML("<html><head></head><body><main id='shell'></main></body></html>");
    const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
    const chart = { field: "status", initial: "a", states: { a: {} } };
    const rows = { found: [{ id: "one", status: "a" }] };
    const base = {
      answer: (table) => rows[table].map((row) => ({ ...row })),
      answers: () => false,
      query: async (table) => rows[table].map((row) => ({ ...row })),
      subscribe: () => () => {},
    };
    globalThis.document = document;
    globalThis.fetch = async (url) => new Response(String(url).endsWith(".css") ? "" : `<section data-screen="home"><div data-live="found" data-filter="id=eq.one" data-machine='${JSON.stringify(chart)}'></div></section>`);
    try {
      await assert.rejects(() => interpretScreen(document.getElementById("shell"), "http://localhost/", { screen: "home", files: { html: "home.html", css: "home.css", handlers: [] }, states: ["populated"] }, batched(base), {}, {
        schema: { found: { fields: [{ name: "id", type: "string", pk: true }] } },
      }).then((screen) => screen.settle()), /nest in each item a region of the row itself/);
    } finally {
      globalThis.document = previousDocument;
      globalThis.fetch = previousFetch;
    }
  },
});

Deno.test({
  name: "a slot whose read matches two rows stands for neither, as its render refuses it",
  sanitizeOps: false,
  sanitizeResources: false,
  // The render's refusal latches the screen's failure, which settle() would
  // rethrow before the click's work ran; time stands in for it.
  fn: () => observing({ waiting: { invoke: { src: "quote" }, on: { click: { target: "moved", effect: effect("first") } } }, moved: {} }, async ({ screen, rows, fire, reorder, observers }) => {
    await screen.settle();
    assert.equal(observers(), 1);
    reorder([...rows.form, { id: "other", status: "waiting", ask: "q1" }]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(observers(), 0, "what the chart observed for its one row stops");
    fire("click");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(rows.form.map((row) => row.status), ["waiting", "waiting"]);
    assert.equal(rows.first.length, 0);
    await screen.settle().catch(() => {});
  }),
});

Deno.test({
  name: "an event raised by one row's turn is spent when the chart meets the row that replaced it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => observing({
    waiting: { on: { click: { target: "pending", raise: "next" } } },
    pending: { on: { next: "done" } }, done: {},
  }, async ({ screen, rows, hold, fire, reorder }) => {
    await screen.settle();
    const release = hold("form");
    fire("click");
    await new Promise((resolve) => setTimeout(resolve, 10));
    reorder([{ id: "other", status: "pending", ask: "q1" }, { ...rows.form[0] }]);
    release();
    await screen.settle();
    assert.equal(rows.form.find((row) => row.id === "other").status, "pending");
  }, "<template data-item><span></span></template>"),
});
