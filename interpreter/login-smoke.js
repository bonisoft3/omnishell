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
  chrome_signin: "Continuar com este aparelho",
  chrome_signin_guest: "Entrar como convidado",
  chrome_signin_failed: "Não deu certo. Tente de novo.",
  nav_home: "Início",
};

// The same gate offering a provider beside the passkey.
const PROVIDER_YAML = CONFIG_YAML.replace("  service: /auth\n", "  service: /auth\n  providers: [google]\n");

const SCREEN_HTML = `<section class="screen" data-screen="home"><h2>Home</h2></section>`;

// `cookie` is the jar the auth service left; `provider` answers its session
// exchange with a status, and the requests the boot made are in `asked`.
// An account signed in by its one passkey, long enough ago that changing its
// ways needs a sign-in first, and not asked to set up recovery.
const ONE_WAY = { ways: [{ kind: "passkey", id: "c1", added: null, current: true }], recent: false, recovery: false };

function boot({ config = CONFIG_YAML, catalogue = null, guestFails = false, cookie = "", provider = 200, expiredToken = null, ways = () => ONE_WAY } = {}) {
  const { document, Event } = parseHTML(
    "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
  );
  globalThis.document = document;
  globalThis.window = globalThis;
  // These are independent pages, not outbox peers; native Deno channels make
  // their stores wait for a cross-tab election before session teardown.
  globalThis.BroadcastChannel = undefined;
  globalThis.addEventListener = () => {};
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.scrollTo = () => {};
  Object.defineProperty(globalThis, "scrollY", { get: () => 0, configurable: true });
  let jar = cookie;
  Object.defineProperty(document, "cookie", {
    get: () => jar,
    // Only clearing is ever written here, and only the hint.
    set: (value) => {
      if (!/^mecha_session_hint=; Path=\/; Max-Age=0$/.test(value)) throw new Error(`unexpected cookie write ${value}`);
      jar = jar.split(";").filter((c) => !c.trim().startsWith("mecha_session_hint=")).join(";");
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
  localStorage.clear();
  localStorage.clear();
  globalThis.fetch = (url, init) => {
    const u = String(url);
    asked.push(`${init?.method ?? "GET"} ${u}`);
    if (u.endsWith("/auth/session")) {
      if (provider !== 200) return Promise.resolve(new Response("{}", { status: provider }));
      return Promise.resolve(new Response(JSON.stringify({ token: "g", user: { id: "u-google", handle: "amber-fox-12" } })));
    }
    if (u.endsWith("/auth/signout")) return Promise.resolve(new Response(null, { status: 204 }));
    if (u.includes("/auth/ways")) return Promise.resolve(Response.json(ways(u)));
    if (u.includes("/crud/app_user")) {
      if (expiredToken && init?.headers?.Authorization === `Bearer ${expiredToken}`) return Promise.resolve(new Response("{}", { status: 401 }));
      return Promise.resolve(new Response(JSON.stringify([{ id: "u-google" }])));
    }
    if (u.endsWith("shell.yaml")) return Promise.resolve(new Response(config));
    // The device takes up the guest minted ahead of it, and lets a session go.
    if (u.endsWith("/auth/session/adopt") || u.endsWith("/auth/signout")) return Promise.resolve(new Response(null, { status: 204 }));
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
    if (u.endsWith("/auth/oidc")) return Promise.resolve(Response.json({ providers: ["google", "apple"] }));
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
    // One way in, the device, which makes the account where nothing is saved,
    // and the guest door beside it (origin-independent by doctrine). This app
    // declares no catalogue, so the words are the terminal's own: what it
    // ships standalone, and what every app that never asked to be translated
    // keeps.
    const labels = [...form.querySelectorAll(".login-actions button")].map((b) => b.textContent);
    assert(labels.join("|") === "Continue with this device|Continue as guest", `device, guest; got ${labels}`);
    assert(localStorage.getItem("pronto-token") === null, "no session stored");
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
    const labels = [...form.querySelectorAll(".login-actions button")].map((b) => b.textContent);
    assert(
      labels.join("|") === [CATALOGUE.chrome_signin, CATALOGUE.chrome_signin_guest].join("|"),
      `the catalogue's words, got ${labels}`,
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
    const error = mount.querySelector(".login-error-text");
    assert(!mount.querySelector(".login-error").hasAttribute("hidden"), "the failure is on screen");
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
    if (localStorage.getItem("pronto-token") === null) {
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
    const labels = [...form.querySelectorAll(".login-actions button")].map((b) => b.textContent);
    assert(labels.join("|") === "Continue with this device|Continue as guest", `buttons unchanged, got ${labels}`);
    // No hint, so nothing was asked of the auth service.
    assert(!asked.some((a) => a.includes("/oidc/")), `asked ${asked}`);
  },
});

Deno.test({
  name: "a reader sent back by the provider is signed in without the gate, and signs out of the provider too",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { Event, mount, asked, reloads } = boot({ config: PROVIDER_YAML, cookie: "mecha_session_hint=1" });
    const { createShell } = await import("./shell.js");
    createShell({ config: "./shell.yaml", mount });
    await settle(200);
    const assert = check(mount);
    assert(!mount.querySelector(".shell-login"), "the gate stayed down");
    assert(mount.querySelector('[data-screen="home"]'), "the screen is up");
    assert(JSON.parse(localStorage.getItem("pronto-token")).user.id === "u-google", "the provider's session is the tab's");
    assert(asked.includes("POST /auth/session"), `asked ${asked}`);

    const out = document.querySelector(".shell-signout");
    assert(out, "a way out");
    out.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();
    // Without the provider's cookie cleared, the reload adopts the session again.
    assert(asked.indexOf("POST /auth/signout") > asked.indexOf("POST /auth/session"), `asked ${asked}`);
    assert(reloads.length === 1, "reloaded once");
    assert(localStorage.getItem("pronto-token") === null, "the tab's session forgotten");
  },
});

Deno.test({
  name: "signing out forgets the account in place: no reload, the screens drawn again for a new guest, the nav a visitor's",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { document: doc, Event, mount, asked, reloads } = boot({ config: GUEST_YAML, cookie: "mecha_session_hint=1" });
    localStorage.setItem("pronto-token", JSON.stringify({ token: "tok-ada", user: { id: "u7", handle: "Ada-1a2b" }, passkey: { rpId: "localhost", userId: "dTc" } }));
    sessionStorage.setItem("pronto-release-recovery", JSON.stringify({ owner: '["subject","u7"]', screens: { home: {} } }));
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      const u = String(url);
      if (u.endsWith("/auth/signout")) {
        asked.push("POST /auth/signout");
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (u.endsWith("/auth/guest")) {
        asked.push("POST /auth/guest");
        return Promise.resolve(Response.json({ token: "tok-next", user: { id: "u8", handle: "pear-otter-0c1d", guest: true } }));
      }
      return prevFetch(url, init);
    };
    const { createShell } = await import("./shell.js");
    createShell({ config: "./shell.yaml", mount });
    await settle(200);
    const assert = check(mount);
    const before = mount.querySelector('[data-screen="home"]');
    assert(before && doc.body.dataset.auth === "user", "a person's screen is up");
    doc.querySelector("nav .shell-person").dispatchEvent(new Event("click", { bubbles: true }));
    doc.querySelector("nav .shell-signout").dispatchEvent(new Event("click", { bubbles: true }));
    await settle(200);
    assert(asked.includes("POST /auth/signout"), `the device's cookie is cleared, asked ${asked}`);
    assert(reloads.length === 0, "nothing reloads");
    // The screen the person saw is gone, and the address drawn again.
    const after = mount.querySelector('[data-screen="home"]');
    assert(after && after !== before && !before.isConnected, "the screen is drawn again, not kept");
    assert(sessionStorage.getItem("pronto-release-recovery") === null, "the person's drafts are not the visitor's");
    assert(JSON.parse(localStorage.getItem("pronto-token")).token === "tok-next", "the next guest is the device's");
    assert(doc.body.dataset.auth !== "user", `the page is a visitor's, got ${doc.body.dataset.auth}`);
    assert(!doc.querySelector("nav .shell-person") && doc.querySelector("nav .shell-signin"), "the nav offers Sign in");
  },
});

Deno.test({
  name: "a stale hint gates as before and is cleared, and a passkey's session is never traded",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    {
      const { mount, jar } = boot({ config: PROVIDER_YAML, cookie: "a=1; mecha_session_hint=1", provider: 401 });
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle();
      const assert = check(mount);
      assert(mount.querySelector(".shell-login form"), "the gate is up");
      assert(jar() === "a=1", `the hint cleared, the rest kept: ${jar()}`);
    }
    {
      const { mount, asked } = boot({ config: PROVIDER_YAML, cookie: "mecha_session_hint=1" });
      localStorage.setItem("pronto-token", JSON.stringify({ token: `p.${btoa(JSON.stringify({ sub: "u-passkey" }))}.s`, user: { id: "u-passkey", handle: "passkey-held" } }));
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(200);
      const assert = check(mount);
      assert(!asked.includes("POST /auth/session"), `asked ${asked}`);
      assert(JSON.parse(localStorage.getItem("pronto-token")).user.handle === "passkey-held", "the passkey's session stands");
    }
  },
});

Deno.test("the nav's Sign in opens one panel in place: each provider, then Passkey, each provider's address written with the page", async () => {
  const { document } = parseHTML("<!doctype html><html><body><nav></nav></body></html>");
  const { signinBox, localizeStrip } = await import("./chrome.js");
  const cfg = { routes: [], auth: { service: "/auth", providers: ["google"] } };
  const nav = document.querySelector("nav");
  nav.append(signinBox(document, cfg));
  localizeStrip(nav, cfg, { here: "/chapter/8", messages: { "pt-BR": { chrome_signin_google: "Entrar com Google" } }, locale: "pt-BR" });
  const open = nav.querySelector(":scope > .shell-me > .shell-signin");
  if (open?.getAttribute("aria-expanded") !== "false") throw new Error("smoke failed: Sign in is a closed disclosure");
  const panel = nav.querySelector(`#${open.getAttribute("aria-controls")}`);
  if (!panel?.hasAttribute("hidden")) throw new Error("smoke failed: the panel waits for Sign in");
  const ways = [...panel.querySelectorAll(".shell-signin-ways > *")].map((el) => `${el.getAttribute("aria-label") ?? ""}:${el.textContent}`);
  if (ways.join("|") !== "Entrar com Google:GGoogle|:Passkey") throw new Error(`smoke failed: the provider first, then Passkey, got ${ways}`);
  const said = panel.querySelector(".shell-signin-with").textContent;
  if (said !== "Continue with") throw new Error(`smoke failed: one "Continue with" over every way, got ${said}`);
  const a = panel.querySelector(".shell-provider");
  if (a.getAttribute("href") !== "/auth/oidc/google/start?return=%2Fchapter%2F8") throw new Error(`smoke failed: got ${a.getAttribute("href")}`);
  const device = panel.querySelector('[data-auth-action="accounts"]');
  if (!device?.hasAttribute("hidden")) throw new Error("smoke failed: My device waits to learn the browser has passkeys");
  if (panel.querySelector('[data-auth-action="signout"]')) throw new Error("smoke failed: a visitor has nothing to sign out of");
});

const GUEST_YAML = CONFIG_YAML
  .replace("  required: true\n", "  required: false\n")
  .replace("tables: []", "tables: [note]\nread: [note]");

Deno.test({
  name: "the nav's My device is offered wherever the browser has passkeys",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const origCred = globalThis.PublicKeyCredential;
    try {
      const { createShell } = await import("./shell.js");
      // No passkeys and no provider: nothing to offer, so not even Sign in.
      delete globalThis.PublicKeyCredential;
      const { document: doc, mount } = boot({ config: GUEST_YAML });
      createShell({ config: "./shell.yaml", mount });
      await settle(150);
      if (doc.querySelector("nav .shell-signin:not([hidden]), nav .shell-passkey:not([hidden])")) {
        throw new Error(`smoke failed: a way in the browser cannot take\n${doc.querySelector("nav")?.outerHTML}`);
      }

      // Passkeys through the browser's dialog, never asked alone: My device
      // opens onto accounts, and asks the browser only once one is chosen.
      for (const cred of [class {}, class { static getClientCapabilities() { return Promise.resolve({ immediateGet: false }); } }]) {
        globalThis.PublicKeyCredential = cred;
        const { document: doc2, mount: mount2 } = boot({ config: GUEST_YAML });
        createShell({ config: "./shell.yaml", mount: mount2 });
        await settle(150);
        if (!doc2.querySelector('nav .shell-signin:not([hidden])') || !doc2.querySelector('nav .shell-passkey[data-auth-action="accounts"]:not([hidden])')) {
          throw new Error(`smoke failed: My device where the browser has passkeys\n${doc2.querySelector("nav")?.outerHTML}`);
        }
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
      const { mount, asked } = boot({ config, cookie: "mecha_session_hint=1", expiredToken: token });
      localStorage.setItem("pronto-token", JSON.stringify({ token, user: { id: "u-google" } }));
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(200);
      const assert = check(mount);
      assert(!mount.querySelector(".shell-login"), "the provider renews without a login gate");
      assert(mount.querySelector('[data-screen="home"]'), "the screen is up");
      assert(asked.includes("POST /auth/session"), `asked ${asked}`);
      assert(!asked.includes("POST /auth/guest"), `asked ${asked}`);
      assert(JSON.parse(localStorage.getItem("pronto-token")).token === "g", "the expired bearer was replaced");
    }
  },
});

Deno.test({
  name: "a kept guest is \"Guest\" on this device, never its generated handle, and its panel offers to keep it and a quiet way out, opening and closing in place",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const origCred = globalThis.PublicKeyCredential;
    globalThis.PublicKeyCredential = class {};
    const AUTH_YAML = GUEST_YAML.replace("  required: false\n", "  required: false\n  providers: [google]\n");
    const SCREEN = `<section class="screen" data-screen="home">
      <strong class="status-name" data-auth-field="handle">Not signed in</strong>
      <button type="button" id="btn-auth-google" data-auth-provider="google">Google</button>
    </section>`;
    try {
      const { document: doc, Event, mount } = boot({ config: AUTH_YAML });
      // A guest who has written something: the posture a guest reaches.
      localStorage.setItem("pronto-token", JSON.stringify({ token: "t", user: { id: "u1", handle: "sunlit-fox-3fa2", guest: true }, committed: true }));
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => String(url).endsWith(".html") ? Promise.resolve(new Response(SCREEN)) : prevFetch(url, init);
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(200);
      const assert = check(mount);

      assert(doc.body.dataset.auth === "guest", `expected guest, got ${doc.body.dataset.auth}`);
      assert(!doc.querySelector("nav .shell-person"), "a guest is no person");
      assert(!doc.querySelector("nav .shell-signout"), "a guest's way out is in its panel, not the person's");
      assert(mount.querySelector('[data-auth-field="handle"]')?.textContent === "sunlit-fox-3fa2", "the app's own field still names the guest");

      const open = doc.querySelector("nav .shell-me > .shell-signin.shell-guest");
      const panel = doc.querySelector("nav .shell-signin-panel");
      assert(open?.querySelector(".handle")?.textContent === "Guest" && !open.textContent.includes("sunlit"), `the guest sees itself as Guest, never its handle, got ${open?.textContent}`);
      assert(open.querySelector(".shell-chip-label")?.textContent === "This device" && panel.hidden, "one closed chip, on this device");
      open.dispatchEvent(new Event("click", { bubbles: true }));
      assert(open.getAttribute("aria-expanded") === "true" && !panel.hidden, "the chip opens its panel in place");
      const out = panel.querySelector('.shell-guest-signout[data-auth-action="signout"]');
      assert(out?.textContent === "sign out" && out.getAttribute("title") === "Its work can't be recovered", `a quiet way out that says what it costs, got ${out?.textContent} / ${out?.getAttribute("title")}`);
      assert(panel.querySelector(".shell-provider"), "the guest is offered the visitor's ways in");
      assert(panel.querySelector(".shell-signin-title")?.textContent === "Signed in as guest" && panel.querySelector(".shell-signin-with")?.textContent === "Keep it with", `the panel is about keeping the guest, got ${panel.querySelector(".shell-signin-title")?.textContent} / ${panel.querySelector(".shell-signin-with")?.textContent}`);
      assert(!panel.querySelector('[data-auth-action="rename"]'), "only a person renames");
      const esc = new Event("keydown", { bubbles: true });
      esc.key = "Escape";
      panel.querySelector(".shell-provider").dispatchEvent(esc);
      assert(open.getAttribute("aria-expanded") === "false" && panel.hidden, "Escape closes it");
      open.dispatchEvent(new Event("click", { bubbles: true }));
      panel.querySelector(".shell-signin-close").dispatchEvent(new Event("click", { bubbles: true }));
      assert(open.getAttribute("aria-expanded") === "false" && panel.hidden, "so does its close button");

      // A kept guest leaves for the provider with its token as id_token_hint,
      // posted, so the token is in no address. Regression: posted by a form,
      // the start's redirect to the provider was one the page's CSP
      // (form-action 'self') refused, so the page fetches it and goes itself.
      const posted = [];
      const priorFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => {
        if (String(url).endsWith("/auth/oidc/google/start")) {
          posted.push({ url: String(url), init });
          return Promise.resolve(Response.json({ to: "https://provider.test/authorize?state=s" }));
        }
        return priorFetch(url, init);
      };
      mount.querySelector("#btn-auth-google").dispatchEvent(new Event("click", { bubbles: true }));
      await settle(30);
      globalThis.fetch = priorFetch;
      const sent = posted[0];
      assert(sent?.init?.method === "POST" && sent.init.headers.accept === "application/json", `a POST to the start, got ${sent?.init?.method} ${sent?.url}`);
      const fields = Object.fromEntries(new URLSearchParams(String(sent.init.body)));
      assert(fields.id_token_hint === "t" && fields.return === "/?page=2", `the guest's token and the way back, got ${JSON.stringify(fields)}`);
      assert(!sent.url.includes("id_token_hint"), `the token went in no address, got ${sent.url}`);
      assert(String(globalThis.location.href) === "https://provider.test/authorize?state=s", `the page goes where the start answers, got ${globalThis.location.href}`);
    } finally {
      globalThis.PublicKeyCredential = origCred;
    }
  },
});

