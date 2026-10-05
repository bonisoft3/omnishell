// Precached immutable shell assets required for cold offline boot.
const STATIC_CACHE = "pronto-static-v3";
const RUNTIME_CACHE = "pronto-runtime-v3";

const PRECACHE_ASSETS = [
  "/shell/index.html",
  "/shell/shell.css",
  "/shell/design.css",
  "/shell/boot.js",
];

// Protocol boundaries: sync streams, mutations, and auth sessions must never
// be cached by an HTTP service worker.
const BYPASS_PREFIXES = ["/electric/", "/crud/", "/auth/", "/events/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k)),
      )
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS_PREFIXES.some((p) => url.pathname.startsWith(p))) return;

  // Stale-While-Revalidate for shell, screen templates, styles, catalogues and
  // interpreter assets: everything a boot reads before its first screen, so a
  // kept document is taken over offline too. Serves from cache immediately for
  // 0ms offline boot, while revalidating against the server in the background.
  // If a template, stylesheet or catalogue has updated, the SW caches the new
  // response and posts a message to active client windows to morph the DOM,
  // hot-reload styles or write the words again in place without page reload.
  if (["/shell/", "/omnishell/", "/messages/"].some((p) => url.pathname.startsWith(p))) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        // The page reads the copy it is answered with before the network
        // answers, so the comparison reads a clone taken now.
        const kept = cached?.clone();

        const revalidatePromise = fetch(req)
          .then(async (res) => {
            if (!res.ok) return res;
            if (!cached) {
              // A first fetch is not an update: the requester is handed this very
              // response, and a morph to it would strip the state a screen mounted.
              await cache.put(req, res.clone());
              return res;
            }
            const newText = await res.clone().text();
            if (newText !== await kept.text()) {
              await cache.put(req, res.clone());
              const clients = await self.clients.matchAll({ type: "window" });
              for (const client of clients) {
                if (url.pathname.endsWith(".html")) {
                  client.postMessage({
                    type: "PRONTO_SKELETON_UPDATED",
                    url: req.url,
                    pathname: url.pathname,
                    html: newText,
                  });
                } else if (url.pathname.endsWith(".css")) {
                  client.postMessage({
                    type: "PRONTO_STYLE_UPDATED",
                    url: req.url,
                    pathname: url.pathname,
                    css: newText,
                  });
                } else if (url.pathname.startsWith("/messages/")) {
                  client.postMessage({
                    type: "PRONTO_MESSAGES_UPDATED",
                    url: req.url,
                    pathname: url.pathname,
                    json: newText,
                  });
                }
              }
            }
            return res;
          })
          .catch(() => {
            // Network failure / offline: cached response already served
          });

        // A request that revalidates (cache: "no-cache") is the shell asking
        // which copy is current, where a document and this copy disagree:
        // the server answers it, and this copy only when there is no server
        // to answer, or it fails, as a door does mid-deploy.
        if (req.cache === "no-cache") {
          return revalidatePromise.then((res) => (res === undefined || res.status >= 500 ? cached ?? res : res));
        }
        if (cached) {
          return cached;
        }
        return revalidatePromise;
      }),
    );
    return;
  }

  // SWR for navigation: the copy kept for an address paints at once, online or
  // not, and the network refreshes it for the next visit. A document rendered
  // with rows is as old as that copy; the shell takes it over and its regions'
  // first reads bring the rows current in place. An address that stops
  // existing, or stops being anyone's to keep, takes its copy with it.
  // Unvisited routes offline fail loudly.
  if (req.mode === "navigate") {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const fetchPromise = fetch(req).then((res) => {
          const cc = res.headers.get("Cache-Control") || "";
          const keepable = !cc.includes("no-store") && !cc.includes("private");
          if (res.ok && keepable) cache.put(req, res.clone());
          else if (res.status === 404 || res.status === 410 || (res.ok && !keepable)) cache.delete(req);
          return res;
        });
        if (cached) {
          fetchPromise.catch(() => {});
          return cached;
        }
        return fetchPromise;
      }),
    );
  }
});
