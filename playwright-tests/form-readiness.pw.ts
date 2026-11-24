// Forms must stay inactive while modules, row values, or locale catalogues are pending.
import { expect, type Page, test } from "@playwright/test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const interpreter = path.join(path.dirname(fileURLToPath(import.meta.url)), "../interpreter")
const ORIGIN = "http://form-readiness.test"

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
      <input id="name" name="name" data-value="{name}" required aria-label="Name">
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
  window.__wake = wake
  window.__booted = (window.__booted ?? 0) + 1
  const route = (screen) => ({
    screen,
    files: { html: "screen.html", css: "screen.css", handlers: ["handlers/nudge.js"] },
    states: ["loading", "empty", "populated"],
  })`

const SUBMITS = `<script>
  let openRows, failRows
  window.__rowGate = new Promise((resolve, reject) => { openRows = resolve; failRows = reject })
  window.__openRows = () => openRows()
  window.__failRows = () => failRows(new Error("profile read failed"))
</script>`

// A client mount: the shell is empty and interpretScreen draws the screen.
const pageOf = (screen: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>form readiness harness</title>${SUBMITS}</head>
<body><div id="shell"></div>
<script type="module">
  import { interpretScreen } from "./screen.js"
  ${STORE}
  window.__handle = await interpretScreen(document.getElementById("shell"), location.origin + "/", route("${screen}"), store, {})
  window.__ready = true
</script>
</body></html>`

// A served first load, in the shell's order: the screen is already in the document, early-gestures.js
// holds what the reader does, and the module takes the screen over, then replays.
const SERVED_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>form readiness harness</title>${SUBMITS}
<script src="./early-gestures.js"></script></head>
<body><div id="shell">${JOIN_HTML}</div>
<script type="module">
  import { interpretScreen, templateHash } from "./screen.js"
  import { replayEarlyGestures } from "./early-replay.js"
  ${STORE}
  const mount = document.getElementById("shell")
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
async function open(page: Page, body: string, html = JOIN_HTML, initialForm = true) {
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
  if (initialForm) await page.locator("#name").waitFor()
  await reached
  return release
}

const ready = (page: Page) => page.waitForFunction(() => (window as Any).__ready === true)
const members = (page: Page): Promise<string[]> => page.evaluate(() => (window as Any).__members())
const documentsOf = (page: Page): string[] => {
  const documents: string[] = []
  page.on("request", (r) => { if (r.resourceType() === "document") documents.push(new URL(r.url()).search) })
  return documents
}

test("a slow module keeps its form inactive without blocking the rest of the page", async ({ page }) => {
  const documents = documentsOf(page)
  const release = await open(page, pageOf("join"))
  const form = page.locator("form")
  await expect(form).toHaveAttribute("inert", "")
  await expect(form).toHaveAttribute("aria-busy", "true")
  await page.locator("#name").evaluate((input: HTMLInputElement) => input.focus())
  await expect(page.locator("#name")).not.toBeFocused()
  await page.locator('[data-on-click="nudge"]').evaluate((button) => button.addEventListener("click", () => (window as Any).__outsideClicked = true))
  await page.locator('[data-on-click="nudge"]').click()
  expect(await page.evaluate(() => (window as Any).__outsideClicked)).toBe(true)
  await page.waitForTimeout(2100)
  await expect(form).toHaveAttribute("inert", "")
  const box = await page.locator("#join").boundingBox()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
  release()
  await ready(page)
  await expect(form).not.toHaveAttribute("inert", "")
  expect(await members(page)).toEqual([])
  await page.locator("#name").fill("Ana")
  await page.locator("#join").click()
  await page.evaluate(() => (window as Any).__handle.settle())
  expect(await members(page)).toEqual(["Ana"])
  expect(documents).toEqual([""])
})

test("a singleton form waits for its row, then binds before accepting input", async ({ page }) => {
  const release = await open(page, pageOf("edit"), EDIT_HTML)
  release()
  await page.waitForFunction(() => (document.querySelector("form") as Any)?._prontoForm)
  await expect(page.locator("form")).toHaveAttribute("inert", "")
  await page.evaluate(() => (window as Any).__openRows())
  await ready(page)
  await expect(page.locator("form")).not.toHaveAttribute("inert", "")
  await expect(page.locator("#name")).toHaveValue("Old")
  await page.locator("#name").fill("Ana")
  await page.locator("#save").click()
  await page.evaluate(() => (window as Any).__handle.settle())
  expect(await page.evaluate(() => (window as Any).__patches())).toEqual([{ key: "p1", changes: { name: "Ana" } }])
})

test("a ready form stays usable while another region waits", async ({ page }) => {
  const html = EDIT_HTML.replace('</section>', JOIN_HTML.replace(/<\/?section[^>]*>/g, "").replaceAll('id="name"', 'id="member-name"') + '</section>')
  const release = await open(page, pageOf("edit"), html)
  release()
  await page.waitForFunction(() => (document.querySelector('form[data-action="create"]') as Any)?._prontoForm)
  await expect(page.locator('form[data-action="update"]')).toHaveAttribute("inert", "")
  await expect(page.locator('form[data-action="create"]')).not.toHaveAttribute("inert", "")
  await page.locator("#member-name").fill("Ana")
  await page.locator("#join").click()
  await expect.poll(() => members(page)).toEqual(["Ana"])
  await page.evaluate(() => (window as Any).__openRows())
  await ready(page)
})

