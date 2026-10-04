// The terminal's markup rules: what a screen's data-* vocabulary may say,
// stated beside the vocabulary itself (fragment.js) so the plugin that
// publishes the grammar also publishes its rules. pronto's derive.ts
// orchestrates these per app; the terminal's own tests exercise them here —
// nothing in this file touches the filesystem or an app.

import {
  machineCandidates,
  machineShape,
  parseFilterSpec,
  parseLimit,
  parseOrder,
  parseReadSpec,
  parseSelect,
  PLACEHOLDER,
  PLACEHOLDERS,
  routeOf,
} from "./fragment.js";

type Unique = { name: string; cols: string[]; where?: string };
export type Entity = {
  table: string;
  durability: string;
  fields: {
    name: string;
    type: string;
    pk?: boolean;
    unique?: boolean;
    default?: string;
    /** What the integer counts, where it counts money (schema.cue #Field). */
    money?: { currency: string; minorUnits: number };
  }[];
  uniques?: Unique[];
  access?: { mode: string; owner?: string; shared?: unknown };
};
type Spec = { col: string; op: string; value?: string }[] | null;

const STYLE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const SCRIPT = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
// One preprocessing for every reader: commented-out markup renders nothing,
// and a script body is program text the HTML parser never turns into
// elements, so a scanner that still saw either would derive reads, vet
// machines, count items, or claim slots for tags the DOM never mounts — and
// the readers would disagree with each other about what the screen says. An
// app-owned script holding a markup-shaped string is ordinary.
const strip = (html: string) => html.replace(SCRIPT, "").replace(STYLE, "").replace(COMMENT, "");
// Both authored quoting styles, matching what the DOM parser hands the
// interpreter — a single-quoted attribute must not be visible to one checker
// and invisible to another.
const ATTR = /\s(data-[a-z][a-z-]*)=(?:"([^"]*)"|'([^']*)')/g;

const decode = (v: string) =>
  v.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Tables read, handler modules bound, and filter fragments authored by one
 * screen's markup. A filter's table is the tag's own anchor: `data-live` on a
 * region, `data-entity` on a delete form. */
export function scanScreen(
  html: string,
): { tables: string[]; handlers: string[]; adapters: string[]; filters: { table: string; filter: string }[] } {
  const tables = new Set<string>();
  const handlers = new Set<string>();
  // An adapter is a Jessie module like a reduce, and a different ROLE: it ends
  // in a map of pure functions rather than one function, and the cage it loads
  // in is endowed. Kept apart here so every reader downstream — the loader, the
  // load check, the battery — asks about it in the role it actually has.
  const adapters = new Set<string>();
  const filters: { table: string; filter: string }[] = [];
  for (const [, closing, , attrText] of strip(html).matchAll(ANY_TAG)) {
    if (closing === "/") continue;
    const attrs = attrMap(attrText);
    for (const [name, value] of attrs) {
      if (name === "data-live") tables.add(value);
      else if (name === "data-reads") {
        for (const t of value.split(",")) if (t.trim() !== "") tables.add(t.trim());
      } else if (name.startsWith("data-read-")) {
        // A named read: its table joins the screen's set, its filter part is
        // anchored to that table for R2 exactly as a data-filter is.
        const read = parseReadSpec(value);
        tables.add(read.table);
        if (read.filter !== undefined) filters.push({ table: read.table, filter: read.filter });
      } else if (binds(name)) handlers.add(value);
      else if (name === "data-value-adapter") adapters.add(value);
    }
    const filter = attrs.get("data-filter");
    if (filter !== undefined) {
      const table = attrs.get("data-live") ?? attrs.get("data-entity");
      if (table === undefined) throw new Error(`data-filter="${filter}" on a tag with no data-live or data-entity`);
      filters.push({ table, filter });
    }
  }
  return { tables: [...tables].sort(), handlers: [...handlers].sort(), adapters: [...adapters].sort(), filters };
}

/** One read a screen's markup makes, as pronto's #Read states it: the
 * filter's clauses without their values, the tables its select embeds, and
 * the columns of every order it can be in. */
export type ScreenRead = {
  table: string;
  /** data-live (a region's own read), data-reads (a whole table a reduce
   * reads) or data-read-<name> (a reduce's named read). */
  kind: "live" | "reads" | "named";
  /** Inside an enclosing data-live region, so its placeholders resolve against
   * that region's row. */
  nested: boolean;
  /** The lists stamping it, as indices into the screen's reads: each region
   * whose item template it is inside, each naming that template, and the lists
   * stamping those in turn. It reads once per row of each; empty, it reads
   * once, as a slot binds one row. */
  lists: number[];
  route: "server" | "snapshot" | "whole" | "view";
  /** Absent, as embeds is, where the server computes the read. */
  clauses?: { col: string; op: string }[];
  embeds?: string[];
  limit?: number;
  orders: string[];
};

/** A write a screen's markup states: a form, a chart's effect, or a reduce,
 * recorded as op `reduce` on its region's table. A reduce is code bound to an
 * event (data-on-<event>, a drag's data-handler): its updates put, patch and
 * delete, and its effects upsert and delete by filter, on whatever tables its
 * module names, which are not the markup's to say. */
export type ScreenWrite = { table: string; op: string; filter?: string };

/** Whether an attribute binds a reduce: a data-on-<event>, data-on-mutation
 * among them, or a data-handler, which a region's drag calls. */
const binds = (name: string) => name === "data-handler" || name.startsWith("data-on-");

/** A read as #Read states it, routed by the function the store routes it by. */
function readOf(
  table: string,
  kind: ScreenRead["kind"],
  nested: boolean,
  lists: number[],
  filter: string | undefined,
  select: string | undefined,
  orders: string[],
): ScreenRead {
  const spec = parseFilterSpec(filter ?? "") as Spec;
  const embeds = parseSelect(select) as { table: string }[] | null;
  const limit = parseLimit(filter) as number | undefined;
  return {
    table,
    kind,
    nested,
    lists,
    route: routeOf(spec, embeds, limit),
    ...(spec === null ? {} : { clauses: spec.map(({ col, op }) => ({ col, op })) }),
    ...(embeds === null ? {} : { embeds: embeds.map((e) => e.table) }),
    ...(limit === undefined ? {} : { limit }),
    orders: [...new Set(orders.flatMap((o) => o.split(",").filter(Boolean).map((k) => k.split(".")[0])))],
  };
}

/** Every order a data-order can be in: the literal, or each a closed map
 * names. */
function ordersOf(spec: string | undefined, table: string): string[] {
  if (spec === undefined) return [];
  const order = parseOrder(spec, table);
  return order.literal !== undefined ? [order.literal] : Object.values(order.of as Record<string, string>);
}

/** Every read and write one screen's markup states, in document order; a
 * reduce in a named template is recorded last, on each region that stamps it. */
