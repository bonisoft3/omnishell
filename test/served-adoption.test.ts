import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { renderDocument } from "../interpreter/document.js"
import { interpretScreen, templateHash } from "../interpreter/screen.js"
import { controlProperties } from "../server/linkedom-controls.ts"
import "../interpreter/vendor/ses.umd.min.js"
import { ensureSes } from "../interpreter/jessie.js"

// Sealed at load, as the shell's realm is before a screen evaluates a module.
await ensureSes()

// A document served before the shell boots, or kept by the service worker
// since a visit before, taken over by the shell where it stands: its nodes
// kept, its rows brought to the store's, what the reader typed left alone.
// The shell once rendered its own screen out of sight and swapped it in,
// which threw away every node the reader was on, their focus and their
// unsent text with it.

const TEMPLATE = `<section class="screen" data-screen="wall">
  <h1>Wall</h1>
  <label>Search <input class="search" name="q"></label>
  <div class="pinned" data-live="pin" data-filter="id=eq.top">
    <input class="draft" name="body" data-value="{body}">
  </div>
  <ul class="cards" data-live="note" data-order="position.asc">
    <template data-item><li class="card" data-kind="{kind}"><a data-route="note" data-param-id="{id}" data-text="{title}"></a></li></template>
  </ul>
</section>`

// The same screen a deploy ago: a paragraph since retired, none since added.
const OLDER = TEMPLATE.replace("<h1>Wall</h1>", `<h1>Wall</h1>\n  <p class="retired">Soon</p>`)
const NEWER = TEMPLATE.replace("<h1>Wall</h1>", `<h1>Wall</h1>\n  <p class="added">Now</p>`)
  .replace("</a></li></template>", `</a><small class="flag">new</small></li></template>`)

const ROUTES = [
  { path: "/", screen: "wall", nav: { label: "Wall" }, files: { html: "screens/wall.html", css: "screens/wall.css", handlers: [] } },
  { path: "/note/:id", screen: "note", nav: { label: "Note", strip: false }, files: { html: "screens/note.html", css: "screens/note.css", handlers: [] } },
]
const ROUTE = ROUTES[0]
const CFG = { app: "wall", routes: ROUTES, tables: ["note", "pin"] }
const ENTRY = `<!doctype html><html><head><title>wall</title></head><body><main id="app"></main><script type="module" src="./boot.js"></script></body></html>`

type Row = Record<string, unknown>

function store(rows: Record<string, Row[]>) {
  const subs = new Map<string, ((changes?: unknown) => Promise<void>)[]>()
  // Milliseconds a table's reads take, where they take any.
  const slow: Record<string, number> = {}
  return {
    rows,
    slow,
    // A filter's equalities, the one clause these screens read with.
    query: (table: string, _order: unknown, opts: { filter?: string } = {}) =>
      new Promise((resolve) =>
        setTimeout(() => {
          const eqs = (opts.filter ?? "").split("&").filter(Boolean).map((c) => /^([^=]+)=eq\.(.*)$/.exec(c)!)
          resolve((rows[table] ?? []).filter((r) => eqs.every(([, col, v]) => String(r[col]) === v)))
        }, slow[table] ?? 0)
      ),
    subscribe: (table: string, fn: (changes?: unknown) => Promise<void>) => {
      subs.set(table, [...(subs.get(table) ?? []), fn])
      return () => subs.set(table, (subs.get(table) ?? []).filter((f) => f !== fn))
    },
    /** How many regions read `table` now. */
    listening: (table: string) => (subs.get(table) ?? []).length,
    create: async () => {},
    update: async () => {},
    remove: async () => {},
    /** The store waking every region reading `table`. */
    wake: async (table: string) => {
      for (const fn of subs.get(table) ?? []) await fn()
    },
  }
}

type Files = { html: string; css?: string }

/** A screen's files as the worker's copy answers them, and as the network
 * does to a request that revalidates (`fresh`, the worker's copy unless said);
 * every revalidating request is counted in `revalidated`. */