Deno.test({
  name: "the device is one way in: where nothing is saved it makes the account there, the guest's, and a dismissal makes nothing",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const origCred = globalThis.PublicKeyCredential;
    const origNavCreds = globalThis.navigator?.credentials;
    const signaled = [];
    const createdOptions = [];
    const askedWith = [];
    let immediate = false;
    globalThis.PublicKeyCredential = class {
      static getClientCapabilities() {
        return Promise.resolve({ immediateGet: immediate });
      }
      static signalUnknownCredential(opts) {
        signaled.push(["unknown", opts]);
        return Promise.resolve();
      }
      static signalAllAcceptedCredentials(opts) {
        signaled.push(["accepted", opts]);
        return Promise.resolve();
      }
      static signalCurrentUserDetails(opts) {
        signaled.push(["details", opts]);
        return Promise.resolve();
      }
    };
    const b64u = (str) => btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const credIdDead = b64u("dead-cred");
    const credIdLive = b64u("live-cred");
    let getBehavior = "dead";
    Object.defineProperty(globalThis.navigator, "credentials", {
      value: {
        get: async (opts) => {
          askedWith.push(opts.uiMode ?? "default");
          if (getBehavior === "none") {
            const err = new Error("nothing saved here");
            err.name = "NotAllowedError";
            throw err;
          }
          return {
            id: credIdDead,
            rawId: new Uint8Array([1, 2, 3]).buffer,
            type: "public-key",
            getClientExtensionResults: () => ({}),
            response: {
              clientDataJSON: new Uint8Array([4]).buffer,
              authenticatorData: new Uint8Array([5]).buffer,
              signature: new Uint8Array([6]).buffer,
            },
          };
        },
        create: async (opts) => {
          createdOptions.push(opts);
          return {
            id: credIdLive,
            rawId: new Uint8Array([7, 8, 9]).buffer,
            type: "public-key",
            getClientExtensionResults: () => ({}),
            response: {
              clientDataJSON: new Uint8Array([10]).buffer,
              attestationObject: new Uint8Array([11]).buffer,
              getTransports: () => ["internal"],
            },
          };
        },
      },
      configurable: true,
    });
    // An app's own sign-in, beside nothing else.
    const SCREEN = `<section class="screen" data-screen="home">
      <p class="keep"><button type="button" id="keep" data-auth-action="device">Sign in</button></p>
    </section>`;
    try {
      const { document: doc, Event, mount, asked } = boot({ config: GUEST_YAML });
      const tokens = [];
      const namedAs = [];
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => {
        const u = String(url);
        if (u.endsWith(".html")) return Promise.resolve(new Response(SCREEN));
        if (u.endsWith("/auth/guest")) {
          return Promise.resolve(new Response(JSON.stringify({ token: "tok-guest", user: { id: "u1", handle: "amber-fox-01", guest: true } })));
        }
        if (u.endsWith("/auth/login/start")) {
          asked.push("POST /auth/login/start");
          return Promise.resolve(new Response(JSON.stringify({ state: "st-login", rpId: "localhost", challenge: b64u("chal-login") })));
        }
        if (u.endsWith("/auth/login/verify")) {
          asked.push("POST /auth/login/verify");
          if (getBehavior === "expired-state") return Promise.resolve(Response.json({ error: "invalid state" }, { status: 401 }));
          return Promise.resolve(Response.json({ error: "authentication verification failed", unknownCredential: true }, { status: 401 }));
        }
        if (u.endsWith("/auth/register/start")) {
          asked.push("POST /auth/register/start");
          tokens.push(init.headers.Authorization);
          namedAs.push(JSON.parse(init.body).name);
          return Promise.resolve(new Response(JSON.stringify({
            state: "st-reg",
            rp: { id: "localhost", name: "localhost" },
            challenge: b64u("chal-reg"),
            user: { id: b64u("u1"), name: "amber-fox-01", displayName: "amber-fox-01" },
            excludeCredentials: [],
          })));
        }
        if (u.endsWith("/auth/register/verify")) {
          asked.push("POST /auth/register/verify");
          return Promise.resolve(new Response(JSON.stringify({
            token: "tok-passkey",
            user: { id: "u1", handle: "amber-fox-01" },
            passkey: { rpId: "localhost", userId: b64u("u1") },
          })));
        }
        return prevFetch(url, init);
      };
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(200);
      const assert = check(mount);
      assert(!doc.querySelector("nav .shell-passkey")?.hidden, "a browser with passkeys offers My device in the nav");
      const keep = mount.querySelector("#keep");

      // 1. An expired challenge is no empty device: no signal, nothing made.
      getBehavior = "expired-state";
      keep.dispatchEvent(new Event("click", { bubbles: true }));
      await settle(100);
      assert(signaled.length === 0, `signalled on an expired state: ${JSON.stringify(signaled)}`);
      assert(mount.querySelector(".keep > .shell-auth-feedback[role=alert] .shell-auth-error")?.textContent === "Sign-in did not go through", "a plain failure is said beside the control");
      assert(!asked.includes("POST /auth/register/start"), `an expired challenge started a registration: ${asked}`);

      // 2. Asked as usual, a refusal is the reader's dismissal, which says
      // nothing about the device: nothing is made.
      getBehavior = "none";
      keep.dispatchEvent(new Event("click", { bubbles: true }));
      await settle(100);
      assert(askedWith.join() === "default,default", `a browser without immediate mode asks as usual, got ${askedWith}`);
      assert(!asked.includes("POST /auth/register/start"), `a dismissal started a registration: ${asked}`);
      assert(createdOptions.length === 0, "nothing created on a dismissal");

      // 3. The device answers with a passkey the server no longer holds: the
      // device is told to drop it, and holding nothing of this app's, a name
      // is asked beside the control; Back returns to it, and nothing is made
      // until Continue.
      getBehavior = "dead";
      keep.dispatchEvent(new Event("click", { bubbles: true }));
      await settle(200);
      assert(signaled.some(([kind, o]) => kind === "unknown" && o.credentialId === credIdDead),
        `expected signalUnknownCredential for the dead credential, got ${JSON.stringify(signaled)}`);
      let named = mount.querySelector(".keep > .shell-name-form");
      const input = named?.querySelector('input[autocomplete="given-name"]');
      assert(input && named.querySelector(".shell-name-label")?.textContent === "What should we call you?", "the name is asked");
      assert(createdOptions.length === 0, "nothing is made before the name");
      named.querySelector(".shell-name-back").dispatchEvent(new Event("click", { bubbles: true }));
      assert(!mount.querySelector(".shell-name-form"), "Back returns to the way in");
      keep.dispatchEvent(new Event("click", { bubbles: true }));
      await settle(200);
      named = mount.querySelector(".keep > .shell-name-form");
      named.querySelector("input").value = "  Ada ";
      named.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle(200);
      // The account is made there under that name — the guest's, which keeps
      // its identity — and the nav turns to the person in place.
      assert(createdOptions.length === 1, "navigator.credentials.create ran once");
      assert(JSON.stringify(createdOptions[0].publicKey.hints) === '["client-device"]', `the browser is asked to lead with this device, got ${JSON.stringify(createdOptions[0].publicKey.hints)}`);
      assert(namedAs.join() === "Ada", `the name made with the passkey, got ${namedAs}`);
      assert(tokens.at(-1) === "Bearer tok-guest", `the guest's token asks for the passkey, got ${tokens.at(-1)}`);
      // The device is told the name, never which passkeys still sign in: no
      // list held here is current once another tab may have added one.
      assert(signaled.some(([kind, o]) => kind === "details" && o.userId === b64u("u1") && o.name === "amber fox 01"), `signalCurrentUserDetails, got ${JSON.stringify(signaled)}`);
      assert(!signaled.some(([kind]) => kind === "accepted"), `a list of passkeys was signalled: ${JSON.stringify(signaled)}`);
      assert(doc.body.dataset.auth === "user", `the guest is a person now, got ${doc.body.dataset.auth}`);
      assert(doc.querySelector("nav .shell-signout"), "a person can sign out");
      assert(!doc.querySelector("nav .shell-signin"), "and has no Sign in");
      const kept = JSON.parse(localStorage.getItem("pronto-device-accounts"));
      assert(JSON.stringify(kept) === JSON.stringify([{ id: "u1", handle: "amber-fox-01", credential: credIdLive }]), `the account is among the device's, by its passkey, got ${JSON.stringify(kept)}`);
    } finally {
      globalThis.PublicKeyCredential = origCred;
      if (origNavCreds !== undefined) {
        Object.defineProperty(globalThis.navigator, "credentials", { value: origNavCreds, configurable: true });
      }
    }
  },
});

