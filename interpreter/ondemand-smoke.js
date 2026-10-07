// Deno smoke: a table that syncs on demand, over the real store, the vendored
// client and a ShapeStream answered by an Electric in process. A view's rows
// are only the ones its subsets loaded, so the store must never answer before
// they are all there, never wake a region on a half-joined row, and refuse
// require explicit complete demand for a local snapshot.

import "./server-mutation-smoke.js";
import { FIXTURE_CARRIERS } from "./fixture-types.js";
import { ProgramError } from "./fragment.js";
import { assert, tick, until, withBrowser } from "./smoke-browser.js";

// Electric's shape protocol as @electric-sql/client asks it: an on-demand
// shape opens at `offset=now` with only changes logged, each view's rows come
// as a subset snapshot, and live polls hang until a change is pushed. A subset
// waits on the gate the test holds for its table.
let worlds = 0;
const servers = new Map();
function electric(server, schema) {
  const base = `http://fake${++worlds}`;
  const subsets = [];
  const gates = new Map();
  const stalls = new Map();
  const failing = new Map();
  const live = new Map();
  const offsets = new Map();
  let transaction = 10;
  const headers = (table) => ({
    "content-type": "application/json",
    "electric-handle": `h-${table}`,
    "electric-offset": `0_${offsets.get(table) ?? 0}`,
    "electric-schema": JSON.stringify(schema[table]),
    "electric-cursor": String(offsets.get(table) ?? 0),
  });
  const message = (table, operation, value, txid) => ({
    key: `"public"."${table}"/"${value.id}"`,
    value,
    headers: { operation, relation: ["public", table], ...(txid === undefined ? {} : { txids: [txid] }) },
  });
  const upToDate = (table) => ({ headers: { control: "up-to-date", global_last_seen_lsn: String(offsets.get(table) ?? 0) } });
  // `"c" = $1` and `"c" = ANY($1)`, ANDed: what a view's eq clauses and a
  // join's lazy load compile to.
  const matches = (where, params) => {
    // A key that is null is a row that does not exist.
    if (/^"\w+" IS NULL$/.test(where.trim())) return () => false;
    if (/^"\w+" IS NOT NULL$/.test(where.trim())) return () => true;
    const clauses = where.split(" AND ").map((c) => /^"(\w+)" = (ANY\()?\$(\d+)\)?$/.exec(c.trim()));
    if (clauses.some((m) => m === null)) throw new Error(`the fake Electric cannot read: ${where}`);
    return (row) =>
      clauses.every(([, col, any, n]) => {
        const value = params[n];
        return any ? value.slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, "")).includes(String(row[col])) : String(row[col]) === value;
      });
  };
  const fetcher = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== base) return servers.get(url.origin)(input, init);
    if (url.pathname.includes("/crud/")) {
      const table = url.pathname.split("/").at(-1);
      const id = url.searchParams.get("id")?.slice(3);
      const rows = server[table];
      const current = rows.find((r) => r.id === id);
      const txid = ++transaction;
      const operation = init.method === "DELETE" ? "delete" : init.method === "PATCH" ? "update" : "insert";
      const value = {
        ...current,
        ...(init.body ? JSON.parse(init.body) : {}),
        txid: String(txid),
      };
      if (operation === "delete") rows.splice(rows.indexOf(current), 1);
      else if (current) Object.assign(current, value);
      else rows.push(value);
      const queued = live.get(table) ?? { changes: [], wake: null };
      live.set(table, queued);
      queued.changes.push(message(table, operation, value, txid));
      queued.wake?.();
      queued.wake = null;
      return new Response(JSON.stringify([value]), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/auth/shape")) {
      const { table } = JSON.parse(init.body);
      return new Response(JSON.stringify({ token: "t", where: `table ${table}`, expires_in: 900 }));
    }
    const p = url.searchParams;
    const table = p.get("table");
    if (p.has("subset__where")) {
      const where = p.get("subset__where");
      const params = JSON.parse(p.get("subset__params") ?? "{}");
      subsets.push({ table, where, params });
      await (gates.get(table) ?? Promise.resolve());
      const failure = failing.get(table)?.shift();
      if (failure !== undefined) {
        return new Response(JSON.stringify(failure.body), { status: failure.status, headers: headers(table) });
      }
      const rows = (server[table] ?? []).filter(matches(where, params));
      return new Response(JSON.stringify({
        metadata: { xmin: "1", xmax: "1", xip_list: [], snapshot_mark: subsets.length, database_lsn: String(offsets.get(table) ?? 0) },
        data: rows.map((r) => message(table, "insert", r)),
      }), { headers: headers(table) });
    }
    if (p.get("live") !== "true") {
      await (stalls.get(table) ?? Promise.resolve());
      const rows = p.get("log") === "changes_only" ? [] : (server[table] ?? []).map((r) => message(table, "insert", r));
      return new Response(JSON.stringify([...rows, upToDate(table)]), { headers: headers(table) });
    }
    const queued = live.get(table) ?? { changes: [], wake: null };
    live.set(table, queued);
    if (queued.changes.length === 0) {
      await new Promise((resolve, reject) => {
        queued.wake = resolve;
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    const batch = queued.changes.splice(0);
    offsets.set(table, (offsets.get(table) ?? 0) + 1);
    return new Response(JSON.stringify([...batch, upToDate(table)]), { headers: headers(table) });
  };
  servers.set(base, fetcher);
  return {
    fetcher,
    // A host of its own: Electric's client remembers a shape's position by its
    // URL for the life of the module, and would resume one test's stream into
    // the next test's fake.
    base,
    subsets,
    /** Answers the next subsets of `table` with each `status` and `body` in
     * turn, one per subset. */
    fail(table, ...answers) {
      failing.set(table, [...(failing.get(table) ?? []), ...answers.map(([status, body]) => ({ status, body }))]);
    },
    /** Holds every subset of `table` until the returned release is called. */
    hold(table) {
      let release;
      gates.set(table, new Promise((r) => (release = r)));
      return () => {
        gates.delete(table);
        release();
      };
    },
    /** Holds the first snapshot of `table` until the returned release is
     * called. */
    stall(table) {
      let release;
      stalls.set(table, new Promise((r) => (release = r)));
      return () => {
        stalls.delete(table);
        release();
      };
    },
    remove(table, id, txid) {
      transaction = Math.max(transaction, txid);
      const rows = server[table];
      const index = rows.findIndex(row => row.id === id);
      assert(index !== -1, `external delete finds ${table}/${id}`);
      const [row] = rows.splice(index, 1);
      const queued = live.get(table) ?? { changes: [], wake: null };
      live.set(table, queued);
      queued.changes.push(message(table, "delete", row, txid));
      queued.wake?.();
      queued.wake = null;
    },
    push(table, row, txid) {
      transaction = Math.max(transaction, txid);
      (server[table] ??= []).push(row);
      const queued = live.get(table) ?? { changes: [], wake: null };
      live.set(table, queued);
      queued.changes.push(message(table, "insert", row, txid));
      queued.wake?.();
      queued.wake = null;
    },
  };
}

const SCHEMA = {
  player_game: { id: { type: "text" }, game_id: { type: "text" }, player_id: { type: "text" }, round: { type: "int4" }, txid: { type: "int8" } },
  player: { id: { type: "text" }, name: { type: "text" }, txid: { type: "int8" } },
  stat: { id: { type: "text" }, player_id: { type: "text" }, games: { type: "int4" }, rate: { type: "numeric" }, ref: { type: "uuid" }, at: { type: "timestamptz" }, txid: { type: "int8" } },
};
const config = (extra = {}) => ({
  carriers: FIXTURE_CARRIERS,
  appBase: "http://fake/app/",
  tables: ["player_game", "player", "stat"],
  schema: {
    player_game: { fields: [{ name: "id", type: "string" }, { name: "game_id", type: "string" }, { name: "player_id", type: "string", ref: "player" }, { name: "round", type: "int32" }] },
    player: { fields: [{ name: "id", type: "string" }, { name: "name", type: "string" }] },
    stat: { fields: [
      { name: "id", type: "string" }, { name: "player_id", type: "string", ref: "player" }, { name: "games", type: "int32" },
      { name: "rate", type: "decimal", precision: 10, scale: 2 }, { name: "ref", type: "uuid" }, { name: "at", type: "timestamptz" },
    ] },
  },
  sync: { player_game: "on-demand", player: "on-demand" },
  ...extra,
});
const world = () => ({
  player_game: [
    { id: "pg1", game_id: "g1", player_id: "p1", round: "3", txid: "1" },
    { id: "pg2", game_id: "g1", player_id: "p2", round: "4", txid: "1" },
    { id: "pg3", game_id: "g2", player_id: "p3", round: "3", txid: "1" },
  ],
  player: [{ id: "p1", name: "Ana", txid: "1" }, { id: "p2", name: "Bia", txid: "1" }, { id: "p3", name: "Cris", txid: "1" }, { id: "p9", name: "Duda", txid: "1" }],
  stat: [
    { id: "s1", player_id: "p1", games: "2", rate: "1.50", ref: "0c000000-0000-4000-8000-0000000000aa", at: "2026-09-22 14:18:21.84623+00", txid: "1" },
    { id: "s2", player_id: "p2", games: "1", rate: "2", ref: "0c000000-0000-4000-8000-0000000000bb", at: "2026-09-23 09:00:00+00", txid: "1" },
  ],
});

for (const [table, id] of [["stat", "s1"], ["player", "p1"]]) {
  Deno.test({
    name: `a server-computed join refreshes after an external ${table} deletion`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const rows = world();
      const fake = electric(rows, SCHEMA);
      await withBrowser({
        fetch: (input, init) => String(input).includes("/crud/stat?")
          ? Promise.resolve(Response.json(rows.stat.filter(row => rows.player.some(player => player.id === row.player_id))))
          : fake.fetcher(input, init),
      }, async createStore => {
        const cfg = config({ sync: { stat: "on-demand", player: "on-demand", player_game: "on-demand" } });
        cfg.schema.stat.durability = "live";
        cfg.schema.player.durability = "server";
        const store = createStore(fake.base, cfg);
        const opts = { select: "*,player!inner(name)" };
        const refreshes = [];
        let visible = [];
        const stop = store.subscribe("stat", () => {
          refreshes.push(store.query("stat", null, opts).then(value => { visible = value; }));
        }, opts);
        try {
          visible = await store.query("stat", null, opts);
          assert(visible.length === 2, "both server rows are initially visible");
          await until(() => refreshes.length > 0, "invalidation stream established");
          await tick(30);
          assert(["stat", "player"].every(name => globalThis.__mechaClient.collections[name].size === 0), "invalidation retains no rows");
          fake.remove(table, id, 20);
          await until(() => visible.length === 1, "external delete refreshes the server result");
          await Promise.all(refreshes);
          assert(visible[0].id === "s2", "the row removed by the server join is no longer rendered");
          assert(fake.subsets.length === 0, "server results do not load local query subsets");
        } finally {
          stop();
        }
      });
    },
  });
}

for (const mode of ["eager", "on-demand"]) {
  Deno.test({
    name: `a registered reverse embed stays server-computed with ${mode} collections`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const rows = world();
      const fake = electric(rows, SCHEMA);
      await withBrowser({ fetch: (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/crud/player") {
          assert(url.searchParams.get("id") === "eq.p1", "the server receives the region's predicate");
          return Promise.resolve(Response.json(rows.player.filter(p => p.id === "p1").map(p => ({
            ...p, player_game: rows.player_game.filter(g => g.player_id === p.id).map(g => ({ round: g.round })),
          }))));
        }
        return fake.fetcher(input, init);
      } }, async createStore => {
        const cfg = config({ sync: { player: mode, player_game: mode, stat: mode } });
        cfg.schema.player.durability = "live";
        const store = createStore(fake.base, cfg);
        const opts = { filter: "id=eq.p1", select: "*,player_game(round)" };
        let visible = await store.query("player", null, opts);
        assert(Array.isArray(visible[0].player_game) && visible[0].player_game[0].round === "3", "reverse embeds preserve cardinality and values");
        const refreshes = [];
        const stop = store.subscribe("player", () => {
          refreshes.push(store.query("player", null, opts).then(value => { visible = value; }));
        }, opts);
        try {
          await until(() => refreshes.length > 0, "dependency invalidation established");
          await Promise.all(refreshes);
          fake.remove("player_game", "pg1", 20);
          await until(() => visible[0].player_game.length === 0, "child deletion refreshes the reverse embed");
          await Promise.all(refreshes);
          assert(fake.subsets.length === 0, "a reverse join loads no local subsets");
          assert(["player", "player_game"].every(t => globalThis.__mechaClient.collections[t].size === 0), "invalidation retains no snapshots");
        } finally {
          stop();
        }
      });
    },
  });
}

