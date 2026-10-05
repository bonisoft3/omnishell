import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import "../interpreter/vendor/ses.umd.min.js"
import { ensureSes } from "../interpreter/jessie.js"
import { createStore } from "../interpreter/data-sync.js"
import { FIXTURE_CARRIERS } from "../interpreter/fixture-types.js"
import { interpretScreen } from "../interpreter/screen.js"

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
})
