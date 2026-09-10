// Deno smoke: the handler path end to end through the REAL ses pin — the umd
// dist pre-imported here installs Compartment, so ensureSes skips <script>
// injection (linkedom does not execute scripts) and still runs lockdown +
// compartment evaluation exactly as the browser does.
import { parseHTML } from "npm:linkedom@0.18.4";
import { parseFilter } from "./fragment.js";
import { batched } from "./batched-store.js";

const SCREEN_HTML = `<div class="note-detail">
  <ul class="items" data-live="note_item" data-handler="reorder-items" data-order="position.asc">
    <template data-item>
      <li><span data-drag-handle></span><span data-text="{id}"></span></li>
    </template>
  </ul>
  <form data-form="attach" data-entity="note_attachment" data-action="create">
    <input type="file" name="object_key" data-upload required />
    <button type="submit">Attach</button>
  </form>
</div>`;

// Jessie handler, frozen mechanism: last expression is the reduce function.
const HANDLER_SOURCE = `const reduce = (state, event) => {
  const ids = state.items.map((item) => item.id);
  ids.splice(ids.indexOf(event.fromId), 1);
  ids.splice(ids.indexOf(event.toId), 0, event.fromId);
  return { updates: ids.map((id, i) => ({ op: "patch", id, row: { position: (i + 1) * 10 } })) };
};
reduce;`;

const ROUTE = {
  screen: "note-detail",
  files: {
    html: "shell/screens/note-detail.html",
    css: "shell/screens/note-detail.css",
    handlers: ["shell/handlers/reorder-items.js"],
  },
  states: ["loading", "populated"],
};

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function boot() {
  // linkedom's dispatchEvent mutates fields Deno's native Event seals, so
  // events must be constructed from linkedom's own Event class.
  const { document, Event } = parseHTML(
    "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
  );
  globalThis.document = document;

  const rows = [
    { id: "a", position: 10 },
    { id: "b", position: 20 },
    { id: "c", position: 30 },
  ];
  const calls = { updates: [], creates: [], puts: [], rows: [], drops: [] };
  // put is the only write here that changes what a later read returns, so it
  // is the only one that wakes a subscriber — which is what lets a smoke
  // exercise a reduce concluding about its own collection.
  const subs = new Set();
  const store = batched({
    // Honors the region's filter the way the real stores do — the slot
    // fixtures below pin one row, as the cardinality precondition demands.
    query: async (_table, _order, opts) =>
      rows.filter((r) => (parseFilter(opts?.filter ?? "") ?? []).every((p) => p(r))),
    subscribe: (_table, cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    create: async (table, values) => calls.creates.push({ table, values }),
    update: async (table, id, patch) => calls.updates.push({ table, id, patch }),
    // The real stores insert or patch by the row's own key; here the effect
    // that matters is that one row lands once however often it is stated.
    put: async (table, row) => {
      calls.rows.push({ table, row });
      const i = rows.findIndex((r) => r.id === row.id);
      if (i < 0) rows.push({ ...row });
      else rows[i] = { ...rows[i], ...row };
      for (const cb of subs) setTimeout(cb, 0);
    },
    remove: async (table, id) => {
      calls.drops.push({ table, id });
      const i = rows.findIndex((r) => String(r.id) === String(id));
      if (i >= 0) rows.splice(i, 1);
      for (const cb of subs) setTimeout(cb, 0);
    },
  });

  globalThis.fetch = (url, init) => {
    const u = String(url);
    if (init?.method === "PUT" && u.includes("/blobs/")) {
      calls.puts.push({ url: u, body: init.body });
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    if (u.endsWith(".html")) return Promise.resolve(new Response(SCREEN_HTML));
    if (u.endsWith(".css")) return Promise.resolve(new Response(""));
    if (u.endsWith("reorder-items.js")) return Promise.resolve(new Response(HANDLER_SOURCE));
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  };

  return { document, Event, store, calls };
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

Deno.test({
  name: "drag reorder drives the handler reduce through a real ses Compartment",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot();
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});

    const items = [...mount.querySelectorAll("li[data-id]")];
    assert(items.length === 3, `3 items hydrated, got ${items.length}`);
    assert(items.every((li) => li.draggable === true), "items draggable");

    const [a, , c] = items;
    c.dispatchEvent(new Event("dragstart"));
    a.dispatchEvent(new Event("drop"));
    await tick();

    assert(
      JSON.stringify(calls.updates) ===
        JSON.stringify([
          { table: "note_item", id: "c", patch: { position: 10 } },
          { table: "note_item", id: "a", patch: { position: 20 } },
          { table: "note_item", id: "b", patch: { position: 30 } },
        ]),
      `handler updates applied in order, got ${JSON.stringify(calls.updates)}`,
    );
    assert(mount.firstElementChild.dataset.state === "populated", "screen state intact");
  },
});

