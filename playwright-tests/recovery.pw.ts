import { FIXTURE_CARRIERS } from "../interpreter/fixture-types.js"
import { describe, expect, it, type Page, withPage } from "./harness.ts"
import { addressRelease } from "../server/release-addresses.ts"
import { posix } from "node:path"
import { parse } from "npm:acorn@8.14.0"
import { simple } from "npm:acorn-walk@8.3.4"

async function importClosure(roots: string[]): Promise<string[]> {
  const seen = new Set<string>()
  const pending = [...roots]
  while (pending.length) {
    const module = pending.pop()!
    if (seen.has(module)) continue
    seen.add(module)
    const ast = parse(await Deno.readTextFile(new URL(`../interpreter/${module}`, import.meta.url)), { ecmaVersion: "latest", sourceType: "module" })
    const take = (source: { value?: unknown } | null | undefined) => {
      if (typeof source?.value === "string" && source.value.startsWith(".")) pending.push(posix.join(posix.dirname(module), source.value))
    }
    simple(ast, {
      ImportDeclaration: (node) => take(node.source),
      ExportNamedDeclaration: (node) => take(node.source),
      ExportAllDeclaration: (node) => take(node.source),
      ImportExpression: (node) => take(node.source as { value?: unknown }),
    })
  }
  return [...seen]
}

