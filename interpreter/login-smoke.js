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
    nav: {label: Home, key: nav_home}
    files: {html: shell/screens/home.html, css: shell/screens/home.css, handlers: []}
`;

const CATALOGUE = {
  chrome_signin_hint: "Um toque com sua passkey.",
  chrome_signin: "Entrar",
  chrome_signin_guest: "Entrar como convidado",
  chrome_signin_failed: "Não deu certo. Tente de novo.",
  nav_home: "Início",
};

// The same gate offering a provider beside the passkey.
const PROVIDER_YAML = CONFIG_YAML.replace("  service: /auth\n", "  service: /auth\n  providers: [google]\n");

const SCREEN_HTML = `<section class="screen" data-screen="home"><h2>Home</h2></section>`;

// `cookie` is the jar the auth service left; `provider` answers its session
// exchange with a status, and the requests the boot made are in `asked`.
function boot({ config = CONFIG_YAML, catalogue = null, guestFails = false, cookie = "", provider = 200, expiredToken = null } = {}) {
  const { document, Event } = parseHTML(
    "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
  );
  globalThis.document = document;
  globalThis.window = globalThis;
  globalThis.addEventListener = () => {};
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.scrollTo = () => {};
  Object.defineProperty(globalThis, "scrollY", { get: () => 0, configurable: true });
  let jar = cookie;
  Object.defineProperty(document, "cookie", {
    get: () => jar,
    // Only clearing is ever written here, and only the hint.
    set: (value) => {
      if (!/^mecha_oidc_hint=; Path=\/; Max-Age=0$/.test(value)) throw new Error(`unexpected cookie write ${value}`);
      jar = jar.split(";").filter((c) => !c.trim().startsWith("mecha_oidc_hint=")).join(";");
    },
    configurable: true,
  });
  const asked = [];
  const reloads = [];
  Object.defineProperty(globalThis, "location", {
    value: { href: "http://localhost:8080/?page=2", pathname: "/", search: "?page=2", hash: "", reload: () => reloads.push(true) },
    configurable: true,
  });
  sessionStorage.clear();
  globalThis.fetch = (url, init) => {
    const u = String(url);
    asked.push(`${init?.method ?? "GET"} ${u}`);
    if (u.endsWith("/auth/oidc/session")) {
      if (provider !== 200) return Promise.resolve(new Response("{}", { status: provider }));
      return Promise.resolve(new Response(JSON.stringify({ token: "g", user: { id: "u-google", handle: "amber-fox-12" } })));
    }
    if (u.endsWith("/auth/oidc/signout")) return Promise.resolve(new Response(null, { status: 204 }));
    if (u.includes("/crud/app_user")) {
      if (expiredToken && init?.headers?.Authorization === `Bearer ${expiredToken}`) return Promise.resolve(new Response("{}", { status: 401 }));
      return Promise.resolve(new Response(JSON.stringify([{ id: "u-google" }])));
    }
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
  return { document, Event, mount: document.getElementById("shell"), asked, reloads, jar: () => jar };
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
    assert(form.getAttribute("aria-labelledby") === "shell-login-title", "the form is named by the app heading");
    assert(form.querySelector(".login-error").getAttribute("role") === "alert", "ceremony failures are announced");
    assert(mount.querySelector(".login-mark").getAttribute("aria-hidden") === "true", "the decorative mark is silent");
    assert(mount.querySelector("h1").textContent === "smoke", "app title shown");
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
    assert(form.getAttribute("aria-labelledby") === "shell-login-title", "the form is named by the app heading");
    assert(form.querySelector(".login-error").getAttribute("role") === "alert", "ceremony failures are announced");
    assert(mount.querySelector(".login-mark").getAttribute("aria-hidden") === "true", "the decorative mark is silent");
    // The gate is up before any route is mounted, so it resolves its own
    // language off the address — and its catalogue has to be in hand before the
    // auth branch runs, not after it beside the screens.
    assert(
      mount.querySelector(".login-hint").textContent === CATALOGUE.chrome_signin_hint,
      `the hint reads ${JSON.stringify(mount.querySelector(".login-hint").textContent)}`,
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

const check = (mount) => (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}\n${mount.innerHTML}`);
};

