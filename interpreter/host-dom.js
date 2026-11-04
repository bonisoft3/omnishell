import { scriptURL } from "./script-url.js";

// These modules deliberately share the host's authority. Only the manifest
// selects them; markup cannot introduce executable paths.
// A single-file page compiles its hatches into its own module and hands them
// over as `hostDomModules`, by src: a dynamic import of a path would go to a
// network the page does not have. Given the map, every hatch must be in it.
/**
 * @param {{hatches?: string[]}} route
 * @param {string} appBase
 * @param {Record<string, unknown>} declarations
 * @param {{fixtures?: boolean, mountHostDom?: boolean, hostDomModules?: Record<string, {default: Function}>}} [options]
 */
export async function hostDomScreen(route, appBase, declarations, { fixtures = false, mountHostDom = !fixtures, hostDomModules } = {}) {
  const names = route.hatches ?? [];
  if (new Set(names).size !== names.length) throw new Error("screen repeats a host-DOM hatch");
  const entries = names.map((name) => {
    if (!Object.hasOwn(declarations, name)) throw new Error(`undeclared host-DOM hatch: ${name}`);
    const hatch = declarations[name];
    if (!hatch.note || !/^shell\/hatches\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.m?js$/.test(hatch.src)) {
      throw new Error(`invalid host-DOM hatch: ${name}`);
    }
    return { src: hatch.src, url: new URL(String(scriptURL(new URL(hatch.src, appBase)))) };
  });
  const load = ({ src, url }) => {
    if (!hostDomModules) return import(url.href);
    if (!Object.hasOwn(hostDomModules, src)) throw new Error(`host-DOM hatch ${src} is not compiled into this page`);
    return hostDomModules[src];
  };
  const modules = mountHostDom ? await Promise.all(entries.map(load)) : [];
  for (const module of modules) {
    if (typeof module.default !== "function") throw new TypeError("host-DOM hatch must export a mount function");
  }
  let mounted = [];
  const stop = () => {
    const errors = [];
    for (const { controller, cleanup } of mounted.splice(0).reverse()) {
      controller.abort();
      try { cleanup?.(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "host-DOM cleanup failed");
  };
  return {
    stop,
    start(screen, environment) {
      if (mounted.length) return;
      try {
        for (const module of modules) {
          const entry = { controller: new AbortController(), cleanup: undefined };
          mounted.push(entry);
          const cleanup = module.default(screen, { ...environment, signal: entry.controller.signal });
          if (typeof cleanup !== "function") throw new TypeError("host-DOM mount must return a cleanup function");
          entry.cleanup = cleanup;
        }
      } catch (error) {
        try { stop(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "host-DOM mount failed"); }
        throw error;
      }
    },
  };
}