Deno.test({
  name: "where the browser can, the device is asked alone with a challenge already in hand, and one with nothing saved asks the name to make the account under",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const origCred = globalThis.PublicKeyCredential;
    const origNavCreds = globalThis.navigator?.credentials;
    const askedWith = [];
    const created = [];
    globalThis.PublicKeyCredential = class {
      static getClientCapabilities() {
        return Promise.resolve({ immediateGet: true });
      }
      static signalCurrentUserDetails() {
        return Promise.resolve();
      }
    };
    Object.defineProperty(globalThis.navigator, "credentials", {
      value: {
        get: async (opts) => {
          askedWith.push(opts.uiMode ?? "default");
          throw Object.assign(new Error("nothing saved here"), { name: "NotAllowedError" });
        },
        create: async (opts) => {
          created.push(opts);
          return {
            id: "bmV3",
            rawId: new Uint8Array([7]).buffer,
            type: "public-key",
            getClientExtensionResults: () => ({}),
            response: { clientDataJSON: new Uint8Array([1]).buffer, attestationObject: new Uint8Array([2]).buffer, getTransports: () => ["internal"] },
          };
        },
      },
      configurable: true,
    });
    const SCREEN = `<section class="screen" data-screen="home">
      <p class="keep"><button type="button" id="keep" data-auth-action="device">Sign in</button></p>
    </section>`;
    try {
      const { document: doc, Event, mount } = boot({ config: GUEST_YAML });
      const prevFetch = globalThis.fetch;
      const registeredWith = [];
      let mint;
      globalThis.fetch = (url, init) => {
        if (String(url).endsWith(".html")) return Promise.resolve(new Response(SCREEN));
        // A slow network: the challenge takes longer than a click's activation
        // lasts here.
        if (String(url).endsWith("/auth/login/start")) {
          return new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({ state: "st", rpId: "localhost", challenge: "Y2hhbA" }))), 300));
        }
        // A guest mint that has not answered yet.
        if (String(url).endsWith("/auth/guest")) return new Promise((resolve) => (mint = resolve));
        if (String(url).endsWith("/auth/register/start")) {
          registeredWith.push(`${init.headers.Authorization} ${JSON.parse(init.body).name}`);
          return Promise.resolve(Response.json({ state: "st-reg", rp: { id: "localhost", name: "localhost" }, challenge: "Y2hhbA", user: { id: "dTE", name: "sunlit-fox-01", displayName: "sunlit-fox-01" } }));
        }
        if (String(url).endsWith("/auth/register/verify")) {
          return Promise.resolve(Response.json({ token: "tok-made", user: { id: "u1", handle: "sunlit-fox-01" }, passkey: { rpId: "localhost", userId: "dTE" } }));
        }
        return prevFetch(url, init);
      };
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(500);
      const assert = check(mount);
      mount.querySelector("#keep").dispatchEvent(new Event("click", { bubbles: true }));
      await settle(30);
      // Regression: a sign-in once waited for the guest's mint, and then for
      // its challenge, before asking the device, spending the click's
      // activation immediate mode needs live.
      assert(askedWith.join() === "immediate", `the device asked alone at once, without waiting on a guest or a challenge, got ${askedWith}`);
      assert(created.length === 0, "nothing is made before the guest it is made for");
      // Asked alone, the device's refusal is its emptiness: the name is asked
      // beside the way in, and no phone is offered.
      const named = mount.querySelector(".keep > .shell-name-form");
      assert(named, "the name is asked beside the way in");
      mint(Response.json({ token: "tok-guest", user: { id: "u1", handle: "sunlit-fox-01", guest: true } }));
      await settle(50);
      named.querySelector("input").value = "Ada";
      named.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle(200);
      // Continue makes the account there, for the guest, under the name.
      assert(created.length === 1, `the device made the account, got ${created.length}`);
      assert(registeredWith.join() === "Bearer tok-guest Ada", `for the guest, named, got ${registeredWith}`);
      assert(!doc.querySelector("nav .shell-auth-choice"), "no choice is offered on an empty device");
      assert(doc.body.dataset.auth === "user", `the guest is a person now, got ${doc.body.dataset.auth}`);
    } finally {
      globalThis.PublicKeyCredential = origCred;
      if (origNavCreds !== undefined) {
        Object.defineProperty(globalThis.navigator, "credentials", { value: origNavCreds, configurable: true });
      }
    }
  },
});

