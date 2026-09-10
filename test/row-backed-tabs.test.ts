// The worked example behind plugins/omnishell/docs/2026-09-01-aria-is-columns.md:
// a tablist whose tabs are ROWS. What the doc argues, this runs.
//
// There is no machine on the screen. The shipped #Tabs needs one state per
// tab, N(N-1) arrows and N literal assigns on each of them, and every one of
// those assigns is the comparison this region states once.
import { describe, expect, it } from "@test/harness"
import { type El, mountScreen, type Mounted } from "./screen-harness.ts"

const ROUTE = { screen: "tabs", files: { html: "tabs.html", css: "tabs.css", handlers: [] } }

const FILES = {
  "tabs.html": `<section class="screen" data-screen="tabs">
    <div data-live="tab_choice" data-filter="id=eq.the">
      <template data-item>
        <div class="tabs">
          <div role="tablist" aria-label="Account"
               data-live="tab_option" data-order="pos.asc"
               data-project='{"selected":{"eq":["id","{value}"]},"posinset":"index","setsize":"count"}'>
            <template data-item>
              <form role="none" id="pick-{id}" data-form="pick" data-entity="tab_choice" data-action="upsert">
                <button type="submit" role="tab" id="tab-{id}" aria-selected="{selected}"
                        aria-controls="panel-{id}" aria-posinset="{posinset}"
                        aria-setsize="{setsize}" data-text="{label}"></button>
                <input type="hidden" name="id" data-value="the">
                <input type="hidden" name="value" data-value="{id}">
              </form>
            </template>
          </div>
          <div class="panels" data-live="tab_option" data-order="pos.asc"
               data-project='{"selected":{"eq":["id","{value}"]}}'>
            <template data-item data-when="selected=eq.true">
              <div role="tabpanel" id="panel-{id}" aria-labelledby="tab-{id}" data-text="{body}"></div>
            </template>
            <template data-item>
              <div class="off" hidden></div>
            </template>
          </div>
        </div>
      </template>
    </div>
  </section>`,
  "tabs.css": "",
}

const options = () => [
  { id: "a", label: "Account", body: "Name and handle.", pos: 1 },
  { id: "b", label: "Password", body: "Change it here.", pos: 2 },
  { id: "c", label: "Team", body: "Who else is in.", pos: 3 },
]

const mount = (value: string) =>
  mountScreen({
    route: ROUTE,
    files: FILES,
    tables: { tab_choice: [{ id: "the", value }], tab_option: options() },
    seed: 1,
  })

const tabs = (m: Mounted) => m.all('[role="tab"]') as El[]
const panels = (m: Mounted) => m.all('[role="tabpanel"]') as El[]
const attr = (m: Mounted, name: string) => tabs(m).map((el) => el.getAttribute(name))

describe("a tablist whose tabs are rows", () => {
  it("marks exactly the tab the choice row names", async () => {
    const m = await mount("b")
    await m.settle()
    expect(attr(m, "aria-selected")).toEqual(["false", "true", "false"])
    expect(attr(m, "aria-posinset")).toEqual(["1", "2", "3"])
    expect(attr(m, "aria-setsize")).toEqual(["3", "3", "3"])
    await m.stop()
  })

  it("renders one panel, and the two id references point at each other", async () => {
    // A tabpanel per row would be three panels and two of them lies: APG's
    // tabpanel is the one the selected tab controls. The arm is picked by the
    // same derived column the tab's aria-selected binds, so the panel cannot
    // disagree with the tab.
    const m = await mount("b")
    await m.settle()
    expect(panels(m).length).toBe(1)
    const panel = panels(m)[0]
    expect(panel.getAttribute("id")).toBe("panel-b")
    expect(panel.getAttribute("aria-labelledby")).toBe("tab-b")
    const selected = tabs(m).find((el) => el.getAttribute("aria-selected") === "true")!
    expect(selected.getAttribute("aria-controls")).toBe(panel.getAttribute("id"))
    expect(selected.getAttribute("id")).toBe(panel.getAttribute("aria-labelledby"))
    await m.stop()
  })

  it("moves the whole contract when the tab is picked, writing one column", async () => {
    const m = await mount("b")
    await m.settle()
    m.fire("#pick-c", "submit")
    await m.settle()

    // One write, one column: the choice row learned which tab, and no option
    // row was touched. The shipped #Tabs writes N columns on every arrow.
    expect(m.store.rows("tab_choice")).toEqual([{ id: "the", value: "c" }])
    expect(m.store.rows("tab_option")).toEqual(options())

    expect(attr(m, "aria-selected")).toEqual(["false", "false", "true"])
    expect(panels(m).length).toBe(1)
    expect(panels(m)[0].getAttribute("id")).toBe("panel-c")
    await m.stop()
  })

  it("takes a tab that did not exist when the screen was written", async () => {
    // The point of the row-backed spelling: the option set is data, so a
    // fourth tab is a row. #OneOf cannot express this at all — its states are
    // CUE-time keys, so a machine would have to be recompiled to grow one.
    const m = await mount("b")
    await m.settle()
    await m.store.create("tab_option", { id: "d", label: "Billing", body: "Card on file.", pos: 4 })
    await m.settle()

    expect(attr(m, "aria-setsize")).toEqual(["4", "4", "4", "4"])
    expect(tabs(m)[3].getAttribute("id")).toBe("tab-d")

    m.fire("#pick-d", "submit")
    await m.settle()
    expect(attr(m, "aria-selected")).toEqual(["false", "false", "false", "true"])
    expect(panels(m)[0].getAttribute("id")).toBe("panel-d")
    await m.stop()
  })

  it("selects no tab and renders no panel when the choice names a row that is gone", async () => {
    // Falling back to the first tab would show a reader a choice nobody made,
    // and the panel would say the same thing twice as loudly.
    const m = await mount("b")
    await m.settle()
    await m.store.remove("tab_option", "b")
    await m.settle()
    expect(attr(m, "aria-selected")).toEqual(["false", "false"])
    expect(panels(m).length).toBe(0)
    await m.stop()
  })
})
