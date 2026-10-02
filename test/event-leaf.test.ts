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

describe("a machine's control", () => {
  it("shows the column the machine clears, whatever the reader typed", async () => {
    // golaberto's comment composer: typing assigns the draft, an acknowledged
    // post assigns it empty — and the textarea kept the posted text, because
    // the binder guarded a typed control as if a form owned it.
    const chart = JSON.stringify({
      field: "state",
      initial: "idle",
      context: { term: "" },
      states: { idle: { on: {
        "input@box": { assign: { term: { type: "event", params: { field: "value" } } } },
        "click@clear": { assign: { term: "" } },
      } } },
    })
    const files = {
      "find.html": `<section class="screen" data-screen="find">
        <div data-live="search" data-filter="id=eq.the" data-machine='${chart}'>
          <textarea id="box" data-value="{term}"></textarea>
          <button id="clear" type="button">clear</button>
        </div>
      </section>`,
      "find.css": "",
    }
    const m = await mountScreen({ route: ROUTE, files, tables: world(), seed: 1 })
    await m.settle()
    m.set("#box", "value", "golaço")
    m.fire("#box", "input")
    await m.settle()
    expect(m.store.rows("search")[0].term).toBe("golaço")
    m.fire("#clear", "click")
    await m.settle()
    expect(m.store.rows("search")[0].term).toBe("")
    expect((m.one("#box") as unknown as { value: string }).value).toBe("")
    await m.stop()
  })
})

describe("a draft nested in the row it edits", () => {
  // data-empty-row was read raw, so a draft could not start from the row
  // around it: the editor opened blank, and saving it wrote blanks back.
  it("starts from the enclosing row, keeping a column's type and its null", async () => {
    const draft = JSON.stringify({
      field: "state",
      initial: "idle",
      states: { idle: { on: { input: [{ target: "idle", assign: { score: { type: "event", params: { field: "value" } } } }] } } },
    })
    const files = {
      "find.html": `<section class="screen" data-screen="find">
        <div data-live="game" data-filter="id=eq.g1">
          <template data-item><article>
            <div data-live="game_edit" data-filter="id=eq.{id}" data-machine='${draft}'
                 data-empty-row='{"id":"{id}","state":"idle","score":"{score}","crowd":"{crowd}","label":"jogo {id}"}'>
              <output class="score" data-text="{score}"></output>
              <output class="label" data-text="{label}"></output>
              <input class="box" type="text" data-value="{score}">
              <ul data-live="choice" data-empty=""><template data-item><li class="choice" data-text="{name}"></li></template></ul>
            </div>
          </article></template>
        </div>
      </section>`,
      "find.css": "",
    }
    // A list inside the draft: the draft stays a slot, its templates the list's.
    const tables = { game: [{ id: "g1", score: 2, crowd: null }], game_edit: [] as Record<string, unknown>[], choice: [{ id: "c1", name: "Arena" }] }
    const m = await mountScreen({ route: ROUTE, files, tables, seed: 1 })
    await m.settle()
    expect(m.texts(".score")).toEqual(["2"])
    expect(m.texts(".label")).toEqual(["jogo g1"])
    expect(m.texts(".choice")).toEqual(["Arena"])
    // The control shows the row through its value, not an attribute.
    expect((m.one(".box") as unknown as { value: string }).value).toBe("2")

    m.set(".box", "value", "3")
    m.fire(".box", "input")
    await m.settle()
    // The fallback is written whole by the first transition: what it seeded
    // is what the row holds, typed.
    expect(m.store.rows("game_edit")[0]).toMatchObject({ id: "g1", score: "3", crowd: null, label: "jogo g1" })
    await m.stop()
  })
})

describe("a bound boolean attribute", () => {
  // A boolean column renders "false", and `checked="false"` is a checked box:
  // an unplayed game's editor opened with "played" ticked.
  it("is absent when the column is false, present when true", async () => {
    const files = {
      "find.html": `<section class="screen" data-screen="find">
        <ul data-live="game" data-order="id.asc">
          <template data-item><li><input class="played" type="checkbox" checked="{played}"></li></template>
        </ul>
      </section>`,
      "find.css": "",
    }
    const tables = { game: [{ id: "a", played: false }, { id: "b", played: true }] }
    const m = await mountScreen({ route: ROUTE, files, tables, seed: 1 })
    await m.settle()
    const [a, b] = m.all(".played") as unknown as { checked: boolean; hasAttribute(n: string): boolean }[]
    expect([a.checked, a.hasAttribute("checked")]).toEqual([false, false])
    expect([b.checked, b.hasAttribute("checked")]).toEqual([true, true])
    await m.stop()
  })
})
