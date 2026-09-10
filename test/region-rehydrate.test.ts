// A nested LIST region that re-hydrates keeps being a list.
//
// Its own render replaces its children with the rows it drew, so by the time
// the enclosing row moves its read — a filter or an order — the item templates
// are no longer in the DOM under it. Read off the DOM a second time they come
// back empty, and an empty template set is how a SLOT is spelled: the region
// silently stops being a list. At one matching row that is invisible, because a
// slot binds one row and draws the right thing; at two it is a cardinality
// error out of a screen whose markup never changed.
import { describe, expect, it } from "@test/harness"
import { type El, mountScreen } from "./screen-harness.ts"

const ROUTE = { screen: "tbl", files: { html: "tbl.html", css: "tbl.css", handlers: [] } }

const withRead = (read: string) => ({
  "tbl.html": `<section class="screen" data-screen="tbl">
    <div data-live="view" data-filter="id=eq.the">
      <template data-item>
        <div class="frame">
          <ul data-live="invoice" ${read}>
            <template data-item><li data-text="{number}"></li></template>
          </ul>
        </div>
      </template>
    </div>
  </section>`,
  "tbl.css": "",
})

const invoices = [
  { id: "a", number: "INV-1", bucket: "x", amount: 20 },
  { id: "b", number: "INV-2", bucket: "y", amount: 90 },
  { id: "c", number: "INV-3", bucket: "y", amount: 50 },
]

const mount = (read: string, pick: string) =>
  mountScreen({
    route: ROUTE,
    files: withRead(read),
    tables: { view: [{ id: "the", pick }], invoice: invoices },
    seed: 1,
  })

const shown = (m: { all(s: string): unknown }) => (m.all("li") as El[]).map((e) => e.textContent)

describe("a re-read nested region stays a list", () => {
  it("renders every matching row after its filter moves, not just one", async () => {
    // "x" matches one row and "y" matches two. Re-hydrating into the slot
    // branch draws the single "x" correctly and then throws on "y", so a suite
    // that only ever moved between one-row filters would call this healthy.
    const m = await mount('data-filter="bucket=eq.{pick}" data-order="number.asc"', "x")
    await m.settle()
    expect(shown(m)).toEqual(["INV-1"])
    await m.store.upsert("view", { id: "the", pick: "y" })
    await m.settle()
    expect(shown(m)).toEqual(["INV-2", "INV-3"])
    await m.stop()
  })

  it("renders every row after its order moves", async () => {
    const m = await mount(
      `data-order='{"by":"{pick}","of":{"n":"number.asc","a":"amount.desc"}}'`,
      "n",
    )
    await m.settle()
    expect(shown(m)).toEqual(["INV-1", "INV-2", "INV-3"])
    await m.store.upsert("view", { id: "the", pick: "a" })
    await m.settle()
    expect(shown(m)).toEqual(["INV-2", "INV-3", "INV-1"])
    await m.stop()
  })

  it("keeps a slot a slot across the same move", async () => {
    // The stash must not turn an empty template set into a list: a region with
    // no template of its own is how a slot is declared, and re-hydration has to
    // preserve that reading rather than repair it.
    const files = {
      "tbl.html": `<section class="screen" data-screen="tbl">
        <div data-live="view" data-filter="id=eq.the">
          <template data-item>
            <div class="frame">
              <b data-live="invoice" data-filter="id=eq.{pick}" data-text="{number}"></b>
            </div>
          </template>
        </div>
      </section>`,
      "tbl.css": "",
    }
    const m = await mountScreen({
      route: ROUTE,
      files,
      tables: { view: [{ id: "the", pick: "a" }], invoice: invoices },
      seed: 1,
    })
    await m.settle()
    expect((m.one("b") as El).textContent).toBe("INV-1")
    await m.store.upsert("view", { id: "the", pick: "c" })
    await m.settle()
    expect((m.one("b") as El).textContent).toBe("INV-3")
    await m.stop()
  })
})

// The same move, with the nested region's OWN table written in the same settle
// — the shape every app that marks a picker's current segment has, since the
// mark is a column of the rows the picker renders.
const MARK = `(state) => {
  const view = (state.rows.view ?? []).find((r) => r.id === "the");
  const updates = [];
  for (const r of state.rows.invoice ?? []) {
    const on = String(r.bucket === view.pick);
    if (String(r.on) !== on) updates.push({ op: "patch", entity: "invoice", id: r.id, row: { on } });
  }
  return { updates };
}`

const SEATED = {
  "seat.html": `<section class="screen" data-screen="seat">
    <div class="seat" data-live="view" data-filter="id=eq.the"
         data-on-mutation="mark" data-reads="invoice,view">
      <template data-item><b data-text="{pick}"></b></template>
    </div>
    <div data-live="view" data-filter="id=eq.the">
      <template data-item>
        <div class="frame">
          <ul data-live="invoice" data-filter="bucket=eq.{pick}" data-order="number.asc">
            <template data-item><li data-text="{number}"></li></template>
          </ul>
        </div>
      </template>
    </div>
  </section>`,
  "seat.css": "",
  "mark.js": MARK,
}

describe("a nested region whose own table is written as its read moves", () => {
  it("shows the rows of the read it has, not of the read it had", async () => {
    // The outgoing handle is replaced the moment the parent's row moves, and it
    // may have a query in flight into the very element the incoming handle has
    // just drawn: the loser of that race is whichever resolved first, which is
    // the one holding the current read. Nothing repairs it afterwards, either —
    // the handle that owns the element will not render again until its table
    // changes, so the region keeps the previous read's rows for good. A picker
    // whose current segment is a fold-stamped column writes that table on every
    // move, so this is that picker one gesture behind, permanently.
    const m = await mountScreen({
      route: { screen: "seat", files: { html: "seat.html", css: "seat.css", handlers: ["mark.js"] } },
      files: SEATED,
      tables: { view: [{ id: "the", pick: "x" }], invoice: invoices.map((r) => ({ ...r, on: "false" })) },
      seed: 1,
    })
    await m.settle()
    expect(shown(m)).toEqual(["INV-1"])
    await m.store.upsert("view", { id: "the", pick: "y" })
    await m.settle()
    expect(shown(m)).toEqual(["INV-2", "INV-3"])
    await m.stop()
  })
})
