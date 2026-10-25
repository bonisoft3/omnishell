import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { recordReads } from "../server/render.ts"
import { carryReads, createStore, http, readKey, servedReadsOf, servedReadsScript } from "../interpreter/data-sync.js"
import { canCoalesceSchemaEq, coalesceReads } from "../interpreter/fragment.js"
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
  const cfg = {
    tables: [],
    carriers: FIXTURE_CARRIERS,
    schema: {
      team: {
        durability: "server",
        fields: [
          { name: "id", type: "string" },
          { name: "slug", type: "string" },
          { name: "name", type: "string" },
          { name: "city", type: "string" },
        ],
      },
    },
    mintedGuest: true,
  }
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
        await new Promise((r) => setTimeout(r, 0))
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

  // Live-durability tables route /auth/shape and /crud/* through the session
  // gate so an invalidated session token clears pronto-token and reloads.
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
        await store.close()
        settleGuest()
        await guestSession
      }
    })
  })

  it("coalesces concurrent single-tick /crud eq reads in the browser while keeping per-item tab answers", async () => {
    await inDocument(async (asked) => {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = String(input)
        asked.push(url)
        return new Response(
          JSON.stringify([
            { id: "t2", slug: "palmeiras", name: "Palmeiras" },
            { id: "t3", slug: "santos", name: "Santos" },
          ]),
          { status: 200 },
        )
      }
      const store = createStore("", cfg)
      const [pal, san] = await Promise.all([
        store.query("team", null, { filter: "slug=eq.palmeiras" }),
        store.query("team", null, { filter: "slug=eq.santos" }),
      ])
      expect(pal).toEqual([{ id: "t2", slug: "palmeiras", name: "Palmeiras" }])
      expect(san).toEqual([{ id: "t3", slug: "santos", name: "Santos" }])
      expect(asked).toEqual(["/crud/team?select=*&slug=in.%28%22palmeiras%22%2C%22santos%22%29"])
      expect(await store.query("team", null, { filter: "slug=eq.palmeiras" })).toEqual(pal)
      await new Promise((r) => setTimeout(r, 0))
    })
  })

  // A screen fold writing a browser-owned (`tab`) table during initial
  // hydration must not clear `#pronto-reads`, and concurrent region + reduce
  // (`current: true`) reads on the served screen must keep their pre-mint
  // reader identity when `POST /auth/guest` settles.
  it("keeps #pronto-reads across local tab writes, concurrent region reads, current reduce reads, and guest token settlement", async () => {
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
      const store = createStore("", {
        tables: [],
        local: { state: "tab" },
        carriers: FIXTURE_CARRIERS,
        schema: {
          team: { durability: "server" },
          state: { durability: "tab", fields: [{ name: "id", type: "string" }] },
        },
        mintedGuest: true,
        ensureSession: () => guestSession,
      })
      try {
        await store.write("state", [{ key: "s1", row: { id: "s1" } }])
        const [a, b, c] = await Promise.all([
          store.query("team", null, { filter: "slug=eq.flamengo" }),
          store.query("team", null, { filter: "slug=eq.flamengo" }),
          store.query("team", null, { filter: "slug=eq.flamengo", current: true }),
        ])
        expect(a).toEqual(served)
        expect(b).toEqual(served)
        expect(c).toEqual(served)
        expect(asked).toEqual([])
        settleGuest()
        await guestSession
        // After the guest token settles, the tab still holds the pre-mint answer
        // under the same reader identity and refreshes it once in the background.
        expect(await store.query("team", null, { filter: "slug=eq.flamengo" })).toEqual(served)
        await new Promise((r) => setTimeout(r, 0))
        expect(asked).toEqual([read])
      } finally {
        await store.close()
      }
    })
  })

  // `subscribeInvalidation`'s initial `offset=now` connection delivers
  // `changes === undefined`; treating that handshake as a mutation wiped
  // `#pronto-reads` and re-fetched every server-routed live region per table.
  it("does not drop #pronto-reads or re-fetch when subscribeInvalidation completes its initial offset=now handshake", async () => {
    await inDocument(async (asked) => {
      let connected!: () => void
      const initialDone = new Promise<void>((r) => { connected = r })
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        asked.push(url)
        if (url.endsWith("/auth/shape")) {
          return new Response(JSON.stringify({ token: "st", table: "team", where: "true", expires_in: 900 }), { status: 200 })
        }
        if (url.includes("/electric/v1/shape")) {
          if (new URL(url).searchParams.get("live") === "true") {
            connected()
            return await new Promise<Response>((_, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
            })
          }
          return new Response(JSON.stringify([{ headers: { control: "up-to-date" } }]), {
            status: 200,
            headers: {
              "electric-handle": "h1",
              "electric-offset": "0_0",
              "electric-schema": JSON.stringify({ id: { type: "text" } }),
              "electric-up-to-date": "true",
            },
          })
        }
        return new Response(JSON.stringify([{ id: "t1", name: "network" }]), { status: 200 })
      }
      const store = createStore("https://gol.example", {
        tables: ["team"],
        carriers: FIXTURE_CARRIERS,
        read: { team: "lazy" as const },
        schema: {
          team: {
            durability: "live",
            fields: [{ name: "id", type: "string" }, { name: "slug", type: "string" }, { name: "name", type: "string" }],
          },
        },
        mintedGuest: true,
      })
      let woken = 0
      // Self-embed without a local FK routes the live read through readServer + subscribeInvalidation without snapshotDemands.
      const serverRead = readKey("/crud/team?select=*,team(*)&slug=eq.flamengo")
      globalThis.document.getElementById("pronto-reads")!.textContent = JSON.stringify({ [serverRead]: JSON.stringify(served) })
      const unsub = store.subscribe("team", () => { woken++ }, { select: "*,team(*)", filter: "slug=eq.flamengo" })
      try {
        await initialDone
        await new Promise((r) => setTimeout(r, 0))
        expect(woken).toBe(1)
        expect(await store.query("team", null, { select: "*,team(*)", filter: "slug=eq.flamengo", current: true })).toEqual(served)
        expect(asked.filter((u) => u.includes("/crud/"))).toEqual([])
      } finally {
        unsub()
        await new Promise((r) => setTimeout(r, 0))
        await store.close()
      }
    })
  })

  // Seeding from a fresh SSR document (`{ at }`) marks the destination URL's
  // reads as `served` without clobbering the current page's `#pronto-reads`,
  // so hovering links on the current page keeps its own served reads while
  // navigating to the prefetched page answers both live-region and
  // `{ current: true }` handler reads without waiting on `/crud` or Electric.
  it("answers both live-region and { current: true } reads from seedReads(..., { at }) without clobbering the active page", async () => {
    await inDocument(async (asked) => {
      const store = createStore("", cfg)
      const nextRead = readKey("/crud/team?select=*&slug=eq.palmeiras")
      const nextServed = [{ id: "t2", name: "Palmeiras" }]
      try {
        store.seedReads(new Map([[nextRead, JSON.stringify(nextServed)]]), { at: "https://gol.example/campeonato/br-2026" })
        // Standing on /equipe/flamengo: hovering /campeonato/br-2026 must not wipe /equipe/flamengo's served reads.
        expect(await store.query("team", null, { select: "*", filter: "slug=eq.flamengo" })).toEqual(served)
        expect(await store.query("team", null, { select: "*", filter: "slug=eq.flamengo", current: true })).toEqual(served)
        expect(asked).toEqual([])
        // Navigating to /campeonato/br-2026 answers its prefetched reads without hitting the network.
        Object.defineProperty(globalThis, "location", { value: new URL("https://gol.example/campeonato/br-2026"), configurable: true })
        expect(await store.query("team", null, { select: "*", filter: "slug=eq.palmeiras" })).toEqual(nextServed)
        expect(await store.query("team", null, { select: "*", filter: "slug=eq.palmeiras", current: true })).toEqual(nextServed)
        await new Promise((r) => setTimeout(r, 0))
        expect(asked).toEqual([])
      } finally {
        await store.close()
        await new Promise((r) => setTimeout(r, 50))
      }
    })
  })

  // Once a lazy live-durability collection loads any subset on an earlier
  // screen, `collection.isReady()` is true; navigating to another screen must
  // still await `waitSeed` for uncached subsets rather than racing Electric,
  // and a rejected `waitSeed` promise must release waiters without an unhandled rejection.
  it("awaits in-flight waitSeed for uncached lazy live-durability subsets even after the collection is ready", async () => {
    await inDocument(async (asked) => {
      const store = createStore("", {
        tables: ["team"],
        carriers: FIXTURE_CARRIERS,
        read: { team: "lazy" as const },
        schema: {
          team: {
            durability: "live",
            fields: [{ name: "id", type: "string" }, { name: "slug", type: "string" }, { name: "name", type: "string" }],
          },
        },
        mintedGuest: true,
      })
      try {
        const col = (globalThis as unknown as { __mechaClient: { collections: Record<string, { isReady: () => boolean }> } }).__mechaClient.collections.team
        col.isReady = () => true
        let finishSeed!: () => void
        const seedPromise = new Promise<void>((r) => { finishSeed = r })
        store.waitSeed(seedPromise)
        Object.defineProperty(globalThis, "location", { value: new URL("https://gol.example/equipe/talleres"), configurable: true })
        const tallRead = readKey("/crud/team?select=*&slug=eq.talleres")
        const pendingQuery = store.query("team", null, { select: "*", filter: "slug=eq.talleres" })
        store.seedReads(new Map([[tallRead, JSON.stringify([{ id: "t9", slug: "talleres", name: "Talleres" }])]]), { at: "https://gol.example/equipe/talleres" })
        finishSeed()
        expect(await pendingQuery).toEqual([{ id: "t9", slug: "talleres", name: "Talleres" }])
        expect(asked.filter((u) => u.includes("/electric/"))).toEqual([])

        // A rejecting waitSeed promise must propagate the seed failure to awaiting queries.
        let rejectSeed!: (err: Error) => void
        store.waitSeed(new Promise<void>((_, rej) => { rejectSeed = rej }))
        Object.defineProperty(globalThis, "location", { value: new URL("https://gol.example/equipe/boca"), configurable: true })
        const failingQuery = store.query("team", null, { select: "*", filter: "slug=eq.boca" })
        rejectSeed(new Error("seed network error"))
        await expect(failingQuery).rejects.toThrow("seed network error")
      } finally {
        await store.close()
        await new Promise((r) => setTimeout(r, 50))
      }
    })
  })

  it("drops the served body for an eager live table when the live collection receives a remote change", async () => {
    await inDocument(async (asked) => {
      const fields = [{ name: "id", type: "string" }, { name: "slug", type: "string" }, { name: "name", type: "string" }]
      const backing = createStore("", {
        tables: [],
        local: { team: "tab" },
        carriers: FIXTURE_CARRIERS,
        schema: { team: { durability: "tab", fields } },
      })
      await backing.write("team", [{ key: "t1", row: { id: "t1", slug: "flamengo", name: "served" } }])
      const backingCol = (globalThis as unknown as { __mechaClient: { collections: Record<string, unknown> } }).__mechaClient.collections.team

      const store = createStore("https://gol.example", {
        tables: ["team"],
        carriers: FIXTURE_CARRIERS,
        schema: { team: { durability: "live", fields } },
        mintedGuest: true,
      })
      ;(globalThis as unknown as { __mechaClient: { collections: Record<string, unknown> } }).__mechaClient.collections.team = backingCol

      const eagerRead = readKey("/crud/team?select=*&slug=eq.flamengo")
      const reduceRead = readKey("/crud/team?select=*")
      globalThis.document.getElementById("pronto-reads")!.textContent = JSON.stringify({
        [eagerRead]: JSON.stringify([{ id: "t1", slug: "flamengo", name: "served" }]),
        [reduceRead]: JSON.stringify([{ id: "t1", slug: "flamengo", name: "served" }]),
      })
      let woken = 0
      let unsub = () => {}
      try {
        expect(await store.query("team", null, { select: "*", filter: "slug=eq.flamengo" })).toEqual([
          { id: "t1", slug: "flamengo", name: "served" },
        ])
        unsub = store.subscribe("team", () => { woken++ }, { select: "*", filter: "slug=eq.flamengo" })
        await new Promise((r) => setTimeout(r, 0))
        expect(woken).toBe(0)

        await backing.write("team", [{ key: "t1", row: { id: "t1", slug: "flamengo", name: "remote-updated" } }])
        await new Promise((r) => setTimeout(r, 10))
        expect(woken).toBe(1)
        const updated = await store.query("team", null, { select: "*", filter: "slug=eq.flamengo" })
        expect(updated.map((r: { id: string; slug: string; name: string }) => ({ id: r.id, slug: r.slug, name: r.name }))).toEqual([
          { id: "t1", slug: "flamengo", name: "remote-updated" },
        ])
        // An unconsumed #pronto-reads entry for a separate reduce data-reads URL is also invalidated by the remote change.
        const allAfterChange = await store.query("team", null, { select: "*", current: true })
        expect(allAfterChange.map((r: { id: string; slug: string; name: string }) => ({ id: r.id, slug: r.slug, name: r.name }))).toEqual([
          { id: "t1", slug: "flamengo", name: "remote-updated" },
        ])
        expect(asked.filter((u) => u.includes("/crud/"))).toEqual([])
      } finally {
        unsub()
        await store.close()
        await backing.close()
      }
    })
  })

  it("consumes a served read at most once across ticks for current: true and isolates re-minted guest sessions", async () => {
    await inDocument(async (asked) => {
      sessionStorage.removeItem("pronto-token")
      const store = createStore("", {
        ...cfg,
        ensureSession: async () => ({ token: "t1", user: { id: "g1", guest: true } }),
      })
      try {
        expect(await store.query("team", null, { filter: "slug=eq.flamengo", current: true })).toEqual(served)
        expect(asked).toEqual([])
        await new Promise((r) => setTimeout(r, 0))
        // A subsequent current: true read on a later tick must ask the network, not the initial served read.
        expect(await store.query("team", null, { filter: "slug=eq.flamengo", current: true })).toEqual([{ id: "t1", name: "network" }])
        expect(asked).toEqual([read])

        // Settling the first guest token keeps the pre-mint reader identity, but a later guest token does not reuse it.
        sessionStorage.setItem("pronto-token", JSON.stringify({ token: "t1", user: { id: "g1", guest: true } }))
        expect(await store.query("team", null, { filter: "slug=eq.flamengo" })).toEqual([{ id: "t1", name: "network" }])
        await new Promise((r) => setTimeout(r, 0))
        const countAfterG1 = asked.length
        sessionStorage.setItem("pronto-token", JSON.stringify({ token: "t2", user: { id: "g2", guest: true } }))
        await store.query("team", null, { filter: "slug=eq.flamengo" })
        expect(asked.length).toBe(countAfterG1 + 1)
      } finally {
        await store.close()
        await new Promise((r) => setTimeout(r, 50))
      }
    })
  })

  it("throws when a coalesced in.(...) read returns a row whose column spelling differs from the eq filter, and restricts schema eq coalescing to declared text and lowercase uuid fields", async () => {
    const coalesced = coalesceReads(async () => [
      { id: "g1", kickoff: "2026-10-22T18:00:00+00:00" },
    ])
    let caught: unknown = null
    try {
      await Promise.all([
        coalesced("/crud/game?select=*&kickoff=eq.2026-10-22T18:00:00Z"),
        coalesced("/crud/game?select=*&kickoff=eq.2026-10-23T18:00:00Z"),
      ])
    } catch (err) {
      caught = err
    }
    expect(caught instanceof Error && /did not match any requested eq filter/.test(caught.message)).toBe(true)

    const pred = canCoalesceSchemaEq(
      {
        game: {
          fields: [
            { name: "id", type: "uuid" },
            { name: "slug", type: "string" },
            { name: "kickoff", type: "timestamptz" },
          ],
        },
        untyped: {},
      },
      FIXTURE_CARRIERS,
    )
    expect(pred("game", "slug", "talleres")).toBe(true)
    expect(pred("game", "id", "11111111-2222-4333-8444-555555555555")).toBe(true)
    expect(pred("game", "id", "11111111-2222-4333-8444-55555555555A")).toBe(false)
    expect(pred("game", "kickoff", "2026-10-22T18:00:00Z")).toBe(false)
    expect(pred("untyped", "slug", "talleres")).toBe(false)
  })

  // Regression: a region bound to a local table (`chair`) with remote synced
  // tables in `data-reads` (`reads: ["team"]`) opened `/auth/shape` for `team`
  // before `POST /auth/guest` settled, getting a 401 that cleared the newly
  // minted token and reloaded the page in a loop.
  it("keeps a local table subscription live during guest minting while deferring remote data-reads shapes until the session settles", async () => {
    await inDocument(async (asked) => {
      sessionStorage.removeItem("pronto-token")
      const shapeAuths: (string | null)[] = []
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        asked.push(url)
        if (url.endsWith("/auth/shape")) {
          const h = new Headers(init?.headers)
          shapeAuths.push(h.get("Authorization"))
          return new Response(JSON.stringify({ token: "st", table: "team", where: "true", expires_in: 900 }), { status: 200 })
        }
        if (url.includes("/electric/v1/shape")) {
          if (new URL(url).searchParams.get("live") === "true") {
            return await new Promise<Response>((_, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
            })
          }
          return new Response(JSON.stringify([{ headers: { control: "up-to-date" } }]), {
            status: 200,
            headers: { "electric-handle": "h1", "electric-offset": "0_0", "electric-schema": "{}" },
          })
        }
        return new Response("[]", { status: 200 })
      }
      let settleGuest!: () => void
      const guestSession = new Promise<{ token: string; user: { id: string; guest: boolean } }>((resolve) => {
        settleGuest = () => {
          const s = { token: "guest-jwt", user: { id: "g1", guest: true } }
          sessionStorage.setItem("pronto-token", JSON.stringify(s))
          resolve(s)
        }
      })
      const store = createStore("", {
        tables: ["team", "chair"],
        local: { chair: "tab" },
        carriers: FIXTURE_CARRIERS,
        schema: {
          team: { durability: "live", fields: [{ name: "id", type: "string" }] },
          chair: { durability: "tab", fields: [{ name: "id", type: "string" }] },
        },
        mintedGuest: true,
        ensureSession: () => guestSession,
      })
      let woken = 0
      const unsub = store.subscribe("chair", () => { woken++ }, { reads: ["team"] })
      try {
        await store.write("chair", [{ key: "c1", row: { id: "c1" } }])
        await new Promise((r) => setTimeout(r, 10))
        expect(woken).toBeGreaterThan(0)
        expect(shapeAuths).toEqual([])
        settleGuest()
        await guestSession
        for (let i = 0; i < 20 && shapeAuths.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
        expect(shapeAuths).toEqual(["Bearer guest-jwt"])
      } finally {
        unsub()
        await store.close()
      }
    })
  })
})
