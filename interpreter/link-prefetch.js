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

/** @param {{ addresses: any, appBase: any, store: any, servedReadsOf: any, takeProgressiveReads?: any }} opts */
export function startLinkPrefetch({ addresses, appBase, store, servedReadsOf, takeProgressiveReads }) {
  const asked = new Map();

  const saving = () => {
    const c = globalThis.navigator?.connection;
    return c?.saveData === true || /(^|-)2g$/.test(c?.effectiveType ?? "");
  };

  async function prefetch(url, speculative = true, idle = false) {
    const found = addresses(url);
    prefetchScreen(appBase, found.route);
    // A route the terminal draws on its own is served a shell that carries
    // nothing; only a rendered one is worth its document.
    if (found.route.ssr !== "ssr" && found.route.ssr !== "ssg") return false;
    const init = speculative
      ? {
          headers: {
            Accept: "text/html",
            Purpose: "prefetch",
            "X-Pronto-Prefetch": "1",
            ...(idle ? { "X-Pronto-Speculative": "1" } : {}),
          },
          ...(idle ? { priority: "low" } : {}),
        }
      : {
          headers: { Accept: "text/html", "X-Pronto-Prefetch": "1" },
        };
    // A document that did not come leaves the click to ask, as it always
    // did; one that came with reads no store can take is a program's fault,
    // and says so.
    const res = await fetch(url.href, init).catch(() => null);
    if (res === null || res.status !== 200) return false;
    const fresh = res.headers.get("x-edge-cache") !== "stale" && (!speculative || res.headers.has("x-edge-cache"));
    const seedOpts = fresh ? { at: url.href } : undefined;
    if (takeProgressiveReads && res.body?.getReader) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parts = [];
      let tail = "";
      for (;;) {
        let step;
        try {
          step = await reader.read();
        } catch {
          return false;
        }
        const { done, value } = step;
        const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (chunk) {
          parts.push(chunk);
          const { reads, rest } = takeProgressiveReads(tail + chunk);
          tail = rest;
          if (reads.size > 0) store.seedReads(reads, seedOpts);
        }
        if (done) break;
      }
      store.seedReads(servedReadsOf(parts.join("")), seedOpts);
      return true;
    }
    const text = await res.text().catch(() => null);
    if (text === null) return false;
    store.seedReads(servedReadsOf(text), seedOpts);
    return true;
  }

  function want(href, idle = false) {
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
    const p = prefetch(url, true, idle);
    p.catch(() => {});
    asked.set(key, p);
    return p;
  }

  const intent = (e) => {
    const a = e.target?.closest?.("a[href]");
    if (a && !a.target && !a.hasAttribute("download") && !a.getAttribute("href").startsWith("#")) want(a.href, false);
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
          Promise.resolve(want(links[i], true)).finally(() => {
            requestIdleCallback(() => step(i + 1));
          });
        };
        step(0);
      });
    },
    /** Joins an in-flight prefetch on navigation or asks the SSR document
     * once when speculation did not run or answered 204. */
    async seed(href) {
      const url = new URL(href, location.href);
      const found = addresses(url);
      if (found === null || found.route.ssr !== "ssr") return;
      const key = url.pathname + url.search;
      const prior = asked.get(key);
      if (prior !== undefined && await prior) return;
      if (saving()) return;
      const run = prefetch(url, false);
      asked.set(key, run);
      await run;
    },
  };
}
