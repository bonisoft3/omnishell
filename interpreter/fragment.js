// The data-plane fragment grammar's parsers. Filters, caps, reads and selects
// are PostgREST fragments authored in markup; the store adapters' predicates,
// clause and dependency builders, the interpreter's synthesized rows, and the
// deno-side checkers all import these functions rather than keeping a private
// parse of the same sentences.

/** A binding as the renderer spells it: one grammar, read by the renderer to
 * fill it, and by every lint that asks whether a text is one. The bracketed
 * form indexes by a row's value rather than by a name written here — what a
 * column holding a message key needs, since the key is the row's to say. */
export const PLACEHOLDER = /\{([\w.]+(?:\[\w+\])?)\}/;
/** The same grammar over a whole text. */
export const PLACEHOLDERS = new RegExp(PLACEHOLDER.source, "g");

/** What `binding` answers for a key the row does not carry: the caller's to
 * judge, since a pending optimistic row and a seed are allowed to lack one. */
export const ABSENT = Symbol("absent");

/**
 * The value a `{param.x}` or row-path placeholder names. A route param the
 * route does not bind is the markup's mistake. A row path is the whole dotted
 * key where the row answers it (fixture rows answer every key), else a walk
 * into embedded objects, where a null embed binds blank: it is how PostgREST
 * answers when RLS hides the joined row.
 */
export function binding(expr, row, params) {
  if (expr.startsWith("param.")) {
    const name = expr.slice("param.".length);
    if (!params || !(name in params)) throw new Error(`unknown route param {${expr}}`);
    return params[name];
  }
  const r = row ?? {};
  if (expr in r) return r[expr];
  let v = r;
  for (const seg of expr.split(".")) {
    if (v == null) return undefined;
    if (!(seg in Object(v))) return ABSENT;
    v = v[seg];
  }
  return v;
}

/** A filter with its placeholders filled by `resolve`. Each value is
 * URI-encoded because the filter lands in a query string and parseFilter
 * splits on `&` and decodes. */
export function fillFilter(template, resolve) {
  return template.replace(PLACEHOLDERS, (_, expr) => encodeURIComponent(String(resolve(expr) ?? "")));
}

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
    // Cursor comparisons. The bound arrives as the text the program wrote;
    // parseFilter compares it through the column's carrier, which is where a
    // bound that is not one is refused.
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

/**
 * A select as PostgREST reads it: columns and embeds, to any depth. An embed
 * is `alias:rel!hint(...)`, or `...rel!hint(...)` spread into its parent; a
 * column is `*`, or `alias:name` with JSON path steps (`->k`, `->>0`), an
 * aggregate (`.sum()`, a bare `count()`) and a cast (`::type`), each kept as
 * written. Whitespace may surround an item. Null for anything else.
 *
 * @returns {{cols: string[], embeds: Embed[]} | null}
 * @typedef {{alias: string, rel: string, hints: string[], spread: boolean, cols: string[], embeds: Embed[]}} Embed
 */
