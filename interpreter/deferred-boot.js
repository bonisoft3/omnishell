import { scriptURL } from "./script-url.js";

export function startDeferredBoot(document, Observer = PerformanceObserver) {
  const loader = document.querySelector("script[data-pronto-boot]");
  if (!loader) throw new Error("the document has no deferred boot");
  const ahead = JSON.parse(loader.dataset.prontoPreloads);
  const src = loader.dataset.prontoBoot;
  new Observer((list, observer) => {
    if (!list.getEntriesByName("first-contentful-paint").length) return;
    observer.disconnect();
    for (const attrs of ahead) {
      const link = document.createElement("link");
      for (const [name, value] of Object.entries(attrs)) link.setAttribute(name, value);
      document.head.append(link);
    }
    const boot = document.createElement("script");
    boot.type = "module";
    boot.src = scriptURL(src, document.baseURI);
    loader.replaceWith(boot);
  }).observe({ type: "paint", buffered: true });
}

if (typeof document !== "undefined" && document.querySelector("script[data-pronto-boot]")) startDeferredBoot(document);
