import { describe, expect, it, withPage } from "./harness.ts"

const interpreter = new URL("../interpreter/", import.meta.url)
const html = `<section data-screen="list"><ul data-live="item"><template data-item><li data-text="{id}"></li></template></ul></section>`
const css = `@keyframes arriving { from { opacity: 0 } to { opacity: 1 } }
@keyframes leaving { from { opacity: 1 } to { opacity: 0 } }
[data-enter] { animation: arriving 30s both }
[data-exit] { animation: leaving 30s both }`

function serve() {
  const stop = new AbortController()
  const server = Deno.serve({ port: 0, signal: stop.signal, onListen() {} }, async (req) => {
    const path = new URL(req.url).pathname
    if (path === "/") return new Response('<!doctype html><div id="app"></div>', { headers: { "content-type": "text/html" } })
    if (path === "/list.html") return new Response(html)
    if (path === "/list.css") return new Response(css)
    return new Response(await Deno.readTextFile(new URL(path.slice(1), interpreter)), { headers: { "content-type": "text/javascript" } })
  })
  return { base: `http://localhost:${server.addr.port}`, close: async () => { stop.abort(); await server.finished } }
}

describe("list motion at placement", () => {
  it("releases still rows immediately and retains animated rows until their motion finishes", async () => {
    const server = serve()
    try {
      await withPage(async (page) => {
        await page.goto(server.base)
        await page.evaluate(async () => {
          const { interpretScreen } = await import("/screen.js")
          let rows = [{ id: "a" }]
          let notify
          const store = {
            query: async () => rows,
            subscribe: (_table, fn) => { notify = fn; return () => {} },
          }
          const handle = await interpretScreen(document.querySelector("#app"), location.origin + "/", {
            screen: "list", files: { html: "list.html", css: "list.css", handlers: [] },
          }, store)
          window.renderRows = async (ids) => { rows = ids.map((id) => ({ id })); await notify() }
          window.stopScreen = handle.stop
        })
        await page.evaluate(() => window.renderRows(["a", "b"]))
        expect(await page.locator('[data-id="b"][data-enter]').count()).toBe(1)
        expect(await page.locator('[data-id="b"]').evaluate((el) => el.getAnimations().map((a) => a.playState))).toEqual(["running"])
        await page.locator('[data-id="b"]').evaluate((el) => el.getAnimations().forEach((a) => a.finish()))
        await page.waitForFunction(() => !document.querySelector('[data-id="b"][data-enter]'))

        await page.evaluate(() => window.renderRows(["b"]))
        expect(await page.locator('[data-id="a"][data-exit][inert]').count()).toBe(1)
        await page.locator('[data-id="a"]').evaluate((el) => el.getAnimations().forEach((a) => a.finish()))
        await page.waitForFunction(() => !document.querySelector('[data-id="a"]'))

        const still = await page.evaluate(async () => {
          document.querySelector('style[id="screen-css-list"]').textContent = ""
          await window.renderRows(["b", "c"])
          const entering = document.querySelector('[data-id="c"]').hasAttribute("data-enter")
          await window.renderRows(["c"])
          const departed = document.querySelector('[data-id="b"]') === null
          window.stopScreen()
          return { entering, departed }
        })
        expect(still).toEqual({ entering: false, departed: true })
      })
    } finally { await server.close() }
  })
})
