import { expect } from "@test/harness"

// The guard that keeps a language switch from prefetching the page on show
// compared screens alone, so on a card's page a pointer resting on the next
// card's link fetched nothing, and that card's first click waited on the door.
Deno.test("a link to the same screen over another row is prefetched, and one to the page on show is not", async () => {
  const handlers: Record<string, (e: unknown) => void> = {}
  const asked: string[] = []
  const saved = { location: globalThis.location, document: globalThis.document, fetch: globalThis.fetch, addEventListener: globalThis.addEventListener }
  Object.defineProperty(globalThis, "location", { value: new URL("https://app.test/card/1"), configurable: true })
  Object.defineProperty(globalThis, "document", { value: { visibilityState: "visible", getElementById: () => ({}) }, configurable: true })
  globalThis.addEventListener = ((type: string, fn: (e: unknown) => void) => { handlers[type] = fn }) as typeof addEventListener
  globalThis.fetch = (async (input: unknown) => {
    asked.push(String(input))
    return new Response("<html></html>", { status: 200 })
  }) as typeof fetch
  try {
    const { startLinkPrefetch } = await import("../interpreter/link-prefetch.js")
    const route = { screen: "card", ssr: "ssr", files: { html: "screens/card.html", css: "screens/card.css", handlers: [], adapters: [], shared: [] } }
    const addresses = (url: URL) => {
      const m = url.pathname.match(/^\/(?:pt\/)?card\/(\w+)$/)
      return m === null ? null : { route, params: { id: m[1] } }
    }
    startLinkPrefetch({ addresses, appBase: "https://app.test/shell/", store: { seedReads: () => {} }, servedReadsOf: () => [] })
    const hover = (href: string) => handlers.pointerover({ target: { closest: () => ({ href, target: "", hasAttribute: () => false, getAttribute: () => href }) } })
    hover("https://app.test/pt/card/1")
    hover("https://app.test/card/2")
    await new Promise((r) => setTimeout(r, 0))
    const documents = asked.filter((u) => u.includes("/card/"))
    expect(documents).toEqual(["https://app.test/card/2"])
  } finally {
    Object.defineProperty(globalThis, "location", { value: saved.location, configurable: true })
    Object.defineProperty(globalThis, "document", { value: saved.document, configurable: true })
    globalThis.fetch = saved.fetch
    globalThis.addEventListener = saved.addEventListener
  }
})

// Navigating to an unvisited SSR route while its hover/pointerdown prefetch is
// still in flight (or after speculation answered 204) must await or ask the
// SSR document once before mounting the screen, rather than racing a multi-RTT
// /crud waterfall against it.
Deno.test("navigation seed joins an in-flight prefetch and retries without Purpose: prefetch after a 204", async () => {
  const handlers: Record<string, (e: unknown) => void> = {}
  const asked: { url: string; purpose: string | null }[] = []
  const seeded: { reads: unknown; opts: unknown }[] = []
  const saved = { location: globalThis.location, document: globalThis.document, fetch: globalThis.fetch, addEventListener: globalThis.addEventListener }
  Object.defineProperty(globalThis, "location", { value: new URL("https://app.test/card/1"), configurable: true })
  Object.defineProperty(globalThis, "document", { value: { visibilityState: "visible", getElementById: () => ({}) }, configurable: true })
  globalThis.addEventListener = ((type: string, fn: (e: unknown) => void) => { handlers[type] = fn }) as typeof addEventListener
  let releaseCard2!: () => void
  const card2Gate = new Promise<void>((r) => { releaseCard2 = r })
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    if (url.includes("/card/")) asked.push({ url, purpose: headers.get("Purpose") })
    if (url.endsWith("/card/2")) {
      await card2Gate
      return new Response("card-2-html", { status: 200, headers: { "x-edge-cache": "hit" } })
    }
    if (url.endsWith("/card/3") && headers.get("Purpose") === "prefetch") {
      return new Response(null, { status: 204 })
    }
    if (url.endsWith("/card/3")) {
      return new Response("card-3-html", { status: 200, headers: { "x-edge-cache": "stale" } })
    }
    return new Response("", { status: 200 })
  }) as typeof fetch
  try {
    const { startLinkPrefetch } = await import("../interpreter/link-prefetch.js")
    const route = { screen: "card", ssr: "ssr", files: { html: "screens/card.html", css: "screens/card.css", handlers: [], adapters: [], shared: [] } }
    const addresses = (url: URL) => {
      const m = url.pathname.match(/^\/card\/(\w+)$/)
      return m === null ? null : { route, params: { id: m[1] } }
    }
    const linkPrefetch = startLinkPrefetch({
      addresses,
      appBase: "https://app.test/shell/",
      store: { seedReads: (reads: unknown, opts: unknown) => seeded.push({ reads, opts }) },
      servedReadsOf: (html: string) => html,
    })
    const down = (href: string) => handlers.pointerdown({ target: { closest: () => ({ href, target: "", hasAttribute: () => false, getAttribute: () => href }) } })

    down("https://app.test/card/2")
    const joined = linkPrefetch.seed("https://app.test/card/2")
    releaseCard2()
    await joined
    expect(asked).toEqual([{ url: "https://app.test/card/2", purpose: "prefetch" }])
    expect(seeded).toEqual([{ reads: "card-2-html", opts: { at: "https://app.test/card/2" } }])

    down("https://app.test/card/3")
    await linkPrefetch.seed("https://app.test/card/3")
    expect(asked.slice(1)).toEqual([
      { url: "https://app.test/card/3", purpose: "prefetch" },
      { url: "https://app.test/card/3", purpose: null },
    ])
    expect(seeded).toEqual([
      { reads: "card-2-html", opts: { at: "https://app.test/card/2" } },
      { reads: "card-3-html", opts: undefined },
    ])
  } finally {
    Object.defineProperty(globalThis, "location", { value: saved.location, configurable: true })
    Object.defineProperty(globalThis, "document", { value: saved.document, configurable: true })
    globalThis.fetch = saved.fetch
    globalThis.addEventListener = saved.addEventListener
  }
})

