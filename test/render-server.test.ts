import { describe, expect, it } from "@test/harness"
import { admittedOrigin, boundedFetch, createRenderer, inhabit, serve, warmEagerTables } from "../server/render.ts"
import { createStore } from "../interpreter/data-sync.js"
import { FIXTURE_CARRIERS } from "../interpreter/fixture-types.js"
import { until, withBrowser } from "../interpreter/smoke-browser.js"

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
    route: { screen: "jogo", path: "/jogo/:id", ssr: "ssr" },
    params: { ...Object.fromEntries(new URLSearchParams(search)), id },
  }
}

type Render = { params: Record<string, unknown>; store: ReturnType<typeof fakeStore>["store"]; base: URL }

function harness({
  gone = false,
  reads = [{ table: "game_card", opts: { filter: "id=eq.1" } }],
  queue = 8,
  retain = true,
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
    retain,
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
  it("development renders again without a data change and forbids response caching", async () => {
    const h = harness({ retain: false, reads: [] })
    const first = await h.get("/jogo/1")
    await first.text()
    const second = await h.get("/jogo/1")
    await second.text()
    expect(second.headers.get("Cache-Control")).toBe("no-store")
    expect(h.renderer.held).toBe(0)
    expect(h.renders()).toBe(2)
  })

  it("refuses matched non-public or non-SSR routes before rendering or caching", async () => {
    const fake = fakeStore()
    let renders = 0
    const routes: Record<string, { screen: string; path: string; ssr?: string; access?: string }> = {
      "/match/1": { screen: "match", path: "/match/:id", ssr: "ssr" },
      "/match/1/edit": { screen: "editor", path: "/match/:id/edit", ssr: "spa", access: "private" },
      "/match/1/score/edit": { screen: "score", path: "/match/:id/score/edit", ssr: "spa" },
      "/private": { screen: "private", path: "/private", ssr: "ssr", access: "private" },
      "/static": { screen: "static", path: "/static", ssr: "ssg" },
      "/default": { screen: "default", path: "/default" },
    }
    const renderer = createRenderer({ store: fake.store, origin: ORIGIN, capacity: 2, queue: 8,
      route: path => routes[path] ? { route: routes[path], params: {} } : null,
      render: async () => { renders++; return { html: 'public', gone: false } },
    })
    for (const path of Object.keys(routes).filter(path => path !== '/match/1')) {
      expect((await renderer.handle(new Request(ORIGIN + path))).status).toBe(404)
    }
    expect(renders).toBe(0)
    expect(renderer.held).toBe(0)
    expect((await renderer.handle(new Request(ORIGIN + '/match/1'))).status).toBe(200)
    expect(renders).toBe(1)
    const protectedApp = createRenderer({ store: fake.store, origin: ORIGIN, capacity: 2, queue: 8,
      authRequired: true,
      route: () => ({ route: routes['/match/1'], params: {} }),
      render: async () => { throw new Error('a signed-in app must not render publicly') },
    })
    expect((await protectedApp.handle(new Request(ORIGIN + '/match/1'))).status).toBe(404)
  })

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
      read: { team_rating: "lazy" },
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

describe("the renderer's reads through its door", () => {
  // A door that never answered held the render, and the request behind it,
  // until whatever proxied the render gave up on both.
  it("give up on a door that never answers", async () => {
    const hung: typeof globalThis.fetch = (_input, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))
    await expect(boundedFetch(hung, 20)("http://door/crud/team")).rejects.toThrow()
  })

  it("still give up when the caller does, on a Request's own signal too", async () => {
    const hung: typeof globalThis.fetch = (_input, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))
    const caller = new AbortController()
    const read = boundedFetch(hung, 60_000)(new Request("http://door/crud/team", { signal: caller.signal }))
    caller.abort(new Error("the caller left"))
    await expect(read).rejects.toThrow("the caller left")
  })

  it("end the renderer at start where no bound is set", async () => {
    const env: Record<string, string> = { DOOR: "http://127.0.0.1:9", ENTRY: "/nowhere", ORIGIN: "https://gol.example" }
    await expect(serve((name) => env[name])).rejects.toThrow("DOOR_TIMEOUT_MS")
  })
})

