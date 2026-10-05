// Deno smoke: the terminal's navigation stack and the addresses it moves
// between. The Navigation API tells a push from a traverse, which is what
// decides whether a held screen resumes its scroll; without it the terminal
// takes the click itself. Screens here carry no live regions, so no store
// query runs and the cases stay about navigation.
import { parseHTML } from "npm:linkedom@0.18.4";
import { templateHash } from "./screen.js";

const CONFIG_YAML = `
app: smoke
i18n:
  default: pt-BR
  locales:
    pt-BR: {path: pt-br}
    es: {path: es}
    en: {path: en}
tables: []
routes:
  - path: /
    screen: home
    nav: {label: Home, key: nav_home}
    files: {html: shell/screens/home.html, css: shell/screens/home.css, handlers: []}
  - path: /other
    screen: other
    nav: {label: Other}
    files: {html: shell/screens/other.html, css: shell/screens/other.css, handlers: []}
  - path: /regras
    screen: regras
    slug: route_rules
    paths: {pt-BR: /regras, es: /reglas, en: /rules}
    nav: {label: Regras}
    files: {html: shell/screens/regras.html, css: shell/screens/regras.css, handlers: []}
  - path: /pt/manual
    screen: manual
    nav: {label: Manual}
    files: {html: shell/screens/manual.html, css: shell/screens/manual.css, handlers: []}
  - path: /search/:q
    screen: search
    nav: {label: Search}
    files: {html: shell/screens/search.html, css: shell/screens/search.css, handlers: []}
  - path: /palavras
    screen: words
    nav: {label: Words, strip: false}
    files: {html: shell/screens/words.html, css: shell/screens/words.css, handlers: []}
`;

// Every screen carries a link named by route rather than by path, and home
// carries the one form whose whole effect is a move.
// The h1 is what names the screen in the document's title, so it is part of
// what these cases exercise; `other` carries none, which is the home screen's
// shape.
// `words` says one thing, in the reader's language.
const screenHtml = (name) => name === "words" ? `<section class="screen" data-screen="words"><h1>words</h1><p class="greet" data-text="{msg.greet}"></p></section>` : `<section class="screen" data-screen="${name}">${name === "other" ? "" : `<h1>${name}</h1>`}
<a class="rules" data-route="regras">R</a>
${name === "home" ? '<form data-action="navigate" data-route="search"><input name="q"></form>' : ""}
</section>`;

// A document a renderer served before the shell booted: its strip, its screen
// in the mount, and in its head the template it was rendered from
// (interpreter/document.js). Rendered from `template`, the screen's own unless
// the document is older than the template the shell fetches, and in `words`'s
// catalogues, each the text it was drawn from by tag.
const served = (name, template = screenHtml(name), witness = true, words = {}) => ({
  head: (witness ? `<meta name="pronto-cas" content="${templateHash(template)}">` : "") +
    (Object.keys(words).length > 0
      ? `<meta name="pronto-words" content="${Object.entries(words).map(([tag, text]) => `${tag}:${templateHash(text)}`).join(" ")}">`
      : ""),
  body: '<nav><a data-route="home" href="/">Início</a><a data-route="other" href="/other">Other</a>' +
    '<a data-route="regras" href="/regras" aria-current="page">Regras</a><a data-route="manual" href="/pt/manual">Manual</a></nav>' +
    `<div id=shell><div class="shell-screen" data-served>${template.replace('data-route="regras"', 'data-route="regras" href="/regras"')}</div></div>`,
});

