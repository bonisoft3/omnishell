import { parseMarkup } from "./markup.js";
// createShell: the omnishell entry for pronto-emitted apps. Reads the file
// map (shell.yaml), boots the store, mounts the route matching the location
// path, and hands the screen to the interpreter. No build step exists on
// this path by design.
//
// The store is the local virtual cluster through the /crud gateway (sayt
// launch). `?storybook` renders every storyboard state against fixtures
// instead.
//
// Auth (cfg.auth: {required, service, providers}): the login screen is
// terminal chrome, driving the WebAuthn ceremony or the guest mint against the
// auth service and stashing {token, user} in sessionStorage["pronto-token"]. A
// provider's sign-in leaves the page and comes back to it, so the boot adopts
// that session from the auth service (adoptProviderSession). Storybook
// bypasses it entirely: the fixture adapter runs without the cluster, so no auth
// service exists to sign against.

import { chromeText, describe, drawStrip, guestBox, hasStrip, localizeStrip, offersGuest, providerHref, providerKey, stripRoutes, supportsPasskeys } from "./chrome.js";
import { localeAt, localeTable, ProgramError, routeAt, routeHref, screenEnv, Unanswered } from "./fragment.js";
import { activateScreenStyle, fetchText, interpretScreen, prefetchScreen, templateHash, submitsOnChange, AssetMissing } from "./screen.js";
import { compileCatalog } from "./vendor/messages.js";
import { planRelease } from "./release-plan.js";
export { routeAt } from "./fragment.js";
import { assetURL, preloadLinkedScreens, preloadScreen, releaseOf, setRelease } from "./preloads.js";
import { startLinkPrefetch } from "./link-prefetch.js";