Deno.test({
  name: "a kept guest's passkey sign-in into another account offers that account or the guest, and switches only when asked",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const origCred = globalThis.PublicKeyCredential;
    const origNavCreds = globalThis.navigator?.credentials;
    globalThis.PublicKeyCredential = class {
      static getClientCapabilities() {
        return Promise.resolve({ immediateGet: true });
      }
      static isConditionalMediationAvailable() {
        return Promise.resolve(true);
      }
      static signalCurrentUserDetails() {
        return Promise.resolve();
      }
    };
    const browser = passkeyBrowser();
    Object.defineProperty(globalThis.navigator, "credentials", { value: browser.credentials, configurable: true });
    try {
      const { document: doc, Event, mount, reloads } = boot({ config: GUEST_YAML });
      localStorage.setItem("pronto-token", JSON.stringify({ token: "tok-guest", user: { id: "u1", handle: "sunlit-fox-3fa2", guest: true }, committed: true }));
      const prevFetch = globalThis.fetch;
      const verifiedWith = [];
      const held = [];
      const owner = { id: "u9", handle: "amber-otter-77aa" };
      globalThis.fetch = (url, init) => {
        const u = String(url);
        if (u.endsWith("/auth/login/start")) return Promise.resolve(Response.json({ state: "st", rpId: "localhost", challenge: "Y2hhbA" }));
        if (u.endsWith("/auth/login/verify")) {
          verifiedWith.push(init.headers.Authorization);
          // The account is held in the device's cookie, not handed over.
          return Promise.resolve(Response.json({ error: "login_required", user: { handle: owner.handle } }, { status: 409 }));
        }
        if (u.endsWith("/auth/session/stay")) {
          held.push("stay");
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (u.endsWith("/auth/session/switch")) {
          held.push("switch");
          return Promise.resolve(Response.json({ token: "tok-owner", user: owner }));
        }
        if (u.includes("/crud/app_user")) return Promise.resolve(Response.json([{ id: "u1" }]));
        return prevFetch(url, init);
      };
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(300);
      const assert = check(mount);
      // The reader picks the passkey in the field's autofill.
      const ask = async () => {
        if (!doc.querySelector("nav .shell-accounts")) doc.querySelector("nav .shell-passkey").dispatchEvent(new Event("click", { bubbles: true }));
        await settle(60);
        browser.pick("b3du");
        await settle(100);
        return doc.querySelector("nav .shell-signin-panel > .shell-auth-feedback[role=alert]");
      };
      let offer = await ask();
      assert(verifiedWith.join() === "Bearer tok-guest", `the guest signs in with its token, got ${verifiedWith}`);
      assert(offer?.querySelector(".shell-auth-error")?.textContent === "Already an account", "the account is said to be another's");
      assert(offer.querySelector(".shell-auth-taken .handle")?.textContent === "amber otter", `the account is named as its person sees it, got ${offer.querySelector(".shell-auth-taken")?.textContent}`);
      const choices = [...offer.querySelectorAll(".shell-auth-choice")].map((b) => `${b.dataset.authChoice}:${b.textContent}`);
      assert(choices.join("|") === "switch:Switch to it|stay:Stay here", `the two choices, got ${choices}`);
      // Staying keeps the guest, untouched.
      offer.querySelector('[data-auth-choice="stay"]').dispatchEvent(new Event("click", { bubbles: true }));
      await settle(30);
      assert(!doc.querySelector("nav .shell-auth-feedback"), "the offer is gone");
      assert(JSON.parse(localStorage.getItem("pronto-token")).token === "tok-guest", "the guest is still the device's");
      assert(reloads.length === 0, "staying reloads nothing");
      assert(held.join() === "stay", `staying lets the held account go, got ${held}`);
      // Staying takes the field's autofill up again, where the reader picks
      // the passkey once more; switching makes the account the device's.
      offer = await ask();
      offer.querySelector('[data-auth-choice="switch"]').dispatchEvent(new Event("click", { bubbles: true }));
      await settle(30);
      assert(held.join() === "stay,switch", `switching takes the held account, got ${held}`);
      assert(JSON.parse(localStorage.getItem("pronto-token")).token === "tok-owner", "the account is the device's now");
      assert(reloads.length === 0 && doc.querySelector("nav .shell-person .handle")?.textContent === "amber otter", "and the page is its, in place");
      const kept = JSON.parse(localStorage.getItem("pronto-device-accounts"));
      assert(kept?.[0]?.id === "u9" && kept[0].credential === "b3du", `the account is first among the device's, got ${JSON.stringify(kept)}`);
    } finally {
      globalThis.PublicKeyCredential = origCred;
      if (origNavCreds !== undefined) {
        Object.defineProperty(globalThis.navigator, "credentials", { value: origNavCreds, configurable: true });
      }
    }
  },
});

Deno.test({
  name: "a kept guest's provider sign-in into another account opens its panel on the choice, and switches only when asked",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const AUTH_YAML = GUEST_YAML.replace("  required: false\n", "  required: false\n  providers: [google]\n");
    for (const choice of ["stay", "switch"]) {
      const { document: doc, Event, mount, asked, reloads } = boot({ config: AUTH_YAML, cookie: "mecha_session_hint=1" });
      localStorage.setItem("pronto-token", JSON.stringify({ token: "tok-guest", user: { id: "u1", handle: "sunlit-fox-3fa2", guest: true }, committed: true }));
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => {
        const u = String(url);
        if (u.endsWith("/auth/session")) {
          asked.push("POST /auth/session");
          return Promise.resolve(Response.json({ error: "login_required", user: { handle: "amber-otter-77aa", name: "Alice" } }, { status: 409 }));
        }
        if (u.endsWith("/auth/session/switch")) {
          asked.push("POST /auth/session/switch");
          return Promise.resolve(Response.json({ token: "tok-owner", user: { id: "u9", handle: "amber-otter-77aa", name: "Alice" } }));
        }
        if (u.endsWith("/auth/session/stay")) {
          asked.push("POST /auth/session/stay");
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (u.includes("/crud/app_user")) return Promise.resolve(Response.json([{ id: "u1" }]));
        return prevFetch(url, init);
      };
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(300);
      const assert = check(mount);
      const panel = doc.querySelector("nav .shell-signin-panel");
      assert(!panel.hidden, "the panel is open on the choice");
      const offer = panel.querySelector(":scope > .shell-auth-feedback[role=alert]");
      assert(offer?.querySelector(".shell-auth-taken .handle")?.textContent === "Alice", `the account is named by its person's name, got ${offer?.querySelector(".shell-auth-taken")?.textContent}`);
      assert(JSON.parse(localStorage.getItem("pronto-token")).token === "tok-guest", "nothing is switched unasked");
      offer.querySelector(`[data-auth-choice="${choice}"]`).dispatchEvent(new Event("click", { bubbles: true }));
      await settle(60);
      if (choice === "stay") {
        // Staying lets the held sign-in go and keeps the guest's own session.
        assert(asked.includes("POST /auth/session/stay") && !asked.includes("POST /auth/session/switch"), `staying lets the held sign-in go, got ${asked}`);
        assert(JSON.parse(localStorage.getItem("pronto-token")).token === "tok-guest" && reloads.length === 0, "and keeps the guest in place");
      } else {
        assert(asked.includes("POST /auth/session/switch"), `switching takes the held sign-in, got ${asked}`);
        assert(JSON.parse(localStorage.getItem("pronto-token")).token === "tok-owner" && reloads.length === 0, "and the account is the device's, in place");
        assert(localStorage.getItem("pronto-device-accounts") === null, "a provider's account is no face of My device's");
      }
    }
  },
});

Deno.test({
  name: "a person's chip names them by their name alone, never the suffix others see, and opens onto Rename and Sign out, and no other account",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { document: doc, Event, mount } = boot({ config: GUEST_YAML });
    localStorage.setItem("pronto-token", JSON.stringify({ token: "tok", user: { id: "u1", handle: "Ada-3fa2" }, passkey: { rpId: "localhost", userId: "dTE" } }));
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => String(url).includes("/crud/app_user") ? Promise.resolve(Response.json([{ id: "u1" }])) : prevFetch(url, init);
    const { createShell } = await import("./shell.js");
    createShell({ config: "./shell.yaml", mount });
    await settle(300);
    const assert = check(mount);
    const open = doc.querySelector("nav .shell-me > .shell-person");
    assert(open?.querySelector(".handle")?.textContent === "Ada" && !open.textContent.includes("3fa2"), `the name alone, got ${open?.textContent}`);
    assert(open.querySelector(".shell-chip-label")?.textContent === "Passkey", "signed in with a passkey");
    assert(!doc.querySelector("nav .shell-signin"), "a person has no Sign in");
    const panel = doc.querySelector("nav #shell-account-panel");
    assert(panel.hidden && open.getAttribute("aria-controls") === "shell-account-panel", "one closed chip");
    open.dispatchEvent(new Event("click", { bubbles: true }));
    assert(!panel.hidden, "the chip opens its panel in place");
    const items = [...panel.querySelectorAll(":scope > button")].map((b) => b.dataset.authAction);
    assert(items.join("|") === "rename|signout|delete-account", `Rename, the way out, then deleting, got ${items}`);
    // Deleting is for good: the first press only asks, and closing the panel takes the question back.
    const drop = panel.querySelector(".shell-delete");
    let deleted = false;
    globalThis.fetch = (url, init) => {
      if (String(url).endsWith("/account") && init?.method === "DELETE") deleted = true;
      return Promise.resolve(Response.json([{ id: "u1" }]));
    };
    drop.dispatchEvent(new Event("click", { bubbles: true }));
    await settle(50);
    assert(drop.hasAttribute("data-confirm") && !deleted, "the first press asks and deletes nothing");
    open.dispatchEvent(new Event("click", { bubbles: true }));
    assert(panel.hidden && !drop.hasAttribute("data-confirm"), "closing the panel takes the question back");
    globalThis.fetch = prevFetch;
    assert(!panel.querySelector(".shell-faces, .shell-passkey"), "a person's panel offers no other account");
  },
});

Deno.test({
  name: "a rename edits the name in place on the chip: Escape leaves it, the suffix others see stays, and the session is the renamed one",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const origCred = globalThis.PublicKeyCredential;
    globalThis.PublicKeyCredential = class {
      static signalCurrentUserDetails() {
        return Promise.resolve();
      }
    };
    try {
      const { document: doc, Event, mount } = boot({ config: GUEST_YAML });
      localStorage.setItem("pronto-token", JSON.stringify({ token: "tok-person", user: { id: "u1", handle: "sunlit-fox-3fa2" } }));
      localStorage.setItem("pronto-device-accounts", JSON.stringify([{ id: "u1", handle: "sunlit-fox-3fa2", credential: "Y3I" }]));
      const asked = [];
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => {
        const u = String(url);
        if (u.includes("/crud/app_user")) return Promise.resolve(Response.json([{ id: "u1" }]));
        if (u.endsWith("/auth/rename")) {
          const name = JSON.parse(init.body).name;
          asked.push(`${init.headers.Authorization} ${name}`);
          if (name === "Taken") return Promise.resolve(Response.json({ error: "name taken" }, { status: 409 }));
          return Promise.resolve(Response.json({ token: "tok-renamed", user: { id: "u1", handle: `${name}-3fa2` }, passkey: { rpId: "localhost", userId: "dTE" } }));
        }
        return prevFetch(url, init);
      };
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(300);
      const assert = check(mount);
      const rename = () => doc.querySelector('nav .shell-signin-panel [data-auth-action="rename"]').dispatchEvent(new Event("click", { bubbles: true }));
      rename();
      await settle(30);
      let form = doc.querySelector("nav .shell-me > .shell-rename-form");
      const input = form?.querySelector('input[name="nickname"]');
      assert(input?.value === "sunlit fox" && !form.querySelector(".suffix"), `the name to edit, and no suffix, got ${form?.textContent}`);
      assert(doc.querySelector("nav .shell-me > .shell-person").hidden, "in place of the chip");
      const esc = new Event("keydown", { bubbles: true });
      esc.key = "Escape";
      input.dispatchEvent(esc);
      assert(!doc.querySelector(".shell-rename-form") && !doc.querySelector("nav .shell-me > .shell-person").hidden, "Escape leaves the name as it was");
      rename();
      await settle(30);
      form = doc.querySelector("nav .shell-rename-form");
      form.querySelector("input").value = "Taken";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle(60);
      assert(form.querySelector(".shell-auth-error")?.textContent === "Another account here has that name", "a name another account holds is said so");
      form.querySelector("input").value = " Mango ";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle(60);
      assert(asked.join("|") === "Bearer tok-person Taken|Bearer tok-person Mango", `the session renames, got ${asked}`);
      assert(doc.querySelector("nav .shell-me > .shell-person .handle")?.textContent === "Mango", "the chip is the new name");
      const stored = JSON.parse(localStorage.getItem("pronto-token"));
      assert(stored.token === "tok-renamed" && stored.passkey === undefined, `the renamed session is the device's, got ${JSON.stringify(stored)}`);
      assert(JSON.parse(localStorage.getItem("pronto-device-accounts"))[0].handle === "Mango-3fa2", "My device shows the new name");
    } finally {
      globalThis.PublicKeyCredential = origCred;
    }
  },
});

