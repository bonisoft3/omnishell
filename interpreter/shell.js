// createShell: the omnishell entry for pronto-emitted apps. Reads the file
// map (shell.yaml), boots the store, mounts the route matching the location
// hash, and hands the screen to the interpreter. No build step exists on
// this path by design.
//
// The store is the local virtual cluster through the /crud gateway (sayt
// launch). `?storybook` renders every storyboard state against fixtures
// instead.
//
// Auth (cfg.auth: {required, service}): the login screen is terminal chrome,
// driving the WebAuthn ceremony or the guest mint against the auth service
// and stashing {token, user} in sessionStorage["pronto-token"]. Storybook
// bypasses it entirely: the fixture tier runs without the cluster, so no auth
// service exists to sign against.

import { load } from "./vendor/js-yaml.js";
import { interpretScreen } from "./screen.js";

/** Whether the account a stored token names still exists.
 *
 * Deliberately fails OPEN: a cluster that cannot be reached is a cluster that
 * cannot answer the question, and signing somebody out because their wifi
 * dropped would be a worse bug than the one this prevents. Only a definite
 * empty answer — the request succeeded and the row is not there — ends the
 * session.
 */
async function accountLives(session) {
  const sub = claimsOf(session.token)?.sub;
  if (!sub) return true;
  try {
    const res = await fetch(`/crud/app_user?id=eq.${encodeURIComponent(sub)}&select=id&limit=1`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    // A refused token is a dead session, however live its account.
    if (res.status === 401) return false;
    if (!res.ok) return true;
    return (await res.json()).length > 0;
  } catch {
    return true;
  }
}

/** The JWT payload, or null if it is not one. */
function claimsOf(token) {
  try {
    const part = String(token).split(".")[1];
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.text();
}

// WebAuthn wire format: the auth service speaks @simplewebauthn JSON
// (base64url strings) while navigator.credentials wants ArrayBuffers.
const bufFromB64u = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer;
const b64uFromBuf = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`${res.status} POST ${url}${detail ? `: ${detail}` : ""}`);
  }
  return res.json();
}

// Both ceremonies are usernameless by terminal doctrine (one tap; identity
// is generated server-side): POST {service}/<kind>/start {} → the WebAuthn
// options object flat, plus `state` (the server's stateless challenge JWT,
// echoed back verbatim); then POST {service}/<kind>/verify
// {state, response} → {token, user}.
async function registerCeremony(service) {
  const { state, ...options } = await postJson(`${service}/register/start`, {});
  const cred = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: bufFromB64u(options.challenge),
      user: { ...options.user, id: bufFromB64u(options.user.id) },
      excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({
        ...c,
        id: bufFromB64u(c.id),
      })),
    },
  });
  return postJson(`${service}/register/verify`, {
    state,
    response: {
      id: cred.id,
      rawId: b64uFromBuf(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      response: {
        clientDataJSON: b64uFromBuf(cred.response.clientDataJSON),
        attestationObject: b64uFromBuf(cred.response.attestationObject),
        transports: cred.response.getTransports?.() ?? [],
      },
    },
  });
}

async function loginCeremony(service) {
  const { state, ...options } = await postJson(`${service}/login/start`, {});
  const cred = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: bufFromB64u(options.challenge),
      allowCredentials: (options.allowCredentials ?? []).map((c) => ({
        ...c,
        id: bufFromB64u(c.id),
      })),
    },
  });
  return postJson(`${service}/login/verify`, {
    state,
    response: {
      id: cred.id,
      rawId: b64uFromBuf(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: b64uFromBuf(cred.response.clientDataJSON),
        authenticatorData: b64uFromBuf(cred.response.authenticatorData),
        signature: b64uFromBuf(cred.response.signature),
        userHandle: cred.response.userHandle ? b64uFromBuf(cred.response.userHandle) : undefined,
      },
    },
  });
}

