export function preloadScreen(doc, appBase, route, { template = true } = {}) {
  const app = new URL(appBase);
  const base = new URL(doc.head.querySelector("base[href]")?.getAttribute("href") ?? ".", app);
  const styles = new Set([...doc.head.querySelectorAll('link[rel="stylesheet"]')]
    .map((link) => new URL(link.getAttribute("href"), base).href));
  const seen = new Set();
  for (const link of doc.head.querySelectorAll('link[rel="modulepreload"], link[rel="preload"]')) {
    const url = new URL(link.getAttribute("href"), base).href;
    if (seen.has(url)) link.remove();
    else seen.add(url);
  }
  const ahead = [
    ...(template ? [[route.files.html, "fetch"], [route.files.css, "fetch"]] : []),
    ...["handlers", "renderers", "adapters"].flatMap((kind) => (route.files[kind] ?? []).map((path) => [path, "fetch"])),
    ...(route.files.shared ?? []).map((path) => [path, "style"]),
  ];
  for (const [path, as] of ahead) {
    const url = new URL(path, app);
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
