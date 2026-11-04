// Deno smoke: the hatch's agent seat — a vendored unit on its own thread,
// props in and named events out. No store, no clock, no screen: what is under
// test is the boundary itself, and the Worker is a stand-in because deno has no
// browser worker here and a real one would answer off the test's own timeline.
import { parseHTML } from "npm:linkedom@0.18.4";
import { batched } from "./batched-store.js";
import { ProgramError } from "./fragment.js";

const UNIT = { isolation: "agent", ports: { reads: ["game"], raises: { answer: { type: "object", fields: { uci: { type: "string", maxLength: 128 }, ply: { type: "string", maxLength: 128 } } } } }, src: "shell/units/engine/unit.js", note: "an oracle" };
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
  made.fetched = [];
  globalThis.fetch = (url) => {
    made.fetched.push(String(url));
    return Promise.resolve(new Response(`/* ${url} */`));
  };
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
  await tick();

  assert(made.length === 1, `one worker constructed, got ${made.length}`);
  assert(made.fetched[0] === SRC, `the unit's src resolved against appBase, got ${made.fetched[0]}`);
  // Started from a blob: of its bytes, the worker inherits the page's policy.
  assert(String(made[0].url).startsWith("blob:"), `started from a blob:, got ${made[0].url}`);
  // A classic worker: a unit is one script.
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
  await tick();
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
  await tick();
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
  await tick();
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
  await tick();

  const mutable = { uci: "e2e4", ply: "0" };
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

Deno.test("a unit that throws is the app's bug, not a console line", async () => {
  const { mountHatch } = await import("./hatch.js");
  const made = fakeWorkers();
  const hatch = mountHatch(root(), { unit: UNIT, src: SRC });
  await tick();
  let prevented = false;
  const [threw] = await escaped(() =>
    setTimeout(() => {
      for (const l of made[0].listeners) {
        if (l.type === "error") l.fn({ message: "Geoapify answered 403", preventDefault: () => (prevented = true) });
      }
    }, 0)
  );
  assert(threw instanceof ProgramError && threw.message.includes("Geoapify answered 403"), `the worker's error is refused by name, got ${threw}`);
  assert(prevented, "and the browser's own report of it is cancelled");
  hatch.destroy();
});

Deno.test("a hole in a list is no item its shape admits, and a unit's address must be this origin's", async () => {
  const { mountHatch, rebuildDetail } = await import("./hatch.js");
  // Structured clone keeps holes and Array.prototype.map skips them.
  let threw = null;
  try {
    rebuildDetail({ type: "array", maxItems: 4, items: { type: "boolean" } }, [, true]);
  } catch (e) {
    threw = e;
  }
  assert(String(threw?.message).includes("detail[0]: invalid boolean"), `a hole is refused, got ${threw}`);
  const made = fakeWorkers();
  const was = globalThis.location;
  globalThis.location = new URL(APP_BASE);
  try {
    threw = null;
    try {
      mountHatch(root(), { unit: UNIT, src: "https://evil.example/u.js" });
    } catch (e) {
      threw = e;
    }
    assert(threw instanceof ProgramError && threw.message.includes("crosses origins"), `refused before any fetch, got ${threw}`);
    assert(made.fetched.length === 0, "and nothing was fetched");
  } finally {
    globalThis.location = was;
  }
});

// Before the memo test below: it locks SES down, after which a refusal
// thrown from a timer ends the process instead of reaching `escaped`.
Deno.test("the declared shape, not an alphabet, decides a detail; size is the seat's only floor", async () => {
  const { mountHatch, rebuildDetail, DETAIL_BYTES } = await import("./hatch.js");
  const made = fakeWorkers();
  const events = [];
  const place = {
    type: "object",
    fields: {
      label: { type: "string", maxLength: 300 },
      lines: { type: "array", maxItems: 4, items: { type: "string", maxLength: 300 } },
      exact: { type: "boolean" },
      zoom: { type: "integer", min: 0, max: 22 },
    },
  };
  const unit = { ...UNIT, ports: { reads: [], raises: { place } } };
  const hatch = mountHatch(root(), { unit, src: SRC, onEvent: (e) => events.push(e) });
  await tick();
  // An address in São Paulo, Tel Aviv or Shanghai must cross: the shape
  // decides a field, never an alphabet the seat imposes on every unit.
  const label = "Praça da Sé, São Paulo · רחוב הרצל · 上海市";
  const first = await escaped(() => made[0].says({ type: "pronto:event", name: "place", detail: { label, lines: ["Sé", "01001-000"], exact: true, zoom: 17 } }));
  assert(first.length === 0, `admitted without a refusal, got ${first}`);
  assert(JSON.stringify(events.map((e) => e.detail)) === JSON.stringify([{ label, lines: ["Sé", "01001-000"], exact: true, zoom: 17 }]), `every script and type arrives, got ${JSON.stringify(events)}`);
  assert(Object.isFrozen(events[0].detail.lines), "nested values are the terminal's, frozen");

  // The app's own wrapper posting outside its declared shape is its bug.
  let [threw] = await escaped(() => made[0].says({ type: "pronto:event", name: "place", detail: { label, lines: [], exact: "yes", zoom: 17 } }));
  assert(threw instanceof ProgramError && threw.message.includes("detail.exact: invalid boolean"), `refused by shape, got ${threw}`);
  [threw] = await escaped(() => made[0].says({ type: "pronto:event", name: "place", detail: { label, lines: [], exact: true, zoom: 17, extra: "x" } }));
  assert(threw instanceof ProgramError && threw.message.includes("detail.extra: undeclared field"), `an undeclared field is refused, got ${threw}`);
  assert(events.length === 1, "and neither reached the screen");
  hatch.destroy();

  // The floor holds even where a shape admits more than it.
  const wide = { type: "object", fields: { image: { type: "array", maxItems: 1024, items: { type: "string", maxLength: 65536 } } } };
  const chunk = "x".repeat(65536);
  let over = null;
  try {
    rebuildDetail(wide, { image: Array(Math.ceil(DETAIL_BYTES / (chunk.length * 2)) + 1).fill(chunk) });
  } catch (e) {
    over = e;
  }
  assert(String(over?.message).includes(`over ${DETAIL_BYTES} bytes`), `a detail past the floor is refused, got ${over}`);
  assert(rebuildDetail(wide, { image: [chunk] }).image[0].length === 65536, "one under it is admitted");
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
      ports: { reads: ["answer"], raises: { answer: { type: "object", fields: { fen: { type: "string", maxLength: 128 }, nodes: { type: "string", maxLength: 128 }, uci: { type: "string", maxLength: 128 } } } } },
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
      if (u.endsWith("unit.js")) return Promise.resolve(new Response(""));
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
