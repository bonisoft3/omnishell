// The roving tabstop: APG's other focus model, and the one that has to reach
// the DOM. Virtual focus (test/virtual-focus.test.ts) keeps focus on the
// container and names the active row with aria-activedescendant, so nothing
// ever calls focus(). Here every item is focusable, one holds the tabstop, and
// the caret moving moves the reader.
//
// What is load-bearing: focus follows the tabstop MOVING — the delta between
// two views — and nothing records who moved it. The reader is also a writer:
// Tab moves focus with no column changing, and every such refresh is one the
// terminal must leave alone. A recorded cause would be state the rows do not
// hold, so a replay and a jump to the same state could take different paths; a
// delta is a function of two views and answers the same either way.
//
// linkedom answers focus() and never sets activeElement, so this tier watches
// the call and the tab order it stamps; that focus lands where it was called is
// the browser's own contract, and the Playwright tier is where it is observed.
import { describe, expect, it } from "@test/harness"
import { type El, mountScreen, type Mounted } from "./screen-harness.ts"
import { focusLint, roveLint, type StopRegion, stopRegions } from "../interpreter/lint.ts"

const ROUTE = { screen: "lb", files: { html: "lb.html", css: "lb.css", handlers: [] } }

const FILES = {
  "lb.html": `<section class="screen" data-screen="lb">
    <div data-live="choice" data-filter="id=eq.the">
      <template data-item>
        <div class="wrap">
          <div role="listbox" id="lb" aria-label="Plan"
               data-key='{"ArrowDown":"nx-{value}","ArrowUp":"pv-{value}"}'
               data-live="option" data-order="pos.asc"
               data-project='{"here":{"eq":["id","{value}"]},"nxt":"next","prv":"prev"}'>
            <template data-item>
              <div role="option" id="opt-{id}" data-rove="{here}"
                   aria-selected="{here}" data-text="{label}"></div>
            </template>
          </div>
          <div hidden data-live="option" data-order="pos.asc" data-project='{"nxt":"next","prv":"prev"}'>
            <template data-item>
              <div class="gestures">
                <form role="none" id="nx-{id}" data-form="nx" data-entity="choice" data-action="upsert">
                  <input type="hidden" name="id" data-value="the">
                  <input type="hidden" name="value" data-value="{nxt}">
                </form>
                <form role="none" id="pv-{id}" data-form="pv" data-entity="choice" data-action="upsert">
                  <input type="hidden" name="id" data-value="the">
                  <input type="hidden" name="value" data-value="{prv}">
                </form>
              </div>
            </template>
          </div>
        </div>
      </template>
    </div>
  </section>`,
  "lb.css": "",
}

const options = () => [
  { id: "a", label: "A", pos: 1 },
  { id: "b", label: "B", pos: 2 },
  { id: "c", label: "C", pos: 3 },
]

const mount = (value: string, files = FILES) =>
  mountScreen({
    route: ROUTE,
    files,
    tables: { choice: [{ id: "the", value }], option: options() },
    seed: 1,
  })

const tabOrder = (m: Mounted) =>
  (m.all('[role="option"]') as El[]).map((el) => `${el.getAttribute("id")}=${el.getAttribute("tabindex")}`)

/** Every focus() the terminal performs, in order. The nodes survive a refresh,
 * so one patch per node holds for the whole run. */
const watchFocus = (m: Mounted): string[] => {
  const seen: string[] = []
  for (const el of m.all('[role="option"]') as unknown as { getAttribute(n: string): string; focus(): void }[]) {
    el.focus = () => void seen.push(el.getAttribute("id"))
  }
  return seen
}

const press = (m: Mounted, key: string) => {
  const el = m.one("#lb") as unknown as { dispatchEvent(e: unknown): void }
  const E = (globalThis as unknown as { document: { defaultView: { Event: new (t: string, i: object) => object } } })
    .document.defaultView.Event
  const ev = new E("keydown", { bubbles: true })
  Object.defineProperty(ev, "key", { value: key })
  el.dispatchEvent(ev)
}