Deno.test({
  name: "a throwing handler surfaces network-error without crashing the screen",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot();
    globalThis.fetch = ((inner) => (url, init) =>
      String(url).endsWith("reorder-items.js")
        ? Promise.resolve(new Response("const reduce = () => { throw Error('boom'); };\nreduce;"))
        : inner(url, init))(globalThis.fetch);
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    const [a, , c] = [...mount.querySelectorAll("li[data-id]")];
    c.dispatchEvent(new Event("dragstart"));
    a.dispatchEvent(new Event("drop"));
    await tick();

    assert(calls.updates.length === 0, "no updates applied");
    assert(mount.firstElementChild.dataset.state === "network-error", "network-error state set");
  },
});

Deno.test({
  name: "file control PUTs the blob and substitutes the object key",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot();
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});

    const form = mount.querySelector("form[data-entity=note_attachment]");
    const input = form.querySelector("input[type=file]");
    Object.defineProperty(input, "files", {
      value: [new File(["png-bytes"], "shot.png", { type: "image/png" })],
    });
    // linkedom implements neither constraint validation nor reset; stub the
    // surface the form engine touches.
    form.checkValidity ??= () => true;
    form.reset ??= () => {};
    form.dispatchEvent(new Event("submit"));
    await tick();

    assert(calls.puts.length === 1, `one blob PUT, got ${calls.puts.length}`);
    const key = calls.puts[0].url.match(/\/blobs\/mecha-objects\/([0-9a-f-]{36}\.png)$/)?.[1];
    assert(key, `PUT url shape, got ${calls.puts[0].url}`);
    assert(calls.creates.length === 1, "one create submitted");
    assert(
      calls.creates[0].values.object_key === key,
      `mutation carries the key string, got ${JSON.stringify(calls.creates[0].values)}`,
    );
    assert(mount.firstElementChild.dataset.state === "success", "success state set");
  },
});

// The region declares a DOM event as a handler source, and the reduce names
// what should happen next. Nothing is endowed: the compartment can neither
// write nor wait, so both are things it asks the terminal for.
const CLICKABLE = SCREEN_HTML.replace(
  'data-handler="reorder-items"',
  'data-handler="reorder-items" data-on-click="reorder-items"',
);

const withHandler = (source) => {
  const inner = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const u = String(url);
    if (u.endsWith("reorder-items.js")) return Promise.resolve(new Response(source));
    if (u.endsWith(".html")) return Promise.resolve(new Response(CLICKABLE));
    return inner(url, init);
  };
};

Deno.test({
  name: "a reduce continues by naming the next event, and the chain is a value",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot();
    withHandler(`const reduce = (state, event) => event.type === "click"
  ? { updates: [{ op: "patch", id: "a", row: { position: 1 } }], then: { type: "settle" } }
  : { updates: [{ op: "patch", id: "b", row: { position: 2 } }] };
reduce;`);
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    mount.querySelector(".items").dispatchEvent(new Event("click"));
    await tick(60);

    assert(
      JSON.stringify(calls.updates) ===
        JSON.stringify([
          { table: "note_item", id: "a", patch: { position: 1 } },
          { table: "note_item", id: "b", patch: { position: 2 } },
        ]),
      `the writes of both steps applied in order, got ${JSON.stringify(calls.updates)}`,
    );
    assert(mount.firstElementChild.dataset.state === "populated", "screen state intact");
  },
});

Deno.test({
  name: "a mutation arriving while the reduce runs wakes it again",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, store, calls } = boot();
    const inner = globalThis.fetch;
    globalThis.fetch = (url) => {
      const u = String(url);
      if (u.endsWith("reorder-items.js")) {
        // Each pass states one row that is not there yet and then waits — and
        // the waiting is the point: the mutation its own write raises lands
        // while the chain is still running, and the chain's last step writes
        // nothing, so nothing else will ever wake it. Dropped, that wake is
        // gone and this stops one row short.
        return Promise.resolve(new Response(`const reduce = (state, event) => {
  if (event.type !== "mutation") return { updates: [] };
  const has = (id) => state.items.some((r) => r.id === id);
  const wait = { type: "settle", delay: 60 };
  if (!has("d1")) return { updates: [{ op: "put", id: "d1", row: { position: 91 } }], then: wait };
  if (!has("d2")) return { updates: [{ op: "put", id: "d2", row: { position: 92 } }], then: wait };
  return { updates: [] };
};
reduce;`));
      }
      if (u.endsWith(".html")) {
        return Promise.resolve(new Response(
          SCREEN_HTML.replace('data-handler="reorder-items"', 'data-on-mutation="reorder-items"'),
        ));
      }
      return inner(url);
    };
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    await tick(500);

    assert(
      JSON.stringify(calls.rows.map((c) => c.row.id)) === JSON.stringify(["d1", "d2"]),
      `the reduce was woken by its own write until it settled, got ${JSON.stringify(calls.rows.map((c) => c.row.id))}`,
    );
  },
});