Deno.test({
  name: "a provider is a way in at the gate, a link that comes back to this address",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { mount, asked } = boot({ config: PROVIDER_YAML });
    const { createShell } = await import("./shell.js");
    createShell({ config: "./shell.yaml", mount });
    await settle();
    const assert = check(mount);
    const form = mount.querySelector(".shell-login form");
    assert(form, "login form rendered");
    assert(form.getAttribute("aria-labelledby") === "shell-login-title", "the form is named by the app heading");
    assert(form.querySelector(".login-error").getAttribute("role") === "alert", "ceremony failures are announced");
    assert(mount.querySelector(".login-mark").getAttribute("aria-hidden") === "true", "the decorative mark is silent");
    const google = form.querySelector(".login-provider");
    assert(form.querySelector(".login-actions").firstElementChild.matches(".login-provider"), "providers lead the action hierarchy");
    assert(google?.textContent === "Continue with Google", `the provider's word, got ${google?.textContent}`);
    assert(
      google.getAttribute("href") === "/auth/oidc/google/start?return=%2F%3Fpage%3D2",
      `the start, returning here, got ${google.getAttribute("href")}`,
    );
    // The passkey's gesture and the guest door are as they were.
    const labels = [...form.querySelectorAll("button")].map((b) => b.textContent);
    assert(labels.join("|") === "Continue|Continue as guest", `buttons unchanged, got ${labels}`);
    // No hint, so nothing was asked of the auth service.
    assert(!asked.some((a) => a.includes("/oidc/")), `asked ${asked}`);
  },
});

Deno.test({
  name: "a reader sent back by the provider is signed in without the gate, and signs out of the provider too",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { Event, mount, asked, reloads } = boot({ config: PROVIDER_YAML, cookie: "mecha_oidc_hint=google" });
    const { createShell } = await import("./shell.js");
    createShell({ config: "./shell.yaml", mount });
    await settle(200);
    const assert = check(mount);
    assert(!mount.querySelector(".shell-login"), "the gate stayed down");
    assert(mount.querySelector('[data-screen="home"]'), "the screen is up");
    assert(JSON.parse(sessionStorage.getItem("pronto-token")).user.id === "u-google", "the provider's session is the tab's");
    assert(asked.includes("POST /auth/oidc/session"), `asked ${asked}`);

    const out = document.querySelector(".shell-signout");
    assert(out, "a way out");
    out.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();
    // Without the provider's cookie cleared, the reload adopts the session again.
    assert(asked.indexOf("POST /auth/oidc/signout") > asked.indexOf("POST /auth/oidc/session"), `asked ${asked}`);
    assert(reloads.length === 1, "reloaded once");
    assert(sessionStorage.getItem("pronto-token") === null, "the tab's session forgotten");
  },
});

Deno.test({
  name: "a stale hint gates as before and is cleared, and a passkey's session is never traded",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    {
      const { mount, jar } = boot({ config: PROVIDER_YAML, cookie: "a=1; mecha_oidc_hint=google", provider: 401 });
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle();
      const assert = check(mount);
      assert(mount.querySelector(".shell-login form"), "the gate is up");
      assert(jar() === "a=1", `the hint cleared, the rest kept: ${jar()}`);
    }
    {
      const { mount, asked } = boot({ config: PROVIDER_YAML, cookie: "mecha_oidc_hint=google" });
      sessionStorage.setItem("pronto-token", JSON.stringify({ token: `p.${btoa(JSON.stringify({ sub: "u-passkey" }))}.s`, user: { id: "u-passkey", handle: "passkey-held" } }));
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(200);
      const assert = check(mount);
      assert(!asked.includes("POST /auth/oidc/session"), `asked ${asked}`);
      assert(JSON.parse(sessionStorage.getItem("pronto-token")).user.handle === "passkey-held", "the passkey's session stands");
    }
  },
});

