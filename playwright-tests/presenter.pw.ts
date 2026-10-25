// A presenter's worker can paint and do nothing else: the escape probes of
// pronto's endowed-Babylon record (docs/decisions/2026-10-22-endowed-babylon.md),
// run against the terminal's own seat and bootstrap rather than a spike's copy.
// The unit below is plain JavaScript holding raw Babylon, the worst case for
// what a presenter's code can be, and it tries every way out. Its report leaves
// the only way left: a message the seat refuses, whose refusal names it.
//
// A second server on another port is "elsewhere": anything that reaches it got
// out. The page's own server records what reaches it too, which is the one
// residual the policy's `script-src 'self'` leaves: a module import of a path
// on this origin, a GET carrying whatever its query says to the app's own
// door, which answers a script's fetch from its static files only.
import { describe, expect, it, withPage } from "./harness.ts";

const root = new URL("../", import.meta.url);
const read = (file: string) => Deno.readTextFile(new URL(file, root));
const terminalPolicy = (await read("content-security-policy.txt")).trim();
const presenterPolicy = (await read("presenter-security-policy.txt")).trim();
const BABYLON = "https://cdn.jsdelivr.net/npm/babylonjs@9.31.0/babylon.js";
const INTEGRITY = "sha384-GbwOam+gaf7GWvN708CvUiGqRFPFMS/lpYod2JfIip04KMa4TIJ8HXRjhwvT9DMC";
const babylon = new Uint8Array(await (await fetch(BABYLON)).arrayBuffer());
const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-384", babylon))));
if (`sha384-${digest}` !== INTEGRITY) throw new Error(`${BABYLON} is not the pinned file`);

const js = { "content-type": "text/javascript; charset=utf-8" };

const PAGE = `<!doctype html><div id="mount" style="width:320px;height:180px"></div>`;

function serve(unit: (elsewhere: string) => string, page = PAGE) {
  const stop = new AbortController();
  const reached: string[] = [];
  const dests: string[] = [];
  const away: string[] = [];
  const outside = Deno.serve({ port: 0, signal: stop.signal, onListen() {} }, (req) => {
    away.push(`${req.method} ${new URL(req.url).pathname}${new URL(req.url).search}`);
    return new Response("x", { headers: { ...js, "access-control-allow-origin": "*" } });
  });
  const elsewhere = `http://127.0.0.1:${outside.addr.port}`;
  const server = Deno.serve({ port: 0, signal: stop.signal, onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/") {
      return new Response(page, {
        headers: { "content-type": "text/html", "Content-Security-Policy": terminalPolicy },
      });
    }
    if (path === "/interpreter/presenter.js") {
      return new Response(await Deno.readFile(new URL(path.slice(1), root)), { headers: { ...js, "Content-Security-Policy": presenterPolicy } });
    }
    if (path.startsWith("/interpreter/")) return new Response(await Deno.readFile(new URL(path.slice(1), root)), { headers: js });
    if (path === "/pinned/babylon.js") return new Response(babylon, { headers: js });
    if (path === "/units/unit.js") return new Response(unit(elsewhere), { headers: js });
    if (path === "/units/data.txt") return new Response("declared");
    // A headed browser asks for the page's icon; that is the page, not the worker.
    if (path === "/favicon.ico") return new Response(null, { status: 204 });
    reached.push(`${req.method} ${path}${url.search}`);
    dests.push(req.headers.get("sec-fetch-dest") ?? "");
    return new Response("x", { headers: js });
  });
  return {
    base: `http://localhost:${server.addr.port}`,
    reached,
    dests,
    away,
    close: async () => {
      stop.abort();
      await Promise.all([server.finished, outside.finished]);
    },
  };
}

/** Mounts the unit and returns what the window heard thrown: the seat's
 * refusals, and the worker's own failures. */