Deno.test({
  name: "a region declares what else its reduce reads, and reads it",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot();
    const asked = [];
    const inner = store.query;
    store.query = async (table, order, opts) => {
      asked.push(table);
      return table === "note_attachment" ? [{ id: "x" }, { id: "y" }] : inner(table, order, opts);
    };
    const inner2 = globalThis.fetch;
    globalThis.fetch = (url) => {
      const u = String(url);
      if (u.endsWith("reorder-items.js")) {
        return Promise.resolve(new Response(`const reduce = (state) => ({
  updates: [{ op: "patch", id: "a", row: { position: state.rows.note_attachment.length } }],
});
reduce;`));
      }
      if (u.endsWith(".html")) {
        return Promise.resolve(new Response(
          CLICKABLE.replace('data-order="position.asc"', 'data-order="position.asc" data-reads="note_attachment"'),
        ));
      }
      return inner2(url);
    };
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    mount.querySelector(".items").dispatchEvent(new Event("click"));
    await tick(40);

    assert(asked.includes("note_attachment"), `the declared read was fetched, asked ${asked}`);
    assert(
      JSON.stringify(calls.updates) ===
        JSON.stringify([{ table: "note_item", id: "a", patch: { position: 2 } }]),
      `the reduce saw the other collection, got ${JSON.stringify(calls.updates)}`,
    );
  },
});

Deno.test({
  name: "a named read arrives filtered and ordered, beside the sugar it leaves alone",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot();
    const asked = [];
    const inner = store.query;
    store.query = async (table, order, opts) => {
      asked.push({ table, order, opts });
      if (table !== "note_attachment") return inner(table, order, opts);
      const all = [
        { id: "x1", kind: "x", rank: 1 },
        { id: "y1", kind: "y", rank: 9 },
        { id: "x2", kind: "x", rank: 5 },
      ];
      const kept = all.filter((r) => (parseFilter(opts?.filter ?? "") ?? []).every((p) => p(r)));
      if (opts?.order === "rank.desc") kept.sort((a, b) => b.rank - a.rank);
      return kept;
    };
    const inner2 = globalThis.fetch;
    globalThis.fetch = (url) => {
      const u = String(url);
      if (u.endsWith("reorder-items.js")) {
        return Promise.resolve(new Response(`const reduce = (state) => ({
  updates: [{ op: "patch", id: "a", row: { position: state.rows.note_attachment.length + ":" + state.rows.top.map((r) => r.id).join(",") } }],
});
reduce;`));
      }
      if (u.endsWith(".html")) {
        return Promise.resolve(new Response(CLICKABLE.replace(
          'data-order="position.asc"',
          'data-order="position.asc" data-reads="note_attachment"' +
            ' data-read-top="note_attachment?kind=eq.x&order=rank.desc"',
        )));
      }
      return inner2(url);
    };
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    mount.querySelector(".items").dispatchEvent(new Event("click"));
    await tick(40);

    const top = asked.find((a) => a.opts?.filter !== undefined);
    assert(
      top !== undefined && top.table === "note_attachment" && top.order === "rank.desc" &&
        top.opts.filter === "kind=eq.x" && top.opts.order === "rank.desc",
      `the named read carries its whole fragment to the store, asked ${JSON.stringify(asked)}`,
    );
    assert(
      JSON.stringify(calls.updates) ===
        JSON.stringify([{ table: "note_item", id: "a", patch: { position: "3:x2,x1" } }]),
      `filtered AND ordered under the name, the bare read whole under its table, got ${
        JSON.stringify(calls.updates)
      }`,
    );
  },
});

Deno.test({
  name: "a named read's placeholders resolve against the region's own row",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot();
    const asked = [];
    const inner = store.query;
    store.query = async (table, order, opts) => {
      asked.push({ table, order, opts });
      return table === "note_attachment" ? [{ id: "m1" }] : inner(table, order, opts);
    };
    const inner2 = globalThis.fetch;
    globalThis.fetch = (url) => {
      const u = String(url);
      if (u.endsWith("reorder-items.js")) {
        return Promise.resolve(new Response(`const reduce = (state) => ({
  updates: [{ op: "patch", id: "a", row: { position: state.rows.mine.length } }],
});
reduce;`));
      }
      if (u.endsWith(".html")) {
        return Promise.resolve(new Response(SCREEN_HTML.replace(
          "</ul>",
          '</ul><div data-live="note_item" data-filter="id=eq.a"' +
            ' data-read-mine="note_attachment?of=eq.{id}"' +
            ' data-on-click="reorder-items"></div>',
        )));
      }
      return inner2(url);
    };
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    mount.querySelector("[data-read-mine]").dispatchEvent(new Event("click"));
    await tick(40);

    const mine = asked.find((a) => a.table === "note_attachment");
    assert(
      mine !== undefined && mine.opts.filter === "of=eq.a",
      `the placeholder resolved from the slot's row, asked ${JSON.stringify(asked)}`,
    );
    assert(
      JSON.stringify(calls.updates) ===
        JSON.stringify([{ table: "note_item", id: "a", patch: { position: 1 } }]),
      `the read landed under its name, got ${JSON.stringify(calls.updates)}`,
    );
  },
});