export function screenAccess(html: string): { reads: ScreenRead[]; writes: ScreenWrite[] } {
  const reads: ScreenRead[] = [];
  const writes: ScreenWrite[] = [];
  const reduced = new Set<string>();
  const reduce = (table: string) => {
    if (reduced.has(table)) return;
    reduced.add(table);
    writes.push({ table, op: "reduce" });
  };
  // A named item template is stamped by each region naming it in
  // data-template and by the region holding it, as machineRegions reads it.
  const referrers = new Map<string, string[]>();
  const refer = (name: string, table: string) => referrers.set(name, [...referrers.get(name) ?? [], table]);
  const stamped: string[] = [];
  // The same, as the reads of the lists stamping each item template, filled
  // once every region naming one has been read.
  const stampers = new Map<string, number[]>();
  const stampersOf = (name: string) => stampers.get(name) ?? stampers.set(name, []).get(name) as number[];
  const stamps: { lists: number[]; templates: number[][] }[] = [];
  type Open = { tag: string; live?: string; read?: number; named?: string; stampers?: number[] };
  walkTags<Open>(html, (tag, attrText, stack) => {
    const attrs = attrMap(attrText);
    const live = attrs.get("data-live");
    const enclosing = stack.findLast((f) => f.live !== undefined)?.live;
    const templates = stack.flatMap((f) => f.stampers === undefined ? [] : [f.stampers]);
    // A named template outside every region is stamped by the lists naming it.
    const nested = enclosing !== undefined || templates.length > 0;
    const stamp = () => {
      const lists: number[] = [];
      stamps.push({ lists, templates });
      return lists;
    };
    let read: number | undefined;
    // The region a reduce here is wired in, or the named template whose
    // stampers wire it.
    const near = stack.findLast((f) => f.live !== undefined || f.named !== undefined);
    if (live !== undefined) {
      read = reads.length;
      reads.push(readOf(live, "live", nested, stamp(), attrs.get("data-filter"), attrs.get("data-select"), ordersOf(attrs.get("data-order"), live)));
      const template = attrs.get("data-template");
      if (template !== undefined) {
        refer(template, live);
        stampersOf(template).push(read);
      }
    }
    if ([...attrs.keys()].some(binds)) {
      if (live !== undefined || near?.live !== undefined) reduce(live ?? near?.live as string);
      else if (near?.named !== undefined) stamped.push(near.named);
    }
    for (const t of (attrs.get("data-reads") ?? "").split(",")) {
      if (t.trim() !== "") reads.push(readOf(t.trim(), "reads", nested, stamp(), undefined, undefined, []));
    }
    for (const [name, value] of attrs) {
      if (!name.startsWith("data-read-")) continue;
      const spec = parseReadSpec(value);
      reads.push(readOf(spec.table, "named", nested, stamp(), spec.filter, undefined, spec.order === undefined ? [] : [spec.order]));
    }
    const action = attrs.get("data-action");
    const entity = attrs.get("data-entity");
    if (tag === "form" && action !== undefined && entity !== undefined) {
      writes.push({ table: entity, op: action, ...(attrs.has("data-filter") ? { filter: attrs.get("data-filter") } : {}) });
    }
    if (tag !== "template" || !attrsOf(attrText).has("data-item")) return { tag, live, read };
    const named = attrs.get("data-name");
    const holder = stack.findLast((f) => f.tag === "template" || f.live !== undefined);
    const held = holder?.read === undefined ? [] : [holder.read];
    if (named !== undefined && holder?.live !== undefined) refer(named, enclosing as string);
    if (named === undefined) return { tag, live, read, stampers: held };
    stampersOf(named).push(...held);
    return { tag, live, read, named, stampers: stampersOf(named) };
  });
  for (const name of stamped) for (const table of referrers.get(name) ?? []) reduce(table);
  // stamps[i] is reads[i]'s. A list stamped by another stamps a read once per
  // row of both, whether its template is nested in the outer one's or named.
  const direct = stamps.map(({ templates }) => templates.flat());
  const closure = (i: number, seen: Set<number>): Set<number> => {
    for (const j of direct[i]) if (!seen.has(j)) closure(j, seen.add(j));
    return seen;
  };
  stamps.forEach(({ lists }, i) => lists.push(...[...closure(i, new Set())].sort((a, b) => a - b)));
  return { reads, writes };
}

/**
 * R2: the columns a filter names that are not fields of its table's entity.
 *
 * The one filter grammar decides what counts as a column: a `limit` is a cap,
 * not a column, and a fragment the parser calls server-computed (an embed
 * path, fts) names nothing this rule may judge — the server resolves those
 * against its own schema.
 */
export function unknownColumns(filter: string, fields: string[]): string[] {
  const spec: Spec = parseFilterSpec(filter);
  if (spec === null) return [];
  return [...new Set(spec.map((p) => p.col).filter((c) => !fields.includes(c)))];
}

/** One tag's valued data-* attributes by name, either quoting style,
 * entities decoded. */
export const attrMap = (attrText: string): Map<string, string> =>
  new Map([...` ${attrText}`.matchAll(ATTR)].map(([, name, dq, sq]): [string, string] => [name, decode(dq ?? sq)]));

