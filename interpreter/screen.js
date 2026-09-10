// Screen interpreter: hydrates one emitted screen (HTML + CSS) against the
// store. The binding vocabulary is the pronto SPEC's; the shell owns every
// effect and the whole state machine — screens only style states.
import { renderInto } from "./render.js";
import { mountHatch } from "./hatch.js";
import { machineCandidates, machineShape, parseFilter, parseFilterSpec, parseReadSpec } from "./fragment.js";
import { evaluateRole } from "./jessie.js";

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.text();
}

// A slot read that matched more than one row. Its own type so the outage
// guard can tell a broken cardinality invariant from a dead gateway.
/** A broken invariant rather than an outage: no retry repairs it, and the
 * network-error dressing would say the store is down when the program is
 * wrong. Everything under this is rethrown past the outage guard. */
export class ProgramError extends Error {}
export class SlotCardinalityError extends ProgramError {}
export class KindAdmissionError extends ProgramError {}
// A row hydrating inside its own shape. Its own type so the outage guard can
// tell cyclic data from a dead gateway.
export class TemplateCycleError extends ProgramError {}
// A malformed data-project. Its own type for the same reason: a nested region
// hydrates inside its parent's refresh, so the outage guard would otherwise
// dress a wrong program as a dead gateway and retry it on a backoff forever.
export class ProjectionError extends ProgramError {}
// A data-key naming a key outside APG's set, or a form that is not one.
export class KeyBindingError extends ProgramError {}
// A data-order whose closed map is malformed, or whose column named an order
// the map does not carry.
export class OrderError extends ProgramError {}

// The terminal's own generator, seeded from the URL when one asks. Every draw
// an app makes comes through here, so a replay is a property of the terminal
// rather than something each app has to arrange.
const params = new URLSearchParams(globalThis.location?.search ?? "");
// How fast the terminal's clock runs. A reduce says how long to wait in the
// table's own seconds; ?tempo= says how many of those go by in one of ours.
// Shortening a wait is not the same as removing one: a mutation landing while
// a chain waits is the whole shape of the bug this bounds, and it still lands
// inside a tenth of a beat. Removing the wait would take the window with it.
const TEMPO = Math.min(50, Math.max(1, Number(params.get("tempo")) || 1));

// A clock something else can hold. Under ?clock=manual no wait comes due on
// its own: it joins a queue, and whoever holds the clock says when time has
// passed. A driver that owns the clock never samples a state it has already
// missed and never waits real seconds for one it has not reached — and the
// waits themselves stay, so a mutation landing while a chain is waiting still
// lands there.
const MANUAL = params.get("clock") === "manual";
const pending = new Set();
let held = 0;

// How much the terminal still has in flight, for a driver outside the page.
//
// Without it the only question a driver can ask is "has the DOM stopped
// changing", which is a guess in both directions: it cannot tell a screen that
// has finished from one between two refreshes, and it sees nothing at all of a
// repaint or a wait that has not come due. The terminal knows both exactly —
// `regions` is refreshes running now, `waits` the delays it is holding — so it
// says so rather than leaving a caller to sleep for a number.
//
// Reported always, not only under a held clock: a driver on the real clock
// still wants to know when a refresh has landed. Under `?clock=manual` the two
// numbers together are the whole answer, because nothing becomes due that a
// caller did not advance to.
//
// `waits` counts TIMERS THE CLOCK HOLDS and not arrows still to fire: a state
// re-entered by its own refresh arms a second one, and the generation mark
// kills the first when it comes due. So the number a driver can act on is
// zero-or-not, and reading it as "transitions pending" would count a wait that
// exists only to be discarded.
let busy = 0;
globalThis.__prontoBusy = () => ({ regions: busy, waits: pending.size });
if (MANUAL) {
  globalThis.__prontoClock = {
    // Returns how many waits are still outstanding, so a caller can tell a
    // table that is thinking from one that has stopped.
    advance(ms) {
      held += ms;
      for (const w of [...pending]) {
        if (w.at > held) continue;
        pending.delete(w);
        w.fire();
      }
      return pending.size;
    },
  };
}
const rest = (ms) =>
  MANUAL
    ? new Promise((fire) => pending.add({ at: held + ms, fire }))
    : new Promise((resolve) => setTimeout(resolve, ms));
// The clock the screen reads, not the one the host runs: a held clock answers
// from where the caller advanced it, so a row stamped {now} lands on the same
// instant in every run. `?epoch` names that start; unset it starts at zero.
const epoch = params.get("epoch");
const now = () => {
  if (!MANUAL) return new Date(Date.now()).toISOString();
  // A held clock with no start would stamp 1970, which reads as a fixture
  // mistake rather than a missing knob — so the screen says which it is.
  if (epoch === null) throw new Error("a held clock stamps {now} only from an ?epoch");
  return new Date(Date.parse(epoch) + held).toISOString();
};
const seeded = params.get("seed");
let entropy = seeded === null ? 0 : Number(seeded) >>> 0;
const draw = () => {
  if (seeded === null) return crypto.getRandomValues(new Uint32Array(1))[0];
  entropy = (entropy + 0x6D2B79F5) >>> 0;
  let t = Math.imul(entropy ^ (entropy >>> 15), 1 | entropy);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
};

const HAS_PLACEHOLDER = /\{[\w.]+\}/;
const PLACEHOLDER = /\{([\w.]+)\}/g;


// Every role resolves the same way: the attribute names the role, its value
// names the module, and route.files.handlers is the app's list of Jessie
// sources whatever role each one plays.
async function loadRole(screen, appBase, route, attr, role) {
  const loaded = new Map();
  for (const el of screen.querySelectorAll(`[${attr}]`)) {
    const name = el.getAttribute(attr);
    if (loaded.has(name)) continue;
    const path = route.files.handlers.find((p) => p.split("/").pop() === `${name}.js`);
    if (!path) throw new Error(`no Jessie module for ${attr}="${name}"`);
    loaded.set(name, await evaluateRole(await fetchText(new URL(path, appBase)), role));
  }
  return loaded;
}

// data-on-<dom-event>="<declared handler>". The event name is the DOM's, so
// there is no vocabulary of ours to keep and no allow-list to maintain: the
// check is that the name is an event and that the handler is declared. The
// value is a REFERENCE and never a body, which is what keeps the assembly
// lintable and the reduce pure — an inline on<event> would be neither.
const onAttrs = (el) =>
  [...el.attributes]
    .filter((a) => a.name.startsWith("data-on-"))
    .map((a) => ({ event: a.name.slice("data-on-".length), name: a.value }));

async function loadHandlers(screen, appBase, route) {
  const loaded = await loadRole(screen, appBase, route, "data-handler", "handler");
  // The same modules, reached by the other spelling. An item's handler lives in
  // a template, whose markup is never in the screen's own tree.
  for (const scope of withTemplates(screen)) {
    for (const el of scope.querySelectorAll("*")) {
      for (const { name } of onAttrs(el)) {
        if (loaded.has(name)) continue;
        const path = route.files.handlers.find((f) => f.split("/").pop() === `${name}.js`);
        if (!path) throw new Error(`no Jessie module for data-on-* handler "${name}"`);
        loaded.set(name, await evaluateRole(await fetchText(new URL(path, appBase)), "handler"));
      }
    }
  }
  // A machine's leaves, reached by the third spelling: value positions in
  // data-machine JSON. Guards and reference delays MUST resolve; an assign
  // string is a reference exactly when it names a declared module (lint
  // refuses the shadowing literal, so resolution is never a guess).
  for (const scope of withTemplates(screen)) {
    for (const el of scope.querySelectorAll("[data-machine]")) {
      // This scan reaches every machine on the screen, and one may sit on an
      // element that is not a region — the message is the guard's whole value.
      const where = el.dataset.live ?? el.id ?? el.localName;
      for (const shape of declaredCharts(el.getAttribute("data-machine"), where).map(machineShape)) {
        for (const name of shape.refs) {
          if (loaded.has(name)) continue;
          const path = route.files.handlers.find((f) => f.split("/").pop() === `${name}.js`);
          if (!path) throw new Error(`no Jessie module for machine reference "${name}"`);
          loaded.set(name, await evaluateRole(await fetchText(new URL(path, appBase)), "handler"));
        }
        for (const name of shape.assignStrings) {
          if (loaded.has(name)) continue;
          const path = route.files.handlers.find((f) => f.split("/").pop() === `${name}.js`);
          if (path) loaded.set(name, await evaluateRole(await fetchText(new URL(path, appBase)), "handler"));
        }
      }
    }
  }
  return loaded;
}

// An item template's markup never appears in the screen's own tree, and a
// template's own content hides any template nested inside it, so anything
// resolved before hydration has to walk every content fragment, depth-first.
const withTemplates = (screen) => {
  const scopes = [screen];
  for (const scope of scopes) {
    for (const t of scope.querySelectorAll("template[data-item]")) scopes.push(t.content);
  }
  return scopes;
};

// data-text-format names one of two things. plain and datetime are value
// formatting — text in, text out, no DOM. Any other name is a renderer: a
// Jessie module the app declared in files.renderers, resolved by basename
// exactly as a handler is.
const TEXT_FORMATS = new Set(["plain", "datetime"]);

async function loadRenderers(screen, appBase, route) {
  const declared = route.files.renderers ?? [];
  for (const path of declared) {
    const name = path.split("/").pop().replace(/\.js$/, "");
    // Shadowing a built-in would be silent: the screen keeps rendering, just
    // never with the module the app shipped.
    if (TEXT_FORMATS.has(name)) {
      throw new Error(`renderer "${name}" collides with a built-in data-text-format`);
    }
  }
  const loaded = {};
  for (const scope of withTemplates(screen)) {
    for (const el of scope.querySelectorAll("[data-text-format]")) {
      const name = el.dataset.textFormat;
      if (TEXT_FORMATS.has(name) || Object.hasOwn(loaded, name)) continue;
      const path = declared.find((p) => p.split("/").pop() === `${name}.js`);
      if (!path) throw new Error(`no renderer module for data-text-format="${name}"`);
      loaded[name] = await evaluateRole(await fetchText(new URL(path, appBase)), "renderer");
    }
  }
  return loaded;
}

// Attributes the hydrator itself consumes; never interpolated in place, so
// their placeholders survive until each region resolves them in its own
// context.
// Declarations the binder must leave standing: each is read with its
// placeholders intact, against a row the binder is not the one holding. Setting
// one would consume the template — an order map bound once would answer its
// first key forever, which is a sort that never sorts again.
const REGION_ATTRS = new Set([
  "data-text", "data-filter", "data-select", "data-empty", "data-empty-row", "data-when",
  "data-project", "data-order",
]);

// What a machine may read off the event that fired it (machine.cue #EventRef).
const EVENT_FIELDS = new Set([
  "value", "checked", "valueAsNumber", "key", "pointerX", "pointerY",
]);
// Types whose default action and an app's answer cannot both stand. Closed, and
// the cancel is the arrow's: answering one IS the markup declaring the gesture.
const DISPLACING_EVENTS = new Set(["contextmenu"]);
// Parts per thousand of the box, as an integer: no rounding to decide and no
// float to compare, so a replay reproduces the column exactly rather than
// nearly. The stylesheet divides it back out, which is where pixels belong.
const POINTER_SCALE = 1000;

/**
 * Where in the affordance's own box the pointer was.
 *
 * The frame is the ELEMENT and never the viewport. Viewport pixels would have
 * to be pinned for a replay to mean anything, and a window resized mid-session
 * makes any one pin a lie; an element the replay also renders is a frame it
 * already has. The app sees the quotient and never the divisor, so no chart can
 * depend on the geometry it was measured against — idempotence under a resize
 * is structural rather than a contract someone keeps.
 */
function pointerIn(e, el) {
  if (typeof e?.clientX !== "number" || typeof e?.clientY !== "number") return {};
  const box = el?.getBoundingClientRect?.();
  // A zero-width box has no interior to be a fraction of, and dividing by it
  // would write Infinity into the row and call it a position.
  if (!box || !(box.width > 0) || !(box.height > 0)) return {};
  const at = (n) => Math.min(POINTER_SCALE, Math.max(0, Math.round(n * POINTER_SCALE)));
  return {
    pointerX: at((e.clientX - box.left) / box.width),
    pointerY: at((e.clientY - box.top) / box.height),
  };
}
// data-read-* is a prefix family, so membership is a function rather than the
// Set alone: wireEvents resolves a named read's placeholders per step against
// the region's current row, which only works while the attribute still
// carries them.
const regionAttr = (name) => REGION_ATTRS.has(name) || name.startsWith("data-read-");
// Attributes the browser resolves as URLs, where the empty string is not
// "unset" but a reference to the current document.
const URL_ATTRS = new Set(["src", "href", "srcset", "poster", "action", "formaction", "data"]);
// A bound boolean attribute is absent when its value is empty. `disabled=""`
// is disabled, so interpolating an empty string would pin the control shut —
// the same trap URL_ATTRS exists for, and the same answer.
const BOOL_ATTRS = new Set([
  "disabled", "checked", "readonly", "required", "selected", "hidden", "open", "multiple",
]);
const BLANK_PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

// {param.x} reads route params; any other expression is a dot path into the
// row ({a.b} descends into embedded objects). Fixture rows answer the whole
// dotted key directly (their `has` is total), so the whole-key probe comes
// before the walk.
function lookup(expr, { row, params }) {
  if (expr.startsWith("param.")) {
    const name = expr.slice("param.".length);
    if (!params || !(name in params)) throw new Error(`unknown route param {${expr}}`);
    return params[name];
  }
  const r = row ?? {};
  if (expr in r) return r[expr];
  let v = r;
  for (const seg of expr.split(".")) {
    // A null embed is how PostgREST answers when the joined row is hidden
    // from this reader's RLS (a sharee reading the owner's label): bind
    // blank — only a key the row itself lacks is a real binding error.
    if (v == null) return undefined;
    if (!(seg in Object(v))) {
      // An optimistic insert carries only the submitted fields; DB-defaulted
      // columns materialize when the synced row arrives. Bind blank instead
      // of crashing the screen out from under the pending row.
      if (r.$synced === false) return undefined;
      throw new Error(`binding {${expr}} not in row [${Object.keys(r)}]`);
    }
    v = v[seg];
  }
  return v;
}

// The app's ONE fixed UTC human timestamp format ("Aug 2, 09:00") for
// data-text-format="datetime" bindings — raw column text (ISO / postgres
// timestamptz) never reaches the user. Unparsable values pass through so
// fixture rows stay visible in the storybook.
//
// Date and time are formatted apart and joined with our own ", ": one
// formatter carrying both would interpose CLDR's date-time connector, which
// reads ", " on V8 but " at " on JSC, making the format browser-dependent.
// Exported so tests can pin the shape without hydrating a screen.
const DATE = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export function formatDatetime(value) {
  if (value == null || value === "") return "";
  // Date takes postgres' "2026-08-02 09:00:00+00" as it stands; it is the
  // T-substitution that forces the offset repair beside it. Neither survives a
  // date-only value, which falls through to the passthrough below.
  const iso = String(value).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(value);
  return `${DATE.format(d)}, ${TIME.format(d)}`;
}

