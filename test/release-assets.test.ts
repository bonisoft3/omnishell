import { strict as assert } from "node:assert"
import { releaseManifest } from "./release-fixture.ts"
import { activateRelease, fetchRelease, readAsset } from "../interpreter/release-assets.js"

Deno.test("an incomplete deployment cannot replace a verified release", async () => {
  const originalFetch = globalThis.fetch
  const originalCaches = globalThis.caches
  const originalNow = Date.now
  let now = 1000000
  Date.now = () => now
  const base = new URL("https://example.test/")
  const binary = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 255]);
  const files = new Map<string, string | Uint8Array<ArrayBuffer>>([
    ["shell/shell.json", "{}"],
    ["shell/screens/team.html", "<main>old</main>"],
    ["shell/screens/team.css", "main{}"],
    ["shell/units/engine.wasm", binary],
  ])
  let manifest = await releaseManifest("runtime@one", files)
  const stored = new Map<string, Response>()
  const cache = {
    match: async (request: string | Request) => stored.get(typeof request === "string" ? request : request.url)?.clone(),
    put: async (request: string, response: Response) => { stored.set(String(request), response.clone()) },
    keys: async () => [...stored.keys()].map((url) => new Request(url)),
    delete: async (request: Request) => stored.delete(request.url),
  }
  try {
    Object.defineProperty(globalThis, "caches", { value: { open: async () => cache }, configurable: true })
    globalThis.fetch = async (request) => {
      const path = new URL(String(request)).pathname.slice(1)
      if (path === "shell/release.json") return new Response(JSON.stringify(manifest))
      return new Response(files.get(path), { status: files.has(path) ? 200 : 404 })
    }
    const before = await fetchRelease(base)
    assert.equal(before?.manifest.id, manifest.id)
    activateRelease(before)
    assert.equal(await readAsset(new URL("shell/screens/team.html", base)), "<main>old</main>")
    const cachedBinary = await cache.match(`${base}shell/units/engine.wasm?pronto-release=${manifest.id}`)
    assert.equal(cachedBinary?.headers.get("Content-Type"), "application/wasm")
    assert.deepEqual(new Uint8Array(await cachedBinary!.arrayBuffer()), binary)
    await assert.rejects(() => readAsset(new URL("shell/units/engine.wasm", base)), /text reader cannot read binary/)

    files.set("shell/screens/team.html", "<main>partial deploy</main>")
    assert.equal((await fetchRelease(base))?.manifest.id, before?.manifest.id)
    assert.equal(await readAsset(new URL("shell/screens/team.html", base)), "<main>old</main>")

    globalThis.fetch = async () => { throw new TypeError("offline") }
    const offline = await fetchRelease(base)
    assert.equal(offline?.manifest.id, manifest.id)
    assert.equal(offline?.assets.get(new URL("shell/screens/team.html", base).href), "<main>old</main>")
    assert.deepEqual(offline?.assets.get(new URL("shell/units/engine.wasm", base).href), binary)
    globalThis.fetch = async () => { throw new Error("cached startup fetched the network") }
    assert.equal((await fetchRelease(base, null, { preferCached: true }))?.manifest.id, manifest.id)

    const firstId = manifest.id
    files.set("shell/screens/team.html", "<main>new release</main>")
    manifest = await releaseManifest("runtime@one", files)
    files.delete("shell/screens/team.css")
    assert.equal((await fetchRelease(base, before))?.manifest.id, firstId)
    files.set("shell/screens/team.css", "main{}")
    globalThis.fetch = async (request) => {
      const path = new URL(String(request)).pathname.slice(1)
      if (path === "shell/release.json") return new Response(JSON.stringify(manifest))
      return new Response(files.get(path), { status: files.has(path) ? 200 : 404 })
    }
    const latest = await fetchRelease(base)
    assert.equal(latest?.manifest.id, manifest.id)
    assert.equal((await cache.match(`${base}shell/screens/team.html?pronto-release=${firstId}`))?.status, 200)
    assert.equal((await cache.match(`${base}shell/screens/team.html?pronto-release=${manifest.id}`))?.status, 200)
    now += 60 * 60 * 1000 + 1
    const keys = cache.keys
    // A worker can delete a departed client's pin between keys() and match().
    cache.keys = async () => [...await keys(), new Request(`${base}.pronto/release-clients/departed`)]
    await fetchRelease(base)
    assert.equal(await cache.match(`${base}shell/screens/team.html?pronto-release=${firstId}`), undefined)
    assert.equal((await cache.match(`${base}shell/screens/team.html?pronto-release=${manifest.id}`))?.status, 200)
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, "caches", { value: originalCaches, configurable: true })
    activateRelease(null)
  }
})

Deno.test("an in-memory verified release survives a failed check without Cache Storage", async () => {
  const originalFetch = globalThis.fetch
  const originalCaches = globalThis.caches
  const base = new URL("https://example.test/")
  const files = new Map([["shell/shell.json", "{}"]])
  const manifest = await releaseManifest("runtime@one", files)
  try {
    Object.defineProperty(globalThis, "caches", { value: undefined, configurable: true })
    globalThis.fetch = async (request) => {
      const path = new URL(String(request)).pathname.slice(1)
      return path === "shell/release.json" ? new Response(JSON.stringify(manifest)) : new Response(files.get(path))
    }
    const current = await fetchRelease(base)
    globalThis.fetch = async () => { throw new TypeError("offline") }
    assert.equal(await fetchRelease(base, current), current)
    await assert.rejects(() => fetchRelease(base), /offline/)
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, "caches", { value: originalCaches, configurable: true })
  }
})

for (const failure of ["idle body", "refused sibling"]) {
  Deno.test(`release downloads cancel a stalled body and clear timers after ${failure}`, async () => {
    const original = { fetch: globalThis.fetch, caches: globalThis.caches, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
    const base = new URL("https://download.test/")
    const files = new Map([["shell/units/engine.wasm", "bytes"]])
    if (failure === "refused sibling") files.set("shell/bad.js", "script")
    const manifest = await releaseManifest("runtime", files)
    const timers = new Set<number | ReturnType<typeof original.setTimeout>>()
    let aborted = false
    try {
      Object.defineProperty(globalThis, "caches", { value: undefined, configurable: true })
      globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (ms !== 15000) return original.setTimeout(fn, ms, ...args)
        const timer = original.setTimeout(() => {
          timers.delete(timer)
          ;(fn as () => void)()
        }, 10)
        timers.add(timer)
        return timer
      }) as typeof setTimeout
      globalThis.clearTimeout = ((timer?: number | ReturnType<typeof original.setTimeout>) => {
        timers.delete(timer!)
        original.clearTimeout(timer)
      }) as typeof clearTimeout
      globalThis.fetch = async (request, init) => {
        const path = new URL(String(request)).pathname.slice(1)
        if (path === "shell/release.json") return Response.json(manifest)
        if (path === "shell/bad.js") return new Response("missing", { status: 404 })
        const signal = init!.signal!
        const body = new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => {
              aborted = true
              controller.error(signal.reason)
            }, { once: true })
          },
        })
        return new Response(body)
      }
      await assert.rejects(() => fetchRelease(base), failure === "idle body" ? /made no progress/ : /404 fetching release asset/)
      assert.equal(aborted, true)
      assert.equal(timers.size, 0)
    } finally {
      globalThis.fetch = original.fetch
      globalThis.setTimeout = original.setTimeout
      globalThis.clearTimeout = original.clearTimeout
      Object.defineProperty(globalThis, "caches", { value: original.caches, configurable: true })
    }
  })
}
