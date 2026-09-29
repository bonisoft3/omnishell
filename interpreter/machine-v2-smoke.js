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

function fakeTime() {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = new Map();
  let now = 0;
  let id = 0;
  globalThis.setTimeout = (fn, ms = 0, ...args) => {
    const key = ++id;
    timers.set(key, { at: now + Number(ms), fn, args });
    return key;
  };
  globalThis.clearTimeout = (key) => timers.delete(key);

  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const due = () => [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
  const fire = async ([key, timer]) => {
    timers.delete(key);
    now = timer.at;
    timer.fn(...timer.args);
    await flush();
  };
  return {
    async advance(ms) {
      const target = now + ms;
      await flush();
      while (due()?.[1].at <= target) await fire(due());
      now = target;
      await flush();
    },
    async next() {
      await flush();
      const timer = due();
      if (!timer) throw new Error("no timer remains for machine transition");
      await fire(timer);
    },
    restore() {
      globalThis.setTimeout = originalSet;
      globalThis.clearTimeout = originalClear;
    },
  };
}

function boot(html = SCREEN_HTML, rows = []) {
  const { document, Event } = parseHTML(
    "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
  );
  globalThis.document = document;
  const puts = [];
  const upserts = [];
  const creates = [];
  const subs = new Set();
  const knobs = { refuseNext: false, refuseUpsert: false, slowUpsertMs: 0 };
  const baseStore = {
    query: async () => rows,
    subscribe: (_table, cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    create: async (_table, row) => {
      creates.push(row);
    },
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
    upsertBy: async (table, values, onRefused) => {
      upserts.push({ table, ...values });
      if (knobs.refuseUpsert) {
        knobs.refuseUpsert = false;
        const err = new Error("409 duplicate");
        err.name = "NonRetriableError";
        if (onRefused) onRefused(err);
        else throw err;
        return;
      }
      if (knobs.slowUpsertMs > 0) {
        const ms = knobs.slowUpsertMs;
        knobs.slowUpsertMs = 0;
        await tick(ms);
      }
    },
  };
  const store = batched(baseStore);
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.endsWith(".html")) return Promise.resolve(new Response(html));
    if (u.endsWith(".css")) return Promise.resolve(new Response(""));
    const mod = Object.keys(MODULES).find((m) => u.endsWith(m));
    if (mod) return Promise.resolve(new Response(MODULES[mod]));
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  };
  return { document, Event, store, rows, puts, upserts, creates, knobs };
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

MODULES["normalizeInput.js"] = "const f = (state, event) => String(event.value ?? '').trim().toLowerCase();\nf;";

const FAVORITE_MACHINE = {
  field: "phase",
  initial: "unfavorited",
  context: { count: 0, favorited: false, token: "" },
  states: {
    unfavorited: {
      on: {
        click: {
          target: "favoriting",
          assign: { count: 1, favorited: true, token: "tok-fav" },
          effect: {
            level: 2,
            op: "upsert",
            entity: "favorite",
            token: "{token}",
            values: { article_id: "{id}", deleted_at: null },
          },
        },
      },
    },
    favoriting: {
      initial: "inflight",
      on: {
        sync_ack: { target: "favorited" },
        refused: { target: "unfavorited", assign: { count: 0, favorited: false } },
      },
      states: {
        inflight: {
          after: { 50: "delayed" },
        },
        delayed: {},
      },
    },
    favorited: {
      on: {
        click: {
          target: "unfavorited",
          assign: { count: 0, favorited: false },
          effect: {
            level: 2,
            op: "delete",
            entity: "favorite",
            filter: "article_id=eq.{id}",
          },
        },
      },
    },
  },
};

const FAVORITE_HTML = `<section class="screen" data-screen="fav">
  <button id="fav" data-live="favorite" data-filter="id=eq.art-1"
          data-text="{count}" data-phase="{phase}"
          data-machine='${JSON.stringify(FAVORITE_MACHINE)}'>0</button>
</section>`;

Deno.test({
  name: "declarative transition effects: upsertBy executes into store, sync_ack auto-dispatches and transitions machine",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, upserts } = boot(FAVORITE_HTML);
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    const route = { ...ROUTE, files: { ...ROUTE.files, handlers: Object.keys(MODULES).map((m) => `shell/handlers/${m}`) } };
    await interpretScreen(mount, "http://localhost:8080/keep/", route, store, {});
    const btn = mount.querySelector("#fav");

    assert(btn.getAttribute("data-phase") === "unfavorited", "starts unfavorited");
    btn.dispatchEvent(new Event("click"));
    await tick(30);

    assert(upserts.length === 1, `upsertBy was called, got ${upserts.length} calls`);
    assert(upserts[0].table === "favorite" && upserts[0].article_id === "art-1" && upserts[0].deleted_at === null,
      `effect values interpolated correctly: ${JSON.stringify(upserts[0])}`);
    assert(btn.getAttribute("data-phase") === "favorited",
      `sync_ack transitioned machine to favorited, got "${btn.getAttribute("data-phase")}"`);
    assert(btn.textContent === "1", `count reflects assign, got "${btn.textContent}"`);
  },
});

