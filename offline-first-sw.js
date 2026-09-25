// Precached immutable shell assets required for cold offline boot.
const STATIC_CACHE = "pronto-static-v2";
const RUNTIME_CACHE = "pronto-runtime-v2";

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

  // Cache-first for immutable static shell and interpreter code.
  if (url.pathname.startsWith("/shell/") || url.pathname.startsWith("/omnishell/")) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(req, clone));
          }
          return res;
        });
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
