import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { recordReads } from "../server/render.ts"
import { carryReads, createStore, http, readKey, servedReadsOf, servedReadsScript } from "../interpreter/data-sync.js"
import { FIXTURE_CARRIERS } from "../interpreter/fixture-types.js"

// A server-rendered document's first paint asked the door again for every
// request-only read the renderer had just made: golaberto's team page drew
// itself from 47 /crud reads, and the shell taking it over made all 47 again.
// The document now carries them, and the shell answers each from it once.

const DOOR = "http://caddy:8080"

describe("the reads a render makes", () => {
  it("are the bodies of its successful /crud GETs, and nothing of how it asked", async () => {
    const asked: string[] = []
    const reads = recordReads(DOOR, async (input, init) => {
      asked.push(`${init?.method ?? "GET"} ${input}`)
      const url = String(input)
      if (url.includes("/missing")) return new Response("[]", { status: 404 })
      return new Response(JSON.stringify([{ url, authorization: "none of it" }]), { status: 200 })
    }, (url) => readKey(url))
    await reads.fetch(`${DOOR}/crud/before?select=*`)
    reads.start()
    await reads.fetch(`${DOOR}/crud/team?select=*&slug=eq.flamengo`, { headers: { Authorization: "Bearer guest-token" } })
    await reads.fetch(`${DOOR}/crud/team`, { method: "POST", body: "{}" })
    await reads.fetch(`${DOOR}/crud/missing`)
    await reads.fetch(`${DOOR}/auth/guest`)
    await reads.fetch(`${DOOR}/electric/v1/shape?table=team`)
    const made = await reads.stop()
    await reads.fetch(`${DOOR}/crud/after`)
    expect([...made.keys()]).toEqual(["/crud/team?select=*&slug=eq.flamengo"])
    expect(asked.length).toBe(7)
    const html = carryReads("<!doctype html><html><body><main></main></body></html>", made, servedReadsScript)
    expect(html).not.toContain("guest-token")
    expect(html).not.toContain("Bearer")
  })

  it("survive the parser whatever their rows hold", () => {
    const body = JSON.stringify([{ name: "</script><script>alert(1)</script>", note: "a b" }])
    const html = carryReads("<!doctype html><html><body><main></main></body></html>", new Map([["/crud/team", body]]), servedReadsScript)
    const { document } = parseHTML(html)
    expect(document.querySelectorAll("script").length).toBe(1)
    expect(JSON.parse(JSON.parse(document.getElementById("pronto-reads")!.textContent!)["/crud/team"])).toEqual(JSON.parse(body))
  })
})

describe("a document's reads, from its text", () => {
  // A link prefetch parsed the document it fetched, a Trusted Types sink the
  // apps' policy refuses, so every prefetch failed at its parse and seeded
  // nothing; the reads are one script element of a known shape.
  it("are what carryReads wrote, whatever their rows hold", () => {
    const reads = new Map([["/crud/team?select=*", JSON.stringify([{ name: "</script><b>" }])], ["/crud/game", "[]"]])
    const html = carryReads("<!doctype html><html><body><main></main></body></html>", reads, servedReadsScript)
    expect(servedReadsOf(html)).toEqual(reads)
    expect(servedReadsOf("<!doctype html><html><body></body></html>")).toEqual(new Map())
  })
})

