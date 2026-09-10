// Deno smoke: a region wakes on its own input changing, and not on every write
// to the table it happens to read.
//
// The engine already hands `subscribeChanges` a change set. Dropping it and
// re-reading the whole collection means a comment written on any article
// re-queries the comment region of every article on screen — the cost the
// filter exists to avoid. These assertions guard the direction of that gate:
// a matching row must always wake the region, and anything the filter cannot
// decide must wake it too, because being unsure costs a re-read while being
// wrong costs a stale screen.
import {
  createStore,
  embedTables,
  isMaintainable,
  parseFilter,
  parseFilterSpec,
  parseLimit,
  parseSelect,
  touches,
} from "./data-crud.js";
import * as fragment from "./fragment.js";

const { parseReadSpec } = fragment;

const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

// The grammar has one reader: the store adapter re-exports fragment.js's
// parsers unchanged, so both import paths hold the same function objects.
Deno.test("the fragment parsers have one definition", () => {
  assert(fragment.parseFilter === parseFilter, "parseFilter");
  assert(fragment.parseFilterSpec === parseFilterSpec, "parseFilterSpec");
  assert(fragment.parseLimit === parseLimit, "parseLimit");
  assert(fragment.parseSelect === parseSelect, "parseSelect");
});

const insert = (value) => ({ type: "insert", key: String(value.id), value });
const remove = (previousValue) => ({ type: "delete", key: String(previousValue.id), previousValue });
const change = (previousValue, value) => ({ type: "update", key: String(value.id), previousValue, value });

Deno.test("a row matching the filter wakes the region", () => {
  const preds = parseFilter("article_id=eq.a1");
  assert(touches(preds, [insert({ id: "c1", article_id: "a1" })]), "insert into the region");
  assert(touches(preds, [remove({ id: "c1", article_id: "a1" })]), "delete from the region");
});

Deno.test("a row the region could never show does not wake it", () => {
  const preds = parseFilter("article_id=eq.a1");
  assert(!touches(preds, [insert({ id: "c2", article_id: "a2" })]), "another article's comment");
  assert(
    !touches(preds, [insert({ id: "c2", article_id: "a2" }), remove({ id: "c3", article_id: "a3" })]),
    "a whole batch from elsewhere",
  );
});

// A row moving across the filter boundary changes the region in both
// directions, and only the pre-image says so for a row on its way out.
Deno.test("both sides of an update count", () => {
  const preds = parseFilter("pinned=is.true");
  assert(
    touches(preds, [change({ id: "n1", pinned: true }, { id: "n1", pinned: false })]),
    "unpinning leaves the region",
  );
  assert(
    touches(preds, [change({ id: "n1", pinned: false }, { id: "n1", pinned: true })]),
    "pinning enters the region",
  );
  assert(
    !touches(preds, [change({ id: "n1", pinned: false }, { id: "n1", pinned: false })]),
    "a row that was and stays outside",
  );
});

// parseFilter returns null for anything it cannot translate (embed-path
// filters, fts). Those regions read through PostgREST, so the client cannot
// decide relevance and must never skip.
Deno.test("an undecidable filter always wakes the region", () => {
  assert(touches(parseFilter("author.handle=eq.davi"), [insert({ id: "x" })]), "embed-path filter");
  assert(touches(parseFilter("search=plfts(simple).dragons"), [insert({ id: "x" })]), "full-text");
  assert(touches(parseFilter(undefined), [insert({ id: "x" })]), "unfiltered region reads everything");
});

// The engine is not the only caller: an own write that settles notifies with
// no change set at all, because the optimistic overlay already matched and the
// collection shows no further diff.
Deno.test("a wake carrying no change set is always relevant", () => {
  const preds = parseFilter("article_id=eq.a1");
  assert(touches(preds, undefined), "settled own write");
  assert(touches(preds, null), "no batch");
});

// Which reads may become a maintained view. The dangerous direction is a
// false yes: the view is built without what the region binds, and the region
// renders blank instead of failing. `*,author:app_user(handle)` is the case
// that actually shipped broken — parseSelect rejects the alias syntax and
// returns null, which read as "no embeds" instead of "server-computed".
const can = (filter, select, access, embedAccess = {}) =>
  isMaintainable(parseFilterSpec(filter), parseSelect(select), access, (t) => embedAccess[t]);