let revalidated: string[] = []
const serveTemplate = (template: string, css = "", fresh: Files = { html: template, css }) => {
  revalidated = []
  globalThis.fetch = ((url: unknown, init?: RequestInit) => {
    const path = String(url)
    const files = init?.cache === "no-cache" ? (revalidated.push(path), fresh) : { html: template, css }
    return Promise.resolve(new Response(path.endsWith(".html") ? files.html : files.css ?? ""))
  }) as typeof fetch
}

/** The document the renderer answers for `/` from `template` and `css`, over
 * `rows`. */
async function served(template: string, rows: Record<string, Row[]>, css = "") {
  serveTemplate(template, css)
  // As the renderers draw it, through the control properties linkedom lacks.
  controlProperties(parseHTML("").document)
  const { html, handle } = await renderDocument({
    entry: ENTRY,
    parse: (text: string) => parseHTML(text).document,
    cfg: CFG,
    appBase: new URL("https://wall.test/"),
    route: ROUTE,
    store: store(rows),
    messages: {},
    rows: true,
    origin: "https://wall.test",
    here: "/",
  })
  handle.stop()
  return html
}

/** That document in a reader's browser, and the shell taking it over against
 * `template` and `live`. `before` is the reader, between the paint and the
 * shell; `worker` the copies the worker answers with, the network's being
 * `template`'s. */
async function adopt(
  html: string,
  template: string,
  live: ReturnType<typeof store>,
  before = (_d: Document) => {},
  worker: Files = { html: template },
) {
  const { document } = parseHTML(html)
  ;(globalThis as unknown as { document: Document }).document = document
  const mount = document.querySelector(".shell-screen[data-served]")!
  const screen = mount.querySelector(".screen")!
  const cas = document.querySelector('meta[name="pronto-cas"]')!.getAttribute("content")
  const nodes = [screen, ...screen.querySelectorAll("*")]
  before(document)
  serveTemplate(worker.html, worker.css ?? "", { html: template, css: "" })
  const handle = await interpretScreen(mount, "https://wall.test/", ROUTE, live, {}, {
    routes: ROUTES,
    served: { screen, cas },
  })
  return { document, screen, nodes, handle }
}

const NOTES = [
  { id: "n1", title: "One", kind: "a", position: 1 },
  { id: "n2", title: "Two", kind: "a", position: 2 },
]
const PIN = [{ id: "top", body: "stored" }]

