import { strict as assert } from "node:assert"
import { parseHTML } from "linkedom"
import { releaseManifest, simulateStylesheetLoads } from "./release-fixture.ts"
import { activateRelease } from "../interpreter/release-assets.js"

Deno.test({
  name: "the first verified bootstrap waits for edits and restores drafts typed before and during its fetch",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const names = [
      "fetch",
      "caches",
      "navigator",
      "location",
      "history",
      "document",
      "window",
      "addEventListener",
      "setInterval",
      "scrollTo",
      "requestAnimationFrame",
      "sessionStorage",
    ]
    const original = new Map(
      names.map(
        (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)],
      ),
    )
    const install = (name: string, value: unknown) =>
      Object.defineProperty(globalThis, name, {
        value,
        configurable: true,
        writable: true,
      })
    const origin = "http://localhost:8080"
    const html =
      '<section class="screen" data-screen="home"><input name="before"><input name="during"><input type="password" name="password"><input type="file" name="file"><form id="pending"></form><div id="rich" contenteditable="true"><strong>default</strong></div></section>'
    const config = {
      app: "bootstrap",
      tables: [],
      routes: [{
        path: "/",
        screen: "home",
        nav: { label: "Home" },
        files: {
          html: "shell/screens/home.html",
          css: "shell/screens/home.css",
          handlers: [],
        },
      }],
    }
    const files = new Map([
      ["shell/index.html", "<html></html>"],
      ["shell/boot.js", "export {}"],
      ["shell/shell.css", ""],
      ["omnishell/interpreter/shell.js", "export {}"],
      ["shell/shell.json", JSON.stringify(config)],
      ["shell/screens/home.html", html],
      ["shell/screens/home.css", ""],
    ])
    const manifest = await releaseManifest("runtime@one", files)
    const entries = new Map<string, Response>()
    const cache = {
      match: async (request: string) => entries.get(String(request))?.clone(),
      put: async (request: string, response: Response) => {
        entries.set(String(request), response.clone())
      },
      keys: async () => [...entries.keys()].map((url) => new Request(url)),
      delete: async (request: Request) => entries.delete(request.url),
    }
    const storage = new Map<string, string>()
    const location = {
      origin,
      href: `${origin}/`,
      pathname: "/",
      search: "",
      restarts: 0,
      replace(href: string) {
        this.href = href
        this.search = new URL(href).search
        this.restarts++
      },
    }
    let openManifest!: () => void
    let fetchedManifest!: () => void
    const fetching = new Promise<void>((resolve) => {
      fetchedManifest = resolve
    })
    const delayed = new Promise<void>((resolve) => {
      openManifest = resolve
    })
    const stopStyles: (() => void)[] = []
    const page = () => {
      const parsed = parseHTML(
        `<!doctype html><html><head><base href="${origin}/shell/"></head><body><div id="app"><div class="shell-screen" data-served>${html}</div></div></body></html>`,
      )
      stopStyles.push(simulateStylesheetLoads(parsed.document))
      for (const field of parsed.document.querySelectorAll("input")) {
        Object.defineProperty(field, "defaultValue", { value: field.value })
      }
      return parsed
    }
    try {
      const { document, Event } = page()
      install("document", document)
      install("window", globalThis)
      install("location", location)
      install("history", {
        state: null,
        pushState() {},
        replaceState(_state: unknown, _title: string, href: string) {
          location.href = href
          location.search = new URL(href).search
        },
      })
      install("navigator", {
        languages: ["en"],
        serviceWorker: {
          controller: {
            postMessage(message: { type: string }, [port]: MessagePort[]) {
              port.postMessage(
                message.type === "PRONTO_RELEASE_CLIENT" ? { id: null } : { ready: true },
              )
              port.close()
            },
          },
          ready: Promise.resolve({}),
          addEventListener() {},
        },
      })
      install("caches", { open: async () => cache })
      install("sessionStorage", {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      })
      install("addEventListener", () => {})
      install("setInterval", () => 1)
      install("scrollTo", () => {})
      install(
        "requestAnimationFrame",
        (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
      )
      install("fetch", async (request: RequestInfo | URL) => {
        const path = new URL(String(request), origin).pathname.slice(1)
        if (path === "shell/release.json") {
          fetchedManifest()
          await delayed
          return new Response(JSON.stringify(manifest))
        }
        return new Response(files.get(path), {
          status: files.has(path) ? 200 : 404,
        })
      })
      const before = document.querySelector(
        'input[name="before"]',
      ) as HTMLInputElement
      before.value = "typed before JS"
      const during = document.querySelector(
        'input[name="during"]',
      ) as HTMLInputElement
      let focused: Element | null = during
      Object.defineProperty(document, "activeElement", { get: () => focused })
      const password = document.querySelector(
        'input[name="password"]',
      ) as HTMLInputElement
      password.value = "secret"
      const file = document.querySelector(
        'input[name="file"]',
      ) as HTMLInputElement
      let selectedFiles = [{}]
      Object.defineProperty(file, "files", { get: () => selectedFiles })
      const form = document.getElementById("pending")!
      form.setAttribute("data-submitting", "")
      const { createShell } = await import("../interpreter/shell.js")
      const boot = createShell({
        config: "./shell.json",
        mount: document.getElementById("app"),
        liveUpdates: true,
      })
      await fetching
      during.value = "typed during fetch"
      during.dispatchEvent(new Event("input", { bubbles: true }))
      const rich = document.getElementById("rich")!
      rich.innerHTML = "<em>typed rich draft</em>"
      rich.dispatchEvent(new Event("input", { bubbles: true }))
      openManifest()
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(location.restarts, 0)
      focused = null
      during.dispatchEvent(new Event("focusout", { bubbles: true }))
      password.value = ""
      password.dispatchEvent(new Event("change", { bubbles: true }))
      selectedFiles = []
      file.dispatchEvent(new Event("change", { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(
        location.restarts,
        0,
        "pending submissions still hold the restart",
      )
      form.removeAttribute("data-submitting")
      assert.equal((await boot).restarting, true)
      assert.equal(location.restarts, 1)
      const recovery = JSON.parse(storage.get("pronto-live-update-recovery")!)
      assert.equal(recovery.expected, manifest.id)
      assert.equal(recovery.tabs, undefined)
      assert.deepEqual(
        recovery.initial.map(([, field]: [string, { value: string }]) => field.value).sort(),
        ["<em>typed rich draft</em>", "typed before JS", "typed during fetch"],
      )

      const next = page()
      install("document", next.document)
      await createShell({
        config: "./shell.json",
        mount: next.document.getElementById("app"),
        liveUpdates: true,
      })
      assert.equal(
        (next.document.querySelector(
          'input[name="before"]',
        ) as HTMLInputElement).value,
        "typed before JS",
      )
      assert.equal(
        (next.document.querySelector(
          'input[name="during"]',
        ) as HTMLInputElement).value,
        "typed during fetch",
      )
      assert.equal(next.document.getElementById("rich")?.innerHTML, "<em>typed rich draft</em>")
      assert.equal(storage.has("pronto-live-update-recovery"), false)
    } finally {
      for (const stop of stopStyles) stop()
      activateRelease(null)
      for (const [name, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    }
  },
})