// `serving` names the screen a served document carries, `witness` whether its
// head names its template, `servedWords` the catalogues it was drawn in;
// `slowCatalogues` answer when released. `catalogues` are the worker's copies
// by tag, and `deployed` the network's, which answers a request that
// revalidates; `blips` fail once, as a network that drops. `config` is the
// worker's copy of the config and `deployedConfig` the network's, and
// `modules` answer each handler by name, a status at a time until one is
// left. `tables` makes the app one a guest session is minted for, and
// `offline` leaves the auth service unreachable.
function boot({
  navigationAPI = true,
  at = "/",
  languages = ["pt-BR"],
  stall = [],
  rejects = [],
  serving,
  servedFrom,
  witness = true,
  slowCatalogues = [],
  catalogues = {},
  deployed = catalogues,
  blips = [],
  servedWords = {},
  config = CONFIG_YAML,
  deployedConfig = config,
  modules = {},
  tables = [],
  offline = false,
} = {}) {
  const page = serving ? served(serving, servedFrom, witness, servedWords) : {head: "", body: "<div id=shell></div>"};
  const {document, Event, MutationObserver} = parseHTML(
    `<!doctype html><html><head>${page.head}</head><body>${page.body}</body></html>`,
  );
  globalThis.document = document;
  globalThis.MutationObserver = MutationObserver;
  globalThis.window = globalThis;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

  const listeners = {};
  globalThis.addEventListener = (ev, fn) => (listeners[ev] ??= []).push(fn);

  let onNavigate = null;
  const intercepted = [];
  delete globalThis.navigation;
  if (navigationAPI) {
    globalThis.navigation = {
      addEventListener: (ev, fn) => {
        if (ev === "navigate") onNavigate = fn;
      },
    };
  }

  // The reader's own system, which is the rung under every address here: left
  // to the host runtime it says English and every default-locale case reads as
  // a negotiation instead.
  // The worker's announcements, delivered by `announce`.
  const heard = [];
  const serviceWorker = {addEventListener: (type, fn) => type === "message" && heard.push(fn)};
  Object.defineProperty(globalThis, "navigator", {value: {languages, serviceWorker}, configurable: true});

  let scrollPos = 0;
  globalThis.scrollTo = (_x, y) => (scrollPos = y);
  Object.defineProperty(globalThis, "scrollY", {get: () => scrollPos, configurable: true});

  const ORIGIN = "http://localhost:8080";
  const reloads = [];
  const loc = {origin: ORIGIN, reload: () => reloads.push(loc.pathname)};
  const setUrl = (url) => {
    const u = new URL(url, ORIGIN);
    Object.assign(loc, {href: u.href, pathname: u.pathname, search: u.search, hash: u.hash});
  };
  setUrl(at);
  Object.defineProperty(globalThis, "location", {value: loc, configurable: true});
  // Under the Navigation API a replaceState is a navigation too, raised
  // before the URL moves and handled after it, which is what the terminal's
  // own restating of an address has to survive.
  globalThis.history = {
    pushState: (_state, _title, url) => setUrl(url),
    replaceState: (_state, _title, url) => {
      let handler;
      onNavigate?.({
        canIntercept: true,
        downloadRequest: null,
        formData: null,
        navigationType: "replace",
        destination: {url: new URL(url, ORIGIN).href, sameDocument: true},
        intercept: (opts) => {
          intercepted.push(url);
          handler = opts.handler;
        },
      });
      setUrl(url);
      if (handler) queueMicrotask(handler);
    },
  };

  sessionStorage.clear();
  const held = [];
  const minted = [];
  const revalidated = [];
  globalThis.fetch = (url, init) => {
    const u = String(url);
    if (u.endsWith("shell.yaml")) {
      const text = init?.cache === "no-cache" ? deployedConfig : config;
      return Promise.resolve(new Response(text.replace("tables: []", `tables: [${tables}]`)));
    }
    const handler = u.match(/handlers\/(\w+)\.js$/)?.[1];
    if (handler !== undefined && modules[handler] !== undefined) {
      const answers = modules[handler];
      const status = answers.length > 1 ? answers.shift() : answers[0];
      return Promise.resolve(new Response(status === 200 ? "const reduce = (state) => state;\nreduce;" : "", {status}));
    }
    if (u.endsWith("/auth/guest")) {
      minted.push(u);
      if (offline) return Promise.reject(new TypeError("Failed to fetch"));
    }
    const screen = u.match(/screens\/(\w+)\.html$/);
    if (screen) {
      // The two ways a first load ends without a screen: it never answers, or
      // it answers with a failure.
      if (stall.includes(screen[1])) return new Promise(() => {});
      if (rejects.includes(screen[1])) return Promise.reject(new Error(`screen ${screen[1]} unavailable`));
      return Promise.resolve(new Response(screenHtml(screen[1])));
    }
    if (u.endsWith(".css")) return Promise.resolve(new Response(""));
    const catalogue = u.match(/\/messages\/([\w-]+)\.json$/)?.[1];
    if (slowCatalogues.includes(catalogue)) {
      return new Promise((resolve) => held.push(() => resolve(new Response("{}", {status: 404}))));
    }
    if (blips.includes(catalogue)) {
      blips.splice(blips.indexOf(catalogue), 1);
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    if (init?.cache === "no-cache" && catalogue !== undefined) revalidated.push(catalogue);
    const copy = (init?.cache === "no-cache" ? deployed : catalogues)[catalogue];
    if (copy !== undefined) return Promise.resolve(new Response(copy));
    if (u.includes("/messages/")) return Promise.resolve(new Response("{}", {status: 404}));
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  };

  return {
    Event,
    document,
    // Every guest session asked of the auth service.
    minted,
    // The browser telling the page it is back online.
    online: () => (listeners.online ?? []).splice(0).forEach((fn) => fn()),
    // Answers every catalogue held back so far.
    releaseCatalogues: () => held.splice(0).forEach((answer) => answer()),
    // The service worker telling every window a screen's template changed.
    announce: (name, html) => {
      for (const fn of heard) fn({data: {type: "PRONTO_SKELETON_UPDATED", pathname: `/shell/screens/${name}.html`, html}});
    },
    // And that a catalogue did.
    announceWords: (tag, json) => {
      for (const fn of heard) fn({data: {type: "PRONTO_MESSAGES_UPDATED", pathname: `/messages/${tag}.json`, json}});
    },
    // The catalogues asked of the network past the worker's copy.
    revalidated,
    // Every address the document was replaced at.
    reloads,
    mount: document.getElementById("shell"),
    // The replaceStates the terminal took as navigations of its own.
    intercepted,
    userScrollsTo: (y) => (scrollPos = y),
    interceptedWith: null,
    at: () => loc.pathname + loc.search,
    // The strip link for a route, which is how a reader moves and therefore
    // how these cases do.
    link: (screen) => document.querySelector(`nav a[data-route="${screen}"]`),
    // The Navigation API raises `navigate` BEFORE the URL changes, and the URL
    // is the destination's by the time an intercept handler runs.
    async goto(path, navigationType = "push") {
      if (!navigationAPI) {
        const target = this.link(path) ?? path;
        if (typeof target === "string") throw new Error(`no strip link for ${path}`);
        for (const fn of listeners.click ?? []) {
          await fn({defaultPrevented: false, button: 0, target, preventDefault() {}});
        }
      } else {
        let handler;
        await onNavigate({
          canIntercept: true,
          downloadRequest: null,
          formData: null,
          navigationType,
          destination: {url: new URL(path, ORIGIN).href, sameDocument: true},
          intercept: (opts) => {
            this.interceptedWith = opts;
            handler = opts.handler;
          },
        });
        setUrl(path);
        await handler?.();
      }
      await new Promise((r) => setTimeout(r, 80));
    },
    async back(path) {
      setUrl(path);
      for (const fn of listeners.popstate ?? []) await fn();
      await new Promise((r) => setTimeout(r, 80));
    },
  };
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
// Long enough to outlive shell.js's SCREEN_LOAD_CAP_MS and the release's two
// frames. Raise it with that constant, never below it.
const SCREEN_CAP_WAIT = 2400;
const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};
const shown = (app) => [...app.mount.querySelectorAll(".shell-screen")]
  .filter((el) => !el.hidden)
  .map((el) => el.querySelector("[data-screen]"));

async function start(opts) {
  const app = boot(opts);
  const {createShell} = await import("./shell.js");
  await createShell({config: "./shell/shell.yaml", mount: app.mount});
  await settle();
  return app;
}

Deno.test({
  name: "the stack owns scroll, so navigation is intercepted with scroll: manual",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start();
    await app.goto("/other");
    // Left to the browser, a held screen already painted at the right offset
    // would be scrolled again underneath us.
    assert(
      app.interceptedWith?.scroll === "manual",
      `intercepted with ${JSON.stringify(app.interceptedWith?.scroll)}`,
    );
  },
});

