// Deno smoke: the store seat of a validation, over the real store and two
// tab collections. A refusal is thrown before the client is called, names
// the validation, and leaves the collection as it was; an accepted write
// lands; a predicate answering a non-boolean is a program error, not a
// refusal — the seat has no fallback for a rule that did not answer.

import { FIXTURE_CARRIERS } from "./fixture-types.js";
import { assert, tick, until, withBrowser } from "./smoke-browser.js";

const OWN_ARTICLE = `({ context, event }) => context.rows.article.every((a) => a.author_id !== event.row.user_id);\n`;
const UNANSWERED = `({ context, event }) => "maybe";\n`;

const config = (src) => ({
  carriers: FIXTURE_CARRIERS,
  appBase: "http://localhost/app/",
  local: { article: "tab", favorite: "tab" },
  seed: { article: [{ id: "a1", author_id: "u1" }, { id: "a2", author_id: "u2" }] },
  validations: {
    favorite: {
      "own-article": { src, on: ["insert", "update"], order: {insert: [0, 0], update: [0, 0]}, edges: [{ table: "article", key: "id", from: "article_id" }] },
    },
  },
});

// The same app, with the table owned: the seat fills the owner column the
// form omits, the way the server's DEFAULT would.
const owned = (src) => ({
  ...config(src),
  access: { favorite: { scope: "private", owner: "user_id" } },
});

// The same app with a natural key, so `upsertBy` resolves one and a favorite
// pill's second press finds the row its first press minted.
const keyed = (src) => ({
  ...config(src),
  uniques: { favorite: [["article_id", "user_id"]] },
});

function serve(sources) {
  globalThis.fetch = (url) => {
    const u = String(url);
    for (const [path, body] of Object.entries(sources)) {
      if (u === `http://localhost/app/${path}`) return Promise.resolve(new Response(body));
    }
    if (u.endsWith("/auth/oidc")) return Promise.resolve(Response.json({ providers: ["google", "apple"] }));
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  };
}

const refusal = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
};

Deno.test({
  name: "a validated insert is refused before the client is called, and names the validation",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    serve({ "shell/validations/own-article.js": OWN_ARTICLE });
    await withBrowser({}, async (createStore) => {
      const store = createStore("", config("shell/validations/own-article.js"));
      const err = await refusal(store.add("favorite", [{ id: "f1", article_id: "a1", user_id: "u1" }]));
      assert(err !== null, "the own-article favorite is refused");
      assert(err.name === "NonRetriableError", `a refusal is non-retriable, got ${err.name}`);
      assert(err.validation === "own-article", `the refusal names the validation, got ${err.validation}`);
      assert(err.message === "validation favorite.own-article", `the message is the server's, got ${err.message}`);
      const rows = await store.query("favorite", null, {});
      assert(rows.length === 0, `nothing landed, got ${JSON.stringify(rows)}`);

      await store.add("favorite", [{ id: "f2", article_id: "a2", user_id: "u1" }]);
      const after = await store.query("favorite", null, {});
      assert(after.length === 1 && after[0].id === "f2", `another author's article is accepted, got ${JSON.stringify(after)}`);

      const moved = await refusal(store.patch("favorite", [{ key: "f2", changes: { article_id: "a1" } }]));
      assert(moved?.validation === "own-article", "a patch is judged as the row it would produce");
      const standing = await store.query("favorite", null, {});
      assert(standing[0].article_id === "a2", `the refused patch left the row standing, got ${JSON.stringify(standing)}`);
    });
  },
});

