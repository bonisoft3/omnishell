import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { renderDocuments } from "../render-documents.ts"
import { templateHash } from "../interpreter/screen.js"

// A document rendered before any request: the screen the shell draws first,
// with the head it would write, and nothing that claims to know rows it has
// not seen. truco is the app because its rules are prerendered and slugged in
// five languages.
const APP = new URL("../../../apps/truco/", import.meta.url)
// What stands for the origin where the documents are served: the door spells
// the deployment's there (pronto's Caddyfile).
const ORIGIN = "{{$o}}"
const rendered = await renderDocuments(APP, ORIGIN)
const doc = (address: string) => {
  const html = rendered.get(address)
  if (html === undefined) throw new Error(`no document at ${address}: ${[...rendered.keys()]}`)
  return parseHTML(html).document
}

// A copy of the app's shell and messages, which a test changes and renders.
const withCopy = async (change: (app: string) => Promise<void>, use: (app: URL) => Promise<void>) => {
  const app = await Deno.makeTempDir()
  try {
    const copy = async (rel: string) => {
      for await (const e of Deno.readDir(new URL(rel, APP))) {
        const path = `${rel}${e.name}`
        if (e.isDirectory) {
          await Deno.mkdir(`${app}/${path}`, { recursive: true })
          await copy(`${path}/`)
        } else await Deno.copyFile(new URL(path, APP), `${app}/${path}`)
      }
    }
    for (const dir of ["shell/", "messages/"]) {
      await Deno.mkdir(`${app}/${dir}`, { recursive: true })
      await copy(dir)
    }
    await change(app)
    await use(new URL(`file://${app}/`))
  } finally {
    await Deno.remove(app, { recursive: true })
  }
}