describe("a served screen taken over by the shell", () => {
  it("is served beside the strip, marking its own page", async () => {
    const strip = parseHTML(await served(TEMPLATE, { note: NOTES, pin: PIN })).document.querySelectorAll("body > nav")
    expect(strip.length).toBe(1)
    expect(strip[0].querySelector('[aria-current="page"]')?.getAttribute("href")).toBe("/")
  })

  it("keeps every node when its template is the one it was rendered from", async () => {
    const html = await served(TEMPLATE, { note: NOTES, pin: PIN })
    const { screen, nodes, handle } = await adopt(html, TEMPLATE, store({ note: NOTES, pin: PIN }))
    expect(screen.isConnected).toBe(true)
    expect([screen, ...screen.querySelectorAll("*")]).toEqual(nodes)
    for (const node of nodes) expect(node.isConnected).toBe(true)
    handle.stop()
  })

  it("brings rows older than the store's to it in place, and keeps them bound", async () => {
    // A service worker paints the copy it kept from a visit before, so the
    // rows a document carries can be any age.
    const html = await served(TEMPLATE, { note: NOTES, pin: PIN })
    const live = store({
      note: [{ id: "n1", title: "One, edited", kind: "b", position: 1 }, { id: "n3", title: "Three", kind: "a", position: 3 }],
      pin: PIN,
    })
    const { document, screen, nodes, handle } = await adopt(html, TEMPLATE, live)
    const one = nodes.find((n) => n.getAttribute("data-id") === "n1")!
    const cards = [...screen.querySelectorAll(".cards > li")]
    expect(cards.map((c) => c.getAttribute("data-id"))).toEqual(["n1", "n3"])
    expect(cards[0]).toBe(one)
    expect(one.textContent).toBe("One, edited")
    expect(one.getAttribute("data-kind")).toBe("b")
    expect(cards[1].querySelector("a")!.getAttribute("href")).toBe("/note/n3")
    expect(document.querySelector('[data-id="n2"]')).toBe(null)
    // Bound for good, not once: the template an attribute was rendered from
    // is the served node's own now.
    live.rows.note = [{ id: "n1", title: "One, again", kind: "c", position: 1 }]
    await live.wake("note")
    expect(screen.querySelector(".cards > li")).toBe(one)
    expect(one.getAttribute("data-kind")).toBe("c")
    expect(one.textContent).toBe("One, again")
    handle.stop()
  })

  it("leaves what the reader typed before it, on the node they typed it into", async () => {
    const html = await served(TEMPLATE, { note: NOTES, pin: PIN })
    const live = store({ note: NOTES, pin: PIN })
    const { screen, handle } = await adopt(html, TEMPLATE, live, (d) => {
      ;(d.querySelector(".search") as HTMLInputElement).value = "fla"
      // Typed, as a browser holds it: apart from the attribute it was served
      // with, which linkedom would rewrite instead.
      Object.defineProperty(d.querySelector(".draft"), "value", { value: "unsent", writable: true })
    })
    const search = screen.querySelector(".search") as HTMLInputElement
    const draft = screen.querySelector(".draft") as HTMLInputElement
    expect(search.value).toBe("fla")
    expect(draft.value).toBe("unsent")
    live.rows.pin = [{ id: "top", body: "stored, then changed" }]
    await live.wake("pin")
    expect(screen.querySelector(".draft")).toBe(draft)
    expect(draft.value).toBe("unsent")
    handle.stop()
  })

  it("brings a control the reader did not touch to its row", async () => {
    const html = await served(TEMPLATE, { note: NOTES, pin: PIN })
    const { screen, handle } = await adopt(html, TEMPLATE, store({ note: NOTES, pin: [{ id: "top", body: "changed" }] }))
    expect((screen.querySelector(".draft") as HTMLInputElement).value).toBe("changed")
    handle.stop()
  })

  it("morphs a screen whose template moved on, keeping what did not change", async () => {
    const html = await served(OLDER, { note: NOTES, pin: PIN })
    const live = store({ note: NOTES, pin: PIN })
    const { screen, nodes, handle } = await adopt(html, NEWER, live)
    // Kept, so what the reader typed stays in it: linkedom holds a typed value
    // in the attribute the morph rewrites, which a browser does not.
    const kept = (selector: string) => nodes.includes(screen.querySelector(selector)!)
    expect(kept("h1")).toBe(true)
    expect(kept(".search")).toBe(true)
    expect(kept(".cards")).toBe(true)
    expect(screen.querySelector(".retired")).toBe(null)
    expect(screen.querySelector(".added")?.textContent).toBe("Now")
    // Rows stamped from an item the screen no longer states are morphed to
    // the one it does, and kept.
    const cards = [...screen.querySelectorAll(".cards > li")]
    expect(cards.every((c) => nodes.includes(c))).toBe(true)
    expect(cards.map((c) => c.querySelector("a")?.textContent)).toEqual(["One", "Two"])
    expect(cards.map((c) => c.querySelector(".flag")?.textContent)).toEqual(["new", "new"])
    // The witness names the template drawn now. linkedom writes the meta's
    // content ahead of its name, so a pattern over the markup matched nothing
    // and this compared the handle's witness with undefined.
    const witness = parseHTML(html).document.querySelector('meta[name="pronto-cas"]')!.getAttribute("content")
    expect(witness).toBe(templateHash(OLDER))
    expect(handle.cas).toBe(templateHash(NEWER))
    handle.stop()
  })

  it("takes a document newer than the worker's copy of its template as it stands", async () => {
    // Right after a deploy the worker still answers the older template, while
    // an address it never kept is rendered by the newer one. A witness that
    // differs was read as the template having moved on: the newer document
    // was morphed back to the older one, and its rows kept the older item for
    // the rest of the visit.
    const html = await served(NEWER, { note: NOTES, pin: PIN })
    const live = store({ note: NOTES, pin: PIN })
    const { screen, nodes, handle } = await adopt(html, NEWER, live, undefined, { html: OLDER })
    expect(revalidated.length).toBe(2)
    expect([screen, ...screen.querySelectorAll("*")]).toEqual(nodes)
    expect(screen.querySelector(".added")?.textContent).toBe("Now")
    expect(screen.querySelector(".retired")).toBe(null)
    live.rows.note = [...NOTES, { id: "n3", title: "Three", kind: "a", position: 3 }]
    await live.wake("note")
    expect([...screen.querySelectorAll(".cards > li")].map((c) => c.querySelector(".flag")?.textContent))
      .toEqual(["new", "new", "new"])
    expect(handle.cas).toBe(templateHash(NEWER))
    handle.stop()
  })

  it("asks nothing of the network when the document and the worker agree", async () => {
    const html = await served(TEMPLATE, { note: NOTES, pin: PIN })
    const { handle } = await adopt(html, TEMPLATE, store({ note: NOTES, pin: PIN }))
    expect(revalidated).toEqual([])
    handle.stop()
  })

  it("draws the current stylesheet over the one a document carries", async () => {
    // The document carries its screen's stylesheet inline. One kept from
    // before a deploy kept it, and the worker, already holding the newer one,
    // had nothing to announce: the newer markup was drawn with the older
    // stylesheet for the whole visit.
    const html = await served(TEMPLATE, { note: NOTES, pin: PIN }, ".card { color: red }")
    const { document, handle } = await adopt(html, TEMPLATE, store({ note: NOTES, pin: PIN }), undefined, { html: TEMPLATE, css: "" })
    expect(document.getElementById("screen-css-wall")!.textContent).toBe("")
    handle.stop()
  })
})

