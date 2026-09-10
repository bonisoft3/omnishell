// What the terminal leaves behind after it has rendered the same region a
// thousand times.
//
// This is the one thing a per-test browser could never catch, and the reason
// it could not is worth stating: isolation and leak detection pull opposite
// ways. A suite that starts every test from a clean process guarantees nothing
// accumulates, which is exactly the condition under which accumulation cannot
// be observed. The soak does the opposite on purpose — one context, one page,
// many cycles — and asks whether the counters come back.
//
// The counters are the browser's own, taken after a forced collection:
// `JSEventListeners` and `Nodes` are exact (a rooted leak of 1000 listeners
// reads 1000, and releasing it reads 0), while `JSHeapUsedSize` drifts by tens
// of kilobytes between identical reads and is therefore reported and never
// asserted on.
//
// What it holds the interpreter to: a keyed reconciler that reuses row nodes
// must not accumulate them, and the wiring passes that run on every refresh —
// bindings, key bindings, forms — must not stack a second listener on a node
// they already wired.
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, type Page, withPage } from "./harness.ts"

const interpreter = path.join(path.dirname(fileURLToPath(import.meta.url)), "../interpreter")
const ORIGIN = "http://soak.test"

// A row carrying the things that get wired per render: a bound attribute, a
// form the terminal owns the submit of, and a key binding naming that form.
const SCREEN_HTML = `<section class="screen" data-screen="lines">
  <ul class="lines" data-live="line" data-order="position.asc"
      data-project='{"nxt":"next","prv":"prev"}'>
    <template data-item>
      <li id="row-{id}" data-id="{id}" data-note="{note}">
        <form id="go-{id}" data-form="go" data-entity="line" data-action="upsert">
          <input type="hidden" name="id" data-value="{id}">
          <input type="hidden" name="note" data-value="{nxt}">
        </form>
        <div tabindex="0" data-key='{"ArrowDown":"go-{nxt}"}'></div>
      </li>
    </template>
  </ul>
</section>`

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>soak</title></head>
<body><div id="shell"></div>
<script type="module">
  import { interpretScreen } from "./screen.js"
  const make = (n, gen) =>
    Array.from({ length: n }, (_, i) => ({ id: "r" + i, position: i + 1, note: "gen" + gen }))
  let rows = make(20, 0)
  let notify
  const store = {
    query: async () => rows.slice().sort((x, y) => x.position - y.position),
    subscribe: (_t, fn) => { notify = fn; return () => {} },
    create: async () => {}, update: async () => {}, remove: async () => {}, upsert: async () => {},
  }
  // One cycle: every row's bound value moves, so every row re-binds and the
  // reconciler keeps the nodes it already has.
  window.__cycle = async (gen) => { rows = make(20, gen); await notify() }
  // The other shape: the row SET changes, so nodes are created and dropped.
  window.__churn = async (gen, n) => { rows = make(n, gen); await notify() }
  await interpretScreen(document.getElementById("shell"), location.origin + "/", {
    screen: "lines",
    files: { html: "screen.html", css: "screen.css", handlers: [] },
    states: ["loading", "empty", "populated"],
  }, store, {})
  window.__ready = true
</script>
</body></html>`

// deno-lint-ignore no-explicit-any
type Any = any

async function open(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== ORIGIN) return route.abort()
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: PAGE })
    if (url.pathname === "/screen.html") {
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: SCREEN_HTML })
    }
    if (url.pathname === "/screen.css") return route.fulfill({ contentType: "text/css", body: "" })
    if (/\.js$/.test(url.pathname)) {
      return route.fulfill({
        contentType: "text/javascript; charset=utf-8",
        body: await readFile(path.join(interpreter, url.pathname.slice(1)), "utf8"),
      })
    }
    return route.abort()
  })
  await page.goto(`${ORIGIN}/`)
  await page.waitForFunction(() => (globalThis as Any).__ready === true)
}

type Counts = { listeners: number; nodes: number; heapKB: number }

/** The browser's own counters, after a collection it was told to run. Without
 * the collect this reads whatever the collector had not got to yet, which
 * moves between runs and would make every assertion below a coin toss. */
async function counts(page: Page): Promise<Counts> {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send("Performance.enable")
    await cdp.send("HeapProfiler.enable")
    await cdp.send("HeapProfiler.collectGarbage")
    const { metrics } = await cdp.send("Performance.getMetrics")
    const m = Object.fromEntries((metrics as { name: string; value: number }[]).map((x) => [x.name, x.value]))
    return { listeners: m.JSEventListeners, nodes: m.Nodes, heapKB: Math.round(m.JSHeapUsedSize / 1024) }
  } finally {
    await cdp.detach()
  }
}

describe("soak", () => {
  it("re-renders one row set a hundred times and gives every node back", async () => {
    await withPage(async (page) => {
      await open(page)
      // A first cycle before the baseline: the very first render is where
      // one-time wiring lands, and counting it as growth would report the
      // terminal's own setup as a leak.
      await page.evaluate(() => (globalThis as Any).__cycle(1))
      const before = await counts(page)

      // The loop runs IN the page: one round trip per render would measure the
      // protocol rather than the reconciler.
      await page.evaluate(async () => {
        for (let gen = 2; gen <= 101; gen++) await (globalThis as Any).__cycle(gen)
      })
      const after = await counts(page)

      // The rows are the same twenty throughout, so the reconciler reuses
      // every node and nothing should have been added at all.
      expect(after.nodes).toBe(before.nodes)
      // The wiring passes run again on every refresh. A listener stacked per
      // pass would be a hundred of them per node, which is what the flags on
      // each element exist to prevent.
      expect(after.listeners).toBe(before.listeners)
      console.log(`    100 re-renders: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
    })
  })

  it("churns the row set and settles back where it started", async () => {
    await withPage(async (page) => {
      await open(page)
      await page.evaluate(() => (globalThis as Any).__churn(1, 20))
      const before = await counts(page)

      // Rows arrive and depart fifty times over. Nodes are genuinely created
      // and dropped here, so what is asserted is that they are RELEASED —
      // a detached row still held by a closure is the leak this catches.
      await page.evaluate(async () => {
        for (let gen = 2; gen <= 51; gen++) {
          await (globalThis as Any).__churn(gen, 40)
          await (globalThis as Any).__churn(gen + 1000, 20)
        }
      })
      const after = await counts(page)

      expect(after.nodes).toBe(before.nodes)
      expect(after.listeners).toBe(before.listeners)
      console.log(`    50 churn rounds: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
    })
  })

  it("measures a real leak, so a green soak means something", async () => {
    // The control. Without it a soak that measured nothing at all would pass
    // exactly as loudly as one that measured a healthy screen — and the first
    // version of this file did measure nothing, because the nodes it leaked
    // referenced only each other and were collected.
    await withPage(async (page) => {
      await open(page)
      const before = await counts(page)
      await page.evaluate(() => {
        const kept: unknown[] = ((globalThis as Any).__kept = [])
        for (let i = 0; i < 500; i++) {
          const d = document.createElement("div")
          d.addEventListener("click", () => {})
          kept.push(d)
        }
      })
      const leaked = await counts(page)
      expect(leaked.nodes - before.nodes).toBe(500)
      expect(leaked.listeners - before.listeners).toBe(500)

      await page.evaluate(() => {
        ;(globalThis as Any).__kept.length = 0
      })
      const released = await counts(page)
      expect(released.nodes).toBe(before.nodes)
      expect(released.listeners).toBe(before.listeners)
    })
  })
})