async function mount(base: string, page: Parameters<Parameters<typeof withPage>[0]>[0], settle: string | null) {
  await page.goto(`${base}/`);
  return await page.evaluate(async ({ base, settle }) => {
    const heard: string[] = [];
    addEventListener("error", (e) => {
      e.preventDefault();
      heard.push(String(e.error?.message ?? e.message));
    });
    addEventListener("unhandledrejection", (e) => {
      e.preventDefault();
      heard.push(String(e.reason?.message ?? e.reason));
    });
    const { mountHatch } = await import("/interpreter/hatch.js");
    const unit = {
      isolation: "agent",
      role: "presenter",
      ports: { reads: [], raises: [] },
      scripts: [{ url: `${base}/pinned/babylon.js`, integrity: "sha384-GbwOam+gaf7GWvN708CvUiGqRFPFMS/lpYod2JfIip04KMa4TIJ8HXRjhwvT9DMC" }],
      files: ["units/data.txt"],
      seed: false,
      src: "units/unit.js",
    };
    const seat = mountHatch(document.getElementById("mount"), { unit, src: unit.src });
    let up = false;
    seat.ready.then(() => { up = true; }, () => {});
    // Until the refusal the test waits for is heard, or with none to wait
    // for, until the unit is up.
    const t0 = performance.now();
    const done = () => settle === null ? up : heard.some((h) => h.includes(settle));
    while (!done() && performance.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 50));
    return heard;
  }, { base, settle });
}

const probeUnit = (elsewhere: string) => `
const B = globalThis.BABYLON;
export default async function present(canvas, env) {
  const engine = new B.Engine(canvas, false);
  const scene = new B.Scene(engine);
  const camera = new B.TargetCamera("c", new B.Vector3(0, 5, -10), scene);
  new B.HemisphericLight("h", new B.Vector3(0, 1, 0), scene);
  const box = B.MeshBuilder.CreateBox("b", { size: 2 }, scene);
  const dt = new B.DynamicTexture("dt", { width: 64, height: 64 }, scene, false);
  dt.getContext().fillRect(0, 0, 64, 64);
  dt.update();
  scene.render();
  const F = [].constructor.constructor;
  const away = (q) => "${elsewhere}/" + q;
  const probes = {
    "fetch elsewhere": () => fetch(away("fetch")),
    "fetch this origin": () => fetch("/fetch-self"),
    "fetch through Function": () => F("return fetch")()(away("ctor")),
    "XMLHttpRequest": () => new Promise((ok, no) => { const x = new XMLHttpRequest(); x.open("GET", away("xhr")); x.onload = ok; x.onerror = () => no(new Error("refused")); x.send(); }),
    "WebSocket": () => new WebSocket("${elsewhere.replace("http", "ws")}/ws"),
    "EventSource": () => new EventSource(away("es")),
    "importScripts": () => importScripts(away("importScripts")),
    "import() elsewhere": () => import(away("import.js")),
    "indexedDB": () => indexedDB.open("x"),
    "caches": () => caches.open("x"),
    "BroadcastChannel": () => new BroadcastChannel("x").postMessage(1),
    "Worker": () => new Worker(away("worker.js")),
    "SharedWorker": () => new SharedWorker(away("shared.js")),
    "navigator.storage": () => navigator.storage.getDirectory(),
    "navigator.locks": () => navigator.locks.request("x", () => {}),
    "navigator.sendBeacon": () => navigator.sendBeacon(away("beacon")),
    "canvas.ownerDocument": () => { const d = engine.getRenderingCanvas().ownerDocument; if (!d) throw new Error("undefined"); return d; },
    "texture ctx.canvas.ownerDocument": () => { const d = dt.getContext().canvas.ownerDocument; if (!d) throw new Error("undefined"); return d; },
    "B.Texture(url)": () => new Promise((ok, no) => { new B.Texture(away("texture.png"), scene, false, true, 1, () => ok("loaded"), (m, e) => no(new Error(m || String(e)))); }),
    "B.Tools.LoadFile": () => new Promise((ok, no) => B.Tools.LoadFile(away("loadfile"), ok, undefined, undefined, false, (r, e) => no(e || new Error("failed")))),
    "B.Tools.LoadScript": () => new Promise((ok, no) => B.Tools.LoadScript(away("loadscript.js"), ok, (m) => no(new Error(m)))),
    "B.Tools.Download": () => B.Tools.Download(new Blob(["x"]), "x.txt"),
    "scene.debugLayer.show": () => scene.debugLayer.show().then(() => "shown"),
  };
  const out = {};
  for (const [name, probe] of Object.entries(probes)) {
    try {
      const r = await Promise.race([Promise.resolve().then(probe), new Promise((ok) => setTimeout(() => ok("pending"), 1000))]);
      out[name] = r === "pending" ? "pending" : "reached";
    } catch { out[name] = "refused"; }
  }
  // What a loader needs still works: bytes the worker holds, by blob:.
  // Babylon decodes its data: URIs itself, so the policy connects to none.
  out["blob: read"] = await (await fetch(URL.createObjectURL(new Blob(["held"])))).text();
  out["data: read"] = await fetch("data:text/plain,held").then((r) => r.text(), () => "refused");
  out["declared read"] = new TextDecoder().decode(await env.read("units/data.txt"));
  postMessage({ type: "probe " + JSON.stringify(out) });
  return { frame() {} };
}`;