// The door as it serves a release (server/release-addresses.ts): each
// deployment's tree addressed, every address any deployment wrote still
// answered, and the current entry at every route.
async function serve(authenticated = false, automaticGuest = false, promoteTo?: string, retarget = false, mutationDrain = false, transition: { gate?: Promise<void>; fail?: number; hatches?: boolean; locales?: boolean; coldBoot?: boolean; progressive?: boolean; delayedThen?: boolean; listRedirect?: boolean; chainRedirect?: boolean; chainDelay?: boolean; cortex?: boolean; cortexRows?: boolean; cortexTimer?: boolean; cortexRetain?: boolean; homeMutation?: boolean } = {}) {

  const screen = (name: string) => `<section class="screen" data-screen="${name}"><h1>Release</h1><input name="draft" id="draft"><input name="answer" type="radio" value="no"><input name="answer" type="radio" value="yes"><div data-live="probe"><template data-item><p data-text="{id}"></p></template></div></section>`
  const files = new Map<string, string>([
    ["shell/index.html", `<!doctype html><html><head><base href="/shell/"><link rel="stylesheet" href="shell.css"></head><body><div id="app"><div class="shell-screen" data-served>${screen("home")}</div></div><script type="module" src="boot.js"></script></body></html>`],
    ["shell/shell.css", "body { --release: A }"],
    ["shell/design.css", ""],
    ["shell/boot.js", `import { createShell } from "/omnishell/interpreter/shell.js";
      navigator.serviceWorker.register("/offline-first-sw.js");
      createShell({config:"./shell.json",mount:document.getElementById("app")})
        .then(app => { window.appReady = !!app.store; window.navigate = app.navigate; window.cortex = app.cortex; });`],
    ["shell/shell.json", JSON.stringify({ app: "release", tables: automaticGuest ? ["unused"] : [], read: { unused: "lazy" }, ...(authenticated ? { auth: { required: true, service: "/auth", promote: !!promoteTo } } : {}), local: { probe: "tab" }, carriers: FIXTURE_CARRIERS, routes: [
      { path: "/", screen: "home", nav: { label: "Home" }, files: { html: "shell/screens/home.html", css: "shell/screens/home.css", handlers: [] } },
      { path: "/other", screen: "other", nav: { label: "Other" }, files: { html: "shell/screens/other.html", css: "shell/screens/other.css", handlers: [] } },
    ] })],
    ["shell/screens/home.html", screen("home")],
    ["shell/screens/other.html", screen("other")],
    ["shell/screens/other.css", ""],
    ["shell/screens/home.css", ""],
    ["offline-first-sw.js", await Deno.readTextFile(new URL("../offline-first-sw.js", import.meta.url))],
  ])
  if (retarget) {
    const config = JSON.parse(files.get("shell/shell.json")!)
    config.routes.push({ path: "/deck/:deck/:card", screen: "card", files: { html: "shell/screens/card.html", css: "shell/screens/card.css", handlers: [] } })
    files.set("shell/shell.json", JSON.stringify(config))
    files.set("shell/screens/card.html", `<section class="screen" data-screen="card" data-retarget-params="card"><p id="card" data-text="{param.card}"></p><a id="next" data-route="card" data-param-deck="{param.deck}" data-param-card="Charmander">Next</a><div data-live="probe"><template data-item><span data-text="{id}"></span></template></div><div style="height:2000px"></div></section>`)
    files.set("shell/screens/card.css", "")
  }
  if (transition.locales) {
    const config = JSON.parse(files.get("shell/shell.json")!)
    config.i18n = { default: "en", locales: { en: { path: "en" }, es: { path: "es" } } }
    files.set("shell/shell.json", JSON.stringify(config))
    files.set("shell/messages/en.json", "{}")
    files.set("shell/messages/es.json", "{")
  }
  if (transition.progressive) {
    const config = JSON.parse(files.get("shell/shell.json")!)
    config.local.detail = "tab"
    config.local.marker = "tab"
    config.seed = { probe: [{ id: "parent" }], detail: [{ id: "child", value: "Child ready" }] }
    config.routes.find((route: { screen: string }) => route.screen === "other").files.handlers = ["shell/handlers/detail.js"]
    files.set("shell/handlers/detail.js", '() => ({ updates: [{ op: "put", entity: "marker", id: "derived", row: { id: "derived", value: "ready" } }] })')
    files.set("shell/shell.json", JSON.stringify(config))
    files.set("shell/screens/other.html", `<section class="screen" data-screen="other"><div data-live="probe" data-empty-row='{"id":"parent"}'><template data-item><article><h1>Parent ready</h1><form data-action="update" data-entity="probe"><input name="draft"><select name="choice"><optgroup class="detail" data-live="detail" data-on-mutation="detail" data-empty=""><template data-item><option value="{id}" data-text="{value}"></option></template></optgroup></select><button type="submit">Save</button></form></article></template></div></section>`)
  }
  if (transition.homeMutation) {
    const config = JSON.parse(files.get("shell/shell.json")!)
    config.local = { probe: "tab", trigger: "tab", result: "tab" }
    config.schema = Object.fromEntries(Object.keys(config.local).map(table => [table, { fields: [{ name: "id", type: "string" }, { name: "value", type: "string" }] }]))
    config.routes[0].files.handlers = ["shell/handlers/home.js"]
    files.set("shell/shell.json", JSON.stringify(config))
    const region = '<div data-live="trigger" data-on-mutation="home"><template data-item><span data-text="{id}"></span></template></div>'
    files.set("shell/screens/home.html", screen("home").replace("</section>", `${region}</section>`))
    files.set("shell/index.html", files.get("shell/index.html")!.replace(screen("home"), screen("home").replace("</section>", `${region}</section>`)))
    files.set("shell/handlers/home.js", `(state) => ({ updates: state.items.map(row => ({ op: "put", entity: "result", id: row.id, row: { id: row.id, value: row.value } })) })`)

  }
  if (transition.coldBoot) {
    files.set("shell/index.html", files.get("shell/index.html")!.replace(`<div class="shell-screen" data-served>${screen("home")}</div>`, ""))
    files.set("shell/shell.css", ".shell-screen[data-entering] { opacity: 0 }")
    files.set("shell/screens/home.css", ".screen { --cold-boot-style: applied }")
    files.set("shell/screens/home.html", screen("home").replace("</section>", '<div data-live="probe"><template data-item><p data-text="{id}"></p></template></div></section>'))
  }
  if (mutationDrain) {
    const config = JSON.parse(files.get("shell/shell.json")!)
    config.local = { probe: "tab", trigger: "tab", label: "tab", late: "tab" }
    config.schema = Object.fromEntries(Object.keys(config.local).map(table => [table, { fields: [{ name: "id", type: "string" }, { name: "value", type: "string" }] }]))
    for (const [name, value] of [["other", "es"], ["english", "en"], ["hebrew", "he"]]) {
      const handler = `shell/handlers/${name}.js`
      const route = { path: `/${name}`, screen: name, nav: { label: name }, files: { html: `shell/screens/${name}.html`, css: `shell/screens/${name}.css`, handlers: [handler] } }
      const index = config.routes.findIndex((candidate: { screen: string }) => candidate.screen === name)
      if (index < 0) config.routes.push(route)
      else config.routes[index] = route
      files.set(route.files.html, `<section class="screen" data-screen="${name}"><h1>${name}</h1><div data-live="trigger" data-on-mutation="${name}"><template data-item><span data-text="{id}"></span></template></div>${name === "other" ? '<div data-live="probe"><template data-item><span data-text="{id}"></span></template></div>' : ""}</section>`)
      files.set(route.files.css, "")
      files.set(handler, `() => ({ updates: [{op:"put",entity:"label",id:"label",row:{value:"${value}"}}${name === "other" ? ',{op:"put",entity:"late",id:"late",row:{value:"es"}}' : ""}] })`)
    }
    files.set("shell/shell.json", JSON.stringify(config))
  }
  if (transition.delayedThen) {
    const config = JSON.parse(files.get("shell/shell.json")!)
    config.local = { probe: "tab", held: "tab", later: "tab" }
    config.schema = Object.fromEntries(Object.keys(config.local).map(table => [table, { fields: [{ name: "id", type: "string" }, { name: "value", type: "string" }] }]))
    config.routes.push({ path: "/delayed", screen: "delayed", nav: { strip: false }, files: { html: "shell/screens/delayed.html", css: "shell/screens/delayed.css", handlers: ["shell/handlers/delayed.js"] } })
    files.set("shell/shell.json", JSON.stringify(config))
    files.set("shell/screens/delayed.html", `<section class="screen" data-screen="delayed"><div data-live="held" data-empty=""><template data-item><p data-text="{id}"></p></template></div><div data-live="probe" data-filter="id=eq.seat" data-empty-row='{"id":"seat","value":""}' data-on-mutation="delayed"><template data-item><p data-text="{id}"></p></template></div></section>`)
    files.set("shell/screens/delayed.css", "")
    files.set("shell/handlers/delayed.js", `(state, event) => event.type === "later"
      ? { updates: [{ op: "put", entity: "later", id: "later", row: { id: "later", value: "written" } }] }
      : state.rows.probe?.[0]?.value ? { updates: [] }
      : { updates: [{ op: "put", entity: "probe", id: "seat", row: { id: "seat", value: "asked" } }], then: { type: "later", delay: 1 } }`)
  }
  if (transition.hatches) {
    const config = JSON.parse(files.get("shell/shell.json")!)
    config.hostDom = { probe: { src: "shell/hatches/probe.js", note: "Measure presentation lifecycle" } }
    for (const route of config.routes) route.hatches = ["probe"]
    files.set("shell/shell.json", JSON.stringify(config))
    files.set("shell/hatches/probe.js", `export default screen => {
      const node = screen.ownerDocument.createElement("p");
      node.className = "presentation-probe";
      node.textContent = "Mounted hatch";
      screen.append(node);
      (globalThis.hatchSizes ??= []).push(screen.getBoundingClientRect().width);
      return () => node.remove();
    }`)
  }
  if (transition.gate) {
    const config = JSON.parse(files.get("shell/shell.json")!)
    config.routes.push({ path: "/resolver", screen: "resolver", nav: { strip: false }, files: { html: "shell/screens/resolver.html", css: "shell/screens/resolver.css", handlers: ["shell/handlers/redirect.js"] } })
    if (transition.chainRedirect || transition.chainDelay) {
      config.local.marker = "tab"
      config.local.later = "tab"
      config.seed = { probe: [{ id: "route", value: "initial" }], marker: [{ id: "marker" }] }
    }
    if (transition.listRedirect) {
      config.local.detail = "tab"
      config.seed = { probe: [{ id: "route" }], detail: [{ id: "nested" }] }
    }
    files.set("shell/shell.json", JSON.stringify(config))
    files.set("shell/screens/resolver.html", transition.listRedirect
      ? `<section class="screen" data-screen="resolver"><p>Resolving destination</p><div data-live="probe" data-on-mutation="redirect"><template data-item><div><span data-text="{id}"></span><div data-live="detail" data-empty=""><template data-item><i data-text="{id}"></i></template></div></div></template></div></section>`
      : `<section class="screen" data-screen="resolver"><p>Resolving destination</p><div data-live="probe" data-empty-row='{"id":"route"}' data-on-mutation="redirect"><span data-text="{id}"></span></div></section>`)
    files.set("shell/screens/resolver.css", "")
    if (transition.chainRedirect || transition.chainDelay) {
      files.set("shell/screens/resolver.html", `<section class="screen" data-screen="resolver"><p>Resolving destination</p><div data-live="probe" data-filter="id=eq.route" data-on-mutation="redirect" data-read-marker="marker?limit=1"><span data-text="{id}"></span></div></section>`)
      const next = transition.chainDelay ? '{ type: "later", delay: 0.1 }' : '{ type: "intent:navigate", with: { route: "other", replace: true } }'
      files.set("shell/handlers/redirect.js", `(world, event) => event.type === "later" ? { updates: [{ op: "put", entity: "later", id: "result", row: { id: "result" } }] } : world.items[0]?.value === "ready" ? { then: ${next} } : { updates: [{ op: "put", entity: "probe", id: "route", row: { id: "route", value: "ready" } }] }`)
    } else files.set("shell/handlers/redirect.js", `() => ({ updates: [{ op: "put", entity: "probe", id: "route", row: { id: "route" } }], then: { type: "intent:navigate", with: { route: "other", replace: true } } })`)
  }
  if (transition.cortex) {
    const config = JSON.parse(files.get("shell/shell.json")!)
    const states: Record<string, unknown> = { routing: {} }
    const on: Record<string, unknown> = {}
    for (const { screen } of config.routes) {
      states[screen] = { initial: "loading", states: {
        loading: { invoke: { src: "navigate", onDone: "ready", onError: "failed" } }, ready: {}, failed: {},
      } }
      on[`route:${screen}`] = { target: `.${screen}`, reenter: true }
    }
    const actors: Record<string, unknown> = { navigate: { via: "navigation" } }
    if (transition.cortexRows) {
      const chart = { field: "status", initial: "idle", states: {
        idle: { on: { click: "selected" } }, selected: transition.cortexTimer ? { after: { 300: "idle" }, on: { click: "idle" } } : { on: { click: "idle" } },
      } }
      actors.homeRows = { via: "rows", screen: "home", lifetime: "attachment", charts: { toggle: chart } }
      if (transition.cortexTimer) (states.home as any).states.ready.invoke = [{ src: "homeRows" }]
      else (states.home as any).invoke = [{ src: "homeRows" }]
      config.schema = { probe: { fields: [{ name: "id", type: "string", pk: true }, { name: "status", type: "string" }] } }
      const control = `<button id="cortex-control" data-live="probe" data-filter="id=eq.toggle" data-empty-row='{"id":"toggle","status":"idle"}' data-status="{status}" data-cortex="homeRows" data-machine='${JSON.stringify(chart)}'>Toggle</button>`
      files.set("shell/screens/home.html", screen("home").replace("</section>", `${control}</section>`))
      files.set("shell/index.html", files.get("shell/index.html")!.replace(screen("home"), screen("home").replace("</section>", `${control}</section>`)))
    }
    if (transition.cortexRetain) {
      const chart = { field: "status", initial: "idle", states: {
        idle: { always: { guard: "isReady", target: "done" }, after: { 30: { guard: "isReady", target: "done" } } }, done: {},
      } }
      actors.cardRows = { via: "rows", screen: "card", lifetime: "attachment", charts: { state: chart } }
      ;(states.card as any).invoke = [{ src: "cardRows" }]
      const card = config.routes.find((route: { screen: string }) => route.screen === "card")
      card.keep = 2
      card.files.handlers = ["shell/handlers/isReady.js"]
      config.local.flag = "tab"
      config.schema = { flag: { fields: [{ name: "id", type: "string", pk: true }, { name: "status", type: "string" }, { name: "trigger", type: "string" }] } }
      files.set("shell/handlers/isReady.js", `(state) => state.items[0]?.trigger === "yes"`)
      files.set("shell/screens/card.html", files.get("shell/screens/card.html")!.replace(' data-retarget-params="card"', "").replace("</section>", `<div data-lease data-live="flag" data-filter="id=eq.{param.card}" data-status="{status}" data-cortex="cardRows" data-machine='${JSON.stringify(chart)}'></div></section>`))
    }
    config.cortex = { config: { initial: "routing", states, on }, actors }
    files.set("shell/shell.json", JSON.stringify(config))
  }
  // The modules the page reaches other than by an import naming them; what
  // they import follows, as the release's addressing requires of every
  // module a served one imports.
  const roots = ["shell.js", "deferred-boot.js", "presenter.js", "vendor/ses.umd.min.js", "vendor/js-yaml.js", "vendor/morphlex.js"]
  for (const module of await importClosure(roots)) files.set(`omnishell/interpreter/${module}`, await Deno.readTextFile(new URL(`../interpreter/${module}`, import.meta.url)))
  const shell = files.get("omnishell/interpreter/shell.js")!
  files.set("omnishell/interpreter/shell.js", `globalThis.runtimeRelease = "A";\n${shell}`)
  const served = new Map<string, Uint8Array>()
  let entry = ""
  const deployTree = async () => {
    const dir = await Deno.makeTempDir({ prefix: "recovery-release-" })
    try {
      for (const [name, body] of files) {
        await Deno.mkdir(`${dir}/${name.split("/").slice(0, -1).join("/")}`, { recursive: true })
        await Deno.writeTextFile(`${dir}/${name}`, body)
      }
      const release = await addressRelease(dir)
      for (const url of Object.values(release.imports)) served.set(url.slice(1), await Deno.readFile(`${dir}${url}`))
      served.set("offline-first-sw.js", await Deno.readFile(`${dir}/offline-first-sw.js`))
      entry = await Deno.readTextFile(`${dir}/shell/index.html`)
    } finally { await Deno.remove(dir, { recursive: true }) }
  }
  await deployTree()
  const stop = new AbortController()
  const server = Deno.serve({ port: 0, signal: stop.signal, onListen() {} }, async req => {
    const path = new URL(req.url).pathname.slice(1)
    if (path === "auth/login/start") return Response.json({ state: "challenge", challenge: "AA" })
    if (path === "auth/login/verify") return Response.json({ token: "promoted", user: { id: promoteTo, handle: "Promoted", guest: false } })
    if (path === "auth/guest") return Response.json({ token: "userB", user: { id: "B", handle: "User B", guest: true } })
    if (!path || path === "other" || (mutationDrain && (path === "english" || path === "hebrew")) || (retarget && path.startsWith("deck/"))) return new Response(entry, { headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" } })
    if (path.endsWith("-other.html")) {
      await transition.gate
      if (transition.fail) return new Response("unavailable", { status: transition.fail })
    }
    const file = served.get(path)
    if (file === undefined) return new Response("missing", { status: 404 })
    const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".json") ? "application/json" : "text/html"
    return new Response(file, { headers: { "Content-Type": type } })
  })
  return {
    base: `http://localhost:${(server.addr as Deno.NetAddr).port}`,
    async deploy(version: string, templateOnly = false) {
      if (templateOnly) {
        for (const screen of ["home", "other"]) {
          const path = `shell/screens/${screen}.html`
          files.set(path, files.get(path)!.replace(/<h1>.*?<\/h1>/, `<h1>Template ${version}</h1>`))
        }
      } else {
        files.set("omnishell/interpreter/shell.js", `globalThis.runtimeRelease = "${version}";\n${shell}`)
      }
      await deployTree()
    },
    async editor(rich: boolean) {
      const path = "shell/screens/home.html"
      files.set(path, files.get(path)!.replace(
        /<input name="draft" id="draft">|<div id="draft" contenteditable="true"><\/div>/,
        rich ? '<div id="draft" contenteditable="true"></div>' : '<input name="draft" id="draft">',
      ))
      await deployTree()
    },
    async close() { stop.abort(); await server.finished },
  }
}

async function refresh(page: Page) {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
}

async function ready(page: Page, version: string, timeout = 30_000) {
  await page.waitForFunction(version => (window as any).appReady && (window as any).runtimeRelease === version, version, { timeout })
}

describe("release draft recovery", () => {
  it("retargets an opted-in card route in place through history", async () => {
    const server = await serve(false, false, undefined, true)
    try {
      await withPage(async page => {
        await page.goto(`${server.base}/deck/a/Pikachu`)
        await page.locator('#card').waitFor()
        await page.waitForFunction(() => document.querySelector('#card')?.textContent === 'Pikachu')
        await page.evaluate(() => { (window as any).originalCard = document.querySelector('#card'); window.scrollTo(0, 500) })
        await page.locator('#next').evaluate((el: HTMLAnchorElement) => el.click())
        await page.waitForURL('**/deck/a/Charmander')
        await page.waitForFunction(() => document.querySelector('#card')?.textContent === 'Charmander')
        // A retarget presents nothing new, and the link pulsed forever when only a presented screen ended it.
        await page.waitForFunction(() => !document.querySelector('#next')?.hasAttribute('aria-busy'))
        expect(await page.evaluate(() => document.querySelector('#card') === (window as any).originalCard)).toBe(true)
        expect(await page.evaluate(() => window.scrollY)).toBe(500)
        await page.goBack()
        await page.waitForFunction(() => document.querySelector('#card')?.textContent === 'Pikachu')
        expect(await page.evaluate(() => document.querySelector('#card') === (window as any).originalCard)).toBe(true)
        await page.goForward()
        await page.waitForFunction(() => document.querySelector('#card')?.textContent === 'Charmander')
        expect(await page.evaluate(() => document.querySelector('#card') === (window as any).originalCard)).toBe(true)
      })
    } finally { await server.close() }
  })
  it("begins a delayed then only once its screen is on show", async () => {
    const server = await serve(false, false, undefined, false, false, { delayedThen: true })
    try {
      await withPage(async page => {
        await page.addInitScript(() => {
          let store: any
          Object.defineProperty(window, "__prontoStore", {
            configurable: true,
            get() { return store },
            set(value) {
              store = value
              const gate = new Promise<void>(resolve => { (window as any).finishRead = resolve })
              const { query, write } = store
              store.query = async (...args: any[]) => {
                if (args[0] === "held") await gate
                return query(...args)
              }
              store.write = (entity: string, ...rest: any[]) => {
                ((window as any).writes ??= []).push([entity, document.querySelector('[data-screen="delayed"]')?.closest(".shell-screen")?.hasAttribute("hidden")])
                return write(entity, ...rest)
              }
            },
          })
        })
        await page.goto(server.base)
        await ready(page, "A")
        await page.evaluate(() => { (window as any).navigate("/delayed") })
        await page.waitForFunction(() => (window as any).writes?.some(([entity]: [string]) => entity === "probe"))
        await page.waitForTimeout(100)
        // A write begun behind the screen is one settle waits for, so a slow server held the screen hidden.
        expect(await page.evaluate(() => (window as any).writes.some(([entity]: [string]) => entity === "later"))).toBe(false)
        await page.evaluate(() => (window as any).finishRead())
        await page.waitForFunction(() => (window as any).writes.some(([entity]: [string]) => entity === "later"))
        expect(await page.evaluate(() => (window as any).writes.find(([entity]: [string]) => entity === "later")[1])).toBe(false)
      })
    } finally { await server.close() }
  })
  it("says nothing of a delayed then's write that a page being left cut off", async () => {
    const server = await serve(false, false, undefined, false, false, { delayedThen: true })
    try {
      await withPage(async page => {
        const errors: string[] = []
        page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
        await page.addInitScript(() => {
          let store: any
          Object.defineProperty(window, "__prontoStore", {
            configurable: true,
            get() { return store },
            set(value) {
              store = value
              const { write } = store
              store.write = (entity: string, ...rest: any[]) => {
                if (entity !== "later") return write(entity, ...rest)
                // A navigation fails what is in flight, and a delayed step now starts just as a reader can leave.
                window.dispatchEvent(new Event("pagehide"))
                ;(window as any).cutOff = true
                return Promise.reject(new TypeError("Failed to fetch"))
              }
            },
          })
        })
        await page.goto(server.base)
        await ready(page, "A")
        await page.evaluate(() => { (window as any).navigate("/delayed") })
        await page.waitForFunction(() => (window as any).cutOff === true)
        await page.waitForTimeout(100)
        expect(errors.filter(text => text.includes("Failed to fetch"))).toEqual([])
      })
    } finally { await server.close() }
  })
  it("shows a held screen at once and refreshes it behind", async () => {
    const server = await serve(false, false, undefined, false, false, { coldBoot: true })
    try {
      await withPage(async page => {
        await page.addInitScript(() => {
          const state = window as any
          let store: any
          const gate = new Promise<void>(resolve => { state.releaseRead = resolve })
          Object.defineProperty(window, "__prontoStore", {
            configurable: true, get() { return store }, set(value) {
              store = value
              const query = store.query
              store.query = async (...args: any[]) => {
                if (state.holdRead && args[0] === "probe") { state.readHeld = true; await gate }
                return query(...args)
              }
            },
          })
        })
        await page.goto(server.base)
        await ready(page, "A")
        await page.evaluate(() => (window as any).navigate("/other").finished)
        await page.evaluate(() => { (window as any).holdRead = true; (window as any).navigate("/") })
        // Hidden until its reads answered, a screen in memory waited on the network to be shown.
        await page.waitForFunction(() => (window as any).readHeld === true)
        expect(await page.evaluate(() => document.querySelector('[data-screen="home"]')?.closest(".shell-screen")?.hasAttribute("hidden"))).toBe(false)
        await page.evaluate(() => (window as any).releaseRead())
      })
    } finally { await server.close() }
  })
  it("keeps newer input while a replacement screen waits for a region read", async () => {
    const server = await serve()
    try {
      await withPage(async page => {
        await page.addInitScript(() => {
          let store: any
          Object.defineProperty(window, "__prontoStore", {
            configurable: true,
            get() { return store },
            set(value) {
              store = value
              if ((window as any).runtimeRelease !== "B") return
              const gate = new Promise<void>(resolve => { (window as any).finishRead = resolve })
              const query = store.query
              store.query = async (...args: any[]) => {
                if (args[0] === "probe") await gate
                return query(...args)
              }
            },
          })
        })
        await page.goto(server.base)
        await ready(page, "A")
        await page.locator('input[value="yes"]').check()
        await page.locator('input[name="draft"]').fill("before restart")
        await page.locator('input[name="draft"]').blur()
        await server.deploy("B")
        await refresh(page)
        await page.waitForFunction(() => (window as any).runtimeRelease === "B" &&
          !!(window as any).finishRead && !!document.querySelector("[data-live=probe]"))
        await page.waitForFunction(() => !document.querySelector('.shell-screen[inert]'))
        await page.locator('input[name="draft"]').fill("typed while hydrating")
        await page.locator('input[value="no"]').check()
        await page.evaluate(() => (window as any).finishRead())
        await ready(page, "B")
        expect(await page.locator('input[name="draft"]').inputValue()).toBe("typed while hydrating")
        expect(await page.locator('input[value="no"]').isChecked()).toBe(true)
        expect(await page.locator('input[value="yes"]').isChecked()).toBe(false)
      })
    } finally { await server.close() }
  })

  for (const next of ["morph", "restart", "reload"]) {
    it(`retains an unvisited draft through a subsequent ${next}`, async () => {
      const server = await serve()
      try {
        await withPage(async page => {
          await page.goto(server.base)
          await ready(page, "A")
          await page.locator('input[name="draft"]').fill("home draft")
          await page.locator('input[name="draft"]').blur()
          await page.evaluate(() => (window as any).navigate("/other").finished)
          await page.locator('[data-screen="other"] input[name="draft"]').fill("other draft")
          await page.locator('[data-screen="other"] input[name="draft"]').blur()
          await server.deploy("B")
          await refresh(page)
          await ready(page, "B")
          expect(await page.locator('input[name="draft"]').inputValue()).toBe("other draft")
          expect(await page.evaluate(() => Object.keys(JSON.parse(sessionStorage.getItem("pronto-release-recovery")!).screens))).toHaveLength(1)
          if (next === "restart") {
            await server.deploy("C")
            await refresh(page)
            await ready(page, "C", 60_000)
          } else {
            await server.deploy("C", true)
            await refresh(page)
            await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Template C", undefined, { timeout: 60_000 })
            if (next === "reload") {
              await page.reload()
              await ready(page, "B")
            }
          }
          await page.evaluate(() => (window as any).navigate("/").finished)
          expect(await page.locator('[data-screen="home"] input[name="draft"]').inputValue()).toBe("home draft")
          expect(await page.evaluate(() => sessionStorage.getItem("pronto-release-recovery"))).toBe(null)
        })
      } finally { await server.close() }
    })
  }

  for (const switchAccount of ["signout", "replace", "same-account", "promotion", "same-promotion"]) {
    it(`scopes pending recovery to its account across ${switchAccount}`, async () => {
      const server = await serve(true, false, switchAccount === "promotion" ? "B" : switchAccount === "same-promotion" ? "A" : undefined)
      try {
        await withPage(async page => {
          await page.addInitScript(() => {
            Object.defineProperty(navigator.credentials, "get", { value: async () => ({
              id: "credential", rawId: new ArrayBuffer(1), type: "public-key",
              getClientExtensionResults: () => ({}),
              response: { clientDataJSON: new ArrayBuffer(1), authenticatorData: new ArrayBuffer(1), signature: new ArrayBuffer(1) },
            }) })
            if (sessionStorage.getItem("seeded")) return
            sessionStorage.setItem("seeded", "yes")
            sessionStorage.setItem("pronto-token", JSON.stringify({ token: "userA", user: { id: "A", handle: "User A", guest: true } }))
          })
          await page.goto(server.base)
          await ready(page, "A")
          await page.locator('input[name="draft"]').fill("private draft for A")
          await page.locator('input[name="draft"]').blur()
          await page.evaluate(() => (window as any).navigate("/other").finished)
          await server.deploy("B")
          await refresh(page)
          await ready(page, "B")
          if (switchAccount === "signout") {
            await page.locator(".shell-signout").click()
            await page.locator(".login-guest").waitFor()
            expect(await page.evaluate(() => sessionStorage.getItem("pronto-release-recovery"))).toBe(null)
            await page.locator(".login-guest").click()
          } else if (switchAccount.endsWith("promotion")) {
            await page.locator(".shell-signin").click()
            await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("pronto-token")!).user.guest === false)
            await page.waitForFunction(() => (window as any).appReady && document.querySelector(".shell-signout") !== null)
          } else {
            await page.evaluate(same => sessionStorage.setItem("pronto-token", JSON.stringify({
              token: "new-token", user: { id: same ? "A" : "B", handle: "New session", guest: false },
            })), switchAccount === "same-account")
            await page.reload()
          }
          await ready(page, "B")
          await page.evaluate(() => (window as any).navigate("/").finished)
          expect(await page.locator('[data-screen="home"] input[name="draft"]').inputValue())
            .toBe(switchAccount.startsWith("same-") ? "private draft for A" : "")
        })
      } finally { await server.close() }
    })
  }

  it("keeps plain text inert when a template switches to a rich editor", async () => {
    const server = await serve()
    try {
      await withPage(async page => {
        await page.goto(server.base)
        await ready(page, "A")
        const text = '<img src="bad" onerror="window.injected=42">'
        await page.locator('input[name="draft"]').fill(text)
        await page.locator('input[name="draft"]').blur()
        await server.editor(true)
        await refresh(page)
        await page.locator("#draft[contenteditable]").waitFor()
        expect(await page.locator("#draft").textContent()).toBe(text)
        expect(await page.locator("#draft img").count()).toBe(0)
        expect(await page.evaluate(() => (window as any).injected)).toBe(undefined)
        await page.locator("#draft").evaluate(el => {
          el.innerHTML = "<b>Formatted draft</b>"
          el.dispatchEvent(new Event("input", { bubbles: true }))
        })
        await server.editor(false)
        await refresh(page)
        await page.locator("input#draft").waitFor()
        expect(await page.locator("#draft").inputValue()).toBe("Formatted draft")
      })
    } finally { await server.close() }
  })


  it("retains an anonymous bootstrap draft for the automatically minted guest", async () => {
    const server = await serve(false, true)
    try {
      await withPage(async page => {
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        // The shell has not started while the reader types.
        await page.route("**/_immutable-*-shell.js", async route => { await gate; await route.continue() })
        await page.goto(server.base, { waitUntil: "commit" })
        await page.locator('input[name="draft"]').fill("guest draft")
        await page.locator('input[name="draft"]').blur()
        release()
        await ready(page, "A")
        expect(await page.locator('input[name="draft"]').inputValue()).toBe("guest draft")
        expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("pronto-token")!).user.id)).toBe("B")
      })
    } finally { await server.close() }
  })


  it("replaces a malformed optional-auth token without restoring its old drafts", async () => {
    const server = await serve(false, true)
    try {
      await withPage(async page => {
        await page.goto(server.base)
        await ready(page, "A")
        await page.locator('input[name="draft"]').fill("untrusted old account draft")
        await page.locator('input[name="draft"]').blur()
        await page.evaluate(() => (window as any).navigate("/other").finished)
        await server.deploy("B")
        await refresh(page)
        await ready(page, "B")
        expect(await page.evaluate(() => Object.keys(JSON.parse(sessionStorage.getItem("pronto-release-recovery")!).screens))).toHaveLength(1)
        await page.evaluate(() => sessionStorage.setItem("pronto-token", "{malformed"))
        await page.reload()
        await ready(page, "B")
        expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("pronto-token")!).user.guest)).toBe(true)
        expect(await page.evaluate(() => sessionStorage.getItem("pronto-release-recovery"))).toBe(null)
        await page.evaluate(() => (window as any).navigate("/").finished)
        expect(await page.locator('[data-screen="home"] input[name="draft"]').inputValue()).toBe("")
      })
    } finally { await server.close() }
  })

})


