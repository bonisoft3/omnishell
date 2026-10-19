const assetMaps = new WeakMap();

/** The release a document runs: its map from logical path to content address,
 * or null for one served without one (a single-file bundle, the storybook). */
export function releaseOf(doc = globalThis.document) {
  if (!assetMaps.has(doc)) {
    const map = doc.getElementById("pronto-assets");
    assetMaps.set(doc, map ? JSON.parse(map.textContent).imports : null);
  }
  return assetMaps.get(doc);
}

/** The map a page takes in place (shell.js): what it fetches from here on is
 * the new release's. Its import map stays the one it loaded, which names the
 * modules it is already running. */
export function setRelease(doc, imports) {
  assetMaps.set(doc, imports);
}

// The release document pins both native imports and fetched screen files to
// the same bytes. Canonical names still identify roles and endowments.
export function assetURL(value, doc = globalThis.document) {
  let url;
  try {
    url = new URL(value);
  } catch {
    const base = doc?.baseURI ? new URL(doc.baseURI, "https://release.invalid/") : (globalThis.location?.href ?? "https://release.invalid/");
    url = new URL(value, base);
  }
  if (!doc) return url;
  const mapped = releaseOf(doc)?.[url.pathname];
  if (mapped !== undefined) {
    let sameOrigin = true;
    if (doc.baseURI) {
      try {
        sameOrigin = url.origin === new URL(doc.baseURI).origin;
      } catch {
        sameOrigin = true;
      }
    }
    if (sameOrigin) url.pathname = mapped;
  }
  return url;
}

/** `rel` is "preload" for the screen being shown and "prefetch" for one a link
 * leads to: a preload is the browser's to fetch at once, at the page's
 * priority, and warned about when unused, which a screen the reader may never
 * visit is; a prefetch is for a navigation that may come. */
export function preloadScreen(doc, appBase, route, { template = true, rel = "preload" } = {}) {
  const app = new URL(appBase);
  const base = new URL(doc.head.querySelector("base[href]")?.getAttribute("href") ?? ".", app);
  const styles = new Set([...doc.head.querySelectorAll('link[rel="stylesheet"]')]
    .map((link) => assetURL(new URL(link.getAttribute("href"), base), doc).href));
  const seen = new Set();
  for (const link of doc.head.querySelectorAll('link[rel="modulepreload"], link[rel="preload"], link[rel="prefetch"]')) {
    const url = assetURL(new URL(link.getAttribute("href"), base), doc).href;
    if (seen.has(url)) link.remove();
    else seen.add(url);
  }
  const ahead = [
    ...(template ? [[route.files.html, "fetch"], [route.files.css, "fetch"]] : []),
    ...["handlers", "renderers", "adapters"].flatMap((kind) => (route.files[kind] ?? []).map((path) => [path, "fetch"])),
    ...(route.files.shared ?? []).map((path) => [path, "style"]),
  ];
  for (const [path, as] of ahead) {
    const url = assetURL(new URL(path, app), doc);
    if (seen.has(url.href) || (as === "style" && styles.has(url.href))) continue;
    seen.add(url.href);
    const link = doc.createElement("link");
    link.setAttribute("rel", rel);
    // The renderer's appBase can name its internal door; the reader's own
    // origin serves the same paths, including a prerender's placeholder origin.
    link.setAttribute("href", url.origin === app.origin ? `${url.pathname}${url.search}${url.hash}` : url.href);
    link.setAttribute("as", as);
    if (as === "fetch") link.setAttribute("crossorigin", "anonymous");
    doc.head.append(link);
  }
}

/** Screen names targeted by `data-route="..."` anywhere in a skeleton template,
 * including inside `<template data-item>` blocks. */
export function skeletonRoutes(html) {
  const routes = new Set();
  const stripped = String(html ?? "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi, "");
  for (const [, dq, sq] of stripped.matchAll(/\bdata-route\s*=\s*(?:"([^"{}\s]+)"|'([^'{}\s]+)')/g)) {
    const name = dq ?? sq;
    if (name) routes.add(name);
  }
  return [...routes];
}

/** Preloads every screen reachable from `screen` via its skeleton `data-route`
 * links, top navigation strip, or generate-time `#pronto-assets` screen graph. */
export function preloadLinkedScreens(doc, appBase, cfg, screen, names = []) {
  if (!doc) return;
  const map = doc.getElementById?.("pronto-assets");
  const generated = map?.textContent ? (JSON.parse(map.textContent).screens?.[screen] ?? []) : [];
  const routes = new Map((cfg?.routes ?? []).map((r) => [r.screen, r]));
  for (const name of new Set([...generated, ...names])) {
    if (!name || name === screen) continue;
    const target = routes.get(name);
    if (target) preloadScreen(doc, appBase, target, { rel: "prefetch" });
  }
}

