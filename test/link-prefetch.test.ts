import { expect } from "@test/harness"
import { parseHTML } from "linkedom"

const MARKUP = `<section class="screen" data-screen="card">
  <div data-live="session" data-filter="id=eq.session"><template data-item>
    <p data-live="picture" data-filter="id=eq.{card_id}"></p>
  </template></div>
  <div data-live="card" data-filter="deck=eq.{param.id}" data-order="id.asc" data-reads="every_card"></div>
  <div data-live="owed" data-filter="owner=eq.{owner}"></div>
</section>`

type Read = { table: string; order?: string; opts: { filter?: string }; at: string }

async function withLinks(run: (hover: (href: string) => void, linkPrefetch: { seed: (href: string) => Promise<unknown> }, seen: { fetched: string[]; reads: Read[] }, gate: { hold?: Promise<void>; fail?: boolean }) => Promise<void>) {
  const handlers: Record<string, (e: unknown) => void> = {}
  const seen = { fetched: [] as string[], reads: [] as Read[] }
  const gate: { hold?: Promise<void>; fail?: boolean } = {}
  const saved = { location: globalThis.location, document: globalThis.document, fetch: globalThis.fetch, addEventListener: globalThis.addEventListener }
  const { document } = parseHTML("<html><head></head><body></body></html>")
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
  Object.defineProperty(globalThis, "location", { value: new URL("https://app.test/card/1"), configurable: true })
  Object.defineProperty(globalThis, "document", { value: document, configurable: true })
  globalThis.addEventListener = ((type: string, fn: (e: unknown) => void) => { handlers[type] = fn }) as typeof addEventListener
  globalThis.fetch = (async (input: unknown) => {
    seen.fetched.push(String(input))
    return new Response(String(input).endsWith(".html") ? MARKUP : "", { status: 200 })
  }) as typeof fetch
  try {
    const { startLinkPrefetch } = await import("../interpreter/link-prefetch.js")
    const route = { screen: "card", files: { html: "screens/card.html", css: "screens/card.css", handlers: [], adapters: [], shared: [] } }
    const addresses = (url: URL) => {
      const m = url.pathname.match(/^\/(?:pt\/)?card\/(\w+)$/)
      return m === null ? null : { route, params: { id: m[1] } }
    }
    const store = {
      readAhead: async (table: string, order: string | undefined, opts: { filter?: string }, at: string) => {
        seen.reads.push({ table, order, opts, at })
        await gate.hold
        if (gate.fail) throw new Error("the read did not come")
      },
    }
    const linkPrefetch = startLinkPrefetch({ addresses, appBase: "https://app.test/shell/", store })
    const hover = (href: string) => handlers.pointerover({ target: { closest: () => ({ href, target: "", hasAttribute: () => false, getAttribute: () => href }) } })
    await run(hover, linkPrefetch, seen, gate)
  } finally {
    Object.defineProperty(globalThis, "location", { value: saved.location, configurable: true })
    Object.defineProperty(globalThis, "document", { value: saved.document, configurable: true })
    globalThis.fetch = saved.fetch
    globalThis.addEventListener = saved.addEventListener
  }
}

const settled = () => new Promise((r) => setTimeout(r, 0))

// The guard that keeps a language switch from prefetching the page on show
// compared screens alone, so on a card's page a pointer resting on the next
// card's link fetched nothing, and that card's first click waited on the door.
Deno.test("a link to the same screen over another row reads ahead, and one to the page on show does not", async () => {
  await withLinks(async (hover, _linkPrefetch, seen) => {
    hover("https://app.test/pt/card/1")
    hover("https://app.test/card/2")
    await settled()
    expect([...new Set(seen.reads.map((r) => r.at))]).toEqual(["https://app.test/card/2"])
  })
})

// A prefetched document was a render, and a pointer crossing a page of links
// queued a render for each ahead of the click: 8 and 15 second writes in production.
Deno.test("a link reads what its address decides and never asks for its document", async () => {
  await withLinks(async (hover, _linkPrefetch, seen) => {
    hover("https://app.test/card/2")
    await settled()
    expect(seen.fetched.filter((u) => u.includes("/card/"))).toEqual([])
    // A fold's whole-table world and a row-bound region wait for the mount.
    expect(seen.reads.map((r) => [r.table, r.order, r.opts.filter])).toEqual([
      ["session", undefined, "id=eq.session"],
      ["card", "id.asc", "deck=eq.2"],
    ])
  })
})

Deno.test("a navigation joins the reads in flight, and asks once when none ran", async () => {
  await withLinks(async (hover, linkPrefetch, seen, gate) => {
    let release!: () => void
    gate.hold = new Promise((r) => { release = r })
    hover("https://app.test/card/2")
    await settled()
    const asked = seen.reads.length
    let joined = false
    const joining = linkPrefetch.seed("https://app.test/card/2").then(() => { joined = true })
    await settled()
    expect(joined).toBe(false)
    release()
    await joining
    expect(seen.reads.length).toBe(asked)
    gate.hold = undefined
    await linkPrefetch.seed("https://app.test/card/3")
    expect(seen.reads.some((r) => r.at === "https://app.test/card/3")).toBe(true)
  })
})

Deno.test("a read that did not come leaves the screen to ask", async () => {
  await withLinks(async (_hover, linkPrefetch, _seen, gate) => {
    gate.fail = true
    await linkPrefetch.seed("https://app.test/card/2")
  })
})
