import { strict as assert } from "node:assert"
import { fetchRelease } from "../interpreter/release-assets.js"
import { releaseManifest } from "./release-fixture.ts"

const source = await Deno.readTextFile(new URL("../offline-first-sw.js", import.meta.url))

function memoryCaches() {
  const stores = new Map<string, Map<string, Response>>()
  const key = (request: string | Request) => typeof request === "string" ? request : request.url
  return {
    async open(name: string) {
      let store = stores.get(name)
      if (!store) stores.set(name, store = new Map())
      return {
        async match(request: string | Request) { return store.get(key(request))?.clone() },
        async put(request: string | Request, response: Response) { store.set(key(request), response.clone()) },
        async delete(request: string | Request) { return store.delete(key(request)) },
        async keys() { return [...store.keys()].map(url => new Request(url)) },
        async addAll() {},
      }
    },
    async keys() { return [...stores.keys()] },
    async delete(name: string) { return stores.delete(name) },
  }
}

function worker(caches: ReturnType<typeof memoryCaches>, live: Set<string>, network: typeof fetch) {
  const handlers: Record<string, (event: unknown) => void> = {}
  const self = {
    location: { origin: "https://app.test" },
    addEventListener(type: string, fn: (event: unknown) => void) { handlers[type] = fn },
    clients: { async matchAll() { return [...live].map(id => ({ id })) },
      async get(id: string) { return live.has(id) ? { id } : undefined }, async claim() {} },
    skipWaiting() {},
  }
  new Function("self", "caches", "fetch", source)(self, caches, network)
  return {
    async message(clientId: string, data: unknown, pathname = "/") {
      let answer: { id?: string; ready?: boolean; error?: string } = {}
      let work: Promise<unknown> | undefined
      handlers.message({ source: { id: clientId, url: `https://app.test${pathname}` }, data,
        ports: [{ postMessage(value: typeof answer) { answer = value } }],
        waitUntil(promise: Promise<unknown>) { work = promise } })
      await work
      if (answer.error) throw new Error(answer.error)
      return answer
    },
    async get(path: string, clientId: string, resultingClientId = "", mode = "cors", cache = "default", destination = "", referrer = ""): Promise<Response> {
      const request = { url: `https://app.test${path}`, method: "GET", mode, cache, destination, referrer }
      let answer: Promise<Response> | undefined
      const work: Promise<unknown>[] = []
      handlers.fetch({ request, clientId: mode === "navigate" ? "" : clientId,
        replacesClientId: mode === "navigate" ? clientId : "", resultingClientId,
        respondWith(promise: Promise<Response>) { answer = promise },
        waitUntil(promise: Promise<unknown>) { work.push(promise) } })
      const response = answer ? await answer : await network(request as unknown as Request)
      await Promise.all(work)
      if (response.status === 302) {
        const redirect = new URL(response.headers.get("Location")!)
        return this.get(redirect.pathname + redirect.search, clientId, resultingClientId, mode, cache, destination, referrer)
      }
      return response
    },
  }
}

