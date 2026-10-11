// Deno smoke: the hatch's agent seat — a vendored unit on its own thread,
// props in and named events out. No store, no clock, no screen: what is under
// test is the boundary itself, and the Worker is a stand-in because deno has no
// browser worker here and a real one would answer off the test's own timeline.
import { parseHTML } from "npm:linkedom@0.18.4";
import { batched } from "./batched-store.js";
import { ProgramError } from "./fragment.js";

const UNIT = { isolation: "agent", ports: { reads: ["game"], raises: ["answer"] }, src: "shell/units/engine/unit.js", note: "an oracle" };
const APP_BASE = "https://app.example/";
const SRC = new URL(UNIT.src, APP_BASE).href;

const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

/** What `act` let escape to where the shell listens: the window's `error`
 * event for a throw nobody caught, `unhandledrejection` for a promise nobody
 * awaited. A seat's refusal must be a ProgramError there, or the shell leaves
 * it a console line. */
async function escaped(act) {
  const out = [];
  const onError = (e) => {
    e.preventDefault();
    out.push(e.error);
  };
  const onRejection = (e) => {
    e.preventDefault();
    out.push(e.reason);
  };
  globalThis.addEventListener("error", onError);
  globalThis.addEventListener("unhandledrejection", onRejection);
  try {
    act();
    await tick();
  } finally {
    globalThis.removeEventListener("error", onError);
    globalThis.removeEventListener("unhandledrejection", onRejection);
  }
  return out;
}

function root() {
  const { document } = parseHTML("<!doctype html><html><body><div id=out></div></body></html>");
  globalThis.document = document;
  return document.getElementById("out");
}

/** Installs a Worker that records what the terminal did to it and can post
 * back on demand. Returns the list every construction lands in. */
function fakeWorkers() {
  const made = [];
  globalThis.Worker = class {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      this.posted = [];
      this.listeners = [];
      this.terminated = 0;
      made.push(this);
    }
    postMessage(data) {
      this.posted.push(data);
    }
    addEventListener(type, fn) {
      this.listeners.push({ type, fn });
    }
    terminate() {
      this.terminated += 1;
    }
    /** What the unit says, delivered as the port does: a task of its own, so
     * a listener's throw is the window's `error` event, never the caller's. */
    says(data) {
      setTimeout(() => {
        for (const l of this.listeners) if (l.type === "message") l.fn({ data });
      }, 0);
    }
  };
  return made;
}

Deno.test("the unit gets a thread, and the terminal grants it nothing else", async () => {
  const { mountHatch } = await import("./hatch.js");
  const made = fakeWorkers();
  const out = root();
  const hatch = mountHatch(out, { unit: UNIT, src: SRC });

  assert(made.length === 1, `one worker constructed, got ${made.length}`);
  assert(made[0].url === SRC, `the unit's src resolved against appBase, got ${made[0].url}`);
  // A module worker has no importScripts, so a wrapper could not reach the
  // code it wraps.
  assert(made[0].opts === undefined, `not a module worker, got ${JSON.stringify(made[0].opts)}`);
  // The host's children are the screen author's.
  assert(out.childNodes.length === 0, `nothing was mounted into the host, got ${out.childNodes.length}`);

  hatch.destroy();
  assert(made[0].terminated === 1, `destroy terminates the thread, got ${made[0].terminated}`);

  // A unit touches the app through its ports alone, and an event outside
  // its raises is refused at the seat rather than dispatched. The mount's
  // refusals are ProgramErrors: it runs inside the region's refresh, whose
  // outage guard retries anything else as a dead gateway.
  let threw = null;
  try {
    mountHatch(root(), { unit: { ...UNIT, ports: undefined }, src: SRC });
  } catch (e) {
    threw = e;
  }
  assert(threw instanceof ProgramError, `a unit declaring no ports is refused as the app's bug, got ${threw}`);
  assert(made.length === 1, "and no thread was started for it");
  const events = [];
  const held = mountHatch(root(), { unit: UNIT, src: SRC, onEvent: (e) => events.push(e) });
  [threw] = await escaped(() => made[1].says({ type: "pronto:event", name: "verdict", detail: { uci: "e2e4" } }));
  assert(threw instanceof ProgramError && String(threw.message).includes('"verdict"'), `an undeclared raise is refused by name, got ${threw}`);
  assert(events.length === 0, "and reaches no listener");
  held.destroy();

  threw = null;
  try {
    mountHatch(root(), { unit: UNIT, src: "javascript:alert(1)" });
  } catch (e) {
    threw = e;
  }
  assert(threw instanceof ProgramError, `a src the terminal will not fetch is refused, got ${threw}`);
});

Deno.test("props wait for ready and coalesce to the latest", async () => {
  const { mountHatch } = await import("./hatch.js");
  const made = fakeWorkers();
  const hatch = mountHatch(root(), { unit: UNIT, src: SRC });
  const worker = made[0];

  // Props are a current-value feed, not a log. Withholding them until the unit
  // says it is ready is what keeps a search from being asked of an engine that
  // has not booted.
  hatch.update({ fen: "one" });
  hatch.update({ fen: "two" });
  hatch.update({ fen: "three" });
  assert(worker.posted.length === 0, `nothing posted before ready, got ${worker.posted.length}`);

  worker.says({ type: "pronto:ready" });
  await tick();
  assert(worker.posted.length === 1, `one delivery on ready, got ${worker.posted.length}`);
  assert(worker.posted[0].type === "pronto:props", "delivery is a props message");
  assert(worker.posted[0].props.fen === "three", "the latest value, not the first");
  hatch.destroy();
});

