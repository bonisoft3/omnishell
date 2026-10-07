import { describe, expect, it } from "@test/harness"
import { admittedOrigin, createRenderer, inhabit, keepGuest, serve, warmEagerTables } from "../server/render.ts"
import { createStore } from "../interpreter/data-sync.js"
import { FIXTURE_CARRIERS } from "../interpreter/fixture-types.js"

// The server terminal's cache, held to its contract with a store that only
// records and wakes: a document stands until a read that drew it moves, a
// document is per address and spelled after the deployment's origin,
// nothing that names no row is kept,
// and the interpreter's one ambient document is never shared by two renders.

type Sub = { table: string; fn: () => void; opts: unknown; live: boolean }

function fakeStore() {
  const subs: Sub[] = []
  return {
    subs,
    store: {
      subscribe(table: string, fn: () => void, opts?: unknown) {
        const sub = { table, fn, opts, live: true }
        subs.push(sub)
        return () => {
          sub.live = false
        }
      },
      query: async () => [],
    },
    /** The store waking every live subscription to `table`. */
    change(table: string) {
      for (const s of subs.filter((s) => s.live && s.table === table)) s.fn()
    },
  }
}

const ORIGIN = "https://gol.example"

/** What routeAt answers: the :id from the path, and every query key folded in
 * beside it. */
const route = (pathname: string, search: string) => {
  const id = pathname.match(/^\/jogo\/([^/]+)$/)?.[1]
  if (id === undefined) return null
  return {
    route: { screen: "jogo", path: "/jogo/:id" },
    params: { ...Object.fromEntries(new URLSearchParams(search)), id },
  }
}

type Render = { params: Record<string, unknown>; store: ReturnType<typeof fakeStore>["store"]; base: URL }

function harness({
  gone = false,
  reads = [{ table: "game_card", opts: { filter: "id=eq.1" } }],
  queue = 8,
  cacheableRead = (_table: string): boolean => true,
  // What the render does once it has read and before it lets go, as the
  // region's own pass would.
  during = async (_r: Render) => {},
  // What the render does after letting go, before it answers.
  after = async (_r: Render) => {},
} = {}) {
  const fake = fakeStore()
  let renders = 0
  let inFlight = 0
  let overlapped = false
  const renderer = createRenderer({
    store: fake.store,
    origin: ORIGIN,
    capacity: 2,
    queue,
    cacheableRead,
    route,
    async render(found, store, base) {
      renders++
      inFlight++
      if (inFlight > 1) overlapped = true
      try {
        // A region subscribes while it renders and lets go once it is
        // stopped, which a render that throws still is (document.js).
        const stops = reads.map((r) => store.subscribe(r.table, () => {}, r.opts))
        const r = { params: found.params, store: fake.store, base }
        try {
          await new Promise((r) => setTimeout(r, 5))
          await during(r)
        } finally {
          for (const stop of stops) stop()
        }
        await after(r)
        return { html: `<p>${base.href} id=${found.params.id} #${renders}</p>`, gone }
      } finally {
        inFlight--
      }
    },
  })
  const get = (path: string, host = "localhost:8443", headers: Record<string, string> = {}) =>
    renderer.handle(new Request(`http://render:8090${path}`, {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": host, ...headers },
    }))
  const live = () => fake.subs.filter((s) => s.live)
  return { renderer, fake, get, live, renders: () => renders, overlapped: () => overlapped }
}