/** A test of the store over an Electric serving world(), handed both. */
const onDemand = (name, fn) =>
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const fake = electric(world(), SCHEMA);
      const online = Object.getOwnPropertyDescriptor(navigator, "onLine");
      Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
      try {
        await withBrowser({ fetch: fake.fetcher }, (createStore) => fn({ fake, store: createStore(fake.base, config()) }));
      } finally {
        if (online) Object.defineProperty(navigator, "onLine", online);
        else delete navigator.onLine;
      }
    },
  });

onDemand("a view on demand answers only once its subset and its join's are in, and wakes on whole rows", async ({ fake, store }) => {
  const opts = { filter: "game_id=eq.g1", select: "*,player(name)" };
  const wakes = [];
  const view = () => [...globalThis.__prontoViews.values()][0].view;
  const releasePlayerGame = fake.hold("player_game");
  const releasePlayer = fake.hold("player");
  const stop = store.subscribe("player_game", (changes) => {
    wakes.push(view().toArray.map((r) => ({ id: r.id, player: r.player?.name ?? null })));
  }, opts);
  let answered = null;
  const read = store.query("player_game", null, opts).then((rows) => (answered = rows));
  await until(() => fake.subsets.some((s) => s.table === "player_game"), "asked for the view's subset");
  releasePlayerGame();
  await until(() => fake.subsets.some((s) => s.table === "player"), "asked for the join's rows");
  await tick(30);
  // Regression: toArrayWhenReady answers once the view holds any row, and
  // here it holds two whose players have not arrived, so the first read
  // rendered a list of games with blank players as if it were the whole.
  assert(view().size > 0, "the view holds the subset's rows while the join loads");
  let reread = null;
  const second = store.query("player_game", null, opts).then((rows) => (reread = rows));
  await tick(30);
  assert(answered === null && reread === null, "neither read answered before the join's rows");
  assert(wakes.length === 0, `no wake while the join loads, got ${JSON.stringify(wakes)}`);
  releasePlayer();
  await read;
  await second;
  assert(
    JSON.stringify(answered.map((r) => [r.id, r.player?.name]).sort()) === JSON.stringify([["pg1", "Ana"], ["pg2", "Bia"]]),
    `the read is the subset, joined: ${JSON.stringify(answered)}`,
  );

  // A row arriving on the live stream whose player no subset loaded: the
  // join fetches it, and the region hears of the row once it has.
  const releaseLate = fake.hold("player");
  wakes.length = 0;
  fake.push("player_game", { id: "pg4", game_id: "g1", player_id: "p9", round: "5", txid: "2" }, 2);
  await until(() => fake.subsets.some((s) => s.table === "player" && s.params["1"]?.includes("p9")), "fetched the late row's player");
  await tick(30);
  assert(wakes.length === 0, `the late row woke nobody before its player arrived: ${JSON.stringify(wakes)}`);
  releaseLate();
  await until(() => wakes.length > 0, "woke on the late row");
  for (const rows of wakes) {
    for (const r of rows) assert(r.player !== null, `a wake bound a row with a blank player: ${JSON.stringify(rows)}`);
  }
  stop();
});