Deno.test("restart pins complete entry and runtime across tabs and worker restarts", async () => {
  const originalFetch = globalThis.fetch
  const originalCaches = globalThis.caches
  const originalNow = Date.now
  const caches = memoryCaches()
  const base = new URL("https://app.test/")
  const live = new Set(["before", "tab-a", "tab-b"])
  let now = 1000000
  Date.now = () => now
  const files = new Map([
    ["shell/index.html", '<html><script type="module" src="/shell/boot.js"></script></html>'],
    ["shell/boot.js", 'import "/omnishell/interpreter/shell.js";'],
    ["shell/design.css", ".old{}"],
    ["shell/shell.json", JSON.stringify({ routes: [{ path: "/" }, { path: "/edit/:id" }] })],
    ["omnishell/interpreter/shell.js", 'import "./dependency.js"; export const version = "a";'],
    ["omnishell/interpreter/dependency.js", 'export const version = "a";'],
  ])
  let manifest = await releaseManifest("runtime@a", files)
  let requests = 0
  const network: typeof fetch = async request => {
    requests++
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url)
    if (url.pathname === "/report.pdf") return new Response("%PDF-1.7", { headers: { "Content-Type": "application/pdf" } })
    if (url.pathname === "/admin") return new Response("external admin", { headers: { "Content-Type": "text/html" } })
    const text = url.pathname === "/shell/release.json" ? JSON.stringify(manifest) : files.get(url.pathname.slice(1))
    return new Response(text, { status: text === undefined ? 404 : 200 })
  }
  try {
    Object.defineProperty(globalThis, "caches", { value: caches, configurable: true })
    globalThis.fetch = network
    const a = await fetchRelease(base)
    assert.ok(a)
    const staticCache = await caches.open("pronto-static-v3")
    for (const [path, text] of files) await staticCache.put(new URL(path, base).href, new Response(text))
    const navigationCache = await caches.open("pronto-runtime-v3")
    await navigationCache.put(`${base}`, new Response("old document"))

    files.set("shell/index.html", '<html data-release="b"><script type="module" src="/shell/boot.js"></script></html>')
    files.set("shell/design.css", ".new{}")
    files.set("omnishell/interpreter/shell.js", 'import "./dependency.js"; export const version = "b";')
    files.set("omnishell/interpreter/dependency.js", 'export const version = "b";')
    manifest = await releaseManifest("runtime@b", files)
    const b = await fetchRelease(base, a)
    assert.ok(b)
    let sw = worker(caches, live, network)
    for (const release of [a, b]) {
      assert.equal((await sw.message("before", { type: "PRONTO_RELEASE_READY", base: base.href, id: release.manifest.id })).ready, true)
    }
    const beforePin = requests
    const document = await sw.get(`/?pronto-release=${b.manifest.id}`, "before", "tab-b", "navigate")
    assert.match(await document.text(), /data-release="b"/)
    assert.equal(document.headers.get("Content-Type"), "text/html")
    assert.match(await (await sw.get("/shell/boot.js", "tab-b")).text(), /\/omnishell\/interpreter\/shell.js/)
    const runtime = await sw.get("/omnishell/interpreter/shell.js", "tab-b")
    assert.equal(runtime.headers.get("Content-Type"), "text/javascript")
    assert.match(await runtime.text(), /version = "b"/)
    assert.match(await (await sw.get("/omnishell/interpreter/dependency.js", "tab-b")).text(), /version = "b"/)
    assert.equal(await (await sw.get("/shell/design.css", "tab-b")).text(), ".new{}")
    assert.equal(requests, beforePin)

    const report = await sw.get("/report.pdf", "tab-b", "report", "navigate")
    assert.equal(report.headers.get("Content-Type"), "application/pdf")
    assert.equal(await report.text(), "%PDF-1.7")
    assert.equal(await (await sw.get(`/report.pdf?pronto-release=${b.manifest.id}`, "tab-b", "report-explicit", "navigate")).text(), "%PDF-1.7")
    assert.equal(await (await sw.get("/admin", "tab-b", "admin", "navigate")).text(), "external admin")
    assert.match(await (await sw.get("/edit/7", "tab-b", "edit", "navigate")).text(), /data-release="b"/)

    await sw.get(`/?pronto-release=${a.manifest.id}`, "before", "tab-a", "navigate")
    assert.match(await (await sw.get("/omnishell/interpreter/dependency.js", "tab-a")).text(), /version = "a"/)
    sw = worker(caches, live, network)
    assert.equal((await sw.message("tab-b", { type: "PRONTO_RELEASE_CLIENT" })).id, b.manifest.id)
    assert.match(await (await sw.get("/omnishell/interpreter/dependency.js", "tab-b")).text(), /version = "b"/)
    live.add("reloaded")
    assert.match(await (await sw.get("/", "tab-b", "reloaded", "navigate")).text(), /data-release="b"/)
    assert.equal((await sw.message("reloaded", { type: "PRONTO_RELEASE_CLIENT" })).id, b.manifest.id)
    assert.equal((await fetchRelease(base, null, { releaseId: a.manifest.id }))?.manifest.id, a.manifest.id)

    now += 3600001
    await fetchRelease(base, b)
    const verified = await caches.open("pronto-verified-releases-v1")
    const oldRuntime = `${base}omnishell/interpreter/shell.js?pronto-release=${a.manifest.id}`
    assert.ok(await verified.match(oldRuntime), "an active tab pins its runtime past retention")
    live.delete("tab-a")
    await sw.message("tab-b", { type: "PRONTO_RELEASE_READY", base: base.href, id: a.manifest.id })
    await sw.message("tab-b", { type: "PRONTO_RELEASE_CLIENT" })
    await fetchRelease(base)
    assert.ok(await verified.match(oldRuntime), "a prepared restart survives concurrent pruning before navigation")
    now += 3600001
    await fetchRelease(base)
    assert.equal(await verified.match(oldRuntime), undefined)
    await verified.delete(`${base}omnishell/interpreter/dependency.js?pronto-release=${b.manifest.id}`)
    await assert.rejects(() => sw.get("/omnishell/interpreter/dependency.js", "tab-b"), /incomplete pinned release/)
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, "caches", { value: originalCaches, configurable: true })
  }
})