it("keeps the presented screen and sidebar while a cold destination loads", async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const server = await serve(false, false, undefined, false, false, { gate, hatches: true })
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      await page.locator('input[name="draft"]').fill("retained draft")
      await page.evaluate(() => {
        const state = window as any
        state.previousScreen = document.querySelector('[data-screen="home"]')
        state.previousNav = document.querySelector('body > nav')
        state.navigationDone = state.navigate("/other").finished
      })
      await page.waitForURL("**/other")
      await page.waitForFunction(() => document.querySelectorAll('#app > .shell-screen').length === 2)
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
      expect(await page.locator('[data-screen="home"] .presentation-probe').isVisible()).toBe(true)
      expect(await page.locator('[data-screen="home"] input[name="draft"]').inputValue()).toBe("retained draft")
      expect(await page.evaluate(() => document.querySelector('body > nav') === (window as any).previousNav)).toBe(true)
      release()
      await page.evaluate(() => (window as any).navigationDone)
      expect(await page.locator('[data-screen="other"]').isVisible()).toBe(true)
      expect(await page.evaluate(() => (window as any).hatchSizes.every((size: number) => size > 0))).toBe(true)
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(false)
      await page.evaluate(() => (window as any).navigate("/").finished)
      expect(await page.evaluate(() => document.querySelector('[data-screen="home"]') === (window as any).previousScreen)).toBe(true)
      expect(await page.locator('[data-screen="home"] input[name="draft"]').inputValue()).toBe("retained draft")
    })
  } finally { release(); await server.close() }
})

