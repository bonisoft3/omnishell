import { describe, expect, it, type Page, withPage } from "./harness.ts"
import { releaseManifest } from "../test/release-fixture.ts"

async function serve() {
  const files = new Map<string, string | Uint8Array<ArrayBuffer>>([
    [
      "shell/index.html",
      '<!doctype html><html><head><meta name="referrer" content="no-referrer"></head><body>A document<script type="module" src="/shell/boot.js"></script></body></html>',
    ],
    ["shell/boot.js", 'import {version} from "/omnishell/interpreter/shell.js"; window.runtimeVersion = version;'],
    ["shell/shell.css", ""],
    ["shell/design.css", ""],
    ["shell/shell.json", JSON.stringify({ routes: [{ path: "/" }] })],
    ["omnishell/interpreter/shell.js", 'export const version = "A";'],
    [
      "shell/units/unit.js",
      `importScripts("./child.js");
      const nested = new Worker("./nested.mjs");
      nested.onmessage = ({data}) => postMessage({wrapper:"A",child:self.child,nested:data});
      onmessage = () => nested.postMessage("again");`,
    ],
    [
      "shell/units/nested.mjs",
      `importScripts("./child.js");
      const answer = async () => {
        const response = await fetch("./engine.wasm");
        await WebAssembly.compileStreaming(response.clone());
        postMessage({wrapper:"A",child:self.child,compiled:true,bytes:[...new Uint8Array(await response.arrayBuffer())]});
      };
      onmessage = answer; answer();`,
    ],
    ["shell/units/child.js", 'self.child = "A";'],
    ["shell/units/engine.wasm", new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 0, 2, 0, 255])],
  ])
  const worker = await Deno.readTextFile(new URL("../offline-first-sw.js", import.meta.url))
  const assets = await Deno.readTextFile(new URL("../interpreter/release-assets.js", import.meta.url))
  let manifest = await releaseManifest("runtime@A", files)
  const stop = new AbortController()
  const server = Deno.serve({ port: 0, signal: stop.signal, onListen() {} }, (request) => {
    const path = new URL(request.url).pathname.slice(1)
    if (path === "setup") {
      return new Response("<!doctype html><html><body>Setup</body></html>", {
        headers: { "Content-Type": "text/html" },
      })
    }
    if (path === "shell/release.json") return Response.json(manifest)
    const file = path === "offline-first-sw.js" ? worker : path === "probe-release-assets.js" ? assets : files.get(path)
    if (file === undefined) return new Response("missing", { status: 404 })
    const type = path.endsWith(".js")
      ? "text/javascript"
      : path.endsWith(".wasm")
      ? "application/wasm"
      : path.endsWith(".css")
      ? "text/css"
      : path.endsWith(".json")
      ? "application/json"
      : "text/html"
    return new Response(file, { headers: { "Content-Type": type, "Cache-Control": "no-store" } })
  })
  return {
    base: `http://localhost:${(server.addr as Deno.NetAddr).port}`,
    async deploy() {
      for (const [path, body] of files) {
        if (typeof body === "string") files.set(path, body.replaceAll('"A"', '"B"').replace("A document", "B document"))
      }
      files.set("shell/units/engine.wasm", new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 0, 2, 0, 254]))
      manifest = await releaseManifest("runtime@B", files)
    },
    async close() {
      stop.abort()
      await server.finished
    },
  }
}

async function prepare(page: Page, base: string) {
  await page.goto(`${base}/setup`)
  await page.evaluate(async () => {
    await (navigator as any).serviceWorker.register("/offline-first-sw.js")
    await (navigator as any).serviceWorker.ready
    if (!(navigator as any).serviceWorker.controller) {
      await new Promise((resolve) =>
        (navigator as any).serviceWorker.addEventListener("controllerchange", resolve, { once: true })
      )
    }
  })
  return stage(page)
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

describe("verified client lifetimes", () => {
  it("keeps reserved pins during concurrent navigations and cleanup", async () => {
    const server = await serve()
    try {
      await withPage(async (page) => {
        const id = await prepare(page, server.base)
        await server.deploy()
        const pages = await Promise.all(Array.from({ length: 16 }, () => page.context().newPage()))
        // Cleanup runs from another live client while resulting navigation
        // clients exist but have not become execution-ready.
        const checking = page.evaluate(async () => {
          for (let i = 0; i < 50; i++) {
            await new Promise((resolve) => {
              const channel = new MessageChannel()
              channel.port1.onmessage = ({ data }) => {
                channel.port1.close()
                resolve(data)
              }
              ;(navigator as any).serviceWorker.controller!.postMessage({ type: "PRONTO_RELEASE_CLIENT" }, [
                channel.port2,
              ])
            })
          }
        })
        await Promise.all(pages.map((tab) => tab.goto(`${server.base}/?pronto-release=${id}`)))
        await checking
        const versions = await Promise.all(pages.map(async (tab) => {
          await tab.waitForFunction(() => (window as any).runtimeVersion)
          return tab.evaluate(() => (window as any).runtimeVersion)
        }))
        expect(versions).toEqual(Array(16).fill("A"))
      })
    } finally {
      await server.close()
    }
  })

  it("pins imports and binary fetches in nested workers through another tab's release", async () => {
    const server = await serve()
    try {
      await withPage(async (page) => {
        const id = await prepare(page, server.base)
        await server.deploy()
        const pinned = await page.context().newPage()
        await pinned.goto(`${server.base}/?pronto-release=${id}`)
        await pinned.waitForFunction(() => (window as any).runtimeVersion === "A")
        const expected = {
          wrapper: "A",
          child: "A",
          nested: { wrapper: "A", child: "A", compiled: true, bytes: [0, 97, 115, 109, 1, 0, 0, 0, 0, 2, 0, 255] },
        }
        const result = await pinned.evaluate(() =>
          new Promise((resolve, reject) => {
            const worker = new Worker("/shell/units/unit.js")
            ;(window as any).probeWorker = worker
            worker.onmessage = ({ data }) => resolve(data)
            worker.onerror = (event) => reject(new Error(event.message))
          })
        )
        expect(result).toEqual(expected)
        await stage(page)
        const again = await pinned.evaluate(() =>
          new Promise((resolve) => {
            const worker = (window as any).probeWorker as Worker
            worker.onmessage = ({ data }) => resolve(data)
            worker.postMessage("again")
          })
        )
        expect(again).toEqual(expected)
        await pinned.evaluate(() => (window as any).probeWorker.terminate())
      })
    } finally {
      await server.close()
    }
  })
})