describe("a running screen whose template moves on", () => {
  it("morphs each row to the newer item, and stamps new rows from it", async () => {
    // The worker announces a newer template to a screen on show. The morph
    // stopped at every list, so its rows, and every row stamped after, stayed
    // the older item until a reload.
    const html = await served(OLDER, { note: NOTES, pin: PIN })
    const live = store({ note: NOTES, pin: PIN })
    const { screen, handle } = await adopt(html, OLDER, live)
    const cards = [...screen.querySelectorAll(".cards > li")]
    await handle.morph(NEWER)
    expect(screen.querySelector(".added")?.textContent).toBe("Now")
    expect([...screen.querySelectorAll(".cards > li")]).toEqual(cards)
    expect(cards.map((c) => c.querySelector(".flag")?.textContent)).toEqual(["new", "new"])
    expect(cards.map((c) => c.querySelector("a")?.getAttribute("href"))).toEqual(["/note/n1", "/note/n2"])
    live.rows.note = [...NOTES, { id: "n3", title: "Three", kind: "a", position: 3 }]
    await live.wake("note")
    expect(screen.querySelector('[data-id="n3"] .flag')?.textContent).toBe("new")
    handle.stop()
  })

  it("keeps the state its rows gave it", async () => {
    // Each list's pass names the screen's state after its own rows, so the
    // re-bind a newer template asks of every list left the screen in whatever
    // state the last to settle said: a game with no comments read as empty.
    const withEmpty = (t: string) =>
      t.replace(`<ul class="cards"`, `<ol class="quiet" data-live="remark"><template data-item><li data-text="{body}"></li></template></ol>\n  <ul class="cards"`)
    const html = await served(withEmpty(OLDER), { note: NOTES, pin: PIN, remark: [] })
    const live = store({ note: NOTES, pin: PIN, remark: [] })
    const { screen, handle } = await adopt(html, withEmpty(OLDER), live)
    expect(screen.getAttribute("data-state")).toBe("populated")
    live.slow.remark = 20
    await handle.morph(withEmpty(NEWER))
    expect(screen.getAttribute("data-state")).toBe("populated")
    handle.stop()
  })
})

