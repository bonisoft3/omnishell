import { describe, expect, it, withPage } from "./harness.ts";

const root = new URL("../", import.meta.url);
const policy = (await Deno.readTextFile(new URL("content-security-policy.txt", root))).trim();

function serve() {
  const stop = new AbortController();
  const server = Deno.serve({ port: 0, signal: stop.signal, onListen() {} }, async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/bundled-ses.js") return new Response(`export function installSes() {\n${await Deno.readTextFile(new URL("interpreter/vendor/ses.umd.min.js", root))}\n}`, { headers: { "content-type": "text/javascript" } });
    if (path === "/shell/screens/probe.html") return new Response('<section data-screen="probe"><button id="probe">Count</button></section>');
    if (path === "/shell/screens/probe.css") return new Response("");
    if (path === "/shell/hatches/probe.js") return new Response(`
      export default function(screen, { signal }) {
        window.mounts = (window.mounts ?? 0) + 1;
        document.title = "host DOM reached";
        const button = screen.querySelector("button");
        button.addEventListener("click", () => { window.clicks = (window.clicks ?? 0) + 1; }, { signal });
        return () => { window.stops = (window.stops ?? 0) + 1; };
      }`, { headers: { "content-type": "text/javascript" } });
    if (path.startsWith("/interpreter/")) {
      return new Response(await Deno.readFile(new URL(path.slice(1), root)), { headers: { "content-type": "text/javascript" } });
    }
    return new Response(`<!doctype html>${path === "/meta" ? `<meta http-equiv="Content-Security-Policy" content="${policy}">` : ""}<p>safe</p>`, {
      headers: { "content-type": "text/html", ...(path === "/meta" ? {} : { "Content-Security-Policy": policy }) },
    });
  });
  return { base: `http://localhost:${server.addr.port}`, close: async () => { stop.abort(); await server.finished; } };
}

describe("the terminal content security boundary", () => {
  it("a compiled SES installer uses the same bounded eval permission as a module load", async () => {
    const server = serve();
    try {
      await withPage(async (page) => {
        await page.goto(`${server.base}/header`);
        const result = await page.evaluate(async () => {
          const { ensureSes, evaluateCaged } = await import("/interpreter/jessie.js");
          const { installSes } = await import("/bundled-ses.js");
          let installed = 0;
          const install = () => { installed++; installSes(); };
          await ensureSes(install);
          await ensureSes(install);
          const value = await evaluateCaged('({sum: 1 + 2, authority: typeof fetch})');
          let refused = false;
          try { (0, eval)('1+2'); } catch { refused = true; }
          return { installed, value, refused };
        });
        expect(result).toEqual({ installed: 1, value: { sum: 3, authority: "undefined" }, refused: true });
      });
    } finally { await server.close(); }
  });
  for (const mode of ["header", "meta"]) it(`${mode} admits parsed markup and SES while rejecting untrusted sinks`, async () => {
    const server = serve();
    try {
      await withPage(async (page) => {
        await page.goto(`${server.base}/${mode}`);
        const result = await page.evaluate(async () => {
          const { parseMarkup } = await import("/interpreter/markup.js");
          const { evaluateCaged } = await import("/interpreter/jessie.js");
          const rejected = [];
          for (const source of ['<script>run()</script>', '<img onerror="run()">', '<a href="java&#10;script:run()">go</a>', '<template><svg onload="run()"></svg></template>']) {
            try { parseMarkup(document, source); rejected.push(false); } catch { rejected.push(true); }
          }
          document.body.append(parseMarkup(document, '<section><template><p>inert</p></template><p id="accepted">accepted</p></section>'));
          const value = await evaluateCaged('({sum: 1 + 2, authority: typeof fetch})');
          for (const run of [
            () => { document.body.innerHTML = '<img src=x onerror="run()">'; },
            () => { const s = document.createElement('script'); s.textContent = 'run()'; },
            () => (0, eval)('1+2'),
            () => trustedTypes.createPolicy('escape', { createHTML: (s) => s }),
          ]) { try { run(); rejected.push(false); } catch { rejected.push(true); } }
          return { rejected, value, text: document.getElementById('accepted')?.textContent };
        });
        expect(result).toEqual({ rejected: Array(8).fill(true), value: { sum: 3, authority: "undefined" }, text: "accepted" });
      });
    } finally { await server.close(); }
  });
});


describe("declared host-DOM execution", () => {
  it("mounts under CSP and owns listeners across pause, resume, morph and removal", async () => {
    const server = serve();
    try {
      await withPage(async (page) => {
        await page.goto(`${server.base}/header`);
        const result = await page.evaluate(async () => {
          const { interpretScreen } = await import("/interpreter/screen.js");
          const { hostDomScreen } = await import("/interpreter/host-dom.js");
          const base = new URL("/", location.href);
          const mount = document.createElement("main");
          document.body.append(mount);
          const route = { screen: "probe", hatches: ["dealer"], files: { html: "shell/screens/probe.html", css: "shell/screens/probe.css", handlers: [] } };
          const opts = { handlers: false, hostDom: { dealer: { src: "shell/hatches/probe.js", note: "trusted document access" } } };
          const store = { query: async () => [], subscribe: () => () => {} };
          const handle = await interpretScreen(mount, base, route, store, {}, opts);
          const click = () => mount.querySelector("button").click();
          click();
          handle.pause();
          click();
          await handle.resume();
          click();
          await handle.morph('<section data-screen="probe"><button id="probe">Changed</button></section>');
          click();
          handle.stop();
          click();
          const refused = [];
          for (const [r, h] of [
            [route, {}],
            [{ ...route, hatches: ["dealer", "dealer"] }, opts.hostDom],
            [route, { dealer: { src: "https://remote.test/code.js", note: "remote" } }],
            [route, { dealer: { src: "shell/hatches/probe.js", note: "" } }],
          ]) {
            try { await hostDomScreen(r, base, h); refused.push(false); }
            catch { refused.push(true); }
          }
          const inert = await interpretScreen(mount, base, route, store, {}, { ...opts, mountHostDom: false });
          inert.stop();
          return { mounts: window.mounts, stops: window.stops, clicks: window.clicks, title: document.title, refused };
        });
        expect(result).toEqual({ mounts: 3, stops: 3, clicks: 3, title: "host DOM reached", refused: Array(4).fill(true) });
      });
    } finally { await server.close(); }
  });
});