export function parseEmbeds(select) {
  if (select === undefined) return { cols: [], embeds: [] };
  let at = 0;
  const match = (re) => {
    const m = re.exec(select.slice(at));
    if (m === null) return null;
    at += m[0].length;
    return m[0];
  };
  const name = () => match(/^[A-Za-z_][A-Za-z0-9_]*/);
  const space = () => match(/^\s*/);
  const take = (token) => {
    if (!select.startsWith(token, at)) return false;
    at += token.length;
    return true;
  };
  const embed = (alias, rel, spread) => {
    const hints = [];
    while (take("!")) {
      const hint = name();
      if (hint === null) return null;
      hints.push(hint);
    }
    if (!take("(")) return null;
    space();
    const inner = select[at] === ")" ? { cols: [], embeds: [] } : list();
    if (inner === null || !take(")")) return null;
    return { alias, rel, hints, spread, ...inner };
  };
  // What may follow a column's name: path steps, an aggregate, a cast.
  const column = () => {
    while (select.startsWith("->", at)) {
      if (!take("->>")) take("->");
      if (name() === null && match(/^-?\d+/) === null) return false;
    }
    if (take(".") && match(/^(count|sum|avg|max|min)\(\)/) === null) return false;
    return !take("::") || name() !== null;
  };
  const list = () => {
    const cols = [], embeds = [];
    do {
      space();
      const from = at;
      if (take("*")) cols.push("*");
      else if (take("...")) {
        const rel = name();
        const spread = rel === null ? null : embed(rel, rel, true);
        if (spread === null) return null;
        embeds.push(spread);
      } else {
        const first = name();
        if (first === null) return null;
        const rel = select.startsWith("::", at) || !take(":") ? first : name();
        if (rel === null) return null;
        const count = rel === "count" && take("()");
        if (!count && (select[at] === "!" || select[at] === "(")) {
          const e = embed(first, rel, false);
          if (e === null) return null;
          embeds.push(e);
        } else {
          if (!column()) return null;
          cols.push(select.slice(from, at));
        }
      }
      space();
    } while (take(","));
    return { cols, embeds };
  };
  const top = list();
  return top === null || at !== select.length ? null : top;
}

/**
 * The tables a select's embeds read, for waking. An embed names a table, or a
 * foreign-key column of its parent (`home:home_id(name)`), which the schema's
 * `ref` resolves; each nested embed resolves against the table it hangs under.
 *
 * @param {Record<string, {fields: {name: string, ref?: string}[]}>} [schema]
 */
export function embedDeps(select, table, schema) {
  const tree = parseEmbeds(select);
  if (tree === null) throw new ProgramError(`select outside the grammar: ${select}`);
  const out = new Set();
  const walk = (parent, embeds) => {
    for (const e of embeds) {
      const target = schema?.[parent]?.fields.find((f) => f.name === e.rel)?.ref ?? e.rel;
      out.add(target);
      walk(target, e.embeds);
    }
  };
  walk(table, tree.embeds);
  return [...out];
}

/** A LIKE pattern as regex source: metacharacters escaped, wildcards restored. */
const likeSource = (pattern) =>
  pattern.replace(/[.*+?^${}()|[\]\\%_]/g, (c) =>
    c === "*" || c === "%" ? "\u0000*" : c === "_" ? "\u0000?" : `\\${c}`,
  ).replace(/\u0000\*/g, ".*").replace(/\u0000\?/g, ".");

/**
 * A filter as row predicates. `compare(col, a, b)` is the column's value order
 * — a carrier's canonical string is not ordered like its value, `"10" < "9"` —
 * and answers undefined for a column it has no type for, which keeps `<`.
 *
 * @param {(col: string, a: unknown, b: unknown) => number | undefined} [compare]
 */