// The fade that covers a first load is written as an attribute the design layer
// reads — `.shell-screen[data-entering] { opacity: 0 }`, emitted into all ten
// apps. Left on, it is a screen that is laid out, hit-testable and invisible,
// which reads as a dead app rather than as a slow one. These two cases are the
// endings that produce no screen; the ordinary ending is covered by every other
// case in this file, which would see nothing at all if the stamp never cleared.
const arriving = (app) => [...app.mount.querySelectorAll(".shell-screen")].at(-1);

Deno.test({
  name: "a first load that never answers still uncovers its screen",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start({stall: ["other"]});
    // Not awaited: the move cannot finish while the screen's own fetch hangs,
    // which is the condition under test.
    app.goto("/other");
    await settle(SCREEN_CAP_WAIT);
    const el = arriving(app);
    assert(el !== undefined, "no screen slot was created");
    assert(!("entering" in el.dataset), "the screen is still covered by its own entrance");
  },
});

Deno.test({
  name: "a first load that fails still uncovers its screen",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start({rejects: ["other"]});
    await app.goto("/other").catch(() => {});
    await settle();
    const el = arriving(app);
    assert(el !== undefined, "no screen slot was created");
    assert(!("entering" in el.dataset), "the screen is still covered by its own entrance");
  },
});

Deno.test({
  name: "a screen arrived at starts at its top",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start();
    app.userScrollsTo(500);
    await app.goto("/other");
    assert(scrollY === 0, `landed at ${scrollY}, not the top`);
  },
});

Deno.test({
  name: "going back resumes where the screen was left",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start();
    app.userScrollsTo(500);
    await app.goto("/other");
    await app.goto("/", "traverse");
    assert(scrollY === 500, `resumed at ${scrollY}, not 500`);
    assert(
      app.mount.querySelectorAll(".shell-screen").length === 2,
      "both screens should be held — the restore only means anything on live DOM",
    );
  },
});

// The distinction a location the terminal cannot see could never draw: a link
// back to a screen you have already seen is a new arrival, not a return.
Deno.test({
  name: "a link to an already-visited screen starts at its top",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start();
    app.userScrollsTo(500);
    await app.goto("/other");
    await app.goto("/", "push");
    assert(scrollY === 0, `a pushed link resumed at ${scrollY} instead of the top`);
  },
});

Deno.test({
  name: "without the Navigation API a link is pushed by hand, and popstate still resumes",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start({navigationAPI: false});
    app.userScrollsTo(500);
    await app.goto("other");
    // The click became a history entry rather than a document load.
    assert(app.at() === "/other", `pushed ${app.at()}`);
    assert(shown(app)[0]?.dataset.screen === "other", "the pushed link did not mount its screen");
    await app.back("/");
    assert(scrollY === 500, `the traverse resumed at ${scrollY}, not 500`);
  },
});

