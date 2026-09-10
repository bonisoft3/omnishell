// Deno smoke: the terminal owns the strip that names the signed-in person and
// the control that ends the session, so it owns landing them back on the door.
// The WebAuthn ceremony is not exercised —
// the guest door needs no authenticator, which is what makes this drivable
// here, as in login-smoke.
import { parseHTML } from "npm:linkedom@0.18.4";

const CONFIG_YAML = `
app: smoke
auth:
  required: true
  service: /auth
  self:
    path: /profile/:handle
    name: {table: app_user, column: display_name}
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

function boot() {
  const { document, Event } = parseHTML(
    "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
  );
  globalThis.document = document;
  globalThis.window = globalThis;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.addEventListener = () => {};
  globalThis.scrollTo = () => {};
  Object.defineProperty(globalThis, "scrollY", { get: () => 0, configurable: true });

  let onNavigate = null;
  globalThis.navigation = {
    addEventListener: (ev, fn) => {
      if (ev === "navigate") onNavigate = fn;
    },
  };

  const app = { reloaded: false, intercepted: false };
  Object.defineProperty(globalThis, "location", {
    value: {
      href: "http://localhost:8080/shell/",
      search: "",
      hash: "",
      reload: () => (app.reloaded = true),
    },
    configurable: true,
  });

  sessionStorage.clear();
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.endsWith("shell.yaml")) return Promise.resolve(new Response(CONFIG_YAML));
    if (u.endsWith("/auth/guest")) {
      return Promise.resolve(
        new Response(JSON.stringify({ token: "t", user: { id: "u1", handle: "sunlit-fox-01" } }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.includes("/crud/app_user")) {
      return Promise.resolve(
        new Response(JSON.stringify([{ id: "u1", display_name: "Ada" }]), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.endsWith("home.html")) return Promise.resolve(new Response(screenHtml("home")));
    if (u.endsWith(".css")) return Promise.resolve(new Response(""));
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  };

  return Object.assign(app, {
    document,
    Event,
    mount: document.getElementById("shell"),
    signIn() {
      const guest = [...this.mount.querySelectorAll(".shell-login button")].find(
        (b) => b.textContent === "Continue as guest",
      );
      if (!guest) throw new Error("smoke failed: no guest button");
      guest.dispatchEvent(new Event("click", { bubbles: true }));
    },
    // The navigate event as the platform raises it for something that replaces
    // the document: a reload, or a link off the hash routes.
    async leaveDocument() {
      await onNavigate({
        canIntercept: true,
        downloadRequest: null,
        formData: null,
        navigationType: "reload",
        destination: { url: "http://localhost:8080/shell/", sameDocument: false },
        intercept: () => (app.intercepted = true),
      });
    },
  });
}

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

async function signedIn() {
  const app = boot();
  const { createShell } = await import("./shell.js");
  createShell({ config: "./shell.yaml", mount: app.mount });
  await settle();
  app.signIn();
  await settle(240);
  return app;
}

Deno.test({
  name: "signing out leaves nothing of the session on screen",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await signedIn();
    assert(app.document.querySelector("nav") !== null, "the strip is up before signing out");
    assert(app.mount.querySelector(".shell-screen") !== null, "a screen is up before signing out");

    const out = app.document.querySelector("nav .shell-signout");
    assert(out !== null, "sign out is in the strip");
    out.dispatchEvent(new app.Event("click", { bubbles: true }));
    await settle();

    // The stack appends its screens beside whatever is already mounted rather
    // than replacing it, so nothing takes the session's chrome down unless
    // sign-out does: left alone, the reader is signed out into the screen and
    // the strip they were already looking at, and sees no change at all.
    assert(sessionStorage.getItem("pronto-token") === null, "the token is gone");
    assert(app.document.querySelector("nav") === null, "the strip went with the session");
    assert(
      app.mount.querySelector(".shell-screen") === null,
      `a screen outlived the session\n${app.mount.innerHTML}`,
    );
    // The screens' subscriptions and the store's token are the session too, and
    // only replacing the document is rid of them.
    assert(app.reloaded, "the door is a fresh document");
  },
});

Deno.test({
  name: "the signed-in person is named, and their name leads to their own page",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await signedIn();
    const who = app.document.querySelector("nav a.shell-who");
    assert(who !== null, "the person's name in the strip is a link");
    assert(
      who.getAttribute("href") === "#/profile/sunlit-fox-01",
      `links to ${who.getAttribute("href")}, not the person's own page`,
    );
    assert(
      who.querySelector(".handle").textContent === "sunlit-fox-01",
      "the handle names them",
    );
    // A rename has to reach the strip the way it reaches a byline, so the name
    // is read live rather than taken from the token, whose claims are fixed for
    // the session.
    assert(
      who.querySelector(".name").textContent === "Ada",
      `the strip reads ${JSON.stringify(who.querySelector(".name").textContent)}, not the name they set`,
    );
  },
});

Deno.test({
  name: "the stack lets a navigation that replaces the document through",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await signedIn();
    await app.leaveDocument();
    // canIntercept is true for a reload as well as for a hash change.
    // Intercepting it turns the document replacement into a re-render of the
    // screen already on show, and sign-out's reload never happens.
    assert(!app.intercepted, "the stack intercepted a navigation that leaves the document");
  },
});