onDemand("a typed column's equality is one literal of its type, and no `or`", async ({ fake, store }) => {
  const opts = { filter: "round=eq.3" };
  const stop = store.subscribe("player_game", () => {}, opts);
  const rows = await store.query("player_game", null, opts);
  const [subset] = fake.subsets;
  assert(subset.where === `"round" = $1` && JSON.stringify(subset.params) === `{"1":"3"}`, `the subset is ${JSON.stringify(subset)}`);
  assert(JSON.stringify(rows.map((r) => r.id).sort()) === JSON.stringify(["pg1", "pg3"]), `matched ${JSON.stringify(rows)}`);
  stop();
});

onDemand("a read whose order is only positional joins the view its subscription opened", async ({ fake, store }) => {
  const stop = store.subscribe("player_game", () => {}, { filter: "game_id=eq.g1", order: "round.desc" });
  // Regression: read() looked the view up by opts.order alone, so a read
  // passing its order only as the positional argument missed the view and,
  // on a table that syncs on demand, was refused as a whole read.
  const rows = await store.query("player_game", "round.desc", { filter: "game_id=eq.g1" });
  assert(JSON.stringify(rows.map((r) => r.id)) === `["pg2","pg1"]`, `the read is the view, ordered: ${JSON.stringify(rows)}`);
  stop();
});

for (const [kind, opts, indexedTable, column] of [
  ["joined", { filter: "game_id=eq.g1", select: "*,player(name)" }, "player", "id"],
  ["capped", { filter: "game_id=eq.g1&limit=1", order: "round.desc" }, "player_game", "round"],
]) {
  onDemand(`a ${kind} demand stays bounded after its source collection is cleaned up`, async ({ fake, store }) => {
    let stop = store.subscribe("player_game", () => {}, opts);
    const first = await store.query("player_game", null, opts);
    const collections = globalThis.__mechaClient.collections;
    assert(collections[indexedTable].indexes.size === 1, "the first read installs its index");
    stop();
    // A renderer's last document can release every source reader. Its next
    // request reuses the collection after idle GC has discarded the indexes.
    await Promise.all([collections.player_game.cleanup(), collections.player.cleanup()]);
    assert(collections[indexedTable].indexes.size === 0, "source cleanup discarded the index");
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    const before = fake.subsets.length;
    try {
      stop = store.subscribe("player_game", () => {}, opts);
      assert(collections[indexedTable].indexes.size === 1, `${column} index is recreated before the next query compiles`);
      const again = await store.query("player_game", null, opts);
      assert(JSON.stringify(again) === JSON.stringify(first), "the revisited query returns the same bounded rows");
      const subsets = fake.subsets.slice(before);
      assert(subsets.some(s => s.table === "player_game" && s.where === '"game_id" = $1'), "the revisit requests the game's subset");
      assert(subsets.every(s => s.table === "player_game" ? s.where === '"game_id" = $1' : s.where === '"id" = ANY($1)'), "every reopened source requests only matching rows");
      assert(collections.player_game.size === 2, "the unrelated game's row stays unloaded");
      if (kind === "joined") assert(collections.player.size === 2, "unrelated players stay unloaded");
      assert(warnings.length === 0, `no index fallback: ${warnings.join("; ")}`);
    } finally {
      stop();
      console.warn = warn;
    }
  });
}