test("a locale catalogue must bind untouched controls before the form becomes active", async ({ page }) => {
  const html = EDIT_HTML.replace('<button type="submit"', '<input name="bio" data-value="{bio}"><button type="submit"')
  const body = pageOf("edit")
    .replace('name: "Old"', 'name: "Old", bio: "Keep", locale: "pt"')
    .replace('store, {})', `store, {}, {
      messages: { en: {} }, locale: "en",
      ensureMessages: () => new Promise((resolve) => { window.__openCatalogue = resolve }),
    })`)
  const release = await open(page, body, html)
  release()
  await page.evaluate(() => (window as Any).__openRows())
  await page.waitForFunction(() => (window as Any).__openCatalogue)
  await expect(page.locator("form")).toHaveAttribute("inert", "")
  await page.evaluate(() => (window as Any).__openCatalogue())
  await ready(page)
  await expect(page.locator('[name="bio"]')).toHaveValue("Keep")
  await expect(page.locator("form")).not.toHaveAttribute("inert", "")
})

test("a failed initial read leaves the form inactive and rejects settlement", async ({ page }) => {
  const release = await open(page, pageOf("edit"), EDIT_HTML)
  release()
  await page.waitForFunction(() => (document.querySelector("form") as Any)?._prontoForm)
  await page.evaluate(() => (window as Any).__failRows())
  await ready(page)
  await expect(page.locator("form")).toHaveAttribute("inert", "")
  await expect(page.evaluate(() => (window as Any).__handle.settle())).rejects.toThrow("profile read failed")
})

test("programmatic submits cannot bypass readiness or get replayed later", async ({ page }) => {
  const release = await open(page, pageOf("join"))
  await page.evaluate(() => {
    (document.querySelector("#name") as HTMLInputElement).value = "Ana";
    (document.querySelector("form") as HTMLFormElement).requestSubmit()
  })
  release()
  await ready(page)
  await expect(page.evaluate(() => (window as Any).__handle.settle())).rejects.toThrow("a form was submitted before it was ready")
  expect(await members(page)).toEqual([])
})

test("a form added by a template update waits for its newly hydrated row", async ({ page }) => {
  const release = await open(page, pageOf("join"))
  release()
  await ready(page)
  await page.evaluate((html) => { (window as Any).__morph = (window as Any).__handle.morph(html) }, EDIT_HTML)
  await page.waitForFunction(() => (document.querySelector('form[data-action="update"]') as Any)?._prontoForm)
  await expect(page.locator('form[data-action="update"]')).toHaveAttribute("inert", "")
  await page.evaluate(() => (window as Any).__openRows())
  await page.evaluate(() => (window as Any).__morph)
  await expect(page.locator('form[data-action="update"]')).not.toHaveAttribute("inert", "")
  await expect(page.locator("#name")).toHaveValue("Old")
})

test("a served form remains inactive until browser wiring finishes", async ({ page }) => {
  const served = SERVED_PAGE.replace('<form data-entity="member"', '<form inert aria-busy="true" data-form-pending data-entity="member"')
  const release = await open(page, served)
  await expect(page.locator("form")).toHaveAttribute("inert", "")
  const box = await page.locator("#join").boundingBox()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
  release()
  await ready(page)
  await expect(page.locator("form")).not.toHaveAttribute("inert", "")
  expect(await members(page)).toEqual([])
  await page.locator("#name").fill("Ana")
  await page.locator("#join").click()
  await expect.poll(() => members(page)).toEqual(["Ana"])
})


test("a cloned list form waits for its nested options before becoming usable", async ({ page }) => {
  const html = `<section class="screen" data-screen="list">
    <div data-live="member"><template data-item><article>
      <form data-action="update" data-entity="member">
        <input id="name" name="name" data-value="{name}">
        <select name="profile"><optgroup data-live="profile"><template data-item>
          <option value="{id}" data-text="{name}"></option>
        </template></optgroup></select>
        <button id="save">Save</button>
      </form>
    </article></template></div>
    <button data-on-click="nudge">nudge</button>
  </section>`
  const body = pageOf("list").replace('member: []', 'member: [{ id: "m1", name: "Ana" }]')
  const release = await open(page, body, html, false)
  release()
  await page.waitForFunction(() => (document.querySelector("form") as Any)?._prontoForm)
  await expect(page.locator("form")).toHaveAttribute("inert", "")
  await page.evaluate(() => (window as Any).__openRows())
  await ready(page)
  await expect(page.locator("form")).not.toHaveAttribute("inert", "")
  await expect(page.locator("select")).toHaveValue("p1")
  await page.locator("#save").click()
  await page.evaluate(() => (window as Any).__handle.settle())
  expect(await page.evaluate(() => (window as Any).__patches())).toEqual([{ key: "m1", changes: { name: "Ana", profile: "p1" } }])
})


