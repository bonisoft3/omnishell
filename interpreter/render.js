// The platform half of the renderer role, and the terminal's DOM mutation
// story. A renderer is a pure (value) => nodes function — no DOM handle, no
// lifecycle, no mount or unmount, no refs, nothing to clean up — so there is
// no state for it to get wrong. Everything that decides what may reach the DOM
// lives here instead: the node schema, the tag and attribute allowlist, the
// URL-scheme check, and the builder.
//
// A node is either a string, which is always a text node, or
// {tag, attrs?, children?}. There is deliberately no node kind for raw markup.
// The schema cannot express it, so no renderer can ask for it, and the builder
// reaches for createElement and textContent and nothing else.
//
// Two kinds of refusal, on a deliberate line. A structural violation — an
// unknown tag, a malformed node, an attribute outside the allowlist — is a bug
// in the renderer, so it throws and the author fixes it. A URL that fails the
// scheme check is user data flowing through a legitimate attribute, so the
// attribute is dropped and the rest of the document still renders: a reader's
// own content must never be able to take the screen down.

// Anything else — javascript:, data:, vbscript: — is not a URL the terminal
// will emit, because those are the schemes a browser executes rather than
// fetches. What passes is what a browser merely fetches or hands to a mail
// client, plus schemeless forms: "/path" and "#frag" resolve against the app's
// own origin, and "//host/path" keeps the scheme and changes the host, which
// reaches a third party exactly as an authored https:// URL already does.
// Refusing the protocol-relative spelling would deny nothing an author cannot
// spell another way. Third-party fetches from reader-authored prose are a real
// tracking surface, but the mechanism for that is an origin policy over every
// URL this emits, not a rule about one URL syntax.
const SCHEMES = new Set(["http", "https", "mailto"]);
const STRIPPED = /[\u0000-\u0020\u007f]/g;

// Exported because a renderer that knows a URL will be refused can present it
// better than a dropped attribute can — markdown leaves the author's link as
// the literal characters they typed. That is presentation; the builder applies
// this again regardless, which is the enforcement.
export function safeUrl(raw) {
  // Browsers strip ASCII whitespace and control characters before resolving a
  // URL, so "java\nscript:alert(1)" IS a javascript: URL by the time it is
  // navigated. The scheme test has to read what the browser will read.
  const url = String(raw).replace(STRIPPED, "");
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (scheme === null) return url;
  return SCHEMES.has(scheme[1].toLowerCase()) ? url : null;
}

const GLOBAL_ATTRS = new Set(["class", "title", "lang", "dir"]);

// Prose elements, and only prose. Absent by decision, not by oversight:
// script/style (code, and this is the whole point), iframe/object/embed (the
// hatch is how a foreign document gets mounted, under a sandbox this path
// cannot express), form/input/button (mutations are forms the screen author
// wrote, never markup a renderer invented), link/meta/base (document-scoped
// authority), and svg/math (their own attribute surfaces — xlink:href,
// foreignObject — which this allowlist does not model). Widening the set is a
// deliberate change here, which is the point of it living here.
const TAGS = {
  p: [], br: [], hr: [], div: [], span: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  ul: [], ol: ["start"], li: ["value"],
  blockquote: ["cite"], pre: [], code: [],
  em: [], strong: [], del: [], ins: [], mark: [], small: [], sub: [], sup: [], kbd: [], abbr: [],
  figure: [], figcaption: [],
  a: ["href", "target", "rel"],
  img: ["src", "alt", "width", "height", "loading"],
  table: [], thead: [], tbody: [], tfoot: [], tr: [], caption: [],
  th: ["colspan", "rowspan", "scope"], td: ["colspan", "rowspan"],
};

// Every allowlisted attribute that HTML treats as a URL. A URL-valued
// attribute added to TAGS but not here gives the builder an allowlisted
// attribute carrying an unchecked scheme, which is why this set is written
// beside TAGS rather than inferred from it.
const URL_ATTRS = new Set(["href", "src", "cite"]);

function checkAttr(tag, name) {
  // data-* is refused ahead of the allowlist because its reason is different
  // and worth saying: the terminal's own binding vocabulary is data-*, so a
  // renderer that could emit one could forge a data-live region, a data-text
  // binding or a data-hatch mount out of a reader's prose.
  if (name.startsWith("data-")) {
    throw new Error(`renderer may not set ${name}: data-* is the terminal's own vocabulary`);
  }
  // on* would be script, and style is both an exfiltration channel and a
  // second opinion about appearance, which design tokens already own.
  if (name.startsWith("on") || name === "style") throw new Error(`renderer may not set ${name}`);
  if (!GLOBAL_ATTRS.has(name) && !TAGS[tag].includes(name)) {
    throw new Error(`renderer may not set ${name} on <${tag}>`);
  }
}