it("retains the presented screen through a resolving route", async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const server = await serve(false, false, undefined, false, false, { gate })
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      await page.evaluate(() => {
        (window as any).navigate("/resolver").finished.catch((error: Error) => {
          if (error.name !== "AbortError") throw error
        })
      })
      await page.waitForURL("**/other")
      await page.waitForFunction(() => document.querySelectorAll('#app > .shell-screen').length === 3)
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
      expect(await page.locator('[data-screen="resolver"]').isVisible()).toBe(false)
      release()
      await page.locator('[data-screen="other"]').waitFor({ state: "visible" })
    })
  } finally { release(); await server.close() }
})

for (const listRedirect of [false, true]) it(`never reveals a ${listRedirect ? "list" : "slot"} redirect while its write or destination is pending`, async () => {
  let releaseDestination!: () => void
  const gate = new Promise<void>(resolve => { releaseDestination = resolve })
  const server = await serve(false, false, undefined, false, false, { gate, listRedirect })
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      await page.evaluate((listRedirect) => {
        const state = window as any
        const store = state.__prontoStore
        const query = store.query.bind(store)
        const nested = new Promise<void>(resolve => { state.releaseNested = resolve })
        store.query = async (...args: any[]) => {
          if (listRedirect && args[0] === "detail") { state.nestedBlocked = true; await nested }
          return query(...args)
        }
        const write = store.write.bind(store)
        state.holdRedirect = () => {
          state.redirectBlocked = false
          state.redirectGate = new Promise<void>(resolve => { state.releaseRedirect = resolve })
        }
        state.holdRedirect()
        store.write = async (...args: any[]) => {
          if (args[0] === "probe" && args[1]?.some((item: any) => item.key === "route")) {
            state.redirectBlocked = true
            await state.redirectGate
          }
          return write(...args)
        }
        state.revealedScreens = []
        const observer = new MutationObserver(records => {
          for (const record of records) {
            if (record.type !== "attributes" || record.attributeName !== "hidden" || record.oldValue === null) continue
            const mount = record.target as Element
            if (!mount.classList.contains("shell-screen") || mount.hasAttribute("hidden")) continue
            const screen = mount.querySelector("[data-screen]")?.getAttribute("data-screen")
            if (screen) state.revealedScreens.push(screen)
          }
        })
        observer.observe(document.querySelector("#app")!, { subtree: true, attributes: true, attributeFilter: ["hidden"], attributeOldValue: true })
        state.visibilityObserver = observer
        state.navigate("/resolver").finished.catch((error: Error) => {
          if (error.name !== "AbortError") state.navigationError = error.message
        })
      }, listRedirect)
      if (listRedirect) {
        await page.waitForFunction(() => (window as any).nestedBlocked)
        await page.waitForTimeout(100)
        expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
        expect(await page.evaluate(() => (window as any).revealedScreens.includes("resolver"))).toBe(false)
        await page.evaluate(() => (window as any).releaseNested())
      }
      await page.waitForFunction(() => (window as any).redirectBlocked)
      await page.waitForTimeout(100)
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
      expect(await page.evaluate(() => (window as any).revealedScreens.includes("resolver"))).toBe(false)
      await page.evaluate(() => (window as any).releaseRedirect())
      await page.waitForURL("**/other")
      await page.waitForTimeout(100)
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
      expect(await page.evaluate(() => (window as any).revealedScreens.includes("resolver"))).toBe(false)
      releaseDestination()
      await page.locator('[data-screen="other"]').waitFor({ state: "visible" })
      expect(await page.evaluate(() => (window as any).revealedScreens.includes("resolver"))).toBe(false)
      expect(await page.evaluate(() => (window as any).navigationError ?? null)).toBe(null)
      await page.evaluate(() => (window as any).navigate("/").finished)
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
      await page.evaluate(() => {
        const state = window as any
        state.holdRedirect()
        state.navigate("/resolver").finished.catch((error: Error) => {
          if (error.name !== "AbortError") state.navigationError = error.message
        })
      })
      await page.waitForFunction(() => (window as any).redirectBlocked)
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
      expect(await page.evaluate(() => (window as any).revealedScreens.includes("resolver"))).toBe(false)
      await page.evaluate(() => (window as any).releaseRedirect())
      await page.waitForURL("**/other")
      await page.locator('[data-screen="other"]').waitFor({ state: "visible" })
      expect(await page.evaluate(() => (window as any).revealedScreens.includes("resolver"))).toBe(false)
      expect(await page.evaluate(() => (window as any).navigationError ?? null)).toBe(null)
      await page.evaluate(() => (window as any).visibilityObserver.disconnect())
    })
  } finally { releaseDestination(); await server.close() }
})