// bind() wires a listener once, so the closure it holds must read the slot's
// one mutated-in-place ctx — a fresh ctx per refresh would pin the read to
// the first row the slot ever bound, and the shipped standing-slot idiom
// (data-read-log="play?round_id=eq.{id}" on the current round) would follow
// a retired round forever.
Deno.test({
  name: "a slot's named read tracks the row across re-binds",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store } = boot();
    const asked = [];
    const inner = store.query;
    store.query = async (table, order, opts) => {
      if (table === "note_attachment") {
        asked.push(opts?.filter);
        return [{ id: "m1" }];
      }
      return inner(table, order, opts);
    };
    const inner2 = globalThis.fetch;
    globalThis.fetch = (url) => {
      const u = String(url);
      if (u.endsWith("reorder-items.js")) {
        return Promise.resolve(new Response(`const reduce = () => ({ updates: [] });
reduce;`));
      }
      if (u.endsWith(".html")) {
        return Promise.resolve(new Response(SCREEN_HTML.replace(
          "</ul>",
          '</ul><div data-live="note_item" data-filter="id=eq.a"' +
            ' data-read-mine="note_attachment?of=eq.{tag}"' +
            ' data-on-click="reorder-items"></div>',
        )));
      }
      return inner2(url);
    };
    const { interpretScreen } = await import("./screen.js");

    await store.put("note_item", { id: "a", tag: "first" });
    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    const slot = mount.querySelector("[data-read-mine]");
    slot.dispatchEvent(new Event("click"));
    await tick(40);
    assert(asked[0] === "of=eq.first", `the first click read the first row, asked ${JSON.stringify(asked)}`);

    // The slot's row rotates; the re-bind must reach the wired closures.
    await store.put("note_item", { id: "a", tag: "second" });
    await tick(40);
    slot.dispatchEvent(new Event("click"));
    await tick(40);
    assert(
      asked[asked.length - 1] === "of=eq.second",
      `the read tracked the current row, asked ${JSON.stringify(asked)}`,
    );
  },
});

Deno.test({
  name: "a reduce states a row, and stating it twice states the same row",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot();
    // The key is derived from what the row identifies, which is the whole
    // reason a reduce is allowed to write a row it has not seen.
    withHandler(`const reduce = (state, event) => ({
  updates: [{ op: "put", id: \`d:\${state.items.length}\`, row: { position: 40 } }],
});
reduce;`);
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    const region = mount.querySelector(".items");
    region.dispatchEvent(new Event("click"));
    await tick(40);
    region.dispatchEvent(new Event("click"));
    await tick(40);

    assert(calls.rows.length === 2, `stated twice, got ${calls.rows.length}`);
    assert(
      JSON.stringify(calls.rows.map((c) => [c.table, c.row.id])) ===
        JSON.stringify([["note_item", "d:3"], ["note_item", "d:4"]]),
      `each stated against the rows it saw, got ${JSON.stringify(calls.rows)}`,
    );
    // The first row is a row now, not a second copy of one: the second pass
    // counted four, which it could only do if the first had landed once.
    assert(calls.updates.length === 0, "a stated row is not a patch");
  },
});

Deno.test({
  name: "an event names the element it fired on",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot();
    const inner = globalThis.fetch;
    globalThis.fetch = (url) => {
      const u = String(url);
      if (u.endsWith("reorder-items.js")) {
        return Promise.resolve(new Response(`const reduce = (state, event) => ({
  updates: [{ op: "patch", id: "a", row: { position: event.from ?? "nobody" } }],
});
reduce;`));
      }
      if (u.endsWith(".html")) {
        return Promise.resolve(new Response(
          // A singleton region, whose children are affordances rather than
          // rows: a list region sweeps away anything that is not an item.
          SCREEN_HTML.replace(
            "</ul>",
            '</ul><div data-live="note_item" data-filter="id=eq.a">' +
              '<button id="btn-yes" data-on-click="reorder-items">yes</button>' +
              '<button data-on-click="reorder-items">no</button></div>',
          ),
        ));
      }
      return inner(url);
    };
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    mount.querySelector("#btn-yes").dispatchEvent(new Event("click"));
    await tick(40);
    mount.querySelectorAll("button")[1].dispatchEvent(new Event("click"));
    await tick(40);

    assert(
      JSON.stringify(calls.updates.map((u) => u.patch.position)) ===
        JSON.stringify(["btn-yes", "nobody"]),
      `the reduce was told which button, got ${JSON.stringify(calls.updates)}`,
    );
  },
});