describe("one item holds the tabstop", () => {
  it("puts the current row in the tab order and every other row out of it", async () => {
    const m = await mount("a")
    await m.settle()
    expect(tabOrder(m)).toEqual(["opt-a=0", "opt-b=-1", "opt-c=-1"])
    await m.stop()
  })

  it("moves the tabstop with the caret", async () => {
    const m = await mount("a")
    await m.settle()
    press(m, "ArrowDown")
    await m.settle()
    expect(tabOrder(m)).toEqual(["opt-a=-1", "opt-b=0", "opt-c=-1"])
    await m.stop()
  })

  it("keeps exactly one row in the tab order at every step", async () => {
    // The failure this guards is a second tabstop, which is worse than none:
    // Tab then lands somewhere the arrows do not govern.
    const m = await mount("a")
    await m.settle()
    for (const key of ["ArrowDown", "ArrowDown", "ArrowUp"]) {
      press(m, key)
      await m.settle()
      expect(tabOrder(m).filter((s) => s.endsWith("=0")).length).toBe(1)
    }
    await m.stop()
  })
})

describe("focus follows the tabstop moving", () => {
  it("follows the caret the arrow moved", async () => {
    const m = await mount("a")
    await m.settle()
    const focused = watchFocus(m)
    press(m, "ArrowDown")
    await m.settle()
    expect(focused).toEqual(["opt-b"])
    press(m, "ArrowDown")
    await m.settle()
    expect(focused).toEqual(["opt-b", "opt-c"])
    await m.stop()
  })

  it("takes no focus on a refresh that left the column standing", async () => {
    // The focus-stealing loop, stated as a test: a row arriving moves no
    // tabstop, and a terminal answering it anyway would pull the caret out of
    // whatever the reader had tabbed to.
    const m = await mount("a")
    await m.settle()
    const focused = watchFocus(m)
    await m.store.create("option", { id: "d", label: "D", pos: 4 })
    await m.settle()
    expect(focused).toEqual([])
    // The tabstop still moved with the data, because the tab order is a fact
    // about the rows and not about the reader.
    expect(tabOrder(m)).toEqual(["opt-a=0", "opt-b=-1", "opt-c=-1", "opt-d=-1"])
    await m.stop()
  })

  it("moves nothing when the arrow moved no row", async () => {
    // At the end the lane names the row itself, so the column does not change
    // and neither does the view — there is nothing for a delta to be, and no
    // arming left over for a later refresh to spend either.
    const m = await mount("c")
    await m.settle()
    const focused = watchFocus(m)
    press(m, "ArrowDown")
    await m.settle()
    expect(tabOrder(m)).toEqual(["opt-a=-1", "opt-b=-1", "opt-c=0"])
    await m.store.create("option", { id: "d", label: "D", pos: 4 })
    await m.settle()
    expect(focused).toEqual([])
    await m.stop()
  })

  it("takes no focus on the first paint, however the set arrives", async () => {
    // A set carrying no tabstop yet is arriving, not moving. Focusing here
    // would take the page from whatever the reader opened it on.
    const m = await mount("b")
    const focused = watchFocus(m)
    await m.settle()
    expect(tabOrder(m)).toEqual(["opt-a=-1", "opt-b=0", "opt-c=-1"])
    expect(focused).toEqual([])
    await m.stop()
  })
})

describe("a set has one current member", () => {
  it("refuses two members reading true, whatever shape the region has", async () => {
    // Which one held the tabstop would otherwise be document order, and the
    // reader would find the caret somewhere the columns did not put it. The
    // rule is the set's, not the row's: a list whose rows are the members and
    // a fixed set under one row break the same way.
    const files = {
      ...FILES,
      "lb.html": FILES["lb.html"].replace(`data-project='{"here"`, `data-project='{"here2":"count","here"`)
        .replace(
          `<div role="option" id="opt-{id}" data-rove="{here}"`,
          `<div role="option" id="opt-{id}" data-rove="true"`,
        ),
    }
    await expect(mount("a", files)).rejects.toThrow(/members read data-rove="true"/)
  })
})

// A compile-time item set: N affordances under ONE row, each binding its own
// column. This is how every grouped pattern in the shadcn gallery spells its
// options — a radiogroup, a segmented control, a tablist, an accordion's
// headers — so it is the set constructor the catalog's roving deferral needs.
const SET_ROUTE = { screen: "tg", files: { html: "tg.html", css: "tg.css", handlers: [] } }

