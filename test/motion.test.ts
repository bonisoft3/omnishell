import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { interpretScreen } from "../interpreter/screen.js"

// The motion slots the terminal's stylesheet is written against. The
// interpreter owns when they are stamped; these pin that timing, because a
// slot released in the same frame it is set animates nothing, and an exit that
// does not wait removes the node before it can play.
const SCREEN_HTML = `<section class="screen" data-screen="wall">
  <ul class="cards" data-live="note" data-order="position.asc" data-empty="Nothing here">
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
  // A read the test can hold open, so a wake can land while a refresh waits.
  let gate: Promise<void> = Promise.resolve()
  const subs = new Set<any>()
  const store = {
    query: async () => {
      await gate
      return rows
    },
    subscribe: (_t: string, fn: any) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    create: async () => {},
    update: async () => {},
    remove: async () => {},
  }
  const mount = document.getElementById("shell")
  await interpretScreen(mount, "http://localhost/", ROUTE, store, {}, { handlers: false })
  return {
    document,
    items: () => [...document.querySelectorAll("li")],
    // Settles the refresh but not the frame callbacks, so a slot can be
    // observed while it is still stamped.
    async render(next: any[]) {
      rows = next
      for (const fn of [...subs]) await fn()
    },
    rows: (next: any[]) => { rows = next },
    gate: (p: Promise<void>) => { gate = p },
    /** One wake, carrying a delta or none, as the store would deliver it. */
    wake: (changes: any) => Promise.all([...subs].map((fn) => fn(changes))),
    tick,
  }
}

describe("motion slots", () => {
  it("does not stamp arrivals on the first paint", async () => {
    const app = await boot([row("a", "Alpha"), row("b", "Beta")])
    for (const li of app.items()) expect(li.hasAttribute("data-enter")).toBe(false)
  })

  it("stamps a row that arrives later, and releases it a frame on", async () => {
    const app = await boot([row("a", "Alpha")])

    await app.render([row("a", "Alpha"), row("b", "Beta")])
    const arrived = app.items()[1]
    expect(arrived.hasAttribute("data-enter")).toBe(true)

    await app.tick()
    expect(arrived.hasAttribute("data-enter")).toBe(false)
  })

  // Motion costs a frame and a style resolution per node, so a pass that moves
  // more rows than a reader can follow plays nothing — the judgement the first
  // paint already makes, applied to every later pass.
  it("stamps a whole gesture of arrivals", async () => {
    const app = await boot([row("a", "Alpha")])
    const many = [row("a", "Alpha"), ...Array.from({ length: 32 }, (_, i) => row(`g${i}`, `G${i}`))]

    await app.render(many)
    expect(app.items().filter((li) => li.hasAttribute("data-enter")).length).toBe(32)
  })

  it("stamps none of a load", async () => {
    const app = await boot([row("a", "Alpha")])
    const many = [row("a", "Alpha"), ...Array.from({ length: 33 }, (_, i) => row(`l${i}`, `L${i}`))]

    await app.render(many)
    expect(app.items().some((li) => li.hasAttribute("data-enter"))).toBe(false)
  })

  it("takes a load away at once, without waiting for motion", async () => {
    const start = Array.from({ length: 33 }, (_, i) => row(`d${i}`, `D${i}`))
    const app = await boot(start)

    await app.render([])
    // A departing gesture stays in the list while it plays; a load does not.
    // What remains is the region's empty message, which is a row of no row.
    expect(app.items().some((li) => li.hasAttribute("data-exit"))).toBe(false)
    expect(app.items().filter((li) => !li.classList.contains("empty")).length).toBe(0)
  })

  // Everything departing at once is the list emptied in one call — unless a
  // gesture's row is still playing its exit, which that call would tear out
  // mid-animation. The load then leaves row by row around it.
  it("keeps a row that is still leaving when the load around it goes", async () => {
    const start = Array.from({ length: 40 }, (_, i) => row(`r${i}`, `R${i}`))
    const app = await boot(start)
    const leaving = app.items()[39]

    await app.render(start.slice(0, 39))
    expect(leaving.hasAttribute("data-exit")).toBe(true)

    await app.render([])
    expect(leaving.isConnected).toBe(true)
    expect(app.items().filter((li) => !li.classList.contains("empty")).length).toBe(1)

    await app.tick()
    expect(leaving.isConnected).toBe(false)
    expect(app.document.querySelector("li.empty")?.textContent).toBe("Nothing here")
  })

  // A wake landing mid-refresh queues a follow-up, which carries the union of
  // what the coalesced wakes named. Carrying only the first wake's delta would
  // leave the rows a later wake named bound to values the pass never read.
  it("carries every queued delta into the follow-up refresh", async () => {
    const app = await boot([row("a", "A1"), row("b", "B1"), row("c", "C1")])
    const texts = () => app.items().map((li) => li.textContent)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    app.gate(gate)
    app.rows([row("a", "A2"), row("b", "B2"), row("c", "C2")])
    // The first wake starts a refresh that waits on the store; the next two
    // land while it is waiting, each naming one row.
    const first = app.wake([{ value: { id: "a" } }])
    const second = app.wake([{ value: { id: "b" } }])
    const third = app.wake([{ value: { id: "c" } }])
    release()
    await Promise.all([first, second, third])
    expect(texts()).toEqual(["A2", "B2", "C2"])
  })

  it("widens the follow-up to every row when a queued wake names none", async () => {
    const app = await boot([row("a", "A1"), row("b", "B1")])
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    app.gate(gate)
    app.rows([row("a", "A2"), row("b", "B2")])
    const first = app.wake([{ value: { id: "a" } }])
    const second = app.wake(undefined)
    release()
    await Promise.all([first, second])
    expect(app.items().map((li) => li.textContent)).toEqual(["A2", "B2"])
  })

  // A pass that throws binds nothing it was handed. The wake that follows
  // carries only its own rows, so it has to be a full pass, or the rows the
  // failed delta named stay bound to values no pass read.
  it("makes the pass after a failed one a full pass", async () => {
    const app = await boot([row("a", "A1"), row("b", "B1")])
    app.rows([row("a", "A2"), row("b", "B2")])
    app.gate(Promise.reject(new Error("store down")))
    await app.wake([{ value: { id: "b" } }])
    app.gate(Promise.resolve())
    await app.wake([{ value: { id: "a" } }])
    expect(app.items().map((li) => li.textContent)).toEqual(["A2", "B2"])
  })

  it("leaves a surviving row unstamped", async () => {
    const app = await boot([row("a", "Alpha")])
    await app.render([row("a", "Alpha"), row("b", "Beta")])
    expect(app.items()[0].hasAttribute("data-enter")).toBe(false)
  })

  it("keeps a departing row in the list while it plays, then removes it", async () => {
    const app = await boot([row("a", "Alpha"), row("b", "Beta")])
    const leaving = app.items()[1]

    await app.render([row("a", "Alpha")])
    // Still present and stamped: the node has to outlive the render to animate.
    expect(leaving.isConnected).toBe(true)
    expect(leaving.hasAttribute("data-exit")).toBe(true)

    await app.tick()
    expect(leaving.isConnected).toBe(false)
    expect(app.items().length).toBe(1)
  })

  // A node on its way out still occupies the region, so ordering has to step
  // over it or a surviving row gets inserted in the wrong place.
  it("orders survivors around a row that is still leaving", async () => {
    const app = await boot([row("a", "Alpha"), row("b", "Beta"), row("c", "Gamma")])
    const [a, , c] = app.items()

    await app.render([row("c", "Gamma"), row("a", "Alpha")])
    const surviving = app.items().filter((li: any) => !li.hasAttribute("data-exit"))

    expect(surviving[0]).toBe(c)
    expect(surviving[1]).toBe(a)
  })

  it("shows the empty message once the last row has gone", async () => {
    const app = await boot([row("a", "Alpha")])
    await app.render([])
    await app.tick()
    expect(app.document.querySelector("li.empty")?.textContent).toBe("Nothing here")
  })

  it("clears the empty message when a row returns", async () => {
    const app = await boot([row("a", "Alpha")])
    await app.render([])
    await app.tick()
    await app.render([row("b", "Beta")])
    await app.tick()
    expect(app.document.querySelector("p.empty")).toBeNull()
    expect(app.items().length).toBe(1)
  })
})
