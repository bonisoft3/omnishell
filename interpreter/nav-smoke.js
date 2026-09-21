// Deno smoke: the terminal's navigation stack and the addresses it moves
// between. The Navigation API tells a push from a traverse, which is what
// decides whether a held screen resumes its scroll; without it the terminal
// takes the click itself. Screens here carry no live regions, so no store
// query runs and the cases stay about navigation.
import { parseHTML } from "npm:linkedom@0.18.4";

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
    nav: {label: Home, key: nav_home, labels: {pt-BR: Início, es: Inicio, en: Start}}
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
`;

// Every screen carries a link named by route rather than by path, and home
// carries the one form whose whole effect is a move.
// The h1 is what names the screen in the document's title, so it is part of
// what these cases exercise; `other` carries none, which is the home screen's
// shape.
const screenHtml = (name) => `<section class="screen" data-screen="${name}">${name === "other" ? "" : `<h1>${name}</h1>`}
<a class="rules" data-route="regras">R</a>
${name === "home" ? '<form data-action="navigate" data-route="search"><input name="q"></form>' : ""}
</section>`;

function boot({navigationAPI = true, at = "/", languages = ["pt-BR"], stall = [], rejects = []} = {}) {
  const {document, Event} = parseHTML(
    "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
  );
  globalThis.document = document;
  globalThis.window = globalThis;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

  const listeners = {};
  globalThis.addEventListener = (ev, fn) => (listeners[ev] ??= []).push(fn);

  let onNavigate = null;
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
  Object.defineProperty(globalThis, "navigator", {value: {languages}, configurable: true});

  let scrollPos = 0;
  globalThis.scrollTo = (_x, y) => (scrollPos = y);
  Object.defineProperty(globalThis, "scrollY", {get: () => scrollPos, configurable: true});

  const ORIGIN = "http://localhost:8080";
  const loc = {origin: ORIGIN};
  const setUrl = (url) => {
    const u = new URL(url, ORIGIN);
    Object.assign(loc, {href: u.href, pathname: u.pathname, search: u.search, hash: u.hash});
  };
  setUrl(at);
  Object.defineProperty(globalThis, "location", {value: loc, configurable: true});
  globalThis.history = {
    pushState: (_state, _title, url) => setUrl(url),
    replaceState: (_state, _title, url) => setUrl(url),
  };

  sessionStorage.clear();
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.endsWith("shell.yaml")) return Promise.resolve(new Response(CONFIG_YAML));
    const screen = u.match(/screens\/(\w+)\.html$/);
    if (screen) {
      // The two ways a first load ends without a screen: it never answers, or
      // it answers with a failure.
      if (stall.includes(screen[1])) return new Promise(() => {});
      if (rejects.includes(screen[1])) return Promise.reject(new Error(`screen ${screen[1]} unavailable`));
      return Promise.resolve(new Response(screenHtml(screen[1])));
    }
    if (u.endsWith(".css")) return Promise.resolve(new Response(""));
    if (u.includes("/messages/")) return Promise.resolve(new Response("{}", {status: 404}));
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  };

  return {
    Event,
    document,
    mount: document.getElementById("shell"),
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
  name: "the canonical is the address's own language, not the reader's",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // The door moves a reader off an unprefixed address their language does
    // not match (negotiation_test.ts holds it to the same rule as this one),
    // so a served /regras is Portuguese. Reached without a door — here, or a
    // harness — the terminal still renders what the reader asked for, and the
    // canonical stays the address's own: it is what a crawler is told to keep,
    // and two readers of one URL must not be told two different things.
    const app = await start({at: "/regras", languages: ["en"]});
    assert(
      head(app, 'link[rel="canonical"]')[0]?.getAttribute("href") === "http://localhost:8080/regras",
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
    const app = await start();
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