const SET_FILES = {
  "tg.html": `<section class="screen" data-screen="tg">
    <div class="tg" data-live="pick" data-filter="id=eq.the">
      <div role="radiogroup" aria-label="Align">
        <button type="button" role="radio" id="tg-left" data-rove="{chk_left}" aria-checked="{chk_left}">L</button>
        <button type="button" role="radio" id="tg-mid" data-rove="{chk_mid}" aria-checked="{chk_mid}">M</button>
        <button type="button" role="radio" id="tg-right" data-rove="{chk_right}" aria-checked="{chk_right}">R</button>
      </div>
    </div>
  </section>`,
  "tg.css": "",
}

const picked = (which: string) => ({
  id: "the",
  chk_left: String(which === "left"),
  chk_mid: String(which === "mid"),
  chk_right: String(which === "right"),
})

const mountSet = (which: string) =>
  mountScreen({ route: SET_ROUTE, files: SET_FILES, tables: { pick: [picked(which)] }, seed: 1 })

const setOrder = (m: Mounted) =>
  (m.all('[role="radio"]') as El[]).map((el) => `${el.getAttribute("id")}=${el.getAttribute("tabindex")}`)

describe("a compile-time item set is one set under one row", () => {
  it("puts the checked member in the tab order and the rest out of it", async () => {
    const m = await mountSet("mid")
    await m.settle()
    expect(setOrder(m)).toEqual(["tg-left=-1", "tg-mid=0", "tg-right=-1"])
    await m.stop()
  })

  it("moves the tabstop when the row's columns move", async () => {
    const m = await mountSet("left")
    await m.settle()
    expect(setOrder(m)).toEqual(["tg-left=0", "tg-mid=-1", "tg-right=-1"])
    await m.store.update("pick", "the", picked("right"))
    await m.settle()
    expect(setOrder(m)).toEqual(["tg-left=-1", "tg-mid=-1", "tg-right=0"])
    await m.stop()
  })

  it("takes no focus on a refresh that left the columns standing", async () => {
    const m = await mountSet("left")
    await m.settle()
    const seen: string[] = []
    for (const el of m.all('[role="radio"]') as unknown as { getAttribute(n: string): string; focus(): void }[]) {
      el.focus = () => void seen.push(el.getAttribute("id"))
    }
    // The row is rewritten with the values it already held: a refresh, and no
    // move for the reader to be taken along by.
    await m.store.update("pick", "the", picked("left"))
    await m.settle()
    expect(seen).toEqual([])
    await m.stop()
  })

  it("follows the tabstop when the row's columns do move", async () => {
    // Safe here for the reason roveLint enforces: a "tab" row has one writer,
    // so a move of this column is this reader's own and nobody else's.
    const m = await mountSet("left")
    await m.settle()
    const seen: string[] = []
    for (const el of m.all('[role="radio"]') as unknown as { getAttribute(n: string): string; focus(): void }[]) {
      el.focus = () => void seen.push(el.getAttribute("id"))
    }
    await m.store.update("pick", "the", picked("right"))
    await m.settle()
    expect(seen).toEqual(["tg-right"])
    await m.stop()
  })

  it("takes every member as the set, where a row would take one", async () => {
    // The refusal inverts between the two constructors, and this is the whole
    // of the difference: N tabstops under one row is the set, not an error.
    const m = await mountSet("mid")
    await m.settle()
    expect(setOrder(m).length).toBe(3)
    await m.stop()
  })
})