Deno.test("a plain read on a public table is maintainable", () => {
  assert(can("article_id=eq.a1", undefined, { mode: "public-read" }), "eq on public-read");
  assert(can(undefined, undefined, undefined), "unfiltered, no access rule");
  assert(can("deleted_at=is.null", undefined, undefined), "is.null");
});

Deno.test("an embed everyone may read becomes a join", () => {
  const pub = { app_user: { mode: "public-read" }, label: { mode: "public-read" } };
  assert(can("slug=eq.x", "*,author:app_user(handle,image_url)", { mode: "public-read" }, pub), "aliased embed");
  assert(can("slug=eq.x", "*,label(name)", { mode: "public-read" }, pub), "unaliased embed");
  assert(can("slug=eq.x", "*,label(name)", { mode: "public-read" }, {}), "no policy at all means anyone may read");
});

// A left join has nowhere to put a per-row visibility test. The snapshot path
// binds the whole embed null for a row this reader cannot see; a join would
// hand over its columns instead.
Deno.test("an embed of a restricted table is not joined here", () => {
  assert(!can("id=eq.x", "*,owner:me(handle)", { mode: "public-read" }, { me: { mode: "owned", owner: "id" } }), "owned embed");
  assert(!can("id=eq.x", "*,f:follow(follower_id)", { mode: "public-read" }, { follow: { mode: "owned", owner: "follower_id" } }), "another owned embed");
  assert(!can("id=eq.x", "*,s:secret(v)", { mode: "public-read" }, { secret: { mode: "service-only" } }), "service-only embed");
});

Deno.test("a hinted embed is server-computed, not embed-free", () => {
  // null must read as "server-computed" rather than "no embeds" — collapsing
  // those built a view whose rows were missing the columns the region binds.
  assert(parseSelect("*,follow!followed_id!inner(follower_id)") === null, "hinted embed does not parse");
  assert(!can("slug=eq.x", "*,follow!followed_id!inner(follower_id)", { mode: "public-read" }), "and is not maintainable");
});

Deno.test("reads the query cannot state stay on the snapshot path", () => {
  assert(!can("search=plfts(simple).dragons", undefined, undefined), "full-text");
  assert(!can("author.handle=eq.davi", undefined, undefined), "embed-path filter");
  assert(!can("created_at=lt.2026-01-01", undefined, undefined), "an ordered cursor");
  // A defaulted boolean is absent on an unconfirmed optimistic row, which the
  // snapshot predicate admits deliberately.
  assert(!can("pinned=is.false", undefined, undefined), "is.false");
  assert(!can("pinned=is.true", undefined, undefined), "is.true");
});

// Only a table everyone may read. `owned` looks like one more eq on the owner
// column, and measured against the running cluster it excluded exactly the row
// it must not: an optimistic insert carries no owner column — auth_uid() fills
// it server-side — and isNull matches a null, not a missing, property. So a
// favourite did not appear until its round trip landed. visible() admits that
// row through `$synced === false`, which is a fact about the client's own
// pending write rather than anything a query over the data can state.
Deno.test("only visibility the query can restate is maintainable", () => {
  assert(can("id=eq.x", undefined, { mode: "public-read" }), "public-read adds no clause");
  assert(can("id=eq.x", undefined, undefined), "no policy at all");
  assert(!can("id=eq.x", undefined, { mode: "owned", owner: "user_id" }), "owned cannot admit an unconfirmed row");
  assert(!can("id=eq.x", undefined, { mode: "owned", owner: "user_id", shared: { via: "share", on: "note_id", user: "user_id" } }), "a share needs a subquery");
  assert(!can("id=eq.x", undefined, { mode: "through", parent: "note", on: "note_id" }), "a parent chain needs a subquery");
  assert(!can("id=eq.x", undefined, { mode: "service-only" }), "service-only is never readable here");
});

