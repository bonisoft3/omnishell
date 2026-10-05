import { describe, expect, it, type Page, withPage } from "./harness.ts"
import { releaseManifest } from "../test/release-fixture.ts"

const classes = ["top", "shared", "nested", "escaped", "quoted", "set", "absolute", "data", "fragment", "font", "content"]
const html = `<section class="screen" data-screen="probe">${classes.map(name => `<div class="${name}">Sample</div>`).join("")}</section>`
const css = String.raw`@import url("./shared/theme.css");
.top { background-image: url(img/top.svg); }
.escaped { background-image: url(img/esca\70 ed.svg); }
.quoted { background-image: url('img/quoted.svg'); }
.set { background-image: image-set("img/set.svg" type("image/svg+xml") 1x, url("img/set2.svg") 2x); }
.absolute { background-image: url(/shell/img/root.svg); }
.data { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"); }
.content::before { content: "url(img/not-a-resource.svg)"; }
/* url(img/comment.svg) */`
const shared = `@import "nested/child.css";
.shared { --generation: A; background-image: url('img/shared.svg'); }
@font-face { font-family: ReleaseProbe; src: url('../fonts/probe.woff2') format('woff2'); }
.font { font-family: ReleaseProbe; }`
const nested = `.nested { --generation: A; background-image: url(./img/nested.svg); }
.fragment { filter: url(#clip); }`

async function serve(delayStyles = false) {
  const files = new Map<string, string | Uint8Array<ArrayBuffer>>([
    ["shell/index.html", '<!doctype html><html><head><base href="/shell/"></head><body><main></main><script type="module" src="boot.js"></script></body></html>'],
    ["shell/boot.js", `import { fetchRelease, activateRelease } from "/omnishell/interpreter/release-assets.js";
      import { interpretScreen } from "/omnishell/interpreter/screen.js";
      const base = new URL("/", location.href);
      activateRelease(await fetchRelease(base, null, { releaseId: new URL(location.href).searchParams.get("pronto-release") }));
      const handle = await interpretScreen(document.querySelector("main"), base, {
        screen: "probe", path: "/probe", files: { html: "shell/screens/probe.html", css: "shell/screens/probe.css", handlers: [] },
      }, { query: async () => [], subscribe: () => () => {} }, {}, { release: true, handlers: false });
      await handle.settle(); window.stylesWhenReady = getComputedStyle(document.querySelector(".nested")).getPropertyValue("--generation").trim(); window.probeHandle = handle; window.probeReady = true;`],
    ["shell/shell.css", ""],
    ["shell/design.css", ""],
    ["shell/shell.json", JSON.stringify({ routes: [{ path: "/probe" }] })],
    ["shell/screens/probe.html", html],
    ["shell/screens/probe.css", css],
    ["shell/shared/theme.css", shared],
    ["shell/shared/alternate.css", ".shared { --generation: changed; }"],
    ["shell/shared/nested/child.css", nested],
    ["shell/fonts/probe.woff2", new Uint8Array([0, 1, 0, 0, 65])],
  ])
  for (const path of ["img/top.svg", "img/escaped.svg", "img/quoted.svg", "img/set.svg", "img/set2.svg", "img/root.svg", "shared/img/shared.svg", "shared/nested/img/nested.svg"]) {
    files.set(`shell/${path}`, '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>')
  }
  for (const module of ["shell.js", "screen.js", "render.js", "fragment.js", "hatch.js", "hatch-worker.js", "jessie.js", "release-assets.js"]) {
    files.set(`omnishell/interpreter/${module}`, await Deno.readTextFile(new URL(`../interpreter/${module}`, import.meta.url)))
  }
  const worker = (delayStyles ? `const originalMatch = Cache.prototype.match;
    Cache.prototype.match = async function(input, ...args) {
      if (String(input?.url ?? input).includes("/shared/")) await new Promise(resolve => setTimeout(resolve, 200));
      return originalMatch.call(this, input, ...args);
    };\n` : "") + await Deno.readTextFile(new URL("../offline-first-sw.js", import.meta.url))
  let manifest = await releaseManifest("runtime@css", files)
  const requests: string[] = []
  const stop = new AbortController()
  const server = Deno.serve({ port: 0, signal: stop.signal, onListen() {} }, request => {
    const path = new URL(request.url).pathname.slice(1)
    requests.push(path)
    if (path === "native") return new Response(`<!doctype html><html><head><base href="/shell/"><link rel="stylesheet" href="entry.css"></head><body>${html}</body></html>`, { headers: { "Content-Type": "text/html" } })
    if (path === "setup") return new Response("<!doctype html><html><body>Setup</body></html>", { headers: { "Content-Type": "text/html" } })
    if (path === "shell/release.json") return Response.json(manifest)
    const value = path === "offline-first-sw.js" ? worker : path === "probe-release-assets.js" ? files.get("omnishell/interpreter/release-assets.js") : path === "shell/entry.css" ? css : files.get(path)
    const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".svg") ? "image/svg+xml" : path.endsWith(".woff2") ? "font/woff2" : path.endsWith(".json") ? "application/json" : "text/html"
    return new Response(value ?? "missing", { status: value === undefined ? 404 : 200, headers: { "Content-Type": type, "Cache-Control": "no-store" } })
  })
  return {
    base: `http://localhost:${(server.addr as Deno.NetAddr).port}`,
    requests,
    async deploy() {
      files.set("shell/shared/theme.css", shared.replace("--generation: A", "--generation: B"))
      files.set("shell/shared/nested/child.css", nested.replace("--generation: A", "--generation: B"))
      files.set("shell/fonts/probe.woff2", new Uint8Array([0, 1, 0, 0, 66]))
      for (const [path, value] of files) if (path.endsWith(".svg") && typeof value === "string") files.set(path, value.replace('fill="red"', 'fill="blue"'))
      manifest = await releaseManifest("runtime@css", files)
    },
    async close() { stop.abort(); await server.finished },
  }
}