onDemand("a literal its column cannot hold is a view of no rows, which Electric can state", async ({ fake, store }) => {
  // What a probe nested under a row with a null foreign key asks for: the
  // placeholder interpolates to the empty string. Regression: sent as the
  // literal, Electric refused to cast it ("invalid syntax for type uuid")
  // and every such probe on golaberto's catalogue failed instead of
  // showing its note.
  const opts = { filter: "round=eq." };
  const stop = store.subscribe("player_game", () => {}, opts);
  const rows = await store.query("player_game", null, opts);
  const [subset] = fake.subsets;
  assert(subset.where === `"id" IS NULL` && Object.keys(subset.params).length === 0, `the subset is ${JSON.stringify(subset)}`);
  assert(rows.length === 0, `matched ${JSON.stringify(rows)}`);
  stop();
});

Deno.test({
  name: "folds and validations cannot treat a partial collection as complete",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = electric(world(), SCHEMA);
    const fold = { fold: true, from: "player_game", to: "stat", key: "player_id", projects: "games", retracted: "retracted_at", watermark: "w", pair: { table: "player", total: "t", counted: "c" } };
    const validation = `(state, event) => state.rows.player_game.length >= 0;\n`;
    const fetch = (input, init) =>
      String(input).endsWith("/app/v.js") ? Promise.resolve(new Response(validation)) : fake.fetcher(input, init);
    await withBrowser({ fetch }, async (createStore) => {
      const store = createStore(fake.base, config({
        uniques: { player_game: [["game_id", "player_id"]] },
        pipelines: [fold],
        validations: { stat: { "counted": { src: "v.js", edges: [{ table: "player_game", key: "player_id", from: "player_id" }] } } },
      }));
      const refused = async (site, run) => {
        try {
          await run();
        } catch (err) {
          assert(err instanceof ProgramError, `${site}: ${err}`);
          assert(/syncs on demand/.test(err.message), `${site}: ${err.message}`);
          return;
        }
        throw new Error(`smoke failed: ${site} read an on-demand table whole`);
      };
      await refused("a fold projection", () => store.query("stat", null, {}));
      await refused("a validation's edge", () => store.add("stat", [{ id: "s2", player_id: "p2", games: 1 }]));
    });
  },
});

Deno.test({
  name: "offset paging uses the server even when its other predicates can run locally",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = electric(world(), SCHEMA);
    const requests = [];
    await withBrowser({ fetch: (input, init) => {
      if (String(input).includes("/crud/player_game?")) {
        requests.push(new URL(input));
        return Promise.resolve(Response.json([{ id: "server-only" }]));
      }
      return fake.fetcher(input, init);
    } }, async createStore => {
      const store = createStore(fake.base, config());
      for (const filter of ["round=eq.3&offset=1&limit=1", "done=is.true&offset=1&limit=1", "player_id=like.p*&offset=1&limit=1"]) {
        const rows = await store.query("player_game", "id.asc", { filter });
        assert(rows[0].id === "server-only", "the server applied the page boundary");
        assert(requests.at(-1).searchParams.get("offset") === "1", "the offset reached the server");
      }
      assert(fake.subsets.length === 0, "paging required no local snapshot");
    });
  },
});

Deno.test({
  name: "an unordered cap reads the complete base and embedded collections",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = electric(world(), SCHEMA);
    await withBrowser({ fetch: fake.fetcher }, async createStore => {
      const store = createStore(fake.base, config({ sync: {} }));
      const rows = await store.query("player_game", null, { filter: "game_id=eq.g1&limit=1", select: "*,player(name)" });
      assert(rows.length === 1 && rows[0].player.name === "Ana", "the cap keeps the joined row");
      assert(fake.subsets.length === 0, "both collections are eager");
    });
  },
});

for (const operation of ["write", "upsert", "delete"]) {
  onDemand(
    `an opaque ${operation} waits for complete demand before touching an unseen row`,
    async ({ fake, store }) => {
      const opts = { filter: "game_id=eq.g1" };
      const stop = store.subscribe("player_game", () => {}, opts);
      await store.query("player_game", null, opts);
      const collection = globalThis.__mechaClient.collections.player_game;
      assert(!collection.has("pg3"), "the first screen loaded only its subset");
      const release = fake.hold("player_game");
      let done = false;
      const mutate = () =>
        operation === "write"
          ? store.write("player_game", [{ key: "pg3", row: { round: 9 } }])
          : operation === "upsert"
          ? store.upsertBy("player_game", { id: "pg3", round: 9 })
          : store.dropWhere("player_game", "game_id=eq.g2");
      const pending = mutate().then(() => {
        done = true;
      });
      await until(
        () => fake.subsets.some((s) => s.where.includes("IS NOT NULL")),
        "requested complete mutation demand",
      );
      await tick(30);
      assert(
        !done && !collection.has("pg3"),
        "the operation waits for the missing rows",
      );
      release();
      await pending;
      assert(
        operation === "delete" ? !collection.has("pg3") : collection.get("pg3").round === 9,
        `the unseen row was mutated: ${JSON.stringify(collection.get("pg3"))}`,
      );
      const before = fake.subsets.length;
      await mutate();
      assert(
        fake.subsets.length === before,
        "repeated mutations reuse complete demand",
      );
      stop();
    },
  );
}

onDemand(
  "mutation demand survives a screen releasing its shared view",
  async ({ fake, store }) => {
    const opts = { filter: "id=not.is.null" };
    const stop = store.subscribe("player_game", () => {}, opts);
    await store.query("player_game", null, opts);
    await store.write("player_game", [{ key: "pg3", row: { round: 9 } }]);
    stop();
    // TanStack collects a view five seconds after its last real subscriber.
    await tick(5200);
    fake.push("player_game", {
      id: "pg4",
      game_id: "g2",
      player_id: "p9",
      round: "7",
      txid: "20",
    }, 20);
    const collection = globalThis.__mechaClient.collections.player_game;
    await until(
      () => collection.has("pg4"),
      "the retained demand received a later row",
    );
    await store.dropWhere("player_game", "id=eq.pg4");
    assert(collection.has("pg3") && !collection.has("pg4"), "the later row is available to a subsequent mutation");
  },
);