Deno.test({
  name: "the default locale is served unprefixed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start({at: "/regras"});
    const screen = shown(app)[0];
    assert(screen?.dataset.screen === "regras", `mounted ${screen?.dataset.screen}`);
    assert(screen.dataset.locale === "pt-BR", `read as ${screen.dataset.locale}`);
  },
});

Deno.test({
  name: "a locale prefix picks both the pattern and the language",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start({at: "/es/reglas"});
    const screen = shown(app)[0];
    assert(screen?.dataset.screen === "regras", `mounted ${screen?.dataset.screen}`);
    assert(screen.dataset.locale === "es", `read as ${screen.dataset.locale}`);
    // The strip is re-addressed per navigation, so every link stays in the
    // language of the page it is on.
    assert(app.link("regras").getAttribute("href") === "/es/reglas", app.link("regras").getAttribute("href"));
    assert(app.link("home").getAttribute("href") === "/es", app.link("home").getAttribute("href"));
  },
});

// The entry document is one file answering at every address: it ships
// `lang="en"` titled "Loading…", with no canonical and no alternates, and
// nothing but these writes a screen's own. They shipped wrong for every route
// of every locale and no case noticed, because every case here reads the mount
// and none read the head.
const head = (app, sel) => [...app.document.head.querySelectorAll(sel)];
const alternates = (app) =>
  Object.fromEntries(
    head(app, 'link[rel="alternate"][hreflang]').map((l) => [l.getAttribute("hreflang"), l.getAttribute("href")]),
  );

Deno.test({
  name: "the document is in the language it renders",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // A screen reader takes its voice from this attribute, so the entry's `en`
    // left standing announces Spanish in an English one.
    const app = await start({at: "/es/reglas"});
    assert(app.document.documentElement.lang === "es", `document says ${app.document.documentElement.lang}`);
    // And which way it reads, which is what the nav strip, the scrollbar and
    // every unstyled box take their side from. Both of this app's languages
    // read left-to-right; which language reads which way is graded against the
    // engine in test/locale-resolver.test.ts.
    assert(app.document.documentElement.dir === "ltr", `document reads ${app.document.documentElement.dir}`);
    await app.goto("/regras");
    assert(app.document.documentElement.lang === "pt-BR", `document says ${app.document.documentElement.lang}`);
    assert(app.document.documentElement.dir === "ltr", `document reads ${app.document.documentElement.dir}`);
  },
});

Deno.test({
  name: "the document is titled by the screen on show, and by the app where a screen has no name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start({at: "/regras"});
    assert(app.document.title === "regras — smoke", `titled ${app.document.title}`);
    // No h1: the screen is the app itself rather than a page within it.
    await app.goto("/other");
    assert(app.document.title === "smoke", `titled ${app.document.title}`);
  },
});

Deno.test({
  name: "a localized route names its own address and every other locale's",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start({at: "/es/reglas"});
    // Absolute, composed against the origin the reader arrived under: a
    // crawler compares these across locales and a path would not compare.
    assert(
      head(app, 'link[rel="canonical"]')[0]?.getAttribute("href") === "http://localhost:8080/es/reglas",
      `canonical ${head(app, 'link[rel="canonical"]')[0]?.getAttribute("href")}`,
    );
    const alts = alternates(app);
    assert(alts["es"] === "http://localhost:8080/es/reglas", `es ${alts["es"]}`);
    assert(alts["en"] === "http://localhost:8080/en/rules", `en ${alts["en"]}`);
    assert(alts["pt-BR"] === "http://localhost:8080/regras", `pt-BR ${alts["pt-BR"]}`);
    // x-default is the default locale's unprefixed address, not a fourth one.
    assert(alts["x-default"] === "http://localhost:8080/regras", `x-default ${alts["x-default"]}`);
  },
});

Deno.test({
  name: "a prefixed address is the language it names, whatever the reader prefers",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // The prefix decides, so a reader who follows a Spanish link gets Spanish.
    const app = await start({at: "/es/reglas", languages: ["en"]});
    assert(shown(app)[0]?.dataset.locale === "es", `rendered ${shown(app)[0]?.dataset.locale}`);
    assert(app.document.documentElement.lang === "es", `document says ${app.document.documentElement.lang}`);
  },
});

Deno.test({
  name: "an unprefixed address read in another language becomes that language's address",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // The door answers /regras for an English reader with the English
    // document rather than a 302 to /en/rules (negotiation_test.ts holds it to
    // the same rule as this one), so the terminal is what moves the address.
    // It must move it, not merely render English under it: the canonical is
    // the address's own language, and two readers of one URL must not be told
    // two different things.
    const app = await start({at: "/regras", languages: ["en"]});
    assert(app.at() === "/en/rules", `settled at ${app.at()}`);
    // Taken as a navigation, the restatement shows the screen a second time:
    // in a browser that re-ran its entrance under a reader already looking
    // at it, measured as a layout shift of 0.58 on golaberto's home.
    assert(app.intercepted.length === 0, `the restated address was navigated to: ${app.intercepted}`);
    assert(
      head(app, 'link[rel="canonical"]')[0]?.getAttribute("href") === "http://localhost:8080/en/rules",
      `canonical ${head(app, 'link[rel="canonical"]')[0]?.getAttribute("href")}`,
    );
  },
});