Deno.test({
  name: "nested states and after timeout: delayed substate displays degraded state while parent catches late sync_ack",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, knobs } = boot(FAVORITE_HTML);
    knobs.slowUpsertMs = 80; // Longer than after: 50ms
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    const route = { ...ROUTE, files: { ...ROUTE.files, handlers: Object.keys(MODULES).map((m) => `shell/handlers/${m}`) } };
    await interpretScreen(mount, "http://localhost:8080/keep/", route, store, {});
    const btn = mount.querySelector("#fav");
    const time = fakeTime();
    try {
      btn.dispatchEvent(new Event("click"));
      await time.advance(15);
      assert(btn.getAttribute("data-phase") === "favoriting.inflight",
        `entered initial compound substate, got "${btn.getAttribute("data-phase")}"`);

      for (let i = 0; i < 10 && btn.getAttribute("data-phase") === "favoriting.inflight"; i++) {
        await time.next();
      }
      assert(btn.getAttribute("data-phase") === "favoriting.delayed",
        `timed out to delayed substate for degraded UI, got "${btn.getAttribute("data-phase")}"`);

      for (let i = 0; i < 10 && btn.getAttribute("data-phase") === "favoriting.delayed"; i++) {
        await time.next();
      }
      assert(btn.getAttribute("data-phase") === "favorited",
        `parent favoriting state cleanly caught late sync_ack while in delayed, got "${btn.getAttribute("data-phase")}"`);
    } finally {
      time.restore();
    }
  },
});

Deno.test({
  name: "late refusal: parent catches refused from inflight or delayed substate and rolls back cleanly",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, knobs } = boot(FAVORITE_HTML);
    knobs.refuseUpsert = true;
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    const route = { ...ROUTE, files: { ...ROUTE.files, handlers: Object.keys(MODULES).map((m) => `shell/handlers/${m}`) } };
    await interpretScreen(mount, "http://localhost:8080/keep/", route, store, {});
    const btn = mount.querySelector("#fav");

    btn.dispatchEvent(new Event("click"));
    await tick(30);

    assert(btn.getAttribute("data-phase") === "unfavorited",
      `refusal caught by parent and rolled back to unfavorited, got "${btn.getAttribute("data-phase")}"`);
    assert(btn.textContent === "0", `count rolled back to 0, got "${btn.textContent}"`);
  },
});

Deno.test({
  name: "inspectable side effects: machine effect is pure data descriptor, inspectable without execution",
  fn() {
    const eff = FAVORITE_MACHINE.states.unfavorited.on.click.effect;
    assert(eff !== undefined && typeof eff === "object", "effect is an object");
    assert(eff.level === 2, "effect declares Level 2 (compensable mutation)");
    assert(eff.op === "upsert", "effect op is upsert");
    assert(eff.entity === "favorite", "effect entity is favorite");
    assert(eff.token === "{token}", "effect token is {token}");
    assert(eff.values.article_id === "{id}" && eff.values.deleted_at === null, "values are pure data");
    // Verify it is JSON-serializable (no closures, no DOM nodes, no side channels)
    const serialized = JSON.stringify(eff);
    assert(JSON.parse(serialized).op === "upsert", "effect survives JSON round-trip");
  },
});

