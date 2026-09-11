// Which controls a linkedom screen shows, and how many gestures away.
//
// linkedom has no cascade: no UA stylesheet, no computed style, no specificity.
// Its selector engine answers membership, so this module keeps the rest: every
// rule that sets `display`, from every stylesheet the route puts in the
// document, ranked by importance, origin, specificity and order, and the winner
// read per element. The state a selector keys on is the live tree's own
// attributes — the rows the interpreter bound — plus `data-popover-open`, the
// harness's stand-in for `:popover-open`.
//
// What this tier cannot judge it reports instead of guessing. A rule under
// `@media`, `@container` or `@supports` is `cond`: it never wins, and `vis`
// names it wherever it would flip the verdict. A selector the browser accepts
// and linkedom cannot compile, or a `display` it cannot resolve, is
// `unjudged`. A selector the browser rejects drops its whole rule, as the
// browser does, except inside the forgiving lists of `:is()` and `:where()`.
//
// Depth is gestures: 0 on screen, and a closed popover or dialog adds one plus
// the depth of its nearest reachable invoker — `[commandfor][command=
// toggle-popover|show-popover]` or `[popovertarget]` for a popover,
// `[commandfor][command=show-modal]` for a dialog. The UA rule hiding either
// while closed is an ordinary cascade entry: an author `display` on the
// element outranks it, and then it shows closed, at no gesture's cost. That
// author rule may key on an enclosing popover's open state
// (`.a:popover-open .b`): an ancestor is opened before its descendants are
// asked whether they are shut, so opening it opens them too.
import { parseHTML } from "npm:linkedom@0.18.4";
import type { Route } from "./screen-harness.ts";

/** The element surface this module reads, structurally: test/deno.json carries
 * no dom lib. `setAttribute`/`removeAttribute` are there for one purpose: a
 * closed popover or dialog is judged with `data-popover-open` or `open`
 * standing for the length of one synchronous judgement, then restored. */
export type VEl = {
  readonly localName: string;
  readonly parentElement: VEl | null;
  readonly children: ArrayLike<VEl>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttributeNames(): string[];
  matches(selector: string): boolean;
  closest(selector: string): VEl | null;
  contains(other: VEl): boolean;
};
export type VRoot = { querySelectorAll(selector: string): Iterable<VEl> };

export type Rule = {
  /** The selector as the cascade reads it: nesting resolved, states as authored. */
  sel: string;
  /** What linkedom is asked: `sel` with the states this tier holds rewritten. */
  test: string;
  display: string;
  important: boolean;
  /** a·10⁶ + b·10³ + c. */
  spec: number;
  order: number;
  /** The at-rule preludes gating the rule. A gated rule never wins. */
  cond?: string;
  origin: "ua" | "author";
  /** The rightmost compound's bucket: `#id`, `.class`, `tag`, `[attr]` or `*`. */
  key: string;
};
export type Unjudged = { sel: string; why: string };
export type Sheet = { rules: Rule[]; unjudged: Unjudged[] };
export type Import = { url: string; cond?: string };
export type Parsed = Sheet & { imports: Import[] };

/** `depth` 0 is on screen and undefined is unreachable, with `why` one of
 * `css <sel>`, `[hidden]`, `inline style`, `popover:<id> (no reachable
 * invoker)`, `dialog:<id> (no reachable invoker)` or `disabled`. `cond` lists
 * the gated rules, on the element or an ancestor, that would flip the verdict
 * if their condition held. */
export type Vis = { depth: number | undefined; why?: string; cond?: string[] };

/* --- the stylesheet ------------------------------------------------------------ */

// At-rules that hold no style rules for an element.
const INERT_AT =
  /^(-[a-z]+-)?(keyframes|font-face|property|page|counter-style|font-feature-values|font-palette-values|view-transition|position-try|starting-style)$/;

const endOfString = (s: string, i: number): number => {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q) j += s[j] === "\\" ? 2 : 1;
  if (j >= s.length) throw new Error(`cssRules: an unterminated string at ${i}`);
  return j + 1;
};

/** The index just past the bracket closing the one at `i`, strings skipped. */
const closeOf = (s: string, i: number): number => {
  const open = s[i];
  const close = open === "{" ? "}" : open === "(" ? ")" : "]";
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '"' || ch === "'") {
      j = endOfString(s, j);
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close && --depth === 0) return j + 1;
    j += 1;
  }
  throw new Error(`cssRules: an unclosed ${open} at ${i}`);
};

const stripComments = (src: string): string => {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const j = endOfString(src, i);
      out += src.slice(i, j);
      i = j;
    } else if (ch === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2);
      if (j < 0) throw new Error(`cssRules: an unterminated comment at ${i}`);
      out += " ";
      i = j + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
};

