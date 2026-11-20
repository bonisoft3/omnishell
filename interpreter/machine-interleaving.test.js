// The invariants a chart keeps whatever arrives in what order:
//
//   a chart's timer is armed for the state its row is in, by whoever last put
//   the row there, and nothing else disarms it;
//   at rest, the chart stands in the state of the row it holds, and the
//   observers running are those of that state.
//
// A chart's writes and effects go out while a gesture, a timer, an
// observation, an acknowledgement, a refusal, somebody else's write or a slow
// refresh arrives, and each way this can break is one interleaving of those. Here they are drawn at random from a seed, on a held clock, over
// a chart every state of which leaves by a timer: whatever happened, the
// timers alone carry it to `end`, unless one was taken from the state that
// owned it.
import assert from "node:assert/strict";
import { parseHTML } from "npm:linkedom@0.18.4";
import { batched } from "./batched-store.js";

// screen.js reads its clock once, at evaluation.
globalThis.location = new URL("http://localhost/?clock=manual");

const order = ["s0", "s1", "s2", "s3", "end"];
const effect = { op: "create", entity: "first", values: {} };
const states = Object.fromEntries(order.slice(0, -1).map((name, i) => {
  const next = order[i + 1];
  return [name, {
    after: { 100: next },
    // Each kind of arrow with a target in some states and without in others.
    on: {
      click: i % 2 === 0 ? { target: next, effect } : { assign: { clicked: "yes" }, effect },
      sync_ack: i < 2 ? { assign: { acked: "yes" } } : { target: next },
      refused: i % 2 === 0 ? { assign: { refused: "yes" } } : { target: next },
      "signal:quote.jump": { target: next },
    },
    ...(i === 1 ? { invoke: { src: "quote" } } : {}),
  }];
}));
const chart = {
  field: "status", initial: "s0", invoke: { src: "quote" },
  on: { "signal:quote.note": { assign: { noted: "yes" } } },
  states: { ...states, end: {} },
};

