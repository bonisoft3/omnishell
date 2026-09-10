// The terminal's markup rules: what a screen's data-* vocabulary may say,
// stated beside the vocabulary itself (fragment.js) so the plugin that
// publishes the grammar also publishes its rules. pronto's derive.ts
// orchestrates these per app; the terminal's own tests exercise them here —
// nothing in this file touches the filesystem or an app.

import { machineCandidates, machineShape, parseFilterSpec, parseReadSpec } from "./fragment.js";

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
): { tables: string[]; handlers: string[]; filters: { table: string; filter: string }[] } {
  const tables = new Set<string>();
  const handlers = new Set<string>();
  const filters: { table: string; filter: string }[] = [];
  for (const [, closing, , attrText] of strip(html).matchAll(ANY_TAG)) {
    if (closing === "/") continue;
    const attrs = new Map<string, string>();
    for (const [, name, dq, sq] of ` ${attrText}`.matchAll(ATTR)) attrs.set(name, decode(dq ?? sq));
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
      } else if (name === "data-handler" || name.startsWith("data-on-")) handlers.add(value);
    }
    const filter = attrs.get("data-filter");
    if (filter !== undefined) {
      const table = attrs.get("data-live") ?? attrs.get("data-entity");
      if (table === undefined) throw new Error(`data-filter="${filter}" on a tag with no data-live or data-entity`);
      filters.push({ table, filter });
    }
  }
  return { tables: [...tables].sort(), handlers: [...handlers].sort(), filters };
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

export type ParamPlan = { route: string; param: string; table: string; column: string; op: string };

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
        const found = { route: route.path, param, table, column: m[1], op: m[2] };
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
};

/** Every data-machine region in one screen's markup, with the attributes its
 * validity depends on. Single-quoted values are the norm here — a machine is
 * JSON, whose own quotes are double. A machine is read from `region.dataset`
 * and from nowhere else, so a data-machine off a region binds nothing: a
 * precondition, not a shape this rule may guess at. */
export function machineRegions(html: string): MachineRegion[] {
  const out: MachineRegion[] = [];
  for (const [, closing, , attrText] of strip(html).matchAll(ANY_TAG)) {
    if (closing === "/") continue;
    const { attr } = attrsOf(attrText);
    const machine = attr("data-machine");
    if (machine === undefined) continue;
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
    const parallel = (Array.isArray(parsed) ? parsed : [parsed]).map((c) => JSON.stringify(c));
    for (const one of parallel) {
      out.push({ table, machine: one, parallel, emptyRow: attr("data-empty-row"), filter: attr("data-filter") });
    }
  }
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
    for (const col of [chart.field, ...machineWrites(chart, undefined).map((w) => w.col)]) {
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

export type Slot = { table: string; filter?: string };

/** Every slot — a `data-live` region with no `template[data-item]` where the
 * interpreter's querySelector would see one — with the filter its cardinality
 * depends on. Template content is a boundary exactly as it is in the DOM: an
 * item template marks only the regions between it and its nearest enclosing
 * template, because a deeper template lives in content the outer region's
 * querySelector cannot reach. A region referencing a named template
 * (`data-template`) is a list — the shape lives elsewhere in the screen. */
export function slotRegions(html: string): Slot[] {
  const out: Slot[] = [];
  type Open = { tag: string; slot?: { table: string; filter?: string; list: boolean } };
  const stack: Open[] = [];
  for (const m of strip(html).matchAll(ANY_TAG)) {
    const [, closing, rawTag, attrText] = m;
    const tag = rawTag.toLowerCase();
    if (closing === "/") {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag !== tag) continue;
        for (const { slot } of stack.splice(i)) {
          if (slot !== undefined && !slot.list) out.push({ table: slot.table, filter: slot.filter });
        }
        break;
      }
      continue;
    }
    const { attr, has } = attrsOf(attrText);
    for (const { slot } of implied(stack, tag)) {
      if (slot !== undefined && !slot.list) out.push({ table: slot.table, filter: slot.filter });
    }
    if (tag === "template" && has("data-item")) {
      for (let i = stack.length - 1; i >= 0 && stack[i].tag !== "template"; i--) {
        const slot = stack[i].slot;
        if (slot !== undefined) slot.list = true;
      }
    }
    const table = attr("data-live");
    const open: Open = { tag };
    if (table !== undefined) {
      open.slot = { table, filter: attr("data-filter"), list: attr("data-template") !== undefined };
    }
    if (VOID.has(tag) || /\/\s*$/.test(attrText)) {
      if (open.slot !== undefined && !open.slot.list) out.push({ table: open.slot.table, filter: open.slot.filter });
      continue;
    }
    stack.push(open);
  }
  for (const { slot } of stack) {
    if (slot !== undefined && !slot.list) out.push({ table: slot.table, filter: slot.filter });
  }
  return out;
}

