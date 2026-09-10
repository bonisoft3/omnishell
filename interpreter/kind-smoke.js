import { batched } from "./batched-store.js";
// Deno smoke: per-kind templates. A region holds several item templates, each
// optionally narrowed by a data-when fragment; per row the first template in
// document order whose predicates admit it stamps the shape, one with no
// data-when is the default, and a row no template admits errors — the runtime
// holds no fallback shape. A surviving row whose matched template changes
// re-stamps its node from the new template, and DOM-private state goes with
// the old node.
import { parseHTML } from "npm:linkedom@0.18.4";

const SCREEN_HTML = `<section class="screen" data-screen="feed">
  <ul class="feed" data-live="entry">
    <template data-item data-when="kind=eq.note">
      <li class="note"><span data-text="{body}"></span></li>
    </template>
    <template data-item data-when="kind=eq.note">
      <li class="shadowed"></li>
    </template>
    <template data-item data-when="kind=eq.link">
      <li class="link"><a data-text="{body}"></a></li>
    </template>
    <template data-item>
      <li class="other"><span data-text="{kind}"></span></li>
    </template>
  </ul>
</section>`;

// The same region with no default template: exhaustiveness is lint's job, and
// a row of an unadmitted kind must error rather than borrow a shape.
const NO_DEFAULT_HTML = `<section class="screen" data-screen="feed">
  <ul class="feed" data-live="entry">
    <template data-item data-when="kind=eq.note"><li class="note"></li></template>
    <template data-item data-when="kind=eq.link"><li class="link"></li></template>
  </ul>
</section>`;

const ROUTE = {
  screen: "feed",
  files: { html: "shell/screens/feed.html", css: "shell/screens/feed.css", handlers: [] },
  states: ["loading", "empty", "populated"],
};

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

function boot(html, rows) {
  const { document } = parseHTML(
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
    put: async () => {},
    remove: async () => {},
  });
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.endsWith(".html")) return Promise.resolve(new Response(html));
    if (u.endsWith(".css")) return Promise.resolve(new Response(""));
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  };
  return { document, store, poke: (changes) => wake(changes) };
}

async function render(html, rows) {
  const { document, store, poke } = boot(html, rows);
  const { interpretScreen } = await import("./screen.js");
  const mount = document.getElementById("shell");
  await interpretScreen(mount, "http://localhost:8090/shell/", ROUTE, store, {});
  return { mount, poke };
}

Deno.test({
  name: "a mixed-kind list renders per-kind shapes, first match in document order",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { mount } = await render(SCREEN_HTML, [
      { id: "1", kind: "note", body: "a note" },
      { id: "2", kind: "link", body: "a link" },
      { id: "3", kind: "poll", body: "unshaped" },
    ]);
    const items = [...mount.querySelectorAll("li[data-id]")];
    assert(
      items.map((li) => li.className).join(",") === "note,link,other",
      `each row wears its kind's shape, got ${items.map((li) => li.className).join(",")}`,
    );
    assert(
      mount.querySelector('li[data-id="1"] [data-text]').textContent === "a note",
      "the kinded shape binds its row",
    );
    assert(
      mount.querySelector('li[data-id="3"] [data-text]').textContent === "poll",
      "the default template binds a row no data-when admits",
    );
    assert(mount.querySelector(".shadowed") === null, "a later template admitting the same kind never stamps");
  },
});

Deno.test({
  name: "a kind flip re-stamps the node; same-kind survivors keep theirs",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const rows = [
      { id: "1", kind: "note", body: "flips" },
      { id: "2", kind: "link", body: "stays" },
    ];
    const { mount, poke } = await render(SCREEN_HTML, rows);
    const flipped = mount.querySelector('li[data-id="1"]');
    const kept = mount.querySelector('li[data-id="2"]');
    // Stand in for DOM-private state — focus, selection, unsent text.
    flipped._readerState = true;

    rows[0] = { id: "1", kind: "link", body: "flips" };
    poke(undefined);
    await tick();

    const after = mount.querySelector('li[data-id="1"]');
    assert(after.className === "link", "the flipped row wears the new kind's shape");
    assert(after !== flipped, "the flip replaced the node");
    assert(after._readerState === undefined, "DOM-private state went with the old node");
    assert(!flipped.isConnected, "the departed shape left the document");
    assert(mount.querySelector('li[data-id="2"]') === kept, "a same-kind survivor keeps its node");
  },
});

