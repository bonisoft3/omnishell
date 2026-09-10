// Deno smoke: the terminal's navigation stack, on both roads. The Navigation
// API tells a push from a traverse, which is what decides whether a held
// screen resumes its scroll; hashchange cannot,
// and keeps resuming. Screens here carry no live regions, so no store query
// runs and the cases stay about navigation.
import { parseHTML } from "npm:linkedom@0.18.4";

const CONFIG_YAML = `
app: smoke
tables: []
routes:
  - path: /
    screen: home
    nav: {label: Home}
    files: {html: shell/screens/home.html, css: shell/screens/home.css, handlers: []}
  - path: /other
    screen: other
    nav: {label: Other}
    files: {html: shell/screens/other.html, css: shell/screens/other.css, handlers: []}
`;

const screenHtml = (name) => `<section class="screen" data-screen="${name}"><h2>${name}</h2></section>`;

function boot({navigationAPI = true} = {}) {
  const {document} = parseHTML(
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

  let scrollPos = 0;
  globalThis.scrollTo = (_x, y) => (scrollPos = y);
  Object.defineProperty(globalThis, "scrollY", {get: () => scrollPos, configurable: true});

  const loc = {href: "http://localhost:8080/shell/", search: "", hash: ""};
  Object.defineProperty(globalThis, "location", {value: loc, configurable: true});

  sessionStorage.clear();
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.endsWith("shell.yaml")) return Promise.resolve(new Response(CONFIG_YAML));
    if (u.endsWith("home.html")) return Promise.resolve(new Response(screenHtml("home")));
    if (u.endsWith("other.html")) return Promise.resolve(new Response(screenHtml("other")));
    if (u.endsWith(".css")) return Promise.resolve(new Response(""));
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  };

  return {
    mount: document.getElementById("shell"),
    userScrollsTo: (y) => (scrollPos = y),
    interceptedWith: null,
    async goto(hash, navigationType = "push") {
      loc.hash = hash;
      if (!navigationAPI) {
        for (const fn of listeners.hashchange ?? []) await fn();
      } else {
        let handler;
        await onNavigate({
          canIntercept: true,
          downloadRequest: null,
          formData: null,
          navigationType,
          destination: {url: `http://localhost:8080/shell/${hash}`, sameDocument: true},
          intercept: (opts) => {
            this.interceptedWith = opts;
            handler = opts.handler;
          },
        });
        await handler?.();
      }
      await new Promise((r) => setTimeout(r, 80));
    },
  };
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

async function start(opts) {
  const app = boot(opts);
  const {createShell} = await import("./shell.js");
  await createShell({config: "./shell.yaml", mount: app.mount});
  await settle();
  return app;
}

Deno.test({
  name: "the stack owns scroll, so navigation is intercepted with scroll: manual",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start();
    await app.goto("#/other");
    // Left to the browser, a held screen already painted at the right offset
    // would be scrolled again underneath us.
    assert(
      app.interceptedWith?.scroll === "manual",
      `intercepted with ${JSON.stringify(app.interceptedWith?.scroll)}`,
    );
  },
});

Deno.test({
  name: "a screen arrived at starts at its top",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start();
    app.userScrollsTo(500);
    await app.goto("#/other");
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
    await app.goto("#/other");
    await app.goto("#/", "traverse");
    assert(scrollY === 500, `resumed at ${scrollY}, not 500`);
    assert(
      app.mount.querySelectorAll(".shell-screen").length === 2,
      "both screens should be held — the restore only means anything on live DOM",
    );
  },
});

// The distinction hashchange could never draw: a link back to a screen you
// have already seen is a new arrival, not a return.
Deno.test({
  name: "a link to an already-visited screen starts at its top",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start();
    app.userScrollsTo(500);
    await app.goto("#/other");
    await app.goto("#/", "push");
    assert(scrollY === 0, `a pushed link resumed at ${scrollY} instead of the top`);
  },
});

Deno.test({
  name: "without the Navigation API, hashchange still resumes on return",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await start({navigationAPI: false});
    app.userScrollsTo(500);
    await app.goto("#/other");
    await app.goto("#/");
    // It cannot tell a back from a link, and a back button that jumps to the
    // top is the worse half to be wrong on.
    assert(scrollY === 500, `fallback resumed at ${scrollY}, not 500`);
  },
});
