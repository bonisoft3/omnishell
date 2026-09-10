// Playwright (run: `bun x playwright test renderer-hostile`): the renderer's
// safety claims, checked in a real browser rather than a DOM shim. A shim can
// say no <script> element was created; only a browser can say nothing
// executed, nothing navigated, and nothing left the page. Those are the claims
// asserted here, behaviourally, against input a reader authored.
//
// The page loads interpreter/render.js and interpreter/markdown.js as real ES
// modules over http, and every request it makes is intercepted — so a beacon
// is evidence rather than merely absent, and an exfiltration attempt cannot
// actually leave the machine.
import { test, expect, type Page } from "@playwright/test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const interpreter = path.join(__dirname, "../interpreter")

const ORIGIN = "http://renderer.test"

// Instrumentation is a classic script and the modules are deferred, so a
// payload that fires during import still lands in __fired.
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>renderer harness</title></head>
<body><div id="out"></div>
<script>
  window.__fired = []
  window.__pwned = (why) => window.__fired.push("pwned:" + why)
  window.onerror = (msg) => { window.__fired.push("onerror:" + msg) }
  window.addEventListener("unhandledrejection", (e) => window.__fired.push("rejection:" + e.reason))
  for (const name of ["alert", "confirm", "prompt", "print", "open"]) {
    window[name] = (...args) => { window.__fired.push(name + ":" + args.join(",")); return null }
  }
</script>
<script type="module">
  import * as render from "./render.js"
  import * as markdown from "./markdown.js"
  window.__mod = { ...render, ...markdown }
  window.__ready = true
