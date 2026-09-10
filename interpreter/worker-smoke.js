// Deno smoke: the hatch's worker seat — a vendored unit on its own thread,
// props in and named events out. No store, no clock, no screen: what is under
// test is the boundary itself, and the Worker is a stand-in because deno has no
// browser worker here and a real one would answer off the test's own timeline.
import { parseHTML } from "npm:linkedom@0.18.4";

const UNIT = { isolation: "worker", capabilities: [], src: "shell/units/engine/unit.js", note: "an oracle" };
const APP_BASE = "https://app.example/";
const SRC = new URL(UNIT.src, APP_BASE).href;

const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

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
    /** What the unit says, delivered the way the port would. */
    says(data) {
      for (const l of this.listeners) if (l.type === "message") l.fn({ data });
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

  // Silence would hand the app a unit that cannot do what it declared, at the
  // boundary where a grant would be least defensible.
  let threw = null;
  try {
    mountHatch(root(), { unit: { ...UNIT, capabilities: ["sensors.camera"] }, src: SRC });
  } catch (e) {
    threw = e;
  }
  assert(threw !== null, "a capability request is refused rather than ignored");
  assert(made.length === 1, "and no thread was started for it");

  threw = null;
  try {
    mountHatch(root(), { unit: UNIT, src: "javascript:alert(1)" });
  } catch (e) {
    threw = e;
  }
  assert(threw !== null, "a src the terminal will not fetch is refused");
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
  assert(worker.posted.length === 1, `one delivery on ready, got ${worker.posted.length}`);
  assert(worker.posted[0].type === "pronto:props", "delivery is a props message");
  assert(worker.posted[0].props.fen === "three", "the latest value, not the first");
  hatch.destroy();
});

Deno.test("only a message the boundary can rebuild reaches the screen", async () => {
  const { mountHatch } = await import("./hatch.js");
  const made = fakeWorkers();
  const events = [];
  const hatch = mountHatch(root(), { unit: UNIT, src: SRC, onEvent: (e) => events.push(e) });
  const worker = made[0];

  // The reduce that receives an answer is a compartment with nothing endowed
  // and cannot defend itself, so every one of these is refused here.
  for (const shape of [
    null,
    42,
    "answer",
    { type: "pronto:event", name: "answer" },
    { type: "pronto:event", name: "answer", detail: ["e2e4"] },
    { type: "pronto:event", name: "answer", detail: { a: "1", b: "2", c: "3", d: "4", e: "5", f: "6", g: "7", h: "8", i: "9" } },
    { type: "pronto:event", name: "answer", detail: { "Bad-Key": "e2e4" } },
    { type: "pronto:event", name: "answer", detail: { uci: "x".repeat(129) } },
    { type: "pronto:event", name: "answer", detail: { uci: "e2e4\n" } },
    { type: "pronto:event", name: "answer", detail: { uci: 7 } },
  ]) {
    worker.says(shape);
    assert(events.length === 0, `dropped: ${JSON.stringify(shape)}`);
  }

  // And the channel is real, which is the half a seat that drops everything
  // would also satisfy.
  worker.says({ type: "pronto:event", name: "answer", detail: { uci: "e2e4", ply: "0" } });
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
  const detail = events[0].detail;
  assert(Object.isFrozen(detail), "the screen cannot be handed something that changes under it");

  // Built key by key from the validated strings: the unit keeps a live handle
  // on what it posted, and a passed-through object would let it edit the value
  // a reduce is about to read.
  mutable.uci = "e7e5";
  assert(detail.uci === "e2e4", `fresh, not the unit's object, got ${detail.uci}`);
  hatch.destroy();
});
