// data-order as a closed map, driven through a screen: a column choosing among
// the orders the file states, and re-reading when that column moves.
//
// The parser's own suite is order-clauses.test.ts — it cannot live here,
// because the harness refuses a static screen.js import.
import { describe, expect, it } from "@test/harness"
import { type El, mountScreen, type Mounted } from "./screen-harness.ts"

const ROUTE = { screen: "tbl", files: { html: "tbl.html", css: "tbl.css", handlers: [] } }

const FILES = {
  "tbl.html": `<section class="screen" data-screen="tbl">
    <div data-live="view" data-filter="id=eq.the">
      <template data-item>
        <div class="frame">
          <ul data-live="invoice"
              data-order='{"by":"{sort}","of":{"num":"number.asc","amt":"amount.desc"}}'>
            <template data-item><li data-text="{number}"></li></template>
          </ul>
        </div>
      </template>
    </div>
  </section>`,
  "tbl.css": "",
}

const invoices = () => [
  { id: "a", number: "INV-1", amount: 20 },
  { id: "b", number: "INV-2", amount: 90 },
  { id: "c", number: "INV-3", amount: 50 },
]

const mount = (sort: string, files = FILES) =>
  mountScreen({ route: ROUTE, files, tables: { view: [{ id: "the", sort }], invoice: invoices() }, seed: 1 })

const shown = (m: Mounted) => (m.all("li") as El[]).map((el) => el.textContent)

describe("a column chooses among the orders the file states", () => {
  it("reads in the order its key names", async () => {
    const m = await mount("num")
    await m.settle()
    expect(shown(m)).toEqual(["INV-1", "INV-2", "INV-3"])
    await m.stop()
  })

  it("reads in a different one when the column says so", async () => {
    const m = await mount("amt")
    await m.settle()
    expect(shown(m)).toEqual(["INV-2", "INV-3", "INV-1"])
    await m.stop()
  })

  it("re-reads when the enclosing row's key moves", async () => {
    // The whole point of the feature: a header that is a form writing `sort`.
    const m = await mount("num")
    await m.settle()
    expect(shown(m)).toEqual(["INV-1", "INV-2", "INV-3"])
    await m.store.upsert("view", { id: "the", sort: "amt" })
    await m.settle()
    expect(shown(m)).toEqual(["INV-2", "INV-3", "INV-1"])
    await m.stop()
  })

  it("refuses a key the map does not carry rather than reading unordered", async () => {
    await expect(mount("nope")).rejects.toThrow(/is "nope", which is not one of num, amt/)
  })

  it("refuses a key column the enclosing row lacks", async () => {
    const files = {
      ...FILES,
      "tbl.html": FILES["tbl.html"].replace('"by":"{sort}"', '"by":"{missing}"'),
    }
    await expect(mount("num", files)).rejects.toThrow(/data-order "\{missing\}"/)
  })
})
