// A surface a trigger opens on hover or focus, and holds no state for.
//
// The whole reason this can be the terminal's without being an escape hatch:
// openness nobody stores cannot disagree with anything. No row is written, so
// nothing is journalled and a replay has nothing to reproduce — the same
// licence popover="auto"'s own light dismiss already runs on.
//
// What the tests hold to is the part that WOULD be nondeterminism: both waits
// go through the terminal's clock, so a test advances them rather than sleeping.
import { describe, expect, it } from "@test/harness"
import { type El, mountScreen, type Mounted } from "./screen-harness.ts"

const ROUTE = { screen: "tip", files: { html: "tip.html", css: "tip.css", handlers: [] } }

const html = (surface: string) => `<section class="screen" data-screen="tip">
    <button type="button" id="trigger" data-interest="tip">Ada Lovelace</button>
    ${surface}
  </section>`

const FILES = {
  "tip.html": html('<div id="tip" popover="auto" role="tooltip">The first programmer.</div>'),
  "tip.css": "",
}

const mount = (files = FILES) => mountScreen({ route: ROUTE, files, tables: {}, seed: 1 })

const open = (m: Mounted) => (m.one("#tip") as El).getAttribute("data-popover-open") !== null

/** The terminal's clock, which is where both of this feature's waits live. */
const after = async (m: Mounted, ms: number) => {
  m.advance(ms)
  await m.quiet()
}

describe("interest opens a surface and nothing holds it open", () => {
  it("opens after the pointer has rested, and not before", async () => {
    const m = await mount()
    await m.settle()
    expect(open(m)).toBe(false)

    m.fire("#trigger", "pointerenter")
    // The wait is real and it is the terminal's: a surface that opened on the
    // event itself would flash on every pointer crossing the page.
    await after(m, 100)
    expect(open(m)).toBe(false)
    await after(m, 300)
    expect(open(m)).toBe(true)
    await m.stop()
  })

  it("closes after the pointer has left, with a grace in between", async () => {
    const m = await mount()
    await m.settle()
    m.fire("#trigger", "pointerenter")
    await after(m, 400)
    expect(open(m)).toBe(true)

    m.fire("#trigger", "pointerleave")
    expect(open(m)).toBe(true)
    await after(m, 400)
    expect(open(m)).toBe(false)
    await m.stop()
  })

  it("stays open while the reader is on the surface itself", async () => {
    // WCAG 1.4.13's HOVERABLE clause, and the one a CSS-only tooltip cannot
    // meet unless the two boxes touch: the reader crosses the gap during the
    // grace, and the surface's own pointerenter cancels the close.
    const m = await mount()
    await m.settle()
    m.fire("#trigger", "pointerenter")
    await after(m, 400)
    m.fire("#trigger", "pointerleave")
    m.fire("#tip", "pointerenter")
    await after(m, 400)
    expect(open(m)).toBe(true)

    m.fire("#tip", "pointerleave")
    await after(m, 400)
    expect(open(m)).toBe(false)
    await m.stop()
  })

  it("stays open while the reader's FOCUS is on the surface", async () => {
    // The keyboard's half of the clause above, and what a surface holding
    // anything reachable needs: Tab takes focus off the trigger, and a surface
    // that only heard the pointer would close on the way into itself — with
    // the reader's focus inside it when it went.
    const files = {
      ...FILES,
      "tip.html": html('<div id="tip" popover="auto"><a href="#/x" id="inside">More</a></div>'),
    }
    const m = await mount(files)
    await m.settle()
    m.fire("#trigger", "focusin")
    await after(m, 0)
    expect(open(m)).toBe(true)

    // What a Tab does, in the order the DOM fires it.
    m.fire("#trigger", "focusout")
    m.fire("#inside", "focusin")
    await after(m, 400)
    expect(open(m)).toBe(true)

    m.fire("#inside", "focusout")
    await after(m, 400)
    expect(open(m)).toBe(false)
    await m.stop()
  })

  it("opens on focus with no wait, because a keyboard reader has already arrived", async () => {
    const m = await mount()
    await m.settle()
    m.fire("#trigger", "focusin")
    await after(m, 0)
    expect(open(m)).toBe(true)
    await m.stop()
  })

  it("does not open for a pointer that passed through", async () => {
    // The generation mark is the cancellation: the wait the enter armed comes
    // due after the leave, finds interest moved on, and dies.
    const m = await mount()
    await m.settle()
    m.fire("#trigger", "pointerenter")
    await after(m, 100)
    m.fire("#trigger", "pointerleave")
    await after(m, 600)
    expect(open(m)).toBe(false)
    await m.stop()
  })

  it("writes nothing at all — the store is not where this lives", async () => {
    const m = await mount()
    await m.settle()
    m.fire("#trigger", "pointerenter")
    await after(m, 400)
    m.fire("#trigger", "pointerleave")
    await after(m, 400)
    expect(m.store.calls.length).toBe(0)
    await m.stop()
  })
})

describe("an interest binding refuses rather than going quiet", () => {
  it("refuses a name that is no element", async () => {
    const files = { ...FILES, "tip.html": html("") }
    await expect(mount(files)).rejects.toThrow(/names "tip", which is no element/)
  })

  it("refuses a surface that is not an auto popover", async () => {
    // Not decoration: light dismiss and Escape are the element's half of
    // 1.4.13, so a surface without them would leave a reader no way out and
    // this code would have to grow a key listener to give them one.
    for (const bad of ['<div id="tip" role="tooltip"></div>', '<div id="tip" popover="manual"></div>']) {
      const files = { ...FILES, "tip.html": html(bad) }
      await expect(mount(files)).rejects.toThrow(/light dismiss and Escape are the element's half/)
    }
  })

  it("refuses a surface whose openness is already a column", async () => {
    // Two writers of one fact. A row restating its answer on the next bind
    // would shut a surface the reader is still under, and a pointer opening one
    // the row says is closed would be undone by the first refresh — so the pair
    // is unspellable rather than arbitrated at runtime.
    const files = {
      ...FILES,
      "tip.html": html('<div id="tip" popover="auto" data-open="{open}"></div>'),
    }
    await expect(mount(files)).rejects.toThrow(/already a column — a surface has one owner/)
  })
})
