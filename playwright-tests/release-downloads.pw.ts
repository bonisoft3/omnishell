import { describe, expect, it, withPage } from "./harness.ts"
import { releaseManifest } from "../test/release-fixture.ts"

async function serve(slow = false) {
  const binary = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
  const files = new Map<string, string | Uint8Array<ArrayBuffer>>([
    ["shell/index.html", '<!doctype html><html><head><link rel="icon" href="/shell/favicon.ico"></head><body>Verified<script type="module" src="/shell/boot.js"></script></body></html>'],
    ["shell/boot.js", 'import "/omnishell/interpreter/shell.js"; window.appReady = true;'],
    ["shell/shell.css", ""], ["shell/design.css", ""],
    ["shell/shell.json", JSON.stringify({ routes: [{ path: "/" }] })],
    ["shell/units/y.js", "export const y = 1;"],
    ["shell/units/j.js", "export const j = 1;"],
    ["shell/units/engine.wasm", binary],
    ["shell/favicon.ico", new Uint8Array([0, 0, 1, 0])],
    ["shell/shared/font.woff2", new Uint8Array([119, 79, 70, 50])],
    ["shell/manifest.webmanifest", JSON.stringify({ name: "Verified", icons: [{ src: "/shell/favicon.ico" }] })],
    ["omnishell/interpreter/shell.js", "export const ready = true;"],
  ])
  const manifest = await releaseManifest("runtime", files)
  const worker = await Deno.readTextFile(new URL("../offline-first-sw.js", import.meta.url))
  const assets = await Deno.readTextFile(new URL("../interpreter/release-assets.js", import.meta.url))
  const stop = new AbortController()
  const timers = new Set<number>()
  const server = Deno.serve({ port: 0, signal: stop.signal, onListen() {} }, request => {
    const path = new URL(request.url).pathname.slice(1)
    if (path === "setup") return new Response("<!doctype html><html><body>Setup</body></html>", { headers: { "Content-Type": "text/html" } })
    if (path === "shell/release.json") return Response.json(manifest)
    if (slow && path === "shell/units/engine.wasm") {
      let at = 0
      let timer: number
      const body = new ReadableStream({
        start(controller) {
          timer = setInterval(() => {
            controller.enqueue(binary.slice(at, at + 2))
            at += 2
            if (at === binary.length) {
              clearInterval(timer)
              timers.delete(timer)
              controller.close()
            }
          }, 1000)
          timers.add(timer)
        },
        cancel() { clearInterval(timer); timers.delete(timer) },
      })
      return new Response(body, { headers: { "Content-Type": "application/wasm" } })
    }
    const file = path === "offline-first-sw.js" ? worker : path === "probe-release-assets.js" ? assets : files.get(path || "shell/index.html")
    if (file === undefined) return new Response("missing", { status: 404 })
    const type = /\.js$/.test(path) ? "text/javascript" : /\.css$/.test(path) ? "text/css" : /\.json$/.test(path) ? "application/json" : /\.ico$/.test(path) ? "image/x-icon" : /\.woff2$/.test(path) ? "font/woff2" : /\.webmanifest$/.test(path) ? "application/manifest+json" : "text/html"
    return new Response(file, { headers: { "Content-Type": type } })
  })
  return {
    base: `http://localhost:${(server.addr as Deno.NetAddr).port}`,
    id: manifest.id,
    mutate() {
      files.set("shell/favicon.ico", new Uint8Array([1, 2, 3, 4]))
      files.set("shell/shared/font.woff2", new Uint8Array([4, 3, 2, 1]))
    },
    async close() {
      for (const timer of timers) clearInterval(timer)
      stop.abort()
      await server.finished
    },
  }
}

describe("verified release downloads", () => {
  it("verifies a producer's release in a browser whose locale orders paths differently", async () => {
    const server = await serve()
    try {
      await withPage(async page => {
        await page.goto(`${server.base}/setup`)
        const result = await page.evaluate(async () => {
          const { fetchRelease } = await import(String("/probe-release-assets.js"))
          return { locale: Intl.DateTimeFormat().resolvedOptions().locale, id: (await fetchRelease(new URL("/", location.href))).manifest.id }
        })
        expect(result).toEqual({ locale: "lt-LT", id: server.id })
      }, { locale: "lt-LT" })
    } finally { await server.close() }
  })

  it("verifies a healthy four-second binary body before pinning declared icons and fonts", async () => {
    const server = await serve(true)
    try {
      await withPage(async page => {
        await page.goto(`${server.base}/setup`)
        const started = Date.now()
        const id = await page.evaluate(async () => {
          await navigator.serviceWorker.register("/offline-first-sw.js")
          await navigator.serviceWorker.ready
          if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }))
          const { fetchRelease, prepareRestartRelease } = await import(String("/probe-release-assets.js"))
          const base = new URL("/", location.href)
          const release = await fetchRelease(base)
          await prepareRestartRelease(base, release)
          return release.manifest.id
        })
        expect(Date.now() - started).toBeGreaterThanOrEqual(3500)
        expect(id).toBe(server.id)
        server.mutate()
        await page.goto(`${server.base}/?pronto-release=${id}`)
        await page.waitForFunction(() => (window as any).appReady)
        const binary = await page.evaluate(async () => {
          const read = async (path: string) => {
            const response = await fetch(path)
            return { type: response.headers.get("Content-Type"), bytes: [...new Uint8Array(await response.arrayBuffer())] }
          }
          return {
            icon: await read("/shell/favicon.ico"), font: await read("/shell/shared/font.woff2"),
            manifest: await (await fetch("/shell/manifest.webmanifest")).json(),
          }
        })
        expect(binary.icon).toEqual({ type: "image/x-icon", bytes: [0, 0, 1, 0] })
        expect(binary.font).toEqual({ type: "font/woff2", bytes: [119, 79, 70, 50] })
        expect(binary.manifest.name).toBe("Verified")
      })
    } finally { await server.close() }
  })
})
