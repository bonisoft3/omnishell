// A named template may sit inside an item, beside the region that uses it.
// Its content is the inner region's shape and not the item's tree: bound as
// the item's, its placeholders would resolve against the enclosing row and
// name columns that row does not have.
import { describe, expect, it } from "@test/harness"
import { mountScreen } from "./screen-harness.ts"

const ROUTE = {
  screen: "frame",
  files: { html: "frame.html", css: "frame.css", handlers: [] },
  states: ["loading", "empty", "populated"],
}

const FILES = {
  "frame.html": `<section class="screen" data-screen="frame">
    <div id="frame" data-live="query" data-filter="id=eq.the">
      <template data-item>
        <div class="hold" data-q="{q}">
          <template data-item data-name="line"><p class="line" data-text="{payer}"></p></template>
          <div class="lines" data-live="row" data-filter="payer=ilike.*{q}*" data-order="id.asc" data-template="line"></div>
        </div>
      </template>
    </div>
  </section>`,
  "frame.css": "",
}

describe("a named template inside an item", () => {
  it("is the inner region's shape, not the item's tree", async () => {
    const m = await mountScreen({
      route: ROUTE,
      files: FILES,
      tables: {
        query: [{ id: "the", q: "a" }],
        row: [{ id: "1", payer: "ada" }, { id: "2", payer: "bob" }, { id: "3", payer: "amy" }],
      },
      seed: 1,
    })
    await m.settle()
    expect(m.one(".hold").getAttribute("data-q")).toBe("a")
    expect(m.texts(".lines .line")).toEqual(["ada", "amy"])
    await m.store.update("query", "the", { q: "b" })
    await m.settle()
    expect(m.texts(".lines .line")).toEqual(["bob"])
    await m.stop()
  })
})
