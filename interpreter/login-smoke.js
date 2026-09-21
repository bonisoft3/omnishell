// Deno smoke: the terminal-owned login screen gates the app before any store
// boots, and comes down once a session exists. The WebAuthn ceremony is not
// exercised — deno has no authenticator,
// and the ceremony belongs to the auth service's own tests; the guest door
// needs none, which is what makes the second case drivable here.
import { parseHTML } from "npm:linkedom@0.18.4";

const CONFIG_YAML = `
app: smoke
auth:
  required: true
  service: /auth
tables: []
routes:
  - path: /
    screen: home
    nav: {label: Home}
    files: {html: shell/screens/home.html, css: shell/screens/home.css, handlers: []}
`;

// The same app with a catalogue of its own: the gate is terminal chrome, so it
// is outside every screen's markup and only the catalogue can reach it.
const TRANSLATED_YAML = `
app: smoke
auth:
  required: true
  service: /auth
i18n:
  default: pt-BR
  locales:
    pt-BR: {path: pt-br}
tables: []
routes:
  - path: /
    screen: home
    nav: {label: Home, key: nav_home, labels: {pt-BR: Início}}
    files: {html: shell/screens/home.html, css: shell/screens/home.css, handlers: []}
`;

const CATALOGUE = {
  chrome_signin_hint: "Um toque com sua passkey.",
  chrome_signin: "Entrar",
  chrome_signin_guest: "Entrar como convidado",
  chrome_signin_failed: "Não deu certo. Tente de novo.",
  nav_home: "Início",
};

const SCREEN_HTML = `<section class="screen" data-screen="home"><h2>Home</h2></section>`;

function boot({ config = CONFIG_YAML, catalogue = null, guestFails = false } = {}) {
  const { document, Event } = parseHTML(
    "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
  );
  globalThis.document = document;
  globalThis.window = globalThis;
  globalThis.addEventListener = () => {};
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.scrollTo = () => {};
  Object.defineProperty(globalThis, "scrollY", { get: () => 0, configurable: true });
  Object.defineProperty(globalThis, "location", {
    value: { href: "http://localhost:8080/shell/", search: "", hash: "" },
    configurable: true,
  });
  sessionStorage.clear();
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.endsWith("shell.yaml")) return Promise.resolve(new Response(config));
    if (u.endsWith("/auth/guest")) {
      if (guestFails) return Promise.resolve(new Response("the door is bolted", { status: 500 }));
      return Promise.resolve(
        new Response(JSON.stringify({ token: "t", user: { id: "u1", handle: "sunlit-fox-01" } }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/messages/")) {
      if (catalogue === null) return Promise.resolve(new Response("{}", { status: 404 }));
      return Promise.resolve(new Response(JSON.stringify(catalogue)));
    }
    if (u.endsWith(".html")) return Promise.resolve(new Response(SCREEN_HTML));
    if (u.endsWith(".css")) return Promise.resolve(new Response(""));
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  };
  return { document, Event, mount: document.getElementById("shell") };
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

Deno.test({
  name: "createShell gates on the login screen when auth is required",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { mount } = boot();
    const { createShell } = await import("./shell.js");
    // Never awaited to completion: the login promise stays pending until a
    // ceremony succeeds, which this case deliberately does not drive.
    createShell({ config: "./shell.yaml", mount });
    await settle();

    const assert = (cond, msg) => {
      if (!cond) throw new Error(`smoke failed: ${msg}\n${mount.innerHTML}`);
    };
    const form = mount.querySelector(".shell-login form");
    assert(form, "login form rendered");
    assert(form.querySelector("h1").textContent === "smoke", "app title shown");
    // Usernameless one-gesture doctrine: a single Continue drives login with
    // registration as the fall-through, and the guest door is always beside it
    // (origin-independent by doctrine) — any other button set is a regression.
    // This app declares no catalogue, so the words are the terminal's own: what
    // it ships standalone, and what every app that never asked to be translated
    // keeps.
    const labels = [...form.querySelectorAll("button")].map((b) => b.textContent);
    assert(
      labels.length === 2 && labels[0] === "Continue" && labels[1] === "Continue as guest",
      `Continue + Continue as guest, got ${labels}`,
    );
    assert(sessionStorage.getItem("pronto-token") === null, "no session stored");
  },
});

Deno.test({
  name: "the gate speaks the app's language, not the terminal's",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { mount } = boot({ config: TRANSLATED_YAML, catalogue: CATALOGUE });
    const { createShell } = await import("./shell.js");
    createShell({ config: "./shell.yaml", mount });
    await settle();

    const assert = (cond, msg) => {
      if (!cond) throw new Error(`smoke failed: ${msg}\n${mount.innerHTML}`);
    };
    const form = mount.querySelector(".shell-login form");
    assert(form, "login form rendered");
    // The gate is up before any route is mounted, so it resolves its own
    // language off the address — and its catalogue has to be in hand before the
    // auth branch runs, not after it beside the screens.
    assert(
      form.querySelector(".login-hint").textContent === CATALOGUE.chrome_signin_hint,
      `the hint reads ${JSON.stringify(form.querySelector(".login-hint").textContent)}`,
    );
    const labels = [...form.querySelectorAll("button")].map((b) => b.textContent);
    assert(
      labels[0] === CATALOGUE.chrome_signin && labels[1] === CATALOGUE.chrome_signin_guest,
      `Entrar + Entrar como convidado, got ${labels}`,
    );
  },
});