Deno.test({
  name: "the gate asks the name where the device holds nothing, and makes the account under it",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const origCred = globalThis.PublicKeyCredential;
    const origNavCreds = globalThis.navigator?.credentials;
    const created = [];
    globalThis.PublicKeyCredential = class {
      static getClientCapabilities() {
        return Promise.resolve({ immediateGet: true });
      }
      static signalCurrentUserDetails() {
        return Promise.resolve();
      }
    };
    Object.defineProperty(globalThis.navigator, "credentials", {
      value: {
        get: async () => {
          throw Object.assign(new Error("nothing saved here"), { name: "NotAllowedError" });
        },
        create: async (opts) => {
          created.push(opts);
          return {
            id: "bmV3", rawId: new Uint8Array([7]).buffer, type: "public-key", getClientExtensionResults: () => ({}),
            response: { clientDataJSON: new Uint8Array([1]).buffer, attestationObject: new Uint8Array([2]).buffer, getTransports: () => ["internal"] },
          };
        },
      },
      configurable: true,
    });
    try {
      const { mount, Event } = boot();
      const named = [];
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => {
        const u = String(url);
        if (u.endsWith("/auth/login/start")) return Promise.resolve(Response.json({ state: "st", rpId: "localhost", challenge: "Y2hhbA" }));
        if (u.endsWith("/auth/register/start")) {
          named.push(`${init.headers.Authorization ?? "nobody"} ${JSON.parse(init.body).name}`);
          return Promise.resolve(Response.json({ state: "st-reg", rp: { id: "localhost", name: "localhost" }, challenge: "Y2hhbA", user: { id: "dTE", name: "x", displayName: "x" } }));
        }
        if (u.endsWith("/auth/register/verify")) return Promise.resolve(Response.json({ token: "tok-made", user: { id: "u1", handle: "Ada-3fa2" }, passkey: { rpId: "localhost", userId: "dTE" } }));
        return prevFetch(url, init);
      };
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(300);
      const assert = check(mount);
      mount.querySelector(".shell-login form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle(60);
      const form = mount.querySelector(".shell-login .shell-name-form");
      assert(form && mount.querySelector(".shell-login form:not(.shell-name-form)").hidden, "the gate asks the name in place of its way in");
      form.querySelector("input").value = "Ada";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle(300);
      assert(created.length === 1 && named.join() === "nobody Ada", `the account is made under the name, got ${named}`);
      assert(JSON.parse(localStorage.getItem("pronto-token")).token === "tok-made", "and is the device's");
      assert(!mount.querySelector(".shell-login"), "the gate comes down");
    } finally {
      globalThis.PublicKeyCredential = origCred;
      if (origNavCreds !== undefined) {
        Object.defineProperty(globalThis.navigator, "credentials", { value: origNavCreds, configurable: true });
      }
    }
  },
});

Deno.test("a name tells the device the name alone, never a list of passkeys", async () => {
  // Regression: a rename, or a ceremony's answer landing late, sent a list of
  // passkeys that missed one another tab had added since, which the device
  // may delete.
  const origCred = globalThis.PublicKeyCredential;
  const calls = [];
  globalThis.PublicKeyCredential = class {
    static signalAllAcceptedCredentials(o) {
      calls.push(["accepted", o]);
      return Promise.resolve();
    }
    static signalCurrentUserDetails(o) {
      calls.push(["details", o]);
      return Promise.resolve();
    }
  };
  try {
    const signals = await import("./passkey-signals.js");
    if ("signalPasskeys" in signals) throw new Error("smoke failed: a way to signal a list of passkeys is back");
    const session = { token: "t", user: { id: "u1", handle: "amber-fox" }, passkey: { rpId: "localhost", userId: "dTE" } };
    signals.signalName(session, "Alice");
    // The account name is the person's own, never the handle others see.
    if (JSON.stringify(calls) !== JSON.stringify([["details", { rpId: "localhost", userId: "dTE", name: "Alice", displayName: "Alice" }]])) {
      throw new Error(`smoke failed: a rename said ${JSON.stringify(calls)}`);
    }
    calls.length = 0;
    const signalName = signals.signalName;
    signalName({ token: "t", user: { id: "u2", handle: "via-google" } }, "Bob");
    if (calls.length !== 0) throw new Error("smoke failed: a provider's session has no passkeys to name");
  } finally {
    globalThis.PublicKeyCredential = origCred;
  }
});

Deno.test("a refused signal is the program's error, not a failed request", async () => {
  // Regression: unowned, it reached the shell's stray-rejection handler,
  // which turned the screen to network-error after a sign-in that worked.
  const origCred = globalThis.PublicKeyCredential;
  globalThis.PublicKeyCredential = class {
    static signalCurrentUserDetails() {
      return Promise.reject(Object.assign(new Error("rpId is not a registrable suffix"), { name: "SecurityError" }));
    }
  };
  try {
    const { signal } = await import("./passkey-signals.js");
    const { ProgramError } = await import("./fragment.js");
    const err = await signal("signalCurrentUserDetails", { rpId: "elsewhere" }).then(() => null, (e) => e);
    if (!(err instanceof ProgramError) || !String(err.message).includes("SecurityError")) {
      throw new Error(`smoke failed: refused as ${err?.constructor?.name}: ${err?.message}`);
    }
  } finally {
    globalThis.PublicKeyCredential = origCred;
  }
});

Deno.test({
  name: "a guest minted after a sign-in landed does not take the person's place",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Regression: a sign-in no longer waits for the guest minted at boot, and
    // that guest, arriving after, wrote its token over the person's.
    const origCred = globalThis.PublicKeyCredential;
    const origNavCreds = globalThis.navigator?.credentials;
    globalThis.PublicKeyCredential = class {
      static getClientCapabilities() {
        return Promise.resolve({ immediateGet: true });
      }
      static isConditionalMediationAvailable() {
        return Promise.resolve(true);
      }
    };
    const b64u = (str) => btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    Object.defineProperty(globalThis.navigator, "credentials", {
      value: {
        get: async () => ({
          id: b64u("cred"),
          rawId: new Uint8Array([1]).buffer,
          type: "public-key",
          getClientExtensionResults: () => ({}),
          response: { clientDataJSON: new Uint8Array([2]).buffer, authenticatorData: new Uint8Array([3]).buffer, signature: new Uint8Array([4]).buffer },
        }),
      },
      configurable: true,
    });
    try {
      const { document: doc, Event, mount, reloads } = boot({ config: GUEST_YAML });
      let releaseGuest = null;
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => {
        const u = String(url);
        if (u.endsWith("/auth/guest")) {
          return new Promise((resolve) => {
            releaseGuest = () => resolve(new Response(JSON.stringify({ token: "tok-guest", user: { id: "g1", handle: "late-guest", guest: true } })));
          });
        }
        if (u.endsWith("/auth/login/start")) return Promise.resolve(new Response(JSON.stringify({ state: "st", rpId: "localhost", challenge: "Y2hhbA" })));
        if (u.endsWith("/auth/login/verify")) {
          return Promise.resolve(new Response(JSON.stringify({ token: "tok-person", user: { id: "p1", handle: "amber-fox" }, passkey: { rpId: "localhost", userId: b64u("p1") } })));
        }
        return prevFetch(url, init);
      };
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(200);
      const assert = check(mount);
      // The passkey is picked in the field's autofill.
      doc.querySelector("nav .shell-passkey").dispatchEvent(new Event("click", { bubbles: true }));
      await settle(100);
      assert(JSON.parse(localStorage.getItem("pronto-token")).user.id === "p1", "the person's session is the tab's");
      assert(reloads.length === 0 && doc.body.dataset.auth === "user", "another owner's sign-in is the page's in place");
      releaseGuest();
      await settle(100);
      assert(JSON.parse(localStorage.getItem("pronto-token")).user.id === "p1", "the late guest took the person's place");
    } finally {
      globalThis.PublicKeyCredential = origCred;
      if (origNavCreds !== undefined) {
        Object.defineProperty(globalThis.navigator, "credentials", { value: origNavCreds, configurable: true });
      }
    }
  },
});

Deno.test({
  name: "a click before the challenge is in hand asks the device as usual, never alone",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Regression: the device was asked alone after waiting on a challenge
    // still on its way, by when the click's activation could have run out;
    // refused, it read as a device with nothing saved.
    const origCred = globalThis.PublicKeyCredential;
    const origNavCreds = globalThis.navigator?.credentials;
    const askedWith = [];
    globalThis.PublicKeyCredential = class {
      static getClientCapabilities() {
        return Promise.resolve({ immediateGet: true });
      }
    };
    Object.defineProperty(globalThis.navigator, "credentials", {
      value: {
        get: async (opts) => {
          askedWith.push(opts.uiMode ?? "default");
          throw Object.assign(new Error("dismissed"), { name: "NotAllowedError" });
        },
      },
      configurable: true,
    });
    try {
      const { document: doc, Event, mount } = boot({ config: GUEST_YAML });
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => {
        if (String(url).endsWith(".html")) return Promise.resolve(new Response(`<section class="screen" data-screen="home"><button type="button" id="keep" data-auth-action="device">Sign in</button></section>`));
        if (String(url).endsWith("/auth/login/start")) {
          return new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({ state: "st", rpId: "localhost", challenge: "Y2hhbA" }))), 300));
        }
        return prevFetch(url, init);
      };
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(100);
      const assert = check(mount);
      mount.querySelector("#keep").dispatchEvent(new Event("click", { bubbles: true }));
      await settle(500);
      assert(askedWith.join() === "default", `a challenge on its way is waited for and the device asked as usual, got ${askedWith}`);
    } finally {
      globalThis.PublicKeyCredential = origCred;
      if (origNavCreds !== undefined) {
        Object.defineProperty(globalThis.navigator, "credentials", { value: origNavCreds, configurable: true });
      }
    }
  },
});

// A browser whose passkey autofill the test drives: a conditional request
// waits until `pick` answers it with a passkey, or its signal lets it go.
function passkeyBrowser() {
  const b64u = (str) => btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const asked = [];
  let waiting = null;
  let refusing = null;
  const cred = (id) => ({
    id,
    rawId: new Uint8Array([1]).buffer,
    type: "public-key",
    getClientExtensionResults: () => ({}),
    response: { clientDataJSON: new Uint8Array([2]).buffer, authenticatorData: new Uint8Array([3]).buffer, signature: new Uint8Array([4]).buffer },
  });
  const browser = {
    b64u,
    asked,
    created: [],
    released: 0,
    pick: (id) => waiting?.(cred(id)),
    refuse: (name) => refusing?.(Object.assign(new Error(name), { name })),
    credentials: {
      get: (opts) => {
        if (opts.mediation === "conditional") {
          asked.push("conditional");
          return new Promise((resolve, reject) => {
            waiting = resolve;
            refusing = reject;
            opts.signal.addEventListener("abort", () => {
              browser.released++;
              waiting = null;
              reject(Object.assign(new Error("released"), { name: "AbortError" }));
            });
          });
        }
        const allowed = opts.publicKey.allowCredentials.map((c) => b64u(String.fromCharCode(...new Uint8Array(c.id))));
        asked.push(allowed.join() || "list");
        return Promise.resolve(cred(allowed[0]));
      },
      create: (opts) => {
        browser.created.push(opts);
        return Promise.resolve({
          id: b64u("cred-new"),
          rawId: new Uint8Array([7]).buffer,
          type: "public-key",
          getClientExtensionResults: () => ({}),
          response: { clientDataJSON: new Uint8Array([1]).buffer, attestationObject: new Uint8Array([2]).buffer, getTransports: () => ["internal"] },
        });
      },
    },
  };
  return browser;
}

