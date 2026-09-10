// Deno smoke: a `tab` collection's declared rows are there before anyone
// writes one, and a row the reader deletes does not come back.
//
// The deletion half is the one worth guarding: seeding "when the collection is
// empty" would resurrect a list the reader emptied on purpose, and seeding
// "insert whatever id is missing" would resurrect every deleted row on every
// read.

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

const PALETTE = {
  local: { command: "tab" },
  seed: [
    { id: "new-note", label: "New note", position: 1 },
    { id: "search", label: "Search", position: 2 },
    { id: "sign-out", label: "Sign out", position: 3 },
  ],
};

const config = () => ({ local: PALETTE.local, seed: { command: PALETTE.seed } });

Deno.test({
  name: "a tab collection holds its declared rows on the first read",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withBrowser(async (createStore) => {
      const store = await createStore("", config());
      const rows = await store.query("command", "position.asc", {});
      assert(rows.length === 3, `three seeded rows, got ${rows.length}`);
      assert(
        rows.map((r) => r.label).join("|") === "New note|Search|Sign out",
        `the region's order is the region's, over rows that are simply there: ${JSON.stringify(rows)}`,
      );
    });
  },
});

Deno.test({
  name: "a filter reads seeded rows like any other rows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withBrowser(async (createStore) => {
      const store = await createStore("", config());
      const rows = await store.query("command", null, { filter: "id=eq.search" });
      assert(rows.length === 1 && rows[0].label === "Search", `one row by id, got ${JSON.stringify(rows)}`);
    });
  },
});

Deno.test({
  name: "a deleted seed row stays deleted for the life of the store",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withBrowser(async (createStore) => {
      const store = await createStore("", config());
      await store.query("command", null, {});
      await store.drop("command", ["search"]);
      const after = await store.query("command", "position.asc", {});
      assert(after.length === 2, `the deleted row is gone, got ${after.length}`);
      assert(!after.some((r) => r.id === "search"), "and no read re-seeds it");
    });
  },
});

Deno.test({
  name: "a new store seeds again — the store's life is the whole ledger",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withBrowser(async (createStore) => {
      const first = await createStore("", config());
      await first.query("command", null, {});
      await first.drop("command", ["search"]);
      const next = await createStore("", config());
      const rows = await next.query("command", null, {});
      assert(rows.length === 3, `a tab collection is born empty and reseeds, got ${rows.length}`);
    });
  },
});

Deno.test({
  name: "a seed row with no key is a program error, not a row the store invents one for",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withBrowser(async (createStore) => {
      const store = await createStore("", {
        local: { command: "tab" },
        seed: { command: [{ label: "New note" }] },
      });
      let threw = null;
      try {
        await store.query("command", null, {});
      } catch (err) {
        threw = err;
      }
      assert(threw !== null, "the read refuses rather than minting a key the program did not name");
      assert(String(threw.message).includes("id"), `the message names the missing key: ${threw?.message}`);
    });
  },
});
