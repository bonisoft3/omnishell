// What the store's smokes share: a window with exactly what the vendored
// client touches, and the two ways a smoke says what it waited for.

export const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

export async function until(cond, what) {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`smoke failed: never ${what}`);
}

/**
 * Runs `fn(createStore)` in a window holding the client's storage probe,
 * resolveUrl's origin, the online detector's listener seam and the outbox
 * leader's heartbeat. `fetch` answers the page's requests; `storage` is what
 * localStorage holds before the store loads, by key, each value as JSON.
 */
export async function withBrowser({ fetch, storage = {} }, fn) {
  const saved = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document };
  const backing = new Map(Object.entries(storage).map(([k, v]) => [k, JSON.stringify(v)]));
  const local = {
    getItem: (k) => backing.get(k) ?? null,
    setItem: (k, v) => void backing.set(k, v),
    removeItem: (k) => void backing.delete(k),
    key: (i) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true });
  globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
  globalThis.window = {
    localStorage: local,
    location: { origin: "http://localhost" },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };
  if (fetch !== undefined) globalThis.fetch = fetch;
  try {
    const { createStore } = await import("./data-sync.js");
    await fn(createStore);
  } finally {
    globalThis.fetch = saved.fetch;
    delete globalThis.localStorage;
    if (saved.window === undefined) delete globalThis.window;
    else globalThis.window = saved.window;
    if (saved.document === undefined) delete globalThis.document;
    else globalThis.document = saved.document;
  }
}