Deno.test({
  name: "Passkey: faces that ask for their own passkey alone, then one field whose autofill offers the rest and whose new name makes one",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const origCred = globalThis.PublicKeyCredential;
    const origNavCreds = globalThis.navigator?.credentials;
    globalThis.PublicKeyCredential = class {
      static isConditionalMediationAvailable() {
        return Promise.resolve(true);
      }
      static signalCurrentUserDetails() {
        return Promise.resolve();
      }
    };
    const browser = passkeyBrowser();
    const { b64u } = browser;
    Object.defineProperty(globalThis.navigator, "credentials", { value: browser.credentials, configurable: true });
    const people = { [b64u("cred-ana")]: { id: "ana", handle: "Ana-3fa2" }, [b64u("cred-marta")]: { id: "marta", handle: "Marta-c4d8" } };
    try {
      const { document: doc, Event, mount, reloads } = boot({ config: GUEST_YAML });
      const registered = [];
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => {
        const u = String(url);
        if (u.endsWith("/auth/login/start")) return Promise.resolve(Response.json({ state: "st", rpId: "localhost", challenge: "Y2hhbA" }));
        if (u.endsWith("/auth/login/verify")) {
          const user = people[JSON.parse(init.body).response.id];
          return Promise.resolve(Response.json({ token: `tok-${user.id}`, user, passkey: { rpId: "localhost", userId: b64u(user.id) } }));
        }
        if (u.endsWith("/auth/register/start")) {
          registered.push(JSON.parse(init.body).name);
          return Promise.resolve(Response.json({ state: "st-reg", rp: { id: "localhost", name: "localhost" }, challenge: "Y2hhbA", user: { id: "dTE", name: "Zed", displayName: "Zed" } }));
        }
        if (u.endsWith("/auth/register/verify")) return Promise.resolve(Response.json({ token: "tok-zed", user: { id: "zed", handle: "Zed-5e21" }, passkey: { rpId: "localhost", userId: "dTE" } }));
        if (u.endsWith("/auth/guest")) return Promise.resolve(Response.json({ token: "tok-guest", user: { id: "g1", handle: "sunlit-fox-01", guest: true } }));
        if (u.includes("/crud/app_user")) return Promise.resolve(Response.json([{ id: "x" }]));
        return prevFetch(url, init);
      };
      localStorage.setItem("pronto-device-accounts", JSON.stringify([{ id: "ana", handle: "Ana-3fa2", credential: b64u("cred-ana") }]));
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(200);
      const assert = check(mount);
      const click = (el) => el.dispatchEvent(new Event("click", { bubbles: true }));
      const openPasskey = async () => {
        click(doc.querySelector("nav .shell-signin"));
        click(doc.querySelector("nav .shell-passkey"));
        await settle(60);
        return doc.querySelector("nav .shell-signin-panel > .shell-accounts");
      };

      // Someone signed in here before: Sign in asks, and Passkey shows them.
      let step = await openPasskey();
      assert(step && doc.querySelector("nav .shell-signin-ways").hidden, "Passkey opens in place of the ways in");
      assert([...step.querySelectorAll(".shell-face")].map((f) => f.getAttribute("aria-label")).join() === "Ana", "Ana's face, by her name alone");
      const field = step.querySelector('.shell-passkey-form input[autocomplete="username webauthn"]');
      assert(field && step.querySelector(".shell-passkey-go")?.getAttribute("aria-label") === "Create a passkey", "one field marked for passkey autofill, and → to make one");
      assert(browser.asked.join() === "conditional", `the field holds the browser's passkey autofill open, got ${browser.asked}`);

      // A face asks for its own passkey alone, the autofill let go first.
      click(step.querySelector(".shell-face-pick"));
      await settle(300);
      assert(browser.released === 1 && browser.asked.join() === `conditional,${b64u("cred-ana")}`, `the autofill let go, then Ana's passkey alone, got ${browser.asked} released ${browser.released}`);
      assert(reloads.length === 0 && doc.querySelector("nav .shell-person .handle")?.textContent === "Ana", "Ana's page, in place");

      // Signed out, a passkey picked in the field's autofill signs in.
      click(doc.querySelector("nav .shell-person"));
      click(doc.querySelector('nav [data-auth-action="signout"]'));
      await settle(300);
      step = await openPasskey();
      browser.pick(b64u("cred-marta"));
      await settle(300);
      assert(doc.querySelector("nav .shell-person .handle")?.textContent === "Marta", "Marta's page, from the autofill");
      assert(JSON.parse(localStorage.getItem("pronto-device-accounts")).map((a) => a.id).join() === "marta,ana", "Marta first now");

      // A new name in the field makes a passkey under it, the autofill let go.
      click(doc.querySelector("nav .shell-person"));
      click(doc.querySelector('nav [data-auth-action="signout"]'));
      await settle(300);
      step = await openPasskey();
      const released = browser.released;
      step.querySelector("input").value = " Zed ";
      step.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle(300);
      assert(browser.released === released + 1, "the autofill let go before the passkey is made");
      assert(registered.join() === "Zed" && browser.created.length === 1, `made under the name, got ${registered}`);
      assert(doc.querySelector("nav .shell-person .handle")?.textContent === "Zed", "Zed's page, in place");

      // Regression: an autofill that failed fell through to adopt no session,
      // and the shell threw. The reader's no is quiet; any other failure is
      // said; neither asks again nor signs anyone in.
      click(doc.querySelector("nav .shell-person"));
      click(doc.querySelector('nav [data-auth-action="signout"]'));
      await settle(300);
      for (const [name, said] of [["NotAllowedError", false], ["SecurityError", true]]) {
        step = await openPasskey();
        const asked = browser.asked.length;
        browser.refuse(name);
        await settle(300);
        assert(step.querySelector(".shell-auth-error").hidden === !said && step.isConnected, `${name} ${said ? "is said" : "is quiet"}, in the step still open`);
        assert(browser.asked.length === asked && !doc.querySelector("nav .shell-person"), `nobody signed in, and nothing asked again, got ${browser.asked.slice(asked)}`);
        click(step.querySelector(".shell-accounts-back"));
        click(doc.querySelector("nav .shell-signin"));
      }
    } finally {
      globalThis.PublicKeyCredential = origCred;
      if (origNavCreds !== undefined) Object.defineProperty(globalThis.navigator, "credentials", { value: origNavCreds, configurable: true });
    }
  },
});

Deno.test({
  name: "Sign in on a device nobody signed in on makes the reader the guest at once, and that guest, having written nothing, becomes an account it reaches silently",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const origCred = globalThis.PublicKeyCredential;
    const origNavCreds = globalThis.navigator?.credentials;
    globalThis.PublicKeyCredential = class {
      static isConditionalMediationAvailable() {
        return Promise.resolve(true);
      }
      static signalCurrentUserDetails() {
        return Promise.resolve();
      }
    };
    const browser = passkeyBrowser();
    const { b64u } = browser;
    Object.defineProperty(globalThis.navigator, "credentials", { value: browser.credentials, configurable: true });
    try {
      const { document: doc, Event, mount, reloads } = boot({ config: GUEST_YAML });
      const verifiedWith = [];
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => {
        const u = String(url);
        if (u.endsWith("/auth/login/start")) return Promise.resolve(Response.json({ state: "st", rpId: "localhost", challenge: "Y2hhbA" }));
        if (u.endsWith("/auth/login/verify")) {
          verifiedWith.push(init.headers.Authorization ?? "no token");
          return Promise.resolve(Response.json({ token: "tok-owner", user: { id: "u9", handle: "amber-otter-77aa" }, passkey: { rpId: "localhost", userId: "dTk" } }));
        }
        if (u.endsWith("/auth/guest")) return Promise.resolve(Response.json({ token: "tok-guest", user: { id: "g1", handle: "sunlit-fox-01", guest: true } }));
        if (u.includes("/crud/app_user")) return Promise.resolve(Response.json([{ id: "x" }]));
        return prevFetch(url, init);
      };
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(200);
      const assert = check(mount);
      const click = (el) => el.dispatchEvent(new Event("click", { bubbles: true }));
      click(doc.querySelector("nav .shell-signin"));
      const chip = doc.querySelector("nav .shell-me > .shell-signin.shell-guest");
      const panel = doc.querySelector("nav .shell-signin-panel");
      assert(chip?.querySelector(".handle")?.textContent === "Guest" && !panel.hidden, "Sign in asked nothing: the reader is the guest, its panel open");
      assert(panel.querySelector(".shell-signin-title")?.textContent === "Signed in as guest", "signed in as guest");
      assert(JSON.parse(localStorage.getItem("pronto-token")).shown === true, "and the device remembers it");

      // The guest wrote nothing: a passkey of an account already made
      // switches to it with no question, the guest's token not sent.
      click(panel.querySelector(".shell-passkey"));
      await settle(60);
      browser.pick(b64u("cred-owner"));
      await settle(300);
      assert(verifiedWith.join() === "no token", `the untouched guest is not carried along, got ${verifiedWith}`);
      assert(!doc.querySelector("nav .shell-auth-choice") && reloads.length === 0, "no Switch or Stay, no reload");
      assert(doc.querySelector("nav .shell-person .handle")?.textContent === "amber otter", "the account's page, in place");
    } finally {
      globalThis.PublicKeyCredential = origCred;
      if (origNavCreds !== undefined) Object.defineProperty(globalThis.navigator, "credentials", { value: origNavCreds, configurable: true });
    }
  },
});

Deno.test({
  name: "a served Sign in another release drew gives way to this one's, whose My device opens its accounts",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Regression: a document rendered before My device opened onto accounts
    // held its older box, which the shell bound and found no My device in.
    const origCred = globalThis.PublicKeyCredential;
    globalThis.PublicKeyCredential = class {};
    try {
      const { document: doc, Event, mount } = boot({ config: GUEST_YAML });
      const { drawStrip, signinBox } = await import("./chrome.js");
      const cfg = { routes: [{ path: "/", screen: "home", nav: { label: "Home" } }], auth: { service: "/auth" } };
      const served = drawStrip(doc, cfg);
      const older = signinBox(doc, cfg);
      older.querySelector('[data-auth-action="accounts"]').setAttribute("data-auth-action", "device");
      served.append(older);
      mount.before(served);
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(300);
      const assert = check(mount);
      assert(!doc.querySelector('nav [data-auth-action="device"]'), "the older box is gone");
      doc.querySelector("nav .shell-signin").dispatchEvent(new Event("click", { bubbles: true }));
      doc.querySelector('nav [data-auth-action="accounts"]').dispatchEvent(new Event("click", { bubbles: true }));
      assert(doc.querySelector("nav .shell-signin-panel > .shell-accounts"), "and this release's My device opens its accounts");
    } finally {
      globalThis.PublicKeyCredential = origCred;
    }
  },
});

