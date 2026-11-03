// The first click on a link drew its screen empty until the screen's reads
// came back, where a second click drew it whole from the tab. So a link's screen
// reads ahead: its markup and stylesheet (prefetchScreen), and the reads that
// markup declares with nothing but the link's own params, each kept for the page
// at that address. Never its document: a render holds the database's one
// connection for seconds, and a pointer crossing a page of links would queue
// one each ahead of the click it was on its way to.
//
// It keeps to what the browser's own speculation keeps to: nothing on a
// connection that asked to save data or on a 2G one, nothing in a hidden tab.
// Ahead of intent, when the browser says it is idle, only the navigation strip's
// links: the app's own places, which the program bounds. Each address once per
// document.
import { addressedReads, prefetchScreen } from "./screen.js";

/** @param {{ addresses: any, appBase: any, store: any }} opts */
export function startLinkPrefetch({ addresses, appBase, store }) {
  const asked = new Map();

  const saving = () => {
    const c = globalThis.navigator?.connection;
    return c?.saveData === true || /(^|-)2g$/.test(c?.effectiveType ?? "");
  };

  async function prefetch(url) {
    const found = addresses(url);
    const markup = await prefetchScreen(appBase, found.route);
    // A read that did not come leaves the screen to ask, and to say so if it fails too.
    await Promise.allSettled(addressedReads(markup, found.params).map((read) =>
      store.readAhead(read.table, read.order, read.opts, url.href)));
  }

  function want(href) {
    if (saving() || document.visibilityState !== "visible") return;
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search) return;
    const key = url.pathname + url.search;
    // The screen on show in another language is no screen the reader is
    // heading to; the strip names one for each. The same screen over another
    // row is.
    const target = addresses(url);
    const here = addresses(location);
    const same = here !== null && target !== null && target.route.screen === here.route.screen &&
      JSON.stringify(target.params) === JSON.stringify(here.params);
    if (asked.has(key) || target === null || same) return;
    const p = prefetch(url);
    p.catch(() => {});
    asked.set(key, p);
    return p;
  }

  const intent = (e) => {
    const a = e.target?.closest?.("a[href]");
    if (a && !a.target && !a.hasAttribute("download") && !a.getAttribute("href").startsWith("#")) want(a.href);
  };
  addEventListener("pointerover", intent, { passive: true });
  addEventListener("pointerdown", intent, { passive: true });
  addEventListener("focusin", intent);

  return {
    /** The strip's links, once the browser is idle: a browser that cannot
     * say when it is gets them on intent alone. */
    idle() {
      if (globalThis.requestIdleCallback === undefined) return;
      requestIdleCallback(() => {
        const links = [...document.querySelectorAll("body > nav a[href]")].map((a) => a.href);
        const step = (i) => {
          if (i >= links.length) return;
          Promise.resolve(want(links[i])).catch(() => {}).finally(() => {
            requestIdleCallback(() => step(i + 1));
          });
        };
        step(0);
      });
    },
    /** Joins an in-flight prefetch on navigation, or reads ahead once when none ran. */
    async seed(href) {
      const url = new URL(href, location.href);
      if (addresses(url) === null) return;
      const key = url.pathname + url.search;
      const prior = asked.get(key);
      if (prior !== undefined) return prior.catch(() => {});
      if (saving()) return;
      const run = prefetch(url);
      asked.set(key, run);
      await run.catch(() => {});
    },
  };
}
