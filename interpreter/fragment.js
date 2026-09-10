// The data-plane fragment grammar's parsers. Filters, caps, reads and selects
// are PostgREST fragments authored in markup; the store adapters' predicates,
// clause and dependency builders, the interpreter's synthesized rows, and the
// deno-side checkers all import these functions rather than keeping a private
// parse of the same sentences.

/**
 * The row cap a filter carries, as a number; undefined when it carries none.
 *
 * Slicing locally is equivalent to letting PostgREST do it because the shape
 * is the whole table — mecha subscribes `params: {table}` with no `where` — so
 * the collection holds every row the reader may see, in the same order, and
 * the cap falls in the same place. `offset` is not read here: paging by
 * offset over a set that is arriving asynchronously is not the same question,
 * and stays the server's.
 */
export function parseLimit(filter) {
  const m = /(?:^|&)limit=(\d+)(?:&|$)/.exec(filter ?? "");
  return m === null ? undefined : Number(m[1]);
}

/**
 * A filter as descriptors rather than closures, so one parse serves both
 * readings of it: the predicates a snapshot read filters with, and the where
 * clauses a live query is built from. null means untranslatable — the region
 * reads through PostgREST.
 *
 * Only the PostgREST filter subset the SPEC's binding grammar emits is
 * translated; anything beyond it (fts, embed-path filters) is server-computed.
 */
export function parseFilterSpec(filter) {
  if (!filter) return [];
  const spec = [];
  for (const part of filter.split("&")) {
    const eq = part.indexOf("=");
    const col = part.slice(0, eq);
    const expr = part.slice(eq + 1);
    // A cap is not a predicate: parseLimit reads it, and both read paths
    // apply it after ordering.
    if (col === "limit" && /^\d+$/.test(expr)) continue;
    if (col.includes(".")) return null; // embed-path filter — server-computed
    if (expr.startsWith("eq.")) spec.push({ col, op: "eq", value: decodeURIComponent(expr.slice(3)) });
    else if (expr.startsWith("neq.")) spec.push({ col, op: "neq", value: decodeURIComponent(expr.slice(4)) });
    // Pattern match, PostgREST's spelling: `*` is the wildcard (`%` is
    // accepted too, since the wire form allows either) and `_` matches one
    // character. `ilike` folds case; `like` does not.
    else if (/^i?like\./.test(expr)) {
      const at = expr.indexOf(".");
      spec.push({ col, op: expr.slice(0, at), value: decodeURIComponent(expr.slice(at + 1)) });
    }
    // Cursor comparisons. The value arrives as a string and the column's type
    // is not knowable here, which JS's relational operators handle the way
    // this needs: two timestamps compare lexically in the one format the
    // cursor ever carries (a row's own value, round-tripped through the URL),
    // and a numeric string coerces against a number.
    else if (/^(lt|lte|gt|gte)\./.test(expr)) {
      const at = expr.indexOf(".");
      spec.push({ col, op: expr.slice(0, at), value: decodeURIComponent(expr.slice(at + 1)) });
    }
    else if (expr === "is.true") spec.push({ col, op: "true" });
    else if (expr === "is.false") spec.push({ col, op: "false" });
    else if (expr === "is.null") spec.push({ col, op: "null" });
    else if (expr === "not.is.null") spec.push({ col, op: "notnull" });
    else return null; // untranslatable — the region reads via PostgREST
  }
  return spec;
}

/**
 * The delete subset of the filter grammar: the descriptors a DELETE's WHERE
 * can state exactly. A limit is refused outright — a DELETE has no ordering
 * to cap against, so honoring the rest of the filter would silently widen the
 * deletion's scope — and any op beyond eq/is would delete more or fewer rows
 * than the region shows.
 */