/**
 * A region's derived columns. The clause set is closed and the refusals behind
 * it are the design; both are stated in
 * plugins/omnishell/docs/2026-09-01-aria-is-columns.md.
 *
 * Those refusals are why no incremental-view engine appears here: every answer
 * is a function of rows the region already holds at refresh, so the pass it
 * runs anyway computes them exactly.
 */
// The clauses that name a row of the region rather than answering about one:
// each is a key for a gesture to write, and each admits a partition column.
const LANE_KINDS = new Set(["next", "prev", "first", "last"]);

export function parseProjection(spec, table) {
  let declared;
  try {
    declared = JSON.parse(spec);
  } catch {
    throw new ProjectionError(`region "${table}": data-project is not JSON`);
  }
  // Valid JSON that is not a map of clauses, which the parse guard above lets
  // through: `null` reaches Object.entries and throws, and a bare `true` or `42`
  // answers no entries at all — a projection that states nothing.
  if (declared === null || typeof declared !== "object" || Array.isArray(declared)) {
    throw new ProjectionError(
      `region "${table}": data-project is ${JSON.stringify(declared)}, not an object of clauses`,
    );
  }
  return Object.entries(declared).map(([name, clause]) => {
    if (clause === "index" || clause === "count") return { name, kind: clause };
    if (LANE_KINDS.has(clause)) return { name, kind: clause, by: undefined };
    const obj = clause === null || typeof clause !== "object" || Array.isArray(clause) ? undefined : clause;
    // A lane clause's partition, in the same key-is-the-kind shape `eq` uses:
    // {"next": "col"} is the neighbour among the rows sharing this row's `col`.
    // A minor axis walked without one runs off the end of its lane into the
    // head of the next, which is a wrong answer rather than a missing one.
    const by = obj === undefined ? undefined : [...LANE_KINDS].find((k) => k in obj);
    if (by !== undefined) {
      if (typeof obj[by] !== "string" || Object.keys(obj).length !== 1) {
        throw new ProjectionError(
          `region "${table}": data-project "${name}" is ${JSON.stringify(clause)}; a partitioned lane clause is {"${by}": column}`,
        );
      }
      return { name, kind: by, by: obj[by] };
    }
    const eq = obj?.eq;
    if (
      !Array.isArray(eq) || eq.length !== 2 ||
      typeof eq[0] !== "string" || typeof eq[1] !== "string"
    ) {
      throw new ProjectionError(
        `region "${table}": data-project "${name}" is ${JSON.stringify(clause)}; a clause is "index", "count", ${
          [...LANE_KINDS].map((k) => `"${k}"`).join(", ")
        }, {"<lane>": column} or {"eq": [column, value]}`,
      );
    }
    return { name, kind: "eq", column: eq[0], value: eq[1] };
  });
}

/**
 * A region's order: either the literal one, or a closed map of them chosen by a
 * column.
 *
 * `data-order="pos.asc"` is the order. `{"by":"{sort}","of":{...}}` states EVERY
 * order the region can be read in, in the file, and lets a column pick among
 * them — so a sortable header is a form writing a key, and the reader can still
 * finish reading what the screen can do. The order itself never interpolates:
 * a column naming a column is reflection, and the set of reads a screen has
 * would stop being enumerable.
 */
export function parseOrder(spec, table) {
  // Structural, not a probe: a value that opens a map and fails to parse is a
  // broken declaration, never quietly the literal order "{...".
  if (!spec.trimStart().startsWith("{")) return { literal: spec };
  let declared;
  try {
    declared = JSON.parse(spec);
  } catch {
    throw new OrderError(`region "${table}": data-order opens a map and is not JSON`);
  }
  const { by, of: of_, ...rest } = declared ?? {};
  if (
    typeof by !== "string" || of_ === null || typeof of_ !== "object" || Array.isArray(of_) ||
    Object.keys(rest).length > 0 || Object.keys(of_).length === 0 ||
    Object.values(of_).some((o) => typeof o !== "string")
  ) {
    throw new OrderError(
      `region "${table}": data-order is ${spec}; a closed order map is {"by": "{column}", "of": {"<key>": "<order>"}}`,
    );
  }
  return { by, of: of_ };
}

function orderOf(parsed, ctx, table) {
  if (parsed === undefined) return undefined;
  if (parsed.literal !== undefined) return parsed.literal;
  let key;
  try {
    key = interpolate(parsed.by, ctx);
  } catch (err) {
    // lookup's own error is a plain one, and this resolves inside the parent's
    // refresh where the dead-gateway guard is standing.
    throw new OrderError(`region "${table}": data-order "${parsed.by}" — ${err.message}`);
  }
  // A key the map does not carry is the program wrong, not a reader's mistake:
  // the column is written by a form the same declaration generated.
  if (!(key in parsed.of)) {
    throw new OrderError(
      `region "${table}": data-order "${parsed.by}" is "${key}", which is not one of ${Object.keys(parsed.of).join(", ")}`,
    );
  }
  return parsed.of[key];
}

/**
 * An `eq` clause's answer. A column the row lacks is a program error, the same
 * rule a binding holds to and for the same reason — answering "false" for a
 * column nobody wrote is a tablist where nothing is ever selected, which is
 * plausible and unreported. The one exception is a binding's too: a row whose
 * write is still in flight carries only the submitted fields.
 */
function eqAnswer(row, p, table) {
  if (!(p.column in row)) {
    if (row.$synced !== false) {
      throw new ProjectionError(
        `region "${table}": data-project "${p.name}" reads {${p.column}}, not in row [${Object.keys(row)}]`,
      );
    }
    return "false";
  }
  return String(row[p.column]) === p.want ? "true" : "false";
}

/**
 * Everything a nested region's own element interpolates from the row it hangs
 * under. That is a LIST region's own attributes and its `data-project`: a list
 * has many rows, so the only row its own element can be about is the enclosing
 * one. A SLOT has one, binds its element from that, and takes nothing from
 * here — which is why `data-total="{total_count}"` on a singleton resolves
 * against the row the singleton found and not against its parent's.
 *
 * The filter is compared separately: a moved filter is a moved read, and has to
 * re-hydrate rather than re-render.
 */
/**
 * A declaration resolved against the row a region hangs under. For a NESTED
 * region every one of these runs inside the parent's refresh, where the outage
 * guard is standing, so lookup's plain "not in row" would be dressed as a dead
 * gateway and retried on a backoff while the markup is what is wrong.
 */
function fromEnclosing(resolve, table, what) {
  try {
    return resolve();
  } catch (err) {
    throw new ProgramError(`region "${table}": ${what} — ${err.message}`);
  }
}

/**
 * The charts a region runs. One `data-machine` is one chart; a LIST is several,
 * which is how a caret sits beside the pattern's own state without either
 * chart learning about the other (machine.cue's parallel machines).
 *
 * They share the row and must not share a column. Columns are `machineLint`'s
 * to refuse, because two charts writing one column is decidable off the markup
 * and a runtime arbitrating it would have to pick a winner. FIELDS are refused
 * here, because everything below keys its listeners, its timer generation and
 * its armed state by field — two charts over one field would silently take
 * each other's.
 */
function declaredCharts(spec, table) {
  let value;
  try {
    value = JSON.parse(spec);
  } catch {
    throw new ProgramError(`region "${table}": data-machine is not JSON: ${spec}`);
  }
  const charts = Array.isArray(value) ? value : [value];
  if (charts.length === 0) {
    throw new ProgramError(`region "${table}": data-machine states no chart`);
  }
  for (const chart of charts) {
    if (chart === null || typeof chart !== "object" || Array.isArray(chart)) {
      throw new ProgramError(`region "${table}": data-machine holds ${JSON.stringify(chart)}, which is not a chart`);
    }
  }
  const fields = charts.map((c) => c.field);
  const twice = fields.find((f, i) => fields.indexOf(f) !== i);
  if (twice !== undefined) {
    throw new ProgramError(`region "${table}": two charts run over the field "${twice}"; parallel charts hold disjoint columns`);
  }
  return charts;
}

/** A JSON declaration off the markup. Malformed is a SyntaxError and `null`
 * parses, so neither reaches a reader without this. */
function declared(spec, table, what) {
  let value;
  try {
    value = JSON.parse(spec);
  } catch {
    throw new ProgramError(`region "${table}": ${what} is not JSON: ${spec}`);
  }
  // Arrays are objects; parseProjection's sibling guard says so too.
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProgramError(`region "${table}": ${what} is ${spec}, not an object`);
  }
  return value;
}

function nestedBindings(el, ctx) {
  const stash = el._prontoAttrs ?? {};
  const names = new Set([...(el.attributes ?? [])].map((a) => a.name));
  for (const name of Object.keys(stash)) names.add(name);
  const out = [];
  for (const name of [...names].sort()) {
    if (name !== "data-project" && regionAttr(name)) continue;
    const template = stash[name] ?? el.getAttribute(name);
    if (template === null || !HAS_PLACEHOLDER.test(template)) continue;
    out.push(`${name}=${fromEnclosing(() => interpolate(template, ctx), el.dataset.live, name)}`);
  }
  return out.join("\u0000");
}

function interpolate(template, ctx) {
  return template.replace(PLACEHOLDER, (_, expr) => String(lookup(expr, ctx) ?? ""));
}

// Filter fragments land in a query string, so resolved values are URI-encoded.
function interpolateFilter(template, ctx) {
  return template.replace(PLACEHOLDER, (_, expr) => encodeURIComponent(String(lookup(expr, ctx) ?? "")));
}

// Hidden data-value grammar: literal "null" → JSON null; {now} → the terminal
// clock at submit time; anything else resolves from the form's row/param
// context.
function resolveHidden(template, ctx) {
  if (template === "null") return null;
  return template.replace(PLACEHOLDER, (_, expr) =>
    expr === "now" ? now() : String(lookup(expr, ctx) ?? ""),
  );
}

// data-action="navigate" hash grammar: data-target's {field} placeholders name
// the form's inputs; values are URI-encoded. Exported so tests can assert the
// hash without a browser location.
export function navigationHash(target, form) {
  const inputs = {};
  for (const input of form.querySelectorAll("[name]")) inputs[input.name] = input.value;
  return target.replace(PLACEHOLDER, (_, name) => {
    if (!(name in inputs)) throw new Error(`navigate target {${name}} names no form input`);
    return encodeURIComponent(inputs[name]);
  });
}

const raf = (fn) => (globalThis.requestAnimationFrame ?? ((f) => setTimeout(f, 0)))(fn);

// moveBefore relocates a node without the teardown insertBefore implies
// (dropped focus, restarted animations, reloading iframes). It is defined on
// the ParentNode mixin, so it is on Element and NOT on Node.prototype, where a
// probe finds nothing and wrongly concludes the engine lacks it.
// Chromium-only.
const HAS_MOVE_BEFORE = typeof globalThis.Element?.prototype?.moveBefore === "function";

// Motion slots drive whatever keyframes the design layer binds, so a slot released
// before its animation ends cancels it mid-play. Both slots therefore wait on
// the animations the stamp actually started, and fall back to releasing at
// once where none run — a reduced-motion viewer, or an engine without the
// Animations API.
function settle(node, done) {
  raf(() => {
    const running = node.getAnimations?.({ subtree: true }) ?? [];
    if (running.length === 0) return done();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      done();
    };
    Promise.allSettled(running.map((a) => a.finished)).then(finish);
    setTimeout(finish, MOTION_CAP_MS);
  });
}

function playEnter(node) {
  node.dataset.enter = "";
  settle(node, () => delete node.dataset.enter);
}

// A departing node stays in the list until its animation finishes — the thing
// that was impossible while every render rebuilt the list. The cap is a leak
// guard: an animation that never settles must not strand the node forever.
const MOTION_CAP_MS = 1000;

// How many rows may arrive or leave in one pass and still be a gesture. Motion
// costs a frame and a style resolution PER NODE — `settle` asks each one what
// it is animating — so a pass moving a thousand rows spends a thousand of those
// on motion no reader can follow. Past this many the pass is a load, which is
// the same judgement the first paint already makes.
const GESTURE = 32;
function playExit(node, done) {
  node.dataset.exit = "";
  settle(node, done);
}

// True when no [data-live] boundary sits between el (inclusive) and scope
// (exclusive) — nested regions bind against their own row, never the parent's.
/** Forms under a scope, the scope included when it is itself one. */
const formsIn = (scope) => [
  ...(scope.matches?.("form[data-action]") ? [scope] : []),
  ...scope.querySelectorAll("form[data-action]"),
];

/** Hatches under a node, the node included when it is itself one — bindHatches
 * mounts on the scope root too, so every release sweep must reach it. */
const hatchesIn = (node) => [
  ...(node.matches?.("[data-hatch]") ? [node] : []),
  ...node.querySelectorAll("[data-hatch]"),
];

/** Whether `el` is the scope's own to bind: nothing between it and the scope
 * declares a read. */
function ownedBy(el, scope) {
  for (let n = el; n && n !== scope; n = n.parentElement) {
    // An attribute probe, not a selector match: this runs once per ancestor
    // of every element bound, and a match is an order of magnitude dearer.
    if (n.hasAttribute?.("data-live")) return false;
  }
  return true;
}

/**
 * Take a region's rendered output away, for a singleton whose row is gone.
 *
 * The output has to stop being the last row's, and it cannot become the
 * template's either: restoring `src="{image_url}"` is what makes a browser
 * request the literal placeholder, and blanking it to "" requests the page
 * itself. So a bound attribute goes back to absent, which asks for nothing.
 * Text goes to empty, which is what every binder already does for a column an
 * unconfirmed row has not got yet.
 */
function clearBindings(scope) {
  for (const el of [scope, ...scope.querySelectorAll("*")]) {
    if (!ownedBy(el, scope)) continue;
    if (el.parentElement?.closest("[data-text-format]")) continue;
    for (const name of Object.keys(el._prontoAttrs ?? {})) el.removeAttribute(name);
  }
  const targets = scope.matches?.("[data-text]") ? [scope] : [];
  targets.push(...scope.querySelectorAll("[data-text]"));
  for (const el of targets) {
    if (!ownedBy(el, scope)) continue;
    if (el.parentElement?.closest("[data-text-format]")) continue;
    el.textContent = "";
  }
}

