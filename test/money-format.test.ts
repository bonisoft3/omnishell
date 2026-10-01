// Plain numbers and decimals are formatted by the terminal without built-in
// money special-casing. The column is a number or decimal string, and the
// reader's own locale decides grouping and fraction digits.
import { describe, expect, it } from "@test/harness"
import { mountScreen, textOf } from "./screen-harness.ts"

const ROUTE = { screen: "ledger", files: { html: "ledger.html", css: "ledger.css", handlers: [] } }

const FILES = {
  "ledger.html": `<section class="screen" data-screen="ledger">
    <ul data-live="expense">
      <template data-item><li>
        <span class="amount" data-text="{amount}" data-text-format="number"></span>
        <span class="seats" data-text="{seats}" data-text-format="number"></span>
      </li></template>
    </ul>
  </section>`,
  "ledger.css": "",
}

const schema = {
  expense: {
    fields: [
      { name: "id", type: "text" },
      { name: "amount", type: "int" },
      { name: "seats", type: "int" },
    ],
  },
}

const world = { expense: [{ id: "e1", amount: 1204, seats: 1234 }] }

describe("plain numbers and decimals are formatted without built-in money special-casing", () => {
  it("renders integer columns with locale grouping and no currency prefix", async () => {
    for (const [locale, amount, seats] of [["pt-BR", "1.204", "1.234"], ["en-US", "1,204", "1,234"]]) {
      const m = await mountScreen({ route: ROUTE, files: FILES, tables: world, seed: 1, schema, locale })
      await m.settle()
      expect(textOf(m.one(".amount"))).toBe(amount)
      expect(textOf(m.one(".seats"))).toBe(seats)
      await m.stop()
    }
  })

  it("renders decimal columns with locale decimal separator without scaling by minor units", async () => {
    const decimalSchema = {
      expense: {
        fields: [
          { name: "id", type: "text" },
          { name: "amount", type: "decimal" },
          { name: "seats", type: "int" },
        ],
      },
    }
    const decimalWorld = { expense: [{ id: "e1", amount: "1204.50", seats: 1234 }] }
    for (const [locale, amount] of [["pt-BR", "1.204,5"], ["en-US", "1,204.5"]]) {
      const m = await mountScreen({ route: ROUTE, files: FILES, tables: decimalWorld, seed: 1, schema: decimalSchema, locale })
      await m.settle()
      expect(textOf(m.one(".amount"))).toBe(amount)
      await m.stop()
    }
  })
})