describe("the server terminal", () => {
  it("becomes warm without querying archive snapshots or request-only rows", async () => {
    const queried: string[] = []
    let finish!: () => void
    const eager = new Promise<void>(resolve => { finish = resolve })
    let ready = false
    const warming = warmEagerTables({ query: async (table) => {
      queried.push(table as string)
      await eager
      return []
    } }, {
      tables: ["settings", "team_rating", "player_game"],
      sync: { team_rating: "on-demand" },
      schema: { player_game: { durability: "server" } },
    }).then(() => { ready = true })
    await Promise.resolve()
    expect(queried).toEqual(["settings"])
    expect(ready).toBe(false)
    finish()
    await warming
    expect(ready).toBe(true)
  })

  it("propagates eager startup failures", async () => {
    await expect(warmEagerTables({ query: async () => { throw new Error("shape refused") } }, {
      tables: ["settings"],
    })).rejects.toThrow("shape refused")
  })

  for (const subscribed of [true, false]) {
    it(`reads changed server rows on the next request for a ${subscribed ? "region" : "named read"}`, async () => {
      const fake = fakeStore()
      let name = "before"
      let renders = 0
      const renderer = createRenderer({
        store: { ...fake.store, query: async () => [{ name }] },
        origin: ORIGIN,
        capacity: 2,
        queue: 8,
        route,
        cacheableRead: table => table !== "player",
        async render(_found, store) {
          renders++
          const stop = subscribed ? store.subscribe("player", () => {}) : () => {}
          try {
            const rows = await store.query("player", null, { filter: "id=eq.1" })
            return { html: JSON.stringify(rows), gone: false }
          } finally { stop() }
        },
      })
      const first = await renderer.handle(new Request(`${ORIGIN}/jogo/1`))
      expect(await first.text()).toContain("before")
      name = "after"
      const second = await renderer.handle(new Request(`${ORIGIN}/jogo/1`, { headers: { "if-none-match": first.headers.get("etag")! } }))
      expect(second.status).toBe(200)
      expect(await second.text()).toContain("after")
      expect(renders).toBe(2)
      expect(renderer.held).toBe(0)
      expect(fake.subs.filter(s => s.live)).toHaveLength(0)
    })
  }

  it("shares an in-flight request-only document without retaining it afterward", async () => {
    const h = harness({ cacheableRead: () => false })
    const pages = await Promise.all([h.get("/jogo/1"), h.get("/jogo/1")].map(async r => (await r).text()))
    expect(pages[0]).toBe(pages[1])
    expect(h.renders()).toBe(1)
    expect(h.renderer.held).toBe(0)
    await h.get("/jogo/1")
    expect(h.renders()).toBe(2)
    expect(h.live()).toHaveLength(0)
  })

  it("holds a document until a read that drew it changes", async () => {
    const h = harness()
    const first = await (await h.get("/jogo/1")).text()
    expect(await (await h.get("/jogo/1")).text()).toBe(first)
    expect(h.renders()).toBe(1)
    h.fake.change("game_card")
    await h.get("/jogo/1")
    expect(h.renders()).toBe(2)
  })

  it("keeps a document a change elsewhere does not touch", async () => {
    const h = harness()
    await h.get("/jogo/1")
    h.fake.change("comment")
    await h.get("/jogo/1")
    expect(h.renders()).toBe(1)
  })

  it("listens to each read as the render read it, so the store decides what touches it", async () => {
    // An embed's table, a filter's rows: the store's own wake already answers
    // which changes move a read, and only the read as stated lets it.
    const opts = { filter: "game_id=eq.1", select: "*,player(name)" }
    const h = harness({ reads: [{ table: "goal", opts }] })
    await h.get("/jogo/1")
    const held = h.live()
    expect(held.length).toBe(1)
    expect(held[0].table).toBe("goal")
    expect(held[0].opts).toBe(opts)
  })

  it("answers an address naming no row 404, and does not keep it", async () => {
    const h = harness({ gone: true })
    expect((await h.get("/jogo/1")).status).toBe(404)
    expect((await h.get("/jogo/1")).status).toBe(404)
    expect(h.renders()).toBe(2)
    expect(h.live().length).toBe(0)
  })

  it("answers an address naming no route 404 without rendering", async () => {
    const h = harness()
    expect((await h.get("/nowhere")).status).toBe(404)
    expect(h.renders()).toBe(0)
  })

  it("spells every answer after the deployment's origin, whatever Host it was asked under", async () => {
    // The origin was the Host's: the door answers any Host, so a client wrote
    // the origin of the canonical, the alternates and og:url into a document
    // anyone may keep — and as a string replacement, `$'` in a Host copied the
    // rest of the held document in per occurrence (a 2 KB Host answered a 30 KB
    // document with 300 MB). Before that, a stream of made-up Hosts was a
    // render and an eviction each.
    const h = harness()
    const hosts = ["localhost:8443", "evil.example", "a.example\"><script>", "a@b.example", "a.example/x", "$'$'.example", "x$&y.example"]
    const answers = await Promise.all(hosts.map((host) => h.get("/jogo/1", host)))
    const pages = await Promise.all(answers.map((r) => r.text()))
    for (const [i, page] of pages.entries()) {
      expect(answers[i].status).toBe(200)
      expect(page).toContain(`${ORIGIN}/jogo/1`)
      for (const host of hosts) expect(page).not.toContain(host)
    }
    expect(new Set(pages).size).toBe(1)
    expect(new Set(answers.map((r) => r.headers.get("etag"))).size).toBe(1)
    expect(h.renders()).toBe(1)
    expect(h.renderer.held).toBe(1)
  })

  it("answers every spelling of a query its screen does not read with one document", async () => {
    // Keyed on the whole query, each `?n=` was a render of its own and a
    // document held beside the real one, so a loop of junk queries evicted
    // every document readers had asked for.
    const h = harness()
    const plain = await (await h.get("/jogo/1")).text()
    for (const n of [1, 2, 3]) expect(await (await h.get(`/jogo/1?n=${n}`)).text()).toBe(plain)
    expect(h.renders()).toBe(1)
    expect(h.renderer.held).toBe(1)
  })

  it("keeps one document per value of a query key its screen reads", async () => {
    const h = harness({ during: async ({ params }) => void params.tab })
    await h.get("/jogo/1?tab=a&n=1")
    await h.get("/jogo/1?tab=a")
    const a = await (await h.get("/jogo/1?n=2&tab=a")).text()
    const b = await (await h.get("/jogo/1?tab=b")).text()
    expect(a).toContain("?tab=a")
    expect(b).toContain("?tab=b")
    // The first render could not yet know `n` is never read, so its document,
    // whose address carries it, is answered and not held.
    expect(h.renders()).toBe(3)
  })

  it("keeps one document per value of a query key its screen read where the address had none", async () => {
    // The keys a screen reads were learnt only from the address its first
    // render was asked at: a key it read and that address lacked was never
    // noted, so `?tab=b` was answered with the document drawn without it.
    const h = harness({ during: async ({ params }) => void params.tab })
    await h.get("/jogo/1")
    const b = await (await h.get("/jogo/1?tab=b")).text()
    expect(b).toContain("?tab=b")
    expect(h.renders()).toBe(2)
  })

  it("answers 503 rather than queueing renders past its bound", async () => {
    const h = harness({ queue: 2 })
    const statuses = await Promise.all([1, 2, 3, 4].map((id) => h.get(`/jogo/${id}`).then((r) => r.status)))
    expect(statuses).toEqual([200, 200, 503, 503])
    expect(h.renders()).toBe(2)
  })

  it("renders an address asked for again while it renders once", async () => {
    // Each miss rendered on its own and held over the last, whose listeners
    // nothing could stop any more: three readers at once left three sets
    // standing for one document.
    const h = harness()
    const pages = await Promise.all([h.get("/jogo/1"), h.get("/jogo/1"), h.get("/jogo/1")].map((p) => p.then((r) => r.text())))
    expect(new Set(pages).size).toBe(1)
    expect(h.renders()).toBe(1)
    expect(h.live().length).toBe(h.renderer.held)
  })

  it("does not hold a document a read moved under while it rendered", async () => {
    const h = harness({ during: async () => h.fake.change("game_card") })
    await h.get("/jogo/1")
    expect(h.renderer.held).toBe(0)
    expect(h.live().length).toBe(0)
  })

  it("drops a document a read moved under between the render letting go and the hold", async () => {
    // The held document once listened only after its render had let go and
    // its etag was taken: a change landing in that gap woke nobody, and the
    // document stood with the old rows until some later change.
    const h = harness({
      after: async () => {
        setTimeout(() => h.fake.change("game_card"), 0)
        await new Promise((r) => setTimeout(r, 0))
      },
    })
    await h.get("/jogo/1")
    await h.get("/jogo/1")
    expect(h.renders()).toBe(2)
  })

  it("lets go of a render's reads when the render throws", async () => {
    const h = harness({
      during: async () => {
        throw new Error("a region refused")
      },
    })
    await expect(h.get("/jogo/1")).rejects.toThrow("a region refused")
    expect(h.live().length).toBe(0)
  })

  it("renders one document at a time", async () => {
    const h = harness()
    await Promise.all([h.get("/jogo/1"), h.get("/jogo/2"), h.get("/jogo/3")])
    expect(h.renders()).toBe(3)
    expect(h.overlapped()).toBe(false)
  })

  it("lets go of the documents used longest ago, and of their reads", async () => {
    const h = harness()
    await h.get("/jogo/1")
    await h.get("/jogo/2")
    await h.get("/jogo/3")
    expect(h.renderer.held).toBe(2)
    expect(h.live().length).toBe(2)
  })

  it("says it may be kept by anyone and served by no one unasked, and answers a revalidation", async () => {
    const h = harness()
    const res = await h.get("/jogo/1")
    expect(res.headers.get("cache-control")).toBe("public, no-cache")
    const etag = res.headers.get("etag")!
    expect((await h.get("/jogo/1", "evil.example", { "if-none-match": etag })).status).toBe(304)
  })
})

