import { describe, expect, it, withPage } from "./harness.ts"
import { releaseManifest } from "../test/release-fixture.ts"

async function serve() {
  const files = new Map<string, string>([
    ["shell/index.html", '<!doctype html><html><head><base href="/shell/"><link rel="stylesheet" href="shell.css"></head><body><div id="app"><div class="shell-screen" data-served><section class="screen" data-screen="home"><h1>Release</h1><input name="draft"></section></div></div><script type="module" src="boot.js"></script></body></html>'],
    ["shell/shell.css", "body { --release: A }"],
    ["shell/design.css", ""],
    ["shell/boot.js", `import { createShell } from "/omnishell/interpreter/shell.js";
      navigator.serviceWorker.register("/offline-first-sw.js");
      createShell({config:"./shell.json",mount:document.getElementById("app"),liveUpdates:true})
        .then(app => { window.appReady = !!app.store; window.navigate = app.navigate; });`],
    ["shell/shell.json", JSON.stringify({ app: "release", tables: [], routes: [
      { path: "/", screen: "home", nav: { label: "Home" }, files: { html: "shell/screens/home.html", css: "shell/screens/home.css", handlers: [] } },
      { path: "/other", screen: "home", nav: { label: "Home" }, files: { html: "shell/screens/home.html", css: "shell/screens/home.css", handlers: [] } },
    ] })],
    ["shell/screens/home.html", '<section class="screen" data-screen="home"><h1>Release</h1><input name="draft"></section>'],
    ["shell/screens/home.css", ""],
    ["offline-first-sw.js", await Deno.readTextFile(new URL("../offline-first-sw.js", import.meta.url))],
  ])
  const modules = ["shell.js", "chrome.js", "screen.js", "fragment.js", "data-sync.js", "validate.js", "render.js",
    "release-plan.js", "release-assets.js", "preloads.js", "hatch.js", "hatch-worker.js", "storybook.js", "jessie.js",
    "kinetic.js", "prng.js", "vendor/mecha-client.js", "vendor/js-yaml.js", "vendor/ses.umd.min.js", "vendor/morphlex.js", "vendor/messages.js"]
  for (const module of modules) files.set(`omnishell/interpreter/${module}`, await Deno.readTextFile(new URL(`../interpreter/${module}`, import.meta.url)))
  const shell = files.get("omnishell/interpreter/shell.js")!
  files.set("omnishell/interpreter/shell.js", `globalThis.runtimeRelease = "A";\n${shell}`)
  let manifest = await releaseManifest("runtime@A", files)
  let offline = false
  let releaseInitial!: () => void
  const initial = new Promise<void>(resolve => { releaseInitial = resolve })
  const stop = new AbortController()
  const server = Deno.serve({ port: 0, signal: stop.signal, onListen() {} }, async req => {
    if (offline) return new Response("offline", { status: 503 })
    const path = new URL(req.url).pathname.slice(1)
    if (path === "shell/release.json") { await initial; return Response.json(manifest) }
    const file = files.get(path) ?? (!path || path === "other" ? files.get("shell/index.html") : undefined)
    if (file === undefined) return new Response("missing", { status: 404 })
    const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".json") ? "application/json" : "text/html"
    return new Response(file, { headers: { "Content-Type": type, "Cache-Control": "no-cache" } })
  })
  return {
    base: `http://localhost:${(server.addr as Deno.NetAddr).port}`,
    async deploy() {
      files.set("shell/shell.css", "body { --release: B }")
      files.set("omnishell/interpreter/shell.js", `globalThis.runtimeRelease = "B";\n${shell}`)
      manifest = await releaseManifest("runtime@B", files)
      return manifest.id
    },
    releaseInitial,
    offline() { offline = true },
    async close() { releaseInitial(); stop.abort(); await server.finished },
  }
}

describe("verified release restart", () => {
  it("restarts into the new runtime and styles while another tab keeps its own release", async () => {
    const server = await serve()
    try {
      await withPage(async page => {
        const errors: string[] = []
        page.on("pageerror", error => errors.push(error.message))
        await page.goto(server.base)
        await page.locator("input").fill("typed during initial release download")
        await page.locator("input").blur()
        server.releaseInitial()
        await page.waitForFunction(() => (window as any).appReady || document.querySelector("pre"))
        expect(await page.locator("pre").allTextContents()).toEqual([])
        expect(await page.evaluate(() => (window as any).runtimeRelease)).toBe("A")
        expect(await page.locator("input").inputValue()).toBe("typed during initial release download")
        const other = await page.context().newPage()
        await other.goto(page.url())
        await other.waitForFunction(() => (window as any).appReady)
        await other.locator("input").fill("keep this tab on A")
        await page.locator("input").fill("recover me")
        await page.locator("input").blur()
        // The Navigation API must allow the release query to reload the document.
        const id = await server.deploy()
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
        await page.waitForFunction(() => (window as any).appReady && (window as any).runtimeRelease === "B")
        expect(new URL(page.url()).searchParams.has("pronto-release")).toBe(false)
        expect(await page.evaluate(async () => {
          const { startupReleaseId } = await import(String("/omnishell/interpreter/release-assets.js"))
          return startupReleaseId()
        })).toBe(id)
        expect(await page.locator("input").inputValue()).toBe("recover me")
        expect(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--release").trim())).toBe("B")
        expect(await other.evaluate(() => (window as any).runtimeRelease)).toBe("A")
        expect(await other.evaluate(async () => (await (await fetch("/omnishell/interpreter/shell.js")).text()).startsWith('globalThis.runtimeRelease = "A"'))).toBe(true)
        expect(await other.evaluate(() => getComputedStyle(document.body).getPropertyValue("--release").trim())).toBe("A")
        // A copied URL must also work in a browser with no verified cache.
        const fresh = await page.context().browser()!.newContext()
        try {
          const copied = await fresh.newPage()
          await copied.goto(page.url())
          await copied.waitForFunction(() => (window as any).appReady)
          expect(await copied.evaluate(() => (window as any).runtimeRelease)).toBe("B")
        } finally { await fresh.close() }
        // Normal app navigation must not discard the pin.
        await page.evaluate(() => (window as any).navigate("/other").finished)
        server.offline()
        await page.reload()
        await page.waitForFunction(() => (window as any).appReady || document.querySelector("pre"))
        expect(await page.locator("pre").allTextContents()).toEqual([])
        expect(await page.evaluate(() => (window as any).runtimeRelease)).toBe("B")
        expect(errors).toEqual([])
      })
    } finally { await server.close() }
  })
})
