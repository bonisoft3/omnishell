// A radio group is one column seen from several controls: the member whose
// value the column holds is the checked one, and values() reads that same
// member back. The two directions have to agree or an edit form opens on a
// choice the row never made.
import { describe, expect, it } from "@test/harness"
import { type El, mountScreen, type Mounted } from "./screen-harness.ts"

// El describes what every element has; a control also carries the two the
// group is about.
type Control = El & { value: string; checked: boolean }

const ROUTE = { screen: "swatch", files: { html: "swatch.html", css: "swatch.css", handlers: [] } }

const FILES = {
  "swatch.html": `<section class="screen" data-screen="swatch">
    <div data-live="note" data-filter="id=eq.n1">
      <form data-form="recolor" data-entity="note" data-action="update" data-id="{id}">
        <input type="radio" name="color" value="sand" data-value="{color}">
        <input type="radio" name="color" value="sage" data-value="{color}">
        <input type="radio" name="color" value="plum" data-value="{color}">
        <button type="submit">Save</button>
      </form>
    </div>
  </section>`,
  "swatch.css": "",
}

const checked = (m: Mounted) =>
  (m.all("input[type=radio]") as Control[]).filter((el) => el.checked).map((el) => el.value)

describe("a radio group binds from the column it writes", () => {
  it("checks the member the row names, and only that one", async () => {
    const m = await mountScreen({
      route: ROUTE,
      files: FILES,
      tables: { note: [{ id: "n1", color: "sage" }] },
      seed: 1,
    })
    await m.settle()
    expect(checked(m)).toEqual(["sage"])
    await m.stop()
  })

  it("checks nothing when the column holds a value no member offers", async () => {
    // Silently checking the first member would show the reader a choice the
    // row never made, and submitting would write it back as though they had.
    const m = await mountScreen({
      route: ROUTE,
      files: FILES,
      tables: { note: [{ id: "n1", color: "chartreuse" }] },
      seed: 1,
    })
    await m.settle()
    expect(checked(m)).toEqual([])
    await m.stop()
  })

  it("submits the member the reader picked", async () => {
    const m = await mountScreen({
      route: ROUTE,
      files: FILES,
      tables: { note: [{ id: "n1", color: "sage" }] },
      seed: 1,
    })
    await m.settle()
    m.set("input[value=plum]", "checked", true)
    m.fire("form[data-form=recolor]", "submit")
    await m.settle()

    expect(m.store.rows("note")[0].color).toBe("plum")
    await m.stop()
  })
})
