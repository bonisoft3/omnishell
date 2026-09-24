import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { interpretScreen } from "../interpreter/screen.js"

// Materialized SSR (M-SSR): Zero-diff hydration adopts server-rendered
// DOM nodes carrying data-id into the live Map instead of tearing them down.
const SERVER_SCREEN_HTML = `<section class="screen" data-screen="wall">
  <ul class="cards" data-live="note" data-order="position.asc" data-empty="Nothing here">
    <template data-item>
      <li>
        <span data-text="{title}"></span>
      </li>
    </template>
    <li data-id="n1"><span data-text="{title}">Server Note 1</span></li>
    <li data-id="n2"><span data-text="{title}">Server Note 2</span></li>
  </ul>
</section>`

const ROUTE = {
  screen: "wall",
  files: { html: "shell/screens/wall.html", css: "shell/screens/wall.css", handlers: [] },
  states: ["loading", "empty", "populated"],
}

const tick = () => new Promise((r) => setTimeout(r, 5))

describe("M-SSR zero-diff hydration", () => {
  it("adopts pre-rendered server nodes without tearing down the DOM", async () => {
    const { document } = parseHTML(
      "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
    )
    globalThis.document = document as any
    globalThis.fetch = ((url: any) => {
      const u = String(url)
      if (u.endsWith(".html")) return Promise.resolve(new Response(SERVER_SCREEN_HTML))
      if (u.endsWith(".css")) return Promise.resolve(new Response(""))
      return Promise.reject(new Error(`unexpected fetch ${u}`))
    }) as any

    let rows = [
      { id: "n1", title: "Live Note 1", position: 1 },
      { id: "n2", title: "Live Note 2", position: 2 },
    ]
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

    const items = [...document.querySelectorAll("li")]
    expect(items.length).toBe(2)
    expect(items[0].dataset.id).toBe("n1")
    expect(items[0].querySelector("span")?.textContent).toBe("Live Note 1")
    expect(items[1].dataset.id).toBe("n2")
    expect(items[1].querySelector("span")?.textContent).toBe("Live Note 2")

    const originalN1 = items[0]
    rows = [
      { id: "n1", title: "Updated Note 1", position: 1 },
      { id: "n2", title: "Live Note 2", position: 2 },
    ]
    await wake([{ type: "update", value: rows[0], previousValue: { id: "n1" } }])
    await tick()

    const updatedItems = [...document.querySelectorAll("li")]
    expect(updatedItems[0]).toBe(originalN1)
    expect(updatedItems[0].querySelector("span")?.textContent).toBe("Updated Note 1")
  })
})