const QATTR = (name: string) => new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`);

/** One tag's attributes as the DOM parser hands them to the interpreter:
 * either quoting style, entities decoded, and `has` for the valueless
 * spelling (`data-item`), whose `(?:[\s=]|$)` tail is what stops it matching
 * a longer name that starts the same way. */
const attrsOf = (attrText: string) => ({
  attr: (name: string): string | undefined => {
    const a = QATTR(name).exec(` ${attrText}`);
    return a ? decode(a[1] ?? a[2]) : undefined;
  },
  has: (name: string): boolean => new RegExp(`\\s${name}(?:[\\s=]|$)`).test(` ${attrText}`),
});

/** A route hole and the region read that fills it; `filter` is the region's whole
 * data-filter, since whether the store answers it locally is decided over all of
 * its clauses. */
export type ParamPlan = { route: string; param: string; table: string; column: string; op: string; filter: string };

/**
 * Where each `:param` gets a real value, read off the SCREEN MARKUP.
 *
 * The markup is the only statement of it: a region names its table in
 * `data-live` and its predicate in `data-filter`, and pronto's derive pass
 * carries neither into the program on purpose, so shell.yaml has no `reads:`
 * to consult.
 *
 * A param is named by ONE route's markup, so a plan is scoped to that route: an
 * `:id` is a category on one screen and an expense on another, and a plan keyed
 * by the name alone fills the second route with the first route's value, which
 * matches no row.
 *
 * A param with no plan is a coverage hole exactly like one whose plan fails to
 * resolve — the route wearing it goes unchecked — so it comes back as
 * `unplanned` rather than being dropped.
 *
 * Only tags declaring BOTH attributes count: `data-text="{param.month}"`
 * states where a param is printed, which nothing can be resolved from.
 */
export function paramPlans(
  routes: { path: string }[],
  markup: Record<string, string>,
): { plans: ParamPlan[]; unplanned: { route: string; param: string }[] } {
  const plans = new Map<string, ParamPlan>();
  const wanted = new Map<string, { route: string; param: string }>();
  for (const route of routes) {
    for (const seg of route.path.split("/")) {
      if (!seg.startsWith(":")) continue;
      const param = seg.slice(1);
      const key = `${route.path} ${param}`;
      wanted.set(key, { route: route.path, param });
      for (const [, closing, , attrText] of strip(markup[route.path] ?? "").matchAll(ANY_TAG)) {
        if (closing === "/") continue;
        const { attr } = attrsOf(attrText);
        const table = attr("data-live");
        const filter = attr("data-filter");
        if (table === undefined || filter === undefined) continue;
        // e.g. `slug=eq.{param.slug}`, `created_at=lt.{param.when}`,
        // `article_tag.tag=eq.{param.name}`, `search=plfts(simple).{param.q}`
        // The placeholder must BE the value, not part of one: a composite like
        // `bucket=eq.{param.month}:{id}` names the param without yielding
        // anything a route can be filled with, and without the terminator the
        // winner is whichever region is declared first.
        const m = filter.match(
          new RegExp(`([\\w.]+)=([a-z]+(?:\\([^)]*\\))?)\\.\\{param\\.${param}\\}(?=&|$)`),
        );
        if (!m) continue;
        // An `eq` plan is the only one a reader can answer by echoing a row's
        // value, so it wins over one the markup happened to declare first.
        const found = { route: route.path, param, table, column: m[1], op: m[2], filter };
        const held = plans.get(key);
        if (held === undefined || (held.op !== "eq" && found.op === "eq")) plans.set(key, found);
        if (found.op === "eq") break;
      }
    }
  }
  return {
    plans: [...plans.values()],
    unplanned: [...wanted].filter(([key]) => !plans.has(key)).map(([, hole]) => hole)
      .sort((a, b) => `${a.route} ${a.param}`.localeCompare(`${b.route} ${b.param}`)),
  };
}

export type MachineRegion = {
  table: string;
  machine: string;
  /** Every chart on this region, this one included: the group a row-sharing
   * rule is about. */
  parallel: string[];
  emptyRow?: string;
  filter?: string;
  /** Every chain of regions it is stamped under, each innermost first: what
   * a row-stamped filter is stamped from. A named template contributes one
   * chain per region that references it by data-template and one for the
   * region whose own content holds it, and none when no region does either. */
  enclosing: Enclosing[][];
};

type Enclosing = { table: string; filter?: string };

/** Every data-machine region in one screen's markup, with the attributes its
 * validity depends on. Single-quoted values are the norm here — a machine is
 * JSON, whose own quotes are double. A machine is read from `region.dataset`
 * and from nowhere else, so a data-machine off a region binds nothing: a
 * precondition, not a shape this rule may guess at. */
export function machineRegions(html: string): MachineRegion[] {
  const out: MachineRegion[] = [];
  // `named` is a template[data-item][data-name]: a chain stops there and goes
  // on through each region that stamps it, which `referrers` holds.
  type Open = { tag: string; table?: string; filter?: string; named?: string };
  // The lexical regions up to the nearest named template, and that template.
  const reach = (stack: Open[]): { chain: Enclosing[]; via?: string } => {
    const chain: Enclosing[] = [];
    for (let i = stack.length - 1; i >= 0; i--) {
      const { table, filter, named } = stack[i];
      if (named !== undefined) return { chain, via: named };
      if (table !== undefined) chain.push({ table, filter });
    }
    return { chain };
  };
  const referrers = new Map<string, { chain: Enclosing[]; via?: string }[]>();
  const refer = (name: string, entry: { chain: Enclosing[]; via?: string }) => {
    const entries = referrers.get(name);
    if (entries === undefined) referrers.set(name, [entry]);
    else entries.push(entry);
  };
  // Whether the nearest region holds the open tag in its own content: a
  // template between them keeps it out of the region's querySelector.
  const lexical = (stack: Open[]): boolean => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].tag === "template") return false;
      if (stack[i].table !== undefined) return true;
    }
    return false;
  };
  const found: { region: Omit<MachineRegion, "enclosing">; chain: Enclosing[]; via?: string }[] = [];
  walkTags<Open>(html, (tag, attrText, stack) => {
    const { attr, has } = attrsOf(attrText);
    const { chain, via } = reach(stack);
    const ref = attr("data-template");
    if (ref !== undefined && attr("data-live") !== undefined) {
      refer(ref, { chain: [{ table: attr("data-live") as string, filter: attr("data-filter") }, ...chain], via });
    }
    const named = tag === "template" && has("data-item") ? attr("data-name") : undefined;
    // hydrateRegion takes every item template whose nearest region it is,
    // named or not, so that region stamps it too.
    if (named !== undefined && lexical(stack)) refer(named, { chain, via });
    const frame = { tag, table: attr("data-live"), filter: attr("data-filter"), named };
    const machine = attr("data-machine");
    if (machine === undefined) return frame;
    const table = attr("data-live");
    if (table === undefined) throw new Error(`data-machine on a tag with no data-live`);
    // A list is several charts on one region, and every rule below is a
    // chart's — so the list becomes entries, each carrying the siblings it
    // shares a row with for the one rule that is the GROUP's.
    let parsed: unknown;
    try {
      parsed = JSON.parse(machine);
    } catch {
      throw new Error(`data-machine is not JSON`);
    }
    const raw = Array.isArray(parsed) ? parsed : [parsed];
    const parallelCharts: unknown[] = [];
    for (const chart of raw) {
      if (chart && typeof chart === "object" && (chart as Record<string, unknown>).type === "parallel") {
        const p = chart as Record<string, unknown>;
        const states = (p.states ?? {}) as Record<string, Record<string, unknown>>;
        for (const [regionName, regionNode] of Object.entries(states)) {
          parallelCharts.push({
            field: regionNode.field ?? regionName,
            initial: regionNode.initial,
            context: regionNode.context ?? (regionNode.field ? p.context : undefined),
            on: { ...(p.on as object), ...(regionNode.on as object) },
            states: regionNode.states ?? {},
            after: regionNode.after,
            always: regionNode.always,
            onDone: regionNode.onDone,
            entry: regionNode.entry,
            exit: regionNode.exit,
          });
        }
      } else {
        parallelCharts.push(chart);
      }
    }
    const parallel = parallelCharts.map((c) => JSON.stringify(c));
    for (const one of parallel) {
      found.push({
        region: { table, machine: one, parallel, emptyRow: attr("data-empty-row"), filter: attr("data-filter") },
        chain,
        via,
      });
    }
    return frame;
  });
  // A template stamped inside itself is stamped first under whatever stamps
  // the outermost copy, so a chain revisiting a name adds no way in.
  const chains = (chain: Enclosing[], via: string | undefined, seen: string[]): Enclosing[][] =>
    via === undefined ? [chain] : seen.includes(via) ? [] : (referrers.get(via) ?? []).flatMap((r) =>
      chains(r.chain, r.via, [...seen, via]).map((outer) => [...chain, ...outer])
    );
  for (const { region, chain, via } of found) out.push({ ...region, enclosing: chains(chain, via, []) });
  return out;
}

/** The reason parallel charts on one region are not disjoint, or null.
 *
 * They share a row, which is the point — one write, several charts' columns —
 * and it is also the whole hazard: a column two charts write has two writers
 * and no arbiter, so which value survives is which chart stepped last. The
 * field counts as a written column, because it is. */
export function parallelLint(charts: Machine[]): string | null {
  const owner = new Map<string, string>();
  for (const chart of charts) {
    if (chart.field === undefined) continue;
    const cols = [chart.field, ...machineWrites(chart, undefined).map((w) => w.col)].filter(
      (c): c is string => typeof c === "string",
    );
    for (const col of cols) {
      const held = owner.get(col);
      if (held !== undefined && held !== chart.field) {
        return `the charts over "${held}" and "${chart.field}" both write "${col}" — parallel charts share the ` +
          `row and hold disjoint columns, or which value survives is which chart stepped last`;
      }
      owner.set(col, chart.field);
    }
  }
  return null;
}

const ANY_TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "source", "track", "wbr",
]);
// The end tags HTML lets a following sibling stand in for. Every stack walker
// below models them, because a stack that did not would put `<li>a<li>b` in
// one frame while the DOM the interpreter queries and stamps from has two.
const CLOSED_BY: Record<string, string[]> = {
  li: ["li"],
  p: ["p"],
  tr: ["tr", "td", "th"],
  td: ["td", "th"],
  th: ["td", "th"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  option: ["option"],
  thead: ["thead", "tbody", "tfoot"],
  tbody: ["thead", "tbody", "tfoot"],
  tfoot: ["thead", "tbody", "tfoot"],
};

/** The open frames a start tag closes on its own, innermost first. */
function implied<T extends { tag: string }>(stack: T[], tag: string): T[] {
  const closes = CLOSED_BY[tag];
  if (closes === undefined) return [];
  const out: T[] = [];
  while (stack.length > 0 && closes.includes(stack[stack.length - 1].tag)) out.push(stack.pop() as T);
  return out;
}

/** Each start tag of a screen's markup, in document order, with the frames of
 * the elements open around it as the DOM nests them. `visit` returns the
 * tag's own frame, pushed unless the element is void or self-closed;
 * `closed` is handed each frame as its element ends, the document's end
 * included. */
function walkTags<F extends { tag: string }>(
  html: string,
  visit: (tag: string, attrText: string, stack: F[]) => F,
  closed: (frame: F) => void = () => {},
): void {
  const stack: F[] = [];
  for (const [, closing, rawTag, attrText] of strip(html).matchAll(ANY_TAG)) {
    const tag = rawTag.toLowerCase();
    if (closing === "/") {
      const at = stack.findLastIndex((f) => f.tag === tag);
      if (at >= 0) for (const frame of stack.splice(at)) closed(frame);
      continue;
    }
    for (const frame of implied(stack, tag)) closed(frame);
    const frame = visit(tag, attrText, stack);
    if (VOID.has(tag) || /\/\s*$/.test(attrText)) closed(frame);
    else stack.push(frame);
  }
  for (const frame of stack) closed(frame);
}

export type Slot = {
  table: string;
  filter?: string;
  /** Authored inside an item template, so the interpreter hydrates it from an
   * enclosing region's row — `syncNested` is its only non-top caller — and no
   * screen state stands for it. */
  nested: boolean;
  /** Whether the region states what it renders with no row: `data-empty`'s
   * copy, or a row to bind instead — `data-empty-row`, or the one a machine
   * synthesizes from its initial. */
  declares: boolean;
};

/** Every slot — a `data-live` region with no `template[data-item]` where the
 * interpreter's querySelector would see one — with the filter its cardinality
 * depends on and what it says about holding no row. Template content is a
 * boundary exactly as it is in the DOM: an item template marks only the
 * regions between it and its nearest enclosing template, because a deeper
 * template lives in content the outer region's querySelector cannot reach. A
 * region referencing a named template (`data-template`) is a list — the shape
 * lives elsewhere in the screen. */
export function slotRegions(html: string): Slot[] {
  const out: Slot[] = [];
  type Open = { tag: string; item: boolean; slot?: Slot; list?: boolean };
  walkTags<Open>(html, (tag, attrText, stack) => {
    const { attr, has } = attrsOf(attrText);
    const item = tag === "template" && has("data-item");
    if (item) {
      for (let i = stack.length - 1; i >= 0 && stack[i].tag !== "template"; i--) {
        if (stack[i].slot !== undefined) stack[i].list = true;
      }
    }
    const table = attr("data-live");
    const open: Open = { tag, item };
    if (table !== undefined) {
      open.slot = {
        table,
        filter: attr("data-filter"),
        nested: stack.some((o) => o.item),
        // A valueless `data-empty` is the empty string in the dataset the
        // interpreter reads, so presence is what counts, not a value.
        declares: has("data-empty") || has("data-empty-row") || has("data-machine"),
      };
      open.list = attr("data-template") !== undefined;
    }
    return open;
  }, ({ slot, list }) => {
    if (slot !== undefined && list !== true) out.push(slot);
  });
  return out;
}

/** The reason a slot would render nothing without saying so, or null. Only a
 * nested one owes the declaration: a top-level slot moves the screen to `gone`
 * or `empty`, and either is a frame the reader can see. */
export function undeclaredSlot(slot: Slot): string | null {
  if (!slot.nested || slot.declares) return null;
  return "is nested and declares no empty treatment: give it data-empty, empty to mean it shows nothing, " +
    "or a data-empty-row to bind instead";
}

export type FormatBinding = {
  /** Verbatim data-text-format: a built-in, or an app renderer's basename. */
  format: string;
  /** One {placeholder} of the element's data-text, as authored. */
  expr: string;
  /** The region whose row the element binds — its own data-live, or the
   * nearest enclosing one. Absent where the element sits under none. */
  table?: string;
};

/** Every formatted binding on a screen, one per placeholder. Template content
 * is no boundary here: an item template's markup binds a row of the region
 * holding it, which is the table the stack already carries. */
export function formatBindings(html: string): FormatBinding[] {
  const out: FormatBinding[] = [];
  walkTags<{ tag: string; table?: string }>(html, (tag, attrText, stack) => {
    const { attr } = attrsOf(attrText);
    const own = attr("data-live");
    const format = attr("data-text-format");
    const text = attr("data-text");
    if (format !== undefined && text !== undefined) {
      // Its own region first, when it is one: the interpreter binds a region's
      // own data-text in that region's context, not its parent's (bindTexts is
      // handed the region as its scope and matches it).
      const table = own ?? stack.findLast((f) => f.table !== undefined)?.table;
      for (const [, expr] of text.matchAll(PLACEHOLDERS)) out.push({ format, expr, table });
    }
    return { tag, table: own };
  });
  return out;
}

/** Why a formatted binding cannot resolve what it renders, or null.
 *
 * `money` is the format that needs a declaration: the code and the minor-unit
 * scale ride the column (schema.cue #Field.money), so a binding whose column
 * this cannot find has no currency to render and would show cents as reais.
 * `number` needs nothing but the value, so it is held only to what IS
 * declared — a derived column (data-project's index, count, lanes) is a number
 * the schema never mentions, and refusing it would be a rule about the wrong
 * layer. datetime, plain and an app's own renderer resolve nothing here. */
export function formatLint(b: FormatBinding, entity: Entity | undefined): string | null {
  if (b.format !== "number" && b.format !== "money") return null;
  const column = /^\w+$/.test(b.expr) ? entity?.fields.find((f) => f.name === b.expr) : undefined;
  if (b.format === "number") {
    if (column === undefined || ["int", "bigint", "int32", "int64", "double", "decimal"].includes(column.type)) return null;
    return `data-text-format="number" reads {${b.expr}}, which is ${column.type} on "${b.table}"`;
  }
  if (b.table === undefined) {
    return `data-text-format="money" reads {${b.expr}} outside every data-live region: no row, so no column to read a currency off`;
  }
  if (entity === undefined) return null;
  if (column === undefined) {
    return `data-text-format="money" reads {${b.expr}}, which is not a column of "${b.table}": ` +
      "money is declared on the column it counts, so an embedded join, a route param or a message cannot carry one";
  }
  if (column.money === undefined) {
    return `data-text-format="money" reads {${b.expr}}, which declares no money: on "${b.table}"`;
  }
  return null;
}

export type KindedRegion = { table: string; whens: (string | undefined)[]; projects?: string[] };

/** Every region's item-template data-when list, in document order — only
 * regions owning at least one item template appear; undefined is a default
 * template. Ownership follows the interpreter's querySelectorAll: a template
 * belongs to every region between it and its nearest enclosing template,
 * because deeper content is invisible to the outer region. */
export function kindedRegions(html: string): KindedRegion[] {
  const out: KindedRegion[] = [];
  type Open = { tag: string; region?: KindedRegion };
  const stack: Open[] = [];
  // A region referencing a named template owns that template's data-when at
  // runtime; the reference resolves after the pass, once every data-name has
  // been seen. A dangling name is the interpreter's own hydrate error.
  const named = new Map<string, string | undefined>();
  const refs: { table: string; ref: string }[] = [];
  const emit = (r?: KindedRegion) => {
    if (r !== undefined && r.whens.length > 0) out.push(r);
  };
  for (const m of strip(html).matchAll(ANY_TAG)) {
    const [, closing, rawTag, attrText] = m;
    const tag = rawTag.toLowerCase();
    if (closing === "/") {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag !== tag) continue;
        for (const { region } of stack.splice(i)) emit(region);
        break;
      }
      continue;
    }
    const { attr, has } = attrsOf(attrText);
    for (const { region } of implied(stack, tag)) emit(region);
    if (tag === "template" && has("data-item")) {
      const when = attr("data-when");
      const name = attr("data-name");
      if (name !== undefined) named.set(name, when);
      for (let i = stack.length - 1; i >= 0 && stack[i].tag !== "template"; i--) {
        stack[i].region?.whens.push(when);
      }
    }
    const table = attr("data-live");
    const ref = attr("data-template");
    const project = attr("data-project");
    const open: Open = { tag };
    if (table !== undefined) {
      if (ref !== undefined) refs.push({ table, ref });
      else {
        let projects: string[] | undefined;
        if (project !== undefined) {
          try {
            const parsed = JSON.parse(project);
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              projects = Object.keys(parsed);
            }
          } catch {}
        }
        open.region = projects ? { table, whens: [], projects } : { table, whens: [] };
      }
    }
    if (VOID.has(tag) || /\/\s*$/.test(attrText)) {
      emit(open.region);
      continue;
    }
    stack.push(open);
  }
  for (const { region } of stack) emit(region);
  for (const { table, ref } of refs) {
    if (named.has(ref)) out.push({ table, whens: [named.get(ref)] });
  }
  return out;
}

/** The reasons a screen's item templates are unstampable: an item is exactly
 * one element, because stamping clones `content.firstElementChild` and the
 * interpreter refuses any other arity at hydrate. Only `template[data-item]`
 * is ever stamped — a template without it is invisible end to end — and a
 * named template goes through the same clone, so one predicate covers both.
 * Element children only: the emitter's indentation is text, and text is not
 * an item. */
export function templateArity(html: string): string[] {
  const out: string[] = [];
  type Item = { name?: string; when?: string; live?: string; children: string[] };
  type Open = { tag: string; live?: string; item?: Item };
  const stack: Open[] = [];
  const emit = (item?: Item) => {
    if (item === undefined || item.children.length === 1) return;
    // Every discriminator the screen offers, so three bad templates on one
    // screen are three distinguishable findings: a screen may hold many, and
    // an anonymous one has no other name.
    const which = `template[data-item]` +
      (item.name === undefined ? "" : `[data-name="${item.name}"]`) +
      (item.when === undefined ? "" : `[data-when="${item.when}"]`) +
      (item.live === undefined ? "" : ` in [data-live="${item.live}"]`);
    out.push(
      item.children.length === 0
        ? `${which} holds no element; an item is exactly one — give the template a single root element`
        : `${which} holds ${item.children.length} elements (${item.children.join(", ")}); ` +
          `an item is exactly one — wrap them in a single element`,
    );
  };
  for (const m of strip(html).matchAll(ANY_TAG)) {
    const [, closing, rawTag, attrText] = m;
    const tag = rawTag.toLowerCase();
    if (closing === "/") {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag !== tag) continue;
        for (const frame of stack.splice(i)) emit(frame.item);
        break;
      }
      continue;
    }
    const { attr, has } = attrsOf(attrText);
    for (const frame of implied(stack, tag)) emit(frame.item);
    stack[stack.length - 1]?.item?.children.push(tag);
    const open: Open = { tag, live: attr("data-live") ?? stack[stack.length - 1]?.live };
    if (tag === "template" && has("data-item")) {
      open.item = { name: attr("data-name"), when: attr("data-when"), live: open.live, children: [] };
    }
    if (VOID.has(tag) || /\/\s*$/.test(attrText)) {
      emit(open.item);
      continue;
    }
    stack.push(open);
  }
  for (const frame of stack) emit(frame.item);
  return out;
}

// A gesture reaches the interpreter through exactly three seams, and every
// one of them is a property of the control's ancestor-or-self chain: the form
// it submits, the region whose bindTree walks it, or the region whose machine
// listens for the event. Nothing else in a screen is a control's contract, so
// a control covered by none of the three is theatre.
const CONTROL_INPUT = new Set(["submit", "button", "reset", "image"]);
const SUBMIT_INPUT = new Set(["submit", "image"]);
const ON_ATTR = /\sdata-on-[a-z][a-z-]*=/;

/** The dom ids a region's machine keys its clicks by, or null when some click
 * key carries none — an unkeyed `click` answers every control under the
 * region. The interpreter tries `click@<id>` before `click`, where the id is
 * the pressed element's nearest ancestor-or-self carrying one, so a machine
 * keyed only by ids drops a click sent from anywhere else. An empty set is a
 * machine that answers no click at all.
 *
 * Whether the attribute is a well-formed machine is machineLint's finding, and
 * a caller must take that finding before asking this rule anything. */
const clickIds = (machine: string | undefined): Set<string> | null => {
  if (machine === undefined) return new Set();
  const parsed: unknown = JSON.parse(machine);
  // Every chart the region runs: a control is witnessed by any of them, so a
  // rule reading only the first would call a header wired to nothing while its
  // sibling chart answers the click.
  const charts = (Array.isArray(parsed) ? parsed : [parsed]) as {
    on?: Record<string, unknown>;
    states?: Record<string, { on?: Record<string, unknown> }>;
  }[];
  const ids = new Set<string>();
  let unkeyed = false;
  for (const on of charts.flatMap((m) => [m.on ?? {}, ...Object.values(m.states ?? {}).map((s) => s.on ?? {})])) {
    for (const key of Object.keys(on)) {
      const [type, id] = key.split("@");
      if (type !== "click") continue;
      if (id === undefined) unkeyed = true;
      else ids.add(id);
    }
  }
  return unkeyed ? null : ids;
};

const label = (tag: string, attr: (name: string) => string | undefined) => {
  const id = attr("id");
  const cls = attr("class");
  if (id !== undefined) return `<${tag} id="${id}">`;
  if (cls !== undefined) return `<${tag} class="${cls}">`;
  return `<${tag}>`;
};

/** The reasons a screen's controls are theatre: a button (or a button-shaped
 * input) that no seam reaches. Cover is ancestor-or-self — a region, a form,
 * and a machine host can all be the control itself. A `<summary>`, a
 * `<select>`, a bare checkbox and a native invoker (`popovertarget`,
 * `commandfor`) are the platform's own affordances and reach the interpreter
 * through nothing, so none of them is a control this rule judges. */
export function unwitnessedControls(html: string): string[] {
  const out: string[] = [];
  type Cover = {
    live: boolean;
    on: boolean;
    click: boolean;
    ids: Set<string>;
    form: boolean;
    id?: string;
  };
  type Own = { submits: boolean };
  const NONE: Cover = { live: false, on: false, click: false, ids: new Set(), form: false };
  const merge = (a: Cover, b: Cover): Cover => ({
    live: a.live || b.live,
    on: a.on || b.on,
    click: a.click || b.click,
    ids: new Set([...a.ids, ...b.ids]),
    form: a.form || b.form,
    id: a.id ?? b.id,
  });
  const reached = (c: Cover, own: Own) =>
    (c.form && own.submits) || (c.live && c.on) || c.click ||
    (c.id !== undefined && c.ids.has(c.id));
  // A named item template is stamped into whichever regions reference it by
  // data-template, and those may come later in the screen — so a control
  // inside one waits for the whole pass and is then judged against the cover
  // its stampers hand it.
  const stampers = new Map<string, Cover>();
  // HTML lets a submit control name its form by id from anywhere on the page,
  // and the submit still fires on that form — the dialog and sticky-footer
  // shape. The named form may come later in the screen, so the judgement waits.
  const actionForms = new Set<string>();
  const deferred: { names: string[]; cover: Cover; own: Own; why: string; attached?: string }[] = [];
  const stack: { tag: string; cover: Cover; names: string[] }[] = [];
  for (const m of strip(html).matchAll(ANY_TAG)) {
    const [, closing, rawTag, attrText] = m;
    const tag = rawTag.toLowerCase();
    if (closing === "/") {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag !== tag) continue;
        stack.splice(i);
        break;
      }
      continue;
    }
    const { attr, has } = attrsOf(attrText);
    implied(stack, tag);
    const top = stack[stack.length - 1];
    const outer = top === undefined ? NONE : top.cover;
    const live = attr("data-live") !== undefined;
    const keyed = live ? clickIds(attr("data-machine")) : new Set<string>();
    const cover: Cover = {
      live: outer.live || live,
      // bindTree starts AT the region and walks down, so a data-on-* binds a
      // control only from the region itself or from something inside it. One
      // above the region binds nothing, and loadHandlers still resolves the
      // module, so the screen is silent at hydrate and dead under the finger —
      // the shipped truco bug's exact shape.
      on: (outer.live ? outer.on : false) || ON_ATTR.test(` ${attrText}`),
      click: outer.click || keyed === null,
      ids: keyed === null || keyed.size === 0 ? outer.ids : new Set([...outer.ids, ...keyed]),
      form: outer.form || (tag === "form" && attr("data-action") !== undefined),
      id: attr("id") ?? outer.id,
    };
    if (tag === "form" && attr("data-action") !== undefined && attr("id") !== undefined) {
      actionForms.add(attr("id") as string);
    }
    const names = tag === "template" && has("data-item") && attr("data-name") !== undefined
      ? [...(top?.names ?? []), attr("data-name") as string]
      : top?.names ?? [];
    if (live && attr("data-template") !== undefined) {
      const ref = attr("data-template") as string;
      stampers.set(ref, merge(stampers.get(ref) ?? NONE, cover));
    }
    const type = attr("type")?.toLowerCase();
    // A control that opens a surface is wired by naming it: `commandfor` or
    // `popovertarget`. Neither writes anything, which is exactly why neither
    // is a handler this rule could otherwise find.
    const invoker = has("popovertarget") || attr("commandfor") !== undefined;
    if (!invoker && (tag === "button" || (tag === "input" && type !== undefined && CONTROL_INPUT.has(type)))) {
      // A button's default type is submit; type="button" and type="reset"
      // reach no submit listener however deep in a form they sit.
      const own: Own = {
        submits: tag === "button" ? type === undefined || type === "submit" : SUBMIT_INPUT.has(type as string),
      };
      const why = `${label(tag, attr)} is wired to nothing: no data-on-* inside a [data-live] region, ` +
        `no form[data-action] it can submit, and no enclosing region whose machine answers its click`;
      const attached = attr("form");
      if (names.length > 0 || attached !== undefined) {
        deferred.push({ names, cover, own, why, attached });
      } else if (!reached(cover, own)) out.push(why);
    }
    if (VOID.has(tag) || /\/\s*$/.test(attrText)) continue;
    stack.push({ tag, cover, names });
  }
  for (const { names, cover, own, why, attached } of deferred) {
    if (attached !== undefined && own.submits && actionForms.has(attached)) continue;
    if (!reached(names.reduce((c, n) => merge(c, stampers.get(n) ?? NONE), cover), own)) out.push(why);
  }
  return out;
}

/** The value set a column admits, or null where it admits an open set. The
 * constraint language it is read out of is the program's, not the markup's,
 * so the reader is handed in: pronto derives it from the parsed cel, the
 * tests here state it outright. Values compare as the strings a data-when
 * carries — an int enum's members stringify. */
export type EnumOf = (col: string) => string[] | null;

/** Per-kind template lint: the reason a region's data-when set is unsound, or
 * null. Every data-when must be in the translatable fragment subset and name
 * fields of the entity; every equality on an enum-carrying field must name a
 * declarable value; and for each such discriminant field, every enum value
 * must be admitted by some template unless a default (no data-when) template
 * exists — the interpreter errors on a row no template admits. */
export function kindLint(whens: (string | undefined)[], e: Entity, enumOf: EnumOf, projects?: string[]): string | null {
  const eqs: { col: string; value: string }[] = [];
  for (const w of whens) {
    if (w === undefined) continue;
    // Matched against the row itself, never interpolated (the interpreter's
    // data-when contract), so a placeholder is a dead predicate.
    if (PLACEHOLDER.test(w)) {
      return `data-when="${w}" carries a placeholder; data-when values are literals matched against the row`;
    }
    const spec: Spec = parseFilterSpec(w);
    if (spec === null) return `data-when="${w}" is outside the translatable fragment subset`;
    for (const p of spec) {
      const f = e.fields.find((f) => f.name === p.col);
      if (f === undefined && !projects?.includes(p.col)) return `data-when="${w}" names "${p.col}" — not a field of "${e.table}"`;
      if (p.op !== "eq") continue;
      if (f !== undefined) {
        const kinds = enumOf(p.col);
        if (kinds !== null && !kinds.includes(p.value as string)) {
          return `data-when="${w}": "${p.value}" is not a declarable ${p.col} (${kinds.join(", ")})`;
        }
      }
      eqs.push({ col: p.col, value: p.value as string });
    }
  }
  if (whens.includes(undefined)) return null;
  for (const col of new Set(eqs.map((q) => q.col))) {
    const field = e.fields.find((f) => f.name === col);
    // An optimistic insert carries only the submitted fields, so a
    // DB-defaulted discriminant is absent until the synced row arrives — and
    // an eq admits no row missing its column. Only a default template can
    // render the pending row (decision-offline-note-path).
    if (field?.default !== undefined) {
      return `"${col}" is DB-defaulted, so a pending row may lack it and no template would admit it; ` +
        `declare a default template`;
    }
    const kinds = enumOf(col);
    if (kinds === null) continue;
    const admitted = new Set(eqs.filter((q) => q.col === col).map((q) => q.value));
    const missing = kinds.filter((k) => !admitted.has(k));
    if (missing.length > 0) {
      return `no template admits ${col} ${missing.map((k) => `"${k}"`).join(", ")}, and no default template exists`;
    }
  }
  return null;
}

/** The slot cardinality witness: the reason a slot's read can never see two
 * rows, or the failure to say so. The witness is any pk, unique field, or
 * declared unique whose columns the filter pins with `eq`. A partial unique
 * (`where:`) counts only when the slot's filter states every constraint of
 * its predicate — only then is every visible row inside the domain the
 * uniqueness holds over.
 *
 * Returns null when witnessed, else the message naming what the filter pins
 * and what nothing covers. */
export function unwitnessedSlot(filter: string | undefined, e: Entity): string | null {
  const spec: Spec = parseFilterSpec(filter ?? "");
  const pinned = new Set((spec ?? []).filter((p) => p.op === "eq").map((p) => p.col));
  const stated = (p: { col: string; op: string; value?: string }) =>
    (spec ?? []).some((q) => q.col === p.col && q.op === p.op && q.value === p.value);
  const witnesses: string[][] = [
    ...e.fields.filter((f) => f.pk || f.unique).map((f) => [f.name]),
    ...(e.uniques ?? [])
      .filter((u) => {
        if (u.where === undefined) return true;
        const w = parseFilterSpec(u.where);
        return w !== null && w.every(stated);
      })
      .map((u) => u.cols),
  ];
  if (witnesses.some((w) => w.length > 0 && w.every((c) => pinned.has(c)))) return null;
  const pinnedText = pinned.size === 0 ? "nothing" : [...pinned].sort().join(", ");
  return `pins ${pinnedText}; no pk, unique field, or declared unique of "${e.table}" is covered`;
}

// A #Machine transition candidate's whole key set; machine.cue's close() is
// the authority (cue vet runs at generate) — this mirror is what lets the
// rule report structure findings from the same pass that checks references,
// unit-testable with no cue spawn.
const TRANSITION_KEYS = new Set(["guard", "target", "assign", "effect", "raise", "actions"]);
const ACTION_KEYS = new Set(["assign", "effect", "raise"]);
const REF_KEYS = new Set(["type", "params"]);
const EFFECT_KEYS = new Set(["level", "op", "entity", "token", "filter", "values"]);
const EFFECT_OPS = new Set(["create", "update", "delete", "upsert"]);
const EFFECT_LEVELS = new Set([
  0, 1, 2, 3, 4,
  "projection", "ephemeral", "compensable", "replicated", "exterior",
]);

/** The reason an object in a value position is not a well-formed {type,
 * params} reference (XState's spelling), or null. Strings and literals are not this rule's —
 * only the object form, whose params must be data (literals). */
const badRef = (r: unknown): string | null => {
  if (typeof r !== "object" || r === null) return null;
  const o = r as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !REF_KEYS.has(k));
  if (unknown.length > 0 || typeof o.type !== "string") {
    return `reference ${JSON.stringify(r)} is not {type, params?}`;
  }
  for (const pv of Object.values((o.params ?? {}) as Record<string, unknown>)) {
    if (typeof pv !== "string" && typeof pv !== "number" && typeof pv !== "boolean") {
      return `params of "${o.type}" carry a non-literal value — params are data`;
    }
  }
  return null;
};

const lintActions = (actions: unknown): string | null => {
  if (actions === undefined) return null;
  const list = Array.isArray(actions) ? actions : [actions];
  for (const act of list) {
    if (typeof act !== "object" || act === null) return `action ${JSON.stringify(act)} is not an object`;
    const unknown = Object.keys(act).filter((k) => !ACTION_KEYS.has(k));
    if (unknown.length > 0) {
      return `action carries ${unknown.map((k) => `"${k}"`).join(", ")} — outside the #Action subset`;
    }
    const a = act as { assign?: Record<string, unknown>; effect?: unknown; raise?: unknown };
    for (const r of Object.values(a.assign ?? {})) {
      const why = badRef(r);
      if (why !== null) return why;
    }
    if (a.effect !== undefined) {
      const effects = Array.isArray(a.effect) ? a.effect : [a.effect];
      for (const eff of effects) {
        if (typeof eff !== "object" || eff === null) return `effect ${JSON.stringify(eff)} is not an object`;
        const effUnknown = Object.keys(eff).filter((k) => !EFFECT_KEYS.has(k));
        if (effUnknown.length > 0) {
          return `effect carries ${effUnknown.map((k) => `"${k}"`).join(", ")} — outside the #Effect subset`;
        }
        const e = eff as { op?: unknown; level?: unknown; values?: Record<string, unknown> };
        if (typeof e.op !== "string" || !EFFECT_OPS.has(e.op)) {
          return `effect op ${JSON.stringify(e.op)} is not in ${[...EFFECT_OPS].join(" | ")}`;
        }
        if (e.level !== undefined && !EFFECT_LEVELS.has(e.level as any)) {
          return `effect level ${JSON.stringify(e.level)} is not in ${[...EFFECT_LEVELS].join(" | ")}`;
        }
        for (const r of Object.values(e.values ?? {})) {
          const why = badRef(r);
          if (why !== null) return why;
        }
      }
    }
  }
  return null;
};

