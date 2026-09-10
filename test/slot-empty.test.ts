// What a slot renders when its row is gone.
//
// A TOP-LEVEL slot has the screen's own state to move to — `gone` where the
// route declares it, `empty` otherwise — and either is a frame the reader can
// see. A NESTED slot has none: the screen around it is populated and staying
// that way, so its empty treatment has to be the region's own, declared the
// way a list declares one.
import { describe, expect, it } from "@test/harness"
import { type El, mountScreen } from "./screen-harness.ts"

type Row = Record<string, unknown>

const ROUTE = {
  screen: "rd",
  files: { html: "rd.html", css: "rd.css", handlers: [] },
  states: ["loading", "empty", "populated"],
}

/** A readout pinned on the item's own row: the shape an app reaches for when a
 * list item carries a singleton beside it. */
const files = (empty: string) => ({
  "rd.html": `<section class="screen" data-screen="rd">
    <ul data-live="step" data-order="pos.asc">
      <template data-item>
        <li>
          <span class="label" data-text="{label}"></span>
          <span class="readout" data-live="note"${empty} data-filter="step_id=eq.{id}">
            <b data-text="{body}"></b>
          </span>
        </li>
      </template>
    </ul>
  </section>`,
  "rd.css": "",
})

const NOTE = { id: "n1", step_id: "a", body: "the note" }

const mount = (empty = "", notes: Row[] = [NOTE]) =>
  mountScreen({
    route: ROUTE,
    files: files(empty),
    tables: { step: [{ id: "a", label: "A", pos: 1 }], note: notes },
    seed: 1,
  })

const readout = (m: { one(s: string): El }) => (m.one(".readout") as El).textContent?.trim()

describe("a nested slot whose row is gone", () => {
  it("renders its row while it has one", async () => {
    const m = await mount()
    await m.settle()
    expect(readout(m)).toBe("the note")
    await m.stop()
  })

  it("refuses when the region declares no empty treatment", async () => {
    // The silence this guards: no state to set, the bindings restored to their
    // templates, and a region rendering nothing. An app whose arrows write into
    // this readout would get no output and no error anywhere.
    const m = await mount()
    await m.settle()
    await m.store.remove("note", "n1")
    await expect(m.settle()).rejects.toThrow(/declares no empty treatment/)
  })

  it("refuses the same way when the row was never there", async () => {
    // A first paint reaches the branch too, and it is the same gap: a region
    // that renders nothing on arrival says as little as one that goes quiet.
    await expect(mount("", [])).rejects.toThrow(/declares no empty treatment/)
  })

  it("shows the copy the region declares instead", async () => {
    const m = await mount(` data-empty="No note."`)
    await m.settle()
    await m.store.remove("note", "n1")
    await m.settle()
    expect(readout(m)).toBe("No note.")
    // The copy stands in for the row rather than beside it: the region's
    // bindings are cleared on the same pass that renders the note.
    expect((m.one(".readout b") as El).textContent).toBe("")
    await m.stop()
  })

  it("admits a probe that declares it shows nothing", async () => {
    // A chip whose whole output is its presence renders nothing when its row is
    // absent, and that is the treatment rather than the absence of one. Refusing
    // empty copy would leave a correct region with nothing it could say.
    const m = await mount(` data-empty=""`)
    await m.settle()
    await m.store.remove("note", "n1")
    await m.settle()
    expect(readout(m)).toBe("")
    // `:empty` is how a screen styles a region that rendered none, and a <p>
    // holding whitespace is what stops it matching.
    expect(m.all(".readout .empty").length).toBe(0)
    await m.stop()
  })

  it("takes the copy away when a row arrives", async () => {
    // The note is the region's own child and no sweep clears a slot's, so a
    // region that fills again would be left holding both.
    const m = await mount(` data-empty="No note."`)
    await m.settle()
    await m.store.remove("note", "n1")
    await m.settle()
    await m.store.create("note", { id: "n2", step_id: "a", body: "another" })
    await m.settle()
    expect(readout(m)).toBe("another")
    expect(m.all(".readout .empty").length).toBe(0)
    await m.stop()
  })

  it("states which region and which read it was", async () => {
    const m = await mount()
    await m.settle()
    await m.store.remove("note", "n1")
    await expect(m.settle()).rejects.toThrow(/slot region "note" \(filter "step_id=eq\.a"\)/)
  })
})

const NOTE_ROUTE = {
  screen: "nt",
  files: { html: "nt.html", css: "nt.css", handlers: [] },
  states: ["loading", "empty", "populated"],
}

/** One screen, three regions declaring the same copy under three content
 * models: a nested slot in phrasing content, a list of flow content, and a
 * list element. */
const NOTE_FILES = {
  "nt.html": `<section class="screen" data-screen="nt">
    <ul class="steps" data-live="step" data-order="pos.asc">
      <template data-item>
        <li>
          <span class="readout" data-live="note" data-empty="None." data-filter="step_id=eq.{id}"></span>
        </li>
      </template>
    </ul>
    <div class="cards" data-live="note" data-filter="step_id=eq.z" data-empty="None.">
      <template data-item><article></article></template>
    </div>
    <ol class="rows" data-live="note" data-filter="step_id=eq.z" data-empty="None.">
      <template data-item><li></li></template>
    </ol>
  </section>`,
  "nt.css": "",
}

describe("the empty note's own element", () => {
  it("is one the region it stands in can hold", async () => {
    // The note replaces the rows, so it inherits their content model. A <p>
    // inside a <span> — the shape most nested slots' declarations ask for, a
    // span being what an inline readout is — is markup no author could have
    // written, and the parser that meets it in a served page breaks the
    // region's phrasing flow around it.
    const m = await mountScreen({
      route: NOTE_ROUTE,
      files: NOTE_FILES,
      tables: { step: [{ id: "a", pos: 1 }], note: [] },
      seed: 1,
    })
    await m.settle()
    expect((m.one(".readout .empty") as El).tagName).toBe("SPAN")
    expect((m.one(".cards .empty") as El).tagName).toBe("P")
    expect((m.one(".rows .empty") as El).tagName).toBe("LI")
    await m.stop()
  })
})

const TOP_ROUTE = {
  screen: "one",
  files: { html: "one.html", css: "one.css", handlers: [] },
  states: ["loading", "empty", "populated", "gone"],
}

const TOP_FILES = {
  "one.html": `<section class="screen" data-screen="one">
    <div class="readout" data-live="note" data-filter="id=eq.n1"><b data-text="{body}"></b></div>
  </section>`,
  "one.css": "",
}

describe("a top-level slot whose row is gone", () => {
  it("moves the screen to gone and asks the region for nothing", async () => {
    // The state IS the signal, so the region owes no copy: raising here would
    // refuse every screen that already answers this the way the route says.
    const m = await mountScreen({ route: TOP_ROUTE, files: TOP_FILES, tables: { note: [NOTE] }, seed: 1 })
    await m.settle()
    await m.store.remove("note", "n1")
    await m.settle()
    expect(m.screen.getAttribute("data-state")).toBe("gone")
    expect((m.one(".readout b") as El).textContent).toBe("")
    await m.stop()
  })
})
