// A whole emitted screen, mounted the way the terminal mounts it: the app's
// own markup and Jessie read off disk, a store that answers the fragment
// grammar the shipped one answers, and a clock the test steps.
//
// screen.js reads its clock and its seed from location.search once, at module
// evaluation, so this module owns that import: it sets location and only then
// loads the interpreter. A test file that also imports screen.js statically
// has already frozen those knobs, and mountScreen says so rather than racing
// real beats.
//
// Nothing here knows an app. The app dir is an argument, and what a screen
// means is the caller's.

import { parseHTML } from "npm:linkedom@0.18.4";
import { load as parseYaml } from "../interpreter/vendor/js-yaml.js";
import { embedTables, parseFilter, parseLimit, parseSelect } from "../interpreter/fragment.js";
import { upsertKey as resolveKey } from "../interpreter/data-crud.js";
import { batched } from "../interpreter/batched-store.js";

/** data-crud.js is the shipped store, not a typed module: the natural key an
 * upsert resolves against comes from there so there is one resolution and not
 * a second. */
const upsertKey = resolveKey as (
  uniques: string[][] | undefined,
  pk: string,
  owner: string | undefined,
  values: Row,
) => string[] | null;

/** SES hardens `console` at lockdown, so the seam has to be taken before the
 * first mount boots it — after that the property is read-only. Nothing is
 * collected until a mount asks, which keeps lockdown's own chatter out. */
const loggedError = console.error;
let collect: ((err: unknown) => void) | null = null;
console.error = (...args: unknown[]) => {
  // lockdown reports every intrinsic it removes through this same channel, in
  // a group whose continuation lines carry no prefix — so the report is told
  // apart by where it comes from, not by how it reads. That is the platform
  // booting, not a screen failing.
  const ses = new Error().stack?.includes("ses.umd.min.js") === true;
  if (collect === null || ses) return loggedError(...args);
  collect(args[0] instanceof Error ? args[0] : new Error(args.map(String).join(" ")));
};

export type Row = Record<string, unknown>;

/** The elements of a role under `root`, optionally the one whose accessible
 * name matches — the query a screen reader makes, and the one a class rename
 * cannot break. Implicit roles are not inferred: a control that wants to be
 * found this way says what it is. A suite that boots its own store reaches
 * this directly; a mounted screen has it as `m.byRole`. */
export function byRole(root: El, role: string, name?: string | RegExp): El[] {
  const found = [...root.querySelectorAll(`[role="${role}"]`)] as El[];
  if (name === undefined) return found;
  // aria-label first, then the element's own text: the accessible name in the
  // order the platform computes it, minus the parts this tier cannot see (a
  // label element's for=, aria-labelledby's referent).
  const named = (el: El) => el.getAttribute("aria-label") ?? textOf(el);
  return found.filter((el) => typeof name === "string" ? named(el) === name : name.test(named(el)));
}

/** The one element of a role and name; none or several is the screen
 * disagreeing with the reader, which is a finding rather than a filter. */
export function oneByRole(root: El, role: string, name: string): El {
  const found = byRole(root, role, name);
  if (found.length !== 1) throw new Error(`"${name}" names ${found.length} elements of role ${role}, not one`);
  return found[0];
}

/** One element's text, trimmed. */
export const textOf = (el: { textContent: string | null }) => (el.textContent ?? "").trim();

/** Throw the message the test wrote, so a failure reads as a sentence about
 * the screen rather than as a diff of two values. */
export const assert = (ok: unknown, msg: string) => {
  if (!ok) throw new Error(msg);
};

/** The one row a claim is about; any other count is the claim being wrong
 * about the world rather than about the row. */
export const only = (rows: Row[], what: string): Row => {
  if (rows.length !== 1) throw new Error(`${what}: ${rows.length} rows, not one — ${JSON.stringify(rows)}`);
  return rows[0];
};
type Change = { value?: Row; previousValue?: Row };

export type Route = {
  /** The hash route the screen answers, `:param` segments and all. Absent on
   * a route a test builds by hand: only shell.yaml states one. */
  path?: string;
  screen: string;
  files: { html: string; css: string; handlers: string[]; renderers?: string[]; shared?: string[] };
  states?: string[];
};

/** One store contact, in the order it was made. `op` is what the store RESOLVED
 * to and not what the markup declared: an upsert lands here as the create or the
 * update it became, which is the fact about the data rather than about the
 * gesture — a test claiming the gesture asserts on the markup. `row` is the
 * values the caller handed over, the patch for an update and the whole row
 * otherwise, so a write can be asked what it CARRIED and not only that it
 * happened. */
export type Call = { op: string; table: string; id?: string; row?: Row };

