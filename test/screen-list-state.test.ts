import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { interpretScreen } from "../interpreter/screen.js"

const HTML = `<section class="screen" data-screen="feed">
  <ul class="upcoming" data-live="game" data-filter="kind=eq.upcoming" data-empty="No upcoming games"><template data-item><li data-text="{label}"></li></template></ul>
  <ul class="recent" data-live="game" data-filter="kind=eq.recent" data-empty="No recent games"><template data-item><li data-text="{label}"></li></template></ul>
</section>`
const ROUTE = {
  screen: "feed",
  files: { html: "feed.html", css: "feed.css", handlers: [] },
  states: ["loading", "empty", "populated"],
}
type Kind = "upcoming" | "recent"
type Row = { id: string; label: string }

async function mountWith(last?: Kind, fixtures = false) {
  const { document } = parseHTML("<!doctype html><html><head></head><body><main></main></body></html>")
  globalThis.document = document as any
  globalThis.fetch = ((url: unknown) => Promise.resolve(new Response(String(url).endsWith(".html") ? HTML : ""))) as any
  const mount = document.querySelector("main")!
  const rows: Record<Kind, Row[]> = { upcoming: [{ id: "g1", label: "One game" }], recent: [] }
  const wakes = new Map<Kind, () => Promise<void>>()
  let release!: () => void
  const held = new Promise<void>((resolve) => release = resolve)
  const kindOf = (opts: { filter: string }) => opts.filter.split(".")[1] as Kind
  const store = {
    query: async (_table: string, _order: unknown, opts: { filter: string }) => {
      const kind = kindOf(opts)
      if (kind === last) await held
      return rows[kind]
    },
    subscribe: (_table: string, fn: () => Promise<void>, opts: { filter: string }) => {
      const kind = kindOf(opts)
      wakes.set(kind, fn)
      return () => { wakes.delete(kind) }
    },
  }
  const pending = interpretScreen(mount, "http://localhost/", ROUTE, store, {}, { handlers: false, fixtures })
  if (last !== undefined) {
    const first = last === "upcoming" ? "recent" : "upcoming"
    try {
      const deadline = Date.now() + 1000
      while (!mount.querySelector(`.${first}`)?.textContent.trim()) {
        if (Date.now() >= deadline) throw new Error(`${first} did not paint before the held read`)
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    } finally {
      release()
    }
  }
  const handle = await pending
  return { handle, rows, wake: (kind: Kind) => wakes.get(kind)!(), state: () => mount.querySelector(".screen")!.getAttribute("data-state") }
}

describe("the screen state across top-level lists", () => {
  // An empty home feed cannot say the homepage is empty when another feed
  // has games, regardless of which read finishes last.
  for (const fixtures of [false, true]) {
    for (const last of ["upcoming", "recent"] as const) {
      it(`is populated when ${last} settles last (${fixtures ? "fixture" : "progressive"} paint)`, async () => {
        const m = await mountWith(last, fixtures)
        try {
          expect(m.state()).toBe("populated")
        } finally {
          m.handle.stop()
        }
      })
    }
  }

  it("is empty only after every list empties, including sibling wakes", async () => {
    const m = await mountWith()
    try {
      await m.wake("recent")
      expect(m.state()).toBe("populated")
      m.rows.recent.push({ id: "g2", label: "Another game" })
      await m.wake("recent")
      m.rows.upcoming.length = 0
      await m.wake("upcoming")
      expect(m.state()).toBe("populated")
      m.rows.recent.length = 0
      await m.wake("recent")
      expect(m.state()).toBe("empty")
      m.rows.upcoming.push({ id: "g3", label: "Next game" })
      await m.wake("upcoming")
      expect(m.state()).toBe("populated")
      await m.wake("recent")
      expect(m.state()).toBe("populated")
    } finally {
      m.handle.stop()
    }
  })

  it("releases the content of a list removed by a newer template", async () => {
    const m = await mountWith()
    try {
      await m.handle.morph(HTML.replace(/  <ul class="upcoming"[^\n]+\n/, ""))
      await m.wake("recent")
      expect(m.state()).toBe("empty")
    } finally {
      m.handle.stop()
    }
  })
})
