// Deno smoke: declared uniques are reconciled over surviving browser-tier
// rows at first load — a device collection can hold rows written before an
// invariant existed, and the answer is a migration (newest wins, one
// warning), never the slot's crash, which from boot onward means only
// corruption that happened after it.

const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

// The device tier persists as localStorage["mecha:<table>"] holding
// {"s:<key>": {versionKey, data}} (the vendored client's own serialization);
// seeding that before createStore is what "rows from a previous era" is.
function seedStorage(entries) {
  const backing = new Map();
  for (const [k, v] of Object.entries(entries)) backing.set(k, JSON.stringify(v));
  return {
    getItem: (k) => backing.get(k) ?? null,
    setItem: (k, v) => void backing.set(k, v),
    removeItem: (k) => void backing.delete(k),
    key: (i) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  };
}

const stored = (rows) =>
  Object.fromEntries(rows.map((r, i) => [`s:${r.id}`, { versionKey: `v${i}`, data: r }]));

async function withDeviceStorage(entries, fn) {
  const hadWindow = "window" in globalThis;
  const hadDocument = "document" in globalThis;
  if (!hadDocument) {
    globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
  }
  const storage = seedStorage(entries);
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  // A window with exactly what the vendored client touches: its storage
  // probe, resolveUrl's origin, and the online detector's listener seam.
  if (!hadWindow) {
    globalThis.window = {
      localStorage: storage,
      location: { origin: "http://localhost" },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const { createStore } = await import("./data-crud.js");
    await fn(createStore, warnings);
  } finally {
    console.warn = warn;
    delete globalThis.localStorage;
    if (!hadWindow) delete globalThis.window;
    if (!hadDocument) delete globalThis.document;
  }
}

Deno.test({
  name: "surviving rows violating a partial unique reconcile to the newest, with one warning",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withDeviceStorage(
      {
        "mecha:match": stored([
          { id: "m1", status: "playing", created_at: "2026-08-14T10:00:00Z" },
          { id: "m2", status: "playing", created_at: "2026-08-20T10:00:00Z" },
          { id: "m3", status: "playing", created_at: "2026-08-30T10:00:00Z" },
          { id: "m4", status: "over", created_at: "2026-08-01T10:00:00Z" },
        ]),
      },
      async (createStore, warnings) => {
        const store = await createStore("", {
          local: { match: "device" },
          partialUniques: { match: [{ cols: ["status"], where: "status=eq.playing" }] },
        });
        const playing = await store.query("match", null, { filter: "status=eq.playing" });
        assert(playing.length === 1, `the slot's read sees one row, got ${playing.length}`);
        assert(playing[0].id === "m3", `the newest survived, got ${playing[0].id}`);
        const all = await store.query("match", null, {});
        assert(all.length === 2, `rows outside the where-domain stay, got ${all.length}`);
        assert(
          warnings.length === 1 && warnings[0].includes("match") && warnings[0].includes("2"),
          `one warning naming the table and the count, got ${JSON.stringify(warnings)}`,
        );
      },
    );
  },
});

Deno.test({
  name: "a full unique reconciles the same way",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withDeviceStorage(
      {
        "mecha:doc": stored([
          { id: "d1", slug: "a", created_at: "2026-08-01T00:00:00Z" },
          { id: "d2", slug: "a", created_at: "2026-08-02T00:00:00Z" },
          { id: "d3", slug: "b", created_at: "2026-08-01T00:00:00Z" },
        ]),
      },
      async (createStore, warnings) => {
        const store = await createStore("", {
          local: { doc: "device" },
          uniques: { doc: [["slug"]] },
        });
        const all = await store.query("doc", null, {});
        assert(all.length === 2, `one slug survivor each, got ${all.length}`);
        assert(all.some((r) => r.id === "d2") && all.some((r) => r.id === "d3"), "newest per slug kept");
        assert(warnings.length === 1, `one warning, got ${warnings.length}`);
      },
    );
  },
});

Deno.test({
  name: "a clean collection loads silently",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withDeviceStorage(
      {
        "mecha:match": stored([
          { id: "m1", status: "playing", created_at: "2026-08-30T10:00:00Z" },
          { id: "m2", status: "over", created_at: "2026-08-01T10:00:00Z" },
        ]),
      },
      async (createStore, warnings) => {
        const store = await createStore("", {
          local: { match: "device" },
          partialUniques: { match: [{ cols: ["status"], where: "status=eq.playing" }] },
        });
        const playing = await store.query("match", null, { filter: "status=eq.playing" });
        assert(playing.length === 1 && playing[0].id === "m1", "the one playing row binds");
        assert(warnings.length === 0, `no warning, got ${JSON.stringify(warnings)}`);
      },
    );
  },
});
