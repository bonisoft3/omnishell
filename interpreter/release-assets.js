const CACHE = "pronto-verified-releases-v1";
const PINS = "pronto-release-clients-v1";
const RETAIN_MS = 60 * 60 * 1000;
const NETWORK_IDLE_MS = 15000;
let active = null;
const prunedAt = new Map();

async function prune(cache, base, force = false) {
  const now = Date.now();
  if (!force && now - (prunedAt.get(base.href) ?? 0) < RETAIN_MS) return;
  const pointer = await cache.match(assetUrl(base, "shell/release.json"));
  if (!pointer) return;
  const current = (await pointer.json()).id;
  const pinned = new Set([current]);
  const pins = await caches.open(PINS);
  for (const request of await pins.keys()) {
    const path = new URL(request.url).pathname;
    if (!/^\/\.pronto\/release-(?:clients|targets)\//.test(path)) continue;
    const response = await pins.match(request);
    if (!response) continue;
    const pin = await response.json();
    if (path.startsWith("/.pronto/release-clients/") || now - pin.preparedAt < RETAIN_MS) pinned.add(pin.id);
  }
  const manifestUrl = new URL(assetUrl(base, "shell/release.json"));
  for (const request of await cache.keys()) {
    const url = new URL(request.url);
    if (url.origin !== manifestUrl.origin || url.pathname !== manifestUrl.pathname) continue;
    const release = url.searchParams.get("pronto-release");
    if (!release || pinned.has(release)) continue;
    const response = await cache.match(request);
    const savedAt = Number(response?.headers.get("X-Pronto-Cached-At"));
    if (!savedAt || now - savedAt < RETAIN_MS) continue;
    const manifest = await response.json();
    await validateIdentity(manifest);
    if (manifest.id !== release) throw new Error("cached release identity mismatch");
    for (const path of Object.keys(manifest.assets)) {
      await cache.delete(new Request(`${assetUrl(base, path)}?pronto-release=${release}`));
    }
    await cache.delete(request);
  }
  prunedAt.set(base.href, now);
}

async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", typeof value === "string" ? new TextEncoder().encode(value) : value);
  return [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, "0")).join("");
}

async function verifiedBody(response, path, hash, bytes = null) {
  bytes ??= new Uint8Array(await response.arrayBuffer());
  if (await digest(bytes) !== hash) throw new Error(`release asset mismatch: ${path}`);
  return /\.(?:html|css|[cm]?js|json|ya?ml|txt|csv|svg)$/.test(path)
    ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) : bytes;
}

function assetUrl(base, path) {
  return new URL(path.startsWith("omnishell/") ? `/${path}` : path, base).href;
}

function validate(manifest) {
  if (manifest?.format !== 1 || !/^[0-9a-f]{64}$/.test(manifest.id) ||
      !/^[0-9a-f]{64}$/.test(manifest.contract) ||
      typeof manifest.runtime !== "string" || !manifest.runtime ||
      !manifest.assets || typeof manifest.assets !== "object" ||
      !manifest.screens || typeof manifest.screens !== "object") {
    throw new Error("invalid app release manifest");
  }
  for (const [path, hash] of Object.entries(manifest.assets)) {
    if (!/^(?:shell|messages|omnishell)\/[a-zA-Z0-9_./-]+$/.test(path) && path !== "offline-first-sw.js") {
      throw new Error(`invalid release asset ${path}`);
    }
    if (path.includes("..") || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`invalid release asset ${path}`);
  }
}

async function validateIdentity(manifest) {
  validate(manifest);
  const ordered = Object.entries(manifest.assets).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const screens = ordered
    .filter(([path]) => /^shell\/screens\/[^/]+\.html$/.test(path))
    .map(([path, html]) => [path, { html, css: manifest.assets[path.slice(0, -5) + ".css"] }]);
  if (screens.some(([, screen]) => !screen.css) ||
      JSON.stringify(Object.fromEntries(screens)) !== JSON.stringify(manifest.screens)) {
    throw new Error("release screen map does not match assets");
  }
  const code = ordered
    .filter(([path]) => !/^shell\/screens\/[^/]+\.(?:html|css)$/.test(path));
  if (await digest(JSON.stringify([manifest.runtime, code])) !== manifest.contract ||
      await digest(JSON.stringify([manifest.contract, screens])) !== manifest.id) {
    throw new Error("release identity does not match assets");
  }
}

async function fromCache(base, releaseId) {
  if (typeof caches === "undefined") return null;
  const cache = await caches.open(CACHE);
  const pointer = await cache.match(assetUrl(base, "shell/release.json") + (releaseId ? `?pronto-release=${releaseId}` : ""));
  if (!pointer) return null;
  const manifest = await pointer.json();
  await validateIdentity(manifest);
  if (releaseId && releaseId !== manifest.id) throw new Error("cached release identity mismatch");
  const assets = new Map();
  for (const path of Object.keys(manifest.assets)) {
    const response = await cache.match(`${assetUrl(base, path)}?pronto-release=${manifest.id}`);
    if (!response) throw new Error(`incomplete cached release ${manifest.id}: ${path}`);
    const value = await verifiedBody(response, path, manifest.assets[path]);
    assets.set(assetUrl(base, path), value);
  }
  return { manifest, assets };
}

async function previousRelease(base, previous, error) {
  const saved = previous ?? await fromCache(base);
  if (saved) return saved;
  throw error;
}

async function download(url, signal) {
  const controller = new AbortController();
  let timer;
  let reader;
  const progress = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`release download made no progress: ${url}`)), NETWORK_IDLE_MS);
  };
  progress();
  try {
    const response = await fetch(url, {
      cache: "no-store", signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    progress();
    const chunks = [];
    let length = 0;
    if (response.body) {
      reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.length === 0) continue;
        progress();
        chunks.push(value);
        length += value.length;
      }
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return { response, bytes };
  } catch (error) {
    controller.abort(error);
    if (reader) await Promise.allSettled([reader.cancel(error)]);
    throw error;
  } finally {
    clearTimeout(timer);
    reader?.releaseLock();
  }
}

