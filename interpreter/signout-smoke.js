// Deno smoke: the terminal owns the strip that names the signed-in person and
// the control that ends the session, so it owns landing them back on the door.
// The WebAuthn ceremony is not exercised —
// the guest door needs no authenticator, which is what makes this drivable
// here, as in login-smoke.
import { parseHTML } from "npm:linkedom@0.18.4";

import { FIXTURE_CARRIERS } from "./fixture-types.js";

// The table a program emits into the shell this smoke serves; YAML reads the
// JSON spelling, so it rides in whole.
const CONFIG_YAML = `
carriers: ${JSON.stringify(FIXTURE_CARRIERS)}
app: smoke
auth:
  required: true
  service: /auth
  self:
    route: profile
    name: {table: app_user, column: display_name}
i18n:
  default: pt-BR
  locales:
    pt-BR: {path: pt-br}
tables: [app_user]
schema:
  app_user:
    durability: live
    fields:
      - {name: id, type: string}
      - {name: display_name, type: string}
routes:
  - path: /
    screen: home
    nav: {label: Home, key: nav_home}
    files: {html: shell/screens/home.html, css: shell/screens/home.css, handlers: []}
  - path: /other
    screen: other
    nav: {label: Other, key: nav_other}
    files: {html: shell/screens/other.html, css: shell/screens/other.css, handlers: []}
  - path: /profile/:handle
    screen: profile
    nav: {label: Profile, key: nav_profile}
    files: {html: shell/screens/profile.html, css: shell/screens/profile.css, handlers: []}
`;

const CATALOGUE = { chrome_signout: "sair", nav_home: "Início", nav_other: "Outra", nav_profile: "Perfil" };

const screenHtml = (name) => `<section class="screen" data-screen="${name}"><h2>${name}</h2></section>`;