describe("the server terminal's origin", () => {
  it("is the one ORIGIN states, exactly an origin", () => {
    expect(admittedOrigin("https://gol.example")).toBe("https://gol.example")
    expect(admittedOrigin("http://localhost:8443")).toBe("http://localhost:8443")
    for (const bad of [undefined, "", "gol.example", "https://gol.example/", "https://gol.example/x", "ftp://gol.example", "https://a@gol.example", "HTTPS://gol.example"]) {
      expect(() => admittedOrigin(bad)).toThrow("ORIGIN")
    }
  })

  it("ends the renderer at start where none is set, before it reads the door", async () => {
    // A guess at start was a Host: whatever a client sent was spelled into
    // every document. The door named here answers nothing, so only the
    // missing ORIGIN can be what ended it.
    const env: Record<string, string> = { DOOR: "http://127.0.0.1:9", ENTRY: "/nowhere" }
    await expect(serve((name) => env[name])).rejects.toThrow("ORIGIN names no origin")
  })
})

describe("the server terminal's guest", () => {
  const tokenFor = (exp: number) => `h.${btoa(JSON.stringify({ exp })).replace(/=+$/, "")}.s`

  it("is minted again once half its token's life is gone", async () => {
    // A guest minted once at start expired a week later; every shape mint was
    // refused from then on, the streams stopped without a word, and the held
    // documents stood frozen behind a healthy /health.
    const now = Math.floor(Date.now() / 1000)
    let minted = 0
    const kept: string[] = []
    const scheduled: { fn: () => void; ms: number }[] = []
    await keepGuest(
      async () => ({ token: tokenFor(now + 7 * 24 * 3600 + minted++) }),
      (g) => kept.push(g.token),
      (err) => {
        throw err
      },
      (fn, ms) => scheduled.push({ fn, ms }),
    )
    expect(kept.length).toBe(1)
    expect(scheduled.length).toBe(1)
    expect(Math.abs(scheduled[0].ms - 3.5 * 24 * 3600 * 1000)).toBeLessThan(5000)
    scheduled[0].fn()
    await new Promise((r) => setTimeout(r, 0))
    expect(kept.length).toBe(2)
    expect(kept[1]).not.toBe(kept[0])
  })

  it("ends the renderer when a renewal is refused", async () => {
    let calls = 0
    const scheduled: (() => void)[] = []
    let died: unknown
    await keepGuest(
      async () => {
        if (calls++ > 0) throw new Error("503 minting a guest")
        return { token: tokenFor(Math.floor(Date.now() / 1000) + 60) }
      },
      () => {},
      (err) => (died = err),
      (fn) => scheduled.push(fn),
    )
    scheduled[0]()
    await new Promise((r) => setTimeout(r, 0))
    expect(String(died)).toContain("503 minting a guest")
  })
})

