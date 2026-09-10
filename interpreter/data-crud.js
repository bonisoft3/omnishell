// Cluster store adapter: the shell as virtual terminal against the real
// virtual cluster, riding mecha's published data plane (vendor/mecha-client):
// one Electric-synced TanStack DB collection per table, and durable offline
// transactions for every mutation — at-least-once end to end, txid-confirmed.
//
// Reads: regions with a translatable filter read the synced collections and
// re-render reactively — including flat FK embeds ("*,label(name)"), joined
// locally so a deleted row evicts the instant its optimistic removal lands
// (a server re-fetch would race the DELETE itself, and in the dev cluster
// every /crud request can queue tens of seconds behind the shape long-polls
// hogging the browser's per-host connection pool). Server-computed reads —
// fts, embed-path filters, hinted/nested embeds — stay ordinary PostgREST
// queries, re-run when any table in their dependency set changes and when
// one of this session's own mutations settles (the collections are the
// change signal, never a clock). Nothing in this file or above it polls.

import {
  BasicIndex,
  BTreeIndex,
  createLiveQueryCollection,
  createMechaClient,
  eq,
  isNull,
  not,
} from "./vendor/mecha-client.js";
import { embedTables, parseFilter, parseFilterSpec, parseLimit, parseSelect } from "./fragment.js";
import { evaluateRole } from "./jessie.js";

export { embedTables, parseFilter, parseFilterSpec, parseLimit, parseSelect };

const HEADERS = { "Content-Type": "application/json" };

/**
 * Runs `fn` in a task of its own, after the current one and everything it
 * queues: a fold's writes — a drop, then a put, each awaited — all land before
 * the region wakes, and a shape commit's several batches wake it once.
 *
 * A message, not a zero-delay timer. The browser clamps a repeated timer to
 * four milliseconds, and a region wakes once per write — so every write past
 * the first few pays the clamp, most of what clearing a thousand rows costs.
 * A posted message is a task with no such floor.
 */
const later = (fn) => {
  // A channel per wake, closed as it fires: an open port is a resource a
  // runtime keeps alive, and a wake owns nothing once it has run.
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    channel.port2.close();
    fn();
  };
  channel.port2.postMessage(null);
};

function token() {
  const session = sessionStorage.getItem("pronto-token");
  return session ? JSON.parse(session).token : null;
}

function userId() {
  const session = sessionStorage.getItem("pronto-token");
  return session ? (JSON.parse(session).user?.id ?? null) : null;
}

async function http(url, init) {
  const headers = { ...init?.headers };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    // Expired/invalid token: re-gate through the login screen. The reload
    // tears the page down, so this promise never settles by design.
    sessionStorage.removeItem("pronto-token");
    location.reload();
    return new Promise(() => {});
  }
  if (!res.ok) throw new Error(`${res.status} ${init?.method ?? "GET"} ${url}`);
  return res;
}

/**
 * Whether a batch of collection changes is this region's input changing.
 *
 * `preds` comes from parseFilter: null means untranslatable, [] means the
 * region reads the whole table. Both sides of an update count — a row leaving
 * the filter changes the region just as much as one entering it — and anything
 * unrecognisable counts, so being unsure costs a re-read rather than a miss.
 */
export function touches(preds, changes) {
  if (preds === null || !Array.isArray(changes)) return true;
  return changes.some((c) =>
    [c.value, c.previousValue].some((row) => row != null && preds.every((p) => p(row))),
  );
}

/**
 * Whether a read can become a view the engine maintains, given its parsed
 * filter, its parsed select, and the table's visibility rule.
 *
 * Every `false` here is a read that already goes to PostgREST or already needs
 * a predicate the query cannot state, so this draws no new boundary. It is
 * kept pure and exported because the interesting failure is silent: a read
 * wrongly called maintainable builds a view whose rows are missing what the
 * region binds, and the region renders blank rather than erroring.
 */
export function isMaintainable(spec, embeds, access, accessOf = () => undefined) {
  // null is "server-computed", never "nothing to do" — for both of these.
  if (spec === null || embeds === null) return false;
  // A boolean the schema defaults is absent on an unconfirmed optimistic row,
  // which the snapshot predicate admits and a column comparison would not.
  if (spec.some((s) => s.op === "true" || s.op === "false")) return false;
  // A cursor reads client-side but is not maintained. The predicate above
  // leans on JS coercion to compare a string value against a column whose
  // type is not knowable here; the engine has its own comparison semantics,
  // and handing it a string for a numeric column is not the same question.
  if (spec.some((s) => s.op === "lt" || s.op === "lte" || s.op === "gt" || s.op === "gte")) return false;
  // A pattern is a predicate the engine's clause vocabulary cannot state, and
  // an unstatable clause would silently widen to "every row" — see `clause`.
  if (spec.some((s) => s.op === "like" || s.op === "ilike")) return false;
  // An embed becomes a left join, and a left join has nowhere to put a
  // per-row visibility test: the snapshot path binds the whole embed null for
  // a row this reader cannot see, and a join would leak its columns instead.
  // So only an embedded table everyone may read can be joined here.
  if (embeds.some((e) => isRestricted(accessOf(e.table)))) return false;
  if (access === undefined) return true;
  // Only a table everyone may read: not even `owned` can admit an unconfirmed
  // optimistic row — see subscribe-smoke.js, "only visibility the query can
  // restate is maintainable".
  return access.mode === "public-read";
}

/** A table not everyone may read. undefined means no policy at all, so anyone may. */
const isRestricted = (a) => a !== undefined && a.mode !== "public-read";