// PostgREST names a flat embed two ways, and the aliased one is what an app
// writes whenever the relation is not named for its table — `author` on a row
// whose foreign key is author_id. Reading only the unaliased form sent every
// such region to the server on every wake.
Deno.test("an embed is parsed with its alias and its table", () => {
  const eq2 = (got, want, what) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`smoke failed: ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };
  eq2(parseSelect("*,label(name)"), [{ alias: "label", table: "label", cols: ["name"] }], "unaliased");
  eq2(
    parseSelect("*,author:app_user(handle,image_url)"),
    [{ alias: "author", table: "app_user", cols: ["handle", "image_url"] }],
    "aliased",
  );
  eq2(
    parseSelect("*,author:app_user(handle),editor:app_user(handle)"),
    [
      { alias: "author", table: "app_user", cols: ["handle"] },
      { alias: "editor", table: "app_user", cols: ["handle"] },
    ],
    "two embeds of one table, which only the aliased form can express",
  );
  eq2(parseSelect("*"), [], "no embeds");
  eq2(parseSelect(undefined), [], "no select at all");
  // A hint or a nested embed is still the server's to compute.
  eq2(parseSelect("*,note_label!inner(label!inner(name))"), null, "hinted and nested");
  // The dependency set is tables, never aliases: a region deaf to app_user
  // would never see a byline change.
  eq2(embedTables("*,author:app_user(handle)"), ["app_user"], "dep set names the table");
});

// A cap is not a predicate. It used to make the whole filter untranslatable,
// which sent the busiest region on every screen — the feed's `limit=20` — to
// PostgREST on every wake.
Deno.test("a row cap is read apart from the predicates", () => {
  const eqj = (got, want, what) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`smoke failed: ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };
  eqj(parseLimit("limit=20"), 20, "alone");
  eqj(parseLimit("author_id=eq.x&limit=5"), 5, "after a predicate");
  eqj(parseLimit("author_id=eq.x"), undefined, "absent");
  eqj(parseLimit(undefined), undefined, "no filter at all");
  // The cap leaves the predicate list, and what remains still translates.
  eqj(parseFilterSpec("limit=20"), [], "a cap on its own is no predicate");
  eqj(parseFilterSpec("author_id=eq.x&limit=5"), [{ col: "author_id", op: "eq", value: "x" }], "and does not disturb one");
  assert(can("limit=20", undefined, { mode: "public-read" }), "a capped read is maintainable");
  // Paging over a set that is still arriving is a different question.
  assert(!can("offset=20&limit=20", undefined, undefined), "offset stays the server's");
  eqj(parseLimit("limit=abc"), undefined, "a non-numeric cap is not a cap");
  assert(!can("limit=abc", undefined, undefined), "and makes the filter untranslatable");
});

// A cursor is what pages a feed — `created_at=lt.{param.when}` — and used to
// make the whole filter untranslatable, so every page turn read through
// PostgREST. The value arrives as a string and the column's type is not
// knowable here, which is exactly what JS's relational operators handle:
// timestamps in the one format a cursor carries compare lexically, and a
// numeric string coerces against a number.
Deno.test("an ordered cursor is translatable", () => {
  const eq3 = (got, want, what) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`smoke failed: ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };
  eq3(parseFilterSpec("created_at=lt.2026-08-02&limit=20"),
      [{ col: "created_at", op: "lt", value: "2026-08-02" }], "cursor beside a cap");
  const older = parseFilter("created_at=lt.2026-08-02");
  assert(older.every((f) => f({ created_at: "2026-08-01" })), "a row before the cursor is in");
  assert(!older.every((f) => f({ created_at: "2026-08-03" })), "a row after it is out");
  const atLeast = parseFilter("rank=gte.3");
  assert(atLeast.every((f) => f({ rank: 3 })), "gte is inclusive, and coerces a numeric string");
  assert(!atLeast.every((f) => f({ rank: 2 })), "below the bound is out");
  // Relevance now works for a paging region too: it used to wake on every
  // write to the table because the filter said nothing.
  assert(touches(older, [insert({ id: "a", created_at: "2026-08-01" })]), "a row it would show wakes it");
  assert(!touches(older, [insert({ id: "b", created_at: "2026-08-03" })]), "a row it never would does not");
  // Still not maintained: the engine has its own comparison semantics and a
  // string against a numeric column is not the same question.
  assert(!can("created_at=lt.2026-08-02", undefined, undefined), "reads client-side, not as a view");
});

// A named read's value — `table?fragment` — splits into exactly the shape a
// region's own read hands the store, or the two could never share a view key.
Deno.test("a read spec splits into the query's own shape", () => {
  const eqr = (got, want, what) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`smoke failed: ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };
  eqr(
    parseReadSpec("round?current=eq.yes&order=created_at.desc"),
    { table: "round", filter: "current=eq.yes", order: "created_at.desc" },
    "filter and order ride apart",
  );
  eqr(
    parseReadSpec("play?round_id=eq.{id}&order=seq.asc"),
    { table: "play", filter: "round_id=eq.{id}", order: "seq.asc" },
    "a placeholder is the filter's business, not this split's",
  );
  eqr(
    parseReadSpec("play?a=eq.1&order=seq.asc&b=eq.2"),
    { table: "play", filter: "a=eq.1&b=eq.2", order: "seq.asc" },
    "filter parts recombine in authored order around the order key",
  );
  eqr(parseReadSpec("round"), { table: "round" }, "a bare table reads whole");
  eqr(parseReadSpec("round?"), { table: "round" }, "an empty fragment is a whole read too");
  let threw = false;
  try {
    parseReadSpec("?current=eq.yes");
  } catch {
    threw = true;
  }
  assert(threw, "a spec naming no table is a program error");
});

