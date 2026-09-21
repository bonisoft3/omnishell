// Which option of a language switcher is the page the reader is already on.
//
// The marking is composed on every bind, beside the href, because both answer
// the same question — which address this element names. An app that instead
// wrote it once at mount would be right until the first navigation, and would
// be writing it from script, which no fast tier can see.
import { describe, expect, it } from "@test/harness"
import { type El, mountScreen } from "./screen-harness.ts"

const I18N = {
  default: "pt-BR",
  locales: { "pt-BR": { path: "pt-br" }, "es-AR": { path: "ar" }, "es-UY": { path: "uy" } },
}
const ROUTES = [{ path: "/", screen: "arena", files: { html: "arena.html", css: "arena.css", handlers: [] } }]

const SWITCHER = `<section class="screen" data-screen="arena">
    <a id="br" data-route="arena" data-locale="pt-BR" data-locale-current="page">Brasil</a>
    <a id="ar" data-route="arena" data-locale="es-AR" data-locale-current="page">Argentina</a>
    <a id="uy" data-route="arena" data-locale="es-UY" data-locale-current="page">Uruguay</a>
    <a id="plain" data-route="arena">Mesa</a>
  </section>`

const at = (locale: string) =>
  mountScreen({
    route: ROUTES[0],
    files: { "arena.html": SWITCHER, "arena.css": "" },
    tables: {},
    seed: 1,
    routes: ROUTES,
    i18n: I18N,
    locale,
  })

const current = (m: Awaited<ReturnType<typeof at>>, id: string) =>
  (m.one(`#${id}`) as El).getAttribute("aria-current")

describe("a language switcher's current option", () => {
  it("is the one naming the locale the screen is in", async () => {
    const m = await at("es-AR")
    expect(current(m, "ar")).toBe("page")
    expect(current(m, "br")).toBe(null)
    expect(current(m, "uy")).toBe(null)
  })

  it("moves with the screen's locale", async () => {
    const m = await at("pt-BR")
    expect(current(m, "br")).toBe("page")
    expect(current(m, "ar")).toBe(null)
  })

  it("is not written onto a link that names no locale", async () => {
    // Every other link on the screen is already in the reader's language, so
    // marking them all would say nothing about which one they are on.
    const m = await at("es-AR")
    expect(current(m, "plain")).toBe(null)
  })

  it("leaves the href alone", async () => {
    // The marking rides beside the address and does not replace it: the option
    // for another language still links to that language's spelling of the page.
    const m = await at("pt-BR")
    expect((m.one("#ar") as El).getAttribute("href")).toBe("/ar")
    expect((m.one("#br") as El).getAttribute("href")).toBe("/")
  })
})