</script>
</body></html>`

interface Harness {
  requests: string[]
  navigations: string[]
  dialogs: string[]
  popups: number
}

async function open(page: Page): Promise<Harness> {
  const h: Harness = { requests: [], navigations: [], dialogs: [], popups: 0 }
  // Routed on the context, not the page, so a context a payload opens is
  // intercepted too rather than reaching the real network.
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === ORIGIN && url.pathname === "/") {
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: PAGE })
    }
    if (url.origin === ORIGIN && /^\/(render|markdown)\.js$/.test(url.pathname)) {
      const body = await readFile(path.join(interpreter, url.pathname.slice(1)), "utf8")
      return route.fulfill({ contentType: "text/javascript; charset=utf-8", body })
    }
    h.requests.push(route.request().url())
    // 204 rather than abort for a navigation: an aborted top-level load
    // replaces the harness with an error page, and the next payload would then
    // be measuring the error page. 204 records the attempt and leaves the
    // document standing.
    return route.request().isNavigationRequest()
      ? route.fulfill({ status: 204, body: "" })
      : route.abort()
  })
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) h.navigations.push(f.url())
  })
  page.on("popup", () => h.popups++)
  page.on("dialog", (d) => {
    h.dialogs.push(`${d.type()}:${d.message()}`)
    d.dismiss()
  })
  await page.goto(`${ORIGIN}/`)
  await page.waitForFunction(() => (window as Any).__ready === true)
  h.navigations.length = 0
  return h
}

// The page's globals are the harness's own; typing them precisely would be
// describing the test to itself.
type Any = any

const fired = (page: Page) => page.evaluate(() => (window as Any).__fired as string[])

const offOrigin = (h: Harness) => h.requests.filter((u) => !u.startsWith(`${ORIGIN}/`))

interface Built {
  threw: string | null
  text: string
  tags: string[]
  attrs: string[]
}

// A fresh target per case, so buildNodes' description cache never
// short-circuits one payload with a previous one's result.
const md = (page: Page, source: string): Promise<Built> =>
  page.evaluate((src) => {
    const el = document.createElement("div")
    document.getElementById("out")!.replaceChildren(el)
    const w = window as Any
    try {
      w.__mod.buildNodes(w.__mod.parseMarkdown(src), el)
    } catch (e) {
      return { threw: String((e as Error).message), text: "", tags: [], attrs: [] }
    }
    const els = [...el.querySelectorAll("*")]
    return {
      threw: null,
      text: el.textContent ?? "",
      tags: els.map((n) => n.localName),
      attrs: els.flatMap((n) => n.getAttributeNames().map((a) => `${n.localName}@${a}=${n.getAttribute(a)}`)),
    }
  }, source)

// The description is evaluated in the page because the cases that matter
// include values JSON cannot carry — an attrs entry whose value is undefined
// is idiomatic JS and is exactly what the builder's rel guard reads.
const nodes = (page: Page, source: string): Promise<Built> =>
  page.evaluate((src) => {
    const el = document.createElement("div")
    document.getElementById("out")!.replaceChildren(el)
    const w = window as Any
    try {
      w.__mod.buildNodes(new Function(`return (${src})`)(), el)
    } catch (e) {
      return { threw: String((e as Error).message), text: "", tags: [], attrs: [] }
    }
    const els = [...el.querySelectorAll("*")]
    return {
      threw: null,
      text: el.textContent ?? "",
      tags: els.map((n) => n.localName),
      attrs: els.flatMap((n) => n.getAttributeNames().map((a) => `${n.localName}@${a}=${n.getAttribute(a)}`)),
    }
  }, source)

// Elements that would be a compromise if any of them ever appeared. Scoped to
// #out because the harness's own instrumentation is a <script>.
const FORBIDDEN = "script,style,iframe,object,embed,form,input,button,link,meta,base,svg,math,template,noscript,frame,frameset,applet"

const forbidden = (page: Page) =>
  page.evaluate((sel) => [...document.getElementById("out")!.querySelectorAll(sel)].map((n) => n.localName), FORBIDDEN)

// The terminal's own binding vocabulary. A renderer that could emit one could
// forge a region, a mutation or a hatch mount out of a reader's prose.
const BINDINGS = ["data-live", "data-entity", "data-action", "data-hatch", "data-widget", "data-handler", "data-text", "data-text-format", "data-screen", "data-part", "data-item", "data-order", "data-adapter", "data-value", "data-state", "data-form"]

const smuggled = (page: Page) =>
  page.evaluate(
    () => [...document.getElementById("out")!.querySelectorAll("*")]
      .flatMap((n) => n.getAttributeNames().filter((a) => a.startsWith("data-")).map((a) => `${n.localName}@${a}`)),
  )

// Markup a reader could type that a browser would execute if any of it were
// ever parsed as markup rather than kept as text.
const EXECUTABLE = [
  `<script>window.__pwned('raw-script')</script>`,
  `<script src="https://evil.test/x.js"></script>`,
  `<img src=x onerror="window.__pwned('img-onerror')">`,
  `<img src="/i.png" onload="window.__pwned('img-onload')">`,
  `<svg onload="window.__pwned('svg-onload')"></svg>`,
  `<svg><script>window.__pwned('svg-script')</script></svg>`,
  `<svg><a xlink:href="javascript:window.__pwned('xlink')"><text>x</text></a></svg>`,
  `<iframe srcdoc="<script>parent.__pwned('srcdoc')</script>"></iframe>`,
  `<iframe src="https://evil.test/frame"></iframe>`,
  `<body onload="window.__pwned('body-onload')">`,
  `<details open ontoggle="window.__pwned('ontoggle')"><summary>s</summary></details>`,
  `<a href="javascript:window.__pwned('inline-a')">x</a>`,
  `<style>@import url(https://evil.test/import.css)</style>`,
  `<style>body{background:url(https://evil.test/bg.png)}</style>`,
  `<link rel=stylesheet href="https://evil.test/link.css">`,
  `<base href="https://evil.test/">`,
  `<meta http-equiv=refresh content="0;url=https://evil.test/">`,
  `<template><script>window.__pwned('template')</script></template>`,
  `<!--[if IE]><script>window.__pwned('cc')</script><![endif]-->`,
  `<math><mtext><script>window.__pwned('math')</script></mtext></math>`,
  `<object data="https://evil.test/o"></object>`,
  `<embed src="https://evil.test/e">`,
  `<form action="https://evil.test/f"><input name=x><button>go</button></form>`,
  `<noscript><img src="https://evil.test/ns.png"></noscript>`,
  `<plaintext><script>window.__pwned('plaintext')</script>`,
  `<xmp><script>window.__pwned('xmp')</script></xmp>`,
  `<video><source onerror="window.__pwned('source')"></video>`,
  `<input autofocus onfocus="window.__pwned('autofocus')">`,
  // Entity- and encoding-shaped variants, which only matter if anything on the
  // path ever hands a string to a markup parser.
  `&lt;script&gt;window.__pwned('entity')&lt;/script&gt;`,
  `&#60;script&#62;window.__pwned('numeric')&#60;/script&#62;`,
  `<script>window.__pwned('unicode-escape')</script>`,
]