it("holds a self-woken initial action until its redirect resolves", async () => {
  let releaseDestination!: () => void
  const gate = new Promise<void>(resolve => { releaseDestination = resolve })
  const server = await serve(false, false, undefined, false, false, { gate, chainRedirect: true })
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      await page.evaluate(() => {
        const state = window as any
        const store = state.__prontoStore
        const query = store.query.bind(store)
        const gate = new Promise<void>(resolve => { state.releaseSecond = resolve })
        state.markerReads = 0
        store.query = async (...args: any[]) => {
          if (args[0] === "marker" && ++state.markerReads > 1) { state.secondBlocked = true; await gate }
          return query(...args)
        }
        state.navigate("/resolver").finished.catch((error: Error) => { if (error.name !== "AbortError") state.navigationError = error.message })
      })
      await page.waitForFunction(() => (window as any).secondBlocked, undefined, { timeout: 5000 })
      await page.waitForTimeout(100)
      const homeWhileBlocked = await page.locator('[data-screen="home"]').isVisible()
      await page.evaluate(() => (window as any).releaseSecond())
      await page.waitForURL("**/other")
      releaseDestination()
      await page.locator('[data-screen="other"]').waitFor({ state: "visible" })
      expect(homeWhileBlocked).toBe(true)
    })
  } finally { releaseDestination(); await server.close() }
})

it("presents a self-woken action that hands a delayed continuation to the future", async () => {
  let releaseDestination!: () => void
  const gate = new Promise<void>(resolve => { releaseDestination = resolve })
  const server = await serve(false, false, undefined, false, false, { gate, chainDelay: true })
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      await page.evaluate(() => {
        const state = window as any
        const store = state.__prontoStore
        const query = store.query.bind(store)
        const gate = new Promise<void>(resolve => { state.releaseSecond = resolve })
        state.markerReads = 0
        store.query = async (...args: any[]) => {
          if (args[0] === "marker" && ++state.markerReads > 1) { state.secondBlocked = true; await gate }
          return query(...args)
        }
        state.navigate("/resolver").finished.then(() => { state.destinationDone = true }, (error: Error) => { state.navigationError = error.message })
      })
      await page.waitForFunction(() => (window as any).secondBlocked, undefined, { timeout: 5000 })
      await page.evaluate(() => (window as any).releaseSecond())
      await page.locator('[data-screen="resolver"]').waitFor({ state: "visible", timeout: 5000 })
      await page.waitForFunction(() => (window as any).destinationDone, undefined, { timeout: 5000 })
      await page.waitForFunction(async () => (await (window as any).__prontoStore.query("later")).some((row: { id: string }) => row.id === "result"), undefined, { timeout: 5000 })
      expect(await page.evaluate(() => (window as any).navigationError ?? null)).toBe(null)
    })
  } finally { releaseDestination(); await server.close() }
})

it("restores interaction with the presented screen when a destination fails", async () => {
  const server = await serve(false, false, undefined, false, false, { fail: 503 })
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      expect(await page.evaluate(async () => {
        try { await (window as any).navigate("/other").finished; return "unexpected success" }
        catch (error) { return (error as Error).message }
      })).toContain("503")
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
      expect(await page.locator('[data-screen="home"]').evaluate(el => el.closest('.shell-screen')!.hasAttribute('inert'))).toBe(false)
      await page.locator('[data-screen="home"] input[name="draft"]').fill("still usable")
    })
  } finally { await server.close() }
})

for (const missing of [false, true]) it(missing ? "heals a missing asset when returning to a pending destination" : "waits for an already pending destination when returning to it", async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const server = await serve(false, false, undefined, false, false, { gate, fail: missing ? 404 : undefined })
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      const origin = await page.evaluate(() => performance.timeOrigin)
      await page.evaluate(() => {
        (window as any).navigate("/other").finished.catch((error: Error) => {
          if (error.name !== "AbortError") throw error
        })
      })
      await page.waitForFunction(() => document.querySelectorAll('#app > .shell-screen').length === 2)
      await page.evaluate(() => (window as any).navigate("/").finished)
      await page.evaluate(() => { (window as any).pendingNavigation = (window as any).navigate("/other").finished })
      await page.waitForURL("**/other")
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
      release()
      if (missing) {
        await page.waitForFunction(origin => performance.timeOrigin !== origin && sessionStorage.getItem("pronto-healed-at") !== null, origin)
        return
      }
      await page.evaluate(() => (window as any).pendingNavigation)
      expect(await page.locator('[data-screen="other"]').isVisible()).toBe(true)
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(false)
    })
  } finally { release(); await server.close() }
})

it("drains automatic writes across overlapping navigation before the old hydration handle exists", async () => {
  const server = await serve(false, false, undefined, false, true)
  try {
    await withPage(async page => {
      await page.addInitScript(() => {
        let store: any
        const state = window as any
        state.committedLabels = []
        state.navigationErrors = []
        state.navigationFailed = (error: Error) => {
          if (error.name !== "AbortError") state.navigationErrors.push(error.message)
        }
        Object.defineProperty(window, "__prontoStore", {
          configurable: true,
          get() { return store },
          set(value) {
            store = value
            const query = store.query
            const write = store.write
            const hydration = new Promise<void>(resolve => { state.releaseHydration = resolve })
            const mutation = new Promise<void>(resolve => { state.releaseOldWrite = resolve })
            store.query = async (...args: any[]) => {
              if (state.stallHydration && args[0] === "probe") {
                state.hydrationBlocked = true
                await hydration
              }
              return query(...args)
            }
            store.write = async (...args: any[]) => {
              const label = args[0] === "label" ? args[1][0]?.row.value : undefined
              if (label === "es") {
                state.oldWriteStarted = true
                await mutation
              }
              const result = await write(...args)
              if (label) state.committedLabels.push(label)
              return result
            }
          },
        })
      })
      await page.goto(server.base)
      await ready(page, "A")
      await page.evaluate(() => {
        const state = window as any
        state.stallHydration = true
        state.navigate("/other").finished.catch(state.navigationFailed)
      })
      await page.waitForFunction(() => (window as any).oldWriteStarted && (window as any).hydrationBlocked)
      await page.evaluate(() => { (window as any).navigate("/english").finished.catch((window as any).navigationFailed) })
      await page.waitForFunction(() => document.querySelector('[data-screen="other"]')?.parentElement?.hidden)
      await page.evaluate(() => { (window as any).navigate("/hebrew").finished.catch((window as any).navigationFailed) })
      await page.waitForURL('**/hebrew')
      expect(await page.evaluate(() => (window as any).committedLabels)).toEqual([])
      expect(await page.locator('[data-screen="english"], [data-screen="hebrew"]').count()).toBe(0)
      await page.evaluate(() => { (window as any).releaseOldWrite() })
      await page.waitForFunction(() => (window as any).committedLabels.includes("he"))
      expect(await page.evaluate(() => (window as any).committedLabels)).toEqual(["es", "he"])
      expect(await page.evaluate(async () => await (window as any).__prontoStore.query("late"))).toEqual([])
      await page.evaluate(() => { (window as any).releaseHydration() })
      await page.waitForFunction(() => !document.querySelector('[data-screen="other"] [data-live="probe"]')?.hasAttribute("data-hydrating"))
      expect(await page.evaluate(async () => (await (window as any).__prontoStore.query("label"))[0]?.value)).toBe("he")
      expect(await page.evaluate(() => (window as any).navigationErrors)).toEqual([])
      expect(await page.evaluate(async () => await (window as any).__prontoStore.query("late"))).toEqual([])
    })
  } finally { await server.close() }
})


it("presents a retargeted card even when its previous visit is still staging", async () => {
  const server = await serve(false, false, undefined, true)
  try {
    await withPage(async page => {
      await page.addInitScript(() => {
        let store: any
        const state = window as any
        const gate = new Promise<void>(resolve => { state.releaseRead = resolve })
        Object.defineProperty(window, "__prontoStore", {
          configurable: true, get() { return store }, set(value) {
            store = value
            const query = store.query
            store.query = async (...args: any[]) => {
              if (state.blockRead && args[0] === "probe") { state.readBlocked = true; await gate }
              return query(...args)
            }
          },
        })
      })
      await page.goto(server.base)
      await ready(page, "A")
      await page.evaluate(() => (window as any).navigate("/deck/a/Pikachu").finished)
      await page.evaluate(() => (window as any).navigate("/deck/a/Charmander").finished)
      await page.evaluate(() => (window as any).navigate("/").finished)
      await page.evaluate(() => {
        const state = window as any
        state.blockRead = true
        state.navigate("/deck/a/Charmander").finished.catch((error: Error) => { if (error.name !== "AbortError") throw error })
      })
      await page.waitForFunction(() => (window as any).readBlocked)
      await page.evaluate(() => { (window as any).lastNavigation = (window as any).navigate("/deck/a/Pikachu").finished })
      await page.waitForURL("**/deck/a/Pikachu")
      await page.evaluate(() => { (window as any).blockRead = false; (window as any).releaseRead() })
      await page.evaluate(() => (window as any).lastNavigation)
      expect(await page.locator('[data-screen="card"]:visible #card').textContent()).toBe("Pikachu")
      expect(await page.locator('.shell-screen:not([hidden])[inert]').count()).toBe(0)
    })
  } finally { await server.close() }
})

