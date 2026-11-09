// How a route becomes an address. Every internal link is composed from the
// route table and the locale the page is in, so markup names a route and its
// :params and never spells a path — which is the only way one app serves
// /regras and /es/reglas from one screen.
import { describe, expect, it } from "@test/harness"
import { parseHTML } from "npm:linkedom@0.18.4"
import { requiredParams, routeAt, routeHref, routePattern } from "../interpreter/fragment.js"
import { drawStrip, localizeStrip, stripRoutes } from "../interpreter/chrome.js"
import { formParams, routeParams } from "../interpreter/screen.js"

const CFG = {
  i18n: {
    default: "pt-BR",
    locales: { "pt-BR": { path: "pt-br" }, es: { path: "es" }, en: { path: "en" } },
  },
  routes: [
    { path: "/", screen: "arena" },
    {
      path: "/regras",
      screen: "regras",
      paths: { "pt-BR": "/regras", es: "/reglas", en: "/rules" },
    },
    {
      path: "/artigo/:slug",
      screen: "article",
      paths: { "pt-BR": "/artigo/:slug", es: "/articulo/:slug", en: "/article/:slug" },
    },
  ],
}

// An app that declares no locales at all, which is most of the corpus.
const PLAIN = { routes: [{ path: "/note/:id", screen: "note" }] }

const el = (html: string) =>
  parseHTML(`<!doctype html><html><body>${html}</body></html>`).document.body.firstElementChild!

describe("a route's pattern", () => {
  it("is the route's own where nothing translates it", () => {
    expect(routePattern(CFG.routes[0], "es")).toBe("/")
  })

  it("is the locale's where the route carries one per language", () => {
    expect(routePattern(CFG.routes[1], "es")).toBe("/reglas")
  })
})

describe("a route's address", () => {
  it("addresses a section before an asset base or a modified click can redirect it", () => {
    expect(routeHref(CFG, "article", { slug: "porto" }, "en", { fragment: "stats & notes" }))
      .toBe("/en/article/porto#stats%20%26%20notes")
    expect(routeHref(CFG, "article", { slug: "porto" }, "pt-BR", { explicitLocale: true, fragment: "stats" }))
      .toBe("/artigo/porto?lang=pt-BR#stats")
    expect(routeHref(PLAIN, "note", { id: "7" }, "pt", { fragment: "stats" })).toBe("/note/7#stats")
    expect(routeHref(CFG, "article", { slug: "" }, "en", { fragment: "stats" })).toBe(undefined)
  })

  it("wears no prefix in the default locale", () => {
    // The Brazilian reader is most of them, and pays no redirect to arrive.
    expect(routeHref(CFG, "regras", {}, "pt-BR")).toBe("/regras")
  })

  it("wears the segment the locale declares, on the pattern that locale states", () => {
    expect(routeHref(CFG, "regras", {}, "es")).toBe("/es/reglas")
    expect(routeHref(CFG, "regras", {}, "en")).toBe("/en/rules")
  })

  it("is the prefix alone for the home route, not a trailing slash", () => {
    expect(routeHref(CFG, "arena", {}, "pt-BR")).toBe("/")
    expect(routeHref(CFG, "arena", {}, "es")).toBe("/es")
  })

  it("fills every :param, encoded", () => {
    expect(routeHref(CFG, "article", { slug: "a b/c" }, "es")).toBe("/es/articulo/a%20b%2Fc")
  })

  it("has no prefix at all where the app declares no locales", () => {
    expect(routeHref(PLAIN, "note", { id: "7" }, "pt")).toBe("/note/7")
  })

  it("refuses a route this app does not have", () => {
    expect(() => routeHref(CFG, "reglas", {}, "es")).toThrow(/no route of this app/)
  })

  it("refuses a :param nothing gives a value", () => {
    // Composing it anyway would produce /es/articulo/undefined and ask the
    // store for it.
    expect(() => routeHref(CFG, "article", {}, "es")).toThrow(/takes a slug/)
  })

  it("has no address when a param is written and the row empties it", () => {
    // The distinction the attribute draws: absent is the author's mistake and
    // throws above; present-and-empty is the row saying there is nowhere to go,
    // and the caller drops the href rather than composing /es/articulo/.
    expect(routeHref(CFG, "article", { slug: "" }, "es")).toBe(undefined)
  })

  it("refuses a locale a translated route has no pattern in", () => {
    expect(() => routeHref(CFG, "regras", {}, "de")).toThrow(/no pattern in de/)
  })

  it("refuses a locale the app does not declare", () => {
    expect(() => routeHref(CFG, "arena", {}, "de")).toThrow(/not one this app declares/)
  })
})