function bindTexts(scope, ctx, renderers = {}) {
  const targets = scope.matches?.("[data-text]") ? [scope] : [];
  targets.push(...scope.querySelectorAll("[data-text]"));
  for (const el of targets) {
    if (!ownedBy(el, scope)) continue;
    const format = el.dataset.textFormat;
    if (format === "datetime") {
      el.textContent = el.dataset.text.replace(PLACEHOLDER, (_, expr) =>
        formatDatetime(lookup(expr, ctx)),
      );
      continue;
    }
    if (format !== undefined && format !== "plain") {
      const render = renderers[format];
      // Every format resolves at hydration, so an unresolved one can only be
      // the fixture tier, which evaluates no Jessie. It shows the value as
      // text there, the way it shows a widget's markup unenhanced.
      if (render === undefined) el.textContent = interpolate(el.dataset.text, ctx);
      else renderInto(render, interpolate(el.dataset.text, ctx), el);
      continue;
    }
    el.textContent = interpolate(el.dataset.text, ctx);
  }
}

function bindAttributes(scope, ctx) {
  for (const el of [scope, ...scope.querySelectorAll("*")]) {
    if (!ownedBy(el, scope)) continue;
    bindElementAttributes(el, ctx);
  }
}

/**
 * One element's bound attributes. Split out because a LIST region's own
 * element belongs to nobody else's pass: its parent's stops at it (ownedBy
 * refuses any [data-live] between the element and the scope) and its own pass
 * binds the items. A slot has always bound its own element; this is the same
 * thing for the branch that renders rows, and it is what lets a container hold
 * aria-activedescendant naming a row of the list inside it.
 */
function bindElementAttributes(el, ctx) {
  // Nodes a renderer produced are the row's own content, not authored
  // markup: nothing in them is a binding, and the braces an author wrote
  // name no column.
  if (el.parentElement?.closest("[data-text-format]")) return;
  // setAttribute would consume the placeholder template; persistent regions
  // (singletons) re-bind on every refresh, so originals are stashed.
  const stash = (el._prontoAttrs ??= {});
  // The names to consider are the element's attributes AND every name already
  // stashed. A binding that resolved to nothing had its attribute removed —
  // an empty boolean is absent, an empty href is not a URL — and iterating
  // only what is present would never visit it again, leaving it dead at the
  // first empty value it ever took.
  const names = new Set([...(el.attributes ?? [])].map((a) => a.name));
  for (const name of Object.keys(stash)) names.add(name);
  for (const name of names) {
    if (regionAttr(name)) continue;
    const template = stash[name] ?? el.getAttribute(name);
    if (template === null || !HAS_PLACEHOLDER.test(template)) continue;
    stash[name] = template;
    const attr = { name, value: template };
    // Fixture tier: an interpolated img src would fire a real request the
    // moment it is set; a transparent pixel keeps the layout box instead.
    if (ctx.inert && el.localName === "img" && attr.name === "src") {
      el.setAttribute("src", BLANK_PIXEL);
      continue;
    }
    if (attr.name === "data-value") {
      if (el.type === "hidden") continue; // resolved at submit (resolveHidden)
      // Unsent edits are not the store's to overwrite. Regions re-bind on
      // any change to their table, so pinning a note elsewhere on the
      // screen would otherwise wipe an unsaved body — and waiting for focus
      // is not enough, because the wipe lands just as happily on text the
      // user typed and then clicked away from. The control stays untouched
      // until its form submits or resets, which is what clears the mark.
      // Checkboxes are exempt: their value IS the state, and a refused
      // toggle has to roll back where the user can see it.
      if (el.type !== "checkbox") {
        if (el._prontoDirty || el === document.activeElement) continue;
        if (!el._prontoDirtyWired) {
          el._prontoDirtyWired = true;
          el.addEventListener("input", () => {
            el._prontoDirty = true;
          });
          el.closest("form")?.addEventListener("reset", () => {
            el._prontoDirty = false;
          });
        }
      }
      if (el.type === "checkbox") {
        el.checked = Boolean(lookup(template.slice(1, -1), ctx));
        continue;
      }
      // The inverse of what values() reads back: a group's members share one
      // name and the checked one carries the column, so binding checks the
      // member whose value the column already holds and a round trip is a
      // fixed point.
      if (el.type === "radio") {
        el.checked = String(lookup(template.slice(1, -1), ctx) ?? "") === el.value;
        continue;
      }
      if (el.type === "datetime-local") {
        // The control accepts only YYYY-MM-DDTHH:MM; rows carry full ISO.
        el.value = interpolate(template, ctx).slice(0, 16);
        continue;
      }
      if (el.type === "date") {
        // Day precision: the control accepts only YYYY-MM-DD.
        el.value = interpolate(template, ctx).slice(0, 10);
        continue;
      }
      if (el.localName === "textarea" || el.localName === "select") {
        el.value = interpolate(template, ctx);
        continue;
      }
    }
    const value = interpolate(template, ctx);
    // A URL attribute that resolves to nothing must not stay empty: the
    // empty string is a valid relative URL meaning "this document", so
    // `src=""` fetches the page and paints it as a broken image.
    if (value === "" && BOOL_ATTRS.has(attr.name)) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (value === "" && URL_ATTRS.has(attr.name)) {
      // An <img> is sized by CSS whether or not it has a source, and a
      // sized <img> with no src at all still gets the engine's missing-image
      // glyph — so the screen's own treatment for the unset case (a filled
      // circle, a hairline) is drawn over rather than revealed. The
      // transparent pixel is how markup says "this image is deliberately
      // blank": no request, no glyph, the element's own background shows.
      if (el.localName === "img" && attr.name === "src") el.setAttribute("src", BLANK_PIXEL);
      else el.removeAttribute(attr.name);
      continue;
    }
    el.setAttribute(attr.name, value);
    if (attr.name === "data-open") openPopover(el, value);
  }
}

/**
 * A surface's place in the top layer, decided by a row.
 *
 * The one thing on this list CSS cannot do: `popover` openness is not a style,
 * the element is MOVED, and the browser offers only an imperative call and an
 * invoker that answers a click. A right-click has no invoker, so a menu the
 * platform dismisses — light dismiss and Escape, both the UA's — is reachable
 * no other way.
 *
 * It stays a consequence rather than an effect anyone schedules: the value is a
 * column, it is re-derived on every bind, and it is idempotent, so a replay
 * puts the surface exactly where the session had it. One column drives one
 * surface; two columns claiming one is the one-writer rule, and a binding
 * cannot express it.
 */
function openPopover(el, value) {
  if (el.getAttribute("popover") === null) {
    throw new ProgramError(`data-open on a <${el.localName}> that declares no popover`);
  }
  setPopover(el, value === "true");
}

/**
 * Moves a surface into or out of the top layer, once.
 *
 * showPopover throws on an already-open popover and hidePopover on a closed
 * one, so the guard is the contract rather than caution — and the flag is the
 * terminal's own record because `:popover-open` is a selector, which every DOM
 * this runs against does not answer. A surface nobody has opened IS closed:
 * that is the element's state, not a value assumed for it, which is why the
 * first bind of a closed row must reach neither call.
 */
function setPopover(el, want) {
  // An `auto` popover has a second writer — light dismiss and Escape are the
  // UA's, and it closes the surface without telling the row. A flag that only
  // this function wrote would then say open over a closed surface and skip the
  // call that reopens it: a menu dead after its first dismissal. `toggle` is
  // where the element states what it did.
  if (el._prontoToggle === undefined) {
    el._prontoToggle = (e) => {
      el._prontoOpen = e.newState === "open";
    };
    el.addEventListener("toggle", el._prontoToggle);
  }
  if ((el._prontoOpen ?? false) === want) return;
  el._prontoOpen = want;
  if (want) el.showPopover();
  else el.hidePopover();
}

// A data-interest naming no element, or one that is not a popover.
export class InterestError extends ProgramError {}

// How long a pointer rests on a trigger before its surface opens, and how long
// the surface survives the pointer leaving. The grace is what makes the surface
// HOVERABLE — WCAG 1.4.13's second clause — since a reader moving onto it
// crosses the gap between the two.
const INTEREST_IN = 300;
const INTEREST_OUT = 200;

/**
 * A surface a trigger opens on hover or focus. The terminal performs the open,
 * the grace that makes it hoverable, and nothing else.
 *
 * Three constraints hold it up, and the argument for each is
 * plugins/omnishell/docs/2026-09-03-what-a-gesture-costs.md. It stores nothing, so
 * no row can disagree with it. Its waits are the terminal's clock and never
 * setTimeout, or `?clock=manual` could not hold them still. And the surface must
 * be `popover="auto"`, so WCAG 1.4.13's DISMISSIBLE clause is the element's and
 * nothing here listens for a key.
 *
 * Not spelled `interestfor`: that name belongs to a spec no engine ships, and
 * this deletes when one does.
 */
function wireInterest(el) {
  if (el._prontoInterest) return;
  const id = el.dataset.interest;
  const surface = document.getElementById(id);
  if (surface === null) throw new InterestError(`data-interest names "${id}", which is no element on the screen`);
  if (surface.getAttribute("popover") !== "auto") {
    throw new InterestError(
      `data-interest names "${id}", which is not popover="auto" — light dismiss and Escape are the element's half of WCAG 1.4.13`,
    );
  }
  // One owner per surface. A row deciding openness and a pointer deciding it
  // are two writers of one fact, and they disagree the moment either moves:
  // the row would restate its answer on the next bind and shut a surface the
  // reader is still under.
  if (surface.dataset.open !== undefined) {
    throw new InterestError(
      `data-interest names "${id}", whose openness is already a column — a surface has one owner`,
    );
  }
  el._prontoInterest = true;

  let generation = 0;
  // The generation mark IS the cancellation, as it is for a machine's `after`:
  // a wait that comes due after interest moved on finds a stale mark and dies.
  const settle = (want, delay) => {
    const mine = ++generation;
    rest(delay / TEMPO).then(() => {
      if (mine !== generation) return;
      setPopover(surface, want);
    });
  };

  // Focus opens with no delay: 1.4.13 is "hover OR focus", and a keyboard
  // reader who has arrived has already waited.
  for (const [node, type, want, delay] of [
    [el, "pointerenter", true, INTEREST_IN],
    [el, "pointerleave", false, INTEREST_OUT],
    [el, "focusin", true, 0],
    [el, "focusout", false, INTEREST_OUT],
    // The surface's own: a reader moving onto it is still interested, which is
    // the clause a CSS-only tooltip cannot meet without the two boxes touching.
    [surface, "pointerenter", true, 0],
    [surface, "pointerleave", false, INTEREST_OUT],
    // And the same pair for the keyboard, which is what a surface holding
    // anything reachable needs: Tab moves focus out of the trigger, and a
    // surface that only heard the pointer would close under the reader on
    // their way into it — taking the focus with it, since the element it held
    // is gone.
    [surface, "focusin", true, 0],
    [surface, "focusout", false, INTEREST_OUT],
  ]) {
    node.addEventListener(type, () => settle(want, delay));
  }
}

function paramOnly(template) {
  const exprs = [...template.matchAll(PLACEHOLDER)].map((m) => m[1]);
  return exprs.length > 0 && exprs.every((e) => e.startsWith("param."));
}