// The builder recurses once per level, so a tree deep enough overflows the
// stack before it renders. A renderer fed reader prose bounds its own nesting;
// this is the backstop for one that does not, and it is set where a real
// document never reaches it.
const MAX_DEPTH = 256;

function toNode(node, depth = 0) {
  if (typeof node === "string") return document.createTextNode(node);
  if (node === null || typeof node !== "object" || typeof node.tag !== "string") {
    throw new Error(`renderer produced ${JSON.stringify(node)}, not a string or {tag}`);
  }
  if (depth >= MAX_DEPTH) throw new Error(`renderer nested deeper than ${MAX_DEPTH} elements`);
  const { tag, attrs = {}, children = [] } = node;
  if (!Object.hasOwn(TAGS, tag)) throw new Error(`renderer may not produce <${tag}>`);
  // A string is iterable, so `children: "abc"` would spread into one text node
  // per code unit — a shape the schema does not describe quietly becoming a
  // different document. Same for attrs, whose entries would be its indices.
  if (!Array.isArray(children)) throw new Error(`<${tag}> children must be an array, got ${typeof children}`);
  if (attrs === null || typeof attrs !== "object" || Array.isArray(attrs)) {
    throw new Error(`<${tag}> attrs must be an object, got ${JSON.stringify(attrs)}`);
  }
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    checkAttr(tag, name);
    // `{target: cond ? "_blank" : undefined}` is how a conditional attribute
    // is written, and setAttribute stringifies: left alone it sets the literal
    // "undefined", which for target is a real browsing-context name.
    if (value === undefined || value === null) continue;
    if (URL_ATTRS.has(name)) {
      const url = safeUrl(value);
      if (url === null) continue;
      el.setAttribute(name, url);
      continue;
    }
    el.setAttribute(name, String(value));
  }
  // A link opening a new context hands that context a live opener unless it is
  // told not to; the renderer never has to remember, because it cannot. Keyed
  // on the element, not the description: any path that puts a target on the
  // DOM is a path this has to see, whatever shape the description had.
  if (tag === "a" && el.hasAttribute("target")) el.setAttribute("rel", "noopener noreferrer");
  for (const child of children) el.append(toNode(child, depth + 1));
  return el;
}

/**
 * Replaces target's children with the renderer's nodes.
 *
 * The DOM is touched only when the description changes. A region re-binds on
 * every refresh, so a rendered article would otherwise be rebuilt whenever any
 * unrelated column moved — losing the reader's text selection every time.
 * Comparing descriptions, not DOM, is what makes re-rendering free and makes
 * idempotence structural rather than something each renderer has to earn.
 *
 * Replacing wholesale is deliberate, not a gap: a body either does not change
 * or changes entirely, and a tree differ was measured and declined. Three
 * things would overturn that — a live-preview editor, a streamed or generated
 * body, or comments appended while a reader reads. Hitting one of those means
 * reading plugins/omnishell/docs/2026-08-02-reconciliation-libraries.md rather than reaching for
 * a library: it names the one that fits (morphdom, because it never creates
 * nodes and so leaves the allowlist owning that), and why the others do not.
 */
export function buildNodes(nodes, target) {
  if (!Array.isArray(nodes)) throw new Error(`renderer must return an array of nodes, got ${typeof nodes}`);
  const description = JSON.stringify(nodes);
  if (target._prontoRendered === description) return;
  // Not `nodes.map(toNode)`: map passes the index as the second argument, so
  // every top-level block would start at its own ordinal depth and a long flat
  // article would be refused for its length.
  const built = nodes.map((node) => toNode(node, 0));
  target.replaceChildren(...built);
  target._prontoRendered = description;
}

/**
 * Runs a renderer over a source value and builds the result into target.
 *
 * The whole pipeline's input is the source, so that is what is compared here:
 * an unchanged value costs one string comparison, where comparing the built
 * description still had to parse and serialise first — 0.18 ms per re-bind on
 * a 60-section article, spent on every refresh of every region holding one.
 * buildNodes keeps its own comparison, which catches the other case: two
 * different sources that render to the same thing.
 *
 * The source is recorded only after a successful build, so a renderer that
 * threw is retried next time rather than remembered as done.
 */
export function renderInto(render, source, target) {
  if (target._prontoSource === source) return;
  buildNodes(render(source), target);
  target._prontoSource = source;
}