// bindHatches mounts on an item's root element too, so both release sweeps —
// the kind-flip re-stamp and the departed-row exit — must reach the root, or
// the page-level message listener the hatch holds leaks and live hatches
// double.
Deno.test({
  name: "a hatch on the item's root element is destroyed by the flip and by departure",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const HATCHED = `<section class="screen" data-screen="feed">
      <ul class="feed" data-live="entry">
        <template data-item data-when="kind=eq.note"><li class="note" data-hatch="embed"></li></template>
        <template data-item><li class="other" data-hatch="embed"></li></template>
      </ul>
    </section>`;
    const UNIT = { isolation: "iframe", capabilities: [], src: "shell/units/embed.html" };
    const rows = [{ id: "1", kind: "note" }];
    const { document, store, poke } = boot(HATCHED, rows);
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8090/shell/", ROUTE, store, {}, { units: { embed: UNIT } });

    const first = mount.querySelector('li[data-id="1"]');
    const spy = (node) => {
      const h = node._prontoHatch;
      const inner = h.destroy.bind(h);
      let destroyed = false;
      h.destroy = () => {
        destroyed = true;
        inner();
      };
      return () => destroyed;
    };
    const flipReleased = spy(first);

    rows[0] = { id: "1", kind: "poll" };
    poke(undefined);
    await tick();
    assert(flipReleased(), "the flip destroyed the old root's hatch");
    const restamped = mount.querySelector('li[data-id="1"]');
    assert(restamped.className === "other" && restamped._prontoHatch !== undefined, "the new shape has its own hatch");
    const exitReleased = spy(restamped);

    rows.length = 0;
    poke(undefined);
    await tick(60);
    assert(exitReleased(), "the departed row's exit destroyed its root hatch");
  },
});

// A data-when is matched against the row itself: a placeholder would compare
// rows against the brace text and admit nothing, silently — refused at
// hydrate instead, matching the derive-side kindLint.
Deno.test({
  name: "a data-when carrying a placeholder refuses to hydrate",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const html = `<section class="screen" data-screen="feed">
      <ul class="feed" data-live="entry">
        <template data-item data-when="owner=eq.{param.me}"><li></li></template>
        <template data-item><li></li></template>
      </ul>
    </section>`;
    const { document, store } = boot(html, [{ id: "1", owner: "me" }]);
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    let msg = "";
    try {
      await interpretScreen(mount, "http://localhost:8090/shell/", ROUTE, store, { me: "me" });
    } catch (err) {
      msg = String(err);
    }
    assert(msg.includes("placeholder"), `the placeholder is refused by name, got: ${msg}`);
    assert(msg.includes("{param.me}"), `the error shows the authored data-when, got: ${msg}`);
  },
});

Deno.test({
  name: "a row no template admits errors, naming the region",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { document, store } = boot(NO_DEFAULT_HTML, [{ id: "1", kind: "poll" }]);
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    let msg = "";
    try {
      await interpretScreen(mount, "http://localhost:8090/shell/", ROUTE, store, {});
    } catch (err) {
      msg = String(err);
    }
    assert(mount.querySelector("li[data-id]") === null, "an unadmitted row stamps no shape");
    assert(msg.includes('"entry"'), `the error names the region, got: ${msg}`);
    assert(msg.includes('"1"'), `the error names the row, got: ${msg}`);
    // A broken invariant, not an outage: the retry loop never dresses it.
    const screen = mount.firstElementChild;
    assert(screen.dataset.state !== "network-error", "an unadmitted kind is not dressed as an outage");
  },
});
