// A select in a form that submits on change carries its state, the way a
// checkbox does: the reader's pick IS the write, so after it lands the select
// shows the row, and a row that moves under a focused select moves the select.
//
// Only a real engine answers this. linkedom has no activeElement and the
// harness's form.reset() is a no-op, and those are the two halves of the bug:
// a successful submit reset the form (a select bound through el.value resets
// to its first option), and the re-bind that would have corrected it skips a
// focused control.
import { describe, expect, it, type Page, withPage } from "./harness.ts"

const ORIGIN = "http://select.test"
const INTERPRETER = new URL("../interpreter/", import.meta.url)

const SCREEN_HTML = `<section class="screen" data-screen="swatch">
  <ul data-live="note" data-order="id.asc">
    <template data-item>
      <li>
        <form data-entity="note" data-action="update">
          <select name="color" data-value="{color}" aria-label="Cor">
            <option value="sand">Sand</option>
            <option value="sage">Sage</option>
            <option value="plum">Plum</option>
          </select>
        </form>
      </li>
    </template>
  </ul>
</section>`

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>select harness</title></head>
<body><div id="shell"></div>
<script type="module">
  import { interpretScreen } from "./screen.js"
  const rows = { note: [{ id: "n1", color: "sage" }] }
  const subs = []
  const wake = async () => { for (const fn of subs) await fn() }
  const set = async (table, id, patch) => {
    Object.assign(rows[table].find((r) => String(r.id) === String(id)), patch)
    await wake()
  }
  const store = {
    query: async (table) => rows[table].map((r) => ({ ...r })),
    subscribe: (_t, fn) => { subs.push(fn); return () => {} },
    create: async () => {},
    upsert: async () => {},
    put: async () => {},
    remove: async () => {},
    removeWhere: async () => {},
    update: set,
    // A form's update: each key with the fields it changes.
    patch: async (table, list) => {
      for (const { key, changes } of list) Object.assign(rows[table].find((r) => String(r.id) === String(key)), changes)
      await wake()
    },
  }
  // The row moving with nobody asking: the store talking, not the reader.
  window.__recolor = (to) => set("note", "n1", { color: to })
  window.__row = () => rows.note[0].color
  window.__select = () => {
    const s = document.querySelector("select")
    return { value: s.value, focused: document.activeElement === s }
  }
  await interpretScreen(document.getElementById("shell"), location.origin + "/", {
    screen: "swatch",
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
      const body = await Deno.readTextFile(new URL(url.pathname.slice(1), INTERPRETER))
      return route.fulfill({ contentType: "text/javascript; charset=utf-8", body })
    }
    return route.abort()
  })
  await page.goto(`${ORIGIN}/`)
  await page.waitForFunction(() => (window as Any).__ready === true)
  await page.waitForFunction(() => (window as Any).__select().value === "sage")
}

const settle = (page: Page) => page.waitForTimeout(700)

describe("a select that submits on change", () => {
  it("still shows the reader's pick after the write lands, with focus kept", () =>
    withPage(async (page) => {
      await open(page)
      await page.locator("select").focus()
      // Type-ahead, the gesture a keyboard reader makes on a closed select.
      await page.keyboard.press("p")
      await page.waitForFunction(() => (window as Any).__row() === "plum")
      await settle(page)
      expect(await page.evaluate(() => (window as Any).__select())).toEqual({ value: "plum", focused: true })
    }))

  it("follows its row when the row moves under a focused select", () =>
    withPage(async (page) => {
      await open(page)
      await page.locator("select").focus()
      await page.evaluate(() => (window as Any).__recolor("sand"))
      await settle(page)
      expect(await page.evaluate(() => (window as Any).__select())).toEqual({ value: "sand", focused: true })
    }))
})
