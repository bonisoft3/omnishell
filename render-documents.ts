// omnishell document renderer: one document per prerendered route per locale,
// rendered before any request, from the app's served tree on disk.
//
//   omnishell render documents <appDir> <outDir> <origin>
//
// The terminal publishes the mechanism and a compiler decides where it
// applies, so a compiler spawns this rather than importing it, as it spawns
// read-markup.ts (whose header states why); terminal.cue publishes its path.
//
// A route declaring `prerender` is written at <outDir><address>/index.html for
// every locale the app declares, the address being routeHref's — the layout a
// door resolving `{path}/index.html` serves. Nothing else is written, and the
// files are byte-equal across runs: a compiler commits them and checks them for
// drift.
//
// No store answers here, so each document is its screen before the first read
// lands (interpreter/document.js): the app's own words, its strip and its
// head, which is what a reader can be shown before the data plane has booted.
// A region is drawn from the row its markup names to stand until its read
// lands (data-empty-row), and a route with a region that names none is
// refused: drawn empty, it would push down whatever follows it once its rows
// land, which a route rendered on request draws in place.
// Nothing here knows where the app is served, so <origin> is written ahead of
// every absolute link as given: whatever the door that serves the documents
// replaces with the deployment's origin.

import { parseHTML } from "linkedom";
import { controlProperties } from "./server/linkedom-controls.ts";

type Route = { path: string; screen: string; prerender?: boolean; files: { html: string; css: string } };
type Shell = {
  app: string;
  i18n?: { default: string; locales: Record<string, { path: string }> };
  routes: Route[];
};

const parse = (html: string) => (parseHTML(html) as unknown as { document: unknown }).document;

/** Every document this app prerenders, by address, its links spelled after
 * `origin`. */
export async function renderDocuments(appDir: URL, origin: string): Promise<Map<string, string>> {
  const read = (rel: string) => Deno.readTextFile(new URL(rel, appDir));
  const cfg: Shell = JSON.parse(await read("shell/shell.json"));
  const entry = await read("shell/index.html");

  // The interpreter's ambient world, as a browser would hand it one: a screen
  // reads its clock knobs off location at module evaluation, so this is set
  // before the interpreter is imported.
  const global = globalThis as unknown as Record<string, unknown>;
  global.location = new URL("http://render.invalid/");
  global.document = parse("<!doctype html><html><head></head><body></body></html>");
  controlProperties(global.document);
  (global as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  // Every fetch is a file of the app's own served tree, by the path the door
  // serves it at.
  global.fetch = async (url: unknown) => {
    const rel = new URL(String(url)).pathname.replace(/^\//, "");
    return new Response(await read(rel));
  };
  const { renderDocument } = await import("./interpreter/document.js");
  const { routeHref } = await import("./interpreter/fragment.js");
  const { compileCatalog } = await import("./interpreter/vendor/messages.js");
  const { fixtureStore } = await import("./interpreter/storybook.js");

  const { templateHash } = await import("./interpreter/screen.js");

  const tags = cfg.i18n === undefined ? [undefined] : Object.keys(cfg.i18n.locales);
  const messages: Record<string, unknown> = {};
  const words: Record<string, string> = {};
  for (const tag of tags) {
    if (tag === undefined) continue;
    const text = await read(`messages/${tag}.json`);
    messages[tag] = compileCatalog(JSON.parse(text));
    words[tag] = templateHash(text);
  }

  const out = new Map<string, string>();
  for (const route of cfg.routes.filter((r) => r.prerender)) {
    const markup = parseHTML(await read(route.files.html)).document;
    const bare = [...markup.querySelectorAll("[data-live]")]
      .filter((el) => el.closest("template") === null && !el.hasAttribute("data-empty-row"))
      .map((el) => `data-live="${el.getAttribute("data-live")}"`);
    if (bare.length > 0) {
      throw new Error(
        `${route.screen} is prerendered, and its ${bare.join(", ")} region${bare.length > 1 ? "s draw" : " draws"} nothing until its read lands, ` +
          `so the rows move what follows when they do: name the row each shows until then (data-empty-row), or render the route on request (ssr: "ssr")`,
      );
    }
    for (const tag of tags) {
      const address = routeHref(cfg, route.screen, {}, tag);
      const { html, handle } = await renderDocument({
        entry,
        parse,
        cfg,
        appBase: global.location,
        route,
        locale: tag,
        written: tag,
        store: fixtureStore("empty"),
        messages,
        words,
        rows: false,
        origin,
        here: address,
      });
      handle.stop();
      out.set(address, html);
    }
  }
  return out;
}

export async function run(args: string[]): Promise<void> {
  const [appArg, outArg, origin] = args;
  if (args.length !== 3) {
    console.error("usage: render-documents.ts <appDir> <outDir> <origin>");
    Deno.exit(1);
  }
  const cwd = `file://${Deno.cwd()}/`;
  const appDir = new URL(`${appArg.replace(/\/*$/, "")}/`, cwd);
  const outDir = new URL(`${outArg.replace(/\/*$/, "")}/`, cwd);
  for (const [address, html] of await renderDocuments(appDir, origin)) {
    const dir = new URL(`.${address.replace(/\/*$/, "")}/`, outDir);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(new URL("index.html", dir), html);
  }
}

if (import.meta.main) await run(Deno.args);
