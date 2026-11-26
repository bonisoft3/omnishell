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
// auth service and stashing {token, user} in localStorage["pronto-token"] — one
// account per device, every tab the same reader. The auth service keeps the
// device's session in an HttpOnly cookie besides, whatever way it came in by,
// so the boot takes it up where the page holds none or one expired — a
// provider's sign-in comes back to the page that way (adoptDeviceSession). Storybook
// bypasses it entirely: the fixture adapter runs without the cluster, so no auth
// service exists to sign against.

import { chromeText, describe, drawStrip, hasStrip, localizeStrip, nameOf, offersSignin, ownName, providerHref, stripRoutes, supportsPasskeys } from "./chrome.js";
import { startConsent } from "./consent.js";
import { startConversions } from "./conversions.js";
import { localeAt, localeTable, ProgramError, restatedHref, routeAt, routeHref, screenEnv, Unanswered } from "./fragment.js";
import { activateScreenStyle, fetchText, forgetFiles, interpretScreen, prefetchScreen, templateHash, submitsOnChange, AssetMissing } from "./screen.js";
import { compileCatalog } from "./vendor/messages.js";
import { filesMoved, planRelease, wordsDropped } from "./release-plan.js";
import { replayEarlyGestures, takeEarlyGestures } from "./early-replay.js";
import { navFeedback } from "./nav-feedback.js";
import { createRowAttachments } from "./row-attachments.js";
import { authPosture, createCortexNavigation, createSessionLifecycle } from "./cortex-navigation.js";
export { routeAt } from "./fragment.js";
import { assetURL, preloadLinkedScreens, preloadScreen, releaseOf, setRelease } from "./preloads.js";
import { startLinkPrefetch } from "./link-prefetch.js";
import { signalName } from "./passkey-signals.js";
import { accountLives, adoptDeviceSession, adoptGuest, askAhead, cover, deviceAccounts, deviceName, dropAhead, forgetAccount, forgetSession, keepsWork, learnDeviceAlone, loginCeremony, mintGuest, nameForm, nameTaken, postJson, providersOffered, recoveryKey, registerCeremony, rememberAccount, renameAccount, renderLogin, renderSession, renderSignin, sessionOwner, storedSessionOwner, syncAuthDOM, uncover, upgradeEarlierGuest } from "./signin.js";

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
/** The app's catalogues, keyed by tag, fetched one locale at a time: a reader
 * is in one language, and the five they are not in cost a page its first paint
 * on a slow link. `ensure` answers once the locale's file has been asked for,
 * and a locale whose file answers with a failure is left out of the map, so
 * what reads it — a screen through screenEnv, the chrome through chromeText —
 * shows the copy it was written with. A request that never answered is no
 * answer: it rejects whoever waits on it, and the next to ask asks again.
 *
 * `heard` takes a newer release's copy, in the caller's task, of a locale
 * `settle` saw answered; one still in flight when the map moved is asked again
 * at the newer address, so the older cannot land after it. `dropped` names the
 * keys a newer copy no longer holds. `taken` counts what has been taken, which a
 * screen compares with what it was last written in. */
function catalogues(appBase, i18n) {
  const messages = {};
  const witnessed = {};
  const said = {};
  const asked = new Map();
  const answered = new Set();
  let taken = 0;
  const declared = i18n?.locales ? localeTable(i18n) : {};
  const urlOf = (loc) => new URL(`messages/${loc}.json`, appBase);
  const askedAt = (pathname) => [...asked.keys()].find((l) => urlOf(l).pathname === pathname);
  const take = (loc, text) => {
    said[loc] = JSON.parse(text);
    messages[loc] = compileCatalog(said[loc]);
    witnessed[loc] = templateHash(text);
    taken++;
  };
  const load = async (loc, init) => {
    const at = assetURL(urlOf(loc)).href;
    const res = await fetch(at, init);
    const text = res.ok ? await res.text() : null;
    if (assetURL(urlOf(loc)).href !== at) return load(loc, init);
    if (text !== null) take(loc, text);
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
    settle: () => Promise.allSettled([...asked.values()]),
    dropped: (pathname, text) => {
      const loc = askedAt(pathname);
      return loc === undefined || said[loc] === undefined ? [] : wordsDropped(said[loc], JSON.parse(text));
    },
    heard: (pathname, text) => {
      const loc = askedAt(pathname);
      if (loc !== undefined && answered.has(loc) && witnessed[loc] !== templateHash(text)) take(loc, text);
    },
    taken: () => taken,
  };
}