// opts.handlers: false skips handler loading (storybook's fixture tier — drag
// stays inert there). opts.units carries shell.yaml's vendored-unit
// declarations, which is what a data-hatch name resolves against.
export async function interpretScreen(mount, appBase, route, store, params = {}, opts = {}) {
  const [html, css] = await Promise.all([
    fetchText(new URL(route.files.html, appBase)),
    fetchText(new URL(route.files.css, appBase)),
  ]);

  const styleId = `screen-css-${route.screen}`;
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = css;
    document.head.append(style);
  }

  // Subscriptions of the previously mounted screen would refresh dead DOM and
  // keep their poll keys hot — stop them before mounting the next one.
  for (const stop of mount._prontoStops ?? []) stop();
  const cleanups = [];
  mount._prontoStops = cleanups;
  // One seat per data-on-mutation handler, screen-wide (see wireEvents).
  const folds = new Map();

  const holder = document.createElement("template");
  holder.innerHTML = html;
  const screen = holder.content.firstElementChild;

  // {param.x} resolves anywhere in the screen; expressions that also touch
  // row fields wait for their region's hydration.
  for (const el of [screen, ...screen.querySelectorAll("*")]) {
    if (el.dataset?.text && paramOnly(el.dataset.text)) {
      el.textContent = interpolate(el.dataset.text, { params });
    }
    for (const attr of [...(el.attributes ?? [])]) {
      if (regionAttr(attr.name) || attr.name === "data-value") continue;
      if (paramOnly(attr.value)) el.setAttribute(attr.name, interpolate(attr.value, { params }));
    }
  }

  // A URL still carrying its placeholder is a URL the document would fetch the
  // instant this tree is connected — `src="{image_url}"` is a relative path,
  // and the request 404s before any row exists to bind. Stash the template the
  // way bindAttributes does and neutralise the attribute until it resolves.
  for (const el of [screen, ...screen.querySelectorAll("*")]) {
    for (const attr of [...(el.attributes ?? [])]) {
      if (!URL_ATTRS.has(attr.name) || !HAS_PLACEHOLDER.test(attr.value)) continue;
      (el._prontoAttrs ??= {})[attr.name] = attr.value;
      if (el.localName === "img" && attr.name === "src") el.setAttribute("src", BLANK_PIXEL);
      else el.removeAttribute(attr.name);
    }
  }

  let base = screen.getAttribute("data-state") || route.states?.[0] || "populated";
  const setState = (s) => {
    screen.dataset.state = s;
  };
  setState(base);

  // Connect only once the tree carries its state: screens style themselves per
  // `[data-state]`, so a screen mounted before this paints with every
  // state-scoped rule inert — every region visible at once, links wearing the
  // user-agent underline — for as long as the awaited loads below take.
  mount.replaceChildren(screen);
  for (const s of screen.querySelectorAll("script")) {
    const fresh = document.createElement("script");
    fresh.textContent = s.textContent;
    s.replaceWith(fresh);
  }

  const handlers = opts.handlers === false ? new Map() : await loadHandlers(screen, appBase, route);
  const renderers = opts.handlers === false
    ? {}
    : await loadRenderers(screen, appBase, route);

  const units = opts.units ?? {};
  const resolveUnit = (name) => {
    const unit = units[name];
    if (unit === undefined) throw new Error(`no vendored unit for data-hatch="${name}"`);
    return unit;
  };
  // Every hatch name resolves before a region hydrates, item templates
  // included. Left to its mount, an undeclared unit would throw inside a
  // region's refresh, where the dead-gateway path catches it: the screen would
  // report a network error and retry a wiring mistake every two seconds.
  for (const scope of withTemplates(screen)) {
    for (const el of scope.querySelectorAll("[data-hatch]")) resolveUnit(el.dataset.hatch);
  }

  // Named templates are screen-scoped, collected once here. A region inside a
  // named template may reference the very template it sits in — recursion,
  // terminating through data when a leaf's child read returns no rows.
  const namedTemplates = new Map();
  for (const scope of withTemplates(screen)) {
    for (const t of scope.querySelectorAll("template[data-item][data-name]")) {
      const name = t.getAttribute("data-name");
      if (namedTemplates.has(name)) throw new Error(`two templates declare data-name="${name}"`);
      namedTemplates.set(name, t);
    }
  }
  const resolveTemplate = (name) => {
    const t = namedTemplates.get(name);
    if (t === undefined) throw new Error(`no template declares data-name="${name}"`);
    return t;
  };
  // Every data-template resolves before a region hydrates, for the same
  // reason every hatch name does: inside a refresh the dead-gateway path
  // would dress the wiring mistake as a network error and retry it forever.
  for (const scope of withTemplates(screen)) {
    for (const el of scope.querySelectorAll("[data-template]")) resolveTemplate(el.getAttribute("data-template"));
  }

  // data-hatch="<unit>" mounts a vendored unit here; data-prop-* carry its
  // props, already resolved against the row by bindAttributes, so a hatch in a
  // region re-synchronises with its row for free. This dispatcher never learns
  // what a unit is: it hands over the props it finds and mounts what the
  // app declared.
  function bindHatches(scope, ctx) {
    const targets = scope.matches?.("[data-hatch]") ? [scope] : [];
    targets.push(...scope.querySelectorAll("[data-hatch]"));
    for (const el of targets) {
      if (!ownedBy(el, scope)) continue;
      // Same reason the fixture tier keeps img src inert: a storyboard frame
      // would otherwise fetch every provider's embed, once per screen × state.
      if (ctx.inert) continue;
      const props = {};
      for (const [key, value] of Object.entries(el.dataset)) {
        if (key.startsWith("prop") && key.length > 4) props[key[4].toLowerCase() + key.slice(5)] = value;
      }
      // A caller that cannot give a unit its boundary says so rather than
      // being handed a fiction: the machine walker mounts screens in linkedom,
      // where neither a Worker nor a frame exists. The name still resolves
      // above, so an undeclared unit is still the wiring mistake it was; only
      // the mount is declined.
      if (opts.mountUnits === false) continue;
      if (el._prontoHatch === undefined) {
        const name = el.dataset.hatch;
        const unit = resolveUnit(name);
        el._prontoHatch = mountHatch(el, {
          unit,
          src: new URL(unit.src, appBase).href,
          // A unit's named event becomes a real DOM event on the mount, so the
          // ordinary data-on-* path carries it the rest of the way: bind
          // attaches the listener, bind builds the event, step runs the reduce
          // with the region's whole world. Nothing here reaches for a handler,
          // which is what makes the mount order-immune — bindHatches runs
          // before wireEvents in the list branch, and a message never arrives
          // in the same task as the mount.
          // Not bubbling: only a data-on-* on the hatch host itself means this
          // unit, and an ancestor region declaring the same name means its own
          // affordance.
          // A unit names its own event, so two things bound it. It must be a
          // name the host DECLARED, and it must not be one a reader can
          // produce — a host carrying both a data-hatch and a data-on-click
          // would otherwise let the unit forge a click the reduce cannot tell
          // from the hand's. Declaration alone is not that guarantee.
          onEvent: (event) => {
            // Every native gesture is an IDL handler property on the element;
            // a unit's own vocabulary is not, so this asks the DOM rather than
            // carrying a list that would go stale.
            if (`on${event.name}` in el) return;
            // Camel-cased the way the DOM cases it, or a hyphenated name
            // builds a key `dataset` does not hold and the event is dropped
            // where the wiring reads correct.
            const declared = `on${event.name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}`;
            if (el.dataset[declared.replace(/^on(.)/, (_, c) => `on${c.toUpperCase()}`)] === undefined) return;
            el.dispatchEvent(new document.defaultView.CustomEvent(event.name, {
              bubbles: false,
              detail: event.detail,
            }));
          },
        });
        cleanups.push(() => el._prontoHatch.destroy());
      }
      el._prontoHatch.update(props);
    }
  }

  // APG's own set for moving through a list, and nothing else: a binding that
  // could name any key would be a handler with a keyboard attached.
  const ROVING_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"]);
  // The one modifier a walk through a list asks for, and APG asks for it by
  // name: in a grid, Home and End move within a row and CTRL+Home and Ctrl+End
  // move to the whole grid's ends. Closed at one, because a binding admitting
  // any modifier would be the handler with a keyboard the set above refuses —
  // and Meta is absent deliberately, since a chord a reader presses from
  // anywhere is not a binding on an element but an event source this terminal
  // does not have.
  const KEY_MODIFIER = "Ctrl+";
  /** A binding's key as the DOM spells it: the modifier, then APG's own name. */
  const keyOfEvent = (e) => `${e.ctrlKey ? KEY_MODIFIER : ""}${e.key}`;

  /** Whether one key of a bound map named a target that varies with the row.
   * The binder consumed the placeholders, so the question is asked of the
   * template it stashed rather than of the value now standing. */
  const interpolates = (el, attr, key) => {
    const template = el._prontoAttrs?.[attr];
    if (template === undefined) return false;
    const declared = JSON.parse(template)[key];
    return typeof declared === "string" && HAS_PLACEHOLDER.test(declared);
  };

  // data-key='{"<key>": "<form id>"}' submits a form on a key, the way a form
  // with no submit button submits on change. The id interpolates, so the map is
  // read at event time; the keys are literals, so they are checked once.
  /** Every key binding at or under `scope` that no deeper region owns, and
   * every interest binding likewise: both name a target by id and both are
   * wired once per element, so one pass carries them. */
  function wireKeysIn(scope) {
    wireKeysOn(scope);
    for (const el of scope.querySelectorAll("[data-key]")) if (ownedBy(el, scope)) wireKeys(el);
    for (const el of scope.querySelectorAll("[data-interest]")) if (ownedBy(el, scope)) wireInterest(el);
  }
  /** The element's own bindings, and none of its descendants'. */
  function wireKeysOn(el) {
    if (el.dataset?.key !== undefined) wireKeys(el);
    if (el.dataset?.interest !== undefined) wireInterest(el);
  }

  function wireKeys(el) {
    if (el._prontoKeys) return;
    let keys;
    try {
      keys = JSON.parse(el.dataset.key);
    } catch {
      throw new KeyBindingError(`data-key is not JSON: ${el.dataset.key}`);
    }
    if (keys === null || typeof keys !== "object" || Array.isArray(keys)) {
      throw new KeyBindingError(`data-key is ${el.dataset.key}, not an object of key to form id`);
    }
    for (const key of Object.keys(keys)) {
      const bare = key.startsWith(KEY_MODIFIER) ? key.slice(KEY_MODIFIER.length) : key;
      if (!ROVING_KEYS.has(bare)) {
        throw new KeyBindingError(
          `data-key names "${key}", which is not one of ${[...ROVING_KEYS].join(", ")}, ` +
            `nor one of those under "${KEY_MODIFIER}"`,
        );
      }
    }
    // Only after the declaration is known good: a listener attached to a
    // refused binding would swallow the key, and the flag would keep the
    // second pass from ever reporting it.
    el._prontoKeys = true;
    el.addEventListener("keydown", (e) => {
      const name = JSON.parse(el.dataset.key)[keyOfEvent(e)];
      if (name === undefined) return;
      const form = document.getElementById(name);
      // A miss means two different things, and only the declaration tells them
      // apart. A LITERAL id naming nothing is the markup naming a form that is
      // not there. An INTERPOLATED one is a set that is empty right now — a
      // filter matching no rows renders no forms — which is an ordinary state a
      // reader reaches by typing, not a broken program. The empty set keeps the
      // key uncancelled, so the arrow does what an arrow does when there is no
      // list to walk.
      if (form === null) {
        if (interpolates(el, "data-key", keyOfEvent(e))) return;
        throw new KeyBindingError(`data-key names "${name}", which is no element on the screen`);
      }
      // The tag, not a duck-type: the declaration names a form, and every
      // element answers requestSubmit in one runtime or another.
      if (form.localName !== "form") {
        throw new KeyBindingError(`data-key names "${name}", which is a <${form.localName}> and not a form`);
      }
      e.preventDefault();
      form.requestSubmit();
    });
  }

  function wireForm(form, rowId, getCtx = () => ({ params, row: {} }), region) {
    const entity = form.dataset.entity;
    const action = form.dataset.action;
    const invalid = form.querySelector(".invalid");
    // The shell owns validation so the storyboard's validation-error state is
    // observable; native tooltips would swallow the submit instead.
    form.noValidate = true;
    // Store resolution can lag the submit (acceptance window); a reset landing
    // then must not wipe input the user has typed since — rapid list entry
    // (add-line, capture) would lose every second entry.
    let edits = 0;
    const values = async () => {
      const ctx = getCtx();
      const out = {};
      for (const input of form.querySelectorAll("[name]")) {
        if (input.type === "radio") {
          // A radio group shares one name; only the checked member speaks
          // (iterating all would leave the last radio's value).
          if (input.checked) out[input.name] = input.value;
        } else if (input.type === "checkbox") out[input.name] = input.checked;
        else if (input.type === "file" && input.dataset.upload !== undefined) {
          // The blob goes to the store's object bucket first; the mutation
          // carries only the resulting key under the input's name. An empty
          // optional file input contributes no value (required-ness was
          // already gated by checkValidity).
          const file = input.files?.[0];
          if (!file) continue;
          const dot = file.name.lastIndexOf(".");
          const ext = dot > 0 ? file.name.slice(dot) : ".bin";
          const key = `${crypto.randomUUID()}${ext}`;
          const res = await fetch(`/blobs/mecha-objects/${key}`, { method: "PUT", body: file });
          if (!res.ok) throw new Error(`${res.status} PUT /blobs/mecha-objects/${key}`);
          out[input.name] = key;
        } else if (input.type === "hidden" && input.dataset.value !== undefined) {
          out[input.name] = resolveHidden(input.dataset.value, ctx);
        } else if (input.type === "datetime-local") {
          // Control values are minute-precision local-format; store UTC (v0).
          out[input.name] = input.value === "" ? null : `${input.value}:00Z`;
        } else if (input.type === "date") {
          // Day precision, pinned to the day's first instant — the one-clock
          // day convention: no hour is ever entered or shown.
          out[input.name] = input.value === "" ? null : `${input.value}T00:00:00Z`;
        } else out[input.name] = input.value.trim();
      }
      return out;
    };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!form.checkValidity()) {
        invalid?.removeAttribute("hidden");
        setState("validation-error");
        return;
      }
      invalid?.setAttribute("hidden", "");
      // navigate forms carry no data-entity: the hash change is the whole
      // effect and its feedback — no store call, no success state.
      if (action === "navigate") {
        location.hash = navigationHash(form.dataset.target, form);
        return;
      }
      setState("form-submit");
      // form-submit is a SCREEN state, so a rule keyed on it alone dims every
      // submit button in view — favouriting a piece flashed its author's
      // Follow arm. This marks the one form actually in flight.
      form.dataset.submitting = "";
      const editsAtSubmit = edits;
      // A store refusal (e.g. a trigger's RAISE) earns words, not just a
      // state: the submitting form's .store-error paragraph is revealed.
      // Passed into the store too, because a refusal can outrun the
      // acceptance window (store resolves optimistically first) — the late
      // rejection must still reach this form, not just the console.
      // A 4xx (the client's NonRetriableError) is the server rejecting the
      // write, so it gets the validation treatment — only user input clears
      // validation-error. It must NOT ride network-error: the region recovery
      // path resets network-error on the next successful refresh, and the
      // refusal's own rollback triggers exactly such a refresh, which would
      // clobber the state within milliseconds.
      const refused = (err) => {
        console.error(err);
        // With a mutation reduce mounted on the form's region, the refusal is
        // the reduce's event (see wireEvents' deliver) — the reduce writes the
        // words as a row, so the .store-error side channel stays untouched.
        const deliver = region?._prontoRefusal;
        if (deliver) {
          const id = action === "create" || form.dataset.filter !== undefined ? undefined : rowId();
          deliver(entity, id, err);
          // The reduce owns the words; the submit state is still this form's
          // to hand back, or a refused submit dims the screen forever.
          if (screen.dataset.state === "form-submit") setState(base);
          return;
        }
        form.querySelector(".store-error")?.removeAttribute("hidden");
        setState(err?.name === "NonRetriableError" ? "validation-error" : "network-error");
      };
      try {
        // A form's create mints the key the store now requires of every write:
        // retries are only idempotent because the key travels with each attempt.
        if (action === "create") {
          // The key is minted here because every write now carries one: retries
          // are idempotent only because the key travels with each attempt.
          const row = await values();
          await store.add(entity, [row.id === undefined ? { id: crypto.randomUUID(), ...row } : row], refused);
        }
        // Write the row for this natural key, existing or not. The form says
        // what the row should be; whether that is an insert or an update is the
        // store's question, answered against the collection.
        else if (action === "upsert") await store.upsertBy(entity, await values(), refused);
        else if (action === "update") {
          await store.patch(entity, [{ key: rowId(), changes: await values() }], refused);
        }
        else if (action === "delete" && form.dataset.filter !== undefined) {
          // Filter-scoped bulk delete: the filter, not the row context,
          // names the rows (SPEC #Form.filter).
          await store.dropWhere(entity, interpolateFilter(form.dataset.filter, getCtx()), refused);
        } else if (action === "delete") await store.drop(entity, [rowId()], refused);
        else throw new Error(`unknown action: ${action}`);
        if (edits === editsAtSubmit) form.reset();
        setState("success");
        // A late refusal can land inside the flash window; only an
        // undisturbed success may hand back to the base state.
        rest(600).then(() => {
          if (screen.dataset.state === "success") setState(base);
        });
      } catch (err) {
        refused(err);
      } finally {
        delete form.dataset.submitting;
      }
    });
    form.addEventListener("input", () => {
      edits++;
      if (["validation-error", "network-error"].includes(screen.dataset.state)) {
        invalid?.setAttribute("hidden", "");
        form.querySelector(".store-error")?.setAttribute("hidden", "");
        setState(base);
      }
    });
    // A form with no submit button (the toggle checkbox) submits on change.
    if (!form.querySelector('button, [type="submit"]')) {
      form.addEventListener("change", () => form.requestSubmit());
    }
  }

  // Stage-4's only handler event source: DOM drags become {type:"move",
  // fromId, toId} against {items: [{id, position}]} read from the region's
  // current rows in DOM order; the handler's {updates: [{op, id, row}]} apply as
  // ordinary update mutations. Handler failures surface as network-error,
  // never as a crashed screen.
  function wireDrag(region, items, getRows, reduce, deliver, apply) {
    for (const item of items) {
      // Item nodes outlive a refresh, so each is wired once — re-wiring would
      // stack another listener pair on every render. The drag's origin lives
      // on the region for the same reason: it must outlive any one wiring
      // pass, since dragstart and drop land on different nodes.
      if (item._prontoDrag) continue;
      item._prontoDrag = true;
      item.draggable = true;
      item.addEventListener("dragstart", (e) => {
        region._prontoDragFrom = item.dataset.id;
        e.dataTransfer?.setData("text/plain", item.dataset.id); // Firefox refuses payloadless drags
        // A screen cannot see which item is in the air any other way. The drag
        // image is a SNAPSHOT — `:-webkit-drag` styles that and never matches
        // the element left behind in the document — so a screen that draws the
        // item somewhere else (a board whose pieces are a layer above its
        // squares) has no way to let go of it for the duration without this.
        item.setAttribute("data-dragging", "");
      });
      item.addEventListener("dragend", () => item.removeAttribute("data-dragging"));
      item.addEventListener("dragover", (e) => e.preventDefault());
      item.addEventListener("drop", async (e) => {
        e.preventDefault();
        const fromId = region._prontoDragFrom;
        const toId = item.dataset.id;
        if (!fromId || fromId === toId) return;
        try {
          const state = { items: getRows().map((r) => ({ id: r.id, position: r.position })) };
          const result = reduce(state, { type: "move", fromId, toId });
          await apply(result.updates ?? [], deliver);
        } catch (err) {
          console.error(err);
          setState("network-error");
        }
      });
    }
  }

  // Any DOM event the app declared, reduced against the region's rows. Same
  // contract as the drag above: {type, id, items} in, {updates} out. The
  // handler never receives a node or an Event — it is evaluated in a
  // compartment with nothing endowed, so it could not use one, and it stays
  // testable with no DOM. A region-level event (a tick) carries no id.
  function wireEvents(region, items, getRows, handlers, ctx) {
    // {updates, then}. The command goes in the return, which is the whole of
    // how a reduce continues: evaluated in a compartment with nothing endowed
    // it can neither write nor wait, so it names the next event and the
    // terminal delivers it — after the writes, and after any delay it asked
    // for. Keeping the command a VALUE is what makes the chain recordable; a
    // promise would put the continuation on a stack nobody can serialise.
    //
    // An update may name its collection. A reduce over one region's rows
    // routinely concludes about their parent — closing a trick is an update to
    // the round the plays belong to. Omitted, it is the region's own, which is
    // the drag's case.
    // What else the reduce reads. The region's rows are its subject, but a
    // conclusion about them routinely needs the rest of the screen's world:
    // whether a card may be played is a fact about the table, not about the
    // hand holding it. Declared on the region, so what a compartment can see
    // stays something a reader can find in the markup, and whole collections
    // rather than a second filter language — a reduce is code and can narrow
    // what it was given.
    const reads = (region.dataset.reads ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    // data-read-<name>="table?fragment": an auxiliary read in the one grammar
    // — filter parts and order= — landing in state.rows under <name>. It goes
    // to query in the same (order, {filter, order}) shape a region's own read
    // carries, so a read some region already subscribes is served by that
    // region's maintained view. Placeholders resolve against the region's own
    // context — the rule data-filter follows — at each step, so a surviving
    // node's read tracks its current row. Bare data-reads names stay
    // whole-table reads keyed by table name.
    const named = [...region.attributes]
      .filter((a) => a.name.startsWith("data-read-"))
      .map((a) => ({ name: a.name.slice("data-read-".length), ...parseReadSpec(a.value) }));
    const worldOf = async () => {
      const rows = {};
      for (const table of reads) rows[table] = await store.query(table, null, {});
      for (const r of named) {
        const opts = {};
        if (r.filter !== undefined) opts.filter = interpolateFilter(r.filter, ctx);
        if (r.order !== undefined) opts.order = r.order;
        rows[r.name] = await store.query(r.table, r.order ?? null, opts);
      }
      return rows;
    };

    const rowsReduce = region.dataset.onMutation && handlers.get(region.dataset.onMutation);
    // Assigned by the machine block below when the machine declares "refused";
    // a refusal is then the machine's onError before it is anything else.
    const machineRefused = [];

    // A refusal is an event, not a callback. A write settles twice — accepted
    // optimistically, then confirmed or withdrawn — so the withdrawal cannot
    // be a return value: the value is already on screen. With a mutation
    // reduce mounted it arrives there as {type: "refused", entity, id?, kind,
    // validation?} and the reduce renders it like any other conclusion;
    // without one the terminal's default applies, the same states a form's
    // refusal sets.
    // `kind` tells the server's no ("refused" — NonRetriableError, the
    // optimistic row already rolled back) from a transport or program failure
    // ("failed").
    // The validation that said no: the store seat stamps it on the error; the
    // server's travels in PostgREST's message, `validation <table>.<name>` —
    // matched unanchored, because that message sits inside a JSON body. Read
    // only on a refusal: a program error carrying a validation's name (its
    // module 404s, its predicate answers no boolean) shares the same prefix
    // and named nothing that said no.
    const validationOf = (err) =>
      // A table name is whatever the schema calls it, so only the validation
      // half of the pair is constrained; the table half stops at the dot.
      err?.validation ?? /validation ([^\s.]+)\.([a-z][a-z0-9-]*)/.exec(err?.message ?? "")?.[2];
    const refusal = (entity, id, err) => {
      const fired = { type: "refused", entity, kind: err?.name === "NonRetriableError" ? "refused" : "failed" };
      if (id !== undefined) fired.id = id;
      if (fired.kind === "refused") {
        const validation = validationOf(err);
        if (validation !== undefined) fired.validation = validation;
      }
      return fired;
    };
    const deliver = (entity, id, err) => {
      console.error(err);
      // The store withdrew the write, so the chain-local machine view holding
      // it is withdrawn with it — the refusal transition concludes from what
      // the store still holds, not from the state that was just rolled back.
      region._prontoMachineRow = undefined;
      const fired = refusal(entity, id, err);
      if (machineRefused.length > 0) {
        for (const hear of machineRefused) hear(fired);
        return;
      }
      if (rowsReduce) {
        step(rowsReduce, fired, 0).catch((e) => {
          console.error(e);
          setState("network-error");
        });
        return;
      }
      setState(fired.kind === "refused" ? "validation-error" : "network-error");
    };
    region._prontoRefusal = rowsReduce ? deliver : undefined;

    const STEPS = 8;
    // Every write a reduce states, in the order it stated them. The shapes and
    // what they mean are GUIDE.md's; what matters here is why they are
    // safe. A put states the row for a key derived from what the row
    // identifies — the same conclusion reached twice is the same row, which is
    // what lets a reduce be woken more than once. A delete is what makes
    // "recompute absolutely, write differentially" total: without it a fold can
    // grow its set and never shrink it.
    //
    // Consecutive updates of the same op against the same collection go down as
    // one call. Applied one at a time each costs the whole table, so a fold
    // stating a thousand rows would be quadratic in the table's size.
    const OPS = new Set(["put", "patch", "delete"]);
    const SHAPES = '{op: "put", id, row}, {op: "patch", id, row} or {op: "delete", id}';
    const opOf = (u) => {
      // Naming the op is what keeps a fold from saying one thing and meaning
      // another: a patch that happens to carry a row would be a put by
      // accident, and silence is how that ships.
      if (!OPS.has(u.op)) {
        throw new Error(`an update states op: ${[...OPS].join(" | ")}, not ${JSON.stringify(u.op)} — ${SHAPES}`);
      }
      if (u.id === undefined) throw new Error(`a ${u.op} names no id — ${SHAPES}`);
      if (u.op !== "delete" && u.row === undefined) throw new Error(`a ${u.op} carries no row — ${SHAPES}`);
      return u.op;
    };
    /** Answers false when a refusal ended the batch, so a caller knows the
     * writes after it were never made: they concluded from a premise the store
     * has withdrawn. Answered rather than held, because a click and a drag can
     * be inside this at once and a flag between them is one they would share. */
    const applyUpdates = async (updates, deliver) => {
      // Every update is classified before any is written. A refusal mid-batch
      // is a fact about the world; a malformed update is the fold's own bug,
      // and finding it after half the batch has landed is worse than not
      // writing at all.
      const ops = updates.map(opOf);
      let at = 0;
      while (at < updates.length) {
        const u = updates[at];
        const entity = u.entity ?? region.dataset.live;
        const op = ops[at];
        const id = u.id;
        let upto = at + 1;
        while (
          upto < updates.length && ops[upto] === op &&
          (updates[upto].entity ?? region.dataset.live) === entity
        ) upto += 1;
        const run = updates.slice(at, upto);
        try {
          if (op === "put") {
            await store.write(entity, run.map((x) => ({ key: x.id, row: x.row })), (err) => deliver(entity, id, err));
          } else if (op === "delete") {
            await store.drop(entity, run.map((x) => x.id), (err) => deliver(entity, id, err));
          } else {
            await store.patch(
              entity,
              run.map((x) => ({ key: x.id, changes: x.row })),
              (err) => deliver(entity, id, err),
            );
          }
        } catch (err) {
          // A fast refusal (rejected inside the store's acceptance window) is
          // the same fact as a late one and takes the same path. Anything else
          // stays the outer catch's network-error.
          if (err?.name !== "NonRetriableError") throw err;
          deliver(entity, id, err);
          return false;
        }
        at = upto;
      }
      return true;
    };

    const step = async (reduce, event, depth) => {
      const result = reduce({ items: getRows(), rows: await worldOf() }, event);
      // A `then` that is callable is a promise, not a command: an async reduce
      // otherwise resolves to undefined updates and does nothing at all.
      if (typeof result?.then === "function") {
        throw new Error(`handler for "${event.type}" returned a promise; a reduce returns its updates`);
      }
      if (!await applyUpdates(result?.updates ?? [], deliver)) return;
      const next = result?.then;
      if (!next?.type) return;
      // The terminal owns the depth. A cascade with no owner has no end, and
      // an app cannot bound one it cannot see.
      if (depth + 1 >= STEPS) {
        throw new Error(`handler chain did not settle in ${STEPS} steps at "${next.type}"`);
      }
      if (next.delay > 0) await rest(next.delay / TEMPO);
      const carried = { type: next.type };
      // A draw the reduce asked for. It has no randomness of its own — the
      // compartment endows nothing — so it says it wants one and is called
      // again with it, the same way it says it wants to wait. The terminal
      // owning the draw is also what lets a screen be replayed: with ?seed= it
      // draws from that instead, and the same run comes back.
      if (next.seed === true) carried.seed = draw();
      await step(reduce, carried, depth + 1);
    };

    const bind = (el, id) => {
      for (const { event, name } of onAttrs(el)) {
        const reduce = handlers.get(name);
        if (!reduce) continue;
        // Item nodes outlive a refresh, so each is wired once — re-wiring would
        // stack another listener on every render.
        const once = `_prontoOn_${event}`;
        if (el[once]) continue;
        el[once] = true;
        el.addEventListener(event, async (e) => {
          try {
            const fired = { type: event };
            if (id !== undefined) fired.id = id;
            // Which element fired, by the name it already has. A region binds
            // one handler and a screen has more than one affordance on it —
            // three answers to a raise are three buttons and one reduce — so
            // an event that says only that a click happened says too little.
            // The DOM id and not the class: the class is how a thing looks,
            // and a reduce that branched on it would be reading the styling.
            if (el.id !== "") fired.from = el.id;
            // Which animation ended, when one did. A screen runs more than one
            // clock — the terminal's own item arrivals among them — and they
            // all bubble to a region that declared this event, so a reduce
            // that means one of them has to be able to say which.
            // The field wears AnimationEvent's own property name.
            if (typeof e?.animationName === "string") fired.animationName = e.animationName;
            // What a unit answered. The only CustomEvent on this path is a
            // unit's named event, re-dispatched on its mount by bindHatches —
            // its detail was parsed against a fixed grammar and frozen at the
            // boundary, so what a reduce reads here is strings the terminal
            // built and never the unit's own object.
            if (e?.detail !== null && typeof e?.detail === "object") fired.detail = e.detail;
            await step(reduce, fired, 0);
          } catch (err) {
            console.error(err);
            setState("network-error");
          }
        });
      }
    };
    // Down the tree, not just at its root: an affordance is rarely the element
    // that declares the read. Inside an item it acts on that row and carries
    // its id; outside one it acts on what the region read. The walk stops at
    // the next [data-live], which binds its own.
    const bindTree = (root, id) => {
      bind(root, id);
      for (const el of root.querySelectorAll("*")) {
        if (!ownedBy(el, root)) continue;
        bind(el, id);
      }
    };
    // A slot's affordances are its own descendants, which persist, so the
    // whole tree is walked. A list's are its items, and only the ones not yet
    // wired are handed in: a surviving node was wired when it arrived and its
    // listeners outlive the refresh, so walking it again is a walk of the
    // whole list per write. Nothing else of a list's is left to bind — its
    // markup outside the items is swept on the first render.
    if (items === null) bindTree(region, undefined);
    else {
      bind(region, undefined);
      for (const item of items) bindTree(item, item.dataset.id);
    }

    // data-machine: the #Machine subset — machine.cue holds the vocabulary
    // and its doctrine — executed here without a compartment, because a
    // machine is data. Every transition lands as one stated row through the
    // same step() path as a reduce; leaves are called over the row-closed
    // world {items: [row]} (no rows key, so a reaching leaf fails on
    // undefined). `<type>@<dom-id>` narrows a transition to one affordance
    // with the bare type as its fallback, a state's transitions hide
    // root-level `on:` per exact key, and no transition for the current
    // (state, event) is a no-op, not an error.
    const charts = region.dataset.machine === undefined
      ? []
      : declaredCharts(region.dataset.machine, region.dataset.live);
    // Each chart is mounted on its own, knowing nothing of its siblings. What
    // they share is the ROW — `_prontoMachineRow` accumulates every chart's
    // stated columns within one tick, which is what makes two charts one write
    // — and everything a chart owns alone is keyed by its field.
    for (const machine of charts) {
      const mine = (what) => `_prontoMachine_${machine.field}_${what}`;
      // Naming a field outside the allowlist is an authoring error and throws.
      // An event that simply does not carry one is this transition declining —
      // a select firing an arrow written for a checkbox must not take the
      // screen down, and writing undefined would be a hole no later reader can
      // tell from a value the app meant.
      // Which state this chart's last transition entered, read by runMachine
      // to arm the timer. It never outlives one call, so it is not the
      // region's to hold.
      let entered;
      const NO_FIELD = Symbol("no field");
      const eventField = (event, field) => {
        if (!EVENT_FIELDS.has(field)) {
          throw new Error(`assign reads event.${field}, and an event carries ${[...EVENT_FIELDS].join(", ")}`);
        }
        return field in event ? event[field] : NO_FIELD;
      };

      const leafVal = (v, world, event) => {
        if (typeof v === "string" && handlers.has(v)) return handlers.get(v)(world, event);
        // The {type, params} object form (#Ref) is always a reference;
        // loading already threw at hydration for a name no module carries.
        if (v !== null && typeof v === "object") {
          if (v.type === "event") return eventField(event, v.params?.field);
          return handlers.get(v.type)(world, event, v.params);
        }
        return v;
      };

      const candidatesFor = (stateName, event) => {
        const stateOn = machine.states[stateName]?.on ?? {};
        const rootOn = machine.on ?? {};
        const out = [];
        const keys = event.from !== undefined ? [`${event.type}@${event.from}`, event.type] : [event.type];
        for (const key of keys) {
          const own = stateOn[key];
          const v = own ?? rootOn[key];
          if (v === undefined) continue;
          const origin = own !== undefined ? stateName : "*";
          machineCandidates(v).forEach((c, index) => out.push({ c, key, index, origin }));
        }
        return out;
      };

      // Ordered candidates, first guard-pass wins. All assigns read the
      // pre-transition snapshot and merge with the field write into ONE
      // stated row — the swap needs no temporary. A first write concluding
      // from the fallback states the whole fallback row, or the created row
      // falls outside the slot's filter and the machine visibly resets.
      const apply = (row, event, list, expectState) => {
        if (row === undefined) return { updates: [] };
        if (expectState !== undefined && row[machine.field] !== expectState) return { updates: [] };
        const world = { items: [row] };
        let chosen;
        for (const entry of list) {
          if (entry.c.guard === undefined) {
            chosen = entry;
            break;
          }
          const named = typeof entry.c.guard === "string" ? entry.c.guard : entry.c.guard.type;
          const g = handlers.get(named);
          if (g === undefined) throw new Error(`machine guard "${named}" names no module`);
          if (g(world, event, typeof entry.c.guard === "object" ? entry.c.guard.params : undefined)) {
            chosen = entry;
            break;
          }
        }
        if (chosen === undefined) return { updates: [] };
        const patch = {};
        for (const [col, v] of Object.entries(chosen.c.assign ?? {})) {
          const value = leafVal(v, world, event);
          if (value === NO_FIELD) return { updates: [] };
          patch[col] = value;
        }
        // Debug seam, like __prontoViews: which arrow fired, where it landed,
        // and the region that fired it. Nothing is pushed unless something
        // armed the array.
        globalThis.__prontoMachineTrace?.push({
          region,
          // Which chart drew it. Two charts on one region share the element, so
          // a walk filtering by region alone would read its sibling's arrows as
          // its own — and the field is what tells them apart everywhere else.
          field: machine.field,
          state: chosen.origin,
          key: chosen.key,
          index: chosen.index,
          to: chosen.c.target ??
            (Object.hasOwn(patch, machine.field) ? patch[machine.field] : row[machine.field]),
        });
        const out = { updates: [] };
        if (chosen.c.target !== undefined || Object.keys(patch).length > 0) {
          const stated = { ...(row === region._prontoFallbackRow ? row : { id: row.id, [machine.field]: row[machine.field] }), ...patch };
          if (chosen.c.target !== undefined) stated[machine.field] = chosen.c.target;
          out.updates = [{ op: "put", id: stated.id, row: stated }];
          // The chain's own view of the row: a raise delivered after this
          // write must conclude from it, not from the slot's last refresh —
          // the store's wake is asynchronous and the chain is not.
          region._prontoMachineRow = { ...row, ...stated };
        }
        // Entered even on a self-target: re-entry is what re-arms `after`.
        if (chosen.c.target !== undefined) entered = chosen.c.target;
        // raise is the reduce's then: under XState's name — delivered after
        // the writes, depth-bounded by the terminal.
        if (chosen.c.raise !== undefined) out.then = { type: chosen.c.raise };
        return out;
      };

      const machineRow = (state) => region._prontoMachineRow ?? state.items[0];

      const machineReduce = (state, event) => {
        const row = machineRow(state);
        if (row === undefined) return { updates: [] };
        return apply(row, event, candidatesFor(row[machine.field], event));
      };

      // Every invocation arms the state its chain ended in; the entered flag
      // is set even on a self-target, which is what re-arms the timer.
      const runMachine = async (reduce, event) => {
        entered = undefined;
        await step(reduce, event, 0);
        if (entered !== undefined) armAfter(entered);
      };

      // `after` is the relocated invoke: armed on state entry, canceled on
      // exit, re-armed by a self-target, performed by the terminal's clock.
      // The generation mark IS the cancellation — any arm bumps it, an
      // expired wait with a stale generation dies silently, and so the
      // duplicate-chain hazard is inexpressible here.
      const armAfter = (stateName) => {
        region[mine("afterGen")] = (region[mine("afterGen")] ?? 0) + 1;
        const gen = region[mine("afterGen")];
        region[mine("armed")] = stateName;
        const spec = machine.states[stateName]?.after;
        if (spec === undefined) return;
        for (const [key, t] of Object.entries(spec)) {
          const row = region._prontoMachineRow ?? getRows()[0];
          const world = { items: row === undefined ? [] : [row] };
          const ms = /^\d+$/.test(key) ? Number(key) : handlers.get(key)?.(world, { type: "after" });
          if (typeof ms !== "number") {
            throw new Error(`machine after "${key}" is neither milliseconds nor a module returning them`);
          }
          const list = machineCandidates(t).map((c, index) => ({ c, key: `after:${key}`, index, origin: stateName }));
          // A raise from an after transition routes through the full lookup;
          // only the timer's own event applies the armed transition, and only
          // while the machine still stands in the state that armed it.
          const timerReduce = (state, event) =>
            event.type === `after:${key}`
              ? apply(machineRow(state), event, list, stateName)
              : machineReduce(state, event);
          (async () => {
            await rest(ms / TEMPO);
            if (region[mine("afterGen")] !== gen) return;
            await runMachine(timerReduce, { type: `after:${key}` });
          })().catch((err) => {
            console.error(err);
            setState("network-error");
          });
        }
      };

      const shape = machineShape(machine);
      for (const type of shape.handled) {
        // Synthesized by the terminal, never dispatched by the DOM.
        if (type === "refused") continue;
        const once = mine(`on:${type}`);
        if (region[once]) continue;
        region[once] = true;
        region.addEventListener(type, async (e) => {
          try {
            const fired = { type };
            const src = e.target?.closest?.("[id]");
            if (src && src.id !== "" && region.contains(src)) fired.from = src.id;
            // The affordance, not whatever child the pointer landed on: a
            // <button><span>Go</span></button> delivers the span, and every
            // input declares `checked` and `valueAsNumber` whatever its type —
            // so admitting a field by presence would write false or NaN into
            // the row and call it the reader's answer.
            const ctl = e.target?.closest?.("input, select, textarea, button") ?? e.target;
            if (typeof ctl?.value === "string") fired.value = ctl.value;
            if (ctl?.type === "checkbox" || ctl?.type === "radio") fired.checked = ctl.checked === true;
            if (typeof ctl?.valueAsNumber === "number" && !Number.isNaN(ctl.valueAsNumber)) {
              fired.valueAsNumber = ctl.valueAsNumber;
            }
            if (typeof e.key === "string") fired.key = e.key;
            // Only where the chart reads it (fragment.js POINTER_FIELDS).
            if (shape.pointer) Object.assign(fired, pointerIn(e, src ?? ctl));
            // The ARROW declares the gesture, not the type: one narrowed to an
            // affordance declares it there, and cancelling elsewhere in the
            // region would take the UA's menu from a reader this app has
            // nothing to offer. Resolved synchronously — preventDefault cannot
            // survive an await.
            // A keydown joins them by its KEY rather than its type: scrolling
            // the page while the tabstop moves inside a group is a default
            // incoherent to keep, where a chart answering a printable key is a
            // reader typing and the browser's job stands. The set is the one
            // data-key already admits.
            if (DISPLACING_EVENTS.has(type) || (type === "keydown" && ROVING_KEYS.has(e.key))) {
              const row = region._prontoMachineRow ?? getRows()[0];
              if (row !== undefined && candidatesFor(row[machine.field], fired).length > 0) {
                e.preventDefault();
              }
            }
            await runMachine(machineReduce, fired);
          } catch (err) {
            console.error(err);
            setState("network-error");
          }
        });
      }
      if (shape.handled.includes("refused")) {
        machineRefused.push((fired) => {
          runMachine(machineReduce, fired).catch((err) => {
            console.error(err);
            setState("network-error");
          });
        });
        // A machine that draws the refused arrow is a mounted consumer of the
        // event whether or not a mutation reduce shares the region, so a
        // form's refusal must route here rather than to the .store-error
        // default.
        region._prontoRefusal = deliver;
      }
      // A state change the machine did not make — a refusal's rollback among
      // them — re-arms on the refresh it causes; the entered flag covers the
      // machine's own moves.
      const current = (region._prontoMachineRow ?? getRows()[0])?.[machine.field];
      if (current !== undefined && region[mine("armed")] !== current) armAfter(current);
    }

    // A mutation landed on this region's collection, and the terminal knows it
    // because it is the one that rendered it — so it says so, rather than
    // leaving an app to recover the fact by watching the DOM and reading rows
    // back out of attributes it may not even carry. `mutation` is the store's
    // word, which is mecha's word throughout, and never MutationObserver's: no
    // DOM change fires this.
    //
    // The seat makes self-waking a fixpoint rather than a spiral: a reduce
    // that writes its own collection wakes itself, finds itself running, and
    // is re-run once. A reduce that never settles is caught by the chain
    // bound in step().
    //
    // A mutation arriving while the reduce runs is remembered, not dropped.
    // Dropping it is only harmless for a reduce whose writes land somewhere
    // it does not itself read; one that concludes about its own collection
    // wakes itself, finds the flag up, and would sleep with its own last
    // write unanswered — a hand that stops halfway through a rodada. Waking
    // again terminates for the reason the flag does: a reduce that writes
    // nothing produces no mutation, so a settled one is not re-entered.
    if (rowsReduce) {
      // Keyed by the handler AND its declared world: regions sharing both are
      // one seat — two concurrent runs would each conclude from a world
      // missing the other's writes — while a region declaring different reads
      // concludes from a different world, and a coalesced re-run replaying
      // another region's closures would hand it rows it never declared.
      // NUL-joined because no authored attribute value can carry one.
      const seatKey = [
        region.dataset.onMutation,
        ...reads,
        ...[...region.attributes]
          .filter((a) => a.name.startsWith("data-read-"))
          .map((a) => `${a.name}=${a.value}`)
          .sort(),
      ].join("\u0000");
      const seat = folds.get(seatKey) ?? { running: false, again: false };
      folds.set(seatKey, seat);
      if (seat.running) seat.again = true;
      else {
        const wake = () => {
          seat.running = true;
          step(rowsReduce, { type: "mutation" }, 0)
            .catch((err) => {
              console.error(err);
              setState("network-error");
            })
            .finally(() => {
              seat.running = false;
              if (!seat.again) return;
              seat.again = false;
              wake();
            });
        };
        wake();
      }
    }
    return { deliver, apply: applyUpdates };
  }

  // top: only top-level regions drive the screen state machine; nested regions
  // (inside a parent's template item) bind silently.
  function hydrateRegion(region, ctx, top) {
    const table = region.dataset.live;
    // data-template references a named template instead of containing one; a
    // region carrying both would leave its own templates silently unused.
    const ref = region.dataset.template;
    if (ref !== undefined && region.querySelector("template[data-item]") !== null) {
      throw new ProgramError(`region "${table}" has both data-template and its own item templates`);
    }
    // A region holds any number of item templates, each optionally narrowed by
    // a data-when fragment (the one filter grammar, matched against the row
    // itself); one with no data-when admits every row.
    // The templates are the markup's, not the render's, and a render replaces
    // this element's children — so they are read once and kept. An empty set
    // read back off the DOM is how a SLOT is spelled.
    const own = (region._prontoItemTemplates ??= [...region.querySelectorAll("template[data-item]")]);
    const templates = (ref !== undefined ? [resolveTemplate(ref)] : own).map((el) => {
      // An item is the template's first element child, and only that: a second
      // one is not rendered, not bound and not reported, so the region quietly
      // draws half of what the markup says it draws.
      if (el.content.children.length !== 1) {
        throw new ProgramError(
          `region "${table}" has a template with ${el.content.children.length} elements; an item is exactly one`,
        );
      }
      const when = el.getAttribute("data-when");
      if (when === null) return { el, admits: null };
      // A data-when is matched against the row itself, so its values are
      // literals — the closed grammar exhaustiveness lint can enumerate. A
      // placeholder here would compare rows against the brace text and admit
      // nothing, silently.
      if (HAS_PLACEHOLDER.test(when)) {
        throw new ProgramError(`region "${table}": data-when="${when}" carries a placeholder; data-when values are literals`);
      }
      const admits = parseFilter(when);
      if (admits === null) {
        throw new ProgramError(`region "${table}": data-when="${when}" is outside the translatable fragment subset`);
      }
      return { el, admits };
    });
    // First match in document order wins. A row no template admits is a broken
    // invariant — exhaustiveness is lint's job, and the runtime holds no
    // fallback shape.
    const templateFor = (row) => {
      const t = templates.find(({ admits }) => admits === null || admits.every((p) => p(row)));
      if (t === undefined) {
        throw new KindAdmissionError(`region "${table}": no template admits row ${JSON.stringify(row.id)}`);
      }
      return t.el;
    };
    const projection = region.dataset.project === undefined
      ? []
      : parseProjection(region.dataset.project, table);
    if (projection.length > 0 && templates.length === 0) {
      throw new ProjectionError(
        `region "${table}" is a slot and declares data-project; a projection states facts about a set of rows`,
      );
    }
    const opts = {};
    if (region.dataset.filter) {
      opts.filter = fromEnclosing(() => interpolateFilter(region.dataset.filter, ctx), table, "data-filter");
    }
    if (region.dataset.select) opts.select = region.dataset.select;
    // Carried in opts as well as passed to query, because the store keys a
    // maintained view on the whole read — order included — and subscribe is
    // handed nothing but opts.
    const order = region.dataset.order === undefined ? undefined : parseOrder(region.dataset.order, table);
    if (region.dataset.order) opts.order = orderOf(order, ctx, table);
    if (templates.length === 0) opts.singleton = true;
    // The machine is the writer of the initial fact: without data-empty-row a
    // singleton machine region binds a row synthesized from the filter's
    // equalities — facts about any row this region can ever show — plus
    // {field: initial}. The pk must be pinned or the first transition's put
    // has no key to write: a precondition, not a fallback.
    const mounted = region.dataset.machine === undefined
      ? []
      : declaredCharts(region.dataset.machine, table);
    let fallbackRow;
    if (region.dataset.emptyRow) {
      fallbackRow = declared(region.dataset.emptyRow, table, "data-empty-row");
    }
    else if (mounted.length > 0 && templates.length === 0) {
      const spec = parseFilterSpec(opts.filter ?? "") ?? [];
      const eqs = Object.fromEntries(spec.filter((s) => s.op === "eq").map((s) => [s.col, s.value]));
      if (eqs.id === undefined) {
        throw new ProgramError(
          `machine region "${table}" has no data-empty-row and its filter pins no id=eq.; the machine's first write would have no key`,
        );
      }
      // {...context, ...eqs, field: initial}: each chart states the initial
      // world, the filter's equalities add the facts any visible row carries,
      // and the field is the chart's own — a filter pinning it would herd rows
      // out of its own read and earns no override. Parallel charts hold
      // disjoint columns, so the merge cannot lose one of them: the row is the
      // union of what they each said, which is the row they all then write to.
      fallbackRow = { ...eqs };
      for (const chart of mounted) {
        fallbackRow = { ...(chart.context ?? {}), ...fallbackRow, [chart.field]: chart.initial };
      }
    }
    // Read back by the machine reduce (wired per refresh, outside this scope):
    // a write concluding from the fallback must state the whole fallback row.
    region._prontoFallbackRow = fallbackRow;
    let currentRow;
    // The slot's one ctx, mutated in place across refreshes. bind() wires each
    // listener once, and the step/worldOf closures it captures read this
    // object — a fresh ctx per refresh would pin every named read and hidden
    // value to the first row the slot ever bound.
    const slotCtx = { params: ctx.params, inert: ctx.inert, row: undefined };
    // A named template may reference itself, so nesting depth is data-driven
    // and its floor is a leaf whose child read returns no rows. Cyclic data
    // removes the floor: the same (template, row) pair hydrating inside itself
    // re-derives an identical subtree forever. The repeat is caught as the
    // cycle closes, before the descent floods the store.
    const chainInto = (tmpl, row) => {
      const link = `${table}:${String(row.id)}`;
      if ((ctx.chain ?? []).some((c) => c.tmpl === tmpl && c.link === link)) {
        throw new TemplateCycleError(
          `region "${table}": row ${JSON.stringify(row.id)} recurses into its own shape — the data cycles`,
        );
      }
      return [...(ctx.chain ?? []), { tmpl, link }];
    };
    /**
     * The rows as they are bound. `currentRows` keeps the stored ones: a
     * machine reads its row off those, and a derived column reaching a
     * transition would widen what a chart is decidable from.
     *
     * `eq`'s value resolves against this region's own ctx, which is the
     * enclosing row mutated in place — so the answer follows the parameter
     * without the node being rebuilt.
     */
    const projected = (rows) => {
      if (projection.length === 0) return rows;
      const answers = projection.map((p) => {
        if (p.kind !== "eq") return p;
        try {
          return { ...p, want: interpolate(p.value, ctx) };
        } catch (err) {
          // lookup's own error, which is a plain one: a clause naming a column
          // the enclosing row lacks is the same program error as one naming a
          // column its own rows lack, and has to reach a reader the same way.
          throw new ProjectionError(`region "${table}": data-project "${p.name}" — ${err.message}`);
        }
      });
      // A lane is the run of rows a neighbour clause walks, in the filter and
      // order the region already declares: the whole set unpartitioned, or the
      // rows sharing this row's own value in the partition column. Built once
      // per column named, so a partitioned projection stays one pass.
      const lanes = new Map();
      const laneOf = (col) => {
        let built = lanes.get(col);
        if (built !== undefined) return built;
        const runs = new Map();
        const at = new Array(rows.length);
        rows.forEach((row, i) => {
          // Unlike `eq`, a row that cannot be placed makes every OTHER row's
          // answer wrong too — the lane it belongs to is short by one — so
          // there is no pending carve-out to make here.
          if (col !== undefined && !(col in row)) {
            throw new ProjectionError(
              `region "${table}": data-project partitions by {${col}}, not in row [${Object.keys(row)}]`,
            );
          }
          const key = col === undefined ? "" : String(row[col]);
          let run = runs.get(key);
          if (run === undefined) runs.set(key, run = []);
          at[i] = run.length;
          run.push(i);
        });
        built = { runs, at };
        lanes.set(col, built);
        return built;
      };
      const lane = (p, row, i) => {
        const { runs, at } = laneOf(p.by);
        const run = runs.get(p.by === undefined ? "" : String(row[p.by]));
        const j = at[i];
        // An end names itself: wrapping is the pattern's decision and APG
        // makes it differently per pattern, so the read tier declines it.
        if (p.kind === "next") return rows[run[Math.min(j + 1, run.length - 1)]].id;
        if (p.kind === "prev") return rows[run[Math.max(j - 1, 0)]].id;
        if (p.kind === "first") return rows[run[0]].id;
        return rows[run[run.length - 1]].id;
      };
      return rows.map((row, i) => {
        const derived = {};
        for (const p of answers) {
          // A fixture row answers `has` for every name by construction, so the
          // collision this guards cannot be told from a name the row simply
          // does not carry — and asking would refuse every projected region in
          // the storybook.
          if (ctx.inert !== true && p.name in row) {
            throw new ProjectionError(
              `region "${table}": data-project "${p.name}" is already a column of row ${JSON.stringify(row.id)}`,
            );
          }
          if (p.kind === "index") derived[p.name] = i + 1;
          else if (p.kind === "count") derived[p.name] = rows.length;
          else if (LANE_KINDS.has(p.kind)) derived[p.name] = lane(p, row, i);
          else if (p.kind === "eq") derived[p.name] = eqAnswer(row, p, table);
          // A kind parseProjection admits and this does not answer would
          // otherwise take whichever arm sits last, silently.
          else throw new ProjectionError(`region "${table}": no answer for clause kind "${p.kind}"`);
        }
        return { ...row, ...derived };
      });
    };

    /**
     * APG's other focus model: the affordances are focusable, one of them holds
     * the tabstop, and moving the caret moves DOM focus. Virtual focus needs
     * neither — `aria-activedescendant` names the active row and focus never
     * leaves the container — so this is the arm that has to reach the DOM.
     *
     * `data-rove` names the column that says which member is current, and the
     * terminal performs both effects it decides: the tab order, because the DOM
     * has one and a screen spelling it per member could disagree with itself,
     * and the focus.
     *
     * Focus follows the tabstop MOVING, which is the delta between two
     * consecutive views and not a fact about who caused it. The reader is the
     * other writer: Tab moves focus with no column changing, so a terminal
     * re-asserting focus on every refresh fights them for it — and a column
     * that did not change is every such refresh. Nothing is recorded to decide
     * this: a cause the rows do not carry would be state outside the algebra,
     * invisible to a trace and absent from a snapshot, so a replay would take
     * one path and a jump to the same state another.
     *
     * The column has ONE writer by construction, which is what makes the delta
     * the reader's own move: `roveLint` refuses a tabstop over an entity the
     * reader does not own, where a second reader's write would land as a jump
     * of this one's caret.
     */
    // Whether the region's markup can ever carry a member of either set. Asked
    // of the markup once rather than of the rendered tree on every refresh: a
    // region with none scans its whole list per write to learn nothing.
    const declares = (selector) =>
      region.querySelector(selector) !== null ||
      templates.some(({ el }) => el.content.querySelector(selector) !== null);
    const roving = declares("[data-rove]");
    const focusing = declares("[data-focus]");
    const dragging = templates.some(({ el }) => el.content.querySelector("[data-drag-handle]") !== null);
    const rove = () => {
      if (!roving) return;
      // Every stop the region owns, whatever row each came from. A list whose
      // rows are the members and a compile-time set of N members under one row
      // are the same set — the region's shape says nothing about the tabstop,
      // and a one-row list carrying a fixed set of affordances is both at once.
      const stops = [...region.querySelectorAll("[data-rove]")].filter((el) => ownedBy(el, region));
      if (stops.length === 0) return;
      const held = stops.find((el) => el.getAttribute("tabindex") === "0");
      const reading = stops.filter((el) => el.getAttribute("data-rove") === "true");
      // The invariant a set has, in either shape: one member is current. Two
      // would leave which one holds the tabstop to document order, and the
      // reader would find the caret somewhere the columns did not put it.
      if (reading.length > 1) {
        throw new ProgramError(
          `region "${table}": ${reading.length} members read data-rove="true"; a set has one current member`,
        );
      }
      const current = reading[0];
      // The attribute, not the property: the tab order is what the markup
      // states, so it has to be readable off the element the same way every
      // other stamped fact is.
      for (const el of stops) el.setAttribute("tabindex", el === current ? "0" : "-1");
      // A set that carried no tabstop is arriving, not moving: focusing on
      // first paint would take the page from whatever the reader opened it on.
      if (held === undefined || current === undefined || held === current) return;
      current.focus();
    };

    /**
     * Move focus to the member a column names, leaving the tab order alone.
     *
     * APG gives some patterns one tab stop and others — an accordion's headers
     * — every affordance in the Tab sequence with the arrows as an addition.
     * `data-rove` performs the first; this is the second, and the split matters
     * because stamping a tabstop where the standard keeps them all would take
     * headers OUT of the Tab sequence, which is a worse contract than the one
     * it replaces.
     *
     * Nothing is remembered and nothing is stamped to stand in for it: the DOM
     * already holds where focus is, so the rule reads it. Move only when the
     * reader is INSIDE this widget and on the wrong member — outside it, their
     * focus is not this region's business, and on the right member there is
     * nothing to do.
     *
     * What keeps the two writers from fighting is `focusin`: the reader's own
     * moves write the column, so a disagreement is the chart's move and never
     * theirs. `focusLint` refuses a region that does not hear it.
     */
    const moveFocus = () => {
      if (!focusing) return;
      const members = [...region.querySelectorAll("[data-focus]")].filter((el) => ownedBy(el, region));
      const reading = members.filter((el) => el.getAttribute("data-focus") === "true");
      if (reading.length > 1) {
        throw new ProgramError(
          `region "${table}": ${reading.length} members read data-focus="true"; a set has one current member`,
        );
      }
      const current = reading[0];
      if (current === undefined) return;
      const active = document.activeElement ?? null;
      if (active === current || !region.contains(active)) return;
      current.focus();
    };

    // Item nodes persist across refreshes, keyed by row id. A surviving node
    // keeps its listeners, its focus, its scroll position and any transition
    // it is mid-way through, and only its bindings are patched — rebuilding
    // the list instead costs all four, and leaves no node alive long enough
    // for an enter or exit animation to play on.
    const live = new Map();
    // Rows playing their exit, still in the list.
    let exiting = 0;
    let currentRows = [];
    // The first paint is not an arrival: animating every row in on load reads
    // as the page still assembling itself, and delays the moment it looks
    // ready. Only rows that arrive afterwards play.
    let first = true;


    // Regions nested inside an item, excluding any that sit under a deeper
    // one — those belong to that region's own pass.
    // Scoped to the item: closest() would walk past it to the enclosing
    // region, and an attached node always has one — so every nested region
    // looked like someone else's and syncNested below re-hydrated nothing.
    const nestedOf = (node) =>
      [...node.querySelectorAll("[data-live]")].filter((el) => ownedBy(el.parentElement, node));

    // A nested region's READ interpolates its parent's row, and is resolved
    // once at hydration. The node survives a refresh, so a read that no longer
    // matches the row it renders has to force a re-hydration, or the nested
    // region silently keeps querying the value its node was born with.
    //
    // Both halves of the read count. A closed order map moves with its key
    // exactly as a filter moves with its value, and the store keys a maintained
    // view on the whole read — so an order left out of this comparison is a
    // sortable header that writes its column and never re-reads.
    const syncNested = (entry, ready) => {
      for (const el of nestedOf(entry.node)) {
        const want = el.dataset.filter
          ? fromEnclosing(() => interpolateFilter(el.dataset.filter, entry.ctx), el.dataset.live, "data-filter")
          : undefined;
        const wantOrder = el.dataset.order === undefined
          ? undefined
          : orderOf(parseOrder(el.dataset.order, el.dataset.live), entry.ctx, el.dataset.live);
        // What this row says to the nested region other than its read: a
        // projection's parameter, an aria-activedescendant, a data-key naming
        // the form of whichever row is active. All of it moves without the
        // read moving, and nothing else re-binds it — the child subscribes to
        // its own table, which a write to THIS row never wakes. Re-rendering
        // keeps the nodes, and with them the reader's focus and selection.
        const held = entry.nested.get(el);
        if (held !== undefined && held.filter === want && held.order === wantOrder) {
          const bound = held.h.binds ? nestedBindings(el, entry.ctx) : "";
          if (held.bound !== bound) {
            held.bound = bound;
            ready.push(held.h.restate());
          }
          continue;
        }
        held?.h.stop();
        const h = hydrateRegion(el, entry.ctx, false);
        entry.nested.set(el, {
          h,
          filter: want,
          order: wantOrder,
          bound: h.binds ? nestedBindings(el, entry.ctx) : "",
        });
        ready.push(h.ready);
      }
    };

    // Stamps entry.node from tmpl and wires the forms the clone carries. The
    // wired closures read entry.ctx, which is mutated in place across
    // refreshes: a form on a surviving node must see the current row, not the
    // one its node was born with. The node itself counts: an item whose whole
    // markup is one form — a row of per-label file buttons, a per-row action —
    // is not inside itself, and querySelectorAll alone would leave it unwired,
    // clicking into silence.
    const stamp = (entry, tmpl) => {
      const node = tmpl.content.firstElementChild.cloneNode(true);
      node.dataset.id = entry.ctx.row.id;
      for (const form of formsIn(node)) {
        if (ownedBy(form, node)) wireForm(form, () => node.dataset.id, () => entry.ctx, region);
      }
      entry.node = node;
      entry.tmpl = tmpl;
      // Set once the node's keys and affordances are attached. A pass that
      // throws mid-way — a row missing a column the item binds — leaves it
      // unset, so the pass that succeeds wires what the first did not reach
      // rather than taking the node for done.
      entry.wired = false;
    };

    const eachNested = (fn) => {
      for (const entry of live.values()) for (const n of entry.nested.values()) fn(n.h);
    };

    const dropAll = () => {
      eachNested((h) => h.stop());
      live.clear();
    };

    const refresh = async (changes) => {
      const stored = await store.query(table, opts.order, opts);
      currentRows = stored;
      const rows = projected(stored);
      // Which rows this pass has to reconsider. null means all of them: a
      // first paint, a retry after an outage, or any wake the store could not
      // attribute to a delta.
      //
      // The delta names rows, never positions, so order below is still read
      // off the maintained array — 13 moves cost 0.1ms at 20 rows and have
      // never appeared in a profile.
      let dirty = null;
      if (Array.isArray(changes)) {
        dirty = new Set();
        for (const c of changes) {
          const id = c.value?.id ?? c.previousValue?.id;
          // A change we cannot attribute to a row makes the whole pass
          // unattributed; a wrong skip renders stale, which is the one
          // outcome worth spending a re-bind to avoid.
          if (id === undefined) {
            dirty = null;
            break;
          }
          dirty.add(String(id));
        }
      }
      // A derived column is a function of the whole set (index, count) or of a
      // value from outside the row (eq), so a row the delta never named can
      // still be showing a stale answer. Delta reconsideration is what that
      // costs, and on a long collection it is every row per pass.
      if (projection.length > 0) dirty = null;
      if (templates.length > 0) {
        {
          const ready = [];
          const order = [];
          // The nodes not yet wired, which are the ones with anything left
          // to attach.
          const fresh = [];
          const seen = new Set();
          let arriving = 0;
          for (const row of rows) if (!live.has(String(row.id))) arriving += 1;
          const entering = !first && arriving <= GESTURE;
          for (const row of rows) {
            const key = String(row.id);
            seen.add(key);
            let entry = live.get(key);
            const arrived = entry === undefined;
            if (arrived) {
              const tmpl = templateFor(row);
              entry = {
                ctx: { params: ctx.params, inert: ctx.inert, row, chain: chainInto(tmpl, row) },
                nested: new Map(),
              };
              stamp(entry, tmpl);
              live.set(key, entry);
              // Stamped before the node is in the document, so its arriving
              // style is the first one the browser ever computes for it.
              if (entering) playEnter(entry.node);
            } else {
              entry.ctx.row = row;
            }
            // An operator does not run when its input has not changed. A row
            // the delta did not name is already rendered from exactly this
            // value, so re-binding it would rebuild a body the reader may be
            // mid-selection in, and re-hydrate nested regions whose filters
            // cannot have moved.
            // A node not yet wired is bound whatever the delta says: its
            // first pass may have thrown before reaching it.
            if (arrived || dirty === null || dirty.has(key) || !entry.wired) {
              // A surviving row whose matched template changed re-stamps from
              // the new one: the old node's nested regions and hatches are
              // released exactly as the departed-row sweep releases them, and
              // DOM-private state (focus, selection, unsent text) goes with
              // the node — a kind flip is a shape change, not a patch.
              if (!arrived) {
                const tmpl = templateFor(row);
                if (tmpl !== entry.tmpl) {
                  entry.ctx.chain = chainInto(tmpl, row);
                  for (const n of entry.nested.values()) n.h.stop();
                  entry.nested.clear();
                  for (const el of hatchesIn(entry.node)) el._prontoHatch?.destroy();
                  const old = entry.node;
                  stamp(entry, tmpl);
                  if (old.isConnected) old.replaceWith(entry.node);
                }
              }
              // decision-offline-note-path: rows whose write is still
              // unconfirmed wear the pending badge. Deleted rather than set to
              // undefined — the DOMStringMap setter stringifies, so the badge
              // would stick on the literal "undefined" and never clear.
              if (row.$synced === false) entry.node.dataset.pending = "true";
              else delete entry.node.dataset.pending;
              bindAttributes(entry.node, entry.ctx);
              bindTexts(entry.node, entry.ctx, renderers);
              bindHatches(entry.node, entry.ctx);
              syncNested(entry, ready);
              if (!entry.wired) fresh.push(entry);
            }
            order.push(entry.node);
          }
          const departing = [];
          for (const [key, entry] of live) {
            if (!seen.has(key)) departing.push([key, entry]);
          }
          const leaving = departing.length <= GESTURE;
          // Everything going and nothing mid-exit is the list emptied in one
          // call: taking ten thousand rows out one at a time costs twice what
          // taking them out together does.
          const wholesale = !leaving && order.length === 0 && exiting === 0;
          const release = (node) => {
            // A hatch holds a page-level message listener; the node going
            // away is what releases it.
            for (const el of hatchesIn(node)) el._prontoHatch?.destroy();
            if (!wholesale) node.remove();
          };
          for (const [key, entry] of departing) {
            for (const n of entry.nested.values()) n.h.stop();
            // A row on its way out stays in the list until its animation ends.
            // A thousand of them have no animation worth waiting for.
            if (leaving) {
              exiting += 1;
              playExit(entry.node, () => {
                exiting -= 1;
                release(entry.node);
              });
            } else release(entry.node);
            live.delete(key);
          }
          await Promise.all(ready);
          // Anything neither current nor mid-exit is stale chrome — the
          // empty-state paragraph on the way back to populated.
          //
          // Text nodes go too, and that is load-bearing rather than tidiness:
          // a screen says "this region rendered nothing" with `:empty`, and
          // `:empty` does not match an element holding whitespace. The newline
          // between a probe's tags and its <template> is enough to make a
          // region that rendered no rows read as full.
          if (wholesale) region.replaceChildren();
          else {
            const keep = new Set(order);
            for (const child of [...region.childNodes]) {
              if (keep.has(child) || child.dataset?.exit !== undefined) continue;
              child.remove();
            }
          }
          // Minimal moves, stepping over nodes on their way out: a node already
          // in position is left where it is. Where moveBefore is absent that is
          // the only thing protecting its state (see HAS_MOVE_BEFORE); where it
          // is present, it still spares the layout work.
          let cursor = region.firstElementChild;
          for (const node of order) {
            while (cursor && cursor.dataset?.exit !== undefined) cursor = cursor.nextElementSibling;
            if (cursor === node) {
              cursor = cursor.nextElementSibling;
              continue;
            }
            // moveBefore requires a node that is already in the document; a row
            // stamped from the template this pass has never been in one.
            if (HAS_MOVE_BEFORE && node.isConnected) region.moveBefore(node, cursor);
            else region.insertBefore(node, cursor);
          }
          rove();
          moveFocus();
          if (order.length === 0 && region.dataset.empty) {
            // A list element admits only li children, so the note matches the
            // rows it stands in for.
            const p = document.createElement(/^(UL|OL)$/.test(region.tagName) ? "li" : "p");
            p.className = "empty";
            p.textContent = region.dataset.empty;
            region.append(p);
          }
          // The region's own element, from the ENCLOSING row rather than any
          // of its rows: a container naming one of them — a listbox's
          // aria-activedescendant — states a fact about the choice, not about
          // an option, and the choice is the row this region hangs under. A
          // slot has always bound its own element; the branch that renders
          // rows did not, so the one element between a container and the list
          // inside it was the only one nobody bound.
          // Bound from a row that is not this region's, so a placeholder naming
          // a column that row lacks is the same program error its
          // change-signature raises.
          fromEnclosing(() => bindElementAttributes(region, ctx), table, "own element");
          // The region's own element, and the items not yet wired: a key on
          // a surviving node was wired when the node arrived, and nothing
          // else of the region's markup survives the sweep.
          wireKeysOn(region);
          const nodes = fresh.map((f) => f.node);
          for (const node of nodes) wireKeysIn(node);
          const { deliver, apply } = wireEvents(region, nodes, () => currentRows, handlers, ctx);
          const reduce = handlers.get(region.dataset.handler);
          if (reduce && dragging) wireDrag(region, nodes, () => currentRows, reduce, deliver, apply);
          for (const f of fresh) f.wired = true;
          first = false;
        }
        if (top) {
          base = rows.length === 0 ? "empty" : "populated";
          if (["loading", "empty", "populated"].includes(screen.dataset.state)) setState(base);
        }
      } else {
        // Singleton region: the row must exist (seed doctrine), except where
        // data-empty-row supplies the fallback for pipeline sinks whose row
        // only appears after the first source event.
        if (rows.length > 1) {
          throw new SlotCardinalityError(
            `slot region "${table}" (filter ${JSON.stringify(opts.filter ?? "")}) matched ${rows.length} rows; a slot binds at most one`,
          );
        }
        let row = rows[0];
        if (row === undefined && fallbackRow !== undefined) row = fallbackRow;
        currentRow = row;
        // The store's answer now includes every machine write that preceded
        // this wake, so the chain-local view has nothing newer to add.
        region._prontoMachineRow = undefined;
        if (row === undefined) {
          // Vanished singleton (row deleted or its visibility revoked
          // mid-visit): the screen's "gone" state owns the frame. The output
          // goes with the input — leaving the last row's values standing is
          // how a deleted subject kept rendering itself under the notice
          // saying it was gone.
          if (top) setState(route.states?.includes("gone") ? "gone" : "empty");
          clearBindings(region);
          return;
        }
        if (top && screen.dataset.state === "gone") setState(base);
        slotCtx.row = row;
        // A singleton has affordances too, and its one row is what they act
        // on: the reduce is handed it the way a list's is handed its rows.
        wireEvents(region, null, () => (currentRow === undefined ? [] : [currentRow]), handlers, slotCtx);
        bindAttributes(region, slotCtx);
        wireKeysIn(region);
        bindTexts(region, slotCtx, renderers);
        bindHatches(region, slotCtx);
        rove();
        moveFocus();
      }
    };
    let retryTimer;
    let retryMs = 2000;
    // Refreshes are serialized, and a wake arriving during one is coalesced
    // into a single follow-up. They share the keyed item map and the region's
    // children, so two overlapping passes can interleave: the older one's
    // departed-row sweep deletes an entry the newer one just created, and the
    // pass after that treats a surviving row as an arrival. The subscription's
    // own coalescing only debounces scheduling — it does not wait for the
    // refresh it scheduled.
    //
    // The follow-up carries the union of what the coalesced wakes named. The
    // first wake's delta alone would leave the rows a later one named bound to
    // values the pass never read; a wake naming nothing widens the follow-up
    // to everything.
    let running = false;
    let queued = false;
    let queuedChanges;
    const refreshSerially = async (changes) => {
      if (running) {
        if (!queued) queuedChanges = changes;
        else if (queuedChanges !== undefined && changes !== undefined) queuedChanges = [...queuedChanges, ...changes];
        else queuedChanges = undefined;
        queued = true;
        return;
      }
      running = true;
      busy += 1;
      try {
        do {
          queued = false;
          await refresh(changes);
          changes = queuedChanges;
          queuedChanges = undefined;
        } while (queued);
      } finally {
        running = false;
        busy -= 1;
      }
    };
    // A dead gateway must degrade, never crash: a failed read leaves the
    // region's DOM (and every form in it) standing, flips the screen to
    // network-error, and re-probes on a capped backoff until the store answers
    // again.
    //
    // The change set rides through to refresh. Every other caller — the first
    // paint, resume, the outage retry — passes nothing, which reconsiders
    // every row.
    // A pass that threw bound nothing it was handed, and the wake that clears
    // its retry carries only its own rows. The pass after a failure is a full
    // one whatever it was handed, or the rows the failed delta named stay
    // bound to values no pass read.
    let stale = false;
    const guarded = async (changes) => {
      clearTimeout(retryTimer);
      try {
        await refreshSerially(stale ? undefined : changes);
        stale = false;
        retryMs = 2000;
        if (top && screen.dataset.state === "network-error") setState(base);
      } catch (err) {
        stale = true;
        // A slot that matched two rows, or a row no template admits, is a
        // broken invariant, not an outage: no retry can repair it, and the
        // network-error dressing would say the store is down when the data is
        // wrong. The rejection propagates — hydration fails on a first paint,
        // a later wake rejects loudly — and the next real change re-checks
        // without a timer.
        if (err instanceof ProgramError) throw err;
        console.error(err);
        if (top) setState("network-error");
        retryTimer = setTimeout(guarded, retryMs);
        retryMs = Math.min(retryMs * 2, 15000);
      }
    };
    let unsub = store.subscribe(table, guarded, opts);
    const detach = () => {
      clearTimeout(retryTimer);
      // An armed machine timer dies with the subscriptions — a wait expiring
      // on a torn-down region must not write into the live store — and the
      // cleared mark is what lets resume's refresh re-arm the standing state.
      for (const chart of mounted) {
        const gen = `_prontoMachine_${chart.field}_afterGen`;
        region[gen] = (region[gen] ?? 0) + 1;
        region[`_prontoMachine_${chart.field}_armed`] = undefined;
      }
      unsub?.();
      unsub = null;
    };
    cleanups.push(detach);
    if (templates.length === 0) {
      for (const form of region.querySelectorAll("form[data-action]")) {
        if (!ownedBy(form, region)) continue;
        wireForm(form, () => currentRow.id, () => ({ params: ctx.params, row: currentRow }), region);
      }
    }
    return {
      // Whether this region binds its own element from the row it hangs under
      // — the same condition that guards the call, and not re-derivable from
      // the DOM afterwards, since a first render sweeps the template away.
      binds: templates.length > 0,
      ready: guarded(),
      // A re-render on the same rows, for a parent whose projection parameter
      // moved. Not resume(): the subscription is already standing.
      restate: () => guarded(),
      // The region's half of the leave/return contract in shell.js.
      pause: () => {
        detach();
        eachNested((h) => h.pause());
      },
      resume: () => {
        unsub ??= store.subscribe(table, guarded, opts);
        eachNested((h) => h.resume());
        return guarded();
      },
      stop: () => {
        detach();
        dropAll();
      },
    };
  }

  const regions = [];
  const pending = [];
  for (const region of screen.querySelectorAll("[data-live]")) {
    if (region.parentElement.closest("[data-live]")) continue;
    const h = hydrateRegion(region, { params, inert: opts.fixtures === true }, true);
    regions.push(h);
    pending.push(h.ready);
  }
  // Screen chrome outside every region — a combobox's input sits beside the
  // listbox it drives, not inside it. Regions wire their own as they render.
  wireKeysIn(screen);


  // A hatch outside every region has no row to resynchronise against; its
  // props are whatever the screen-level {param.x} pass already resolved.
  for (const el of screen.querySelectorAll("[data-hatch]")) {
    if (!el.closest("template") && !el.closest("[data-live]")) {
      // And no reduce either: wireEvents runs per region, so out here the
      // listener would never be attached and the unit's answers would go
      // nowhere, silently. A hatch whose event has to reach a handler lives
      // inside a region — the same class of wiring mistake as naming a unit no
      // app declared, and refused in the same place.
      if (onAttrs(el).length > 0) {
        throw new Error(`data-hatch="${el.dataset.hatch}" declares data-on-* outside every [data-live]`);
      }
      bindHatches(el, { params, inert: opts.fixtures === true });
    }
  }

  for (const form of screen.querySelectorAll("form[data-action]")) {
    if (!form.closest("template") && !form.dataset.id && !form.closest("[data-live]")) {
      // A screen-level update/delete form addresses its row through its own
      // hidden id field (the {param.x} grammar) — the trash-note form sits
      // outside every region by design. Only a form with neither a region
      // nor a hidden id truly has no row context.
      const idField = form.querySelector('input[type="hidden"][name="id"]');
      wireForm(form, () => {
        if (idField?.dataset.value !== undefined) return resolveHidden(idField.dataset.value, { params });
        throw new Error("screen-level form has no row context");
      });
    }
  }

  await Promise.all(pending);
  if (regions.length === 0) {
    screen.dataset.state = route.states?.[0] ?? "populated";
  }

  // The terminal owns the navigation stack, so it needs more than a teardown:
  // a screen it is holding for a back press is paused, not stopped.
  return {
    pause: () => {
      for (const r of regions) r.pause();
    },
    resume: () => Promise.all(regions.map((r) => r.resume())),
    stop: () => {
      for (const r of regions) r.stop();
    },
  };
}
