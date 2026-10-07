// Screen interpreter: hydrates one emitted screen (HTML + CSS) against the
// store. The binding vocabulary is the pronto SPEC's; the shell owns every
// effect and the whole state machine — screens only style states.
import { renderInto } from "./render.js";
import { mountHatch } from "./hatch.js";
import {
  ABSENT,
  binding,
  directionOf,
  fillFilter,
  machineCandidates,
  machineShape,
  parseFilter,
  OrderError,
  parseFilterSpec,
  parseOrder,
  parseReadSpec,
  PLACEHOLDER,
  PLACEHOLDERS,
  ProgramError,
  routeHref,
  routeParams,
  Unanswered,
} from "./fragment.js";
import { evaluateRole } from "./jessie.js";
import { releaseReader } from "./release-assets.js";

export async function fetchText(url, init) {
  const res = await fetch(url, init).catch((err) => {
    // fetch rejects with a TypeError when no answer arrived at all.
    throw err instanceof TypeError ? new Unanswered(`nothing answered ${url}: ${err.message}`, { cause: err }) : err;
  });
  if (res.status >= 500) throw new Unanswered(`${res.status} fetching ${url}`);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.text();
}

const stylesheetLoads = new WeakMap();
function releaseStyle(id, css) {
  const prior = document.getElementById(id);
  const loading = stylesheetLoads.get(prior);
  if (loading?.css === css) return loading.ready;
  if (loading && !loading.done) return loading.ready.then(() => releaseStyle(id, css));
  const style = document.createElement("style");
  style.id = id;
  // Populate before insertion: appending an empty sheet first can fire a
  // load event before its imports finish. Keep the prior sheet until ready.
  style.textContent = css;
  const entry = { css, done: false, ready: null };
  entry.ready = new Promise((resolve, reject) => {
    const finish = (event) => {
      entry.done = true;
      style.removeEventListener("load", finish);
      style.removeEventListener("error", finish);
      if (event.type === "load") {
        prior?.remove();
        resolve();
      } else {
        style.remove();
        if (prior) prior.id = id;
        reject(new Error(`failed to load stylesheet ${id}`));
      }
    };
    style.addEventListener("load", finish);
    style.addEventListener("error", finish);
  });
  stylesheetLoads.set(style, entry);
  if (prior) {
    prior.removeAttribute("id");
    prior.after(style);
  } else document.head.append(style);
  return entry.ready;
}

// A screen's files asked for ahead of its mount, each taken once: the next
// visit fetches again, so a redeployed screen is never served from here.
const prefetched = new Map();
const screenFile = (url) => {
  const ahead = prefetched.get(url.href);
  if (ahead === undefined) return fetchText(url);
  prefetched.delete(url.href);
  return ahead;
};

/** Starts a route's markup and stylesheet loading before the mount that reads
 * them exists. The stylesheet is installed the moment it lands, so the shared
 * sheets it @imports load beside the data plane rather than after it. */
export function prefetchScreen(appBase, route) {
  const html = new URL(route.files.html, appBase);
  const css = new URL(route.files.css, appBase);
  const styleId = `screen-css-${route.screen}`;
  const ahead = [
    [html, fetchText(html)],
    [css, fetchText(css).then((text) => {
      if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = text;
        document.head.append(style);
      }
      return text;
    })],
  ];
  for (const [url, pending] of ahead) {
    // The mount awaits this promise and throws what it threw; the mark only
    // keeps a failure from being reported a second time before then.
    pending.catch(() => {});
    prefetched.set(url.href, pending);
  }
}

// A slot read that matched more than one row. Its own type so the outage
// guard can tell a broken cardinality invariant from a dead gateway.
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
// The seed's generator, declared ahead of the clock because a held clock can
// rewind it: a replay is the same seed from the same start, and `reset` is
// what puts the start back.
const seeded = params.get("seed");
const origin = seeded === null ? 0 : Number(seeded) >>> 0;
let entropy = origin;
let drawn = 0;
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
    // Back to table time zero and the seed's first draw, so a second mount in
    // the same process replays the first one rather than continuing it. A
    // queued wait or a refresh in flight belongs to a screen still running:
    // rewinding under it would fire that wait at a time it was never armed
    // for, so a dirty queue is refused, not cleared.
    reset() {
      if (pending.size > 0 || busy > 0) {
        throw new Error(`reset over ${pending.size} waits, ${busy} regions`);
      }
      held = 0;
      entropy = origin;
      drawn = 0;
    },
    // What is queued and how far off each is, soonest first, so a driver can
    // jump to the next thing that happens instead of stepping toward it, and
    // can tell a metronome from a wait that ends.
    due() {
      return [...pending]
        .map((w) => ({ in: w.at - held, label: w.label }))
        .sort((a, b) => a.in - b.in);
    },
    // How many draws the screen has made since the last reset: two runs that
    // drew a different number of times took different paths.
    draws: () => drawn,
  };
}
// Every wait says what armed it. The label is what due() reports, and a held
// clock with an unlabelled wait could only answer "something".
const rest = (ms, label) => {
  if (!MANUAL) return new Promise((resolve) => setTimeout(resolve, ms));
  if (label?.kind === undefined) throw new Error(`a held wait of ${ms}ms names no kind`);
  return new Promise((fire) => pending.add({ at: held + ms, fire, label }));
};
// The clock the screen reads, not the one the host runs: a held clock answers
// from where the caller advanced it, so a row stamped {now} lands on the same
// instant in every run. `?epoch` names that start; unset it starts at zero.
const epoch = params.get("epoch");
// A `timestamp` type is six fractional digits; toISOString spells three, so
// the stamp is padded rather than left a spelling the column refuses and every
// other holder of the same instant disagrees with.
const stamp = (ms) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
const now = () => {
  if (!MANUAL) return stamp(Date.now());
  // A held clock with no start would stamp 1970, which reads as a fixture
  // mistake rather than a missing knob — so the screen says which it is.
  if (epoch === null) throw new Error("a held clock stamps {now} only from an ?epoch");
  return stamp(Date.parse(epoch) + held);
};
const draw = () => {
  drawn += 1;
  if (seeded === null) return crypto.getRandomValues(new Uint32Array(1))[0];
  entropy = (entropy + 0x6D2B79F5) >>> 0;
  let t = Math.imul(entropy ^ (entropy >>> 15), 1 | entropy);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
};
// A key the terminal mints for a row or a blob. Seeded, it is four draws laid
// out as a version-4 uuid, so a replayed create writes the same key; unseeded,
// it is the platform's own.
const mintUuid = () => {
  if (seeded === null) return crypto.randomUUID();
  const hex = [draw(), draw(), draw(), draw()].map((n) => n.toString(16).padStart(8, "0")).join("");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
};

