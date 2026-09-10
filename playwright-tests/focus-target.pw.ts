// Playwright (run: `bun x playwright test focus-target`): the half of
// `data-focus` no DOM shim can answer.
//
// The whole-screen tier (test/focus-target.test.ts) can say which element the
// terminal CALLED focus() on and what tabindex it stamped. It cannot say where
// the reader ends up, because linkedom has no activeElement and no Tab key —
// and this effect's entire contract is about a reader the terminal is sharing
// the focus with:
//
//   - every member stays in the Tab sequence, which is the reason this is not
//     data-rove. Only a browser can press Tab and report that the next member
//     is where it lands, rather than whatever follows the group.
//   - a reader who moves themselves is RECORDED rather than dragged back. The
//     shim fires the focusin the test writes; here the browser fires the one a
//     Tab actually caused, which is the event the rule depends on.
import { test, expect, type Page } from "@playwright/test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const interpreter = path.join(__dirname, "../interpreter")

const ORIGIN = "http://focus.test"

// An accordion's headers: three affordances, all of them tabbable, with a
// caret over them that is a column. The chart hears the arrow AND the focusin,
// which is what focusLint refuses a region for going without.
// Guarded, because an UNGUARDED keydown answers every key — Tab included, and
// Tab is what this suite presses. A caret that moved on Tab would move the
// reader before the browser's own default did, and the default would then step
// off wherever the terminal had just put them: one press, two members skipped.
// Every walk in the catalog is guarded this way; the shim tier never had to
// say so, because linkedom has no Tab.
const DOWN = { type: "is-key", params: { key: "ArrowDown" } }

const CHART = {
  field: "caret",
  initial: "one",
  context: { cur_one: "true", cur_two: "false", cur_three: "false" },
  states: {
    one: {
      on: {
        "keydown@h-one": [{ guard: DOWN, target: "two", assign: { cur_one: "false", cur_two: "true", cur_three: "false" } }],
        "focusin@h-two": { target: "two", assign: { cur_one: "false", cur_two: "true", cur_three: "false" } },
        "focusin@h-three": { target: "three", assign: { cur_one: "false", cur_two: "false", cur_three: "true" } },
      },
    },
    two: {
      on: {
        "keydown@h-two": [{ guard: DOWN, target: "three", assign: { cur_one: "false", cur_two: "false", cur_three: "true" } }],
        "focusin@h-one": { target: "one", assign: { cur_one: "true", cur_two: "false", cur_three: "false" } },
        "focusin@h-three": { target: "three", assign: { cur_one: "false", cur_two: "false", cur_three: "true" } },
      },
    },
    three: {
      on: {
        "focusin@h-one": { target: "one", assign: { cur_one: "true", cur_two: "false", cur_three: "false" } },
        "focusin@h-two": { target: "two", assign: { cur_one: "false", cur_two: "true", cur_three: "false" } },
      },
    },
  },
}

