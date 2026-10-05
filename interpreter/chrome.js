// The terminal's own chrome: the words it says in its own voice, outside any
// screen's markup — the login gate, and the control that ends a session — and
// the two things it draws around a screen, the nav strip and the document's
// head. They live here rather than in fragment.js because that leaf is the data
// plane's grammar and this is the page, and here rather than in shell.js
// because a page is drawn in more than one place: the shell draws it live, and
// a document rendered anywhere a DOM exists (document.js) draws the same one
// before any script runs. Nothing here reads an ambient document or location:
// check-i18n grades an app against the copy without a DOM, and a server draws
// many documents in one process.
//
// An app carrying catalogues answers these keys like any other, and check-i18n
// makes a missing one an error. The strings below are what the terminal says
// standalone, and what every app declaring no catalogue at all shows.

import { directionOf, localeTable, routeHref, routeParams } from "./fragment.js";

// The gate's copy, reachable only where the app requires a sign-in.
const LOGIN = {
  chrome_signin_hint: "One tap with your passkey — new here, one is created for you.",
  chrome_signin: "Continue",
  chrome_signin_guest: "Continue as guest",
  chrome_signin_failed: "That did not go through. Try again.",
};

// The strip's, drawn wherever a session exists — behind a gate, or as the guest
// every app with a table of its own is handed.
const SESSION = {
  chrome_signout: "sign out",
};

// A guest's way to a passkey, drawn where the app offers one (auth.promote).
const PROMOTE = {
  chrome_passkey: "sign in",
  chrome_passkey_failed: "sign-in did not go through",
};

/** Which copy a reader can reach, by the surface that shows it: an app is asked
 * for the group its own declaration puts on screen, never for the rest. */
export const CHROME_KEYS = { login: Object.keys(LOGIN), session: Object.keys(SESSION), promote: Object.keys(PROMOTE) };

export const CHROME = { ...LOGIN, ...SESSION, ...PROMOTE };

/** What the chrome says, in the language the page is in. A key no group holds
 * is the terminal asking for copy it never wrote, which no catalogue can
 * answer. */
export function chromeText(key, { messages, locale } = {}) {
  if (!Object.hasOwn(CHROME, key)) throw new Error(`no chrome copy named "${key}"`);
  return messages?.[locale]?.[key] ?? CHROME[key];
}

/** The routes the strip links. Parametrized routes have no static href; they
 * are reached from rows. A route may also take itself off the strip, when it is
 * reached from somewhere more specific than "everywhere". */
export function stripRoutes(cfg) {
  return cfg.routes.filter((r) => !r.path.includes(":") && r.nav.strip !== false);
}

/** Whether a page carries a strip: one link is no choice, but a session is
 * always someone the reader should see. */
export function hasStrip(cfg, session) {
  return stripRoutes(cfg).length > 1 || Boolean(session);
}

/** The strip, before any locale is resolved. Its addresses change with the
 * one the reader is in, so it names routes, and localizeStrip writes the hrefs
 * on every navigation. */
export function drawStrip(doc, cfg) {
  const nav = doc.createElement("nav");
  for (const r of stripRoutes(cfg)) {
    const a = doc.createElement("a");
    a.setAttribute("data-route", r.screen);
    a.textContent = r.nav.label;
    nav.append(a);
  }
  return nav;
}

/** A guest's end of the strip where the app offers a passkey (auth.promote):
 * one gesture to sign in, its word the strip's to write in the page's language
 * (localizeStrip), the key saying which word. */
export function guestBox(doc) {
  const box = doc.createElement("span");
  box.className = "shell-me";
  const signIn = doc.createElement("button");
  signIn.setAttribute("type", "button");
  signIn.className = "shell-signin";
  signIn.setAttribute("data-key", "chrome_passkey");
  box.append(signIn);
  return box;
}

