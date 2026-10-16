import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { recordReads } from "../server/render.ts"
import { carryReads, createStore, readKey, servedReadsScript } from "../interpreter/data-sync.js"
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

  it("answers each of them from the document once, then from the network", async () => {
    await inDocument(async (asked) => {
      const store = createStore("", cfg)
      expect(await store.query("team", null, { filter: "slug=eq.flamengo" })).toEqual(served)
      expect(asked).toEqual([])
      expect(globalThis.document.getElementById("pronto-reads")).toBe(null)
      expect(await store.query("team", null, { filter: "slug=eq.flamengo" })).toEqual([{ id: "t1", name: "network" }])
      expect(asked).toEqual(["/crud/team?select=*&slug=eq.flamengo"])
    })
  })

  // Served reads left unasked by the first screen would otherwise answer a
  // later screen, or a screen after a write, with what the document was drawn
  // from.
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
