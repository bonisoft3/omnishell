import { batched } from "./batched-store.js";
// Deno smoke: the slot cardinality precondition. A slot (singleton region)
// whose read matches two rows errors naming the region's table and filter —
// and the error is a precondition, not an outage: the guarded retry loop
// never dresses it as network-error or schedules a 2s re-probe. One row and
// zero rows (data-empty-row fallback) still bind.
import { parseHTML } from "npm:linkedom@0.18.4";

const screenHtml = (extra = "") => `<section class="screen" data-screen="demo">
  <div id="slot" data-live="tint" data-filter="id=eq.the" data-hue="{hue}"${extra}></div>
</section>`;

const ROUTE = {
  screen: "demo",
  files: { html: "shell/screens/demo.html", css: "shell/screens/demo.css", handlers: [] },
  states: ["populated"],
};

function boot(html, rows) {
  const { document, Event } = parseHTML(
    "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
  );
  globalThis.document = document;

  const subs = new Set();
  const store = batched({
    query: async () => rows,
    subscribe: (_table, cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
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

  return { document, Event, store, subs, rows };
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

Deno.test({
  name: "a two-row slot refuses to bind, naming the table and filter",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, store } = boot(screenHtml(), [
      { id: "the", hue: "warm" },
      { id: "the", hue: "cool" },
    ]);
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    let msg = "";
    try {
      await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    } catch (err) {
      msg = String(err);
    }
    assert(msg.includes('"tint"'), `the error names the region's table, got: ${msg}`);
    assert(msg.includes("id=eq.the"), `the error names the region's filter, got: ${msg}`);
    assert(msg.includes("2 rows"), `the error states the cardinality, got: ${msg}`);
  },
});

Deno.test({
  name: "a one-row slot and a zero-row fallback slot still bind",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { interpretScreen } = await import("./screen.js");

    {
      const { document, store } = boot(screenHtml(), [{ id: "the", hue: "warm" }]);
      const mount = document.getElementById("shell");
      await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
      assert(
        mount.querySelector("#slot").getAttribute("data-hue") === "warm",
        "one row binds",
      );
    }
    {
      const { document, store } = boot(
        screenHtml(` data-empty-row='{"id":"the","hue":"sun"}'`),
        [],
      );
      const mount = document.getElementById("shell");
      await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
      assert(
        mount.querySelector("#slot").getAttribute("data-hue") === "sun",
        "zero rows bind the data-empty-row fallback",
      );
    }
  },
});

Deno.test({
  name: "a slot turning two-row mid-visit rejects the wake without the outage retry",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, store, subs, rows } = boot(screenHtml(), [{ id: "the", hue: "warm" }]);
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    const screen = mount.firstElementChild;
    assert(screen.dataset.state === "populated", "one row hydrates populated");

    rows.push({ id: "the", hue: "cool" });
    const delays = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => {
      delays.push(ms);
      return realSetTimeout(fn, ms, ...rest);
    };
    let msg = "";
    try {
      for (const cb of subs) await cb();
    } catch (err) {
      msg = String(err);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert(msg.includes('"tint"') && msg.includes("2 rows"), `the wake rejected loudly, got: ${msg}`);
    assert(
      !delays.some((ms) => ms >= 2000),
      `no outage re-probe was scheduled, got delays ${JSON.stringify(delays)}`,
    );
    assert(
      screen.dataset.state !== "network-error",
      "a broken invariant is not dressed as an outage",
    );
  },
});
