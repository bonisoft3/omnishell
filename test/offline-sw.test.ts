// The worker answers an address from its copy forever and a navigation from
// the entry it kept, revalidated behind it; it touches nothing else
// (offline-first-sw.js). A release is its entry, so a kept entry is a whole
// earlier release and every file it names is an address.
import { describe, expect, it } from "@test/harness"

const source = await Deno.readTextFile(new URL("../offline-first-sw.js", import.meta.url))

/** The worker's fetch handler over an in-memory cache and a server that answers
 * `served`, or is unreachable while `served` is null. */
function worker(initial: string | null, cacheControl = "public, no-cache") {
  let served = initial
  let status = 200
  let control = cacheControl
  let rejectCacheWrites = false
  const store = new Map<string, Response>()
  const lifetime: Promise<unknown>[] = []
  const key = (req: Request | string) => typeof req === "string" ? new URL(req, self.location.origin).href : req.url
  const handlers: Record<string, (e: unknown) => void> = {}
  const self = {
    location: { origin: "https://app.test" },
    addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] = fn),
    clients: { claim: () => {} },
    skipWaiting: () => {},
  }
  const caches = {
    open: () =>
      Promise.resolve({
        match: (req: Request) => Promise.resolve(store.get(key(req))?.clone()),
        put: (req: Request, res: Response) => rejectCacheWrites
          ? Promise.reject(new Error("cache full"))
          : Promise.resolve(void store.set(key(req), res)),
        delete: (req: Request) => Promise.resolve(store.delete(key(req))),
        addAll: () => Promise.resolve(),
      }),
    keys: () => Promise.resolve([]),
    delete: (_name: string) => Promise.resolve(void store.clear()),
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
  const raw = async (path: string, mode = "cors", cache = "default"): Promise<Response | undefined> => {
    let answer: Promise<Response> | undefined
    // A Request cannot be constructed in navigate mode; the worker reads only
    // these four.
    const req = { method: "GET", url: `https://app.test${path}`, mode, cache }
    handlers.fetch({ request: req, respondWith: (p: Promise<Response>) => (answer = p),
      waitUntil: (p: Promise<unknown>) => lifetime.push(p) })
    return answer && await answer
  }
  const get = async (path: string, mode = "cors", cache = "default") => {
    const text = await (await raw(path, mode, cache))!.text()
    // The revalidation outlives the answer when a cached copy was served.
    await Promise.all(lifetime.splice(0))
    return text
  }
  const serve = (next: string | null, answer = 200, cc = cacheControl) => {
    served = next
    status = answer
    control = cc
  }
  return { get, raw, store, serve,
    rejectWrites: () => { rejectCacheWrites = true },
    settle: () => Promise.allSettled(lifetime.splice(0)) }
}

describe("the offline service worker", () => {
  const address = "/shell/screens/_immutable-" + "a".repeat(64) + "-jogo.html"
  it("answers an address from its copy forever, whatever the door now serves", async () => {
    const sw = worker("<section>1</section>")
    expect(await sw.get(address)).toBe("<section>1</section>")
    sw.serve("<section>2</section>")
    expect(await sw.get(address)).toBe("<section>1</section>")
    sw.serve(null)
    expect(await sw.get(address)).toBe("<section>1</section>")
  })

  it("keeps no copy of an address the door failed", async () => {
    const sw = worker("bad gateway")
    sw.serve("bad gateway", 502)
    expect(await (await sw.raw(address))!.status).toBe(502)
    sw.serve("<section>1</section>")
    expect(await sw.get(address)).toBe("<section>1</section>")
  })

  it("evicts kept entries when an addressed file returns 404", async () => {
    const sw = worker("cached page")
    await sw.get("/", "navigate")
    expect(sw.store.has("https://app.test/")).toBe(true)
    sw.serve("missing", 404)
    expect(await (await sw.raw(address))!.status).toBe(404)
    await sw.settle()
    expect(sw.store.has("https://app.test/")).toBe(false)
  })

  // Every file a release names is an address; a name that is not one is the
  // door's to answer, current, and never stands in for a release's file.
  it("leaves a file that is no address, and the data plane, to the network", async () => {
    const sw = worker("x")
    expect(await sw.raw("/shell/screens/jogo.html")).toBe(undefined)
    expect(await sw.raw("/crud/team")).toBe(undefined)
  })

  it("returns a successful uncached navigation when Cache Storage cannot retain it", async () => {
    const sw = worker("ready")
    sw.rejectWrites()
    const response = await sw.raw("/", "navigate")
    expect(await response!.text()).toBe("ready")
    expect((await sw.settle())[0].status).toBe("rejected")
  })

  it("drops a navigation made private", async () => {
    const sw = worker("public")
    await sw.get("/conta", "navigate")
    sw.serve("mine", 200, "private, no-store")
    expect(await sw.get("/conta", "navigate")).toBe("public")
    expect(sw.store.has("https://app.test/conta")).toBe(false)
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

  // The reads a server-rendered document carries are current as it arrives
  // (interpreter/data-sync.js): a copy painted later answering its regions from them
  // would draw rows any number of changes old.
  it("keeps its copy of a document without the reads it was served with", async () => {
    const reads = `<script type="application/json" id="pronto-reads">{"/crud/team":"[]"}</script>`
    const sw = worker(`<head></head><body><main>2-1</main>${reads}</body>`)
    expect(await sw.get("/jogo/1", "navigate")).toBe(`<head></head><body><main>2-1</main>${reads}</body>`)
    expect(await sw.get("/jogo/1", "navigate")).toBe(`<head><meta name="pronto-kept"></head><body><main>2-1</main></body>`)
  })

  it("answers a navigation from the copy it keeps when the network is gone, and fails one it never kept", async () => {
    const sw = worker("<p>0-0</p>")
    await sw.get("/jogo/1", "navigate")
    sw.serve(null)
    expect(await sw.get("/jogo/1", "navigate")).toBe("<p>0-0</p>")
    await expect(sw.get("/jogo/2", "navigate")).rejects.toThrow("Failed to fetch")
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