export type MemoryStore = {
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
  write(table: string, rows: Row[]): Promise<void>;
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
 * The store's ordering, which is not part of the fragment grammar: a
 * comma-separated `col.dir` list, nulls last on asc and first on desc, JS
 * relational comparison. It mirrors data-crud.js's compareBy, so a column of
 * strings compares lexically here exactly as it does in the browser.
 */
function compareBy(order?: string | null) {
  const keys = (order ?? "").split(",").filter(Boolean).map((k) => {
    const [col, dir] = k.split(".");
    return { col, sign: dir === "desc" ? -1 : 1 };
  });
  return (a: Row, b: Row) => {
    for (const { col, sign } of keys) {
      const x = a[col] as never;
      const y = b[col] as never;
      if (x == null && y == null) continue;
      if (x == null) return sign;
      if (y == null) return -sign;
      if (x < y) return -sign;
      if (x > y) return sign;
    }
    return 0;
  };
}

/** What the cluster fills in that the browser never computes. A mount that
 * omits all of it can still read and create; only upsert needs a key to
 * resolve against. */
export type Cluster = {
  uniques?: Record<string, string[][]>;
  owners?: Record<string, string>;
  /** The pk of every table whose pk is not `id` (shell.yaml `keys:`), which is
   * how a pipeline sink keys on its subject. */
  keys?: Record<string, string>;
  /** Each entity's access mode (shell.yaml `access:`), which decides which
   * rows a reader can see at all. Answered only for a mount that names its
   * reader: with nobody reading there is no visibility question to settle. */
  access?: Record<
    string,
    { mode: string; owner?: string; parent?: string; on?: string; shared?: { via: string; on: string; user: string } }
  >;
  me?: string;
  /** Column DEFAULTs the database fills and the browser never computes, per
   * table. The shipped store has the same hole transiently — it writes the
   * submitted values optimistically and learns the rest when the server row
   * arrives — so a mount that declares none is faithful to that instant and
   * one that declares them is faithful to the settled row. A binding over a
   * column no default supplies renders nothing, which is a guarded refresh
   * error the rejection trap cannot see. */
  defaults?: Record<string, Row>;
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
export function memoryStore(tables: Record<string, Row[]>, cluster: Cluster = {}): MemoryStore {
  const data = new Map<string, Row[]>(
    Object.entries(tables).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]),
  );
  type Sub = { fn: (changes?: Change[]) => void; batch: Change[]; scheduled: boolean };
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
  } as MemoryStore;

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
    if (a.mode === "public-read") return true;
    if (a.mode === "service-only") return false;
    if (a.mode === "owned") {
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

  // PostgREST names an embed by its relation OR by the foreign key column that
  // reaches it, and the grammar reports whichever the markup wrote. Only the
  // table set can tell them apart, so resolution happens here, against the
  // tables this store actually holds.
  const relationOf = (named: string) => {
    if (data.has(named)) return named;
    const stripped = named.replace(/_id$/, "");
    if (data.has(stripped)) return stripped;
    throw new Error(
      `embed "${named}" names neither a table nor a foreign key into one; the store holds ${
        [...data.keys()].join(", ")
      }`,
    );
  };

  const note = (table: string, change: Change) => {
    store.version++;
    for (const sub of subs.get(table) ?? []) {
      sub.batch.push(change);
      if (sub.scheduled) continue;
      sub.scheduled = true;
      store.pendingWakes++;
      setTimeout(() => {
        sub.scheduled = false;
        store.pendingWakes--;
        const changes = sub.batch;
        sub.batch = [];
        sub.fn(changes);
      }, 0);
    }
  };

  store.rows = (table) => of(table);

  store.query = async (table, order, opts = {}) => {
    store.calls.push({ op: "query", table });
    const preds = parseFilter(opts.filter);
    if (preds === null) throw new Error(`filter outside the grammar for ${table}: ${opts.filter}`);
    const embeds = parseSelect(opts.select);
    if (embeds === null) throw new Error(`select outside the grammar for ${table}: ${opts.select}`);
    const sorted = of(table)
      .filter((r: Row) => visible(table, r) && preds.every((p: (row: Row) => boolean) => p(r)))
      .sort(compareBy(order ?? (opts.order as string | undefined)));
    const limit = parseLimit(opts.filter);
    const capped = limit === undefined ? sorted : sorted.slice(0, limit);
    return capped.map((row: Row) => {
      if (embeds.length === 0) return row;
      const out = { ...row };
      for (const { alias, table: rel, cols } of embeds) {
        const t = relationOf(rel);
        const target = of(t).find((r) => String(r[keyOf(t)]) === String(row[`${alias}_id`]));
        // A joined row that does not resolve binds null, never omitted:
        // PostgREST under RLS answers the same way.
        out[alias] = target === undefined
          ? null
          : Object.fromEntries(cols.map((c: string) => [c, target[c]]));
      }
      return out;
    });
  };

  // Per table, not per read: the shipped store maintains a view over the
  // region's own filter and wakes only when that view moves. Waking on the
  // whole table is a superset — the extra pass costs a re-read and the delta
  // set still names the rows that moved — so a region here never misses a
  // wake it would get in the browser.
  store.subscribe = (table, fn, opts = {}) => {
    of(table);
    const sub: Sub = { fn, batch: [], scheduled: false };
    // The shipped store watches the region's embedded tables beside its own,
    // so an edit to a joined row reaches the region that renders it. Row
    // visibility is the part not modelled: every seeded row is readable here.
    const watched = [table, ...embedTables(opts.select as string | undefined)]
      .filter((t) => data.has(t));
    for (const t of watched) {
      const set = subs.get(t) ?? new Set<Sub>();
      subs.set(t, set);
      set.add(sub);
    }
    return () => {
      for (const t of watched) subs.get(t)?.delete(sub);
    };
  };

  store.create = async (table, values) => {
    // The shipped store mints the key when the form does not carry one
    // (data-crud.js: retries are idempotent only because the id travels with
    // every attempt), so a fake that refused would fail writes the browser
    // accepts. Minted from the mount's seeded entropy, not crypto, so a
    // created row's id is the same on every run.
    const given = owned(table, values);
    const row = given?.id === undefined ? { id: mintId(table), ...given } : given;
    store.calls.push({ op: "create", table, id: String(row.id), row: { ...row } });
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
      const value = { ...row };
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
  const wrapped = batched(store) as MemoryStore;
  wrapped.upsertBy = store.upsert;
  wrapped.dropWhere = store.removeWhere;
  return wrapped;
}

/** Every route the app ships, in the order shell.yaml lists them — what a
 * driver that has no screen in mind walks. */
export async function appRoutes(appDir: URL): Promise<Route[]> {
  const shell = parseYaml(await Deno.readTextFile(new URL("shell/shell.yaml", appDir))) as {
    routes?: Route[];
  };
  return shell.routes ?? [];
}

/** The route a screen ships under, read from the emitted shell.yaml so a test
 * cannot drift from what the app actually mounts. */
export async function appRoute(appDir: URL, screen: string): Promise<Route> {
  const route = (await appRoutes(appDir)).find((r) => r.screen === screen);
  if (route === undefined) throw new Error(`shell.yaml declares no screen "${screen}"`);
  return route;
}

/** Every collection the app declares: the browser tier's `local:` and the
 * cluster's `tables:`. memoryStore refuses a read of a table it was not given,
 * so a driver that does not know which collections a screen touches states
 * them all — empty, which is where a visit starts. */
export async function appCollections(appDir: URL): Promise<string[]> {
  const shell = parseYaml(await Deno.readTextFile(new URL("shell/shell.yaml", appDir))) as {
    local?: Record<string, unknown>;
    tables?: string[];
  };
  return [...Object.keys(shell.local ?? {}), ...(shell.tables ?? [])];
}

/** A route's own files, keyed by the paths the route names them by. */
export async function appFiles(appDir: URL, route: Route): Promise<Record<string, string>> {
  const paths = [
    ...(route.files.shared ?? []),
    route.files.html,
    route.files.css,
    ...route.files.handlers,
    ...(route.files.renderers ?? []),
  ];
  const files: Record<string, string> = {};
  for (const path of paths) files[path] = await Deno.readTextFile(new URL(path, appDir));
  return files;
}

// The DOM this needs, structurally: test/deno.json carries no dom lib, and a
// linkedom node is not the platform's Element anyway.
export type El = {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  querySelectorAll(selector: string): ArrayLike<El> & Iterable<El>;
  dispatchEvent(event: unknown): boolean;
  readonly firstElementChild: El | null;
  readonly textContent: string | null;
};

/** A vendored unit, as shell.yaml declares it and as the interpreter resolves
 * a `data-hatch` name against. */
export type Unit = { isolation: string; capabilities: string[]; src: string };

type Interpreter = {
  interpretScreen(
    mount: El,
    base: string,
    route: Route,
    store: MemoryStore,
    params: Record<string, string>,
    opts: { units: Record<string, Unit>; mountUnits: boolean },
  ): Promise<{ pause(): void; resume(): Promise<unknown>; stop(): void }>;
};

const global = globalThis as unknown as Record<string, unknown>;

// The interpreter, imported once per test file with the knobs it reads at
// evaluation already standing. Deno gives each test module its own realm, so
// "once per file" is also once per clock queue and once per draw sequence.
let engine: Promise<Interpreter> | undefined;
let knobs: string | undefined;

async function interpreter(search: string): Promise<Interpreter> {
  if (engine !== undefined) {
    if (knobs !== search) {
      throw new Error(
        `the clock and the seed belong to the test file, not the case: "${knobs}" stands, "${search}" was asked for`,
      );
    }
    return engine;
  }
  knobs = search;
  global.location = new URL(`http://screen.test/${search}`);
  engine = import("../interpreter/screen.js") as unknown as Promise<Interpreter>;
  await engine;
  if (global.__prontoClock === undefined) {
    throw new Error(
      "screen.js evaluated without the manual clock: this file imports it outside the harness, and its waits are real",
    );
  }
  return engine;
}

// The Jessie tier's ses pin, pre-imported so ensureSes skips script injection:
// linkedom executes no scripts. The vendored bundle rather than the CDN's, so
// a whole-screen mount needs no network reach of any kind.
let ses: Promise<unknown> | undefined;
const ensureSes = () => (ses ??= import("../interpreter/vendor/ses.umd.min.js"));

const macrotask = () => new Promise((r) => setTimeout(r, 0));

export type Mounted = {
  mount: El;
  screen: El;
  store: MemoryStore;
  rows(table: string): Row[];
  /** The one element the selector names; absent or ambiguous is an error. */
  one(selector: string): El;
  all(selector: string): El[];
  /** Dispatch a bubbling DOM event, the way a reader's finger would. `init`
   * carries the fields the binding reads — `key` for a data-key gesture — and
   * `bubbles`/`cancelable` reach the constructor. */
  /** Dispatches the event and hands it back, so a test can assert whether the
   * terminal cancelled it. */
  fire(target: string | El, type?: string, init?: Record<string, unknown>): { defaultPrevented: boolean };
  /** Every match's text, trimmed — a region's rendered rows in order. */
  texts(selector: string): string[];
  /** The elements of a role, optionally the one whose accessible name matches
   * — the query a screen reader makes, and the one a class rename cannot
   * break. Implicit roles are not inferred: a control that wants to be found
   * this way says what it is. */
  byRole(role: string, name?: string | RegExp): El[];
  /** Set a DOM property linkedom does not model as an attribute. */
  set(target: string | El, prop: string, value: unknown): void;
  /** Pick an option in a native select and report it, the way a reader does.
   * linkedom's select reads its value off the selected ATTRIBUTE, so the
   * attribute is what moves. */
  choose(target: string | El, value: string): void;
  /** Move the table's clock on; returns the waits still queued. */
  advance(ms: number): number;
  /** Let every promise the last stimulus started run out. */
  quiet(): Promise<void>;
  /** Drive the clock until the screen has stopped: nothing waiting, nothing
   * writing. */
  settle(): Promise<void>;
  stop(): Promise<void>;
};

export type MountSpec = {
  route: Route;
  files: Record<string, string>;
  tables: Record<string, Row[]>;
  seed: number;
  params?: Record<string, string>;
  /** Table milliseconds per clock step. A hundred at a time, not a beat at a
   * time: a screen wears states between its beats. */
  step?: number;
  /** Table milliseconds one settle may spend before the screen is declared
   * unable to stop. */
  cap?: number;
  /** What the cluster fills in that the browser never computes. mountApp reads
   * it from the app's own shell.yaml; `me` is the only part a test supplies. */
  cluster?: Cluster;
  /** Where the held clock starts, as an ISO instant, so a row stamped {now}
   * lands somewhere a test can name. Unset starts at zero. */
  epoch?: string;
  /** Let the screen answer a refusal without failing the test: the interpreter
   * reports one through the same console.error every silent failure takes. */
  expectRefusal?: boolean;
  /** The vendored units a `data-hatch` may name. mountApp reads them from the
   * app's own shell.yaml; a screen naming one it does not declare is refused at
   * mount, so a hatch on the screen under test makes this mandatory. The unit
   * itself still needs its boundary faked — a real Worker answers off the held
   * clock, where settle() cannot see it. */
  units?: Record<string, Unit>;
  /** Whether a resolved unit is also mounted. The machine walker declares
   * false: linkedom has neither a Worker nor a frame, and a unit renders
   * nothing and declares no machine, so mounting one adds nothing to a walk. */
  mountUnits?: boolean;
};

/** linkedom's HTMLFormElement carries no constraint API, and the interpreter
 * gates every submit on checkValidity — so without this a form's submit
 * listener throws out of dispatchEvent and takes the whole test file with it.
 * The check is the real one, not a blanket true: a test that cannot see its
 * own `required` cannot claim the form validates anything. */
function formValidation(document: unknown, submitEvent: new (t: string, i: object) => unknown) {
  const proto = Object.getPrototypeOf(
    (document as { createElement(tag: string): object }).createElement("form"),
  ) as { checkValidity?: () => boolean; reset?: () => void; requestSubmit?: () => void };
  if (proto.checkValidity !== undefined) return;

  type Field = {
    name?: string;
    type?: string;
    value: string;
    disabled?: boolean;
    hasAttribute(name: string): boolean;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
  };
  const fieldsOf = (form: { querySelectorAll(sel: string): Field[] }) =>
    [...form.querySelectorAll("input, select, textarea")].filter((f) => f.disabled !== true);

  proto.checkValidity = function (this: { querySelectorAll(sel: string): Field[] }) {
    for (const field of fieldsOf(this)) {
      const value = field.value ?? "";
      if (field.hasAttribute("required") && value === "") return false;
      const pattern = field.getAttribute("pattern");
      if (pattern !== null && value !== "" && !new RegExp(`^(?:${pattern})$`, "u").test(value)) return false;
      if (field.getAttribute("type") === "number" && value !== "") {
        const n = Number(value);
        if (Number.isNaN(n)) return false;
        const min = field.getAttribute("min");
        const max = field.getAttribute("max");
        if (min !== null && n < Number(min)) return false;
        if (max !== null && n > Number(max)) return false;
      }
    }
    return true;
  };
  // The interpreter resets a form inside its submit try, so a throw here is
  // caught by the form's own refused() and lands a settled write on
  // network-error: a harness fault wearing the app's face. Nothing is assigned
  // that linkedom refuses.
  //
  // What it therefore cannot do: clear a field. linkedom stores an input's
  // value IN its value attribute, so the live value and the default are one
  // storage and a reset has nothing to restore from. "The form clears after a
  // successful write" is not assertable at this tier — assert the row instead.
  proto.reset = function () {};
  // A buttonless form is submitted by its own change listener calling
  // requestSubmit, so without this the reader's actual gesture is undrivable
  // and a test has to dispatch submit behind the control's back.
  proto.requestSubmit = function (this: { dispatchEvent(e: unknown): boolean }) {
    this.dispatchEvent(new submitEvent("submit", { bubbles: true, cancelable: true }));
  };
}

/** A number or range input's parsed value, which linkedom models nowhere:
 * without it the allowlist advertises a field this tier can never deliver, and
 * a machine reading it works in every browser and refuses under test. */
function valueAsNumber(document: unknown): void {
  type Input = { type?: string; value?: string; getAttribute(name: string): string | null };
  const proto = Object.getPrototypeOf(
    (document as { createElement(tag: string): object }).createElement("input"),
  ) as object;
  if (Object.getOwnPropertyDescriptor(proto, "valueAsNumber") !== undefined) return;
  Object.defineProperty(proto, "valueAsNumber", {
    configurable: true,
    get(this: Input) {
      if (this.type !== "number" && this.type !== "range") return Number.NaN;
      // An empty number field is NaN, not zero: the interpreter drops the field
      // when it is NaN, and a test asserting a cleared field writes 0 would
      // pass while the browser wrote nothing at all.
      const raw = (this.value ?? "").trim();
      if (raw === "") return Number.NaN;
      const n = Number(raw);
      // A range CLAMPS to its own bounds, and a screen may rest a safety
      // argument on that. Returning the raw number would let a test claim a
      // clamp the browser performs and this tier does not.
      if (this.type !== "range" || Number.isNaN(n)) return n;
      const lo = Number(this.getAttribute("min") ?? "0");
      const hi = Number(this.getAttribute("max") ?? "100");
      return Math.min(Math.max(n, Number.isNaN(lo) ? n : lo), Number.isNaN(hi) ? n : hi);
    },
  });
}

/** A button's `value`, which the DOM gives every one of them and linkedom gives
 * none.
 *
 * The interpreter reads a control's leaves off the ELEMENT — `value` off the
 * closest input, select, textarea or BUTTON — so in a browser every click
 * carries `value: ""` from the button it came from, where here it carried
 * nothing at all. A guard or an assign reading the event's value then answers
 * one way under test and the other way in front of a reader, which is the whole
 * class this shim closes: a questionnaire's Back arrow read an empty string as
 * an unanswered question and blocked a step the reader had already answered. */
function buttonValue(document: unknown): void {
  const proto = Object.getPrototypeOf(
    (document as { createElement(tag: string): object }).createElement("button"),
  ) as object;
  if (Object.getOwnPropertyDescriptor(proto, "value") !== undefined) return;
  Object.defineProperty(proto, "value", {
    configurable: true,
    get(this: { getAttribute(name: string): string | null }) {
      return this.getAttribute("value") ?? "";
    },
    set(this: { setAttribute(name: string, v: string): void }, v: string) {
      this.setAttribute("value", String(v));
    },
  });
}

/** An element's box, which this tier has no layout to measure.
 *
 * A normalized pointer is a fraction of the affordance it landed on, so without
 * a box the allowlist advertises two fields that work in every browser and are
 * silently absent under test. A test states the box it means with
 * `boxOf(el, {...})`; anything unstated is zero-sized, which is what the
 * interpreter already refuses to divide by. */
function layoutBoxes(document: unknown): void {
  const proto = Object.getPrototypeOf(
    (document as { createElement(tag: string): object }).createElement("div"),
  ) as object;
  if (Object.getOwnPropertyDescriptor(proto, "getBoundingClientRect") !== undefined) return;
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value(this: { _prontoBox?: Box }) {
      return this._prontoBox ?? { left: 0, top: 0, width: 0, height: 0 };
    },
  });
}