// Every block and inline construct the parser has, as a route a payload could
// ride. The image and link targets are same-origin so an off-origin request
// stays a signal.
const WRAPPERS: Array<(p: string) => string> = [
  (p) => p,
  (p) => `# ${p}`,
  (p) => `###### ${p}`,
  (p) => `- ${p}`,
  (p) => `1. ${p}`,
  (p) => `> ${p}`,
  (p) => `> > ${p}`,
  (p) => "```\n" + p + "\n```",
  (p) => "```" + p + "\n body \n```",
  (p) => "`" + p + "`",
  (p) => `**${p}**`,
  (p) => `_${p}_`,
  (p) => `[${p}](/ok)`,
  (p) => `![${p}](/i.png)`,
  (p) => `[link](/ok) ${p} **after**`,
]

test.describe("nothing a reader typed becomes markup", () => {
  test("no payload in any construct produces an element or executes", async ({ page }) => {
    const h = await open(page)
    for (const payload of EXECUTABLE) {
      for (const wrap of WRAPPERS) {
        const source = wrap(payload)
        const built = await md(page, source)
        expect(built.threw, `parser threw on ${JSON.stringify(source)}`).toBeNull()
        expect(await forbidden(page), `element built from ${JSON.stringify(source)}`).toEqual([])
        expect(await smuggled(page), `attribute smuggled from ${JSON.stringify(source)}`).toEqual([])
      }
    }
    // The behavioural half a DOM shim cannot reach.
    expect(await fired(page), "something executed").toEqual([])
    expect(h.dialogs, "a dialog opened").toEqual([])
    expect(h.popups, "a popup opened").toBe(0)
    expect(h.navigations, "the document navigated").toEqual([])
    expect(offOrigin(h), "a request left the origin").toEqual([])
  })

  test("the characters survive as text a reader can read", async ({ page }) => {
    await open(page)
    // Refusing to execute is only half of it; the author's prose must still be
    // legible, or the safe behaviour is silent data loss.
    const built = await md(page, `<script>alert(1)</script> & <b>bold</b> "quoted" 'single' \\ backslash`)
    expect(built.text).toBe(`<script>alert(1)</script> & <b>bold</b> "quoted" 'single' \\ backslash`)
    expect(built.tags).toEqual(["p"])
  })
})

// Schemes a browser would execute, spelled the ways an attacker spells them.
// markdown-smoke.js already covers javascript:, JavaScript:, java\0script:,
// java\tscript:, data: and vbscript:; everything here is deliberately outside
// that set.
const HOSTILE_URLS = [
  // Entity and percent spellings. These only bite if anything on the path
  // hands the string to a markup or URL decoder before the scheme test.
  "&#106;avascript:window.__pwned('dec-entity')",
  "jav&#x61;script:window.__pwned('hex-entity')",
  "&#x6a;avascript&#x3a;window.__pwned('entity-colon')",
  "javascript&colon;window.__pwned('named-colon')",
  "%6Aavascript:window.__pwned('percent')",
  "%25%36%41avascript:window.__pwned('double-percent')",
  // Characters inside STRIPPED (\u0000-\u0020, \u007f), which the scheme test
  // removes because the browser removes them before it navigates.
  "java\u000bscript:window.__pwned('vtab')",
  "java\u000cscript:window.__pwned('formfeed')",
  "java\u001fscript:window.__pwned('unit-sep')",
  "java\u007fscript:window.__pwned('del')",
  "\u0001javascript:window.__pwned('leading-ctl')",
  "javascript\u0009:window.__pwned('tab-before-colon')",
  // Characters outside STRIPPED, which survive into the scheme test. The
  // question each asks is whether the browser also keeps them: one the browser
  // drops but the test keeps is a bypass.
  "java\u00a0script:window.__pwned('nbsp')",
  "java\ufeffscript:window.__pwned('bom')",
  "java\u200bscript:window.__pwned('zwsp')",
  "\ufeffjavascript:window.__pwned('leading-bom')",
  "\u2028javascript:window.__pwned('line-sep')",
  "JaVaScRiPt:window.__pwned('mixed-case')",
  // Shapes that are not a scheme at all, and must stay harmless relative URLs.
  "/javascript:window.__pwned('rooted')",
  "./javascript:window.__pwned('dotted')",
  "x:javascript:window.__pwned('nested-scheme')",
  // Schemes outside the allowlist that a browser still knows how to act on.
  "blob:https://renderer.test/window.__pwned",
  "filesystem:https://renderer.test/temporary/x",
  "view-source:https://evil.test/",
  "jar:https://evil.test/!/x",
  "intent://evil.test/#Intent;scheme=https;end",
  "data:text/html;base64,PHNjcmlwdD53aW5kb3cuX19wd25lZCgnYjY0Jyk8L3NjcmlwdD4=",
  "data:image/svg+xml,<svg onload=\"window.__pwned('svg-data')\"/>",
]

