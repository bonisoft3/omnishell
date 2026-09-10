import { batched } from "./batched-store.js";
// Deno smoke: the #Machine v2 grammar end to end — value positions holding
// literals and Jessie references, guarded candidate lists, raise, root-level
// on:, after as the relocated invoke, context in the synthesized fallback,
// row closure, and refused as an ordinary machine event. The specimen is the
// design session's Fibonacci autoplayer: three states, three one-line
// modules, zero reducers.
import { parseHTML } from "npm:linkedom@0.18.4";

// The autoplayer. `beat` in the after key is a reference — a module returning
// the milliseconds — so the delay position's both spellings are exercised.
const MACHINE = {
  field: "phase",
  initial: "counting",
  context: { current: 1, previous: 0 },
  on: { refused: { target: "counting" } },
  states: {
    counting: {
      on: {
        click: { raise: "tick" },
        dblclick: { target: "playing", raise: "tick" },
        tick: [
          { guard: "pastLimit", target: "done" },
          { assign: { current: "advance", previous: "carry" } },
        ],
      },
    },
    playing: {
      after: { beat: { raise: "tick" } },
      on: {
        dblclick: { target: "counting" },
        tick: [
          { guard: "pastLimit", target: "done" },
          { target: "playing", assign: { current: "advance", previous: "carry" } },
        ],
      },
    },
    done: {
      on: { click: { target: "counting", assign: { current: 1, previous: 0 } } },
    },
  },
};

const SCREEN_HTML = `<section class="screen" data-screen="fib">
  <button id="fib" data-live="fib" data-filter="id=eq.the"
          data-text="{current}" data-phase="{phase}"
          data-machine='${JSON.stringify(MACHINE)}'>1</button>
</section>`;

const MODULES = {
  "pastLimit.js": "const f = (state, event) => state.items[0].current + state.items[0].previous > 1000;\nf;",
  "advance.js": "const f = (state, event) => state.items[0].current + state.items[0].previous;\nf;",
  "carry.js": "const f = (state, event) => state.items[0].current;\nf;",
  "beat.js": "const f = (state, event) => 40;\nf;",
  // The row-closure specimen: a leaf reaching beyond the machine's row.
  "leaky.js": "const f = (state, event) => state.rows.fib.length > 0;\nf;",
};

const ROUTE = {
  screen: "fib",
  files: {
    html: "shell/screens/fib.html",
    css: "shell/screens/fib.css",
    handlers: Object.keys(MODULES).map((m) => `shell/handlers/${m}`),
  },
  states: ["populated"],
};

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

function boot(html = SCREEN_HTML, rows = []) {
  const { document, Event } = parseHTML(
    "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
  );
  globalThis.document = document;
  const puts = [];
  const subs = new Set();
  const knobs = { refuseNext: false };
  const store = batched({
    query: async () => rows,
    subscribe: (_table, cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    create: async () => {},
    update: async () => {},
    put: async (_table, row) => {
      if (knobs.refuseNext) {
        knobs.refuseNext = false;
        const err = new Error("409 refused");
        err.name = "NonRetriableError";
        throw err;
      }
      puts.push({ ...row });
      const i = rows.findIndex((r) => r.id === row.id);
      if (i < 0) rows.push({ ...row });
      else rows[i] = { ...rows[i], ...row };
      for (const cb of subs) setTimeout(cb, 0);
    },
    remove: async () => {},
  });
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.endsWith(".html")) return Promise.resolve(new Response(html));
    if (u.endsWith(".css")) return Promise.resolve(new Response(""));
    const mod = Object.keys(MODULES).find((m) => u.endsWith(m));
    if (mod) return Promise.resolve(new Response(MODULES[mod]));
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  };
  return { document, Event, store, rows, puts, knobs };
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

Deno.test({
  name: "clicks advance the sequence: context seeds the fallback, assigns read one snapshot",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, puts } = boot();
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});

    const btn = mount.querySelector("#fib");
    // No row, no data-empty-row: the fallback is {...context, field: initial,
    // ...filter eqs}, and the binding reads context's value.
    assert(btn.textContent === "1", `context seeds the readout, got "${btn.textContent}"`);
    assert(btn.getAttribute("data-phase") === "counting", "initial state bound");

    for (const _ of [0, 1, 2, 3, 4]) {
      btn.dispatchEvent(new Event("click"));
      await tick(30);
    }
    assert(
      JSON.stringify(puts.map((p) => p.current)) === JSON.stringify([1, 2, 3, 5, 8]),
      `five ticks walk the sequence, got ${JSON.stringify(puts.map((p) => p.current))}`,
    );
    // The first write concluded from the fallback, so it stated the whole row.
    assert(puts[0].previous === 1 && puts[0].id === "the" && puts[0].phase === "counting",
      `the first write states the whole fallback row, got ${JSON.stringify(puts[0])}`);
    assert(btn.textContent === "8", "the readout tracks the row");
  },
});