Deno.test("the nav's Sign in puts Passkey ahead of More options (email) while keeping primary providers first", async () => {
  const { document } = parseHTML("<!doctype html><html><body><nav></nav></body></html>");
  const { signinBox, localizeStrip } = await import("./chrome.js");
  for (const [providers, expected] of [
    [["google", "email"], ["google", "accounts", "email"]],
    [["email"], ["accounts", "email"]],
  ]) {
    const cfg = { routes: [], auth: { service: "/auth", providers } };
    const nav = document.createElement("nav");
    nav.append(signinBox(document, cfg));
    localizeStrip(nav, cfg, { here: "/deck", messages: {}, locale: "en" });
    const order = [...nav.querySelectorAll(".shell-signin-ways > *")].map((el) => el.dataset.provider ?? el.dataset.authAction);
    if (order.join("|") !== expected.join("|")) {
      throw new Error(`smoke failed: expected ${expected.join("|")}, got ${order.join("|")}`);
    }
    const more = nav.querySelector('.shell-provider[data-provider="email"]');
    if (more?.textContent !== "More options" || more.getAttribute("aria-label") !== "More options") {
      throw new Error(`smoke failed: expected More options, got ${more?.textContent} / ${more?.getAttribute("aria-label")}`);
    }
  }
});

Deno.test({
  name: "a credential provider keeps its styled link and overlays FedCM when IdentityCredential is available, and falls back to redirect without it",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const origCred = globalThis.PublicKeyCredential;
    const origIdentity = globalThis.IdentityCredential;
    globalThis.PublicKeyCredential = class {};
    globalThis.IdentityCredential = class {};
    try {
      const { document: doc, Event, mount } = boot({ config: GUEST_YAML.replace("  service: /auth\n", "  service: /auth\n  providers: [google]\n") });
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (url, init) =>
        String(url).endsWith("/auth/oidc") ? Promise.resolve(Response.json({ providers: ["google"], credential: { google: "client-123" } })) : prevFetch(url, init);
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(300);
      const assert = check(mount);
      const wrap = doc.querySelector('nav .shell-provider-wrap[data-provider="google"]');
      const link = wrap?.querySelector('a.shell-provider[data-provider="google"]');
      assert(wrap && link, "Google keeps its styled link inside a wrap without rendering flips");
      assert(!doc.querySelector("nav .shell-provider-button"), "no GIS button holder replaces the link");
      assert(!wrap.querySelector("iframe"), "a visitor who has not opened the panel loads no FedCM frame");
      doc.querySelector("nav .shell-signin").dispatchEvent(new Event("click", { bubbles: true }));
      const frame = wrap.querySelector("iframe.shell-provider-active");
      assert(frame?.getAttribute("src")?.startsWith("/auth/oidc/google/button?prompt="), `opening the panel mounts the active+prompt FedCM frame, got ${frame?.getAttribute("src")}`);
      assert(frame.getAttribute("allow") === "identity-credentials-get", "which may ask FedCM");
      assert(frame.hasAttribute("data-pending"), "and waits for ready before intercepting clicks");
      assert(!doc.querySelector('script[src*="accounts.google.com"]'), "and the terminal loads no Google script itself");
      doc.querySelector("nav .shell-signin-close").dispatchEvent(new Event("click", { bubbles: true }));
      assert(!wrap.querySelector("iframe"), "closing the panel removes the FedCM frame");
    } finally {
      globalThis.IdentityCredential = origIdentity;
    }

    // Without IdentityCredential (e.g. Safari/Firefox), no FedCM frame mounts and the styled link stays plain.
    delete globalThis.IdentityCredential;
    try {
      const { document: doc, Event, mount } = boot({ config: GUEST_YAML.replace("  service: /auth\n", "  service: /auth\n  providers: [google]\n") });
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (url, init) =>
        String(url).endsWith("/auth/oidc") ? Promise.resolve(Response.json({ providers: ["google"], credential: { google: "client-123" } })) : prevFetch(url, init);
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(300);
      const assert = check(mount);
      doc.querySelector("nav .shell-signin").dispatchEvent(new Event("click", { bubbles: true }));
      assert(!doc.querySelector("nav .shell-provider-wrap"), "without FedCM no overlay wrap is added");
      assert(doc.querySelector('nav a.shell-provider[data-provider="google"]'), "the styled redirect link stands directly");
      assert(!doc.querySelector("nav iframe.shell-provider-active"), "no FedCM frame mounts");
    } finally {
      globalThis.PublicKeyCredential = origCred;
      globalThis.IdentityCredential = origIdentity;
    }
  },
});

Deno.test({
  name: "a provider's prompt stays off by default and is framed on interaction only when opted in",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const origCred = globalThis.PublicKeyCredential;
    const origIdentity = globalThis.IdentityCredential;
    globalThis.PublicKeyCredential = class {};
    globalThis.IdentityCredential = class {};
    try {
      // Off by default: even after a trusted press outside the panel, no prompt opens.
      {
        const { document: doc, Event, mount } = boot({ config: GUEST_YAML.replace("  service: /auth\n", "  service: /auth\n  providers: [google]\n") });
        const prevFetch = globalThis.fetch;
        globalThis.fetch = (url, init) =>
          String(url).endsWith("/auth/oidc") ? Promise.resolve(Response.json({ providers: ["google"], credential: { google: "client-123" } })) : prevFetch(url, init);
        const { createShell } = await import("./shell.js");
        createShell({ config: "./shell.yaml", mount });
        await settle(300);
        const assert = check(mount);
        const ev = new Event("pointerdown", { bubbles: true });
        Object.defineProperty(ev, "isTrusted", { value: true });
        mount.dispatchEvent(ev);
        assert(doc.querySelector("body > iframe.shell-provider-prompt") === null, "no prompt without auth.prompt: true");
      }

      const { document: doc, Event, mount } = boot({ config: GUEST_YAML.replace("  service: /auth\n", "  service: /auth\n  prompt: true\n  providers: [google]\n") });
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (url, init) =>
        String(url).endsWith("/auth/oidc") ? Promise.resolve(Response.json({ providers: ["google"], credential: { google: "client-123" } })) : prevFetch(url, init);
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(300);
      const assert = check(mount);
      const prompt = () => doc.querySelector("body > iframe.shell-provider-prompt");
      // A crawler or a visit no one touches pays nothing of Google's.
      assert(prompt() === null, "no prompt before a person is there");
      const press = (el) => {
        const e = new Event("pointerdown", { bubbles: true });
        Object.defineProperty(e, "isTrusted", { value: true });
        el.dispatchEvent(e);
      };
      mount.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      assert(prompt() === null, "a script's press is no person's");
      // Regression: a press on the way to the panel spent the prompt for good.
      press(doc.querySelector("nav .shell-signin"));
      assert(prompt() === null, "the panel's own button serves a press on Sign in");
      press(mount);
      assert(prompt()?.getAttribute("src")?.startsWith("/auth/oidc/google/button?prompt="), `a person's first press frames the prompt, got ${prompt()?.getAttribute("src")}`);
      assert(prompt().getAttribute("allow") === "identity-credentials-get", "which may ask FedCM");
      // Regression: a prompt framed while signed out outlived a passkey
      // sign-in and could sign Google in over the account.
      const { renderSession } = await import("./signin.js");
      renderSession({ user: { id: "u1", handle: "ana", guest: false }, passkey: true }, { app: "t", auth: { service: "/auth" } }, null, (k) => k);
      assert(prompt() === null, "signing in another way withdraws the prompt");
    } finally {
      globalThis.PublicKeyCredential = origCred;
      globalThis.IdentityCredential = origIdentity;
    }
  },
});

Deno.test({
  name: "an app's own control for a credential provider redirects cleanly without swapping into an iframe",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const origCred = globalThis.PublicKeyCredential;
    globalThis.PublicKeyCredential = class {};
    const SCREEN = `<section class="screen" data-screen="home"><button type="button" id="btn-auth-google" data-auth-provider="google">Google</button></section>`;
    try {
      const { Event, mount } = boot({ config: GUEST_YAML.replace("  service: /auth\n", "  service: /auth\n  providers: [google]\n") });
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => {
        if (String(url).endsWith("/auth/oidc")) return Promise.resolve(Response.json({ providers: ["google"], credential: { google: "client-123" } }));
        return String(url).endsWith(".html") ? Promise.resolve(new Response(SCREEN)) : prevFetch(url, init);
      };
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(300);
      const assert = check(mount);
      mount.querySelector("#btn-auth-google").dispatchEvent(new Event("click", { bubbles: true }));
      assert(!mount.querySelector("iframe.shell-provider-frame, iframe.shell-provider-active"), "app control does not swap into a Google iframe");
      assert(String(globalThis.location.href).endsWith("/auth/oidc/google/start?return=%2F%3Fpage%3D2"), `clicking starts the OIDC redirect, got ${globalThis.location.href}`);
    } finally {
      globalThis.PublicKeyCredential = origCred;
    }
  },
});

Deno.test({
  name: "a served panel drawn with the program's providers keeps only those this deployment turns on",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Regression: a prerendered document's panel held Google for a deployment
    // that turns on none, and its link led to a 404.
    const origCred = globalThis.PublicKeyCredential;
    globalThis.PublicKeyCredential = class {};
    try {
      const { document: doc, mount } = boot({ config: GUEST_YAML.replace("  service: /auth\n", "  service: /auth\n  providers: [google]\n") });
      const { drawStrip, signinBox } = await import("./chrome.js");
      const cfg = { routes: [{ path: "/", screen: "home", nav: { label: "Home" } }], auth: { service: "/auth", providers: ["google"] } };
      const served = drawStrip(doc, cfg);
      served.append(signinBox(doc, cfg));
      mount.before(served);
      const assert = check(mount);
      assert(served.querySelector('.shell-provider[data-provider="google"]'), "the document was drawn with Google");
      const prevFetch = globalThis.fetch;
      // A visitor's guest, as the auth service answers one: still a visitor's panel.
      globalThis.fetch = (url, init) => {
        const u = String(url);
        if (u.endsWith("/auth/oidc")) return Promise.resolve(Response.json({ providers: [] }));
        if (u.endsWith("/auth/guest")) return Promise.resolve(Response.json({ token: "t", user: { id: "u1", handle: "sunlit-fox-01", guest: true } }));
        return prevFetch(url, init);
      };
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(300);
      assert(doc.querySelector("nav .shell-signin-panel"), "the visitor's panel stands");
      assert(!doc.querySelector("nav .shell-provider"), "a deployment with no provider keeps no provider's link");
      assert(doc.querySelector('nav [data-auth-action="accounts"]'), "and keeps this device's way in");
    } finally {
      globalThis.PublicKeyCredential = origCred;
    }
  },
});