Deno.test({
  name: "the head describes the screen on show, not the one before it",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Rewritten rather than appended: a second navigation that added a second
    // canonical would leave the crawler to pick one.
    const app = await start({at: "/es/reglas"});
    await app.goto("/es");
    assert(head(app, 'link[rel="canonical"]').length === 1, `${head(app, 'link[rel="canonical"]').length} canonicals`);
    assert(
      head(app, 'link[rel="canonical"]')[0].getAttribute("href") === "http://localhost:8080/es",
      head(app, 'link[rel="canonical"]')[0].getAttribute("href"),
    );
    assert(alternates(app)["en"] === "http://localhost:8080/en", alternates(app)["en"]);
  },
});

Deno.test({
  name: "a first segment the app declares no locale for is a route's own",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // `pt` looks like a language and is not one this app declares — the
    // ambiguity /es would carry if a route's default slug were ever `es`.
    const app = await start({at: "/pt/manual"});
    const screen = shown(app)[0];
    assert(screen?.dataset.screen === "manual", `mounted ${screen?.dataset.screen}`);
    assert(screen.dataset.locale === "pt-BR", `read as ${screen.dataset.locale}`);
  },
});

Deno.test({
  name: "?lang= on a localized route is replaced by the address it names",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // One document, one address: the server answers this case with a 301, and
    // a deep link that arrives here is canonicalised before anything renders.
    const app = await start({at: "/regras?lang=en"});
    assert(app.at() === "/en/rules", `settled at ${app.at()}`);
    assert(shown(app)[0]?.dataset.locale === "en", `read as ${shown(app)[0]?.dataset.locale}`);
  },
});

Deno.test({
  name: "?lang= on a plain route decides its language and leaves the address alone",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start({at: "/other?lang=es"});
    assert(app.at() === "/other?lang=es", `settled at ${app.at()}`);
    assert(shown(app)[0]?.dataset.locale === "es", `read as ${shown(app)[0]?.dataset.locale}`);
  },
});

Deno.test({
  name: "a link names a route, and the terminal writes its address in the page's language",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start({at: "/es/other"});
    const link = shown(app)[0].querySelector("a.rules");
    // The same markup on the Portuguese page addresses /regras.
    assert(link.getAttribute("href") === "/es/reglas", `linked to ${link.getAttribute("href")}`);
  },
});

// The strip is chrome, so nothing a screen's markup says reaches it: a route's
// label was a literal in the route table, spelled once in whatever language the
// author typed, and worn under every address the app answers at.
Deno.test({
  name: "the strip's label is the language the page is in",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start({catalogues: {
      "pt-BR": JSON.stringify({nav_home: "Início"}),
      es: JSON.stringify({nav_home: "Inicio"}),
      en: JSON.stringify({nav_home: "Start"}),
    }});
    assert(app.link("home").textContent === "Início", `the strip reads ${app.link("home").textContent}`);
    await app.goto("/es");
    assert(app.link("home").textContent === "Inicio", `the strip reads ${app.link("home").textContent}`);
    await app.goto("/en");
    assert(app.link("home").textContent === "Start", `the strip reads ${app.link("home").textContent}`);
  },
});

Deno.test({
  name: "a route with no label key keeps the label the table spells",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Every app but one is on this path: the label is the only spelling there
    // is, and a locale pass that wrote over it with nothing would empty the
    // strip of an app that never asked to be translated.
    const app = await start();
    assert(app.link("other").textContent === "Other", `the strip reads ${app.link("other").textContent}`);
    await app.goto("/es");
    assert(app.link("other").textContent === "Other", `the strip reads ${app.link("other").textContent}`);
  },
});

Deno.test({
  name: "a navigate form fills its route's :params from its inputs and moves the stack",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start({navigationAPI: false});
    const form = shown(app)[0].querySelector("form");
    form.checkValidity ??= () => true;
    form.querySelector("[name=q]").value = "truco";
    form.dispatchEvent(new app.Event("submit", {bubbles: true, cancelable: true}));
    await settle(120);
    assert(app.at() === "/search/truco", `submitted to ${app.at()}`);
    assert(shown(app)[0]?.dataset.screen === "search", "the search screen never mounted");
  },
});

Deno.test({
  name: "a served document is taken over by the shell, not joined or replaced",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // The shell appended each screen beside whatever the mount held, so a
    // served document showed its screen twice. It then rendered its own out of
    // sight and swapped it in, which threw away every node the reader was on.
    const app = boot({at: "/regras", serving: "regras"});
    const servedScreen = app.mount.querySelector("[data-served]");
    const heading = servedScreen.querySelector("h1");
    const {createShell} = await import("./shell.js");
    await createShell({config: "./shell/shell.yaml", mount: app.mount});
    await settle();
    const screens = app.mount.querySelectorAll(".shell-screen");
    assert(screens.length === 1 && screens[0] === servedScreen, `${screens.length} screens, the served one ${screens[0] === servedScreen ? "kept" : "gone"}`);
    assert(!screens[0].hidden && !screens[0].hasAttribute("data-served"), "the served screen was not taken over");
    assert(screens[0].querySelector("h1") === heading, "the heading was drawn again");
    const navs = app.document.querySelectorAll("body > nav");
    assert(navs.length === 1, `${navs.length} strips: ${[...navs].map((n) => n.outerHTML)}`);
  },
});

