import { batched } from "./batched-store.js";
// Deno smoke: a nested region inside an item's template, hydrated with real
// rows — the article shape. Every other smoke's regions are flat, and the
// batteries fill parametrized routes with slugs matching nothing, so a
// template that only breaks under a stamped row is invisible to both.
import { parseHTML } from "npm:linkedom@0.18.4";

const SCREEN_HTML = `<section class="screen" data-screen="piece">
  <div class="pieces" data-live="article">
    <template data-item>
      <article>
        <h2 data-text="{title}"></h2>
        <div class="cover" data-live="article" data-filter="id=eq.{id}&cover_url=not.is.null">
          <template data-item>
            <figure><img src="{cover_url}" alt=""></figure>
          </template>
        </div>
      </article>
    </template>
  </div>
</section>`;

const ROUTE = {
  screen: "piece",
  files: { html: "shell/screens/piece.html", css: "shell/screens/piece.css", handlers: [] },
  states: ["loading", "empty", "populated"],
};

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function boot(rows) {
  const { document } = parseHTML(
    "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
  );
  globalThis.document = document;
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.endsWith(".html")) return Promise.resolve(new Response(SCREEN_HTML));
    if (u.endsWith(".css")) return Promise.resolve(new Response(""));
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  };
  const store = batched({
    // The nested region's filter arrives interpolated from the parent row;
    // honoring it is what the smoke is about.
    query: async (_table, _order, opts) => {
      const m = /id=eq\.([^&]*)/.exec(opts?.filter ?? "");
      const wantCover = (opts?.filter ?? "").includes("cover_url=not.is.null");
      return rows.filter((r) =>
        (m === null || String(r.id) === m[1]) && (!wantCover || (r.cover_url ?? "") !== "")
      );
    },
    subscribe: () => () => {},
    create: async () => {},
    update: async () => {},
    put: async () => {},
    remove: async () => {},
  });
  return { document, store };
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

Deno.test({
  name: "an item's nested region hydrates against its own row",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { document, store } = boot([
      { id: "a1", title: "With cover", cover_url: "x.png" },
      { id: "a2", title: "Bare", cover_url: "" },
    ]);
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    await tick();
    const items = [...mount.querySelectorAll("article[data-id], [data-id]")];
    assert(mount.querySelectorAll(".pieces > [data-id]").length === 2, "two items stamped");
    const covered = mount.querySelector('[data-id="a1"] .cover figure img');
    assert(covered !== null, "the covered row's nested region stamped its figure");
    assert(covered.getAttribute("src") === "x.png", `nested binding resolved, got ${covered?.getAttribute("src")}`);
    assert(
      mount.querySelector('[data-id="a2"] .cover figure') === null,
      "the bare row's nested region stamped nothing",
    );
  },
});

Deno.test({
  name: "a nested template with two elements is the region's own loud error",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { document, store } = boot([{ id: "a1", title: "t", cover_url: "x.png" }]);
    globalThis.fetch = ((inner) => (url) =>
      String(url).endsWith(".html")
        ? Promise.resolve(
          new Response(SCREEN_HTML.replace(
            "<figure><img src=\"{cover_url}\" alt=\"\"></figure>",
            "<img src=\"{cover_url}\" alt=\"\"><figcaption data-text=\"{title}\"></figcaption>",
          )),
        )
        : inner(url))(globalThis.fetch);
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    // Template arity is a ProgramError, so it is rethrown past the outage guard
    // rather than dressed as one — the mount is what fails.
    let thrown;
    try {
      await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
      await tick();
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown !== undefined && String(thrown.message).includes("an item is exactly one"),
      `the two-element template was named, got ${thrown === undefined ? "no throw" : thrown.message}`,
    );
  },
});

// A read nested under a nearer row names an outer one by its table: a device's
// key reached no read under the session's row, which answered `{key}` alone.
const OUTER_HTML = `<section class="screen" data-screen="piece">
  <div data-live="device" data-filter="id=eq.device" data-empty-row='{"id":"device","key":""}'>
    <div class="session" data-live="session" data-filter="id=eq.s">
      <div class="slots" data-live="slot" data-filter="id=eq.{device.key}:cheap">
        <template data-item><p data-text="{id}"></p></template>
      </div>
    </div>
  </div>
</section>`;