// Resolves {token, user} once a ceremony succeeds; failures surface inline
// and leave the form live for another attempt.
function renderLogin(mount, cfg) {
  const wrap = document.createElement("div");
  wrap.className = "shell-login";
  wrap.innerHTML = `<form>
    <h1></h1>
    <p class="login-hint">One tap with your passkey — new here, one is created for you.</p>
    <p class="login-error" hidden></p>
    <button type="submit">Continue</button>
    <button type="button" class="login-guest">Continue as guest</button>
  </form>`;
  wrap.querySelector("h1").textContent = cfg.app;
  mount.replaceChildren(wrap);
  return new Promise((resolve) => {
    const form = wrap.querySelector("form");
    const error = wrap.querySelector(".login-error");
    // Register and login are one gesture: attempt the discoverable get; when
    // no resident credential materializes (NotAllowedError covers both "none"
    // and "canceled" — the platform does not distinguish, by design), fall
    // through to creating one.
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.setAttribute("hidden", "");
      try {
        resolve(await loginCeremony(cfg.auth.service));
      } catch (loginErr) {
        console.error(loginErr);
        try {
          resolve(await registerCeremony(cfg.auth.service));
        } catch (err) {
          console.error(err);
          error.textContent = String(err?.message ?? err);
          error.removeAttribute("hidden");
        }
      }
    });
    // Guest is terminal doctrine, rendered unconditionally: passkey ceremonies
    // verify the server-pinned WEBAUTHN_ORIGIN, so on any other origin this is
    // the only door that opens. Each click mints a fresh generated identity.
    wrap.querySelector(".login-guest").addEventListener("click", async () => {
      error.setAttribute("hidden", "");
      try {
        resolve(await postJson(`${cfg.auth.service}/guest`, {}));
      } catch (err) {
        console.error(err);
        error.textContent = String(err?.message ?? err);
        error.removeAttribute("hidden");
      }
    });
  });
}

// The signed-in person, at the end of the nav strip: who they are, the way to
// their own page, and the way out. `cfg.auth.self` is the app naming that page
// — `path` is a route whose :params are filled from the session user, `name`
// the table and column their chosen name lives in. An app with no page for a
// person declares no `self`, and the handle stands on its own.
function renderSession(session, cfg, store, signOut) {
  const box = document.createElement("span");
  box.className = "shell-me";

  const self = cfg.auth?.self;
  const who = document.createElement(self === undefined ? "span" : "a");
  who.className = "shell-who";
  if (self !== undefined) {
    who.href = `#${self.path.replace(/:(\w+)/g, (_, k) => encodeURIComponent(session.user[k]))}`;
  }
  const name = document.createElement("span");
  name.className = "name";
  const handle = document.createElement("span");
  handle.className = "handle";
  handle.textContent = session.user.handle;
  who.append(name, handle);

  const out = document.createElement("a");
  out.className = "shell-signout";
  out.href = "#";
  out.textContent = "sign out";
  out.addEventListener("click", (e) => {
    e.preventDefault();
    signOut();
  });
  box.append(who, out);

  // The strip is one of the places a person appears, so a rename has to reach
  // it the way it reaches a byline: read live, not stamped from the token,
  // whose claims are fixed for the session.
  if (self?.name !== undefined) {
    const paint = async () => {
      const [row] = await store.query(self.name.table, undefined, {
        filter: `id=eq.${session.user.id}`,
      });
      name.textContent = row?.[self.name.column] ?? "";
    };
    store.subscribe(self.name.table, paint);
    paint();
  }
  return box;
}