export function deleteSpec(filter) {
  if (parseLimit(filter) !== undefined) throw new Error(`delete filter carries a limit: ${filter}`);
  const spec = parseFilterSpec(filter);
  if (spec === null || spec.length === 0) throw new Error(`untranslatable delete filter: ${filter}`);
  for (const p of spec) {
    if (!["eq", "true", "false", "null"].includes(p.op)) {
      throw new Error(`unsupported delete filter op: ${p.col}=${p.op}`);
    }
  }
  return spec;
}

/**
 * A read spec — `table?fragment` — split into the shape store.query takes.
 * The fragment is filter parts and `order=`, in this grammar: `order` rides
 * apart from the filter, whose parts recombine in authored order. A bare
 * table name reads whole — no filter, no order — and `filter`/`order` are
 * absent rather than empty, so the spec keys a maintained view exactly as a
 * region's own read does.
 */
export function parseReadSpec(value) {
  const at = value.indexOf("?");
  const table = at === -1 ? value : value.slice(0, at);
  if (table === "") throw new Error(`read spec names no table: "${value}"`);
  const parts = at === -1 ? [] : value.slice(at + 1).split("&").filter(Boolean);
  const order = parts.find((p) => p.startsWith("order="));
  const filter = parts.filter((p) => !p.startsWith("order=")).join("&");
  /** @type {{table: string, filter?: string, order?: string}} */
  const out = { table };
  if (filter !== "") out.filter = filter;
  if (order !== undefined) out.order = order.slice("order=".length);
  return out;
}

/**
 * Embed tables named in a select fragment ("*,task_list(name,color)",
 * "*,note_label!inner(label!inner(name))") join a region's dependency set —
 * its result can only change when one of its tables does. A hint must not
 * swallow the table name: capturing "inner" instead would leave a hinted
 * region deaf to the very tables it joins. Hints stack — two tables joined by
 * more than one foreign key need a relationship hint *and* !inner
 * ("follow!followed_id!inner(…)"), so the run of hints repeats.
 */