describe("the server terminal's store", () => {
  it("ends the renderer when the door refuses its token", async () => {
    // A refused token was dropped and the read thrown: every render after
    // went out with no token and answered 500, while held documents stood
    // frozen behind a healthy /health until the next renewal. The world is
    // the one the renderer installs, so a location without its reload fails
    // here as it did there, with every read throwing past a healthy /health.
    const names = ["location", "document", "CSS", "requestAnimationFrame", "fetch"] as const
    const global = globalThis as unknown as Record<string, unknown>
    const ambient = names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)] as const)
    let died: unknown
    try {
      inhabit("http://caddy:8080", (err) => (died = err))
      global.fetch = () => Promise.resolve(new Response("", { status: 401 }))
      sessionStorage.setItem("pronto-token", JSON.stringify({ token: "refused" }))
      const read = createStore("http://caddy:8080", { tables: [], carriers: FIXTURE_CARRIERS }).query("game", null, {})
      await new Promise((r) => setTimeout(r, 0))
      expect(String(died)).toContain("refused")
      expect(await Promise.race([read.then(() => "answered", () => "threw"), new Promise((r) => setTimeout(() => r("pending"), 10))])).toBe("pending")
    } finally {
      for (const [n, d] of ambient) {
        if (d === undefined) delete global[n]
        else Object.defineProperty(globalThis, n, d)
      }
      sessionStorage.removeItem("pronto-token")
    }
  })
})