Deno.test("pinned navigation follows mounted and localized routes", async () => {
  const originalFetch = globalThis.fetch
  const originalCaches = globalThis.caches
  const caches = memoryCaches()
  const base = new URL("https://app.test/project/")
  const live = new Set(["before", "pinned"])
  const cfg = {
    prefix: "/project",
    i18n: { default: "pt", locales: { pt: { path: "br" }, es: { path: "es" } } },
    routes: [
      { path: "/", paths: { pt: "/", es: "/" } },
      { path: "/jogo/:id", paths: { pt: "/jogo/:id", es: "/partido/:id" } },
      { path: "/plain/:id" },
    ],
  }
  const files = new Map([
    ["shell/index.html", "pinned entry"],
    ["shell/shell.json", JSON.stringify(cfg)],
    ["omnishell/interpreter/shell.js", "export const ready = true;"],
  ])
  const manifest = await releaseManifest("runtime@one", files)
  let requests = 0
  const network: typeof fetch = async request => {
    requests++
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url)
    const path = url.pathname.startsWith(base.pathname) ? url.pathname.slice(base.pathname.length) : url.pathname.slice(1)
    return new Response(path === "shell/release.json" ? JSON.stringify(manifest) : files.get(path) ?? "outside app")
  }
  try {
    Object.defineProperty(globalThis, "caches", { value: caches, configurable: true })
    globalThis.fetch = network
    await fetchRelease(base)
    const sw = worker(caches, live, network)
    await sw.message("before", { type: "PRONTO_RELEASE_READY", base: base.href, id: manifest.id }, "/project")
    assert.equal(await (await sw.get(`/project?pronto-release=${manifest.id}`, "before", "pinned", "navigate")).text(), "pinned entry")
    const beforeRoutes = requests
    for (const path of ["/project", "/project/", "/project/br", "/project/es", "/project/jogo/1", "/project/es/partido/1", "/project/es/plain/1"]) {
      assert.equal(await (await sw.get(path, "pinned", "next", "navigate")).text(), "pinned entry", path)
    }
    assert.equal(requests, beforeRoutes)
    for (const path of ["/project/report.pdf", "/project/es/jogo/1", "/project/jogo/", "/projectx", "/project/es/partido/1/extra"]) {
      assert.equal(await (await sw.get(path, "pinned", "outside", "navigate")).text(), "outside app", path)
    }
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, "caches", { value: originalCaches, configurable: true })
  }
})