export async function createShell({ config, mount }) {
  const banner = (err) => {
    mount.replaceChildren();
    const pre = document.createElement("pre");
    pre.style.cssText = "color:#B8422E;padding:16px;white-space:pre-wrap";
    pre.textContent = String(err?.stack ?? err);
    mount.append(pre);
  };
  // The banner is a boot-failure surface only. Once a screen is mounted, a
  // stray rejection (a severed gateway killing an in-flight fetch anywhere in
  // the data plane) must never replace live DOM — the screen's own state
  // machine degrades to network-error and its forms keep working.
  let booted = false;
  addEventListener("unhandledrejection", (e) => {
    if (!booted) {
      banner(e.reason);
      return;
    }
    e.preventDefault();
    console.error(e.reason);
    // Only the screen on show: the stack holds the others hidden beside it.
    mount.querySelector(":scope > :not([hidden]) .screen")?.setAttribute("data-state", "network-error");
  });

  try {
    const configUrl = new URL(config, location.href);
    const appBase = new URL("..", configUrl);
    const cfg = load(await fetchText(configUrl));
    document.title = cfg.app;

    const search = new URLSearchParams(location.search);
    // Route patterns may contain :name segments, each matching exactly one
    // non-empty path segment; matched values arrive decoded as route params.
    const matchRoute = (pattern, path) => {
      const ps = pattern.split("/");
      const xs = path.split("/");
      if (ps.length !== xs.length) return null;
      const params = {};
      for (let i = 0; i < ps.length; i++) {
        if (ps[i].startsWith(":") && xs[i]) params[ps[i].slice(1)] = decodeURIComponent(xs[i]);
        else if (ps[i] !== xs[i]) return null;
      }
      return params;
    };
    const currentRoute = () => {
      const path = location.hash.slice(1) || "/";
      for (const r of cfg.routes) {
        const params = matchRoute(r.path, path);
        if (params) return { route: r, params };
      }
      throw new Error(`no route for ${path}`);
    };

    if (search.has("storybook")) {
      const { renderStorybook } = await import("./storybook.js");
      const { route, params } = currentRoute();
      await renderStorybook(mount, appBase, route, params, cfg.units ?? {});
      return;
    }

    let session = null;
    if (cfg.auth?.required) {
      const stored = sessionStorage.getItem("pronto-token");
      // A stored token is not a session. The account it names can be gone —
      // the row dropped, the database recreated — and nothing about the token
      // says so: it is still correctly signed and unexpired, reads are public
      // so every screen still paints, and only writes fail, as a foreign key
      // violation (23503, "Key is not present in table app_user") behind copy
      // that says "try again". Retrying cannot work. One read at boot is
      // cheaper than that experience, and it is the read the auth plane
      // guarantees: app_user is the cluster's own table, written by the auth
      // service itself, so this holds for any app on this terminal.
      if (stored && !(await accountLives(JSON.parse(stored)))) {
        sessionStorage.removeItem("pronto-token");
      }
      const live = sessionStorage.getItem("pronto-token");
      if (live) {
        session = JSON.parse(live);
      } else {
        session = await renderLogin(mount, cfg);
        // The gate takes its own chrome down. The navigation stack appends
        // each screen beside whatever is already mounted rather than replacing
        // it, so nothing else will: left here, the login form outlives the
        // sign-in it gated and sits above every screen for the session.
        mount.replaceChildren();
        sessionStorage.setItem("pronto-token", JSON.stringify(session));
      }
    }

    const { createStore } = await import("./data-crud.js");
    const store = createStore("", { ...cfg, appBase });

    // The navigation stack belongs to the terminal — there is one back button,
    // so no screen can own it. A screen the user leaves keeps its DOM, hidden
    // in place, and lets go of its subscriptions: the shapes close on
    // schedule, and coming back repaints from what is already rendered before
    // the refresh lands. route.keep is how many instances of a route survive
    // that way; 0 rebuilds on every visit.
    const held = new Map();
    let current = null;
    let seq = 0;
    const raf = (fn) => (globalThis.requestAnimationFrame ?? ((f) => setTimeout(f, 0)))(fn);
    // The arriving-screen slot, released a frame later so the browser has a
    // style to transition from (the design layer's .shell-screen rules).
    const enter = (el) => {
      el.dataset.entering = "";
      raf(() => raf(() => delete el.dataset.entering));
    };
    const keepOf = (route) => route.keep ?? 1;
    const keyOf = (route, params) => `${route.screen} ${JSON.stringify(params)}`;

    const discard = (entry) => {
      entry.handle.stop();
      entry.el.remove();
      held.delete(entry.key);
    };

    // Parametrized routes would otherwise accumulate one screen per id ever
    // visited, so a route holds only its most recently shown instances.
    const evict = (route) => {
      const mine = [...held.values()]
        .filter((e) => e.route.screen === route.screen && e !== current)
        .sort((a, b) => b.seq - a.seq);
      for (const e of mine.slice(Math.max(keepOf(route) - 1, 0))) discard(e);
    };

    // Signing out lands on the door with nothing of the session left standing.
    // The chrome comes down here because the stack appends rather than
    // replaces, so nothing else would take it down; the document is then
    // replaced because the screens' subscriptions and the store's token are
    // the session too, and re-gating in place would keep both.
    let nav = null;
    const signOut = () => {
      for (const entry of [...held.values()]) discard(entry);
      current = null;
      nav?.remove();
      mount.replaceChildren();
      sessionStorage.removeItem("pronto-token");
      location.reload();
    };

    // Parametrized routes have no static href; they are reached from rows. A
    // route may also take itself off the strip, when it is reached from
    // somewhere more specific than "everywhere".
    const navRoutes = cfg.routes.filter((r) => !r.path.includes(":") && r.nav.strip !== false);
    if (navRoutes.length > 1 || session) {
      nav = document.createElement("nav");
      for (const r of navRoutes) {
        const a = document.createElement("a");
        a.href = `#${r.path}`;
        a.textContent = r.nav.label;
        nav.append(a);
      }
      if (session) nav.append(renderSession(session, cfg, store, signOut));
      mount.before(nav);
    }

    const show = async (navigationType = "push") => {
      const { route, params } = currentRoute();
      // The strip's state is an attribute, not a style: aria-current names
      // the link that is this page (none, on parametrized routes) and CSS
      // decides what that looks like.
      for (const a of nav?.querySelectorAll("a") ?? []) {
        if (a.getAttribute("href") === `#${route.path}`) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
      }
      const key = keyOf(route, params);
      if (current) {
        current.scrollY = window.scrollY;
        current.handle.pause();
        current.el.hidden = true;
        if (keepOf(current.route) === 0) discard(current);
        current = null;
      }
      const entry = held.get(key);
      if (entry !== undefined) {
        entry.seq = ++seq;
        entry.el.hidden = false;
        enter(entry.el);
        current = entry;
        evict(route);
        // Following a link to a screen visited before is a fresh arrival
        // however warm its DOM is, and an arrival starts at the top; going
        // back resumes. Only "push" is treated as an arrival, so the
        // hashchange fallback — which cannot tell the two apart and says
        // "unknown" — keeps resuming, the better half to be wrong on: a back
        // button that jumps to the top is worse than a link that remembers.
        window.scrollTo(0, navigationType === "push" ? 0 : entry.scrollY);
        await entry.handle.resume();
        return;
      }
      const el = document.createElement("div");
      el.className = "shell-screen";
      el.dataset.entering = "";
      mount.append(el);
      const fresh = { key, el, route, scrollY: 0, seq: ++seq };
      held.set(key, fresh);
      current = fresh;
      evict(route);
      fresh.handle = await interpretScreen(el, appBase, route, store, params, { units: cfg.units });
      // A screen arrived at starts at its own top. This lands there anyway
      // today, but only because hiding the outgoing screen collapses the page
      // and the browser clamps — an accident of ordering that any overlap of
      // the two screens would undo, and a cross-fade needs exactly that
      // overlap.
      window.scrollTo(0, 0);
      // Released only once the screen has content, so the fade covers the
      // fetch rather than racing it.
      enter(el);
    };
    // The Navigation API is the platform's own navigation stack, and the only
    // thing that can tell a push from a traverse — which is what decides
    // whether a held screen resumes its scroll. It also takes scroll policy as
    // configuration: "manual", because the stack owns scroll and the browser
    // cannot know that a held screen is already painted at the right offset.
    // hashchange stays as the fallback and cannot distinguish the two, so it
    // calls everything a push, which is the safe half.
    if ("navigation" in globalThis) {
      navigation.addEventListener("navigate", (e) => {
        if (!e.canIntercept || e.downloadRequest !== null || e.formData) return;
        // The stack owns same-document navigation and nothing else. canIntercept
        // is true for a reload and for any same-origin document navigation too,
        // and intercepting one of those turns a document replacement into a
        // re-render of the screen already on show — which would leave sign-out,
        // whose whole job is to replace the document, doing nothing visible.
        if (!e.destination.sameDocument) return;
        e.intercept({scroll: "manual", handler: () => show(e.navigationType)});
      });
    } else {
      addEventListener("hashchange", () => show("unknown"));
    }
    await show();
    booted = true;
  } catch (err) {
    console.error(err);
    banner(err);
  }
}
