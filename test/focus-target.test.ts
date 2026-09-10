// `data-focus`: move focus to the member a column names, and leave the tab
// order alone.
//
// The split from `data-rove` is APG's own. Some patterns get one tab stop and
// arrows that move it; an accordion's headers are ALL in the Tab sequence and
// the arrows are an addition. Stamping a tabstop there would take headers out
// of the sequence — a worse contract than the one it replaced — so the two
// effects the terminal fused have to come apart.
//
// Nothing is remembered here: the DOM holds where focus is, so the rule reads
// it. What keeps the terminal and the reader from fighting over it is
// `focusin`, and focusLint refuses a region that does not hear it.
import { describe, expect, it } from "@test/harness"
import { type El, mountScreen, type Mounted } from "./screen-harness.ts"
import { focusLint, stopRegions } from "../interpreter/lint.ts"

const ROUTE = { screen: "acc", files: { html: "acc.html", css: "acc.css", handlers: [] } }

// One region, one row, three headers. The caret is a column; the tab order is
// the document's and the terminal never touches it.
const CHART = {
  field: "caret",
  initial: "one",
  context: { cur_one: "true", cur_two: "false", cur_three: "false" },
  states: {
    one: {
      on: {
        "keydown@h-one": [{ target: "two", assign: { cur_one: "false", cur_two: "true", cur_three: "false" } }],
        "focusin@h-two": { target: "two", assign: { cur_one: "false", cur_two: "true", cur_three: "false" } },
        "focusin@h-three": { target: "three", assign: { cur_one: "false", cur_two: "false", cur_three: "true" } },
      },
    },
    two: {
      on: {
        "keydown@h-two": [{ target: "three", assign: { cur_one: "false", cur_two: "false", cur_three: "true" } }],
        "focusin@h-one": { target: "one", assign: { cur_one: "true", cur_two: "false", cur_three: "false" } },
        "focusin@h-three": { target: "three", assign: { cur_one: "false", cur_two: "false", cur_three: "true" } },
      },
    },
    three: {
      on: {
        "focusin@h-one": { target: "one", assign: { cur_one: "true", cur_two: "false", cur_three: "false" } },
        "focusin@h-two": { target: "two", assign: { cur_one: "false", cur_two: "true", cur_three: "false" } },
      },
    },
  },
}

const files = (machine: unknown = CHART) => ({
  "acc.html": `<section class="screen" data-screen="acc">
    <button id="outside" type="button">outside</button>
    <div class="acc" data-live="acc_demo" data-filter="id=eq.the"
         data-machine='${JSON.stringify(machine)}'>
      <button type="button" id="h-one" data-focus="{cur_one}">One</button>
      <button type="button" id="h-two" data-focus="{cur_two}">Two</button>
      <button type="button" id="h-three" data-focus="{cur_three}">Three</button>
    </div>
  </section>`,
  "acc.css": "",
})

const row = (caret: string) => ({
  id: "the",
  caret,
  cur_one: String(caret === "one"),
  cur_two: String(caret === "two"),
  cur_three: String(caret === "three"),
})

const mount = (caret = "one", machine: unknown = CHART) =>
  mountScreen({ route: ROUTE, files: files(machine), tables: { acc_demo: [row(caret)] }, seed: 1 })

/** linkedom has no activeElement, so the harness keeps the one this tier can
 * observe: which element the terminal last called focus() on, and which the
 * test has said the reader is standing on. */
const watch = (m: Mounted) => {
  const seen: string[] = []
  for (const el of m.all("button") as unknown as { getAttribute(n: string): string; focus(): void }[]) {
    el.focus = () => void seen.push(el.getAttribute("id"))
  }
  return seen
}

/** Put the reader somewhere. linkedom answers `contains` faithfully, which is
 * the half of the rule this tier can drive; activeElement it does not model, so
 * the harness stands one in. */
const readerOn = (m: Mounted, id: string | null) => {
  Object.defineProperty(globalThis.document, "activeElement", {
    configurable: true,
    get: () => (id === null ? null : m.one(`#${id}`)),
  })
}

