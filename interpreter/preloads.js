const assetMaps = new WeakMap();

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
  let imports = assetMaps.get(doc);
  if (imports === undefined) {
    const map = doc.getElementById("pronto-assets");
    imports = map ? JSON.parse(map.textContent).imports : {};
    assetMaps.set(doc, imports);
  }
  const mapped = imports[url.pathname];
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

export function preloadScreen(doc, appBase, route, { template = true } = {}) {
  const app = new URL(appBase);
  const base = new URL(doc.head.querySelector("base[href]")?.getAttribute("href") ?? ".", app);
  const styles = new Set([...doc.head.querySelectorAll('link[rel="stylesheet"]')]
    .map((link) => assetURL(new URL(link.getAttribute("href"), base), doc).href));
  const seen = new Set();
  for (const link of doc.head.querySelectorAll('link[rel="modulepreload"], link[rel="preload"]')) {
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
    link.setAttribute("rel", "preload");
    // The renderer's appBase can name its internal door; the reader's own
    // origin serves the same paths, including a prerender's placeholder origin.
    link.setAttribute("href", url.origin === app.origin ? `${url.pathname}${url.search}${url.hash}` : url.href);
    link.setAttribute("as", as);
    if (as === "fetch") link.setAttribute("crossorigin", "anonymous");
    doc.head.append(link);
  }
}
