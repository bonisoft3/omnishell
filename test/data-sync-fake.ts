// The fake of interpreter/data-sync.js: the same surface over whole tables in
// memory, which is what an app's screen tests mount. data-sync-parity.test.ts
// drives both with the same writes and holds them to the same rows, wakes and
// refusals.

import { embedDeps, parseFilter, parseLimit } from "../interpreter/fragment.js";
import { upsertKey as resolveKey } from "../interpreter/data-sync.js";
import { batched } from "../interpreter/batched-store.js";
import { seedQuery } from "./seed-query.ts";
import type { Cluster, Row } from "./screen-harness.ts";

/** data-sync.js is the shipped store, not a typed module: the natural key an
 * upsert resolves against comes from there so there is one resolution and not
 * a second. */
const upsertKey = resolveKey as (
  uniques: string[][] | undefined,
  pk: string,
  owner: string | undefined,
  values: Row,
) => string[] | null;

export type Change = { value?: Row; previousValue?: Row };

/** One store contact, in the order it was made. `op` is what the store RESOLVED
 * to and not what the markup declared: an upsert lands here as the create or the
 * update it became, which is the fact about the data rather than about the
 * gesture — a test claiming the gesture asserts on the markup. `row` is the
 * values the caller handed over, the patch for an update and the whole row
 * otherwise, so a write can be asked what it CARRIED and not only that it
 * happened. */
export type Call = { op: string; table: string; id?: string; row?: Row };

export type FakeDataSync = {
  query(table: string, order?: string | null, opts?: Record<string, unknown>): Promise<Row[]>;
  subscribe(table: string, fn: (changes?: Change[]) => void, opts?: Record<string, unknown>): () => void;
  create(table: string, values: Row): Promise<void>;
  upsert(table: string, values: Row): Promise<void>;
  update(table: string, id: unknown, patch: Row): Promise<void>;
  put(table: string, row: Row): Promise<void>;
  // The batch surface the interpreter writes through. A test drives the
  // singular methods above; the interpreter drives these, and `batched` below
  // is what keeps the two describing the same store.
  add(table: string, rows: Row[]): Promise<void>;
  write(table: string, edits: { key: string; row: Row }[]): Promise<void>;
  patch(table: string, edits: { key: string; changes: Row }[]): Promise<void>;
  drop(table: string, keys: string[]): Promise<void>;
  dropWhere(table: string, filter: string): Promise<void>;
  upsertBy(table: string, values: Row): Promise<void>;
  remove(table: string, id: unknown): Promise<void>;
  removeWhere(table: string, filter: string): Promise<void>;
  /** The rows a table holds, as the store holds them. */
  rows(table: string): Row[];
  calls: Call[];
  /** Bumped by every write; the harness's quiet signal. */
  version: number;
  /** Wakes scheduled and not yet delivered. */
  pendingWakes: number;
};

/**
 * An in-memory store over whole tables. Reads go through the fragment
 * grammar's own parsers, so there is one dialect of filters, caps and selects
 * and this is not a second one; a fragment the grammar cannot state throws
 * rather than widening the read.
 *
 * Wakes carry the change set, coalesced on a macrotask, per subscription —
 * which is what the interpreter's delta path reads to decide which rows a
 * refresh has to reconsider.
 */

