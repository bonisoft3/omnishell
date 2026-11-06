import { expect, it } from "@test/harness"
import { mountScreen } from "./screen-harness.ts"

it("an update in a derived row uses its explicit target id without trying to rewrite the key", async () => {
  const m = await mountScreen({
    route: { screen: "picker", files: { html: "picker.html", css: "picker.css", handlers: [] } },
    params: { preset: "none" },
    files: {
      "picker.html": `<section class="screen" data-screen="picker">
        <ul data-live="choice" data-empty="No choices"><template data-item><li>
          <form data-entity="filter" data-action="update">
            <input type="hidden" name="id" data-value="{param.preset}">
            <input type="hidden" name="range" data-value="{range}">
            <button type="submit">Choose</button>
          </form>
        </li></template></ul>
      </section>`,
      "picker.css": "",
    },
    tables: { choice: [{ id: "none|day", range: "day" }], filter: [{ id: "none", range: "28d" }] },
    seed: 1,
  })
  try {
    await m.settle()
    const patch = m.store.patch.bind(m.store)
    const writes: unknown[] = []
    m.store.patch = (table, edits) => {
      writes.push({ table, edits })
      return patch(table, edits)
    }
    m.fire("form", "submit")
    await m.settle()
    expect(writes).toEqual([{ table: "filter", edits: [{ key: "none", changes: { range: "day" } }] }])
    expect(m.store.rows("filter")).toEqual([{ id: "none", range: "day" }])
    expect(m.store.rows("choice")).toEqual([{ id: "none|day", range: "day" }])
  } finally {
    await m.stop()
  }
})