/** The top layer, which this tier has no layers to hold.
 *
 * Only the state is modelled, because only the state is what a row decides:
 * `showPopover` on an open popover throws and `hidePopover` on a closed one
 * throws, and the interpreter leans on exactly that to stay idempotent. A stub
 * that accepted both would let a double-open through here and fail in a
 * browser. `:popover-open` is the state a test reads back.
 *
 * Both fire `toggle`, because that event is the only way anything learns of a
 * dismissal the UA performed on its own — light dismiss and Escape. A stub
 * silent about it would leave the interpreter's one guard against a second
 * writer untested here and broken there. */
function topLayer(document: unknown, Event: new (t: string, i: object) => object): void {
  const proto = Object.getPrototypeOf(
    (document as { createElement(tag: string): object }).createElement("div"),
  ) as object;
  if (Object.getOwnPropertyDescriptor(proto, "showPopover") !== undefined) return;
  type Surface = {
    _prontoShown?: boolean;
    localName: string;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    dispatchEvent(e: unknown): void;
  };
  const toggled = (el: Surface, newState: string) =>
    el.dispatchEvent(Object.assign(new Event("toggle", { bubbles: false }), { newState }));
  Object.defineProperty(proto, "showPopover", {
    configurable: true,
    value(this: Surface) {
      if (this.getAttribute("popover") === null) throw new Error("showPopover on an element with no popover")
      if (this._prontoShown === true) throw new Error("InvalidStateError: already open")
      this._prontoShown = true
      // The attribute stands in for :popover-open, which no selector engine
      // here answers.
      this.setAttribute("data-popover-open", "")
      toggled(this, "open")
    },
  });
  Object.defineProperty(proto, "hidePopover", {
    configurable: true,
    value(this: Surface) {
      if (this._prontoShown !== true) throw new Error("InvalidStateError: already closed")
      this._prontoShown = false
      this.removeAttribute("data-popover-open")
      toggled(this, "closed")
    },
  });
}

