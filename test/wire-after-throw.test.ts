// An item is wired once, when it arrives — and a pass can throw before it
// gets that far: a row missing a column the item binds is a program error the
// refresh reports and retries. The pass that then succeeds must attach what
// the first never reached, or the row stands bound and deaf: its affordances
// never fire, and nothing says so.
import { describe, expect, it } from "@test/harness"
import { mountScreen } from "./screen-harness.ts"

const REDUCE = `(state, event) => ({
  updates: [{ op: "patch", entity: "cell", id: event.id, row: { hit: "yes" } }],
})`

const ROUTE = {
  screen: "grid",
  files: { html: "grid.html", css: "grid.css", handlers: ["shell/handlers/tap.js"] },
  states: ["loading", "empty", "populated"],
}

const FILES = {
  "grid.html": `<section class="screen" data-screen="grid">
    <div id="grid" data-live="cell" data-order="pos.asc" data-handler="tap" data-reads="cell">
      <template data-item>
        <div class="row" data-label="{label}">
          <button type="button" class="tap" data-on-click="tap">go</button>
        </div>
      </template>
    </div>
  </section>`,
  "grid.css": "",
  "shell/handlers/tap.js": REDUCE,
}

describe("an item whose first bind threw", () => {
  it("is wired by the pass that binds it", async () => {
    // The row lacks {label}, so the first pass throws at the item's root.
    const m = await mountScreen({
      route: ROUTE,
      files: FILES,
      tables: { cell: [{ id: "c1", pos: 1, hit: "no" }] },
      seed: 1,
      expectRefusal: true,
    })
    await m.settle()
    expect(m.screen.getAttribute("data-state")).toBe("network-error")
    // The column arrives; the pass that follows binds the row for real.
    await m.store.update("cell", "c1", { label: "one" })
    await m.settle()
    expect(m.one(".row").getAttribute("data-label")).toBe("one")
    m.fire(".tap")
    await m.settle()
    expect(m.rows("cell")[0].hit).toBe("yes")
    await m.stop()
  })

  // The sibling bound BEFORE the throw: the next delta names only the broken
  // row, so nothing but its unwired state admits it to that pass.
  it("wires a sibling the throwing pass had already bound", async () => {
    const m = await mountScreen({
      route: ROUTE,
      files: FILES,
      tables: { cell: [{ id: "ok", pos: 1, label: "fine", hit: "no" }, { id: "bad", pos: 2, hit: "no" }] },
      seed: 1,
      expectRefusal: true,
    })
    await m.settle()
    expect(m.screen.getAttribute("data-state")).toBe("network-error")
    await m.store.update("cell", "bad", { label: "two" })
    await m.settle()
    m.fire('.row[data-id="ok"] .tap')
    await m.settle()
    expect(m.rows("cell").find((r) => r.id === "ok")!.hit).toBe("yes")
    await m.stop()
  })
})
