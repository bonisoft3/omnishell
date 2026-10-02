// createShell: the omnishell entry for pronto-emitted apps. Reads the file
// map (shell.yaml), boots the store, mounts the route matching the location
// path, and hands the screen to the interpreter. No build step exists on
// this path by design.
//
// The store is the local virtual cluster through the /crud gateway (sayt
// launch). `?storybook` renders every storyboard state against fixtures
// instead.
//
// Auth (cfg.auth: {required, service}): the login screen is terminal chrome,
// driving the WebAuthn ceremony or the guest mint against the auth service
// and stashing {token, user} in sessionStorage["pronto-token"]. Storybook
// bypasses it entirely: the fixture adapter runs without the cluster, so no auth
// service exists to sign against.

import { chromeText } from "./chrome.js";
import { directionOf, localeByPath, localeTable, resolveLocale, routeHref, routePattern, screenEnv } from "./fragment.js";
import { interpretScreen, routeParams } from "./screen.js";
import { compileCatalog } from "./vendor/messages.js";

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

// A screen's fade covers its first load. The cap is what keeps it from covering
// a load that never lands: one region whose read queues behind the shape
// long-polls is enough to leave the whole screen at opacity 0 for good.
const SCREEN_LOAD_CAP_MS = 2000;

// WebAuthn wire format: the auth service speaks @simplewebauthn JSON
// (base64url strings) while navigator.credentials wants ArrayBuffers.
const bufFromB64u = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer;
const b64uFromBuf = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function postJson(url, body, token) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
// {state, response} → {token, user}. A register started with a session's token
// gives that session's identity the passkey rather than minting a new one.
async function registerCeremony(service, token) {
  const { state, ...options } = await postJson(`${service}/register/start`, {}, token);
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

// Register and login are one gesture: attempt the discoverable get; when no
// resident credential materializes (NotAllowedError covers both "none" and
// "canceled" — the platform does not distinguish, by design), create one. Any
// other failure is the login's own and is not a reason to mint a passkey.
async function passkeyCeremony(service, token) {
  try {
    return await loginCeremony(service);
  } catch (err) {
    if (err?.name !== "NotAllowedError") throw err;
    return registerCeremony(service, token);
  }
}

// Resolves {token, user} once a ceremony succeeds; failures surface inline
// and leave the form live for another attempt. `chrome` answers the terminal's
// own copy in the reader's language.
function renderLogin(mount, cfg, chrome) {
  const wrap = document.createElement("div");
  wrap.className = "shell-login";
  // Every word is written in after the template rather than interpolated into
  // it: a catalogue is app data, and data spliced into markup is an injection
  // seam where a literal was none.
  wrap.innerHTML = `<form>
    <h1></h1>
    <p class="login-hint"></p>
    <p class="login-error" hidden></p>
    <button type="submit"></button>
    <button type="button" class="login-guest"></button>
  </form>`;
  wrap.querySelector("h1").textContent = cfg.app;
  wrap.querySelector(".login-hint").textContent = chrome("chrome_signin_hint");
  wrap.querySelector("button[type=submit]").textContent = chrome("chrome_signin");
  wrap.querySelector(".login-guest").textContent = chrome("chrome_signin_guest");
  mount.replaceChildren(wrap);
  return new Promise((resolve) => {
    const form = wrap.querySelector("form");
    const error = wrap.querySelector(".login-error");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.setAttribute("hidden", "");
      try {
        resolve(await passkeyCeremony(cfg.auth.service));
      } catch (err) {
        // What failed is the platform's own sentence, in whatever language
        // the browser threw it in and about a ceremony the reader did not
        // ask to know the shape of. It goes to the console, where it is
        // diagnosable; the reader is told, in theirs, that it did not work.
        console.error(err);
        error.textContent = chrome("chrome_signin_failed");
        error.removeAttribute("hidden");
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
        error.textContent = chrome("chrome_signin_failed");
        error.removeAttribute("hidden");
      }
    });
  });
}