Deno.test({
  name: "an animation event tells the reduce which animation ended",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, store, calls } = boot();
    const inner = globalThis.fetch;
    globalThis.fetch = (url) => {
      const u = String(url);
      if (u.endsWith("reorder-items.js")) {
        return Promise.resolve(new Response(`const reduce = (state, event) => ({
  updates: [{ op: "patch", id: "a", row: { position: event.animationName === "beat" ? 1 : 0 } }],
});
reduce;`));
      }
      if (u.endsWith(".html")) {
        return Promise.resolve(new Response(
          SCREEN_HTML.replace('data-handler="reorder-items"', 'data-on-animationend="reorder-items"'),
        ));
      }
      return inner(url);
    };
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    const region = mount.querySelector(".items");
    // linkedom has no AnimationEvent; the field is what the listener reads.
    const fire = (name) => {
      const e = new document.defaultView.Event("animationend", { bubbles: true });
      e.animationName = name;
      region.dispatchEvent(e);
    };
    fire("shell-item-enter");
    fire("beat");
    await tick(40);

    assert(
      JSON.stringify(calls.updates.map((u) => u.patch.position)) === JSON.stringify([0, 1]),
      `the reduce told one animation from the other, got ${JSON.stringify(calls.updates)}`,
    );
  },
});

Deno.test({
  name: "a reduce asks for a draw and is called again with one",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot();
    withHandler(`const reduce = (state, event) => event.type === "click"
  ? { updates: [], then: { type: "drawn", seed: true } }
  : { updates: [{ op: "patch", id: "a", row: { position: typeof event.seed } }] };
reduce;`);
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    mount.querySelector(".items").dispatchEvent(new Event("click"));
    await tick(60);

    assert(
      JSON.stringify(calls.updates) ===
        JSON.stringify([{ table: "note_item", id: "a", patch: { position: "number" } }]),
      `the draw arrived on the next event, got ${JSON.stringify(calls.updates)}`,
    );
  },
});

Deno.test({
  name: "a step the reduce asked to be delayed does not land before its delay",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot();
    withHandler(`const reduce = (state, event) => event.type === "click"
  ? { updates: [{ op: "patch", id: "a", row: { position: 1 } }], then: { type: "settle", delay: 120 } }
  : { updates: [{ op: "patch", id: "b", row: { position: 2 } }] };
reduce;`);
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    mount.querySelector(".items").dispatchEvent(new Event("click"));

    // The wait is the terminal's: a compartment with nothing endowed has no
    // clock, so a reduce that wants one asks for it and is called again.
    await tick(40);
    assert(calls.updates.length === 1, `the delayed step waited, got ${calls.updates.length}`);

    await tick(160);
    assert(
      JSON.stringify(calls.updates.map((u) => u.id)) === JSON.stringify(["a", "b"]),
      `the delayed step arrived, got ${JSON.stringify(calls.updates)}`,
    );
    assert(mount.firstElementChild.dataset.state === "populated", "screen state intact");
  },
});

Deno.test({
  name: "a chain that never settles is bounded by the terminal, not by the app",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot();
    withHandler(`const reduce = () => ({
  updates: [{ op: "patch", id: "a", row: { position: 1 } }],
  then: { type: "again" },
});
reduce;`);
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    mount.querySelector(".items").dispatchEvent(new Event("click"));
    await tick(80);

    assert(calls.updates.length === 8, `the chain stopped at the bound, got ${calls.updates.length}`);
    assert(
      mount.firstElementChild.dataset.state === "network-error",
      "a chain that does not settle surfaces as a refusal, not as a hang",
    );
  },
});

// A store refusal, the client's contract for a 4xx: retrying cannot help and
// the optimistic state has already rolled back.
const refusal = (msg = "409 duplicate") => {
  const e = new Error(msg);
  e.name = "NonRetriableError";
  return e;
};

Deno.test({
  name: "a refused reduce write reaches validation-error, not network-error",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot();
    store.update = async () => {
      throw refusal();
    };
    withHandler(`const reduce = () => ({ updates: [{ op: "patch", id: "a", row: { position: 1 } }] });
reduce;`);
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    mount.querySelector(".items").dispatchEvent(new Event("click"));
    await tick(40);

    assert(calls.updates.length === 0, "no update recorded");
    assert(
      mount.firstElementChild.dataset.state === "validation-error",
      `the server's no is not a transport failure, got ${mount.firstElementChild.dataset.state}`,
    );
  },
});