export async function fetchRelease(base, previous = null, { preferCached = false, releaseId = "" } = {}) {
  if (releaseId) {
    const saved = await fromCache(base, releaseId);
    if (!saved) throw new Error(`selected release is not cached: ${releaseId}`);
    return saved;
  }
  if (preferCached) {
    const saved = await fromCache(base);
    if (saved) return saved;
  }
  let response, bytes;
  try {
    ({ response, bytes } = await download(assetUrl(base, "shell/release.json")));
  } catch (error) {
    return previousRelease(base, previous, error);
  }
  if (response.status === 404) return null;
  if (response.status >= 500) {
    return previousRelease(base, previous, new Error(`${response.status} fetching app release`));
  }
  if (!response.ok) throw new Error(`${response.status} fetching app release`);
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes));
    await validateIdentity(manifest);
  } catch (error) {
    return previousRelease(base, previous, error);
  }
  if (previous?.manifest.id === manifest.id) {
    if (typeof caches !== "undefined") await prune(await caches.open(CACHE), base);
    return previous;
  }
  const assets = new Map();
  const controller = new AbortController();
  const downloading = [];
  try {
    for (const path of Object.keys(manifest.assets)) downloading.push((async () => {
      const url = assetUrl(base, path);
      const { response: file, bytes } = await download(url, controller.signal);
      if (!file.ok) throw new Error(`${file.status} fetching release asset ${path}`);
      const value = await verifiedBody(file, path, manifest.assets[path], bytes);
      assets.set(url, value);
    })());
    await Promise.all(downloading);
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled(downloading);
    return previousRelease(base, previous, error);
  }
  if (typeof caches !== "undefined") {
    const cache = await caches.open(CACHE);
    const savedAt = String(Date.now());
    for (const [url, value] of assets) {
      await cache.put(`${url}?pronto-release=${manifest.id}`, new Response(value, {
        headers: { "X-Pronto-Cached-At": savedAt, "Content-Type": contentType(url) },
      }));
    }
    await cache.put(`${assetUrl(base, "shell/release.json")}?pronto-release=${manifest.id}`, new Response(JSON.stringify(manifest), {
      headers: { "X-Pronto-Cached-At": savedAt, "Content-Type": "application/json" },
    }));
    await cache.put(assetUrl(base, "shell/release.json"), new Response(JSON.stringify(manifest)));
    await prune(cache, base, true);
  }
  return { manifest, assets };
}

export function activateRelease(release) {
  active = release;
}

function contentType(url) {
  const extension = new URL(url).pathname.split(".").pop();
  return ({
    js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript", css: "text/css", html: "text/html",
    json: "application/json", yaml: "application/yaml", yml: "application/yaml", txt: "text/plain", csv: "text/csv",
    wasm: "application/wasm", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    ico: "image/x-icon", webmanifest: "application/manifest+json",
    gif: "image/gif", webp: "image/webp", avif: "image/avif", woff: "font/woff", woff2: "font/woff2",
  })[extension] ?? "application/octet-stream";
}

export function releaseReader() {
  const selected = active;
  return async (url) => {
    const key = String(url);
    if (selected?.assets.has(key)) {
      const value = selected.assets.get(key);
      if (typeof value !== "string") throw new Error(`release text reader cannot read binary asset: ${url}`);
      return value;
    }
    if (selected && /\/(?:shell|messages|omnishell)\//.test(new URL(key).pathname)) {
      throw new Error(`asset absent from selected release: ${url}`);
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
    return response.text();
  };
}

export async function readAsset(url) {
  return releaseReader()(url);
}

function workerRequest(worker, message) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      const error = new Error("service worker did not answer release request");
      error.code = "release-protocol-timeout";
      reject(error);
    }, 5000);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      channel.port1.close();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    worker.postMessage(message, [channel.port2]);
  });
}

async function requestWorker(message) {
  const registration = await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
  }
  try {
    return await workerRequest(navigator.serviceWorker.controller, message);
  } catch (error) {
    if (error.code !== "release-protocol-timeout") throw error;
    await registration.update();
    const installing = registration.installing ?? registration.waiting;
    if (installing && installing.state !== "activated") {
      await new Promise((resolve, reject) => installing.addEventListener("statechange", () => {
        if (installing.state === "activated") resolve();
        if (installing.state === "redundant") reject(new Error("release service worker installation failed"));
      }));
    }
    if (installing && navigator.serviceWorker.controller !== installing) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
    }
    return workerRequest(navigator.serviceWorker.controller, message);
  }
}

export async function startupReleaseId() {
  const explicit = new URL(location.href).searchParams.get("pronto-release");
  if (explicit) return explicit;
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return null;
  return (await requestWorker({ type: "PRONTO_RELEASE_CLIENT" })).id;
}

export async function prepareRestartRelease(base, release) {
  const saved = await fromCache(base, release.manifest.id);
  if (!saved || !saved.assets.has(assetUrl(base, "shell/index.html")) ||
      !saved.assets.has(assetUrl(base, "omnishell/interpreter/shell.js"))) {
    throw new Error("restart requires a complete cached entry and runtime");
  }
  await requestWorker({ type: "PRONTO_RELEASE_READY", base: base.href, id: saved.manifest.id });
  const url = new URL(location.href);
  url.searchParams.set("pronto-release", saved.manifest.id);
  return () => location.replace(url.href);
}

export async function restartRelease(base, release) {
  (await prepareRestartRelease(base, release))();
}
