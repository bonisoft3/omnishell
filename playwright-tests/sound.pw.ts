// A sound role's one authority is the AudioContext the seat hands it
// (interpreter/kinetic-sound.js), so what that context reaches is the role's
// reach. The probes below run against a real browser's Web Audio after the
// terminal's own lockdown and taming: a caged module holding the context
// tries the ways out, and a walk of every value its graph exposes looks for
// the page, the network and storage.
import { describe, expect, it, withPage } from "./harness.ts";

const root = new URL("../", import.meta.url);
const terminalPolicy = (await Deno.readTextFile(new URL("content-security-policy.txt", root))).trim();
const js = { "content-type": "text/javascript; charset=utf-8" };

function serve() {
  const stop = new AbortController();
  const server = Deno.serve({ port: 0, signal: stop.signal, onListen() {} }, async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/") return new Response("<!doctype html><p>sound</p>", { headers: { "content-type": "text/html", "Content-Security-Policy": terminalPolicy } });
    if (path.startsWith("/interpreter/")) return new Response(await Deno.readFile(new URL(path.slice(1), root)), { headers: js });
    return new Response(null, { status: 404 });
  });
  return { base: `http://localhost:${server.addr.port}`, close: async () => { stop.abort(); await server.finished; } };
}

describe("a sound role's AudioContext", () => {
  it("reaches no document, network or storage once tamed, from the cage or by its graph", async () => {
    const server = serve();
    try {
      await withPage(async (page) => {
        await page.goto(`${server.base}/`);
        const out = await page.evaluate(async () => {
          const { ensureSes, evaluateCaged } = await import("/interpreter/jessie.js");
          const { createSoundSeat, TAMED } = await import("/interpreter/kinetic-sound.js");
          await ensureSes();
          let handed = null;
          createSoundSeat({ createSound: (make: () => AudioContext) => { handed = make(); return {}; } });
          const ctx = handed as unknown as AudioContext;
          const tamed = TAMED.map(([owner, name]) => [owner, name, name in ((globalThis as any)[owner]?.prototype ?? {})]);

          // The cage: a module holding the context and nothing else.
          const caged = await evaluateCaged(`(ctx) => {
            const tries = {
              "constructor's Function": () => ctx.constructor.constructor("return document")(),
              "a node's Function": () => ctx.createGain().connect.constructor("return fetch")(),
              "audioWorklet.addModule": () => ctx.audioWorklet.addModule("/x.js"),
              "setSinkId": () => ctx.setSinkId("x"),
              "globalThis.document": () => globalThis.document.title,
              "globalThis.fetch": () => globalThis.fetch("/x"),
            };
            const out = {};
            for (const [name, t] of Object.entries(tries)) {
              try { const r = t(); out[name] = r === undefined ? "undefined" : "reached"; } catch { out[name] = "refused"; }
            }
            return out;
          }`);
          const tries = caged(ctx);

          // The graph: every value reachable by property from the context and
          // from what its factories make, getters read on their own receiver.
          const forbidden = new Map<unknown, string>([
            [window, "window"], [document, "document"], [fetch, "fetch"], [XMLHttpRequest, "XMLHttpRequest"],
            [WebSocket, "WebSocket"], [indexedDB, "indexedDB"], [localStorage, "localStorage"], [navigator, "navigator"],
            [Worker, "Worker"], [caches, "caches"], [location, "location"], [history, "history"],
          ]);
          const made = [
            ctx, ctx.createGain(), ctx.createOscillator(), ctx.createBiquadFilter(), ctx.createBufferSource(),
            ctx.createAnalyser(), ctx.createDynamicsCompressor(), ctx.createBuffer(1, 128, ctx.sampleRate),
            ctx.createMediaStreamDestination(), ctx.createConvolver(), ctx.createPanner(), ctx.createDelay(),
            ctx.createStereoPanner(), ctx.createWaveShaper(), ctx.createConstantSource(), ctx.createChannelMerger(),
            ctx.createChannelSplitter(), ctx.createIIRFilter([1], [1]), ctx.createPeriodicWave([0, 1], [0, 0]),
          ];
          const seen = new Set<unknown>();
          const queue: unknown[] = [...made];
          const reached: string[] = [];
          while (queue.length > 0 && seen.size < 20000) {
            const v = queue.shift();
            if ((typeof v !== "object" && typeof v !== "function") || v === null || seen.has(v)) continue;
            seen.add(v);
            if (forbidden.has(v)) reached.push(forbidden.get(v)!);
            for (let o: any = v; o !== null; o = Object.getPrototypeOf(o)) {
              for (const key of Reflect.ownKeys(o)) {
                const d = Object.getOwnPropertyDescriptor(o, key)!;
                try {
                  queue.push(d.get ? d.get.call(v) : d.value);
                } catch { /* a getter for another receiver */ }
              }
            }
          }
          return { tamed, tries, reached, walked: seen.size };
        });
        expect(out.tamed.filter(([, , left]) => left)).toEqual([]);
        expect(out.tries).toEqual({
          "constructor's Function": "refused",
          "a node's Function": "refused",
          "audioWorklet.addModule": "refused",
          "setSinkId": "refused",
          "globalThis.document": "refused",
          "globalThis.fetch": "refused",
        });
        expect(out.reached).toEqual([]);
        expect(out.walked).toBeGreaterThan(100);
      });
    } finally { await server.close(); }
  });
});