// A deploy landing while a screen is on show: what the newer template adds,
// drops or reads differently. The morph hydrated no region the template added
// and left a bound slot's markup as it stood, so a screen mounted before the
// deploy kept the older one's half until a reload.
const RUNNING = `<section class="screen" data-screen="wall">
  <h1>Wall</h1>
  <label>Search <input class="search" name="q"></label>
  <div class="pinned" data-live="pin" data-filter="id=eq.top">
    <input class="draft" name="body" data-value="{body}">
  </div>
  <ul class="cards" data-live="note" data-order="position.asc">
    <template data-item><li class="card" data-kind="{kind}"><a data-route="note" data-param-id="{id}" data-text="{title}"></a></li></template>
  </ul>
  <p class="retiring" data-live="pin" data-filter="id=eq.top"><span data-text="{body}"></span></p>
</section>`
// The pinned slot gains a bound text and a list of its own, each card a slot,
// a list joins and one leaves.
const DEPLOYED = RUNNING
  .replace(`data-value="{body}">`, `data-value="{body}">\n    <small class="echo" data-text="{body}"></small>\n    <ol class="remarks" data-live="remark" data-order="id.asc"><template data-item><li data-text="{body}"></li></template></ol>`)
  .replace(`data-text="{title}"></a></li>`, `data-text="{title}"></a><em class="pin" data-live="pin" data-filter="id=eq.top"><b data-text="{body}"></b></em></li>`)
  .replace(/\n  <p class="retiring".*<\/p>/, `\n  <aside class="latest" data-live="note" data-filter="id=eq.n2"><h2 data-text="{title}"></h2></aside>`)
const REMARKS = [{ id: "r1", body: "first" }, { id: "r2", body: "second" }]

/** A tree as a mount leaves it, its attributes in a fixed order and its
 * whitespace dropped, so two trees built differently compare by what they
 * show. These fixtures name no language, which linkedom spells two ways. */
const canonical = (el: Element): string => {
  const attrs = [...el.attributes].filter((a) => a.name !== "data-locale").map((a) => `${a.name}="${a.value}"`).sort().join(" ")
  const kids = [...el.childNodes].map((n) =>
    n.nodeType === 1 ? canonical(n as Element) : (n.textContent ?? "").trim()
  ).join("")
  return `<${el.localName} ${attrs}>${kids}</${el.localName}>`
}

/** The screen a mount of `template` draws over `rows`, from no document. */
async function mounted(template: string, rows: Record<string, Row[]>) {
  const { document } = parseHTML(`<!doctype html><html><head></head><body><main id="app"></main></body></html>`)
  ;(globalThis as unknown as { document: Document }).document = document
  serveTemplate(template)
  const handle = await interpretScreen(document.getElementById("app"), "https://wall.test/", ROUTE, store(rows), {}, { routes: ROUTES })
  const screen = canonical(document.querySelector(".screen")!)
  handle.stop()
  return screen
}