/**
 * Whether a read is the whole table: no predicate, no embed, no cap.
 *
 * Such a read gets no view. The collection already is that set, kept current
 * by the same event stream a view would be fed from, so a view over it would
 * maintain the set twice — and keep its order by moving array elements, which
 * charges a bulk write the length of the table per row (subscribe-smoke.js,
 * "a whole-table read is served by the collection"). Sorting the snapshot at
 * read costs the read once.
 */
function isWhole(spec, embeds, limit) {
  return Array.isArray(spec) && spec.length === 0 &&
    Array.isArray(embeds) && embeds.length === 0 && limit === undefined;
}

function compareBy(order) {
  const keys = (order ?? "").split(",").filter(Boolean).map((k) => {
    const [col, dir] = k.split(".");
    return { col, sign: dir === "desc" ? -1 : 1 };
  });
  return (a, b) => {
    for (const { col, sign } of keys) {
      const x = a[col];
      const y = b[col];
      if (x == null && y == null) continue;
      if (x == null) return sign;
      if (y == null) return -sign;
      if (x < y) return -sign;
      if (x > y) return sign;
    }
    return 0;
  };
}

// Mutations resolve on confirmation OR on durable queueing: the client's
// promise settles only when the write's txid is seen in the shape stream,
// which can lag arbitrarily (offline outbox, a starved long-poll pool) —
// and the screen must not wedge in form-submit meanwhile; the pending
// badge is the feedback. A refusal (4xx → NonRetriableError) normally
// rejects well inside the window; one that loses the race still rolls the
// optimistic row back and re-renders, only its message is lost.
const ACCEPT_MS = 2500;
export function settle(promise, acceptMs = ACCEPT_MS, onRefused) {
  return new Promise((resolve, reject) => {
    let accepted = false;
    const timer = setTimeout(() => {
      accepted = true;
      resolve();
    }, acceptMs);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err) => {
        clearTimeout(timer);
        if (!accepted) {
          reject(err);
          return;
        }
        // A refusal landing after the acceptance window can no longer reject
        // the (already-resolved) submit; the optimistic rollback re-renders
        // the truth, and onRefused carries the words back to the form.
        console.error("late store refusal (optimistic state rolled back):", err);
        onRefused?.(err);
      },
    );
  });
}

/**
 * The natural key an upsert resolves against: the declared composite uniques
 * where the table has any, else the row's own pk — a single-row toggle must
 * not restate its primary key as a unique. An owner column counts as covered
 * (it materialises server-side from the session). null when nothing covers
 * the values, which the caller turns into a program error.
 */
export function upsertKey(uniques, pk, owner, values) {
  const candidates = uniques ?? [[pk]];
  return candidates.find((cols) => cols.every((c) => values[c] !== undefined || c === owner)) ?? null;
}

/**
 * How many OTHER readers a fold sink counts, before this reader's own intent.
 *
 * Pure on purpose: the caller looks the reader's source row and private pair
 * out of the local collections and hands them in, so the rule this file exists
 * to state can be tested without a client, a network or a tier.
 */
const stateOf = (p, r) => (r[p.retracted] == null ? 1 : 0);

// Every input is a synced, persisted collection, so this answers at boot and
// stays answerable offline — there is no branch that waits on the network.
export function othersFor(p, sinkRow, mine, pair) {
  const total = sinkRow[p.projects];
  const acked = mine !== undefined && mine.$synced !== false && mine.txid != null;
  // The public total's read is at or after this exact acknowledged version,
  // so it counted the reader as the row now reads. No pair needed, and this
  // is the one question a watermark answers exactly: two server txids about
  // versions that exist. It is also what keeps a first favourite from
  // spiking — the total starts including the reader before their pair
  // arrives, and without this the reader adds themselves twice.
  if (acked && sinkRow[p.watermark] != null && sinkRow[p.watermark] >= mine.txid) {
    return total - stateOf(p, mine);
  }
  // The read predates the reader's latest change, so the freshest total
  // cannot be paired with anything the reader knows. The pair's own read is
  // internally consistent whatever has happened since: older, never wrong,
  // and never a frozen pixel.
  if (pair !== undefined) return pair[p.pair.total] - pair[p.pair.counted];
  // No pair was ever written, so no read has ever counted this reader.
  return total;
}

