// settle()'s two failure modes, both of which cost more than the slowness the
// predicate exists to remove.
//
// A page that never stops changing must be *reported*, not waited on forever:
// `page.evaluate` takes no timeout, so an unbounded wait inside it hangs the
// whole battery with no output at all — strictly worse than the fixed sleep it
// replaced. And the change it watches for is DOM change, not motion: a widget
// machine stamps an attribute without moving a box, and checkWidgetsMounted
// calls an unstamped widget inert.
//
// The pages are served rather than filed because one of them has to answer a
// request with nothing, forever, which no fixture on disk can do.
import { describe, expect, it, withPage } from "./harness.ts"
import { settle } from "../check-visual.ts"

const PAGES: Record<string, string> = {
  "/quiet": `<p>nothing happens here</p>`,
  "/stalling-image": `<img src="/never-answers"><p>text</p>`,
  "/mutating": `<div id="w">widget</div><script>
    setInterval(() => document.getElementById("w").setAttribute("data-tick", String(Date.now())), 40)
  </script>`,
}

function serve() {
  // Aborted rather than shut down: shutdown() drains in-flight requests, and
  // the whole point of /never-answers is that one of them never drains.
  const stop = new AbortController()
  const server = Deno.serve({ port: 0, signal: stop.signal, onListen: () => {} }, async (req) => {
    const path = new URL(req.url).pathname
    if (path === "/never-answers") {
      await new Promise((done) => stop.signal.addEventListener("abort", done, { once: true }))
      return new Response(null, { status: 499 })
    }
    const body = PAGES[path]
    if (body === undefined) return new Response("no such page", { status: 404 })
    return new Response(`<!doctype html><meta charset=utf-8>${body}`, {
      headers: { "content-type": "text/html" },
    })
  })
  return {
    base: `http://localhost:${(server.addr as Deno.NetAddr).port}`,
    close: async () => {
      stop.abort()
      await server.finished
    },
  }
}

// Two of these cases exist to REACH the cap, so at the battery's own value they
// would sit out the whole budget twice over. What is under test is the shape —
// reports rather than hangs — and the shape does not depend on the number.
const CAP_MS = 250

/** Resolving at all is half the assertion, so a hang fails rather than stalling the suite. */
async function settleWithin(page: Parameters<typeof settle>[0], ms: number) {
  let guard = 0
  try {
    return await Promise.race([
      settle(page, { capMs: CAP_MS }),
      new Promise<string>((r) => (guard = setTimeout(() => r("hung"), ms))),
    ])
  } finally {
    clearTimeout(guard)
  }
}

describe("settle", () => {
  it("clears a quiet page", async () => {
    const server = serve()
    try {
      await withPage(async (page) => {
        await page.goto(`${server.base}/quiet`, { waitUntil: "domcontentloaded" })
        expect(await settleWithin(page as never, 10_000)).toBe(true)
      })
    } finally {
      await server.close()
    }
  })

  it("reports rather than hangs when an image request never answers", async () => {
    const server = serve()
    try {
      await withPage(async (page) => {
        await page.goto(`${server.base}/stalling-image`, { waitUntil: "domcontentloaded" })
        expect(await settleWithin(page as never, 10_000)).toBe(false)
      })
    } finally {
      await server.close()
    }
  })

  it("reports a page that mutates without moving a box", async () => {
    const server = serve()
    try {
      await withPage(async (page) => {
        await page.goto(`${server.base}/mutating`, { waitUntil: "domcontentloaded" })
        expect(await settleWithin(page as never, 10_000)).toBe(false)
      })
    } finally {
      await server.close()
    }
  })
})