describe("a running screen whose template adds, drops or changes regions", () => {
  const rows = () => ({ note: NOTES, pin: PIN, remark: REMARKS })

  it("ends where a mount of the newer template does", async () => {
    const changed = DEPLOYED.replace(`data-order="position.asc"`, `data-order="position.asc" data-filter="id=eq.n2"`)
    const fresh = await mounted(changed, rows())
    const html = await served(RUNNING, rows())
    const { screen, handle } = await adopt(html, RUNNING, store(rows()))
    await handle.morph(changed)
    expect(canonical(screen)).toBe(fresh)
    expect([...screen.querySelectorAll(".cards > li")].map((c) => c.getAttribute("data-id"))).toEqual(["n2"])
    handle.stop()
  })

  it("keeps what did not change, with what the reader typed", async () => {
    const html = await served(RUNNING, rows())
    const live = store(rows())
    const { screen, handle } = await adopt(html, RUNNING, live)
    const kept = [".search", ".draft", ".pinned", ".cards", ".cards > li:first-child"].map((s) => screen.querySelector(s))
    const draft = screen.querySelector(".draft") as HTMLInputElement
    Object.defineProperty(draft, "value", { value: "unsent", writable: true })
    const { Event } = draft.ownerDocument.defaultView as unknown as { Event: typeof globalThis.Event }
    draft.dispatchEvent(new Event("input"))
    await handle.morph(DEPLOYED)
    expect([".search", ".draft", ".pinned", ".cards", ".cards > li:first-child"].map((s) => screen.querySelector(s))).toEqual(kept)
    expect(draft.value).toBe("unsent")
    expect(screen.querySelector(".echo")?.textContent).toBe("stored")
    expect([...screen.querySelectorAll(".remarks > li")].map((li) => li.textContent)).toEqual(["first", "second"])
    expect([...screen.querySelectorAll(".cards .pin b")].map((b) => b.textContent)).toEqual(["stored", "stored"])
    expect(screen.querySelector(".latest h2")?.textContent).toBe("Two")
    expect(screen.querySelector(".retiring")).toBe(null)
    // Bound for good: each region the template added follows its rows.
    live.rows.pin = [{ id: "top", body: "moved" }]
    live.rows.remark = [...REMARKS, { id: "r3", body: "third" }]
    await live.wake("pin")
    await live.wake("remark")
    expect(screen.querySelector(".echo")?.textContent).toBe("moved")
    expect([...screen.querySelectorAll(".cards .pin b")].map((b) => b.textContent)).toEqual(["moved", "moved"])
    expect(screen.querySelectorAll(".remarks > li").length).toBe(3)
    expect(draft.value).toBe("unsent")
    handle.stop()
  })

  it("keeps a hidden field a form resolves at submit, through a slot that held no row", async () => {
    // The newer template stashed the field's data-value as a binding, the
    // empty slot cleared it with its bindings, and a hidden field is never
    // bound back: the form's next submit left the column out.
    const slotted = `<section class="screen" data-screen="wall">
  <h1>Wall</h1>
  <div class="pinned" data-live="pin" data-filter="id=eq.top" data-empty="">
    <form data-entity="pin" data-action="update"><input class="ref" type="hidden" name="ref" data-value="{id}"><input class="body" name="body" data-value="{body}"></form>
  </div>
</section>`
    const { document } = parseHTML(`<!doctype html><html><head></head><body><main id="app"></main></body></html>`)
    ;(globalThis as unknown as { document: Document }).document = document
    serveTemplate(slotted)
    const live = store({ pin: [] })
    const handle = await interpretScreen(document.getElementById("app"), "https://wall.test/", ROUTE, live, {}, { routes: ROUTES })
    await handle.morph(slotted.replace("<h1>Wall</h1>", `<h1>Wall</h1>\n  <small>now</small>`))
    const ref = () => document.querySelector(".ref")!.getAttribute("data-value")
    expect(ref()).toBe("{id}")
    live.rows.pin = PIN
    await live.wake("pin")
    expect([ref(), (document.querySelector(".body") as HTMLInputElement).value]).toEqual(["{id}", "stored"])
    // A slot that loses its row and gets one back clears the same bindings.
    live.rows.pin = []
    await live.wake("pin")
    live.rows.pin = PIN
    await live.wake("pin")
    expect(ref()).toBe("{id}")
    handle.stop()
  })

  it("hydrates nothing for a screen left while the newer template loads", async () => {
    // The shell checks the screen is on show before it morphs, and the morph
    // waits on the newer template's modules before it hydrates: a screen
    // stopped in between hydrated the regions the template added anyway, and
    // nothing stopped them again.
    const listening = (live: ReturnType<typeof store>) => Object.fromEntries(["note", "pin", "remark"].map((t) => [t, live.listening(t)]))
    const stopped = store(rows())
    const left = await adopt(await served(RUNNING, rows()), RUNNING, stopped)
    const morphing = left.handle.morph(DEPLOYED)
    left.handle.stop()
    await morphing
    expect(listening(stopped)).toEqual({ note: 0, pin: 0, remark: 0 })
    // One paused instead takes the template, and listens again only once it
    // resumes, as a running screen of the newer template does.
    const reference = store(rows())
    const running = await adopt(await served(DEPLOYED, rows()), DEPLOYED, reference)
    const paused = store(rows())
    const held = await adopt(await served(RUNNING, rows()), RUNNING, paused)
    const morphed = held.handle.morph(DEPLOYED)
    held.handle.pause()
    await morphed
    expect(listening(paused)).toEqual({ note: 0, pin: 0, remark: 0 })
    await held.handle.resume()
    expect(listening(paused)).toEqual(listening(reference))
    running.handle.stop()
    held.handle.stop()
  })

  it("lets go of what the template took out", async () => {
    const html = await served(DEPLOYED, rows())
    const live = store(rows())
    const { screen, handle } = await adopt(html, DEPLOYED, live)
    const listening = () => Object.fromEntries(["note", "pin", "remark"].map((t) => [t, live.listening(t)]))
    const before = listening()
    await handle.morph(RUNNING)
    // The latest note, each card's pin and the pinned remarks go; the
    // retiring paragraph comes.
    expect(listening()).toEqual({ note: before.note - 1, pin: before.pin - 2 + 1, remark: 0 })
    expect(screen.querySelector(".remarks")).toBe(null)
    expect(screen.querySelector(".retiring span")?.textContent).toBe("stored")
    handle.stop()
  })
})

