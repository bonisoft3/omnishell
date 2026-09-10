// What the CLS check can and cannot see, and why the arming call sits where
// it does.
//
// The pages are served rather than filed so the measurement runs over a real
// navigation: `layout-shift` is scoped to the document being loaded, and a
// fixture reached some other way would not exercise the path the battery uses.
import { asCheckPage, describe, expect, it, withPage } from "./harness.ts"
import { armCLS, checkCLS } from "../src/lint/playwright/checks/cls.ts"

const PAGES: Record<string, string> = {
  // Half a viewport of content pushed down well after first paint: the shape
  // of a stylesheet that arrives late and reflows the text under it.
  "/shifting": `<style>body{margin:0}p{margin:0;padding:8px}</style>
    <div id="late" style="height:0"></div>
    <p>one</p><p>two</p><p>three</p><p>four</p><p>five</p><p>six</p><p>seven</p><p>eight</p>
    <script>setTimeout(() => { document.getElementById("late").style.height = "500px" }, 60)<\/script>`,
  "/stable": `<style>body{margin:0}p{margin:0;padding:8px}</style>
    <div style="height:500px"></div><p>nothing moves</p>`,
}

function serve() {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const body = PAGES[new URL(req.url).pathname]
    return body === undefined
      ? new Response("no such page", { status: 404 })
      : new Response(`<!doctype html><meta charset=utf-8>${body}`, {
        headers: { "content-type": "text/html" },
      })
  })
  return {
    base: `http://localhost:${(server.addr as Deno.NetAddr).port}`,
    close: () => server.shutdown(),
  }
}

/** Long enough for the page's own shift to land and be observed. This and the
 * fixture's delay are one pair, and neither is the check's: what CLS measures
 * is the shift, not how long anything waited for it. */
const AFTER_SHIFT_MS = 250

describe("cls", () => {
  it("reports a screen that reflows after first paint", async () => {
    const server = serve()
    try {
      await withPage(async (page) => {
        await armCLS(asCheckPage(page))
        await page.goto(`${server.base}/shifting`, { waitUntil: "domcontentloaded" })
        await page.waitForTimeout(AFTER_SHIFT_MS)
        const bugs = await checkCLS(asCheckPage(page))
        expect(bugs.length).toBe(1)
        expect(bugs[0].rule).toBe("cls-threshold")
      })
    } finally {
      await server.close()
    }
  })

  it("stays silent on a screen that holds still", async () => {
    const server = serve()
    try {
      await withPage(async (page) => {
        await armCLS(asCheckPage(page))
        await page.goto(`${server.base}/stable`, { waitUntil: "domcontentloaded" })
        await page.waitForTimeout(AFTER_SHIFT_MS)
        expect(await checkCLS(asCheckPage(page))).toEqual([])
      })
    } finally {
      await server.close()
    }
  })

  // The failure this file exists for, and no battery can notice it: a check
  // that sees nothing reports nothing. `addInitScript` is not retroactive, so
  // a call site that arms after its goto measures a clean zero off a screen
  // that reflowed. The shifts are not gone — a post-hoc `buffered: true`
  // observer still recovers them — so what is lost is the reading, not the data.
  it("armed after the navigation, a reflowing screen reads clean", async () => {
    const server = serve()
    try {
      await withPage(async (page) => {
        await page.goto(`${server.base}/shifting`, { waitUntil: "domcontentloaded" })
        await page.waitForTimeout(AFTER_SHIFT_MS)
        await armCLS(asCheckPage(page))
        expect(await checkCLS(asCheckPage(page))).toEqual([])
      })
    } finally {
      await server.close()
    }
  })
})