test.describe("no URL a browser would execute reaches an attribute", () => {
  test("hostile schemes are refused through markdown, and clicking proves it", async ({ page }) => {
    const h = await open(page)
    const survived: string[] = []
    for (const url of HOSTILE_URLS) {
      for (const source of [`[click](${url})`, `![alt](${url})`]) {
        const built = await md(page, source)
        expect(built.threw, `parser threw on ${JSON.stringify(source)}`).toBeNull()
        for (const attr of built.attrs) {
          // An href or src that came out carrying a scheme the browser
          // executes is the finding this test exists for.
          if (/@(href|src)=/.test(attr) && /^[^=]*=\s*(javascript|data|vbscript|blob|filesystem|view-source|jar|intent):/i.test(attr.split("=").slice(1).join("="))) {
            survived.push(`${source} -> ${attr}`)
          }
        }
      }
      // Whatever did render, click it. A refused href leaves an <a> with no
      // href, which must be inert rather than merely attribute-free.
      const anchors = page.locator("#out a")
      for (let i = 0; i < (await anchors.count()); i++) {
        await anchors.nth(i).click({ force: true, noWaitAfter: true })
      }
    }
    await page.waitForTimeout(100)

    expect(survived, "a dangerous scheme reached an attribute").toEqual([])
    expect(await fired(page), "clicking a hostile link executed something").toEqual([])
    expect(h.dialogs, "a dialog opened").toEqual([])
    expect(h.popups, "a popup opened").toBe(0)
    expect(page.url(), "the document navigated away").toBe(`${ORIGIN}/`)
    expect(offOrigin(h), "clicking a hostile link left the origin").toEqual([])
  })

  test("the builder refuses them too, for a renderer that never consulted safeUrl", async ({ page }) => {
    const h = await open(page)
    // markdown checks safeUrl before it emits, so the cases above may never
    // reach the builder. An app-declared renderer has no such habit, and the
    // builder is where the guarantee is supposed to live.
    //
    // The oracle is the browser's own resolution of the attribute, read back
    // off the built element — not a second opinion about what the string looks
    // like. A string that merely resembles a scheme is not a finding; a string
    // the browser will act on as one is.
    const survived: string[] = []
    for (const url of HOSTILE_URLS) {
      const seen = await page.evaluate((raw) => {
        const el = document.createElement("div")
        document.getElementById("out")!.replaceChildren(el)
        const w = window as Any
        w.__mod.buildNodes(
          [{ tag: "a", attrs: { href: raw }, children: ["x"] }, { tag: "img", attrs: { src: raw, alt: "a" } }],
          el,
        )
        const a = el.querySelector("a")!
        const img = el.querySelector("img")!
        return {
          anchor: a.hasAttribute("href") ? a.protocol : null,
          image: img.hasAttribute("src") ? new URL(img.getAttribute("src")!, document.baseURI).protocol : null,
        }
      }, url)
      for (const [where, protocol] of Object.entries(seen)) {
        if (protocol !== null && !["http:", "https:", "mailto:"].includes(protocol)) {
          survived.push(`${JSON.stringify(url)} -> ${where} resolves as ${protocol}`)
        }
      }
      // And whatever survived, click it: a protocol table is a claim about
      // what the browser would do, and this is the browser doing it.
      const anchors = page.locator("#out a")
      for (let i = 0; i < (await anchors.count()); i++) {
        await anchors.nth(i).click({ force: true, noWaitAfter: true })
      }
    }
    await page.waitForTimeout(100)
    expect(survived, "the builder let a dangerous scheme through").toEqual([])
    expect(await fired(page), "clicking a built link executed something").toEqual([])
    expect(h.dialogs).toEqual([])
    expect(page.url(), "the document navigated away").toBe(`${ORIGIN}/`)
  })
})