export function parseFilter(filter, compare = () => undefined) {
  const spec = parseFilterSpec(filter);
  if (spec === null) return null;
  const ordered = (col, value, admits) => {
    // The bound is the program's own text: a value that is not the column's
    // carrier is a broken filter, and it says so here, once, naming the
    // column — not per row, from inside a region's render.
    try {
      compare(col, value, value);
    } catch (err) {
      throw new Error(`filter ${col}: ${err.message}`);
    }
    return (row) => {
      if (row[col] == null) return false;
      const typed = compare(col, row[col], value);
      return admits(typed === undefined ? (row[col] < value ? -1 : row[col] > value ? 1 : 0) : typed);
    };
  };
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
    if (op === "lt") return ordered(col, value, (d) => d < 0);
    if (op === "lte") return ordered(col, value, (d) => d <= 0);
    if (op === "gt") return ordered(col, value, (d) => d > 0);
    return ordered(col, value, (d) => d >= 0);
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
 * when it names a declared module, and a literal otherwise.
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
  const effects = [];
  const walkActions = (actions) => {
    const list = Array.isArray(actions) ? actions : (actions ? [actions] : []);
    for (const act of list) {
      if (act.raise !== undefined) raises.add(act.raise);
      for (const v of Object.values(act.assign ?? {})) {
        if (typeof v === "string") assignStrings.add(v);
        else if (v !== null && typeof v === "object" && !RESERVED_LEAVES.has(v.type)) refs.add(v.type);
        else if (v !== null && typeof v === "object" && POINTER_FIELDS.has(v.params?.field)) pointer = true;
      }
      const rawEffects = Array.isArray(act.effect) ? act.effect : (act.effect ? [act.effect] : []);
      for (const eff of rawEffects) {
        effects.push(eff);
        for (const v of Object.values(eff.values ?? {})) {
          if (typeof v === "string") assignStrings.add(v);
          else if (v !== null && typeof v === "object" && !RESERVED_LEAVES.has(v.type)) refs.add(v.type);
          else if (v !== null && typeof v === "object" && POINTER_FIELDS.has(v.params?.field)) pointer = true;
        }
      }
    }
  };
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
      const rawEffects = Array.isArray(c.effect) ? c.effect : (c.effect ? [c.effect] : []);
      for (const eff of rawEffects) {
        effects.push(eff);
        for (const v of Object.values(eff.values ?? {})) {
          if (typeof v === "string") assignStrings.add(v);
          else if (v !== null && typeof v === "object" && !RESERVED_LEAVES.has(v.type)) refs.add(v.type);
          else if (v !== null && typeof v === "object" && POINTER_FIELDS.has(v.params?.field)) pointer = true;
        }
      }
      if (c.actions) walkActions(c.actions);
    });
  };
  for (const [key, value] of Object.entries(machine.on ?? {})) {
    handled.add(key.split("@")[0]);
    walk("*", key, value);
  }
  if (machine.onDone !== undefined) {
    walk("*", "onDone", machine.onDone);
  }
  const walkState = (name, s) => {
    for (const [key, value] of Object.entries(s.on ?? {})) {
      handled.add(key.split("@")[0]);
      walk(name, key, value);
    }
    for (const [delay, value] of Object.entries(s.after ?? {})) {
      if (!/^\d+$/.test(delay)) refs.add(delay);
      walk(name, `after:${delay}`, value);
    }
    if (s.always !== undefined) {
      walk(name, "always", s.always);
    }
    if (s.onDone !== undefined) {
      walk(name, "onDone", s.onDone);
    }
    walkActions(s.entry);
    walkActions(s.exit);
    if (s.states) {
      for (const [subName, subState] of Object.entries(s.states)) {
        walkState(`${name}.${subName}`, subState);
      }
    }
  };
  for (const [name, s] of Object.entries(machine.states ?? {})) {
    walkState(name, s);
  }
  return {
    refs: [...refs],
    assignStrings: [...assignStrings],
    raises: [...raises],
    handled: [...handled],
    arrows,
    pointer,
    effects,
  };
}

/* --- where a screen's language comes from ------------------------------- */

/** The locales an app declares, as tag -> {path}. A locale is a KEY, so pt-BR
 * and pt cannot be given two disagreeing names, and the segment is the app's to
 * state — the tag lowercased only where it states none.
 *
 * The return is annotated because an empty object literal infers as `{}`, which
 * a caller indexing by tag cannot use — the deno-side checkers type-check under
 * `build` and would refuse every read of it.
 *
 * @returns {Record<string, {path: string}>}
 */
export function localeTable(i18n) {
  /** @type {Record<string, {path: string}>} */
  const out = {};
  for (const [tag, spec] of Object.entries(i18n?.locales ?? {})) {
    out[tag] = { path: String(spec?.path ?? tag).toLowerCase() };
  }
  return out;
}

/** Segment -> tag, for the router's first question. The DEFAULT locale is
 * included: its segment addresses no document and exists so the server can
 * redirect a reader who guessed the symmetrical spelling. */