// The signed-in person, at the end of the nav strip: who they are, the way to
// their own page, and the way out. `cfg.auth.self` is the app naming that page
// — `route` names it, its :params are filled from the session user, `name` is
// the table and column their chosen name lives in. An app with no page for a
// person declares no `self`, and the handle stands on its own.
function renderSession(session, cfg, store, signOut, chrome) {
  const box = document.createElement("span");
  box.className = "shell-me";

  // A guest has nothing to sign out of and a passkey to gain: one gesture
  // signs in to the passkey's account where the device has one, and otherwise
  // makes one of this guest, keeping what it wrote.
  if (session.user.guest && cfg.auth?.promote) {
    const signIn = document.createElement("button");
    signIn.type = "button";
    signIn.className = "shell-signin";
    // The word is the strip's to write in the page's language (localizeStrip);
    // the key says which word.
    signIn.dataset.key = "chrome_passkey";
    signIn.addEventListener("click", async () => {
      let next;
      try {
        next = await passkeyCeremony(cfg.auth.service, session.token);
      } catch (err) {
        console.error(err);
        signIn.dataset.key = "chrome_passkey_failed";
        signIn.textContent = chrome(signIn.dataset.key, document.documentElement.lang);
        return;
      }
      sessionStorage.setItem("pronto-token", JSON.stringify(next));
      location.reload();
    });
    box.append(signIn);
    return box;
  }

  const self = cfg.auth?.self;
  const who = document.createElement(self === undefined ? "span" : "a");
  who.className = "shell-who";
  if (self !== undefined) {
    const route = cfg.routes.find((r) => r.screen === self.route);
    if (route === undefined) throw new Error(`auth.self names "${self.route}", which is no route of this app`);
    // The person is fixed for the session; only the locale of their address
    // moves, so the strip's own pass composes the href (localizeStrip).
    who.dataset.route = self.route;
    for (const [, name] of route.path.matchAll(/:(\w+)/g)) {
      who.setAttribute(`data-param-${name}`, session.user[name]);
    }
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
  // Written twice on purpose. localizeStrip moves it to the page's language on
  // every navigation, like the labels beside it — but it runs from show(),
  // past a currentRoute() that throws on an address the app has no route for,
  // and the strip outlives that banner because it hangs beside the mount. The
  // only way out of a session may not be a control with no word on it.
  out.textContent = chrome("chrome_signout", cfg.i18n?.default);
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

// Route patterns may contain :name segments, each matching exactly one
// non-empty path segment; matched values arrive decoded as route params. The
// query string is folded in under its own names, so `?q=x` reaches a screen as
// {param.q}.
function matchRoute(pattern, path) {
  const [cleanPath, queryString] = path.split("?");
  const ps = pattern.split("/");
  const xs = cleanPath.split("/");
  if (ps.length !== xs.length) return null;
  const params = {};
  // The query is read FIRST so the pattern's own captures land over it: a
  // :param is part of the address and a query is what rode along beside it, so
  // /note/7?id=9 is note 7. Refusing the pair instead would let any pasted URL
  // take the screen down, which is not a visitor's to do.
  if (queryString) {
    for (const [k, v] of new URLSearchParams(queryString)) params[k] = v;
  }
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(":") && xs[i]) params[ps[i].slice(1)] = decodeURIComponent(xs[i]);
    else if (ps[i] !== xs[i]) return null;
  }
  return params;
}

/** An address without the path the app is mounted under, where it is mounted
 * under one (cfg.prefix): a project site serves it at /<repo>/, and the routes
 * are written from the root. routeHref puts the prefix back. */
function unprefixed(cfg, pathname) {
  const prefix = cfg.prefix ?? "";
  if (prefix === "" || pathname === prefix) return prefix === "" ? pathname : "/";
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : pathname;
}

/** The language an address is in, and what is left of it once a locale prefix
 * is taken off. Separate from routeAt because the chrome is drawn before any
 * route is mounted — the gate, the strip — and has to ask the same resolution
 * order: a second order is how an address and a screen come to disagree. */