Deno.test({
  name: "the owner column is filled from the session, and an update is judged by the owner the row already has",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    serve({ "shell/validations/own-article.js": OWN_ARTICLE });
    await withBrowser({ storage: { "pronto-token": { token: "t", user: { id: "u1" } } } }, async (createStore) => {
      const store = createStore("", owned("shell/validations/own-article.js"));
      // The form never says whose the row is — the server's DEFAULT would —
      // so a predicate reading the owner judges nothing unless the seat fills
      // it from the session first.
      const mine = await refusal(store.add("favorite", [{ id: "f1", article_id: "a1" }]));
      assert(mine?.validation === "own-article", `the session's user owns the row, got ${mine?.message}`);
      const theirs = await refusal(store.add("favorite", [{ id: "f2", article_id: "a2" }]));
      assert(theirs === null, `another author's article is accepted for that owner, got ${theirs?.message}`);

      // A row this reader may write but does not own: it states its owner,
      // so nothing is filled and it is judged as that owner's.
      const shared = await refusal(store.add("favorite", [{ id: "f3", article_id: "a1", user_id: "u2" }]));
      assert(shared === null, `a stated owner stands, got ${shared?.message}`);
      // Merged first, filled second: the update omits the owner, and the
      // owner it is judged by is the standing row's, not this session's.
      const again = await refusal(store.patch("favorite", [{ key: "f3", changes: { article_id: "a1" } }]));
      assert(again === null, `an update keeps the row's own owner, got ${again?.message}`);
    });
  },
});

// The offline worker keeps only what the page fetched, so a module first
// asked for by a write made offline would not be there to judge it.
// A first visit loads the modules before the worker it registered controls
// the page, so the worker never saw them; the store fetches them again when
// control arrives, which is when the worker keeps them.
Deno.test({
  name: "a store that boots uncontrolled fetches its validation modules again when a worker takes control",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const src = "http://localhost/app/shell/validations/own-article.js";
    const fetched = [];
    globalThis.fetch = (url) => {
      fetched.push(String(url));
      return String(url) === src ? Promise.resolve(new Response(OWN_ARTICLE)) : Promise.reject(new Error(`unexpected fetch ${url}`));
    };
    const sw = Object.assign(new EventTarget(), { controller: null });
    const had = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
    Object.defineProperty(navigator, "serviceWorker", { value: sw, configurable: true });
    try {
      await withBrowser({}, async (createStore) => {
        const store = createStore("", config("shell/validations/own-article.js"));
        await until(() => fetched.includes(src), "the store fetched the module");
        await tick();
        assert(fetched.length === 1, `one fetch before control, got ${JSON.stringify(fetched)}`);
        sw.controller = {};
        sw.dispatchEvent(new Event("controllerchange"));
        await until(() => fetched.length === 3, "the store fetched the module and the cage again under the worker");
        assert(fetched[1] === src, `the same module, got ${JSON.stringify(fetched)}`);
        // The cage the module runs in: SES's bundle, at the address its first
        // load names.
        assert(fetched[2].endsWith("/interpreter/vendor/ses.umd.min.js"), `and the cage's bundle, got ${JSON.stringify(fetched)}`);
        await store.close();
      });
    } finally {
      if (had) Object.defineProperty(navigator, "serviceWorker", had);
      else delete navigator.serviceWorker;
    }
  },
});

Deno.test({
  name: "a table's validation modules are fetched with the store, before any write",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const src = "http://localhost/app/shell/validations/own-article.js";
    let online = true;
    const fetched = [];
    globalThis.fetch = (url) => {
      fetched.push(String(url));
      if (!online) return Promise.reject(new TypeError("Failed to fetch"));
      return String(url) === src ? Promise.resolve(new Response(OWN_ARTICLE)) : Promise.reject(new Error(`unexpected fetch ${url}`));
    };
    await withBrowser({}, async (createStore) => {
      const store = createStore("", config("shell/validations/own-article.js"));
      await until(() => fetched.includes(src), "the store fetched the module");
      await tick();
      // Nothing reaches the network from here, and the module is still there
      // to refuse the first write.
      online = false;
      const err = await refusal(store.add("favorite", [{ id: "f1", article_id: "a1", user_id: "u1" }]));
      assert(err?.validation === "own-article", `the first write is judged, got ${err?.message}`);
      assert(fetched.length === 1, `the module was fetched once, got ${JSON.stringify(fetched)}`);
    });
  },
});

