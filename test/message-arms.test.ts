// Compile-time ICU MessageFormat AST evaluation in pure SES:
// Plurals evaluate with Intl.PluralRules and format counts with Intl.NumberFormat;
// selects match against the value and fall back to 'other'.
import { describe, expect, it } from "@test/harness"
import { mountScreen } from "./screen-harness.ts"
import { compileCatalog } from "../src/messages.ts"

const ROUTE = {
  screen: "pr",
  files: { html: "pr.html", css: "pr.css", handlers: [] },
  states: ["populated"],
}

type Row = Record<string, unknown>
type Catalog = Record<string, unknown>

const files = (item: string) => ({
  "pr.html": `<section class="screen" data-screen="pr">
    <ul data-live="bet" data-order="n.asc">
      <template data-item>
        <li>${item}</li>
      </template>
    </ul>
  </section>`,
  "pr.css": "",
})

const PRICE = {
  "pt-BR": compileCatalog({ worth: "{n, plural, one {vale # ponto} many {vale # pontos} other {vale # pontos}}" }),
  es: compileCatalog({ worth: "{n, plural, one {vale # punto} many {vale # puntos} other {vale # puntos}}" }),
  en: compileCatalog({ worth: "{n, plural, one {worth # point} other {worth # points}}" }),
} satisfies Record<string, Catalog>

const mount = (
  item: string,
  bets: Row[],
  opts: { messages?: Record<string, Catalog>; locale?: string } = {},
) =>
  mountScreen({
    route: ROUTE,
    files: files(item),
    tables: { bet: bets },
    seed: 1,
    messages: opts.messages ?? PRICE,
    locale: opts.locale ?? "pt-BR",
  })

const PLURAL = `<small data-text="{msg.worth}"></small>`

describe("ICU plural message evaluation", () => {
  it("reads the arm the reader's language names for the count", async () => {
    // Spanish pluralizes as one/many/other, so 1 and 2 are different arms of
    // one key — the sentence a string-valued catalogue cannot say.
    const m = await mount(PLURAL, [{ id: "a", n: 1 }, { id: "b", n: 2 }], { locale: "es" })
    await m.settle()
    expect(m.texts("li")).toEqual(["vale 1 punto", "vale 2 puntos"])
    await m.stop()
  })

  it("asks each language for the categories it has and no others", async () => {
    // The same markup over a catalogue carrying one/other, because that is the
    // whole of English.
    const m = await mount(PLURAL, [{ id: "a", n: 1 }, { id: "b", n: 2 }], { locale: "en" })
    await m.settle()
    expect(m.texts("li")).toEqual(["worth 1 point", "worth 2 points"])
    await m.stop()
  })

  it("interpolates the arm's own bindings against the row", async () => {
    const m = await mount(PLURAL, [{ id: "a", n: 7 }], { locale: "pt-BR" })
    await m.settle()
    expect(m.texts("li")).toEqual(["vale 7 pontos"])
    await m.stop()
  })

  it("refuses a column that is not a count", async () => {
    // Intl would answer "other" for every one of these and render a plural
    // over a value that never counted anything.
    for (const n of ["", null, "abc"]) {
      await expect(mount(PLURAL, [{ id: "a", n }])).rejects.toThrow(/is not a count/)
    }
  })
})

describe("ICU select message evaluation", () => {
  const GREET = {
    "pt-BR": compileCatalog({ greet: "{g, select, f {bem-vinda} m {bem-vindo} other {bem-vinde}}" }),
    es: compileCatalog({ greet: "{g, select, f {bienvenida} m {bienvenido} other {bienvenide}}" }),
    en: compileCatalog({ greet: "{gender, select, f {welcome} m {welcome} other {welcome}}" }),
  } satisfies Record<string, Catalog>

  it("reads the arm the column's own value names", async () => {
    const m = await mount(
      `<small data-text="{msg.greet}"></small>`,
      [{ id: "a", n: 1, g: "f" }, { id: "b", n: 2, g: "m" }],
      { messages: GREET },
    )
    await m.settle()
    expect(m.texts("li")).toEqual(["bem-vinda", "bem-vindo"])
    await m.stop()
  })

  it("falls back to other when the value has no specific arm", async () => {
    const m = await mount(
      `<small data-text="{msg.greet}"></small>`,
      [{ id: "a", n: 1, g: "x" }],
      { messages: GREET },
    )
    await m.settle()
    expect(m.texts("li")).toEqual(["bem-vinde"])
    await m.stop()
  })
})

describe("the fixture tier", () => {
  it("answers a plural selector's column with a count", async () => {
    const route = { screen: "pr", files: { html: "pr.html", css: "pr.css" }, states: ["populated"] }
    const source = files(PLURAL)["pr.html"]
    const html = `<!doctype html><html><head></head><body><div id="mount"></div></body></html>`
    const { renderStorybook } = await import("../interpreter/storybook.js")
    const { parseHTML } = await import("npm:linkedom@0.18.4")
    // deno-lint-ignore no-explicit-any
    const g = globalThis as any
    const doc = g.document
    g.document = (parseHTML(html) as unknown as { document: unknown }).document
    g.fetch = (url: unknown) =>
      Promise.resolve(new Response(String(url).endsWith(".css") ? "" : source))
    try {
      const mount = g.document.getElementById("mount")
      await renderStorybook(mount, "http://app.test/", route, {}, {}, { messages: PRICE, locale: "es" })
      expect(mount.querySelector(".frame small").textContent).toMatch(/^vale \d+ punto/)
    } finally {
      g.document = doc
    }
  })
})

describe("an arm bound into an attribute", () => {
  it("selects the same arm the element's text does", async () => {
    const m = await mount(
      `<small title="{msg.worth}">x</small>`,
      [{ id: "a", n: 1 }, { id: "b", n: 4 }],
      { locale: "es" },
    )
    await m.settle()
    expect(m.all("small").map((el) => el.getAttribute("title"))).toEqual(["vale 1 punto", "vale 4 puntos"])
    await m.stop()
  })
})
