// The keyboard, closed: a listbox whose options are rows, walked by bindings,
// forms and the projection. The composition is
// plugins/omnishell/docs/2026-09-01-aria-is-columns.md.
//
// What is load-bearing here and easy to lose: the container names the form by
// interpolating its OWN row, so the gesture always reaches the active option's
// item without anything reading the DOM.
import { describe, expect, it } from "@test/harness"
import { type El, mountScreen, type Mounted, writes } from "./screen-harness.ts"

const ROUTE = { screen: "lb", files: { html: "lb.html", css: "lb.css", handlers: [] } }

const FILES = {
  "lb.html": `<section class="screen" data-screen="lb">
    <div data-live="choice" data-filter="id=eq.the">
      <template data-item>
        <div class="wrap">
          <div role="listbox" id="lb" tabindex="0" aria-label="Plan"
               aria-activedescendant="opt-{value}"
               data-key='{"ArrowDown":"nx-{value}","ArrowUp":"pv-{value}"}'
               data-live="option" data-order="pos.asc"
               data-project='{"selected":{"eq":["id","{value}"]},"nxt":"next","prv":"prev"}'>
            <template data-item>
              <div role="option" id="opt-{id}" aria-selected="{selected}" data-text="{label}"></div>
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

const mount = (value: string) =>
  mountScreen({
    route: ROUTE,
    files: FILES,
    tables: { choice: [{ id: "the", value }], option: options() },
    seed: 1,
  })

const active = (m: Mounted) => (m.one("#lb") as El).getAttribute("aria-activedescendant")

/** An arrow pressed where the reader's focus actually is: the container. */
const press = (m: Mounted, key: string) => {
  const el = m.one("#lb") as unknown as { dispatchEvent(e: unknown): void }
  const E = (globalThis as unknown as { document: { defaultView: { Event: new (t: string, i: object) => object } } })
    .document.defaultView.Event
  const ev = new E("keydown", { bubbles: true })
  Object.defineProperty(ev, "key", { value: key })
  el.dispatchEvent(ev)
}

describe("a listbox walks its options on the arrow keys", () => {
  it("moves the active option down and back up", async () => {
    const m = await mount("a")
    await m.settle()
    expect(active(m)).toBe("opt-a")

    press(m, "ArrowDown")
    await m.settle()
    expect(active(m)).toBe("opt-b")

    // The second press is the one the tablist spike could not make: focus never
    // moved, so the container still holds the gesture, and its own row now
    // names the next option's form.
    press(m, "ArrowDown")
    await m.settle()
    expect(active(m)).toBe("opt-c")

    press(m, "ArrowUp")
    await m.settle()
    expect(active(m)).toBe("opt-b")
    await m.stop()
  })

  it("marks exactly the option it names, at every step", async () => {
    const m = await mount("a")
    await m.settle()
    press(m, "ArrowDown")
    await m.settle()
    const marked = (m.all('[role="option"]') as El[]).filter((e) => e.getAttribute("aria-selected") === "true")
    expect(marked.length).toBe(1)
    expect(marked[0].getAttribute("id")).toBe(active(m))
    await m.stop()
  })

  it("stops at the ends instead of wrapping", async () => {
    const m = await mount("c")
    await m.settle()
    press(m, "ArrowDown")
    await m.settle()
    expect(active(m)).toBe("opt-c")
    await m.stop()
  })

  it("writes one column and touches no option row", async () => {
    const m = await mount("a")
    await m.settle()
    press(m, "ArrowDown")
    await m.settle()
    expect(m.store.rows("choice")).toEqual([{ id: "the", value: "b" }])
    expect(m.store.rows("option")).toEqual(options())
    await m.stop()
  })

  it("keeps the whole list on one tab stop", async () => {
    const m = await mount("a")
    await m.settle()
    expect((m.one("#lb") as El).getAttribute("tabindex")).toBe("0")
    expect((m.all('[role="option"]') as El[]).map((e) => e.getAttribute("tabindex"))).toEqual([null, null, null])
    await m.stop()
  })

  it("walks when nothing but the container's own attributes reads the parent", async () => {
    // The read never moves and the projection interpolates nothing, so the
    // container's own bindings are the only thing that has to notice. Nothing
    // else re-binds them: this region subscribes to `option`, and writing the
    // choice row never wakes it.
    const files = {
      ...FILES,
      "lb.html": FILES["lb.html"]
        .replace(`'{"selected":{"eq":["id","{value}"]},"nxt":"next","prv":"prev"}'`, `'{"nxt":"next","prv":"prev"}'`)
        .replace(' aria-selected="{selected}"', ""),
    }
    const m = await mountScreen({
      route: ROUTE,
      files,
      tables: { choice: [{ id: "the", value: "a" }], option: options() },
      seed: 1,
    })
    await m.settle()
    press(m, "ArrowDown")
    await m.settle()
    expect(active(m)).toBe("opt-b")
    press(m, "ArrowDown")
    await m.settle()
    expect(active(m)).toBe("opt-c")
    await m.stop()
  })
})

describe("a key binding refuses rather than going quiet", () => {
  const withKey = (spec: string) => ({
    ...FILES,
    "lb.html": FILES["lb.html"].replace(/data-key='[^']*'/, `data-key='${spec}'`),
  })
  const mountWith = (files: Record<string, string>) =>
    mountScreen({
      route: ROUTE,
      files,
      tables: { choice: [{ id: "the", value: "a" }], option: options() },
      seed: 1,
    })

  it("refuses a key outside APG's set", async () => {
    await expect(mountWith(withKey('{"Enter":"nx-{value}"}'))).rejects.toThrow(/not one of ArrowDown/)
  })

  it("refuses malformed JSON", async () => {
    await expect(mountWith(withKey("{not json"))).rejects.toThrow(/data-key is not JSON/)
  })

  it("refuses valid JSON that is not a map", async () => {
    // `null` is the sharp one: the parse guard never fires and Object.keys
    // throws, which is a TypeError and so not a ProgramError.
    for (const bad of ["null", "true", '"ArrowDown"', "[1]"]) {
      await expect(mountWith(withKey(bad))).rejects.toThrow(/not an object of key to form id/)
    }
  })

  it("stays refusable on the pass after the first", async () => {
    // The flag that keeps a listener from stacking must not also keep a bad
    // declaration from being reported: set before validation, the first pass
    // throws, the retry returns early, and the screen comes back looking
    // healthy with the key dead.
    const files = withKey('{"Enter":"nx-{value}"}')
    await expect(mountWith(files)).rejects.toThrow(/not one of ArrowDown/)
    await expect(mountWith(files)).rejects.toThrow(/not one of ArrowDown/)
  })

  it("refuses naming something that is not a form", async () => {
    // Cancelling the key first would leave a reader with an arrow that neither
    // moves the list nor scrolls the page, and no signal at all.
    const m = await mountWith(withKey('{"ArrowDown":"opt-{value}"}'))
    await m.settle()
    let thrown: unknown
    try {
      press(m, "ArrowDown")
    } catch (e) {
      thrown = e
    }
    expect(String((thrown as { message?: string })?.message)).toMatch(/is a <div> and not a form/)
    await m.stop()
  })
})

describe("a key whose target set is empty", () => {
  // The two halves of one declaration, told apart by whether the id varies with
  // a row. `empty` is a literal filter no option answers, so the list renders
  // nothing and the form the arrow names is not there — the state a reader
  // reaches by typing into a filter, which used to throw.
  const withFilter = (filter: string) => ({
    ...FILES,
    "lb.html": FILES["lb.html"]
      .replace(
        `data-key='{"ArrowDown":"nx-{value}","ArrowUp":"pv-{value}"}'`,
        `data-key='{"ArrowDown":"nx-{value}","Home":"never-here"}'`,
      )
      .replace(`<div hidden data-live="option" data-order="pos.asc"`, `<div hidden data-live="option"${filter} data-order="pos.asc"`),
  })

  const mountWithFilter = (filter: string) =>
    mountScreen({
      route: ROUTE,
      files: withFilter(filter),
      tables: { choice: [{ id: "the", value: "a" }], option: options() },
      seed: 1,
    })

  it("does nothing, and does not cancel, when the read answers no rows", async () => {
    const m = await mountWithFilter(' data-filter="pos=gt.99"')
    await m.settle()
    expect(m.all('[role="none"]').length).toBe(0)
    const ev = m.fire("#lb", "keydown", { key: "ArrowDown", cancelable: true })
    await m.settle()
    // Uncancelled, so the arrow does what an arrow does with no list to walk.
    expect(ev.defaultPrevented).toBe(false)
    expect(writes(m).length).toBe(0)
    await m.stop()
  })

  it("still walks when the read answers rows", async () => {
    const m = await mountWithFilter("")
    await m.settle()
    const ev = m.fire("#lb", "keydown", { key: "ArrowDown", cancelable: true })
    await m.settle()
    expect(ev.defaultPrevented).toBe(true)
    expect(active(m)).toBe("opt-b")
    await m.stop()
  })

  it("still refuses a literal naming a form that is not there", async () => {
    // The other half, and why the rule reads the DECLARATION rather than the
    // resolved value: an id that never varied cannot have been emptied by a
    // read, so a miss there is the typo it looks like.
    const m = await mountWithFilter("")
    await m.settle()
    let thrown: unknown
    try {
      m.fire("#lb", "keydown", { key: "Home" })
    } catch (e) {
      thrown = e
    }
    expect(String((thrown as { message?: string })?.message)).toMatch(/"never-here", which is no element/)
    await m.stop()
  })
})