export type KindedRegion = { table: string; whens: (string | undefined)[] };

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
    const open: Open = { tag };
    if (table !== undefined) {
      if (ref !== undefined) refs.push({ table, ref });
      else open.region = { table, whens: [] };
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
    // A control that opens a surface is wired by naming it, whichever gesture
    // does the opening: `commandfor` on activation, `data-interest` on hover or
    // focus. Neither writes anything, which is exactly why neither is a handler
    // this rule could otherwise find.
    const invoker = has("popovertarget") || attr("commandfor") !== undefined ||
      attr("data-interest") !== undefined;
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
export function kindLint(whens: (string | undefined)[], e: Entity, enumOf: EnumOf): string | null {
  const eqs: { col: string; value: string }[] = [];
  for (const w of whens) {
    if (w === undefined) continue;
    // Matched against the row itself, never interpolated (the interpreter's
    // data-when contract), so a placeholder is a dead predicate.
    if (/\{[\w.]+\}/.test(w)) {
      return `data-when="${w}" carries a placeholder; data-when values are literals matched against the row`;
    }
    const spec: Spec = parseFilterSpec(w);
    if (spec === null) return `data-when="${w}" is outside the translatable fragment subset`;
    for (const p of spec) {
      const f = e.fields.find((f) => f.name === p.col);
      if (f === undefined) return `data-when="${w}" names "${p.col}" — not a field of "${e.table}"`;
      if (p.op !== "eq") continue;
      const kinds = enumOf(p.col);
      if (kinds !== null && !kinds.includes(p.value as string)) {
        return `data-when="${w}": "${p.value}" is not a declarable ${p.col} (${kinds.join(", ")})`;
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
const TRANSITION_KEYS = new Set(["guard", "target", "assign", "raise"]);
const REF_KEYS = new Set(["type", "params"]);

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

type Machine = {
  field: string;
  initial: string;
  context?: Record<string, unknown>;
  on?: Record<string, unknown>;
  states: Record<string, { on?: Record<string, unknown>; after?: Record<string, unknown> }>;
};

/** Machine lint: the reason a data-machine's leaves or cascade are unsound,
 * or null. References (guards, non-numeric after keys) must name modules in
 * `available`; every raised type must be handled by some state or root `on:`
 * (the cascade stays drawable); context never carries the machine's own
 * field — one fact, one writer. */
export function machineLint(machine: Machine, available: Set<string>): string | null {
  const values: unknown[] = [
    ...Object.values(machine.on ?? {}),
    ...Object.values(machine.states).flatMap((s) => [
      ...Object.values(s.on ?? {}),
      ...Object.values(s.after ?? {}),
    ]),
  ];
  for (const v of values) {
    for (const c of machineCandidates(v)) {
      if (typeof c !== "object" || c === null) return `transition ${JSON.stringify(c)} is neither a target nor a candidate`;
      const unknown = Object.keys(c).filter((k) => !TRANSITION_KEYS.has(k));
      if (unknown.length > 0) {
        return `transition carries ${unknown.map((k) => `"${k}"`).join(", ")} — outside the #Machine subset`;
      }
      const cand = c as { guard?: unknown; assign?: Record<string, unknown> };
      for (const r of [cand.guard, ...Object.values(cand.assign ?? {})]) {
        const why = badRef(r);
        if (why !== null) return why;
      }
    }
  }
  const shape = machineShape(machine);
  const dangling = shape.refs.filter((r) => !available.has(r));
  if (dangling.length > 0) {
    return `${dangling.map((r) => `"${r}"`).join(", ")} name no module under shell/handlers/`;
  }
  const unraisable = shape.raises.filter((r) => !shape.handled.includes(r));
  if (unraisable.length > 0) {
    return `raise ${unraisable.map((r) => `"${r}"`).join(", ")} is handled by no state or root on: — the cascade has an undrawn arrow`;
  }
  if (machine.context !== undefined && machine.field in machine.context) {
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
    ...Object.values(machine.states).flatMap((s) => [
      ...Object.values(s.on ?? {}),
      ...Object.values(s.after ?? {}),
    ]),
  ];
  // The state IS a column: initial: seeds it and every target restates it, so
  // a machine whose arrows spell it one way and whose assigns spell it another
  // writes the column the rule exists to watch — and expectState compares it
  // strictly on every step.
  push(machine.field, machine.initial);
  for (const v of values) {
    for (const c of machineCandidates(v)) {
      const assign = (c as { assign?: Record<string, unknown> }).assign ?? {};
      for (const [k, av] of Object.entries(assign)) push(k, av);
      const target = (c as { target?: unknown }).target;
      if (target !== undefined) push(machine.field, target);
    }
  }
  return out;
}

// A tab or device row is built by a local factory and read back from it, so
// the JS value a writer spelled is the value every later reader compares
// against. The rule is scoped to those two tiers; what a crud, live or offline
// row settles to is the server's answer and not a fact about the markup.
const BROWSER_TIERS = new Set(["tab", "device"]);
// The types whose one value has two JS spellings — a number and its decimal
// string, a boolean and "true"/"false". Every other type has exactly one, so
// a non-string written into it is not a second spelling but a second type.
const TWO_SPELLINGS = new Set(["int", "bigint", "bool"]);

/** The answers a region's projection supplies, by name. Unparseable is this
 * pass's finding rather than the runtime's: every other reader of the markup
 * would go on to judge the region against a projection it could not read. */
const clausesOf = (project: string | undefined): string[] => {
  if (project === undefined) return [];
  try {
    return Object.keys(JSON.parse(project));
  } catch {
    throw new Error(`data-project is not JSON: ${project}`);
  }
};

export type StopRegion =
  { table: string; columns: string[]; machine?: string; projected: string[]; outer?: string };

/** Every region declaring tabstops or focus targets under `attr`, with the
 * names its members bind, the answers its projection supplies and the chart it
 * runs. A region owns the members under it, so the scan needs the nesting the
 * interpreter's `ownedBy` answers at runtime — the innermost open `data-live`
 * is whose set a member joins, and the elements between are markup.
 *
 * A member sits under whatever the skin wraps it in — a cell, a list item, a
 * group — so the search is for the nearest REGION and never the nearest tag. */
type OpenStop = {
  table?: string;
  machine?: string;
  columns: string[];
  projected: string[];
  outer?: string;
  template?: string;
};

// A template the screen keeps by name, for the regions that render through one.
// Named because their region re-hydrates and a render sweeps every child that
// is not one of its rows — so the members are declared OUTSIDE the region they
// belong to, and a scan reading the markup's nesting alone would find none.
const NAMED_TEMPLATE = /<template\b[^>]*\sdata-name="([^"]*)"[^>]*>([\s\S]*?)<\/template>/g;

export function stopRegions(html: string, attr: "data-rove" | "data-focus"): StopRegion[] {
  const bare = strip(html);
  const named = new Map<string, string>();
  for (const [, name, body] of bare.matchAll(NAMED_TEMPLATE)) named.set(name, body);
  // Removed before the walk, and reached only through the region that names
  // one: a named template at the top of a screen belongs to no region where it
  // is written, and to the region that renders it where it is rendered.
  return walkStops(bare.replace(NAMED_TEMPLATE, ""), attr, named);
}

/** `root` is a region already open — the walk of a template body a region
 * renders, whose top-level members are that region's. The caller owns it and
 * emits it; this pass only fills it in. */
function walkStops(
  html: string,
  attr: "data-rove" | "data-focus",
  named: Map<string, string>,
  root?: OpenStop,
): StopRegion[] {
  const out: StopRegion[] = [];
  const open: OpenStop[] = root === undefined ? [] : [root];
  const close = (done: OpenStop) => {
    if (done.template !== undefined) {
      const body = named.get(done.template);
      if (body === undefined) {
        throw new Error(`data-template names "${done.template}", which no <template data-name> declares`);
      }
      out.push(...walkStops(body, attr, named, done));
    }
    if (done.table !== undefined && done.columns.length > 0) {
      out.push({
        table: done.table,
        columns: done.columns,
        machine: done.machine,
        projected: done.projected,
        outer: done.outer,
      });
    }
  };
  for (const [, closing, tag, attrText] of html.matchAll(ANY_TAG)) {
    if (closing === "/") {
      const done = open.pop();
      if (done !== undefined && done !== root) close(done);
      continue;
    }
    const { attr: read } = attrsOf(attrText);
    const table = read("data-live");
    const member = read(attr);
    if (member !== undefined) {
      const col = /^\{([\w.]+)\}$/.exec(member)?.[1];
      const held = open.findLast((o) => o.table !== undefined);
      if (col !== undefined && held !== undefined) held.columns.push(col);
    }
    if (VOID.has(tag) || /\/\s*$/.test(attrText)) continue;
    open.push({
      table,
      machine: read("data-machine"),
      columns: [],
      projected: clausesOf(read("data-project")),
      outer: open.findLast((o) => o.table !== undefined)?.table,
      template: read("data-template"),
    });
  }
  return out;
}

/** The reason a region's caret is one a second reader could move, or null.
 *
 * The terminal moves focus when the caret MOVES, and a move carries no account
 * of who caused it — deliberately, since a cause the rows do not hold is state
 * no trace records and no snapshot restores. That is exact while the column has
 * one writer, and the reader IS that writer only where the row is theirs: a
 * `tab` or `device` row is the browser's own, while a `crud` or `live` row is
 * one anybody sharing it can write, and their write would land here as this
 * reader's focus jumping. */
function caretLint(region: StopRegion, e: Entity, outer: Entity | undefined, what: string): string | null {
  for (const col of region.columns) {
    if (region.projected.includes(col) || e.fields.some((f) => f.name === col)) continue;
    return `${what} binds "${col}" — not a field of "${e.table}", and not an answer its projection supplies`;
  }
  // A projected caret is one the region computes over the rows it holds, so
  // nothing writes it — but the projection compares against the row it is
  // nested in, and THAT row is what moves the caret. So the tier question is
  // asked of the enclosing region too, and a member set is only as private as
  // the least private row deciding which of its members is current.
  const owns = region.columns.some((c) => region.projected.includes(c)) && outer !== undefined
    ? [e, outer]
    : [e];
  for (const held of owns) {
    if (BROWSER_TIERS.has(held.durability)) continue;
    return `${what} follows a "${held.durability}" table ("${held.table}"), whose rows another reader can write — ` +
      `their move would take this reader's focus; a caret follows a ` +
      `"${[...BROWSER_TIERS].join('" or "')}" row, which is the reader's own`;
  }
  return null;
}

export const roveLint = (region: StopRegion, e: Entity, outer?: Entity): string | null =>
  caretLint(region, e, outer, "data-rove");

/** As above, and one more: a focus target must hear `focusin`.
 *
 * `data-rove` owns the tab order, so the terminal can tell a move it made from
 * a refresh it did not. `data-focus` owns nothing, so its only reading of "the
 * reader is on the wrong member" is the DOM's own focus — and a reader who
 * Tabbed there would be dragged back on the next refresh, forever, unless their
 * move writes the column too. `focusin` is what writes it, and a chart that
 * does not draw it turns this into a focus-stealing loop. */
export function focusLint(region: StopRegion, e: Entity, outer?: Entity): string | null {
  const why = caretLint(region, e, outer, "data-focus");
  if (why !== null) return why;
  // Every chart the region runs, since a region may run several and which one
  // hears the reader is the region's business rather than this rule's.
  const parsed = region.machine === undefined ? [] : JSON.parse(region.machine);
  const charts = Array.isArray(parsed) ? parsed : [parsed];
  if (!charts.some((c) => machineShape(c).handled.includes("focusin"))) {
    return `data-focus without a chart hearing "focusin": every affordance stays in the Tab sequence, so a ` +
      `reader can put focus on a member the column does not name, and every refresh would drag them back — ` +
      `draw the arrow that records where they went`;
  }
  return null;
}

/** Column-spelling consistency over the writes a screen's markup declares:/** Column-spelling consistency over the writes a screen's markup declares:
 * the reason a browser-tier entity's regions write one column in more than one
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