test.describe("the terminal's binding vocabulary cannot be forged out of prose", () => {
  test("no markdown route smuggles a data-* attribute", async ({ page }) => {
    await open(page)
    // Every place a reader's characters end up adjacent to attribute
    // construction: the link label, the image alt, the URL, the fence info
    // string, and raw markup that looks like a bound element.
    const sources = [
      `![data-live](/i.png)`,
      `![a" data-live="note](/i.png)`,
      `![a' data-entity='note](/i.png)`,
      `![a" data-hatch="x" alt="](/i.png)`,
      `[a" data-entity="note](/ok)`,
      `[a' data-action='delete](/ok)`,
      `[x](/ok" data-action="delete)`,
      `[x](/ok'data-widget='combobox)`,
      `[x](/ok " data-live="note)`,
      "```\" data-hatch=\"x\nbody\n```",
      "```js data-live=note\nbody\n```",
      "`code\" data-text=\"{secret}`",
      `# heading" data-widget="combobox`,
      `- item" data-handler="x`,
      `> quote" data-screen="admin`,
      `<p data-live="note">forged</p>`,
      `<div data-hatch="evil"></div>`,
      `<span data-text="{password}"></span>`,
      `<article data-live="user" data-order="id.asc"><template data-item><b data-text="{token}"></b></template></article>`,
      `**bold" data-form="wire**`,
      `[![nested" data-live="x](/i.png)](/ok)`,
    ]
    for (const source of sources) {
      const built = await md(page, source)
      expect(built.threw, `parser threw on ${JSON.stringify(source)}`).toBeNull()
      expect(await smuggled(page), `smuggled from ${JSON.stringify(source)}`).toEqual([])
    }
    // And nothing anywhere in the document answers to a binding selector.
    const bound = await page.evaluate(
      (sel) => document.getElementById("out")!.querySelectorAll(sel).length,
      BINDINGS.map((b) => `[${b}]`).join(","),
    )
    expect(bound, "a binding selector matched something built from prose").toBe(0)
  })

  test("the builder refuses a data-* attribute however it is spelled", async ({ page }) => {
    await open(page)
    // setAttribute lowercases attribute names on HTML elements, so a spelling
    // that slipped past the prefix test would still land as a live binding.
    for (const name of ["data-live", "DATA-LIVE", "Data-Live", "data-Entity", "dAtA-hatch", "data-", "data-x"]) {
      const built = await nodes(page, `[{tag: "p", attrs: {${JSON.stringify(name)}: "note"}}]`)
      expect(built.threw, `<p ${name}> was built`).not.toBeNull()
    }
    // A name the allowlist has no opinion about must still be refused, since
    // the allowlist is what stands between prose and the document.
    for (const name of ["onclick", "ONCLICK", "onClick", "style", "srcset", "formaction", "xlink:href", "xmlns", "is", "slot", "id", "name", "constructor"]) {
      const built = await nodes(page, `[{tag: "p", attrs: {${JSON.stringify(name)}: "x"}}]`)
      expect(built.threw, `<p ${name}> was built`).not.toBeNull()
    }
    // __proto__ has to come through JSON.parse: written as an object literal
    // key it sets the prototype instead of becoming an own property, so the
    // literal form tests nothing about the builder.
    const polluted = await nodes(page, `[{tag: "p", attrs: JSON.parse('{"__proto__": "x"}')}]`)
    expect(polluted.threw, "<p __proto__> was built").not.toBeNull()
    // Tags reached through the prototype chain rather than the allowlist.
    for (const tag of ["script", "constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      const built = await nodes(page, `[{tag: ${JSON.stringify(tag)}}]`)
      expect(built.threw, `<${tag}> was built`).not.toBeNull()
    }
    expect(await fired(page)).toEqual([])
  })
})

test.describe("nothing leaves the page that the prose did not name", () => {
  test("only the URLs a reader actually wrote are fetched", async ({ page }) => {
    const h = await open(page)
    // Raw markup naming an external origin must fetch nothing, because it is
    // never markup.
    for (const source of [
      `<img src="https://evil.test/raw-img.gif">`,
      `<script src="https://evil.test/raw.js"></script>`,
      `<link rel=stylesheet href="https://evil.test/raw.css">`,
      `<style>@import url(https://evil.test/raw-import.css)</style>`,
      `<iframe src="https://evil.test/raw-frame"></iframe>`,
      `<video poster="https://evil.test/raw-poster.jpg"></video>`,
      `[unclicked](https://evil.test/link)`,
    ]) {
      await md(page, source)
    }
    await page.waitForTimeout(200)
    expect(offOrigin(h), "raw markup or an unclicked link reached the network").toEqual([])

    // An image the author wrote is a request the author asked for. Recording
    // what it actually contacts is the point: the allowlist admits http and
    // https, so this is capability, not a leak.
    h.requests.length = 0
    await md(page, `![beacon](https://evil.test/authored.gif)`)
    await page.waitForTimeout(200)
    expect(offOrigin(h)).toEqual(["https://evil.test/authored.gif"])

    // A protocol-relative URL keeps the scheme and changes the host, so it
    // reaches a third party — deliberately, and identically to the authored
    // https:// case above. Refusing this one spelling would deny nothing an
    // author cannot write another way, so it is admitted and asserted rather
    // than blocked. Third-party fetches from reader-authored prose remain a
    // real tracking surface; the mechanism for that is an origin policy over
    // every URL the builder emits, not a rule about one URL syntax, and this
    // assertion is what will fail first when such a policy lands.
    h.requests.length = 0
    await md(page, `![proto-relative](//evil.test/schemeless.gif)`)
    await page.waitForTimeout(200)
    // http, not https: the scheme is inherited from the page, so this spelling
    // is the one that follows an insecure page down rather than pinning TLS.
    expect(offOrigin(h), "protocol-relative is admitted like any http(s) URL").toEqual([
      "http://evil.test/schemeless.gif",
    ])
  })
})

test.describe("the builder's own attribute surface", () => {
  test("every allowlisted URL attribute is scheme-checked", async ({ page }) => {
    await open(page)
    // href and src go through safeUrl. cite is allowlisted on <blockquote> and
    // is a URL attribute in HTML, so if it is not scheme-checked the builder
    // has an allowlisted attribute carrying an unchecked URL.
    const built = await nodes(page, `[{tag: "blockquote", attrs: {cite: "javascript:window.__pwned('cite')"}, children: ["q"]}]`)
    expect(built.threw).toBeNull()
    // No browser dereferences cite today, so this is latent rather than live —
    // which is why the click below stays quiet. It is still an allowlisted URL
    // attribute that URL_ATTRS does not cover, so the guarantee "the builder
    // applies the scheme check regardless" is not true of every URL it emits.
    await page.locator("#out blockquote").click({ force: true, noWaitAfter: true })
    await page.waitForTimeout(50)
    expect(await fired(page), "cite was dereferenced").toEqual([])
    const cite = built.attrs.filter((a) => a.startsWith("blockquote@cite="))
    expect(cite, "an allowlisted URL attribute carried an unchecked scheme").toEqual([])
  })

  test("a link opening a new context cannot leak its opener", async ({ page }) => {
    // The builder stamps rel whenever target is set, reading attrs.target
    // !== undefined. setAttribute stringifies, so an attrs entry whose value
    // is undefined — idiomatic for a conditional attribute — becomes a real
    // browsing-context name that the guard does not see.
    const h = await open(page)
    const built = await nodes(page, `[{tag: "a", attrs: {href: ${JSON.stringify(`${ORIGIN}/`)}, target: undefined}, children: ["x"]}]`)
    expect(built.threw).toBeNull()

    // "undefined" is a browsing-context name like any other, so this is not a
    // naming curiosity: the click opens a context, and without rel that
    // context gets a live window.opener pointing back at the terminal — which
    // is reverse tabnabbing, whatever the name happens to be.
    const [popup] = await Promise.all([
      page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null),
      page.locator("#out a").click({ force: true, noWaitAfter: true }),
    ])
    let reach = "no context opened"
    if (popup !== null) {
      await popup.waitForLoadState().catch(() => {})
      reach = await popup.evaluate(() => {
        if (window.opener === null) return "opener severed"
        try {
          window.opener.location = "/hijacked"
          return "the opened context navigated the terminal"
        } catch (e) {
          return `opener live but blocked: ${(e as Error).message}`
        }
      })
      await popup.close()
    }

    const target = built.attrs.find((a) => a.startsWith("a@target="))
    const rel = built.attrs.find((a) => a.startsWith("a@rel="))
    expect(
      target === undefined || rel === "a@rel=noopener noreferrer",
      `target was set as ${target} without rel (${rel}); ${h.popups} context(s) opened; ${reach}`,
    ).toBe(true)
  })

  test("a description the schema does not describe is refused", async ({ page }) => {
    await open(page)
    // children is documented as an array of nodes. A string is iterable, so it
    // is accepted and spread into one text node per code unit — a shape the
    // schema does not describe silently becoming a different document.
    const built = await nodes(page, `[{tag: "p", children: "abc"}]`)
    expect(built.threw, `children: "abc" was accepted as ${JSON.stringify(built.text)}`).not.toBeNull()
  })
})