// `preload: false` for a page that serves the app's files itself (pronto's
// single-file bundle): a preload goes to the network past the page's own
// answer, and fetches what nothing reads.
export function installModalInert(document) {
  const modalInert = new Map();
  const esc = document.defaultView?.CSS?.escape ?? ((s) => String(s).replace(/["\\]/g, "\\$&"));
  const syncModalInert = () => {
    const modal = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
      .find((el) => el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true }) && el.getClientRects().length);
    const next = new Set();
    for (let node = modal; node?.parentElement; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling === node) continue;
        if (sibling.localName === "input" && (sibling.type === "checkbox" || sibling.type === "radio") && sibling.id &&
            modal.querySelector(`label[for="${esc(sibling.id)}"]`)) continue;
        next.add(sibling);
      }
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
  document.addEventListener("change", syncModalInert, true);
  syncModalInert();
}

export function shellPreferredLanguages(served, document, navigator) {
  return served && document.documentElement.lang ? [document.documentElement.lang] : navigator?.languages;
}

export async function createShell({ config, mount, preload = true, hostDomModules }) {
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
    for (const type of ["input", "change", "keydown", "pointerdown", "click", "submit"]) {
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
    const rowAttachments = createRowAttachments(Object.fromEntries(Object.entries(cfg.cortex?.actors ?? {}).filter(([, binding]) => binding.via === "rows")));
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
      const book = await renderStorybook(mount, appBase, route, params, cfg.units ?? {}, {
        hostDom: cfg.hostDom ?? {},
        kinetic: cfg.kinetic ?? {},
        messages,
        locale,
        routes: cfg.routes,
        i18n: cfg.i18n,
        schema: cfg.schema,
        cortex: cfg.cortex,
      });
      return { storybook: true, stop: book.stop };
    }
    // Before any screen, so the tag hears the reader's consent before any
    // event; the entry's bridge (pronto's meta.googleTag) is its `gtag`.
    if (cfg.consent) {
      if (typeof globalThis.gtag !== "function") throw new Error("consent is declared, and the entry carries no tag bridge to state it to");
      const locale = arriving?.locale ?? cfg.i18n?.default;
      startConsent({
        consent: cfg.consent,
        doc: document,
        storage: localStorage,
        sessionStorage: globalThis.sessionStorage,
        navigator: globalThis.navigator,
        location,
        gtag: globalThis.gtag,
        text: (key) => chrome(key, locale),
        ready: catalogued,
        now: Date.now,
      }).catch(banner);
    }
    // After consent is stated, which the bridge takes before any event.
    const conversions = cfg.conversions
      ? startConversions({ conversions: cfg.conversions, gtag: globalThis.gtag, storage: sessionStorage })
      : null;
    const dataPlane = import("./data-sync.js");
    const offered = cfg.auth ? providersOffered(cfg) : null;

    let session = null;
    // A sign-in no longer waits for the guest minted at boot, so it can land
    // first; the guest arriving after must not take its place.
    let signedIn = false;
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
    dropAhead();
    if (cfg.auth) learnDeviceAlone();
    // One account per device: a tab whose account another tab changed — a
    // sign-in, a sign-out — is that account's page no longer. A token renewed
    // keeps its account; a tab still minting its guest takes the one stored.
    addEventListener("storage", (e) => {
      if (e.key !== "pronto-token" || (session === null && guestSession !== null)) return;
      if (sessionOwner(e.newValue === null ? null : JSON.parse(e.newValue)) !== sessionOwner(session)) location.reload();
    });
    if (cfg.auth) await upgradeEarlierGuest(cfg);
    const adopted = cfg.auth?.required || (cfg.tables?.length ?? 0) > 0 ? await adoptDeviceSession(cfg, conversions?.signedIn) : null;
    if (offered !== null) Object.assign(cfg.auth, await offered);
    if (cfg.auth?.required) {
      const stored = localStorage.getItem("pronto-token");
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
      const live = localStorage.getItem("pronto-token");
      if (live) {
        session = JSON.parse(live);
      } else {
        const gate = localeAt(cfg, location.pathname || "/", location.search ?? "", globalThis.navigator?.languages);
        await Promise.all([catalogued, ensureMessages(gate.locale)]);
        session = await renderLogin(mount, cfg, (key) => chrome(key, gate.locale), conversions?.made);
        // The gate takes its own chrome down. The navigation stack appends
        // each screen beside whatever is already mounted rather than replacing
        // it, so nothing else will: left here, the login form outlives the
        // sign-in it gated and sits above every screen for the session.
        mount.replaceChildren();
        localStorage.setItem("pronto-token", JSON.stringify(session));
      }
    } else if ((cfg.tables?.length ?? 0) > 0) {
      let stored = localStorage.getItem("pronto-token");
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
        // Minted ahead of the reader, so without the device's cookie: a sign-in
        // that finishes first keeps it, and a guest kept is adopted after.
        guestSession = mintGuest(cfg, served !== null, false).then(async (minted) => {
          if (signedIn) return minted;
          // Another of this device's tabs kept its guest first: that one is
          // this device's, and this tab's is left unused.
          const kept = JSON.parse(localStorage.getItem("pronto-token") ?? "null");
          const s = kept ?? minted;
          if (kept === null) await adoptGuest(cfg, s);
          if (signedIn) return s;
          session = s;
          if (!hadInitialOwner) initialDraftOwner = sessionOwner(s);
          localStorage.setItem("pronto-token", JSON.stringify(s));
          if (recovery && recovery.owner === null && !hadInitialOwner) {
            recovery.owner = sessionOwner(s);
            retainRecovery();
          }
          return s;
        });
      }
    }

    let nav = null;
    let signOut = null;
    let localizeCurrentStrip = null;
    const sessionLifecycle = createSessionLifecycle({
      session,
      required: Boolean(cfg.auth?.required),
      ensureSession: () => session ?? (guestSession ? guestSession : Promise.resolve(null)),
      // A guest with work signs in with its token, so another account's
      // passkey is offered rather than switched to; one that wrote nothing
      // has nothing to lose, and is switched from silently.
      passkeySignin: (s, how) => loginCeremony(cfg.auth.service, how, keepsWork(s) ? s.token : null),
      passkeyRegister: (s, _how, name) => registerCeremony(cfg.auth.service, s?.token, name),
      signOut: async () => {
        const res = await fetch(`${cfg.auth.service}/signout`, { method: "POST", credentials: "same-origin" });
        if (!res.ok) throw new Error(`${res.status} POST ${cfg.auth.service}/signout`);
      },
    });
    if (guestSession) {
      guestSession = guestSession.then((s) => {
        if (session === s) sessionLifecycle.setSession(s);
        return s;
      });
    }
    const commitGuest = async () => {
      const before = session;
      const s = await sessionLifecycle.commitGuest();
      if (!s?.user?.guest) return s;
      // Every gesture's write asks; a guest already kept is unchanged, and its
      // chip, with any panel open on it, stays as it is.
      if (before?.committed && before.token === s.token) return s;
      session = s;
      localStorage.setItem("pronto-token", JSON.stringify(s));
      const box = nav?.querySelector(":scope > .shell-me");
      if (box && offersSignin(cfg)) box.replaceWith(renderSession(s, cfg, store, chrome));
      syncAuthDOM(nav, s, { signOut, chrome, cfg, lifecycle: sessionLifecycle });
      localizeCurrentStrip?.();
      return s;
    };

    // Sign in on a device nobody signed in on asks nothing: the guest this
    // page already reads as becomes the reader, shown, and its panel opens on
    // keeping it. It wrote nothing, so a sign-in elsewhere leaves it silently.
    document.addEventListener("click", (e) => {
      const open = e.target?.closest?.(".shell-me > .shell-signin:not(.shell-guest)");
      if (!open || !session?.user?.guest || authPosture(session) !== "anonymous" || deviceAccounts().length > 0) return;
      e.stopImmediatePropagation();
      session = { ...session, shown: true };
      localStorage.setItem("pronto-token", JSON.stringify(session));
      sessionLifecycle.setSession(session);
      const box = renderSignin(cfg, null, session);
      open.closest(".shell-me").replaceWith(box);
      localizeCurrentStrip();
      syncAuthDOM(nav, session, { signOut, chrome, cfg, lifecycle: sessionLifecycle });
      box.querySelector(":scope > .shell-signin").click();
    }, true);

    await catalogued;
    const { createStore } = await dataPlane;
    // One store per session: its rows and shapes are what that session
    // reached, so another session gets a new one (becomeSession).
    const makeStore = () => createStore("", {
      ...cfg,
      appBase,
      mintedGuest,
      ensureSession: guestSession ? () => guestSession : null,
      onRemoteWrite: () => { if (gesture > 0) commitGuest(); },
    });
    let store = makeStore();
    const linkPrefetch = startLinkPrefetch({ addresses, appBase, storeOf: () => store });
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
    let preview = null;
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
    const feedback = navFeedback(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true);
    const describeEntry = (entry) => describe(document, cfg, { route: entry.route, params: entry.params, locale: entry.locale, written: entry.written, el: entry.el, origin: location.origin });
    const present = (entry) => {
      feedback.settle();
      const previous = presented;
      if (preview && preview !== entry) preview.el.hidden = true;
      preview = null;
      entry.committed = true;
      entry.el.hidden = false;
      entry.el.inert = false;
      entry.el.removeAttribute("aria-busy");
      delete entry.el.dataset.entering;
      activateScreenStyle(`screen-css-${entry.route.screen}`);
      entry.handle?.present();
      entry.onPresented?.();
      if (previous && previous !== entry) {
        previous.handle?.pause();
        previous.el.hidden = true;
        previous.el.inert = false;
        if (keepOf(previous.route) === 0) discard(previous);
      }
      presented = entry;
      syncAuthDOM(nav, session, { signOut, chrome, cfg, lifecycle: sessionLifecycle });
      mount.querySelector(":scope > [data-shell-error]")?.remove();
      evict(entry.route);
    };
    const restorePresentation = async (failed) => {
      if (current !== failed) return;
      if (failed && presented === failed) {
        failed.mutationActive = true;
        return;
      }
      current = presented;
      if (failed) {
        failed.el.hidden = presented !== null;
        failed.mutationActive = false;
        if (preview === failed) preview = null;
      }
      const previous = current;
      mutationDrain = Promise.all([failed?.handle?.pause(), failed?.mutationDrain?.()]);
      await mutationDrain;
      if (previous && current === previous) {
        previous.el.hidden = false;
        previous.el.inert = false;
        activateScreenStyle(`screen-css-${previous.route.screen}`);
        describeEntry(previous);
        previous.mutationActive = true;
        window.scrollTo(0, previous.scrollY);
        await previous.handle?.resume();
      }
    };

    localizeCurrentStrip = () => {
      if (!nav) return;
      const locale = current?.locale ?? document.documentElement.lang ?? cfg.i18n?.default;
      const explicitLocale = Boolean(cfg.i18n && locale === cfg.i18n.default && typeof location !== "undefined" && new URLSearchParams(location.search).has("lang"));
      localizeStrip(nav, cfg, { locale, here: location.pathname, search: location.search ?? "", messages, explicitLocale });
    };

    // The page becomes another session's in place — a visitor's, or another
    // account's: the screens on hand and the store's rows and shapes were the
    // last session's, so they go with it, and the address is drawn again from
    // what the next one reaches. A visitor of an app that keeps tables has its
    // next guest before anything is taken down, as its boot does, so no
    // moment shows the page without a session. A person with no strip to
    // stand in has one only as the boot draws it.
    const become = async (next) => {
      const person = next !== null && !next.user.guest;
      if (person && !nav && hasStrip(cfg, next)) {
        sessionStorage.removeItem(recoveryKey);
        localStorage.setItem("pronto-token", JSON.stringify(next));
        location.reload();
        return;
      }
      for (const entry of [...held.values()]) discard(entry);
      current = null;
      presented = null;
      preview = null;
      sessionStorage.removeItem(recoveryKey);
      recovery = null;
      forgetSession();
      if (next !== null) localStorage.setItem("pronto-token", JSON.stringify(next));
      session = next;
      signedIn = person;
      mintedGuest = next !== null && !person;
      guestSession = null;
      sessionLifecycle.setSession(next);
      await store.close();
      store = makeStore();
      globalThis.__prontoStore = store;
      linkPrefetch.forget();
      const box = nav?.querySelector(":scope > .shell-me");
      if (box) {
        box.querySelector("[data-step]")?._release?.();
        box.replaceWith(person ? renderSession(next, cfg, store, chrome)
          : offersSignin(cfg) ? renderSignin(cfg) : Object.assign(document.createElement("span"), { className: "shell-me" }));
      }
      localizeCurrentStrip();
      syncAuthDOM(nav, session, { signOut, chrome, cfg, lifecycle: sessionLifecycle });
      await show("replace");
    };
    const becomeVisitor = async () => await become((cfg.tables?.length ?? 0) > 0 ? await mintGuest(cfg, false) : null);

    // Signing out forgets the device's account. The cookies go first, or the
    // next boot takes the session up again; a sign-out that cannot reach the
    // auth service leaves the reader signed in, and on screen as they were.
    signOut = async () => {
      const outcome = await sessionLifecycle.signOut();
      if (!outcome || outcome.mode === "busy" || outcome.mode === "stopped") return;
      if (outcome.mode === "in-place") return await becomeVisitor();
      // An app that admits only a signed-in reader lands on its gate, which
      // the boot draws: the chrome comes down here because the stack appends
      // rather than replaces, so nothing else would take it down.
      for (const entry of [...held.values()]) discard(entry);
      current = null;
      nav?.remove();
      mount.replaceChildren();
      sessionStorage.removeItem(recoveryKey);
      forgetSession();
      location.reload();
    };

    const guestSignin = mintedGuest && ((cfg.auth?.providers?.length ?? 0) > 0 || supportsPasskeys());
    if (hasStrip(cfg, session, guestSignin)) {
      nav = drawStrip(document, cfg);
      // A served strip naming this strip's routes is this strip: kept, with
      // the link the reader may be on, and its words and addresses rewritten
      // in place by the first show(). One naming others is another deploy's,
      // and gives way to this one, its words written in the same task.
      const routesOf = (strip) => [
        strip.querySelector(":scope > .shell-brand") ? "1" : "0",
        ...[...strip.querySelectorAll(":scope > a[data-route]")].map(
          (a) => `${a.dataset.route}:${a.dataset.entry ?? ""}:${a.dataset.icon ?? ""}:${a.dataset.display ?? ""}`,
        ),
      ].join(" ");
      const kept = servedStrip !== null && routesOf(servedStrip) === routesOf(nav) ? servedStrip : null;
      if (kept !== null) nav = kept;
      else if (servedStrip) servedStrip.replaceWith(nav);
      else mount.before(nav);
      const servedBox = kept?.querySelector(":scope > .shell-me") ?? null;
      if (session) {
        const box = renderSession(session, cfg, store, chrome, servedBox);
        if (box !== servedBox) {
          servedBox?.remove();
          nav.append(box);
        }
      } else if (mintedGuest && offersSignin(cfg)) {
        const box = renderSignin(cfg, servedBox);
        if (box !== servedBox) {
          servedBox?.remove();
          nav.append(box);
        }
      } else servedBox?.remove();
    } else servedStrip?.remove();

    /** The account a guest's sign-in found already made, said beside the way
     * it took — in the panel, in place of its ways in: switching to it leaves
     * the guest, staying keeps it. */
    const offerTaken = (container, user, take, stay) => {
      const panel = container.closest(".shell-signin-panel");
      const shown = panel ? [...panel.children].filter((el) => !el.hidden) : [];
      for (const el of shown) el.hidden = true;
      const locale = current?.locale ?? document.documentElement.lang ?? cfg.i18n?.default;
      const feedback = document.createElement("div");
      feedback.className = "shell-auth-feedback";
      feedback.dataset.authFeedback = "";
      feedback.setAttribute("role", "alert");
      const msg = document.createElement("p");
      msg.className = "shell-auth-error";
      msg.textContent = chrome("chrome_taken", locale);
      const who = document.createElement("p");
      who.className = "shell-auth-taken";
      who.append(ownName(document, user.handle, user.name ?? undefined));
      const choices = [["chrome_switch", "switch", take], ["chrome_stay", "stay", stay]].map(([key, choice, run]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "shell-auth-choice";
        b.dataset.authChoice = choice;
        b.textContent = chrome(key, locale);
        b.addEventListener("click", async () => {
          for (const c of choices) c.disabled = true;
          const newer = await run();
          feedback.remove();
          for (const el of shown) el.hidden = false;
          // Another tab's sign-in replaced the offer this one showed: show that one.
          if (newer) offerTaken(container, newer.user, () => takeHeld(newer), () => stayHere(newer));
        });
        return b;
      });
      feedback.append(msg, who, ...choices);
      (panel ?? container).append(feedback);
    };
    // The account a sign-in found is held in the device's cookie: taking it
    // makes it the device's session from now on, staying lets it go. Either
    // names the offer it answers; a newer one comes back to be shown instead.
    const askHeld = async (choice, taken) => {
      const res = await fetch(`${cfg.auth.service}/session/${choice}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offer: taken.offer }),
      });
      if (res.status === 409) return { newer: await res.json() };
      if (!res.ok) throw new Error(`${res.status} POST ${cfg.auth.service}/session/${choice}`);
      return { res };
    };
    const takeHeld = async (taken) => {
      const asked = await askHeld("switch", taken);
      if (asked.newer) return asked.newer;
      const next = await asked.res.json();
      rememberAccount(next, taken.credential);
      if (cfg.auth?.required) {
        sessionStorage.removeItem(recoveryKey);
        localStorage.setItem("pronto-token", JSON.stringify(next));
        location.reload();
        return;
      }
      await become(next);
    };
    const stayHere = async (taken) => (await askHeld("stay", taken)).newer;
    // A guest's provider sign-in whose subject is another account's came
    // back held: the panel opens on the choice.
    if (adopted?.taken) {
      const box = nav?.querySelector(":scope > .shell-me");
      const panel = box?.querySelector(":scope > .shell-signin-panel");
      if (!panel) throw new Error("a held provider sign-in has no Sign in panel to be offered in");
      box.querySelector(":scope > .shell-signin").click();
      offerTaken(panel.querySelector(".shell-signin-ways"), adopted.taken.user, () => takeHeld(adopted.taken), () => stayHere(adopted.taken));
    }

    // Every passkey control runs here, the nav's ways in and any an app places
    // in its own markup: its neighbours wait out the ceremony, and a failure
    // is said beside it — or, where the passkey is another account's, the
    // choice between it and the guest.
    // A ceremony's neighbours wait it out.
    const hold = async (container, button, run) => {
      const neighbours = [...container.querySelectorAll("button, input, [data-auth-action], [data-auth-provider]")];
      if (button) {
        button.disabled = true;
        delete button.dataset.authError;
      }
      for (const ctrl of neighbours) {
        ctrl.disabled = true;
        ctrl.setAttribute("aria-disabled", "true");
      }
      try {
        return await run();
      } finally {
        if (button) button.disabled = false;
        for (const ctrl of neighbours) {
          ctrl.disabled = false;
          ctrl.removeAttribute("aria-disabled");
        }
      }
    };
    const localeNow = () => current?.locale ?? document.documentElement.lang ?? cfg.i18n?.default;
    // A session a ceremony brought: the chip's alone where it is the same
    // account's, the page's in place where it is another's, a new page behind
    // the gate.
    const adopt = async (outcome) => {
      const next = outcome.session;
      conversions?.signedIn(outcome.activeSession, next, outcome.transitionMode !== "in-place");
      if (outcome.transitionMode !== "in-place") {
        signedIn = !next.user.guest;
        if (!outcome.sameOwner) sessionStorage.removeItem(recoveryKey);
        localStorage.setItem("pronto-token", JSON.stringify(next));
        location.reload();
        return;
      }
      if (!outcome.sameOwner) return await become(next);
      signedIn = !next.user.guest;
      localStorage.setItem("pronto-token", JSON.stringify(next));
      session = next;
      if (nav) {
        const oldBox = nav.querySelector(":scope > .shell-me");
        oldBox?.querySelector("[data-step]")?._release?.();
        const nextBox = renderSession(next, cfg, store, chrome);
        if (oldBox) oldBox.replaceWith(nextBox);
        else nav.append(nextBox);
        localizeCurrentStrip();
      }
      syncAuthDOM(nav, next, { signOut, chrome, cfg, lifecycle: sessionLifecycle });
    };
    // The device holds nothing of this app's: the panel asks the name to make
    // the account under — the guest's, keeping its work — in place of its ways
    // in, and Back returns to them.
    const askName = (container, button) => {
      const named = nameForm((key) => chrome(key, localeNow()));
      const panel = container.closest(".shell-signin-panel");
      if (panel) cover(panel, named.form);
      else container.append(named.form);
      named.form.querySelector("input").focus();
      const back = () => {
        if (panel) uncover(named.form);
        else named.form.remove();
      };
      named.form.querySelector(".shell-name-back").addEventListener("click", () => {
        back();
        button.focus();
      });
      named.form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (sessionLifecycle.busy()) return;
        const outcome = await hold(named.form, null, () => sessionLifecycle.registerPasskey({ origin: "action", name: named.name() }));
        if (!outcome || outcome.status === "busy" || outcome.status === "stopped") return;
        if (outcome.status === "failed") {
          console.error(outcome.error);
          named.say(nameTaken(outcome.error) ? "chrome_name_taken" : "chrome_passkey_failed");
          return;
        }
        back();
        await adopt(outcome);
      });
    };

    // Every passkey control runs here, the nav's ways in and any an app places
    // in its own markup: its neighbours wait out the ceremony, and a failure
    // is said beside it — or, where the passkey is another account's, the
    // choice between it and the guest.
    // `kind` is "register", "device", "signin", or `{credential}` for one face.
    const runPasskeyAuth = async (button, kind) => {
      if (sessionLifecycle.busy()) return;
      const existingFeedback = button.closest("[data-auth-feedback]");
      const container = button.closest(".shell-signin-panel > [data-step]") ?? existingFeedback?.parentElement ?? button.parentElement;
      existingFeedback?.remove();
      for (const el of container.querySelectorAll(":scope > [data-auth-feedback]")) el.remove();
      const outcome = await hold(container, button, () =>
        kind === "register"
          ? sessionLifecycle.registerPasskey({ origin: "action" })
          : sessionLifecycle.signInPasskey({ origin: "action", how: kind === "device" ? "device" : kind === "signin" ? undefined : kind }));
      if (!outcome || outcome.status === "busy" || outcome.status === "stopped") return;
      if (outcome.status === "failed" && outcome.taken) {
        offerTaken(container, outcome.taken.user, () => takeHeld(outcome.taken), () => stayHere(outcome.taken));
        return;
      }
      if (outcome.status === "failed" && outcome.empty && kind === "device") {
        askName(container, button);
        return;
      }
      if (outcome.status === "failed") {
        console.error(outcome.error);
        button.dataset.authError = "true";
        const feedback = document.createElement("div");
        feedback.className = "shell-auth-feedback";
        feedback.dataset.authFeedback = "";
        feedback.setAttribute("role", "alert");
        const msg = document.createElement("p");
        msg.className = "shell-auth-error";
        msg.textContent = chrome("chrome_passkey_failed", localeNow());
        feedback.append(msg);
        container.append(feedback);
        return;
      }
      await adopt(outcome);
    };

    // Passkey: the accounts this device signed in to, as faces, as many as
    // the panel's width holds — a face asks for its own passkey alone, so no
    // list opens — then one field. The field holds the browser's passkey
    // autofill open (a conditional request), which offers every passkey it
    // has for the site; a new name in it and Enter or → makes one, the
    // guest's, keeping its work. A page holds one passkey request at a time,
    // so the autofill is let go before any other and taken up after it.
    const openAccounts = (button) => {
      const panel = button.closest(".shell-signin-panel");
      const say = (key) => chrome(key, localeNow());
      const step = document.createElement("div");
      step.className = "shell-accounts";
      step.append(parseMarkup(document, `<div class="shell-accounts-head"><button type="button" class="shell-accounts-back"><svg class="shell-back-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button><span class="shell-accounts-title"></span></div>`));
      step.querySelector(".shell-accounts-back").setAttribute("aria-label", say("chrome_back"));
      step.querySelector(".shell-accounts-title").textContent = say("chrome_device");
      const accounts = deviceAccounts();
      if (accounts.length > 0) {
        const faces = document.createElement("div");
        faces.className = "shell-faces";
        for (const account of accounts) {
          const name = nameOf(account.handle);
          const face = parseMarkup(document, `<div class="shell-face" role="group"><button type="button" class="shell-face-pick" data-auth-action="face"><span class="shell-face-mark" aria-hidden="true"></span><span class="shell-face-name"></span></button><button type="button" class="shell-face-forget" data-auth-action="forget"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`).firstElementChild;
          face.setAttribute("aria-label", name);
          face.dataset.account = account.id;
          face.querySelector(".shell-face-pick").dataset.credential = account.credential;
          face.querySelector(".shell-face-mark").textContent = [...name][0]?.toLocaleUpperCase() ?? "";
          // Each face its own hue, the same every time it is drawn.
          face.style.setProperty("--shell-face-hue", String([...account.id].reduce((h, c) => (h * 31 + c.codePointAt(0)) % 360, 7)));
          face.querySelector(".shell-face-name").textContent = name;
          const forget = face.querySelector(".shell-face-forget");
          forget.setAttribute("aria-label", say("chrome_forget"));
          forget.title = say("chrome_forget");
          faces.append(face);
        }
        step.append(faces);
        // The faces the row's width holds, the most recent first; the rest
        // are the field's autofill.
        const fit = () => {
          const room = faces.clientWidth;
          for (const face of faces.children) face.hidden = false;
          if (room === 0) return;
          for (const face of faces.children) face.hidden = face.offsetLeft - faces.offsetLeft + face.offsetWidth > room;
        };
        if (globalThis.ResizeObserver) new ResizeObserver(fit).observe(faces);
      }
      const form = parseMarkup(document, `<form class="shell-passkey-form"><input id="shell-passkey-name" name="username" autocomplete="username webauthn"><button type="submit" class="shell-passkey-go"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button><p class="shell-auth-error" role="alert" hidden></p></form>`).firstElementChild;
      const input = form.querySelector("input");
      input.setAttribute("placeholder", say("chrome_name_label"));
      input.setAttribute("aria-label", say("chrome_name_label"));
      const go = form.querySelector(".shell-passkey-go");
      go.setAttribute("aria-label", say("chrome_create_passkey"));
      go.title = say("chrome_create_passkey");
      const error = form.querySelector(".shell-auth-error");
      const failed = (err, key = "chrome_passkey_failed") => {
        console.error(err);
        error.textContent = say(key);
        error.hidden = false;
      };
      step.append(form);

      let listening = null;
      const release = () => {
        listening?.abort();
        listening = null;
      };
      const listen = async () => {
        if (listening !== null || !step.isConnected) return;
        const held = (listening = new AbortController());
        if (!(await globalThis.PublicKeyCredential?.isConditionalMediationAvailable?.())) return;
        let next;
        try {
          next = await loginCeremony(cfg.auth.service, { conditional: held.signal }, keepsWork(session) ? session.token : null);
        } catch (err) {
          if (held.signal.aborted) return;
          listening = null;
          if (err?.taken) {
            return offerTaken(step, err.taken.user, () => takeHeld(err.taken), async () => {
              const newer = await stayHere(err.taken);
              listen();
              return newer;
            });
          }
          // The autofill refused is the reader's no, or no passkey here for
          // this site: nothing to say. Any other failure is said, and waits for
          // the reader: listening again at once would ask a failing service for
          // challenges unending.
          if (err?.name !== "NotAllowedError") failed(err);
          return;
        }
        listening = null;
        await adopt({ session: next, sameOwner: sessionOwner(next) === sessionOwner(session), transitionMode: cfg.auth?.required ? "reload" : "in-place" });
      };
      step._release = release;
      step._listen = listen;

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (sessionLifecycle.busy()) return;
        release();
        error.hidden = true;
        const outcome = await hold(form, null, () => sessionLifecycle.registerPasskey({ origin: "action", name: input.value.trim() || deviceName() || undefined }));
        if (!outcome || outcome.status === "busy" || outcome.status === "stopped") return listen();
        if (outcome.status === "failed") {
          failed(outcome.error, nameTaken(outcome.error) ? "chrome_name_taken" : "chrome_passkey_failed");
          return listen();
        }
        await adopt(outcome);
      });
      step.querySelector(".shell-accounts-back").addEventListener("click", () => {
        uncover(step);
        button.focus();
      });
      step._opener = button;
      cover(panel, step);
      askAhead(cfg.auth.service);
      (step.querySelector(".shell-face-pick") ?? input).focus();
      listen();
    };

    // A rename edits the chip in place: the name, and Save; the suffix
    // others see stays. A person whose app keeps their name (auth.self.name) renames it
    // there; anyone else renames the account, guest or person — a visitor's
    // rename keeps the guest first, which then has a chip to rename.
    const startRename = async () => {
      if (sessionLifecycle.posture() === "anonymous") await commitGuest();
      const box = nav?.querySelector(":scope > .shell-me");
      const open = box?.querySelector(":scope > :is(.shell-signin.shell-guest, .shell-person)");
      if (!open) throw new Error("a rename has no account chip to edit");
      const panel = box.querySelector(":scope > .shell-signin-panel");
      panel.hidden = true;
      open.setAttribute("aria-expanded", "false");
      const shown = open.querySelector(".shell-chip-who .handle");
      const form = document.createElement("form");
      form.className = "shell-rename-form";
      form.append(parseMarkup(document, `<label class="shell-rename-label" for="shell-rename-input"></label>
        <input id="shell-rename-input" name="nickname" autocomplete="nickname">
        <button type="submit" class="shell-rename-save"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg></button>
        <p class="shell-auth-error" role="alert" hidden></p>`));
      form.querySelector("label").textContent = chrome("chrome_name_label", localeNow());
      form.querySelector(".shell-rename-save").setAttribute("aria-label", chrome("chrome_save", localeNow()));
      const input = form.querySelector("input");
      input.value = shown.firstChild?.textContent ?? "";
      open.hidden = true;
      open.before(form);
      input.focus();
      input.select?.();
      const done = () => {
        form.remove();
        open.hidden = false;
        open.focus();
      };
      form.addEventListener("keydown", (e) => {
        if (e.key === "Escape") done();
      });
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const called = input.value.trim();
        if (called === "" || called === input.defaultValue) return done();
        const self = cfg.auth?.self;
        try {
          const next = await hold(form, null, async () => {
            if (self?.name !== undefined && !session.user.guest) {
              await store.patch(self.name.table, [{ key: session.user.id, changes: { [self.name.column]: called } }]);
              return null;
            }
            return await postJson(`${cfg.auth.service}/rename`, { name: called }, session.token);
          });
          if (next === null) return done();
          if (session.committed) next.committed = true;
          // Only a device that signed in with a passkey has one to rename.
          if (session.passkey) next.passkey = session.passkey;
          else delete next.passkey;
          session = next;
          localStorage.setItem("pronto-token", JSON.stringify(next));
          sessionLifecycle.setSession(next);
          signalName(next, nameOf(next.user.handle));
          renameAccount(next.user.id, next.user.handle);
          box.replaceWith(renderSession(next, cfg, store, chrome));
          localizeCurrentStrip();
          syncAuthDOM(nav, next, { signOut, chrome, cfg, lifecycle: sessionLifecycle });
          nav.querySelector(":scope > .shell-me > :is(.shell-signin, .shell-person)")?.focus();
        } catch (err) {
          console.error(err);
          const error = form.querySelector(".shell-auth-error");
          error.textContent = chrome(nameTaken(err) ? "chrome_name_taken" : "chrome_passkey_failed", localeNow());
          error.hidden = false;
        }
      });
    };
    /** A provider's sign-in, by navigation: a guest with work goes with its
     * token as OpenID Connect's id_token_hint, posted, so the token is in no
     * URL and the provider's subject becomes the guest. The post is fetched
     * and the page goes where it answers: a form's redirect to the provider is
     * one the page's CSP (form-action 'self') refuses. */
    const startProvider = async (provider, here) => {
      if (!keepsWork(sessionLifecycle.session())) {
        location.href = providerHref(cfg.auth.service, provider, here);
        return;
      }
      const res = await fetch(providerHref(cfg.auth.service, provider, here).split("?")[0], {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        body: new URLSearchParams({ id_token_hint: sessionLifecycle.session().token, return: here }),
      });
      if (!res.ok) throw new Error(`${res.status} POST ${cfg.auth.service}/oidc/${provider}/start`);
      location.href = (await res.json()).to;
    };
    globalThis.addEventListener?.("message", (e) => {
      if (e.origin !== location.origin || e.data?.fallback !== "redirect" || e.data?.add === true) return;
      if (typeof e.data.provider !== "string" || !cfg.auth?.service || sessionLifecycle.busy()) return;
      if (e.source && ![...document.querySelectorAll("iframe.shell-provider-active")].some((f) => f.contentWindow === e.source)) return;
      const here = `${location.pathname ?? "/"}${location.search ?? ""}${location.hash ?? ""}`;
      void startProvider(e.data.provider, here);
    });
    document.addEventListener("click", (e) => {
      const providerEl = e.target?.closest?.("[data-auth-provider], .shell-me a.shell-provider[data-provider]");
      if (providerEl && cfg.auth?.service) {
        if (providerEl.localName !== "label") e.preventDefault();
        if (sessionLifecycle.busy()) return;
        const provider = providerEl.dataset.authProvider ?? providerEl.dataset.provider;
        const here = `${location.pathname ?? "/"}${location.search ?? ""}${location.hash ?? ""}`;
        void startProvider(provider, here);
        return;
      }
      const actionEl = e.target?.closest?.("[data-auth-action]");
      if (!actionEl) return;
      const action = actionEl.dataset.authAction;
      if (action === "signout") {
        if (actionEl.localName !== "label") e.preventDefault();
        signOut();
      } else if (action === "rename" && cfg.auth?.service) {
        if (actionEl.localName !== "label") e.preventDefault();
        startRename();
      } else if (action === "device" && cfg.auth?.service) {
        if (actionEl.localName !== "label") e.preventDefault();
        runPasskeyAuth(actionEl, "device");
      } else if (action === "accounts" && cfg.auth?.service) {
        openAccounts(actionEl);
      } else if (action === "face" && cfg.auth?.service) {
        const step = actionEl.closest("[data-step]");
        step._release();
        runPasskeyAuth(actionEl, { credential: actionEl.dataset.credential }).then(() => step._listen());
      } else if (action === "forget") {
        const face = actionEl.closest(".shell-face");
        forgetAccount((a) => a.id === face.dataset.account);
        const step = face.closest("[data-step]");
        uncover(step);
        openAccounts(step._opener);
      } else if (action === "delete-account" && cfg.auth?.service) {
        if (actionEl.localName !== "label") e.preventDefault();
        if (!actionEl.hasAttribute("data-confirm")) {
          actionEl.setAttribute("data-confirm", "");
          return;
        }
        void (async () => {
          if (sessionLifecycle.busy()) return;
          const active = session ?? sessionLifecycle.session();
          const bearer = active?.token;
          if (!bearer) return;
          const res = await fetch(`${cfg.auth.service}/account`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${bearer}` },
          });
          if (!res.ok) throw new Error(`DELETE ${cfg.auth.service}/account failed: ${res.status}`);
          const bridge = globalThis.AuthBridge ?? globalThis.__omnishellAuth;
          bridge?.clearSession?.();
          await store?.wipeAccountData?.(active?.user?.id);
          // A deleted account is no longer one of this device's to sign in as.
          forgetAccount((a) => a.id === active?.user?.id);
          for (const entry of [...held.values()]) discard(entry);
          current = null;
          nav?.remove();
          mount.replaceChildren();
          forgetSession();
          location.reload();
        })();
      } else if (action === "passkey-signin" && cfg.auth?.service) {
        if (actionEl.localName !== "label") e.preventDefault();
        runPasskeyAuth(actionEl, "signin");
      } else if (action === "passkey-register" && cfg.auth?.service) {
        if (actionEl.localName !== "label") e.preventDefault();
        runPasskeyAuth(actionEl, "register");
      }
    });

    // The address this mount is already rendering, spelled as it should be.
    // The Navigation API reports a replaceState as a navigation, and taking
    // that one would mount the screen a second time under the first.
    let restating = false;
    const scrollFragment = (root, hash) => {
      if (!hash) return false;
      let id;
      try {
        id = decodeURIComponent(hash.slice(1));
      } catch (error) {
        if (error instanceof URIError) return false;
        throw error;
      }
      const target = [...root.querySelectorAll("[id]")].find((el) => el.id === id);
      if (!target) return false;
      target.scrollIntoView();
      return true;
    };
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
        if (canonical !== undefined) restate(restatedHref(canonical, location.search, location.hash));
        ({ route, params, locale, written } = currentRoute());
      }
      if (preload) preloadScreen(document, appBase, route);
      if (!answered(locale)) {
        await ensureMessages(locale);
        if (turn !== showing) return;
      }
      const explicitLocale = Boolean(cfg.i18n && locale === cfg.i18n.default && (params?.locale === locale || (typeof location !== "undefined" && new URLSearchParams(location.search).has("lang"))));
      localizeStrip(nav, cfg, { locale, here: location.pathname, search: location.search ?? "", messages, explicitLocale });
      // A navigation closes the shown screen's open popovers, whether it leaves
      // the screen or retargets it: the top layer would keep them over the next
      // view, and over the screen when it comes back.
      for (const popover of presented?.el.querySelectorAll("[popover]") ?? []) popover.hidePopover?.();
      const key = keyOf(route, params);
      const retarget =current?.el.querySelector(":scope > .screen")?.getAttribute("data-retarget-params")?.split(/\s+/).filter(Boolean) ?? [];
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
        current.mutationActive = true;
        await current.handle.retarget(params);
        if (turn !== showing) return;
        feedback.settle();
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
          if (preview === current) {
            preview = null;
            if (presented) {
              presented.el.hidden = false;
              activateScreenStyle(`screen-css-${presented.route.screen}`);
              describeEntry(presented);
              window.scrollTo(0, presented.scrollY);
            }
          }
          if (keepOf(current.route) === 0) discard(current);
        }
        current = null;
        await mutationDrain;
        if (turn !== showing) return;
      }
      const prior = held.get(key);
      if (prior?.navigating) discard(prior);
      const entry = held.get(key);
      if (entry !== undefined) {
        entry.locale = locale;
        entry.seq = ++seq;
        current = entry;
        try {
          await entry.ready;
          if (turn !== showing) return;
          entry.mutationActive = true;
          reword(entry);
          // What it drew is on hand, so it shows at once and refreshes behind:
          // resuming first kept a screen in memory hidden through every read
          // its regions ask again.
          present(entry);
          // Following a link to a screen visited before is a fresh arrival
          // however warm its DOM is, and an arrival starts at the top; going
          // back resumes. Only "push" is treated as an arrival.
          window.scrollTo(0, navigationType === "push" ? 0 : entry.scrollY);
          // A frame's callbacks run before its paint, so what follows waits for
          // the task after it, or resuming would hold back the paint it follows.
          if (document.visibilityState === "visible") {
            await new Promise((painted) => requestAnimationFrame(() => setTimeout(painted)));
          }
          if (turn !== showing) return;
          entry.ready = (async () => {
            await entry.handle?.resume();
            await entry.handle?.settle();
          })();
          await entry.ready;
          if (turn !== showing) return;
        } catch (err) {
          if (turn === showing) await restorePresentation(entry);
          if (entry !== current && entry !== presented) discard(entry);
          if (turn === showing && isMissing(err) && await heal()) return;
          throw err;
        }
        describe(document, cfg, { route, params, locale, written, el: entry.el, origin: location.origin });
        if (navigationType === "push") scrollFragment(entry.el, location.hash);
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
      // A tab opened offline paints what the worker kept, rows and all: its
      // store can read nothing yet, so the page is taken over once the browser
      // is back online, whether or not the device holds a session.
      if (adopting !== null && globalThis.navigator?.onLine === false) {
        await new Promise((resolve) => addEventListener("online", resolve, { once: true }));
        if (turn !== showing) return;
      }
      let el = adopting;
      let initialLoading;
      let initialLoadingTimer;
      const releaseInitial = () => {
        clearTimeout(initialLoadingTimer);
        initialLoading?.remove();
        if (initialLoading) mount.removeAttribute("aria-busy");
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
          // Before any catalogue, so no words: a pulse reads in every language.
          initialLoading = document.createElement("div");
          initialLoading.dataset.initialLoading = "";
          initialLoading.setAttribute("aria-hidden", "true");
          initialLoading.style.cssText = "position:fixed;inset:0;pointer-events:none;background:currentColor;opacity:.05";
          if (!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
            initialLoading.animate?.([{ opacity: 0.03 }, { opacity: 0.1 }], { duration: 1100, iterations: Infinity, direction: "alternate", easing: "ease-in-out" });
          }
          mount.setAttribute("aria-busy", "true");
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
          ...(hostDomModules ? { hostDomModules } : {}),
          messages,
          ensureMessages,
          rowAttachments,
          locale,
          navigate: (href, options) => {
            const target = new URL(href, location.href);
            if (!fresh.committed && (target.origin !== location.origin || target.pathname !== location.pathname || target.search !== (location.search ?? ""))) fresh.navigating = true;
            return navigate(href, options);
          },
          mutationActive: () => fresh.mutationActive,
          registerMutationDrain: (drain) => { fresh.mutationDrain = drain; },
          presented: new Promise((resolve) => { fresh.onPresented = resolve; }),
          ...(!adopting && presented !== null ? { onHeadReady: async (_screen, cas, settleActions) => {
            await settleActions();
            if (current !== fresh || turn !== showing || fresh.gone || fresh.navigating) return;
            fresh.cas = cas;
            feedback.settle();
            preview = fresh;
            presented.el.hidden = true;
            el.hidden = false;
            el.inert = true;
            el.setAttribute("aria-busy", "true");
            delete el.dataset.entering;
            activateScreenStyle(`screen-css-${route.screen}`);
            window.scrollTo(0, 0);
            describe(document, cfg, { route, params, locale, written, el, origin: location.origin });
          } } : {}),
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
        await replayEarlyGestures(document, () => fresh.handle.settle());
        if (current !== fresh || turn !== showing || fresh.navigating) return fresh.handle.pause();
        present(fresh);
        // After the render: the screen's own h1 is where its name comes from.
        describe(document, cfg, { route, params, locale, written, el, origin: location.origin });
        if (!adopting && !scrollFragment(el, location.hash)) window.scrollTo(0, 0);
      } catch (err) {
        takeEarlyGestures();
        feedback.settle();
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
    const activate = async (navigationType = "push", signal) => {
      if (signal?.aborted) return;
      const turn = ++showing;
      let resolveAbort;
      const aborted = new Promise((resolve) => { resolveAbort = resolve; });
      const cancel = () => {
        if (turn === showing) showing++;
        resolveAbort();
      };
      signal?.addEventListener("abort", cancel, { once: true });
      let deadline;
      let expire;
      const expired = new Promise((_, reject) => { expire = reject; });
      // What the bound found when it fired: the screen it was waiting on and
      // what that screen was waiting on, so a report names a cause rather than
      // the bound alone.
      const timedOut = () => {
        const target = current;
        const screen = target?.route.screen ?? currentRoute().route.screen;
        const phase = !target ? "between screens, draining the last screen's writes"
          : target.handle === undefined ? "loading its template and modules"
          : target !== presented ? "settling its regions"
          : target.el.inert ? "re-targeting the screen on show"
          : "before leaving the screen on show, awaiting the destination's catalogue or the last screen's writes";
        const hydrating = [...(target?.el.querySelectorAll("[data-hydrating]") ?? [])];
        const regions = hydrating.slice(0, 5).map((r) => `${r.dataset.live ?? r.localName}${r.dataset.filter ? `?${r.dataset.filter}` : ""}`);
        const state = target?.el.querySelector(":scope > .screen")?.getAttribute("data-state") ?? undefined;
        const inflight = (globalThis.performance?.getEntriesByType?.("resource") ?? [])
          .filter((r) => r.responseEnd === 0 && !/[?&]live=true/.test(r.name))
          .map((r) => r.name.replace(location.origin, "").slice(0, 120)).slice(0, 5);
        const error = new Error([
          `screen navigation timed out after 15 seconds: ${screen} at ${location.pathname}, ${phase}`,
          state === undefined ? null : `screen state ${state}`,
          hydrating.length === 0 ? null : `${hydrating.length} region(s) still hydrating: ${regions.join(", ")}`,
          inflight.length === 0 ? null : `request(s) in flight: ${inflight.join(", ")}`,
          presented ? `screen on show: ${presented.route.screen}` : null,
        ].filter(Boolean).join("; "));
        error.details = { screen, path: location.pathname, phase, state, hydrating: regions, inflight, presented: presented?.route.screen };
        return error;
      };
      // Bounded from the click, whenever a screen is on show: a turn stalls
      // before it stages anything too, awaiting the last screen's writes, and
      // a bound that armed only once the presented screen went inert left that
      // wait silent for good. Initial hydration keeps no bound.
      const boundPresentation = () => {
        if (deadline === undefined && presented) {
          deadline = setTimeout(() => expire(timedOut()), 15000);
        }
      };
      boundPresentation();
      try {
        await Promise.race([showTurn(navigationType, turn, boundPresentation), expired, aborted]);
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
        // The outgoing screen is back on show, so the address and the strip
        // say so too: a link pulsed for a destination that never came, and the
        // strip marked the address the navigation had already taken.
        feedback.settle();
        if (presented) {
          const shown = presented;
          // After this navigation has finished failing: restating the address
          // from inside its own handler aborts it, and the failure would read
          // as an abort rather than its cause.
          setTimeout(() => {
            if (presented !== shown || current !== shown || recoveryTurn !== showing) return;
            const back = routeHref(cfg, shown.route.screen, shown.params, shown.locale, {
              explicitLocale: Boolean(cfg.i18n && shown.locale === cfg.i18n.default && shown.params?.locale === shown.locale),
            });
            if (back !== undefined && new URL(back, location.href).pathname !== location.pathname) restate(back);
            if (nav) localizeStrip(nav, cfg, { locale: shown.locale, here: location.pathname, search: location.search ?? "", messages });
          }, 0);
        }
        banner(error);
        throw error;
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", cancel);
      }
    };
    const cortex = cfg.cortex === undefined ? undefined : createCortexNavigation(cfg.cortex, (request, { signal }) => {
      if (currentRoute().route.screen !== request.screen || location.pathname !== request.pathname || location.search !== request.search) throw new ProgramError("Cortex navigation no longer matches the requested route");
      return activate(request.navigationType, signal);
    }, (binding, spec) => rowAttachments.attach(binding, spec));
    const show = (navigationType = "push") => {
      if (!cortex) return activate(navigationType);
      if (current) current.mutationActive = false;
      return cortex.navigate({ screen: currentRoute().route.screen, pathname: location.pathname, search: location.search, navigationType });
    };
    // A screen written in catalogues older than the ones the page holds now:
    // a deployment's, taken while it was out of sight.
    const reword = (entry) => {
      if (entry.handle === undefined || entry.words === words.taken()) return;
      entry.words = words.taken();
      entry.handle.localize();
      syncAuthDOM(nav, session, { signOut, chrome, cfg, lifecycle: sessionLifecycle });
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
    const updateHandlers = async (paths) => {
      for (const entry of [...held.values()]) {
        if (entry.loading && !entry.handle) await entry.loading;
        if (entry.gone || held.get(entry.key) !== entry) continue;
        await entry.handle.updateHandlers(paths);
      }
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
      const to = new URL(a.href, location.href);
      if (to.origin === location.origin && to.pathname !== location.pathname && addresses(to) !== null) feedback.press(a);
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
        if (url.pathname === location.pathname && url.search === (location.search ?? "")) {
          if (url.hash && current) {
            e.intercept({ scroll: "manual", handler: () => scrollFragment(current.el, url.hash) });
            return;
          }
          // The strip offers a link to the address on show on every screen. Left
          // to the browser it loads a document in the page's place, and what
          // the link asked (a pending author) goes with the page.
          if (addresses(url) !== null) e.intercept({ scroll: "manual", handler: () => show("replace") });
          return;
        }
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
        if (url.pathname === location.pathname && url.search === (location.search ?? "")) {
          e.preventDefault();
          if (url.hash && current) {
            history.pushState(null, "", url.href);
            scrollFragment(current.el, url.hash);
            return;
          }
          show("replace");
          return;
        }
        e.preventDefault();
        navigate(url.pathname + url.search + url.hash);
      }, true);
      addEventListener("popstate", () => {
        const { route, params } = currentRoute();
        if (current?.key === keyOf(route, params)) {
          if (!scrollFragment(current.el, location.hash)) window.scrollTo(0, 0);
          return;
        }
        show("traverse");
      });
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
          handlers: (r.files.handlers ?? []).map((f) => new URL(f, appBase).pathname),
        })));
        if (plan.kind === "unchanged") return;
        // A template the page still holds may name a key until it is morphed,
        // and a template it takes names the newer ones from the first word it
        // localizes: only a catalogue that keeps every key is taken in place.
        const said = plan.kind === "morph"
          ? await Promise.all(plan.catalogues.map(async (name) => [name, await fetchText(new URL(next[name], location.origin))]))
          : [];
        await words.settle();
        if (plan.kind === "restart" || said.some(([name, text]) => words.dropped(name, text).length > 0)) {
          pending = next;
          await restart();
          return;
        }
        if (editing()) {
          deferred = true;
          return;
        }
        deferred = false;
        // The words and the map in one task, before any template is fetched
        // or morphed: no screen reads one release's markup against another's
        // catalogue, whether it is morphed here or mounted meanwhile.
        for (const [name, text] of said) words.heard(name, text);
        forgetFiles(filesMoved(running, next));
        setRelease(document, next);
        await updateHandlers(plan.handlers);
        await updateScreens(plan.screens);
        // Only now: a failed update is found again at the next check, not taken for done.
        running = next;
        if (current) reword(current);
      })().finally(() => { checking = null; });
      return checking;
    };
    const heed = () => checkRelease()?.catch(unheard);
    // A control losing focus only retries what was found while editing, and
    // with nothing found it schedules nothing: every blur and change on the
    // page would otherwise cost a task.
    const retry = () => {
      if (pending === null && !deferred) return;
      setTimeout(() => {
        if (pending !== null) restart().catch(unheard);
        else if (deferred) heed();
      }, 0);
    };
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
    return { get store() { return store; }, navigate, cortex, sessionLifecycle };
  } catch (err) {
    if (heal !== null && (isMissing(err) || document.querySelector('meta[name="pronto-kept"]')) && await heal()) return;
    banner(err);
    throw err;
  }
}