export function embedTables(select) {
  return [...(select ?? "").matchAll(/([a-z_][a-z0-9_]*)(?:![a-z_][a-z0-9_]*)*\(/g)].map((m) => m[1]);
}

/** A LIKE pattern as regex source: metacharacters escaped, wildcards restored. */
const likeSource = (pattern) =>
  pattern.replace(/[.*+?^${}()|[\]\\%_]/g, (c) =>
    c === "*" || c === "%" ? "\u0000*" : c === "_" ? "\u0000?" : `\\${c}`,
  ).replace(/\u0000\*/g, ".*").replace(/\u0000\?/g, ".");

export function parseFilter(filter) {
  const spec = parseFilterSpec(filter);
  if (spec === null) return null;
  return spec.map(({ col, op, value }) => {
    if (op === "eq") return (row) => String(row[col]) === value;
    if (op === "neq") return (row) => String(row[col]) !== value;
    if (op === "like" || op === "ilike") {
      const re = new RegExp(`^${likeSource(value)}$`, op === "ilike" ? "is" : "s");
      return (row) => row[col] != null && re.test(String(row[col]));
    }
    if (op === "true") return (row) => row[col] === true;
    // An optimistic insert omits DB-defaulted columns; every boolean the
    // schema defaults defaults to false, so a missing column on an
    // unconfirmed row must not hide it (the offline-captured note has to
    // render on the wall). Synced rows always carry every column.
    if (op === "false") return (row) => row[col] === false || (row.$synced === false && row[col] === undefined);
    if (op === "null") return (row) => row[col] == null;
    if (op === "notnull") return (row) => row[col] != null;
    if (op === "lt") return (row) => row[col] < value;
    if (op === "lte") return (row) => row[col] <= value;
    if (op === "gt") return (row) => row[col] > value;
    return (row) => row[col] >= value;
  });
}

/**
 * The locally joinable select subset: "*" plus flat unhinted embeds, each
 * resolvable through the base row's `<alias>_id` column against the embedded
 * table's synced collection (pronto's FK naming convention). Anything else —
 * !hints, nested embeds, column lists on the base — is server-computed.
 *
 * A flat FK embed comes back as {alias, table, cols}.
 *
 * PostgREST spells one of these two ways: `label(name)`, where the relation is
 * named for its table, and `author:app_user(handle)`, where it is named for
 * the foreign key. Both are the same join — the alias is what the row binds
 * under and what `<alias>_id` is derived from, the table is which collection
 * to look in — and only the second can express two embeds of one table.
 *
 * null means server-computed: a hint (`!inner`), a nested embed, or anything
 * else this cannot state as a flat lookup.
 */
export function parseSelect(select) {
  if (select === undefined) return [];
  const rel = "(?:[a-z_][a-z0-9_]*:)?[a-z_][a-z0-9_]*";
  if (!new RegExp(`^\\*(,${rel}\\([a-z0-9_,]*\\))*$`).test(select)) return null;
  return [...select.matchAll(/(?:([a-z_][a-z0-9_]*):)?([a-z_][a-z0-9_]*)\(([a-z0-9_,]*)\)/g)].map((m) => ({
    alias: m[1] ?? m[2],
    table: m[2],
    cols: m[3].split(",").filter(Boolean),
  }));
}

/** A transition value in every #Machine spelling — a bare target string, one
 * candidate object, or an ordered candidate list — as the list. */
export function machineCandidates(value) {
  if (typeof value === "string") return [{ target: value }];
  return Array.isArray(value) ? value : [value];
}

/**
 * One walk of a #Machine's value positions, shared by the interpreter (which
 * modules to load), the checkers (which references must resolve, which raises
 * must be handled), and the path walker (which arrows exist).
 *
 * `refs` are positions that are ALWAYS references (guards, non-numeric after
 * keys, and the `{type, params}` object form except where it names a leaf the
 * terminal answers itself);
 * `assignStrings` are dual positions — a string here is a reference exactly
 * when it names a declared module, which is why a literal shadowing one is
 * refused at lint rather than resolved by guess.
 */
/** Leaf types the terminal answers itself in the assign position, so no module
 * is looked up and no checker demands one for them there. */
export const RESERVED_LEAVES = new Set(["event"]);

/** Event leaves whose value the terminal has to MEASURE. Reading one costs a
 * synchronous layout, so a chart says whether it wants that by reading it: a
 * click carries clientX in every browser, and measuring on all of them would
 * put a reflow in front of every gesture in every app. */
const POINTER_FIELDS = new Set(["pointerX", "pointerY"]);

export function machineShape(machine) {
  let pointer = false;
  const refs = new Set();
  const assignStrings = new Set();
  const raises = new Set();
  const handled = new Set();
  const arrows = [];
  const walk = (state, key, value) => {
    machineCandidates(value).forEach((c, index) => {
      arrows.push({ state, key, index });
      if (c.guard !== undefined) refs.add(typeof c.guard === "string" ? c.guard : c.guard.type);
      if (c.raise !== undefined) raises.add(c.raise);
      for (const v of Object.values(c.assign ?? {})) {
        if (typeof v === "string") assignStrings.add(v);
        else if (v !== null && typeof v === "object" && !RESERVED_LEAVES.has(v.type)) refs.add(v.type);
        else if (v !== null && typeof v === "object" && POINTER_FIELDS.has(v.params?.field)) pointer = true;
      }
    });
  };
  for (const [key, value] of Object.entries(machine.on ?? {})) {
    handled.add(key.split("@")[0]);
    walk("*", key, value);
  }
  for (const [name, s] of Object.entries(machine.states)) {
    for (const [key, value] of Object.entries(s.on ?? {})) {
      handled.add(key.split("@")[0]);
      walk(name, key, value);
    }
    for (const [delay, value] of Object.entries(s.after ?? {})) {
      if (!/^\d+$/.test(delay)) refs.add(delay);
      walk(name, `after:${delay}`, value);
    }
  }
  return {
    refs: [...refs],
    assignStrings: [...assignStrings],
    raises: [...raises],
    handled: [...handled],
    arrows,
    pointer,
  };
}
