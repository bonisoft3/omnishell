// Deno smoke: a table that syncs on demand, over the real store, the vendored
// client and a ShapeStream answered by an Electric in process. A view's rows
// are only the ones its subsets loaded, so the store must never answer before
// they are all there, never wake a region on a half-joined row, and refuse
// every read that would take the collection for the table.

import { FIXTURE_CARRIERS } from "./fixture-types.js";
import { ProgramError } from "./fragment.js";
import { assert, tick, until, withBrowser } from "./smoke-browser.js";

// Electric's shape protocol as @electric-sql/client asks it: an on-demand
// shape opens at `offset=now` with only changes logged, each view's rows come
// as a subset snapshot, and live polls hang until a change is pushed. A subset
// waits on the gate the test holds for its table.
let worlds = 0;
function electric(server, schema) {
  const subsets = [];
  const gates = new Map();
  const stalls = new Map();
  const failing = new Map();
  const live = new Map();
  const headers = (table) => ({
    "content-type": "application/json",
    "electric-handle": `h-${table}`,
    "electric-offset": "0_0",
    "electric-schema": JSON.stringify(schema[table]),
    "electric-cursor": "0",
  });
  const message = (table, operation, value, txid) => ({
    key: `"public"."${table}"/"${value.id}"`,
    value,
    headers: { operation, relation: ["public", table], ...(txid === undefined ? {} : { txids: [txid] }) },
  });
  const upToDate = { headers: { control: "up-to-date", global_last_seen_lsn: "1" } };
  // `"c" = $1` and `"c" = ANY($1)`, ANDed: what a view's eq clauses and a
  // join's lazy load compile to.
  const matches = (where, params) => {
    // A key that is null is a row that does not exist.
    if (/^"\w+" IS NULL$/.test(where.trim())) return () => false;
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
        metadata: { xmin: "1", xmax: "1", xip_list: [], snapshot_mark: subsets.length, database_lsn: "1" },
        data: rows.map((r) => message(table, "insert", r)),
      }), { headers: headers(table) });
    }
    if (p.get("live") !== "true") {
      await (stalls.get(table) ?? Promise.resolve());
      const rows = p.get("log") === "changes_only" ? [] : (server[table] ?? []).map((r) => message(table, "insert", r));
      return new Response(JSON.stringify([...rows, upToDate]), { headers: headers(table) });
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
    return new Response(JSON.stringify([...batch, upToDate]), { headers: headers(table) });
  };
  return {
    fetcher,
    // A host of its own: Electric's client remembers a shape's position by its
    // URL for the life of the module, and would resume one test's stream into
    // the next test's fake.
    base: `http://fake${++worlds}`,
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
    push(table, row, txid) {
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
    player_game: { fields: [{ name: "id", type: "string" }, { name: "game_id", type: "string" }, { name: "player_id", type: "string" }, { name: "round", type: "int32" }] },
    player: { fields: [{ name: "id", type: "string" }, { name: "name", type: "string" }] },
    stat: { fields: [
      { name: "id", type: "string" }, { name: "player_id", type: "string" }, { name: "games", type: "int32" },
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

/** A test of the store over an Electric serving world(), handed both. */
const onDemand = (name, fn) =>
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const fake = electric(world(), SCHEMA);
      await withBrowser({ fetch: fake.fetcher }, (createStore) => fn({ fake, store: createStore(fake.base, config()) }));
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
  name: "every read that takes an on-demand collection for its table is a program error",
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
      await refused("a snapshot read", () => store.query("player_game", null, { filter: "player_id=ilike.*p*" }));
      await refused("a whole read", () => store.query("player", null, {}));
      await refused("a write by key", () => store.write("player_game", [{ key: "pg1", row: { round: 9 } }]));
      await refused("an upsert", () => store.upsertBy("player_game", { game_id: "g1", player_id: "p1" }));
      await refused("a delete by filter", () => store.dropWhere("player_game", "game_id=eq.g1"));
      await refused("a fold projection", () => store.query("stat", null, {}));
      await refused("a validation's edge", () => store.add("stat", [{ id: "s2", player_id: "p2", games: 1 }]));
    });
  },
});

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

// Regression: the check that an embedded table is read whole ran after the
// base table's first snapshot, so an eager table embedding an on-demand one
// raised nothing while its own shape stalled, and the region sat loading
// where it should have named the program error.
onDemand("a read embedding a table on demand is a program error before it waits on anything", async ({ fake, store }) => {
  const release = fake.stall("stat");
  try {
    const failed = await Promise.race([
      store.query("stat", null, { select: "*,player(name)" }).then(() => null, (err) => err),
      tick(500).then(() => "still waiting"),
    ]);
    assert(failed instanceof ProgramError, `the read failed as the program's error: ${failed}`);
    assert(/a read of stat embedding it reads player whole/.test(failed.message), `the error names the embed: ${failed.message}`);
  } finally {
    release();
  }
});
