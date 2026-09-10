// The projection: derived columns a region states about its own rows.
// The clause set and its refusals are
// plugins/omnishell/docs/2026-09-01-aria-is-columns.md.
//
// What these pin is that the answers reach markup as ordinary columns, that
// they follow a parameter the region's own read never mentions, and that the
// clause set is closed.
import { describe, expect, it } from "@test/harness"
import { type El, mountScreen, type Mounted } from "./screen-harness.ts"

const ROUTE = { screen: "picker", files: { html: "picker.html", css: "picker.css", handlers: [] } }

// A tablist whose tabs are ROWS: which one is selected lives on the enclosing
// choice row as an id, and every tab's aria-* is derived from the comparison.
const FILES = {
  "picker.html": `<section class="screen" data-screen="picker">
    <div data-live="choice" data-filter="id=eq.the">
      <template data-item>
        <div class="frame">
          <div role="tablist" data-live="option" data-order="pos.asc"
               data-project='{"selected":{"eq":["id","{value}"]},"posinset":"index","setsize":"count"}'>
            <template data-item>
              <button type="button" role="tab" id="tab-{id}" aria-selected="{selected}"
                      aria-posinset="{posinset}" aria-setsize="{setsize}" data-text="{label}"></button>
            </template>
          </div>
        </div>
      </template>
    </div>
  </section>`,
  "picker.css": "",
}

const tabs = (m: Mounted) => m.all('[role="tab"]') as El[]
const attr = (m: Mounted, name: string) => tabs(m).map((el) => el.getAttribute(name))

const options = () => [
  { id: "a", label: "Account", pos: 1 },
  { id: "b", label: "Password", pos: 2 },
  { id: "c", label: "Team", pos: 3 },
]

const mount = (value: string, files = FILES) =>
  mountScreen({
    route: ROUTE,
    files,
    tables: { choice: [{ id: "the", value }], option: options() },
    seed: 1,
  })

describe("a region states derived columns about its own rows", () => {
  it("answers the comparison against the enclosing row, for every row", async () => {
    const m = await mount("b")
    await m.settle()
    expect(attr(m, "aria-selected")).toEqual(["false", "true", "false"])
    await m.stop()
  })

  it("counts and numbers the rows in the order the region declares", async () => {
    const m = await mount("b")
    await m.settle()
    // 1-based: aria-posinset is the reader's ordinal, not an array offset.
    expect(attr(m, "aria-posinset")).toEqual(["1", "2", "3"])
    expect(attr(m, "aria-setsize")).toEqual(["3", "3", "3"])
    await m.stop()
  })

  it("selects nothing when the enclosing row names a row that is not there", async () => {
    // Falling back to the first row would show a reader a choice nobody made.
    const m = await mount("gone")
    await m.settle()
    expect(attr(m, "aria-selected")).toEqual(["false", "false", "false"])
    await m.stop()
  })

  it("moves the answers when the enclosing row moves, keeping the nodes", async () => {
    // The read never moves — the tablist's filter carries no placeholder — so
    // nothing but the projection can notice. Node identity is the assertion
    // that this was a re-render and not a re-hydration: a rebuilt list drops
    // the reader's focus, which is the whole point of a roving tabstop.
    const m = await mount("b")
    await m.settle()
    const before = tabs(m)
    await m.store.update("choice", "the", { value: "c" })
    await m.settle()
    expect(attr(m, "aria-selected")).toEqual(["false", "false", "true"])
    expect(tabs(m).every((el, i) => el === before[i])).toBe(true)
    await m.stop()
  })

  it("picks a template arm, so a derived column is an ordinary one downstream", async () => {
    // The projection's answers are merged into the row before templateFor
    // reads it, which is what makes `data-when` work over one — the same
    // mechanism the row-backed tabs use to render exactly one panel.
    const files = {
      ...FILES,
      // The tablist's template, not the choice region's: both open with the
      // same tag, and replacing the first would arm the wrong region.
      "picker.html": FILES["picker.html"].replace(
        `<template data-item>
              <button`,
        `<template data-item data-when="selected=eq.true">
              <button class="on"></button>
            </template>
            <template data-item>
              <button`,
      ),
    }
    const m = await mount("b", files)
    await m.settle()
    // One arm per row, and only the selected row takes the first.
    expect((m.all(".on") as El[]).length).toBe(1)
    expect(tabs(m).length).toBe(2)
    await m.stop()
  })

  it("names each row's neighbours, and clamps rather than wrapping at the ends", async () => {
    // Positional facts like index and count, and the operand a gesture would
    // write. Wrapping is the pattern's decision, not the read tier's: APG wraps
    // some and stops others, so an end names itself and a gesture there writes
    // what is already true.
    const files = {
      ...FILES,
      "picker.html": FILES["picker.html"]
        .replace('"posinset":"index","setsize":"count"', '"nxt":"next","prv":"prev"')
        .replace('aria-posinset="{posinset}"\n                      aria-setsize="{setsize}"', 'data-next="{nxt}" data-prev="{prv}"')
        .replace('aria-posinset="{posinset}" aria-setsize="{setsize}"', 'data-next="{nxt}" data-prev="{prv}"'),
    }
    const m = await mount("b", files)
    await m.settle()
    expect(attr(m, "data-next")).toEqual(["b", "c", "c"])
    expect(attr(m, "data-prev")).toEqual(["a", "a", "b"])
    await m.stop()
  })

  it("renumbers when the row set changes", async () => {
    const m = await mount("b")
    await m.settle()
    await m.store.create("option", { id: "d", label: "Billing", pos: 4 })
    await m.settle()
    expect(attr(m, "aria-setsize")).toEqual(["4", "4", "4", "4"])
    expect(attr(m, "aria-posinset")).toEqual(["1", "2", "3", "4"])
    await m.stop()
  })
})

