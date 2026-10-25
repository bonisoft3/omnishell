import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import "../interpreter/vendor/ses.umd.min.js"
import { ensureSes } from "../interpreter/jessie.js"
import { createStore } from "../interpreter/data-sync.js"
import { FIXTURE_CARRIERS } from "../interpreter/fixture-types.js"
import { activateScreenStyle, interpretScreen, prefetchScreen } from "../interpreter/screen.js"

await ensureSes()

const chart = `<section class="screen" data-screen="chart">
  <div data-live="chart" data-filter="id=eq.c" data-empty-row='{"id":"c","series":"empty"}'
       data-on-mutation="seed" data-read-stored="chart?id=eq.c">
    <p class="series" data-text="{series}"></p>
    <div data-live="point" data-on-mutation="fold" data-read-chart="chart?id=eq.c">
      <template data-item><span hidden></span></template>
    </div>
  </div>
</section>`
const seed = `(state) => ({ updates: state.rows.stored.length ? [] :
  [{ op: "put", id: "c", row: { series: "empty" } }] })`
const fold = `(state) => {
  const view = state.rows.chart[0];
  const series = state.items.map(p => p.value).join(",");
  return { updates: !view || view.series === series ? [] :
    [{ op: "patch", entity: "chart", id: view.id, row: { series } }] };
}`

async function boot(html = chart, handlers = { seed, fold }, prepare?: (store: any) => void) {
  const ambient = { document: globalThis.document, fetch: globalThis.fetch, sessionStorage: globalThis.sessionStorage }
  const { document } = parseHTML("<html><head></head><body><div id='app'></div></body></html>")
  globalThis.document = document as any
  globalThis.sessionStorage = { getItem: () => null } as any
  const files: Record<string, string> = { "chart.html": html, "chart.css": "" }
  for (const [name, body] of Object.entries(handlers)) files[`${name}.js`] = body
  globalThis.fetch = ((url: URL | string) => {
    const file = files[new URL(String(url), "http://localhost/").pathname.slice(1)]
    if (file === undefined) throw new Error(`unexpected fetch ${url}`)
    return Promise.resolve(new Response(file))
  }) as typeof fetch
  const store = createStore("", { carriers: FIXTURE_CARRIERS, local: { chart: "tab", point: "tab" } })
  await store.write("point", [{ key: "p1", row: { value: "12" } }, { key: "p2", row: { value: "24" } }])
  prepare?.(store)
  const route = { screen: "chart", files: { html: "chart.html", css: "chart.css", handlers: Object.keys(handlers).map(name => `${name}.js`) } }
  const handle = await interpretScreen(document.getElementById("app"), "http://localhost/", route, store)
  return { document, store, handle, stop() { handle.stop(); Object.assign(globalThis, ambient) } }
}