Deno.test({
  name: "a door that will not open says so in the reader's language, and tells the console why",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { Event, mount } = boot({ config: TRANSLATED_YAML, catalogue: CATALOGUE, guestFails: true });
    const logged = [];
    const console_error = console.error;
    console.error = (e) => logged.push(e);
    try {
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle();
      mount.querySelector(".login-guest").dispatchEvent(new Event("click", { bubbles: true }));
      await settle(200);
    } finally {
      console.error = console_error;
    }

    const assert = (cond, msg) => {
      if (!cond) throw new Error(`smoke failed: ${msg}\n${mount.innerHTML}`);
    };
    const error = mount.querySelector(".login-error");
    assert(!error.hasAttribute("hidden"), "the failure is on screen");
    // What failed is an HTTP status and a server's sentence — the platform's
    // own language, about a ceremony the reader never asked to see the shape
    // of. Painting it inline is how English reaches a translated screen.
    assert(
      error.textContent === CATALOGUE.chrome_signin_failed,
      `the error reads ${JSON.stringify(error.textContent)}`,
    );
    assert(
      logged.some((e) => String(e?.message ?? e).includes("500")),
      `the detail never reached the console: ${JSON.stringify(logged.map(String))}`,
    );
  },
});

Deno.test({
  name: "the login screen comes down once a session exists",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { Event, mount } = boot();
    const { createShell } = await import("./shell.js");
    createShell({ config: "./shell.yaml", mount });
    await settle();

    const guest = [...mount.querySelectorAll(".shell-login button")].find(
      (b) => b.textContent === "Continue as guest",
    );
    if (!guest) throw new Error("smoke failed: no guest button");
    guest.dispatchEvent(new Event("click", { bubbles: true }));
    await settle(200);

    // The navigation stack appends its screens beside whatever is already
    // mounted rather than replacing it, so the gate has to take its own chrome
    // down. Left alone, the form outlives the sign-in it gated and sits above
    // every screen for the rest of the session.
    if (mount.querySelector(".shell-login")) {
      throw new Error(`smoke failed: login screen outlived the session\n${mount.innerHTML}`);
    }
    // A boot failure also empties the mount (the banner replaces its
    // children), so an absent form proves nothing on its own: the screen the
    // gate was guarding has to be the thing standing in its place.
    if (!mount.querySelector('[data-screen="home"]')) {
      throw new Error(`smoke failed: no screen behind the gate\n${mount.innerHTML}`);
    }
    if (sessionStorage.getItem("pronto-token") === null) {
      throw new Error("smoke failed: session not stored");
    }
  },
});