Deno.test({
  name: "pure reduction form normalization: transforms input value on submit without race conditions",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const NORMALIZE_MACHINE = {
      field: "status",
      initial: "idle",
      context: { email: "" },
      states: {
        idle: {
          on: {
            click: {
              target: "done",
              assign: { email: "normalizeInput" },
              effect: {
                op: "create",
                entity: "profile",
                values: { email: "{email}" },
              },
            },
          },
        },
        done: {},
      },
    };
    const NORMALIZE_HTML = `<section class="screen" data-screen="norm">
      <button id="norm-btn" data-live="profile" data-filter="id=eq.u1"
              data-status="{status}"
              data-machine='${JSON.stringify(NORMALIZE_MACHINE)}'>Save</button>
    </section>`;

    const { document, Event, store, creates } = boot(NORMALIZE_HTML);
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    const route = { ...ROUTE, files: { ...ROUTE.files, handlers: Object.keys(MODULES).map((m) => `shell/handlers/${m}`) } };
    await interpretScreen(mount, "http://localhost:8080/keep/", route, store, {});
    const btn = mount.querySelector("#norm-btn");

    const clickEvent = new Event("click");
    // Control / input value attached to event at gesture time
    btn.value = "   Alice@Example.COM   ";
    btn.dispatchEvent(clickEvent);
    await tick(30);

    assert(btn.getAttribute("data-status") === "done", "status is done");
    assert(creates.length === 1, `created 1 row, got ${creates.length}`);
    assert(creates[0].email === "alice@example.com",
      `email was normalized synchronously at gesture time: "${creates[0].email}"`);
  },
});

Deno.test({
  name: "entry and exit actions: exit runs on source, entry runs on destination with effects and assigns",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const ENTRY_EXIT_MACHINE = {
      field: "phase",
      initial: "a",
      context: { log: "start" },
      states: {
        a: {
          exit: {
            assign: { log: "exited_a" },
            effect: { op: "create", entity: "log", values: { text: "bye_a" } },
          },
          on: { NEXT: "b" },
        },
        b: {
          entry: {
            assign: { log: "entered_b" },
            effect: { op: "create", entity: "log", values: { text: "hello_b" } },
          },
        },
      },
    };
    const HTML = `<section class="screen" data-screen="ee">
      <button id="ee-btn" data-live="session" data-filter="id=eq.s1"
              data-phase="{phase}" data-log="{log}"
              data-machine='${JSON.stringify(ENTRY_EXIT_MACHINE)}'>Go</button>
    </section>`;
    const { document, Event, store, creates } = boot(HTML);
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    const route = { ...ROUTE, files: { ...ROUTE.files, handlers: [] } };
    await interpretScreen(mount, "http://localhost:8080/keep/", route, store, {});
    const btn = mount.querySelector("#ee-btn");

    btn.dispatchEvent(new Event("NEXT"));
    await tick(30);

    assert(btn.getAttribute("data-phase") === "b", `expected phase b, got ${btn.getAttribute("data-phase")}`);
    assert(btn.getAttribute("data-log") === "entered_b", `expected log entered_b, got ${btn.getAttribute("data-log")}`);
    assert(creates.length === 2, `expected 2 created effect rows, got ${creates.length}`);
    assert(creates[0].text === "bye_a", `expected first effect bye_a, got ${creates[0].text}`);
    assert(creates[1].text === "hello_b", `expected second effect hello_b, got ${creates[1].text}`);
  },
});

Deno.test({
  name: "onDone and type: final: substate completion automatically triggers parent onDone transition",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const ONDONE_MACHINE = {
      field: "phase",
      initial: "round",
      context: { roundNum: 1 },
      states: {
        round: {
          initial: "dealing",
          states: {
            dealing: {
              on: { FINISH: "settled" },
            },
            settled: {
              type: "final",
            },
          },
          onDone: {
            target: "summary",
            assign: { roundNum: 2 },
          },
        },
        summary: {},
      },
    };
    const HTML = `<section class="screen" data-screen="od">
      <button id="od-btn" data-live="game" data-filter="id=eq.g1"
              data-phase="{phase}" data-round="{roundNum}"
              data-machine='${JSON.stringify(ONDONE_MACHINE)}'>Go</button>
    </section>`;
    const { document, Event, store } = boot(HTML);
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    const route = { ...ROUTE, files: { ...ROUTE.files, handlers: [] } };
    await interpretScreen(mount, "http://localhost:8080/keep/", route, store, {});
    const btn = mount.querySelector("#od-btn");

    assert(btn.getAttribute("data-phase") === "round.dealing", `expected round.dealing, got ${btn.getAttribute("data-phase")}`);
    btn.dispatchEvent(new Event("FINISH"));
    await tick(30);

    assert(btn.getAttribute("data-phase") === "summary", `expected summary via onDone, got ${btn.getAttribute("data-phase")}`);
    assert(btn.getAttribute("data-round") === "2", `expected roundNum 2, got ${btn.getAttribute("data-round")}`);
  },
});

