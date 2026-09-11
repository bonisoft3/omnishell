// A select bound with data-value shows the option the row names, the way a
// browser does when a script sets its value: the first option carrying that
// value is selected and every other one is not. A value no option offers
// selects nothing and reads back as the empty string — never the first option,
// which would show the reader a choice the row never made.
import { describe, expect, it } from "@test/harness"
import { type El, mountScreen, type Mounted } from "./screen-harness.ts"

type Select = El & { value: string }

const ROUTE = { screen: "swatch", files: { html: "swatch.html", css: "swatch.css", handlers: [] } }

const FILES = {
  "swatch.html": `<section class="screen" data-screen="swatch">
    <div data-live="note" data-filter="id=eq.n1">
      <form data-form="recolor" data-entity="note" data-action="update" data-id="{id}">
        <select name="color" data-value="{color}">
          <option value="sand">Sand</option>
          <option value="sage">Sage</option>
          <option value="plum">Plum</option>
        </select>
      </form>
    </div>
  </section>`,
  "swatch.css": "",
}

const selected = (m: Mounted) =>
  m.all("option").filter((o) => o.hasAttribute("selected")).map((o) => o.getAttribute("value"))

describe("a select binds from the column it writes", () => {
  it("selects the option the row names, and only that one", async () => {
    const m = await mountScreen({ route: ROUTE, files: FILES, tables: { note: [{ id: "n1", color: "sage" }] }, seed: 1 })
    await m.settle()
    expect((m.one("select") as Select).value).toBe("sage")
    expect(selected(m)).toEqual(["sage"])
    await m.stop()
  })

  it("selects nothing when the column holds a value no option offers", async () => {
    const m = await mountScreen({ route: ROUTE, files: FILES, tables: { note: [{ id: "n1", color: "chartreuse" }] }, seed: 1 })
    await m.settle()
    expect((m.one("select") as Select).value).toBe("")
    expect(selected(m)).toEqual([])
    await m.stop()
  })

  it("submits the option the reader picked, on change", async () => {
    const m = await mountScreen({ route: ROUTE, files: FILES, tables: { note: [{ id: "n1", color: "sage" }] }, seed: 1 })
    await m.settle()
    m.choose("select", "plum")
    await m.settle()
    expect(m.store.rows("note")[0].color).toBe("plum")
    expect((m.one("select") as Select).value).toBe("plum")
    await m.stop()
  })
})