Deno.test({
  name: "a served strip is kept, with the link the reader is on",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // The strip was drawn again over the served one, so a reader who had
    // tabbed into it while the modules loaded lost the link they were on.
    const app = boot({at: "/regras", serving: "regras"});
    const strip = app.document.querySelector("body > nav");
    const links = [...strip.querySelectorAll("a")];
    const {createShell} = await import("./shell.js");
    await createShell({config: "./shell/shell.yaml", mount: app.mount});
    await settle();
    assert(app.document.querySelector("body > nav") === strip, "the served strip was replaced");
    const now = [...strip.querySelectorAll("a")];
    assert(now.length === links.length && now.every((a, i) => a === links[i]), "a served link was drawn again");
    assert(app.link("regras").getAttribute("aria-current") === "page", "the strip does not mark the page it is on");
  },
});

Deno.test({
  name: "a kept document of a screen this address no longer maps to gives way to a fresh mount",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // The worker keeps a document for an address across deploys, and the shell
    // read from a newer one mounts another screen there: the boot failed, and
    // its banner replaced the page the reader had.
    const app = boot({at: "/regras", serving: "other"});
    const {createShell} = await import("./shell.js");
    await createShell({config: "./shell/shell.yaml", mount: app.mount});
    await settle();
    assert(app.mount.querySelector("pre") === null, `a banner: ${app.mount.querySelector("pre")?.textContent}`);
    assert(shown(app).length === 1 && shown(app)[0]?.dataset.screen === "regras", `showing ${shown(app).map((s) => s?.dataset.screen)}`);
  },
});

Deno.test({
  name: "a kept document naming no template gives way to a fresh mount",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = boot({at: "/regras", serving: "regras", witness: false});
    const {createShell} = await import("./shell.js");
    await createShell({config: "./shell/shell.yaml", mount: app.mount});
    await settle();
    assert(app.mount.querySelector("pre") === null, `a banner: ${app.mount.querySelector("pre")?.textContent}`);
    assert(shown(app).length === 1 && shown(app)[0]?.dataset.screen === "regras", `showing ${shown(app).map((s) => s?.dataset.screen)}`);
  },
});

Deno.test({
  name: "a document opened offline stays the page while no guest session can be had",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // A tab opened offline paints what the worker kept and holds no session,
    // which lives in the tab. The guest mint failed, and the banner replaced
    // the page the reader was reading with a stack trace.
    const app = boot({at: "/regras", serving: "regras", tables: ["note"], offline: true});
    const servedScreen = app.mount.querySelector("[data-served]");
    const {createShell} = await import("./shell.js");
    createShell({config: "./shell/shell.yaml", mount: app.mount});
    await settle();
    assert(app.mount.querySelector("pre") === null, `a banner: ${app.mount.querySelector("pre")?.textContent}`);
    assert(app.mount.querySelector(".shell-screen") === servedScreen && !servedScreen.hidden, "the served screen was taken down");
    assert(app.minted.length === 1, `${app.minted.length} mints`);
    app.online();
    await settle();
    assert(app.minted.length === 2, `the mint was not asked again online: ${app.minted.length}`);
    assert(app.mount.querySelector(".shell-screen") === servedScreen, "the served screen was taken down");
  },
});

Deno.test({
  name: "a served document stays the page, as it was, while the shell takes it over",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Nothing the reader is reading may blank, fade or jump while the shell
    // boots: the served screen is the page throughout, scrolled where the
    // reader scrolled it.
    const app = boot({at: "/regras", serving: "regras", stall: ["regras"]});
    app.userScrollsTo(640);
    const {createShell} = await import("./shell.js");
    createShell({config: "./shell/shell.yaml", mount: app.mount});
    await settle();
    const servedScreen = app.mount.querySelector("[data-served]");
    assert(servedScreen !== null && !servedScreen.hidden, "the served screen was taken down while the shell booted");
    assert(app.mount.querySelectorAll(".shell-screen").length === 1, "a second screen is being drawn beside the served one");
    assert(servedScreen.dataset.entering === undefined, "a served screen fades in over itself");
    assert(globalThis.scrollY === 640, `the reader was moved to ${globalThis.scrollY}`);
  },
});

Deno.test({
  name: "a served screen keeps the reader's scroll once taken over",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = boot({at: "/regras", serving: "regras"});
    app.userScrollsTo(640);
    const {createShell} = await import("./shell.js");
    await createShell({config: "./shell/shell.yaml", mount: app.mount});
    await settle();
    assert(globalThis.scrollY === 640, `the reader was moved to ${globalThis.scrollY}`);
  },
});

