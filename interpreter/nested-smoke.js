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