export function localeByPath(i18n) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [tag, spec] of Object.entries(localeTable(i18n))) out[spec.path] = tag;
  return out;
}

/** The best declared locale for a list of preferred tags, most-wanted first —
 * `Accept-Language` on a server, `navigator.languages` in a browser. An exact
 * tag wins over its own language, so a reader asking for `pt-BR` is not handed
 * `pt-PT` while `pt-BR` is declared. Undefined rather than a guess when nothing
 * matches, because the caller's default is a better answer than a near one. */
export function negotiateLocale(i18n, preferred) {
  const tags = Object.keys(localeTable(i18n));
  for (const want of preferred ?? []) {
    const lower = String(want).toLowerCase();
    const exact = tags.find((t) => t.toLowerCase() === lower);
    if (exact) return exact;
    const base = lower.split("-")[0];
    const sameLanguage = tags.find((t) => t.toLowerCase().split("-")[0] === base);
    if (sameLanguage) return sameLanguage;
  }
  return undefined;
}

/** THE order, in one place. A localized route is told by its path and asks
 * nothing else; a plain one takes the most explicit thing it carries. The
 * router (shell.js) is the one caller and holds no row, so a slot row's own
 * `locale` is applied by the screen that binds it (screen.js), and only where
 * the address decided nothing.
 *
 * Accept-Language is a standing need and loses to present intent: a link
 * someone was handed, or a choice made in this app. */
export function resolveLocale(i18n, sources = {}) {
  const table = localeTable(i18n);
  const known = (tag) => typeof tag === "string" && tag !== "" && Object.hasOwn(table, tag);
  if (known(sources.path)) return sources.path;
  if (known(sources.query)) return sources.query;
  if (known(sources.row)) return sources.row;
  return negotiateLocale(i18n, sources.preferred) ?? i18n?.default;
}

/** Which way a tag's script reads. The engine already carries CLDR's answer,
 * so nothing here is a list of languages that would go stale the day an app
 * declares one more. `getTextInfo()` is the spelling TC39 settled on; the
 * `textInfo` getter is what shipped first and is still what an older WebKit
 * answers. An engine offering neither cannot be asked, and "ltr" is not a safe
 * thing to assume — it renders Hebrew backwards and calls it an answer.
 *
 * The one caller that holds no Intl is CUE, which is why the emitter resolves
 * the entry document's direction against terminal.cue's #RtlLanguages instead;
 *
 * @param {string} [tag]
 * @returns {string}
 */
export function directionOf(tag) {
  const locale = new Intl.Locale(tag);
  const info = locale.getTextInfo?.() ?? locale.textInfo;
  if (info === undefined || info.direction === undefined) {
    throw new Error(`cannot tell which way ${tag} reads: Intl.Locale offers neither getTextInfo() nor textInfo`);
  }
  return info.direction;
}

/* --- a route's address ---------------------------------------------------
 *
 * Every internal link is composed here, from the route table and the locale
 * the page is in, so no author ever spells a path: markup names a route
 * (data-route) and its :params (data-param-<name>), and the same markup
 * addresses /regras and /es/reglas. It sits in this leaf module rather than in
 * the interpreter because the router, the binder, the storybook and the
 * deno-side checkers all compose one way or serve two tables.
 */

/** A broken invariant rather than an outage: no retry repairs it, and the
 * network-error dressing would say the store is down when the program is
 * wrong. Everything under this is rethrown past the interpreter's outage
 * guard. */
export class ProgramError extends Error {}

/** A route's pattern in one locale. A route with no translated spellings is
 * the same in every language. */
export function routePattern(route, locale) {
  return route.paths === undefined ? route.path : route.paths[locale];
}