onDemand(
  "concurrent mutations share complete demand and wait through a transport failure",
  async ({ fake, store }) => {
    fake.fail("player_game", [401, { error: "invalid shape token" }]);
    await Promise.all([
      store.write("player_game", [{ key: "pg1", row: { round: 8 } }]),
      store.write("player_game", [{ key: "pg3", row: { round: 9 } }]),
    ]);
    assert(
      globalThis.__prontoViews.size === 1 && fake.subsets.length >= 2,
      "both writes share the retained view across its retry",
    );
    const collection = globalThis.__mechaClient.collections.player_game;
    assert(
      collection.get("pg1").round === 8 && collection.get("pg3").round === 9,
      "both writes landed",
    );
  },
);

onDemand(
  "a refused mutation subset leaves the collection untouched",
  async ({ fake, store }) => {
    fake.fail("player_game", [400, REFUSED_BY_ELECTRIC]);
    const error = await store.write("player_game", [{
      key: "pg1",
      row: { round: 9 },
    }]).then(() => null, (err) => err);
    assert(
      error instanceof ProgramError,
      `the subset refusal reaches the caller: ${error}`,
    );
    assert(
      !globalThis.__mechaClient.collections.player_game.has("pg1"),
      "no optimistic mutation preceded the refused read",
    );
  },
);

onDemand("a write by key loads the row no view loaded, and a row that does not exist is the collection's own refusal", async ({ fake, store }) => {
  // Regression: the key a form or an effect carries need not be a row any
  // view on the screen loaded (a pick from a server-computed list), and
  // TanStack refuses to update a key it does not hold. Resolving is the
  // write accepted.
  await store.patch("player_game", [{ key: "pg3", changes: { round: 9 } }]);
  const [subset] = fake.subsets;
  assert(subset.where === `"id" = $1` && subset.params["1"] === "pg3", `the row was loaded by its key: ${JSON.stringify(subset)}`);
  assert(globalThis.__mechaClient.collections.player_game.has("pg3"), "the row the write named is held");
  assert(globalThis.__prontoViews.size === 0, "the view the write held is released");
  let refusal;
  try {
    await store.patch("player_game", [{ key: "nope", changes: { round: 9 } }]);
  } catch (err) {
    refusal = err;
  }
  assert(/passed to update but an object for this key was not found/.test(refusal?.message), `patch of a missing key: ${refusal}`);
});

onDemand("a read waiting on a view its region released settles, and the region's next subscription reads afresh", async ({ fake, store }) => {
  const opts = { filter: "game_id=eq.g1" };
  const release = fake.hold("player_game");
  const stop = store.subscribe("player_game", () => {}, opts);
  let answer = "pending";
  store.query("player_game", null, opts).then((rows) => (answer = rows), (err) => (answer = err));
  await until(() => fake.subsets.length > 0, "asked for the view's subset");
  // Regression: a Back press mid-load released the view's last
  // reference, cleaned it up, and the read waiting on it never settled;
  // the region awaiting it held its refresh, and every parent's, so the
  // held screen never repainted again.
  stop();
  release();
  await until(() => answer !== "pending", "settled the read of a released view");
  assert(Array.isArray(answer) && JSON.stringify(answer.map((r) => r.id).sort()) === `["pg1","pg2"]`, `the read: ${answer}`);
  assert(globalThis.__prontoViews.size === 0, "the view went with its last reader");
  const again = store.subscribe("player_game", () => {}, opts);
  const rows = await store.query("player_game", null, opts);
  assert(JSON.stringify(rows.map((r) => r.id).sort()) === `["pg1","pg2"]`, `the next read: ${JSON.stringify(rows)}`);
  again();
});

// Electric's and the gate's refusals of a subset, as they answer them.
const REFUSED_BY_ELECTRIC = { message: "Invalid request", errors: { subset: { where: ["At location 0: unknown reference nope"] } } };
const REFUSED_BY_GATE = { message: "Invalid request", errors: { subset: { where: ["subset__where is not a predicate a subset may state"] } } };

onDemand("a subset that failed in transit is asked again while the read waits, and only a refusal of the subset itself is a program error", async ({ fake, store }) => {
  const ids = (rows) => JSON.stringify(rows.map((r) => r.id).sort());
  const failure = (p) => p.then(() => null, (err) => err);
  const asked = (filter) => fake.subsets.filter((s) => s.table === "player_game" && s.params["1"] === filter).length;
  // Regression: a transport failure rejected the region's first read, the
  // screen went to network-error and re-read on its own backoff (2s, 4s,
  // 8s), and two misses outlasted a reader's patience: /chances opens
  // some forty subsets, and one CI run of test-chances-live never saw it
  // populated. A token Electric's gate no longer takes (401), one minted
  // for a where the stream has since moved off (403), and a 409 loop the
  // client gave up on (its 502) are each answered on a retry.
  // What a view's load asks with nothing failing, which each failure
  // below adds one request to.
  const g2 = { filter: "game_id=eq.g2" };
  const stopG2 = store.subscribe("player_game", () => {}, g2);
  assert(ids(await store.query("player_game", null, g2)) === `["pg3"]`, "a view of the table loads");
  const clean = asked("g2");
  const g1 = { filter: "game_id=eq.g1" };
  const stopG1 = store.subscribe("player_game", () => {}, g1);
  const refetch = [409, [{ headers: { control: "must-refetch" } }]];
  fake.fail("player_game", [401, { error: "invalid shape token" }], [403, { error: "where not authorized" }], ...Array(6).fill(refetch));
  const read = await store.query("player_game", null, g1).then(ids, (err) => err);
  assert(read === `["pg1","pg2"]`, `the read waited out the failures: ${read}`);
  // Electric's client asks six times through a 409 before it gives up.
  assert(asked("g1") === clean + 8, `the subset was asked again after each failure: ${asked("g1")} against ${clean}`);
  // Regression: the failure was kept on the collection and never cleared,
  // so every later view of the table failed with it.
  assert(ids(await store.query("player_game", null, g2)) === `["pg3"]`, "another view of the table still reads");
  // A refusal of the subset itself is the program asking for a predicate
  // that cannot be stated, which no retry repairs.
  for (const [status, body, round] of [[400, REFUSED_BY_ELECTRIC, "3"], [400, REFUSED_BY_GATE, "4"]]) {
    const opts = { filter: `round=eq.${round}` };
    const stop = store.subscribe("player_game", () => {}, opts);
    fake.fail("player_game", [status, body]);
    const refused = await failure(store.query("player_game", null, opts));
    assert(refused instanceof ProgramError && /refused a subset of player_game/.test(refused.message), `a ${status} refusal: ${refused}`);
    stop();
  }
  assert(ids(await store.query("player_game", null, g2)) === `["pg3"]`, "a refusal fails no other view");
  stopG1();
  stopG2();
});