Deno.test({
  name: "the cap's guard wins its candidate slot, and done's literal assigns reset",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, rows, puts } = boot(SCREEN_HTML, [
      { id: "the", phase: "counting", current: 987, previous: 610 },
    ]);
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});

    const btn = mount.querySelector("#fib");
    btn.dispatchEvent(new Event("click"));
    await tick(30);
    assert(rows[0].phase === "done", `987+610 passes the limit, got ${JSON.stringify(rows[0])}`);
    assert(rows[0].current === 987, "the guarded arrow moves only the field");

    btn.dispatchEvent(new Event("click"));
    await tick(30);
    assert(rows[0].phase === "counting" && rows[0].current === 1 && rows[0].previous === 0,
      `done's click resets by literal assigns, got ${JSON.stringify(rows[0])}`);
    assert(puts.length === 2, "two transitions, two stated rows");
  },
});

Deno.test({
  name: "after is the relocated invoke: armed on entry, re-armed by self-target, canceled on exit",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, puts } = boot();
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    const btn = mount.querySelector("#fib");

    btn.dispatchEvent(new Event("dblclick"));
    await tick(200);
    const playing = puts.length;
    // Entry raised the first tick at once; the beat-module's 40ms loop added
    // more. Exact counts are the clock's business, not this test's.
    assert(playing >= 3, `the autoplayer beats on its own, got ${playing} writes`);

    btn.dispatchEvent(new Event("dblclick"));
    await tick(60);
    const paused = puts.length;
    await tick(150);
    assert(puts.length === paused, `leaving playing cancels the pending beat, got ${puts.length - paused} late beats`);
  },
});

Deno.test({
  name: "re-entering playing runs one beat chain, not two",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, puts } = boot();
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    const btn = mount.querySelector("#fib");

    // In, out, in: the naive reduce's duplicate-chain hazard. The generation
    // mark must leave exactly one live chain.
    btn.dispatchEvent(new Event("dblclick"));
    await tick(10);
    btn.dispatchEvent(new Event("dblclick"));
    await tick(10);
    btn.dispatchEvent(new Event("dblclick"));
    await tick(20);
    const mark = puts.length;
    await tick(170);
    const beats = puts.length - mark;
    // One chain at ~40ms yields ~4 beats in 170ms; two chains ~8. The bound
    // splits the two regimes with slack for the scheduler.
    assert(beats >= 2 && beats <= 6, `one chain's beat rate expected, got ${beats} in 170ms`);
  },
});

Deno.test({
  name: "refused is an ordinary machine event, handled at the root",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, rows, knobs } = boot();
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    const btn = mount.querySelector("#fib");

    btn.dispatchEvent(new Event("dblclick"));
    await tick(60);
    knobs.refuseNext = true;
    await tick(120);
    assert(rows.some((r) => r.id === "the") && rows.find((r) => r.id === "the").phase === "counting",
      `the store's no lands as the machine's onError arrow back to counting, got ${JSON.stringify(rows)}`);
    assert(mount.firstElementChild.dataset.state !== "validation-error",
      "the machine owned the refusal; no default state flip");
  },
});

Deno.test({
  name: "row closure: a leaf reaching state.rows fails loudly and writes nothing",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const machine = JSON.parse(JSON.stringify(MACHINE));
    machine.states.counting.on.tick[0].guard = "leaky";
    const html = SCREEN_HTML.replace(JSON.stringify(MACHINE), JSON.stringify(machine));
    const { document, Event, store, puts } = boot(html);
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    const btn = mount.querySelector("#fib");
    btn.dispatchEvent(new Event("click"));
    await tick(30);
    assert(puts.length === 0, "no write concludes from a broken leaf");
    assert(mount.firstElementChild.dataset.state === "network-error",
      "the TypeError surfaced as a program failure, not a silent no-op");
  },
});

// Parameterized references: the threshold lives in the chart as data, the
// module serves any instance. (state, event, params) is the leaf's whole
// signature; a params object of anything but literals never reaches here —
// machine.cue refuses it at vet.
const PARAMS_MACHINE = {
  field: "phase",
  initial: "counting",
  context: { n: 0 },
  states: {
    counting: {
      on: {
        click: [
          { guard: { type: "under", params: { limit: 2 } }, assign: { n: { type: "bump", params: { by: 3 } } } },
          { target: "done" },
        ],
      },
    },
    done: {},
  },
};

const PARAMS_HTML = `<section class="screen" data-screen="pk">
  <button id="pk" data-live="pk" data-filter="id=eq.the" data-n="{n}" data-phase="{phase}"
          data-machine='${JSON.stringify(PARAMS_MACHINE)}'>0</button>
</section>`;

MODULES["under.js"] = "const f = (state, event, params) => state.items[0].n < params.limit;\nf;";
MODULES["bump.js"] = "const f = (state, event, params) => state.items[0].n + params.by;\nf;";

Deno.test({
  name: "a {type, params} leaf receives its params in guard and assign positions",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, rows } = boot(PARAMS_HTML);
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    const route = { ...ROUTE, files: { ...ROUTE.files, handlers: Object.keys(MODULES).map((m) => `shell/handlers/${m}`) } };
    await interpretScreen(mount, "http://localhost:8080/keep/", route, store, {});
    const btn = mount.querySelector("#pk");

    btn.dispatchEvent(new Event("click"));
    await tick(30);
    assert(rows[0].n === 3, `bump's params.by reached the assign, got ${JSON.stringify(rows[0])}`);
    btn.dispatchEvent(new Event("click"));
    await tick(30);
    assert(rows[0].phase === "done" && rows[0].n === 3,
      `under's params.limit decided the guard, got ${JSON.stringify(rows[0])}`);
  },
});