type StateNode = {
  field?: string;
  type?: string;
  initial?: string;
  on?: Record<string, unknown>;
  onDone?: unknown;
  always?: unknown;
  after?: Record<string, unknown>;
  entry?: unknown;
  exit?: unknown;
  states?: Record<string, StateNode>;
};

type Machine = {
  field?: string;
  type?: string;
  initial?: string;
  context?: Record<string, unknown>;
  on?: Record<string, unknown>;
  onDone?: unknown;
  always?: unknown;
  after?: Record<string, unknown>;
  entry?: unknown;
  exit?: unknown;
  states: Record<string, StateNode>;
};

function collectValues(state: StateNode): unknown[] {
  const vals: unknown[] = [
    ...Object.values(state.on ?? {}),
    ...Object.values(state.after ?? {}),
  ];
  if (state.always !== undefined) vals.push(state.always);
  if (state.onDone !== undefined) vals.push(state.onDone);
  if (state.states) {
    for (const sub of Object.values(state.states)) {
      vals.push(...collectValues(sub));
    }
  }
  return vals;
}

function collectStateActions(state: StateNode): unknown[] {
  const acts: unknown[] = [];
  if (state.entry !== undefined) acts.push(state.entry);
  if (state.exit !== undefined) acts.push(state.exit);
  if (state.states) {
    for (const sub of Object.values(state.states)) {
      acts.push(...collectStateActions(sub));
    }
  }
  return acts;
}

