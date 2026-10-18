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