Deno.test({
  name: "a refusal that outruns the acceptance window still reaches the screen",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store } = boot();
    // The write reports success (the optimistic window closed); the store's
    // late-refusal callback is the only path left back to the screen.
    let late;
    store.update = async (_table, _id, _patch, onRefused) => {
      late = onRefused;
    };
    withHandler(`const reduce = () => ({ updates: [{ op: "patch", id: "a", row: { position: 1 } }] });
reduce;`);
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    mount.querySelector(".items").dispatchEvent(new Event("click"));
    await tick(40);

    assert(typeof late === "function", "the reduce write carried a late-refusal callback");
    assert(mount.firstElementChild.dataset.state === "populated", "accepted optimistically");
    late(refusal());
    await tick(20);
    assert(
      mount.firstElementChild.dataset.state === "validation-error",
      `the late refusal landed, got ${mount.firstElementChild.dataset.state}`,
    );
  },
});

Deno.test({
  name: "a refused write is an event the region's reduce renders as a row",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot();
    store.update = async () => {
      throw refusal();
    };
    const inner = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      const u = String(url);
      if (u.endsWith("reorder-items.js")) {
        return Promise.resolve(new Response(`const reduce = (state, event) => {
  if (event.type === "click") return { updates: [{ op: "patch", id: "a", row: { position: 1 } }] };
  if (event.type === "refused") {
    return { updates: [{ op: "put", id: "notice", row: { position: 99, of: event.id, kind: event.kind, entity: event.entity } }] };
  }
  return { updates: [] };
};
reduce;`));
      }
      if (u.endsWith(".html")) {
        return Promise.resolve(new Response(
          CLICKABLE.replace('data-on-click="reorder-items"', 'data-on-click="reorder-items" data-on-mutation="reorder-items"'),
        ));
      }
      return inner(url, init);
    };
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    mount.querySelector(".items").dispatchEvent(new Event("click"));
    await tick(60);

    const notice = calls.rows.find((c) => c.row.id === "notice");
    assert(notice, `the refusal reached the reduce as data, got ${JSON.stringify(calls.rows)}`);
    assert(
      notice.row.of === "a" && notice.row.kind === "refused" && notice.row.entity === "note_item",
      `the event named the write it withdraws, got ${JSON.stringify(notice.row)}`,
    );
    assert(
      mount.firstElementChild.dataset.state === "populated",
      `the reduce owns the feedback, not a screen state, got ${mount.firstElementChild.dataset.state}`,
    );
  },
});

Deno.test({
  name: "a refused drag does not vanish as network-error",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot();
    store.update = async () => {
      throw refusal();
    };
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    const [a, , c] = [...mount.querySelectorAll("li[data-id]")];
    c.dispatchEvent(new Event("dragstart"));
    a.dispatchEvent(new Event("drop"));
    await tick(40);

    assert(calls.updates.length === 0, "no update recorded");
    assert(
      mount.firstElementChild.dataset.state === "validation-error",
      `the drag's refusal is classified like a form's, got ${mount.firstElementChild.dataset.state}`,
    );
  },
});

Deno.test({
  name: "a form's refusal becomes the same event when its region mounts a reduce",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot();
    store.create = async () => {
      throw refusal();
    };
    const inner = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      const u = String(url);
      if (u.endsWith("reorder-items.js")) {
        return Promise.resolve(new Response(`const reduce = (state, event) => {
  if (event.type === "refused") {
    return { updates: [{ op: "put", id: "notice", row: { position: 99, kind: event.kind, entity: event.entity } }] };
  }
  return { updates: [] };
};
reduce;`));
      }
      if (u.endsWith(".html")) {
        return Promise.resolve(new Response(SCREEN_HTML.replace(
          /<form[\s\S]*<\/form>/,
          '<div data-live="note_item" data-filter="id=eq.a" data-on-mutation="reorder-items">' +
            '<form data-form="attach" data-entity="note_attachment" data-action="create">' +
            '<input type="hidden" name="kind" data-value="x">' +
            "<button type=\"submit\">go</button></form></div>",
        )));
      }
      return inner(url, init);
    };
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    const form = mount.querySelector("form[data-entity=note_attachment]");
    form.checkValidity ??= () => true;
    form.reset ??= () => {};
    form.dispatchEvent(new Event("submit"));
    await tick(60);

    const notice = calls.rows.find((c) => c.row.id === "notice");
    assert(notice, `the form's refusal reached the reduce, got ${JSON.stringify(calls.rows)}`);
    assert(
      notice.row.kind === "refused" && notice.row.entity === "note_attachment",
      `the event carries the form's entity, got ${JSON.stringify(notice.row)}`,
    );
    assert(
      mount.firstElementChild.dataset.state === "populated",
      `the submit state handed back, got ${mount.firstElementChild.dataset.state}`,
    );
  },
});