export function createStore(base = "", cfg = {}) {
  // cfg.local names the browser-only tiers (shell.yaml `local:`), which are
  // collections like any other here — read by a region, mutated by a form —
  // but built from a local factory rather than an Electric shape, so they are
  // listed apart from the tables the terminal subscribes.
  const local = cfg.local ?? {};
  const tables = [...(cfg.tables ?? []), ...Object.keys(local)];
  const client = createMechaClient({
    // cfg.keys names the pk of every table whose pk is not "id" (pipeline
    // sinks like note_progress key on their subject). Without it the synced
    // collection keys every row on a missing column and the whole table
    // collapses onto one key.
    //
    // cfg.access rides along so the client knows which tables a grant can
    // reach; a note shared to this subject is not in its scopes, and arrives
    // one shape per row instead.
    tables: tables.map((t) => ({
      id: t,
      table: t,
      key: cfg.keys?.[t],
      durability: local[t],
      access: cfg.access?.[t],
    })),
    electricUrl: `${base}/electric`,
    crudUrl: `${base}/crud`,
    authUrl: `${base}/auth`,
    token,
    subject: userId,
  });

  // Debug seam: the running client is inspectable from the console.
  globalThis.__mechaClient = client;

  // cfg.access is the emitted RLS mirror (shell.yaml `access`): collection
  // reads re-apply row visibility, and a region re-renders when a table that
  // decides it changes (accessDeps below). PostgREST reads (embeds, fts) are
  // RLS-scoped server-side.
  const access = cfg.access ?? {};
  const keyOf = (t) => cfg.keys?.[t] ?? "id";

  // Validations by table (shell.yaml); each table's modules load on its first
  // write, through the same compartment a handler runs in.
  const validations = cfg.validations ?? {};
  const predicates = new Map();
  function predicatesFor(table) {
    let p = predicates.get(table);
    if (p === undefined) {
      // Dropped on rejection: a fetch that failed once would otherwise refuse
      // the table for the rest of the session.
      p = Promise.all(Object.entries(validations[table] ?? {}).map(async ([name, v]) => {
        const res = await fetch(new URL(v.src, cfg.appBase));
        if (!res.ok) throw new Error(`validation ${table}.${name}: ${v.src} ${res.status}`);
        return { name, edges: v.edges ?? [], test: await evaluateRole(await res.text(), "validation") };
      })).catch((e) => {
        predicates.delete(table);
        throw e;
      });
      predicates.set(table, p);
    }
    return p;
  }

  // The store seat: every validation of the table judges the row the write
  // would produce, over the reader's own copy of the rows its edges name.
  // The owner column is filled from the session when the produced row omits
  // it — the server defaults it, and a predicate over an absent owner judges
  // nothing. Filled after the merge, so an update never restates the owner of
  // a row this reader does not own.
  // `current` is the standing row, when the caller already holds it: finding it
  // again is a scan of the table per row.
  // `edgeIndex` is one write's shared bucketing of each edge's visible rows by
  // the column it joins on, so a batch costs one pass over an edge table rather
  // than one per row. It is keyed by table AND join column: two validations of
  // one entity may walk to one table on different columns.
  async function validate(table, type, row, current, edgeIndex) {
    const list = await predicatesFor(table);
    if (list.length === 0) return;
    const collection = client.collections[table];
    if (collection === undefined) throw new Error(`validation on unsynced table: ${table}`);
    if (!collection.isReady()) await collection.toArrayWhenReady();
    const key = keyOf(table);
    const held = type !== "update"
      ? undefined
      : current ?? collection.toArray.find((r) => String(r[key]) === String(row[key]));
    // An update states the fields that change, so judging it without the row
    // it changes would judge a fragment as if it were the whole row.
    if (type === "update" && held === undefined) {
      throw new Error(`validation ${table}: update of a row the store does not hold: ${String(row[key])}`);
    }
    const items = held === undefined ? [] : [held];
    let produced = held === undefined ? row : { ...held, ...row };
    const owner = access[table]?.owner;
    if (owner !== undefined && produced[owner] === undefined) {
      produced = { ...produced, [owner]: userId() };
    }
    const event = { type, row: produced };
    for (const v of list) {
      const rows = {};
      for (const edge of v.edges) {
        await ensurePrepared(edge.table);
        const c = client.collections[edge.table];
        if (c === undefined) throw new Error(`validation ${table}.${v.name}: reads unsynced table ${edge.table}`);
        if (!c.isReady()) await c.toArrayWhenReady();
        const want = String(event.row[edge.from]);
        const at = `${edge.table} ${edge.key}`;
        let index = edgeIndex.get(at);
        if (index === undefined) {
          index = new Map();
          for (const r of c.toArray) {
            if (!visible(edge.table, r)) continue;
            const k = String(r[edge.key]);
            const bucket = index.get(k);
            if (bucket === undefined) index.set(k, [r]);
            else bucket.push(r);
          }
          edgeIndex.set(at, index);
        }
        rows[edge.table] = index.get(want) ?? [];
      }
      const verdict = v.test({ items, rows }, event);
      if (verdict === true) continue;
      if (verdict !== false) {
        throw new Error(`validation ${table}.${v.name}: the predicate answered ${typeof verdict}`);
      }
      const err = new Error(`validation ${table}.${v.name}`);
      err.name = "NonRetriableError";
      err.validation = v.name;
      throw err;
    }
  }

  // A local collection is made ready for use once per boot, before the first
  // read or write touches it: its bootstrap rows are written, then its
  // declared uniques are reconciled over everything the collection holds —
  // seeded rows included, so a seed that collides with a natural key is
  // caught by the same pass that catches any other collision rather than
  // being trusted because the program wrote it.
  //
  // Server tiers never arrive here: Postgres owns their uniques, and their
  // bootstrap rows are 900_seed.sql.
  const preparedAt = new Map();
  const ensurePrepared = (table) => {
    if (local[table] === undefined) return Promise.resolve();
    let p = preparedAt.get(table);
    if (p === undefined) {
      p = prepare(table);
      preparedAt.set(table, p);
    }
    return p;
  };
  async function prepare(table) {
    await seed(table);
    await reconcile(table);
  }

  // Written straight through the client, not through create(): a seed is the
  // program stating the collection's initial world, not a reader's gesture, so
  // there is no refusal to settle and no key to mint — the program names each
  // row's own. Called only where the store is built, which is what makes the
  // empty collection the whole ledger #Entity.seed relies on.
  async function seed(table) {
    const rows = cfg.seed?.[table];
    if (rows === undefined) return;
    const c = client.collections[table];
    if (c === undefined) throw new Error(`seed on unknown table: ${table}`);
    if (!c.isReady()) await c.toArrayWhenReady();
    const key = keyOf(table);
    for (const row of rows) {
      if (row[key] === undefined) throw new Error(`seed ${table}: a row carries no ${key}`);
    }
    await client.insert(table, rows);
  }

  // Browser-tier rows outlive the invariants declared over them: a device
  // collection may hold rows written before a unique existed, and a slot
  // meeting them would die on data no one can repair from the screen. So a
  // local collection's declared uniques — cfg.uniques and the partial ones
  // shell.yaml carries as cfg.partialUniques {table: [{cols, where}]} — are
  // reconciled: within each unique's domain the newest row per key wins
  // (created_at when the rows carry it, else load order) and the rest are
  // dropped with one warning. Dropped, not repaired: the terminal cannot mint
  // domain values to move a loser out of the where-domain. The slot
  // cardinality error guards what appears after boot.
  async function reconcile(table) {
    const c = client.collections[table];
    if (c === undefined) return;
    if (!c.isReady()) await c.toArrayWhenReady();
    const declared = [
      ...(cfg.uniques?.[table] ?? []).map((cols) => ({ cols })),
      ...(cfg.partialUniques?.[table] ?? []),
    ];
    for (const u of declared) {
      // A where outside the translatable subset never ships: derive vets it.
      const preds = u.where === undefined ? [] : (parseFilter(u.where) ?? []);
      const groups = new Map();
      for (const r of c.toArray) {
        if (!preds.every((p) => p(r))) continue;
        const g = u.cols.map((col) => String(r[col] ?? "")).join("\u0000");
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(r);
      }
      let dropped = 0;
      for (const rows of groups.values()) {
        if (rows.length < 2) continue;
        const newestLast = [...rows].sort((a, b) =>
          String(a.created_at ?? "") < String(b.created_at ?? "") ? -1 : String(a.created_at ?? "") > String(b.created_at ?? "") ? 1 : 0
        );
        for (const loser of newestLast.slice(0, -1)) {
          await client.remove(table, [loser[keyOf(table)]]);
          dropped++;
        }
      }
      if (dropped > 0) {
        console.warn(
          `mecha: ${table}: ${dropped} surviving row(s) violated unique (${u.cols.join(", ")})` +
            (u.where === undefined ? "" : ` where ${u.where}`) + "; kept the newest, dropped the rest",
        );
      }
    }
  }
  function visible(table, row) {
    const a = access[table];
    if (!a) return true;
    // Optimistic rows are this session's own writes; their DB-defaulted
    // owner column has not materialized yet.
    if (row.$synced === false) return true;
    if (a.mode === "public-read") return true;
    if (a.mode === "service-only") return false;
    const uid = userId();
    if (a.mode === "owned") {
      if (row[a.owner] === uid) return true;
      if (a.shared) {
        const via = client.collections[a.shared.via];
        const pk = row[keyOf(table)];
        return (
          via !== undefined &&
          via.toArray.some((s) => s[a.shared.on] === pk && s[a.shared.user] === uid)
        );
      }
      return false;
    }
    // through: visible exactly when the parent row is (a vanished parent
    // hides the child, matching the policy's EXISTS).
    const parent = client.collections[a.parent];
    const p = parent?.get(row[a.on]);
    return p !== undefined && visible(a.parent, p);
  }

  // Tables whose changes can flip a row's visibility (the share table of an
  // owned mode, the parent chain of a through mode): regions must re-render
  // when they change — an unshare must revoke the row from the open wall.
  function accessDeps(table, out = new Set()) {
    const a = access[table];
    if (!a) return out;
    if (a.mode === "owned" && a.shared) out.add(a.shared.via);
    if (a.mode === "through" && !out.has(a.parent)) {
      out.add(a.parent);
      accessDeps(a.parent, out);
    }
    return out;
  }

  // A region's read as a view the engine maintains, rather than a snapshot it
  // re-derives on every wake. The differential-dataflow engine ships inside
  // the client bundle; this is the door into it.
  //
  // Not every read qualifies; isMaintainable holds the disqualifiers, all of
  // them reads that already go to PostgREST, so this draws no new boundary.
  const views = new Map();
  const indexed = new Set();
  // createIndex refuses to choose a type, and the two questions want different
  // ones: equality for a join's key, ordered for an orderBy the engine should
  // be able to stop scanning early.
  const ensureIndex = (table, column, indexType) => {
    const at = `${table}|${column}`;
    if (indexed.has(at)) return;
    indexed.add(at);
    client.collections[table].createIndex((r) => r[column], { indexType });
  };
  // Debug seam, like the client above: which reads entered the graph, and
  // which fell to the snapshot path, is the first question when a region
  // re-renders more than it should.
  globalThis.__prontoViews = views;
  function maintainedView(table, opts = {}, create = false) {
    const order = opts.order;
    const collection = client.collections[table];
    if (collection === undefined) return null;
    const spec = parseFilterSpec(opts.filter);
    const a = access[table];
    const embeds = parseSelect(opts.select);
    if (!isMaintainable(spec, embeds, a, (t) => access[t])) return null;
    if (isWhole(spec, embeds, parseLimit(opts.filter))) return null;
    if (embeds !== null && embeds.some((e) => client.collections[e.table] === undefined)) return null;
    // Views are keyed by the read they stand for, so the many nested regions
    // that share one — every row's comment probe on a screen — enter the graph
    // once between them.
    const key = `${table}|${order ?? ""}|${opts.filter ?? ""}|${opts.select ?? ""}`;
    const held = views.get(key);
    if (held !== undefined) {
      if (create) held.refs += 1;
      return held;
    }
    // Only a subscription opens a view; a read joins one already open, so a
    // server-computed region cannot leave a view behind it never closes.
    if (!create) return null;
    const clause = (row, { col, op, value }) =>
      op === "eq"
        ? eq(row[col], value)
        : op === "neq"
          ? not(eq(row[col], value))
          : op === "null"
            ? isNull(row[col])
            : not(isNull(row[col]));
    // Without an index on the joined side's key the engine says so and loads
    // the whole collection per join. Created before the query is built, never
    // inside its builder: mutating a collection while its query is compiling
    // leaves the view unready and the screen never leaves `loading`. And
    // created here rather than where the collection is, because that would
    // make the client a subscriber and sync is meant to begin only when a
    // region actually reads.
    for (const e of embeds) ensureIndex(e.table, keyOf(e.table), BasicIndex);
    // An ordered read with a cap can stop early, but only over a sorted index;
    // without one the engine says so and loads the whole collection to sort it.
    if (parseLimit(opts.filter) !== undefined) {
      for (const k of (order ?? "").split(",").filter(Boolean)) {
        ensureIndex(table, k.split(".")[0], BTreeIndex);
      }
    }
    const view = createLiveQueryCollection({
      query: (q) => {
        let built = q.from({ row: collection });
        for (const s of spec) built = built.where(({ row }) => clause(row, s));

        for (const k of (order ?? "").split(",").filter(Boolean)) {
          const [col, dir] = k.split(".");
          built = built.orderBy(({ row }) => row[col], dir === "desc" ? "desc" : "asc");
        }
        const limit = parseLimit(opts.filter);
        if (limit !== undefined) built = built.limit(limit);
        if (embeds.length === 0) return built;
        // A flat FK embed is a left join on `<alias>_id`, and left is what
        // makes an unmatched row bind blank instead of vanishing — the same
        // thing the snapshot path means by a null embed.
        for (const e of embeds) {
          built = built.join(
            { [e.alias]: client.collections[e.table] },
            (refs) => eq(refs.row[`${e.alias}_id`], refs[e.alias][keyOf(e.table)]),
            "left",
          );
        }
        // The row the region binds: every base column, plus each embed under
        // the name it is addressed by.
        return built.select((refs) => {
          const out = { ...refs.row };
          for (const e of embeds) {
            out[e.alias] = Object.fromEntries(e.cols.map((col) => [col, refs[e.alias][col]]));
          }
          return out;
        });
      },
    });
    const entry = {
      view,
      refs: 1,
      release() {
        entry.refs -= 1;
        if (entry.refs > 0) return;
        views.delete(key);
        view.cleanup?.();
      },
    };
    views.set(key, entry);
    return entry;
  }

  const crud = (table) => `${base}/crud/${table}`;
  const search = (order, opts = {}) => {
    const parts = [`select=${opts.select ?? "*"}`];
    if (order) parts.push(`order=${order}`);
    if (opts.filter) parts.push(opts.filter);
    return parts.join("&");
  };

  // Pipeline sinks lag their source by the whole CDC loop, so a count read
  // straight from the sink is a second old. A fold sink is not opaque though:
  // its row IS the accumulator, so the reader can resume the fold over the
  // rows the sink has not seen yet and show the total now.
  //
  //   shown = result(combine(sink, fold of this session's uncounted rows))
  //
  // Both sides come from the local collections — never a server read. The
  // identical rule failed as a region filter precisely because relational
  // operators are not maintainable there, so the gate hit PostgREST while the
  // value came from Electric and the number visibly dipped between them.
  const foldSinks = new Map(
    (cfg.pipelines ?? []).filter((p) => p.fold).map((p) => [p.to, p]),
  );
  // A derived count, as the reader should see it:
  //
  //     shown = others + intent
  //
  // `others` is how many OTHER people have favourited, and no write of this
  // reader's can change it — which is the whole reason nothing here has to be
  // held, waited for, or reconciled. `intent` is local fact, so it applies the
  // instant it is expressed, online or off.
  //
  // The earlier shape of this was `total − mine_counted + intent`, with
  // `mine_counted` inferred from the reader's own row. That cannot work: it is
  // a property of the READ that produced the total, not of the data now, and a
  // bounded row cannot carry unbounded history. Every rule tried here failed at
  // some number of changes. So the pipeline states it instead, per reader, in a
  // table RLS keeps private.
  async function project(table, rows) {
    const p = foldSinks.get(table);
    if (p === undefined || rows.length === 0 || p.pair === undefined) return rows;
    const source = client.collections[p.from];
    if (source === undefined) return rows;
    const pairs = client.collections[p.pair.table];
    return rows.map((sinkRow) => {
      const k = sinkRow[p.key];
      // One row per natural key: the unique index says the reader holds at
      // most one, and the newest wins.
      let mine;
      for (const r of source.toArray) {
        if (r[p.key] !== k || !visible(p.from, r)) continue;
        if (mine === undefined || (mine.txid ?? Infinity) < (r.txid ?? Infinity)) mine = r;
      }
      const pair = pairs?.toArray.find(
        (r) => visible(p.pair.table, r) && String(r[p.key]) === String(k),
      );
      const intent = mine === undefined ? 0 : stateOf(p, mine);
      // The projected column is the one the fold DECLARES; the interpreter is
      // generic and must never name an app's column.
      return { ...sinkRow, [p.projects]: othersFor(p, sinkRow, mine, pair) + intent };
    });
  }

  const query = async (table, order, opts = {}) =>
    project(table, await read(table, order, opts));

  async function read(table, order, opts = {}) {
    await ensurePrepared(table);
    // A read the engine already maintains needs no re-derivation: the view is
    // the filter and the order, kept current by the deltas that woke us.
    const held = maintainedView(table, opts);
    if (held !== null) {
      if (!held.view.isReady?.()) await held.view.toArrayWhenReady?.();
      return held.view.toArray;
    }
    const preds = parseFilter(opts.filter);
    const embeds = preds !== null ? parseSelect(opts.select) : null;
    const c =
      embeds !== null && embeds.every((e) => client.collections[e.table] !== undefined)
        ? client.collections[table]
        : undefined;
    if (c !== undefined) {
      // First read awaits the initial shape snapshot — an unsynced collection
      // is empty, not authoritative, and must never render as "empty state".
      // After that, read the live snapshot synchronously: it includes the
      // optimistic overlay, and it must keep rendering while the stream is
      // down (an outage would otherwise freeze every region).
      if (!c.isReady()) await c.toArrayWhenReady();
      for (const { table } of embeds) {
        const ec = client.collections[table];
        if (!ec.isReady()) await ec.toArrayWhenReady();
      }
      // The FK column is a convention, not a schema fact the client holds:
      // probe it on a synced row (synced rows carry every column) and leave
      // an unresolvable embed to the server.
      // Enumerated once: every row is enriched on the way out, and a table's
      // length is what that costs.
      const all = c.toArray;
      const probe = all.find((r) => r.$synced !== false);
      if (probe === undefined || embeds.every(({ alias }) => probe[`${alias}_id`] !== undefined)) {
        // The snapshot is a fresh array, so it is sorted in place, and copied
        // only where a predicate, a cap or an embed makes a different one.
        const rows = access[table] === undefined && preds.length === 0
          ? all
          : all.filter((r) => visible(table, r) && preds.every((p) => p(r)));
        if (order) rows.sort(compareBy(order));
        const limit = parseLimit(opts.filter);
        const capped = limit === undefined ? rows : rows.slice(0, limit);
        if (embeds.length === 0) return capped;
        return capped.map((row) => {
          const out = { ...row };
          for (const { alias, table: rel, cols } of embeds) {
            // A collection is keyed by the same column keyOf names, so the
            // joined row is one lookup; a scan of the related table per row
            // is the product of the two tables per read.
            const target = client.collections[rel].get(row[`${alias}_id`]);
            // null embed mirrors PostgREST under RLS: a joined row this
            // reader cannot see binds blank, never leaks.
            out[alias] =
              target !== undefined && visible(rel, target)
                ? Object.fromEntries(cols.map((col) => [col, target[col]]))
                : null;
          }
          return out;
        });
      }
    }
    // Server-computed read: fts, embed-path filter, or untranslatable
    // select/filter.
    return (await http(`${crud(table)}?${search(order, opts)}`)).json();
  }

  // Server-computed regions have one blind spot the collections cannot
  // cover: a re-fetch triggered by this session's own optimistic write races
  // the write's HTTP, and once the write confirms the collection state shows
  // no further diff (the optimistic overlay already matched), so no change
  // event follows — the region would keep the raced, pre-write result until
  // navigation. Settlement of an own mutation is therefore its own signal.
  const settleListeners = new Map();
  function notifySettled(table, keys) {
    for (const fn of settleListeners.get(table) ?? []) fn(keys);
  }
  function onSettled(promise, table, keys) {
    promise.then(
      () => notifySettled(table, keys),
      // A refusal rolls the optimistic state back, which re-renders through
      // the collections on its own.
      () => {},
    );
    return promise;
  }

  // A fold sink's shown value depends on the source rows the sink has not
  // folded in yet, so its region has to wake on the source too — the sink row
  // itself does not move when this session favourites something.
  const foldSourceOf = (table) => {
    const p = foldSinks.get(table);
    // The reader's private pair is an input to the shown value exactly as the
    // source rows are: when it lands, `others` changes.
    return p === undefined ? [] : [p.from, p.pair?.table].filter(Boolean);
  };

  /**
   * A collection's changes, every one of them. Left to its default, a
   * subscription hears only about keys it has been told of: a row already in
   * the collection when the subscription opens is not, so its later delete is
   * never delivered, and a region reading a seeded or resumed table keeps
   * drawing a row the store no longer holds. `includeInitialState: false`,
   * stated rather than left unset, is the engine's "every key is seen": no
   * filtering, no snapshot walked, no key set kept per subscription.
   */
  function watch(collection, fn) {
    return stopper(collection.subscribeChanges(fn, { includeInitialState: false }));
  }
  /** An engine subscription handle, either shape, as a plain stop. */
  const stopper = (sub) => (typeof sub === "function" ? sub : () => sub.unsubscribe());

  /**
   * One wake per burst, carrying what the burst named.
   *
   * Changes are accumulated across the window, because a shape commit arrives
   * as several batches and the region is woken once for all of them. The
   * wake carries the rows they named; a cause with no rows — a change set the
   * read cannot attribute, a settle on another table — widens it to
   * everything, which asks the region to reconsider every row rather than
   * pretend nothing moved. A wake that named nothing is not delivered, and
   * neither is one that comes due after the subscription stopped: a region
   * torn down in the same task would otherwise be refreshed as if it stood,
   * re-hydrating nested regions nothing will ever stop.
   */
  function coalesce(fn) {
    let scheduled = false;
    let stopped = false;
    let batch = [];
    let unattributed = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      later(() => {
        scheduled = false;
        if (stopped || (batch.length === 0 && !unattributed)) return;
        const changes = unattributed ? undefined : batch;
        batch = [];
        unattributed = false;
        fn(changes);
      });
    };
    return {
      /** These rows moved. */
      named: (changes) => {
        for (const c of changes) batch.push(c);
        schedule();
      },
      /** Something moved, and which rows is not known. */
      widened: () => {
        unattributed = true;
        schedule();
      },
      /** A write of this table settled, naming the keys it wrote. */
      settled: (keys) => {
        if (keys === undefined) unattributed = true;
        else for (const id of keys) batch.push({ value: { id } });
        schedule();
      },
      stop: () => {
        stopped = true;
      },
    };
  }

  function subscribe(table, fn, opts = {}) {
    const wakes = coalesce(fn);
    // A maintained view's own changes ARE this region's input changing —
    // computed by the engine against the actual query rather than guessed
    // from a predicate over one table's raw change set. Nothing else needs
    // watching: a row leaving the filter, a row entering it, and a row moving
    // in the order all arrive here and nowhere else.
    const view = maintainedView(table, opts, true);
    if (view !== null) {
      // Through watch, for the same reason a raw collection is: a region
      // joining a view another already holds subscribes after the view has
      // its rows, and would otherwise never hear one of them go.
      const stop = watch(view.view, (changes) => {
        if (Array.isArray(changes)) wakes.named(changes);
        else wakes.widened();
      });
      // The engine maintains the view over the sink alone; the projection is
      // applied after it, so the source's changes have to arrive separately.
      const sourceStops = foldSourceOf(table)
        .filter((t) => client.collections[t] !== undefined)
        .map((t) => watch(client.collections[t], wakes.widened));
      settleListeners.set(table, (settleListeners.get(table) ?? new Set()).add(wakes.settled));
      return () => {
        wakes.stop();
        stop();
        for (const s of sourceStops) s();
        settleListeners.get(table).delete(wakes.settled);
        view.release();
      };
    }
    const deps = [
      table,
      ...embedTables(opts.select),
      ...accessDeps(table),
      ...foldSourceOf(table),
    ].filter(
      (t) => client.collections[t] !== undefined,
    );
    // The region's own filter as predicates. A change to a row this region
    // could never show is not this region's input changing, so it must not
    // cost a re-read: without this every comment written anywhere re-queries
    // every comment region on the page.
    const preds = parseFilter(opts.filter);
    // Whether a change to this table names exactly the rows whose rendering it
    // can move. That holds when the read is decided here — predicates the
    // client evaluates, nothing joined — so a row the change did not name is
    // rendered from a value nothing touched. A server-computed read can move a
    // row a write never named (a trigger, a computed column), so it keeps
    // asking for everything to be reconsidered.
    const embeds = parseSelect(opts.select);
    const attributable = preds !== null && Array.isArray(embeds) && embeds.length === 0;
    // Anything the read cannot reason about — another dependency's table, an
    // untranslatable filter — is unconditionally the region's input changing.
    // Being unsure costs a re-read, never a miss.
    const wakeMatching = (changes) => {
      if (!touches(preds, changes)) return;
      if (attributable && Array.isArray(changes)) wakes.named(changes);
      else wakes.widened();
    };
    const settle = attributable ? wakes.settled : wakes.widened;
    const stops = deps.map((t) =>
      watch(client.collections[t], t === table && preds !== null ? wakeMatching : wakes.widened)
    );
    for (const t of deps) {
      settleListeners.set(t, (settleListeners.get(t) ?? new Set()).add(t === table ? settle : wakes.widened));
    }
    return () => {
      wakes.stop();
      for (const stop of stops) stop();
      for (const t of deps) settleListeners.get(t).delete(t === table ? settle : wakes.widened);
    };
  }

  /* Every mutation below takes a batch, because the collection does its work
   * per CALL and not per row: it maintains the live queries each region reads
   * a table through, and that is what a write costs. A caller with a hundred
   * rows that writes them one at a time pays for the whole table a hundred
   * times, which is how building one becomes quadratic in its own size. There
   * is no singular form here, so there is none to reach for. */

  /** Rows stated by their own keys — inserted where absent, patched where
   * present. The caller derived each key from what its row identifies, so the
   * same row written twice is the same row, and fields a row does not name are
   * left alone: it states a row, it does not replace one. */
  // Each edit is {key, row}: the key beside the row it identifies, the way
  // patch and drop already take theirs. The row need not repeat it, and the key
  // wins where it does — a caller states identity in one place.
  async function write(table, edits, onRefused) {
    if (edits.length === 0) return;
    await ensurePrepared(table);
    const key = keyOf(table);
    const rows = edits.map((e) => {
      if (e?.key === undefined) throw new Error(`write ${table}: an edit names no ${key}`);
      return { ...e.row, [key]: e.key };
    });
    const collection = client.collections[table];
    if (collection === undefined) throw new Error(`write on unsynced table: ${table}`);
    if (!collection.isReady()) await collection.toArrayWhenReady();
    // Asked once for the batch. Asked per row it is a scan of the table per
    // row, which is the quadratic term this whole shape exists to remove — and
    // the standing row itself, so the judge below does not scan for it either.
    // Stringified for the lookup and kept in its own type for the write: a key
    // the collection holds as a number is still that number when patched.
    const byKey = new Map(collection.toArray.map((r) => [String(r[key]), r]));
    const edgeIndex = new Map();
    for (const row of rows) {
      const have = byKey.get(String(row[key]));
      if (have === undefined) await validate(table, "insert", row, undefined, edgeIndex);
      else await validate(table, "update", row, have, edgeIndex);
    }
    // Judging awaits, so the collection may have moved under the snapshot the
    // verdicts were read from; the partition the client calls carry is the one
    // that stands now, or an insert would be aimed at a row that has arrived.
    const now = new Map(collection.toArray.map((r) => [String(r[key]), r]));
    const fresh = [];
    const standing = [];
    for (const row of rows) {
      const have = now.get(String(row[key]));
      if (have === undefined) fresh.push(row);
      else standing.push({ key: have[key], changes: row });
    }
    await Promise.all([
      fresh.length === 0 ? undefined : settle(
        onSettled(client.insert(table, fresh), table, fresh.map((r) => String(r[key]))),
        ACCEPT_MS,
        onRefused,
      ),
      standing.length === 0 ? undefined : settle(
        onSettled(client.update(table, standing), table, standing.map((e) => String(e.key))),
        ACCEPT_MS,
        onRefused,
      ),
    ].filter(Boolean));
  }

  /** Rows asserted to be new. A form's create says so, and saying so is what
   * makes a duplicate a refusal the reader can be told about rather than a
   * silent patch of somebody else's row. */
  async function add(table, rows, onRefused) {
    if (rows.length === 0) return;
    await ensurePrepared(table);
    const key = keyOf(table);
    const edgeIndex = new Map();
    for (const row of rows) await validate(table, "insert", row, undefined, edgeIndex);
    await settle(
      onSettled(client.insert(table, rows), table, rows.map((r) => String(r[key]))),
      ACCEPT_MS,
      onRefused,
    );
  }

  /** Named fields of rows that are already there. */
  async function patch(table, edits, onRefused) {
    if (edits.length === 0) return;
    await ensurePrepared(table);
    const key = keyOf(table);
    // The key last: a `changes` naming the key cannot redirect the judgement
    // onto a row other than the one this edit identifies.
    const edgeIndex = new Map();
    for (const e of edits) await validate(table, "update", { ...e.changes, [key]: e.key }, undefined, edgeIndex);
    await settle(
      onSettled(client.update(table, edits), table, edits.map((e) => String(e.key))),
      ACCEPT_MS,
      onRefused,
    );
  }

  // Write the row for a natural key, whether or not it exists yet.
  //
  // The decision is local and stays local: the collection holds every row this
  // reader may see, so "does my row exist" is a lookup rather than a round
  // trip, and the write leaves as an insert or an update accordingly. The
  // gateway injects resolution=ignore-duplicates on POST, so a create aimed at
  // a row that already exists would be swallowed in silence — which is exactly
  // what this resolves before anything reaches the wire.
  //
  // The owner column is filled from the session when the form omits it: it is
  // DEFAULT auth_uid() and materialises server-side, so the reader's own rows
  // carry it while the row they are about to write does not.
  async function upsertBy(table, values, onRefused) {
    await ensurePrepared(table);
    const owner = access[table]?.owner;
    const keys = upsertKey(cfg.uniques?.[table], keyOf(table), owner, values);
    if (keys === null) {
      throw new Error(`upsert ${table}: no natural key covers ${Object.keys(values).join(",")}`);
    }
    const collection = client.collections[table];
    if (collection === undefined) throw new Error(`upsert on unsynced table: ${table}`);
    if (!collection.isReady()) await collection.toArrayWhenReady();
    const at = (r, c) => String(r[c] ?? (c === owner ? userId() : ""));
    const wanted = keys.map((c) => at(values, c));
    const existing = collection.toArray.find(
      (r) => visible(table, r) && keys.every((c, i) => at(r, c) === wanted[i]),
    );
    if (existing === undefined) {
      // The key the row will be found by next time, minted here because the
      // natural key is not the primary one and nothing else will supply it.
      const id = crypto.randomUUID();
      return write(table, [{ key: id, row: { [keyOf(table)]: id, ...values } }], onRefused);
    }
    return patch(table, [{ key: existing[keyOf(table)], changes: values }], onRefused);
  }

  async function drop(table, keys, onRefused) {
    if (keys.length === 0) return;
    await settle(
      onSettled(client.remove(table, keys), table, keys.map((k) => String(k))),
      ACCEPT_MS,
      onRefused,
    );
  }

  // Filter-scoped bulk delete (SPEC #Form.filter): resolve the matching keys,
  // then one durable per-row delete each — at-least-once row by row.
  //
  // The keys come from the local collection whenever the filter translates,
  // and that is a correctness requirement, not an optimisation. Resolving them
  // server-side returns rows the server still holds — including one whose
  // optimistic delete has already been applied here — and deleting a key the
  // collection no longer has throws, rolls the mutation back and aborts its
  // own DELETE in flight. A reader toggling quickly then gets a refusal on
  // every subsequent click while other sessions are unaffected. The collection
  // holds every row this reader may see (the shape is the whole table), so it
  // is the same set, read from the tier that owns the optimistic state.
  async function dropWhere(table, filter, onRefused) {
    // A limit is a cap the parser reads apart from the predicates, and a
    // DELETE has no ordering to cap against — honoring the rest of the filter
    // would silently widen the deletion's scope.
    if (parseLimit(filter) !== undefined) throw new Error(`delete filter carries a limit: ${filter}`);
    await ensurePrepared(table);
    const preds = parseFilter(filter);
    const collection = client.collections[table];
    // A precondition, not a branch: resolving these keys anywhere but the
    // collection reintroduces the divergence this comment block describes, so
    // an untranslatable delete filter is a program error rather than a quieter
    // path that works until it doesn't.
    if (preds === null) throw new Error(`delete filter is not translatable: ${filter}`);
    if (collection === undefined) throw new Error(`delete on unsynced table: ${table}`);
    if (!collection.isReady()) await collection.toArrayWhenReady();
    const rows = collection.toArray.filter((r) => visible(table, r) && preds.every((f) => f(r)));
    // Re-check presence at the moment of the delete: resolution and mutation
    // are separated by an await, and a concurrent settle can retire a row in
    // between.
    const keys = rows
      .map((r) => r[keyOf(table)])
      .filter((k) => collection === undefined || collection.has?.(k) !== false);
    await drop(table, keys, onRefused);
  }

  return { query, add, write, patch, drop, dropWhere, upsertBy, subscribe };
}