async function stage(page: Page) {
  return page.evaluate(async () => {
    const { fetchRelease, prepareRestartRelease } = await import(String("/probe-release-assets.js"))
    const base = new URL("/", location.href)
    const release = await fetchRelease(base)
    await prepareRestartRelease(base, release)
    return release.manifest.id as string
  })
}

async function prepare(page: Page, base: string) {
  await page.goto(`${base}/setup`)
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/offline-first-sw.js")
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }))
  })
  return stage(page)
}

async function ready(page: Page) {
  await page.waitForFunction(() => (window as any).probeReady)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForLoadState("networkidle")
}

async function styles(page: Page) {
  return page.evaluate(names => Object.fromEntries(names.map(name => {
    const node = document.querySelector(`.${name}`)!
    const style = getComputedStyle(node, name === "content" ? "::before" : null)
    return [name, name === "fragment" ? style.filter : name === "content" ? style.content : name === "font" ? style.fontFamily : style.backgroundImage]
  })), classes)
}

describe("verified stylesheet URL bases", () => {
  it("keeps native imports and their resources in the document's pinned release, including offline", async () => {
    const server = await serve()
    try {
      const native = await withPage(async page => {
        await page.goto(`${server.base}/native`)
        await page.evaluate(() => document.fonts.ready)
        return styles(page)
      })
      await withPage(async setup => {
        const first = await prepare(setup, server.base)
        await server.deploy()
        server.requests.length = 0
        const page = await setup.context().newPage()
        const resources = new Map<string, string>()
        const bodies: Promise<void>[] = []
        page.on("response", response => {
          if (!/\.(svg|woff2)$/.test(new URL(response.url()).pathname)) return
          bodies.push(response.body().then(bytes => { resources.set(new URL(response.url()).pathname.slice(1), bytes.toString("hex")) }))
        })
        await page.goto(`${server.base}/probe?pronto-release=${first}`)
        await ready(page)
        await Promise.all(bodies)
        expect(await styles(page)).toEqual(native)
        expect(await page.locator("#screen-css-probe").textContent()).toBe(css)
        expect(await page.evaluate(() => ["shared", "nested"].map(name => getComputedStyle(document.querySelector(`.${name}`)!).getPropertyValue("--generation").trim()))).toEqual(["A", "A"])
        const svgA = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>')
        const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("")
        for (const path of ["shell/img/top.svg", "shell/img/escaped.svg", "shell/img/quoted.svg", "shell/shared/img/shared.svg", "shell/shared/nested/img/nested.svg", "shell/img/root.svg"]) expect(resources.get(path)).toBe(hex(svgA))
        expect([...resources.keys()].some(path => /^shell\/img\/set2?\.svg$/.test(path))).toBe(true)
        // The font's request and bytes establish its base and pin; decoding
        // this deliberately incomplete font is outside the URL contract.
        expect(resources.get("shell/fonts/probe.woff2")).toBe("0001000041")
        expect(server.requests.filter(path => path.startsWith("shell/"))).toEqual([])
        const second = await stage(setup)
        expect(second).not.toBe(first)
        const newer = await setup.context().newPage()
        await newer.goto(`${server.base}/probe?pronto-release=${second}`)
        await ready(newer)
        expect(await newer.evaluate(() => getComputedStyle(document.querySelector(".nested")!).getPropertyValue("--generation").trim())).toBe("B")
        await setup.context().setOffline(true)
        resources.clear()
        bodies.length = 0
        await page.reload()
        await ready(page)
        await Promise.all(bodies)
        expect(resources.get("shell/shared/nested/img/nested.svg")).toBe(hex(svgA))
        expect(resources.get("shell/fonts/probe.woff2")).toBe("0001000041")
        expect(await styles(page)).toEqual(native)
        expect(await page.evaluate(() => ["shared", "nested"].map(name => getComputedStyle(document.querySelector(`.${name}`)!).getPropertyValue("--generation").trim()))).toEqual(["A", "A"])
        expect(await page.locator("#screen-css-probe").textContent()).toBe(css)
      })
    } finally { await server.close() }
  })

  it("awaits native import completion before initial readiness and style updates", async () => {
    const server = await serve(true)
    try {
      await withPage(async setup => {
        const id = await prepare(setup, server.base)
        const page = await setup.context().newPage()
        await page.goto(`${server.base}/probe?pronto-release=${id}`)
        await ready(page)
        expect(await page.evaluate(() => (window as any).stylesWhenReady)).toBe("A")
        const updated = await page.evaluate(async () => {
          const handle = (window as any).probeHandle
          const css = '@import url("./shared/alternate.css");'
          await handle.updateStyle(css)
          const value = getComputedStyle(document.querySelector(".shared")!).getPropertyValue("--generation").trim()
          await handle.updateStyle(css)
          await handle.updateStyle("")
          const plainCss = ".shared { --generation: plain; }"
          await handle.updateStyle(plainCss)
          // A sheet supplied by SSR or prefetch has no interpreter promise.
          const supplied = document.getElementById("screen-css-probe")!
          supplied.replaceWith(supplied.cloneNode(true))
          await handle.updateStyle(plainCss)
          let refused = false
          try { await handle.updateStyle('@import url("./shared/missing.css");') }
          catch { refused = true }
          const plain = getComputedStyle(document.querySelector(".shared")!).getPropertyValue("--generation").trim()
          return { value, plain, refused }
        })
        expect(updated).toEqual({ value: "changed", plain: "plain", refused: true })
      })
    } finally { await server.close() }
  })

})