Deno.test("cleanup deletes a base's obsolete runtime without touching another base's current release", async () => {
  const originalFetch = globalThis.fetch
  const originalCaches = globalThis.caches
  const originalNow = Date.now
  const caches = memoryCaches()
  const root = new URL("https://app.test/")
  const mounted = new URL("https://app.test/project/")
  const rootFiles = new Map([
    ["shell/shell.json", JSON.stringify({ app: "root" })],
    ["shell/design.css", ".old{}"],
    ["omnishell/interpreter/shell.js", "export const ready = true;"],
  ])
  const mountedFiles = new Map(rootFiles)
  mountedFiles.set("shell/shell.json", JSON.stringify({ app: "project", prefix: "/project" }))
  let rootManifest = await releaseManifest("runtime@one", rootFiles)
  let mountedManifest = await releaseManifest("runtime@one", mountedFiles)
  let now = 1000000
  Date.now = () => now
  try {
    Object.defineProperty(globalThis, "caches", { value: caches, configurable: true })
    globalThis.fetch = async request => {
      const path = new URL(String(request)).pathname
      const project = path.startsWith(mounted.pathname)
      const asset = path.slice(project ? mounted.pathname.length : 1)
      return new Response(asset === "shell/release.json"
        ? JSON.stringify(project ? mountedManifest : rootManifest)
        : (project ? mountedFiles : rootFiles).get(asset))
    }
    const rootA = await fetchRelease(root)
    const mountedA = await fetchRelease(mounted)
    assert.ok(rootA)
    assert.ok(mountedA)
    now += 3600001
    rootFiles.set("shell/design.css", ".new{}")
    rootManifest = await releaseManifest("runtime@one", rootFiles)
    const rootB = await fetchRelease(root, rootA)
    assert.ok(rootB)
    const cache = await caches.open("pronto-verified-releases-v1")
    const runtimeKey = (id: string) => `${root}omnishell/interpreter/shell.js?pronto-release=${id}`
    assert.equal(await cache.match(runtimeKey(rootA.manifest.id)), undefined)
    assert.ok(await cache.match(runtimeKey(mountedA.manifest.id)))
    assert.ok(await cache.match(`${mounted}shell/shell.json?pronto-release=${mountedA.manifest.id}`))
    assert.ok(await cache.match(`${mounted}shell/release.json?pronto-release=${mountedA.manifest.id}`))
    assert.equal((await fetchRelease(mounted, null, { releaseId: mountedA.manifest.id }))?.manifest.id, mountedA.manifest.id)

    mountedFiles.set("shell/design.css", ".project-new{}")
    mountedManifest = await releaseManifest("runtime@one", mountedFiles)
    const mountedB = await fetchRelease(mounted, mountedA)
    assert.ok(mountedB)
    assert.equal(await cache.match(runtimeKey(mountedA.manifest.id)), undefined)
    assert.equal(await cache.match(`${mounted}shell/release.json?pronto-release=${mountedA.manifest.id}`), undefined)
    assert.ok(await cache.match(runtimeKey(mountedB.manifest.id)))
    assert.ok(await cache.match(runtimeKey(rootB.manifest.id)))
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, "caches", { value: originalCaches, configurable: true })
  }
})

