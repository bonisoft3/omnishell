// Binding a region costs what its markup costs, not what its markup costs
// times its rows.
//
// The region-level pass walks every descendant to bind the affordances that
// are the REGION's rather than a row's, and has to leave the ones inside an
// item to the per-item pass that knows the row id. Asking each item in turn
// whether it contains the element would be one question per (element, item)
// pair — quadratic in the rows, and invisible until a table is thousands long:
// four thousand rows of this markup come to 72 million Node.contains calls for
// a single append, and 2.4 seconds of a 2.5-second one.
//
// Node.contains is what is counted because it is the shape of the mistake: a
// containment test per pair rather than per element. The ownership walk every
// element already pays can answer it on the way past instead.
import { describe, expect, it } from "@test/harness"
import { mountScreen } from "./screen-harness.ts"

const ROUTE = { screen: "grid", files: { html: "grid.html", css: "grid.css", handlers: [] } }

// Nine elements a row, which is what a benchmark table's four cells and its
// remove control come to, so the count here is the count an app pays.
const FILES = {
  "grid.html": `<section class="screen" data-screen="grid">
    <div id="grid" data-live="cell" data-order="pos.asc">
      <template data-item>
        <div class="row">
          <span data-text="{pos}"></span>
          <span><a class="lbl" data-text="{label}"></a></span>
          <span>
            <form data-form="drop" data-entity="cell" data-action="delete">
              <button type="submit" class="drop"><span class="x"></span></button>
            </form>
          </span>
          <span></span>
        </div>
      </template>
    </div>
  </section>`,
  "grid.css": "",
}

/** The prototype in `el`'s chain that owns `name`. Assigning to the immediate
 * prototype would count only calls on elements of the mount's own type, and
 * contains is called on the items. */
const ownerOf = (el: object, name: string): Record<string, unknown> => {
  for (let p = Object.getPrototypeOf(el); p !== null; p = Object.getPrototypeOf(p)) {
    if (Object.prototype.hasOwnProperty.call(p, name)) return p as Record<string, unknown>
  }
  throw new Error(`no prototype in the chain owns ${name}`)
}

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: String(i), pos: i, label: `row ${i}` }))

/** Calls of one DOM method made appending one row to a region of `n` items,
 * which is what one append to a table that long costs. */
const callsToAppend = async (n: number, method: string): Promise<number> => {
  const m = await mountScreen({ route: ROUTE, files: FILES, tables: { cell: rows(n) }, seed: 1 })
  await m.settle()
  const proto = ownerOf(m.mount, method)
  const real = proto[method] as (...args: unknown[]) => unknown
  let calls = 0
  proto[method] = function (this: unknown, ...args: unknown[]) {
    calls += 1
    return real.apply(this, args)
  }
  try {
    await m.store.create("cell", { id: String(n), pos: n, label: `row ${n}` })
    await m.settle()
  } finally {
    proto[method] = real
    await m.stop()
  }
  return calls
}

describe("binding a region", () => {
  it("asks a containment question per element, not per element and row", async () => {
    const small = await callsToAppend(100, "contains")
    const large = await callsToAppend(400, "contains")
    // Four times the rows is four times the work, give or take the fixed cost
    // of the screen around the region. Quadratic would be sixteen.
    expect(large).toBeLessThan(small * 6 + 100)
  })

  it("asks the arriving row what it binds, not every row on every write", async () => {
    // A surviving row was bound and wired when it arrived, so the pass that
    // adds one row queries the arrival alone.
    const small = await callsToAppend(100, "querySelectorAll")
    const large = await callsToAppend(400, "querySelectorAll")
    // One row arrived either time; the rows already standing cost nothing.
    expect(large).toBe(small)
  })
})
