// A list region binds a freshly stamped row by its template's binding plan
// rather than by walking every element of the row. What has to hold is what
// the walk gave: every bound attribute, data-text and owned data-on-* of every
// row is reached exactly once, at any depth; a nested region's markup is left
// to the nested region; and whatever sits under a data-text-format element is
// still wired for the item. These tests state it as a reader would see it —
// text, attributes, and which write a click causes — not as the plan's shape.
import { describe, expect, it } from "@test/harness"
import { mountScreen, writes } from "./screen-harness.ts"

// A click records WHO was clicked and ON WHICH row as a row in `log`, so a
// test can say which affordance fired with which id, and a double-wired
// affordance shows as a second write.
const TAP = `(state, event) => ({
  updates: [{ op: "put", entity: "log", id: event.id + "/" + event.from, row: { id: event.id + "/" + event.from } }],
})`

const ROUTE = {
  screen: "grid",
  files: { html: "grid.html", css: "grid.css", handlers: ["shell/handlers/tap.js"] },
}

// The store learns a table's columns from its rows, so one row stands from the
// start and the rest are created, which is the path under test.
const ROWS = [
  { id: "r1", pos: 1, label: "one", sel: "on" },
  { id: "r2", pos: 2, label: "two", sel: "off" },
  { id: "r3", pos: 3, label: "three", sel: "on" },
]

const SEED = ROWS[0]

describe("a list row bound from its template's plan", () => {
  const FILES = {
    "grid.html": `<section class="screen" data-screen="grid">
      <div id="grid" data-live="cell" data-order="pos.asc" data-handler="tap" data-reads="cell">
        <template data-item>
          <div class="row {sel}" data-sel="{sel}">
            <span class="name" data-text="{label}"></span>
            <div class="a"><div class="b"><p class="c">
              <button type="button" id="deep" class="deep" title="open {label}" data-on-click="tap">x</button>
            </p></div></div>
            <button type="button" id="top" class="top" data-on-click="tap">y</button>
            <span><i class="note" data-text="n:{pos}"></i></span>
          </div>
        </template>
      </div>
    </section>`,
    "grid.css": "",
    "shell/handlers/tap.js": TAP,
  }
  const mount = async () => {
    const m = await mountScreen({ route: ROUTE, files: FILES, tables: { cell: [SEED], log: [] }, seed: 1 })
    await m.settle()
    for (const row of ROWS.slice(1)) await m.store.create("cell", row)
    await m.settle()
    return m
  }

  it("shows each created row its own text, bound attributes and nested cells", async () => {
    const m = await mount()
    try {
      expect(m.texts(".name")).toEqual(["one", "two", "three"])
      expect(m.texts(".note")).toEqual(["n:1", "n:2", "n:3"])
      expect(m.all(".row").map((r) => r.getAttribute("class"))).toEqual(["row on", "row off", "row on"])
      expect(m.all(".row").map((r) => r.getAttribute("data-sel"))).toEqual(["on", "off", "on"])
      expect(m.all(".deep").map((b) => b.getAttribute("title"))).toEqual(["open one", "open two", "open three"])
    } finally { await m.stop() }
  })

  it("runs the declared handler with the row's id from an affordance nested deep in the row", async () => {
    const m = await mount()
    try {
      m.fire('.row[data-id="r2"] .deep')
      await m.settle()
      expect(m.rows("log").map((r) => r.id)).toEqual(["r2/deep"])
    } finally { await m.stop() }
  })

  it("runs the handler with the row's id from an affordance at the row's top level", async () => {
    const m = await mount()
    try {
      m.fire('.row[data-id="r3"] .top')
      await m.settle()
      expect(m.rows("log").map((r) => r.id)).toEqual(["r3/top"])
    } finally { await m.stop() }
  })

  it("fires one write per click, however many passes have run since the row arrived", async () => {
    const m = await mount()
    try {
      // A later row arriving and an update to this one are further passes.
      await m.store.create("cell", { id: "r4", pos: 4, label: "four", sel: "off" })
      await m.store.update("cell", "r1", { label: "uno" })
      await m.settle()
      const before = writes(m).length
      m.fire('.row[data-id="r1"] .deep')
      await m.settle()
      expect(writes(m).length - before).toBe(1)
      expect(m.rows("log").map((r) => r.id)).toEqual(["r1/deep"])
    } finally { await m.stop() }
  })

  it("updates a row's text and bound attributes after it was created", async () => {
    const m = await mount()
    try {
      await m.store.update("cell", "r2", { label: "deux", sel: "on", pos: 20 })
      await m.settle()
      expect(m.one('.row[data-id="r2"] .name').textContent).toBe("deux")
      expect(m.one('.row[data-id="r2"] .note').textContent).toBe("n:20")
      expect(m.one('.row[data-id="r2"]').getAttribute("class")).toBe("row on")
      expect(m.one('.row[data-id="r2"] .deep').getAttribute("title")).toBe("open deux")
      // The untouched rows keep theirs.
      expect(m.one('.row[data-id="r1"] .name').textContent).toBe("one")
      expect(m.one('.row[data-id="r3"]').getAttribute("class")).toBe("row on")
    } finally { await m.stop() }
  })

  it("still answers a click on a row after that row was updated", async () => {
    const m = await mount()
    try {
      await m.store.update("cell", "r2", { label: "deux" })
      await m.settle()
      m.fire('.row[data-id="r2"] .top')
      await m.settle()
      expect(m.rows("log").map((r) => r.id)).toEqual(["r2/top"])
    } finally { await m.stop() }
  })
})

