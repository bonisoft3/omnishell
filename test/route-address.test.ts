// How a route becomes an address. Every internal link is composed from the
// route table and the locale the page is in, so markup names a route and its
// :params and never spells a path — which is the only way one app serves
// /regras and /es/reglas from one screen.
import { describe, expect, it } from "@test/harness"
import { parseHTML } from "npm:linkedom@0.18.4"
import { routeHref, routePattern } from "../interpreter/fragment.js"
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
