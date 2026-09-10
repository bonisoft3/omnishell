import { batched } from "./batched-store.js";
// Deno smoke: a region only re-renders the rows its input actually changed.
//
// This is the property the whole incremental model is for. The store hands
// the region the change set the engine computed against its query; a row that
// set does not name is already rendered from exactly the value it holds, so
// touching it again would rebuild a body the reader may be mid-selection in.
// The test states that behaviourally rather than by counting calls: it writes
// into a rendered node by hand and asserts the write survives a refresh that
// did not name that row — and does not survive one that did.
import { parseHTML } from "npm:linkedom@0.18.4";

const SCREEN_HTML = `<section class="screen" data-screen="wall">
  <ul class="cards" data-live="note" data-order="created_at.desc">
    <template data-item>
      <li><span data-text="{title}"></span></li>
    </template>
  </ul>
</section>`;

const ROUTE = {
  screen: "wall",
  files: { html: "shell/screens/wall.html", css: "shell/screens/wall.css", handlers: [] },
  states: ["loading", "empty", "populated"],
};

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

function boot(rows) {
  const { document, Event } = parseHTML(
    "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
  );
  globalThis.document = document;
  let wake;
  const store = batched({
    query: async () => rows,
    subscribe: (_t, fn) => {
      wake = fn;
      return () => {};
    },
    create: async () => {},
    update: async () => {},
    remove: async () => {},
  });
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.endsWith(".html")) return Promise.resolve(new Response(SCREEN_HTML));
    if (u.endsWith(".css")) return Promise.resolve(new Response(""));
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  };
  return { document, Event, store, poke: (changes) => wake(changes) };
}

const ROWS = () => [
  { id: "a", title: "first" },
  { id: "b", title: "second" },
  { id: "c", title: "third" },
];

const titleOf = (mount, id) =>
  mount.querySelector(`li[data-id="${id}"] [data-text='{title}']`).textContent;
const scribble = (mount, id, text) => {
  mount.querySelector(`li[data-id="${id}"] [data-text='{title}']`).textContent = text;
};

async function render(rows) {
  const { document, store, poke } = boot(rows);
  const { interpretScreen } = await import("./screen.js");
  const mount = document.getElementById("shell");
  await interpretScreen(mount, "http://localhost:8090/shell/", ROUTE, store, {});
  return { mount, poke };
}

Deno.test({
  name: "a row the change set does not name is left alone",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const rows = ROWS();
    const { mount, poke } = await render(rows);
    assert(titleOf(mount, "b") === "second", "b rendered on first paint");

    // Stand in for anything the reader owns on a surviving node.
    scribble(mount, "b", "READER STATE");
    rows[0] = { id: "a", title: "first, edited" };
    poke([{ type: "update", value: rows[0], previousValue: { id: "a", title: "first" } }]);
    await tick();

    assert(titleOf(mount, "a") === "first, edited", "the named row re-binds");
    assert(titleOf(mount, "b") === "READER STATE", "an unnamed row is not re-bound");
  },
});

Deno.test({
  name: "a wake with no change set reconsiders every row",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // A settled own write, an outage retry and resume all arrive this way:
    // the cause cannot be attributed to a delta, so nothing may be skipped.
    const { mount, poke } = await render(ROWS());
    scribble(mount, "b", "READER STATE");
    poke(undefined);
    await tick();
    assert(titleOf(mount, "b") === "second", "an unattributable wake re-binds everything");
  },
});

Deno.test({
  name: "a change that names no row reconsiders every row",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Skipping on a delta we cannot attribute would render stale, which is the
    // one outcome worth spending a re-bind to avoid.
    const { mount, poke } = await render(ROWS());
    scribble(mount, "b", "READER STATE");
    poke([{ type: "update", key: "opaque-stream-key" }]);
    await tick();
    assert(titleOf(mount, "b") === "second", "an unattributable change re-binds everything");
  },
});

Deno.test({
  name: "arrivals and departures still land",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const rows = ROWS();
    const { mount, poke } = await render(rows);
    scribble(mount, "b", "READER STATE");

    rows.push({ id: "d", title: "fourth" });
    poke([{ type: "insert", value: rows[3] }]);
    await tick();
    assert(titleOf(mount, "d") === "fourth", "an arrival renders");
    assert(titleOf(mount, "b") === "READER STATE", "an arrival does not disturb its neighbours");

    rows.splice(2, 1); // drop c
    poke([{ type: "delete", previousValue: { id: "c", title: "third" } }]);
    await tick();
    assert(mount.querySelector('li[data-id="c"]') === null, "a departure leaves the document");
    assert(titleOf(mount, "b") === "READER STATE", "a departure does not disturb its neighbours");
  },
});

// A singleton region is a sink too: when its row goes, its output must go
// with it. Leaving the last row's values standing is how a deleted subject
// kept rendering itself underneath the notice saying it was gone.
const SINGLETON_HTML = `<section class="screen" data-screen="piece">
  <article class="piece" data-live="note" data-filter="id=eq.n1">
    <h1 data-text="{title}"></h1>
    <img src="{image_url}" alt="">
    <p data-text="{body}"></p>
  </article>
</section>`;

const SINGLETON_ROUTE = {
  screen: "piece",
  files: { html: "shell/screens/piece.html", css: "shell/screens/piece.css", handlers: [] },
  states: ["loading", "populated", "gone"],
};

Deno.test({
  name: "a singleton whose row vanishes stops rendering it",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { document, Event } = parseHTML(
      "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
    );
    globalThis.document = document;
    let wake;
    let rows = [{ id: "n1", title: "A piece", body: "prose", image_url: "/img/x.png" }];
    const store = {
      query: async () => rows,
      subscribe: (_t, fn) => { wake = fn; return () => {}; },
      create: async () => {}, update: async () => {}, remove: async () => {},
    };
    globalThis.fetch = (url) => {
      const u = String(url);
      if (u.endsWith(".html")) return Promise.resolve(new Response(SINGLETON_HTML));
      if (u.endsWith(".css")) return Promise.resolve(new Response(""));
      return Promise.reject(new Error(`unexpected fetch ${u}`));
    };
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8090/shell/", SINGLETON_ROUTE, store, {});

    const piece = mount.querySelector(".piece");
    assert(piece.querySelector("h1").textContent === "A piece", "the row renders");
    assert(piece.querySelector("img").getAttribute("src") === "/img/x.png", "and its image");

    rows = [];
    wake(undefined);
    await tick();

    const screen = mount.querySelector(".screen");
    assert(screen.dataset.state === "gone", "the screen says gone");
    assert(piece.querySelector("h1").textContent === "", "the title goes with the row");
    assert(piece.querySelector("p").textContent === "", "and the body");
    // Neither the last value, nor "", nor the literal {image_url}: all three
    // are requests for something. Absent is the only one that asks for nothing.
    assert(!piece.querySelector("img").hasAttribute("src"), "the image asks for nothing at all");
  },
});
