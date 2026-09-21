// An amount reaches the reader through the terminal, not through SQL. The
// column is an integer and the currency and the minor-unit scale are declared
// on it, so one screen over one store renders the same row "R$ 1.204" to a
// Brazilian and "R$1,204" to an American — where a generated *_display column
// would have picked one of those in the database and shown it to everybody.
import { describe, expect, it } from "@test/harness"
import { mountScreen, textOf } from "./screen-harness.ts"

const ROUTE = { screen: "ledger", files: { html: "ledger.html", css: "ledger.css", handlers: [] } }

const FILES = {
  "ledger.html": `<section class="screen" data-screen="ledger">
    <ul data-live="expense">
      <template data-item><li>
        <span class="money" data-text="{amount}" data-text-format="money"></span>
        <span class="seats" data-text="{seats}" data-text-format="number"></span>
      </li></template>
    </ul>
  </section>`,
  "ledger.css": "",
}

const money = { currency: "BRL", minorUnits: 0 }
const schema = (declared: boolean) => ({
  expense: {
    fields: [
      { name: "id", type: "text" },
      declared ? { name: "amount", type: "int", money } : { name: "amount", type: "int" },
      { name: "seats", type: "int" },
    ],
  },
})

const world = { expense: [{ id: "e1", amount: 1204, seats: 1234 }] }

describe("a money column is formatted by the terminal", () => {
  it("renders the currency the column declares in the reader's own language", async () => {
    for (const [locale, amount, seats] of [["pt-BR", "R$\u00a01.204", "1.234"], ["en-US", "R$1,204", "1,234"]]) {
      const m = await mountScreen({ route: ROUTE, files: FILES, tables: world, seed: 1, schema: schema(true), locale })
      await m.settle()
      expect(textOf(m.one(".money"))).toBe(amount)
      expect(textOf(m.one(".seats"))).toBe(seats)
      await m.stop()
    }
  })

  it("refuses a money binding on a column that declares none", async () => {
    // A currency is not guessable and the bare integer reads as reais to one
    // app and as cents to the next, so hydration fails rather than showing an
    // amount nobody stated — a ProgramError, which the region's guard lets
    // through unretried. check-markup answers the same question off the
    // emitted schema, before a mount.
    let refused: string | undefined
    try {
      await mountScreen({ route: ROUTE, files: FILES, tables: world, seed: 1, schema: schema(false) })
    } catch (err) {
      refused = (err as Error).message
    }
    expect(refused).toBe('data-text-format="money" reads {amount}, which declares no money: on "expense"')
  })
})
