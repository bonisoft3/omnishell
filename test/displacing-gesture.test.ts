// A displacing gesture: an event type whose default action and an app's answer
// cannot both stand, cancelled wherever an arrow answers it.
//
// The claim this rests on is unchanged — every cancel the terminal makes
// belongs to a gesture the markup declared. What moved is which markup counts:
// an arrow keyed on `contextmenu` IS that declaration, as much as data-key's
// map is. The set is closed, so adding an arrow can only change the default of
// a type where keeping it was already incoherent.
import { describe, expect, it } from "@test/harness"
import { boxOf, mountScreen } from "./screen-harness.ts"

const ROUTE = { screen: "menu", files: { html: "menu.html", css: "menu.css", handlers: [] } }

const machine = JSON.stringify({
  field: "open",
  initial: "false",
  states: {
    "false": {
      on: {
        "contextmenu@target": [{
          target: "true",
          assign: {
            x: { type: "event", params: { field: "pointerX" } },
            y: { type: "event", params: { field: "pointerY" } },
          },
        }],
        // The same chart answers a plain click, which is NOT displacing.
        "click@plain": [{ target: "true" }],
      },
    },
    "true": { on: { "click@close": [{ target: "false" }] } },
  },
})

const FILES = {
  "menu.html": `<section class="screen" data-screen="menu">
    <div data-live="menu" data-filter="id=eq.the" data-machine='${machine}'
         data-empty-row='{"id":"the","open":"false","x":0,"y":0}'>
      <div id="target" class="target">right-click me</div>
      <button type="button" id="plain">open</button>
      <button type="button" id="close">close</button>
      <div class="surface" data-state="{open}" style="--x: {x}; --y: {y}"></div>
    </div>
  </section>`,
  "menu.css": "",
}

const mount = () => mountScreen({ route: ROUTE, files: FILES, tables: { menu: [] }, seed: 1 })

describe("a displacing type is cancelled where an arrow answers it", () => {
  it("cancels contextmenu, so the UA's own menu never joins the app's", async () => {
    const m = await mount()
    await m.settle()
    boxOf(m.one("#target"), { left: 0, top: 0, width: 100, height: 100 })
    const ev = m.fire("#target", "contextmenu", { cancelable: true, clientX: 10, clientY: 10 })
    await m.settle()
    expect(ev.defaultPrevented).toBe(true)
    expect(m.store.rows("menu")[0].open).toBe("true")
    await m.stop()
  })

  it("leaves a click alone, because a click displaces nothing", async () => {
    const m = await mount()
    await m.settle()
    const ev = m.fire("#plain", "click", { cancelable: true })
    await m.settle()
    expect(ev.defaultPrevented).toBe(false)
    expect(m.store.rows("menu")[0].open).toBe("true")
    await m.stop()
  })

  it("leaves the UA its menu where no arrow answers the right-click", async () => {
    // The arrow is narrowed to #target, so a right-click on the close button is
    // a gesture this markup never declared. Cancelling by TYPE rather than by
    // arrow would take the platform's own menu away from a reader the app has
    // nothing to show — a whole region made inert by one narrowed arrow in it.
    const m = await mount()
    await m.settle()
    boxOf(m.one("#close"), { left: 0, top: 0, width: 100, height: 100 })
    const ev = m.fire("#close", "contextmenu", { cancelable: true, clientX: 10, clientY: 10 })
    await m.settle()
    expect(ev.defaultPrevented).toBe(false)
    expect(m.store.rows("menu").length).toBe(0)
    await m.stop()
  })

  it("leaves it alone in a state that draws no such arrow", async () => {
    // Openness is the state, and the open menu draws no contextmenu arrow. The
    // cancel has to follow the chart there too, or the gesture stays displaced
    // in a state that stopped answering it.
    const m = await mount()
    await m.settle()
    boxOf(m.one("#target"), { left: 0, top: 0, width: 100, height: 100 })
    m.fire("#plain", "click")
    await m.settle()
    expect(m.store.rows("menu")[0].open).toBe("true")
    const ev = m.fire("#target", "contextmenu", { cancelable: true, clientX: 10, clientY: 10 })
    await m.settle()
    expect(ev.defaultPrevented).toBe(false)
    await m.stop()
  })
})

