// A form is on the page before the shell wires it: interpretScreen connects
// the screen, then loads its handlers' modules, then wires its forms. On a slow
// host a press of a form's button can land in that gap, where the browser would
// submit the form itself: a navigation to the page's own address with the
// fields in its query, which loses the write. The submit is held instead, and
// made once the form is the shell's. On a served document the hold is
// early-gestures.js's, at the document.
import { expect, type Page, test } from "@playwright/test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const interpreter = path.join(path.dirname(fileURLToPath(import.meta.url)), "../interpreter")
const ORIGIN = "http://early-submit.test"

const JOIN_HTML = `<section class="screen" data-screen="join">
  <form data-entity="member" data-action="create">
    <input id="name" name="name" required aria-label="Name">
    <button type="submit" id="join">Join</button>
  </form>
  <button type="button" data-on-click="nudge">nudge</button>
</section>`

// A singleton region's form acts on the one row the region binds, which its read
// answers only later than the form is wired.
const EDIT_HTML = `<section class="screen" data-screen="edit">
  <div data-live="profile">
    <form data-entity="profile" data-action="update">
      <input id="name" name="name" required aria-label="Name">
      <button type="submit" id="save">Save</button>
    </form>
  </div>
  <button type="button" data-on-click="nudge">nudge</button>
</section>`

const NUDGE = `({ context, event }) => ({ updates: [] })`

const STORE = `
  // A create mints its key, and this harness's origin is not a secure context.
  if (!crypto.randomUUID) crypto.randomUUID = () => "m-" + Math.random().toString(16).slice(2)
  const rows = { member: [], profile: [{ id: "p1", name: "Old" }] }
  const patches = []
  const subs = []
  const wake = async () => { for (const fn of subs) await fn() }
  const store = {
    query: async (table) => {
      if (table === "profile") await window.__rowGate
      return (rows[table] ?? []).map((r) => ({ ...r }))
    },
    subscribe: (_t, fn) => { subs.push(fn); return () => {} },
    add: async (table, list) => { rows[table].push(...list); await wake() },
    patch: async (table, list) => { patches.push(...list) },
    create: async () => {},
    upsert: async () => {},
    put: async () => {},
    remove: async () => {},
    removeWhere: async () => {},
    drop: async () => {},
  }
  window.__members = () => rows.member.map((r) => r.name)
  window.__patches = () => patches
  window.__booted = (window.__booted ?? 0) + 1
  const route = (screen) => ({
    screen,
    files: { html: "screen.html", css: "screen.css", handlers: ["handlers/nudge.js"] },
    states: ["loading", "empty", "populated"],
  })`

// The submits that reach the document, bubbling, and the button that made each.
const SUBMITS = `<script>
  window.__submits = []
  document.addEventListener("submit", (e) => window.__submits.push(e.submitter?.id ?? null))
  let openRows
  window.__rowGate = new Promise((r) => (openRows = r))
  window.__openRows = () => openRows()
</script>`

// A client mount: the shell is empty and interpretScreen draws the screen.
const pageOf = (screen: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>early submit harness</title>${SUBMITS}</head>
<body><div id="shell"></div>
<script type="module">
  import { interpretScreen } from "./screen.js"
  ${STORE}
  await interpretScreen(document.getElementById("shell"), location.origin + "/", route("${screen}"), store, {})
  window.__ready = true
</script>
</body></html>`

// A served first load, in the shell's order: the screen is already in the document, early-gestures.js
// holds what the reader does, and the module takes the screen over, then replays.
const SERVED_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>early submit harness</title>${SUBMITS}
<script src="./early-gestures.js"></script></head>
<body><div id="shell">${JOIN_HTML}</div>
<script type="module">
  import { interpretScreen, templateHash } from "./screen.js"
  import { replayEarlyGestures } from "./early-replay.js"
  ${STORE}
  const mount = document.getElementById("shell")
  // What reaches the screen in the capture phase: early-gestures.js stops a submit at the document first.
  window.__atScreen = 0
  mount.firstElementChild.addEventListener("submit", () => window.__atScreen++, true)
  const html = ${JSON.stringify(JOIN_HTML)}
  const handle = await interpretScreen(mount, location.origin + "/", route("join"), store, {}, {
    served: { screen: mount.firstElementChild, cas: templateHash(html) },
  })
  await handle.settle()
  await replayEarlyGestures(document, () => handle.settle())
  window.__ready = true
</script>
</body></html>`

// deno-lint-ignore no-explicit-any
type Any = any

// The handler's module answers only once released: the gap a slow host opens. `reached` is when
// the request for it is in, so a test acts only once the shell is waiting on it. The shell's
// inert/hidden gating is not modelled here: the tests exercise interpretScreen directly.
async function open(page: Page, body: string, html = JOIN_HTML) {
  let release!: () => void
  let reach!: () => void
  const released = new Promise<void>((r) => (release = r))
  const reached = new Promise<void>((r) => (reach = r))
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== ORIGIN) return route.abort()
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body })
    if (url.pathname === "/screen.html") return route.fulfill({ contentType: "text/html; charset=utf-8", body: html })
    if (url.pathname === "/screen.css") return route.fulfill({ contentType: "text/css", body: "" })
    if (url.pathname === "/handlers/nudge.js") {
      reach()
      await released
      return route.fulfill({ contentType: "text/javascript", body: NUDGE })
    }
    if (/\.js$/.test(url.pathname)) {
      const text = await readFile(path.join(interpreter, url.pathname.slice(1)), "utf8")
      return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: text })
    }
    return route.abort()
  })
  await page.goto(`${ORIGIN}/`)
  await page.locator("#name").waitFor()
  await reached
  return release
}