// A route whose reads hang under a browser entity's row is rendered from its
// seed, the row every reader starts from; a device that kept another reads its
// own.
const CATALOG = `<section class="screen" data-screen="wall">
  <div class="search" data-live="search" data-filter="id=eq.catalog">
    <input class="q" name="q" data-value="{kind}">
    <select class="kind" name="kind" data-value="{kind}"><option value="a">A</option><option value="b">B</option></select>
    <ul class="cards" data-live="note" data-filter="kind=eq.{kind}" data-order="position.asc">
      <template data-item><li class="card" data-text="{title}"></li></template>
    </ul>
  </div>
</section>`
const SEARCH = [{ id: "catalog", kind: "a" }]
const CATALOGUE = [...NOTES, { id: "n3", title: "Three", kind: "b", position: 3 }]

describe("a served screen drawn from a browser entity's seed", () => {
  it("keeps every row where the browser holds the seed", async () => {
    const html = await served(CATALOG, { search: SEARCH, note: CATALOGUE })
    // Chosen in the markup. linkedom's select had no value to set, so the
    // renderer threw binding it, and golaberto's catalogue was served in its
    // network-error state.
    expect([...parseHTML(html).document.querySelectorAll(".kind option[selected]")].map((o) => o.getAttribute("value"))).toEqual(["a"])
    const { screen, nodes, handle } = await adopt(html, CATALOG, store({ search: SEARCH, note: CATALOGUE }))
    expect([screen, ...screen.querySelectorAll("*")]).toEqual(nodes)
    expect([...screen.querySelectorAll(".cards > li")].map((li) => li.textContent)).toEqual(["One", "Two"])
    handle.stop()
  })

  it("reads the browser's own row where it holds another", async () => {
    const html = await served(CATALOG, { search: SEARCH, note: CATALOGUE })
    const { screen, nodes, handle } = await adopt(html, CATALOG, store({ search: [{ id: "catalog", kind: "b" }], note: CATALOGUE }))
    expect(nodes.includes(screen.querySelector(".cards")!)).toBe(true)
    expect([...screen.querySelectorAll(".cards > li")].map((li) => li.textContent)).toEqual(["Three"])
    expect((screen.querySelector(".q") as HTMLInputElement).value).toBe("b")
    expect((screen.querySelector(".kind") as HTMLSelectElement).value).toBe("b")
    handle.stop()
  })
})

