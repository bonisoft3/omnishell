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

  // Stale-While-Revalidate for shell, screen templates, styles, and interpreter assets.
  // Serves from cache immediately for 0ms offline boot, while revalidating against
  // the server in the background. If a template or stylesheet has updated, the SW
  // caches the new response and posts a message to active client windows to morph
  // the DOM or hot-reload styles in-place without page reload.
  if (url.pathname.startsWith("/shell/") || url.pathname.startsWith("/omnishell/")) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(req);

        const revalidatePromise = fetch(req)
          .then(async (res) => {
            if (!res.ok) return res;
            const newText = await res.clone().text();

            let changed = false;
            if (!cached) {
              changed = true;
            } else {
              const oldText = await cached.clone().text();
              if (oldText !== newText) {
                changed = true;
              }
            }

            if (changed) {
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
                }
              }
            }
            return res;
          })
          .catch(() => {
            // Network failure / offline: cached response already served
          });

        if (cached) {
          return cached;
        }
        return revalidatePromise;
      }),
    );
    return;
  }

  // SWR for navigation: serve cached entry document immediately if known,
  // revalidating in background. Unvisited routes offline fail loudly.
  if (req.mode === "navigate") {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const fetchPromise = fetch(req).then((res) => {
          const cc = res.headers.get("Cache-Control") || "";
          if (res.ok && !cc.includes("no-store") && !cc.includes("private")) {
            cache.put(req, res.clone());
          }
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