// Regression: every failure that was no refusal rebuilt the view without end,
// and the read waited on it all the while: an auth service minting nothing, a
// gate refusing what it minted, or the page's cluster answering in a body the
// store did not read as a refusal left the region loading for good, the cause
// on the console alone, where the screen used to say network-error.
onDemand("a subset that keeps failing fails the read once its rebuilds run out, and the next read asks again", async ({ fake, store }) => {
  const opts = { filter: "game_id=eq.g1" };
  const stop = store.subscribe("player_game", () => {}, opts);
  const asked = () => fake.subsets.filter((s) => s.table === "player_game" && s.params["1"] === "g1").length;
  fake.fail("player_game", ...Array(7).fill([403, { error: "table not authorized" }]));
  const failed = await Promise.race([store.query("player_game", null, opts).then(() => null, (err) => err), tick(12000).then(() => "still waiting")]);
  assert(failed instanceof Error && !(failed instanceof ProgramError), `the read failed as an outage: ${failed}`);
  assert(/a subset of player_game failed 7 times in a row: .*403/.test(failed.message), `the read names the table and the failure: ${failed.message}`);
  assert(asked() === 7, `the subset was asked once and again six times: ${asked()}`);
  const rows = await store.query("player_game", null, opts);
  assert(JSON.stringify(rows.map((r) => r.id).sort()) === `["pg1","pg2"]`, `the next read asked again: ${JSON.stringify(rows)}`);
  stop();
});

onDemand("a typed literal is read against its column's own field and compared in canonical form", async ({ fake, store }) => {
  const read = async (filter) => {
    const stop = store.subscribe("stat", () => {}, { filter });
    try {
      return JSON.stringify((await store.query("stat", null, { filter })).map((r) => r.id).sort());
    } finally {
      stop();
    }
  };
  // Regression: the literal was read against a field with no precision or
  // scale, which a decimal refuses, so every decimal literal counted as one
  // the column cannot hold: eq matched nothing and neq everything.
  assert(await read("rate=eq.1.50") === `["s1"]`, "a decimal's eq");
  assert(await read("rate=neq.1.5") === `["s2"]`, "a decimal's neq");
  assert(await read("rate=eq.1.555") === `[]`, "a decimal out of the column's profile is no row's");
  assert(await read("ref=eq.0C000000-0000-4000-8000-0000000000AA") === `["s1"]`, "a uuid in uppercase");
  // Regression: a column declared by a physical label (timestamptz) keeps
  // Electric's spelling in the row, since only a canonical type has a
  // canonical form, and the literal was canonicalized all the same:
  // `2026-09-22T14:18:21.846230Z` against a row holding Postgres's text
  // matched nothing.
  assert(await read("at=eq.2026-09-22 14:18:21.84623+00") === `["s1"]`, "a physical label's literal in the row's own spelling");
  assert(await read("at=neq.2026-09-22 14:18:21.84623+00") === `["s2"]`, "a physical label's neq");
});

onDemand("a whole read demands its embeds while an eager base snapshot is pending", async ({ fake, store }) => {
  const release = fake.stall("stat");
  const releaseEmbed = fake.hold("player");
  let answered;
  const pending = store.query("stat", null, { select: "*,player(name)" }).then(rows => answered = rows);
  await until(() => fake.subsets.some(s => s.table === "player"), "demanded the embed concurrently");
  release();
  await tick(30);
  assert(answered === undefined, "the base alone cannot answer the join");
  releaseEmbed();
  await pending;
  assert(answered.length === 2 && answered[1].player.name === "Bia", "complete embedded rows arrived");
  assert(globalThis.__prontoViews.size === 0, "temporary complete demand released");
});

onDemand("a broad reader neither widens nor blocks a concurrent filtered reader", async ({ fake, store }) => {
  const opts = { filter: "game_id=eq.g1" };
  const stopSubset = store.subscribe("player_game", () => {}, opts);
  assert((await store.query("player_game", null, opts)).length === 2, "filtered screen loaded its subset");
  assert(!globalThis.__mechaClient.collections.player_game.has("pg3"), "unmounted broad screen costs no rows");
  const release = fake.hold("player_game");
  const stopWhole = store.subscribe("player_game", () => {});
  let answered;
  const pending = store.query("player_game", null).then(rows => answered = rows);
  await until(() => fake.subsets.some(s => s.where.includes("IS NOT NULL")), "requested complete snapshot");
  assert((await store.query("player_game", null, opts)).length === 2, "filtered read proceeds while full demand waits");
  assert(answered === undefined, "ready source is not proof of complete snapshot");
  release();
  await pending;
  assert(answered.length === 3, "broad read includes unseen row");
  stopWhole();
  assert(globalThis.__prontoViews.size === 1, "only the subset view remains");
  assert((await store.query("player_game", null, opts)).length === 2, "release preserves filtered reader");
  stopSubset();
  assert(globalThis.__prontoViews.size === 0, "all readers released");
});

for (const filter of ["game_id=eq.g1", "game_id=ilike.g1", undefined]) {
  onDemand(`a pending ${filter ?? "whole"} read survives its screen leaving past view GC`, async ({ fake, store }) => {
    const opts = { filter };
    const release = fake.hold("player_game");
    const stop = store.subscribe("player_game", () => {}, opts);
    const pending = store.query("player_game", null, opts);
    await until(() => fake.subsets.length > 0, "subset pending");
    stop();
    await tick(5200);
    release();
    const rows = await pending;
    assert(rows.length === (filter ? 2 : 3), "pending read retained a real listener");
    assert(globalThis.__prontoViews.size === 0, "read lease released");
  });
}

