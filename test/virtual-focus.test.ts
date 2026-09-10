// Virtual focus: APG's other focus model, and the one this vocabulary can
// state. DOM focus stays on ONE container and aria-activedescendant names the
// active row, so no arrow key moves focus and nothing has to call focus() —
// which is what a roving tabstop would need and what nothing here does.
//
// It is a plain binding off the enclosing row. What made it impossible was
// that a list region's own element was the one element nobody bound: its
// parent's pass stops at any [data-live] between the element and the scope,
// and its own pass binds the items.
import { describe, expect, it } from "@test/harness"
import { type El, mountScreen, type Mounted } from "./screen-harness.ts"

const ROUTE = { screen: "lb", files: { html: "lb.html", css: "lb.css", handlers: [] } }

const FILES = {
  "lb.html": `<section class="screen" data-screen="lb">
    <div data-live="choice" data-filter="id=eq.the">
      <template data-item>
        <div class="wrap">
          <div role="listbox" id="lb" tabindex="0" aria-label="Plan"
               aria-activedescendant="opt-{value}"
               data-live="option" data-order="pos.asc"
               data-project='{"selected":{"eq":["id","{value}"]},"posinset":"index","setsize":"count"}'>
            <template data-item>
              <div role="option" id="opt-{id}" aria-selected="{selected}"
                   aria-posinset="{posinset}" aria-setsize="{setsize}" data-text="{label}"></div>
            </template>
          </div>
        </div>
      </template>
    </div>
  </section>`,
  "lb.css": "",
}

const mount = (value: string) =>
  mountScreen({
    route: ROUTE,
    files: FILES,
    tables: {
      choice: [{ id: "the", value }],
      option: [{ id: "a", label: "A", pos: 1 }, { id: "b", label: "B", pos: 2 }, { id: "c", label: "C", pos: 3 }],
    },
    seed: 1,
  })

const box = (m: Mounted) => m.one("#lb") as El
const opts = (m: Mounted) => m.all('[role="option"]') as El[]