describe("a presenter's worker", () => {
  it("reaches no network, storage, document or other context, and posts nothing past its port", async () => {
    const server = serve(probeUnit);
    try {
      await withPage(async (page) => {
        const heard = await mount(server.base, page, "probe {");
        const report = heard.find((h) => h.includes("probe {"));
        expect(report).toBeDefined();
        // The refusal quotes the type it refused, which is the report.
        const posted = JSON.parse(report!.slice(report!.indexOf("posted ") + 7, report!.lastIndexOf(", which"))) as string;
        const out = JSON.parse(posted.slice("probe ".length));
        // A network probe is held by what reached either server, which is
        // nothing: a Babylon loader may call its success callback on a refused
        // request (it reads XHR status 0 as a local file), and that is no
        // escape. Everything else had to fail where it stood.
        const local = ["indexedDB", "caches", "BroadcastChannel", "Worker", "SharedWorker", "navigator.storage", "navigator.locks", "navigator.sendBeacon", "canvas.ownerDocument", "texture ctx.canvas.ownerDocument", "importScripts", "WebSocket", "EventSource"];
        expect(local.filter((name) => out[name] !== "refused")).toEqual([]);
        expect([out["blob: read"], out["data: read"], out["declared read"]]).toEqual(["held", "refused", "declared"]);
        expect(report).toContain("which a presenter's port does not carry");
        expect(server.away).toEqual([]);
        expect(server.reached).toEqual([]);
      });
    } finally { await server.close(); }
  });

  it("refuses a read of a path it does not declare", async () => {
    const server = serve(() => `export default async function present(canvas, env) { await env.read("secret.txt"); return { frame() {} }; }`);
    try {
      await withPage(async (page) => {
        const heard = await mount(server.base, page, "does not declare");
        expect(heard.some((h) => h.includes(`read "secret.txt", which it does not declare`))).toBe(true);
        expect(server.reached).toEqual([]);
      });
    } finally { await server.close(); }
  });

  // The residual the policy's script-src 'self' leaves, pinned so a change to
  // it is a decision rather than a drift: a GET to this origin's own door,
  // which says it is a script's. Both doors answer that destination from a
  // static file only (terminal.cue `presenter.scripted`), so the GET reaches
  // no upstream, whose GET may act.
  it("reaches its own origin only by a module import's GET, which says it is a script's", async () => {
    const server = serve(() => `export default async function present() { await import("/residual.js?carried").catch(() => {}); return { frame() {} }; }`);
    try {
      await withPage(async (page) => {
        await mount(server.base, page, null);
        expect(server.reached).toEqual(["GET /residual.js?carried"]);
        expect(server.dests).toEqual(["script"]);
        expect(server.away).toEqual([]);
      });
    } finally { await server.close(); }
  });
});

