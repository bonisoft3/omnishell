// Driving a real browser the way the linkedom tier drives a shim: advance the
// clock, wait for the terminal to say it is done, assert. No sleeping.
//
// This is what the browser tier could not do before. A driver outside the page
// could only ask "has the DOM stopped changing", which is a guess both ways —
// it cannot tell a finished screen from one between two refreshes, and it sees
// nothing of a wait that has not come due. So every check that needed to know
// slept for a number sized to the slowest screen it might ever meet.
//
// `__prontoBusy()` is the terminal answering instead: refreshes running now,
// and delays it is holding. Under `?clock=manual` nothing becomes due that this
// test did not advance to, so the pair is the whole answer and the run is
// deterministic rather than merely usually-long-enough.
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, type Page, withPage } from "./harness.ts"

const interpreter = path.join(path.dirname(fileURLToPath(import.meta.url)), "../interpreter")
const ORIGIN = "http://driven.test"

// A machine whose second state is reached only by a delay the terminal holds.
const MACHINE = JSON.stringify({
  field: "phase",
  initial: "idle",
  states: {
    idle: { on: { click: "waiting" } },
    waiting: { after: { "3000": "done" } },
    done: {},
  },
})

const SCREEN_HTML = `<section class="screen" data-screen="beat">
  <div id="region" data-live="beat" data-filter="id=eq.the" data-machine='${MACHINE}'
       data-empty-row='{"id":"the","phase":"idle"}'>
    <button type="button" id="go">go</button>
    <output id="phase" data-text="{phase}"></output>
  </div>
</section>`

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>driven</title></head>
<body><div id="shell"></div>
<script type="module">
  import { interpretScreen } from "./screen.js"
  let rows = []
  let notify = () => {}
  const store = {
    query: async () => rows,
    subscribe: (_t, fn) => { notify = fn; return () => {} },
    create: async () => {}, update: async () => {}, remove: async () => {},
    put: async (_t, row) => { rows = [row]; await notify() },
    upsert: async (_t, row) => { rows = [row]; await notify() },
  }
  await interpretScreen(document.getElementById("shell"), location.origin + "/", {
    screen: "beat",
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
  // The clock is held from the first byte: a wait armed before the driver
  // arrived would otherwise come due on its own and the run would not be the
  // test's to reproduce.
  await page.goto(`${ORIGIN}/?clock=manual&seed=1`)
  await page.waitForFunction(() => (globalThis as Any).__ready === true)
}

/** Everything the terminal had in flight has landed. Polled by Playwright on
 * the page's own frames, so this is the browser telling the driver rather than
 * the driver sleeping and hoping. */
const idle = (page: Page) => page.waitForFunction(() => (globalThis as Any).__prontoBusy().regions === 0)

/** Timers the clock is holding. Zero-or-not is the part a driver acts on: a
 * state re-entered by its own refresh holds two, one of which exists only to
 * be discarded when it comes due. */
const waits = (page: Page) => page.evaluate(() => (globalThis as Any).__prontoBusy().waits as number)

const phase = (page: Page) => page.textContent("#phase")

describe("driven", () => {
  it("reports what it has in flight, and settles to nothing", async () => {
    await withPage(async (page) => {
      await open(page)
      await idle(page)
      expect(await phase(page)).toBe("idle")
      // At rest: the initial state arms nothing, so a screen nobody touched is
      // holding no delay — the chart's own claim, read off the terminal.
      expect(await waits(page)).toBe(0)
    })
  })

  it("holds the beat until the driver advances to it", async () => {
    await withPage(async (page) => {
      await open(page)
      await idle(page)

      await page.click("#go")
      await idle(page)
      expect(await phase(page)).toBe("waiting")
      // Something is armed and held. Real time passing does nothing to it,
      // which is what makes the two assertions below facts rather than races.
      expect(await waits(page)).toBeGreaterThan(0)

      // One millisecond short of the beat, and the screen has not moved. On a
      // real clock this is the assertion that would be a coin toss.
      await page.evaluate(() => (globalThis as Any).__prontoClock.advance(2999))
      await idle(page)
      expect(await phase(page)).toBe("waiting")

      await page.evaluate(() => (globalThis as Any).__prontoClock.advance(1))
      await idle(page)
      await page.evaluate(() => (globalThis as Any).__prontoClock.advance(1))
      await idle(page)
      expect(await phase(page)).toBe("done")
      // And the state it landed in declares no wait, so the screen is at rest.
      expect(await waits(page)).toBe(0)
    })
  })
})
