import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { interpretScreen } from "../interpreter/screen.js"

// The navigation stack holds a screen the user left: its DOM stays put and its
// subscriptions stop, so the shape closes on schedule and coming back repaints
// before it refreshes. Both halves have to be true — a pause that kept the
// subscription would defeat the shape budget, and one that dropped the DOM
// would defeat the point.
const SCREEN_HTML = `<section class="screen" data-screen="wall">
  <ul class="cards" data-live="note" data-order="position.asc">
    <template data-item><li><span data-text="{title}"></span></li></template>
  </ul>
</section>`

const ROUTE = {
  screen: "wall",
  files: { html: "shell/screens/wall.html", css: "shell/screens/wall.css", handlers: [] },
  states: ["loading", "empty", "populated"],
}

const tick = () => new Promise((r) => setTimeout(r, 5))
const row = (id: string, title: string) => ({ id, title, position: 1 })

async function boot(initial: any[]) {
  const { document } = parseHTML(
    "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
  )
  globalThis.document = document as any
  globalThis.fetch = ((url: any) => {
    const u = String(url)
    if (u.endsWith(".html")) return Promise.resolve(new Response(SCREEN_HTML))
    if (u.endsWith(".css")) return Promise.resolve(new Response(""))
    return Promise.reject(new Error(`unexpected fetch ${u}`))
  }) as any

  let rows = initial
  // A faithful store: an unsubscribed region stops being called at all, which
  // is the whole mechanism under test. Holding the callback directly would
  // make every pause look like it worked.
  const subs = new Set<any>()
  const store = {
    query: async () => rows,
    subscribe: (_t: string, fn: any) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    create: async () => {},
    update: async () => {},
    remove: async () => {},
  }
  const mount = document.getElementById("shell")
  const handle = await interpretScreen(mount, "http://localhost/", ROUTE, store, {}, { handlers: false })
  return {
    handle,
    subscribers: () => subs.size,
    items: () => [...document.querySelectorAll("li")],
    titles: () => [...document.querySelectorAll("li span")].map((e: any) => e.textContent),
    async push(next: any[]) {
      rows = next
      for (const fn of [...subs]) await fn()
      await tick()
    },
  }
}

describe("screen lifecycle", () => {
  it("holds one subscription per live region while shown", async () => {
    const app = await boot([row("a", "Alpha")])
    expect(app.subscribers()).toBe(1)
  })

  it("lets go of the subscription on pause but keeps the rendered DOM", async () => {
    const app = await boot([row("a", "Alpha"), row("b", "Beta")])
    const before = app.items()

    app.handle.pause()

    expect(app.subscribers()).toBe(0)
    // The whole point of holding the screen: it is still painted.
    expect(app.items().length).toBe(2)
    expect(app.items()[0]).toBe(before[0])
  })

  it("goes deaf while paused", async () => {
    const app = await boot([row("a", "Alpha")])
    app.handle.pause()
    await app.push([row("a", "Alpha"), row("b", "Beta")])
    expect(app.titles()).toEqual(["Alpha"])
  })

  it("resubscribes and catches up on resume, reusing the held nodes", async () => {
    const app = await boot([row("a", "Alpha")])
    const [a] = app.items()
    app.handle.pause()

    await app.handle.resume()

    expect(app.subscribers()).toBe(1)
    // Resume refreshes, so a change made while paused lands on return.
    await app.push([row("a", "Alpha"), row("b", "Beta")])
    expect(app.titles()).toEqual(["Alpha", "Beta"])
    expect(app.items()[0]).toBe(a)
  })

  it("does not stack subscriptions when paused or resumed twice", async () => {
    const app = await boot([row("a", "Alpha")])
    app.handle.pause()
    app.handle.pause()
    expect(app.subscribers()).toBe(0)
    await app.handle.resume()
    await app.handle.resume()
    expect(app.subscribers()).toBe(1)
  })

  it("drops the subscription for good on stop", async () => {
    const app = await boot([row("a", "Alpha")])
    app.handle.stop()
    expect(app.subscribers()).toBe(0)
  })
})