it("restores the outgoing screen when a newer catalogue fails during staging", async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const server = await serve(false, false, undefined, false, false, { gate, locales: true })
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      await page.evaluate(() => {
        (window as any).navigate("/other").finished.catch((error: Error) => { if (error.name !== "AbortError") throw error })
      })
      await page.waitForFunction(() => document.querySelector('[data-screen="home"]')?.closest('.shell-screen')?.hasAttribute('inert'))
      let catalogueFailed = false
      await page.route(/es\.json$/, async route => { catalogueFailed = true; await route.abort("failed") })
      const error = await page.evaluate(async () => {
        try { await (window as any).navigate("/other?lang=es").finished; return "unexpected success" }
        catch (error) { return (error as Error).message }
      })
      expect(error).toContain("Failed to fetch")
      expect(catalogueFailed).toBe(true)
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
      await page.locator('[data-screen="home"] input[name="draft"]').fill("catalogue failure recovered")
      release()
      await page.waitForTimeout(50)
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
    })
  } finally { release(); await server.close() }
})

it("a failed navigation releases the link it pulsed and puts the address and the strip back on the screen on show", async () => {
  const server = await serve(false, false, undefined, false, false, {})
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      await page.evaluate(() => {
        const store = (window as any).__prontoStore
        const query = store.query
        let blocked = false
        store.query = async (...args: any[]) => {
          if (!blocked && args[0] === "probe") { blocked = true; await new Promise(() => {}) }
          return query(...args)
        }
        const timer = window.setTimeout.bind(window)
        window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: any[]) => timer(callback, delay === 15000 ? 100 : delay, ...args)) as typeof setTimeout
      })
      await page.locator('body > nav a[data-route="other"]').click()
      await page.waitForSelector("[data-shell-error]")
      expect(await page.locator("[data-shell-error]").innerText()).toContain("navigation timed out")
      // The link it pressed is released, the home screen shows, and the address and the strip say home.
      expect(await page.locator('body > nav [aria-busy="true"]').count()).toBe(0)
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
      expect(await page.evaluate(() => location.pathname)).toBe("/")
      expect(await page.locator('body > nav a[data-route="home"]').getAttribute("aria-current")).toBe("page")
      expect(await page.locator('body > nav a[data-route="other"]').getAttribute("aria-current")).toBeNull()
    })
  } finally { await server.close() }
})

// A turn that stalled before staging anything (a catalogue that never answers, the
// last screen's writes) had no bound: the one that fired armed only once the
// presented screen went inert, and the strip pulsed for good.
it("a navigation stalled before it stages anything is bounded, and the next one proceeds", async () => {
  const server = await serve(false, false, undefined, false, false, { locales: true })
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      await page.evaluate(() => {
        const timer = window.setTimeout.bind(window)
        window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: any[]) => timer(callback, delay === 15000 ? 100 : delay, ...args)) as typeof setTimeout
      })
      await page.route(/es\.json$/, () => {})
      const stalled = await page.evaluate(async () => {
        try { await (window as any).navigate("/other?lang=es").finished; return "unexpected success" }
        catch (error) { return (error as Error).message }
      })
      expect(stalled).toContain("navigation timed out")
      expect(stalled).toContain("before leaving the screen on show")
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
      await page.unroute(/es\.json$/)
      await page.evaluate(() => (window as any).navigate("/other").finished)
      expect(await page.locator('[data-screen="other"]').isVisible()).toBe(true)
    })
  } finally { await server.close() }
})

it("a link to the address on show shows the screen again, never a document in the page's place", async () => {
  const server = await serve()
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      await page.evaluate(() => { (window as any).__sameDocument = true })
      await page.locator('body > nav a[data-route="home"]').click()
      await page.waitForTimeout(300)
      expect(await page.evaluate(() => (window as any).__sameDocument === true)).toBe(true)
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
      expect(await page.evaluate(() => location.pathname)).toBe("/")
    })
  } finally { await server.close() }
})

for (const stalledRead of [false, true]) it(`bounds a stalled ${stalledRead ? "region read" : "asset load"} and ignores its late destination`, async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const server = await serve(false, false, undefined, false, false, { gate: stalledRead ? undefined : gate })
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      await page.evaluate(stalledRead => {
        if (stalledRead) {
          const state = window as any
          const store = state.__prontoStore
          const query = store.query
          const read = new Promise<void>(resolve => { state.releaseRegionRead = resolve })
          let blocked = false
          store.query = async (...args: any[]) => {
            if (!blocked && args[0] === "probe") { blocked = true; await read }
            return query(...args)
          }
        }
        const timer = window.setTimeout.bind(window)
        window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: any[]) => timer(callback, delay === 15000 ? 100 : delay, ...args)) as typeof setTimeout
      }, stalledRead)
      const timedOut = await page.evaluate(async () => {
        try { await (window as any).navigate("/other").finished; return "unexpected success" }
        catch (error) { return (error as Error).message }
      })
      expect(timedOut).toContain("navigation timed out")
      // The bound names what it was waiting on: the screen, and the region whose read stalled.
      expect(timedOut).toContain("other at /other")
      if (stalledRead) expect(timedOut).toContain("probe")
      await page.locator('[data-screen="home"] input[name="draft"]').fill("timeout recovered")
      release()
      if (stalledRead) await page.evaluate(() => (window as any).releaseRegionRead())
      await page.waitForTimeout(100)
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
      expect(await page.locator('[data-screen="other"]:visible').count()).toBe(0)
      expect(await page.locator('[data-shell-error]').count()).toBe(1)
      await page.evaluate(() => (window as any).navigate("/").finished)
      expect(await page.locator('[data-shell-error]').count()).toBe(0)
    })
  } finally { release(); await server.close() }
})

it("holds the first screen through initial reads and releases later updates", async () => {
  const server = await serve(false, false, undefined, false, false, { coldBoot: true })
  try {
    await withPage(async page => {
      await page.addInitScript(() => {
        let store: any
        const gate = new Promise<void>(resolve => { (window as any).releaseInitialRead = resolve })
        Object.defineProperty(window, "__prontoStore", {
          configurable: true, get() { return store }, set(value) {
            store = value
            const query = store.query.bind(store)
            store.query = async (...args: unknown[]) => { await gate; return query(...args) }
          },
        })
      })
      await page.goto(server.base)
      await page.locator('.shell-screen[data-entering]').waitFor()
      expect(await page.locator("[data-initial-loading]").count()).toBe(1)
      expect(await page.locator('.shell-screen').evaluate(el => getComputedStyle(el).opacity)).toBe("0")
      const initialTop = await page.locator(".shell-screen").evaluate(el => el.getBoundingClientRect().top)
      await page.evaluate(() => (window as any).releaseInitialRead())
      await ready(page, "A")
      expect(await page.locator(".shell-screen").evaluate(el => el.getBoundingClientRect().top)).toBe(initialTop)
      expect(await page.locator('.shell-screen').evaluate(el => getComputedStyle(el).opacity)).toBe("1")
      expect(await page.locator('[role="status"]').count()).toBe(0)
      await page.evaluate(() => (window as any).__prontoStore.write("probe", [{ key: "later", row: { id: "later" } }]))
      await page.waitForFunction(() => document.querySelectorAll('[data-screen="home"] p').length === 2)
      expect(await page.locator('.shell-screen').evaluate(el => getComputedStyle(el).opacity)).toBe("1")
    })
  } finally { await server.close() }
})

it("reveals a slow first screen after a bounded wait", async () => {
  const server = await serve(false, false, undefined, false, false, { coldBoot: true })
  try {
    await withPage(async page => {
      await page.addInitScript(() => {
        let store: any
        Object.defineProperty(window, "__prontoStore", {
          configurable: true, get() { return store }, set(value) {
            store = value
            store.query = () => new Promise(() => {})
          },
        })
      })
      await page.goto(server.base)
      await page.locator('.shell-screen[data-entering]').waitFor()
      await page.waitForFunction(() => document.getElementById('screen-css-home'))
      expect(await page.locator('#screen-css-home').evaluate((el: HTMLStyleElement) => el.disabled)).toBe(false)
      await page.locator('[data-screen="home"] input[name="draft"]').focus()
      expect(await page.evaluate(() => document.activeElement?.id)).not.toBe("draft")
      await page.waitForFunction(() => !document.querySelector('.shell-screen[data-entering]'))
      expect(await page.locator('[data-screen="home"] h1').isVisible()).toBe(true)
      expect(await page.locator('[data-screen="home"]').evaluate(el => getComputedStyle(el).getPropertyValue('--cold-boot-style').trim())).toBe('applied')
      expect(await page.locator('[role="status"]').count()).toBe(0)
      await page.locator('[data-screen="home"] input[name="draft"]').focus()
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("draft")
    })
  } finally { await server.close() }
})