/** A <template>'s children are not in the document.
 *
 * linkedom's SELECTORS already hold to that — `querySelector("#x")` and
 * `querySelectorAll("form")` both decline to enter template content — but its
 * `getElementById` walks an index that includes it. A browser parses those
 * children into `content`, a fragment of another document, where
 * `getElementById` cannot reach them at all.
 *
 * Without this the tier answers `data-key` and `data-interest` from markup that
 * was never rendered: a key whose form only exists inside the template it is
 * stamped from resolves here and throws in a browser, so the one case that
 * matters — a filtered list with nothing in it — passes under test and fails in
 * front of a reader.
 *
 * `closest` is what tells them apart, and it works for the same reason the bug
 * does: linkedom keeps template children parented to the template. A node the
 * interpreter has stamped into the live tree is a clone, and its chain reaches
 * no template. */
function templateIsolation(document: unknown): void {
  const doc = document as {
    getElementById(id: string): { closest(sel: string): unknown } | null
    _prontoIsolated?: boolean
  }
  if (doc._prontoIsolated === true) return
  doc._prontoIsolated = true
  const own = doc.getElementById.bind(doc)
  doc.getElementById = (id: string) => {
    const found = own(id)
    return found !== null && found.closest("template") !== null ? null : found
  }
}

export type Box = { left: number; top: number; width: number; height: number }

