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

import { chromeText, describe, drawStrip, guestBox, hasStrip, localizeStrip } from "./chrome.js";
import { localeByPath, localeTable, resolveLocale, routeHref, routePattern, screenEnv, Unanswered } from "./fragment.js";
import { fetchText, interpretScreen, prefetchScreen, templateHash } from "./screen.js";
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

/** A guest session from the auth service. A served or kept document on show
 * (`reading`) stays the page while no answer can arrive — a tab opened offline
 * paints what the worker kept, and holds no session yet, since one lives in
 * the tab — so the mint is asked again once the browser is back online, or a
 * backoff has passed. With nothing on show, there is nothing to keep. */
async function mintGuest(cfg, reading) {
  for (let wait = 2000; ; wait = Math.min(wait * 2, 15000)) {
    let res;
    try {
      res = await fetch(`${cfg.auth?.service ?? "/auth"}/guest`, { method: "POST" });
    } catch (err) {
      // fetch rejects with a TypeError when no answer arrived at all.
      if (!reading || !(err instanceof TypeError)) throw err;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, wait);
        addEventListener("online", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      continue;
    }
    if (!res.ok) throw new Error(`Guest auth failed with status ${res.status}: ${await res.text()}`);
    return res.json();
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
function renderSession(session, cfg, store, signOut, chrome, served = null) {

  // A guest has nothing to sign out of and a passkey to gain: one gesture
  // signs in to the passkey's account where the device has one, and otherwise
  // makes one of this guest, keeping what it wrote. A served document's strip
  // already holds that box (document.js), and it is the one bound.
  if (session.user.guest && cfg.auth?.promote) {
    const box = served?.querySelector(".shell-signin") ? served : guestBox(document);
    const signIn = box.querySelector(".shell-signin");
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

  const box = document.createElement("span");
  box.className = "shell-me";
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

/** The app's catalogues, keyed by tag, fetched one locale at a time: a reader
 * is in one language, and the five they are not in cost a page its first paint
 * on a slow link. `ensure` answers once the locale's file has been asked for,
 * and a locale whose file answers with a failure is left out of the map, so
 * what reads it — a screen through screenEnv, the chrome through chromeText —
 * shows the copy it was written with. A request that never answered is no
 * answer: it rejects whoever waits on it, and the next to ask asks again.
 *
 * The worker answers from its copy of a catalogue, which is any deploy old.
 * `settle` takes a served document's witness of the catalogues it is drawn in
 * (document.js) and asks the network past the worker for each this shell holds
 * otherwise, as a screen does for its template: the screen writes its words
 * again on taking the document over, and the older copy would write a newer
 * document back to older words. `heard` takes the worker's announcement of a
 * newer copy once the one asked has landed, so the older cannot land after
 * it; `taken` counts what has been taken, which a screen compares with what it
 * was last written in. */
function catalogues(appBase, i18n) {
  const messages = {};
  const witnessed = {};
  const asked = new Map();
  const answered = new Set();
  let taken = 0;
  const declared = i18n?.locales ? localeTable(i18n) : {};
  const urlOf = (loc) => new URL(`messages/${loc}.json`, appBase);
  const take = (loc, text) => {
    messages[loc] = compileCatalog(JSON.parse(text));
    witnessed[loc] = templateHash(text);
    taken++;
  };
  const load = (loc, init) =>
    fetch(urlOf(loc), init).then(async (res) => {
      if (res.ok) take(loc, await res.text());
      answered.add(loc);
    });
  const ensure = (loc) => {
    if (loc === undefined || !Object.hasOwn(declared, loc)) return Promise.resolve();
    let pending = asked.get(loc);
    if (pending === undefined) {
      pending = load(loc).catch((err) => {
        asked.delete(loc);
        throw err;
      });
      asked.set(loc, pending);
    }
    return pending;
  };
  return {
    messages,
    ensure,
    // Whether asking would wait: a navigation within one language must not
    // yield before it mounts, or a second navigation can land between the two.
    answered: (loc) => loc === undefined || !Object.hasOwn(declared, loc) || answered.has(loc),
    all: () => Promise.all(Object.keys(declared).map(ensure)),
    settle: (witness) =>
      Promise.all(witness.split(" ").filter(Boolean).map((pair) => {
        const [loc, hash] = pair.split(":");
        return Object.hasOwn(witnessed, loc) && witnessed[loc] !== hash ? load(loc, { cache: "no-cache" }) : undefined;
      })),
    heard: async (pathname, text) => {
      const loc = [...asked.keys()].find((l) => urlOf(l).pathname === pathname);
      if (loc === undefined) return false;
      // Whoever asked for it hears how its request ended.
      await Promise.allSettled([asked.get(loc)]);
      if (witnessed[loc] === templateHash(text)) return false;
      take(loc, text);
      return true;
    },
    taken: () => taken,
  };
}

export async function createShell({ config, mount }) {
  // A document rendered before this script ran (document.js), from the
  // network or from the service worker's copy: its screen in the mount, its
  // strip beside it, and the template it was rendered from in its head. The
  // first show() takes the screen over where it stands.
  let served = mount.querySelector(":scope > .shell-screen[data-served]");
  const servedStrip = mount.previousElementSibling?.localName === "nav" ? mount.previousElementSibling : null;
  const servedCas = document.querySelector('meta[name="pronto-cas"]')?.getAttribute("content");
  const servedWords = document.querySelector('meta[name="pronto-words"]')?.getAttribute("content") ?? "";
  const banner = (err) => {
    mount.replaceChildren();
    const pre = document.createElement("pre");
    pre.style.cssText = "color:#B8422E;padding:16px;white-space:pre-wrap";
    pre.textContent = String(err?.stack ?? err);
    mount.append(pre);
  };
  // The banner is a boot-failure surface, and a deploy's (`unheard` below).
  // Once a screen is mounted, a stray rejection (a severed gateway killing an
  // in-flight fetch anywhere in the data plane) must never replace live DOM —
  // the screen's own state machine degrades to network-error and its forms
  // keep working.
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
    // The newest screen files the service worker has announced, by path. It
    // answers a screen's fetch from its copy and announces a newer one once
    // its revalidation lands, which can be before anything here is mounted; a
    // message no listener hears is dropped, so this listens before anything
    // is fetched, and a screen catches up once it is on show.
    const announced = new Map();
    let hear = null;
    let words = null;
    globalThis.navigator?.serviceWorker?.addEventListener("message", (e) => {
      const type = e.data?.type;
      // One announced before the catalogue is first asked for has nothing to
      // replace: the request is answered from the worker's copy, this one.
      if (type === "PRONTO_MESSAGES_UPDATED") {
        words?.heard(e.data.pathname, e.data.json).then((took) => took && hear?.(), banner);
        return;
      }
      if (type !== "PRONTO_SKELETON_UPDATED" && type !== "PRONTO_STYLE_UPDATED") return;
      announced.set(e.data.pathname, e.data.html ?? e.data.css);
      hear?.();
    });

    // Against the document's base, not the address it arrived under: one entry
    // answers at every route, so location.href is /games as readily as
    // /shell/, and resolving there asks for a shell.yaml beside the route.
    const configUrl = new URL(config, document.baseURI);
    const appBase = new URL("..", configUrl);
    const text = await fetchText(configUrl);
    const cfg = configUrl.pathname.endsWith(".json")
      ? JSON.parse(text)
      : (await import("./vendor/js-yaml.js")).load(text);
    // A served document's head already says what it is.
    if (served === null) document.title = cfg.app;

    const search = new URLSearchParams(location.search);
    // This app's own reading of an address, at the terminal's preferences.
    const addresses = (url) => routeAt(cfg, url.pathname || "/", url.search ?? "", globalThis.navigator?.languages);
    const currentRoute = () => {
      const found = addresses(location);
      if (found === null) throw new Error(`no route for ${location.pathname}`);
      return found;
    };

    // Everything the first screen waits on that does not wait on each other
    // leaves here at once: its catalogue, the session, the data plane's module
    // and the screen's own files. Asked one after another, each is a round
    // trip the first paint pays in turn.
    const arriving = addresses(location);
    words = catalogues(appBase, cfg.i18n);
    const { messages, ensure: ensureMessages, answered, all: allMessages } = words;
    const storybook = search.has("storybook");
    if (arriving !== null && !storybook) prefetchScreen(appBase, arriving.route);
    // Ahead of the gate, not beside the screens: the terminal's own chrome is
    // drawn before any route is mounted and speaks the reader's language too.
    // The default's comes along because a key one catalogue lacks is read from
    // it (screen.js lookup).
    const catalogued = storybook
      ? allMessages()
      : Promise.all([ensureMessages(arriving?.locale), ensureMessages(cfg.i18n?.default)]);
    // The terminal's own words, in whichever language the caller resolved: the
    // gate and the strip are both drawn before a screen is, so neither can take
    // a locale off one.
    const chrome = (key, locale) => chromeText(key, { messages, locale });

    if (storybook) {
      await catalogued;
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
    const dataPlane = import("./data-sync.js");

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
        await Promise.all([catalogued, ensureMessages(gate.locale)]);
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
        session = await mintGuest(cfg, served !== null);
        sessionStorage.setItem("pronto-token", JSON.stringify(session));
      }
    }

    await catalogued;
    if (served !== null) await words.settle(servedWords);
    const { createStore } = await dataPlane;
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

    if (hasStrip(cfg, session)) {
      nav = drawStrip(document, cfg);
      // A served strip naming this strip's routes is this strip: kept, with
      // the link the reader may be on, and its words and addresses rewritten
      // in place by the first show(). One naming others is another deploy's,
      // and gives way to this one, its words written in the same task.
      const routesOf = (strip) => [...strip.querySelectorAll(":scope > a[data-route]")].map((a) => a.dataset.route).join(" ");
      const kept = servedStrip !== null && routesOf(servedStrip) === routesOf(nav) ? servedStrip : null;
      if (kept !== null) nav = kept;
      else if (servedStrip) servedStrip.replaceWith(nav);
      else mount.before(nav);
      const servedBox = kept?.querySelector(":scope > .shell-me") ?? null;
      if (session) {
        const box = renderSession(session, cfg, store, signOut, chrome, servedBox);
        if (box !== servedBox) {
          servedBox?.remove();
          nav.append(box);
        }
      } else servedBox?.remove();
    } else servedStrip?.remove();

    // The address this mount is already rendering, spelled as it should be.
    // The Navigation API reports a replaceState as a navigation, and taking
    // that one would mount the screen a second time under the first.
    let restating = false;
    const restate = (href) => {
      restating = true;
      try {
        history.replaceState(null, "", href);
      } finally {
        restating = false;
      }
    };
    // Which show() is the latest. One that waited for a catalogue and finds a
    // later one started meanwhile mounts nothing: what it read off the
    // address is no longer the address.
    let showing = 0;
    const show = async (navigationType = "push") => {
      const turn = ++showing;
      let { route, params, locale, written } = currentRoute();
      const asked = new URLSearchParams(location.search).has("lang");
      // A localized route has one address, so `?lang=` on one is replaced by
      // the address it names rather than rendered — the server answers the
      // same case with a 301. And an unprefixed address read in another
      // language is that language's address: the door answered it with that
      // document rather than a redirect (pronto's emitted Caddyfile), so the
      // address is restated here, where it costs no round trip.
      const negotiated = !asked && params.locale === undefined && locale !== written;
      if ((route.paths !== undefined && asked) || negotiated) {
        const canonical = routeHref(cfg, route.screen, params, locale);
        if (canonical !== undefined) restate(canonical);
        ({ route, params, locale, written } = currentRoute());
      }
      if (!answered(locale)) {
        await ensureMessages(locale);
        if (turn !== showing) return;
      }
      localizeStrip(nav, cfg, { locale, here: location.pathname, messages });
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
        entry.locale = locale;
        entry.seq = ++seq;
        entry.el.hidden = false;
        enter(entry.el);
        current = entry;
        evict(route);
        describe(document, cfg, { route, params, locale, written, el: entry.el, origin: location.origin });
        // Following a link to a screen visited before is a fresh arrival
        // however warm its DOM is, and an arrival starts at the top; going
        // back resumes. Only "push" is treated as an arrival.
        window.scrollTo(0, navigationType === "push" ? 0 : entry.scrollY);
        await entry.handle?.resume();
        await catchUp(entry).catch(unheard(entry));
        return;
      }
      // A served document is already the screen on show, so the first show()
      // takes it over where it stands: no fade, since nothing arrives, and no
      // jump to the top, since the reader may already have scrolled what they
      // were reading.
      let adopting = served;
      served = null;
      // A kept document is any deploy old. One that names no template, or
      // draws a screen this address no longer maps to, is a deploy's this
      // shell is not: it gives way to a fresh mount, and the worker's copy
      // to the network's on the next visit.
      if (adopting !== null && (servedCas === undefined || adopting.firstElementChild?.dataset.screen !== route.screen)) {
        adopting.remove();
        adopting = null;
      }
      let el = adopting;
      if (adopting === null) {
        el = document.createElement("div");
        el.className = "shell-screen";
        el.dataset.entering = "";
        mount.append(el);
      }
      // In the catalogues as they stand now: one taken while it mounts is
      // written in once it is on show.
      const fresh = { key, el, route, locale, words: words.taken(), scrollY: 0, seq: ++seq };
      held.set(key, fresh);
      current = fresh;
      evict(route);
      // The fade is released once the screen has content, so it covers the
      // fetch rather than racing it — and released anyway when the fetch
      // throws or outlasts the cap, because a stamp that outlives its load is
      // a screen nobody can see.
      const capped = adopting ? undefined : setTimeout(() => release(el), SCREEN_LOAD_CAP_MS);
      try {
        // A screen composes its own links and hands the move back: the stack is
        // the terminal's, and a screen that pushed its own entry would be
        // deciding scroll and history for a back button it does not own.
        fresh.handle = await interpretScreen(el, appBase, route, store, params, screenEnv(cfg, {
          messages,
          ensureMessages,
          locale,
          navigate,
          ...(adopting ? { served: { screen: adopting.firstElementChild, cas: servedCas } } : {}),
        }));
        fresh.cas = fresh.handle.cas;
        // Bound, so the screen is the shell's now rather than the document's.
        el.removeAttribute("data-served");
        // Left, or dropped, before the load landed: a back press during the
        // fetch is the common case.
        if (fresh.gone) return fresh.handle.stop();
        if (current !== fresh) return fresh.handle.pause();
        // After the render: the screen's own h1 is where its name comes from.
        describe(document, cfg, { route, params, locale, written, el, origin: location.origin });
        // A screen arrived at starts at its own top. This lands there anyway
        // today, but only because hiding the outgoing screen collapses the page
        // and the browser clamps — an accident of ordering that any overlap of
        // the two screens would undo, and a cross-fade needs exactly that
        // overlap.
        if (!adopting) window.scrollTo(0, 0);
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
        if (!adopting) release(el);
      }
      await catchUp(fresh).catch(unheard(fresh));
    };
    // A newer template is a deploy's, and names its modules in that deploy's
    // config. The worker answers the config from its copy and announces none
    // of its changes, so before a template is taken the config is asked of the
    // network: one the deploy changed is a newer app than the one running, and
    // the document is replaced by it, as sign-out replaces it.
    const settleConfig = async () => {
      if (await fetchText(configUrl, { cache: "no-cache" }) === text) return;
      location.reload();
      return new Promise(() => {});
    };
    // A screen on show takes the files announced for it: the catalogues it
    // was not written in, its stylesheet in place, and its skeleton morphed to
    // a template it was not drawn from.
    const catchUp = async (entry) => {
      if (entry.handle === undefined || current !== entry) return;
      if (entry.words !== words.taken()) {
        entry.words = words.taken();
        entry.handle.localize();
        localizeStrip(nav, cfg, { locale: entry.locale, here: location.pathname, messages });
      }
      const css = announced.get(new URL(entry.route.files.css, appBase).pathname);
      const style = document.getElementById(`screen-css-${entry.route.screen}`);
      if (css !== undefined && style !== null && style.textContent !== css) style.textContent = css;
      const html = announced.get(new URL(entry.route.files.html, appBase).pathname);
      if (html === undefined || templateHash(html) === entry.cas) return;
      await settleConfig();
      const was = entry.cas;
      entry.cas = templateHash(html);
      await entry.handle.morph(html).catch((err) => {
        // Not taken, so asked again the next time the screen is shown.
        if (entry.cas === templateHash(html)) entry.cas = was;
        throw err;
      });
    };
    // A newer file the screen cannot take. One the network failed to answer
    // is an outage, said as a dropped connection is: the screen stays as it
    // was, and usable. Anything else is a deploy that broke it, which the
    // reader is told as a boot that failed is.
    const unheard = (entry) => (err) => {
      if (!(err instanceof Unanswered)) return banner(err);
      console.error(err);
      entry.el.querySelector(".screen")?.setAttribute("data-state", "network-error");
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
        if (restating || !e.canIntercept || e.downloadRequest !== null || e.formData) return;
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

    hear = () => current !== null && catchUp(current).catch(unheard(current));

    await show();
    booted = true;
    return { store, navigate };
  } catch (err) {
    banner(err);
    throw err;
  }
}