describe("virtual focus is a binding on the container", () => {
  it("names the active option, and moves it with the enclosing row", async () => {
    const m = await mount("b")
    await m.settle()
    expect(box(m).getAttribute("aria-activedescendant")).toBe("opt-b")
    await m.store.update("choice", "the", { value: "c" })
    await m.settle()
    expect(box(m).getAttribute("aria-activedescendant")).toBe("opt-c")
    await m.stop()
  })

  it("keeps the whole set on one tab stop", async () => {
    // The half a roving tabstop has to work for: focus never leaves the
    // container, so no option carries a tabindex and no key has to move one.
    const m = await mount("b")
    await m.settle()
    expect(box(m).getAttribute("tabindex")).toBe("0")
    expect(opts(m).map((el) => el.getAttribute("tabindex"))).toEqual([null, null, null])
    await m.stop()
  })

  it("agrees with the row it points at", async () => {
    // aria-activedescendant is the container's answer and aria-selected is the
    // row's, computed from the same column by different means — the binding
    // interpolates it, the projection compares against it. A screen where they
    // disagreed would name one option and mark another.
    const m = await mount("b")
    await m.settle()
    const active = box(m).getAttribute("aria-activedescendant")
    const marked = opts(m).filter((el) => el.getAttribute("aria-selected") === "true")
    expect(marked.length).toBe(1)
    expect(marked[0].getAttribute("id")).toBe(active)
    expect(marked[0].getAttribute("aria-posinset")).toBe("2")
    expect(marked[0].getAttribute("aria-setsize")).toBe("3")
    await m.stop()
  })

  it("binds a top-level list region's own element from params", async () => {
    // The newly bound element at the OTHER tier. A top-level region's context
    // carries no row, so only {param.x} can resolve there — and a {column}
    // would throw the binder's own "not in row", which is the right answer for
    // an element that has no row to be about.
    const files = {
      ...FILES,
      "lb.html": `<section class="screen" data-screen="lb">
        <ul id="top" data-live="option" data-order="pos.asc" aria-label="Plan for {param.who}">
          <template data-item><li data-text="{label}"></li></template>
        </ul>
      </section>`,
    }
    const m = await mountScreen({
      route: ROUTE,
      files,
      tables: { choice: [], option: [{ id: "a", label: "A", pos: 1 }] },
      seed: 1,
      params: { who: "Ada" },
    })
    await m.settle()
    expect((m.one("#top") as El).getAttribute("aria-label")).toBe("Plan for Ada")
    await m.stop()
  })

  it("refuses an own-element binding naming a column the enclosing row lacks", async () => {
    // nestedBindings runs inside the PARENT's refresh, which is the one place
    // a plain binding error is dressed as a dead gateway and retried forever.
    const files = {
      ...FILES,
      "lb.html": FILES["lb.html"].replace('aria-activedescendant="opt-{value}"', 'aria-activedescendant="opt-{valu}"'),
    }
    await expect(
      mountScreen({
        route: ROUTE,
        files,
        tables: { choice: [{ id: "the", value: "b" }], option: [{ id: "a", label: "A", pos: 1 }] },
        seed: 1,
      }),
    ).rejects.toThrow(/binding \{valu\} not in row/)
  })

  it("refuses a nested read whose filter names a column the enclosing row lacks", async () => {
    // The read's own placeholder, resolved in the parent's refresh like the
    // attributes beside it. Unguarded this resolved the mount: the screen came
    // up looking healthy and re-probed the store forever.
    const files = {
      ...FILES,
      "lb.html": FILES["lb.html"].replace('data-live="option" data-order="pos.asc"', 'data-live="option" data-filter="kind=eq.{valu}"'),
    }
    await expect(
      mountScreen({
        route: ROUTE,
        files,
        tables: { choice: [{ id: "the", value: "b" }], option: [] },
        seed: 1,
      }),
    ).rejects.toThrow(/data-filter — binding \{valu\} not in row/)
  })

  it("refuses a declaration that is not JSON, or is null", async () => {
    const cases = [
      ["data-machine", "{bad", /data-machine is not JSON/],
      ["data-machine", "null", /data-machine holds null, which is not a chart/],
      ["data-empty-row", "{bad", /data-empty-row is not JSON/],
      ["data-empty-row", "42", /data-empty-row is 42, not an object/],
      // A list is now several charts, so the message names the member that is
      // not one rather than refusing the list.
      ["data-machine", "[1,2]", /data-machine holds 1, which is not a chart/],
      ["data-machine", "[]", /data-machine states no chart/],
      [
        "data-machine",
        '[{"field":"v","initial":"a","states":{}},{"field":"v","initial":"b","states":{}}]',
        /two charts run over the field "v"/,
      ],
    ] as const
    for (const [attr, spec, why] of cases) {
      const files = {
        ...FILES,
        "lb.html": FILES["lb.html"].replace('data-live="option" data-order="pos.asc"', `data-live="option" ${attr}='${spec}'`),
      }
      await expect(
        mountScreen({ route: ROUTE, files, tables: { choice: [{ id: "the", value: "b" }], option: [] }, seed: 1 }),
      ).rejects.toThrow(why)
    }
  })

  it("names the attribute when a top-level region's own read cannot resolve", async () => {
    // The other route into a filter's placeholders. A nested region never
    // reaches it — syncNested resolves the same template against the same row
    // first — so what this pins is the top-level message, where a bare
    // "not in row" would not say which attribute was wrong.
    const files = {
      ...FILES,
      "lb.html": `<section class="screen" data-screen="lb">
        <ul data-live="option" data-filter="kind=eq.{param.missing}">
          <template data-item><li data-text="{id}"></li></template>
        </ul>
      </section>`,
    }
    await expect(
      mountScreen({ route: ROUTE, files, tables: { choice: [], option: [] }, seed: 1 }),
    ).rejects.toThrow(/data-filter — unknown route param/)
  })

  it("refuses a declaration fault from a nested region instead of retrying it", async () => {
    // These faults were bare Errors, so a nested region — hydrating inside the
    // parent's refresh where the outage guard stands — swallowed them and
    // re-probed the store forever, while a top-level one escaped only because
    // it hydrates outside the guard.
    const files = {
      ...FILES,
      // The LISTBOX's template, not the choice region's: the outer one is
      // top-level and hydrates outside the guard, so patching it would prove
      // the throw that was already there.
      "lb.html": FILES["lb.html"].replace(
        `<template data-item>
              <div role="option"`,
        `<template data-item data-when="selected=eq.{value}">
              <div role="option"`,
      ),
    }
    await expect(
      mountScreen({ route: ROUTE, files, tables: { choice: [{ id: "the", value: "b" }], option: [] }, seed: 1 }),
    ).rejects.toThrow(/carries a placeholder/)
  })
})