/** Where a route lives, in one locale. The default locale is served
 * unprefixed — its prefixed spelling is an alias the server redirects — and
 * every other locale wears the segment it declares.
 *
 * Undefined when the address cannot be composed from data the row holds, and
 * the caller drops the attribute rather than writing a broken one. That is the
 * same answer URL_ATTRS and BOOL_ATTRS already give for an empty binding, and
 * what the renderer's URL check gives for a refused one: a reader's data must
 * not take the screen down. A NAME the app got wrong still throws, because
 * that is the author's mistake and no row can fix it. */
export function routeHref(cfg, screen, params, locale) {
  const route = cfg.routes?.find((r) => r.screen === screen);
  if (route === undefined) throw new ProgramError(`data-route names "${screen}", which is no route of this app`);
  const pattern = routePattern(route, locale);
  if (pattern === undefined) throw new ProgramError(`route "${screen}" has no pattern in ${locale}`);
  // The two ways a param can have no value are not the same thing. No
  // data-param-<name> at all is the author naming a route whose shape they did
  // not supply, and no row can put that right. One that IS written and carries
  // nothing is the row saying there is nowhere to go — the first month has no
  // month before it — and the link simply has no address.
  let unaddressed = false;
  const filled = pattern.replace(/:(\w+)/g, (_, name) => {
    if (params === undefined || !(name in params)) {
      throw new ProgramError(`route "${screen}" takes a ${name}; no data-param-${name} gives it one`);
    }
    const value = params[name];
    if (value === "" || value === undefined) {
      unaddressed = true;
      return "";
    }
    return encodeURIComponent(value);
  });
  if (unaddressed) return undefined;
  // An app declaring no locales has one language and no prefixes at all.
  if (cfg.i18n === undefined || locale === cfg.i18n.default) return mounted(cfg, filled);
  const declared = localeTable(cfg.i18n)[locale];
  if (declared === undefined) throw new ProgramError(`locale "${locale}" is not one this app declares`);
  return mounted(cfg, `/${declared.path}${filled === "/" ? "" : filled}`);
}

/** An app address under the path the app is mounted at (cfg.prefix), where it
 * is mounted under one; the shell takes the prefix off again before matching.
 * The address is the app's, never one already mounted: an app route may begin
 * with the prefix's own name. */
export function mounted(cfg, href) {
  const prefix = cfg.prefix ?? "";
  if (prefix === "" || !href.startsWith("/")) return href;
  // The path alone decides; a query or fragment rides along untouched.
  const end = href.search(/[?#]/);
  const path = end === -1 ? href : href.slice(0, end);
  const rest = end === -1 ? "" : href.slice(end);
  return `${prefix}${path === "/" ? "" : path}${rest}`;
}

/** What a screen needs from the app it belongs to, in one place.
 *
 * Four callers reach interpretScreen — the shell, the storybook, the test
 * harness and the machine walk — and a set spelled at each of them is a set
 * three of them can lack a field of, silently, until a screen that needs it
 * renders somewhere nobody looked. A caller states only what only it knows:
 * whether handlers run, whether units mount, where a navigation goes.
 *
 * `messages` and `locale` ride along rather than being read from cfg: the
 * catalogues are fetched asynchronously and the locale is resolved per
 * navigation, so neither is a property of the configuration alone.
 *
 * @template {object} T
 * The app-config fields are `any` because each caller's own signature is what
 * types them — the harness knows its Unit, the shell knows its Route — and this
 * only decides WHICH fields travel, not what they hold.
 *
 * @param {{units?: any, routes?: any, i18n?: any, schema?: any} | undefined} cfg
 * @param {T} [over]
 * @returns {{units: any, routes: any, i18n: any, schema: any} & T}
 */
export function screenEnv(cfg, over = /** @type {T} */ ({})) {
  return {
    units: cfg?.units ?? {},
    routes: cfg?.routes,
    i18n: cfg?.i18n,
    schema: cfg?.schema,
    prefix: cfg?.prefix,
    endowments: cfg?.endowments,
    ...over,
  };
}