/** Machine lint: the reason a data-machine's leaves or cascade are unsound,
 * or null. References (guards, non-numeric after keys) must name modules in
 * `available`; every raised type must be handled by some state or root `on:`
 * (the cascade stays drawable); context never carries the machine's own
 * field — one fact, one writer. */
export function machineLint(machine: Machine, available: Set<string>): string | null {
  const values: unknown[] = [
    ...Object.values(machine.on ?? {}),
    ...Object.values(machine.states ?? {}).flatMap(collectValues),
  ];
  if (machine.onDone !== undefined) values.push(machine.onDone);
  for (const v of values) {
    for (const c of machineCandidates(v)) {
      if (typeof c !== "object" || c === null) return `transition ${JSON.stringify(c)} is neither a target nor a candidate`;
      const unknown = Object.keys(c).filter((k) => !TRANSITION_KEYS.has(k));
      if (unknown.length > 0) {
        return `transition carries ${unknown.map((k) => `"${k}"`).join(", ")} — outside the #Machine subset`;
      }
      const cand = c as { guard?: unknown; assign?: Record<string, unknown>; effect?: unknown; actions?: unknown };
      for (const r of [cand.guard, ...Object.values(cand.assign ?? {})]) {
        const why = badRef(r);
        if (why !== null) return why;
      }
      if (cand.actions !== undefined) {
        const why = lintActions(cand.actions);
        if (why !== null) return why;
      }
      if (cand.effect !== undefined) {
        const effects = Array.isArray(cand.effect) ? cand.effect : [cand.effect];
        for (const eff of effects) {
          if (typeof eff !== "object" || eff === null) return `effect ${JSON.stringify(eff)} is not an object`;
          const effUnknown = Object.keys(eff).filter((k) => !EFFECT_KEYS.has(k));
          if (effUnknown.length > 0) {
            return `effect carries ${effUnknown.map((k) => `"${k}"`).join(", ")} — outside the #Effect subset`;
          }
          const e = eff as { op?: unknown; level?: unknown; values?: Record<string, unknown> };
          if (typeof e.op !== "string" || !EFFECT_OPS.has(e.op)) {
            return `effect op ${JSON.stringify(e.op)} is not in ${[...EFFECT_OPS].join(" | ")}`;
          }
          if (e.level !== undefined && !EFFECT_LEVELS.has(e.level as any)) {
            return `effect level ${JSON.stringify(e.level)} is not in ${[...EFFECT_LEVELS].join(" | ")}`;
          }
          for (const r of Object.values(e.values ?? {})) {
            const why = badRef(r);
            if (why !== null) return why;
          }
        }
      }
    }
  }
  for (const act of Object.values(machine.states ?? {}).flatMap(collectStateActions)) {
    const why = lintActions(act);
    if (why !== null) return why;
  }
  const shape = machineShape(machine) as ReturnType<typeof machineShape> & { effects?: { level?: unknown; entity?: string }[] };
  for (const eff of shape.effects ?? []) {
    if (eff.level === 2 || eff.level === "compensable") {
      if (!shape.handled.includes("refused")) {
        return `compensable effect on "${eff.entity ?? "entity"}" requires "refused" transition in machine to handle server conflict/rollback`;
      }
    }
  }
  const dangling = shape.refs.filter((r) => !available.has(r));
  if (dangling.length > 0) {
    return `${dangling.map((r) => `"${r}"`).join(", ")} name no module under shell/handlers/`;
  }
  const unraisable = shape.raises.filter((r) => !shape.handled.includes(r));
  if (unraisable.length > 0) {
    return `raise ${unraisable.map((r) => `"${r}"`).join(", ")} is handled by no state or root on: — the cascade has an undrawn arrow`;
  }
  if (machine.context !== undefined && machine.field && machine.field in machine.context) {
    return `context carries the machine's own field "${machine.field}" — one fact, one writer (initial: is the declaration)`;
  }
  return null;
}

