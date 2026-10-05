// The service worker revalidates a screen's skeleton and tells every open
// window when it changed, and the shell morphs the live screen to it. A first
// fetch once counted as a change: with several windows opening screens at once
// (check-visual's lanes, a reader with tabs), each window was told to morph to
// the markup it had just mounted, the morph dropped the screen's data-state,
// and the screen sat unsettled for good — shadcnui's visual lint timed out on a
// different handful of routes every run.
//
// The comparison then read the copy it had already answered with, whose body
// the page had consumed by the time the network answered: the clone threw, the
// catch swallowed it, and no change was ever announced or kept.
import { describe, expect, it } from "@test/harness"

const source = await Deno.readTextFile(new URL("../offline-first-sw.js", import.meta.url))

/** The worker's fetch handler over an in-memory cache and a server that answers
 * `served`, or is unreachable while `served` is null. */
function worker(initial: string | null, cacheControl = "public, no-cache") {
  let served = initial
  let status = 200
  let control = cacheControl
  const store = new Map<string, Response>()
  const posted: unknown[] = []
  const handlers: Record<string, (e: unknown) => void> = {}
  const self = {
    location: { origin: "https://app.test" },
    addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] = fn),
    clients: { matchAll: () => Promise.resolve([{ postMessage: (m: unknown) => posted.push(m) }]), claim: () => {} },
    skipWaiting: () => {},
  }
  const caches = {
    open: () =>
      Promise.resolve({
        match: (req: Request) => Promise.resolve(store.get(req.url)?.clone()),
        put: (req: Request, res: Response) => Promise.resolve(void store.set(req.url, res)),
        delete: (req: Request) => Promise.resolve(store.delete(req.url)),
        addAll: () => Promise.resolve(),
      }),
    keys: () => Promise.resolve([]),
  }
  // The network answers after the page has its answer, as it does: the copy
  // the worker answered with is read by then.
  const fetch = () =>
    new Promise<Response>((resolve, reject) =>
      setTimeout(() =>
        served === null
          ? reject(new TypeError("Failed to fetch"))
          : resolve(new Response(served, { status, headers: { "Cache-Control": control } })), 1)
    )
  new Function("self", "caches", "fetch", source)(self, caches, fetch)
  const raw = async (path: string, mode = "cors", cache = "default") => {
    let answer: Promise<Response> | undefined
    // A Request cannot be constructed in navigate mode; the worker reads only
    // these four.
    const req = { method: "GET", url: `https://app.test${path}`, mode, cache }
    handlers.fetch({ request: req, respondWith: (p: Promise<Response>) => (answer = p) })
    return await answer!
  }
  const get = async (path: string, mode = "cors", cache = "default") => {
    const text = await (await raw(path, mode, cache)).text()
    // The revalidation outlives the answer when a cached copy was served.
    await new Promise((r) => setTimeout(r, 10))
    return text
  }
  const serve = (next: string | null, answer = 200, cc = cacheControl) => {
    served = next
    status = answer
    control = cc
  }
  return { get, raw, posted, store, serve }
}