const SCREEN_HTML = `<section class="screen" data-screen="acc">
  <button id="before" type="button">before</button>
  <div class="acc" data-live="acc" data-filter="id=eq.the"
       data-machine='${JSON.stringify(CHART)}'>
    <button type="button" id="h-one" data-focus="{cur_one}">One</button>
    <button type="button" id="h-two" data-focus="{cur_two}">Two</button>
    <button type="button" id="h-three" data-focus="{cur_three}">Three</button>
  </div>
  <button id="after" type="button">after</button>
</section>`

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>focus harness</title></head>
<body><div id="shell"></div>
<script type="module">
  import { interpretScreen } from "./screen.js"
  const rows = { acc: [{ id: "the", caret: "one", cur_one: "true", cur_two: "false", cur_three: "false" }] }
  const subs = []
  const wake = async () => { for (const fn of subs) await fn() }
  const store = {
    query: async (table) => rows[table].slice(),
    subscribe: (_t, fn) => { subs.push(fn); return () => {} },
    create: async () => {},
    upsert: async () => {},
    // A machine states a whole row, which is the write this screen makes.
    put: async (table, row) => {
      const at = rows[table].findIndex((r) => String(r.id) === String(row.id))
      if (at === -1) rows[table].push(row)
      else rows[table][at] = row
      await wake()
    },
    remove: async () => {},
    removeWhere: async () => {},
    update: async (table, id, patch) => {
      Object.assign(rows[table].find((r) => String(r.id) === String(id)), patch)
      await wake()
    },
  }
  // A row moving with nobody asking: the store talking, not the reader.
  window.__moveCaret = async (to) => {
    await store.put("acc", { id: "the", caret: to, cur_one: String(to === "one"),
      cur_two: String(to === "two"), cur_three: String(to === "three") })
  }
  window.__caret = () => rows.acc[0].caret
  window.__active = () => document.activeElement?.id ?? null
  window.__tabindex = () =>
    [...document.querySelectorAll("[data-focus]")].map((el) => el.id + "=" + el.getAttribute("tabindex"))
  await interpretScreen(document.getElementById("shell"), location.origin + "/", {
    screen: "acc",
    files: { html: "screen.html", css: "screen.css", handlers: ["is-key.js"] },
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
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: PAGE })
    if (url.pathname === "/screen.html") {
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: SCREEN_HTML })
    }
    if (url.pathname === "/screen.css") return route.fulfill({ contentType: "text/css", body: "" })
    // The catalog's own leaf, inline: which key a keydown carried, as the
    // boolean a guard reads (apps/shadcnui/shell/handlers/is-key.js).
    if (url.pathname === "/is-key.js") {
      return route.fulfill({
        contentType: "text/javascript; charset=utf-8",
        body: "(state, event, params) => event.key === params.key;",
      })
    }
    if (/\.js$/.test(url.pathname)) {
      const body = await readFile(path.join(interpreter, url.pathname.slice(1)), "utf8")
      return route.fulfill({ contentType: "text/javascript; charset=utf-8", body })
    }
    return route.abort()
  })
  await page.goto(`${ORIGIN}/`)
  await page.waitForFunction(() => (window as Any).__ready === true)
  await page.waitForFunction(() => (window as Any).__tabindex().length === 3)
}

test("every member keeps its own tab stop, which is why this is not a tabstop", async ({ page }) => {
  await open(page)
  // The contract in one line, and the reason APG gives this pattern the other
  // effect: a roving tabstop would take two of these three OUT of the sequence.
  expect(await page.evaluate(() => (window as Any).__tabindex())).toEqual([
    "h-one=null",
    "h-two=null",
    "h-three=null",
  ])

  await page.locator("#before").focus()
  await page.keyboard.press("Tab")
  expect(await page.evaluate(() => (window as Any).__active())).toBe("h-one")
  await page.keyboard.press("Tab")
  // Where a roving group would have sent the reader past the whole set.
  expect(await page.evaluate(() => (window as Any).__active())).toBe("h-two")
  await page.keyboard.press("Tab")
  expect(await page.evaluate(() => (window as Any).__active())).toBe("h-three")
})

test("the arrow takes the reader with the caret", async ({ page }) => {
  await open(page)
  await page.locator("#h-one").focus()
  await page.keyboard.press("ArrowDown")
  await page.waitForFunction(() => (window as Any).__caret() === "two")
  // The half linkedom answers wrongly: focus() on a shim records a call, and a
  // browser moves a reader.
  expect(await page.evaluate(() => (window as Any).__active())).toBe("h-two")
})

test("a reader's own Tab is recorded, not undone", async ({ page }) => {
  await open(page)
  await page.locator("#h-one").focus()
  await page.keyboard.press("Tab")
  // The focusin the browser fired — not one a test wrote — is what writes the
  // column, and the column agreeing is what stops the next refresh from
  // dragging the reader back to where the caret used to be.
  await page.waitForFunction(() => (window as Any).__caret() === "two")
  expect(await page.evaluate(() => (window as Any).__active())).toBe("h-two")

  await page.keyboard.press("Tab")
  await page.waitForFunction(() => (window as Any).__caret() === "three")
  expect(await page.evaluate(() => (window as Any).__active())).toBe("h-three")
})

test("a caret moving under a reader who has left the widget moves nothing", async ({ page }) => {
  await open(page)
  await page.locator("#after").focus()
  expect(await page.evaluate(() => (window as Any).__active())).toBe("after")

  await page.evaluate(() => (window as Any).__moveCaret("three"))
  await page.waitForFunction(() => (window as Any).__caret() === "three")
  // Their focus is not this region's business. The rule reads the DOM's own
  // answer to "is the reader inside", which is the one thing a shim without an
  // activeElement cannot be asked.
  expect(await page.evaluate(() => (window as Any).__active())).toBe("after")
})

