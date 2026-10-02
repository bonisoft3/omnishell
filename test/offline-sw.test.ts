// The service worker revalidates a screen's skeleton and tells every open
// window when it changed, and the shell morphs the live screen to it. A first
// fetch once counted as a change: with several windows opening screens at once
// (check-visual's lanes, a reader with tabs), each window was told to morph to
// the markup it had just mounted, the morph dropped the screen's data-state,
// and the screen sat unsettled for good — shadcnui's visual lint timed out on a
// different handful of routes every run.
import { describe, expect, it } from "@test/harness"

const source = await Deno.readTextFile(new URL("../offline-first-sw.js", import.meta.url))

/** The worker's fetch handler over an in-memory cache and a server that answers `served`. */
function worker(served: string) {
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
        addAll: () => Promise.resolve(),
      }),
    keys: () => Promise.resolve([]),
  }
  const fetch = () => Promise.resolve(new Response(served))
  new Function("self", "caches", "fetch", source)(self, caches, fetch)
  const get = async (path: string) => {
    let answer: Promise<Response> | undefined
    const req = new Request(`https://app.test${path}`)
    handlers.fetch({ request: req, respondWith: (p: Promise<Response>) => (answer = p) })
    const res = await answer!
    // The revalidation outlives the answer when a cached copy was served.
    await new Promise((r) => setTimeout(r, 0))
    return res.text()
  }
  return { get, posted, store }
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
})