Deno.test("a guest's strip offers each provider, its address written with the page", async () => {
  const { document } = parseHTML("<!doctype html><html><body><nav></nav></body></html>");
  const { guestBox, localizeStrip } = await import("./chrome.js");
  const cfg = { routes: [], auth: { service: "/auth", providers: ["google"] } };
  const nav = document.querySelector("nav");
  nav.append(guestBox(document, cfg));
  localizeStrip(nav, cfg, { here: "/chapter/8", messages: { "pt-BR": { chrome_signin_google: "Entrar com Google" } }, locale: "pt-BR" });
  const a = nav.querySelector(".shell-provider");
  if (a?.textContent !== "Entrar com Google") throw new Error(`smoke failed: the provider's word, got ${a?.textContent}`);
  if (a.getAttribute("href") !== "/auth/oidc/google/start?return=%2Fchapter%2F8") throw new Error(`smoke failed: got ${a.getAttribute("href")}`);
  // No passkey was offered, so none is drawn.
  if (nav.querySelector(".shell-signin")) throw new Error("smoke failed: a passkey nobody offered");
});

Deno.test({
  name: "a guest's strip passkey buttons are conditional to passkey support",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const origCred = globalThis.PublicKeyCredential;
    const PROMOTE_YAML = CONFIG_YAML.replace("  required: true\n", "  required: false\n  promote: true\n").replace("tables: []", "tables: [note]\nread: [note]");
    try {
      const { document: doc } = parseHTML("<!doctype html><html><body></body></html>");
      const { guestBox } = await import("./chrome.js");
      const box = guestBox(doc, { auth: { service: "/auth", promote: true } });
      if (!box.querySelector(".shell-signin") || !box.querySelector(".shell-register")) {
        throw new Error("expected guestBox to emit passkey buttons for SSG");
      }

      delete globalThis.PublicKeyCredential;
      const { document: doc1, mount: mount1 } = boot({ config: PROMOTE_YAML });
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount: mount1 });
      await settle(150);
      if (doc1.querySelector(".shell-signin") || doc1.querySelector(".shell-register")) {
        throw new Error("expected no passkey buttons in shell strip when PublicKeyCredential is not supported");
      }

      globalThis.PublicKeyCredential = class {};
      const { document: doc2, mount: mount2 } = boot({ config: PROMOTE_YAML });
      createShell({ config: "./shell.yaml", mount: mount2 });
      await settle(150);
      if (!doc2.querySelector(".shell-signin") || !doc2.querySelector(".shell-register")) {
        throw new Error("expected passkey buttons in shell strip when PublicKeyCredential is supported");
      }
    } finally {
      globalThis.PublicKeyCredential = origCred;
    }
  },
});

Deno.test({
  name: "a provider cookie renews an expired bearer before the first boot gates or mints a guest",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const token = `e.${btoa(JSON.stringify({ sub: "u-google", exp: 1 }))}.s`;
    for (const config of [PROVIDER_YAML, PROVIDER_YAML.replace("required: true", "required: false").replace("tables: []", "tables: [example]\nread: [example]")]) {
      const { mount, asked } = boot({ config, cookie: "mecha_oidc_hint=google", expiredToken: token });
      sessionStorage.setItem("pronto-token", JSON.stringify({ token, user: { id: "u-google" } }));
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(200);
      const assert = check(mount);
      assert(!mount.querySelector(".shell-login"), "the provider renews without a login gate");
      assert(mount.querySelector('[data-screen="home"]'), "the screen is up");
      assert(asked.includes("POST /auth/oidc/session"), `asked ${asked}`);
      assert(!asked.includes("POST /auth/guest"), `asked ${asked}`);
      assert(JSON.parse(sessionStorage.getItem("pronto-token")).token === "g", "the expired bearer was replaced");
    }
  },
});
