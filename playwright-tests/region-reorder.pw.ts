// Playwright (run: `bun x playwright test region-reorder`): a live region's
// rows keep their state when the region reorders them. This cannot be asserted
// in a DOM shim — linkedom has no focus, no iframes and no moveBefore, so it
// would only ever be able to check which method was called, and which method
// was called is not what a reader notices.
//
// The property under test: reordering rows must not tear down what is inside
// them. insertBefore relocates by removing and re-inserting, which blurs a
// focused field and reloads an embedded document; moveBefore relocates without
// the teardown. Measured before landing it: a two-row swap in a twenty-row
// list reloaded 13 iframes with insertBefore and 0 with moveBefore
// (plugins/omnishell/docs/2026-08-02-reconciliation-libraries.md).
import { test, expect, type Page } from "@playwright/test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const interpreter = path.join(__dirname, "../interpreter")

const ORIGIN = "http://region.test"

// Each row carries both observable states: a text field the reader can be
// typing in, and an embedded document that announces every load.
const SCREEN_HTML = `<section class="screen" data-screen="lines">
  <ul class="lines" data-live="line" data-order="position.asc">
    <template data-item>
      <li><input name="note" /><iframe src="/embed" sandbox="allow-scripts"></iframe></li>
    </template>
  </ul>
</section>`

const EMBED = `<!doctype html><script>parent.postMessage("embed-load","*")</script>`

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>region harness</title></head>
<body><div id="shell"></div>
<script>
  window.__loads = 0
  addEventListener("message", (e) => { if (e.data === "embed-load") window.__loads++ })
</script>
<script type="module">
  import { interpretScreen } from "./screen.js"
  // A store the test drives by hand: rows in, one subscriber out, so a
  // reorder is exactly one refresh with the same ids in a new order.
  let rows = [
    { id: "a", position: 1 },
    { id: "b", position: 2 },
    { id: "c", position: 3 },
    { id: "d", position: 4 },
  ]
  let notify
  const store = {
    query: async () => rows.slice().sort((x, y) => x.position - y.position),
    subscribe: (_t, fn) => { notify = fn; return () => {} },
    create: async () => {}, update: async () => {}, remove: async () => {},
  }
  window.__reorder = async (order) => {
    rows = order.map((id, i) => ({ id, position: i + 1 }))
    await notify()
  }
  window.__order = () => [...document.querySelectorAll("li[data-id]")].map((li) => li.dataset.id)
  await interpretScreen(document.getElementById("shell"), location.origin + "/", {
    screen: "lines",
    files: { html: "screen.html", css: "screen.css", handlers: [] },
    states: ["loading", "empty", "populated"],
  }, store, {})
  window.__ready = true
</script>
</body></html>`

type Any = any

async function open(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== ORIGIN) return route.abort()
    if (url.pathname === "/") {
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: PAGE })
    }
    if (url.pathname === "/embed") {
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: EMBED })
    }
    if (url.pathname === "/screen.html") {
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: SCREEN_HTML })
    }
    if (url.pathname === "/screen.css") return route.fulfill({ contentType: "text/css", body: "" })
    if (/\.js$/.test(url.pathname)) {
      const body = await readFile(path.join(interpreter, url.pathname.slice(1)), "utf8")
      return route.fulfill({ contentType: "text/javascript; charset=utf-8", body })
    }
    return route.abort()
  })
  await page.goto(`${ORIGIN}/`)
  await page.waitForFunction(() => (window as Any).__ready === true)
  await page.waitForFunction(() => (window as Any).__loads === 4)
}

test("the engine under test actually has moveBefore", async ({ page }) => {
  await open(page)
  // If this ever fails, every other assertion here is passing for the wrong
  // reason: the fallback path is being measured, not the improvement. The
  // method is on the ParentNode mixin — Element, never Node.prototype.
  expect(
    await page.evaluate(() => ({
      onElement: typeof (Element.prototype as Any).moveBefore,
      onNode: typeof (Node.prototype as Any).moveBefore,
    })),
  ).toEqual({ onElement: "function", onNode: "undefined" })
})

test("a reorder keeps a row's focus and its unsent text", async ({ page }) => {
  await open(page)
  // A reader typing into a row while the list re-sorts under them: their
  // caret and their unsent text belong to them, not to the sort order.
  await page.evaluate(() => {
    const input = document.querySelector('li[data-id="d"] input') as HTMLInputElement
    input.focus()
    input.value = "half-written thought"
  })
  await page.evaluate(() => (window as Any).__reorder(["d", "a", "b", "c"]))

  expect(await page.evaluate(() => (window as Any).__order())).toEqual(["d", "a", "b", "c"])
  expect(
    await page.evaluate(() => {
      const active = document.activeElement as HTMLInputElement
      return { row: active?.closest("li")?.dataset.id, value: active?.value }
    }),
  ).toEqual({ row: "d", value: "half-written thought" })
})

test("a reorder does not reload the documents embedded in the rows", async ({ page }) => {
  await open(page)
  const loads = () => page.evaluate(() => (window as Any).__loads as number)
  expect(await loads()).toBe(4)

  // The shape that cost the most before moveBefore: two distant rows trading
  // places, which walks the cursor across every row between them.
  await page.evaluate(() => (window as Any).__reorder(["d", "b", "c", "a"]))
  expect(await page.evaluate(() => (window as Any).__order())).toEqual(["d", "b", "c", "a"])
  await page.waitForTimeout(500)
  expect(await loads()).toBe(4)

  // A full reversal moves every row.
  await page.evaluate(() => (window as Any).__reorder(["a", "c", "b", "d"]))
  await page.waitForTimeout(500)
  expect(await loads()).toBe(4)
})

test("a row arriving is inserted, not moved", async ({ page }) => {
  await open(page)
  // moveBefore throws on a node that is not already in the document, so a row
  // stamped from the template this pass must still go in with insertBefore.
  // A fresh row appearing mid-list is what would catch that guard inverted.
  await page.evaluate(() => (window as Any).__reorder(["a", "b", "fresh", "c", "d"]))
  expect(await page.evaluate(() => (window as Any).__order())).toEqual(["a", "b", "fresh", "c", "d"])
  await page.waitForFunction(() => (window as Any).__loads === 5)
  expect(await page.evaluate(() => (window as Any).__loads)).toBe(5)
})
