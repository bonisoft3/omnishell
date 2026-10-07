import { expect } from "@test/harness"
import { createRenderer, warmEagerTables } from "../server/render.ts"
import { FIXTURE_CARRIERS } from "../interpreter/fixture-types.js"
import type { createStore as CreateStore } from "../interpreter/data-sync.js"
import { until, withBrowser } from "../interpreter/smoke-browser.js"

Deno.test({
  name: "retained documents lease their on-demand query until invalidation or eviction",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const requests: URL[] = []
    const rows = [{ id: "1", name: "first" }, { id: "2", name: "second" }]
    const changes: unknown[] = []
    let wake: (() => void) | undefined
    let offset = 1
    const message = (value: typeof rows[number]) => ({
      key: `"public"."card"/"${value.id}"`, value,
      headers: { operation: "insert", relation: ["public", "card"] },
    })
    const fetcher = async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input))
      requests.push(url)
      if (url.pathname === "/auth/shape") return Response.json({ token: "shape", where: "true", expires_in: 900 })
      const headers = {
        "electric-handle": "cards", "electric-offset": `0_${offset}`, "electric-cursor": String(offset),
        "electric-schema": JSON.stringify({ id: { type: "text" }, name: { type: "text" } }),
      }
      if (url.searchParams.has("subset__where")) {
        const params = JSON.parse(url.searchParams.get("subset__params") ?? "{}")
        return Response.json({
          metadata: { xmin: "1", xmax: "1", xip_list: [], snapshot_mark: offset, database_lsn: String(offset) },
          data: rows.filter(row => row.id === params["1"]).map(message),
        }, { headers })
      }
      if (url.searchParams.get("live") === "true" && changes.length === 0) {
        await new Promise<void>((resolve, reject) => {
          wake = resolve
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
        })
      }
      wake = undefined
      return Response.json([...changes.splice(0), { headers: { control: "up-to-date", global_last_seen_lsn: String(offset) } }], { headers })
    }
    const cfg = {
      tables: ["card"], carriers: FIXTURE_CARRIERS, sync: { card: "on-demand" },
      schema: { card: { durability: "live", fields: [{ name: "id", type: "string" }, { name: "name", type: "string" }] } },
    }
    const online = Object.getOwnPropertyDescriptor(navigator, "onLine")
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true })
    try {
      await withBrowser({ fetch: fetcher }, async (createStore: typeof CreateStore) => {
        const store = createStore("http://render-demand", cfg)
        await warmEagerTables(store, cfg)
        expect(requests).toHaveLength(0)
        const renderer = createRenderer({
          store, origin: "https://example.test", capacity: 1, queue: 2,
          route: pathname => ({ route: { screen: "card", path: "/:id" }, params: { id: pathname.slice(1) } }),
          async render(found, watched) {
            const opts = { filter: `id=eq.${found.params.id}` }
            const stop = watched.subscribe("card", () => {}, opts)
            try {
              const result = await watched.query("card", null, opts)
              return { html: JSON.stringify(result), gone: false }
            } finally { stop() }
          },
        })
        const get = (id: string) => renderer.handle(new Request(`https://example.test/${id}`))
        const views = () => (globalThis as unknown as { __prontoViews: Map<string, { refs: number }> }).__prontoViews
        const prime = async (id: string) => {
          let notified = false
          const opts = { filter: `id=eq.${id}` }
          const stop = store.subscribe("card", () => { notified = true }, opts)
          await store.query("card", null, opts)
          await until(() => notified, "initial snapshot notification arrived")
          return stop
        }
        const first = await prime("1")
        expect(await (await get("1")).text()).toContain("first")
        first()
        expect(renderer.held).toBe(1)
        expect([...views().values()].map(view => view.refs)).toEqual([1])
        const second = await prime("2")
        await get("2")
        second()
        expect([...views().keys()].every(key => !key.includes("id=eq.1"))).toBe(true)
        expect(renderer.held).toBe(1)
        expect([...views().values()].map(view => view.refs)).toEqual([1])
        rows[1] = { id: "2", name: "changed" }
        offset++
        changes.push(message(rows[1]))
        wake?.()
        await until(() => renderer.held === 0, "live changes invalidated the retained document")
        expect(views().size).toBe(0)
        expect(requests.filter(url => url.searchParams.has("subset__where"))
          .every(url => url.searchParams.get("subset__where") === '"id" = $1')).toBe(true)
        expect(requests.filter(url => url.pathname === "/electric/v1/shape" && !url.searchParams.has("subset__where") && url.searchParams.get("live") !== "true")
          .every(url => url.searchParams.get("log") === "changes_only")).toBe(true)
      })
    } finally {
      if (online) Object.defineProperty(navigator, "onLine", online)
      else delete (navigator as unknown as { onLine?: boolean }).onLine
    }
  },
})
