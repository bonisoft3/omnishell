import { describe, expect, it, withPage } from "./harness.ts";

const root = new URL("../", import.meta.url);
const policy = (await Deno.readTextFile(new URL("content-security-policy.txt", root))).trim();

function serve() {
  const stop = new AbortController();
  const server = Deno.serve({ port: 0, signal: stop.signal, onListen() {} }, async (req) => {
    const path = new URL(req.url).pathname;
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
