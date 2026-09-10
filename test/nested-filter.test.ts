// A nested region's filter interpolates its parent's row, and is resolved once
// at hydration — so when the parent's row moves, the node that survives the
// refresh has to be re-hydrated or it keeps answering the value it was born
// with. This is the tier where that shows: the region renders, the column it
// filters on changes, and nothing about the DOM says which query produced the
// rows still on screen.
import { describe, expect, it } from "@test/harness"
import { mountScreen } from "./screen-harness.ts"

const ROUTE = { screen: "wall", files: { html: "wall.html", css: "wall.css", handlers: [] } }

const FILES = {
  "wall.html": `<section class="screen" data-screen="wall">
    <ul class="parents" data-live="parent" data-filter="id=neq.zz" data-order="id.asc">
      <template data-item>
        <li>
          <span class="kind" data-text="{kind}"></span>
          <ul class="children" data-live="child" data-filter="kind=eq.{kind}" data-order="id.asc">
            <template data-item><i class="child" data-text="{name}"></i></template>
          </ul>
        </li>
      </template>
    </ul>
  </section>`,
  "wall.css": "",
}

const world = () => ({
  parent: [{ id: "p1", kind: "warm" }],
  child: [
    { id: "c1", kind: "warm", name: "ember" },
    { id: "c2", kind: "cool", name: "frost" },
  ],
})

describe("a nested region follows its parent's row", () => {
  it("re-queries when the column its filter reads moves", async () => {
    const m = await mountScreen({ route: ROUTE, files: FILES, tables: world(), seed: 1 })
    await m.settle()
    expect(m.texts(".child")).toEqual(["ember"])

    await m.store.update("parent", "p1", { kind: "cool" })
    await m.settle()

    // The parent repaints from the new row either way; the child is the claim.
    // Scoping nestedOf with closest() instead of ownedBy() made every nested
    // region look like it belonged to the enclosing one, so the re-hydration
    // never ran and this still read "ember" — the old query, on the new row.
    expect(m.texts(".kind")).toEqual(["cool"])
    expect(m.texts(".child")).toEqual(["frost"])
    await m.stop()
  })

  it("leaves the node alone when the filter resolves to the same value", async () => {
    const m = await mountScreen({ route: ROUTE, files: FILES, tables: world(), seed: 1 })
    await m.settle()
    const readsBefore = m.store.calls.filter((c) => c.op === "query" && c.table === "child").length

    await m.store.update("parent", "p1", { kind: "warm" })
    await m.settle()

    // hydrateRegion hydrates in place, so node identity survives a
    // re-hydration and cannot witness one. The query can: re-hydrating on
    // every parent refresh would re-read the nested collection each time and
    // restart the enter animation of every row it renders.
    const readsAfter = m.store.calls.filter((c) => c.op === "query" && c.table === "child").length
    expect(readsAfter).toBe(readsBefore)
    expect(m.texts(".child")).toEqual(["ember"])
    await m.stop()
  })
})