describe("the server terminal's store", () => {
  for (const [firstStatus, name] of [
    [200, "refreshes a refused guest through the Dapr door and retries the reads"],
    [401, "ends the renderer when its refresh token is refused"],
    [503, "keeps its guest through a temporary auth outage"],
  ] as const) {
    it(name, async () => {
      const names = ["location", "document", "CSS", "requestAnimationFrame", "fetch"] as const
      const global = globalThis as unknown as Record<string, unknown>
      const ambient = names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)] as const)
      const door = "http://localhost:3500/v1.0/invoke/caddy/method"
      let died: unknown
      let refreshes = 0
      const reads: string[] = []
      const guest = { id: "guest-id", guest: true }
      try {
        inhabit(door, (err) => (died = err))
        global.fetch = (input: string, init: RequestInit) => {
          if (input === `${door}/auth/refresh`) {
            refreshes++
            expect(init.method).toBe("POST")
            expect(JSON.parse(String(init.body))).toEqual({ refresh_token: "refresh-old" })
            const status = refreshes === 1 ? firstStatus : 200
            return Promise.resolve(status === 200
              ? Response.json({ token: "renewed", refresh_token: "refresh-new", user: guest })
              : new Response("", { status }))
          }
          expect(input.startsWith(`${door}/crud/`)).toBe(true)
          const auth = new Headers(init.headers).get("authorization") ?? ""
          reads.push(auth)
          return Promise.resolve(auth === "Bearer renewed" ? Response.json([{ id: "1" }]) : new Response("", { status: 401 }))
        }
        localStorage.setItem("pronto-token", JSON.stringify({ token: "refused", refresh_token: "refresh-old", user: guest }))
        const store = createStore(door, { tables: [], carriers: FIXTURE_CARRIERS, keepReads: false }, { refreshUrl: `${door}/auth/refresh` })
        const read = store.query("game", null, {})
        if (firstStatus === 200) {
          expect(await Promise.all([read, store.query("team", null, {})])).toEqual([[{ id: "1" }], [{ id: "1" }]])
          expect(reads.filter((auth) => auth === "Bearer refused").length).toBe(2)
          expect(reads.filter((auth) => auth === "Bearer renewed").length).toBe(2)
          expect(died).toBe(undefined)
          expect(JSON.parse(localStorage.getItem("pronto-token")!)).toEqual({
            token: "renewed", refresh_token: "refresh-new", user: guest,
          })
        } else if (firstStatus === 503) {
          await expect(read).rejects.toThrow("503")
          expect(died).toBe(undefined)
          expect(JSON.parse(localStorage.getItem("pronto-token")!).refresh_token).toBe("refresh-old")
          expect(await store.query("game", null, {})).toEqual([{ id: "1" }])
        } else {
          // The real reload exits. The stub records it while the old read waits.
          expect(await Promise.race([read.then(() => "answered"), new Promise((r) => setTimeout(() => r("pending"), 10))])).toBe("pending")
          expect(String(died)).toContain("refused")
        }
        expect(refreshes).toBe(firstStatus === 503 ? 2 : 1)
      } finally {
        for (const [n, d] of ambient) {
          if (d === undefined) delete global[n]
          else Object.defineProperty(globalThis, n, d)
        }
        localStorage.removeItem("pronto-token")
      }
    })
  }
})

Deno.test({
  name: "a public Electric subscription keeps receiving rows after the renderer guest expires",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const door = "http://localhost:3500/v1.0/invoke/caddy/method"
    const guest = { id: "renderer", guest: true }
    let refreshes = 0
    let offset = 0
    let expired = false
    const cfg = {
      tables: ["game"], carriers: FIXTURE_CARRIERS,
      access: { game: { scope: "public" } },
      schema: { game: { durability: "live", fields: [{ name: "id", type: "string" }] } },
    }
    const online = Object.getOwnPropertyDescriptor(navigator, "onLine")
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true })
    try {
      await withBrowser({
        storage: { "pronto-token": { token: "initial", refresh_token: "refresh-old", user: guest } },
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input))
          if (url.href === `${door}/auth/refresh`) {
            refreshes++
            expect(JSON.parse(String(init?.body)).refresh_token).toBe("refresh-old")
            if (refreshes === 1) return new Response(null, { status: 503 })
            return Response.json({ token: "renewed", refresh_token: "refresh-new", user: guest })
          }
          expect(url.origin + url.pathname).toBe(`${door}/electric/v1/shape`)
          const bearer = new Headers(init?.headers).get("authorization")
          if (expired && bearer === "Bearer initial") return new Response(null, { status: 401 })
          expect(bearer).toBe(expired ? "Bearer renewed" : "Bearer initial")
          if (offset > 0) await new Promise((resolve) => setTimeout(resolve, 10))
          const id = String(++offset)
          return Response.json([
            { key: `"public"."game"/"${id}"`, value: { id }, headers: { operation: "insert", relation: ["public", "game"] } },
            { headers: { control: "up-to-date", global_last_seen_lsn: id } },
          ], { headers: {
            "electric-handle": "games", "electric-offset": `0_${id}`, "electric-cursor": id,
            "electric-schema": JSON.stringify({ id: { type: "text" } }),
          } })
        },
      }, async (makeStore: typeof createStore) => {
        const store = makeStore(door, cfg, { refreshUrl: `${door}/auth/refresh` })
        let updates = 0
        const stop = store.subscribe("game", () => { updates++ }, {})
        try {
          expect((await store.query("game", null, {})).some((row: { id: string }) => row.id === "1")).toBe(true)
          expired = true
          const before = updates
          await until(() => refreshes === 2 && updates > before, "the public stream received another batch")
          expect(JSON.parse(localStorage.getItem("pronto-token")!)).toEqual({
            token: "renewed", refresh_token: "refresh-new", user: guest,
          })
          expect((await store.query("game", null, {})).length).toBeGreaterThan(1)
        } finally {
          stop()
          await store.close()
        }
      })
    } finally {
      if (online) Object.defineProperty(navigator, "onLine", online)
      else delete (navigator as unknown as { onLine?: boolean }).onLine
    }
  },
})
