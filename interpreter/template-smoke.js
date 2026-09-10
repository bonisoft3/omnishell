import { batched } from "./batched-store.js";
// Deno smoke: named/recursive templates. A <template data-item data-name="X">
// declared anywhere in the screen may be referenced by a region via
// data-template="X" instead of containing its own template. Resolution is
// screen-scoped, collected once at hydration; a name may be referenced from
// inside the template that declares it, so a thread of unknown depth renders
// from one authored shape, terminating when a leaf's child read returns no
// rows. A data-template naming nothing throws at hydrate, before any region
// reads.
import { parseHTML } from "npm:linkedom@0.18.4";

const THREAD_HTML = `<section class="screen" data-screen="thread">
  <ul class="thread" data-live="comment" data-filter="parent_id=eq.root">
    <template data-item data-name="comment">
      <li>
        <span class="body" data-text="{body}"></span>
        <ul class="replies" data-live="comment" data-filter="parent_id=eq.{id}" data-template="comment"></ul>
      </li>
    </template>
  </ul>
</section>`;

const DANGLING_HTML = `<section class="screen" data-screen="thread">
  <ul class="thread" data-live="comment" data-filter="parent_id=eq.root" data-template="nope"></ul>
</section>`;

const ROUTE = {
  screen: "thread",
  files: { html: "shell/screens/thread.html", css: "shell/screens/thread.css", handlers: [] },
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
  const wakes = new Set();
  let reads = 0;
  const store = batched({
    query: async (_t, _order, opts) => {
      reads++;
      const m = /^parent_id=eq\.(.*)$/.exec(opts.filter ?? "");
      if (m === null) throw new Error(`unexpected filter ${opts.filter}`);
      return rows.filter((r) => r.parent_id === m[1]);
    },
    subscribe: (_t, fn) => {
      wakes.add(fn);
      return () => wakes.delete(fn);
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
  return { document, store, poke: () => [...wakes].forEach((fn) => fn(undefined)), readCount: () => reads };
}

Deno.test({
  name: "a three-level thread renders from one authored shape, and grows with the data",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const rows = [
      { id: "c1", parent_id: "root", body: "top" },
      { id: "c2", parent_id: "c1", body: "reply" },
      { id: "c3", parent_id: "c2", body: "reply to reply" },
    ];
    const { document, store, poke } = boot(THREAD_HTML, rows);
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8090/shell/", ROUTE, store, {});
    await tick();
    assert(
      mount.querySelector('[data-id="c1"] [data-id="c2"] [data-id="c3"]') !== null,
      "each reply nests inside its parent's item",
    );
    assert(
      mount.querySelector('[data-id="c3"] .body').textContent === "reply to reply",
      "the deepest row binds through the shared shape",
    );
    assert(
      mount.querySelector('[data-id="c3"] .replies [data-id]') === null,
      "the leaf's child read returns no rows — the recursion's floor",
    );

    rows.push({ id: "c4", parent_id: "c3", body: "deeper still" });
    poke();
    await tick();
    assert(
      mount.querySelector('[data-id="c3"] [data-id="c4"] .body')?.textContent === "deeper still",
      "a row arriving under the leaf opens a fourth level from the same shape",
    );
  },
});

// Everything resolved before hydration walks template content recursively, so
// a handler referenced only inside a named template is seen at load time. The
// witness is the negative: an undeclared name errors at hydrate instead of a
// stamped node clicking into silence.
// Recursion terminates through data; cyclic data would never terminate. The
// same (template, row) pair hydrating inside itself is a broken invariant:
// it throws its own type as the cycle closes, reads stay bounded, and the
// retry loop never dresses it as an outage.
Deno.test({
  name: "a row that is its own descendant errors as the cycle closes, with bounded reads",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { document, store, readCount } = boot(THREAD_HTML, [
      { id: "root", parent_id: "root", body: "ouroboros" },
    ]);
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    let msg = "";
    try {
      await interpretScreen(mount, "http://localhost:8090/shell/", ROUTE, store, {});
    } catch (err) {
      msg = String(err);
    }
    assert(msg.includes("recurses"), `the cycle threw its own error, got: ${msg}`);
    assert(msg.includes('"root"'), `the error names the row, got: ${msg}`);
    assert(readCount() <= 4, `the descent stopped as the cycle closed, ${readCount()} reads`);
    const screen = mount.firstElementChild;
    assert(screen?.dataset.state !== "network-error", "cyclic data is not dressed as an outage");
  },
});

Deno.test({
  name: "the same row may appear in two sibling branches without tripping the cycle guard",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // c2 renders under BOTH c1a and c1b — repetition across branches, no cycle.
    const rows = [
      { id: "c1a", parent_id: "root", body: "left" },
      { id: "c1b", parent_id: "root", body: "right" },
      { id: "c2", parent_id: "c1a", body: "shared" },
    ];
    rows.push({ id: "c2", parent_id: "c1b", body: "shared" });
    const { document, store } = boot(THREAD_HTML, rows);
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8090/shell/", ROUTE, store, {});
    await tick();
    assert(
      mount.querySelectorAll('[data-id="c2"]').length === 2,
      "the shared row rendered once per branch",
    );
  },
});

Deno.test({
  name: "handler resolution sees inside a named template's content",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const html = `<section class="screen" data-screen="thread">
      <ul data-live="comment" data-filter="parent_id=eq.root">
        <template data-item><li>
          <template data-item data-name="reply"><li data-on-click="collapse"></li></template>
        </li></template>
      </ul>
    </section>`;
    const { document, store } = boot(html, []);
    const { interpretScreen } = await import("./screen.js");
    let msg = "";
    try {
      await interpretScreen(document.getElementById("shell"), "http://localhost:8090/shell/", ROUTE, store, {});
    } catch (err) {
      msg = String(err);
    }
    assert(msg.includes('"collapse"'), `the undeclared handler is found through the nesting, got: ${msg}`);
  },
});

Deno.test({
  name: "a data-template naming nothing throws at hydrate, before any region reads",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { document, store, readCount } = boot(DANGLING_HTML, []);
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    let msg = "";
    try {
      await interpretScreen(mount, "http://localhost:8090/shell/", ROUTE, store, {});
    } catch (err) {
      msg = String(err);
    }
    assert(msg.includes('"nope"'), `the error names the missing template, got: ${msg}`);
    assert(readCount() === 0, "no region read before the dangling name threw");
    // A broken invariant, not an outage: the retry loop never dresses it.
    const screen = mount.firstElementChild;
    assert(screen?.dataset.state !== "network-error", "a dangling name is not dressed as an outage");
  },
});