describe("a prerendered document", () => {
  it("is written at every prerendered address in every locale", () => {
    for (const address of ["/regras", "/ar/reglas", "/uy/reglas", "/py/reglas", "/ca/regles"]) {
      expect(rendered.has(address)).toBe(true)
    }
    // A :param route has no address before a row names one.
    expect([...rendered.keys()].some((a) => a.includes(":"))).toBe(false)
  })

  for (const [address, lang, title] of [["/regras", "pt-BR", "Como se joga — truco"], ["/ca/regles", "ca-ES", "Com es juga — truco"]]) {
    it(`says what it is in its own language at ${address}`, () => {
      const d = doc(address)
      expect(d.documentElement.getAttribute("lang")).toBe(lang)
      expect(d.querySelector("title")?.textContent).toBe(title)
    })

    it(`names itself and its other languages absolutely at ${address}`, () => {
      const d = doc(address)
      const href = (selector: string) => d.querySelector(selector)?.getAttribute("href")
      expect(href('link[rel="canonical"]')).toBe(`${ORIGIN}${address}`)
      expect(href('link[hreflang="ca-ES"]')).toBe(`${ORIGIN}/ca/regles`)
      expect(href('link[hreflang="pt-BR"]')).toBe(`${ORIGIN}/regras`)
      expect(href('link[hreflang="x-default"]')).toBe(`${ORIGIN}/regras`)
      expect(d.querySelectorAll("link[hreflang]").length).toBe(6)
    })

    it(`names the template it was rendered from at ${address}`, async () => {
      const template = await Deno.readTextFile(new URL("shell/screens/regras.html", APP))
      expect(doc(address).querySelector('meta[name="pronto-cas"]')?.getAttribute("content")).toBe(templateHash(template))
    })

    it(`names the catalogues its words are from at ${address}`, async () => {
      // The shell takes a document over in whichever catalogue it holds, and
      // the worker's copy is any deploy old: named, the shell asks the network
      // where its copy is not the document's (nav-smoke.js).
      const witness = async (tag: string) => `${tag}:${templateHash(await Deno.readTextFile(new URL(`messages/${tag}.json`, APP)))}`
      const tags = [...new Set([lang, "pt-BR"])]
      expect(doc(address).querySelector('meta[name="pronto-words"]')?.getAttribute("content"))
        .toBe((await Promise.all(tags.map(witness))).join(" "))
    })

    it(`is the screen before its first read lands at ${address}`, () => {
      const d = doc(address)
      const screens = d.querySelectorAll("#app > .shell-screen > section.screen[data-screen]")
      expect(screens.length).toBe(1)
      expect(screens[0].getAttribute("data-state")).toBe("loading")
      expect(screens[0].getAttribute("data-screen")).toBe("regras")
      // No empty note: the build cannot know a region has no row, and saying
      // so under rows about to arrive is a claim and a layout shift.
      expect(d.querySelectorAll("[data-live] > .empty").length).toBe(0)
      expect(d.querySelector("[data-storybook]")).toBe(null)
    })

    it(`carries its stylesheet once, under the id the shell looks for, at ${address}`, () => {
      const d = doc(address)
      expect(d.querySelectorAll("style").length).toBe(1)
      expect(d.querySelectorAll("style#screen-css-regras").length).toBe(1)
    })

    it(`draws the strip a guest sees, which is empty for this app, at ${address}`, () => {
      // truco puts no route on its strip and offers no sign-in to promote.
      const strip = doc(address).querySelectorAll("body > nav")
      expect(strip.length).toBe(1)
      expect(strip[0].children.length).toBe(0)
    })

    it(`boots only after it has painted, at ${address}`, () => {
      const d = doc(address)
      // Every module the entry would preload is asked for by the loader, after
      // the first contentful paint, and nothing the shell boots from is
      // fetched ahead of it.
      expect(d.querySelectorAll('link[rel="modulepreload"], link[rel="preload"]').length).toBe(0)
      expect(d.querySelectorAll("script[src]").length).toBe(0)
      const scripts = [...d.querySelectorAll("script")].filter((s) => s.getAttribute("type") !== "speculationrules")
      expect(scripts.length).toBe(1)
      expect(scripts[0].textContent).toContain("first-contentful-paint")
      expect(scripts[0].textContent).toContain('"./boot.js"')
      expect(scripts[0].textContent).toContain("/omnishell/interpreter/vendor/mecha-client.js")
    })
  }

  it("is refused where a region would draw nothing until its read lands", async () => {
    // Prerendered, such a region filled once the shell took the document over
    // and pushed down what followed it: pronto refused it only over rows the
    // server holds, and a tab or device entity's rows moved the page as well.
    await withCopy(async (app) => {
      const screen = `${app}/shell/screens/regras.html`
      await Deno.writeTextFile(screen, (await Deno.readTextFile(screen)).replace(/\n\s*data-empty-row='[^']*'/, ""))
    }, async (app) => {
      await expect(renderDocuments(app, ORIGIN)).rejects.toThrow(
        'regras is prerendered, and its data-live="match" region draws nothing until its read lands',
      )
    })
  })

  it("says the page, not the app, on the social card an entry carries", async () => {
    // An entry's og:url left standing beside the page's own named the app's
    // root, or carried two og:url a scraper picks between. pronto's card
    // names a local image from the root, since the origin is the
    // deployment's, which a scraper cannot resolve against.
    const card = [
      '<meta property="og:type" content="article">',
      '<meta property="og:title" content="truco">',
      '<meta property="og:description" content="o jogo">',
      '<meta property="og:url" content="https://truco.example">',
      '<meta property="og:image" content="/card.png">',
      '<meta name="twitter:card" content="summary">',
      '<meta name="twitter:title" content="truco">',
      '<meta name="twitter:image" content="https://cdn.example/card.png">',
    ].join("\n")
    await withCopy(async (app) => {
      const entry = `${app}/shell/index.html`
      await Deno.writeTextFile(entry, (await Deno.readTextFile(entry)).replace('<link rel="icon" href="data:,">', `<link rel="icon" href="data:,">\n${card}`))
    }, async (app) => {
      const d = parseHTML((await renderDocuments(app, ORIGIN)).get("/ca/regles")!).document
      const content = (selector: string) => [...d.querySelectorAll(selector)].map((m) => m.getAttribute("content"))
      expect(content('meta[property="og:url"]')).toEqual([`${ORIGIN}/ca/regles`])
      expect(content('meta[property="og:title"]')).toEqual(["Com es juga — truco"])
      expect(content('meta[name="twitter:title"]')).toEqual(["Com es juga — truco"])
      expect(content('meta[property="og:type"]')).toEqual(["article"])
      expect(content('meta[property="og:description"]')).toEqual(["o jogo"])
      expect(content('meta[property="og:image"]')).toEqual([`${ORIGIN}/card.png`])
      expect(content('meta[name="twitter:image"]')).toEqual(["https://cdn.example/card.png"])
      expect(d.querySelectorAll('link[rel="canonical"]').length).toBe(1)
    })
  })

  it("is the same bytes every time it is rendered", async () => {
    // A compiler commits these and checks them for drift.
    const again = await renderDocuments(APP, ORIGIN)
    for (const [address, html] of rendered) expect(again.get(address)).toBe(html)
  })
})