Deno.test({
  name: "a mutation on the region's collection wakes its reduce with the rows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, store, calls } = boot();
    // The rows the reduce sees are the store's, not the DOM's: `position` is
    // never rendered into the markup, so a fold that reads it could not have
    // been fed by watching attributes.
    const inner = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      const u = String(url);
      if (u.endsWith("reorder-items.js")) {
        return Promise.resolve(new Response(`const reduce = (state, event) => ({
  updates: [{ op: "patch", id: "sum", row: { total: state.items.reduce((n, r) => n + r.position, 0), on: event.type } }],
});
reduce;`));
      }
      if (u.endsWith(".html")) {
        return Promise.resolve(new Response(
          SCREEN_HTML.replace('data-handler="reorder-items"', 'data-on-mutation="reorder-items"'),
        ));
      }
      return inner(url, init);
    };
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    await tick(40);

    assert(calls.updates.length === 1, `woken once, got ${calls.updates.length}`);
    assert(
      JSON.stringify(calls.updates[0]) ===
        JSON.stringify({ table: "note_item", id: "sum", patch: { total: 60, on: "mutation" } }),
      `the reduce saw the store's rows, got ${JSON.stringify(calls.updates[0])}`,
    );
  },
});

Deno.test({
  name: "two regions waking one fold open a single sitting, not one each",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, store, calls } = boot();
    const inner = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      const u = String(url);
      if (u.endsWith("reorder-items.js")) {
        // The open shape: a conclusion asks for a draw, and the row's id
        // derives from that draw — so two concurrent runs of the fold would
        // mint two rows for one conclusion. The seat, not the reduce, is what
        // makes the second wake see the first's write.
        return Promise.resolve(new Response(`const reduce = (state, event) => {
  if (state.rows.note_item.some((r) => String(r.id).startsWith("m"))) return { updates: [] };
  if (event.type !== "open") return { updates: [], then: { type: "open", seed: true } };
  return { updates: [{ op: "put", id: "m" + event.seed, row: { position: 99 } }] };
};
reduce;`));
      }
      if (u.endsWith(".html")) {
        return Promise.resolve(new Response(`<section class="screen" data-screen="note">
  <ul data-live="note_item" data-on-mutation="reorder-items" data-reads="note_item"><template data-item><li data-text="{id}"></li></template></ul>
  <ol data-live="note_item" data-on-mutation="reorder-items" data-reads="note_item"><template data-item><li data-text="{id}"></li></template></ol>
</section>`));
      }
      return inner(url, init);
    };
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    await tick(200);

    const minted = calls.rows.filter((c) => String(c.row.id).startsWith("m"));
    assert(minted.length === 1, `one sitting opened, got ${minted.length}: ${JSON.stringify(calls.rows)}`);
  },
});

// The seat is keyed by the handler AND its declared world: a region whose
// data-read-* names a different filter concludes from a different world, so
// coalescing it into another region's seat would replay closures over rows
// it never declared.
Deno.test({
  name: "regions sharing a fold but declaring different reads keep separate seats",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, store, calls } = boot();
    // Slowed so the first region's fold still holds its seat while the second
    // region wires — the coalesced re-run is exactly the hazard: it would
    // replay the first region's closures over a world the second declared
    // differently. The fold concludes through update, which wakes no
    // subscriber, so no later mutation hands the starved region another turn.
    const innerQuery = store.query;
    store.query = async (t, o, opts) => {
      await tick(40);
      return innerQuery(t, o, opts);
    };
    const inner = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      const u = String(url);
      if (u.endsWith("reorder-items.js")) {
        return Promise.resolve(new Response(`const reduce = (state, event) => {
  const world = state.rows.mine.map((r) => r.id).sort().join("+");
  if (world === "") return { updates: [] };
  return { updates: [{ op: "patch", id: "probe-" + world, row: { seen: true } }] };
};
reduce;`));
      }
      if (u.endsWith(".html")) {
        return Promise.resolve(new Response(`<section class="screen" data-screen="note">
  <ul data-live="note_item" data-on-mutation="reorder-items" data-reads="note_item" data-read-mine="note_item?id=eq.a"><template data-item><li data-text="{id}"></li></template></ul>
  <ol data-live="note_item" data-on-mutation="reorder-items" data-reads="note_item" data-read-mine="note_item?id=eq.b"><template data-item><li data-text="{id}"></li></template></ol>
</section>`));
      }
      return inner(url, init);
    };
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    await tick(400);

    const probed = [...new Set(calls.updates.map((c) => c.id))].sort();
    assert(
      JSON.stringify(probed) === JSON.stringify(["probe-a", "probe-b"]),
      `each seat concluded from its own declared world, got ${JSON.stringify(probed)}`,
    );
  },
});

