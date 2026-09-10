// Parallel charts: one region, several `#Machine`s, one row.
//
// A region hosting one chart is why a pattern that needs two facts about the
// same affordances — which item is open, and which one the caret is on — had to
// spread itself over rows or go without. They share the row on purpose: a
// transition writes ONE stated row, and two charts stepping in a tick merge
// into it, so the reader sees one write and not two.
//
// What they must not share is a column. That is `parallelLint`'s, at compile
// time, because two writers over one column have no arbiter and which value
// survives would be which chart stepped last.
import { describe, expect, it } from "@test/harness"
import { mountScreen, type Mounted } from "./screen-harness.ts"
import { parallelLint } from "../interpreter/lint.ts"

const ROUTE = { screen: "acc", files: { html: "acc.html", css: "acc.css", handlers: [] } }

// The accordion's shape: expansion is one chart over `open`, the caret another
// over `caret`, and both narrow their arrows to the same two headers.
const EXPANSION = {
  field: "open",
  initial: "none",
  context: { exp_one: "false", exp_two: "false" },
  states: {
    none: {
      on: {
        "click@h-one": { target: "one", assign: { exp_one: "true", exp_two: "false" } },
        "click@h-two": { target: "two", assign: { exp_one: "false", exp_two: "true" } },
      },
    },
    one: {
      on: {
        "click@h-one": { target: "none", assign: { exp_one: "false", exp_two: "false" } },
        "click@h-two": { target: "two", assign: { exp_one: "false", exp_two: "true" } },
      },
    },
    two: {
      on: {
        "click@h-one": { target: "one", assign: { exp_one: "true", exp_two: "false" } },
        "click@h-two": { target: "none", assign: { exp_one: "false", exp_two: "false" } },
      },
    },
  },
}

const CARET = {
  field: "caret",
  initial: "one",
  context: { cur_one: "true", cur_two: "false" },
  states: {
    one: {
      on: {
        "keydown@h-one": [{ target: "two", assign: { cur_one: "false", cur_two: "true" } }],
        "focusin@h-two": { target: "two", assign: { cur_one: "false", cur_two: "true" } },
      },
    },
    two: {
      on: {
        "keydown@h-two": [{ target: "one", assign: { cur_one: "true", cur_two: "false" } }],
        "focusin@h-one": { target: "one", assign: { cur_one: "true", cur_two: "false" } },
      },
    },
  },
}

const files = (charts: unknown = [EXPANSION, CARET]) => ({
  "acc.html": `<section class="screen" data-screen="acc">
    <div class="acc" data-live="acc_demo" data-filter="id=eq.the"
         data-machine='${JSON.stringify(charts)}'>
      <button type="button" id="h-one" aria-expanded="{exp_one}" data-focus="{cur_one}">One</button>
      <button type="button" id="h-two" aria-expanded="{exp_two}" data-focus="{cur_two}">Two</button>
    </div>
  </section>`,
  "acc.css": "",
})

/** No seeded row: the fallback the charts synthesize between them is what the
 * first write states, which is the case this has to cover. */
const mount = (charts: unknown = [EXPANSION, CARET]) =>
  mountScreen({ route: ROUTE, files: files(charts), tables: { acc_demo: [] }, seed: 1 })

const read = (m: Mounted) => {
  const row = m.rows("acc_demo")[0] ?? {}
  return { open: row.open, caret: row.caret, exp: [row.exp_one, row.exp_two], cur: [row.cur_one, row.cur_two] }
}

const press = (m: Mounted, id: string, key: string) => {
  const el = m.one(`#${id}`) as unknown as { dispatchEvent(e: unknown): void }
  const E = (globalThis as unknown as { document: { defaultView: { Event: new (t: string, i: object) => object } } })
    .document.defaultView.Event
  const ev = new E("keydown", { bubbles: true })
  Object.defineProperty(ev, "key", { value: key })
  el.dispatchEvent(ev)
}

describe("two charts, one row", () => {
  it("synthesizes a fallback row carrying every chart's initial world", async () => {
    // Neither chart's context may be lost to the other's: the row a first write
    // states is the union, or whichever chart moved first would put a row
    // missing the other's columns and the bindings would fail on the next pass.
    const m = await mount()
    await m.settle()
    expect((m.one("#h-one") as unknown as { getAttribute(n: string): string }).getAttribute("aria-expanded"))
      .toBe("false")
    expect((m.one("#h-one") as unknown as { getAttribute(n: string): string }).getAttribute("data-focus"))
      .toBe("true")
    await m.stop()
  })

  it("lets each chart move without disturbing the other", async () => {
    const m = await mount()
    await m.settle()

    press(m, "h-one", "ArrowDown")
    await m.settle()
    // The caret moved and the expansion did not, though both charts heard the
    // same region and both narrow to the same header.
    expect(read(m)).toEqual({ open: "none", caret: "two", exp: ["false", "false"], cur: ["false", "true"] })

    m.fire("#h-two", "click")
    await m.settle()
    expect(read(m)).toEqual({ open: "two", caret: "two", exp: ["false", "true"], cur: ["false", "true"] })
    await m.stop()
  })

  it("keeps the row whole when one chart writes it", async () => {
    // The hazard a shared row has: a write states a row, and a chart that
    // stated only its own columns would drop its sibling's.
    const m = await mount()
    await m.settle()
    m.fire("#h-one", "click")
    await m.settle()
    press(m, "h-one", "ArrowDown")
    await m.settle()
    expect(read(m)).toEqual({ open: "one", caret: "two", exp: ["true", "false"], cur: ["false", "true"] })
    expect(m.rows("acc_demo").length).toBe(1)
    await m.stop()
  })

  it("gives one region one row however many charts run on it", async () => {
    const m = await mount()
    await m.settle()
    press(m, "h-one", "ArrowDown")
    m.fire("#h-two", "click")
    await m.settle()
    expect(m.rows("acc_demo").length).toBe(1)
    await m.stop()
  })
})

describe("what parallel charts may not share", () => {
  it("refuses two charts over one field at mount", async () => {
    // Everything the runtime keys per chart is keyed by field: the listener
    // flags, the timer generation, the armed state. Two over one field would
    // silently take each other's.
    const twin = { ...CARET, field: "open" }
    await expect(mount([EXPANSION, twin])).rejects.toThrow(/two charts run over the field "open"/)
  })

  it("refuses two charts writing one column", () => {
    const greedy = { ...CARET, states: { ...CARET.states, one: { on: { "click@h-one": { target: "two", assign: { exp_one: "true" } } } } } }
    expect(parallelLint([EXPANSION, greedy])).toMatch(/both write "exp_one"/)
  })

  it("passes charts whose columns are disjoint", () => {
    expect(parallelLint([EXPANSION, CARET])).toBe(null)
  })

  it("counts the field as a column a chart writes", () => {
    // It is one: the transition's target lands there. A rule that judged only
    // the assigns would let a chart's field be another's derived column.
    const shadow = { field: "x", initial: "a", context: {}, states: { a: { on: { "click@h-one": { target: "a", assign: { caret: "one" } } } } } }
    expect(parallelLint([CARET, shadow])).toMatch(/both write "caret"/)
  })
})