// A screen's `<canvas data-layer>` is the presenter's too: the seat transfers
// it with its box and the text style CSS gave it, so the worker paints a
// gauge's digits where the panel put them.
describe("a presenter's layers", () => {
  it("are transferred with their box and style, and painted by the worker", async () => {
    const page = `<!doctype html><div data-screen="s"><div id="mount" style="width:320px;height:180px"></div>
      <span style="font: 700 24px monospace; color: rgb(255, 0, 0); zoom: 0.5"><canvas data-layer="digits" style="width: 40px; height: 20px; display: block"></canvas></span></div>`;
    const server = serve(() => `export default async function present(canvas, env) {
      const l = env.layers.digits;
      const ctx = l.canvas.getContext("2d");
      ctx.fillStyle = l.style.color;
      ctx.fillRect(0, 0, l.canvas.width, l.canvas.height);
      postMessage({ type: "layer " + JSON.stringify({ width: l.width, height: l.height, dpr: l.dpr, font: l.style.font }) });
      return { frame() {} };
    }`, page);
    try {
      await withPage(async (p) => {
        const heard = await mount(server.base, p, "layer {");
        const report = heard.find((h) => h.includes("layer {"))!;
        const posted = JSON.parse(report.slice(report.indexOf("posted ") + 7, report.lastIndexOf(", which"))) as string;
        const layer = JSON.parse(posted.slice("layer ".length));
        // The zoom halves the box, not the font the style reports. The font
        // stays above WebKit's minimum once zoomed: WebKit reports 12px under
        // `zoom: 0.5` as 18px, its 9px floor unzoomed, and the worker drawing
        // that at dpr 0.5 matches the text WebKit itself would paint.
        expect([layer.width, layer.height, layer.dpr]).toEqual([20, 10, 0.5]);
        expect(layer.font).toContain("24px");
        const shot = await (await p.$("canvas[data-layer]"))!.screenshot();
        expect(shot.length).toBeGreaterThan(0);
      });
    } finally { await server.close(); }
  });

  // Regression: a singleton slot region still carried `[data-hydrating]`
  // (`.screen [data-hydrating] > * { display: none !important }`) when
  // `bindHatches` mounted its presenter, and `ResizeObserver` dropped resize
  // notifications that arrived before `READY`, leaving every HUD `<canvas
  // data-layer>` permanently `1x1`.
  it("measure after slot hydration clears display:none, and flush resizes that land before READY", async () => {
    const page = `<!doctype html><style>.screen [data-hydrating] > * { display: none !important; }</style><div id="shell"></div>`;
    const server = serve(() => `export default async function present(canvas, env) {
      const l = env.layers.digits;
      const initial = [l.width, l.height];
      await new Promise((r) => setTimeout(r, 80));
      return {
        frame() {},
        resizeLayer(name, box) {
          postMessage({ type: "hydrated " + JSON.stringify({ initial, name, after: [box.width, box.height] }) });
        },
      };
    }`, page);
    try {
      await withPage(async (p) => {
        await p.goto(`${server.base}/`);
        const heard = await p.evaluate(async () => {
          const out: string[] = [];
          addEventListener("error", (e) => {
            e.preventDefault();
            out.push(String(e.error?.message ?? e.message));
          });
          const screenHtml = `<section class="screen" data-screen="s">
            <div data-region="r" data-live="hud" data-empty-row='{"id":"1"}'>
              <div id="mount" data-hatch="unit" style="width:320px;height:180px"></div>
              <canvas id="digits" data-layer="digits" style="width:40px;height:20px;display:block"></canvas>
            </div>
          </section>`;
          const origFetch = globalThis.fetch.bind(globalThis);
          globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input), location.origin);
            if (url.pathname === "/screen.html") return new Response(screenHtml, { headers: { "content-type": "text/html" } });
            if (url.pathname === "/screen.css") return new Response("", { headers: { "content-type": "text/css" } });
            return origFetch(input, init);
          };
          const { interpretScreen } = await import("/interpreter/screen.js");
          const store = {
            query: async () => [],
            subscribe: () => () => {},
          };
          await interpretScreen(document.getElementById("shell"), `${location.origin}/`, {
            screen: "s",
            files: { html: "screen.html", css: "screen.css", handlers: [] },
            states: ["loading", "empty", "populated"],
          }, store, {}, {
            units: {
              unit: {
                isolation: "agent",
                role: "presenter",
                ports: { reads: ["hud"], raises: [] },
                scripts: [],
                files: [],
                seed: false,
                src: "units/unit.js",
              },
            },
          });
          // Resize while `present()` is still awaiting its 80ms boot delay (before READY).
          const el = document.getElementById("digits") as HTMLElement;
          el.style.width = "60px";
          el.style.height = "30px";
          const t0 = performance.now();
          while (!out.some((h) => h.includes("hydrated {")) && performance.now() - t0 < 10000) {
            await new Promise((r) => setTimeout(r, 25));
          }
          return out;
        });
        const report = heard.find((h) => h.includes("hydrated {"))!;
        expect(report).toBeDefined();
        const posted = JSON.parse(report.slice(report.indexOf("posted ") + 7, report.lastIndexOf(", which"))) as string;
        const data = JSON.parse(posted.slice("hydrated ".length));
        expect(data.initial).toEqual([40, 20]);
        expect(data.name).toBe("digits");
        expect(data.after).toEqual([60, 30]);
      });
    } finally { await server.close(); }
  });
});