function localeAt(cfg, pathname, search, preferred) {
  // Segment -> tag, so the first segment is asked of a map rather than guessed
  // from the shape of the word: anything the app does not declare is already a
  // slug of the default language.
  const byPath = localeByPath(cfg.i18n);
  const [, first, ...rest] = unprefixed(cfg, pathname).split("/");
  const prefixed = Object.hasOwn(byPath, first);
  const path = prefixed ? byPath[first] : undefined;
  const query = new URLSearchParams(search).get("lang") ?? undefined;
  return {
    rel: prefixed ? `/${rest.join("/")}` : unprefixed(cfg, pathname),
    path,
    query,
    // One resolver, so a row and an address cannot disagree about the language
    // a screen is in. navigator.languages is the browser's Accept-Language,
    // and loses to anything the reader was handed.
    locale: resolveLocale(cfg.i18n, { path, query, preferred }),
    // The language the ADDRESS is written in, which only the prefix decides:
    // /regras is Portuguese whatever ?lang= asks for, and the ask is honoured
    // by redirecting to /es/reglas rather than by matching it here.
    written: path ?? cfg.i18n?.default,
  };
}

/** What an address says, or null where it names no screen. The locale is part
 * of the answer: the first render is then correct rather than corrected, and
 * the screen never discovers its own language. `preferred` is the browser's
 * Accept-Language, passed in so this function decides nothing from ambient
 * state and can be asked about an address the terminal is not at. */
export function routeAt(cfg, pathname, search, preferred) {
  const { rel, path, query, locale, written } = localeAt(cfg, pathname, search, preferred);
  for (const r of cfg.routes) {
    const params = matchRoute(routePattern(r, written), rel + search);
    if (params === null) continue;
    // `lang` is the wire's name for a locale and dies at this boundary;
    // `locale` is the model's. It is set only where the ADDRESS decided — a
    // prefix, or a ?lang= naming a locale the app declares — which is what
    // leaves a row free to decide on a plain route, and what keeps an app
    // declaring no locales at all from carrying the key.
    delete params.lang;
    if (path !== undefined || (query !== undefined && locale === query)) params.locale = locale;
    return { route: r, params, locale, written };
  }
  return null;
}

/** Every catalogue the app declares, keyed by tag. A locale whose file does not
 * answer is left out of the map, and what reads it — a screen through
 * screenEnv, the chrome through chromeText — shows the copy it was written
 * with. */