Deno.test("reserved navigation and worker pins survive cleanup until arrival or abandonment", async () => {
  const originalFetch = globalThis.fetch
  const originalCaches = globalThis.caches
  const originalNow = Date.now
  const caches = memoryCaches()
  const base = new URL("https://app.test/")
  const live = new Set(["before"])
  let now = 1000000
  Date.now = () => now
  const files = new Map<string, string | Uint8Array<ArrayBuffer>>([
    ["shell/index.html", "entry A"],
    ["shell/shell.json", JSON.stringify({ routes: [{ path: "/" }] })],
    ["omnishell/interpreter/shell.js", "runtime A"],
    ["shell/units/worker.js", "worker A"],
    ["shell/units/child.js", "child A"],
    ["shell/units/engine.wasm", new Uint8Array([0, 97, 115, 109, 255])],
  ])
  let manifest = await releaseManifest("runtime@a", files)
  const network: typeof fetch = async request => {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url)
    const path = url.pathname.slice(1)
    return new Response(path === "shell/release.json" ? JSON.stringify(manifest) : files.get(path))
  }
  try {
    Object.defineProperty(globalThis, "caches", { value: caches, configurable: true })
    globalThis.fetch = network
    const a = await fetchRelease(base)
    assert.ok(a)
    let sw = worker(caches, live, network)
    await sw.message("before", { type: "PRONTO_RELEASE_READY", base: base.href, id: a.manifest.id })
    await sw.get(`/?pronto-release=${a.manifest.id}`, "before", "reserved", "navigate")
    const pins = await caches.open("pronto-release-clients-v1")
    const pinKey = (id: string) => `${base}.pronto/release-clients/${id}`
    await sw.message("before", { type: "PRONTO_RELEASE_CLIENT" })
    assert.equal((await (await pins.match(pinKey("reserved")))!.json()).pending, true)
    sw = worker(caches, live, network)
    await sw.message("before", { type: "PRONTO_RELEASE_CLIENT" })
    assert.ok(await pins.match(pinKey("reserved")), "pending lifecycle survives worker restart")

    files.set("shell/units/worker.js", "worker B")
    files.set("shell/units/child.js", "child B")
    files.set("shell/units/engine.wasm", new Uint8Array([0, 97, 115, 109, 254]))
    manifest = await releaseManifest("runtime@b", files)
    live.add("reserved")
    assert.equal(await (await sw.get("/shell/units/worker.js", "reserved", "worker", "same-origin", "default", "worker")).text(), "worker A")
    await sw.message("before", { type: "PRONTO_RELEASE_CLIENT" })
    assert.ok(await pins.match(pinKey("worker")), "worker script response reserves its descendant pin")
    live.add("worker")
    assert.equal(await (await sw.get("/shell/units/child.js", "worker")).text(), "child A")
    assert.deepEqual(new Uint8Array(await (await sw.get("/shell/units/engine.wasm", "worker")).arrayBuffer()), new Uint8Array([0, 97, 115, 109, 255]))
    const referrer = `${base}shell/units/worker.js?pronto-release=${a.manifest.id}`
    assert.equal(await (await sw.get("/shell/units/child.js", "", "", "no-cors", "default", "script", referrer)).text(), "child A")
    await assert.rejects(() => sw.get("/shell/units/child.js", "", "", "no-cors", "default", "script", `${base}shell/unlisted.js?pronto-release=${a.manifest.id}`), /asset absent from pinned release/)
    await sw.get("/shell/units/worker.js", "worker", "abandoned", "same-origin", "default", "worker")
    live.delete("reserved")
    await sw.message("before", { type: "PRONTO_RELEASE_CLIENT" })
    assert.equal(await pins.match(pinKey("reserved")), undefined)
    assert.ok(await pins.match(pinKey("worker")), "a live worker holds its release after the window leaves")
    live.delete("worker")
    await sw.message("before", { type: "PRONTO_RELEASE_CLIENT" })
    assert.equal(await pins.match(pinKey("worker")), undefined)
    assert.ok(await pins.match(pinKey("abandoned")))
    now += 3600001
    await sw.message("before", { type: "PRONTO_RELEASE_CLIENT" })
    assert.equal(await pins.match(pinKey("abandoned")), undefined)
    await fetchRelease(base, a)
    assert.equal(await (await caches.open("pronto-verified-releases-v1")).match(`${base}shell/units/engine.wasm?pronto-release=${a.manifest.id}`), undefined)
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, "caches", { value: originalCaches, configurable: true })
  }
})