Deno.test("streaming prefetch seeds progressive read comments across chunk boundaries and swallows mid-stream failures", async () => {
  const handlers: Record<string, (e: unknown) => void> = {}
  const seeded: { reads: Map<string, string>; opts: unknown }[] = []
  const saved = { location: globalThis.location, document: globalThis.document, fetch: globalThis.fetch, addEventListener: globalThis.addEventListener }
  Object.defineProperty(globalThis, "location", { value: new URL("https://app.test/card/1"), configurable: true })
  Object.defineProperty(globalThis, "document", { value: { visibilityState: "visible", getElementById: () => ({}) }, configurable: true })
  globalThis.addEventListener = ((type: string, fn: (e: unknown) => void) => { handlers[type] = fn }) as typeof addEventListener
  const encoder = new TextEncoder()
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url.endsWith("/card/2")) {
      const part1 = '<!doctype html><html><body><!--pronto-read:{"/crud/card?id=eq.2":'
      const part2 = '"[{\\"id\\":\\"2\\"}]"}--><script type="application/json" id="pronto-reads">{"/crud/card?id=eq.2":"[{\\"id\\":\\"2\\"}]"}</script></body></html>'
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(part1))
          controller.enqueue(encoder.encode(part2))
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { "x-edge-cache": "miss" } })
    }
    if (url.endsWith("/card/broken")) {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("stream reset"))
        },
      })
      return new Response(body, { status: 200, headers: { "x-edge-cache": "miss" } })
    }
    return new Response("", { status: 200 })
  }) as typeof fetch
  try {
    const { startLinkPrefetch } = await import("../interpreter/link-prefetch.js")
    const { servedReadsOf, takeProgressiveReads } = await import("../interpreter/data-sync.js")
    const route = { screen: "card", ssr: "ssr", files: { html: "screens/card.html", css: "screens/card.css", handlers: [], adapters: [], shared: [] } }
    const addresses = (url: URL) => {
      const m = url.pathname.match(/^\/card\/(\w+)$/)
      return m === null ? null : { route, params: { id: m[1] } }
    }
    const linkPrefetch = startLinkPrefetch({
      addresses,
      appBase: "https://app.test/shell/",
      store: { seedReads: (reads: Map<string, string>, opts: unknown) => seeded.push({ reads, opts }) },
      servedReadsOf,
      takeProgressiveReads,
    })
    await linkPrefetch.seed("https://app.test/card/2")
    expect(seeded.length).toBe(2)
    expect([...seeded[0].reads.entries()]).toEqual([["/crud/card?id=eq.2", '[{"id":"2"}]']])
    expect(seeded[0].opts).toEqual({ at: "https://app.test/card/2" })
    expect([...seeded[1].reads.entries()]).toEqual([["/crud/card?id=eq.2", '[{"id":"2"}]']])

    const down = (href: string) => handlers.pointerdown({ target: { closest: () => ({ href, target: "", hasAttribute: () => false, getAttribute: () => href }) } })
    down("https://app.test/card/broken")
    await new Promise((r) => setTimeout(r, 10))
    expect(seeded.length).toBe(2)

    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('<!doctype html><html><body><!--pronto-read:not-json--></body></html>'))
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { "x-edge-cache": "miss" } })
    }) as typeof fetch
    let threw = false
    try {
      await linkPrefetch.seed("https://app.test/card/malformed")
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  } finally {
    Object.defineProperty(globalThis, "location", { value: saved.location, configurable: true })
    Object.defineProperty(globalThis, "document", { value: saved.document, configurable: true })
    globalThis.fetch = saved.fetch
    globalThis.addEventListener = saved.addEventListener
  }
})