for (const filter of ["game_id=eq.g1", "game_id=ilike.g1"]) {
  onDemand(`a named ${filter} read releases its temporary demand on success and refusal`, async ({ fake, store }) => {
    fake.fail("player_game", [400, { errors: { subset: ["predicate rejected"] } }]);
    const error = await store.query("player_game", null, { filter }).then(() => null, err => err);
    assert(error instanceof ProgramError, "subset refusal reaches caller");
    assert(globalThis.__prontoViews.size === 0, "failed named demand released");
    assert((await store.query("player_game", null, { filter })).length === 2, "next named demand succeeds");
    assert(globalThis.__prontoViews.size === 0, "successful named demand released");
  });
}

onDemand("a snapshot subscription holds notifications until all embedded demand is complete", async ({ fake, store }) => {
  const release = fake.hold("player");
  const opts = { filter: "game_id=eq.g1&limit=1", select: "*,player(name)" };
  let wakes = 0;
  const stop = store.subscribe("player_game", () => wakes++, opts);
  let answered;
  const pending = store.query("player_game", null, opts).then(rows => answered = rows);
  await until(() => globalThis.__mechaClient.collections.player_game.size === 3, "complete base loaded");
  await tick(30);
  assert(wakes === 0 && answered === undefined, "no half-joined wake or answer");
  release();
  await pending;
  await until(() => wakes > 0, "complete snapshot wake released");
  assert(answered.length === 1 && answered[0].player.name === "Ana", "unordered cap keeps its joined row");
  assert(new Set(fake.subsets.map(s => s.table)).size === 2 && fake.subsets.every(s => s.where.includes("IS NOT NULL")), `both tables demanded complete snapshots: ${JSON.stringify(fake.subsets)}`);
  stop();
});

onDemand("a capped free-text order demands completeness before sorting locally", async ({ fake, store }) => {
  const rows = await store.query("player", "name.desc", { filter: "id=not.is.null&limit=1" });
  assert(rows.length === 1 && rows[0].name === "Duda", "local collation and cap applied");
  const optionOrder = await store.query("player", null, { order: "name.desc", filter: "id=not.is.null&limit=1" });
  assert(optionOrder.length === 1 && optionOrder[0].name === "Duda", "options order survives snapshot routing");
  assert(fake.subsets.length > 0 && fake.subsets.every(s => s.where.includes("IS NOT NULL")), `no server collation cursor: ${JSON.stringify(fake.subsets)}`);
});

Deno.test({
  name: "unsupported predicate carriers and joined keys demand complete snapshots without typed equality",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const rows = world();
    rows.player = [{ id: "1", name: "Ana", txid: "1" }, { id: "2", name: "Bia", txid: "1" }];
    rows.stat[0].player_id = "1";
    rows.stat[1].player_id = "2";
    const fake = electric(rows, { ...SCHEMA, player: { ...SCHEMA.player, id: { type: "int8" } } });
    const cfg = config({ sync: { stat: "on-demand", player: "on-demand" } });
    cfg.schema.player.fields[0].type = "int64";
    await withBrowser({ fetch: fake.fetcher }, async createStore => {
      const store = createStore(fake.base, cfg);
      const selected = await store.query("stat", null, { filter: "rate=eq.1.5", select: "*,player(name)" });
      assert(selected.length === 1 && selected[0].player.name === "Ana", "domain predicate uses carrier comparison");
      const joined = await store.query("stat", null, { filter: "id=eq.s2", select: "*,player(name)" });
      assert(joined.length === 1 && joined[0].player.name === "Bia", "unsupported joined key uses complete embed");
      assert(fake.subsets.every(s => s.where.includes("IS NOT NULL")), "no unsafe equality sent to Electric");
      assert(globalThis.__prontoViews.size === 0, "snapshot demands released");
    });
  },
});

for (const mode of ["eager", "on-demand"]) {
  Deno.test({
    name: `${mode} typed queries preserve canonical equality, nulls and invalid literals`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const rows = world();
      rows.stat.push({ ...rows.stat[0], id: "null", rate: null, ref: null });
      const fake = electric(rows, SCHEMA);
      await withBrowser({ fetch: fake.fetcher }, async createStore => {
        const store = createStore(fake.base, config({ sync: { stat: mode } }));
        // A decimal cannot be sent in an Electric subset: the complete
        // snapshot must compare its literals exactly as an eager view does.
        const cases = [
          ["rate=eq.1.50", ["s1"]],
          ["rate=neq.1.50", ["s2"]],
          ["rate=eq.1.555", []],
          ["rate=neq.1.555", ["s1", "s2"]],
          ["rate=neq.1.555&ref=eq.0C000000-0000-4000-8000-0000000000AA", ["s1"]],
          ["rate=neq.1.555&ref=eq.invalid", []],
          ["rate=neq.1.555&ref=neq.invalid", ["s1", "s2"]],
        ];
        for (const [filter, expected] of cases) {
          const opts = { filter };
          const stop = store.subscribe("stat", () => {}, opts);
          try {
            const ids = (await store.query("stat", null, opts)).map(row => row.id).sort();
            assert(JSON.stringify(ids) === JSON.stringify(expected), `${mode} ${filter}: ${JSON.stringify(ids)}`);
          } finally { stop(); }
        }
        let wakes = 0;
        const opts = { filter: "rate=eq.1.50" };
        const stop = store.subscribe("stat", () => { wakes++; }, opts);
        try {
          await store.query("stat", null, opts);
          await tick(30);
          wakes = 0;
          fake.push("stat", { ...rows.stat[0], id: "s3", rate: "1.50", txid: "20" }, 20);
          await until(() => wakes > 0, "a canonical-equivalent external row wakes the query");
          const ids = (await store.query("stat", null, opts)).map(row => row.id).sort();
          assert(JSON.stringify(ids) === '["s1","s3"]', `the refreshed query includes the new row: ${JSON.stringify(ids)}`);
        } finally { stop(); }
      });
    },
  });
}

