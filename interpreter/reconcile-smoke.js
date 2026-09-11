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
  name: "surviving rows gain the optional columns they predate: text blank, any other type null",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withDeviceStorage(
      {
        "mecha:match": stored([
          { id: "m1", status: "over" },
          { id: "m2", status: "over", result: "1-0" },
          { id: "m3", status: "playing", result: "", opening: "C20", lie: 3 },
        ]),
      },
      async (createStore) => {
        const store = await createStore("", {
          local: { match: "device" },
          optional: {
            match: [
              { name: "result", type: "text" },
              { name: "opening", type: "text" },
              { name: "lie", type: "int" },
            ],
          },
        });
        const byId = Object.fromEntries((await store.query("match", null, {})).map((r) => [r.id, r]));
        const cols = (r) => JSON.stringify([r.result, r.opening, r.lie]);
        assert(cols(byId.m1) === `["","",null]`, `a row lacking all three gains text blank and int null, got ${cols(byId.m1)}`);
        assert(cols(byId.m2) === `["1-0","",null]`, `a stored value is kept, got ${cols(byId.m2)}`);
        assert(cols(byId.m3) === `["","C20",3]`, `a complete row is untouched, got ${cols(byId.m3)}`);

        // Neither is refused: both resolve rather than throw.
        await store.add("match", [{ id: "m4", status: "playing" }]);
        await store.write("match", [{ key: "m5", row: { status: "playing", opening: "B00" } }]);
        const made = Object.fromEntries((await store.query("match", null, {})).map((r) => [r.id, r]));
        assert(cols(made.m4) === `["","",null]`, `a row added without them carries them unset, got ${cols(made.m4)}`);
        assert(cols(made.m5) === `["","B00",null]`, `a row written without two carries them unset, got ${cols(made.m5)}`);
      },
    );
  },
});

Deno.test({
  name: "a write that demotes one row and promotes another never holds both in a unique's domain",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withDeviceStorage(
      {
        "mecha:game": stored([{ id: "g1", current: "yes", ordinal: "0001" }]),
      },
      async (createStore, warnings) => {
        const opts = { filter: "current=eq.yes", order: "ordinal.desc" };
        const store = await createStore("", {
          local: { game: "device" },
          partialUniques: { game: [{ cols: ["current"], where: "current=eq.yes" }] },
        });
        await store.query("game", null, opts);
        // Every change event, read synchronously, and every region wake.
        const seen = [];
        const current = () => globalThis.__mechaClient.collections.game.toArray.filter((r) => r.current === "yes");
        globalThis.__mechaClient.collections.game.subscribeChanges(
          () => seen.push(["change", current().map((r) => r.id)]),
          { includeInitialState: false },
        );
        const wakes = [];
        const stop = store.subscribe("game", () => {
          store.query("game", null, opts).then((rows) => wakes.push(rows.map((r) => r.id)));
        }, opts);
        await store.write("game", [
          { key: "g1", row: { current: "no" } },
          { key: "g2", row: { current: "yes", ordinal: "0002" } },
        ]);
        await new Promise((r) => setTimeout(r, 20));
        stop();
        const doubled = seen.filter(([, ids]) => ids.length > 1);
        assert(doubled.length === 0, `no change event holds two current rows, got ${JSON.stringify(seen)}`);
        assert(wakes.length > 0 && wakes.every((ids) => ids.length === 1 && ids[0] === "g2"), `every wake reads g2 alone, got ${JSON.stringify(wakes)}`);
        assert(warnings.length === 0, `no reconcile warning, got ${JSON.stringify(warnings)}`);
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