const recoveryKey = "pronto-release-recovery";
const releaseKey = (imports) => templateHash(JSON.stringify(imports));
// How often an open page asks whether a deployment landed, besides whenever it
// is shown again.
const RELEASE_CHECK_MS = 5 * 60 * 1000;
// The worker's copies of entries (offline-first-sw.js), dropped whole when the
// page restarts into a newer release: each names the older one.
const ENTRY_CACHE = "pronto-entries-v1";
// A release's map as served in an entry, read without parsing the document,
// which the policy's Trusted Types forbid on a string.
const SERVED_MAP = /<script\b[^>]*\bid="pronto-assets"[^>]*>([\s\S]*?)<\/script>/;
const sessionOwner = (session) => {
  if (session === null) return null;
  const subject = claimsOf(session.token)?.sub ?? session.user?.id;
  return JSON.stringify(subject === undefined ? ["token", session.token] : ["subject", subject]);
};
const forgetSession = () => {
  sessionStorage.removeItem(recoveryKey);
  sessionStorage.removeItem("pronto-token");
};
const storedSessionOwner = () => {
  try {
    return sessionOwner(JSON.parse(sessionStorage.getItem("pronto-token") ?? "null"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    forgetSession();
    return undefined;
  }
};

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

// The auth service leaves this readable cookie beside the HttpOnly one a
// provider's sign-in sets (mecha's services/auth/README.md#provider-sign-in),
// so a tab that has none never asks for a session it does not have.
const PROVIDER_HINT = "mecha_oidc_hint";
const providerHinted = () => (globalThis.document?.cookie ?? "").split(";").some((c) => c.trim().startsWith(`${PROVIDER_HINT}=`));

/** The browser's provider sign-in as this tab's session, or null. A redirect
 * cannot write sessionStorage, so the provider's return lands here, and so
 * does every tab opened later. A live non-guest session keeps its identity;
 * an expired bearer can be renewed by the longer-lived cookie. Fails open
 * as accountLives does: offline, the tab boots as it would have. */
async function adoptProviderSession(cfg) {
  if ((cfg.auth?.providers?.length ?? 0) === 0 || !providerHinted()) return null;
  let held = null;
  try {
    held = JSON.parse(sessionStorage.getItem("pronto-token") ?? "null");
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (held !== null && !held.user?.guest && await accountLives(held)) return null;
  let res;
  try {
    res = await fetch(`${cfg.auth.service}/oidc/session`, { method: "POST", credentials: "same-origin" });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return null;
  }
  // Signed out elsewhere, or the link revoked: the hint is stale, and the
  // next boot need not ask.
  if (res.status === 401) {
    document.cookie = `${PROVIDER_HINT}=; Path=/; Max-Age=0`;
    return null;
  }
  if (!res.ok) throw new Error(`${res.status} POST ${cfg.auth.service}/oidc/session`);
  const session = await res.json();
  if (sessionOwner(session) !== sessionOwner(held)) sessionStorage.removeItem(recoveryKey);
  sessionStorage.setItem("pronto-token", JSON.stringify(session));
  return session;
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
  wrap.append(parseMarkup(document, `<header class="login-intro">
    <span class="login-mark" aria-hidden="true"></span>
    <h1 id="shell-login-title"></h1>
    <p class="login-hint" id="shell-login-hint"></p>
  </header><form aria-labelledby="shell-login-title" aria-describedby="shell-login-hint">
    <p class="login-error" role="alert" hidden></p>
    <div class="login-actions">
      <button type="submit" class="login-passkey"></button>
      <button type="button" class="login-guest"></button>
    </div>
  </form>`));
  // A provider's way in leaves the page, so it is a link, not a button: the
  // provider brings the reader back to this address, where the boot adopts
  // the session (adoptProviderSession).
  const here = `${location.pathname ?? "/"}${location.search ?? ""}`;
  for (const provider of cfg.auth.providers ?? []) {
    const a = document.createElement("a");
    a.className = "login-provider";
    a.dataset.provider = provider;
    a.href = providerHref(cfg.auth.service, provider, here);
    a.textContent = chrome(providerKey(provider));
    wrap.querySelector(".login-passkey").before(a);
  }
  wrap.querySelector("h1").textContent = cfg.app;
  wrap.querySelector(".login-mark").textContent = [...cfg.app][0]?.toLocaleUpperCase() ?? "";
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

function renderPromote(ensureSession, cfg, chrome, served = null) {
  const box = served?.querySelector(".shell-signin, .shell-provider") ? served : guestBox(document, cfg);
  const signIn = box.querySelector(".shell-signin");
  const create = box.querySelector(".shell-register");
  if (!supportsPasskeys()) {
    signIn?.remove();
    create?.remove();
    return box;
  }
  const authenticate = async (button, ceremony) => {
    if (signIn) signIn.disabled = true;
    if (create) create.disabled = true;
    let current;
    let next;
    try {
      current = await ensureSession();
      next = await ceremony(current);
    } catch (err) {
      console.error(err);
      button.dataset.key = "chrome_passkey_failed";
      button.textContent = chrome(button.dataset.key, document.documentElement.lang);
      return;
    } finally {
      if (signIn) signIn.disabled = false;
      if (create) create.disabled = false;
    }
    if (sessionOwner(next) !== sessionOwner(current)) sessionStorage.removeItem(recoveryKey);
    sessionStorage.setItem("pronto-token", JSON.stringify(next));
    location.reload();
  };
  signIn?.addEventListener("click", () => authenticate(signIn, (session) => passkeyCeremony(cfg.auth.service, session.token)));
  create?.addEventListener("click", () => authenticate(create, (session) => registerCeremony(cfg.auth.service, session.token)));
  return box;
}
function renderSession(session, cfg, store, signOut, chrome, served = null) {
  // A guest has nothing to sign out of and a way in to gain: a passkey's one
  // gesture signs in to the passkey's account where the device has one, and
  // otherwise makes one of this guest, keeping what it wrote; a provider's
  // signs in as the person it links. A served document's strip already holds
  // that box (document.js), and it is the one bound.
  if (session.user.guest && offersGuest(cfg)) {
    return renderPromote(() => Promise.resolve(session), cfg, chrome, served);
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
  const openLoginModal = (e) => {
    const activeBtn = Array.from(document.querySelectorAll("#btn-top-login, .btn-top-login"))
      .find((el) => !el.closest(".shell-screen[hidden]"));
    if (activeBtn && typeof activeBtn.click === "function") {
      e.preventDefault();
      activeBtn.click();
      return true;
    }
    const toggle = Array.from(document.querySelectorAll("#login-modal-toggle, .login-modal-chk"))
      .find((el) => !el.closest(".shell-screen[hidden]")) ?? document.getElementById("login-modal-toggle");
    if (toggle) {
      e.preventDefault();
      toggle.checked = true;
      return true;
    }
    return false;
  };
  who.addEventListener("click", (e) => {
    openLoginModal(e);
  });
  out.textContent = chrome("chrome_signout", cfg.i18n?.default);
  out.addEventListener("click", (e) => {
    const isGuestSession = Boolean(
      session?.user?.guest ||
      !session?.user?.handle ||
      session?.user?.handle === "guest" ||
      /entrar|sign\s*in|iniciar|התחבר|登录/i.test(out.textContent || ""),
    );
    if (isGuestSession && openLoginModal(e)) return;
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

/** The app's catalogues, keyed by tag, fetched one locale at a time: a reader
 * is in one language, and the five they are not in cost a page its first paint
 * on a slow link. `ensure` answers once the locale's file has been asked for,
 * and a locale whose file answers with a failure is left out of the map, so
 * what reads it — a screen through screenEnv, the chrome through chromeText —
 * shows the copy it was written with. A request that never answered is no
 * answer: it rejects whoever waits on it, and the next to ask asks again.
 *
 * `heard` takes a newer release's copy once the
 * one asked has landed, so the older cannot land after it; `taken` counts what
 * has been taken, which a screen compares with what it was last written in. */
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
  const load = async (loc, init) => {
    const res = await fetch(assetURL(urlOf(loc)), init);
    if (res.ok) take(loc, await res.text());
    answered.add(loc);
  };
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

// `preload: false` for a page that serves the app's files itself (pronto's
// single-file bundle): a preload goes to the network past the page's own
// answer, and fetches what nothing reads.
export function installModalInert(document) {
  const modalInert = new Map();
  const syncModalInert = () => {
    const modal = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
      .find((el) => el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true }) && el.getClientRects().length);
    const next = new Set();
    for (let node = modal; node?.parentElement; node = node.parentElement) {
      for (const sibling of node.parentElement.children) if (sibling !== node) next.add(sibling);
    }
    for (const [el, wasInert] of modalInert) if (!next.has(el)) {
      el.inert = wasInert;
      modalInert.delete(el);
    }
    for (const el of next) if (!modalInert.has(el)) {
      modalInert.set(el, el.inert);
      el.inert = true;
    }
  };
  new document.defaultView.MutationObserver(syncModalInert).observe(document.body, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["data-status", "hidden", "class", "style", "aria-modal"],
  });
  syncModalInert();
}

export function shellPreferredLanguages(served, document, navigator) {
  return served && document.documentElement.lang ? [document.documentElement.lang] : navigator?.languages;
}

export async function createShell({ config, mount, preload = true }) {
  installModalInert(document);
  let initialDraftOwner = storedSessionOwner();
  const editedFields = new WeakSet();
  const morphDrafts = new Map();
  {
    for (const type of ["input", "change"]) {
      document.addEventListener(type, (event) => {
        const field = event.target?.closest?.("input, textarea, select, [contenteditable]");
        if (!field) return;
        const changed = field.type === "radio" && field.name
          ? [...document.querySelectorAll('input[type="radio"]')].filter(candidate =>
            candidate.name === field.name && candidate.form === field.form)
          : [field];
        for (const candidate of changed) editedFields.add(candidate);
        for (const [el, saved] of morphDrafts) {
          if (!el.contains(field)) continue;
          for (const [candidate, key] of keyedFields(el)) {
            if (changed.includes(candidate)) saved.set(key, captureField(candidate));
          }
        }
      }, true);
    }
  }
  const fields = (el) => [...el.querySelectorAll("input, textarea, select, [contenteditable]")]
    .filter((field) => field.type !== "password" && field.type !== "file" &&
      (field.id || field.name));
  const keyedFields = (el) => {
    const candidates = fields(el).map((field) => {
      const owners = [];
      for (let node = field.parentElement; node && node !== el; node = node.parentElement) {
        if (node.hasAttribute("data-id")) owners.unshift(`row:${node.getAttribute("data-id")}`);
        else if (node.id) owners.unshift(`node:${node.id}`);
      }
      const name = field.id ? `#${field.id}` : field.name;
      const choice = field.type === "radio" || field.type === "checkbox" ? field.value : "";
      return [field, JSON.stringify([owners, name, choice])];
    });
    const counts = new Map();
    for (const [, key] of candidates) counts.set(key, (counts.get(key) ?? 0) + 1);
    return candidates.filter(([, key]) => counts.get(key) === 1);
  };
  const fieldKind = (field) => field.isContentEditable ? "rich"
    : field.type === "checkbox" || field.type === "radio" ? field.type
    : field.matches("select[multiple]") ? "multiple" : "text";
  const captureField = (field) => ({
    kind: fieldKind(field),
    text: field.isContentEditable ? field.textContent : undefined,
    value: field.isContentEditable ? field.innerHTML : field.value,
    selectedValues: field.matches("select[multiple]")
      ? [...field.options].filter((option) => option.selected).map((option) => option.value) : undefined,
    checked: field.checked,
  });
  const captureFields = (el) => new Map(keyedFields(el).filter(([field]) => editedFields.has(field))
    .map(([field, key]) => [key, captureField(field)]));
  const restoreFields = (el, saved) => {
    for (const [field, key] of keyedFields(el)) {
      const prior = saved.get(key);
      const kind = fieldKind(field);
      if (!prior?.kind || (prior.kind !== kind &&
          ![prior.kind, kind].every(value => value === "text" || value === "rich"))) continue;
      if (field.isContentEditable) {
        const property = prior.kind === "rich" ? "innerHTML" : "textContent";
        if (field[property] !== prior.value) {
          if (prior.kind === "rich") field.replaceChildren(parseMarkup(document, prior.value));
          else field.textContent = prior.value;
        }
      }
      else if (field.type === "checkbox" || field.type === "radio") {
        if (field.checked !== prior.checked) field.checked = prior.checked;
      }
      else if (field.matches("select[multiple]")) {
        const selected = new Set(prior.selectedValues ?? []);
        for (const option of field.options) {
          if (option.selected !== selected.has(option.value)) option.selected = selected.has(option.value);
        }
      }
      else {
        const value = prior.kind === "rich" ? prior.text : prior.value;
        if (field.value !== value) field.value = value;
      }
      editedFields.add(field);
      if (field.closest("[data-machine]") === null && field.type !== "checkbox" &&
          !submitsOnChange(field.closest("form"))) field._prontoDirty = true;
    }
  };
  let gesture = 0;
  {
    for (const field of fields(mount)) {
      const changed = !field.isContentEditable && (field.matches("select")
        ? [...field.options].some(option => option.selected !== option.defaultSelected)
        : field.type === "checkbox" || field.type === "radio"
          ? field.checked !== field.defaultChecked
          : field.value !== field.defaultValue);
      if (changed) editedFields.add(field);
    }
    for (const type of ["input", "change", "keydown", "pointerdown"]) {
      document.addEventListener(type, () => { gesture += 1; }, true);
    }
  }
  const editing = () => {
    const focused = document.activeElement;
    return focused?.matches?.("input:not([type=hidden]), textarea, select, [contenteditable]") ||
      mount.querySelector("form[data-submitting]") !== null ||
      [...mount.querySelectorAll("input[type=password]")].some(field => field.value !== "") ||
      [...mount.querySelectorAll("input[type=file]")].some(field => field.files?.length > 0);
  };
  const idle = () => new Promise(resolve => {
    const events = ["focusout", "input", "change"];
    const check = () => {
      if (editing()) return;
      for (const type of events) document.removeEventListener(type, changed, true);
      observer.disconnect();
      resolve();
    };
    const changed = () => queueMicrotask(check);
    const observer = new document.defaultView.MutationObserver(check);
    for (const type of events) document.addEventListener(type, changed, true);
    observer.observe(mount, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-submitting"] });
    check();
  });
  // A document rendered before this script ran (document.js), from the
  // network or from the service worker's copy: its screen in the mount, its
  // strip beside it, and the template it was rendered from in its head. The
  // first show() takes the screen over where it stands.
  let served = mount.querySelector(":scope > .shell-screen[data-served]");
  let servedStrip = mount.previousElementSibling?.localName === "nav" ? mount.previousElementSibling : null;
  const servedCas = document.querySelector('meta[name="pronto-cas"]')?.getAttribute("content");
  const banner = (err) => {
    if (!mount.querySelector(".shell-screen .screen")) mount.replaceChildren();
    mount.querySelector(":scope > [data-shell-error]")?.remove();
    const pre = document.createElement("pre");
    pre.dataset.shellError = "";
    pre.setAttribute("role", "alert");
    pre.style.cssText = "color:#B8422E;padding:16px;white-space:pre-wrap";
    pre.textContent = String(err?.stack ?? err);
    mount.prepend(pre);
  };
  // The banner is a boot-failure surface, a deploy's it cannot take, and a
  // program error's whenever it lands: the app's own bug, which no retry and
  // no reader recovers, so it dies attributed rather than logged. Once a
  // screen is mounted, any other stray rejection (a severed gateway killing
  // an in-flight fetch anywhere in the data plane) must never replace live
  // DOM — the screen's own state machine degrades to network-error and its
  // forms keep working.
  let booted = false;
  addEventListener("unhandledrejection", (e) => {
    if (!booted || e.reason instanceof ProgramError) {
      banner(e.reason);
      return;
    }
    e.preventDefault();
    console.error(e.reason);
    // Only the screen on show: the stack holds the others hidden beside it.
    mount.querySelector(":scope > :not([hidden]) .screen")?.setAttribute("data-state", "network-error");
  });
  // A program error thrown from a listener — a hatch's port refusing a
  // message, a timer — is the window's error event, not a rejection, and
  // lands on the same banner. Anything else there is the browser's to report.
  addEventListener("error", (e) => {
    if (e.error instanceof ProgramError) banner(e.error);
  });

  const HEAL_KEY = "pronto-healed-at";
  const HEAL_COOLDOWN_MS = 15_000;
  const isMissing = (err) => err instanceof AssetMissing ||
    (typeof err?.message === "string" && err.message.includes("404 fetching")) ||
    (err instanceof TypeError && typeof err?.message === "string" && err.message.includes("dynamically imported module"));
  const canHeal = () => {
    if (typeof sessionStorage?.getItem !== "function" || typeof sessionStorage?.setItem !== "function") return false;
    const last = Number(sessionStorage.getItem(HEAL_KEY) ?? "0");
    return Date.now() - last >= HEAL_COOLDOWN_MS;
  };
  let heal = null;

  try {
    let words = null;

    // Against the document's base, not the address it arrived under: one entry
    // answers at every route, so location.href is /games as readily as
    // /shell/, and resolving there asks for a shell.yaml beside the route.
    const configUrl = new URL(config, document.baseURI);
    const appBase = new URL("..", configUrl);
    // The release this page runs, named by its entry; null where it was served
    // without one, which then takes no other.
    let running = releaseOf(document);
    let initialFields = captureFields(served ?? mount);
    const text = await fetchText(configUrl);
    const cfg = configUrl.pathname.endsWith(".json")
      ? JSON.parse(text)
      : (await import("./vendor/js-yaml.js")).load(text);
    // A served document's head already says what it is.
    if (served === null) document.title = cfg.app;

    const search = new URLSearchParams(location.search);
    // This app's own reading of an address, at the terminal's preferences.
    const preferredLanguages = shellPreferredLanguages(served, document, globalThis.navigator);
    const addresses = (url) => routeAt(cfg, url.pathname || "/", url.search ?? "", preferredLanguages);
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
    if (arriving !== null && !storybook) {
      if (preload) preloadScreen(document, appBase, arriving.route, { template: false });
      prefetchScreen(appBase, arriving.route);
    }
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
        hostDom: cfg.hostDom ?? {},
        kinetic: cfg.kinetic ?? {},
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
    let mintedGuest = false;
    let guestSession = null;
    let recovery = null;
    const retainRecovery = () => {
      if (!recovery) return;
      if (Object.keys(recovery.screens ?? {}).length || recovery.initial?.length) {
        sessionStorage.setItem(recoveryKey, JSON.stringify(recovery));
      } else sessionStorage.removeItem(recoveryKey);
    };
    const hadInitialOwner = initialDraftOwner !== null;
    if (cfg.auth?.required || (cfg.tables?.length ?? 0) > 0) await adoptProviderSession(cfg);
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
        forgetSession();
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
            forgetSession();
            stored = null;
          }
        } catch {
          forgetSession();
          stored = null;
        }
      }
      if (stored) {
        session = JSON.parse(stored);
      } else {
        mintedGuest = true;
        guestSession = mintGuest(cfg, served !== null).then((s) => {
          session = s;
          if (!hadInitialOwner) initialDraftOwner = sessionOwner(s);
          sessionStorage.setItem("pronto-token", JSON.stringify(s));
          if (recovery && recovery.owner === null && !hadInitialOwner) {
            recovery.owner = sessionOwner(s);
            retainRecovery();
          }
          return s;
        });
      }
    }

    await catalogued;
    const { createStore, servedReadsOf, takeProgressiveReads } = await dataPlane;
    const store = createStore("", {
      ...cfg,
      appBase,
      mintedGuest,
      ensureSession: guestSession ? () => guestSession : null,
    });
    const linkPrefetch = startLinkPrefetch({ addresses, appBase, store, servedReadsOf, takeProgressiveReads });
    recovery = JSON.parse(sessionStorage.getItem(recoveryKey) ?? "null");
    const owner = session === null ? storedSessionOwner() : sessionOwner(session);
    if (initialDraftOwner !== owner) initialFields = null;
    const ownsRecovery = owner !== undefined && (recovery?.owner === owner ||
      (recovery?.owner === null && (initialDraftOwner === owner || (mintedGuest && !hadInitialOwner)) &&
        recovery.initial && !recovery.screens && !recovery.tabs));
    if (recovery && ownsRecovery && running !== null && recovery.expected === releaseKey(running)) {
      recovery.owner = owner;
      if (recovery.tabs) await store.restoreTabs(recovery.tabs);
      delete recovery.tabs;
    } else if (recovery) {
      sessionStorage.removeItem(recoveryKey);
      recovery = null;
    }

    // Debug & visual-lint seam: pose fixture rows in-memory without page reloads.
    globalThis.__prontoStore = store;
    globalThis.__prontoPose = (table, row) => store.pose(table, row);

    // The navigation stack belongs to the terminal — there is one back button,
    // so no screen can own it. A screen the user leaves keeps its DOM, hidden
    // in place, and lets go of its subscriptions: the shapes close on
    // schedule, and coming back repaints from what is already rendered before
    // the refresh lands. route.keep is how many instances of a route survive
    // that way; 0 rebuilds on every visit.
    const held = new Map();
    let current = null;
    let presented = null;
    let seq = 0;
    const keepOf = (route) => route.keep ?? 1;
    const keyOf = (route, params) => `${route.screen} ${JSON.stringify(params)}`;

    // A screen still loading has no handle: `gone` marks a discard its load
    // honours when it lands.
    const discard = (entry) => {
      entry.gone = true;
      entry.handle?.stop();
      entry.el.remove();
      if (held.get(entry.key) === entry) held.delete(entry.key);
    };

    // Parametrized routes would otherwise accumulate one screen per id ever
    // visited, so a route holds only its most recently shown instances.
    const evict = (route) => {
      const mine = [...held.values()]
        .filter((e) => e.route.screen === route.screen && e !== current && e !== presented)
        .sort((a, b) => b.seq - a.seq);
      for (const e of mine.slice(Math.max(keepOf(route) - 1, 0))) discard(e);
    };
    const present = (entry) => {
      const previous = presented;
      entry.el.hidden = false;
      entry.el.inert = false;
      delete entry.el.dataset.entering;
      activateScreenStyle(`screen-css-${entry.route.screen}`);
      entry.handle?.present();
      if (previous && previous !== entry) {
        previous.handle?.pause();
        previous.el.hidden = true;
        previous.el.inert = false;
        if (keepOf(previous.route) === 0) discard(previous);
      }
      presented = entry;
      mount.querySelector(":scope > [data-shell-error]")?.remove();
      evict(entry.route);
    };
    const restorePresentation = async (failed) => {
      if (current !== failed || (failed && presented === failed)) return;
      current = presented;
      if (failed) {
        failed.el.hidden = presented !== null;
        failed.mutationActive = false;
      }
      const previous = current;
      mutationDrain = Promise.all([failed?.handle?.pause(), failed?.mutationDrain?.()]);
      await mutationDrain;
      if (previous && current === previous) {
        previous.el.hidden = false;
        previous.el.inert = false;
        activateScreenStyle(`screen-css-${previous.route.screen}`);
        previous.mutationActive = true;
        await previous.handle?.resume();
      }
    };

    // Signing out lands on the door with nothing of the session left standing.
    // The chrome comes down here because the stack appends rather than
    // replaces, so nothing else would take it down; the document is then
    // replaced because the screens' subscriptions and the store's token are
    // the session too, and re-gating in place would keep both.
    let nav = null;
    const signOut = async () => {
      // The provider's cookie first, or the reload adopts the session again;
      // a sign-out that cannot reach the auth service leaves the reader signed
      // in, and on screen as they were.
      if (providerHinted()) {
        const res = await fetch(`${cfg.auth.service}/oidc/signout`, { method: "POST", credentials: "same-origin" });
        if (!res.ok) throw new Error(`${res.status} POST ${cfg.auth.service}/oidc/signout`);
      }
      for (const entry of [...held.values()]) discard(entry);
      current = null;
      nav?.remove();
      mount.replaceChildren();
      forgetSession();
      location.reload();
    };

    if (hasStrip(cfg, session, mintedGuest)) {
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
      } else if (mintedGuest && offersGuest(cfg)) {
        const box = renderPromote(() => guestSession, cfg, chrome, servedBox);
        if (box !== servedBox) {
          servedBox?.remove();
          nav.append(box);
        }
      } else if (mintedGuest) {
        guestSession = guestSession.then((s) => {
          const box = renderSession(s, cfg, store, signOut, chrome, servedBox);
          if (box !== servedBox) {
            servedBox?.remove();
            nav.append(box);
          }
          if (current !== null) {
            const explicitLocale = Boolean(cfg.i18n && current.locale === cfg.i18n.default && typeof location !== "undefined" && new URLSearchParams(location.search).has("lang"));
            localizeStrip(nav, cfg, { locale: current.locale, here: location.pathname, search: location.search ?? "", messages, explicitLocale });
          }
          return s;
        });
      } else servedBox?.remove();
    } else servedStrip?.remove();

    // The address this mount is already rendering, spelled as it should be.
    // The Navigation API reports a replaceState as a navigation, and taking
    // that one would mount the screen a second time under the first.
    const applyThemeMode = (mode) => {
      const m = mode === "light" || mode === "dark" ? mode : "auto";
      if (m === "auto") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = m;
      try { sessionStorage.setItem("snapcards-theme", m); } catch (_e) {}
      for (const r of document.querySelectorAll('input.theme-radio[name="theme-mode"]')) {
        r.checked = (r.value === m);
      }
    };
    try {
      const savedTheme = sessionStorage.getItem("snapcards-theme");
      if (savedTheme === "light" || savedTheme === "dark") {
        document.documentElement.dataset.theme = savedTheme;
      }
    } catch (_e) {}
    document.addEventListener("change", (e) => {
      const t = e.target;
      if (t && t.classList?.contains("theme-radio") && t.name === "theme-mode") {
        applyThemeMode(t.value);
      } else if (t && t.classList?.contains("fullscreen-checkbox")) {
        try {
          if (t.checked && document.documentElement.requestFullscreen && !document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {});
          } else if (!t.checked && document.exitFullscreen && document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
          }
        } catch (_e) {}
      }
    });
    document.addEventListener("fullscreenchange", () => {
      try {
        if (!document.fullscreenElement) {
          for (const cb of document.querySelectorAll("input.fullscreen-checkbox")) {
            cb.checked = false;
          }
        }
      } catch (_e) {}
    });
    let pendingAuthor = null;
    const syncCategoryRadios = (author) => {
      const root = current?.el || document;
      if (author === "me") {
        const mineRadio = root.querySelector?.("#cat-mine");
        if (mineRadio) mineRadio.checked = true;
      } else {
        const allRadio = root.querySelector?.("#cat-all");
        if (allRadio) allRadio.checked = true;
      }
    };
    const applyPendingAuthor = () => {
      if (!pendingAuthor) return;
      const author = pendingAuthor;
      const targetId = author === "me" ? "nav-my-cards" : author === "gallery" ? "nav-gallery" : "nav-home-trigger";
      const btn = current?.el?.querySelector?.(`#${targetId}`) || document.getElementById(targetId);
      if (btn && current?.el.contains(btn)) {
        pendingAuthor = null;
        syncCategoryRadios(author);
        btn.click();
      }
    };
    const EXTRA_NAV_FALLBACKS = {
      pt: ["Minhas Fichas", "Galeria"],
      es: ["Mis Tarjetas", "Galería"],
      en: ["My Cards", "Gallery"],
      he: ["הכרטיסיות שלי", "גלריה"],
      zh: ["我的闪卡", "图库"],
    };
    const syncExtraNav = (loc, explicitLocale = false) => {
      if (!nav || !nav.querySelector('a[data-route="cards"]')) return;
      let box = nav.querySelector(":scope > .sidebar-extra-nav");
      if (!box) {
        box = document.createElement("div");
        box.className = "sidebar-extra-nav";
        box.setAttribute("role", "navigation");
        const myLink = document.createElement("a");
        myLink.className = "sidebar-extra-link nav-my-cards-link";
        myLink.setAttribute("data-route", "cards");
        myLink.setAttribute("data-author", "me");
        const galLink = document.createElement("a");
        galLink.className = "sidebar-extra-link nav-gallery-link";
        galLink.setAttribute("data-route", "cards");
        galLink.setAttribute("data-author", "gallery");
        box.append(myLink, galLink);
        const printLink = nav.querySelector(':scope > a[data-route="print"]');
        if (printLink) printLink.before(box);
        else nav.append(box);
      }
      const langKey = (loc || cfg.i18n?.default || "pt").split("-")[0];
      const fb = EXTRA_NAV_FALLBACKS[langKey] || EXTRA_NAV_FALLBACKS.pt;
      const cat = messages?.[loc] ?? messages?.[langKey] ?? messages?.[cfg.i18n?.default] ?? {};
      const href = routeHref(cfg, "cards", {}, loc || cfg.i18n?.default, { explicitLocale }) || "/";
      const myLink = box.querySelector(".nav-my-cards-link");
      const galLink = box.querySelector(".nav-gallery-link");
      if (myLink) {
        myLink.textContent = cat.nav_my_cards || fb[0];
        myLink.setAttribute("href", href);
        myLink.removeAttribute("aria-current");
      }
      if (galLink) {
        galLink.textContent = cat.nav_gallery || fb[1];
        galLink.setAttribute("href", href);
        galLink.removeAttribute("aria-current");
      }
    };
    document.addEventListener("click", (e) => {
      const themeBtn = e.target?.closest?.(".theme-btn[data-theme-val]");
      if (themeBtn) {
        applyThemeMode(themeBtn.dataset.themeVal);
      }
      const extraLink = e.target?.closest?.("a.sidebar-extra-link[data-author]");
      if (extraLink) {
        const author = extraLink.dataset.author || null;
        const targetId = author === "me" ? "nav-my-cards" : author === "gallery" ? "nav-gallery" : "nav-home-trigger";
        const btn = current?.el?.querySelector?.(`#${targetId}`) || document.getElementById(targetId);
        if (current?.route?.screen === "cards" && btn && !btn.closest(".shell-screen[hidden]")) {
          e.preventDefault();
          syncCategoryRadios(author);
          btn.click();
        } else {
          pendingAuthor = author;
        }
      }
    }, true);
    if (nav) {
      const homeLink = nav.querySelector(':scope > a[data-route="cards"]');
      if (homeLink) {
        homeLink.addEventListener("click", () => {
          const homeTrigger = current?.el?.querySelector?.("#nav-home-trigger") || document.getElementById("nav-home-trigger");
          if (current?.route?.screen === "cards" && homeTrigger && !homeTrigger.closest(".shell-screen[hidden]")) {
            syncCategoryRadios("home");
            homeTrigger.click();
          } else {
            pendingAuthor = "home";
          }
        });
      }
      syncExtraNav(currentRoute().locale);
    }
    let restating = false;
    const restate = (href) => {
      restating = true;
      try {
        history.replaceState(null, "", href);
      } finally {
        restating = false;
      }
    };

    heal = async () => {
      if (!canHeal()) return false;
      sessionStorage.setItem(HEAL_KEY, String(Date.now()));
      const screens = { ...recovery?.screens };
      for (const entry of held.values()) {
        screens[entry.key] = [...new Map([...(screens[entry.key] ?? []), ...captureFields(entry.el)])];
      }
      const tabs = store ? await store.tabSnapshot() : null;
      sessionStorage.setItem(recoveryKey, JSON.stringify({
        expected: running ? releaseKey(running) : undefined,
        owner: session === null ? storedSessionOwner() : sessionOwner(session),
        screens,
        ...(tabs ? { tabs } : {}),
        ...(initialFields === null ? {} : { initial: [...new Map([...(recovery?.initial ?? []), ...initialFields])] }),
      }));
      await globalThis.caches?.delete(ENTRY_CACHE);
      navigator.serviceWorker?.controller?.postMessage?.({ type: "pronto:purge-entries" });
      location.reload();
      return true;
    };

    // Which show() is the latest. One that waited for a catalogue and finds a
    // later one started meanwhile mounts nothing: what it read off the
    // address is no longer the address.
    let showing = 0;
    let mutationDrain = Promise.resolve();
    const showTurn = async (navigationType, turn, boundPresentation) => {
      await mutationDrain;
      if (turn !== showing) return;
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
        const canonical = routeHref(cfg, route.screen, params, locale, { explicitLocale: asked && locale === cfg.i18n?.default });
        if (canonical !== undefined) restate(canonical);
        ({ route, params, locale, written } = currentRoute());
      }
      if (preload) preloadScreen(document, appBase, route);
      if (!answered(locale)) {
        await ensureMessages(locale);
        if (turn !== showing) return;
      }
      const explicitLocale = Boolean(cfg.i18n && locale === cfg.i18n.default && (params?.locale === locale || (typeof location !== "undefined" && new URLSearchParams(location.search).has("lang"))));
      localizeStrip(nav, cfg, { locale, here: location.pathname, search: location.search ?? "", messages, explicitLocale });
      syncExtraNav(locale, explicitLocale);
      const key = keyOf(route, params);
      const retarget = current?.el.querySelector(":scope > .screen")?.getAttribute("data-retarget-params")?.split(/\s+/).filter(Boolean) ?? [];
      const unchanged = new Set([...Object.keys(current?.params ?? {}), ...Object.keys(params)]);
      const changesRead = [...(current?.el.querySelectorAll("[data-live]") ?? [])].some((region) =>
        [...region.attributes].some((attr) => (attr.name === "data-filter" || attr.name === "data-order" || attr.name.startsWith("data-read-")) &&
          retarget.some((name) => attr.value.includes(`{param.${name}}`))));
      if (current === presented && current?.handle && current.route.screen === route.screen && current.locale === locale && retarget.length &&
          !changesRead &&
          [...unchanged].every((name) => retarget.includes(name) || current.params[name] === params[name])) {
        const displaced = held.get(key);
        if (displaced && displaced !== current) discard(displaced);
        held.delete(current.key);
        current.key = key;
        current.route = route;
        current.written = written;
        current.seq = ++seq;
        held.set(key, current);
        await current.handle.retarget(params);
        if (turn !== showing) return;
        mount.querySelector(":scope > [data-shell-error]")?.remove();
        describe(document, cfg, { route, params, locale, written, el: current.el, origin: location.origin });
        linkPrefetch.idle();
        return;
      }
      if (current) {
        current.scrollY = window.scrollY;
        current.mutationActive = false;
        mutationDrain = Promise.all([current.handle?.pause({ preservePresentation: current === presented }), current.mutationDrain?.()]);
        current.releaseInitial?.();
        current.el.inert = true;
        boundPresentation();
        if (current !== presented) {
          current.el.hidden = true;
          if (keepOf(current.route) === 0) discard(current);
        }
        current = null;
        await mutationDrain;
        if (turn !== showing) return;
      }
      const entry = held.get(key);
      if (entry !== undefined) {
        entry.locale = locale;
        entry.seq = ++seq;
        current = entry;
        try {
          await entry.ready;
          if (turn !== showing) return;
          entry.mutationActive = true;
          entry.ready = (async () => {
            await entry.handle?.resume();
            await entry.handle?.settle();
          })();
          await entry.ready;
          if (turn !== showing) return;
          reword(entry);
          if (route.screen === "cards") {
            applyPendingAuthor();
            await entry.handle?.settle();
            if (turn !== showing) return;
          }
          present(entry);
        } catch (err) {
          if (turn === showing) await restorePresentation(entry);
          if (entry !== current && entry !== presented) discard(entry);
          if (turn === showing && isMissing(err) && await heal()) return;
          throw err;
        }
        describe(document, cfg, { route, params, locale, written, el: entry.el, origin: location.origin });
        // Following a link to a screen visited before is a fresh arrival
        // however warm its DOM is, and an arrival starts at the top; going
        // back resumes. Only "push" is treated as an arrival.
        window.scrollTo(0, navigationType === "push" ? 0 : entry.scrollY);
        try { applyThemeMode(sessionStorage.getItem("snapcards-theme") || "auto"); } catch (_e) {}
        linkPrefetch.idle();
        if (preload) {
          preloadLinkedScreens(document, appBase, cfg, route.screen, [
            ...(entry.handle?.links ?? []),
            ...(hasStrip(cfg, session, mintedGuest) ? stripRoutes(cfg).map((r) => r.screen) : []),
          ]);
        }
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
      let initialLoading;
      let initialLoadingTimer;
      const releaseInitial = () => {
        clearTimeout(initialLoadingTimer);
        initialLoading?.remove();
        if (el) {
          delete el.dataset.entering;
          if (initialLoading && !fresh.gone) el.inert = false;
        }
      };
      if (adopting === null) {
        el = document.createElement("div");
        el.className = "shell-screen";
        el.hidden = presented !== null;
        if (presented === null) {
          el.dataset.entering = "";
          el.inert = true;
          initialLoading = document.createElement("p");
          initialLoading.setAttribute("role", "status");
          initialLoading.textContent = "Loading…";
          mount.append(initialLoading);
          initialLoadingTimer = setTimeout(releaseInitial, 2000);
        }
        mount.append(el);
      }
      // In the catalogues as they stand now: one taken while it mounts is
      // written in once it is on show.
      const fresh = { key, el, route, params, written, locale, words: words.taken(), scrollY: 0, seq: ++seq, mutationActive: true, releaseInitial };
      held.set(key, fresh);
      current = fresh;
      if (adopting) presented = fresh;
      try {
        const seeded = !adopting && mintedGuest && route.ssr === "ssr" ? linkPrefetch.seed(location.href) : undefined;
        // A screen composes its own links and hands the move back: the stack is
        // the terminal's, and a screen that pushed its own entry would be
        // deciding scroll and history for a back button it does not own.
        fresh.loading = interpretScreen(el, appBase, route, store, params, screenEnv(cfg, {
          messages,
          ensureMessages,
          locale,
          navigate,
          mutationActive: () => fresh.mutationActive,
          registerMutationDrain: (drain) => { fresh.mutationDrain = drain; },
          ...(seeded ? { seeded } : {}),
          ...(adopting ? { served: { screen: adopting.firstElementChild, cas: servedCas } } : {}),
        }));
        fresh.ready = fresh.loading.then(async (handle) => {
          fresh.handle = handle;
          if (fresh.gone) return handle.stop();
          await handle.settle();
        });
        await fresh.ready;
        fresh.cas = fresh.handle.cas;
        if (fresh.gone) return fresh.handle.stop();
        el.removeAttribute("data-served");
        // Hydration can leave controls usable while another region reads.
        // Capture their newer edits before restoring any saved value.
        const drafts = new Map([
          ...(recovery?.screens?.[key] ?? []),
          ...(initialFields === null ? [] : [...(recovery?.initial ?? []), ...initialFields]),
          ...captureFields(el),
        ]);
        restoreFields(el, drafts);
        if (recovery?.screens) delete recovery.screens[key];
        if (initialFields !== null) {
          initialFields = null;
          if (recovery) delete recovery.initial;
        }
        retainRecovery();
        if (current !== fresh || turn !== showing) return fresh.handle.pause();
        if (route.screen === "cards") {
          applyPendingAuthor();
          await fresh.handle.settle();
          if (turn !== showing) return;
        }
        present(fresh);
        try { applyThemeMode(sessionStorage.getItem("snapcards-theme") || "auto"); } catch (_e) {}
        // After the render: the screen's own h1 is where its name comes from.
        describe(document, cfg, { route, params, locale, written, el, origin: location.origin });
        // A screen arrived at starts at its own top. This lands there anyway
        // today, but only because hiding the outgoing screen collapses the page
        // and the browser clamps — an accident of ordering that any overlap of
        // the two screens would undo, and a cross-fade needs exactly that
        // overlap.
        if (!adopting) window.scrollTo(0, 0);
      } catch (err) {
        // A failed mount cannot be retained: revisiting it would resume a
        // slot without a hydration handle.
        if (turn === showing) await restorePresentation(fresh);
        if (current !== fresh || turn === showing) {
          if (held.get(key) === fresh) held.delete(key);
          if (current === fresh) current = null;
          fresh.gone = true;
          fresh.el.inert = true;
          fresh.handle?.stop();
          if (presented && fresh !== presented) fresh.el.remove();
        }
        if (turn === showing && isMissing(err) && await heal()) return;
        throw err;
      } finally {
        releaseInitial();
      }
      linkPrefetch.idle();
      if (preload) {
        preloadLinkedScreens(document, appBase, cfg, route.screen, [
          ...(fresh.handle?.links ?? []),
          ...(hasStrip(cfg, session, mintedGuest) ? stripRoutes(cfg).map((r) => r.screen) : []),
        ]);
      }
    };
    const show = async (navigationType = "push") => {
      const turn = ++showing;
      let deadline;
      let expire;
      const expired = new Promise((_, reject) => { expire = reject; });
      const boundPresentation = () => {
        if (deadline === undefined && presented?.el.inert) {
          deadline = setTimeout(() => expire(new Error("screen navigation timed out after 15 seconds")), 15000);
        }
      };
      boundPresentation();
      try {
        await Promise.race([showTurn(navigationType, turn, boundPresentation), expired]);
      } catch (error) {
        if (turn !== showing) return;
        const recoveryTurn = ++showing;
        const failed = current;
        if (failed && failed !== presented) {
          failed.gone = true;
          if (held.get(failed.key) === failed) held.delete(failed.key);
        }
        await restorePresentation(failed);
        if (recoveryTurn !== showing) return;
        if (failed && failed !== presented) {
          failed.handle?.stop();
          if (presented) discard(failed);
        }
        banner(error);
        throw error;
      } finally {
        clearTimeout(deadline);
      }
    };
    // A screen written in catalogues older than the ones the page holds now:
    // a deployment's, taken while it was out of sight.
    const reword = (entry) => {
      if (entry.handle === undefined || entry.words === words.taken()) return;
      entry.words = words.taken();
      entry.handle.localize();
      localizeStrip(nav, cfg, { locale: entry.locale, here: location.pathname, search: location.search ?? "", messages });
    };
    // A deployment the page could not take. One the network failed to answer
    // is an outage, said as a dropped connection is: the screen stays as it
    // was, and usable. Anything else broke it, which the reader is told as a
    // boot that failed is.
    const unheard = (err) => {
      if (!(err instanceof Unanswered)) return banner(err);
      console.error(err);
      current?.el.querySelector(".screen")?.setAttribute("data-state", "network-error");
    };
    // A newer template or style for a screen the page holds, morphed in place
    // with what the reader typed carried through it.
    const updateScreens = async (paths) => {
      for (const entry of [...held.values()]) {
        if (!paths.includes(new URL(entry.route.files.html, appBase).pathname)) continue;
        if (entry.loading && !entry.handle) await entry.loading;
        if (entry.gone || held.get(entry.key) !== entry) continue;
        const [html, css] = await Promise.all([entry.route.files.html, entry.route.files.css].map((f) => fetchText(new URL(f, appBase))));
        if (templateHash(html) !== entry.cas) {
          const saved = captureFields(entry.el);
          morphDrafts.set(entry.el, saved);
          try {
            await entry.handle.morph(html, { preserve: () => restoreFields(entry.el, saved) });
          } finally {
            morphDrafts.delete(entry.el);
            restoreFields(entry.el, saved);
          }
          entry.cas = templateHash(html);
        }
        await entry.handle.updateStyle(css);
      }
    };
    // The one way anything inside the app moves, to an address routeHref
    // composed, mounted already. Through the platform's stack where there is
    // one, so a push and a traverse stay distinguishable; by hand where there
    // is not.
    const navigate = (href, { replace = false } = {}) =>
      "navigation" in globalThis
        ? navigation.navigate(href, { history: replace ? "replace" : "push" })
        : (replace ? history.replaceState(null, "", href) : history.pushState(null, "", href), show(replace ? "replace" : "push"));
    // The entry document's <base> locates shell assets. A section fragment
    // still belongs to the visible address; preserve native scrolling/history
    // by resolving it there before the browser follows the anchor.
    const fragments = new WeakMap();
    addEventListener("click", (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target?.closest?.("a[href]");
      if (!a || a.target || a.hasAttribute("download")) return;
      const href = a.getAttribute("href");
      if (href.startsWith("#")) fragments.set(a, href);
      // Held screens reuse their anchors after a language/address change.
      const fragment = fragments.get(a);
      if (fragment !== undefined) a.href = new URL(fragment, location.href).href;
    }, true);
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
        if (url.pathname === location.pathname && url.search === (location.search ?? "")) return;
        e.preventDefault();
        navigate(url.pathname + url.search);
      }, true);
      addEventListener("popstate", () => show("traverse"));
    }

    // A deployment is a newer entry at this address. What changed between the
    // two maps decides how the page takes it (release-plan.js): screens and
    // catalogues in place, anything the page runs by restarting into it, once
    // the reader is not mid-edit, with drafts and tab rows carried through.
    let checking = null;
    // A deployment found while the reader was editing: one to restart into,
    // or one whose screens wait to be morphed.
    let pending = null;
    let deferred = false;
    let restarting = null;
    const restart = () => {
      if (restarting) return restarting;
      if (pending === null || editing()) return Promise.resolve();
      restarting = (async () => {
        const at = gesture;
        const screens = { ...recovery?.screens };
        for (const entry of held.values()) {
          screens[entry.key] = [...new Map([...(screens[entry.key] ?? []), ...captureFields(entry.el)])];
        }
        const tabs = await store.tabSnapshot();
        if (gesture !== at || editing()) return;
        sessionStorage.setItem(recoveryKey, JSON.stringify({
          expected: releaseKey(pending),
          owner: session === null ? storedSessionOwner() : sessionOwner(session),
          screens,
          tabs,
          ...(initialFields === null ? {} : { initial: [...new Map([...(recovery?.initial ?? []), ...initialFields])] }),
        }));
        // A navigation would be answered from the entry the worker kept.
        await globalThis.caches?.delete(ENTRY_CACHE);
        location.reload();
      })().finally(() => { restarting = null; });
      return restarting;
    };
    const checkRelease = () => {
      if (checking || running === null) return checking;
      checking = (async () => {
        let res;
        try {
          res = await fetch(location.href, { cache: "no-store", headers: { accept: "text/html" } });
        } catch (error) {
          // Offline, or the door is down: no deployment is learned of.
          if (error instanceof TypeError) return;
          throw error;
        }
        if (!res.ok) return;
        // A portal or a door answering for ours redirects, serves another
        // kind of document, or a page without a release map: nothing is
        // learned of, and the screen stays. A broken entry is a boot's to
        // refuse, not a running page's to tear down.
        const kind = res.headers.get("content-type");
        if (res.redirected || (kind !== null && !kind.includes("text/html"))) return;
        const found = SERVED_MAP.exec(await res.text());
        if (found === null) return;
        const next = JSON.parse(found[1]).imports;
        const plan = planRelease(running, next, cfg.routes.map((r) => ({
          html: new URL(r.files.html, appBase).pathname,
          css: new URL(r.files.css, appBase).pathname,
        })));
        if (plan.kind === "unchanged") return;
        if (plan.kind === "restart") {
          pending = next;
          await restart();
          return;
        }
        if (editing()) {
          deferred = true;
          return;
        }
        deferred = false;
        setRelease(document, next);
        running = next;
        await updateScreens(plan.screens);
        for (const name of plan.catalogues) await words.heard(name, await fetchText(new URL(name, location.origin)));
        if (current) reword(current);
      })().finally(() => { checking = null; });
      return checking;
    };
    const heed = () => checkRelease()?.catch(unheard);
    // A control losing focus only retries what was found while editing.
    const retry = () => setTimeout(() => {
      if (pending !== null) restart().catch(unheard);
      else if (deferred) heed();
    }, 0);
    document.addEventListener("focusout", retry);
    document.addEventListener("change", retry);

    await show();
    if (guestSession) await guestSession;
    booted = true;
    sessionStorage.removeItem?.(HEAL_KEY);
    // Painted from the worker's copy, which is any deployment old.
    if (document.querySelector('meta[name="pronto-kept"]')) heed();
    setInterval(heed, RELEASE_CHECK_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) heed();
    });
    return { store, navigate };
  } catch (err) {
    if (heal !== null && (isMissing(err) || document.querySelector('meta[name="pronto-kept"]')) && await heal()) return;
    banner(err);
    throw err;
  }
}