it("clears the first loading status when a newer navigation wins", async () => {
  const server = await serve(false, false, undefined, false, false, { coldBoot: true })
  try {
    await withPage(async page => {
      await page.addInitScript(() => {
        let store: any
        ;(window as any).holdInitial = true
        const gate = new Promise<void>(resolve => { (window as any).releaseInitialRead = resolve })
        Object.defineProperty(window, "__prontoStore", {
          configurable: true, get() { return store }, set(value) {
            store = value
            const query = store.query.bind(store)
            store.query = async (...args: unknown[]) => {
              if ((window as any).holdInitial) await gate
              return query(...args)
            }
          },
        })
      })
      await page.goto(server.base)
      await page.locator('.shell-screen[data-entering]').waitFor()
      await page.evaluate(() => {
        (window as any).holdInitial = false
        ;(window as any).navigation.navigate("/other")
      })
      await page.locator('[data-screen="other"]').waitFor({ state: "visible" })
      expect(await page.locator('[role="status"]').count()).toBe(0)
      await page.evaluate(() => (window as any).releaseInitialRead())
      expect(await page.locator('[data-screen="home"]:visible').count()).toBe(0)
    })
  } finally { await server.close() }
})

it("keeps partial cold-boot content when its first read fails", async () => {
  const server = await serve(false, false, undefined, false, false, { coldBoot: true })
  try {
    await withPage(async page => {
      await page.addInitScript(() => {
        let store: any
        Object.defineProperty(window, "__prontoStore", {
          configurable: true, get() { return store }, set(value) {
            store = value
            store.query = async () => { throw new Error("first read unavailable") }
          },
        })
      })
      await page.goto(server.base)
      await page.waitForFunction(() => document.body.textContent?.includes("first read unavailable"))
      expect(await page.locator('[data-screen="home"] h1').isVisible()).toBe(true)
      expect(await page.locator('[data-screen="home"]').evaluate(el => el.closest('.shell-screen')!.hasAttribute('inert'))).toBe(true)
      expect(await page.locator('[data-shell-error]').evaluate(el => el.closest('[inert]') === null)).toBe(true)
    })
  } finally { await server.close() }
})


it("ignores a stale destination failure after a newer navigation succeeds", async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const server = await serve(false, false, undefined, true, false, { gate, fail: 503 })
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      await page.evaluate(() => {
        (window as any).navigate("/other").finished.catch((error: Error) => { if (error.name !== "AbortError") throw error })
      })
      await page.waitForFunction(() => document.querySelectorAll('#app > .shell-screen').length === 2)
      await page.evaluate(() => (window as any).navigate("/deck/a/Pikachu").finished)
      release()
      await page.waitForTimeout(100)
      expect(await page.locator('[data-screen="card"]').isVisible()).toBe(true)
      expect(await page.locator('.shell-screen:not([hidden])[inert]').count()).toBe(0)
      expect(await page.locator('[data-shell-error]').count()).toBe(0)
    })
  } finally { release(); await server.close() }
})

it("does not restore an old error after a newer navigation overtakes recovery", async () => {
  const server = await serve(false, false, undefined, true, false, { fail: 503 })
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      await page.evaluate(() => {
        const state = window as any
        const store = state.__prontoStore
        const query = store.query
        const recovery = new Promise<void>(resolve => { state.releaseRecovery = resolve })
        let blocked = false
        store.query = async (...args: any[]) => {
          if (!blocked && args[0] === "probe") { blocked = true; state.recoveryBlocked = true; await recovery }
          return query(...args)
        }
        state.navigate("/other").finished.catch((error: Error) => { if (error.name !== "AbortError") throw error })
      })
      await page.waitForFunction(() => (window as any).recoveryBlocked)
      await page.evaluate(() => (window as any).navigate("/deck/a/Pikachu").finished)
      await page.evaluate(() => (window as any).releaseRecovery())
      await page.waitForTimeout(100)
      expect(await page.locator('[data-screen="card"]').isVisible()).toBe(true)
      expect(await page.locator('[data-shell-error]').count()).toBe(0)
      expect(await page.locator('.shell-screen:not([hidden])[inert]').count()).toBe(0)
    })
  } finally { await server.close() }
})


it("presents a cold destination before its nested reads finish", async () => {
  const server = await serve(false, false, undefined, false, false, { progressive: true })
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      await page.evaluate(() => {
        const state = window as any
        const store = state.__prontoStore
        const query = store.query.bind(store)
        const gate = new Promise<void>(resolve => { state.releaseDetail = resolve })
        store.query = async (...args: unknown[]) => {
          if (args[0] === "detail") { state.detailBlocked = true; await gate }
          return query(...args)
        }
        state.destinationDone = false
        state.navigate("/other").finished.then(() => { state.destinationDone = true })
      })
      await page.waitForFunction(() => (window as any).detailBlocked)
      await page.locator('[data-screen="other"] h1').waitFor({ state: "visible" })
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(false)
      expect(await page.evaluate(() => (window as any).destinationDone)).toBe(false)
      expect(await page.locator('[data-screen="other"]').evaluate(el => el.closest('.shell-screen')!.inert)).toBe(true)
      expect(await page.locator('[data-screen="other"]').evaluate(el => el.closest('.shell-screen')!.getAttribute('aria-busy'))).toBe('true')
      let blocked = false
      try { await page.locator('[data-screen="other"] button').click({ timeout: 300 }) } catch { blocked = true }
      expect(blocked).toBe(true)
      await page.evaluate(() => (window as any).releaseDetail())
      await page.waitForFunction(() => (window as any).destinationDone)
      expect(await page.locator('[data-screen="other"] option').innerText()).toBe("Child ready")
      expect(await page.locator('[data-screen="other"]').evaluate(el => el.closest('.shell-screen')!.inert)).toBe(false)
      expect(await page.locator('[data-screen="other"]').evaluate(el => el.closest('.shell-screen')!.hasAttribute('aria-busy'))).toBe(false)
      await page.locator('[data-screen="other"] input').fill("ready to edit")
      expect(await page.locator('[data-screen="other"] input').inputValue()).toBe("ready to edit")
    })
  } finally { await server.close() }
})


it("previews while unrelated notification wakes continue during a nested read", async () => {
  const server = await serve(false, false, undefined, false, false, { progressive: true })
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      await page.evaluate(() => {
        const state = window as any
        const store = state.__prontoStore
        const query = store.query.bind(store)
        const flush = store.flushNotifications.bind(store)
        const gate = new Promise<void>(resolve => { state.releaseDetail = resolve })
        store.flushNotifications = () => Math.max(1, flush())
        store.query = async (...args: unknown[]) => {
          if (args[0] === "detail") { state.detailBlocked = true; await gate }
          return query(...args)
        }
        state.finishRead = () => { store.flushNotifications = flush; state.releaseDetail() }
        state.navigate("/other").finished.then(() => { state.destinationDone = true }, (error: Error) => { state.navigationError = error.message })
      })
      await page.waitForFunction(() => (window as any).detailBlocked)
      await page.locator('[data-screen="other"] h1').waitFor({ state: "visible", timeout: 5000 })
      expect(await page.evaluate(() => (window as any).__prontoStore.flushNotifications() > 0)).toBe(true)
      expect(await page.evaluate(() => (window as any).destinationDone === true)).toBe(false)
      expect(await page.evaluate(() => (window as any).navigationError ?? null)).toBe(null)
      await page.evaluate(() => (window as any).finishRead())
      await page.waitForFunction(() => (window as any).destinationDone)
      expect(await page.locator('[data-screen="other"] option').innerText()).toBe("Child ready")
    })
  } finally { await server.close() }
})

it("restores the committed screen after a preview's nested invariant fails", async () => {
  const server = await serve(false, false, undefined, false, false, { progressive: true })
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      await page.evaluate(() => {
        const state = window as any
        const store = state.__prontoStore
        const query = store.query.bind(store)
        const gate = new Promise<void>(resolve => { state.releaseDetail = resolve })
        store.query = async (...args: unknown[]) => {
          if (args[0] === "detail") { state.detailBlocked = true; await gate; return [{ id: "broken" }] }
          return query(...args)
        }
        state.navigate("/other").finished.catch((error: Error) => { state.navigationError = error.message })
      })
      await page.waitForFunction(() => (window as any).detailBlocked)
      await page.locator('[data-screen="other"] h1').waitFor({ state: "visible" })
      expect(await page.title()).toBe("Parent ready — release")
      expect(await page.locator('link[rel=canonical]').getAttribute('href')).toBe(`${server.base}/other`)
      await page.evaluate(() => (window as any).releaseDetail())
      await page.waitForFunction(() => (window as any).navigationError)
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
      expect(await page.title()).toBe("Release — release")
      expect(await page.locator('link[rel=canonical]').getAttribute('href')).toBe(`${server.base}/`)
      expect(await page.locator('[data-screen="home"]').evaluate(el => el.closest('.shell-screen')!.inert)).toBe(false)
      expect(await page.locator('[data-screen="other"]').count()).toBe(0)
      await page.locator('[data-screen="home"] input[name=draft]').fill("still usable")
    })
  } finally { await server.close() }
})

it("restores the committed view while a newer navigation overtakes a preview", async () => {
  const server = await serve(false, false, undefined, true, false, { progressive: true })
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      await page.evaluate(() => {
        const state = window as any
        const store = state.__prontoStore
        const query = store.query.bind(store)
        const detail = new Promise<void>(resolve => { state.releaseDetail = resolve })
        const next = new Promise<void>(resolve => { state.releaseNext = resolve })
        store.query = async (...args: unknown[]) => {
          if (args[0] === "detail") { state.detailBlocked = true; await detail }
          if (args[0] === "probe" && state.blockNext) { state.nextBlocked = true; await next }
          return query(...args)
        }
        state.navigate("/other").finished.catch(() => {})
      })
      await page.waitForFunction(() => (window as any).detailBlocked)
      await page.locator('[data-screen="other"] h1').waitFor({ state: "visible" })
      expect(await page.title()).toBe("Parent ready — release")
      expect(await page.locator('link[rel=canonical]').getAttribute('href')).toBe(`${server.base}/other`)
      await page.evaluate(() => {
        const state = window as any
        state.blockNext = true
        state.navigate("/deck/a/Pikachu").finished.then(() => { state.nextDone = true })
      })
      await page.waitForFunction(() => (window as any).nextBlocked)
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
      expect(await page.title()).toBe("Release — release")
      expect(await page.locator('link[rel=canonical]').getAttribute('href')).toBe(`${server.base}/`)
      expect(await page.locator('[data-screen="other"]').isVisible()).toBe(false)
      await page.evaluate(() => { (window as any).releaseDetail(); (window as any).releaseNext() })
      await page.waitForFunction(() => (window as any).nextDone)
      expect(await page.locator('[data-screen="card"]').isVisible()).toBe(true)
      expect(await page.locator('[data-screen="home"]').isVisible()).toBe(false)
    })
  } finally { await server.close() }
})