for (const mode of ["eager", "on-demand"]) {
  Deno.test({
    name: `${mode} JSON scalar snapshots preserve queries and external wakes`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const rows = world();
      rows.stat[0].payload = "1";
      rows.stat[1].payload = "true";
      const fake = electric(rows, { ...SCHEMA, stat: { ...SCHEMA.stat, payload: { type: "json" } } });
      const cfg = config({ sync: { stat: mode } });
      cfg.carriers = { ...FIXTURE_CARRIERS, types: { ...FIXTURE_CARRIERS.types, json: {
        pg: "json", column: "checked", subset: false, base: ["json", "jsonb"], json: "value", order: "none", beyond: ["scalar-values", "finite-numbers"],
      } } };
      cfg.schema.stat.fields.push({ name: "payload", type: "json" });
      await withBrowser({ fetch: fake.fetcher }, async createStore => {
        const store = createStore(fake.base, cfg);
        // A canonical JSON literal stays text; synced scalars are numbers
        // and booleans, so snapshot predicates keep their text comparison.
        for (const [filter, expected] of [
          ["payload=eq.1&id=like.*", ["s1"]],
          ["payload=eq.true&id=like.*", ["s2"]],
          ["payload=neq.1&id=like.*", ["s2"]],
        ]) {
          const ids = (await store.query("stat", null, { filter })).map(row => row.id).sort();
          assert(JSON.stringify(ids) === JSON.stringify(expected), `${mode} ${filter}: ${JSON.stringify(ids)}`);
        }
        const watches = [
          { filter: "payload=eq.1&id=like.*", payload: "1", source: rows.stat[0], id: "s3", expected: ["s1", "s3"], wakes: 0 },
          { filter: "payload=eq.true&id=like.*", payload: "true", source: rows.stat[1], id: "s4", expected: ["s2", "s4"], wakes: 0 },
        ];
        const stops = watches.map(w => store.subscribe("stat", () => { w.wakes++; }, { filter: w.filter }));
        try {
          await Promise.all(watches.map(w => store.query("stat", null, { filter: w.filter })));
          await tick(30);
          for (const w of watches) w.wakes = 0;
          for (const [i, w] of watches.entries()) fake.push("stat", { ...w.source, id: w.id, payload: w.payload, txid: String(20 + i) }, 20 + i);
          await until(() => watches.every(w => w.wakes > 0), "matching external JSON scalars wake their snapshot queries");
          for (const w of watches) {
            const ids = (await store.query("stat", null, { filter: w.filter })).map(row => row.id).sort();
            assert(JSON.stringify(ids) === JSON.stringify(w.expected), `${mode} refreshed ${w.filter}: ${JSON.stringify(ids)}`);
          }
        } finally { for (const stop of stops) stop(); }
      });
    },
  });
}

Deno.test({
  name: "server durability reads filtered joins on request without opening Electric",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const requests = [];
    let rows = [{ id: "pg1", game_id: "g1", player: { name: "Ana" } }];
    await withBrowser({ fetch: async (input, init) => {
      const url = new URL(String(input));
      if (servers.has(url.origin)) return servers.get(url.origin)(input, init);
      assert(url.origin === "http://request-only", `unexpected request origin: ${url.origin}`);
      requests.push(url);
      assert(url.pathname === "/crud/player_game", "a server read opened neither auth nor Electric");
      return Response.json(rows);
    } }, async createStore => {
      const cfg = config();
      cfg.schema.player_game.durability = "server";
      const store = createStore("http://request-only", cfg);
      const opts = { filter: "game_id=eq.g1&limit=40&offset=0", select: "*,player(name)", order: "round.desc" };
      let wakes = 0;
      const stop = store.subscribe("player_game", () => wakes++, opts);
      try {
        assert((await store.query("player_game", null, opts))[0].player.name === "Ana", "joined server result");
        assert(requests.length === 1, "only the requested read");
        assert(requests[0].searchParams.get("game_id") === "eq.g1", "filter reaches server");
        assert(requests[0].searchParams.get("order") === "round.desc", "order reaches server");
        rows = [];
        await tick(30);
        assert(wakes === 0 && requests.length === 1, `remote changes do not trigger a request-only read: ${wakes} wakes, ${requests.map(String).join(", ")}`);
        assert((await store.query("player_game", null, opts)).length === 0, "an explicit read gets current rows");
        assert(globalThis.__prontoViews.size === 0, "request-only reads create no local views");
        assert(globalThis.__mechaClient.collections.player_game.size === 0, "request-only reads retain no rows");
      } finally { stop(); }
    });
  },
});

Deno.test({
  name: "a completed local command refreshes a server read that began before it",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    let releaseRead;
    const reading = new Promise(resolve => { releaseRead = resolve; });
    let calls = 0;
    let committed = [];
    await withBrowser({ fetch: async input => {
      assert(String(input).startsWith("http://settled/crud/player_game?"), "the read opens no remote subscription");
      const snapshot = [...committed];
      if (++calls === 1) await reading;
      return Response.json(snapshot);
    } }, async createStore => {
      const cfg = config();
      cfg.schema.player_game.durability = "server";
      const store = createStore("http://settled", cfg);
      let finishWrite;
      globalThis.__mechaClient.insert = (_table, rows) => new Promise(resolve => {
        finishWrite = () => { committed = rows; resolve(); };
      });
      let refreshed;
      const stop = store.subscribe("player_game", () => { refreshed = store.query("player_game"); });
      try {
        const first = store.query("player_game");
        const write = store.add("player_game", [{ id: "pg1", game_id: "g1", player_id: "p1", round: 1 }]);
        await until(() => finishWrite !== undefined, "local command started");
        assert(calls === 1 && refreshed === undefined, "an unfinished command does not refresh");
        finishWrite();
        await write;
        await until(() => refreshed !== undefined, "command completion requests a new read");
        assert((await refreshed)[0].id === "pg1", "refresh includes committed result");
        releaseRead();
        assert((await first).length === 0, "the overlapping read held the old snapshot");
        assert(calls === 2, "one initial read and one completion refresh");
      } finally { releaseRead(); stop(); }
    });
  },
});

Deno.test({
  name: "server reads of absent optional references are empty without an invalid UUID request",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withBrowser({ fetch: () => { throw new Error("an impossible typed equality reached the network"); } }, async createStore => {
      const cfg = config();
      cfg.schema.stat.durability = "server";
      cfg.carriers = { ...FIXTURE_CARRIERS, types: { ...FIXTURE_CARRIERS.types,
        uuid: { ...FIXTURE_CARRIERS.types.uuid, pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" },
      } };
      const store = createStore("http://optional-reference", cfg);
      for (const filter of ["ref=eq.", "ref=eq.not-a-uuid", "games=eq.invalid"]) {
        assert((await store.query("stat", null, { filter })).length === 0, filter);
      }
    });
  },
});