// data-read-* placeholders resolve per step against the region's CURRENT row
// — a slot that rebinds must not keep reading the world its first row
// declared.
Deno.test({
  name: "a slot fold's named read tracks the current row across a rebind",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, store, calls } = boot();
    const inner = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      const u = String(url);
      if (u.endsWith("reorder-items.js")) {
        return Promise.resolve(new Response(`const reduce = (state, event) => {
  const seen = state.rows.self.map((r) => r.id).join("+");
  if (seen === "") return { updates: [] };
  return { updates: [{ op: "patch", id: "probe-" + seen, row: { seen: true } }] };
};
reduce;`));
      }
      if (u.endsWith(".html")) {
        return Promise.resolve(new Response(`<section class="screen" data-screen="note">
  <div data-live="note_item" data-filter="position=eq.10" data-on-mutation="reorder-items"
       data-read-self="note_item?id=eq.{id}" data-text="{id}"></div>
</section>`));
      }
      return inner(url, init);
    };
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    await tick(60);
    assert(
      calls.updates.some((c) => c.id === "probe-a"),
      `the first bind's world is row a's, got ${JSON.stringify(calls.updates)}`,
    );

    // Hand the slot's filter to a different row: a leaves, b arrives.
    await store.put("note_item", { id: "a", position: 40 });
    await tick(60);
    await store.put("note_item", { id: "b", position: 10 });
    await tick(120);

    assert(
      calls.updates.some((c) => c.id === "probe-b"),
      `after the rebind the named read resolves against row b, got ${JSON.stringify(calls.updates)}`,
    );
  },
});

Deno.test({
  name: "a fold's run of stated rows reaches the store as one call",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, store } = boot();
    // What the store is handed, rather than what it does with it: the whole
    // point of the batch is that the collection is touched once for it, and a
    // decomposition below this line cannot put that back.
    const batches = [];
    const inner = store.write;
    store.write = async (table, rows, onRefused) => {
      batches.push(rows.length);
      return inner(table, rows, onRefused);
    };
    const outer = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      const u = String(url);
      if (u.endsWith("reorder-items.js")) {
        // A fixpoint, because a write is a mutation and a mutation wakes this
        // fold again: one that restated its rows unconditionally would write
        // them forever.
        return Promise.resolve(new Response(`const reduce = (state) => state.items.some((r) => r.id === "r1")
  ? ({ updates: [] })
  : ({
      updates: [
        { op: "put", entity: "note_item", id: "r1", row: { tag: "one" } },
        { op: "put", entity: "note_item", id: "r2", row: { tag: "two" } },
        { op: "put", entity: "note_item", id: "r3", row: { tag: "three" } },
      ],
    });
reduce;`));
      }
      if (u.endsWith(".html")) {
        return Promise.resolve(new Response(
          SCREEN_HTML.replace('data-handler="reorder-items"', 'data-on-mutation="reorder-items"'),
        ));
      }
      return outer(url, init);
    };
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    await tick(40);

    assert(
      batches.length === 1 && batches[0] === 3,
      `three stated rows are one write of three, got ${JSON.stringify(batches)}`,
    );
  },
});

Deno.test({
  name: "a reduce states a row's absence, and the row goes",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot();
    // Recompute absolutely, write differentially: the fold keeps the rows it
    // wants and states the absence of the rest. Without a delete it could only
    // ever grow the set.
    withHandler(`const reduce = (state, event) => event.type !== "click" ? { updates: [] } : {
  updates: state.items.filter((r) => r.id !== "b").map((r) => ({ op: "delete", id: r.id })),
};
reduce;`);
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    assert(mount.querySelectorAll("li[data-id]").length === 3, "three rows hydrated");

    mount.querySelector(".items").dispatchEvent(new Event("click"));
    await tick(60);

    assert(
      JSON.stringify(calls.drops) ===
        JSON.stringify([{ table: "note_item", id: "a" }, { table: "note_item", id: "c" }]),
      `both absences reached the store as drops, got ${JSON.stringify(calls.drops)}`,
    );
    const left = [...mount.querySelectorAll("li[data-id]")].map((li) => li.dataset.id);
    assert(JSON.stringify(left) === JSON.stringify(["b"]), `only the kept row is drawn, got ${left}`);
    assert(calls.updates.length === 0 && calls.rows.length === 0, "a delete is not a write");
  },
});

Deno.test({
  name: "an update that names no op is a program error",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot();
    // Inferring the op from which key is present is what lets a fold say one
    // thing and mean another: a patch that happens to carry a row is a put by
    // accident, and silence is how that ships.
    //
    // Two good updates of DIFFERENT ops go first, so a run of them is complete
    // and ready to write before the bad one is reached: the batch is classified
    // before any of it is written, and a fold's own bug must not land half a
    // batch before it is found.
    withHandler(`const reduce = (state, event) => event.type !== "click" ? { updates: [] } : {
  updates: [
    { op: "patch", id: "b", row: { position: 7 } },
    { op: "put", id: "z", row: { position: 8 } },
    { id: "a", row: { position: 1 } },
  ],
};
reduce;`);
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    mount.querySelector(".items").dispatchEvent(new Event("click"));
    await tick(60);

    assert(
      mount.firstElementChild.dataset.state === "network-error",
      `the screen reports the reduce's throw, got ${mount.firstElementChild.dataset.state}`,
    );
    assert(
      calls.updates.length === 0 && calls.rows.length === 0 && calls.drops.length === 0,
      "a batch the terminal cannot classify writes none of itself",
    );
  },
});
