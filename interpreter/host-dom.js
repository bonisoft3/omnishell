import { scriptURL } from "./script-url.js";

// These modules deliberately share the host's authority. Only the manifest
// selects them; markup cannot introduce executable paths.
export async function hostDomScreen(route, appBase, declarations, { fixtures = false, mountHostDom = !fixtures } = {}) {
  const names = route.hatches ?? [];
  if (new Set(names).size !== names.length) throw new Error("screen repeats a host-DOM hatch");
  const entries = names.map((name) => {
    if (!Object.hasOwn(declarations, name)) throw new Error(`undeclared host-DOM hatch: ${name}`);
    const hatch = declarations[name];
    if (!hatch.note || !/^shell\/hatches\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.m?js$/.test(hatch.src)) {
      throw new Error(`invalid host-DOM hatch: ${name}`);
    }
    return new URL(String(scriptURL(new URL(hatch.src, appBase))));
  });
  const modules = mountHostDom ? await Promise.all(entries.map((url) => import(url.href))) : [];
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