test("a ready editor keeps focus and stays usable while a template refresh reads again", async ({ page }) => {
  const release = await open(page, pageOf("edit"), EDIT_HTML)
  release()
  await page.evaluate(() => (window as Any).__openRows())
  await ready(page)
  await page.locator("#name").fill("Ana")
  await page.evaluate((html) => {
    (window as Any).__rowGate = new Promise((resolve) => (window as Any).__openRows = resolve);
    (window as Any).__morph = (window as Any).__handle.morph(html)
  }, EDIT_HTML.replace("Save</button>", "Save changes</button>"))
  await expect(page.locator("#save")).toHaveText("Save changes")
  await expect(page.locator("form")).not.toHaveAttribute("inert", "")
  await expect(page.locator("#name")).toBeFocused()
  await expect(page.locator("#name")).toHaveValue("Ana")
  await page.evaluate(() => (window as Any).__openRows())
  await page.evaluate(() => (window as Any).__morph)
  await expect(page.locator("#name")).toHaveValue("Ana")
})

test("a failed nested read keeps its parent form inactive", async ({ page }) => {
  const html = EDIT_HTML.replace('<button type="submit"', '<select name="choice"><optgroup data-live="member"><template data-item><option value="{id}" data-text="{name}"></option></template></optgroup></select><button type="submit"')
  const body = pageOf("edit").replace('if (table === "profile") await window.__rowGate', 'if (table === "member" && !window.__recoverChoices) throw new Error("choices unavailable")')
  const release = await open(page, body, html)
  release()
  await ready(page)
  await expect(page.locator("form")).toHaveAttribute("inert", "")
  await expect(page.evaluate(() => (window as Any).__handle.settle())).rejects.toThrow("choices unavailable")
  await page.evaluate(async () => { (window as Any).__recoverChoices = true; await (window as Any).__wake() })
  await expect(page.locator("form")).not.toHaveAttribute("inert", "")
})

test("legacy captured form submissions are not replayed", async ({ page }) => {
  const release = await open(page, SERVED_PAGE)
  await page.evaluate(() => {
    (document.querySelector("#name") as HTMLInputElement).value = "Ana";
    (window as Any).__prontoEarlyGestures = () => [{ target: document.querySelector("form"), type: "submit" }]
  })
  release()
  await ready(page)
  expect(await members(page)).toEqual([])
})


test("a list item that is itself a form keeps focus across a template refresh", async ({ page }) => {
  const html = `<section class="screen" data-screen="list"><div data-live="member"><template data-item>
    <form data-action="update" data-entity="member"><input id="name" name="name" data-value="{name}"><button id="save">Save</button></form>
    </template></div><button data-on-click="nudge">nudge</button></section>`
  const body = pageOf("list").replace('member: []', 'member: [{ id: "m1", name: "Old" }]').replace('table === "profile"', 'table === "member"')
  const release = await open(page, body, html, false)
  release()
  await page.evaluate(() => (window as Any).__openRows())
  await ready(page)
  await page.locator("#name").fill("Ana")
  await page.evaluate((html) => {
    (window as Any).__rowGate = new Promise((resolve) => (window as Any).__openRows = resolve);
    (window as Any).__morph = (window as Any).__handle.morph(html)
  }, html.replace("Save</button>", "Save changes</button>"))
  await expect(page.locator("#save")).toHaveText("Save changes")
  await expect(page.locator("form")).not.toHaveAttribute("inert", "")
  await expect(page.locator("#name")).toBeFocused()
  await page.evaluate(() => (window as Any).__openRows())
  await page.evaluate(() => (window as Any).__morph)
  await expect(page.locator("#name")).toHaveValue("Ana")
})

for (const root of [false, true]) {
  test(`template updates toggle authored inert on ${root ? "a form row" : "a screen form"}`, async ({ page }) => {
    const html = root
      ? `<section class="screen" data-screen="list"><div data-live="member"><template data-item>
          <form data-action="update" data-entity="member"><input id="name" name="name" data-value="{name}"><button id="save">Save</button></form>
        </template></div><button data-on-click="nudge">nudge</button></section>`
      : JOIN_HTML
    const body = root ? pageOf("list").replace('member: []', 'member: [{ id: "m1", name: "Old" }]') : pageOf("join")
    const release = await open(page, body, html, !root)
    release()
    await ready(page)
    const form = page.locator("form")
    await expect(form).not.toHaveAttribute("inert", "")
    await page.evaluate(async (html) => { await (window as Any).__handle.morph(html) }, html.replace('<form ', '<form inert '))
    await expect(form).toHaveAttribute("inert", "")
    await page.locator("#name").evaluate((input: HTMLInputElement) => input.focus())
    await expect(page.locator("#name")).not.toBeFocused()
    await page.evaluate(async (html) => { await (window as Any).__handle.morph(html) }, html)
    await expect(form).not.toHaveAttribute("inert", "")
    await expect(form).not.toHaveAttribute("data-form-pending", "")
    await page.locator("#name").fill("Ana")
    await expect(page.locator("#name")).toHaveValue("Ana")
  })
}