/** States the box an element occupies, for the tier that cannot measure one. */
export function boxOf(el: unknown, box: Box): void {
  ;(el as { _prontoBox?: Box })._prontoBox = box
}

/** The control properties linkedom declares nowhere. `checked` is the state a
 * radio or checkbox submits — the attribute is that state here, as it is for
 * value, and a radio's group clears when one of its own is set. */
function controlProperties(document: unknown) {
  type Input = {
    type?: string;
    name?: string;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    closest(selector: string): { querySelectorAll(sel: string): Input[] } | null;
  };
  valueAsNumber(document);
  buttonValue(document);
  const proto = Object.getPrototypeOf(
    (document as { createElement(tag: string): object }).createElement("input"),
  ) as object;
  if (Object.getOwnPropertyDescriptor(proto, "checked") !== undefined) return;

  Object.defineProperty(proto, "checked", {
    configurable: true,
    get(this: Input) {
      return this.getAttribute("checked") !== null;
    },
    set(this: Input, on: boolean) {
      if (!on) {
        this.removeAttribute("checked");
        return;
      }
      if (this.type === "radio" && this.name !== undefined) {
        const scope = this.closest("form");
        for (const peer of scope?.querySelectorAll(`input[type=radio][name="${this.name}"]`) ?? []) {
          peer.removeAttribute("checked");
        }
      }
      this.setAttribute("checked", "");
    },
  });
}