const press = (m: Mounted, id: string, key: string) => {
  const el = m.one(`#${id}`) as unknown as { dispatchEvent(e: unknown): void }
  const E = (globalThis as unknown as { document: { defaultView: { Event: new (t: string, i: object) => object } } })
    .document.defaultView.Event
  const ev = new E("keydown", { bubbles: true })
  Object.defineProperty(ev, "key", { value: key })
  el.dispatchEvent(ev)
}

describe("the tab order is the document's", () => {
  it("stamps no tabindex on any member", async () => {
    // The whole reason this is not data-rove. An accordion's headers are all in
    // the Tab sequence, and a tabstop would take two of the three out of it.
    const m = await mount()
    await m.settle()
    expect((m.all("[data-focus]") as El[]).map((el) => el.getAttribute("tabindex"))).toEqual([null, null, null])
    await m.stop()
  })
})

describe("focus moves for the caret, and only inside the widget", () => {
  it("follows the caret when the reader is on the wrong member", async () => {
    const m = await mount()
    await m.settle()
    readerOn(m, "h-one")
    const seen = watch(m)
    press(m, "h-one", "ArrowDown")
    await m.settle()
    expect(seen).toEqual(["h-two"])
    await m.stop()
  })

  it("leaves a reader who has left the widget where they are", async () => {
    // Their focus is not this region's business. Without this the caret would
    // reach out of the widget and pull them back into it.
    const m = await mount()
    await m.settle()
    readerOn(m, "outside")
    const seen = watch(m)
    await m.store.update("acc_demo", "the", row("three"))
    await m.settle()
    expect(seen).toEqual([])
    await m.stop()
  })

  it("takes no focus on the first paint", async () => {
    // Nothing inside is focused yet, so the widget is not where the reader is.
    const m = await mount("two")
    readerOn(m, null)
    const seen = watch(m)
    await m.settle()
    expect(seen).toEqual([])
    await m.stop()
  })

  it("does nothing when the reader is already on the member the caret names", async () => {
    const m = await mount("two")
    await m.settle()
    readerOn(m, "h-two")
    const seen = watch(m)
    await m.store.update("acc_demo", "the", row("two"))
    await m.settle()
    expect(seen).toEqual([])
    await m.stop()
  })

  it("records the reader's own move instead of undoing it", async () => {
    // The loop this pattern would otherwise be: every affordance is tabbable,
    // so a reader can stand on a member the column does not name. focusin
    // writes the column, and the disagreement is gone before a refresh can act
    // on it.
    const m = await mount()
    await m.settle()
    readerOn(m, "h-three")
    const seen = watch(m)
    m.fire("#h-three", "focusin")
    await m.settle()
    expect(m.rows("acc_demo")[0].caret).toBe("three")
    expect(seen).toEqual([])
    await m.stop()
  })
})

describe("a chart that cannot hear the reader is refused", () => {
  const entity = {
    table: "acc_demo",
    durability: "tab",
    fields: [
      { name: "id", type: "text", pk: true },
      { name: "caret", type: "text" },
      { name: "cur_one", type: "text" },
      { name: "cur_two", type: "text" },
      { name: "cur_three", type: "text" },
    ],
  }
  const scan = (machine: unknown) => stopRegions(files(machine)["acc.html"], "data-focus")[0]

  it("passes a chart drawing focusin", () => {
    expect(focusLint(scan(CHART), entity)).toBe(null)
  })

  it("refuses one that does not", () => {
    const deaf = {
      ...CHART,
      states: { one: { on: { "keydown@h-one": [{ target: "two", assign: {} }] } }, two: {}, three: {} },
    }
    expect(focusLint(scan(deaf), entity)).toMatch(/without a chart hearing "focusin"/)
  })

  it("still refuses a row a second reader can write", () => {
    expect(focusLint(scan(CHART), { ...entity, durability: "live" })).toMatch(/another reader can write/)
  })
})