describe("the clause set is closed", () => {
  const withProject = (spec: string) => ({
    ...FILES,
    "picker.html": FILES["picker.html"].replace(/data-project='[^']*'/, `data-project='${spec}'`),
  })

  it("refuses a clause outside the three", async () => {
    // A projection that could name its own operations is a query language, and
    // the chart stops being the whole inventory of what a screen can do.
    await expect(mount("b", withProject('{"n":{"sum":["pos"]}}'))).rejects.toThrow(/a clause is "index"/)
  })

  it("refuses a derived name a stored column already carries", async () => {
    // Which one a binding read would otherwise depend on the merge order.
    await expect(mount("b", withProject('{"label":"count"}'))).rejects.toThrow(/already a column/)
  })

  it("refuses an eq clause naming a column no row carries", async () => {
    // The silent-wrong case, and the one most likely to be mistyped: answering
    // "false" for a column nobody wrote is a tablist where nothing is ever
    // selected. Same rule the binder holds to for {placeholders}.
    await expect(mount("b", withProject('{"selected":{"eq":["dis","{value}"]}}')))
      .rejects.toThrow(/reads \{dis\}, not in row/)
  })

  it("answers a row whose write is still in flight instead of refusing it", async () => {
    // A binding's carve-out too: an optimistic insert carries only the fields
    // that were submitted, and DB-defaulted columns land when the sync does.
    // Throwing here would take the screen down under the pending row.
    const m = await mountScreen({
      route: ROUTE,
      files: FILES,
      tables: {
        choice: [{ id: "the", value: "b" }],
        option: [...options(), { id: "d", label: "Pending", pos: 4, $synced: false }],
      },
      seed: 1,
    })
    await m.settle()
    expect(attr(m, "aria-selected")).toEqual(["false", "true", "false", "false"])
    await m.stop()
  })

  it("refuses a projection on a slot", async () => {
    const files = {
      ...FILES,
      "picker.html": `<section class="screen" data-screen="picker">
        <div data-live="choice" data-filter="id=eq.the" data-project='{"n":"count"}'>
          <span data-text="{value}"></span>
        </div>
      </section>`,
    }
    await expect(mount("b", files)).rejects.toThrow(/is a slot and declares data-project/)
  })
})