describe("newer templates reaching a running screen", () => {

  it("are taken in the order they arrive", async () => {
    // Every announcement started a morph of its own, and a morph waits on the
    // modules its template names: the newer template's loaded first and was
    // morphed to, then the older one's landed and the screen was morphed back
    // to it, while the shell held the newer as the one on show.
    const route = { ...ROUTE, files: { ...ROUTE.files, renderers: ["renderers/slow.js", "renderers/quick.js"] } }
    const BASE = `<section class="screen" data-screen="wall"><h1>Wall</h1></section>`
    const OLDER_ONE = BASE.replace("</h1>", `</h1><p class="older" data-text-format="slow"></p>`)
    const NEWER_ONE = BASE.replace("</h1>", `</h1><p class="newer" data-text-format="quick"></p>`)
    const { document } = parseHTML(`<!doctype html><html><head></head><body><main id="app"></main></body></html>`)
    ;(globalThis as unknown as { document: Document }).document = document
    globalThis.fetch = ((url: unknown) => {
      const path = String(url)
      const module = `(value) => [String(value)];`
      if (path.endsWith("slow.js")) return new Promise((r) => setTimeout(() => r(new Response(module)), 30))
      if (path.endsWith("quick.js")) return Promise.resolve(new Response(module))
      return Promise.resolve(new Response(path.endsWith(".html") ? BASE : ""))
    }) as typeof fetch
    const handle = await interpretScreen(document.getElementById("app"), "https://wall.test/", route, store({}), {}, { routes: ROUTES })
    await Promise.all([handle.morph(OLDER_ONE), handle.morph(NEWER_ONE)])
    expect(document.querySelector(".newer")).not.toBe(null)
    expect(document.querySelector(".older")).toBe(null)
    handle.stop()
  })

  it("leave the screen as it was when one cannot be taken", async () => {
    // The named templates were renamed after the newer template before it was
    // known to resolve: it named one nobody declared, the morph threw, and a
    // row arriving after drew its pins from the newer template's item inside
    // the older screen.
    const NAMED = `<section class="screen" data-screen="wall">
  <ul class="cards" data-live="note" data-order="position.asc">
    <template data-item><li class="card"><span data-text="{title}"></span><ol class="pins" data-live="pin" data-filter="id=eq.top" data-template="pinned"></ol></li></template>
  </ul>
  <template data-item data-name="pinned"><li class="older" data-text="{body}"></li></template>
</section>`
    const BROKEN = NAMED.replace(`class="older"`, `class="newer"`)
      .replace(`</ul>`, `</ul>\n  <ol class="stray" data-live="remark" data-template="undeclared"></ol>`)
    const live = store({ note: NOTES, pin: PIN })
    const { screen, handle } = await adopt(await served(NAMED, { note: NOTES, pin: PIN }), NAMED, live)
    await expect(handle.morph(BROKEN)).rejects.toThrow(`no template declares data-name="undeclared"`)
    live.rows.note = [...NOTES, { id: "n3", title: "Three", kind: "a", position: 3 }]
    await live.wake("note")
    expect([...screen.querySelectorAll('.card[data-id="n3"] .pins > li')].map((li) => li.className)).toEqual(["older"])
    handle.stop()
  })
})