describe("the column has one writer, and the tier is where that is decidable", () => {
  const entity = (durability: string) => ({
    table: "pick",
    durability,
    fields: [{ name: "id", type: "text", pk: true }, { name: "chk_left", type: "text" }],
  })
  const html = `<div data-live="pick" data-filter="id=eq.the">` +
    `<button data-rove="{chk_left}"></button></div>`

  const one = (t: string, cols: string[], rest: Partial<StopRegion> = {}) => [{
    table: t,
    columns: cols,
    machine: undefined,
    projected: [],
    outer: undefined,
    ...rest,
  }]

  it("reads the columns a region's tabstops bind", () => {
    expect(stopRegions(html, "data-rove")).toEqual(one("pick", ["chk_left"]))
  })

  it("reads them through whatever the skin wraps them in", () => {
    // The rule judged nothing for as long as it looked at the nearest TAG: a
    // set inside a role="radiogroup", a cell inside a row, a menu item inside
    // its <li> — every real member is wrapped in something, so every one of
    // them was attributed to an element with no table and dropped. A rule
    // that covers nothing and a rule that passes read the same from outside.
    expect(
      stopRegions(
        `<div data-live="pick"><div role="radiogroup"><span><button data-rove="{chk_left}"></button></span></div></div>`,
        "data-rove",
      ),
    ).toEqual(one("pick", ["chk_left"]))
  })

  it("reads them through a template the region renders by name", () => {
    // A region whose rows re-render points at a NAMED template, which lives at
    // the top of the screen rather than inside the region — so the members are
    // declared outside the region they belong to, and a scan reading the
    // markup's nesting alone finds none of them.
    expect(
      stopRegions(
        `<div data-live="pick" data-template="opt"></div>` +
          `<template data-item data-name="opt"><li><button data-rove="{chk_left}"></button></li></template>`,
        "data-rove",
      ),
    ).toEqual(one("pick", ["chk_left"]))
  })

  it("refuses a region naming a template the screen has not got", () => {
    expect(() => stopRegions(`<div data-live="pick" data-template="gone"></div>`, "data-rove")).toThrow(
      /names "gone", which no <template data-name> declares/,
    )
  })

  it("leaves a nested region's tabstops to that region", () => {
    // ownedBy is the runtime's answer to the same question; a scan that read
    // the enclosing region as owning them would judge them against its entity.
    expect(
      stopRegions(
        `<div data-live="outer"><div data-live="inner"><i data-rove="{c}"></i></div></div>`,
        "data-rove",
      ),
    ).toEqual(one("inner", ["c"], { outer: "outer" }))
  })

  it("passes a row the reader owns", () => {
    expect(roveLint(stopRegions(html, "data-rove")[0], entity("tab"))).toBe(null)
    expect(roveLint(stopRegions(html, "data-rove")[0], entity("device"))).toBe(null)
  })

  it("refuses a row a second reader can write", () => {
    // Focus follows the delta and asks nothing about who caused it, which is
    // exact only while the answer cannot be anyone else.
    expect(roveLint(stopRegions(html, "data-rove")[0], entity("live"))).toMatch(/another reader can write/)
    expect(roveLint(stopRegions(html, "data-rove")[0], entity("server"))).toMatch(/a "server" table/)
  })

  it("refuses a tabstop over a column the entity has not got", () => {
    const region = stopRegions(`<div data-live="pick"><b data-rove="{nope}"></b></div>`, "data-rove")[0]
    expect(roveLint(region, entity("tab"))).toMatch(/binds "nope" — not a field/)
  })
})

// A caret over ROWS names its current member with a projection, because which
// row is current is not a fact any one of them holds. Nothing writes that
// answer — the region recomputes it from the rows it is holding — so the
// question the rule asks moves to the row the projection compares against.
describe("a caret the region computes", () => {
  const points = (durability: string) => ({
    table: "point",
    durability,
    fields: [{ name: "id", type: "text", pk: true }, { name: "value", type: "int" }],
  })
  const cursor = (durability: string) => ({
    table: "cursor",
    durability,
    fields: [{ name: "id", type: "text", pk: true }, { name: "active", type: "text" }],
  })
  const plot = `<div data-live="cursor" data-filter="id=eq.the"><div data-live="point"` +
    ` data-project='{"act":{"eq":["id","{active}"]},"nxt":"next"}'>` +
    `<td><button data-rove="{act}"></button></td></div></div>`
  const region = () => stopRegions(plot, "data-rove")[0]

  it("admits an answer the projection supplies", () => {
    // `act` is no column of `point` and never will be: a projected answer is
    // the region's own, recomputed on every read, which is the one-writer
    // property the rule wants reached by having no writer at all.
    expect(region().projected).toEqual(["act", "nxt"])
    expect(roveLint(region(), points("tab"), cursor("tab"))).toBe(null)
  })

  it("refuses one whose enclosing row a second reader can write", () => {
    // The rows are this reader's and the caret still is not: `{active}` comes
    // from the row the plot is nested in, so that row is what moves it.
    expect(roveLint(region(), points("tab"), cursor("live"))).toMatch(/"cursor"/)
  })

  it("still refuses a name nothing supplies", () => {
    const bare = stopRegions(`<div data-live="point"><td><b data-rove="{act}"></b></td></div>`, "data-rove")[0]
    expect(roveLint(bare, points("tab"))).toMatch(/not an answer its projection supplies/)
  })
})