// The reuse the named-read grammar exists for: a read some region already
// subscribes is served by that region's maintained view, not re-derived. The
// store's debug seam (__prontoViews) is the witness — the query neither opens
// a second view nor takes the snapshot path past the held one.
Deno.test({
  name: "a read a region already subscribes is served by its maintained view",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const store = await createStore("", { local: { round: "tab" } });
    await store.write("round", [{ key: "r1", row: { current: "yes", created_at: 2 } }]);
    await store.write("round", [{ key: "r2", row: { current: "no", created_at: 1 } }]);
    await store.write("round", [{ key: "r3", row: { current: "yes", created_at: 5 } }]);

    // A query alone never opens a view; only a subscription does.
    const spec = parseReadSpec("round?current=eq.yes&order=created_at.desc");
    const opts = { filter: spec.filter, order: spec.order };
    await store.query(spec.table, spec.order, opts);
    assert(globalThis.__prontoViews.size === 0, "a read alone opened no view");

    const stop = store.subscribe(spec.table, () => {}, opts);
    assert(globalThis.__prontoViews.size === 1, "the subscription opened the view");
    const entry = [...globalThis.__prontoViews.values()][0];

    // Spy through the seam: the same read must come back out of this view.
    const real = entry.view;
    let served = 0;
    entry.view = {
      isReady: () => real.isReady?.() ?? true,
      toArrayWhenReady: () => real.toArrayWhenReady?.(),
      get toArray() {
        served++;
        return real.toArray;
      },
    };
    const rows = await store.query(spec.table, spec.order, opts);
    entry.view = real;
    assert(served === 1, `the held view served the read, served ${served}`);
    assert(
      JSON.stringify(rows.map((r) => r.id)) === JSON.stringify(["r3", "r1"]),
      `filtered and ordered by the engine, got ${JSON.stringify(rows.map((r) => r.id))}`,
    );
    assert(globalThis.__prontoViews.size === 1, "the read joined the view rather than opening one");
    assert(entry.refs === 1, "and holds no reference of its own");

    stop();
    assert(globalThis.__prontoViews.size === 0, "the subscription's release closed the view");
  },
});

// A read of the whole table opens no view: the collection is that set already,
// and a view over it would keep the order by moving array elements — which a
// bulk write paid per row. The region still hears which rows moved.
Deno.test({
  name: "a whole-table read is served by the collection, with its changes attributed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const store = createStore("", { local: { row: "tab" } });
    await store.write("row", [{ key: "a", row: { ord: 2 } }, { key: "b", row: { ord: 1 } }]);
    await new Promise((r) => setTimeout(r, 5));
    const wakes = [];
    const stop = store.subscribe("row", (changes) => wakes.push(changes), { order: "ord.asc" });
    assert(globalThis.__prontoViews.size === 0, "no view for a whole read");
    // A cap is not a whole read: the engine's ordered index is what stops a
    // capped read scanning the table.
    const capped = store.subscribe("row", () => {}, { order: "ord.asc", filter: "limit=1" });
    assert(globalThis.__prontoViews.size === 1, "a capped read keeps its view");
    capped();
    const rows = await store.query("row", "ord.asc", { order: "ord.asc" });
    assert(JSON.stringify(rows.map((r) => r.id)) === JSON.stringify(["b", "a"]), "ordered at read");
    await store.patch("row", [{ key: "a", changes: { ord: 0 } }]);
    await new Promise((r) => setTimeout(r, 5));
    assert(wakes.length === 1, `one wake, got ${wakes.length}`);
    assert(Array.isArray(wakes[0]) && wakes[0].some((c) => String(c.value?.id) === "a"), "the wake names the row");
    stop();
  },
});