Deno.test({
  name: "a served document older than its template is brought to it in place",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = boot({at: "/regras", serving: "regras", servedFrom: screenHtml("regras").replace("<h1>regras</h1>", "<h1>regras</h1><p>retired</p>")});
    const servedScreen = app.mount.querySelector("[data-served]");
    const heading = servedScreen.querySelector("h1");
    const {createShell} = await import("./shell.js");
    await createShell({config: "./shell/shell.yaml", mount: app.mount});
    await settle();
    assert(app.mount.querySelector(".shell-screen") === servedScreen, "the served screen was replaced");
    assert(servedScreen.querySelector("h1") === heading, "an unchanged heading was drawn again");
    assert(servedScreen.querySelector("p") === null, "the template's retired paragraph is still on the page");
  },
});

Deno.test({
  name: "a template the worker announces before its screen is mounted reaches the screen once it is",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // The worker answers a screen's fetch from its copy and announces the newer
    // template as soon as its revalidation lands, which the shell's own
    // prefetch made sooner than anything was listening.
    const app = boot({at: "/regras", serving: "regras"});
    const heading = app.mount.querySelector("h1");
    const {createShell} = await import("./shell.js");
    const booting = createShell({config: "./shell/shell.yaml", mount: app.mount});
    app.announce("regras", screenHtml("regras").replace("<h1>regras</h1>", "<h1>regras</h1><p class=\"deployed\">new</p>"));
    await booting;
    await settle();
    assert(app.mount.querySelector(".deployed")?.textContent === "new", "the announced template never reached the screen");
    assert(app.mount.querySelector("h1") === heading, "the heading was drawn again");
  },
});

Deno.test({
  name: "leaving a served document before it is taken over puts it out of sight",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = boot({at: "/regras", serving: "regras", stall: ["regras"]});
    const {createShell} = await import("./shell.js");
    createShell({config: "./shell/shell.yaml", mount: app.mount});
    await settle();
    await app.goto("/other");
    assert(shown(app).length === 1 && shown(app)[0]?.dataset.screen === "other", `showing ${shown(app).map((s) => s?.dataset.screen)}`);
  },
});

Deno.test({
  name: "a move into another language that a later move overtakes mounts nothing",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // A move into a language whose catalogue had not arrived waited for it
    // with the route it had read; a move made meanwhile mounted, and the
    // first then mounted its own screen over it at the second's address.
    const app = await start({at: "/regras", slowCatalogues: ["en"]});
    const switching = app.goto("/en/rules");
    await settle(10);
    await app.goto("/other");
    app.releaseCatalogues();
    await switching;
    await settle();
    assert(app.at() === "/other", `at ${app.at()}`);
    assert(shown(app).length === 1 && shown(app)[0]?.dataset.screen === "other", `showing ${shown(app).map((s) => s?.dataset.screen)}`);
  },
});

// A catalogue the worker kept is any deploy old, and so is a document. On
// taking a document over the screen writes its words again in the catalogue
// the shell holds, so a document newer than the worker's copy was written back
// to the older words, and stayed so for the visit.
const OLD_WORDS = JSON.stringify({greet: "Olá"});
const NEW_WORDS = JSON.stringify({greet: "Olá de novo"});
const greeting = (app) => app.mount.querySelector(".greet")?.textContent;

Deno.test({
  name: "a served document in newer words than the worker's catalogue keeps them",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = boot({
      at: "/palavras",
      serving: "words",
      servedFrom: screenHtml("words").replace("></p>", ">Olá de novo</p>"),
      servedWords: {"pt-BR": NEW_WORDS},
      catalogues: {"pt-BR": OLD_WORDS},
      deployed: {"pt-BR": NEW_WORDS},
    });
    const {createShell} = await import("./shell.js");
    await createShell({config: "./shell/shell.yaml", mount: app.mount});
    await settle();
    assert(greeting(app) === "Olá de novo", `the served words were written back to ${JSON.stringify(greeting(app))}`);
    // The shell holds the newer words from then on, and draws them.
    await app.goto("/other");
    await app.goto("/palavras", "traverse");
    assert(greeting(app) === "Olá de novo", `drawn again as ${JSON.stringify(greeting(app))}`);
  },
});

Deno.test({
  name: "a served document in the worker's words asks nothing of the network",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = boot({
      at: "/palavras",
      serving: "words",
      servedFrom: screenHtml("words").replace("></p>", ">Olá</p>"),
      servedWords: {"pt-BR": OLD_WORDS},
      catalogues: {"pt-BR": OLD_WORDS},
    });
    const {createShell} = await import("./shell.js");
    await createShell({config: "./shell/shell.yaml", mount: app.mount});
    await settle();
    assert(app.revalidated.length === 0, `revalidated ${app.revalidated}`);
    assert(greeting(app) === "Olá", `drawn as ${JSON.stringify(greeting(app))}`);
  },
});

Deno.test({
  name: "a catalogue the worker announces is written into the screen on show and the ones held",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // The worker kept catalogues and announced none of their changes, so a
    // deploy's words reached a reader one page load late.
    const app = await start({at: "/palavras", catalogues: {"pt-BR": OLD_WORDS}});
    assert(greeting(app) === "Olá", `drawn as ${JSON.stringify(greeting(app))}`);
    app.announceWords("pt-BR", NEW_WORDS);
    await settle();
    assert(greeting(app) === "Olá de novo", `still ${JSON.stringify(greeting(app))}`);
    await app.goto("/other");
    app.announceWords("pt-BR", OLD_WORDS);
    await settle();
    await app.goto("/palavras", "traverse");
    assert(greeting(app) === "Olá", `the held screen came back as ${JSON.stringify(greeting(app))}`);
  },
});