/** `s` split on `by` wherever no bracket or string is open. */
export const splitTop = (s: string, by: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === "(" || ch === "[") {
      const j = ch === "(" || ch === "[" ? closeOf(s, i) : endOfString(s, i);
      cur += s.slice(i, j);
      i = j;
      continue;
    }
    if (ch === by) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
    i += 1;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
};

/** Applies `fn` to the stretches of `sel` outside strings and attribute brackets. */
const outside = (sel: string, fn: (text: string) => string): string => {
  let out = "";
  let run = "";
  let i = 0;
  while (i < sel.length) {
    const ch = sel[i];
    if (ch === '"' || ch === "'" || ch === "[") {
      const j = ch === "[" ? closeOf(sel, i) : endOfString(sel, i);
      out += fn(run) + sel.slice(i, j);
      run = "";
      i = j;
      continue;
    }
    run += ch;
    i += 1;
  }
  return out + fn(run);
};

/** `sel`'s own text: strings, attribute brackets and function arguments
 * blanked, so what is left belongs to its compounds and nothing nested. */
const ownText = (sel: string): string => {
  let out = "";
  let i = 0;
  while (i < sel.length) {
    const ch = sel[i];
    if (ch === '"' || ch === "'" || ch === "[" || ch === "(") {
      i = ch === "[" || ch === "(" ? closeOf(sel, i) : endOfString(sel, i);
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
};

// A pseudo-element in `sel`'s own compounds makes it select a box, never an
// element. One inside a function's arguments is the browser's to reject.
const PSEUDO_ELEMENT = /::|:(before|after|first-line|first-letter)(?![\w-])/i;
const hasPseudoElement = (sel: string) => PSEUDO_ELEMENT.test(ownText(sel));

// `:popover-open` is an attribute the harness keeps; hover, focus, activation
// and drag are states no linkedom screen is ever in.
const rewrite = (sel: string) =>
  outside(
    sel,
    (t) =>
      t.replace(/:popover-open(?![\w-])/gi, "[data-popover-open]")
        .replace(/:(hover|focus-visible|focus-within|focus|active|-webkit-drag)(?![\w-])/gi, ":not(*)"),
  );

/* --- selectors: compounds, specificity, buckets ----------------------------------- */

type Simple = { kind: "id" | "class" | "attr" | "tag" | "pseudo" | "element"; name: string; arg?: string; raw: string };

const IDENT = /^(?:\\.|[\w\u00a0-\uffff-])+/;
const unescape = (s: string) => s.replace(/\\(.)/g, "$1");

/** A complex selector's compounds, combinators dropped. */
function compounds(sel: string): Simple[][] {
  const out: Simple[][] = [];
  let cur: Simple[] = [];
  const cut = () => {
    if (cur.length > 0) out.push(cur);
    cur = [];
  };
  let i = 0;
  while (i < sel.length) {
    const ch = sel[i];
    if (/\s/.test(ch) || ch === ">" || ch === "+" || ch === "~") {
      cut();
      i += 1;
      continue;
    }
    if (ch === "[") {
      const j = closeOf(sel, i);
      const raw = sel.slice(i, j);
      const name = /^\[\s*(?:[\w*-]*\|)?([^\s~|^$*!=\]]+)/.exec(raw)?.[1] ?? "";
      cur.push({ kind: "attr", name: name.toLowerCase(), raw });
      i = j;
      continue;
    }
    if (ch === ":") {
      const element = sel[i + 1] === ":";
      const from = i + (element ? 2 : 1);
      const name = IDENT.exec(sel.slice(from))?.[0] ?? "";
      if (name === "") throw new Error(`cssRules: cannot read "${sel}" at ${i}`);
      let j = from + name.length;
      let arg: string | undefined;
      if (sel[j] === "(") {
        const end = closeOf(sel, j);
        arg = sel.slice(j + 1, end - 1);
        j = end;
      }
      cur.push({ kind: element ? "element" : "pseudo", name: name.toLowerCase(), arg, raw: sel.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === "#" || ch === ".") {
      const name = IDENT.exec(sel.slice(i + 1))?.[0] ?? "";
      if (name === "") throw new Error(`cssRules: cannot read "${sel}" at ${i}`);
      cur.push({ kind: ch === "#" ? "id" : "class", name: unescape(name), raw: sel.slice(i, i + 1 + name.length) });
      i += 1 + name.length;
      continue;
    }
    if (ch === "*") {
      cur.push({ kind: "tag", name: "*", raw: "*" });
      i += 1;
      continue;
    }
    if (ch === "|") {
      // A namespace prefix: HTML has one namespace, so it selects nothing more.
      i += 1;
      continue;
    }
    const name = IDENT.exec(sel.slice(i))?.[0];
    if (name === undefined) throw new Error(`cssRules: cannot read "${sel}" at ${i}`);
    cur.push({ kind: "tag", name: unescape(name).toLowerCase(), raw: name });
    i += name.length;
  }
  cut();
  return out;
}

const SELECTOR_ARG = new Set(["is", "not", "has", "matches", "-webkit-any", "where"]);

/** Specificity as a·10⁶ + b·10³ + c: `:is`/`:not`/`:has` take their most
 * specific argument, `:where` counts nothing. */
export function specificity(sel: string): number {
  let n = 0;
  for (const compound of compounds(sel)) {
    for (const s of compound) {
      if (s.kind === "id") n += 1_000_000;
      else if (s.kind === "tag") n += s.name === "*" ? 0 : 1;
      else if (s.kind === "element") n += 1;
      else if (s.kind === "pseudo" && s.name === "where") continue;
      else if (s.kind === "pseudo" && SELECTOR_ARG.has(s.name)) {
        n += Math.max(0, ...splitTop(s.arg ?? "", ",").map(specificity));
      } else if (s.kind === "pseudo" && /^nth-(last-)?child$/.test(s.name) && /\sof\s/.test(s.arg ?? "")) {
        const of = (s.arg ?? "").split(/\sof\s/).slice(1).join(" of ");
        n += 1_000 + Math.max(0, ...splitTop(of, ",").map(specificity));
      } else n += 1_000;
    }
  }
  return n;
}

const bucketOf = (sel: string): string => {
  const last = compounds(sel).at(-1) ?? [];
  const id = last.find((s) => s.kind === "id");
  if (id !== undefined) return `#${id.name}`;
  const cls = last.find((s) => s.kind === "class");
  if (cls !== undefined) return `.${cls.name}`;
  const tag = last.find((s) => s.kind === "tag" && s.name !== "*");
  if (tag !== undefined) return tag.name;
  const attr = last.find((s) => s.kind === "attr");
  if (attr !== undefined) return `[${attr.name}]`;
  return "*";
};

/* --- selectors the browser rejects ------------------------------------------------ */

// The names the CSS specs define. A selector naming any other is one the
// browser rejects; a name defined here that linkedom cannot compile is a gap
// in this tier, and the selector is unjudged instead.
const PSEUDO_CLASSES = new Set([
  "active", "active-view-transition", "active-view-transition-type", "any-link", "autofill", "blank",
  "buffering", "checked", "closed", "current", "default", "defined", "dir", "disabled", "empty", "enabled",
  "first-child", "first-of-type", "focus", "focus-visible", "focus-within", "fullscreen", "future", "has",
  "has-slotted", "host", "host-context", "hover", "in-range", "indeterminate", "invalid", "is", "lang",
  "last-child", "last-of-type", "link", "local-link", "modal", "muted", "not", "nth-child", "nth-last-child",
  "nth-last-of-type", "nth-of-type", "only-child", "only-of-type", "open", "optional", "out-of-range", "past",
  "paused", "picture-in-picture", "placeholder-shown", "playing", "popover-open", "read-only", "read-write",
  "required", "root", "scope", "seeking", "stalled", "state", "target", "target-current", "target-within",
  "user-invalid", "user-valid", "valid", "visited", "volume-locked", "where", "xr-overlay",
  "-webkit-any", "-webkit-autofill", "-webkit-drag", "-webkit-full-screen",
  // CSS2's single-colon pseudo-elements.
  "before", "after", "first-line", "first-letter",
]);
const PSEUDO_ELEMENTS = new Set([
  "before", "after", "first-line", "first-letter", "marker", "placeholder", "selection", "backdrop",
  "file-selector-button", "cue", "cue-region", "part", "slotted", "highlight", "target-text", "spelling-error",
  "grammar-error", "details-content", "view-transition", "view-transition-group", "view-transition-image-pair",
  "view-transition-old", "view-transition-new", "picker", "picker-icon", "checkmark", "scroll-marker",
  "scroll-marker-group", "scroll-button", "column", "search-text",
]);
const FORGIVING = new Set(["is", "where"]);
const NTH_OF = /^nth-(last-)?child$/;
const ofList = (arg: string) => arg.split(/\sof\s/).slice(1).join(" of ");

const LEGACY_ELEMENTS = new Set(["before", "after", "first-line", "first-letter"]);

/** Why the browser rejects the complex selector `sel`, or undefined where it
 * accepts it. `within` names the function whose argument `sel` is: no
 * pseudo-element may stand there. Inside `:is()`/`:where()` a rejected
 * argument is not fatal: `forgive` drops it. Chromium keeps an unknown
 * `::-webkit-` pseudo-element, for the web's sake, and no other unknown one. */
const rejection = (sel: string, within?: string): string | undefined => {
  let parts: Simple[][];
  try {
    parts = compounds(sel);
  } catch (e) {
    return (e as Error).message;
  }
  for (const compound of parts) {
    for (const s of compound) {
      if (s.kind === "element" || (s.kind === "pseudo" && LEGACY_ELEMENTS.has(s.name))) {
        if (within !== undefined) return `puts the pseudo-element ${s.raw} inside :${within}()`;
        if (s.kind === "element" && !PSEUDO_ELEMENTS.has(s.name) && !s.name.startsWith("-webkit-")) {
          return `names the unknown pseudo-element ::${s.name}`;
        }
        continue;
      }
      if (s.kind !== "pseudo") continue;
      if (!PSEUDO_CLASSES.has(s.name)) return `names the unknown pseudo-class :${s.name}`;
      if (FORGIVING.has(s.name)) continue;
      const list = SELECTOR_ARG.has(s.name)
        ? s.arg
        : NTH_OF.test(s.name) && /\sof\s/.test(s.arg ?? "")
        ? ofList(s.arg ?? "")
        : undefined;
      for (const inner of splitTop(list ?? "", ",")) {
        const why = rejection(inner, s.name);
        if (why !== undefined) return why;
      }
    }
  }
  return undefined;
};

/** `sel` with every argument the browser rejects dropped from its `:is()` and
 * `:where()` lists; a list left empty matches nothing. */
const forgive = (sel: string): string => {
  let out = "";
  let i = 0;
  while (i < sel.length) {
    const ch = sel[i];
    if (ch === '"' || ch === "'" || ch === "[") {
      const j = ch === "[" ? closeOf(sel, i) : endOfString(sel, i);
      out += sel.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "(") {
      const j = closeOf(sel, i);
      const inner = sel.slice(i + 1, j - 1);
      const fn = /(?<!:):([\w-]+)$/.exec(out)?.[1];
      const name = fn?.toLowerCase() ?? "";
      const args = splitTop(inner, ",");
      const kept = FORGIVING.has(name) ? args.filter((a) => rejection(a, name) === undefined) : args;
      if (kept.length === args.length) out += `(${forgive(inner)})`;
      else if (kept.length > 0) out += `(${kept.map(forgive).join(", ")})`;
      else out = `${out.slice(0, -(name.length + 1))}:not(*)`;
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
};

/* --- parsing ----------------------------------------------------------------------- */

// The engine every selector is compiled against once, so a selector linkedom
// refuses is set aside at parse time rather than thrown mid-judgement.
const probe = (parseHTML("<!doctype html><html><body><p></p></body></html>") as unknown as {
  document: { querySelector(s: string): VEl };
}).document.querySelector("p");

/** Where a walk stands: the selectors of the enclosing style rule, the at-rule
 * preludes gating it, whether it is the sheet's top level, and, inside a rule
 * the browser drops, why. */
type Ctx = { parents: string[] | null; conds: string[]; top: boolean; dropped?: string };

/** `prelude`'s selectors with `&` resolved against `parents`. `wrapped` takes
 * the `:is(parent)` form throughout, which reads nothing of the parents: a
 * dropped rule's parents may be selectors this module cannot tokenise. */
const resolveNesting = (prelude: string, parents: string[] | null, wrapped = false): string[] => {
  const list = splitTop(prelude, ",");
  if (parents === null) return list.map((s) => outside(s, (t) => t.replaceAll("&", ":root")));
  const complex = wrapped || parents.length > 1 || parents.some((p) => compounds(p).length > 1);
  const whole = parents.length === 1 ? parents[0] : `:is(${parents.join(", ")})`;
  return list.map((s) => {
    const own = /^[>+~]/.test(s) || !s.includes("&") ? `& ${s}` : s;
    const leading = own.startsWith("&") && own.indexOf("&", 1) < 0;
    // A textual parent is exact only where `&` leads or the parent is one
    // compound; anywhere else it is `:is(parent)`, which is what nesting means.
    const parent = !complex || leading ? whole : `:is(${parents.join(", ")})`;
    return outside(own, (t) => t.replaceAll("&", parent));
  });
};

function parse(text: string, origin: Rule["origin"]): Parsed {
  const rules: Rule[] = [];
  const unjudged: Unjudged[] = [];
  const imports: Import[] = [];
  let order = 0;
  // An @import counts only ahead of every rule but @charset and @layer
  // statements; the browser ignores one that comes later.
  let late = false;

  const declare = (ctx: Ctx, body: string) => {
    if (ctx.parents === null) return;
    let found: { value: string; important: boolean } | undefined;
    for (const decl of splitTop(body, ";")) {
      const m = /^display\s*:\s*([\s\S]*?)\s*(!\s*important)?$/i.exec(decl.trim());
      if (m === null) continue;
      const next = { value: m[1].trim().toLowerCase(), important: m[2] !== undefined };
      if (found === undefined || next.important || !found.important) found = next;
    }
    if (found === undefined) return;
    if (ctx.dropped !== undefined) {
      unjudged.push({ sel: ctx.parents.join(", "), why: ctx.dropped });
      return;
    }
    const at = order++;
    for (const sel of ctx.parents) {
      if (/var\(|env\(|attr\(|revert-layer/.test(found.value)) {
        unjudged.push({ sel, why: `display: ${found.value}` });
        continue;
      }
      const read = forgive(sel);
      const test = rewrite(read);
      try {
        probe.matches(test);
      } catch (e) {
        unjudged.push({ sel, why: (e as Error).message });
        continue;
      }
      rules.push({
        sel,
        test,
        display: found.value,
        important: found.important,
        spec: specificity(read),
        order: at,
        cond: ctx.conds.length === 0 ? undefined : ctx.conds.join(" "),
        origin,
        key: bucketOf(sel),
      });
    }
  };

  const statement = (ctx: Ctx, stmt: string) => {
    const name = (/^@([\w-]+)/.exec(stmt)?.[1] ?? "").toLowerCase();
    if (name !== "import") {
      if (ctx.top && name !== "charset" && name !== "layer") late = true;
      return; // @charset, @namespace, a @layer order statement
    }
    if (!ctx.top) throw new Error(`cssRules: "${stmt}" is not at the top level`);
    const m = /^@import\s+(?:url\(\s*(["']?)(.*?)\1\s*\)|(["'])(.*?)\3)\s*([\s\S]*)$/i.exec(stmt);
    if (m === null) throw new Error(`cssRules: cannot read "${stmt}"`);
    if (late) return;
    const rest = m[5].replace(/\blayer(\([^)]*\))?/i, "").trim();
    imports.push({ url: m[2] ?? m[4], cond: rest === "" ? undefined : `@import ${rest}` });
  };

  const block = (ctx: Ctx, prelude: string, body: string) => {
    if (prelude.startsWith("@")) {
      const name = (/^@([\w-]+)/.exec(prelude)?.[1] ?? "").toLowerCase();
      const inner = { ...ctx, top: false };
      if (name === "layer") walk(body, inner);
      else if (!INERT_AT.test(name)) walk(body, { ...inner, conds: [...ctx.conds, prelude.replace(/\s+/g, " ")] });
      return;
    }
    // One selector the browser rejects drops the whole list, the rules nested
    // in it included.
    const list = resolveNesting(prelude, ctx.parents, ctx.dropped !== undefined);
    let dropped = ctx.dropped;
    for (const sel of list) {
      if (dropped !== undefined) break;
      const why = rejection(sel);
      if (why !== undefined) dropped = `the browser drops the whole rule: ${sel} ${why}`;
    }
    const sels = list.filter((s) => !hasPseudoElement(s));
    if (sels.length > 0) walk(body, { parents: sels, conds: ctx.conds, top: false, dropped });
  };

  // A run of declarations is one rule: runs split by a nested block keep
  // their places in the order, as the browser's nested declarations do.
  const walk = (src: string, ctx: Ctx) => {
    let decls = "";
    let start = 0;
    let i = 0;
    // A `}` closing nothing is read, as the browser reads it, into the next
    // rule's prelude, which then selects nothing: that whole rule is dropped.
    let stray = false;
    const flush = () => {
      if (decls.trim() !== "") declare(ctx, decls);
      decls = "";
    };
    while (i < src.length) {
      const ch = src[i];
      if (ch === '"' || ch === "'") {
        i = endOfString(src, i);
      } else if (ch === "(" || ch === "[") {
        i = closeOf(src, i);
      } else if (ch === ";" && stray) {
        i += 1;
      } else if (ch === ";") {
        const stmt = src.slice(start, i).trim();
        if (stmt.startsWith("@")) statement(ctx, stmt);
        else decls += stmt + ";";
        start = i = i + 1;
      } else if (ch === "{") {
        const end = closeOf(src, i);
        flush();
        const prelude = src.slice(start, i).trim();
        if (stray) {
          unjudged.push({ sel: prelude.replace(/\s+/g, " "), why: "a stray } before it: the browser drops this rule" });
          stray = false;
        } else block(ctx, prelude, src.slice(i + 1, end - 1));
        if (ctx.top) late = true;
        start = i = end;
      } else if (ch === "}") {
        stray = true;
        i += 1;
      } else i += 1;
    }
    const tail = src.slice(start).trim();
    if (tail.startsWith("@")) statement(ctx, tail);
    else decls += tail;
    flush();
  };

  walk(stripComments(text), { parents: null, conds: [], top: true });
  return { rules, unjudged, imports };
}

/** Every rule in `text` that sets `display`, one per selector, in source order.
 * `@layer` is transparent; any other at-rule holding style rules makes them
 * `cond`. `&` nesting is flattened, selectors carrying a pseudo-element are
 * dropped, and `imports` lists the `@import`s for the caller to resolve. */
export function cssRules(text: string): Parsed {
  return parse(text, "author");
}

/** The document's own rules, which lose to any author rule. */
const UA = parse(
  `[hidden] { display: none }
   template { display: none }
   [popover]:not(:popover-open) { display: none }
   dialog:not([open]) { display: none }`,
  "ua",
).rules;

const offset = (parsed: Sheet, by: number, cond?: string): Sheet => ({
  rules: parsed.rules.map((r) => ({
    ...r,
    order: r.order + by,
    cond: cond === undefined ? r.cond : r.cond === undefined ? cond : `${cond} ${r.cond}`,
  })),
  unjudged: parsed.unjudged,
});

/** Every display rule the route puts in the document, in cascade order: the
 * screen css with each `@import` expanded in place from the route's shared
 * files, then the `<style>` blocks in its markup. An `@import` naming no shared
 * file is an error: the browser would load a sheet this evaluator never saw. */
export function routeSheet(route: Route, files: Record<string, string>): Sheet {
  const read = (path: string) => {
    const text = files[path];
    if (text === undefined) throw new Error(`routeSheet: ${path} is not among the files given`);
    return text;
  };
  const parts: Sheet[] = [];
  let next = 0;
  const push = (sheet: Sheet, cond?: string) => {
    parts.push(offset(sheet, next, cond));
    next += Math.max(0, ...sheet.rules.map((r) => r.order + 1));
  };
  const shared = route.files.shared ?? [];
  // The screen css is a <style> in the page, so its imports resolve against
  // the page, wherever the app keeps it; a shared sheet's resolve against the
  // sheet itself.
  const target = (from: string, url: string): string | undefined => {
    if (from === route.files.css) {
      const rel = new URL(url, "file:///page/").pathname.replace(/^\/page\//, "");
      return shared.find((p) => p === rel || p.endsWith(`/${rel}`));
    }
    const abs = new URL(url, `file:///${from}`).pathname.slice(1);
    return shared.find((p) => p === abs);
  };
  const expand = (path: string, cond: string | undefined, trail: string[]) => {
    if (trail.includes(path)) throw new Error(`routeSheet: ${[...trail, path].join(" → ")} imports itself`);
    const parsed = cssRules(read(path));
    for (const imp of parsed.imports) {
      const hit = target(path, imp.url);
      if (hit === undefined) {
        throw new Error(`routeSheet: ${path} imports "${imp.url}", which is none of the route's shared files`);
      }
      const both = [cond, imp.cond].filter((c) => c !== undefined).join(" ");
      expand(hit, both === "" ? undefined : both, [...trail, path]);
    }
    push(parsed, cond);
  };
  expand(route.files.css, undefined, []);
  for (const m of read(route.files.html).matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)) {
    const media = /\bmedia\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
    const query = media === null ? undefined : (media[1] ?? media[2] ?? media[3]).trim();
    const parsed = cssRules(m[2]);
    if (parsed.imports.length > 0) throw new Error(`routeSheet: an inline <style> in ${route.files.html} imports`);
    push(parsed, query === undefined || query === "" || query === "all" ? undefined : `@media ${query}`);
  }
  return { rules: parts.flatMap((p) => p.rules), unjudged: parts.flatMap((p) => p.unjudged) };
}

/** Every attribute simple selector inside a `display:none` rule, normalised —
 * `[data-ply="0"]` — so a state can be described by which of them match. */
export function atoms(rules: Rule[]): string[] {
  const out = new Set<string>();
  const visit = (sel: string) => {
    for (const compound of compounds(sel)) {
      for (const s of compound) {
        if (s.kind === "attr") out.add(normalAttr(s.raw));
        else if (s.kind === "pseudo" && s.arg !== undefined && SELECTOR_ARG.has(s.name)) {
          for (const inner of splitTop(s.arg, ",")) visit(inner);
        } else if (s.kind === "pseudo" && s.arg !== undefined && /\sof\s/.test(s.arg)) {
          for (const inner of splitTop(s.arg.split(/\sof\s/).slice(1).join(" of "), ",")) visit(inner);
        }
      }
    }
  };
  for (const r of rules) if (r.display === "none") visit(r.sel);
  return [...out].sort();
}

// An HTML attribute's name matches in any case, and `[|x]` is the
// no-namespace x, which every HTML attribute is. `[*|x]` and `[ns|x]` never
// get here: linkedom compiles no namespace, so their rules are unjudged.
const normalAttr = (raw: string): string => {
  const m = /^\[\s*\|?([^\s~|^$*!=\]]+)\s*(?:([~|^$*]?=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s\]]+)\s*([iIsS])?)?\s*\]$/
    .exec(raw);
  if (m === null) throw new Error(`atoms: cannot read the attribute selector ${raw}`);
  const name = m[1].toLowerCase();
  if (m[2] === undefined) return `[${name}]`;
  const value = /^["']/.test(m[3]) ? m[3].slice(1, -1).replace(/\\(.)/g, "$1") : m[3];
  const flag = m[4] === undefined ? "" : ` ${m[4].toLowerCase()}`;
  return `[${name}${m[2]}"${value.replace(/["\\]/g, "\\$&")}"${flag}]`;
};

/* --- the cascade ------------------------------------------------------------------- */

type Cand = { important: boolean; level: 0 | 1 | 2; spec: number; order: number; display: string; rule?: Rule };
const cand = (r: Rule): Cand => ({
  important: r.important,
  level: r.origin === "ua" ? 0 : 1,
  spec: r.spec,
  order: r.order,
  display: r.display,
  rule: r,
});

// Importance, then origin (inline over author over UA), then specificity,
// then order.
const outranks = (a: Cand, b: Cand | undefined): boolean => {
  if (b === undefined) return true;
  if (a.important !== b.important) return a.important;
  if (a.level !== b.level) return a.level > b.level;
  if (a.spec !== b.spec) return a.spec > b.spec;
  return a.order > b.order;
};

const inlineDisplay = (el: VEl): Cand | undefined => {
  const style = el.getAttribute("style");
  if (style === null) return undefined;
  let found: Cand | undefined;
  for (const decl of splitTop(style, ";")) {
    const m = /^display\s*:\s*([\s\S]*?)\s*(!\s*important)?$/i.exec(decl.trim());
    if (m === null) continue;
    const next: Cand = { important: m[2] !== undefined, level: 2, spec: 0, order: 0, display: m[1].trim().toLowerCase() };
    if (found === undefined || next.important || !found.important) found = next;
  }
  return found;
};

type Index = Map<string, Rule[]>;
const index = (rules: Rule[]): Index => {
  const out: Index = new Map();
  for (const r of rules) {
    const list = out.get(r.key);
    if (list === undefined) out.set(r.key, [r]);
    else list.push(r);
  }
  return out;
};

const candidates = (el: VEl, idx: Index): Rule[] => {
  const keys = ["*", el.localName];
  const id = el.getAttribute("id");
  if (id !== null && id !== "") keys.push(`#${id}`);
  for (const c of (el.getAttribute("class") ?? "").split(/\s+/)) if (c !== "") keys.push(`.${c}`);
  for (const a of el.getAttributeNames()) keys.push(`[${a.toLowerCase()}]`);
  const out: Rule[] = [];
  for (const k of new Set(keys)) out.push(...(idx.get(k) ?? []));
  return out;
};

const DISABLEABLE = new Set(["button", "input", "select", "textarea", "optgroup", "option", "fieldset"]);
const isDisabled = (el: VEl): boolean => {
  if (el.getAttribute("aria-disabled") === "true") return true;
  if (!DISABLEABLE.has(el.localName)) return false;
  if (el.hasAttribute("disabled")) return true;
  const set = el.parentElement?.closest("fieldset[disabled]") ?? null;
  if (set === null) return false;
  const legend = Array.from(set.children).find((c) => c.localName === "legend");
  return legend === undefined || !legend.contains(el);
};

const OPENS_POPOVER = new Set(["toggle-popover", "show-popover"]);

/** What a gesture opens: a popover, or a dialog. */
type Shut = "popover" | "dialog";
/** The attribute standing for the open state of each. */
const OPEN_ATTR = { popover: "data-popover-open", dialog: "open" } as const;

/** One observed state's visibility. The tree must hold still while it is
 * asked: winners are memoized per element. */
export function visibility(root: VRoot, sheet: Sheet): { vis(el: VEl): Vis } {
  const author = index(sheet.rules.filter((r) => r.cond === undefined));
  const gated = index(sheet.rules.filter((r) => r.cond !== undefined));
  const ua = index(UA);

  // `<kind>:<id>` → the elements that open it.
  const invokers = new Map<string, VEl[]>();
  const invokes = (key: string, el: VEl) => invokers.set(key, [...(invokers.get(key) ?? []), el]);
  for (const el of root.querySelectorAll("[commandfor], [popovertarget]")) {
    const command = (el.getAttribute("command") ?? "").toLowerCase();
    const target = el.getAttribute("commandfor");
    const action = (el.getAttribute("popovertargetaction") ?? "toggle").toLowerCase();
    if (target !== null && OPENS_POPOVER.has(command)) invokes(`popover:${target}`, el);
    else if (target !== null && command === "show-modal") invokes(`dialog:${target}`, el);
    else if (el.hasAttribute("popovertarget") && action !== "hide") {
      invokes(`popover:${el.getAttribute("popovertarget")}`, el);
    }
  }

  const best = (el: VEl, idx: Index, from?: Cand): Cand | undefined => {
    let out = from;
    for (const r of candidates(el, idx)) {
      const c = cand(r);
      if (outranks(c, out) && el.matches(r.test)) out = c;
    }
    return out;
  };

  type Verdict = { winner?: Cand; cond: string[] };
  const memo = new Map<VEl, Verdict>();
  const verdict = (el: VEl, steady: boolean): Verdict => {
    const known = steady ? memo.get(el) : undefined;
    if (known !== undefined) return known;
    let winner = best(el, author, inlineDisplay(el));
    if (winner?.display === "revert") winner = undefined;
    winner ??= best(el, ua);
    const none = winner?.display === "none";
    const cond: string[] = [];
    for (const r of candidates(el, gated)) {
      const c = cand(r);
      if ((r.display === "none") !== none && outranks(c, winner) && el.matches(r.test)) cond.push(`${r.cond} ${r.sel}`);
    }
    const out = { winner, cond };
    if (steady) memo.set(el, out);
    return out;
  };

  const whyOf = (w: Cand): string =>
    w.level === 2 ? "inline style" : w.rule?.origin === "ua" && w.rule.sel === "[hidden]" ? "[hidden]" : `css ${w.rule?.sel}`;

  // A popover or dialog that is closed and that the cascade hides while
  // closed. The verdict is read on the tree as it stands when asked, which is
  // `steady` when nothing is held open: an author display on the element
  // outranks the UA rule, and then it shows as it stands.
  const shut = (el: VEl, steady: boolean): Shut | undefined => {
    const kind: Shut | undefined = el.hasAttribute("popover")
      ? (el.hasAttribute(OPEN_ATTR.popover) ? undefined : "popover")
      : el.localName === "dialog" && !el.hasAttribute(OPEN_ATTR.dialog)
      ? "dialog"
      : undefined;
    return kind !== undefined && verdict(el, steady).winner?.display === "none" ? kind : undefined;
  };

  const openDepth = (pop: VEl, kind: Shut, seen: Set<VEl>): number | undefined => {
    if (seen.has(pop)) return undefined;
    const branch = new Set(seen).add(pop);
    let depth: number | undefined;
    for (const by of invokers.get(`${kind}:${pop.getAttribute("id") ?? ""}`) ?? []) {
      // Each invoker walks with its own copy: one branch reaching a popover
      // must not mark it unreachable for its sibling.
      const d = judge(by, new Set(branch)).depth;
      if (d !== undefined && (depth === undefined || d < depth)) depth = d;
    }
    return depth === undefined ? undefined : depth + 1;
  };

  const judge = (el: VEl, seen: Set<VEl>): Vis => {
    const chain: VEl[] = [];
    for (let up: VEl | null = el; up !== null; up = up.parentElement) chain.push(up);
    // The closed popovers and dialogs above `el`, innermost first. Each is
    // asked outermost first, with every one above it already opened, and is
    // opened in turn: its subtree is judged as it shows once open, its
    // `:popover-open` or `[open]` rules holding for the length of this walk.
    const closed: { el: VEl; kind: Shut }[] = [];
    const cond: string[] = [];
    let hidden: string | undefined;
    try {
      for (const up of chain.toReversed()) {
        const kind = shut(up, closed.length === 0);
        if (kind === undefined) continue;
        up.setAttribute(OPEN_ATTR[kind], "");
        closed.unshift({ el: up, kind });
      }
      for (const up of chain) {
        const v = verdict(up, closed.length === 0);
        cond.push(...v.cond);
        if (v.winner?.display === "none") {
          hidden = whyOf(v.winner);
          break;
        }
      }
    } finally {
      for (const c of closed) c.el.removeAttribute(OPEN_ATTR[c.kind]);
    }
    const withCond = (v: Vis): Vis => (cond.length === 0 ? v : { ...v, cond });
    if (hidden !== undefined) return withCond({ depth: undefined, why: hidden });
    if (isDisabled(el)) return withCond({ depth: undefined, why: "disabled" });
    let depth = 0;
    for (const c of closed) {
      const d = openDepth(c.el, c.kind, seen);
      if (d === undefined) {
        return withCond({ depth: undefined, why: `${c.kind}:${c.el.getAttribute("id") ?? ""} (no reachable invoker)` });
      }
      depth = Math.max(depth, d);
    }
    return withCond({ depth });
  };

  return { vis: (el) => judge(el, new Set()) };
}