async function loadMessages(appBase, i18n) {
  const messages = {};
  if (!i18n?.locales) return messages;
  await Promise.all(
    Object.keys(localeTable(i18n)).map(async (loc) => {
      try {
        const res = await fetch(new URL(`messages/${loc}.json`, appBase));
        if (res.ok) {
          messages[loc] = compileCatalog(await res.json());
        }
      } catch (_) {}
    }),
  );
  return messages;
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
    // Against the document's base, not the address it arrived under: one entry
    // answers at every route, so location.href is /games as readily as
    // /shell/, and resolving there asks for a shell.yaml beside the route.
    const configUrl = new URL(config, document.baseURI);
    const appBase = new URL("..", configUrl);
    const text = await fetchText(configUrl);
    const cfg = configUrl.pathname.endsWith(".json")
      ? JSON.parse(text)
      : (await import("./vendor/js-yaml.js")).load(text);
    document.title = cfg.app;

    const search = new URLSearchParams(location.search);
    // This app's own reading of an address, at the terminal's preferences.
    const addresses = (url) => routeAt(cfg, url.pathname || "/", url.search ?? "", globalThis.navigator?.languages);
    const currentRoute = () => {
      const found = addresses(location);
      if (found === null) throw new Error(`no route for ${location.pathname}`);
      return found;
    };

    // Ahead of the gate, not beside the screens: the terminal's own chrome is
    // drawn before any route is mounted and speaks the reader's language too.
    const messages = await loadMessages(appBase, cfg.i18n);
    // The terminal's own words, in whichever language the caller resolved: the
    // gate and the strip are both drawn before a screen is, so neither can take
    // a locale off one.
    const chrome = (key, locale) => chromeText(key, { messages, locale });

    if (search.has("storybook")) {
      const { renderStorybook } = await import("./storybook.js");
      const { route, params, locale } = currentRoute();
      await renderStorybook(mount, appBase, route, params, cfg.units ?? {}, {
        messages,
        locale,
        routes: cfg.routes,
        i18n: cfg.i18n,
        schema: cfg.schema,
      });
      return { storybook: true };
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
        const gate = localeAt(cfg, location.pathname || "/", location.search ?? "", globalThis.navigator?.languages);
        session = await renderLogin(mount, cfg, (key) => chrome(key, gate.locale));
        // The gate takes its own chrome down. The navigation stack appends
        // each screen beside whatever is already mounted rather than replacing
        // it, so nothing else will: left here, the login form outlives the
        // sign-in it gated and sits above every screen for the session.
        mount.replaceChildren();
        sessionStorage.setItem("pronto-token", JSON.stringify(session));
      }
    } else if ((cfg.tables?.length ?? 0) > 0) {
      let stored = sessionStorage.getItem("pronto-token");
      if (stored) {
        try {
          if (!(await accountLives(JSON.parse(stored)))) {
            sessionStorage.removeItem("pronto-token");
            stored = null;
          }
        } catch {
          sessionStorage.removeItem("pronto-token");
          stored = null;
        }
      }
      if (stored) {
        session = JSON.parse(stored);
      } else {
        const res = await fetch(`${cfg.auth?.service ?? "/auth"}/guest`, { method: "POST" });
        if (!res.ok) {
          throw new Error(`Guest auth failed with status ${res.status}: ${await res.text()}`);
        }
        session = await res.json();
        sessionStorage.setItem("pronto-token", JSON.stringify(session));
      }
    }

    const { createStore } = await import("./data-sync.js");
    const store = createStore("", { ...cfg, appBase });

    // Debug & visual-lint seam: pose fixture rows in-memory without page reloads.
    globalThis.__prontoStore = store;
    globalThis.__prontoPose = async (table, row) => {
      const client = globalThis.__mechaClient;
      const collection = client?.collections?.[table];
      if (collection) {
        if (!collection.isReady?.()) await collection.toArrayWhenReady?.();
        const existing = collection.toArray ?? [];
        const key = cfg.keys?.[table] || "id";
        const targetKey = existing[0]?.[key] ?? ((row[key] !== undefined && row[key] !== "") ? row[key] : `${table}_0001`);
        const cleanRow = { ...row };
        if (cleanRow[key] === "") delete cleanRow[key];
        await store.write(table, [{ key: targetKey, row: { ...existing[0], ...cleanRow, [key]: targetKey } }]);
      }
    };

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
    // Releasing stands on its own because the fresh path stamps at creation and
    // must come back to opacity 1 on every ending, including the ones that
    // never produce a screen.
    const release = (el) => raf(() => raf(() => delete el.dataset.entering));
    const enter = (el) => {
      el.dataset.entering = "";
      release(el);
    };
    const keepOf = (route) => route.keep ?? 1;
    const keyOf = (route, params) => `${route.screen} ${JSON.stringify(params)}`;

    // A screen still loading has no handle: `gone` marks a discard its load
    // honours when it lands.
    const discard = (entry) => {
      entry.gone = true;
      entry.handle?.stop();
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
        // The strip is built before any locale is resolved, and its addresses
        // change with the one the reader is in: it names routes, and
        // localizeStrip writes the hrefs on every navigation.
        a.dataset.route = r.screen;
        a.textContent = r.nav.label;
        nav.append(a);
      }
      if (session) nav.append(renderSession(session, cfg, store, signOut, chrome));
      mount.before(nav);
    }

    // The strip's addresses, its words and its state, all re-derived per
    // navigation: an href carries the locale of the page it is on, so does a
    // label, and aria-current names the link that IS this page — which is the
    // link whose address is this one, not merely a link to the same route with
    // someone else's :params.
    const localizeStrip = (locale) => {
      for (const a of nav?.querySelectorAll("a[data-route]") ?? []) {
        const href = routeHref(cfg, a.dataset.route, routeParams(a), locale);
        if (href === undefined) a.removeAttribute("href");
        else a.setAttribute("href", href);
        if (a.getAttribute("href") === location.pathname) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
      }
      // The strip's own links, and not the person's: renderSession's anchor
      // names a route too, and is a name and a handle rather than a word — a
      // label written onto it takes both down.
      for (const a of nav?.querySelectorAll(":scope > a[data-route]") ?? []) {
        // Absent on a route the app declares no label key for, and on every
        // route of an app declaring no catalogues: the table's own spelling
        // stands, which is the language it was written in.
        const label = cfg.routes.find((r) => r.screen === a.dataset.route)?.nav.labels?.[locale];
        if (label !== undefined) a.textContent = label;
      }
      const out = nav?.querySelector(".shell-signout");
      if (out) out.textContent = chrome("chrome_signout", locale);
      const signIn = nav?.querySelector(".shell-signin");
      if (signIn) signIn.textContent = chrome(signIn.dataset.key, locale);
    };

    // What the document says it IS, rewritten on every navigation. One entry
    // file answers at every address, so its head names no screen and no
    // language of its own: until this runs, every route of every locale is
    // `lang="en"` titled with the app. A screen reader takes the document's
    // language from that attribute, and a crawler that renders the page has no
    // other source for the title or for the fact that three addresses are one
    // page in three languages.
    const describe = (route, params, locale, written, el) => {
      // The language RENDERED, which is what a screen reader has to pronounce,
      // and which way its script runs, which is what the nav strip, the
      // scrollbar and every unstyled box take their side from. It is the
      // address's own everywhere but a plain route carrying `?lang=`, which
      // names a language without naming an address. An app that declares no
      // locales resolves none and makes no claim: the entry document's own
      // attributes stand rather than being overwritten with `undefined`.
      if (locale !== undefined) {
        document.documentElement.lang = locale;
        document.documentElement.dir = directionOf(locale);
      }
      // A screen's h1 names it; a screen without one — the home screen — is
      // the app itself.
      const name = el.querySelector("h1")?.textContent?.trim();
      document.title = name ? `${name} — ${cfg.app}` : cfg.app;

      for (const old of document.head.querySelectorAll('link[rel="canonical"], link[rel="alternate"][hreflang]')) {
        old.remove();
      }
      const link = (rel, href, hreflang) => {
        const node = document.createElement("link");
        node.rel = rel;
        // Absolute, which is what a crawler is asked to compare across
        // locales — and absolute against the address the reader arrived under,
        // so nothing here has to be told where the app is deployed. Every href
        // composed here is root-relative, so the document's own path drops out.
        node.href = new URL(href, location.href).href;
        if (hreflang !== undefined) node.hreflang = hreflang;
        document.head.append(node);
      };
      // The language the ADDRESS is written in, never the rendered one. The
      // two part only on a plain route carrying `?lang=`, which is the case
      // that would otherwise make a canonical vary per reader — and a
      // canonical two readers of one URL disagree about is the one thing a
      // canonical exists not to be.
      const here = routeHref(cfg, route.screen, params, written);
      // A route whose param carries nothing has no address, so this document
      // has none to name — and none in any other locale either, since the
      // param is the same in all of them.
      if (here === undefined) return;
      link("canonical", here);
      if (cfg.i18n === undefined) return;
      for (const tag of Object.keys(localeTable(cfg.i18n))) {
        link("alternate", routeHref(cfg, route.screen, params, tag), tag);
      }
      // x-default names the default locale's unprefixed address: where a
      // crawler is told to send a reader whose language matches no alternate.
      link("alternate", routeHref(cfg, route.screen, params, cfg.i18n.default), "x-default");
    };

    const show = async (navigationType = "push") => {
      let { route, params, locale, written } = currentRoute();
      // A localized route has one address, so `?lang=` on one is replaced by
      // the address it names rather than rendered — the server answers the
      // same case with a 301.
      if (route.paths !== undefined && new URLSearchParams(location.search).has("lang")) {
        const canonical = routeHref(cfg, route.screen, params, locale);
        if (canonical !== undefined) history.replaceState(null, "", canonical);
        ({ route, params, locale, written } = currentRoute());
      }
      localizeStrip(locale);
      const key = keyOf(route, params);
      if (current) {
        current.scrollY = window.scrollY;
        current.handle?.pause();
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
        describe(route, params, locale, written, entry.el);
        // Following a link to a screen visited before is a fresh arrival
        // however warm its DOM is, and an arrival starts at the top; going
        // back resumes. Only "push" is treated as an arrival.
        window.scrollTo(0, navigationType === "push" ? 0 : entry.scrollY);
        await entry.handle?.resume();
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
      // The fade is released once the screen has content, so it covers the
      // fetch rather than racing it — and released anyway when the fetch
      // throws or outlasts the cap, because a stamp that outlives its load is
      // a screen nobody can see.
      const capped = setTimeout(() => release(el), SCREEN_LOAD_CAP_MS);
      try {
        // A screen composes its own links and hands the move back: the stack is
        // the terminal's, and a screen that pushed its own entry would be
        // deciding scroll and history for a back button it does not own.
        fresh.handle = await interpretScreen(el, appBase, route, store, params, screenEnv(cfg, {
          messages,
          locale,
          navigate,
        }));
        // Left, or dropped, before the load landed: a back press during the
        // fetch is the common case.
        if (fresh.gone) return fresh.handle.stop();
        if (current !== fresh) return fresh.handle.pause();
        // After the render: the screen's own h1 is where its name comes from.
        describe(route, params, locale, written, el);
        // A screen arrived at starts at its own top. This lands there anyway
        // today, but only because hiding the outgoing screen collapses the page
        // and the browser clamps — an accident of ordering that any overlap of
        // the two screens would undo, and a cross-fade needs exactly that
        // overlap.
        window.scrollTo(0, 0);
      } catch (err) {
        // A slot whose load threw has no handle, and every later eviction calls
        // one: held onto, it turns the next visit to any screen into a
        // TypeError instead of the error that actually happened. The element
        // stays where it is — whatever rendered before the throw is what the
        // reader has — but the terminal stops counting it as a live screen.
        if (held.get(key) === fresh) held.delete(key);
        if (current === fresh) current = null;
        throw err;
      } finally {
        clearTimeout(capped);
        release(el);
      }
    };
    // The one way anything inside the app moves, to an address routeHref
    // composed, mounted already. Through the platform's stack where there is
    // one, so a push and a traverse stay distinguishable; by hand where there
    // is not.
    const navigate = (href) =>
      "navigation" in globalThis
        ? navigation.navigate(href)
        : (history.pushState(null, "", href), show("push"));
    // The Navigation API is the platform's own navigation stack, and the only
    // thing that can tell a push from a traverse — which is what decides
    // whether a held screen resumes its scroll. It also takes scroll policy as
    // configuration: "manual", because the stack owns scroll and the browser
    // cannot know that a held screen is already painted at the right offset.
    // Where it is missing, the terminal takes the click itself: a click it
    // pushed is the push, and popstate is the traverse.
    if ("navigation" in globalThis) {
      navigation.addEventListener("navigate", (e) => {
        if (!e.canIntercept || e.downloadRequest !== null || e.formData) return;
        // A reload is a document replacement on purpose — sign-out's whole
        // effect — and intercepting one turns it into a re-render of the
        // screen already on show, which leaves sign-out doing nothing visible.
        if (e.navigationType === "reload") return;
        const url = new URL(e.destination.url, location.href);
        // Only a path names a screen. An in-page fragment (an href="#id", the
        // chrome's own sign-out anchor) changes nothing the stack owns, and a
        // path this app has no route for belongs to the server.
        if (url.origin !== location.origin) return;
        if (url.pathname === location.pathname && url.search === (location.search ?? "")) return;
        if (addresses(url) === null) return;
        e.intercept({scroll: "manual", handler: () => show(e.navigationType)});
      });
    } else {
      addEventListener("click", (e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const a = e.target?.closest?.("a[href]");
        if (a === null || a === undefined || a.target || a.hasAttribute("download")) return;
        const href = a.getAttribute("href");
        if (href.startsWith("#")) return;
        const url = new URL(href, location.href);
        if (url.origin !== location.origin || addresses(url) === null) return;
        e.preventDefault();
        navigate(url.pathname + url.search);
      }, true);
      addEventListener("popstate", () => show("traverse"));
    }

    if (typeof navigator !== "undefined" && navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener("message", async (e) => {
        if (e.data?.type === "PRONTO_SKELETON_UPDATED" && e.data?.html) {
          const path = e.data.pathname || "";
          if (current?.route?.files?.html && path.endsWith(current.route.files.html)) {
            await current.handle?.morph?.(e.data.html);
          }
        } else if (e.data?.type === "PRONTO_STYLE_UPDATED" && e.data?.css) {
          const path = e.data.pathname || "";
          if (current?.route?.files?.css && path.endsWith(current.route.files.css)) {
            const style = document.getElementById(`screen-css-${current.route.screen}`);
            if (style) style.textContent = e.data.css;
          }
        }
      });
    }

    await show();
    booted = true;
    return { store, navigate };
  } catch (err) {
    banner(err);
    throw err;
  }
}
