import { batched } from "./batched-store.js";
// Deno smoke: the chart-derived path walker over a guarded machine with
// leaves — every arrow of the fib specimen fires, including the guard's
// numeric branch (driven to, not solved), the after arrow, and the root
// refused arrow. The specimen's cap is small so the drive converges fast.
import { parseHTML } from "npm:linkedom@0.18.4";
import { walkMachine } from "../test/walker.ts";

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
      after: { "30": { raise: "tick" } },
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
  "pastLimit.js": "const f = (state, event) => state.items[0].current + state.items[0].previous > 40;\nf;",
  "advance.js": "const f = (state, event) => state.items[0].current + state.items[0].previous;\nf;",
  "carry.js": "const f = (state, event) => state.items[0].current;\nf;",
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

Deno.test({
  name: "the walker exercises every arrow of the fib machine with no per-machine test code",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event } = parseHTML(
      "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
    );
    globalThis.document = document;
    const rows = [];
    const subs = new Set();
    const knobs = { refuseNext: false };
    const store = batched({
      query: async () => rows,
      subscribe: (_t, cb) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
      create: async () => {},
      update: async () => {},
      put: async (_t, row) => {
        if (knobs.refuseNext) {
          knobs.refuseNext = false;
          const err = new Error("409 refused");
          err.name = "NonRetriableError";
          throw err;
        }
        const i = rows.findIndex((r) => r.id === row.id);
        if (i < 0) rows.push({ ...row });
        else rows[i] = { ...rows[i], ...row };
        for (const cb of subs) setTimeout(cb, 0);
      },
      remove: async () => {},
    });
    globalThis.fetch = (url) => {
      const u = String(url);
      if (u.endsWith(".html")) return Promise.resolve(new Response(SCREEN_HTML));
      if (u.endsWith(".css")) return Promise.resolve(new Response(""));
      const mod = Object.keys(MODULES).find((m) => u.endsWith(m));
      if (mod) return Promise.resolve(new Response(MODULES[mod]));
      return Promise.reject(new Error(`unexpected fetch ${u}`));
    };
    const mount = document.getElementById("shell");
    const { interpretScreen } = await import("./screen.js");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    const region = mount.querySelector("#fib");

    const walk = await walkMachine(MACHINE, {
      // `refused` is not a DOM event: the harness synthesizes it by arming a
      // one-shot store refusal and forcing a write.
      fire: async (type, from) => {
        if (type === "refused") {
          knobs.refuseNext = true;
          region.dispatchEvent(new Event("click", { bubbles: true }));
          return;
        }
        const el = from === undefined ? region : document.getElementById(from);
        el.dispatchEvent(new Event(type, { bubbles: true }));
      },
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      field: () => rows.find((r) => r.id === "the")?.phase,
    });
    // `arrows` is what the walk drove; `shadowed` is what it could not select,
    // and a chart with no two candidates on one event has none.
    const covered = walk.arrows;
    if (covered.length !== 10) throw new Error(`fib declares 10 arrows, walker saw ${covered.length}`);
    if (walk.shadowed.length !== 0) {
      throw new Error(`fib has no sibling sharing an event, walker shadowed ${walk.shadowed.length}`);
    }
  },
});