describe("a document carrying its reads", () => {
  const cfg = { tables: [], carriers: FIXTURE_CARRIERS, schema: { team: { durability: "server" } }, mintedGuest: true }
  const read = "/crud/team?select=*&slug=eq.flamengo"
  const served = [{ id: "t1", name: "served" }]

  async function inDocument(fn: (asked: string[]) => Promise<void>, signedIn = false) {
    const global = globalThis as unknown as Record<string, unknown>
    const ambient = ["document", "location", "fetch"].map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)] as const)
    const asked: string[] = []
    try {
      const html = carryReads("<!doctype html><html><body><main></main></body></html>", new Map([[read, JSON.stringify(served)]]), servedReadsScript)
      global.document = parseHTML(html).document
      global.location = new URL("https://gol.example/equipe/flamengo")
      global.fetch = async (input: RequestInfo | URL) => {
        asked.push(String(input))
        return new Response(JSON.stringify([{ id: "t1", name: "network" }]), { status: 200 })
      }
      sessionStorage.setItem("pronto-token", JSON.stringify({ token: "t", user: signedIn ? { id: "u1" } : { id: "g1", guest: true } }))
      await fn(asked)
    } finally {
      for (const [n, d] of ambient) {
        if (d === undefined) delete global[n]
        else Object.defineProperty(globalThis, n, d)
      }
      sessionStorage.removeItem("pronto-token")
    }
  }

  // A screen drawn again waited out its request-only reads every time, and
  // drew itself empty until they landed: the tab now answers them from what it
  // last read, at once, and refreshes behind.
  it("answers each of them from the document once, then from the tab while one request refreshes them", async () => {
    await inDocument(async (asked) => {
      const store = createStore("", cfg)
      expect(await store.query("team", null, { filter: "slug=eq.flamengo" })).toEqual(served)
      expect(asked).toEqual([])
      expect(globalThis.document.getElementById("pronto-reads")).toBe(null)
      expect(await store.query("team", null, { filter: "slug=eq.flamengo" })).toEqual(served)
      await new Promise((r) => setTimeout(r, 0))
      expect(asked).toEqual(["/crud/team?select=*&slug=eq.flamengo"])
      expect(await store.query("team", null, { filter: "slug=eq.flamengo" })).toEqual([{ id: "t1", name: "network" }])
    })
  })

  // Served reads left unasked by the first screen would otherwise answer a
  // later screen, or a screen after a write, with what the document was drawn
  // from.
  // A read the tab answers from what it held is current only once its
  // refresh lands: the readers have to hear when that brought other rows.
  it("wakes its readers when the refresh brings other rows", async () => {
    await inDocument(async () => {
      const store = createStore("", cfg)
      expect(await store.query("team", null, { filter: "slug=eq.flamengo" })).toEqual(served)
      let woken = 0
      const stop = store.subscribe("team", () => { woken++ }, { filter: "slug=eq.flamengo" })
      expect(await store.query("team", null, { filter: "slug=eq.flamengo" })).toEqual(served)
      await new Promise((r) => setTimeout(r, 50))
      expect(woken).toBeGreaterThan(0)
      expect(await store.query("team", null, { filter: "slug=eq.flamengo" })).toEqual([{ id: "t1", name: "network" }])
      stop()
    })
  })

  // What the tab read is what a later read shows first; after this tab's own
  // write it would show the rows from before it.
  it("asks the network, not the tab, after a write to the table it read", async () => {
    await inDocument(async (asked) => {
      const store = createStore("", cfg)
      expect(await store.query("team", null, { filter: "slug=eq.flamengo" })).toEqual(served)
      await store.add("team", [{ id: "t1", name: "network" }])
      const writes = asked.length
      expect(await store.query("team", null, { filter: "slug=eq.flamengo" })).toEqual([{ id: "t1", name: "network" }])
      expect(asked.slice(writes)).toEqual([read])
    })
  })

  // A read in flight while this tab's write settles brings back rows from
  // before it; kept, they would answer the read the write woke.
  it("keeps nothing a read brought back across this tab's own write", async () => {
    await inDocument(async () => {
      const store = createStore("", cfg)
      const network = globalThis.fetch
      let release!: () => void
      const held = new Promise<void>((r) => { release = r })
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET" && String(input).includes("slug=eq.santos") && !written) {
          await held
          return new Response(JSON.stringify([{ id: "t1", name: "before the write" }]), { status: 200 })
        }
        return network(input, init)
      }) as typeof fetch
      let written = false
      const before = store.query("team", null, { filter: "slug=eq.santos" })
      await store.add("team", [{ id: "t1", name: "network" }])
      written = true
      release()
      expect(await before).toEqual([{ id: "t1", name: "before the write" }])
      expect(await store.query("team", null, { filter: "slug=eq.santos" })).toEqual([{ id: "t1", name: "network" }])
    })
  })

  // A first click drew its screen empty until its reads came back; the
  // document the link was prefetched as carries them.
  it("answers a read a prefetched document carried, for the guest the page minted", async () => {
    await inDocument(async (asked) => {
      const store = createStore("", cfg)
      store.seedReads(new Map([["/crud/team?select=*&slug=eq.palmeiras", JSON.stringify([{ id: "t2", name: "prefetched" }])]]))
      expect(await store.query("team", null, { filter: "slug=eq.palmeiras" })).toEqual([{ id: "t2", name: "prefetched" }])
      // Answered from the document; what asks the door is the refresh behind.
      expect(asked).toEqual(["/crud/team?select=*&slug=eq.palmeiras"])
    })
  })

  it("takes nothing a prefetched document carried for a reader signed in", async () => {
    await inDocument(async () => {
      const store = createStore("", cfg)
      store.seedReads(new Map([["/crud/team?select=*&slug=eq.palmeiras", JSON.stringify([{ id: "t2", name: "prefetched" }])]]))
      expect(await store.query("team", null, { filter: "slug=eq.palmeiras" })).toEqual([{ id: "t1", name: "network" }])
    }, true)
  })

  // A reduce or a lookup acts once on what it is given and holds no
  // subscription a refresh could correct it through.
  it("asks the network for a read stated current, whatever the tab holds", async () => {
    await inDocument(async (asked) => {
      const store = createStore("", cfg)
      store.seedReads(new Map([["/crud/team?select=*&slug=eq.palmeiras", JSON.stringify([{ id: "t2", name: "prefetched" }])]]))
      expect(await store.query("team", null, { filter: "slug=eq.palmeiras", current: true })).toEqual([{ id: "t1", name: "network" }])
      expect(asked).toEqual(["/crud/team?select=*&slug=eq.palmeiras"])
    })
  })

  // search() writes a query as the program states it and a carried read is
  // recorded URL-serialized: a non-ASCII value spelled the two apart.
  it("answers a carried read whatever spelling of its address the click asks by", async () => {
    await inDocument(async () => {
      const store = createStore("", cfg)
      store.seedReads(new Map([["/crud/team?select=*&city=eq.S%C3%A3o%20Paulo", JSON.stringify([{ id: "t3", name: "prefetched" }])]]))
      expect(await store.query("team", null, { filter: "city=eq.São Paulo" })).toEqual([{ id: "t3", name: "prefetched" }])
    })
  })

  it("asks the network once the shell has moved to another address", async () => {
    await inDocument(async (asked) => {
      const store = createStore("", cfg)
      await store.query("team", null, { filter: "slug=eq.other" })
      globalThis.location = new URL("https://gol.example/equipe/flamengo?lang=pt-BR") as unknown as Location
      expect(await store.query("team", null, { filter: "slug=eq.flamengo" })).toEqual([{ id: "t1", name: "network" }])
    })
  })

  it("asks the network after a write", async () => {
    await inDocument(async (asked) => {
      const store = createStore("", cfg)
      await store.query("team", null, { filter: "slug=eq.other" })
      await store.upload("crest", new Blob(["png"]))
      expect(await store.query("team", null, { filter: "slug=eq.flamengo" })).toEqual([{ id: "t1", name: "network" }])
      expect(asked.at(-1)).toBe(read)
    })
  })

  it("asks the network for a guest the page did not mint, who may own rows", async () => {
    await inDocument(async (asked) => {
      const store = createStore("", { ...cfg, mintedGuest: false })
      expect(await store.query("team", null, { filter: "slug=eq.flamengo" })).toEqual([{ id: "t1", name: "network" }])
      expect(asked.length).toBe(1)
    })
  })

  it("asks the network for a reader signed in, who may read more than a guest", async () => {
    await inDocument(async (asked) => {
      const store = createStore("", cfg)
      expect(await store.query("team", null, { filter: "slug=eq.flamengo" })).toEqual([{ id: "t1", name: "network" }])
      expect(asked.length).toBe(1)
    }, true)
  })

  // Regression: a 401 forgot the token after the guest was minted, and every
  // subscribe then waited on the settled session and subscribed again, on the
  // microtask queue, until the page ran out of heap ("Aw, Snap").
  it("refuses a subscribe once the session settled without a token, rather than waiting on it again", async () => {
    await inDocument(async () => {
      sessionStorage.removeItem("pronto-token")
      const settled = Promise.resolve({ token: "t", user: { id: "g1", guest: true } })
      const refused = new Promise<unknown>((resolve) => {
        globalThis.addEventListener("unhandledrejection", (event) => { event.preventDefault(); resolve(event.reason) }, { once: true })
      })
      const store = createStore("", {
        tables: ["team"],
        carriers: FIXTURE_CARRIERS,
        read: { team: "lazy" as const },
        schema: { team: { durability: "live", fields: [{ name: "id", type: "string" }, { name: "slug", type: "string" }, { name: "name", type: "string" }] } },
        mintedGuest: true,
        ensureSession: () => settled,
      })
      const unsub = store.subscribe("team", () => {}, { filter: "slug=eq.flamengo" })
      try {
        expect(String(await refused)).toContain("the session settled without a token")
      } finally {
        unsub()
        await store.close()
      }
    })
  })

  // A row security refusal comes back as a 401 too; taking it for an expired
  // session forgot the token and reloaded the page for one refused write.
  it("fails a write refused by row security without forgetting the session", async () => {
    await inDocument(async () => {
      let reloaded = false
      Object.defineProperty(globalThis, "location", { value: Object.assign(new URL("https://gol.example/"), { reload: () => { reloaded = true } }), configurable: true })
      globalThis.fetch = async () => new Response(JSON.stringify({ code: "42501", message: "new row violates row-level security policy" }), { status: 401 })
      await expect(http("/crud/team", { method: "POST", body: "{}" })).rejects.toThrow("401 POST /crud/team")
      expect(reloaded).toBe(false)
      expect(sessionStorage.getItem("pronto-token")).not.toBe(null)
    })
  })

  // Regression: createMechaClient used bare fetch for /auth/shape and /crud/*,
  // so a live-durability table hitting a 401 from an invalidated session token
  // threw NonRetriableError instead of clearing pronto-token and reloading.
  it("forgets the session and reloads when a live-durability shape mint returns a session 401", async () => {
    await inDocument(async () => {
      let reloaded = false
      Object.defineProperty(globalThis, "location", { value: Object.assign(new URL("https://gol.example/"), { reload: () => { reloaded = true } }), configurable: true })
      globalThis.fetch = async () => new Response(JSON.stringify({ error: "invalid token" }), { status: 401 })
      const store = createStore("", {
        tables: ["team"],
        carriers: FIXTURE_CARRIERS,
        schema: { team: { durability: "live", fields: [{ name: "id", type: "string" }] } },
      })
      const unsub = store.subscribe("team", () => {})
      try {
        for (let i = 0; i < 20 && !reloaded; i++) await new Promise((r) => setTimeout(r, 5))
        expect(reloaded).toBe(true)
        expect(sessionStorage.getItem("pronto-token")).toBe(null)
      } finally {
        unsub()
        await store.close()
      }
    })
  })

  it("answers a live-durability table from #pronto-reads while guest minting is still in flight", async () => {
    await inDocument(async (asked) => {
      sessionStorage.removeItem("pronto-token")
      let settleGuest!: () => void
      const guestSession = new Promise<{ token: string; user: { id: string; guest: boolean } }>((resolve) => {
        settleGuest = () => {
          const s = { token: "t", user: { id: "g1", guest: true } }
          sessionStorage.setItem("pronto-token", JSON.stringify(s))
          resolve(s)
        }
      })
      const liveCfg = {
        tables: ["team"],
        carriers: FIXTURE_CARRIERS,
        read: { team: "lazy" as const },
        schema: { team: { durability: "live", fields: [{ name: "id", type: "string" }, { name: "slug", type: "string" }, { name: "name", type: "string" }] } },
        mintedGuest: true,
        ensureSession: () => guestSession,
      }
      const store = createStore("", liveCfg)
      const unsub = store.subscribe("team", () => {}, { filter: "slug=eq.flamengo" })
      try {
        expect(await store.query("team", null, { filter: "slug=eq.flamengo" })).toEqual(served)
        expect(asked).toEqual([])
        expect(sessionStorage.getItem("pronto-token")).toBe(null)
      } finally {
        unsub()
        settleGuest()
        await store.close()
      }
    })
  })
})