describe("the pointer is a share of the affordance, never a viewport pixel", () => {
  it("writes where in the target's own box the pointer landed", async () => {
    const m = await mount()
    await m.settle()
    boxOf(m.one("#target"), { left: 100, top: 50, width: 200, height: 100 })
    m.fire("#target", "contextmenu", { cancelable: true, clientX: 150, clientY: 75 })
    await m.settle()
    // A quarter across and a quarter down the box, in parts per thousand — not
    // (150, 75), which would mean something else in a window of another size.
    expect(m.store.rows("menu")[0].x).toBe(250)
    expect(m.store.rows("menu")[0].y).toBe(250)
    await m.stop()
  })

  it("answers the same share whatever the box's pixels are", async () => {
    // The property the frame buys: the row a replay reproduces does not depend
    // on the geometry it was measured against, so nothing has to be pinned.
    for (const box of [{ left: 0, top: 0, width: 400, height: 200 }, { left: 12, top: 8, width: 40, height: 20 }]) {
      const m = await mount()
      await m.settle()
      boxOf(m.one("#target"), box)
      m.fire("#target", "contextmenu", {
        cancelable: true,
        clientX: box.left + box.width * 0.75,
        clientY: box.top + box.height * 0.5,
      })
      await m.settle()
      expect(m.store.rows("menu")[0].x).toBe(750)
      expect(m.store.rows("menu")[0].y).toBe(500)
      await m.stop()
    }
  })

  it("clamps to the box rather than storing a point outside it", async () => {
    const m = await mount()
    await m.settle()
    boxOf(m.one("#target"), { left: 100, top: 50, width: 200, height: 100 })
    m.fire("#target", "contextmenu", { cancelable: true, clientX: 1000, clientY: -40 })
    await m.settle()
    expect(m.store.rows("menu")[0].x).toBe(1000)
    expect(m.store.rows("menu")[0].y).toBe(0)
    await m.stop()
  })

  it("declines the whole arrow for a box with no interior, rather than dividing by it", async () => {
    // An unmeasured element is zero-sized here; in a browser it is a collapsed
    // one. Either way there is no fraction to be, so the field is absent — and
    // an absent event field is a transition declining, which is the rule a
    // select firing an arrow written for a checkbox already relies on. The menu
    // does not open, which is right: a surface placed at no point is one the
    // reader would find somewhere the gesture never was.
    const m = await mount()
    await m.settle()
    m.fire("#target", "contextmenu", { cancelable: true, clientX: 10, clientY: 10 })
    await m.settle()
    expect(m.store.rows("menu").length).toBe(0)
    await m.stop()
  })
})

describe("a row decides a surface's place in the top layer", () => {
  const surfaced = {
    "menu.html": FILES["menu.html"].replace(
      '<div class="surface" data-state="{open}" style="--x: {x}; --y: {y}"></div>',
      '<div class="surface" popover="auto" data-open="{open}" style="--x: {x}; --y: {y}"></div>',
    ),
    "menu.css": "",
  }
  const mountSurfaced = () => mountScreen({ route: ROUTE, files: surfaced, tables: { menu: [] }, seed: 1 })

  it("opens on the state the machine wrote and closes on the state it wrote back", async () => {
    const m = await mountSurfaced()
    await m.settle()
    expect(m.one(".surface")?.getAttribute("data-popover-open")).toBe(null)

    m.fire("#plain", "click")
    await m.settle()
    expect(m.one(".surface")?.getAttribute("data-popover-open")).toBe("")

    m.fire("#close", "click")
    await m.settle()
    expect(m.one(".surface")?.getAttribute("data-popover-open")).toBe(null)
    await m.stop()
  })

  it("survives a refresh that restates the same openness", async () => {
    // Every bind re-derives it, and showPopover throws on an already-open
    // surface — so a second write of the same value must reach neither call.
    const m = await mountSurfaced()
    await m.settle()
    m.fire("#plain", "click")
    await m.settle()
    await m.store.upsert("menu", { id: "the", open: "true", x: 500, y: 500 })
    await m.settle()
    expect(m.one(".surface")?.getAttribute("data-popover-open")).toBe("")
    await m.stop()
  })

  it("refuses data-open on an element that declares no popover", async () => {
    const files = {
      "menu.html": FILES["menu.html"].replace('data-state="{open}"', 'data-open="{open}"'),
      "menu.css": "",
    }
    await expect(mountScreen({ route: ROUTE, files, tables: { menu: [] }, seed: 1 }))
      .rejects.toThrow(/declares no popover/)
  })

  it("reopens after the UA dismissed the surface behind the row's back", async () => {
    // An auto popover has a second writer: light dismiss and Escape are the
    // element's, and they close it without the row hearing. A flag only the
    // terminal wrote would then read open over a closed surface and skip the
    // call that reopens it — a menu dead after its first dismissal, and dead
    // in a way no row inspection shows, since the row still says open.
    const m = await mountSurfaced()
    await m.settle()
    m.fire("#plain", "click")
    await m.settle()
    expect(m.one(".surface")?.getAttribute("data-popover-open")).toBe("")

    ;(m.one(".surface") as unknown as { hidePopover(): void }).hidePopover()
    expect(m.one(".surface")?.getAttribute("data-popover-open")).toBe(null)
    expect(m.store.rows("menu")[0].open).toBe("true")

    m.fire("#close", "click")
    await m.settle()
    m.fire("#plain", "click")
    await m.settle()
    expect(m.one(".surface")?.getAttribute("data-popover-open")).toBe("")
    await m.stop()
  })
})
