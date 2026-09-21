import { describe, expect, it } from "@test/harness"
import { linkLint } from "../interpreter/lint.ts"

// A route table of the two shapes that differ to this rule: one pattern with
// no hole, one with a `:param` a link has to fill.
const ROUTES = [
  { screen: "arena", path: "/" },
  { screen: "regras", path: "/regras" },
  { screen: "article", path: "/article/:slug" },
]

// The silent cases first: a rule that refuses an address which is not a route
// makes a page unable to link out of itself.
describe("linkLint stays silent on what is not an internal path", () => {
  it("an in-page fragment", () => {
    expect(linkLint('<a href="#top">Topo</a>', ROUTES)).toEqual([])
  })

  // shell.js's sign-out anchor: terminal chrome, preventDefault, no route.
  it("a bare hash", () => {
    expect(linkLint('<a href="#">Sair</a>', ROUTES)).toEqual([])
  })

  it("mail, phone and somebody else's site", () => {
    expect(
      linkLint(
        '<a href="mailto:oi@exemplo.test">a</a><a href="tel:+551199">b</a>' +
          '<a href="https://exemplo.test/x">c</a>',
        ROUTES,
      ),
    ).toEqual([])
  })

  // Two slashes are an authority, not a path: the rule reads the second one
  // before it calls a leading slash internal.
  it("a protocol-relative URL, which is another origin", () => {
    expect(linkLint('<a href="//cdn.exemplo.test/x">CDN</a>', ROUTES)).toEqual([])
  })

  it("a route named by its screen, with every hole filled", () => {
    expect(linkLint('<a data-route="article" data-param-slug="{slug}">x</a>', ROUTES)).toEqual([])
  })

  // A navigation rail whose items are rows: which route each link goes to is
  // the row's answer, so there is no name here to hold against the table.
  it("a route a row names", () => {
    expect(linkLint('<a data-route="{route}">x</a>', ROUTES)).toEqual([])
  })

  it("a navigate form, which names a route the same way", () => {
    expect(
      linkLint('<form data-action="navigate" data-route="article" data-param-slug="{q}"></form>', ROUTES),
    ).toEqual([])
  })

  // The href a route-bound link already carries once the binder has run: the
  // rule judges authored markup, and the screens it reads are authored.
  it("a route with no holes and no params", () => {
    expect(linkLint('<a data-route="regras">Regras</a>', ROUTES)).toEqual([])
  })
})

describe("linkLint refuses a path written by hand", () => {
  it("a real path, which has one spelling per locale", () => {
    expect(linkLint('<a href="/regras">Regras</a>', ROUTES)).toEqual([
      '<a href="/regras"> writes an internal path by hand: a route has one address per locale, so name it ' +
      "with data-route and let the binder compose the href",
    ])
  })

  it("the hash spelling, which the server never sees", () => {
    expect(linkLint('<a href="#/regras">Regras</a>', ROUTES).length).toEqual(1)
  })

  // The rule is about the address, not the tag: an `<area>` or a `<link>`
  // carrying an internal path is the same defect.
  it("on a tag that is not an anchor", () => {
    expect(linkLint('<link rel="canonical" href="/regras">', ROUTES).length).toEqual(1)
  })
})

describe("linkLint judges a data-route against the route table", () => {
  it("a screen no route declares", () => {
    expect(linkLint('<a data-route="fantasma">x</a>', ROUTES)).toEqual([
      'data-route="fantasma" names no route in shell.yaml',
    ])
  })

  it("a hole no data-param fills", () => {
    expect(linkLint('<a data-route="article">x</a>', ROUTES)).toEqual([
      'data-route="article" fills no :slug of "/article/:slug"',
    ])
  })

  it("a data-param the route has no hole for", () => {
    expect(linkLint('<a data-route="regras" data-param-slug="{slug}">x</a>', ROUTES)).toEqual([
      'data-param-slug on data-route="regras" names no :param of "/regras"',
    ])
  })
})