async function mountOuter(tables) {
  const { document } = parseHTML("<!doctype html><html><head></head><body><div id=shell></div></body></html>");
  globalThis.document = document;
  globalThis.fetch = (url) => String(url).endsWith(".html")
    ? Promise.resolve(new Response(OUTER_HTML))
    : String(url).endsWith(".css") ? Promise.resolve(new Response("")) : Promise.reject(new Error(`unexpected fetch ${url}`));
  const asked = [];
  const store = batched({
    query: async (table, _order, opts) => {
      asked.push(`${table}?${opts?.filter ?? ""}`);
      const id = /id=eq\.([^&]*)/.exec(opts?.filter ?? "")?.[1];
      return (tables[table] ?? []).filter((r) => id === undefined || String(r.id) === decodeURIComponent(id));
    },
    subscribe: () => () => {},
    create: async () => {},
    update: async () => {},
    put: async () => {},
    remove: async () => {},
  });
  const { interpretScreen } = await import("./screen.js");
  const mount = document.getElementById("shell");
  await interpretScreen(mount, "http://localhost:8080/keep/", { ...ROUTE, files: { ...ROUTE.files } }, store, {});
  await tick();
  return { mount, asked };
}

Deno.test({
  name: "{table.column} reaches past a nearer row to the enclosing region over that table",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { mount, asked } = await mountOuter({
      device: [{ id: "device", key: "k1" }],
      session: [{ id: "s" }],
      slot: [{ id: "k1:cheap" }, { id: "k2:cheap" }],
    });
    const stamped = [...mount.querySelectorAll(".slots p")].map((p) => p.textContent);
    assert(JSON.stringify(stamped) === '["k1:cheap"]', `the device's slot alone, got ${JSON.stringify(stamped)}`);
    assert(asked.includes("slot?id=eq.k1:cheap"), `asked ${JSON.stringify(asked)}`);
  },
});

Deno.test({
  name: "{table.column} under an enclosing empty row reads the empty row's value",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { mount } = await mountOuter({ session: [{ id: "s" }], slot: [{ id: "k1:cheap" }, { id: ":cheap" }] });
    const stamped = [...mount.querySelectorAll(".slots p")].map((p) => p.textContent);
    assert(JSON.stringify(stamped) === '[":cheap"]', `the empty key, got ${JSON.stringify(stamped)}`);
  },
});

// A retarget restates the screen's top regions; a nested region's fold, which
// reads the route's params, kept the card it was born with.
Deno.test({
  name: "a retarget reaches a nested region's fold reading the route's params",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document } = parseHTML("<!doctype html><html><head></head><body><div id=shell></div></body></html>");
    globalThis.document = document;
    const html = `<section class="screen" data-screen="piece">
  <div data-live="device" data-filter="id=eq.device" data-empty-row='{"id":"device","key":""}'>
    <div class="session" data-live="session" data-filter="id=eq.s" data-on-mutation="follow-card"><p data-text="{id}"></p></div>
  </div>
</section>`;
    const handler = `const reduce = (state, event) => ({ updates: [{ op: "patch", id: "s", row: { card: state.params.card } }] });
reduce;`;
    globalThis.fetch = (url) => String(url).endsWith(".html")
      ? Promise.resolve(new Response(html))
      : String(url).endsWith(".css") ? Promise.resolve(new Response(""))
      : String(url).endsWith("follow-card.js") ? Promise.resolve(new Response(handler))
      : Promise.reject(new Error(`unexpected fetch ${url}`));
    const written = [];
    const store = batched({
      query: async (table) => table === "session" ? [{ id: "s", card: "" }] : [],
      subscribe: () => () => {},
      create: async () => {},
      update: async (_table, _id, patch) => { written.push(patch.card); },
      put: async () => {},
      remove: async () => {},
    });
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    const route = { ...ROUTE, path: "/piece/:card", files: { ...ROUTE.files, handlers: ["shell/handlers/follow-card.js"] } };
    const h = await interpretScreen(mount, "http://localhost:8080/keep/", route, store, { card: "titan-arum" });
    await tick();
    assert(written.includes("titan-arum"), `the fold ran for the first card, wrote ${JSON.stringify(written)}`);
    await h.retarget({ card: "black-caiman" });
    await tick(60);
    assert(written.includes("black-caiman"), `the fold followed the retarget, wrote ${JSON.stringify(written)}`);
  },
});