it("previews while a nested mutation settles, with controls inert until its write lands", async () => {
  const server = await serve(false, false, undefined, false, false, { progressive: true, hatches: true })
  try {
    await withPage(async page => {
      await page.goto(server.base)
      await ready(page, "A")
      await page.evaluate(() => {
        const state = window as any
        const store = state.__prontoStore
        const write = store.write.bind(store)
        const gate = new Promise<void>(resolve => { state.releaseMutation = resolve })
        store.write = async (...args: unknown[]) => {
          if (args[0] === "marker") { state.mutationBlocked = true; await gate }
          return write(...args)
        }
        state.navigate("/other").finished.then(() => { state.destinationDone = true })
      })
      await page.waitForFunction(() => (window as any).mutationBlocked)
      await page.locator('[data-screen="other"] h1').waitFor({ state: "visible" })
      expect(await page.locator('[data-screen="other"]').evaluate(el => el.closest('.shell-screen')!.inert)).toBe(true)
      expect(await page.evaluate(() => (window as any).destinationDone === true)).toBe(false)
      expect(await page.locator('[data-screen="other"] .presentation-probe').count()).toBe(0)
      await page.evaluate(() => (window as any).releaseMutation())
      await page.waitForFunction(() => (window as any).destinationDone)
      expect(await page.locator('[data-screen="other"]').evaluate(el => el.closest('.shell-screen')!.inert)).toBe(false)
      expect(await page.locator('[data-screen="other"] .presentation-probe').count()).toBe(1)
      expect(await page.evaluate(() => (window as any).hatchSizes.every((size: number) => size > 0))).toBe(true)
      expect(await page.evaluate(async () => (await (window as any).__prontoStore.query("marker"))[0]?.value)).toBe("ready")
    })
  } finally { await server.close() }
})

describe("Cortex navigation", () => {
  it("resumes automatic mutations when a catalogue fails before leaving the presented screen", async () => {
    const server = await serve(false, false, undefined, false, false, { cortex: true, locales: true, homeMutation: true })
    try {
      await withPage(async page => {
        await page.goto(server.base)
        await ready(page, "A")
        await page.route(/es\.json$/, route => route.abort("failed"))
        expect(await page.evaluate(async () => {
          try { await (window as any).navigate('/other?lang=es').finished; return 'unexpected success' }
          catch (error) { return (error as Error).message }
        })).toContain('Failed to fetch')
        expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
        await page.evaluate(() => (window as any).__prontoStore.write('trigger', [{ key: 'after', row: { id: 'after', value: 'recovered' } }]))
        expect(await page.evaluate(async () => {
          const deadline = Date.now() + 3000
          do {
            if ((await (window as any).__prontoStore.query('result')).some((row: any) => row.value === 'recovered')) return true
            await new Promise(resolve => setTimeout(resolve, 25))
          } while (Date.now() < deadline)
          return false
        })).toBe(true)
      })
    } finally { await server.close() }
  })

  it("boots a deep link and follows same-screen changes and history", async () => {
    const server = await serve(false, false, undefined, true, false, { cortex: true })
    try {
      await withPage(async page => {
        await page.goto(`${server.base}/deck/a/Pikachu`)
        await ready(page, "A")
        await page.waitForFunction(() => document.querySelector('#card')?.textContent === 'Pikachu')
        expect(await page.evaluate(() => (window as any).cortex.snapshot().value)).toEqual({ card: "ready" })
        await page.evaluate(() => (window as any).navigate('/deck/a/Charmander').finished)
        await page.waitForFunction(() => document.querySelector('#card')?.textContent === 'Charmander')
        expect(await page.evaluate(() => (window as any).cortex.snapshot().value)).toEqual({ card: "ready" })
        await page.goBack()
        await page.waitForFunction(() => document.querySelector('#card')?.textContent === 'Pikachu')
        await page.waitForFunction(() => (window as any).cortex.snapshot().matches({ card: 'ready' }))
        await page.goForward()
        await page.waitForFunction(() => document.querySelector('#card')?.textContent === 'Charmander')
        await page.waitForFunction(() => (window as any).cortex.snapshot().matches({ card: 'ready' }))
      })
    } finally { await server.close() }
  })

  it("reattaches a cached screen's row machine when its route returns", async () => {
    const server = await serve(false, false, undefined, false, false, { cortex: true, cortexRows: true })
    try {
      await withPage(async page => {
        await page.goto(server.base)
        await ready(page, "A")
        await page.locator("#cortex-control").click()
        await page.waitForFunction(() => document.querySelector('#cortex-control')?.getAttribute('data-status') === 'selected')
        await page.evaluate(() => (window as any).navigate('/other').finished)
        await page.evaluate(() => document.querySelector<HTMLButtonElement>('#cortex-control')!.click())
        expect(await page.locator('#cortex-control').getAttribute('data-status')).toBe('selected')
        await page.evaluate(() => (window as any).navigate('/').finished)
        expect(await page.locator('#cortex-control').getAttribute('data-status')).toBe('selected')
        await page.locator('#cortex-control').click()
        await page.waitForFunction(() => document.querySelector('#cortex-control')?.getAttribute('data-status') === 'idle')
      })
    } finally { await server.close() }
  })

  it("runs a retained row family only for the active parameterized screen", async () => {
    const server = await serve(false, false, undefined, true, false, { cortex: true, cortexRetain: true })
    try {
      await withPage(async page => {
        await page.goto(server.base)
        await ready(page, "A")
        await page.evaluate(async () => {
          await (window as any).__prontoStore.write("flag", [
            { key: "First", row: { id: "First", status: "idle", trigger: "no" } },
            { key: "Second", row: { id: "Second", status: "idle", trigger: "no" } },
          ])
        })
        await page.evaluate(() => (window as any).navigate('/deck/a/First').finished)
        await page.evaluate(() => (window as any).navigate('/deck/a/Second').finished)
        await page.evaluate(async () => {
          await (window as any).__prontoStore.write("flag", [
            { key: "First", row: { id: "First", status: "idle", trigger: "yes" } },
            { key: "Second", row: { id: "Second", status: "idle", trigger: "yes" } },
          ])
        })
        await page.waitForFunction(async () => (await (window as any).__prontoStore.query('flag')).find((row: any) => row.id === 'Second')?.status === 'done')
        await page.waitForTimeout(100)
        expect(await page.evaluate(async () => (await (window as any).__prontoStore.query('flag')).find((row: any) => row.id === 'First').status)).toBe('idle')
        await page.evaluate(() => (window as any).navigate('/deck/a/First').finished)
        await page.waitForFunction(async () => (await (window as any).__prontoStore.query('flag')).find((row: any) => row.id === 'First')?.status === 'done')
      })
    } finally { await server.close() }
  })

  it("keeps the winning screen when a delayed navigation finishes late", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const server = await serve(false, false, undefined, true, false, { cortex: true, gate })
    try {
      await withPage(async page => {
        await page.goto(server.base)
        await ready(page, "A")
        await page.evaluate(() => { (window as any).navigate('/other').finished.catch((error: Error) => { if (error.name !== 'AbortError') throw error }) })
        await page.waitForFunction(() => (window as any).cortex.snapshot().matches({ other: 'loading' }) && document.querySelectorAll('#app > .shell-screen').length === 2)
        await page.evaluate(() => (window as any).navigate('/deck/a/Pikachu').finished)
        expect(await page.evaluate(() => (window as any).cortex.snapshot().value)).toEqual({ card: "ready" })
        release()
        await page.waitForTimeout(100)
        expect(await page.locator('[data-screen="card"]').isVisible()).toBe(true)
        expect(await page.locator('[data-screen="other"]:visible').count()).toBe(0)
        expect(await page.evaluate(() => (window as any).cortex.snapshot().value)).toEqual({ card: "ready" })
      })
    } finally { release(); await server.close() }
  })

  it("reports a failed destination and recovers on a later route", async () => {
    const server = await serve(false, false, undefined, true, false, { cortex: true, cortexRows: true, cortexTimer: true, fail: 503 })
    try {
      await withPage(async page => {
        await page.goto(server.base)
        await ready(page, "A")
        expect(await page.evaluate(async () => {
          try { await (window as any).navigate('/other').finished; return 'unexpected success' }
          catch (error) { return (error as Error).message }
        })).toContain('503')
        expect(await page.evaluate(() => (window as any).cortex.snapshot().value)).toEqual({ home: "ready" })
        expect(await page.locator('[data-screen="home"]').isVisible()).toBe(true)
        await page.locator('#cortex-control').click()
        await page.waitForFunction(() => document.querySelector('#cortex-control')?.getAttribute('data-status') === 'selected')
        await page.waitForFunction(() => document.querySelector('#cortex-control')?.getAttribute('data-status') === 'idle')
        await page.evaluate(() => (window as any).navigate('/deck/a/Pikachu').finished)
        expect(await page.locator('[data-screen="card"]').isVisible()).toBe(true)
        expect(await page.evaluate(() => (window as any).cortex.snapshot().value)).toEqual({ card: "ready" })
      })
    } finally { await server.close() }
  })

})