const ready = (page: Page) => page.waitForFunction(() => (window as Any).__ready === true)
const members = (page: Page): Promise<string[]> => page.evaluate(() => (window as Any).__members())
const submits = (page: Page): Promise<unknown[]> => page.evaluate(() => (window as Any).__submits)
const documentsOf = (page: Page): string[] => {
  const documents: string[] = []
  page.on("request", (r) => { if (r.resourceType() === "document") documents.push(new URL(r.url()).search) })
  return documents
}

test("a form submitted before the shell wires it is not the browser's: the write is made once it is wired", async ({ page }) => {
  const documents = documentsOf(page)
  const release = await open(page, pageOf("join"))
  expect(await page.evaluate(() => (window as Any).__ready === true)).toBe(false)
  await page.locator("#name").fill("Ana")
  await page.locator("#join").click()
  release()
  await ready(page)
  await page.waitForFunction(() => (window as Any).__members().length === 1)
  expect(await members(page)).toEqual(["Ana"])
  expect(await page.evaluate(() => (window as Any).__booted)).toBe(1)
  expect(documents).toEqual([""])
  expect(await submits(page)).toEqual(["join"])
})

test("a button pressed twice in the gap makes one write", async ({ page }) => {
  const documents = documentsOf(page)
  const release = await open(page, pageOf("join"))
  await page.locator("#name").fill("Ana")
  await page.locator("#join").click()
  await page.locator("#join").click()
  release()
  await ready(page)
  await page.waitForFunction(() => (window as Any).__members().length >= 1)
  expect(await members(page)).toEqual(["Ana"])
  expect(documents).toEqual([""])
  expect((await submits(page)).length).toBe(1)
})

// A guard, and it passes without the screen's hold: on a served first load early-gestures.js holds
// the submit at the document, so the screen must not hold it again, and the shell's replay makes it once.
test("a served first load holds the submit at the document only, and the replay makes it once", async ({ page }) => {
  const documents = documentsOf(page)
  const release = await open(page, SERVED_PAGE)
  expect(await page.evaluate(() => (window as Any).__ready === true)).toBe(false)
  await page.locator("#name").fill("Ana")
  await page.locator("#join").click()
  expect(await page.evaluate(() => (window as Any).__atScreen)).toBe(0)
  release()
  await ready(page)
  await page.waitForFunction(() => (window as Any).__members().length === 1)
  expect(await members(page)).toEqual(["Ana"])
  expect(documents).toEqual([""])
  expect((await submits(page)).length).toBe(1)
})

test("an update form in a singleton region is made once the region has bound its row", async ({ page }) => {
  const documents = documentsOf(page)
  const release = await open(page, pageOf("edit"), EDIT_HTML)
  await page.locator("#name").fill("Ana")
  await page.locator("#save").click()
  release()
  // The form is wired, and the region's read has not answered.
  await page.waitForFunction(() => (document.querySelector("form") as Any)?._prontoForm === true)
  expect(await page.evaluate(() => (window as Any).__patches())).toEqual([])
  await page.evaluate(() => (window as Any).__openRows())
  await ready(page)
  await page.waitForFunction(() => (window as Any).__patches().length === 1)
  expect(await page.evaluate(() => (window as Any).__patches())).toEqual([{ key: "p1", changes: { name: "Ana" } }])
  expect(documents).toEqual([""])
})
