import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { interpretScreen } from "../interpreter/screen.js"

// Item nodes must survive a refresh. Everything a screen feels like — focus
// held while typing, scroll kept, a transition allowed to finish, an enter
// animation having a node to play on — depends on the node being the same
// object across renders, so these assert identity rather than markup.
const SCREEN_HTML = `<section class="screen" data-screen="wall">
  <ul class="cards" data-live="note" data-order="position.asc" data-empty="Nothing here">
    <template data-item>
      <li>
        <span data-text="{title}"></span>
        <form data-form="rename" data-entity="note" data-action="update">
          <textarea name="body" data-value="{body}"></textarea>
          <input type="checkbox" name="done" data-value="{done}">
          <button type="submit">Save</button>
        </form>
      </li>
    </template>
  </ul>
</section>`

const ROUTE = {
  screen: "wall",
  files: { html: "shell/screens/wall.html", css: "shell/screens/wall.css", handlers: [] },
  states: ["loading", "empty", "populated"],
}

const tick = () => new Promise((r) => setTimeout(r, 5))

async function boot(initial: any[]) {
  const { document, Event } = parseHTML(
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
  let wake: any = () => {}
  const store = {
    query: async () => rows,
    subscribe: (_t: string, fn: any) => {
      wake = fn
      return () => {}
    },
    create: async () => {},
    update: async () => {},
    remove: async () => {},
  }
  const mount = document.getElementById("shell")
  await interpretScreen(mount, "http://localhost/", ROUTE, store, {}, { handlers: false })
  return {
    document,
    Event,
    items: (): any[] => [...document.querySelectorAll("li")],
    async render(next: any[]) {
      rows = next
      await wake()
      await tick()
    },
  }
}

const row = (id: string, title: string, extra: any = {}) => ({
  id,
  title,
  position: 1,
  body: "",
  done: false,
  ...extra,
})

describe("region reconciliation", () => {
  it("stamps the empty note as a list item inside a list region", async () => {
    // ul admits only li children (axe: list), so the note must match the
    // rows it stands in for.
    const t = await boot([])
    const note = t.document.querySelector(".cards > .empty")
    expect(note?.tagName).toBe("LI")
    expect(note?.textContent).toBe("Nothing here")
  })

  it("reuses the same node for a row that survives a refresh", async () => {
    const app = await boot([row("a", "Alpha"), row("b", "Beta")])
    const before = app.items()
    expect(before.length).toBe(2)

    await app.render([row("a", "Alpha renamed"), row("b", "Beta")])
    const after = app.items()

    expect(after.length).toBe(2)
    // Identity, not markup: these must be the very same objects.
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
    expect(after[0].querySelector("span").textContent).toBe("Alpha renamed")
  })

  it("removes a departed row and keeps the survivors' nodes", async () => {
    const app = await boot([row("a", "Alpha"), row("b", "Beta"), row("c", "Gamma")])
    const before = app.items()

    await app.render([row("a", "Alpha"), row("c", "Gamma")])
    const after = app.items()

    expect(after.length).toBe(2)
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[2])
    expect(before[1].isConnected).toBe(false)
  })

  it("moves a reordered node instead of rebuilding it", async () => {
    const app = await boot([row("a", "Alpha"), row("b", "Beta")])
    const [a, b] = app.items()

    await app.render([row("b", "Beta"), row("a", "Alpha")])
    const after = app.items()

    expect(after[0]).toBe(b)
    expect(after[1]).toBe(a)
  })

  it("adds only the new node when a row arrives", async () => {
    const app = await boot([row("a", "Alpha")])
    const [a] = app.items()

    await app.render([row("a", "Alpha"), row("b", "Beta")])
    const after = app.items()

    expect(after.length).toBe(2)
    expect(after[0]).toBe(a)
    expect(after[1]).not.toBe(a)
  })

  // The DOMStringMap setter stringifies, so assigning undefined would stamp
  // the literal "undefined" and [data-pending] would match forever.
  it("clears the pending badge when the row confirms", async () => {
    const app = await boot([row("a", "Alpha", { $synced: false })])
    expect(app.items()[0].dataset.pending).toBe("true")

    await app.render([row("a", "Alpha")])
    expect(app.items()[0].dataset.pending).toBeUndefined()
    expect(app.items()[0].hasAttribute("data-pending")).toBe(false)
  })

  // A refresh triggered by anything else on the screen must not overwrite the
  // control being typed into.
  it("does not overwrite a control that currently holds focus", async () => {
    const app = await boot([row("a", "Alpha", { body: "stored" })])
    const box = app.items()[0].querySelector("textarea")
    box.value = "half a sentence the user is still writing"
    Object.defineProperty(app.document, "activeElement", { value: box, configurable: true })

    await app.render([row("a", "Alpha", { body: "stored" })])

    expect(app.items()[0].querySelector("textarea").value).toBe(
      "half a sentence the user is still writing",
    )
  })

  // The wipe lands just as happily on text the user typed and then clicked away
  // from, which focus alone does not cover.
  it("does not overwrite an edit the user typed and then left", async () => {
    const app = await boot([row("a", "Alpha", { body: "stored" })])
    const box = app.items()[0].querySelector("textarea")
    box.value = "typed, then clicked elsewhere"
    box.dispatchEvent(new app.Event("input", { bubbles: true }))
    Object.defineProperty(app.document, "activeElement", { value: null, configurable: true })

    await app.render([row("a", "Alpha", { body: "changed under them" })])

    expect(app.items()[0].querySelector("textarea").value).toBe("typed, then clicked elsewhere")
  })

  it("binds again once the form has reset", async () => {
    const app = await boot([row("a", "Alpha", { body: "stored" })])
    const box = app.items()[0].querySelector("textarea")
    box.dispatchEvent(new app.Event("input", { bubbles: true }))
    Object.defineProperty(app.document, "activeElement", { value: null, configurable: true })

    box.closest("form").dispatchEvent(new app.Event("reset", { bubbles: true }))
    await app.render([row("a", "Alpha", { body: "now welcome" })])

    expect(app.items()[0].querySelector("textarea").value).toBe("now welcome")
  })

  // A checkbox is exempt from both guards on purpose: its value IS the state,
  // so a write the store refuses has to roll the control back where the user
  // can see it, even though they just touched it.
  it("re-binds a checkbox the user just toggled, so a refusal is visible", async () => {
    const app = await boot([row("a", "Alpha", { done: false })])
    const box = app.items()[0].querySelector('input[type="checkbox"]')
    box.checked = true
    box.dispatchEvent(new app.Event("input", { bubbles: true }))
    Object.defineProperty(app.document, "activeElement", { value: box, configurable: true })

    // The store refused; the row still reads false and the control must agree.
    await app.render([row("a", "Alpha", { done: false })])

    expect(app.items()[0].querySelector('input[type="checkbox"]').checked).toBe(false)
  })

  it("still binds a control the user is not in", async () => {
    const app = await boot([row("a", "Alpha", { body: "stored" })])
    Object.defineProperty(app.document, "activeElement", { value: null, configurable: true })

    await app.render([row("a", "Alpha", { body: "updated elsewhere" })])

    expect(app.items()[0].querySelector("textarea").value).toBe("updated elsewhere")
  })
})
