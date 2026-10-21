import { describe, expect, it, type Page, withPage } from "./harness.ts"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const interpreter = path.join(__dirname, "../interpreter")
const ORIGIN = "http://checked-rebind.test"

const SCREEN_HTML = `<section class="screen" data-screen="odds">
  <div data-live="preference" data-filter="id=eq.preference">
    <template data-item>
      <div>
        <label><input type="radio" name="zone" value="*" data-value="{zone_id}">All</label>
        <div data-live="zone" data-filter="group_id=eq.{group_id}" data-order="position.asc,id.asc"
             data-project='{"selected_zone":{"eq":["id","{zone_id}"]}}'>
          <template data-item>
            <label><input type="radio" name="zone" value="{id}" checked="{selected_zone}"><span data-text="{name}"></span></label>
          </template>
        </div>
      </div>
    </template>
  </div>
</section>`

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>checked rebind</title></head>
<body><div id="shell"></div>
<script type="module">
  import { interpretScreen } from "./screen.js"
  const preferences = [{ id: "preference", group_id: "group", zone_id: "a" }]
  const zones = [
    { id: "a", group_id: "group", position: 0, name: "Zone A" },
    { id: "b", group_id: "group", position: 1, name: "Zone B" },
  ]
  const listeners = new Map()
  const store = {
    query: async (table) => (table === "preference" ? preferences : zones).map((row) => ({ ...row })),
    subscribe: (table, fn) => {
      const rows = listeners.get(table) ?? []
      rows.push(fn)
      listeners.set(table, rows)
      return () => listeners.set(table, rows.filter((item) => item !== fn))
    },
    create: async () => {}, update: async () => {}, remove: async () => {},
  }
  window.__selectModel = async (zone_id) => {
    preferences[0].zone_id = zone_id
    for (const refresh of listeners.get("preference") ?? []) await refresh()
  }
  await interpretScreen(document.getElementById("shell"), location.origin + "/", {
    screen: "odds",
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
    if (url.pathname === "/screen.html") return route.fulfill({ contentType: "text/html; charset=utf-8", body: SCREEN_HTML })
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
  await page.waitForFunction(() => (window as Any).__ready === true)
  await page.waitForFunction(() => document.querySelector('input[value="a"]') !== null)
}

describe("projected radio checkedness", () => {
  it("follows the parent selection after a reader changes the dirty group", async () => {
    await withPage(async (page) => {
      await open(page)
      const checked = () => page.locator('input[type="radio"]:checked').evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value))
      expect(await checked()).toEqual(["a"])

      await page.locator('input[value="b"]').check()
      await page.locator('input[value="a"]').check()
      await page.evaluate(() => (window as Any).__selectModel("b"))
      await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[value="b"]')?.checked === true)
      expect(await checked()).toEqual(["b"])

      await page.evaluate(() => (window as Any).__selectModel("*"))
      await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[value="*"]')?.checked === true)
      expect(await checked()).toEqual(["*"])
    })
  })
})