// A local table is prepared on its first use; a bootstrap write that fails is
// not a preparation under way, and the next use prepares it again.
Deno.test({
  name: "a failed preparation is not counted as syncing, and the table's next use prepares it again",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    serve({ "shell/validations/own-article.js": OWN_ARTICLE });
    await withBrowser({}, async (createStore) => {
      const store = createStore("", config("shell/validations/own-article.js"));
      const client = globalThis.__mechaClient;
      const insert = client.insert;
      let refused = 0;
      client.insert = (table, rows) =>
        table === "article" && refused++ === 0 ? Promise.reject(new Error("quota exceeded")) : insert.call(client, table, rows);
      const reading = store.query("article", null, {});
      assert(store.syncing() === 1, `a preparation under way is syncing, got ${store.syncing()}`);
      const err = await refusal(reading);
      assert(err?.message === "quota exceeded", `the first read meets the failed write, got ${err?.message}`);
      assert(store.syncing() === 0, `a failed preparation is not syncing, got ${store.syncing()}`);
      const rows = await store.query("article", null, {});
      assert(rows.length === 2, `the next read prepares the table again, got ${JSON.stringify(rows)}`);
      assert(store.syncing() === 0, `and it is done, got ${store.syncing()}`);
    });
  },
});

// A preparation that fails after its seed resumes from where it stopped: the
// seeded rows are in the collection, and writing them again would refuse the
// table for good.
Deno.test({
  name: "a preparation that failed after its seed resumes, and seeds the rows once",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    serve({ "shell/validations/own-article.js": OWN_ARTICLE });
    await withBrowser({}, async (createStore) => {
      const store = createStore("", { ...config("shell/validations/own-article.js"), optional: { article: [{ name: "title", type: "string" }] } });
      const client = globalThis.__mechaClient;
      const insert = client.insert;
      const update = client.update;
      let seeded = 0;
      let filled = 0;
      client.insert = (table, rows) => {
        if (table === "article") seeded++;
        return insert.call(client, table, rows);
      };
      client.update = (table, edits) =>
        table === "article" && filled++ === 0 ? Promise.reject(new Error("quota exceeded")) : update.call(client, table, edits);
      const err = await refusal(store.query("article", null, {}));
      assert(err?.message === "quota exceeded", `the first read meets the failed fill, got ${err?.message}`);
      const rows = await store.query("article", null, {});
      assert(rows.length === 2 && rows.every((r) => r.title === ""), `the next read finishes the preparation, got ${JSON.stringify(rows)}`);
      assert(seeded === 1, `the seed was written once, got ${seeded}`);
      assert(filled === 2, `the fill ran again, got ${filled}`);
      assert(store.syncing() === 0, `and the table is done, got ${store.syncing()}`);
    });
  },
});

// Tab recovery replaces a table's seed, so once the seed is written it is late:
// a preparation that failed after it resumes past the seed, and would never
// read the saved rows.
Deno.test({
  name: "tab recovery after a preparation that failed past its seed is refused, not ignored",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    serve({ "shell/validations/own-article.js": OWN_ARTICLE });
    await withBrowser({}, async (createStore) => {
      const store = createStore("", { ...config("shell/validations/own-article.js"), optional: { article: [{ name: "title", type: "string" }] } });
      const client = globalThis.__mechaClient;
      const update = client.update;
      let filled = 0;
      client.update = (table, edits) =>
        table === "article" && filled++ === 0 ? Promise.reject(new Error("quota exceeded")) : update.call(client, table, edits);
      const err = await refusal(store.query("article", null, {}));
      assert(err?.message === "quota exceeded", `the first read meets the failed fill, got ${err?.message}`);
      let late = null;
      try {
        await store.restoreTabs({ article: { schema: undefined, rows: [{ id: "saved", author_id: "u9" }] } });
      } catch (e) {
        late = e;
      }
      assert(late?.message === "tab recovery after article was prepared", `recovery is refused as late, got ${late?.message}`);
      const rows = await store.query("article", null, {});
      assert(rows.map((r) => r.id).sort().join() === "a1,a2", `the seeded rows stand, got ${JSON.stringify(rows)}`);
    });
  },
});