describe("the values a link carries", () => {
  it("are its data-param-* attributes, under the names the pattern uses", () => {
    // Read off the attributes rather than the dataset, where `note_id` would
    // arrive camel-cased and match no :param.
    const a = el(`<a data-route="note" data-param-note_id="7" data-locale="es" class="x">n</a>`)
    expect(routeParams(a)).toEqual({ note_id: "7" })
  })

  it("are empty on a link to a route that takes none", () => {
    expect(routeParams(el(`<a data-route="regras">R</a>`))).toEqual({})
  })
})

describe("a navigate form", () => {
  it("fills its route's :params from its own inputs", () => {
    // The whole effect of such a form is the move, so what it submits is an
    // address rather than a row.
    const form = el(
      `<form data-action="navigate" data-route="search"><input name="q" value="pão de ló"></form>`,
    )
    const cfg = { routes: [{ path: "/search/:q", screen: "search" }] }
    expect(formParams(form)).toEqual({ q: "pão de ló" })
    expect(routeHref(cfg, "search", formParams(form), "pt-BR")).toBe("/search/p%C3%A3o%20de%20l%C3%B3")
  })
})

// One route, several addresses: the library at `/` and its shelves at `/mine`
// and `/gallery`, each a strip link current by its own address — so the strip
// never has to be told which shelf a gesture meant (the double mark that cost
// snapcards its single selection).
const SHELVES = {
  routes: [
    {
      path: "/:shelf?",
      screen: "cards",
      nav: { label: "Cards", key: "nav_cards", entries: [{ label: "My Cards", key: "nav_my_cards", params: { shelf: "mine" } }, { label: "Gallery", key: "nav_gallery", params: { shelf: "gallery" } }] },
    },
    { path: "/about", screen: "about", nav: { label: "About", key: "nav_about" } },
    { path: "/note/:id", screen: "note", nav: { label: "Note" } },
  ],
}
describe("an optional :param?", () => {
  it("is required by no one, so its route keeps a static address and a place on the strip", () => {
    expect(requiredParams("/:shelf?")).toEqual([])
    expect(requiredParams("/note/:id")).toEqual(["id"])
    expect(stripRoutes(SHELVES).map((r: { screen: string }) => r.screen)).toEqual(["cards", "about"])
  })
  it("binds blank at the bare address and its segment where one is given", () => {
    expect(routeAt(SHELVES, "/", "")).toMatchObject({ route: SHELVES.routes[0], params: { shelf: "" } })
    expect(routeAt(SHELVES, "/mine", "")).toMatchObject({ params: { shelf: "mine" } })
    expect(routeAt(SHELVES, "/mine/extra", "")).toBeNull()
    expect(routeAt(SHELVES, "/anything", "")).toBeNull()
    expect(routeAt(SHELVES, "/about", "")).toMatchObject({ route: SHELVES.routes[1] })
  })
  it("is left out of an address when it is empty or unnamed", () => {
    expect(routeHref(SHELVES, "cards", {}, undefined)).toBe("/")
    expect(routeHref(SHELVES, "cards", { shelf: "" }, undefined)).toBe("/")
    expect(routeHref(SHELVES, "cards", { shelf: "mine" }, undefined)).toBe("/mine")
    expect(routeHref({ routes: [{ path: "/x/:y?", screen: "x" }] }, "x", {}, undefined)).toBe("/x")
  })
})
describe("a route's strip entries", () => {
  const { document } = parseHTML("<!doctype html><html><body></body></html>")
  it("are drawn as links of their own, and exactly one of them is current at each address", () => {
    const nav = drawStrip(document, SHELVES)
    const links = [...nav.querySelectorAll("a")]
    expect(links.map((a) => a.textContent)).toEqual(["Cards", "My Cards", "Gallery", "About"])
    expect(links[1].getAttribute("data-param-shelf")).toBe("mine")
    const messages = { en: { nav_cards: "Home", nav_my_cards: "Mine", nav_gallery: "All", nav_about: "About" } }
    for (const [here, current] of [["/", "Home"], ["/mine", "Mine"], ["/gallery", "All"], ["/about", "About"]]) {
      const options = { locale: "en", here, search: "", messages, explicitLocale: false }
      localizeStrip(nav, SHELVES, options)
      expect(links.map((a) => a.getAttribute("href"))).toEqual(["/", "/mine", "/gallery", "/about"])
      expect(links.filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent)).toEqual([current])
    }
  })
})