describe("the offline service worker", () => {
  it("does not announce a skeleton it is fetching for the first time", async () => {
    const sw = worker("<section class=\"screen\"></section>")
    expect(await sw.get("/shell/screens/select.html")).toBe("<section class=\"screen\"></section>")
    expect(sw.posted).toEqual([])
    expect(sw.store.has("https://app.test/shell/screens/select.html")).toBe(true)
  })

  it("announces a skeleton that changed since it was cached", async () => {
    const sw = worker("<section class=\"screen\">new</section>")
    sw.store.set("https://app.test/shell/screens/select.html", new Response("<section class=\"screen\">old</section>"))
    expect(await sw.get("/shell/screens/select.html")).toBe("<section class=\"screen\">old</section>")
    expect(sw.posted).toEqual([{
      type: "PRONTO_SKELETON_UPDATED",
      url: "https://app.test/shell/screens/select.html",
      pathname: "/shell/screens/select.html",
      html: "<section class=\"screen\">new</section>",
    }])
  })

  // A navigation went to the network first for a round, so a returning reader
  // waited on the door for a page the worker already held, and offline-first
  // kept only its offline half. The copy paints at once; the rows a document
  // carries are brought current by the shell taking it over
  // (served-adoption.test.ts).
  it("paints a navigation from the copy it keeps and refreshes the copy behind it", async () => {
    const sw = worker("<p>0-0</p>")
    expect(await sw.get("/jogo/1", "navigate")).toBe("<p>0-0</p>")
    sw.serve("<p>2-1</p>")
    expect(await sw.get("/jogo/1", "navigate")).toBe("<p>0-0</p>")
    expect(await sw.get("/jogo/1", "navigate")).toBe("<p>2-1</p>")
  })

  it("answers a navigation from the copy it keeps when the network is gone, and fails one it never kept", async () => {
    const sw = worker("<p>0-0</p>")
    await sw.get("/jogo/1", "navigate")
    sw.serve(null)
    expect(await sw.get("/jogo/1", "navigate")).toBe("<p>0-0</p>")
    await expect(sw.get("/jogo/2", "navigate")).rejects.toThrow("Failed to fetch")
  })

  it("answers a request that revalidates from the network, and from its copy only offline", async () => {
    // The shell asks this way where a document and the worker's copy of its
    // template disagree; the copy answering would downgrade a newer document.
    const sw = worker("<section>new</section>")
    sw.store.set("https://app.test/shell/screens/jogo.html", new Response("<section>old</section>"))
    expect(await sw.get("/shell/screens/jogo.html", "cors", "no-cache")).toBe("<section>new</section>")
    expect(await sw.get("/shell/screens/jogo.html")).toBe("<section>new</section>")
    sw.serve(null)
    expect(await sw.get("/shell/screens/jogo.html", "cors", "no-cache")).toBe("<section>new</section>")
  })

  it("answers a request that revalidates from its copy when the server fails it", async () => {
    // Any answer won, so a door answering 502 mid-deploy failed the boot
    // with a banner while the copy stood ready.
    const sw = worker("<section>old</section>")
    sw.store.set("https://app.test/shell/screens/jogo.html", new Response("<section>old</section>"))
    sw.serve("bad gateway", 502)
    expect(await sw.get("/shell/screens/jogo.html", "cors", "no-cache")).toBe("<section>old</section>")
    expect(await (await sw.raw("/shell/screens/nunca.html", "cors", "no-cache")).status).toBe(502)
  })

  it("keeps a catalogue, so a kept document is taken over offline", async () => {
    // A boot reads its catalogues before its first screen, and they went to
    // the network every time: offline, the boot failed and its banner
    // replaced the document the worker had painted.
    const sw = worker("{\"brand\": \"golaberto\"}")
    await sw.get("/messages/pt-BR.json")
    sw.serve(null)
    expect(await sw.get("/messages/pt-BR.json")).toBe("{\"brand\": \"golaberto\"}")
  })

  it("announces a catalogue that changed since it was cached", async () => {
    // It kept catalogues and announced none of their changes, so a deploy's
    // words reached a reader a page load late, and a document served in them
    // was written back to the older ones as the shell took it over.
    const sw = worker("{\"brand\": \"golaberto 2\"}")
    sw.store.set("https://app.test/messages/pt-BR.json", new Response("{\"brand\": \"golaberto\"}"))
    await sw.get("/messages/pt-BR.json")
    expect(sw.posted).toEqual([{
      type: "PRONTO_MESSAGES_UPDATED",
      url: "https://app.test/messages/pt-BR.json",
      pathname: "/messages/pt-BR.json",
      json: "{\"brand\": \"golaberto 2\"}",
    }])
  })

  it("drops its copy of an address that stops existing", async () => {
    // A game deleted after a visit painted from the copy on every visit after,
    // since no answer but a 200 ever touched it.
    const sw = worker("<p>0-0</p>")
    await sw.get("/jogo/1", "navigate")
    sw.serve("<p>gone</p>", 404)
    expect(await sw.get("/jogo/1", "navigate")).toBe("<p>0-0</p>")
    expect(sw.store.has("https://app.test/jogo/1")).toBe(false)
    expect(await sw.get("/jogo/1", "navigate")).toBe("<p>gone</p>")
  })

  it("drops its copy of an address answered private since", async () => {
    const sw = worker("<p>public</p>")
    await sw.get("/conta", "navigate")
    sw.serve("<p>mine</p>", 200, "private, no-store")
    await sw.get("/conta", "navigate")
    expect(sw.store.has("https://app.test/conta")).toBe(false)
  })

  it("keeps no copy of a navigation answered private", async () => {
    const sw = worker("<p>mine</p>", "private, no-store")
    await sw.get("/conta", "navigate")
    expect(sw.store.has("https://app.test/conta")).toBe(false)
  })
})
