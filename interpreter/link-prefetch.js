// The first click on a link drew its screen empty until the screen's reads
// came back, where a second click drew it whole from the tab. A link's
// document, rendered for a fresh guest, carries the very /crud reads its first
// paint makes (data-sync.js, carryReads), so fetching it ahead and seeding the
// store with them makes the first click the second. Its markup and stylesheet
// come along (prefetchScreen).
//
// A data read carries the guest's token, which no <link rel=prefetch> or
// speculation rule can send, so this asks itself; it keeps to what the
// browser's own speculation keeps to. Nothing on a connection that asked to
// save data or on a 2G one, nothing in a hidden tab. Ahead of intent, when the
// browser says it is idle, only the navigation strip's links: the app's own
// places, which the program bounds. A page's links to rows are as many as its
// rows, and each document a prefetch asks for is a render the cluster makes,
// so any other link waits for a pointer to rest on it or for focus. Each
// address once per document, at low priority, so the browser schedules them
// behind what the page itself needs, and marked as the browser marks its own
// (Purpose: prefetch), which a stale cached document is served whole for.
// servedReadsOf comes from the data plane the shell loads apart, so that this
// module costs the first paint nothing of it.
import { prefetchScreen } from "./screen.js";

export function startLinkPrefetch({ addresses, appBase, store, servedReadsOf }) {
  const asked = new Set();

  const saving = () => {
    const c = globalThis.navigator?.connection;
    return c?.saveData === true || /(^|-)2g$/.test(c?.effectiveType ?? "");
  };

  async function prefetch(url) {
    const found = addresses(url);
    prefetchScreen(appBase, found.route);
    // A route the terminal draws on its own is served a shell that carries
    // nothing; only a rendered one is worth its document.
    if (found.route.ssr !== "ssr" && found.route.ssr !== "ssg") return;
    // A document that did not come leaves the click to ask, as it always
    // did; one that came with reads no store can take is a program's fault,
    // and says so.
    const res = await fetch(url.href, { headers: { Accept: "text/html", Purpose: "prefetch" }, priority: "low" }).catch(() => null);
    if (res === null || !res.ok) return;
    store.seedReads(servedReadsOf(await res.text()));
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
    asked.add(key);
    prefetch(url);
  }

  const intent = (e) => {
    const a = e.target?.closest?.("a[href]");
    if (a && !a.target && !a.hasAttribute("download") && !a.getAttribute("href").startsWith("#")) want(a.href);
  };
  addEventListener("pointerover", intent, { passive: true });
  addEventListener("focusin", intent);

  return {
    /** The strip's links, once the browser is idle: a browser that cannot
     * say when it is gets them on intent alone. */
    idle() {
      if (globalThis.requestIdleCallback === undefined) return;
      requestIdleCallback(() => {
        for (const a of document.querySelectorAll("body > nav a[href]")) want(a.href);
      });
    },
  };
}
