// The event leaf is what makes an as-you-type behaviour — a filter, a slider's
// position, an OTP digit — a column rather than something only a submit can
// state. What has to hold: the value reaches the ROW, not just the paint, and
// the allowlist is the whole of what a leaf can reach.
import { describe, expect, it } from "@test/harness"
import { mountScreen } from "./screen-harness.ts"

const ROUTE = { screen: "find", files: { html: "find.html", css: "find.css", handlers: [] } }

const machine = (field: string) =>
  JSON.stringify({
    field: "typed",
    initial: "idle",
    states: {
      idle: {
        on: {
          input: [{ target: "idle", assign: { term: { type: "event", params: { field } } } }],
        },
      },
    },
  })

const screenHtml = (field: string) => ({
  "find.html": `<section class="screen" data-screen="find">
    <div data-live="search" data-filter="id=eq.the" data-machine='${machine(field)}'
         data-empty-row='{"id":"the","typed":"idle","term":""}'>
      <input class="box" type="text">
      <output class="echo" data-text="{term}"></output>
    </div>
  </section>`,
  "find.css": "",
})

const world = () => ({ search: [] as Record<string, unknown>[] })

describe("a machine reads the value off its own event", () => {
  it("writes what the control was showing into the row", async () => {
    const m = await mountScreen({ route: ROUTE, files: screenHtml("value"), tables: world(), seed: 1 })
    await m.settle()
    expect(m.texts(".echo")).toEqual([""])

    m.set(".box", "value", "ora")
    m.fire(".box", "input")
    await m.settle()

    // The row is the claim, not the echo: a screen that painted the value
    // without storing it would leave the next region reading nothing.
    expect(m.store.rows("search")[0].term).toBe("ora")
    expect(m.texts(".echo")).toEqual(["ora"])
    await m.stop()
  })

  it("declines when the control carries no such field, and does not take the screen with it", async () => {
    // Every input declares `checked` and `valueAsNumber` whatever its type, so
    // admitting a field by presence would write false or NaN and call it the
    // reader's answer. One control's shape must not decide the screen's fate
    // either: the same arrow can be reached by a checkbox and by a select.
    for (const field of ["checked", "valueAsNumber"]) {
      const m = await mountScreen({ route: ROUTE, files: screenHtml(field), tables: world(), seed: 1 })
      await m.settle()
      m.set(".box", "value", "ora")
      m.fire(".box", "input")
      await m.settle()

      expect(m.store.rows("search")).toEqual([])
      expect(m.screen.getAttribute("data-state")).not.toBe("network-error")
      await m.stop()
    }
  })

  it("refuses a field the allowlist does not carry", async () => {
    const m = await mountScreen({
      route: ROUTE,
      files: screenHtml("outerHTML"),
      tables: world(),
      seed: 1,
      expectRefusal: true,
    })
    await m.settle()
    m.set(".box", "value", "ora")
    m.fire(".box", "input")
    await m.settle()

    // A leaf that could name any property would be a handle on the DOM, and a
    // transition reading one is no longer decidable from the row and the event.
    // The transition concludes nothing, so the collection is still empty —
    // stronger than a row with the column left blank.
    expect(m.store.rows("search")).toEqual([])
    await m.stop()
  })
})