/** The strip's addresses, its words and its state, all re-derived per
 * navigation: an href carries the locale of the page it is on, so does a
 * label, and aria-current names the link that IS this page — which is the
 * link whose address is this one (`here`, a pathname), not merely a link to
 * the same route with someone else's :params. */
export function localizeStrip(nav, cfg, { locale, here, messages, explicitLocale = false } = {}) {
  if (!nav) return;
  for (const a of nav.querySelectorAll("a[data-route]")) {
    const href = routeHref(cfg, a.getAttribute("data-route"), routeParams(a), locale, { explicitLocale });
    if (href === undefined) a.removeAttribute("href");
    else a.setAttribute("href", href);
    if (href !== undefined && (a.getAttribute("href") === here || new URL(href, "https://shell.local").pathname === here)) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  // The strip's own links, and not the person's: renderSession's anchor
  // names a route too, and is a name and a handle rather than a word — a
  // label written onto it takes both down.
  for (const a of nav.querySelectorAll(":scope > a[data-route]")) {
    // A key is absent on a route the app declares none for, and on every
    // route of an app declaring no catalogues: the table's own spelling
    // stands, which is the language it was written in. The word is the
    // catalogue's, read as a screen reads one, so whatever brings the
    // catalogues current (shell.js catalogues) brings the strip with them.
    const { key, label } = cfg.routes.find((r) => r.screen === a.getAttribute("data-route"))?.nav ?? {};
    if (key === undefined) continue;
    a.textContent = messages?.[locale]?.[key] ?? messages?.[cfg.i18n?.default]?.[key] ?? label;
  }
  const out = nav.querySelector(".shell-signout");
  if (out) out.textContent = chromeText("chrome_signout", { messages, locale });
  const signIn = nav.querySelector(".shell-signin");
  if (signIn) signIn.textContent = chromeText(signIn.getAttribute("data-key"), { messages, locale });
}

/** What a document says it IS. One entry file answers at every address, so its
 * head names no screen and no language of its own: until this runs, every
 * route of every locale is the entry's language, titled with the app. A screen
 * reader takes the document's language from that attribute, and a crawler has
 * no other source for the title or for the fact that three addresses are one
 * page in three languages.
 *
 * `el` is the rendered screen, whose h1 names it; `origin` is spelled ahead of
 * every link, which is what makes them absolute: the origin the reader arrived
 * at, so nothing here has to be told where the app is deployed, or what stands
 * for it in a document rendered before any request. */
export function describe(doc, cfg, { route, params, locale, written, el, origin }) {
  // The language RENDERED, which is what a screen reader has to pronounce,
  // and which way its script runs, which is what the nav strip, the
  // scrollbar and every unstyled box take their side from. It is the
  // address's own everywhere but a plain route carrying `?lang=`, which
  // names a language without naming an address. An app that declares no
  // locales resolves none and makes no claim: the entry document's own
  // attributes stand rather than being overwritten with `undefined`.
  if (locale !== undefined) {
    doc.documentElement.setAttribute("lang", locale);
    doc.documentElement.setAttribute("dir", directionOf(locale));
  }
  // A screen's h1 names it; a screen without one — the home screen — is
  // the app itself.
  const name = el.querySelector("h1")?.textContent?.trim();
  let title = doc.querySelector("title");
  if (title === null) {
    title = doc.createElement("title");
    doc.head.append(title);
  }
  title.textContent = name ? `${name} — ${cfg.app}` : cfg.app;

  for (const old of doc.head.querySelectorAll('link[rel="canonical"], link[rel="alternate"][hreflang]')) {
    old.remove();
  }
  const link = (rel, href, hreflang) => {
    const node = doc.createElement("link");
    node.setAttribute("rel", rel);
    // Every href composed here is root-relative and already encoded
    // (routeHref).
    node.setAttribute("href", `${origin}${href}`);
    if (hreflang !== undefined) node.setAttribute("hreflang", hreflang);
    doc.head.append(node);
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
}