export type Write = { col: string; value: string | number | boolean };

/** Every literal a machine region persists into a column: the machine's
 * context, its assign literals, and the data-empty-row — a transition
 * concluding from the synthesized fallback row restates that row verbatim, so
 * its values are written, not merely bound. A `{type, params}` assign is a
 * module's return, which nothing declares a type for; it carries no literal
 * and this rule may not judge it. */
export function machineWrites(machine: Machine, emptyRow?: string): Write[] {
  const out: Write[] = [];
  const push = (col: string, value: unknown) => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out.push({ col, value });
    }
  };
  if (emptyRow !== undefined) {
    for (const [k, v] of Object.entries(JSON.parse(emptyRow) as Record<string, unknown>)) push(k, v);
  }
  for (const [k, v] of Object.entries(machine.context ?? {})) push(k, v);
  const values: unknown[] = [
    ...Object.values(machine.on ?? {}),
    ...Object.values(machine.states ?? {}).flatMap(collectValues),
  ];
  if (machine.field !== undefined && machine.initial !== undefined) {
    push(machine.field, machine.initial);
  }
  for (const v of values) {
    for (const c of machineCandidates(v)) {
      const assign = (c as { assign?: Record<string, unknown> }).assign ?? {};
      for (const [k, av] of Object.entries(assign)) push(k, av);
      const target = (c as { target?: unknown }).target;
      if (target !== undefined && machine.field !== undefined) push(machine.field, target);
    }
  }
  for (const act of Object.values(machine.states ?? {}).flatMap(collectStateActions)) {
    const list = Array.isArray(act) ? act : [act];
    for (const a of list) {
      if (typeof a === "object" && a !== null) {
        const assign = (a as { assign?: Record<string, unknown> }).assign ?? {};
        for (const [k, av] of Object.entries(assign)) push(k, av);
      }
    }
  }
  return out;
}

