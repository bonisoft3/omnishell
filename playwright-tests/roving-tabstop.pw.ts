// Playwright (run: `bun x playwright test roving-tabstop`): the half of the
// roving tabstop no DOM shim can answer.
//
// linkedom has a focus() that records nothing and never sets activeElement, so
// the whole-screen tier (test/roving-tabstop.test.ts) can only check that the
// terminal CALLED it and what tabindex it stamped. Two things follow that only
// a browser knows:
//
//   - focus() on an element with no tabindex is a no-op. The tab order and the
//     focus are one contract, and a shim that answers focus() would report the
//     terminal doing its job while a reader's caret never moved.
//   - the browser owns activeElement, so "a refresh nobody asked for moves
//     nothing" is only observable where something else holds the focus and
//     keeps it.
import { test, expect, type Page } from "@playwright/test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const interpreter = path.join(__dirname, "../interpreter")

const ORIGIN = "http://rove.test"

// The listbox is row-backed, so its tabstop is one column answered on every
// row. Outside it sits a plain button: somewhere for a reader's focus to be
// that the region has no claim on.
const SCREEN_HTML = `<section class="screen" data-screen="lb">
  <button id="elsewhere" type="button">elsewhere</button>
  <div data-live="choice" data-filter="id=eq.the">
    <template data-item>
      <div class="wrap">
        <div role="listbox" id="lb" aria-label="Plan"
             data-key='{"ArrowDown":"nx-{value}"}'
             data-live="option" data-order="pos.asc"
             data-project='{"here":{"eq":["id","{value}"]},"nxt":"next"}'>
          <template data-item>
            <div role="option" id="opt-{id}" data-rove="{here}"
                 aria-selected="{here}" data-text="{label}"></div>
          </template>
        </div>
        <div hidden data-live="option" data-order="pos.asc" data-project='{"nxt":"next"}'>
          <template data-item>
            <form role="none" id="nx-{id}" data-form="nx" data-entity="choice" data-action="upsert">
              <input type="hidden" name="id" data-value="the">
              <input type="hidden" name="value" data-value="{nxt}">
            </form>
          </template>
        </div>
      </div>
    </template>
  </div>
</section>`

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>rove harness</title></head>
<body><div id="shell"></div>
<script type="module">
  import { interpretScreen } from "./screen.js"
  const tables = {
    choice: [{ id: "the", value: "a" }],
    option: [
      { id: "a", label: "A", pos: 1 },
      { id: "b", label: "B", pos: 2 },
      { id: "c", label: "C", pos: 3 },
    ],
  }
  const subs = []
  const wake = async () => { for (const fn of subs) await fn() }
  const store = {
    query: async (table, opts = {}) => {
      const rows = tables[table].slice().sort((x, y) => (x.pos ?? 0) - (y.pos ?? 0))
      // The one filter these screens state, answered literally: a harness that
      // ignored it would hand the singleton every row and trip its cardinality
      // guard rather than the behaviour under test.
      const eq = /id=eq\\.([^&]+)/.exec(opts.filter ?? "")
      return eq === null ? rows : rows.filter((r) => String(r.id) === eq[1])
    },
    subscribe: (_t, fn) => { subs.push(fn); return () => {} },
    create: async () => {},
    // The forms state every column including the key, which is what lets one
    // form off an option's row write the choice row rather than its own.
    upsert: async (table, row) => {
      Object.assign(tables[table].find((r) => String(r.id) === String(row.id)), row)
      await wake()
    },
    put: async () => {},
    remove: async () => {},
    removeWhere: async () => {},
    update: async (table, id, patch) => {
      Object.assign(tables[table].find((r) => String(r.id) === String(id)), patch)
      await wake()
    },
  }
  // A row arriving with nobody asking: the store talking, not the reader.
  window.__arrive = async () => {
    tables.option.push({ id: "d", label: "D", pos: 4 })
    await wake()
  }
  window.__tabindex = () =>
    [...document.querySelectorAll('[role="option"]')].map((el) => el.id + "=" + el.getAttribute("tabindex"))
  window.__active = () => document.activeElement?.id ?? null
  await interpretScreen(document.getElementById("shell"), location.origin + "/", {
    screen: "lb",
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
  await page.waitForFunction(() => (window as Any).__tabindex().length === 3)
}

test("the tabstop is what makes the focus possible", async ({ page }) => {
  await open(page)
  // If this ever fails every other assertion here passes for the wrong reason:
  // a browser refuses focus() on an element with no tabindex, so the terminal
  // stamping the tab order is the precondition for it moving anyone.
  expect(await page.evaluate(() => (window as Any).__tabindex())).toEqual([
    "opt-a=0",
    "opt-b=-1",
    "opt-c=-1",
  ])
  expect(
    await page.evaluate(() => {
      const bare = document.getElementById("elsewhere")!.cloneNode(true) as HTMLElement
      bare.id = "bare"
      bare.removeAttribute("tabindex")
      bare.setAttribute("tabindex", "-1")
      document.body.append(bare)
      const untabbable = document.createElement("div")
      untabbable.id = "untabbable"
      document.body.append(untabbable)
      untabbable.focus()
      return document.activeElement?.id ?? null
    }),
  ).not.toBe("untabbable")
})

test("the arrow lands the reader on the row it chose", async ({ page }) => {
  await open(page)
  await page.locator("#opt-a").focus()
  expect(await page.evaluate(() => (window as Any).__active())).toBe("opt-a")

  await page.keyboard.press("ArrowDown")
  await page.waitForFunction(() => (window as Any).__active() === "opt-b")
  // Both halves, and only a browser has the second: the tab order moved with
  // the caret, and the reader moved with it.
  expect(await page.evaluate(() => (window as Any).__tabindex())).toEqual([
    "opt-a=-1",
    "opt-b=0",
    "opt-c=-1",
  ])

  await page.keyboard.press("ArrowDown")
  await page.waitForFunction(() => (window as Any).__active() === "opt-c")
})

test("a refresh nobody asked for leaves the reader where they are", async ({ page }) => {
  await open(page)
  // The focus-stealing loop, stated where it can actually be seen: the reader
  // has tabbed out of the group, and a row arriving is the store talking.
  await page.locator("#elsewhere").focus()
  expect(await page.evaluate(() => (window as Any).__active())).toBe("elsewhere")

  await page.evaluate(() => (window as Any).__arrive())
  await page.waitForFunction(() => (window as Any).__tabindex().length === 4)

  expect(await page.evaluate(() => (window as Any).__active())).toBe("elsewhere")
  // The tab order still moved, because it is a fact about the rows rather than
  // about the reader.
  expect(await page.evaluate(() => (window as Any).__tabindex())).toEqual([
    "opt-a=0",
    "opt-b=-1",
    "opt-c=-1",
    "opt-d=-1",
  ])
})

test("the arrow is the group's, and the page does not scroll under it", async ({ page }) => {
  await open(page)
  // A tall page, so an uncancelled ArrowDown would move the viewport. data-key
  // cancels what it answers; this is that cancel where a scroll can happen.
  await page.evaluate(() => {
    const filler = document.createElement("div")
    filler.style.height = "4000px"
    document.body.append(filler)
  })
  await page.locator("#opt-a").focus()
  await page.keyboard.press("ArrowDown")
  await page.waitForFunction(() => (window as Any).__active() === "opt-b")
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
})