/** Every store call a mount made that was not a read. */
export const writes = (m: Mounted): Call[] => m.store.calls.filter((c) => c.op !== "query");

export async function mountScreen(spec: MountSpec): Promise<Mounted> {
  await ensureSes();
  const { interpretScreen } = await interpreter(
    `?clock=manual&seed=${spec.seed}${spec.epoch === undefined ? "" : `&epoch=${spec.epoch}`}`,
  );
  const clock = global.__prontoClock as { advance(ms: number): number };

  // The Event class has to be linkedom's own: the platform's seals fields
  // linkedom's dispatchEvent assigns.
  const { document, Event } = parseHTML(
    "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
  ) as unknown as {
    document: { getElementById(id: string): El | null };
    Event: new (type: string, init: { bubbles: boolean; cancelable?: boolean }) => object;
  };
  global.document = document;
  formValidation(document, Event as new (t: string, i: object) => unknown);
  controlProperties(document);
  templateIsolation(document);
  layoutBoxes(document);
  topLayer(document, Event as new (t: string, i: object) => object);

  // The interpreter answers every one of its own seams — a handler, a machine
  // event, an after timer, a refusal, a form submit, a region refresh — with
  // console.error and data-state="network-error". Nothing reaches the runtime
  // as an unhandled rejection, so a stimulus returns normally, no write
  // happens, and a test asserting only on rows passes while the screen sits
  // dead. That one console.error is the seam they all pass through, so it is
  // what quiet() and settle() re-raise. A test that means to drive a refusal
  // says so with expectRefusal.
  const escaped: unknown[] = [];
  const onEscape = (e: { preventDefault(): void; reason?: unknown }) => {
    e.preventDefault();
    escaped.push(e.reason);
  };
  (globalThis as unknown as EventTarget).addEventListener("unhandledrejection", onEscape as EventListener);

  const base = "http://app.test/";
  global.fetch = (url: unknown) => {
    const path = new URL(String(url), base).pathname.replace(/^\//, "");
    const source = spec.files[path];
    if (source === undefined) {
      return Promise.reject(new Error(`the screen fetched ${path}, which the route does not name`));
    }
    return Promise.resolve(new Response(source));
  };

  if (spec.expectRefusal !== true) collect = (err) => escaped.push(err);

  const store = memoryStore(spec.tables, spec.cluster ?? {});
  const mount = document.getElementById("shell");
  if (mount === null) throw new Error("the harness document has no mount");
  const handle = await interpretScreen(mount, base, spec.route, store, spec.params ?? {}, {
    units: spec.units ?? {},
    mountUnits: spec.mountUnits ?? true,
  });

  const step = spec.step ?? 100;
  const cap = spec.cap ?? 60_000;

  const raiseEscaped = () => {
    if (escaped.length === 0) return;
    const first = escaped[0];
    escaped.length = 0;
    throw first instanceof Error
      ? first
      : new Error(`a listener rejected and the DOM swallowed it: ${String(first)}`);
  };

  /** Regions still inside a pass. A wake delivered during the turn a drain is
   * measuring starts a refresh that writes no row, so the store's version and
   * its wake count both read quiet while the screen is still drawing. Waits are
   * not counted: they come due only when settle advances the clock, and waiting
   * on one without advancing would never end. */
  const rendering = () =>
    (global as { __prontoBusy?: () => { regions: number } }).__prontoBusy?.().regions ?? 0;

  // Yields macrotasks until three in a row pass with nothing outstanding. Not a
  // sleep: a promise chain the interpreter started only runs between turns, and
  // there is nothing else to wait on.
  //
  // Three, because a hand-off spans three: a wake is delivered on one turn, the
  // pass it starts reads on the next, and what that read writes lands on the
  // third. The middle turn is the one no counter reports.
  const quiet = async () => {
    raiseEscaped();
    for (let turns = 0, calm = 0; calm < 3; turns++) {
      if (turns > 500) throw new Error("the store never went quiet: something writes on every turn");
      const before = store.version;
      await macrotask();
      calm = store.pendingWakes === 0 && store.version === before && rendering() === 0 ? calm + 1 : 0;
    }
  };

  const settle = async () => {
    for (let spent = 0, twice = false;;) {
      await quiet();
      raiseEscaped();
      if (clock.advance(0) > 0) {
        if (spent >= cap) {
          throw new Error(`the screen never stopped: waits still queued after ${spent}ms of table time`);
        }
        clock.advance(step);
        spent += step;
        continue;
      }
      // An empty queue is not a stopped screen. A machine arms its `after`
      // from the refresh that entered the state, so a screen whose opening act
      // is a beat has nothing queued for the turn between the two; and the
      // advance above fires what was due, whose writes are not drained yet.
      // Both show up as a change across one more turn.
      const before = store.version;
      await macrotask();
      // The turn that ends the drain is the one a teardown refusal lands on,
      // and it writes no row — so the loop would exit past it and `stop` would
      // then drop the collector with the error still in it.
      raiseEscaped();
      if (clock.advance(0) === 0 && store.version === before && rendering() === 0) {
        // Settling is idempotent or it has not settled. Draining once more is
        // what tells apart a screen that has stopped from one whose next turn
        // was queued while this drain was measuring.
        if (twice) return;
        twice = true;
        continue;
      }
      twice = false;
    }
  };

  const one = (selector: string): El => {
    const found = mount.querySelectorAll(selector);
    if (found.length !== 1) throw new Error(`"${selector}" names ${found.length} elements, not one`);
    return found[0];
  };

  return {
    mount,
    screen: mount.firstElementChild as El,
    store,
    rows: (table) => store.rows(table),
    one,
    all: (selector) => [...mount.querySelectorAll(selector)],
    fire(target, type = "click", init) {
      const el = typeof target === "string" ? one(target) : target;
      const { bubbles = true, cancelable = false, ...rest } = (init ?? {}) as {
        bubbles?: boolean;
        cancelable?: boolean;
        [field: string]: unknown;
      };
      // `key` and its neighbours belong to KeyboardEvent, which linkedom does
      // not construct, and an Event ignores an init field it does not declare —
      // so a binding reading event.key would see undefined without this.
      const ev = Object.assign(new Event(type, { bubbles, cancelable }), rest) as {
        defaultPrevented: boolean;
      };
      el.dispatchEvent(ev);
      return ev;
    },
    texts: (selector) => [...mount.querySelectorAll(selector)].map(textOf),
    byRole: (role, name) => byRole(mount, role, name),
    set(target, prop, value) {
      const el = typeof target === "string" ? one(target) : target;
      (el as unknown as Record<string, unknown>)[prop] = value;
    },
    choose(target, value) {
      const select = typeof target === "string" ? one(target) : target;
      const options = [...select.querySelectorAll("option")] as El[];
      // Either the key or the words: a reader picks what the option shows,
      // and a test that can only name the key cannot say the two differ.
      const wanted = options.find((o) => o.getAttribute("value") === value) ??
        options.find((o) => textOf(o) === value);
      if (wanted === undefined) {
        throw new Error(`choose: no option ${JSON.stringify(value)} among ${options.length}`);
      }
      for (const o of options) o.removeAttribute("selected");
      wanted.setAttribute("selected", "");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    advance: (ms) => clock.advance(ms),
    quiet,
    settle,
    async stop() {
      try {
        // Inside, not before: a region whose teardown throws would otherwise
        // skip the detach below. It still skips the regions after it —
        // screen.js's `stop` walks them without a guard — so those keep their
        // subscriptions and their timers for the life of the process.
        handle.stop();
        // The clock queue outlives the screen and is the file's, not this
        // mount's: a wait left behind would come due inside the next case — and
        // a wait is the work most likely to throw, so the traps outlive it.
        await settle();
      } finally {
        // Detached even when the drain throws: the console seam is one slot for
        // the process, and a mount that kept it holds every report until the
        // next mount takes the slot back.
        collect = null;
        (globalThis as unknown as EventTarget).removeEventListener("unhandledrejection", onEscape as EventListener);
      }
    },
  };
}

/** mountScreen against an app's emitted tree: its shell.yaml names the route,
 * and the route names its own files. */
export async function mountApp(
  spec: Omit<MountSpec, "route" | "files"> & { appDir: URL; screen: string },
): Promise<Mounted> {
  const route = await appRoute(spec.appDir, spec.screen);
  const declared = await appCluster(spec.appDir);
  return mountScreen({
    ...spec,
    route,
    files: await appFiles(spec.appDir, route),
    tables: { ...(await appSeed(spec.appDir)), ...spec.tables },
    cluster: { ...declared, ...spec.cluster },
    units: { ...(await appUnits(spec.appDir)), ...spec.units },
  });
}

/** The vendored units an app declares (shell.yaml `units:`), which is what a
 * `data-hatch` name resolves against. */
export async function appUnits(appDir: URL): Promise<Record<string, Unit>> {
  const shell = parseYaml(await Deno.readTextFile(new URL("shell/shell.yaml", appDir))) as {
    units?: Record<string, Unit>;
  };
  return shell.units ?? {};
}

/** The rows a browser tier holds before anyone writes one (shell.yaml
 * `seed:`), which the terminal writes into the collection it has just built.
 * A test that states the table itself is stating a later world than the seed's
 * and keeps it whole. */
export async function appSeed(appDir: URL): Promise<Record<string, Row[]>> {
  const shell = parseYaml(await Deno.readTextFile(new URL("shell/shell.yaml", appDir))) as {
    seed?: Record<string, Row[]>;
  };
  return shell.seed ?? {};
}

/** The cluster facts an app declares about itself: the natural keys of
 * `uniques:` and the owner column of each owned entity in `access:`. */
export async function appCluster(appDir: URL): Promise<Cluster> {
  const shell = parseYaml(await Deno.readTextFile(new URL("shell/shell.yaml", appDir))) as {
    uniques?: Record<string, string[][]>;
    access?: Cluster["access"];
    keys?: Record<string, string>;
  };
  const owners: Record<string, string> = {};
  for (const [table, a] of Object.entries(shell.access ?? {})) {
    if (a.owner !== undefined) owners[table] = a.owner;
  }
  return { uniques: shell.uniques, owners, keys: shell.keys, access: shell.access };
}