// mulberry32
const random = (seed) => () => {
  let t = seed += 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const turn = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

async function interleave(seed, steps) {
  const { interpretScreen } = await import("./screen.js");
  const clock = globalThis.__prontoClock;
  const { document, Event } = parseHTML("<html><head></head><body><main id='shell'></main></body></html>");
  globalThis.document = document;
  globalThis.fetch = async (url) => new Response(String(url).endsWith(".css") ? "" : `<section data-screen="home"><div id="seat" data-live="form" data-filter="id=eq.draft" data-machine='${JSON.stringify(chart)}'></div></section>`);
  const rows = { form: [{ id: "draft", status: "s0", ask: "q1" }], quote: [{ id: "q1", status: "asking", txid: "1" }], first: [] };
  const subscribers = new Map();
  const notify = (table) => { for (const fn of subscribers.get(table) ?? []) fn(); };
  // What a test holds back: the next read of the chart's row, its writes, its
  // effects. `refuse` answers the chart's next write with a refusal.
  const gates = new Map();
  let slow, refuse = false;
  // Reads of the chart's table not yet answered: until the region's own
  // read answers, a chart reading the store has not met what it holds.
  let reading = 0;
  const hold = (what) => { if (gates.has(what)) return; let open; const wait = new Promise((resolve) => { open = resolve; }); gates.set(what, { wait, open }); };
  const release = (what) => { gates.get(what)?.open(); gates.delete(what); };
  const base = {
    query: async (table) => {
      if (table === "form") reading += 1;
      try {
        if (table === "form" && slow) { const wait = slow; slow = undefined; await wait; }
      } finally { if (table === "form") reading -= 1; }
      return rows[table].map((row) => ({ ...row }));
    },
    // The store answering at once from what it holds, as the tab's store does.
    answer: (table) => rows[table]?.map((row) => ({ ...row })),
    subscribe(table, fn) { const group = subscribers.get(table) ?? new Set(); group.add(fn); subscribers.set(table, group); return () => group.delete(fn); },
    async put(table, row) {
      await gates.get(table)?.wait;
      // A refused write is rolled back, which the store's readers are told.
      if (table === "form" && refuse) { refuse = false; queueMicrotask(() => notify(table)); throw Object.assign(new Error("refused"), { name: "NonRetriableError" }); }
      Object.assign(rows[table].find((held) => held.id === row.id), row);
      notify(table);
    },
    async create(table, row) { await gates.get(table)?.wait; rows[table].push({ ...row }); notify(table); },
  };
  const draw = random(seed);
  const pick = (list) => list[Math.floor(draw() * list.length)];
  const kinds = {
    gesture: () => document.getElementById("seat").dispatchEvent(new Event("click")),
    timer: () => clock.advance(pick([40, 100])),
    observation: () => { rows.quote[0] = { ...rows.quote[0], status: pick(["note", "jump"]), txid: String(Number(rows.quote[0].txid) + 1) }; notify("quote"); },
    "outside write": () => { rows.form[0] = { ...rows.form[0], status: pick(order.slice(0, -1)) }; notify("form"); },
    refusal: () => { refuse = true; },
    "hold effects": () => hold("first"), "release effects": () => release("first"),
    "hold writes": () => hold("form"), "release writes": () => release("form"),
    "hold a read": () => { if (!slow) hold("read"), slow = gates.get("read").wait; }, "release the read": () => release("read"),
  };
  const log = [];
  const said = () => `seed ${seed}: ${log.join(", ")}`;
  const seat = () => document.getElementById("seat");
  const errors = console.error;
  // A refusal is reported the way every silent failure is; here it is asked for.
  console.error = () => {};
  let screen;
  try {
    screen = await interpretScreen(document.getElementById("shell"), "http://localhost/", { screen: "home", files: { html: "home.html", css: "home.css", handlers: [] }, states: ["populated"] }, batched(base), {}, {
      schema: Object.fromEntries(Object.keys(rows).map((table) => [table, { fields: [{ name: "id", type: "string", pk: true }] }])),
      actors: { quote: { via: "observe", table: "quote", field: "status", match: { id: "ask" }, event: "signal:quote." } },
    });
    await turn();
    // Checked after every step, not only at the end, so a later event cannot
    // repair what an earlier one broke.
    const atRest = () => {
      const chart = seat()._prontoMachine_status_chart, outbox = seat()._prontoOutbox;
      if (chart.queue.length > 0 || outbox.waiting() || reading > 0) return;
      const stands = chart.view().status;
      assert.equal(chart.standing, stands, `${said()}: the chart stands in ${chart.standing}, its row in ${stands}`);
      assert.equal(subscribers.get("quote")?.size ?? 0, stands === "s1" ? 2 : 1, `${said()}: observers running in ${stands}`);
    };
    atRest();
    for (let i = 0; i < steps; i++) {
      const kind = pick(Object.keys(kinds));
      log.push(kind);
      kinds[kind]();
      await turn();
      atRest();
    }
    for (const what of [...gates.keys()]) release(what);
    refuse = false;
    // Nothing more happens to the chart but time.
    for (let i = 0; i < 40 && rows.form[0].status !== "end"; i++) { await turn(); clock.advance(100); }
    await turn();
    assert.equal(rows.form[0].status, "end", said());
    assert.equal(seat()._prontoMachine_status_chart.standing, "end", said());
  } finally {
    console.error = errors;
    try { await screen?.stop(); } catch (error) { throw new Error(`${said()}: ${error.message}`, { cause: error }); }
  }
}

Deno.test({
  name: "whatever overlaps, a chart's timers carry it to its end",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
    try {
      // SEED and STEPS replay one sequence a failure named; SEEDS widens the draw.
      const steps = Number(Deno.env.get("STEPS") ?? 14);
      const only = Deno.env.get("SEED");
      if (only) return await interleave(Number(only), steps);
      // Sequences that once ended with a spent timer nothing re-armed: a
      // refused entry by a timer, and a refusal a refresh had read past.
      for (const [seed, length] of [[304, 14], [450, 14], [25, 30]]) await interleave(seed, length);
      for (let seed = 1; seed <= Number(Deno.env.get("SEEDS") ?? 80); seed++) await interleave(seed, steps);
    } finally {
      globalThis.document = previousDocument;
      globalThis.fetch = previousFetch;
    }
  },
});
