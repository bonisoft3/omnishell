import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { renderDocument } from "../interpreter/document.js"
import { preloadScreen } from "../interpreter/preloads.js"

const files = {
  html: "shell/screens/home.html",
  css: "shell/screens/home.css",
  handlers: ["shell/handlers/save.js", "shell/handlers/save.js"],
  renderers: ["shell/renderers/body.js"],
  adapters: ["/omnishell/interpreter/adapters/wallclock.js"],
  shared: ["shell/shared/common.css"],
}
const route = { path: "/", screen: "home", nav: { strip: false }, files }

async function rendered(appBase: string, base: string, hints = "") {
  const ambientFetch = globalThis.fetch
  globalThis.fetch = ((url: URL | string) => Promise.resolve(new Response(
    String(url).endsWith(".html") ? '<section class="screen" data-screen="home"><h1>Home</h1></section>' : "",
  ))) as typeof fetch
  try {
    const { html, handle } = await renderDocument({
      entry: `<html><head><base href="${base}"><title>App</title>${hints}</head><body><div id="app"></div><script type="module" src="./boot.js"></script></body></html>`,
      parse: (text: string) => parseHTML(text).document,
      cfg: { app: "App", routes: [route, { path: "/other", screen: "other", nav: { strip: false }, files: { html: "shell/screens/other.html", css: "shell/screens/other.css" } }] },
      appBase,
      route,
      store: {},
      messages: {},
      rows: false,
      origin: "{{$o}}",
    })
    handle.stop()
    return parseHTML(html).document
  } finally {
    globalThis.fetch = ambientFetch
  }
}

function loader(document: ReturnType<typeof parseHTML>["document"]) {
  let paint!: (list: { getEntriesByName: (name: string) => object[] }, observer: { disconnect: () => void }) => void
  let disconnected = false
  const observer = { disconnect: () => { disconnected = true } }
  class PerformanceObserver {
    constructor(callback: typeof paint) { paint = callback }
    observe(options: object) { expect(options).toEqual({ type: "paint", buffered: true }) }
  }
  new Function("document", "PerformanceObserver", document.querySelector("script")!.textContent!)(document, PerformanceObserver)
  return (name: string) => {
    paint({ getEntriesByName: (asked) => asked === name ? [{}] : [] }, observer)
    return disconnected
  }
}

describe("a rendered document's hydration preloads", () => {
  it("starts only this screen's fetches and styles together after its first contentful paint", async () => {
    // Jessie is fetched as source, not imported: modulepreload would both
    // miss the fetch cache and parse modules outside their compartment.
    const document = await rendered("http://renderer.internal/", "/shell/", '<link rel="modulepreload" href="/omnishell/interpreter/screen.js">')
    const paint = loader(document)
    expect(document.querySelectorAll('link[rel="preload"], link[rel="modulepreload"], script[src]').length).toBe(0)
    expect(paint("first-paint")).toBe(false)
    expect(document.querySelectorAll('link[rel="preload"], link[rel="modulepreload"], script[src]').length).toBe(0)
    expect(paint("first-contentful-paint")).toBe(true)
    const fetches = [...document.querySelectorAll('link[rel="preload"][as="fetch"]')]
    expect(fetches.map((link) => link.getAttribute("href"))).toEqual([
      "/shell/screens/home.html", "/shell/screens/home.css", "/shell/handlers/save.js",
      "/shell/renderers/body.js", "/omnishell/interpreter/adapters/wallclock.js",
    ])
    expect(fetches.every((link) => link.getAttribute("crossorigin") === "anonymous")).toBe(true)
    expect(document.querySelector('link[as="style"]')?.getAttribute("href")).toBe("/shell/shared/common.css")
    expect(document.querySelector('link[as="style"]')?.hasAttribute("crossorigin")).toBe(false)
    expect([...document.querySelectorAll('link[rel="modulepreload"]')].map((link) => link.getAttribute("href")))
      .toEqual(["/omnishell/interpreter/screen.js"])
    expect(document.querySelector("script[src]")?.getAttribute("src")).toBe("./boot.js")
    expect(document.querySelector('link[href*="other"]')).toBe(null)
    expect(document.documentElement.outerHTML).not.toContain("renderer.internal")
  })

  it("reuses equivalent entry hints under the entry base and preserves an app prefix", async () => {
    const document = await rendered("http://renderer.internal/site/", "/site/shell/", [
      '<link rel="preload" href="./screens/home.html" as="fetch" crossorigin="anonymous">',
      '<link rel="preload" href="/site/shell/screens/home.html" as="fetch" crossorigin="anonymous">',
      '<link rel="modulepreload" href="/omnishell/interpreter/screen.js">',
      '<link rel="modulepreload" href="http://renderer.internal/omnishell/interpreter/screen.js">',
    ].join(""))
    loader(document)("first-contentful-paint")
    const links = [...document.querySelectorAll('link[rel="preload"], link[rel="modulepreload"]')]
    const urls = links.map((link) => new URL(link.getAttribute("href")!, "https://reader.test/site/shell/").href)
    expect(new Set(urls).size).toBe(links.length)
    expect(links.filter((link) => link.getAttribute("href") === "./screens/home.html").length).toBe(1)
    expect(document.querySelector('link[href="/site/shell/screens/home.css"]')).not.toBe(null)
    expect(document.querySelector('link[href="/site/shell/handlers/save.js"]')).not.toBe(null)
    expect(document.querySelector('link[href="/site/shell/shared/common.css"]')).not.toBe(null)
    expect(document.querySelector('link[href="/omnishell/interpreter/adapters/wallclock.js"]')).not.toBe(null)
  })

  it("starts the SPA route's remaining assets alongside its existing template fetch without duplicating served hints", () => {
    // The SPA already prefetches HTML/CSS and installs the arriving sheet;
    // issuing their hints as well would race those requests with duplicates.
    const { document } = parseHTML('<html><head><base href="/shell/"></head><body></body></html>')
    preloadScreen(document, "https://reader.test/", route, { template: false })
    expect([...document.querySelectorAll('link[as="fetch"]')].map((link) => link.getAttribute("href")))
      .toEqual(["/shell/handlers/save.js", "/shell/renderers/body.js", "/omnishell/interpreter/adapters/wallclock.js"])
    expect(document.querySelector('link[as="style"]')?.getAttribute("href")).toBe("/shell/shared/common.css")
    preloadScreen(document, "https://reader.test/", route)
    const count = document.querySelectorAll("link").length
    preloadScreen(document, "https://reader.test/", route, { template: false })
    expect(document.querySelectorAll("link").length).toBe(count)
    expect(count).toBe(6)
  })

  it("keeps the entry's linked sheets without issuing unused style hints or suppressing source fetches", async () => {
    // Shared sheets already load for the first paint. A fetch of CSS source
    // uses a different destination, so a stylesheet cannot cover that read.
    const sheets = [
      '<link rel="stylesheet" href="../shell/shared/common.css">',
      '<link rel="stylesheet" href="/site/shell/shared/common.css" media="print">',
      '<link rel="stylesheet" href="./screens/home.css">',
    ]
    const document = await rendered("http://renderer.internal/site/", "/site/shell/", sheets.join(""))
    loader(document)("first-contentful-paint")
    preloadScreen(document, "https://reader.test/site/", route, { template: false })
    expect([...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.outerHTML)).toEqual(sheets)
    expect(document.querySelector('link[rel="preload"][as="style"]')).toBe(null)
    expect(document.querySelector('link[rel="preload"][as="fetch"][href="/site/shell/screens/home.css"]')).not.toBe(null)
  })
})
