import { strict as assert } from "node:assert"
import { parseHTML } from "linkedom"
import { activateRelease, fetchRelease } from "../interpreter/release-assets.js"
import { releaseManifest, simulateStylesheetLoads } from "./release-fixture.ts"
import { interpretScreen } from "../interpreter/screen.js"
import { createStore } from "../interpreter/data-sync.js"
import { FIXTURE_CARRIERS } from "../interpreter/fixture-types.js"
import { ensureSes } from "../interpreter/jessie.js"

await ensureSes()

const base = new URL("https://example.test/app/")
const machine = JSON.stringify({ field: "phase", initial: "ready", states: {
  ready: { on: { dblclick: { guard: "allowed", assign: { title: "assigned" } } } },
} })
const html = `<section class="screen" data-screen="edit">
  <div data-live="note" data-filter="id=eq.n" data-handler="drag" data-machine='${machine}'>
    <button id="change" data-on-click="change">Change</button>
    <input class="direct" data-value="{title}" data-value-adapter="direct">
    <p class="result" data-text="{title}" data-text-format="label"></p>
  </div>
  <ul data-live="note"><template data-item><li>
    <input class="nested" data-value="{title}" data-value-adapter="nested">
    <button data-on-click="nested-change">Nested</button>
  </li></template></ul>
</section>`
const route = { screen: "edit", files: {
  html: "shell/screens/edit.html", css: "shell/screens/edit.css",
  handlers: ["drag", "change", "nested-change", "morph-change", "allowed", "assigned"].map(name => `shell/handlers/${name}.js`),
  adapters: ["direct", "nested"].map(name => `shell/handlers/${name}.js`),
  renderers: ["shell/handlers/label.js"],
} }
const contents = (version: string) => new Map([
  [route.files.html, html],
  [route.files.css, `@import "shared/edit.css"; .screen-${version}{color:red}`],
  ["shell/shared/edit.css", `.release-${version}{color:red}`],
  ["shell/handlers/drag.js", "() => ({updates:[]})"],
  ["shell/handlers/change.js", `() => ({updates:[{op:"patch",id:"n",row:{title:"${version}"}}]})`],
  ["shell/handlers/nested-change.js", "() => ({updates:[]})"],
  ["shell/handlers/morph-change.js", '() => ({updates:[{op:"patch",id:"n",row:{title:"morphed"}}]})'],
  ["shell/handlers/allowed.js", "() => true"],
  ["shell/handlers/assigned.js", `() => "${version}"`],
  ["shell/handlers/direct.js", `({format: v => "${version}:" + v, parse: v => v})`],
  ["shell/handlers/nested.js", `({format: v => "nested-${version}:" + v, parse: v => v})`],
  ["shell/handlers/label.js", `v => [{tag:"strong", children:["${version}:" + v]}]`],
  ["shell/validations/title.js", `(_state, event) => event.row.title !== "${version}-forbidden"`],
])

async function verified(files: Map<string, string>) {
  const manifest = await releaseManifest("runtime@one", files)
  globalThis.fetch = async request => {
    const path = new URL(String(request)).pathname.slice(base.pathname.length)
    return path === "shell/release.json"
      ? new Response(JSON.stringify(manifest))
      : new Response(files.get(path), { status: files.has(path) ? 200 : 404 })
  }
  return (await fetchRelease(base))!
}

async function fixture(run: (app: any) => Promise<void>) {
  const ambient = { document: globalThis.document, fetch: globalThis.fetch, sessionStorage: globalThis.sessionStorage }
  const originalCaches = globalThis.caches
  const { document, Event } = parseHTML("<html><head></head><body><div id='app'></div></body></html>")
  const stopStyles = simulateStylesheetLoads(document)
  globalThis.document = document as any
  globalThis.sessionStorage = { getItem: () => null } as any
  Object.defineProperty(globalThis, "caches", { value: undefined, configurable: true })
  let handle: any
  try {
    const release = await verified(contents("a"))
    activateRelease(release)
    const store = createStore("", {
      carriers: FIXTURE_CARRIERS, local: { note: "tab" }, appBase: base.href, release: true,
      seed: { note: [{id:"n",title:"start"}] },
      validations: { note: { title: { src: "shell/validations/title.js" } } },
    })
    const offline = () => { globalThis.fetch = async () => { throw new TypeError("offline") } }
    offline()
    await run({ document, Event, store, release, offline,
      async mount(opts = {}) {
        handle = await interpretScreen(document.getElementById("app"), base, route, store, {}, { release: true, ...opts })
        return handle
      },
    })
  } finally {
    stopStyles()
    handle?.stop()
    activateRelease(null)
    Object.assign(globalThis, ambient)
    Object.defineProperty(globalThis, "caches", { value: originalCaches, configurable: true })
  }
}

Deno.test("verified screen code and authored CSS load offline from one selected release", async () => {
  await fixture(async ({ mount, document, Event, store, release }) => {
    const replacement = await verified(contents("b"))
    globalThis.fetch = async () => { throw new TypeError("offline") }
    // Activation during an awaited mount must not swap its later module reads.
    const get = release.assets.get.bind(release.assets)
    Object.defineProperty(release.assets, "get", {value: (key: string) => {
      if (key.endsWith("edit.html")) activateRelease(replacement)
      return get(key)
    }})
    const handle = await mount()
    assert.equal(document.querySelector(".direct").value, "a:start")
    assert.equal(document.querySelector(".nested").value, "nested-a:start")
    assert.equal(document.querySelector(".result").textContent, "a:start")
    assert.equal(document.getElementById("screen-css-edit").textContent, contents("a").get(route.files.css))
    document.getElementById("change").dispatchEvent(new Event("click", {bubbles:true}))
    await handle.settle()
    assert.equal((await store.query("note"))[0].title, "a")
  })
})

Deno.test("a verified morph loads newly referenced modules without a network cache", async () => {
  await fixture(async ({ mount, document, Event, store, offline }) => {
    const handle = await mount()
    const files = contents("a")
    files.set(route.files.html, html.replace('data-on-click="change"', 'data-on-click="morph-change"'))
    activateRelease(await verified(files))
    offline()
    await handle.morph(files.get(route.files.html))
    document.getElementById("change").dispatchEvent(new Event("click", {bubbles:true}))
    await handle.settle()
    assert.equal((await store.query("note"))[0].title, "morphed")
  })
})

Deno.test("style updates preserve authored imports for the pinned browser CSS loader", async () => {
  await fixture(async ({ mount, document }) => {
    const handle = await mount()
    const css = '@import url("shared/edit.css") layer(theme) screen; .screen{color:blue}'
    await handle.updateStyle(css)
    assert.equal(document.getElementById("screen-css-edit").textContent, css)
  })
})

Deno.test("a store keeps its release's validation code until the store is rebuilt", async () => {
  await fixture(async ({ store, offline }) => {
    activateRelease(await verified(contents("b")))
    offline()
    await assert.rejects(store.patch("note", [{key:"n",changes:{title:"a-forbidden"}}]), /validation note.title/)
    await store.patch("note", [{key:"n",changes:{title:"b-forbidden"}}])
    assert.equal((await store.query("note"))[0].title, "b-forbidden")
  })
})

Deno.test("a mismatched served screen cannot bypass the verified release while offline", async () => {
  await fixture(async ({ mount, document }) => {
    document.getElementById("app").innerHTML = '<section class="screen" data-screen="edit"><h1>Old document</h1></section>'
    await mount({served:{cas:"previous-template",screen:document.querySelector(".screen")}})
    assert.equal(document.querySelector(".result").textContent, "a:start")
  })
})
