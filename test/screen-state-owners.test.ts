// Who moves the screen's state when a slot and a list are both top-level.
//
// A slot's row arriving takes the screen out of `loading` (or back from
// `gone`): without it a singleton screen stays on its loading frame. It does
// not get to say `populated` over a list that has just emptied: the list's own
// count is the screen's state, and a slot re-rendering beside it once stood
// the screen back up over an empty list.
import { describe, expect, it } from "@test/harness"
import { mountScreen } from "./screen-harness.ts"

const ROUTE = {
  screen: "st",
  files: { html: "st.html", css: "st.css", handlers: [] },
  states: ["loading", "empty", "populated"],
}

const SETTINGS = { id: "s1", title: "Board" }
const CLUSTER = {
  schema: {
    settings: { fields: [{ name: "id", type: "string" }, { name: "title", type: "string" }] },
    item: { fields: [{ name: "id", type: "string" }, { name: "label", type: "string" }] },
  },
}

const slotOnly = `<section class="screen" data-screen="st">
  <header data-live="settings"><h1 data-text="{title}"></h1></header>
</section>`

const slotAndList = `<section class="screen" data-screen="st">
  <header data-live="settings"><h1 data-text="{title}"></h1></header>
  <ul data-live="item">
    <template data-item><li data-text="{label}"></li></template>
  </ul>
</section>`

const mount = (html: string, items: Record<string, unknown>[] = []) =>
  mountScreen({
    route: ROUTE,
    files: { "st.html": html, "st.css": "" },
    tables: { settings: [SETTINGS], item: items },
    cluster: CLUSTER,
    seed: 1,
  })

const state = (m: { one(s: string): unknown }) =>
  (m.one("[data-screen]") as { dataset: { state?: string } }).dataset.state

describe("the screen state between a slot and a list", () => {
  it("leaves loading once a singleton screen's row arrives", async () => {
    const m = await mount(slotOnly)
    await m.settle()
    expect(state(m)).toBe("populated")
    await m.stop()
  })

  it("keeps a list's empty when the slot beside it re-renders", async () => {
    const m = await mount(slotAndList, [{ id: "i1", label: "one" }])
    await m.settle()
    expect(state(m)).toBe("populated")
    await m.store.remove("item", "i1")
    await m.settle()
    expect(state(m)).toBe("empty")
    await m.store.update("settings", "s1", { title: "Renamed" })
    await m.settle()
    expect(state(m)).toBe("empty")
    await m.stop()
  })
})
