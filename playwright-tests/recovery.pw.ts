import { FIXTURE_CARRIERS } from "../interpreter/fixture-types.js"
import { describe, expect, it, type Page, withPage } from "./harness.ts"
import { releaseManifest } from "../test/release-fixture.ts"

async function serve(authenticated = false, automaticGuest = false, promoteTo?: string) {
  const screen = (name: string) => `<section class="screen" data-screen="${name}"><h1>Release</h1><input name="draft" id="draft"><input name="answer" type="radio" value="no"><input name="answer" type="radio" value="yes"><div data-live="probe"><template data-item><p data-text="{id}"></p></template></div></section>`
  const files = new Map<string, string>([
    ["shell/index.html", `<!doctype html><html><head><base href="/shell/"><link rel="stylesheet" href="shell.css"></head><body><div id="app"><div class="shell-screen" data-served>${screen("home")}</div></div><script type="module" src="boot.js"></script></body></html>`],
    ["shell/shell.css", "body { --release: A }"],
    ["shell/design.css", ""],
    ["shell/boot.js", `import { createShell } from "/omnishell/interpreter/shell.js";
      navigator.serviceWorker.register("/offline-first-sw.js");
      createShell({config:"./shell.json",mount:document.getElementById("app"),liveUpdates:true})
        .then(app => { window.appReady = !!app.store; window.navigate = app.navigate; });`],
    ["shell/shell.json", JSON.stringify({ app: "release", tables: automaticGuest ? ["unused"] : [], sync: { unused: "on-demand" }, ...(authenticated ? { auth: { required: true, service: "/auth", promote: !!promoteTo } } : {}), local: { probe: "tab" }, carriers: FIXTURE_CARRIERS, routes: [
      { path: "/", screen: "home", nav: { label: "Home" }, files: { html: "shell/screens/home.html", css: "shell/screens/home.css", handlers: [] } },
      { path: "/other", screen: "other", nav: { label: "Other" }, files: { html: "shell/screens/other.html", css: "shell/screens/other.css", handlers: [] } },
    ] })],
    ["shell/screens/home.html", screen("home")],
    ["shell/screens/other.html", screen("other")],
    ["shell/screens/other.css", ""],
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
  let runtime = "A"
  const stop = new AbortController()
  const server = Deno.serve({ port: 0, signal: stop.signal, onListen() {} }, req => {
    const path = new URL(req.url).pathname.slice(1)
    if (path === "auth/login/start") return Response.json({ state: "challenge", challenge: "AA" })
    if (path === "auth/login/verify") return Response.json({ token: "promoted", user: { id: promoteTo, handle: "Promoted", guest: false } })
    if (path === "auth/guest") return Response.json({ token: "userB", user: { id: "B", handle: "User B", guest: true } })
    if (path === "shell/release.json") return Response.json(manifest)
    const file = files.get(path) ?? (!path || path === "other" ? files.get("shell/index.html") : undefined)
    if (file === undefined) return new Response("missing", { status: 404 })
    const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".json") ? "application/json" : "text/html"
    return new Response(file, { headers: { "Content-Type": type, "Cache-Control": "no-cache" } })
  })
  return {
    base: `http://localhost:${(server.addr as Deno.NetAddr).port}`,
    async deploy(version: string, templateOnly = false) {
      if (templateOnly) {
        for (const screen of ["home", "other"]) {
          const path = `shell/screens/${screen}.html`
          files.set(path, files.get(path)!.replace(/<h1>.*?<\/h1>/, `<h1>Template ${version}</h1>`))
        }
      } else {
        runtime = version
        files.set("omnishell/interpreter/shell.js", `globalThis.runtimeRelease = "${version}";\n${shell}`)
      }
      manifest = await releaseManifest(`runtime@${runtime}`, files)
    },
    async editor(rich: boolean) {
      const path = "shell/screens/home.html"
      files.set(path, files.get(path)!.replace(
        /<input name="draft" id="draft">|<div id="draft" contenteditable="true"><\/div>/,
        rich ? '<div id="draft" contenteditable="true"></div>' : '<input name="draft" id="draft">',
      ))
      manifest = await releaseManifest(`runtime@${runtime}`, files)
    },
    async close() { stop.abort(); await server.finished },
  }
}

async function refresh(page: Page) {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
}

async function ready(page: Page, version: string) {
  await page.waitForFunction(version => (window as any).appReady && (window as any).runtimeRelease === version, version)
}

describe("release draft recovery", () => {
  it("keeps newer input while a replacement screen waits for a region read", async () => {
    const server = await serve()
    try {
      await withPage(async page => {
        await page.addInitScript(() => {
          let store: any
          Object.defineProperty(window, "__prontoStore", {
            configurable: true,
            get() { return store },
            set(value) {
              store = value
              if ((window as any).runtimeRelease !== "B") return
              const gate = new Promise<void>(resolve => { (window as any).finishRead = resolve })
              const query = store.query
              store.query = async (...args: any[]) => {
                if (args[0] === "probe") await gate
                return query(...args)
              }
            },
          })
        })
        await page.goto(server.base)
        await ready(page, "A")
        await page.locator('input[value="yes"]').check()
        await page.locator('input[name="draft"]').fill("before restart")
        await page.locator('input[name="draft"]').blur()
        await server.deploy("B")
        await refresh(page)
        await page.waitForFunction(() => (window as any).runtimeRelease === "B" &&
          !!(window as any).finishRead && !!document.querySelector("[data-live=probe]"))
        await page.locator('input[name="draft"]').fill("typed while hydrating")
        await page.locator('input[value="no"]').check()
        await page.evaluate(() => (window as any).finishRead())
        await ready(page, "B")
        expect(await page.locator('input[name="draft"]').inputValue()).toBe("typed while hydrating")
        expect(await page.locator('input[value="no"]').isChecked()).toBe(true)
        expect(await page.locator('input[value="yes"]').isChecked()).toBe(false)
      })
    } finally { await server.close() }
  })

  for (const next of ["morph", "restart", "reload"]) {
    it(`retains an unvisited draft through a subsequent ${next}`, async () => {
      const server = await serve()
      try {
        await withPage(async page => {
          await page.goto(server.base)
          await ready(page, "A")
          await page.locator('input[name="draft"]').fill("home draft")
          await page.locator('input[name="draft"]').blur()
          await page.evaluate(() => (window as any).navigate("/other").finished)
          await page.locator('[data-screen="other"] input[name="draft"]').fill("other draft")
          await page.locator('[data-screen="other"] input[name="draft"]').blur()
          await server.deploy("B")
          await refresh(page)
          await ready(page, "B")
          expect(await page.locator('input[name="draft"]').inputValue()).toBe("other draft")
          expect(await page.evaluate(() => Object.keys(JSON.parse(sessionStorage.getItem("pronto-live-update-recovery")!).screens))).toHaveLength(1)
          if (next === "restart") {
            await server.deploy("C")
            await refresh(page)
            await ready(page, "C")
          } else {
            await server.deploy("C", true)
            await refresh(page)
            await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Template C")
            if (next === "reload") {
              await page.reload()
              await ready(page, "B")
            }
          }
          await page.evaluate(() => (window as any).navigate("/").finished)
          expect(await page.locator('[data-screen="home"] input[name="draft"]').inputValue()).toBe("home draft")
          expect(await page.evaluate(() => sessionStorage.getItem("pronto-live-update-recovery"))).toBe(null)
        })
      } finally { await server.close() }
    })
  }

  for (const switchAccount of ["signout", "replace", "same-account", "promotion", "same-promotion"]) {
    it(`scopes pending recovery to its account across ${switchAccount}`, async () => {
      const server = await serve(true, false, switchAccount === "promotion" ? "B" : switchAccount === "same-promotion" ? "A" : undefined)
      try {
        await withPage(async page => {
          await page.addInitScript(() => {
            Object.defineProperty(navigator.credentials, "get", { value: async () => ({
              id: "credential", rawId: new ArrayBuffer(1), type: "public-key",
              getClientExtensionResults: () => ({}),
              response: { clientDataJSON: new ArrayBuffer(1), authenticatorData: new ArrayBuffer(1), signature: new ArrayBuffer(1) },
            }) })
            if (sessionStorage.getItem("seeded")) return
            sessionStorage.setItem("seeded", "yes")
            sessionStorage.setItem("pronto-token", JSON.stringify({ token: "userA", user: { id: "A", handle: "User A", guest: true } }))
          })
          await page.goto(server.base)
          await ready(page, "A")
          await page.locator('input[name="draft"]').fill("private draft for A")
          await page.locator('input[name="draft"]').blur()
          await page.evaluate(() => (window as any).navigate("/other").finished)
          await server.deploy("B")
          await refresh(page)
          await ready(page, "B")
          if (switchAccount === "signout") {
            await page.locator(".shell-signout").click()
            await page.locator(".login-guest").waitFor()
            expect(await page.evaluate(() => sessionStorage.getItem("pronto-live-update-recovery"))).toBe(null)
            await page.locator(".login-guest").click()
          } else if (switchAccount.endsWith("promotion")) {
            await page.locator(".shell-signin").click()
            await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("pronto-token")!).user.guest === false)
            await page.waitForFunction(() => (window as any).appReady && document.querySelector(".shell-signout") !== null)
          } else {
            await page.evaluate(same => sessionStorage.setItem("pronto-token", JSON.stringify({
              token: "new-token", user: { id: same ? "A" : "B", handle: "New session", guest: false },
            })), switchAccount === "same-account")
            await page.reload()
          }
          await ready(page, "B")
          await page.evaluate(() => (window as any).navigate("/").finished)
          expect(await page.locator('[data-screen="home"] input[name="draft"]').inputValue())
            .toBe(switchAccount.startsWith("same-") ? "private draft for A" : "")
        })
      } finally { await server.close() }
    })
  }

  it("keeps plain text inert when a template switches to a rich editor", async () => {
    const server = await serve()
    try {
      await withPage(async page => {
        await page.goto(server.base)
        await ready(page, "A")
        const text = '<img src="bad" onerror="window.injected=42">'
        await page.locator('input[name="draft"]').fill(text)
        await page.locator('input[name="draft"]').blur()
        await server.editor(true)
        await refresh(page)
        await page.locator("#draft[contenteditable]").waitFor()
        expect(await page.locator("#draft").textContent()).toBe(text)
        expect(await page.locator("#draft img").count()).toBe(0)
        expect(await page.evaluate(() => (window as any).injected)).toBe(undefined)
        await page.locator("#draft").evaluate(el => {
          el.innerHTML = "<b>Formatted draft</b>"
          el.dispatchEvent(new Event("input", { bubbles: true }))
        })
        await server.editor(false)
        await refresh(page)
        await page.locator("input#draft").waitFor()
        expect(await page.locator("#draft").inputValue()).toBe("Formatted draft")
      })
    } finally { await server.close() }
  })


  it("retains an anonymous bootstrap draft for the automatically minted guest", async () => {
    const server = await serve(false, true)
    try {
      await withPage(async page => {
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        await page.route("**/shell/release.json", async route => { await gate; await route.continue() })
        await page.goto(server.base, { waitUntil: "domcontentloaded" })
        await page.locator('input[name="draft"]').fill("guest draft")
        await page.locator('input[name="draft"]').blur()
        release()
        await ready(page, "A")
        expect(await page.locator('input[name="draft"]').inputValue()).toBe("guest draft")
        expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("pronto-token")!).user.id)).toBe("B")
      })
    } finally { await server.close() }
  })


  it("replaces a malformed optional-auth token without restoring its old drafts", async () => {
    const server = await serve(false, true)
    try {
      await withPage(async page => {
        await page.goto(server.base)
        await ready(page, "A")
        await page.locator('input[name="draft"]').fill("untrusted old account draft")
        await page.locator('input[name="draft"]').blur()
        await page.evaluate(() => (window as any).navigate("/other").finished)
        await server.deploy("B")
        await refresh(page)
        await ready(page, "B")
        expect(await page.evaluate(() => Object.keys(JSON.parse(sessionStorage.getItem("pronto-live-update-recovery")!).screens))).toHaveLength(1)
        await page.evaluate(() => sessionStorage.setItem("pronto-token", "{malformed"))
        await page.reload()
        await ready(page, "B")
        expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("pronto-token")!).user.guest)).toBe(true)
        expect(await page.evaluate(() => sessionStorage.getItem("pronto-live-update-recovery"))).toBe(null)
        await page.evaluate(() => (window as any).navigate("/").finished)
        expect(await page.locator('[data-screen="home"] input[name="draft"]').inputValue()).toBe("")
      })
    } finally { await server.close() }
  })

})