export function fakeDataSync(tables: Record<string, Row[]>, cluster: Cluster = {}): FakeDataSync {
  const data = new Map<string, Row[]>(
    Object.entries(tables).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]),
  );
  const queryCluster: Cluster = { ...cluster, schema: Object.fromEntries(Object.entries(tables).map(([table, rows]) => [
    table, cluster.schema?.[table] ?? { fields: [...new Set([...rows.flatMap((r) => Object.keys(r)), cluster.keys?.[table] ?? "id"])].map((name) => ({ name, type: "unknown" })) },
  ])) };
  type Sub = { fn: (changes?: Change[]) => void; batch: Change[]; scheduled: boolean; stopped: boolean };
  const subs = new Map<string, Set<Sub>>();
  const minted = new Map<string, number>();
  const mintId = (table: string) => {
    const n = (minted.get(table) ?? 0) + 1;
    minted.set(table, n);
    return `${table}-${n}`;
  };
  const store = {
    calls: [] as Call[],
    version: 0,
    pendingWakes: 0,
  } as FakeDataSync;

  const of = (table: string) => {
    const rows = data.get(table);
    if (rows === undefined) throw new Error(`no table "${table}" in this store`);
    return rows;
  };
  const keyOf = (table: string) => cluster.keys?.[table] ?? "id";
  // The policies the cluster enforces, so a fixture seeded with rows the
  // reader could not fetch does not render here and vanish in a browser.
  const visible = (table: string, row: Row): boolean => {
    const a = cluster.access?.[table];
    if (a === undefined || cluster.me === undefined) return true;
    if (a.scope === "public") return true;
    if (a.scope === "internal") return false;
    if (a.scope === "private") {
      if (row[a.owner as string] === cluster.me) return true;
      if (a.shared === undefined) return false;
      const pk = row[keyOf(table)];
      return (data.get(a.shared.via) ?? []).some(
        (sh) => sh[a.shared!.on] === pk && sh[a.shared!.user] === cluster.me,
      );
    }
    const parent = a.parent as string;
    const p = (data.get(parent) ?? []).find((r) => r[keyOf(parent)] === row[a.on as string]);
    return p !== undefined && visible(parent, p);
  };
  // Comparing the key's string form matches a row whose key is absent to a
  // lookup for nothing, so a keyless row would answer for every id.
  const indexOf = (table: string, rows: Row[], id: unknown) => {
    const key = keyOf(table);
    if (id === undefined) throw new Error(`${table}: a row is addressed by its ${key}, and none was given`);
    return rows.findIndex((r) => {
      if (r[key] === undefined) throw new Error(`${table}: a row carries no ${key}`);
      return String(r[key]) === String(id);
    });
  };

  // A write wakes with the key it settled, named as `id` whatever the table
  // keys on, as the shipped store's settle names it, and with the row's change
  // where the row moved: a write restating a row as it stands changes no row.
  const moved = (change: Change) => change.value === undefined || change.previousValue === undefined ||
    Object.keys(change.value).some((k) => JSON.stringify(change.previousValue![k]) !== JSON.stringify(change.value![k]));
  const note = (table: string, change: Change) => {
    store.version++;
    const settled = { value: { id: (change.value ?? change.previousValue)![keyOf(table)] } };
    for (const sub of subs.get(table) ?? []) {
      if (moved(change)) sub.batch.push(change);
      sub.batch.push(settled);
      if (sub.scheduled) continue;
      sub.scheduled = true;
      store.pendingWakes++;
      setTimeout(() => {
        sub.scheduled = false;
        store.pendingWakes--;
        const changes = sub.batch;
        sub.batch = [];
        // A region torn down before its wake is not woken.
        if (!sub.stopped) sub.fn(changes);
      }, 0);
    }
  };

  store.rows = (table) => of(table);

  store.query = async (table, order, opts = {}) => {
    store.calls.push({ op: "query", table });
    return seedQuery(Object.fromEntries(data), queryCluster, table, {
      filter: opts.filter as string | undefined,
      select: opts.select as string | undefined,
      order: order ?? opts.order as string | undefined,
    }, visible);
  };

  // Per table, not per read: the shipped store maintains a view over the
  // region's own filter and wakes only when that view moves. Waking on the
  // whole table is a superset — the extra pass costs a re-read and the delta
  // set still names the rows that moved — so a region here never misses a
  // wake it would get in the browser.
  store.subscribe = (table, fn, opts = {}) => {
    of(table);
    const sub: Sub = { fn, batch: [], scheduled: false, stopped: false };
    // The shipped store watches the region's embedded tables beside its own,
    // so an edit to a joined row reaches the region that renders it. Row
    // visibility is the part not modelled: every seeded row is readable here.
    const watched = [table, ...embedDeps(opts.select as string | undefined, table, cluster.schema)]
      .filter((t) => data.has(t));
    for (const t of watched) {
      const set = subs.get(t) ?? new Set<Sub>();
      subs.set(t, set);
      set.add(sub);
    }
    return () => {
      sub.stopped = true;
      for (const t of watched) subs.get(t)?.delete(sub);
    };
  };

  store.create = async (table, values) => {
    // The shipped store mints the key when the form does not carry one
    // (data-sync.js: retries are idempotent only because the id travels with
    // every attempt), so a fake that refused would fail writes the browser
    // accepts. Minted from the mount's seeded entropy, not crypto, so a
    // created row's id is the same on every run.
    const given = owned(table, values);
    const key = keyOf(table);
    const row = given?.[key] === undefined ? { [key]: mintId(table), ...given } : given;
    store.calls.push({ op: "create", table, id: String(row[key]), row: { ...row } });
    const rows = of(table);
    if (rows.some((r) => String(r[keyOf(table)]) === String(row[keyOf(table)]))) {
      throw new Error(`create ${table}: ${row[keyOf(table)]} is already there`);
    }
    const value = { ...row };
    rows.push(value);
    note(table, { value });
  };

  // The owner column is DEFAULT auth_uid() and materialises server-side, so a
  // row the reader writes carries it while the values the form submitted do
  // not. A mount that names no reader leaves it to the app's own fixtures.
  const owned = (table: string, values: Row): Row => {
    const filled = { ...cluster.defaults?.[table], ...values };
    const owner = cluster.owners?.[table];
    if (owner === undefined || cluster.me === undefined || filled[owner] !== undefined) return filled;
    return { ...filled, [owner]: cluster.me };
  };

  store.upsert = async (table, values) => {
    const keys = upsertKey(cluster.uniques?.[table], keyOf(table), cluster.owners?.[table], values);
    if (keys === null) {
      throw new Error(`upsert ${table}: no natural key covers ${Object.keys(values).join(",")}`);
    }
    const row = owned(table, values);
    const at = (r: Row, c: string) => String(r[c] ?? "");
    const wanted = keys.map((c) => at(row, c));
    const existing = of(table).find((r) => keys.every((c, i) => at(r, c) === wanted[i]));
    if (existing === undefined) return store.create(table, row);
    return store.update(table, existing[keyOf(table)], row);
  };

  store.update = async (table, id, patch) => {
    store.calls.push({ op: "update", table, id: String(id), row: { ...patch } });
    const rows = of(table);
    const i = indexOf(table, rows, id);
    if (i < 0) throw new Error(`update ${table}: no row ${id}`);
    const previousValue = rows[i];
    const value = { ...previousValue, ...patch };
    rows[i] = value;
    note(table, { value, previousValue });
  };

  store.put = async (table, row) => {
    const key = keyOf(table);
    if (row?.[key] === undefined) throw new Error(`put ${table}: the row carries no ${key}`);
    store.calls.push({ op: "put", table, id: String(row[key]), row: { ...row } });
    const rows = of(table);
    const i = rows.findIndex((r) => String(r[keyOf(table)]) === String(row[keyOf(table)]));
    if (i < 0) {
      // An insert, however it is spelled, is stamped as the server stamps it.
      const value = owned(table, row);
      rows.push(value);
      note(table, { value });
      return;
    }
    // A row states its fields and leaves the rest alone; the key is the
    // caller's own, so the same conclusion reached twice is the same row.
    const previousValue = rows[i];
    const value = { ...previousValue, ...row };
    rows[i] = value;
    note(table, { value, previousValue });
  };

  store.remove = async (table, id) => {
    store.calls.push({ op: "remove", table, id: String(id) });
    const rows = of(table);
    const i = indexOf(table, rows, id);
    if (i < 0) throw new Error(`remove ${table}: no row ${id}`);
    const [previousValue] = rows.splice(i, 1);
    note(table, { previousValue });
  };

  store.removeWhere = async (table, filter) => {
    store.calls.push({ op: "removeWhere", table });
    // A cap on a delete states a row count the server cannot honour, so the
    // shipped store refuses the filter rather than deleting what it matches.
    if (parseLimit(filter) !== undefined) throw new Error(`delete filter carries a limit: ${filter}`);
    const preds = parseFilter(filter);
    if (preds === null) throw new Error(`filter outside the grammar for ${table}: ${filter}`);
    const doomed = of(table).filter((r: Row) => preds.every((p: (row: Row) => boolean) => p(r)));
    for (const row of doomed) await store.remove(table, row[keyOf(table)]);
  };

  // The harness keeps its own upsert and removeWhere: tests drive them
  // directly and they model natural-key resolution the adapter cannot.
  const wrapped = batched(store) as FakeDataSync;
  wrapped.upsertBy = store.upsert;
  wrapped.dropWhere = store.removeWhere;
  // The shipped store hands a batch to its collection as one transaction, so
  // a batch with one row refused writes none of them.
  const has = (table: string, id: unknown) => of(table).some((r) => String(r[keyOf(table)]) === String(id));
  const whole = <A extends unknown[]>(check: (table: string, ...a: A) => void, write: (table: string, ...a: A) => Promise<void>) =>
    (table: string, ...a: A) => {
      check(table, ...a);
      return write(table, ...a);
    };
  wrapped.add = whole((table, rows: Row[]) => {
    const keys = rows.map((r) => String(r[keyOf(table)] ?? ""));
    const twice = keys.find((k, i) => k !== "" && (has(table, k) || keys.indexOf(k) !== i));
    if (twice !== undefined) throw new Error(`add ${table}: ${twice} is already there`);
  }, wrapped.add);
  wrapped.patch = whole((table, edits: { key: string }[]) => {
    const missing = edits.find((e) => !has(table, e.key));
    if (missing !== undefined) throw new Error(`patch ${table}: no row ${missing.key}`);
  }, wrapped.patch);
  // An edit carries its key beside its row, under the column the table keys
  // on, and a batch with an edit naming none writes nothing.
  wrapped.write = whole((table, edits: { key: string; row: Row }[]) => {
    if (edits.some((e) => e?.key === undefined)) throw new Error(`write ${table}: an edit names no ${keyOf(table)}`);
  }, async (table, edits: { key: string; row: Row }[]) => {
    for (const e of edits) await store.put(table, { ...e.row, [keyOf(table)]: e.key });
  });
  wrapped.drop = whole((table, keys: string[]) => {
    const missing = keys.find((k) => !has(table, k));
    if (missing !== undefined) throw new Error(`drop ${table}: no row ${missing}`);
  }, wrapped.drop);
  return wrapped;
}
