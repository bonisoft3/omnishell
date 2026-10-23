// A row's nested region binds after the row is in the document, so a URL it
// had yet to bind went in as written: the browser fetched `{image_url}`, a 404
// on the console, which failed an app's visual battery on every viewport.
import { describe, expect, it } from "@test/harness"
import { parseHTML } from "npm:linkedom@0.18.4"
import { holdUnboundLoads } from "../interpreter/fragment.js"
import { mountScreen } from "./screen-harness.ts"

const ROUTE = { screen: "settings", files: { html: "settings.html", css: "settings.css", handlers: [] } }

const FILES = {
  "settings.html": `<section class="screen" data-screen="settings">
    <div class="sheet" data-live="me">
      <template data-item>
        <div class="me">
          <div class="you" data-live="person" data-filter="id=eq.{id}">
            <img class="avatar" src="{image_url}" alt="">
          </div>
        </div>
      </template>
    </div>
  </section>`,
  "settings.css": "",
}

const world = () => ({
  me: [{ id: "u1" }],
  person: [{ id: "u1", image_url: "https://pictures.example/u1.png" }],
})

describe("a nested region's unbound URL is never in the document", () => {
  it("holds the template until the region binds, then sets the bound URL", async () => {
    // Whatever enters a connected parent is what the browser would fetch.
    // linkedom places nodes through ParentNode, under Element.
    const { Element } = parseHTML("<!doctype html><html></html>") as unknown as { Element: { prototype: object } }
    const proto = Object.getPrototypeOf(Element.prototype) as Record<string, (this: { isConnected: boolean }, ...a: unknown[]) => unknown>
    type Inserted = { localName?: string; getAttribute?: (n: string) => string | null; querySelectorAll?: (s: string) => Iterable<Inserted> }
    const fetched: string[] = []
    const watch = (node: Inserted) => {
      for (const img of node.localName === "img" ? [node] : [...(node.querySelectorAll?.("img") ?? [])]) {
        const src = img.getAttribute?.("src")
        if (src) fetched.push(src)
      }
    }
    const originals = Object.fromEntries(["insertBefore", "appendChild", "replaceChildren"].map((n) => [n, proto[n]]))
    for (const [name, original] of Object.entries(originals)) {
      proto[name] = function (this: { isConnected: boolean }, ...args: unknown[]) {
        const out = original.apply(this, args)
        if (this.isConnected) for (const n of name === "insertBefore" ? [args[0]] : args) watch(n as Inserted)
        return out
      }
    }
    try {
      const m = await mountScreen({ route: ROUTE, files: FILES, tables: world(), seed: 1 })
      await m.settle()
      expect(fetched.filter((src) => src.includes("{"))).toEqual([])
      expect(m.one(".avatar").getAttribute("src")).toBe("https://pictures.example/u1.png")
      await m.stop()
    } finally {
      Object.assign(proto, originals)
    }
  })

  it("stashes only a placeholder URL, and leaves a literal one in place", () => {
    const { document } = parseHTML(`<div><img id="a" src="{image_url}"><img id="b" src="/static/a.png"><video id="v" poster="{cover}"></video></div>`)
    const root = document.querySelector("div") as unknown as Parameters<typeof holdUnboundLoads>[0]
    holdUnboundLoads(root)
    const a = document.getElementById("a") as unknown as { getAttribute(n: string): string | null; _prontoAttrs?: Record<string, string> }
    expect(a.getAttribute("src")).toBe(null)
    expect(a._prontoAttrs).toEqual({ src: "{image_url}" })
    expect(document.getElementById("b")!.getAttribute("src")).toBe("/static/a.png")
    expect(document.getElementById("v")!.getAttribute("poster")).toBe(null)
  })
})