Deno.test({
  name: "a guest taken up again from the device's cookie keeps what the device knows of it: that it wrote, that it was shown",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Regression: the boot stored the cookie's fresh guest token over the
    // device's, and a shown guest was a visitor's Sign in again on reload.
    const origCred = globalThis.PublicKeyCredential;
    globalThis.PublicKeyCredential = class {};
    try {
      const { document: doc, mount } = boot({ config: GUEST_YAML, cookie: "mecha_session_hint=1" });
      localStorage.setItem("pronto-token", JSON.stringify({ token: "tok-old", user: { id: "g1", handle: "sunlit-fox-01", guest: true }, committed: true, shown: true }));
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => {
        const u = String(url);
        if (u.endsWith("/auth/session")) return Promise.resolve(Response.json({ token: "tok-fresh", user: { id: "g1", handle: "sunlit-fox-01", guest: true } }));
        if (u.includes("/crud/app_user")) return Promise.resolve(Response.json([{ id: "g1" }]));
        return prevFetch(url, init);
      };
      const { createShell } = await import("./shell.js");
      createShell({ config: "./shell.yaml", mount });
      await settle(300);
      const assert = check(mount);
      const stored = JSON.parse(localStorage.getItem("pronto-token"));
      assert(stored.token === "tok-fresh" && stored.committed === true && stored.shown === true, `the fresh token, the device's knowledge kept, got ${JSON.stringify(stored)}`);
      assert(doc.querySelector("nav .shell-me > .shell-signin.shell-guest .handle")?.textContent === "Guest", "still the guest's chip");
    } finally {
      globalThis.PublicKeyCredential = origCred;
    }
  },
});

Deno.test({
  name: "Tabs of one device share its guest: one minting takes the guest another kept first, and only a change of account reloads a tab",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Regression: two tabs opened together each minted a guest, and the first
    // reloaded when the second stored its own.
    const { mount, reloads } = boot({ config: GUEST_YAML });
    const adopted = [];
    // Another tab's write, as the browser tells this one: the storage event.
    const onStorage = [];
    const prevListen = globalThis.addEventListener;
    globalThis.addEventListener = (type, fn, opts) => type === "storage" ? onStorage.push(fn) : prevListen.call(globalThis, type, fn, opts);
    let answerMint;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      const u = String(url);
      if (u.endsWith("/auth/guest")) return new Promise((resolve) => (answerMint = () => resolve(Response.json({ token: "tok-mine", user: { id: "g-mine", handle: "sunlit-fox-01", guest: true } }))));
      if (u.endsWith("/auth/session/adopt")) {
        adopted.push(init.headers.Authorization);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (u.includes("/crud/app_user")) return Promise.resolve(Response.json([{ id: "x" }]));
      return prevFetch(url, init);
    };
    const stored = (value) => {
      const newValue = JSON.stringify(value);
      localStorage.setItem("pronto-token", newValue);
      for (const fn of onStorage) fn({ key: "pronto-token", newValue });
    };
    const { createShell } = await import("./shell.js");
    createShell({ config: "./shell.yaml", mount });
    await settle(100);
    const assert = check(mount);
    const theirs = { token: "tok-theirs", user: { id: "g-theirs", handle: "amber-otter-02", guest: true } };
    stored(theirs);
    answerMint();
    await settle(200);
    assert(reloads.length === 0, `a tab still minting reloads for no guest kept first, got ${reloads.length}`);
    assert(JSON.parse(localStorage.getItem("pronto-token")).user.id === "g-theirs" && adopted.length === 0, `the guest kept first is this tab's too, and its own is not adopted, got ${localStorage.getItem("pronto-token")} / ${adopted}`);
    stored({ ...theirs, token: "tok-theirs-renewed" });
    await settle(20);
    assert(reloads.length === 0, "a token renewed elsewhere keeps the account, and the page");
    stored({ token: "tok-person", user: { id: "u1", handle: "Ana-3fa2" } });
    await settle(20);
    assert(reloads.length === 1, `an account changed elsewhere reloads the tab, got ${reloads.length}`);
    globalThis.addEventListener = prevListen;
  },
});

Deno.test({
  name: "a person signed in again after an external effect, with one way in, finds the panel open on Set up recovery, until Not now",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    let later = false;
    const ways = (u) => {
      if (u.endsWith("/later")) later = true;
      return { ways: [{ kind: "provider", provider: "google", issuer: "https://accounts.google.com", sub: "g1", name: "Ada", email: "ada@example.test", added: "2026-11-20T10:00:00Z", current: true }], recent: true, recovery: !later };
    };
    const config = GUEST_YAML.replace("  required: false\n", "  required: false\n  providers: [google, apple]\n");
    const { document: doc, Event, mount, asked } = boot({ config, ways });
    localStorage.setItem("pronto-token", JSON.stringify({ token: "tok", user: { id: "u1", handle: "Ada-3fa2", email: "ada@example.test" } }));
    const { createShell } = await import("./shell.js");
    createShell({ config: "./shell.yaml", mount });
    await settle(300);
    const assert = check(mount);
    const panel = doc.querySelector("nav #shell-account-panel");
    assert(!panel.hidden, "asked, the panel opens itself after the sign-in");
    const section = panel.querySelector(".shell-ways");
    assert(section.nextElementSibling === panel.querySelector(".shell-signout"), "the ways sit above Sign out");
    assert(!section.querySelector(".shell-recovery").hidden, "Set up recovery is asked");
    const listed = [...section.querySelectorAll(".shell-way")];
    assert(listed.length === 1 && listed[0].querySelector(".shell-way-name").textContent === "Google", "its one way in, named by the provider");
    assert(listed[0].querySelector(".shell-way-detail").textContent === "This device", "the way this device came in by");
    assert(!listed[0].querySelector(".shell-way-remove"), "the last way in has no Remove");
    const offered = [...section.querySelectorAll(".shell-way-add .shell-way-provider")].map((b) => b.dataset.provider);
    assert(offered.join("|") === "apple", `a provider it has no link of is offered, got ${offered}`);
    section.querySelector(".shell-later").dispatchEvent(new Event("click", { bubbles: true }));
    await settle(100);
    assert(asked.includes("POST /auth/ways/later") && section.querySelector(".shell-recovery").hidden, "Not now puts the question off");
  },
});

Deno.test({
  name: "ways whose sign-in is not recent offer no change, only the sign-in that would allow one, and a device without its session cookie shows none",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { document: doc, Event, mount } = boot({ config: GUEST_YAML });
    localStorage.setItem("pronto-token", JSON.stringify({ token: "tok", user: { id: "u1", handle: "Ada-3fa2" }, passkey: { rpId: "localhost", userId: "dTE" } }));
    const { createShell } = await import("./shell.js");
    createShell({ config: "./shell.yaml", mount });
    await settle(300);
    const assert = check(mount);
    const panel = doc.querySelector("nav #shell-account-panel");
    assert(panel.hidden, "not asked, the panel stays shut");
    doc.querySelector("nav .shell-me > .shell-person").dispatchEvent(new Event("click", { bubbles: true }));
    await settle(100);
    const section = panel.querySelector(".shell-ways");
    assert(section.querySelector(".shell-way-add").hidden, "nothing to add on a stale sign-in");
    assert(section.querySelector(".shell-ways-note").textContent === "Sign in again to change these.", "and it says what would allow it");
  },
});

Deno.test({
  name: "a stored guest recovers its device cookie without losing local work",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { mount } = boot({ config: GUEST_YAML, cookie: "mecha_session_hint=1" });
    const held = { token: "tok-old", user: { id: "g1", handle: "guest", guest: true }, committed: true, shown: true };
    localStorage.setItem("pronto-token", JSON.stringify(held));
    const previous = globalThis.fetch;
    let adopted = 0;
    globalThis.fetch = (url, init) => {
      const path = String(url);
      if (path.endsWith("/auth/session")) return Promise.resolve(new Response(null, { status: 401 }));
      if (path.endsWith("/auth/session/adopt")) {
        adopted++;
        if (init.headers.Authorization !== "Bearer tok-old") throw new Error("adoption lost the guest's bearer");
        return Promise.resolve(Response.json({ ...held, token: "tok-fresh", committed: undefined, shown: undefined }));
      }
      if (path.includes("/crud/app_user")) return Promise.resolve(Response.json([{ id: "g1" }]));
      return previous(url, init);
    };
    const { createShell } = await import("./shell.js");
    createShell({ config: "./shell.yaml", mount });
    await settle(300);
    const assert = check(mount);
    const stored = JSON.parse(localStorage.getItem("pronto-token"));
    assert(adopted === 1, "boot adopts the guest once");
    assert(stored.token === "tok-fresh" && stored.committed && stored.shown, "renewal retains the guest's work and presentation");
  },
});

Deno.test("guest cookie recovery respects a concurrent sign-in, refuses expired bearers and retries after network failure", async () => {
  const { adoptDeviceSession } = await import("./signin.js");
  for (const outcome of ["race", "expired", "offline"]) {
    const { mount } = boot({ cookie: "mecha_session_hint=1" });
    const assert = check(mount);
    const held = { token: "guest-token", user: { id: "g1", guest: true }, committed: true };
    localStorage.setItem("pronto-token", JSON.stringify(held));
    let reads = 0;
    let attempts = 0;
    globalThis.fetch = (url) => {
      if (String(url).endsWith("/session/adopt")) {
        attempts++;
        if (outcome === "offline" && attempts === 1) return Promise.reject(new TypeError("offline"));
        if (outcome === "offline") return Promise.resolve(Response.json({ ...held, token: "fresh" }));
        return Promise.resolve(new Response(null, { status: outcome === "race" ? 409 : 401 }));
      }
      if (String(url).endsWith("/session")) {
        reads++;
        return Promise.resolve(outcome === "race" && reads === 2
          ? Response.json({ token: "account-token", user: { id: "person" } })
          : new Response(null, { status: 401 }));
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const result = await adoptDeviceSession({ auth: { service: "/auth" } });
    if (outcome === "race") {
      assert(result.user.id === "person" && !result.committed, "concurrent sign-in wins without inheriting guest metadata");
    } else {
      assert(result === null && localStorage.getItem("pronto-token") === JSON.stringify(held), "failed adoption does not overwrite the stored guest");
      if (outcome === "offline") {
        const retried = await adoptDeviceSession({ auth: { service: "/auth" } });
        assert(retried.token === "fresh" && retried.committed, "a subsequent boot retries recovery");
      }
    }
  }
});

Deno.test("a late guest recovery cannot overwrite a newer stored sign-in and adoption errors name their endpoint", async () => {
  const { adoptDeviceSession } = await import("./signin.js");
  for (const outcome of ["late", "late-refusal", "error"]) {
    const { mount, jar } = boot({ cookie: "mecha_session_hint=1" });
    const assert = check(mount);
    const guest = { token: "guest", user: { id: "guest", guest: true } };
    const person = { token: "account", user: { id: "person" } };
    localStorage.setItem("pronto-token", JSON.stringify(guest));
    globalThis.fetch = (url) => {
      if (String(url).endsWith("/session")) return Promise.resolve(new Response(null, { status: 401 }));
      if (String(url).endsWith("/session/adopt")) {
        if (outcome === "error") return Promise.resolve(new Response(null, { status: 503 }));
        localStorage.setItem("pronto-token", JSON.stringify(person));
        return Promise.resolve(outcome === "late-refusal" ? new Response(null, { status: 401 }) : Response.json(guest));
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    if (outcome !== "error") {
      assert(await adoptDeviceSession({ auth: { service: "/auth" } }) === null, "a stale response does not supply the boot's session");
      assert(localStorage.getItem("pronto-token") === JSON.stringify(person), "the newer account is retained");
      assert(jar() === "mecha_session_hint=1", "the newer session hint is retained");
    } else {
      let failure;
      try { await adoptDeviceSession({ auth: { service: "/auth" } }); } catch (error) { failure = error; }
      assert(failure?.message === "503 POST /auth/session/adopt", `wrong adoption failure: ${failure}`);
    }
  }
});