describe("a screen's present work", () => {
  it("settles a fallback seed, nested source fold and its tab row before answering", async () => {
    // A first region paint is not the chart's answer: the seed must become a
    // stored row, the source must fold it, and the parent's binding must read
    // that fold. Posted subscription wakes are part of those dependencies.
    const app = await boot()
    try {
      await app.handle.settle()
      expect(app.document.querySelector(".series")?.textContent).toBe("12,24")
      expect((await app.store.query("chart"))[0].series).toBe("12,24")
      expect(app.store.flushNotifications()).toBe(0)
    } finally { app.stop() }
  })

  it("settles separate chart worlds whose named reads share one parameter template", async () => {
    // The same authored read can name different chart rows. Sharing its seat
    // before binding the ID reruns only the first seed and leaves the other empty.
    const slot = (id: string, point: string) => `<div data-live="chart" data-filter="id=eq.${id}"
      data-empty-row='{"id":"${id}","series":"empty"}'
      data-on-mutation="seed" data-read-stored="chart?id=eq.{id}">
      <p class="series" data-text="{series}"></p>
      <div data-live="point" data-filter="id=eq.${point}" data-on-mutation="fold"
           data-read-chart="chart?id=eq.{id}"><template data-item><span hidden></span></template></div>
    </div>`
    const app = await boot(`<section class="screen" data-screen="chart">${slot("c1", "p1")}${slot("c2", "p2")}</section>`, {
      seed: `(state) => {
        if (state.rows.stored.length || !state.items[0]) return { updates: [] };
        const { id, ...row } = state.items[0];
        return { updates: [{ op: "put", id, row }] };
      }`,
      fold,
    })
    try {
      await app.handle.settle()
      expect([...app.document.querySelectorAll(".series")].map(node => node.textContent)).toEqual(["12", "24"])
      expect((await app.store.query("chart", "id.asc")).map((row: any) => [row.id, row.series])).toEqual([
        ["c1", "12"], ["c2", "24"],
      ])
      expect(app.store.flushNotifications()).toBe(0)
    } finally { app.stop() }
  })

  it("serializes equivalent bound reads written as literals and parameter templates", async () => {
    const slot = (id: string) => `<div data-live="chart" data-filter="id=eq.c"
      data-empty-row='{"id":"c","series":"empty"}' data-on-mutation="seed"
      data-read-stored="chart?id=eq.${id}"><p data-text="{series}"></p></div>`
    let active = 0
    let peak = 0
    const app = await boot(`<section class="screen" data-screen="chart">${slot("c")}${slot("{id}")}</section>`, { seed, fold }, store => {
      const query = store.query
      store.query = async (table: string, order: string | null, options: any) => {
        if (table !== "chart" || order !== null || options.filter !== "id=eq.c") return query(table, order, options)
        active++
        peak = Math.max(peak, active)
        try {
          await new Promise(resolve => setTimeout(resolve, 1))
          return await query(table, order, options)
        } finally { active-- }
      }
    })
    try {
      await app.handle.settle()
      expect(peak).toBe(1)
      expect((await app.store.query("chart")).map((row: any) => row.id)).toEqual(["c"])
    } finally { app.stop() }
  })

  it("rejects a failed detached derived read", async () => {
    const app = await boot(chart.replace("chart?id=eq.c\">\n      <template", "missing?id=eq.c\">\n      <template"))
    try {
      await expect(app.handle.settle()).rejects.toThrow(/missing/)
    } finally { app.stop() }
  })

  it("keeps the browser's first paint incremental while settlement waits for its derived reads", async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const app = await boot(chart, { seed, fold }, store => {
      const query = store.query
      store.query = async (table: string, order: string | null, options: object) => {
        if (table === "chart" && order === null) await held
        return query(table, order, options)
      }
    })
    try {
      expect(app.document.querySelector(".series")?.textContent).toBe("empty")
      let complete = false
      const settled = app.handle.settle().then(() => { complete = true })
      await Promise.resolve()
      expect(complete).toBe(false)
      release()
      await settled
      expect(app.document.querySelector(".series")?.textContent).toBe("12,24")
    } finally { release(); app.stop() }
  })

  it("drains immediate handler continuations before the seat hands off its next run", async () => {
    const app = await boot(chart, { seed, fold: fold.replace("(state) =>", "(state, event) =>")
      .replace("  const view", '  if (event.type === "mutation") return { updates: [], then: { type: "compute" } };\n  const view') })
    try {
      await app.handle.settle()
      expect(app.document.querySelector(".series")?.textContent).toBe("12,24")
    } finally { app.stop() }
  })

  it("flushes a batch once and keeps stopped subscriptions detached", async () => {
    const app = await boot()
    try {
      await app.handle.settle()
      let wakes = 0
      const stop = app.store.subscribe("point", () => { wakes++ })
      await app.store.query("point")
      app.store.flushNotifications()
      wakes = 0
      await app.store.patch("point", [
        { key: "p1", changes: { value: "13" } },
        { key: "p2", changes: { value: "25" } },
      ])
      app.store.flushNotifications()
      expect(wakes).toBe(1)
      await app.handle.settle()
      app.store.flushNotifications()
      expect(wakes).toBe(1)
      stop()
      await app.store.patch("point", [{ key: "p1", changes: { value: "14" } }])
      await app.handle.settle()
      expect(wakes).toBe(1)
      expect(app.document.querySelector(".series")?.textContent).toBe("14,25")
    } finally { app.stop() }
  })

  it("rejects a fold which changes its own input forever", async () => {
    const app = await boot(`<section class="screen" data-screen="chart"><div data-live="point"
      data-on-mutation="fold"><template data-item><p data-text="{value}"></p></template></div></section>`, {
      seed,
      fold: `(state) => ({ updates: state.items.map(p => ({ op: "patch", id: p.id,
        row: { value: p.value === "a" ? "b" : "a" } })) })`,
    })
    try {
      await expect(app.handle.settle()).rejects.toThrow(/did not settle/)
    } finally { app.stop() }
  })

  it("answers while a handler's future continuation is held by the clock", async () => {
    const originalSetTimeout = globalThis.setTimeout
    let waits = 0
    globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms === 60000) { waits++; return 0 }
      return originalSetTimeout(fn, ms, ...args)
    }) as typeof setTimeout
    const app = await boot(`<section class="screen" data-screen="chart"><div data-live="point"
      data-on-mutation="fold"><template data-item><p data-text="{value}"></p></template></div></section>`, {
      seed,
      fold: `() => ({ updates: [], then: { type: "later", delay: 60000 } })`,
    })
    try {
      await app.handle.settle()
      expect(app.document.querySelector("p")?.textContent).toBe("12")
      expect(waits).toBe(1)
    } finally {
      globalThis.setTimeout = originalSetTimeout
      app.stop()
    }
  })

  it("poses rows in-memory without HTTP writes, sorts snapshot data-read-* by carrier PK, and isolates screen CSS across prefetch and hidden mounts", async () => {
    const html = `<section class="screen" data-screen="chart">
      <div data-live="chart" data-filter="id=eq.c" data-empty-row='{"id":"c","series":"empty"}'
           data-on-mutation="fold" data-read-points="point?value=ilike.*v*">
        <p class="series" data-text="{series}"></p>
        <div class="nested" data-live="point">
          <template data-item><span class="pt" data-text="{value}"></span></template>
        </div>
      </div>
    </section>`
    const unorderedFold = `(state) => {
      const view = state.items[0];
      const series = state.rows.points.map(p => p.id + ":" + p.value).join(",");
      return { updates: !view || view.series === series ? [] :
        [{ op: "put", id: view.id, row: { series } }] };
    }`
    const ambientDoc = globalThis.document
    const { document: preDoc } = parseHTML(
      "<html><head><style id='screen-css-stale'>.x{color:red}</style></head><body><div id='app'></div><div id='bg' hidden></div></body></html>",
    )
    globalThis.document = preDoc as any
    globalThis.sessionStorage = { getItem: () => null } as any
    const httpMethods: string[] = []
    globalThis.fetch = ((url: URL | string, init?: RequestInit) => {
      const m = init?.method ?? "GET"
      httpMethods.push(`${m} ${new URL(String(url), "http://localhost/").pathname}`)
      const name = new URL(String(url), "http://localhost/").pathname.slice(1)
      const files: Record<string, string> = {
        "chart.html": html,
        "chart.css": ".series{color:blue}",
        "other.html": `<section class="screen" data-screen="other"><p>other</p></section>`,
        "other.css": ".series{color:green}",
        "bg.html": `<section class="screen" data-screen="bg"><p>bg</p></section>`,
        "bg.css": ".series{color:yellow}",
        "fold.js": unorderedFold,
      }
      if (files[name] !== undefined) return Promise.resolve(new Response(files[name]))
      throw new Error(`unexpected fetch ${m} ${url}`)
    }) as typeof fetch
    const store = createStore("", {
      carriers: FIXTURE_CARRIERS,
      local: { chart: "tab", point: "tab" },
      schema: {
        chart: { fields: [{ name: "id", type: "string", pk: true }, { name: "series", type: "string" }] },
        point: { fields: [{ name: "id", type: "int64", pk: true }, { name: "value", type: "string" }] },
      },
    })
    // Insert int64 string PK "10" before "2": plain JS string < sorts "10" < "2",
    // whereas carrier-aware sortByPk via store.orderOf sorts "2" before "10".
    await store.write("point", [{ key: "10", row: { value: "v10" } }, { key: "2", row: { value: "v2" } }])
    const route = { screen: "chart", files: { html: "chart.html", css: "chart.css", handlers: ["fold.js"] } }
    const handle = await interpretScreen(preDoc.getElementById("app"), "http://localhost/", route, store)
    let bgHandle: any
    try {
      await handle.settle()
      expect(preDoc.querySelector(".series")?.textContent).toBe("2:v2,10:v10")
      expect(preDoc.querySelector(".nested")?.hasAttribute("data-hydrating")).toBe(false)
      expect((preDoc.getElementById("screen-css-stale") as any)?.disabled).toBe(true)
      expect((preDoc.getElementById("screen-css-chart") as any)?.disabled).toBe(false)

      // Prefetching another screen installs its stylesheet disabled.
      prefetchScreen("http://localhost/", {
        screen: "other",
        files: { html: "other.html", css: "other.css", handlers: [] },
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect((preDoc.getElementById("screen-css-other") as any)?.disabled).toBe(true)
      expect((preDoc.getElementById("screen-css-chart") as any)?.disabled).toBe(false)

      // Interpreting a screen into a hidden mount installs its stylesheet disabled
      // without disabling the active screen's stylesheet.
      bgHandle = await interpretScreen(
        preDoc.getElementById("bg"),
        "http://localhost/",
        { screen: "bg", files: { html: "bg.html", css: "bg.css", handlers: [] } },
        store,
      )
      expect((preDoc.getElementById("screen-css-bg") as any)?.disabled).toBe(true)
      expect((preDoc.getElementById("screen-css-chart") as any)?.disabled).toBe(false)

      // Updating a hidden cached screen's stylesheet keeps it disabled and leaves the active screen's stylesheet enabled.
      await bgHandle.updateStyle(".series{color:orange}")
      expect((preDoc.getElementById("screen-css-bg") as any)?.textContent).toBe(".series{color:orange}")
      expect((preDoc.getElementById("screen-css-bg") as any)?.disabled).toBe(true)
      expect((preDoc.getElementById("screen-css-chart") as any)?.disabled).toBe(false)

      // Interpreting a second instance of the SAME route.screen ("chart") into a hidden mount
      // must NOT disable the shared #screen-css-chart stylesheet while a visible "chart" instance is mounted.
      const hiddenSameScreen = await interpretScreen(
        preDoc.getElementById("bg"),
        "http://localhost/",
        route,
        store,
      )
      expect((preDoc.getElementById("screen-css-chart") as any)?.disabled).toBe(false)
      hiddenSameScreen.stop()

      // Switching active screen style toggles disabled across screen-css-* sheets.
      activateScreenStyle("screen-css-other")
      expect((preDoc.getElementById("screen-css-other") as any)?.disabled).toBe(false)
      expect((preDoc.getElementById("screen-css-chart") as any)?.disabled).toBe(true)
      activateScreenStyle("screen-css-chart")
      expect((preDoc.getElementById("screen-css-chart") as any)?.disabled).toBe(false)
      expect((preDoc.getElementById("screen-css-other") as any)?.disabled).toBe(true)

      // Posing a row updates the dependent region in-memory without HTTP writes,
      // and re-rendering the parent singleton slot does not re-stamp data-hydrating on .nested.
      await store.pose("point", { id: "2", value: "v99" })
      await handle.settle()
      expect(preDoc.querySelector(".series")?.textContent).toBe("2:v99,10:v10")
      expect(preDoc.querySelector(".nested")?.hasAttribute("data-hydrating")).toBe(false)
      expect(httpMethods.filter(m => m.startsWith("POST ") || m.startsWith("PATCH "))).toEqual([])
    } finally {
      bgHandle?.stop()
      handle.stop()
      globalThis.document = ambientDoc
    }
  })

  it("evaluates posed server-tier queries with offset before limit and throws on unsupported posed filters", async () => {
    const store = createStore("", {
      carriers: FIXTURE_CARRIERS,
      local: {},
      schema: {
        item: { fields: [{ name: "id", type: "string", pk: true }, { name: "rank", type: "int64" }] },
      },
    })
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify([
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
      { id: "c", rank: 3 },
    ])))) as typeof fetch
    await store.query("item", "id.asc")
    await store.pose("item", { id: "b", rank: 20 })
    const paged = await store.query("item", "id.asc", { filter: "offset=1&limit=1" })
    expect(paged).toEqual([{ id: "b", rank: 20 }])
    await expect(store.query("item", undefined, { filter: "tags=cs.{x}" })).rejects.toThrow(/unsupported filter on posed table item/)
  })

  it("restates nested list regions with data-read-* placeholders and wakes data-read-* dependents on form change", async () => {
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms === 600) return 0
      return originalSetTimeout(fn, ms, ...args)
    }) as typeof setTimeout
    const html = `<section class="screen" data-screen="chart">
      <div data-live="chart" data-filter="id=eq.c" data-empty-row='{"id":"c","series":"12"}'>
        <form data-entity="chart" data-action="upsert">
          <input type="hidden" name="id" data-value="{id}">
          <input class="q" type="text" name="series" data-value="{series}">
        </form>
        <div id="pts-region" data-live="point" data-on-mutation="filterFold" data-read-pts="point?value=ilike.*{series}*">
          <template data-item><span class="pt" data-text="{value}"></span></template>
        </div>
      </div>
    </section>`
    const filterFold = `(state, event) => {
      const matched = (event.from ?? "") + ":" + state.rows.pts.map(p => p.id).join(",");
      return { updates: state.items[0]?.matched === matched ? [] :
        state.items.map(p => ({ op: "patch", id: p.id, row: { matched } })) };
    }`
    const app = await boot(html, { seed, fold: filterFold, filterFold } as any)
    try {
      await app.handle.settle()
      expect((await app.store.query("point", "id.asc"))[0].matched).toBe("pts-region:p1")
      const form = app.document.querySelector("form") as any
      form.checkValidity = () => true
      form.reset = () => {}
      form.requestSubmit = () => form.dispatchEvent(new (app.document.defaultView?.Event ?? Event)("submit", { bubbles: true, cancelable: true }))
      const input = app.document.querySelector(".q") as any
      input.value = "24"
      input.dispatchEvent(new (app.document.defaultView?.Event ?? Event)("change", { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 10))
      await app.handle.settle()
      expect((await app.store.query("point", "id.asc"))[0].matched).toBe("pts-region:p2")
    } finally {
      globalThis.setTimeout = originalSetTimeout
      app.stop()
    }
  })
})