// Every role resolves the same way: the attribute names the role, its value
// names the module, and route.files.handlers is the app's list of Jessie
// sources whatever role each one plays.
async function loadRole(screen, appBase, route, attr, role, listed = "handlers", endowmentsMap = {}, read = fetchText) {
  const loaded = new Map();
  for (const el of screen.querySelectorAll(`[${attr}]`)) {
    const name = el.getAttribute(attr);
    if (loaded.has(name)) continue;
    const path = (route.files[listed] ?? []).find((p) => p.split("/").pop() === `${name}.js`);
    if (!path) throw new Error(`no Jessie module for ${attr}="${name}"`);
    const granted = endowmentsMap[path] ?? endowmentsMap[name] ?? endowmentsMap[`${name}.js`] ?? [];
    loaded.set(name, await evaluateRole(await read(new URL(path, appBase)), role, granted));
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

/** The adapter a control names, or undefined. Modules are loaded once per
 * screen and reached through the ctx every binding already carries. null is
 * the fixture adapter, which evaluates no module at all: a control binds its
 * column's text there, the way a handler wired to nothing does nothing. A map
 * that lacks the name is the other thing entirely — a screen naming a module
 * the route does not carry. */
function adapterOf(el, ctx) {
  const name = el.dataset?.valueAdapter;
  if (name === undefined || ctx?.adapters === null) return undefined;
  const adapter = ctx?.adapters?.get(name);
  if (adapter === undefined) throw new Error(`no Jessie module for data-value-adapter="${name}"`);
  return adapter;
}

async function loadAdapters(screen, appBase, route, endowmentsMap = {}, read = fetchText) {
  const loaded = await loadRole(screen, appBase, route, "data-value-adapter", "adapter", "adapters", endowmentsMap, read);
  // A control in an item template is bound per row, and its markup is not in
  // the screen's own tree — the same reason loadHandlers and loadRenderers
  // walk withTemplates.
  for (const scope of withTemplates(screen)) {
    for (const el of scope.querySelectorAll("[data-value-adapter]")) {
      const name = el.getAttribute("data-value-adapter");
      if (loaded.has(name)) continue;
      const path = (route.files.adapters ?? []).find((p) => p.split("/").pop() === `${name}.js`);
      if (!path) throw new Error(`no Jessie module for data-value-adapter="${name}"`);
      const granted = endowmentsMap[path] ?? endowmentsMap[name] ?? endowmentsMap[`${name}.js`] ?? [];
      loaded.set(name, await evaluateRole(await read(new URL(path, appBase)), "adapter", granted));
    }
  }
  return loaded;
}

async function loadHandlers(screen, appBase, route, endowmentsMap = {}, read = fetchText) {
  const loaded = await loadRole(screen, appBase, route, "data-handler", "handler", "handlers", endowmentsMap, read);
  // The same modules, reached by the other spelling. An item's handler lives in
  // a template, whose markup is never in the screen's own tree.
  for (const scope of withTemplates(screen)) {
    for (const el of scope.querySelectorAll("*")) {
      for (const { name } of onAttrs(el)) {
        if (loaded.has(name)) continue;
        const path = route.files.handlers.find((f) => f.split("/").pop() === `${name}.js`);
        if (!path) throw new Error(`no Jessie module for data-on-* handler "${name}"`);
        const granted = endowmentsMap[path] ?? endowmentsMap[name] ?? endowmentsMap[`${name}.js`] ?? [];
        loaded.set(name, await evaluateRole(await read(new URL(path, appBase)), "handler", granted));
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
          const granted = endowmentsMap[path] ?? endowmentsMap[name] ?? endowmentsMap[`${name}.js`] ?? [];
          loaded.set(name, await evaluateRole(await read(new URL(path, appBase)), "handler", granted));
        }
        for (const name of shape.assignStrings) {
          if (loaded.has(name)) continue;
          const path = route.files.handlers.find((f) => f.split("/").pop() === `${name}.js`);
          if (path) {
            const granted = endowmentsMap[path] ?? endowmentsMap[name] ?? endowmentsMap[`${name}.js`] ?? [];
            loaded.set(name, await evaluateRole(await read(new URL(path, appBase)), "handler", granted));
          }
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

// data-text-format names one of two things. plain, datetime, number and money
// are value formatting — text in, text out, no DOM. Any other name is a
// renderer: a Jessie module the app declared in files.renderers, resolved by
// basename exactly as a handler is.
const TEXT_FORMATS = new Set(["plain", "datetime", "number"]);

// The built-ins that format the looked-up VALUE rather than interpolate a
// sentence around it. plain is not one: it is the default spelled out.
const VALUE_FORMATS = new Set(["datetime", "number"]);

async function loadRenderers(screen, appBase, route, endowmentsMap = {}, read = fetchText) {
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
      const granted = endowmentsMap[path] ?? endowmentsMap[name] ?? endowmentsMap[`${name}.js`] ?? [];
      loaded[name] = await evaluateRole(await read(new URL(path, appBase)), "renderer", granted);
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
  "data-project", "data-order", "data-exit-motion", "data-machine",
]);

// What hydrating a region reads off its own element once, and holds for as
// long as the region runs.
const READ_ATTRS = new Set([
  "data-live", "data-template", "data-filter", "data-select", "data-order", "data-project",
  "data-exit-motion", "data-machine", "data-empty-row", "data-reads", "data-handler", "data-on-mutation",
]);
/** A region's read as its element states it. A newer template stating another
 * is another region, hydrated in its place rather than brought to it. */
const readOf = (el) =>
  [...el.attributes]
    .filter(({ name }) => READ_ATTRS.has(name) || name.startsWith("data-read-"))
    .map(({ name, value }) => `${name}=${value}`)
    .sort()
    .join("\n");
/** Whether the running region `h` is not the one `from` states. */
const moved = (h, from) => readOf(from) !== h.read || listRegion(from) !== h.binds;

const WHOLE_PLACEHOLDER = new RegExp(`^${PLACEHOLDER.source}$`);
// The key a slot's own entry is kept under, beside a list's rows.
const SLOT = Symbol("slot");

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
// A bound boolean attribute is absent when its value is empty or "false".
// `disabled=""` is disabled, so interpolating an empty string would pin the
// control shut — the same trap URL_ATTRS exists for, and the same answer.
const BOOL_ATTRS = new Set([
  "disabled", "checked", "readonly", "required", "selected", "hidden", "open", "multiple",
]);
const BLANK_PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

/** The language a screen is rendering in, from the most explicit thing its
 * context carries. The app's own default at the end and never a literal: a
 * language spelled here would outlive the catalogue it names the moment an app
 * renames its default, and every lookup would miss against a tag nothing
 * ships. Undefined for an app declaring no locales at all, which is most of
 * them. */
function localeOf(ctx) {
  return ctx?.params?.locale || ctx?.locale || ctx?.row?.locale || ctx?.i18n?.default;
}

// {msg.x} and {msg[col]} read the catalogue; everything else is `binding`'s.
function lookup(expr, ctx) {
  const { row, params, messages, locale, i18n } = ctx ?? {};
  // {msg[column]} names the message a ROW carries: the writer stored a key
  // rather than a sentence, so the text it stands for is the reader's to
  // choose. A column that has said nothing yet stands for nothing, which is
  // not the same as naming a message the catalogue is missing.
  const rowMsg = /^msg\[([a-z][a-z0-9_]*)\]$/.exec(expr);
  if (expr.startsWith("msg.") || rowMsg !== null) {
    const key = rowMsg === null ? expr.slice("msg.".length) : String((row ?? {})[rowMsg[1]] ?? "");
    if (rowMsg !== null && key === "") return "";
    const activeLocale = localeOf(ctx);
    let catalog = messages;
    if (catalog && activeLocale && activeLocale in catalog && typeof catalog[activeLocale] === "object") {
      catalog = catalog[activeLocale];
    }
    const resolveFrom = (dict) => {
      if (!dict || typeof dict !== "object") return undefined;
      if (key in dict) return dict[key];
      let v = dict;
      for (const seg of key.split(".")) {
        if (v == null || !(seg in Object(v))) return undefined;
        v = v[seg];
      }
      return v;
    };
    let val = resolveFrom(catalog);
    // The app's declared default and nothing else. A language spelled here
    // names a catalogue the app may not ship — `pt` stood here and stopped
    // answering the day truco declared `pt-BR` — and a miss against one is
    // indistinguishable from a key nobody wrote.
    if (val === undefined && messages && catalog !== messages) {
      val = resolveFrom(messages[i18n?.default]) ?? resolveFrom(messages.default);
    }
    if (val === undefined) {
      // A name written in the markup that no catalogue answers is the author's
      // mistake and stops the screen. A name a ROW carries is data: the
      // catalogue may not have caught up with it yet, and a row is never
      // allowed to take the screen down — it surfaces as the key itself, which
      // is what check-i18n reads and reports.
      if (rowMsg !== null) return key;
      throw new Error(`unknown message {${expr}}`);
    }
    if (Array.isArray(val)) return evaluateAst(val, ctx, activeLocale);
    return val;
  }
  const v = binding(expr, row, params);
  if (v !== ABSENT) return v;
  const r = row ?? {};
  // An optimistic insert carries only the submitted fields; DB-defaulted
  // columns materialize when the synced row arrives. Bind blank instead of
  // crashing the screen out from under the pending row.
  if (r.$synced === false) return undefined;
  throw new Error(`binding {${expr}} not in row [${Object.keys(r)}]`);
}

/**
 * Evaluates a compile-time FormatJS ICU MessageFormat AST in pure SES.
 * Handles literals (0), arguments (1), selects (5), plurals (6), and pounds (7).
 */
export function evaluateAst(ast, ctx, locale, pound) {
  if (typeof ast === "string") return ast;
  if (!Array.isArray(ast)) return String(ast ?? "");
  const loc = locale ?? localeOf(ctx) ?? "en-US";
  let out = "";
  for (const node of ast) {
    switch (node.type) {
      case 0:
        out += node.value;
        break;
      case 1:
        out += String(lookup(node.value, ctx) ?? "");
        break;
      case 5: {
        const val = String(lookup(node.value, ctx) ?? "");
        const opt = node.options?.[val] ?? node.options?.other;
        if (opt?.value !== undefined) {
          out += evaluateAst(opt.value, ctx, loc, pound);
        }
        break;
      }
      case 6: {
        const countVal = lookup(node.value, ctx);
        if (countVal === null || countVal === undefined || countVal === "" || !Number.isFinite(Number(countVal))) {
          throw new ProgramError(`plural "${node.value}" reads ${JSON.stringify(countVal)}, which is not a count`);
        }
        const count = Number(countVal);
        const offset = node.offset ?? 0;
        const n = count - offset;
        const exact = `=${count}`;
        const pr = pluralRulesFor(loc);
        const category = pr.select(n);
        const opt = node.options?.[exact] ?? node.options?.[category] ?? node.options?.other;
        if (opt?.value !== undefined) {
          const formattedPound = numberFormatFor(loc).format(n);
          out += evaluateAst(opt.value, ctx, loc, formattedPound);
        }
        break;
      }
      case 7:
        out += pound ?? "";
        break;
      default:
        throw new ProgramError(`unsupported ICU node type: ${node.type}`);
    }
  }
  return out;
}

// Constructing a PluralRules is expensive and this runs per binding per
// refresh, which is what FORMATTERS below is kept for too.
const PLURALS = new Map();
function pluralRulesFor(locale) {
  let rules = PLURALS.get(locale);
  if (rules === undefined) {
    rules = new Intl.PluralRules(locale);
    PLURALS.set(locale, rules);
  }
  return rules;
}

// The human timestamp behind data-text-format="datetime" bindings — raw column
// text (ISO / postgres timestamptz) never reaches the user. Unparsable values
// pass through so fixture rows stay visible in the storybook.
//
// Date and time are formatted APART and joined with our own ", ": one formatter
// carrying both would interpose CLDR's date-time connector, which reads ", " on
// V8 but " at " on JSC, making the format browser-dependent. That hazard is
// about one formatter spanning both fields, not about locales — so the split
// is what lets the reader's own language through rather than an argument for
// pinning it.
//
// The zone is the reader's, and `undefined` is how Intl spells that. It is
// passed rather than read because the checks render the same screens off a
// reader's machine — linkedom under deno, chromium under CI — where an ambient
// zone would make every date-bearing frame differ by where it was rendered.
// The storybook pins UTC, for the checks and for prerendered documents, and the
// test harness pins it for its cases; nothing else does.
//
// Constructing a DateTimeFormat is expensive and this runs per binding per
// refresh, so the pair is built once per (locale, zone) and kept.
const FORMATTERS = new Map();
function formattersFor(locale, timeZone) {
  const key = `${locale} ${timeZone ?? ""}`;
  let pair = FORMATTERS.get(key);
  if (pair === undefined) {
    pair = {
      date: new Intl.DateTimeFormat(locale, { timeZone, month: "short", day: "numeric" }),
      // h23, because the adjacent h24 cycle renders midnight "24:00" and
      // omitting the cycle gives an en-US reader "12:00 AM".
      time: new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    };
    FORMATTERS.set(key, pair);
  }
  return pair;
}

/** Exported so tests can pin the shape without hydrating a screen. `ctx` is a
 * screen's, and a caller that has none is asking for the app's default
 * language in the reader's own zone. */
export function formatDatetime(value, ctx) {
  if (value == null || value === "") return "";
  // Date takes postgres' "2026-08-02 09:00:00+00" as it stands; it is the
  // T-substitution that forces the offset repair beside it. The offset repair
  // mangles a date-only value, which falls through to the passthrough below.
  const iso = String(value).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(value);
  // An app that declares no locales names no language, and this is every such
  // app's every screen — not an error path. It renders what every app rendered
  // before a declared locale reached here at all, which is the change this is
  // deliberately not making: an app wanting its dates in its own language says
  // so by declaring one.
  const { date, time } = formattersFor(localeOf(ctx) ?? "en-US", ctx?.timeZone);
  return `${date.format(d)}, ${time.format(d)}`;
}

// The reader's own digits behind data-text-format="number" and "money" — a
// group separator is "." to a Brazilian and "," to an American, and a column's
// ASCII spelling is neither.
//
// A money column is an INTEGER count of minor units and says so on the column
// (schema.cue #Field.money), never in the markup: the integer alone does not
// say what it counts — xpense stores whole reais where the ordinary convention
// is cents — and a scale spelled into an attribute is a second place to look
// for the same fact. check-markup grades every such binding against the
// emitted schema for exactly that reason.
//
// Built once per locale: this runs per binding per refresh.
const NUMBERS = new Map();
function numberFormatFor(locale) {
  let fmt = NUMBERS.get(locale);
  if (fmt === undefined) {
    fmt = new Intl.NumberFormat(locale);
    NUMBERS.set(locale, fmt);
  }
  return fmt;
}

/** Exported so tests can pin the shape without hydrating a screen. Plain
 * number and decimal formatting using the reader's locale. */
export function formatNumber(value, ctx) {
  if (value == null || value === "") return "";
  const text = String(value).trim();
  if (!Number.isFinite(Number(text))) return text;
  // The string, not Number(text): a value wider than a double survives to the
  // formatter, which reads a decimal literal exactly.
  return numberFormatFor(localeOf(ctx) ?? "en-US").format(text);
}

/**
 * A region's derived columns. The clause set is closed and the refusals behind
 * it are the design; both are stated in
 * plugins/omnishell/docs/accessibility.md.
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
  const rawCharts = Array.isArray(value) ? value : [value];
  if (rawCharts.length === 0) {
    throw new ProgramError(`region "${table}": data-machine states no chart`);
  }
  const charts = [];
  for (const chart of rawCharts) {
    if (chart === null || typeof chart !== "object" || Array.isArray(chart)) {
      throw new ProgramError(`region "${table}": data-machine holds ${JSON.stringify(chart)}, which is not a chart`);
    }
    if (chart.type === "parallel") {
      for (const [regionName, regionNode] of Object.entries(chart.states ?? {})) {
        charts.push({
          field: regionNode.field ?? regionName,
          initial: regionNode.initial,
          context: regionNode.context ?? (regionNode.field ? chart.context : undefined),
          on: { ...chart.on, ...regionNode.on },
          states: regionNode.states ?? {},
          after: regionNode.after,
          always: regionNode.always,
          onDone: regionNode.onDone,
          entry: regionNode.entry,
          exit: regionNode.exit,
        });
      }
    } else {
      charts.push(chart);
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
    if (template === null || !PLACEHOLDER.test(template)) continue;
    out.push(`${name}=${fromEnclosing(() => interpolate(template, ctx), el.dataset.live, name)}`);
  }
  return out.join("\u0000");
}

function interpolate(template, ctx) {
  if (Array.isArray(template)) return evaluateAst(template, ctx, localeOf(ctx));
  return template.replace(PLACEHOLDERS, (_, expr) => String(lookup(expr, ctx) ?? ""));
}

function interpolateFilter(template, ctx) {
  return fillFilter(template, (expr) => lookup(expr, ctx));
}

// Hidden data-value grammar: literal "null" → JSON null; {now} → the terminal
// clock at submit time; anything else resolves from the form's row/param
// context.
function resolveHidden(template, ctx) {
  if (template === "null") return null;
  return template.replace(PLACEHOLDERS, (_, expr) =>
    expr === "now" ? now() : String(lookup(expr, ctx) ?? ""),
  );
}

/* --- a route's address, as markup states it ------------------------------
 *
 * The composition itself is fragment.js's (routeHref), and so is reading a
 * link's :params (routeParams), which the chrome asks too; this reads a
 * form's.
 */

export { routeParams };

/** The form's own inputs, by name: what a data-action="navigate" form fills
 * its route's :params from. */
export function formParams(form) {
  const out = {};
  for (const input of form.querySelectorAll("[name]")) out[input.name] = input.value;
  return out;
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
// A leaving row is no longer the data: while it plays, nothing may click it,
// read it or resolve an id to it — the row that replaces it may carry the same
// ids.
function playExit(node, done) {
  node.dataset.exit = "";
  node.setAttribute("inert", "");
  node.setAttribute("aria-hidden", "true");
  for (const el of [node, ...node.querySelectorAll("[id]")]) el.removeAttribute("id");
  settle(node, done);
}

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

/** Whether `el` sits under a node committed to exit — playExit stamps the mark
 * and the node stays in the tree until its animation ends, so a query over the
 * live DOM reaches members the region has already let go of. */
function midExit(el, scope) {
  for (let n = el; n && n !== scope; n = n.parentElement) {
    if (n.hasAttribute?.("data-exit")) return true;
  }
  return false;
}

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
    for (const name of Object.keys(el._prontoAttrs ?? {})) {
      // Resolved at submit (resolveHidden), never bound back.
      if (name === "data-value" && el.type === "hidden") continue;
      el.removeAttribute(name);
    }
  }
  const targets = scope.matches?.("[data-text]") ? [scope] : [];
  targets.push(...scope.querySelectorAll("[data-text]"));
  for (const el of targets) {
    if (!ownedBy(el, scope)) continue;
    if (el.parentElement?.closest("[data-text-format]")) continue;
    el.textContent = "";
  }
}

// Regions whose content model is phrasing. A <p> inside one is markup no
// author could have written: it ends the container's phrasing flow, and a
// parser meeting it in a served page closes the container around it.
const PHRASING_REGION = /^(A|ABBR|B|BUTTON|CODE|EM|I|LABEL|OUTPUT|P|SMALL|SPAN|STRONG|H[1-6])$/;

/** The element a note may be, from the region it stands in: a list admits only
 * li, a table section only a row, a phrasing container only phrasing, and
 * everything else takes the paragraph the note reads as. */
const noteTag = (tag) =>
  /^(UL|OL)$/.test(tag) ? "li" : TABLE_SECTION.test(tag) ? "tr" : PHRASING_REGION.test(tag) ? "span" : "p";
const TABLE_SECTION = /^(THEAD|TBODY|TFOOT)$/;

/** How many columns a table section's note spans: the cells of the table
 * head's last row, else of the row its items are stamped from, else of a
 * slot's own row. */
function noteColumns(region, item) {
  const rowOf = (parent) => [...(parent?.children ?? [])].filter((c) => c.tagName === "TR");
  const table = region.closest("table");
  const head = [...(table?.children ?? [])].find((c) => c.tagName === "THEAD");
  const row = rowOf(head).at(-1) ?? rowOf(item?.content ?? item)[0] ?? rowOf(region)[0];
  if (row === undefined) {
    throw new ProgramError(
      `region "${region.dataset.live}": an empty note in a ${region.tagName.toLowerCase()} spans the table's columns, and the table has no thead row, no item row and no row of its own to count them by`,
    );
  }
  return [...row.children]
    .filter((c) => c.tagName === "TD" || c.tagName === "TH")
    .reduce((n, c) => n + Number(c.getAttribute("colspan") ?? 1), 0);
}

/**
 * The copy `data-empty` declares, for a region holding nothing: a list with no
 * rows, or a slot whose row is gone.
 *
 * Copy that is empty is no copy: a region declaring the empty string has
 * declared nothing to show, and a note holding it would put an element where
 * the region says there is none.
 *
 * A list's own sweep takes the note away; a slot has no sweep — its children
 * are the markup — so the node is held on the region rather than found by its
 * class, which is the app's to style and to author elsewhere.
 */
/** A form with no submit button submits on change: its controls carry the
 * row's state rather than an edit waiting to be sent. */
export function submitsOnChange(form) {
  return form !== null && form !== undefined && !form.querySelector('button, [type="submit"]');
}

function emptyNote(region, copy, ctx, item) {
  region._prontoEmpty?.remove();
  region._prontoEmpty = undefined;
  if (!copy) return;
  const note = document.createElement(noteTag(region.tagName));
  note.className = "empty";
  const text = ctx && PLACEHOLDER.test(copy)
    ? interpolate(copy, ctx)
    : copy;
  // A row's only content is cells: a paragraph in a table section is moved
  // out of the table by a parser reading the served page.
  if (TABLE_SECTION.test(region.tagName)) {
    const cell = document.createElement("td");
    cell.setAttribute("colspan", String(noteColumns(region, item)));
    cell.textContent = text;
    note.append(cell);
  } else note.textContent = text;
  region._prontoEmpty = note;
  region.append(note);
}

function bindTexts(scope, ctx, renderers = {}) {
  const targets = scope.matches?.("[data-text]") ? [scope] : [];
  targets.push(...scope.querySelectorAll("[data-text]"));
  for (const el of targets) {
    if (!ownedBy(el, scope)) continue;
    const format = el.dataset.textFormat;
    // Written only where it differs: a served row already saying it keeps
    // its text node, and the reader's selection in it.
    const write = (text) => {
      if (el.textContent !== text) el.textContent = text;
    };
    if (VALUE_FORMATS.has(format)) {
      write(el.dataset.text.replace(PLACEHOLDERS, (_, expr) =>
        format === "datetime"
          ? formatDatetime(lookup(expr, ctx), ctx)
          : formatNumber(lookup(expr, ctx), ctx),
      ));
      continue;
    }
    if (format !== undefined && format !== "plain") {
      const render = renderers[format];
      // Every format resolves at hydration, so an unresolved one can only be
      // the fixture adapter, which evaluates no Jessie. It shows the value as
      // text there, the way it shows a widget's markup unenhanced.
      if (render === undefined) write(interpolate(el.dataset.text, ctx));
      else renderInto(render, interpolate(el.dataset.text, ctx), el);
      continue;
    }
    write(interpolate(el.dataset.text, ctx));
  }
}

/** Marks a control edited once the reader types into it, until its form
 * resets, so no binding overwrites what has not been sent. */
function guardEdits(el) {
  if (el._prontoDirtyWired) return;
  el._prontoDirtyWired = true;
  el.addEventListener("input", () => {
    el._prontoDirty = true;
  });
  el.closest("form")?.addEventListener("reset", () => {
    el._prontoDirty = false;
  });
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
    if (template === null || !PLACEHOLDER.test(template)) continue;
    stash[name] = template;
    const attr = { name, value: template };
    // The fixture adapter: an interpolated img src would fire a real request
    // the moment it is set; a transparent pixel keeps the layout box instead.
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
      // toggle has to roll back where the user can see it. So is any control
      // whose form submits on change, for the same reason: the reader's pick
      // was the write, there is no unsent edit to protect, and a focused
      // select left un-bound goes on showing a value the row no longer holds.
      // A machine's control is the other exception: its arrows write every
      // keystroke into the row, so the row is what the reader typed, and a
      // machine that clears the column must clear the control. Only focus
      // holds it, so a rebind never moves the caret under the reader.
      const machined = el.closest("[data-machine]") !== null;
      if (machined && el === document.activeElement) continue;
      if (!machined && el.type !== "checkbox" && !submitsOnChange(el.closest("form"))) {
        if (el._prontoDirty || el === document.activeElement) continue;
        guardEdits(el);
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
      // A control's value is the control's own spelling and a column's is its
      // canonical type; data-value-adapter names the module that maps between them,
      // and a control naming none binds the column's text unchanged
      // (plugins/omnishell/REFERENCE.md#adapters).
      const adapter = adapterOf(el, ctx);
      if (adapter !== undefined) {
        el.value = adapter.format(interpolate(template, ctx), { zone: ctx.timeZone, locale: localeOf(ctx) });
        continue;
      }
      // The property, not the attribute: once a reader has typed, the
      // attribute no longer moves what the control shows.
      if (el.localName === "textarea" || el.localName === "select" || el.localName === "input") {
        const value = interpolate(template, ctx);
        el.value = value;
        // A select's options may be a list still to arrive; it re-applies this.
        if (el.localName === "select") el._prontoBound = el.value === value ? undefined : value;
        continue;
      }
    }
    const value = interpolate(template, ctx);
    if (BOOL_ATTRS.has(attr.name)) {
      if (value === "" || value === "false") el.removeAttribute(attr.name);
      else el.setAttribute(attr.name, value);
      continue;
    }
    // A URL attribute that resolves to nothing must not stay empty: the
    // empty string is a valid relative URL meaning "this document", so
    // `src=""` fetches the page and paints it as a broken image.
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
  }
  // Last, because the params it reads are the ones the loop above just
  // resolved. A row-bound link therefore re-addresses itself whenever its
  // region re-binds, and data-locale is how a language switcher links to the
  // page it is on in another language. A navigate form names a route too, and
  // takes no href: its :params are its inputs, and they are read at submit.
  if (el.dataset?.route !== undefined && el.localName !== "form") {
    const args = routeParams(el);
    // A param that bound to nothing is a destination that does not exist —
    // the row this link points at has no id yet. The href goes with it, the
    // way an empty URL attribute's does above, so the screen's own
    // `:not([href])` treatment is what the reader gets. A param the markup
    // never declared is a different thing and still raises: routeHref reads
    // undefined, and the link lint refused it at generate.
    const explicitLocale = (el.dataset.locale !== undefined && el.dataset.locale !== ctx.locale) || Boolean(ctx.cfg?.i18n && ctx.locale === ctx.cfg.i18n.default && typeof location !== "undefined" && new URLSearchParams(location.search).has("lang"));
    const href = routeHref(ctx.cfg, el.dataset.route, args, el.dataset.locale ?? ctx.locale, { explicitLocale });
    if (href === undefined) el.removeAttribute("href");
    else el.setAttribute("href", href);
  }
}


function astNeedsRow(ast, params) {
  if (!Array.isArray(ast)) return false;
  for (const node of ast) {
    if (node.type === 1 || node.type === 5 || node.type === 6) {
      const varName = node.value;
      if (!params || !(varName in params)) return true;
      if (node.options) {
        for (const opt of Object.values(node.options)) {
          if (opt?.value && astNeedsRow(opt.value, params)) return true;
        }
      }
    }
  }
  return false;
}

function staticOrParam(template, ctx) {
  const exprs = [...template.matchAll(PLACEHOLDERS)].map((m) => m[1]);
  if (exprs.length === 0) return false;
  for (const e of exprs) {
    if (e.startsWith("param.")) continue;
    if (e.startsWith("msg.")) {
      if (ctx?.messages) {
        const key = e.slice("msg.".length);
        const catalog = ctx.messages[ctx.locale] ?? ctx.messages[ctx.i18n?.default] ?? ctx.messages.default ?? Object.values(ctx.messages)[0];
        const val = catalog?.[key];
        if (astNeedsRow(val, ctx.params)) return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

// opts.handlers: false skips handler loading (the storybook's fixture adapter —
// drag stays inert there). opts.units carries shell.yaml's vendored-unit
// declarations, which is what a data-hatch name resolves against. opts.routes
// and opts.i18n are the table every link's address is composed from, and
// opts.navigate is how a navigate form reaches the terminal's stack.
export async function interpretScreen(mount, appBase, route, store, params = {}, opts = {}) {
  const screenOpts = opts;
  const read = opts.release ? releaseReader() : fetchText;
  const files = [new URL(route.files.html, appBase), new URL(route.files.css, appBase)];
  let [html, css] = await Promise.all(files.map(opts.release ? read : screenFile));
  const styleId = `screen-css-${route.screen}`;
  // A document the shell was served or kept for this address (document.js): its
  // screen is taken over where it stands rather than drawn again, so nothing
  // on show is replaced and nothing the reader has done to it is lost.
  const served = opts.served;
  // The document and the worker's copies of its files are each any deploy
  // old, and a hash cannot say which of two is the newer. Where they disagree
  // the network says which is current: a revalidating request, which the
  // worker answers past its copy (offline-first-sw.js).
  if (!opts.release && served !== undefined && (served.cas !== templateHash(html) || document.getElementById(styleId)?.textContent !== css)) {
    [html, css] = await Promise.all(files.map((url) => fetchText(url, { cache: "no-cache" })));
  }
  if (opts.release) await releaseStyle(styleId, css);
  else {
    let style = document.getElementById(styleId);
    if (style === null) {
      style = document.createElement("style");
      style.id = styleId;
      document.head.append(style);
    }
    if (style.textContent !== css) style.textContent = css;
  }

  // Subscriptions of the previously mounted screen would refresh dead DOM and
  // keep their poll keys hot — stop them before mounting the next one.
  for (const stop of mount._prontoStops ?? []) stop();
  const cleanups = [];
  mount._prontoStops = cleanups;
  // One seat per data-on-mutation handler, screen-wide (see wireEvents).
  const folds = new Map();
  const work = new Set();
  const derived = new Map();
  const dirty = new Set();
  let failure;
  let settling;
  const failed = (err) => {
    failure ??= err;
  };
  const track = (promise) => {
    const tracked = promise.then((value) => {
      work.delete(tracked);
      return value;
    }, (err) => {
      work.delete(tracked);
      failed(err);
      throw err;
    });
    work.add(tracked);
    return tracked;
  };
  const finite = (run) => {
    // A seat's finally can start another fold. Its lifecycle belongs to
    // readiness until the chain explicitly hands control to a future timer.
    let pause;
    const waiting = new Promise((resolve) => (pause = resolve));
    const running = run(pause);
    track(Promise.race([running, waiting])).catch(failed);
    return running;
  };
  const checkSettlement = (region) => {
    if (settling === undefined) return;
    const passes = (settling.get(region) ?? 0) + 1;
    settling.set(region, passes);
    if (passes > 256) throw new ProgramError(`screen did not settle: ${region.dataset.live} exceeded 256 passes`);
  };
  const settle = async () => {
    if (settling !== undefined) throw new Error("screen settlement is already running");
    settling = new Map();
    try {
      for (let turns = 0;; turns++) {
        if (turns >= 256) throw new ProgramError("screen did not settle in 256 turns");
        if (failure !== undefined) throw failure;
        await Promise.allSettled([...work]);
        // A completed fold can enqueue its next seat or a store wake after
        // the promise it wrote through answers. Drain those before declaring
        // the document complete, without waiting on the store's streams.
        await Promise.resolve();
        const wakes = store.flushNotifications?.() ?? 0;
        const changed = [...dirty];
        dirty.clear();
        // A child can read an absent seed before its parent writes it. The
        // parent's fallback and stored row bind identically, so no ordinary
        // nested rebind wakes that auxiliary read.
        const readers = new Set(changed.flatMap((table) => [...(derived.get(table) ?? [])]));
        for (const refresh of readers) refresh();
        if (failure !== undefined) throw failure;
        if (work.size === 0 && wakes === 0 && dirty.size === 0) return;
      }
    } finally {
      settling = undefined;
    }
  };

  // The screen as its template states it, every {param.*} and {msg.*}
  // resolved: what a mount connects, and what a served screen is read against
  // and brought to when it is adopted.
  const prepare = (text) => {
    const holder = document.createElement("template");
    holder.innerHTML = text;
    const root = holder.content.firstElementChild;
    localize(root);
    // A URL still carrying its placeholder is a URL the document would fetch
    // the instant this tree is connected — `src="{image_url}"` is a relative
    // path, and the request 404s before any row exists to bind. Stash the
    // template the way bindAttributes does and neutralise the attribute until
    // it resolves.
    for (const el of [root, ...root.querySelectorAll("*")]) {
      for (const attr of [...(el.attributes ?? [])]) {
        if (!URL_ATTRS.has(attr.name) || !PLACEHOLDER.test(attr.value)) continue;
        (el._prontoAttrs ??= {})[attr.name] = attr.value;
        if (el.localName === "img" && attr.name === "src") el.setAttribute("src", BLANK_PIXEL);
        else el.removeAttribute(attr.name);
      }
    }
    return root;
  };

  let currentLocale = opts.locale ?? params.locale ?? opts.i18n?.default;
  // A screen's own script says things the markup cannot bind — chrome that
  // outlives the row it speaks for. It reads the catalogue the bindings read,
  // so one app never keeps the same sentence in two places.
  globalThis.__prontoMessages = opts.messages;
  // What a binding reads off the app rather than off its row: the route table
  // and the locales every link's address is composed from (routeHref).
  const cfg = { routes: opts.routes, i18n: opts.i18n, schema: opts.schema, prefix: opts.prefix, endowments: opts.endowments };
  // Loaded below, before anything binds; the ctx carries the map so an adapter
  // is reached the way a message catalogue is, and every derived ctx keeps it.
  let adapters = null;
  const screenCtx = {
    params,
    inert: opts.fixtures === true,
    messages: opts.messages,
    i18n: opts.i18n,
    // The storybook and the test harness pass UTC so a rendered moment does not
    // differ by the machine that rendered it; it rides the ctx the way locale
    // does because every formatted binding reads it from there. Resolved here rather than
    // left undefined — Intl's spelling for "the host's own" — because an
    // adapter takes the zone as data and may read none for itself, and because
    // one render answers from one zone throughout.
    timeZone: opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    get adapters() {
      return adapters;
    },
    cfg,
    get locale() {
      return currentLocale;
    },
  };

  // {param.*} and {msg.*} resolve anywhere under `root`; row-level locale
  // switches re-evaluate them in place without remounting the DOM. Each is
  // written only where it differs, so a served screen that already says it
  // keeps its text nodes, and the reader's selection in them.
  const localize = (root) => {
    root.dataset.locale = currentLocale;
    // A screen can be in a language the document is not: a row carrying its own
    // `locale` switches this one and leaves the rest of the page alone. The
    // document's dir is the chrome's; this one is the screen's, and without it
    // an Arabic match inside a Portuguese app lays out left-to-right.
    if (currentLocale !== undefined) root.dir = directionOf(currentLocale);
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (el.dataset?.text && staticOrParam(el.dataset.text, screenCtx)) {
        const text = interpolate(el.dataset.text, screenCtx);
        if (el.textContent !== text) el.textContent = text;
      }
      for (const attr of [...(el.attributes ?? [])]) {
        if (regionAttr(attr.name) || attr.name === "data-value") continue;
        const template = (el._prontoAttrs ?? {})[attr.name] ?? attr.value;
        if (staticOrParam(template, screenCtx)) {
          if (PLACEHOLDER.test(template)) {
            (el._prontoAttrs ??= {})[attr.name] = template;
          }
          const value = interpolate(template, screenCtx);
          if (attr.value !== value) el.setAttribute(attr.name, value);
        }
      }
    }
    // A link carries the locale of the page it is on, so a switch re-addresses
    // every one whose :params are already known. A row-bound link still holds
    // its placeholders here and is addressed when its region binds.
    for (const el of root.querySelectorAll("[data-route]:not(form)")) {
      const routeArgs = routeParams(el);
      if (Object.values(routeArgs).some((v) => PLACEHOLDER.test(v))) continue;
      const explicitLocale = (el.dataset.locale !== undefined && el.dataset.locale !== currentLocale) || Boolean(cfg.i18n && currentLocale === cfg.i18n.default && typeof location !== "undefined" && new URLSearchParams(location.search).has("lang"));
      const href = routeHref(cfg, el.dataset.route, routeArgs, el.dataset.locale ?? currentLocale, { explicitLocale });
      if (href === undefined) el.removeAttribute("href");
      else if (el.getAttribute("href") !== href) el.setAttribute("href", href);
      // Which option of a language switcher is the page the reader is already
      // on. It rides the address rather than the mount because it moves when
      // the address does, and this pass is what a switch re-runs. Only an
      // element NAMING a locale can be the current one: every other link is in
      // the reader's language already, so marking them all would say nothing.
      if (el.dataset.localeCurrent !== undefined) {
        const current = el.dataset.localeCurrent || "page";
        if (el.dataset.locale !== currentLocale) el.removeAttribute("aria-current");
        else if (el.getAttribute("aria-current") !== current) el.setAttribute("aria-current", current);
      }
    }
  };
  const applyLocale = (newLocale) => {
    currentLocale = newLocale;
    localize(screen);
  };

  const markup = prepare(html);
  const cas = templateHash(html);
  const screen = served?.screen ?? markup;

  let base = screen.getAttribute("data-state") || route.states?.[0] || "populated";
  const setState = (s) => {
    screen.dataset.state = s;
  };
  setState(base);
  // The regions whose outage the screen says: a top region whose read failed,
  // a nested region whose first read did. Whichever reads again last puts the
  // state back, so a region nested two deep that recovers on its own pass
  // clears what it set, and a top region's pass does not clear what a nested
  // one still says.
  const outages = new Set();

  if (served === undefined) {
    // Connect only once the tree carries its state: screens style themselves
    // per `[data-state]`, so a screen mounted before this paints with every
    // state-scoped rule inert — every region visible at once, links wearing
    // the user-agent underline — for as long as the awaited loads below take.
    mount.replaceChildren(screen);
    for (const s of screen.querySelectorAll("script")) {
      const fresh = document.createElement("script");
      fresh.textContent = s.textContent;
      s.replaceWith(fresh);
    }
  } else {
    // The witness: the template the document was rendered from, which this
    // one is or is not. One it is not is morphed to this one first, and each
    // row its lists hold, stamped from an older item, is morphed to this
    // template's as its region adopts it.
    const current = served.cas === cas;
    if (!current) await morphScreen(screen, markup, { slots: true });
    adoptTree(markup, screen, { rows: current, scripts: true });
    // The words are this catalogue's, whichever the document was drawn with.
    localize(screen);
  }

  const endowmentsMap = {
    ...(cfg?.endowments ?? {}),
    ...(opts.endowments ?? {}),
    ...(route.files?.endowments ?? {}),
    ...(route.endowments ?? {}),
  };
  const handlers = opts.handlers === false ? new Map() : await loadHandlers(markup, appBase, route, endowmentsMap, read);
  adapters = opts.handlers === false ? null : await loadAdapters(markup, appBase, route, endowmentsMap, read);
  const renderers = opts.handlers === false
    ? {}
    : await loadRenderers(markup, appBase, route, endowmentsMap, read);

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
  for (const scope of withTemplates(markup)) {
    for (const el of scope.querySelectorAll("[data-hatch]")) resolveUnit(el.dataset.hatch);
  }

  // Named templates are screen-scoped, collected once here. A region inside a
  // named template may reference the very template it sits in — recursion,
  // terminating through data when a leaf's child read returns no rows.
  // Every data-template resolves before a region hydrates, for the same
  // reason every hatch name does: inside a refresh the dead-gateway path
  // would dress the wiring mistake as a network error and retry it forever.
  const templatesOf = (root) => {
    const named = new Map();
    for (const scope of withTemplates(root)) {
      for (const t of scope.querySelectorAll("template[data-item][data-name]")) {
        const name = t.getAttribute("data-name");
        if (named.has(name)) throw new Error(`two templates declare data-name="${name}"`);
        named.set(name, t);
      }
    }
    for (const scope of withTemplates(root)) {
      for (const el of scope.querySelectorAll("[data-template]")) {
        const name = el.getAttribute("data-template");
        if (!named.has(name)) throw new Error(`no template declares data-name="${name}"`);
      }
    }
    return named;
  };
  let namedTemplates = templatesOf(markup);
  // Drafts return after adoption checks the template's structure, before
  // a pending read lets the reader edit the replacement controls.
  let preserveMorph;
  const resolveTemplate = (name) => {
    const t = namedTemplates.get(name);
    if (t === undefined) throw new Error(`no template declares data-name="${name}"`);
    return t;
  };

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
      // Same reason the fixture adapter keeps img src inert: a storyboard frame
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
    return typeof declared === "string" && PLACEHOLDER.test(declared);
  };

  // data-key='{"<key>": "<form id>"}' submits a form on a key, the way a form
  // with no submit button submits on change. The id interpolates, so the map is
  // read at event time; the keys are literals, so they are checked once.
  /** Every key binding at or under `scope` that no deeper region owns,
   * named by id and wired once per element. */
  function wireKeysIn(scope) {
    wireKeysOn(scope);
    for (const el of scope.querySelectorAll("[data-key]")) if (ownedBy(el, scope)) wireKeys(el);
  }
  /** The element's own bindings, and none of its descendants'. */
  function wireKeysOn(el) {
    if (el.dataset?.key !== undefined) wireKeys(el);
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
    // Once per form, and everything it acts on is read at the gesture: what
    // it declares, which a newer template may change, and the row and region
    // of whoever wired it last, which a region hydrated again in place is.
    form._prontoWiring = { rowId, getCtx, region };
    if (form._prontoForm) return;
    form._prontoForm = true;
    const wiring = () => form._prontoWiring;
    // The shell owns validation so the storyboard's validation-error state is
    // observable; native tooltips would swallow the submit instead.
    form.noValidate = true;
    // Store resolution can lag the submit (acceptance window); a reset landing
    // then must not wipe input the user has typed since — rapid list entry
    // (add-line, capture) would lose every second entry.
    let edits = 0;
    const values = async () => {
      const ctx = wiring().getCtx();
      const out = {};
      for (const input of form.querySelectorAll("[name]")) {
        const adapter = adapterOf(input, screenCtx);
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
          const key = `${mintUuid()}${ext}`;
          const res = await fetch(`/blobs/mecha-objects/${key}`, { method: "PUT", body: file });
          if (!res.ok) throw new Error(`${res.status} PUT /blobs/mecha-objects/${key}`);
          out[input.name] = key;
        } else if (input.type === "hidden" && input.dataset.value !== undefined) {
          out[input.name] = resolveHidden(input.dataset.value, ctx);
        } else if (adapter !== undefined) {
          // Read at the gesture, from the control the reader just typed in:
          // the inputs are both in hand, so there is nothing to materialise
          // and nothing to wait for. The modules and the zone are the screen's
          // — a form's own ctx carries the row it writes, and nothing else.
          out[input.name] = input.value === "" ? null : adapter.parse(input.value, { zone: screenCtx.timeZone, locale: localeOf(screenCtx) });
        } else out[input.name] = input.value.trim();
      }
      return out;
    };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const entity = form.dataset.entity;
      const action = form.dataset.action;
      const invalid = form.querySelector(".invalid");
      if (!form.checkValidity()) {
        invalid?.removeAttribute("hidden");
        setState("validation-error");
        return;
      }
      invalid?.setAttribute("hidden", "");
      // navigate forms carry no data-entity: the navigation is the whole
      // effect and its feedback — no store call, no success state. The
      // terminal owns the stack, so the move is made through it.
      if (action === "navigate") {
        if (screenOpts.navigate === undefined) {
          throw new ProgramError("a navigate form needs the terminal's navigation; this screen was mounted without it");
        }
        // A form whose route has no address yet submits to nowhere, which is
        // not an error: the same row that empties a link empties this.
        const explicitLocale = Boolean(cfg.i18n && currentLocale === cfg.i18n.default && typeof location !== "undefined" && new URLSearchParams(location.search).has("lang"));
        const target = routeHref(cfg, form.dataset.route, formParams(form), currentLocale, { explicitLocale });
        if (target !== undefined) screenOpts.navigate(target);
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
        const deliver = wiring().region?._prontoRefusal;
        if (deliver) {
          const id = action === "create" || form.dataset.filter !== undefined ? undefined : wiring().rowId();
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
          await store.add(entity, [row.id === undefined ? { id: mintUuid(), ...row } : row], refused);
        }
        // Write the row for this natural key, existing or not. The form says
        // what the row should be; whether that is an insert or an update is the
        // store's question, answered against the collection.
        else if (action === "upsert") await store.upsertBy(entity, await values(), refused);
        else if (action === "update") {
          await store.patch(entity, [{ key: wiring().rowId(), changes: await values() }], refused);
        }
        else if (action === "delete" && form.dataset.filter !== undefined) {
          // Filter-scoped bulk delete: the filter, not the row context,
          // names the rows (SPEC #Form.filter).
          await store.dropWhere(entity, interpolateFilter(form.dataset.filter, wiring().getCtx()), refused);
        } else if (action === "delete") await store.drop(entity, [wiring().rowId()], refused);
        else throw new Error(`unknown action: ${action}`);
        // A form that submits on change is not reset: its controls already
        // show the row the write stated, and a select whose value was bound
        // (not authored as its default) would reset to its first option.
        if (edits === editsAtSubmit && !submitsOnChange(form)) form.reset();
        setState("success");
        // A late refusal can land inside the flash window; only an
        // undisturbed success may hand back to the base state.
        rest(600, { kind: "flash" }).then(() => {
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
        form.querySelector(".invalid")?.setAttribute("hidden", "");
        form.querySelector(".store-error")?.setAttribute("hidden", "");
        setState(base);
      }
    });
    // A form with no submit button (the toggle checkbox) submits on change.
    form.addEventListener("change", () => {
      if (submitsOnChange(form)) form.requestSubmit();
    });
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
    const machineAck = [];

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
      const fired = refusal(entity, id, err);
      if (machineRefused.length > 0) {
        for (const hear of machineRefused) hear(fired);
        return;
      }
      // The store withdrew the write, so the chain-local machine view holding
      // it is withdrawn with it — the refusal transition concludes from what
      // the store still holds, not from the state that was just rolled back.
      region._prontoMachineRow = undefined;
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
        dirty.add(entity);
        at = upto;
      }
      return true;
    };

    const applyEffects = async (effects, deliver) => {
      for (const eff of effects) {
        const entity = eff.entity ?? region.dataset.live;
        const id = eff.values?.id;
        if (!["upsert", "create", "update", "delete"].includes(eff.op)) {
          throw new Error(`unknown effect op: ${eff.op}`);
        }
        const upsertFn = eff.op === "upsert" ? store.upsertBy ?? store.upsert : undefined;
        if (eff.op === "upsert" && typeof upsertFn !== "function") {
          throw new Error("store has no upsertBy or upsert");
        }
        const method = eff.op === "create" ? "add" : eff.op === "update" ? "patch" :
          eff.op === "delete" ? (eff.filter === undefined ? "drop" : "dropWhere") : undefined;
        if (method !== undefined && typeof store[method] !== "function") {
          throw new Error(`store has no ${method}`);
        }
        let refused = false;
        const wrappedRefused = (err) => {
          refused = true;
          deliver(entity, id, err);
        };
        const row = eff.op === "create" && eff.values?.id === undefined
          ? { id: mintUuid(), ...eff.values }
          : eff.values;
        try {
          if (eff.op === "upsert") {
            await upsertFn.call(store, entity, eff.values, wrappedRefused);
          } else if (eff.op === "create") {
            await store.add(entity, [row], wrappedRefused);
          } else if (eff.op === "update") {
            await store.patch(entity, [{ key: id, changes: eff.values }], wrappedRefused);
          } else if (eff.op === "delete") {
            if (eff.filter !== undefined) {
              await store.dropWhere(entity, eff.filter, wrappedRefused);
            } else {
              await store.drop(entity, [id], wrappedRefused);
            }
          }
        } catch (err) {
          if (!refused) deliver(entity, id, err);
          return false;
        }
        if (refused) return false;
        dirty.add(entity);
        if (machineAck.length > 0) {
          const ackEvent = { type: "sync_ack", entity, token: eff.token };
          for (const hear of machineAck) hear(ackEvent);
        }
      }
      return true;
    };

    const step = async (reduce, event, depth, pause) => {
      const next = await track((async () => {
        checkSettlement(region);
        const result = reduce({ items: getRows(), rows: await worldOf() }, event);
        // A promise is not a continuation command and cannot be a reduce.
        if (typeof result?.then === "function") {
          throw new Error(`handler for "${event.type}" returned a promise; a reduce returns its updates`);
        }
        if (!await applyUpdates(result?.updates ?? [], deliver)) return;
        if (result?.effects && result.effects.length > 0) {
          if (!await applyEffects(result.effects, deliver)) return;
        }
        if (result?.then?.type && depth + 1 >= STEPS) {
          throw new Error(`handler chain did not settle in ${STEPS} steps at "${result.then.type}"`);
        }
        return result?.then;
      })());
      if (!next?.type) return;
      if (next.delay > 0) {
        pause?.();
        await rest(next.delay / TEMPO, { kind: "then", type: next.type });
      }
      const carried = { type: next.type };
      // A draw the reduce asked for. It has no randomness of its own — the
      // compartment endows nothing — so it says it wants one and is called
      // again with it, the same way it says it wants to wait. The terminal
      // owning the draw is also what lets a screen be replayed: with ?seed= it
      // draws from that instead, and the same run comes back.
      if (next.seed === true) carried.seed = draw();
      if (next.with !== undefined) carried.with = next.with;
      await step(reduce, carried, depth + 1, pause);
    };

    const bind = (el, id) => {
      for (const { event, name } of onAttrs(el)) {
        if (!handlers.get(name)) continue;
        // Item nodes outlive a refresh, so each is wired once — re-wiring would
        // stack another listener on every render. The handler is the one the
        // element names when it fires, which a newer template may change.
        const once = `_prontoOn_${event}`;
        if (el[once]) continue;
        el[once] = true;
        el.addEventListener(event, async (e) => {
          const reduce = handlers.get(el.getAttribute(`data-on-${event}`));
          if (!reduce) return;
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
    const charts = (screenOpts.handlers === false || region.dataset.machine === undefined)
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

      const resolveStateNode = (path) => {
        if (!path) return undefined;
        if (machine.states[path]) return machine.states[path];
        const parts = path.split(".");
        let curr = machine.states[parts[0]];
        for (let i = 1; i < parts.length && curr; i++) {
          curr = curr.states?.[parts[i]];
        }
        return curr;
      };

      const resolveTarget = (target, currentState) => {
        if (target === undefined) return undefined;
        let resolved = target;
        if (target.startsWith(".")) {
          const sub = target.slice(1);
          if (currentState?.includes(".")) {
            const parent = currentState.slice(0, currentState.lastIndexOf("."));
            resolved = `${parent}.${sub}`;
          } else {
            resolved = sub;
          }
        } else if (!target.includes(".") && currentState?.includes(".")) {
          const parent = currentState.slice(0, currentState.lastIndexOf("."));
          const parentNode = resolveStateNode(parent);
          if (parentNode?.states?.[target]) {
            resolved = `${parent}.${target}`;
          }
        }
        let node = resolveStateNode(resolved);
        while (node?.initial && node?.states?.[node.initial]) {
          resolved = `${resolved}.${node.initial}`;
          node = node.states[node.initial];
        }
        return resolved;
      };

      const candidatesFor = (rawState, event) => {
        const stateName = (rawState && rawState !== "") ? rawState : machine.initial;
        const out = [];
        const keys = event.from !== undefined ? [`${event.type}@${event.from}`, event.type] : [event.type];
        const chain = [];
        if (stateName) {
          chain.push(stateName);
          let s = stateName;
          while (s.includes(".")) {
            s = s.slice(0, s.lastIndexOf("."));
            chain.push(s);
          }
        }
        for (const key of keys) {
          let foundInState = false;
          for (const st of chain) {
            const node = resolveStateNode(st);
            const v = node?.on?.[key];
            if (v !== undefined) {
              machineCandidates(v).forEach((c, index) => out.push({ c, key, index, origin: st }));
              foundInState = true;
              break;
            }
          }
          if (!foundInState) {
            const v = machine.on?.[key];
            if (v !== undefined) {
              machineCandidates(v).forEach((c, index) => out.push({ c, key, index, origin: "*" }));
            }
          }
        }
        return out;
      };

      const getExitEnterPaths = (from, to) => {
        if (!to) return { exit: [], enter: [] };
        if (from === to) return { exit: [from], enter: [to] };
        if (!from) return { exit: [], enter: to.split(".").map((_, i, a) => a.slice(0, i + 1).join(".")) };
        const fromParts = from.split(".");
        const toParts = to.split(".");
        let commonDepth = 0;
        while (
          commonDepth < fromParts.length &&
          commonDepth < toParts.length &&
          fromParts[commonDepth] === toParts[commonDepth]
        ) {
          commonDepth++;
        }
        const exit = [];
        for (let i = fromParts.length; i > commonDepth; i--) {
          exit.push(fromParts.slice(0, i).join("."));
        }
        const enter = [];
        for (let i = commonDepth; i < toParts.length; i++) {
          enter.push(toParts.slice(0, i + 1).join("."));
        }
        return { exit, enter };
      };

      const normalizeActions = (actions) => {
        if (!actions) return [];
        return Array.isArray(actions) ? actions : [actions];
      };

      const parseEffect = (eff, effectiveCtx, world, event) => {
        const values = {};
        for (const [k, v] of Object.entries(eff.values ?? {})) {
          let val;
          if (typeof v === "string") {
            if (v === "null" || v === "{null}") val = null;
            else if (v === "{now}") val = now();
            else if (v.startsWith("{") && v.endsWith("}")) {
              const expr = v.slice(1, -1);
              val = expr in effectiveCtx ? effectiveCtx[expr] : lookup(expr, effectiveCtx);
            } else if (PLACEHOLDERS.test(v)) {
              val = resolveHidden(v, effectiveCtx);
            } else {
              val = leafVal(v, world, event);
            }
          } else {
            val = leafVal(v, world, event);
          }
          if (val === NO_FIELD) return NO_FIELD;
          values[k] = val;
        }
        let token = eff.token;
        if (typeof token === "string") {
          if (token.startsWith("{") && token.endsWith("}")) {
            const expr = token.slice(1, -1);
            token = expr in effectiveCtx ? effectiveCtx[expr] : lookup(expr, effectiveCtx);
          } else if (PLACEHOLDERS.test(token)) {
            token = interpolate(token, effectiveCtx);
          }
        }
        let filter = eff.filter;
        if (typeof filter === "string") {
          filter = interpolateFilter(filter, effectiveCtx);
        }
        return {
          level: eff.level ?? 2,
          op: eff.op,
          entity: eff.entity ?? region.dataset.live,
          token,
          filter,
          values,
        };
      };

      const runAction = (act, patch, effectiveCtx, effects, world, event) => {
        let raised;
        if (act.assign) {
          for (const [col, v] of Object.entries(act.assign)) {
            const value = leafVal(v, world, event);
            if (value === NO_FIELD) return NO_FIELD;
            patch[col] = value;
            effectiveCtx[col] = value;
          }
        }
        const rawEffects = Array.isArray(act.effect)
          ? act.effect
          : (act.effect ? [act.effect] : []);
        for (const eff of rawEffects) {
          const parsed = parseEffect(eff, effectiveCtx, world, event);
          if (parsed === NO_FIELD) return NO_FIELD;
          effects.push(parsed);
        }
        if (act.raise !== undefined) raised = act.raise;
        return raised;
      };

      const evalCandidates = (list, world, event) => {
        for (const entry of list) {
          if (entry.c.guard === undefined) return entry;
          const named = typeof entry.c.guard === "string" ? entry.c.guard : entry.c.guard.type;
          const g = handlers.get(named);
          if (g === undefined) throw new Error(`machine guard "${named}" names no module`);
          if (g(world, event, typeof entry.c.guard === "object" ? entry.c.guard.params : undefined)) {
            return entry;
          }
        }
        return undefined;
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
        const chosen = evalCandidates(list, world, event);
        if (chosen === undefined) return { updates: [] };

        const patch = {};
        const effectiveCtx = { ...row };
        const effects = [];
        let raisedThen;

        let targetState = chosen.c.target !== undefined
          ? resolveTarget(chosen.c.target, row[machine.field])
          : undefined;
        const arrowTarget = targetState;

        const { exit: exitStates, enter: enterStates } = getExitEnterPaths(row[machine.field], targetState);

        // 1. Exit actions (innermost to outermost)
        for (const s of exitStates) {
          const node = resolveStateNode(s);
          if (node?.exit) {
            for (const act of normalizeActions(node.exit)) {
              const r = runAction(act, patch, effectiveCtx, effects, world, event);
              if (r === NO_FIELD) return { updates: [] };
              if (r !== undefined) raisedThen = r;
            }
          }
        }

        // 2. Transition actions
        if (chosen.c.actions) {
          for (const act of normalizeActions(chosen.c.actions)) {
            const r = runAction(act, patch, effectiveCtx, effects, world, event);
            if (r === NO_FIELD) return { updates: [] };
            if (r !== undefined) raisedThen = r;
          }
        }
        const rTrans = runAction(chosen.c, patch, effectiveCtx, effects, world, event);
        if (rTrans === NO_FIELD) return { updates: [] };
        if (rTrans !== undefined) raisedThen = rTrans;

        // 3. Entry actions (outermost to innermost)
        for (const s of enterStates) {
          const node = resolveStateNode(s);
          if (node?.entry) {
            for (const act of normalizeActions(node.entry)) {
              const r = runAction(act, patch, effectiveCtx, effects, world, event);
              if (r === NO_FIELD) return { updates: [] };
              if (r !== undefined) raisedThen = r;
            }
          }
        }

        // 4. onDone and always cascade
        let cascadeSteps = 0;
        while (targetState !== undefined && cascadeSteps < 10) {
          cascadeSteps++;
          let progressed = false;
          // Check if targetState is final and parent has onDone
          const currNode = resolveStateNode(targetState);
          if (currNode?.type === "final") {
            const hasParent = targetState.includes(".");
            const parentPath = hasParent ? targetState.slice(0, targetState.lastIndexOf(".")) : "";
            const parentNode = hasParent ? resolveStateNode(parentPath) : machine;
            if (parentNode?.onDone !== undefined) {
              const onDoneList = machineCandidates(parentNode.onDone).map((c, index) => ({
                c, key: "onDone", index, origin: parentPath
              }));
              const chosenOnDone = evalCandidates(onDoneList, { items: [{ ...effectiveCtx, [machine.field]: targetState }] }, event);
              if (chosenOnDone !== undefined) {
                const nextTarget = chosenOnDone.c.target !== undefined
                  ? resolveTarget(chosenOnDone.c.target, targetState)
                  : undefined;
                const { exit: ex, enter: en } = getExitEnterPaths(targetState, nextTarget);
                for (const s of ex) {
                  const node = resolveStateNode(s);
                  if (node?.exit) {
                    for (const act of normalizeActions(node.exit)) {
                      const r = runAction(act, patch, effectiveCtx, effects, world, event);
                      if (r === NO_FIELD) return { updates: [] };
                      if (r !== undefined) raisedThen = r;
                    }
                  }
                }
                if (chosenOnDone.c.actions) {
                  for (const act of normalizeActions(chosenOnDone.c.actions)) {
                    const r = runAction(act, patch, effectiveCtx, effects, world, event);
                    if (r === NO_FIELD) return { updates: [] };
                    if (r !== undefined) raisedThen = r;
                  }
                }
                const rOD = runAction(chosenOnDone.c, patch, effectiveCtx, effects, world, event);
                if (rOD === NO_FIELD) return { updates: [] };
                if (rOD !== undefined) raisedThen = rOD;
                for (const s of en) {
                  const node = resolveStateNode(s);
                  if (node?.entry) {
                    for (const act of normalizeActions(node.entry)) {
                      const r = runAction(act, patch, effectiveCtx, effects, world, event);
                      if (r === NO_FIELD) return { updates: [] };
                      if (r !== undefined) raisedThen = r;
                    }
                  }
                }
                globalThis.__prontoMachineTrace?.push({
                  region,
                  field: machine.field,
                  state: parentPath || "*",
                  key: "onDone",
                  index: chosenOnDone.index,
                  to: nextTarget,
                });
                targetState = nextTarget;
                progressed = true;
                continue;
              }
            }
          }

          // Check always on current targetState
          const stateNode = resolveStateNode(targetState);
          if (stateNode?.always !== undefined) {
            const alwaysList = machineCandidates(stateNode.always).map((c, index) => ({
              c, key: "always", index, origin: targetState
            }));
            const chosenAlways = evalCandidates(alwaysList, { items: [{ ...effectiveCtx, [machine.field]: targetState }] }, event);
            if (chosenAlways !== undefined) {
              const nextTarget = chosenAlways.c.target !== undefined
                ? resolveTarget(chosenAlways.c.target, targetState)
                : undefined;
              const { exit: ex, enter: en } = getExitEnterPaths(targetState, nextTarget);
              for (const s of ex) {
                const node = resolveStateNode(s);
                if (node?.exit) {
                  for (const act of normalizeActions(node.exit)) {
                    const r = runAction(act, patch, effectiveCtx, effects, world, event);
                    if (r === NO_FIELD) return { updates: [] };
                    if (r !== undefined) raisedThen = r;
                  }
                }
              }
              if (chosenAlways.c.actions) {
                for (const act of normalizeActions(chosenAlways.c.actions)) {
                  const r = runAction(act, patch, effectiveCtx, effects, world, event);
                  if (r === NO_FIELD) return { updates: [] };
                  if (r !== undefined) raisedThen = r;
                }
              }
              const rAlw = runAction(chosenAlways.c, patch, effectiveCtx, effects, world, event);
              if (rAlw === NO_FIELD) return { updates: [] };
              if (rAlw !== undefined) raisedThen = rAlw;
              for (const s of en) {
                const node = resolveStateNode(s);
                if (node?.entry) {
                  for (const act of normalizeActions(node.entry)) {
                    const r = runAction(act, patch, effectiveCtx, effects, world, event);
                    if (r === NO_FIELD) return { updates: [] };
                    if (r !== undefined) raisedThen = r;
                  }
                }
              }
              globalThis.__prontoMachineTrace?.push({
                region,
                field: machine.field,
                state: targetState,
                key: "always",
                index: chosenAlways.index,
                to: nextTarget,
              });
              targetState = nextTarget;
              progressed = true;
              continue;
            }
          }
          if (!progressed) break;
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
          to: arrowTarget ??
            (Object.hasOwn(patch, machine.field) ? patch[machine.field] : row[machine.field]),
        });
        const out = { updates: [] };
        if (targetState !== undefined || Object.keys(patch).length > 0) {
          const stated = { ...(row === region._prontoFallbackRow ? row : { id: row.id, [machine.field]: row[machine.field] }), ...patch };
          if (targetState !== undefined) stated[machine.field] = targetState;
          out.updates = [{ op: "put", id: stated.id, row: stated }];
          // The chain's own view of the row: a raise delivered after this
          // write must conclude from it, not from the slot's last refresh —
          // the store's wake is asynchronous and the chain is not.
          region._prontoMachineRow = { ...row, ...stated };
        }
        // Entered even on a self-target: re-entry is what re-arms `after`.
        if (targetState !== undefined) entered = targetState;
        if (effects.length > 0) out.effects = effects;
        // raise is the reduce's then: under XState's name — delivered after
        // the writes, depth-bounded by the terminal.
        if (raisedThen !== undefined) out.then = { type: raisedThen };
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
      const runMachine = (reduce, event) => finite(async (pause) => {
        entered = undefined;
        await step(reduce, event, 0, pause);
        if (entered !== undefined) armAfter(entered);
      });

      // `after` is the relocated invoke: armed on state entry, canceled on
      // exit, re-armed by a self-target, performed by the terminal's clock.
      // The generation mark IS the cancellation — any arm bumps it, an
      // expired wait with a stale generation dies silently, and so the
      // duplicate-chain hazard is inexpressible here.
      const armAfter = (stateName) => {
        region[mine("afterGen")] = (region[mine("afterGen")] ?? 0) + 1;
        const gen = region[mine("afterGen")];
        region[mine("armed")] = stateName;
        const node = resolveStateNode(stateName);
        const spec = node?.after ?? machine.states[stateName]?.after;
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
          // Periodic when every arrow the timer can take lands back in the
          // state that armed it and raises nothing: a metronome re-arms
          // forever, and a driver waiting for the queue to empty would wait
          // for it forever. A raise can carry the machine out of the state,
          // so an arrow that raises never counts as one that stays.
          const label = {
            kind: "after",
            key,
            table: region.dataset.live,
            field: machine.field,
            state: stateName,
            periodic: list.length > 0 && list.every(({ c }) => resolveTarget(c.target, stateName) === stateName && c.raise === undefined),
          };
          (async () => {
            await rest(ms / TEMPO, label);
            if (region[mine("afterGen")] !== gen) return;
            await runMachine(timerReduce, { type: `after:${key}` });
          })().catch((err) => {
            console.error(err);
            setState("network-error");
          });
        }
      };

      const SYNTHESIZED_EVENTS = new Set(["refused", "sync_ack"]);
      const shape = machineShape(machine);
      for (const type of shape.handled) {
        // Synthesized by the terminal, never dispatched by the DOM.
        if (SYNTHESIZED_EVENTS.has(type)) continue;
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
      if (shape.handled.includes("sync_ack")) {
        machineAck.push((fired) => {
          runMachine(machineReduce, fired).catch((err) => {
            console.error(err);
            setState("network-error");
          });
        });
      }
      // A state change the machine did not make — a refusal's rollback among
      // them — re-arms on the refresh it causes; the entered flag covers the
      // machine's own moves.
      const current = (region._prontoMachineRow ?? getRows()[0])?.[machine.field];
      if (current !== undefined && region[mine("armed")] !== current) {
        armAfter(current);
        const node = resolveStateNode(current);
        if (node?.always !== undefined) {
          const alwaysList = machineCandidates(node.always).map((c, index) => ({ c, key: "always", index, origin: current }));
          runMachine((state, event) => apply(machineRow(state), event, alwaysList), { type: "always" }).catch((err) => {
            failed(err);
            console.error(err);
          });
        }
      }
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
        ...named
          .map((r) => JSON.stringify([
            r.name, r.table, r.order ?? null,
            r.filter === undefined ? null : interpolateFilter(r.filter, ctx),
          ]))
          .sort(),
      ].join("\u0000");
      const seat = folds.get(seatKey) ?? { running: false, again: false };
      folds.set(seatKey, seat);
      if (seat.running) seat.again = true;
      else {
        const wake = () => {
          seat.running = true;
          let rejected = false;
          finite((pause) => step(rowsReduce, { type: "mutation" }, 0, pause)
            .catch((err) => {
              rejected = true;
              failed(err);
              console.error(err);
              setState("network-error");
            })
            .finally(() => {
              seat.running = false;
              if (!seat.again || rejected) return;
              seat.again = false;
              wake();
            }));
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

    // A region holds any number of item templates, each optionally narrowed by
    // a data-when fragment (the one filter grammar, matched against the row
    // itself); one with no data-when admits every row.
    // The templates are the markup's, not the render's, and a render replaces
    // this element's children — so they are read once and kept. An empty set
    // read back off the DOM is how a SLOT is spelled.
    // A template is the region's whose nearest region it is: a slot holding
    // lists of its own (an editor's choices, its goals) is still a slot.
    const own = (region._prontoItemTemplates ??= [...region.querySelectorAll("template[data-item]")]
      .filter((t) => t.parentElement.closest("[data-live]") === region));
    if (ref !== undefined && own.length > 0) {
      throw new ProgramError(`region "${table}" has both data-template and its own item templates`);
    }
    // Read again when a newer template reaches the running screen (retemplate).
    const compile = (own) => (ref !== undefined ? [resolveTemplate(ref)] : own).map((el) => {
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
      if (PLACEHOLDER.test(when)) {
        throw new ProgramError(`region "${table}": data-when="${when}" carries a placeholder; data-when values are literals`);
      }
      const admits = parseFilter(when);
      if (admits === null) {
        throw new ProgramError(`region "${table}": data-when="${when}" is outside the translatable fragment subset`);
      }
      return { el, admits };
    });
    let templates = compile(own);
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
    // data-exit-motion="none": this list's rows leave in the pass that loses
    // them, with no exit motion.
    const exitMotion = region.getAttribute("data-exit-motion");
    if (exitMotion !== null && exitMotion !== "none") {
      throw new ProgramError(`region "${table}": data-exit-motion="${exitMotion}"; the one value is "none"`);
    }
    if (exitMotion !== null && templates.length === 0) {
      throw new ProgramError(`region "${table}" is a slot and declares data-exit-motion; a slot has no rows to leave`);
    }
    const exits = exitMotion === null;
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
      // Resolved against the enclosing row, as the filter is: a draft nested in
      // the row it edits starts from that row. A value that is one whole
      // placeholder keeps the column's type and its null.
      fallbackRow = fromEnclosing(() => Object.fromEntries(
        Object.entries(declared(region.dataset.emptyRow, table, "data-empty-row")).map(([k, v]) => [k,
          typeof v !== "string" ? v
          : WHOLE_PLACEHOLDER.test(v) ? lookup(v.slice(1, -1), ctx) ?? null
          : PLACEHOLDER.test(v) ? interpolate(v, ctx) : v]),
      ), table, "data-empty-row");
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
        let initialVal = chart.initial;
        let node = chart.states?.[initialVal];
        while (node?.initial && node?.states?.[node.initial]) {
          initialVal = `${initialVal}.${node.initial}`;
          node = node.states[node.initial];
        }
        fallbackRow = { ...(chart.context ?? {}), ...fallbackRow, [chart.field]: initialVal };
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
    const slotCtx = {
      params: ctx.params,
      inert: ctx.inert,
      messages: ctx.messages,
      i18n: ctx.i18n,
      cfg: ctx.cfg,
      timeZone: ctx.timeZone,
      adapters: ctx.adapters,
      // The entity a bound column belongs to, for the formats that resolve a
      // declaration rather than render the value as it stands.
      table,
      get locale() {
        return ctx.locale ?? currentLocale;
      },
      row: undefined,
    };
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
        // makes it differently per pattern, so the projection declines it.
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
        // A fixture row owns no keys, so a spread of one keeps nothing of it.
        return ctx.inert === true
          ? new Proxy(row, { get: (t, f) => (Object.hasOwn(derived, f) ? derived[f] : t[f]) })
          : { ...row, ...derived };
      });
    };

    const dragging = templates.some(({ el }) => el.content.querySelector("[data-drag-handle]") !== null);


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
      const present = nestedOf(entry.node);
      // One a newer template took out stops with it.
      for (const [el, held] of entry.nested) {
        if (present.includes(el)) continue;
        held.h.stop();
        entry.nested.delete(el);
      }
      for (const el of present) {
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

    // The nested regions of a row, or of the slot, whose markup a newer
    // template has just brought on (`pairs`, each against its counterpart):
    // one still reading what it read takes the newer markup, and any other
    // stands as a fresh copy of the markup it now has, for the pass after to
    // hydrate as it would a stamp's. One the template took out is syncNested's.
    const retemplateNested = (nested, pairs, ready) => {
      for (const [el, from] of pairs) {
        const held = nested.get(el);
        if (held !== undefined && !moved(held.h, from)) {
          ready.push(held.h.retemplate(from));
          continue;
        }
        held?.h.stop();
        nested.delete(el);
        el.replaceWith(twin(from));
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
      // A row already drawn under this key — a served document's, or one
      // written into the markup — is the row's node from here on, and the
      // binding below brings it to the row as it is now. One an older template
      // drew is first morphed to this one's item (adoptTree).
      let node = null;
      if (first) {
        const key = String(entry.ctx.row.id);
        for (const child of region.children) {
          if (child.dataset?.id === key) {
            node = child;
            break;
          }
        }
      }
      if (node) {
        const item = tmpl.content.firstElementChild.cloneNode(true);
        if (region._prontoStale) morphTree(node, item.cloneNode(true), { slots: true });
        adoptTree(item, node, { rows: !region._prontoStale, scripts: false });
      } else {
        node = tmpl.content.firstElementChild.cloneNode(true);
        node.dataset.id = entry.ctx.row.id;
      }
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

    // Set by stop(), and read after EVERY await that precedes a paint: the
    // store read and the nested mounts. A stopped handle's element is not gone,
    // because syncNested replaces a nested region's handle IN PLACE when the
    // enclosing row moves its read, so work still in flight from the outgoing
    // handle lands in the element the incoming one now owns — and lands second.
    let stopped = false;

    // Whether the pass in flight is still waiting on the store's answer, so
    // that a failure is told apart as the read's rather than the render's.
    let reading = false;
    const refresh = async (changes) => {
      reading = true;
      const stored = await store.query(table, opts.order, opts);
      reading = false;
      if (stopped) return;
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
                ctx: {
                  params: ctx.params,
                  inert: ctx.inert,
                  messages: ctx.messages,
                  i18n: ctx.i18n,
                  cfg: ctx.cfg,
                  timeZone: ctx.timeZone,
                  adapters: ctx.adapters,
                  table,
                  get locale() {
                    return ctx.locale ?? currentLocale;
                  },
                  row,
                  chain: chainInto(tmpl, row),
                },
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
          // A gesture's rows play their exit, unless the region's rows leave
          // without motion.
          const leaving = exits && departing.length <= GESTURE;
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
          if (stopped) return;
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
          emptyNote(region, order.length === 0 ? region.dataset.empty : undefined, ctx, templates[0]?.el);
          // A list of options landing under a select whose bound value had no
          // option to take yet.
          const select = region.closest("select");
          if (select?._prontoBound !== undefined) {
            select.value = select._prontoBound;
            if (select.value === select._prontoBound) select._prontoBound = undefined;
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
          //
          // Only an ABSENT attribute is refused below: the empty string is a
          // declaration that the region shows nothing, which a probe whose whole
          // output is its presence has no other way to state.
          //
          // `undeclaredSlot` refuses the same markup at generate, so an app
          // that was built cannot arrive here. What can is markup that never
          // went through one — a fixture, a harness, a screen served from
          // somewhere else — and the interpreter's contract is its own.
          if (top) {
            base = route.states?.includes("gone") ? "gone" : "empty";
            setState(base);
          }
          else if (region.dataset.empty === undefined) {
            throw new ProgramError(
              `slot region "${table}" (filter ${
                JSON.stringify(opts.filter ?? "")
              }) has no row and declares no empty treatment; a nested region has no screen state to say so with — give it data-empty, empty to mean it shows nothing, or a data-empty-row to bind instead`,
            );
          }
          clearBindings(region);
          // The lists it held go with the row: left running, they would go on
          // painting the last row's children under the note.
          dropAll();
          emptyNote(region, region.dataset.empty, slotCtx);
          return;
        }
        emptyNote(region, undefined);
        if (top) {
          base = "populated";
          if (["loading", "empty", "populated", "gone"].includes(screen.dataset.state)) setState(base);
        }
        if (
          !screenOpts.fixtures &&
          row !== fallbackRow &&
          typeof row.locale === "string" &&
          !params.locale &&
          row.locale !== currentLocale
        ) {
          // The shell fetches a catalogue when a language is first read, and a
          // row is the one reader it cannot see coming.
          if (screenOpts.messages && !(row.locale in screenOpts.messages)) {
            await screenOpts.ensureMessages?.(row.locale);
            if (stopped) return;
          }
          if (screenOpts.messages ? row.locale in screenOpts.messages : true) applyLocale(row.locale);
        }
        slotCtx.row = row;
        // A singleton has affordances too, and its one row is what they act
        // on: the reduce is handed it the way a list's is handed its rows.
        wireEvents(region, null, () => (currentRow === undefined ? [] : [currentRow]), handlers, slotCtx);
        bindAttributes(region, slotCtx);
        wireKeysIn(region);
        bindTexts(region, slotCtx, renderers);
        bindHatches(region, slotCtx);
        // The lists a slot holds — an editor's choices, its goals — are
        // hydrated from its row as an item's are from its own.
        let slot = live.get(SLOT);
        if (slot === undefined) live.set(SLOT, slot = { node: region, ctx: slotCtx, nested: new Map() });
        const ready = [];
        syncNested(slot, ready);
        await Promise.all(ready);
        if (stopped) return;
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
        return false;
      }
      running = true;
      busy += 1;
      try {
        do {
          queued = false;
          checkSettlement(region);
          await refresh(changes);
          changes = queuedChanges;
          queuedChanges = undefined;
        } while (queued);
      } finally {
        running = false;
        busy -= 1;
      }
      return true;
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
    // A nested region's first attempt, which is what its `ready` answers: the
    // enclosing row awaits it before it is painted, so a wake queued behind
    // the first read does not count it painted. A pass that ran settles it,
    // and so does one that failed: a read that never answers cannot hold the
    // row, its list or the screen, and the region says its outage until it
    // reads again (`outages`), so the screen says populated only once what it
    // shows is on it. Settled by the region's stop too, since a region gone
    // paints nothing more. A top region's `ready` is its first attempt.
    let paint;
    const painted = top ? undefined : new Promise((resolve, reject) => (paint = { resolve, reject }));
    let shown = false;
    // A top region's pass clears any network-error no region still says; a
    // nested region's clears only one it said.
    const recovered = (clears) => {
      const said = outages.delete(guarded);
      if ((clears || said) && outages.size === 0 && screen.dataset.state === "network-error") setState(base);
    };
    const guarded = (changes) => track((async () => {
      if (stopped) return;
      clearTimeout(retryTimer);
      try {
        // A wake queued behind a pass in flight has painted nothing; the
        // call running the pass answers for it.
        const ran = await refreshSerially(stale ? undefined : changes);
        if (stopped) return;
        stale = false;
        retryMs = 2000;
        if (ran) {
          shown = true;
          paint?.resolve();
          recovered(top);
        }
      } catch (err) {
        if (stopped) return;
        failed(err);
        stale = true;
        // A slot that matched two rows, or a row no template admits, is a
        // broken invariant, not an outage: no retry can repair it, and the
        // network-error dressing would say the store is down when the data is
        // wrong. The rejection propagates — hydration fails on a first paint,
        // a later wake rejects loudly — and the next real change re-checks
        // without a timer.
        if (err instanceof ProgramError) {
          paint?.reject(err);
          throw err;
        }
        console.error(err);
        if (top || (reading && !shown)) {
          outages.add(guarded);
          setState("network-error");
        }
        paint?.resolve();
        retryTimer = setTimeout(guarded, retryMs);
        retryMs = Math.min(retryMs * 2, 15000);
      }
    })());
    const dependencies = new Set([
      ...(region.dataset.reads ?? "").split(",").map((table) => table.trim()).filter(Boolean),
      ...[...region.attributes].filter((attr) => attr.name.startsWith("data-read-"))
        .map((attr) => parseReadSpec(attr.value).table),
    ]);
    for (const dependency of dependencies) {
      const readers = derived.get(dependency) ?? new Set();
      readers.add(guarded);
      derived.set(dependency, readers);
    }
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
    const stop = () => {
      if (stopped) return;
      stopped = true;
      for (const dependency of dependencies) derived.get(dependency).delete(guarded);
      detach();
      dropAll();
      paint?.resolve();
      recovered(false);
    };
    cleanups.push(stop);
    // A slot's forms act on its one row: wired as it hydrates, and as a newer
    // template brings more (retemplate).
    const wireSlotForms = () => {
      for (const form of region.querySelectorAll("form[data-action]")) {
        if (!ownedBy(form, region)) continue;
        wireForm(form, () => currentRow.id, () => ({ params: ctx.params, row: currentRow }), region);
      }
    };
    if (templates.length === 0) wireSlotForms();
    const attempt = guarded();
    // A nested region's ProgramError reaches its enclosing row through
    // `painted`, which rejects with it.
    if (!top) attempt.catch(() => {});
    return {
      // The read it was hydrated with (moved).
      read: readOf(region),
      // Whether this region binds its own element from the row it hangs under
      // — the same condition that guards the call, and not re-derivable from
      // the DOM afterwards, since a first render sweeps the template away.
      binds: templates.length > 0,
      ready: top ? attempt : painted,
      // A re-render on the same rows, for a parent whose projection parameter
      // moved. Not resume(): the subscription is already standing.
      restate: () => guarded(),
      // A newer template for the screen on show, `from` its counterpart of this
      // region, reading what it read (handle.morph). A list takes its items
      // from it and morphs each row it holds to its item in place, so a row
      // drawn before, or one stamped from now on, is the newer item's. A slot
      // morphs its own markup to the newer one. Either way the regions under
      // it follow (retemplateNested), and the pass after binds what changed,
      // wires what arrived and hydrates what was added, ending where a mount
      // of the newer template would.
      retemplate: async (from) => {
        const ready = [];
        if (templates.length === 0) {
          await morphScreen(region, from);
          const pairs = new Map();
          adoptTree(from, region, { rows: true, scripts: false, live: true, pairs, enter: true });
          retemplateNested(live.get(SLOT)?.nested ?? new Map(), pairs, ready);
          wireSlotForms();
          preserveMorph?.();
          await Promise.all(ready);
          return guarded();
        }
        if (ref === undefined) {
          region._prontoItemTemplates = [...from.querySelectorAll("template[data-item]")]
            .filter((t) => t.parentElement.closest("[data-live]") === from);
        }
        templates = compile(region._prontoItemTemplates);
        for (const entry of live.values()) {
          const tmpl = templateFor(entry.ctx.row);
          const item = tmpl.content.firstElementChild;
          const node = entry.node;
          morphTree(node, item.cloneNode(true), { slots: false });
          const pairs = new Map();
          adoptTree(item, node, { rows: true, scripts: false, live: true, pairs });
          entry.tmpl = tmpl;
          entry.ctx.chain = chainInto(tmpl, entry.ctx.row);
          retemplateNested(entry.nested, pairs, ready);
          for (const form of formsIn(node)) {
            if (ownedBy(form, node)) wireForm(form, () => node.dataset.id, () => entry.ctx, region);
          }
          // Keys and affordances attach once per element, so wiring the row
          // again reaches only what the newer item added.
          entry.wired = false;
        }
        preserveMorph?.();
        await Promise.all(ready);
        return guarded();
      },
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
      stop,
    };
  }

  const regions = [];
  const pending = [];
  for (const region of screen.querySelectorAll("[data-live]")) {
    if (region.parentElement.closest("[data-live]")) continue;
    const h = hydrateRegion(region, screenCtx, true);
    h.el = region;
    regions.push(h);
    pending.push(h.ready);
  }
  // What the screen wires outside every region, at its mount and again for a
  // newer template (each element once).
  const wireScreen = () => {
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
        bindHatches(el, screenCtx);
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
  };
  wireScreen();

  await Promise.all(pending);
  if (regions.length === 0) {
    screen.dataset.state = route.states?.[0] ?? "populated";
  }

  // The terminal owns the navigation stack, so it needs more than a teardown:
  // a screen it is holding for a back press is paused, not stopped. A morph
  // waiting on the newer template's modules meets either when it resumes.
  let held = "shown";
  // A newer template for the screen on show (the service worker's
  // revalidation): its skeleton is brought to it in place, then each region
  // (retemplate). A region it adds, or whose read it changes, is hydrated
  // where it stands, as the mount would have, and one it drops is stopped.
  const morph = async (newHtml) => {
    const read = opts.release ? releaseReader() : fetchText;
    const next = prepare(newHtml);
    // Everything the mount refuses or loads before anything hydrates, before
    // the running screen or anything it reads by name is touched: a template
    // that cannot be taken leaves the screen as it was.
    for (const scope of withTemplates(next)) {
      for (const el of scope.querySelectorAll("[data-hatch]")) resolveUnit(el.dataset.hatch);
    }
    const named = templatesOf(next);
    const modules = opts.handlers === false ? null : {
      handlers: await loadHandlers(next, appBase, route, endowmentsMap, read),
      adapters: await loadAdapters(next, appBase, route, endowmentsMap, read),
      renderers: await loadRenderers(next, appBase, route, endowmentsMap, read),
    };
    namedTemplates = named;
    if (modules !== null) {
      for (const [name, module] of modules.handlers) handlers.set(name, module);
      adapters = modules.adapters;
      Object.assign(renderers, modules.renderers);
    }
    await morphScreen(screen, next);
    if (held === "stopped") return;
    const pairs = new Map();
    adoptTree(next, screen, { rows: true, scripts: false, live: true, pairs });
    localize(screen);
    // Every list re-binds its rows, and a top region's pass names the
    // screen's state after its own rows: the region settling last would
    // decide it, though a template moving on changes no row.
    const [state, standing] = [screen.dataset.state, base];
    const ready = [];
    for (const r of [...regions]) {
      const from = pairs.get(r.el);
      if (from !== undefined && !moved(r, from)) {
        ready.push(r.retemplate(from));
        pairs.delete(r.el);
        continue;
      }
      r.stop();
      regions.splice(regions.indexOf(r), 1);
    }
    for (const [el, from] of pairs) {
      const fresh = twin(from);
      el.replaceWith(fresh);
      const h = hydrateRegion(fresh, screenCtx, true);
      h.el = fresh;
      regions.push(h);
      ready.push(h.ready);
    }
    wireScreen();
    preserveMorph?.();
    await Promise.all(ready);
    base = standing;
    setState(state);
    // What it hydrated subscribed as it did, held or not.
    if (held === "paused") for (const r of regions) r.pause();
  };
  // One at a time, in the order they arrive: each waits on the modules its
  // template names, and a later one landing first would be morphed back.
  let morphing = Promise.resolve();
  return {
    settle,
    updateStyle: async (css) => {
      if (opts.release) await releaseStyle(styleId, css);
      else {
        const style = document.getElementById(styleId);
        if (style.textContent !== css) style.textContent = css;
      }
    },
    // Which template this screen was drawn from (templateHash).
    cas,
    pause: () => {
      held = "paused";
      for (const r of regions) r.pause();
    },
    resume: () => {
      held = "shown";
      return Promise.all(regions.map((r) => r.resume()));
    },
    stop: () => {
      held = "stopped";
      for (const r of regions) r.stop();
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
    // Its words written again, in the catalogues as they now stand.
    localize: () => localize(screen),
    morph: (newHtml, { preserve } = {}) => {
      const turn = morphing.then(async () => {
        preserveMorph = preserve;
        try { await morph(newHtml); }
        finally { preserveMorph = undefined; }
      });
      morphing = turn.then(() => {}, () => {});
      return turn;
    },
  };
}

/** The hash of a screen's template text: what a document says it was rendered
 * from (`pronto-cas`, document.js), and what a shell holding the template it
 * fetched recomputes to know whether the screen on show is that template's.
 * Synchronous and dependency-free, so a renderer and a page compute it alike;
 * it witnesses which text, and guards nothing. */
export function templateHash(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** A region whose children are rows: it states item templates, or names one. */
function listRegion(el) {
  if (!el.hasAttribute("data-live")) return false;
  if (el.hasAttribute("data-template")) return true;
  return [...el.querySelectorAll("template[data-item]")].some((t) => t.parentElement.closest("[data-live]") === el);
}

/**
 * Takes `to` over as the render of `from`, the same template prepared
 * (interpretScreen's prepare). A served screen is its template's tree with
 * every binding resolved, every list's rows where its item templates stood and
 * its scripts taken out (document.js), so what a render holds only in memory —
 * a placeholder attribute's template, a list's item templates — is read off
 * the template and set on the node it became. A served tree that is not that
 * render is refused, not half adopted.
 *
 * `rows`: whether the rows a list holds were stamped from this template's
 * items, or must be morphed to them as they are adopted. `scripts`: whether the template's
 * scripts run, which they do once, on the screen's first mount. `live`: `to`
 * is a screen already running, whose regions own everything under them; each
 * region met is set in `pairs` against its counterpart in `from`. `enter`:
 * `to` is a region taking its own markup over, which it owns down to the
 * regions under it.
 */
function adoptTree(from, to, { rows, scripts, live = false, pairs, enter = false }) {
  if (from.localName !== to.localName) {
    throw new ProgramError(`the served screen has <${to.localName}> where its template has <${from.localName}>`);
  }
  const stash = { ...from._prontoAttrs };
  for (const { name, value } of [...from.attributes]) {
    if (!regionAttr(name) && PLACEHOLDER.test(value)) stash[name] ??= value;
  }
  if (Object.keys(stash).length > 0) to._prontoAttrs = stash;
  else delete to._prontoAttrs;
  // Typed into before the shell arrived: an edit its binding must not
  // overwrite, as one typed after is. A running control's value is its
  // binding's, set apart from the attribute, and says nothing of the reader.
  if (
    !live && stash["data-value"] !== undefined && (to.localName === "input" || to.localName === "textarea") &&
    !["checkbox", "radio", "hidden"].includes(to.type) &&
    to.value !== (to.localName === "textarea" ? to.textContent : to.getAttribute("value") ?? "")
  ) {
    guardEdits(to);
    to._prontoDirty = true;
  }
  if (from.localName === "template" || from.hasAttribute("data-hatch") || from.hasAttribute("data-text")) return;
  if (from.hasAttribute("data-live") && !enter) {
    if (live) {
      pairs?.set(to, from);
      return;
    }
    if (listRegion(from)) {
      to._prontoItemTemplates = [...from.querySelectorAll("template[data-item]")]
        .filter((t) => t.parentElement.closest("[data-live]") === from);
      if (!rows) to._prontoStale = true;
      return;
    }
  }
  const theirs = [...to.children];
  let at = 0;
  for (const child of [...from.children]) {
    if (child.localName === "script") {
      if (!scripts) continue;
      const run = document.createElement("script");
      run.textContent = child.textContent;
      to.insertBefore(run, theirs[at] ?? null);
      continue;
    }
    const counterpart = theirs[at++];
    if (counterpart === undefined) {
      throw new ProgramError(`the served screen lacks the <${child.localName}> its template states under <${from.localName}>`);
    }
    adoptTree(child, counterpart, { rows, scripts, live, pairs });
  }
  if (at === theirs.length) return;
  // A slot whose row is gone draws its note after its markup (emptyNote), and
  // the slot's first pass takes it down or keeps it.
  if (from.hasAttribute("data-live") && at === theirs.length - 1) {
    to._prontoEmpty = theirs[at];
    return;
  }
  throw new ProgramError(`the served screen has ${theirs.length - at} element(s) under <${from.localName}> its template does not state`);
}

/**
 * Brings `live` to `markup` in place with morphlex: nodes that match are kept,
 * with the reader's focus, selection and unsent input in them
 * (preserveChanges). A list's rows are the store's and a hatch's frame its
 * unit's, so neither is entered, and a slot is entered only when `slots` says
 * so — on a served screen, whose slots nothing has bound yet; a running slot
 * wired its markup when it hydrated. What a binding shows — a bound text, a
 * bound attribute — stays as it is until the binding writes it: the markup
 * says only `{column}` there, while a region's own attributes are its read
 * and the markup's to state. The state is the screen's own, never the
 * template's.
 */
export async function morphScreen(live, markup, { slots = false } = {}) {
  if (!live || live.nodeType !== 1) throw new Error("morphScreen: the live screen is missing");
  if (!markup || markup.nodeType !== 1) throw new Error("morphScreen: the markup has no root element");
  morphlex ??= await import("./vendor/morphlex.js");
  const target = markup.cloneNode(true);
  // A URL prepare() took off until its row binds goes back on as the template
  // it was, so the hook below sees a binding rather than an attribute the
  // template dropped.
  const restore = (from, to) => {
    for (const [name, template] of Object.entries(from._prontoAttrs ?? {})) {
      const held = from.getAttribute(name);
      if (held === null || (name === "src" && held === BLANK_PIXEL)) to.setAttribute(name, template);
    }
    for (let i = 0; i < from.children.length; i++) restore(from.children[i], to.children[i]);
  };
  restore(markup, target);
  morphTree(live, target, { slots });
}

// Loaded by the first morph: a screen whose template has not moved on never
// asks for it. A row is morphed only after its screen was (adoptTree).
let morphlex = null;

/** morphScreen's walk over a target it may consume. */
function morphTree(live, target, { slots }) {
  // A screen's scripts run once, where it is first mounted (adoptTree), and
  // never again for a morph.
  for (const script of [...target.querySelectorAll("script")]) script.remove();
  // The state is the screen's and the key the row's, never the template's.
  const own = (name) => name === "data-state" || name === "data-id";
  // A region's attributes are its read, which no binding writes over, so they
  // are the template's to state with their placeholders.
  for (const { name, value } of [...target.attributes]) {
    if (own(name) || (PLACEHOLDER.test(value) && !regionAttr(name))) continue;
    if (live.getAttribute(name) !== value) live.setAttribute(name, value);
  }
  for (const { name } of [...live.attributes]) {
    if (!own(name) && !target.hasAttribute(name)) live.removeAttribute(name);
  }
  const halted = new WeakSet();
  morphlex.morphInner(live, target, {
    preserveChanges: true,
    beforeNodeVisited: (from, to) => {
      if (to.nodeType === 1 && to.hasAttribute("data-live") && (!slots || listRegion(to))) halted.add(from);
      return true;
    },
    beforeChildrenVisited: (from) =>
      from.nodeType !== 1 || !(halted.has(from) || from.hasAttribute("data-hatch") || from.hasAttribute("data-text")),
    beforeAttributeUpdated: (_el, name, value) => value === null || !PLACEHOLDER.test(value) || regionAttr(name),
  });
}

/** A copy of a prepared tree, carrying what prepare() holds only in memory:
 * the template of each attribute it took off. */
function twin(from) {
  const to = from.cloneNode(true);
  const carry = (a, b) => {
    if (a._prontoAttrs !== undefined) b._prontoAttrs = { ...a._prontoAttrs };
    for (let i = 0; i < a.children.length; i++) carry(a.children[i], b.children[i]);
  };
  carry(from, to);
  return to;
}
