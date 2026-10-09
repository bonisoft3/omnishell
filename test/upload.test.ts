import { expect } from "@test/harness"
import { parseHTML } from "linkedom"
import { createStore } from "../interpreter/data-sync.js"
import { batched } from "../interpreter/batched-store.js"

const locationBeforeImport = Object.getOwnPropertyDescriptor(globalThis, "location")
Object.defineProperty(globalThis, "location", { value: { search: "?clock=manual" }, configurable: true, writable: true })
const { interpretScreen } = await import("../interpreter/screen.js")
if (locationBeforeImport) Object.defineProperty(globalThis, "location", locationBeforeImport)
else delete (globalThis as any).location

const storage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  }
}
async function until(test: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (test()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error("upload lifecycle did not settle")
}
const route = { screen: "upload", files: { html: "upload.html", css: "upload.css", handlers: [] }, states: ["loading", "empty", "populated"] }
const html = `<section class="screen" data-screen="upload">
  <form data-form="attach" data-entity="attachment" data-action="create">
    <input name="caption" value=" draft ">
    <input type="file" name="image_key" data-upload>
    <p class="store-error" hidden>Upload refused</p>
    <button type="submit">Save</button>
  </form>
</section>`

// The store's offline executor lives until page exit, even with no tables.
Deno.test({ name: "authenticated native file uploads", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  const names = ["document", "fetch", "sessionStorage", "localStorage", "location", "console"] as const
  const prior = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  const session = storage()
  let reloads = 0
  Object.defineProperty(globalThis, "sessionStorage", { value: session, configurable: true, writable: true })
  Object.defineProperty(globalThis, "localStorage", { value: storage(), configurable: true, writable: true })
  Object.defineProperty(globalThis, "location", { value: { search: "", reload: () => reloads++ }, configurable: true, writable: true })
  const signIn = (token: string) => session.setItem("pronto-token", JSON.stringify({ token, user: { id: token } }))
  const real = createStore()
  const file = new File([new Uint8Array([137, 80, 78, 71])], "portrait.png", { type: "image/png" })
  const requests: Request[] = []
  let reply: (request: Request) => Promise<Response> = async () => new Response(null, { status: 204 })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://upload.test")
    if (url.pathname === "/upload.html") return new Response(html)
    if (url.pathname === "/upload.css") return new Response("")
    const request = new Request(url, init)
    requests.push(request)
    return await reply(request)
  }) as typeof fetch
  try {
    await t.step("PUT uses the current bearer, retains bytes and content type, and forwards through the batch adapter", async () => {
      const double = batched({ upload: real.upload })
      expect(double.upload).toBe(real.upload)
      signIn("account-one")
      await double.upload("first.png", file)
      signIn("account-two")
      await double.upload("second.png", file)
      expect(requests.map(r => [r.method, r.url, r.headers.get("authorization"), r.headers.get("content-type")])).toEqual([
        ["PUT", "https://upload.test/blobs/mecha-objects/first.png", "Bearer account-one", "image/png"],
        ["PUT", "https://upload.test/blobs/mecha-objects/second.png", "Bearer account-two", "image/png"],
      ])
      expect(new Uint8Array(await requests[0].arrayBuffer())).toEqual(new Uint8Array(await file.arrayBuffer()))
    })
    await t.step("missing session refuses before sending bytes; HTTP refusal makes no unauthenticated retry", async () => {
      const before = requests.length
      session.removeItem("pronto-token")
      await expect(real.upload("missing.png", file)).rejects.toThrow("requires an authenticated session")
      expect(requests.length).toBe(before)
      signIn("refused-account")
      reply = async () => new Response(null, { status: 403 })
      await expect(real.upload("refused.png", file)).rejects.toThrow("403 PUT /blobs/mecha-objects/refused.png")
      expect(requests.length).toBe(before + 1)
      expect(requests.at(-1)!.headers.get("authorization")).toBe("Bearer refused-account")
    })
    await t.step("401 clears the expired session and retains the existing unresolved re-gating lifecycle", async () => {
      signIn("expired-account")
      reply = async () => new Response(null, { status: 401 })
      let settled = false
      real.upload("expired.png", file).then(() => { settled = true }, () => { settled = true })
      await until(() => reloads === 1)
      expect(session.getItem("pronto-token")).toBe(null)
      expect(settled).toBe(false)
    })
    async function mount(upload: typeof real.upload | undefined, files: File[]) {
      const { document, Event } = parseHTML("<html><head></head><body><main id=app></main></body></html>")
      globalThis.document = document as any
      const writes: any[] = [], errors: unknown[] = []
      const originalConsole = globalThis.console
      globalThis.console = { ...originalConsole, error: (...values: unknown[]) => errors.push(values[0]) }
      const store = batched({ query: async () => [], subscribe: () => () => {}, create: async (_table: string, row: unknown) => { writes.push(row) }, ...(upload ? { upload } : {}) })
      const handle = await interpretScreen(document.getElementById("app"), "https://upload.test/", route, store, {}, { handlers: false })
      const form = document.querySelector("form") as any
      form.checkValidity = () => true
      let resets = 0
      form.reset = () => { resets++ }
      const input = document.querySelector('input[type="file"]') as any
      Object.defineProperty(input, "files", { value: files, configurable: true })
      return { document, writes, errors, form, input, resets: () => resets,
        submit: () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
        stop: () => { (globalThis as any).__prontoClock.advance(600); handle.stop(); globalThis.console = originalConsole },
      }
    }
    await t.step("the form stays pending until upload succeeds, then writes the key with its scalar fields", async () => {
      signIn("form-account")
      let complete!: (response: Response) => void
      reply = () => new Promise(resolve => { complete = resolve })
      const app = await mount(real.upload, [file])
      try {
        const before = requests.length
        app.submit()
        await until(() => requests.length === before + 1)
        expect(app.form.dataset.submitting).toBe("")
        expect(requests.at(-1)!.headers.get("authorization")).toBe("Bearer form-account")
        expect(app.writes).toEqual([])
        expect(app.document.querySelector(".screen")!.getAttribute("data-state")).toBe("form-submit")
        complete(new Response(null, { status: 204 }))
        await until(() => app.writes.length === 1 && app.form.dataset.submitting === undefined)
        expect(app.writes[0].caption).toBe("draft")
        expect(app.writes[0].image_key).toMatch(/^[0-9a-f-]{36}\.png$/)
        expect(requests.at(-1)!.url).toBe(`https://upload.test/blobs/mecha-objects/${app.writes[0].image_key}`)
        expect(app.resets()).toBe(1)
        expect(app.errors).toEqual([])
      } finally { app.stop() }
    })
    // A reader's file name once reached the key verbatim, so "logo.png (1)"
    // became a path the media gateway could not route.
    await t.step("an upload key keeps only a short alphanumeric extension from the file name", async () => {
      signIn("name-account")
      reply = async () => new Response(null, { status: 204 })
      for (const [name, ext] of [["Crest.PNG", ".png"], ["logo.png (1)", ".bin"], ["crest.final-v2", ".bin"], ["README", ".bin"]]) {
        const app = await mount(real.upload, [new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" })])
        try {
          app.submit()
          await until(() => app.writes.length === 1 && app.form.dataset.submitting === undefined)
          expect(app.writes[0].image_key).toMatch(new RegExp(`^[0-9a-f-]{36}\\${ext}$`))
        } finally { app.stop() }
      }
    })
    await t.step("upload refusal preserves the draft and file, shows the existing error, and prevents the row write", async () => {
      signIn("form-account")
      reply = async () => new Response(null, { status: 403 })
      const app = await mount(real.upload, [file])
      try {
        app.submit()
        await until(() => app.errors.length === 1 && app.form.dataset.submitting === undefined)
        expect(String(app.errors[0])).toMatch(/403 PUT \/blobs\/mecha-objects\//)
        expect(app.writes).toEqual([])
        expect(app.resets()).toBe(0)
        expect((app.document.querySelector('[name="caption"]') as any).value).toBe(" draft ")
        expect(app.input.files[0]).toBe(file)
        expect(app.document.querySelector(".store-error")!.hasAttribute("hidden")).toBe(false)
      } finally { app.stop() }
    })
    await t.step("an empty optional file leaves scalar forms working without an upload method", async () => {
      const before = requests.length
      const app = await mount(undefined, [])
      try {
        app.submit()
        await until(() => app.writes.length === 1 && app.form.dataset.submitting === undefined)
        expect(app.writes[0].caption).toBe("draft")
        expect("image_key" in app.writes[0]).toBe(false)
        expect(requests.length).toBe(before)
        expect(app.errors).toEqual([])
      } finally { app.stop() }
    })
    await t.step("an upload without the store capability fails visibly instead of using raw fetch", async () => {
      const before = requests.length
      const app = await mount(undefined, [file])
      try {
        app.submit()
        await until(() => app.errors.length === 1 && app.form.dataset.submitting === undefined)
        expect(app.writes).toEqual([])
        expect(requests.length).toBe(before)
        expect(app.document.querySelector(".store-error")!.hasAttribute("hidden")).toBe(false)
      } finally { app.stop() }
    })
  } finally {
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete (globalThis as any)[name]
    }
  }
} })
