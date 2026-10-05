import { strict as assert } from "node:assert"
import { fetchRelease, prepareRestartRelease, startupReleaseId } from "../interpreter/release-assets.js"
import { releaseManifest } from "./release-fixture.ts"

Deno.test("a complete release prepares an offline restart without navigating before commit", async () => {
  const original = {
    fetch: globalThis.fetch, caches: globalThis.caches, navigator: globalThis.navigator,
    location: globalThis.location, setTimeout: globalThis.setTimeout,
  }
  const base = new URL("https://app.test/")
  const files = new Map([
    ["shell/index.html", '<script src="./boot.js" type="module"></script>'],
    ["shell/boot.js", 'import "/omnishell/interpreter/shell.js";'],
    ["omnishell/interpreter/shell.js", "export const ready = true;"],
  ])
  const manifest = await releaseManifest("runtime@one", files)
  const stores = new Map<string, Map<string, Response>>()
  const caches = { async open(name: string) {
    let stored = stores.get(name)
    if (!stored) stores.set(name, stored = new Map())
    const key = (request: string | Request) => typeof request === "string" ? request : request.url
    return {
      async match(request: string | Request) { return stored.get(key(request))?.clone() },
      async put(request: string, response: Response) { stored.set(request, response.clone()) },
      async keys() { return [...stored.keys()].map(url => new Request(url)) },
      async delete(request: Request) { return stored.delete(request.url) },
    }
  } }
  let navigated: string | null = null
  let updates = 0
  const current = { postMessage(message: { type: string }, ports: MessagePort[]) {
    ports[0].postMessage(message.type === "PRONTO_RELEASE_CLIENT" ? { id: manifest.id } : { ready: true })
    ports[0].close()
  } }
  const serviceWorker = {
    controller: current,
    ready: Promise.resolve({ async update() { updates++ } }),
  }
  try {
    Object.defineProperty(globalThis, "caches", { value: caches, configurable: true })
    Object.defineProperty(globalThis, "navigator", { value: { serviceWorker }, configurable: true })
    Object.defineProperty(globalThis, "location", { value: {
      href: "https://app.test/edit?lang=pt", replace(url: string) { navigated = url },
    }, configurable: true })
    globalThis.fetch = async request => {
      const path = new URL(String(request)).pathname.slice(1)
      return new Response(path === "shell/release.json" ? JSON.stringify(manifest) : files.get(path))
    }
    const release = await fetchRelease(base)
    assert.ok(release)
    globalThis.fetch = async () => { throw new Error("offline restart must use verified bytes") }
    assert.equal(await startupReleaseId(), manifest.id)
    const commit = await prepareRestartRelease(base, release)
    assert.equal(navigated, null)
    assert.equal(updates, 0)
    commit()
    assert.equal(navigated, `https://app.test/edit?lang=pt&pronto-release=${manifest.id}`)

    // An old controller cannot pin a document. Upgrade once before permitting
    // navigation, and fail rather than enter a reload loop if it stays old.
    navigated = null
    serviceWorker.controller = { postMessage() {} }
    serviceWorker.ready = Promise.resolve({ async update() { updates++; serviceWorker.controller = current } })
    globalThis.setTimeout = ((fn: TimerHandler) => original.setTimeout(fn, 25)) as typeof setTimeout
    await prepareRestartRelease(base, release)
    assert.equal(updates, 1)
    assert.equal(navigated, null)
    serviceWorker.controller = { postMessage() {} }
    serviceWorker.ready = Promise.resolve({ async update() { updates++ } })
    await assert.rejects(() => prepareRestartRelease(base, release), /did not answer release request/)
    assert.equal(updates, 2)
    assert.equal(navigated, null)

    const verified = await caches.open("pronto-verified-releases-v1")
    await verified.delete(new Request(`${base}omnishell/interpreter/shell.js?pronto-release=${manifest.id}`))
    await assert.rejects(() => prepareRestartRelease(base, release), /incomplete cached release/)
    assert.equal(navigated, null)
  } finally {
    for (const [name, value] of Object.entries(original)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
})
