// The inverse of composing an address: what the router reads back out of one.
// The answer carries the locale, so the first render is correct rather than
// corrected — and it carries `locale` as a ROUTE PARAM only where the address
// itself decided, because that key is what tells a screen not to let a row
// decide instead.
import { describe, expect, it } from "@test/harness"
import { routeAt } from "../interpreter/shell.js"

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

// An app that declares no i18n at all, which is every app in the repo but one.
const PLAIN = { routes: [{ path: "/", screen: "home" }, { path: "/note/:id", screen: "note" }] }

describe("an app that declares no locales", () => {
  it("carries no locale param, so a row still decides the language", () => {
    // Nothing in such an app has decided a language, so nothing may claim to:
    // the key's presence is what says an address did, and a `locale` set to
    // undefined says it in a way no reader can tell from a real answer.
    const { params } = routeAt(PLAIN, "/note/7", "", ["en"])!
    expect(Object.hasOwn(params, "locale")).toBe(false)
    expect(params).toEqual({ id: "7" })
  })

  it("matches its patterns unchanged, with no prefix to strip", () => {
    expect(routeAt(PLAIN, "/", "", [])!.route.screen).toBe("home")
    expect(routeAt(PLAIN, "/nowhere", "", [])).toBe(null)
  })
})

describe("an address in a localized app", () => {
  it("is matched against the default locale's pattern where it wears no prefix", () => {
    // /reglas is Spanish and unprefixed, so it addresses nothing: only the
    // prefix puts another locale's patterns in the table.
    expect(routeAt(CFG, "/regras", "", [])!.route.screen).toBe("regras")
    expect(routeAt(CFG, "/reglas", "", [])).toBe(null)
    // No address said, so no route param claims one did, and the row rung and
    // the header below it stay free to answer.
    expect(Object.hasOwn(routeAt(CFG, "/regras", "", [])!.params, "locale")).toBe(false)
  })

  it("is the prefix's locale, matched against that locale's pattern", () => {
    const got = routeAt(CFG, "/es/articulo/pao", "", ["en"])!
    expect(got.route.screen).toBe("article")
    expect(got.locale).toBe("es")
    expect(got.params).toEqual({ slug: "pao", locale: "es" })
  })

  it("is the bare prefix's home, since stripping it leaves /", () => {
    const got = routeAt(CFG, "/es", "", [])!
    expect(got.route.screen).toBe("arena")
    expect(got.locale).toBe("es")
  })

  it("honours a ?lang= naming a declared locale, and drops the wire name", () => {
    const got = routeAt(CFG, "/", "?lang=en", ["es"])!
    expect(got.locale).toBe("en")
    expect(got.params).toEqual({ locale: "en" })
  })

  it("ignores a ?lang= naming a locale the app does not declare", () => {
    const got = routeAt(CFG, "/", "?lang=de", ["es"])!
    expect(got.locale).toBe("es")
    expect(Object.hasOwn(got.params, "locale")).toBe(false)
  })

  it("leaves every other query param under its own name", () => {
    expect(routeAt(CFG, "/", "?q=truco", [])!.params).toEqual({ q: "truco" })
  })

  it("reads a :param off the path, whatever a query of the same name says", () => {
    // The path is the address; a query rode along beside it. Serving note 9
    // from /note/7 would answer an address nobody asked for.
    const cfg = { i18n: CFG.i18n, routes: [{ path: "/note/:id", screen: "note" }] }
    // The whole object, so a stray second id would show rather than hide.
    expect(routeAt(cfg, "/note/7", "?id=9", [])!.params).toEqual({ id: "7" })
  })
})