describe("a row that holds a nested region", () => {
  const FILES = {
    "grid.html": `<section class="screen" data-screen="grid">
      <div id="grid" data-live="cell" data-order="pos.asc" data-handler="tap" data-reads="cell">
        <template data-item>
          <div class="row" data-tag="{label}">
            <span class="name" data-text="{label}"></span>
            <button type="button" id="outer" class="outer" data-on-click="tap">o</button>
            <div class="kids" data-live="child" data-order="pos.asc" data-handler="tap" data-reads="child">
              <template data-item>
                <p class="kid" data-tag="{label}">
                  <span class="kname" data-text="{label}"></span>
                  <button type="button" id="inner" class="inner" data-on-click="tap">i</button>
                </p>
              </template>
            </div>
          </div>
        </template>
      </div>
    </section>`,
    "grid.css": "",
    "shell/handlers/tap.js": TAP,
  }
  const mount = async () => {
    const m = await mountScreen({
      route: ROUTE,
      files: FILES,
      tables: {
        cell: [{ id: "p1", pos: 1, label: "parent" }],
        child: [{ id: "k1", pos: 1, label: "kid" }],
        log: [],
      },
      seed: 1,
    })
    await m.settle()
    return m
  }

  it("renders the nested region's own rows, bound from its own table", async () => {
    const m = await mount()
    try {
      expect(m.texts(".name")).toEqual(["parent"])
      expect(m.texts(".kname")).toEqual(["kid"])
      expect(m.one(".kid").getAttribute("data-tag")).toBe("kid")
      expect(m.one(".row").getAttribute("data-tag")).toBe("parent")
    } finally { await m.stop() }
  })

  it("reaches a nested row's affordance with the nested row's id, not the outer row's", async () => {
    const m = await mount()
    try {
      m.fire(".inner")
      await m.settle()
      expect(m.rows("log").map((r) => r.id)).toEqual(["k1/inner"])
    } finally { await m.stop() }
  })

  it("still wires the outer row's own affordance with the outer id, once", async () => {
    const m = await mount()
    try {
      m.fire(".outer")
      await m.settle()
      expect(m.rows("log").map((r) => r.id)).toEqual(["p1/outer"])
    } finally { await m.stop() }
  })

  it("keeps a nested row's bound attribute its own when the outer row changes", async () => {
    const m = await mount()
    try {
      await m.store.update("cell", "p1", { label: "changed" })
      await m.settle()
      expect(m.one(".row").getAttribute("data-tag")).toBe("changed")
      expect(m.one(".kid").getAttribute("data-tag")).toBe("kid")
      expect(m.texts(".kname")).toEqual(["kid"])
    } finally { await m.stop() }
  })
})

describe("a row with a data-text-format element in it", () => {
  const FILES = {
    "grid.html": `<section class="screen" data-screen="grid">
      <div id="grid" data-live="cell" data-order="pos.asc" data-handler="tap" data-reads="cell">
        <template data-item>
          <div class="row">
            <span class="name" data-text="{label}"></span>
            <div class="fmt" data-text-format="plain">
              <section><button type="button" id="under" class="under" title="{label}" data-on-click="tap">u</button></section>
            </div>
            <button type="button" id="after" class="after" data-on-click="tap">a</button>
          </div>
        </template>
      </div>
    </section>`,
    "grid.css": "",
    "shell/handlers/tap.js": TAP,
  }
  const mount = async () => {
    const m = await mountScreen({
      route: ROUTE,
      files: FILES,
      tables: { cell: [{ id: "f1", pos: 1, label: "first" }, { id: "f2", pos: 2, label: "second" }], log: [] },
      seed: 1,
    })
    await m.settle()
    return m
  }

  it("wires an owned affordance below the format element with its row's id", async () => {
    const m = await mount()
    try {
      m.fire('.row[data-id="f2"] .under')
      await m.settle()
      expect(m.rows("log").map((r) => r.id)).toEqual(["f2/under"])
    } finally { await m.stop() }
  })

  it("wires it once, and leaves the sibling after the format element wired too", async () => {
    const m = await mount()
    try {
      await m.store.update("cell", "f1", { label: "uno" })
      await m.settle()
      const before = writes(m).length
      m.fire('.row[data-id="f1"] .under')
      m.fire('.row[data-id="f1"] .after')
      await m.settle()
      expect(writes(m).length - before).toBe(2)
      expect(m.rows("log").map((r) => r.id).sort()).toEqual(["f1/after", "f1/under"])
    } finally { await m.stop() }
  })

  it("leaves a placeholder below the format element literal, as formatted content is not a binding", async () => {
    const m = await mount()
    try {
      expect(m.all(".under").map((b) => b.getAttribute("title"))).toEqual(["{label}", "{label}"])
      expect(m.texts(".name")).toEqual(["first", "second"])
    } finally { await m.stop() }
  })
})