// A tab or device row is built by a local factory and read back from it, so
// the JS value a writer spelled is the value every later reader compares
// against. The rule is scoped to those two durabilities; what a crud, live or
// offline row settles to is the server's answer and not a fact about the markup.
const BROWSER_TIERS = new Set(["tab", "device"]);
// The types whose one value has two JS spellings — a number and its decimal
// string, a boolean and "true"/"false". Every other type has exactly one, so
// a non-string written into it is not a second spelling but a second type.
const TWO_SPELLINGS = new Set(["int", "bigint", "int32", "double", "bool"]);

/** Column-spelling consistency over the writes a screen's markup declares:
 * the reason a browser-owned entity's regions write one column in more than one
 * JS spelling, or write a non-string into a column whose type has only the
 * string spelling, or null. This rule judges spelling and nothing else — it
 * never asks whether a value is in the column's range.
 *
 * Comparisons downstream are strict — a machine's expectState, a maintained
 * view's `is.` predicate, an app fold's guard — so a column spelled two ways
 * disowns half its own rows with no error anywhere. */
export function writeLint(writes: Write[], e: Entity): string | null {
  if (!BROWSER_TIERS.has(e.durability)) return null;
  for (const col of new Set(writes.map((w) => w.col))) {
    const field = e.fields.find((f) => f.name === col);
    if (field === undefined) return `a machine region writes "${col}" — not a field of "${e.table}"`;
    const values = writes.filter((w) => w.col === col).map((w) => w.value);
    const tier = `"${e.durability}" entity`;
    const spellings = new Set(values.map((v) => typeof v));
    if (spellings.size > 1) {
      const shown = [...new Set(values.map((v) => JSON.stringify(v)))].join(", ");
      return `"${col}" is written in ${spellings.size} spellings (${shown}), and a ${tier} passes through ` +
        `no Postgres to reconcile them — a strict compare against any one of them disowns the rows ` +
        `carrying the others; spell every write of a column the same way`;
    }
    if (TWO_SPELLINGS.has(field.type)) continue;
    const bad = values.find((v) => typeof v !== "string");
    if (bad === undefined) continue;
    return `"${col}" is ${field.type}, and a machine region writes ${JSON.stringify(bad)} — ` +
      `a ${tier} passes through no Postgres to coerce it; write it as a string`;
  }
  return null;
}