Deno.test({
  name: "an update of a row the store does not hold is a program error, not a refusal",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    serve({ "shell/validations/own-article.js": OWN_ARTICLE });
    await withBrowser({}, async (createStore) => {
      const store = createStore("", config("shell/validations/own-article.js"));
      const err = await refusal(store.patch("favorite", [{ key: "nope", changes: { article_id: "a2" } }]));
      assert(err !== null && err.name !== "NonRetriableError", `an unheld update is not a refusal, got ${err?.name}`);
      assert(
        err.message === "validation favorite: update of a row the store does not hold: nope",
        `the error names the key, got ${err.message}`,
      );
    });
  },
});

Deno.test({
  name: "a module that failed to fetch is not held against the table's next write",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const src = "http://localhost/app/shell/validations/own-article.js";
    let attempts = 0;
    globalThis.fetch = (url) => {
      if (String(url) !== src) return Promise.reject(new Error(`unexpected fetch ${url}`));
      attempts += 1;
      return Promise.resolve(attempts <= 2 ? new Response("", { status: 404 }) : new Response(OWN_ARTICLE));
    };
    await withBrowser({}, async (createStore) => {
      const store = createStore("", config("shell/validations/own-article.js"));
      // The store's own load fails first, and is not held against the write.
      await until(() => attempts === 1, "the store loaded the module");
      await tick();
      const err = await refusal(store.add("favorite", [{ id: "f1", article_id: "a2", user_id: "u1" }]));
      assert(attempts === 2, `the write fetched the module again, got ${attempts} fetches`);
      assert(err !== null && err.name !== "NonRetriableError", `a failed fetch is a program error, got ${err?.name}`);
      assert(
        err.message === "validation favorite.own-article: shell/validations/own-article.js 404",
        `the error names the src and the status, got ${err.message}`,
      );
      const empty = await store.query("favorite", null, {});
      assert(empty.length === 0, `nothing landed, got ${JSON.stringify(empty)}`);

      const refused = await refusal(store.add("favorite", [{ id: "f1", article_id: "a1", user_id: "u1" }]));
      assert(refused?.validation === "own-article", `the next write is judged, got ${refused?.message}`);
      const accepted = await refusal(store.add("favorite", [{ id: "f2", article_id: "a2", user_id: "u1" }]));
      assert(accepted === null, `and an accepted write lands, got ${accepted?.message}`);
    });
  },
});

Deno.test({
  name: "a batch is judged whole: one refusal keeps every row of it off the wire",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    serve({ "shell/validations/own-article.js": OWN_ARTICLE });
    await withBrowser({}, async (createStore) => {
      const store = createStore("", config("shell/validations/own-article.js"));
      await store.add("favorite", [{ id: "f1", article_id: "a2", user_id: "u1" }]);

      // The fresh row passes and the standing row's update does not. Every row
      // is judged before any of them is written, so the accepted one does not
      // land either.
      const err = await refusal(store.write("favorite", [
        { key: "f2", row: { article_id: "a2", user_id: "u1" } },
        { key: "f1", row: { article_id: "a1" } },
      ]));
      assert(err?.validation === "own-article", `the batch is refused, got ${err?.message}`);
      const kept = await store.query("favorite", null, {});
      assert(
        kept.length === 1 && kept[0].id === "f1" && kept[0].article_id === "a2",
        `nothing landed and the standing row is unchanged, got ${JSON.stringify(kept)}`,
      );

      await store.write("favorite", [
        { key: "f1", row: { article_id: "a2", user_id: "u1" } },
        { key: "f3", row: { article_id: "a2", user_id: "u1" } },
      ]);
      const after = await store.query("favorite", null, {});
      assert(after.length === 2, `a batch that all passes lands whole, got ${JSON.stringify(after)}`);
    });
  },
});