// A fold's writes are one conclusion — a drop, then a put, each awaited — and
// they reach the region as one wake with both in it.
Deno.test({
  name: "a fold's several writes wake a region once, with every write in the wake",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const store = createStore("", { local: { row: "tab" } });
    await store.write("row", [{ key: "a", row: { ord: 1 } }]);
    await new Promise((r) => setTimeout(r, 5));
    const wakes = [];
    const stop = store.subscribe("row", (changes) => wakes.push(changes), {});
    await store.drop("row", ["a"]);
    await store.write("row", [{ key: "b", row: { ord: 2 } }, { key: "c", row: { ord: 3 } }]);
    assert(wakes.length === 0, "the wake is a task of its own, after every write of the fold");
    await new Promise((r) => setTimeout(r, 5));
    assert(wakes.length === 1, `one wake for the fold, got ${wakes.length}`);
    const ids = [...new Set(wakes[0].map((c) => String(c.value?.id ?? c.previousValue?.id)))].sort();
    assert(JSON.stringify(ids) === JSON.stringify(["a", "b", "c"]), `every write in it, got ${ids}`);
    stop();
  },
});

// A subscription is told only of keys it has seen. A row written before the
// region subscribed — a seed, a table a screen returns to — must still report
// its delete, or the region keeps drawing a row the store no longer holds.
Deno.test({
  name: "a row older than the subscription still reports its delete",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const store = createStore("", { local: { row: "tab" } });
    await store.write("row", [{ key: "old", row: { ord: 1 } }]);
    await new Promise((r) => setTimeout(r, 5));
    const wakes = [];
    const stop = store.subscribe("row", (changes) => wakes.push(changes), {});
    await new Promise((r) => setTimeout(r, 5));
    assert(wakes.length === 0, "subscribing alone wakes nothing: the standing rows are no burst");
    await store.drop("row", ["old"]);
    await new Promise((r) => setTimeout(r, 5));
    assert(wakes.length === 1, `the delete woke the region, got ${wakes.length}`);
    assert(wakes[0].every((c) => c.type !== "insert"), "nothing of the standing state rides in the wake");
    assert(wakes[0].some((c) => c.type === "delete" && String(c.key) === "old"), "and named the row");
    stop();
  },
});

// A view is shared by every region reading the same filter, and the second
// of them subscribes after the view has its rows. It must still hear one of
// those rows go, or it keeps drawing a row the store no longer holds.
Deno.test({
  name: "a region joining a shared view still hears a standing row's delete",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const store = createStore("", { local: { row: "tab" } });
    await store.write("row", [{ key: "a", row: { kind: "x" } }, { key: "b", row: { kind: "x" } }]);
    const opts = { filter: "kind=eq.x" };
    const first = store.subscribe("row", () => {}, opts);
    await store.query("row", null, opts);
    await new Promise((r) => setTimeout(r, 5));
    const wakes = [];
    const second = store.subscribe("row", (changes) => wakes.push(changes), opts);
    assert(globalThis.__prontoViews.size === 1, "one view between them");
    await store.drop("row", ["a"]);
    await new Promise((r) => setTimeout(r, 5));
    assert(wakes.length === 1, `the late joiner woke, got ${wakes.length}`);
    assert(wakes[0].some((c) => c.type === "delete" && String(c.key) === "a"), "and heard the delete");
    second();
    first();
  },
});

// A wake comes due in a task of its own; a subscription stopped before then
// must not be delivered, or a region torn down in the same task is refreshed
// as if it stood.
Deno.test({
  name: "a wake pending when the subscription stops is not delivered",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const store = createStore("", { local: { row: "tab" } });
    const wakes = [];
    const stop = store.subscribe("row", (changes) => wakes.push(changes), {});
    await store.write("row", [{ key: "a", row: { ord: 1 } }]);
    stop();
    await new Promise((r) => setTimeout(r, 5));
    assert(wakes.length === 0, `no wake after stop, got ${wakes.length}`);
  },
});