Deno.test({
  name: "a catalogue that failed to arrive is asked again",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // The first answer was kept for the locale whatever it was, so one dropped
    // request left every later move into that language throwing it.
    const app = await start({at: "/", blips: ["es"], catalogues: {es: JSON.stringify({greet: "Hola"})}});
    let dropped;
    await app.goto("/es/reglas").catch((err) => (dropped = err));
    assert(String(dropped).includes("Failed to fetch"), `the dropped request said ${dropped}`);
    await app.goto("/es");
    const screen = shown(app)[0];
    assert(screen?.dataset.screen === "home" && screen.dataset.locale === "es", `showing ${screen?.dataset.screen} in ${screen?.dataset.locale}`);
  },
});

Deno.test({
  name: "a template the worker announces that cannot be taken says so",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // The morph's rejection went unheard: the stray-rejection handler marked
    // the screen offline and logged it, so a deploy that broke a screen read
    // as a reader's dropped connection.
    const app = await start({at: "/regras"});
    app.announce("regras", screenHtml("regras").replace("<h1>regras</h1>", "<h1>regras</h1><div data-hatch=\"undeclared\"></div>"));
    await settle();
    const banner = app.mount.querySelector("pre")?.textContent ?? "";
    assert(banner.includes(`no vendored unit for data-hatch="undeclared"`), `the banner says ${JSON.stringify(banner)}`);
  },
});

// The strip's words were the config's, which the worker keeps any deploy old
// and announces no change of: settling the catalogues against a served
// document, and taking the ones the worker announced, left the strip in older
// words for the visit.
const home = (word) => JSON.stringify({nav_home: word});

Deno.test({
  name: "a served strip in newer words than the worker's keeps them",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = boot({
      at: "/regras",
      serving: "regras",
      servedWords: {"pt-BR": home("Começo")},
      catalogues: {"pt-BR": home("Início")},
      deployed: {"pt-BR": home("Começo")},
    });
    app.link("home").textContent = "Começo";
    const {createShell} = await import("./shell.js");
    await createShell({config: "./shell/shell.yaml", mount: app.mount});
    await settle();
    assert(app.link("home").textContent === "Começo", `the strip was written back to ${app.link("home").textContent}`);
  },
});

Deno.test({
  name: "a catalogue the worker announces is written into the strip",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start({at: "/regras", catalogues: {"pt-BR": home("Início")}});
    app.announceWords("pt-BR", home("Começo"));
    await settle();
    assert(app.link("home").textContent === "Começo", `the strip still reads ${app.link("home").textContent}`);
  },
});

// A newer template names its modules in its own deploy's config, and the
// shell runs on the config the worker kept, which it never announces: a deploy
// adding a handler to a screen made the announced template unloadable, and the
// banner put a stack trace where every screen had been. A module the door
// failed mid-deploy did the same.
const withHandler = (handlers) => CONFIG_YAML.replace(
  "files: {html: shell/screens/regras.html, css: shell/screens/regras.css, handlers: []}",
  `files: {html: shell/screens/regras.html, css: shell/screens/regras.css, handlers: [${handlers}]}`,
);
const handled = screenHtml("regras").replace("<h1>regras</h1>", '<h1>regras</h1><p class="deployed">new</p><button data-on-click="fresh">go</button>');

Deno.test({
  name: "a template the worker announces under a config the deploy changed replaces the document",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start({at: "/regras", deployedConfig: withHandler("shell/handlers/fresh.js"), modules: {fresh: [200]}});
    app.announce("regras", handled);
    await settle();
    assert(app.mount.querySelector("pre") === null, `a banner: ${app.mount.querySelector("pre")?.textContent}`);
    assert(app.reloads.length === 1 && app.reloads[0] === "/regras", `replaced at ${JSON.stringify(app.reloads)}`);
    assert(shown(app)[0]?.dataset.screen === "regras", `showing ${shown(app).map((s) => s?.dataset.screen)}`);
  },
});

Deno.test({
  name: "a template whose module the network fails leaves the screen as it was, and is taken once it is shown again",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const config = withHandler("shell/handlers/fresh.js");
    const app = await start({at: "/regras", config, modules: {fresh: [502, 200]}});
    app.announce("regras", handled);
    await settle();
    assert(app.mount.querySelector("pre") === null, `a banner: ${app.mount.querySelector("pre")?.textContent}`);
    assert(app.reloads.length === 0, `replaced at ${JSON.stringify(app.reloads)}`);
    const screen = shown(app)[0];
    assert(screen?.dataset.screen === "regras" && screen.dataset.state === "network-error", `showing ${screen?.dataset.screen} as ${screen?.dataset.state}`);
    assert(app.mount.querySelector(".deployed") === null, "a template not taken reached the screen");
    await app.goto("/other");
    await app.goto("/regras", "traverse");
    assert(app.mount.querySelector(".deployed")?.textContent === "new", "the template was not asked again");
  },
});
