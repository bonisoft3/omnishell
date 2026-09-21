// A message with more than one wording, and the element that picks between
// them: data-msg-plural reads the arm Intl.PluralRules names for a count,
// data-msg-select the arm the column's own value names.
//
// The count refusals are the reason armOf exists at all: Intl.PluralRules
// answers "other" for NaN, undefined, "" and "abc" alike, so a selector over a
// column that is not a count would render a plural nobody asked for and no
// tier would say so.
import { describe, expect, it } from "@test/harness"
import { mountScreen } from "./screen-harness.ts"

const ROUTE = {
  screen: "pr",
  files: { html: "pr.html", css: "pr.css", handlers: [] },
  states: ["populated"],
}

type Row = Record<string, unknown>
type Catalog = Record<string, string | Record<string, string>>

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
  "pt-BR": { worth: { one: "vale {n} ponto", many: "vale {n} pontos", other: "vale {n} pontos" } },
  es: { worth: { one: "vale {n} punto", many: "vale {n} puntos", other: "vale {n} puntos" } },
  en: { worth: { one: "worth {n} point", other: "worth {n} points" } },
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

const PLURAL = `<small data-text="{msg.worth}" data-msg-plural="n"></small>`

describe("data-msg-plural", () => {
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
    // whole of English. Nothing here names a category.
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

describe("data-msg-select", () => {
  const GREET = {
    "pt-BR": { greet: { f: "bem-vinda", m: "bem-vindo" } },
    es: { greet: { f: "bienvenida", m: "bienvenido" } },
    en: { greet: { f: "welcome", m: "welcome" } },
  } satisfies Record<string, Catalog>

  it("reads the arm the column's own value names", async () => {
    const m = await mount(
      `<small data-text="{msg.greet}" data-msg-select="g"></small>`,
      [{ id: "a", n: 1, g: "f" }, { id: "b", n: 2, g: "m" }],
      { messages: GREET },
    )
    await m.settle()
    expect(m.texts("li")).toEqual(["bem-vinda", "bem-vindo"])
    await m.stop()
  })

  it("refuses a value the map has no arm for", async () => {
    await expect(
      mount(`<small data-text="{msg.greet}" data-msg-select="g"></small>`, [{ id: "a", n: 1, g: "x" }], {
        messages: GREET,
      }),
    ).rejects.toThrow(/has no arm "x"; it carries \[f, m\]/)
  })
})

describe("a message with arms and nothing selecting one", () => {
  it("refuses rather than rendering [object Object]", async () => {
    // What this tier shipped before: String({one,many,other}) reaching the DOM
    // as "[object Object]", in every locale, with no tier saying anything.
    await expect(mount(`<small data-text="{msg.worth}"></small>`, [{ id: "a", n: 1 }])).rejects.toThrow(
      /is a map of \[one, many, other\]/,
    )
  })

  it("refuses an arm that names another message", async () => {
    // A catalogue recursing through the renderer: the arm is text, and the one
    // inner pass it gets resolves the row's columns and nothing else.
    await expect(
      mount(PLURAL, [{ id: "a", n: 1 }], {
        messages: { "pt-BR": { worth: { one: "{msg.other}", many: "x", other: "x" }, other: "o" } },
      }),
    ).rejects.toThrow(/an arm is text, not another key/)
  })

  it("refuses two selectors on one element", async () => {
    await expect(
      mount(`<small data-text="{msg.worth}" data-msg-plural="n" data-msg-select="n"></small>`, [{ id: "a", n: 1 }]),
    ).rejects.toThrow(/an arm is selected once/)
  })
})

describe("the fixture tier", () => {
  it("answers a plural selector's column with a count", async () => {
    // fixture() synthesizes "Sample <leaf> 1" for every field it does not
    // recognise, and a selector over one of those is exactly what armOf
    // refuses — so without the markup scan every storybook frame of every
    // pluralized screen goes down, and the check tiers render through here.
    const route = { screen: "pr", files: { html: "pr.html", css: "pr.css" }, states: ["populated"] }
    const source = files(PLURAL)["pr.html"]
    const html = `<!doctype html><html><head></head><body><div id="mount"></div></body></html>`
    // Imported here rather than at the top of the file: screen-harness owns
    // the interpreter import, and a second static one freezes the clock knobs
    // before mountScreen can set them.
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
    // The attribute path renders "[object Object]" exactly as data-text did,
    // so the arm reaches bindElementAttributes and not only bindTexts.
    const m = await mount(
      `<small title="{msg.worth}" data-msg-plural="n">x</small>`,
      [{ id: "a", n: 1 }, { id: "b", n: 4 }],
      { locale: "es" },
    )
    await m.settle()
    expect(m.all("small").map((el) => el.getAttribute("title"))).toEqual(["vale 1 punto", "vale 4 puntos"])
    await m.stop()
  })
})
