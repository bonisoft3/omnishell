import { strict as assert } from "node:assert"
import { parseHTML } from "npm:linkedom@0.18.4"
import { releaseManifest, simulateStylesheetLoads } from "./release-fixture.ts"
import { FIXTURE_CARRIERS } from "../interpreter/fixture-types.js"
import { fetchRelease } from "../interpreter/release-assets.js"

Deno.test({
  name: "a template update morphs a retained screen and a code update restarts",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const original = {
      fetch: globalThis.fetch,
      caches: globalThis.caches,
      navigator: globalThis.navigator,
      location: globalThis.location,
      history: globalThis.history,
      document: globalThis.document,
      window: globalThis.window,
      addEventListener: globalThis.addEventListener,
      setInterval: globalThis.setInterval,
      scrollTo: globalThis.scrollTo,
      requestAnimationFrame: globalThis.requestAnimationFrame,
      Event: globalThis.Event,
    }
    const { document, Event } = parseHTML(
      '<!doctype html><html><head><base href="http://localhost:8080/shell/"></head><body><div id="app"></div></body></html>',
    )
    const stopStyles = simulateStylesheetLoads(document)
    const origin = "http://localhost:8080"
    const location = { origin, href: `${origin}/`, pathname: "/", search: "", reloads: 0,
      reload() { this.reloads += 1 },
      replace(href: string) { this.href = href; this.reloads += 1 } }
    const config = {
      app: "smoke", tables: [], local: { probe: "tab" }, carriers: FIXTURE_CARRIERS,
      routes: ["home", "other"].map((screen) => ({
        path: screen === "home" ? "/" : "/other", screen, nav: { label: screen },
        files: { html: `shell/screens/${screen}.html`, css: `shell/screens/${screen}.css`, handlers: [] },
      })),
    }
    const screen = (name: string, added = "", reverse = false) => {
      const rows = ["a", "b"].map((id) => `<div data-id="${id}"><input name="draft"></div>`)
      if (reverse) rows.reverse()
      return `<section class="screen" data-screen="${name}"><h1>${name}</h1>${rows.join("")}<select name="choices" multiple><option value="a">A</option><option value="b">B</option></select><input name="answer" type="radio" value="yes"><input name="answer" type="radio" value="no"><div id="rich" contenteditable="true"><strong>old</strong></div><input name="password" type="password">${added}</section>`
    }
    const files = new Map([
      ["shell/index.html", "<html></html>"],
      ["shell/boot.js", "export {}"],
      ["shell/shell.css", ""],
      ["omnishell/interpreter/shell.js", "export {}"],
      ["shell/shell.json", JSON.stringify(config)],
      ["shell/screens/home.html", screen("home")],
      ["shell/screens/home.css", '@IMPORT "./shared/common.css"; .quoted::after{content:\'@import "ignore.css";\'}'],
      ["shell/screens/other.html", screen("other")],
      ["shell/screens/other.css", ""],
      ["shell/shared/common.css", '@import url("nested.css"); .verified{color:green}'],
      ["shell/shared/nested.css", ".nested{color:blue}"],
      ["shell/handlers/change.js", "export default 1"],
    ])
    let manifest = await releaseManifest("runtime@one", files)
    const initialManifestId = manifest.id
    const entries = new Map<string, Response>()
    const cache = {
      match: async (request: string) => entries.get(String(request))?.clone(),
      put: async (request: string, response: Response) => { entries.set(String(request), response.clone()) },
      keys: async () => [...entries.keys()].map((url) => new Request(url)),
      delete: async (request: Request) => entries.delete(request.url),
    }
    const workerListeners = new Map<string, (event?: unknown) => void>()
    let releaseRequests = 0
    let intervals = 0
    let releaseTick: () => void = () => { throw new Error("release timer not installed") }
    try {
      globalThis.document = document
      Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true })
      Object.defineProperty(globalThis, "location", { value: location, configurable: true })
      Object.defineProperty(globalThis, "history", { value: { pushState: (_state: unknown, _title: string, path: string) => {
        const url = new URL(path, origin)
        location.href = url.href
        location.pathname = url.pathname
        location.search = url.search
      }, replaceState: () => {} }, configurable: true })
      Object.defineProperty(globalThis, "navigator", { value: { languages: ["en"], serviceWorker: {
        controller: { postMessage(message: { type: string }, [port]: MessagePort[]) {
          port.postMessage(message.type === "PRONTO_RELEASE_CLIENT" ? { id: initialManifestId } : { ready: true })
          port.close()
        } },
        ready: Promise.resolve({ active: { postMessage() {} } }),
        addEventListener: (type: string, listener: (event?: unknown) => void) => workerListeners.set(type, listener),
      } }, configurable: true })
      globalThis.addEventListener = () => {}
      Object.defineProperty(globalThis, "setInterval", { configurable: true, value: (fn: () => void) => {
        if (typeof fn !== "function") throw new Error("release timer is not a callback")
        intervals += 1
        releaseTick = () => { void fn() }
        return 1
      } })
      globalThis.scrollTo = () => {}
      Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (fn: FrameRequestCallback) => {
        setTimeout(() => fn(0), 0)
        return 1
      } })
      Object.defineProperty(globalThis, "caches", { value: { open: async () => cache }, configurable: true })
      globalThis.fetch = async (request) => {
        const path = new URL(String(request), origin).pathname.slice(1)
        if (path === "shell/release.json") {
          releaseRequests += 1
          return new Response(JSON.stringify(manifest))
        }
        return new Response(files.get(path), { status: files.has(path) ? 200 : 404 })
      }

      const { createShell } = await import("../interpreter/shell.js")
      await fetchRelease(new URL(`${origin}/`))
      const { store, navigate } = await createShell({ config: "./shell.json", mount: document.getElementById("app"), liveUpdates: true })
      if (!navigate) throw new Error("shell did not provide navigation")
      assert.equal(intervals, 1)
      assert.equal(document.getElementById("screen-css-home")?.textContent, files.get("shell/screens/home.css"))
      const draft = document.querySelector<HTMLInputElement>('[data-screen="home"] [data-id="a"] input')
      if (!draft) throw new Error("draft missing")
      draft.value = "kept"
      draft.dispatchEvent(new Event("input", { bubbles: true }))
      const rich = document.querySelector<HTMLElement>('[data-screen="home"] #rich')
      if (!rich) throw new Error("editable control missing")
      rich.innerHTML = "<em>kept</em>"
      rich.dispatchEvent(new Event("input", { bubbles: true }))
      const radio = document.querySelector<HTMLInputElement>('[data-screen="home"] input[name="answer"][value="yes"]')
      if (!radio) throw new Error("radio missing")
      radio.checked = true
      radio.dispatchEvent(new Event("input", { bubbles: true }))
      await navigate("/other")
      const beforeChange = releaseRequests
      let changes = 0
      let inputs = 0
      document.addEventListener("change", () => { changes += 1 })
      document.addEventListener("input", () => { inputs += 1 })
      draft.dispatchEvent(new Event("change", { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(releaseRequests, beforeChange)
      files.set("shell/screens/home.html", screen("home", '<p id="added">new section</p>', true))
      manifest = await releaseManifest("runtime@one", files)
      releaseTick()
      await new Promise((resolve) => setTimeout(resolve, 180))
      await navigate("/")
      assert.equal(document.querySelector("#added")?.textContent, "new section", document.getElementById("app")?.innerHTML)
      assert.equal(document.querySelector<HTMLInputElement>('[data-screen="home"] [data-id="a"] input')?.value, "kept")
      assert.equal(document.querySelector<HTMLInputElement>('[data-screen="home"] [data-id="b"] input')?.value, "")
      assert.equal(document.querySelector('[data-screen="home"] #rich')?.innerHTML, "<em>kept</em>")
      const restoredRadio = document.querySelector<HTMLInputElement>('[data-screen="home"] input[name="answer"][value="yes"]')
      assert.equal(restoredRadio?.checked, true)
      assert.equal((restoredRadio as HTMLInputElement & { _prontoDirty?: boolean })._prontoDirty, true)
      assert.equal(changes, 1)
      assert.equal(inputs, 0)
      assert.equal((globalThis as typeof globalThis & { __prontoStore: unknown }).__prontoStore, store)

      // Region reads can outlive the field snapshot; edits during that wait
      // belong to the reader even when hydration replaces their control.
      let releaseRead!: () => void
      let enteredRead!: () => void
      const reading = new Promise<void>(resolve => { enteredRead = resolve })
      const delayed = new Promise<void>(resolve => { releaseRead = resolve })
      const query = store.query
      store.query = async (...args: Parameters<typeof query>) => {
        if (args[0] === "probe") { enteredRead(); await delayed }
        return query(...args)
      }
      files.set("shell/screens/home.html", screen("home", '<p id="added">new section</p><div data-live="probe"><template data-item><p data-text="{id}"></p></template></div>', true)
        .replace(/<div data-id=("[^"]+")>(.*?)<\/div>/g, '<article data-id=$1>$2</article>'))
      manifest = await releaseManifest("runtime@one", files)
      releaseTick()
      await reading
      const during = document.querySelector<HTMLInputElement>('[data-screen="home"] [data-id="a"] input')!
      assert.equal(during.value, "kept")
      during.value += "!"
      during.dispatchEvent(new Event("input", { bubbles: true }))
      releaseRead()
      await new Promise(resolve => setTimeout(resolve, 180))
      store.query = query
      assert.equal(document.querySelector<HTMLInputElement>('[data-screen="home"] [data-id="a"] input')?.value, "kept!")

      const password = document.querySelector<HTMLInputElement>('[data-screen="home"] input[type="password"]')
      if (!password) throw new Error("password missing")
      password.value = "editing"
      files.set("shell/screens/home.css", '@import "./shared/common.css"; .next{display:block}')
      manifest = await releaseManifest("runtime@one", files)
      document.dispatchEvent(new Event("visibilitychange"))
      await new Promise((resolve) => setTimeout(resolve, 80))
      assert.equal(document.querySelector<HTMLInputElement>('[data-screen="home"] input[type="password"]')?.value, "editing")
      assert.doesNotMatch(document.getElementById("screen-css-home")?.textContent ?? "", /\.next/)
      password.value = ""
      password.dispatchEvent(new Event("change", { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 180))
      assert.match(document.getElementById("screen-css-home")?.textContent ?? "", /\.next/)

      files.set("shell/handlers/change.js", "export default 2")
      manifest = await releaseManifest("runtime@one", files)
      workerListeners.get("message")?.({ data: { type: "PRONTO_ASSET_UPDATED", pathname: "/shell/handlers/change.js" } })
      await new Promise((resolve) => setTimeout(resolve, 80))
      assert.equal(location.reloads, 1)
      assert.equal(new URL(location.href).searchParams.get("pronto-release"), manifest.id)
      assert.equal(JSON.parse(sessionStorage.getItem("pronto-live-update-recovery") ?? "{}").expected, manifest.id)
    } finally {
      stopStyles()
      for (const [name, value] of Object.entries(original)) {
        Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
      }
    }
  },
})