test.describe("a reader's own content cannot take the screen down", () => {
  // render.js: "a reader's own content must never be able to take the screen
  // down". These are the inputs that test that sentence rather than the
  // scheme check it was written about.

  test("prose does not blow the stack", async ({ page }) => {
    await open(page)
    const outcome = await page.evaluate(() => {
      const w = window as Any
      const probe = (source: string) => {
        const el = document.createElement("div")
        document.getElementById("out")!.replaceChildren(el)
        try {
          w.__mod.buildNodes(w.__mod.parseMarkdown(source), el)
          return null
        } catch (e) {
          return `${(e as Error).constructor.name}: ${(e as Error).message}`.slice(0, 80)
        }
      }
      const out: Record<string, string | null> = {}
      // One byte of input per level of recursion, so the threshold is also the
      // size of the smallest document that reaches it.
      for (const n of [100, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000]) {
        out[`quote-${n}`] = probe(">".repeat(n) + " x")
      }
      for (const n of [100, 1000, 5000]) {
        out[`strong-${n}`] = probe("**".repeat(n) + "x" + "**".repeat(n))
      }
      // A quoted list inside a quoted list is what a reader actually writes;
      // the same recursion serves it, so the depth budget is shared.
      out["nested-quote-prose"] = probe("> ".repeat(2000) + "hello")
      return out
    })
    const broke = Object.entries(outcome).filter(([, v]) => v !== null)
    expect(broke, `nesting threw instead of rendering: ${JSON.stringify(outcome, null, 2)}`).toEqual([])
  })

  test("prose does not freeze the main thread", async ({ page }) => {
    test.setTimeout(120_000)
    await open(page)
    // The parser is synchronous and runs on the main thread, so a slow parse
    // is not a slow region — it is a frozen terminal.
    const timings = await page.evaluate(() => {
      const w = window as Any
      const out: Record<string, number> = {}
      for (const kb of [16, 32, 64, 128]) {
        const source = "[a](".repeat((kb * 1024) / 4)
        const t0 = performance.now()
        w.__mod.parseMarkdown(source)
        out[`${kb}kb`] = Math.round(performance.now() - t0)
      }
      return out
    })
    // A body column a reader could paste must not cost more than a frame
    // budget's worth of orders of magnitude. One second is already generous.
    const slow = Object.entries(timings).filter(([, ms]) => ms > 1000)
    expect(slow, `parsing blocked the main thread: ${JSON.stringify(timings)} ms`).toEqual([])
  })

  test("a long document renders rather than throwing", async ({ page }) => {
    test.setTimeout(120_000)
    await open(page)
    const outcome = await page.evaluate(() => {
      const w = window as Any
      const out: Record<string, string | null> = {}
      for (const n of [1000, 20000, 100000]) {
        const el = document.createElement("div")
        document.getElementById("out")!.replaceChildren(el)
        try {
          w.__mod.buildNodes(w.__mod.parseMarkdown("a\n\n".repeat(n)), el)
          out[`paragraphs-${n}`] = null
        } catch (e) {
          out[`paragraphs-${n}`] = `${(e as Error).constructor.name}: ${(e as Error).message}`.slice(0, 80)
        }
      }
      return out
    })
    const broke = Object.entries(outcome).filter(([, v]) => v !== null)
    expect(broke, `a long document threw: ${JSON.stringify(outcome, null, 2)}`).toEqual([])
  })
})
