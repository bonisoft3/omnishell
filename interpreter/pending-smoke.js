import { batched } from "./batched-store.js";
// Deno smoke: the offline-capture surface — optimistic rows that carry only
// their submitted fields must render (blank-bound, badge-stamped) instead of
// crashing the screen, and a form whose write is still on its way must resolve
// out of form-submit.
import { parseHTML } from "npm:linkedom@0.18.4";

const SCREEN_HTML = `<section class="screen" data-screen="wall">
  <ul class="cards" data-live="note" data-filter="pinned=is.false" data-order="created_at.desc">
    <template data-item>
      <li data-color="{color}">
        <span data-text="{title}"></span>
        <em data-text="{body}"></em>
        <input type="checkbox" data-value="{done}" name="done" />
      </li>
    </template>
  </ul>
  <form data-form="capture" data-entity="note" data-action="create">
    <input name="title" required />
    <button type="submit">Add</button>
  </form>
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

  const calls = { creates: [] };
  let deferred;
  const store = batched({
    query: async () => rows,
    subscribe: () => () => {},
    create: (table, values) => {
      calls.creates.push({ table, values });
      return new Promise((resolve, reject) => (deferred = { resolve, reject }));
    },
    update: async () => {},
    remove: async () => {},
  });

  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.endsWith(".html")) return Promise.resolve(new Response(SCREEN_HTML));
    if (u.endsWith(".css")) return Promise.resolve(new Response(""));
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  };

  return { document, Event, store, calls, settleWrite: () => deferred };
}

Deno.test({
  name: "optimistic rows bind tolerantly and wear the pending badge",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Guards drift-risk #2 / accept-offline-capture: the optimistic insert
    // carries only {id, title}; DB-defaulted columns (body, color, done)
    // materialize with the synced row. Binding them must yield blanks — a
    // throw here takes the whole wall down with it.
    const rows = [
      { id: "s1", title: "synced", body: "prose", color: "sun", done: true, pinned: false },
      { id: "o1", title: "on its way", $synced: false },
    ];
    const { document, store } = boot(rows);
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8090/shell/", ROUTE, store, {});

    const items = [...mount.querySelectorAll("li[data-id]")];
    assert(items.length === 2, `2 items hydrated, got ${items.length}`);
    const synced = items.find((li) => li.dataset.id === "s1");
    const pending = items.find((li) => li.dataset.id === "o1");
    assert(pending.dataset.pending === "true", "unconfirmed row stamped data-pending=true");
    assert(synced.dataset.pending === undefined, "synced row carries no pending stamp");
    assert(
      pending.querySelector("[data-text='{title}']").textContent === "on its way",
      "submitted field binds",
    );
    assert(
      pending.querySelector("[data-text='{body}']").textContent === "",
      "absent field binds blank, not a crash",
    );
    assert(pending.getAttribute("data-color") === "", "absent attr reflection binds blank");
    assert(pending.querySelector("input[name=done]").checked === false, "absent checkbox unchecked");
    assert(synced.getAttribute("data-color") === "sun", "synced attr reflection intact");
    assert(mount.firstElementChild.dataset.state === "populated", "screen reached populated");
  },
});

Deno.test({
  name: "a create resolving on acceptance (not confirmation) clears the form",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // The store contract data-crud's settle() provides: the promise resolves
    // once the write is durably queued even when confirmation lags (offline
    // outbox). The screen must ride that resolution out of form-submit.
    const { document, Event, store, calls, settleWrite } = boot([]);
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8090/shell/", ROUTE, store, {});
    const screen = mount.firstElementChild;
    const form = mount.querySelector("form[data-form=capture]");
    form.querySelector("input[name=title]").value = "offline thought";
    // linkedom implements neither constraint validation nor reset.
    let resetCalled = false;
    form.checkValidity ??= () => true;
    form.reset ??= () => (resetCalled = true);

    form.dispatchEvent(new Event("submit"));
    await tick();
    assert(screen.dataset.state === "form-submit", "submit in flight");
    assert(calls.creates.length === 1, "one create issued");

    settleWrite().resolve(); // acceptance window elapses, txid still unseen
    await tick();
    assert(resetCalled, "input cleared on acceptance");
    assert(screen.dataset.state === "success", "state left form-submit for success");
    await tick(650);
    assert(screen.dataset.state === "empty", "state returned to base after the success beat");
  },
});

Deno.test({
  name: "embed translation: dep-set names survive !hints, only flat FK embeds join locally",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { embedTables, parseSelect } = await import("./data-crud.js");
    // accept-label-file regression: a hinted embed must contribute its table
    // names to the dependency set — capturing the "!inner" hint instead left
    // the label-wall deaf to note_label/label changes.
    assert(
      JSON.stringify(embedTables("*,note_label!inner(label!inner(name))")) ===
        JSON.stringify(["note_label", "label"]),
      "hinted/nested embeds name their tables, not the hint",
    );
    assert(JSON.stringify(embedTables("*,label(name)")) === JSON.stringify(["label"]), "flat embed");
    // Two tables joined by more than one foreign key need a relationship hint
    // as well as !inner, and the capture has to stay on the table: a feed read
    // that names "followed_id" as its dependency never re-renders when a
    // follow lands.
    assert(
      JSON.stringify(
        embedTables("*,author:app_user!inner(handle,follow!followed_id!inner(follower_id))"),
      ) === JSON.stringify(["app_user", "follow"]),
      "stacked hints name the table, not the last hint",
    );
    // Local join is what evicts a deleted chip instantly (the server
    // re-fetch races the DELETE); the subset gate must accept exactly the
    // flat unhinted form and push everything else back to PostgREST.
    assert(
      JSON.stringify(parseSelect("*,label(name)")) ===
        JSON.stringify([{ alias: "label", table: "label", cols: ["name"] }]),
      "flat FK embed is locally joinable, its alias defaulting to its table",
    );
    // The aliased spelling is the same join under the name the row binds
    // under: `author` on a row whose foreign key is author_id. Reading only
    // the unaliased form sent every such region to PostgREST on every wake.
    assert(
      JSON.stringify(parseSelect("*,author:app_user(handle)")) ===
        JSON.stringify([{ alias: "author", table: "app_user", cols: ["handle"] }]),
      "aliased FK embed is locally joinable too",
    );
    assert(JSON.stringify(parseSelect(undefined)) === "[]", "no select — no embeds");
    assert(parseSelect("*,note_label!inner(label!inner(name))") === null, "hinted stays server-side");
    assert(parseSelect("id,title") === null, "column list on the base stays server-side");
  },
});

Deno.test({
  name: "settle resolves an unconfirmed write inside the acceptance window",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { settle } = await import("./data-crud.js");
    // Never-settling client promise = offline outbox / starved long-poll:
    // the caller must not wedge.
    let done = false;
    await settle(new Promise(() => {}), 50).then(() => (done = true));
    assert(done, "unconfirmed write accepted at the window");
    // Confirmation beats the window: immediate resolution.
    const t0 = Date.now();
    await settle(Promise.resolve(), 5000);
    assert(Date.now() - t0 < 1000, "confirmed write resolves without waiting the window");
    // A refusal inside the window still reaches the form.
    let rejected = null;
    await settle(Promise.reject(new Error("store refusal")), 5000).catch((e) => (rejected = e));
    assert(String(rejected).includes("store refusal"), "refusal propagates");
  },
});