Deno.test({
  name: "an upsert with no row for its natural key is judged, then lands under a minted key",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    serve({ "shell/validations/own-article.js": OWN_ARTICLE });
    await withBrowser({}, async (createStore) => {
      const store = createStore("", keyed("shell/validations/own-article.js"));
      const refused = await refusal(store.upsertBy("favorite", { article_id: "a1", user_id: "u1" }));
      assert(refused?.validation === "own-article", `the minted row is judged before it is written, got ${refused?.message}`);
      const none = await store.query("favorite", null, {});
      assert(none.length === 0, `nothing landed, got ${JSON.stringify(none)}`);

      const accepted = await refusal(store.upsertBy("favorite", { article_id: "a2", user_id: "u1" }));
      assert(accepted === null, `an accepted upsert lands, got ${accepted?.message}`);
      const rows = await store.query("favorite", null, {});
      assert(rows.length === 1 && rows[0].article_id === "a2", `the insert landed, got ${JSON.stringify(rows)}`);
      const minted = rows[0].id;
      assert(typeof minted === "string" && minted !== "", `the row carries the key it was minted under, got ${minted}`);

      // The natural key resolves now, so the second press patches that row
      // rather than minting a second one.
      await store.upsertBy("favorite", { article_id: "a2", user_id: "u1" });
      const after = await store.query("favorite", null, {});
      assert(
        after.length === 1 && after[0].id === minted,
        `the second upsert found the minted row, got ${JSON.stringify(after)}`,
      );
    });
  },
});

Deno.test({
  name: "a predicate that does not answer a boolean is a program error, not a refusal",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    serve({ "shell/validations/unanswered.js": UNANSWERED });
    await withBrowser({}, async (createStore) => {
      const store = createStore("", config("shell/validations/unanswered.js"));
      const err = await refusal(store.add("favorite", [{ id: "f1", article_id: "a2", user_id: "u1" }]));
      assert(err !== null && err.name !== "NonRetriableError", `a non-boolean is thrown as a program error, got ${err?.name}`);
      assert(/answered string/.test(err.message), `the error says what was answered, got ${err.message}`);
    });
  },
});

Deno.test({
  name: "delete guards see the old row and refuse the whole local batch before mutation",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const src = "shell/validations/delete.js";
    serve({ [src]: `({ context, event }) => event.type === "delete" && context.items.length === 1 && context.items[0].id === event.row.id && event.row.user_id !== "blocked";` });
    await withBrowser({}, async createStore => {
      const cfg = config(src);
      cfg.validations.favorite["own-article"].on = ["delete"];
      cfg.validations.favorite["own-article"].order = {delete: [0, 0]};
      const store = createStore("", cfg);
      await store.add("favorite", [
        { id: "f1", article_id: "a1", user_id: "ok" },
        { id: "f2", article_id: "a1", user_id: "blocked" },
      ]);
      const err = await refusal(store.drop("favorite", ["f1", "f2"]));
      assert(err?.validation === "own-article", `expected named delete refusal, got ${err}`);
      assert((await store.query("favorite", null, {})).length === 2, "batch partially deleted before the guard refused");
      await store.drop("favorite", ["f1"]);
      const rows = await store.query("favorite", null, {});
      assert(rows.length === 1 && rows[0].id === "f2", "the accepted delete did not remove exactly its row");
    });
  },
});

Deno.test({
  name: "browser refusal order follows the compiled lifecycle order, not declaration order",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const src = "shell/validations/no.js";
    serve({ [src]: "() => false" });
    await withBrowser({}, async createStore => {
      const cfg = config(src);
      cfg.validations.favorite = {
        firstDeclared: {src, on: ["insert"], order: {insert: [1, 0]}, edges: []},
        laterTransitionGuard: {src, on: ["insert"], order: {insert: [0, 1]}, edges: []},
        firstTransitionGuard: {src, on: ["insert"], order: {insert: [0, 0]}, edges: []},
      };
      const store = createStore("", cfg);
      const error = await refusal(store.add("favorite", [{id: "f", article_id: "a1", user_id: "u"}]));
      assert(error?.validation === "firstTransitionGuard", `wrong first refusal: ${error?.validation}`);
    });
  },
});
