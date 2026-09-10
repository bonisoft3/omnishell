// Deno smoke: the store seat of a validation, over the real store and two
// tab collections. A refusal is thrown before the client is called, names
// the validation, and leaves the collection as it was; an accepted write
// lands; a predicate answering a non-boolean is a program error, not a
// refusal — the seat has no fallback for a rule that did not answer.

const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

// A window with exactly what the vendored client touches: its storage probe,
// resolveUrl's origin, and the online detector's listener seam.
async function withBrowser(fn) {
  const hadWindow = "window" in globalThis;
  const hadDocument = "document" in globalThis;
  if (!hadDocument) {
    globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
  }
  const backing = new Map();
  const storage = {
    getItem: (k) => backing.get(k) ?? null,
    setItem: (k, v) => void backing.set(k, v),
    removeItem: (k) => void backing.delete(k),
    key: (i) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  if (!hadWindow) {
    globalThis.window = {
      localStorage: storage,
      location: { origin: "http://localhost" },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }
  try {
    const { createStore } = await import("./data-crud.js");
    await fn(createStore);
  } finally {
    delete globalThis.localStorage;
    if (!hadWindow) delete globalThis.window;
    if (!hadDocument) delete globalThis.document;
  }
}

const OWN_ARTICLE = `(state, event) => state.rows.article.every((a) => a.author_id !== event.row.user_id);\n`;
const UNANSWERED = `(state, event) => "maybe";\n`;

const config = (src) => ({
  appBase: "http://localhost/app/",
  local: { article: "tab", favorite: "tab" },
  seed: { article: [{ id: "a1", author_id: "u1" }, { id: "a2", author_id: "u2" }] },
  validations: {
    favorite: {
      "own-article": { src, edges: [{ table: "article", key: "id", from: "article_id" }] },
    },
  },
});

// The same app, with the table owned: the seat fills the owner column the
// form omits, the way the server's DEFAULT would.
const owned = (src) => ({
  ...config(src),
  access: { favorite: { mode: "owned", owner: "user_id" } },
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
    await withBrowser(async (createStore) => {
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
    sessionStorage.setItem("pronto-token", JSON.stringify({ token: "t", user: { id: "u1" } }));
    try {
      await withBrowser(async (createStore) => {
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
    } finally {
      sessionStorage.removeItem("pronto-token");
    }
  },
});

Deno.test({
  name: "an update of a row the store does not hold is a program error, not a refusal",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    serve({ "shell/validations/own-article.js": OWN_ARTICLE });
    await withBrowser(async (createStore) => {
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
      return Promise.resolve(attempts === 1 ? new Response("", { status: 404 }) : new Response(OWN_ARTICLE));
    };
    await withBrowser(async (createStore) => {
      const store = createStore("", config("shell/validations/own-article.js"));
      const err = await refusal(store.add("favorite", [{ id: "f1", article_id: "a2", user_id: "u1" }]));
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
    await withBrowser(async (createStore) => {
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
    await withBrowser(async (createStore) => {
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
    await withBrowser(async (createStore) => {
      const store = createStore("", config("shell/validations/unanswered.js"));
      const err = await refusal(store.add("favorite", [{ id: "f1", article_id: "a2", user_id: "u1" }]));
      assert(err !== null && err.name !== "NonRetriableError", `a non-boolean is thrown as a program error, got ${err?.name}`);
      assert(/answered string/.test(err.message), `the error says what was answered, got ${err.message}`);
    });
  },
});