let boots = 0;
function boot(at = "/") {
  const origin = `http://localhost:${8080 + ++boots}`;
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
      href: `${origin}${at}`,
      origin,
      pathname: at,
      search: "",
      hash: "",
      reload: () => (app.reloaded = true),
    },
    configurable: true,
  });

  sessionStorage.clear();
  const profile = { id: "u1", display_name: "Ada", txid: "1" };
  const handle = `profile-${boots}`;
  let offset = 1;
  const changes = [];
  let wake;
  const message = operation => ({
    key: '"public"."app_user"/"u1"',
    value: { ...profile },
    headers: { operation, relation: ["public", "app_user"] },
  });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("shell.yaml")) return Promise.resolve(new Response(CONFIG_YAML));
    if (u.endsWith("/auth/guest")) {
      return Promise.resolve(
        new Response(JSON.stringify({ token: "t", user: { id: "u1", handle: "sunlit-fox-01" } }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (u.endsWith("/auth/shape")) {
      return Response.json({ token: "shape-token", where: "id = 'u1'", expires_in: 900 });
    }
    if (u.includes("/electric/v1/shape")) {
      const query = new URL(u).searchParams;
      let batch;
      if (query.get("live") === "true") {
        if (!changes.length) await new Promise((resolve, reject) => {
          wake = resolve;
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
        wake = undefined;
        batch = changes.splice(0);
      } else {
        batch = [message("insert")];
      }
      return Response.json([...batch, { headers: { control: "up-to-date", global_last_seen_lsn: String(offset) } }], {
        headers: {
          "electric-handle": handle,
          "electric-offset": `0_${offset}`,
          "electric-cursor": String(offset),
          "electric-schema": JSON.stringify({ id: { type: "text" }, display_name: { type: "text" }, txid: { type: "int8" } }),
        },
      });
    }
    if (u.includes("/messages/")) return Promise.resolve(new Response(JSON.stringify(CATALOGUE)));
    if (u.endsWith("home.html")) return Promise.resolve(new Response(screenHtml("home")));
    if (u.endsWith(".css")) return Promise.resolve(new Response(""));
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  };

  return Object.assign(app, {
    document,
    Event,
    mount: document.getElementById("shell"),
    rename(name) {
      profile.display_name = name;
      profile.txid = String(++offset);
      changes.push(message("update"));
      wake?.();
    },
    signIn() {
      const guest = [...this.mount.querySelectorAll(".shell-login button")].find(
        (b) => b.textContent === "Continue as guest",
      );
      if (!guest) throw new Error("smoke failed: no guest button");
      guest.dispatchEvent(new Event("click", { bubbles: true }));
    },
    // The navigate event as the platform raises it for something that replaces
    // the document: a reload, or a link off this app's routes.
    async leaveDocument() {
      await onNavigate({
        canIntercept: true,
        downloadRequest: null,
        formData: null,
        navigationType: "reload",
        destination: { url: `${origin}/shell/`, sameDocument: false },
        intercept: () => (app.intercepted = true),
      });
    },
  });
}

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};
const assertRejects = async (fn, expectedMsg) => {
  let threw = null;
  try {
    await fn();
  } catch (err) {
    threw = err;
  }
  if (!threw) throw new Error("smoke failed: expected promise to reject");
  if (expectedMsg && !threw.message?.includes(expectedMsg)) {
    throw new Error(`smoke failed: expected message ${expectedMsg}, got ${threw.message}`);
  }
};

async function signedIn(at) {
  const app = boot(at);
  const { createShell } = await import("./shell.js");
  app.booting = createShell({ config: "./shell.yaml", mount: app.mount });
  // Mark the promise handled so the guest sign-in ceremony can settle before the test asserts on boot settlement
  app.booting.catch(() => {});
  await settle();
  app.signIn();
  await settle(240);
  if (at !== "/nowhere") {
    await app.booting;
  }
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
  name: "the way out is a word even at an address the app has no route for",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // The strip hangs beside the mount, so it survives the banner show() raises
    // when currentRoute() finds no route — and localizeStrip, which writes this
    // word on every navigation, is past that throw. Written once at creation
    // too, or the only way out of a session is an anchor with nothing in it.
    const app = await signedIn("/nowhere");
    await assertRejects(() => app.booting, "no route for /nowhere");
    const out = app.document.querySelector("nav .shell-signout");
    assert(out !== null, "the strip is up even where the route is not");
    assert(out.textContent !== "", `the way out reads ${JSON.stringify(out.textContent)}`);
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
      who.getAttribute("href") === "/profile/sunlit-fox-01",
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
    app.rename("Augusta");
    await settle();
    assert(who.querySelector(".name").textContent === "Augusta", "a remote profile rename reaches the strip");
  },
});

Deno.test({
  name: "the strip's words are the page's language, and the person is not one of them",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await signedIn();
    const out = app.document.querySelector("nav .shell-signout");
    assert(out.textContent === CATALOGUE.chrome_signout, `the way out reads ${JSON.stringify(out.textContent)}`);
    assert(app.document.querySelector('nav > a[data-route="home"]').textContent === "Início", "the strip is localized");
    // The person's own anchor names a route too, so a label pass that asked the
    // route table for every `a[data-route]` in the strip would find it and
    // write a word over the name and handle it holds — the only place a signed
    // in reader is told who they are.
    const who = app.document.querySelector("nav a.shell-who");
    assert(who.querySelector(".handle")?.textContent === "sunlit-fox-01", `the handle is ${who.innerHTML}`);
    assert(who.querySelector(".name")?.textContent === "Ada", `the name is ${who.innerHTML}`);
  },
});

Deno.test({
  name: "the stack lets a navigation that replaces the document through",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = await signedIn();
    await app.leaveDocument();
    // canIntercept is true for a reload as well as for a route change.
    // Intercepting it turns the document replacement into a re-render of the
    // screen already on show, and sign-out's reload never happens.
    assert(!app.intercepted, "the stack intercepted a navigation that leaves the document");
  },
});