Deno.test("only a message the boundary can rebuild reaches the screen, and the rest is refused, not dropped", async () => {
  const { mountHatch } = await import("./hatch.js");
  const made = fakeWorkers();
  const events = [];
  const hatch = mountHatch(root(), { unit: UNIT, src: SRC, onEvent: (e) => events.push(e) });
  const worker = made[0];

  // The reduce that receives an answer is a compartment with nothing endowed
  // and cannot defend itself, so every one of these stops here — thrown,
  // naming the unit, since what posted it is the app's own wrapper and a memo
  // answer lost in silence is a question that stands forever. Thrown from
  // the port's listener it is the window's `error` event, so it is a
  // ProgramError, the one kind the shell banners from there.
  for (const shape of [
    null,
    42,
    "answer",
    { type: "pronto:ask" },
    { type: "pronto:event", name: "" },
    { type: "pronto:event", name: "answer" },
    { type: "pronto:event", name: "answer", detail: ["e2e4"] },
    { type: "pronto:event", name: "answer", detail: { a: "1", b: "2", c: "3", d: "4", e: "5", f: "6", g: "7", h: "8", i: "9" } },
    { type: "pronto:event", name: "answer", detail: { "Bad-Key": "e2e4" } },
    { type: "pronto:event", name: "answer", detail: { uci: "x".repeat(129) } },
    { type: "pronto:event", name: "answer", detail: { uci: "e2e4\n" } },
    { type: "pronto:event", name: "answer", detail: { uci: 7 } },
  ]) {
    const [threw] = await escaped(() => worker.says(shape));
    assert(threw instanceof ProgramError && String(threw.message).includes(SRC), `refused, naming the unit: ${JSON.stringify(shape)}, got ${threw}`);
    assert(events.length === 0, `and nothing reached the screen: ${JSON.stringify(shape)}`);
  }

  // And the channel is real, which is the half a seat that drops everything
  // would also satisfy.
  worker.says({ type: "pronto:event", name: "answer", detail: { uci: "e2e4", ply: "0" } });
  await tick();
  assert(events.length === 1, `a well-formed answer arrives, got ${events.length}`);
  assert(events[0].name === "answer", `named, got ${events[0].name}`);
  assert(events[0].detail.uci === "e2e4" && events[0].detail.ply === "0", "carrying every validated key");
  hatch.destroy();
});

Deno.test("the detail a screen sees is the terminal's own object", async () => {
  const { mountHatch } = await import("./hatch.js");
  const made = fakeWorkers();
  const events = [];
  const hatch = mountHatch(root(), { unit: UNIT, src: SRC, onEvent: (e) => events.push(e) });

  const mutable = { uci: "e2e4" };
  made[0].says({ type: "pronto:event", name: "answer", detail: mutable });
  await tick();
  const detail = events[0].detail;
  assert(Object.isFrozen(detail), "the screen cannot be handed something that changes under it");

  // Built key by key from the validated strings: the unit keeps a live handle
  // on what it posted, and a passed-through object would let it edit the value
  // a reduce is about to read.
  mutable.uci = "e7e5";
  assert(detail.uci === "e2e4", `fresh, not the unit's object, got ${detail.uci}`);
  hatch.destroy();
});

Deno.test({
  name: "a question missing a key of its memo is refused past the region's refresh, not retried as an outage",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // The question is put from the bind pass inside the region's refresh,
    // where the outage guard rethrows a ProgramError and dresses anything else
    // as network-error with a retry timer — the mount's own port refusals one
    // function away are held to the same path (hatch-smoke.js).
    const memoUnit = {
      ...UNIT,
      ports: { reads: ["answer"], raises: ["answer"] },
      memo: { table: "answer", key: ["fen", "nodes"], columns: ["fen", "nodes", "uci"] },
    };
    const screen = `<section class="screen" data-screen="board">
      <article data-live="answer" data-order="created_at.desc">
        <div data-hatch="engine" data-on-answer="record" data-prop-fen="{fen}"></div>
      </article>
    </section>`;
    const route = {
      screen: "board",
      files: { html: "shell/screens/board.html", css: "shell/screens/board.css", handlers: ["shell/handlers/record.js"] },
      states: ["loading", "empty", "populated", "network-error"],
    };
    const { document } = parseHTML("<!doctype html><html><body><div id=shell></div></body></html>");
    globalThis.document = document;
    fakeWorkers();
    const store = batched({
      query: async () => [{ id: "1", fen: "e4", nodes: "100", uci: "" }],
      subscribe: () => () => {},
      create: async () => {},
      update: async () => {},
      remove: async () => {},
    });
    globalThis.fetch = (url) => {
      const u = String(url);
      if (u.endsWith(".html")) return Promise.resolve(new Response(screen));
      if (u.endsWith(".css")) return Promise.resolve(new Response(""));
      if (u.endsWith("record.js")) return Promise.resolve(new Response("const reduce = () => ({ updates: [] });\nreduce;"));
      return Promise.reject(new Error(`unexpected fetch ${u}`));
    };
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    let err = null;
    try {
      await interpretScreen(mount, APP_BASE, route, store, {}, { units: { engine: memoUnit } });
      await tick();
    } catch (e) {
      err = e;
    }
    assert(err instanceof ProgramError, `the refusal escapes the refresh as the app's bug, got ${err}`);
    assert(String(err.message).includes('without "nodes"'), `naming the unbound key, got ${err.message}`);
    assert(mount.querySelector(".screen")?.dataset.state !== "network-error", "and the screen was not dressed as an outage");
  },
});