Deno.test({
  name: "type: parallel: orthogonal regions on a single machine row update both columns atomically",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const PARALLEL_MACHINE = {
      type: "parallel",
      states: {
        audio: {
          field: "audio_state",
          initial: "muted",
          states: {
            muted: { on: { UNMUTE: "audible" } },
            audible: { on: { MUTE: "muted" } },
          },
        },
        display: {
          field: "display_state",
          initial: "visible",
          states: {
            visible: { on: { HIDE: "hidden" } },
            hidden: { on: { SHOW: "visible" } },
          },
        },
      },
    };
    const HTML = `<section class="screen" data-screen="par">
      <button id="par-btn" data-live="media" data-filter="id=eq.m1"
              data-audio="{audio_state}" data-display="{display_state}"
              data-machine='${JSON.stringify(PARALLEL_MACHINE)}'>Toggle</button>
    </section>`;
    const { document, Event, store } = boot(HTML);
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    const route = { ...ROUTE, files: { ...ROUTE.files, handlers: [] } };
    await interpretScreen(mount, "http://localhost:8080/keep/", route, store, {});
    const btn = mount.querySelector("#par-btn");

    assert(btn.getAttribute("data-audio") === "muted", `expected audio muted, got ${btn.getAttribute("data-audio")}`);
    assert(btn.getAttribute("data-display") === "visible", `expected display visible, got ${btn.getAttribute("data-display")}`);

    btn.dispatchEvent(new Event("UNMUTE"));
    await tick(30);
    assert(btn.getAttribute("data-audio") === "audible", `expected audio audible, got ${btn.getAttribute("data-audio")}`);
    assert(btn.getAttribute("data-display") === "visible", `display should remain visible`);

    btn.dispatchEvent(new Event("HIDE"));
    await tick(30);
    assert(btn.getAttribute("data-audio") === "audible", `audio should remain audible`);
    assert(btn.getAttribute("data-display") === "hidden", `expected display hidden, got ${btn.getAttribute("data-display")}`);
  },
});

Deno.test({
  name: "always: transient eventless transitions evaluate immediately on entering a state",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const ALWAYS_MACHINE = {
      field: "phase",
      initial: "idle",
      context: { current: 10, previous: 0 },
      states: {
        idle: {
          on: { CHECK: "evaluating" },
        },
        evaluating: {
          always: [
            { guard: "pastLimit", target: "high" },
            { target: "low" },
          ],
        },
        high: {},
        low: {},
      },
    };
    const HTML = `<section class="screen" data-screen="alw">
      <button id="alw-btn" data-live="score" data-filter="id=eq.s1"
              data-phase="{phase}"
              data-machine='${JSON.stringify(ALWAYS_MACHINE)}'>Check</button>
    </section>`;
    const { document, Event, store } = boot(HTML);
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    const route = { ...ROUTE, files: { ...ROUTE.files, handlers: Object.keys(MODULES).map((m) => `shell/handlers/${m}`) } };
    await interpretScreen(mount, "http://localhost:8080/keep/", route, store, {});
    const btn = mount.querySelector("#alw-btn");

    assert(btn.getAttribute("data-phase") === "idle", `expected idle, got ${btn.getAttribute("data-phase")}`);
    btn.dispatchEvent(new Event("CHECK"));
    await tick(30);

    // pastLimit checks current + previous > 1000; with current=10 and previous=0 it is false, so it falls to low
    assert(btn.getAttribute("data-phase") === "low", `expected low via always transition, got ${btn.getAttribute("data-phase")}`);
  },
});