/** A route as the link rule needs it: the screen a link names it by, and the
 * pattern its `:param` holes are read off. */
export type LinkRoute = { screen: string; path: string };

/** The `:param` holes of a pattern, in order. */
const holesOf = (pattern: string): string[] =>
  pattern.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1));

/**
 * An internal link says which ROUTE it goes to, never which path.
 *
 * A path written by hand is one spelling of a URL that now has one per locale,
 * so `href="/regras"` sends a Spanish reader to the Portuguese document, and
 * `href="#/regras"` names an address the server never sees at all. The
 * vocabulary is `data-route` naming a route's screen plus one
 * `data-param-<name>` per hole; the binder composes the href from the route
 * table and the page's active locale.
 *
 * An in-page fragment (`href="#top"`), an external URL — absolute or
 * protocol-relative, whose `//host` is another origin rather than a path of
 * this one — `mailto:` and `tel:` address something other than a route and stay
 * legal.
 *
 * Only the FIRST segment of a pattern is translated, so the authored pattern
 * answers for the holes in every locale and this rule needs no catalogue.
 */
export function linkLint(html: string, routes: LinkRoute[]): string[] {
  const out: string[] = [];
  const byScreen = new Map(routes.map((r) => [r.screen, r]));
  for (const [, closing, tag, attrText] of strip(html).matchAll(ANY_TAG)) {
    if (closing === "/") continue;
    const { attr } = attrsOf(attrText);
    const href = attr("href");
    // One leading slash is a path of this origin; two are an authority, so
    // "//cdn.example.test/x" is somebody else's site written without a scheme.
    if (href !== undefined && ((href.startsWith("/") && !href.startsWith("//")) || href.startsWith("#/"))) {
      out.push(
        `<${tag.toLowerCase()} href="${href}"> writes an internal path by hand: a route has one address per ` +
          `locale, so name it with data-route and let the binder compose the href`,
      );
    }
    const screen = attr("data-route");
    if (screen === undefined) continue;
    // A row names the route — a navigation rail whose items are rows. Which
    // route it will be is not decidable here, and neither are its holes;
    // routeHref refuses a name no route answers when the region binds.
    if (PLACEHOLDER.test(screen)) continue;
    const route = byScreen.get(screen);
    if (route === undefined) {
      out.push(`data-route="${screen}" names no route in shell.yaml`);
      continue;
    }
    const holes = holesOf(route.path);
    const given = new Set<string>();
    for (const [, name] of ` ${attrText}`.matchAll(ATTR)) {
      if (name.startsWith("data-param-")) given.add(name.slice("data-param-".length));
    }
    for (const hole of holes) {
      if (!given.has(hole)) out.push(`data-route="${screen}" fills no :${hole} of "${route.path}"`);
    }
    for (const name of given) {
      if (holes.includes(name)) continue;
      out.push(`data-param-${name} on data-route="${screen}" names no :param of "${route.path}"`);
    }
  }
  return out;
}
