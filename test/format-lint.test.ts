import { describe, expect, it } from "@test/harness"
import { type Entity, formatBindings, formatLint } from "../interpreter/lint.ts"

// data-text-format="money" is the one format that needs more than the value:
// the currency code and the minor-unit scale ride the column (schema.cue
// #Field.money), so a binding whose column the emitted schema cannot answer for
// has no currency to render with — and the interpreter refuses it at hydration.
// This is the rung that says so before a screen is ever mounted.

const ledger: Entity = {
  table: "expense",
  durability: "server",
  fields: [
    { name: "id", type: "uuid", pk: true },
    { name: "note", type: "text" },
    { name: "amount", type: "int", money: { currency: "BRL", minorUnits: 0 } },
    { name: "seats", type: "int" },
  ],
}

const one = (html: string) => formatBindings(html)[0]

describe("formatBindings", () => {
  it("binds each placeholder to the region whose row carries it", () => {
    expect(formatBindings('<ul data-live="expense"><template data-item><li data-text="{amount} de {note}" data-text-format="money"></li></template></ul>'))
      .toEqual([
        { format: "money", expr: "amount", table: "expense" },
        { format: "money", expr: "note", table: "expense" },
      ])
  })

  it("resolves a nested region against its own table, not the one around it", () => {
    // The tag stack exists for this case: a checker reading the outermost
    // data-live would grade a nested list's columns against the wrong entity.
    expect(
      formatBindings(
        '<ul data-live="category"><template data-item><li>' +
          '<ol data-live="expense"><template data-item><li data-text="{amount}" data-text-format="money"></li></template></ol>' +
          "</li></template></ul>",
      ),
    ).toEqual([{ format: "money", expr: "amount", table: "expense" }])
  })

  it("binds a region's own data-text in that region's context", () => {
    // bindTexts is handed the region as its scope and matches it, so the
    // region's own binding reads its own row and not its parent's.
    expect(one('<ul data-live="category"><span data-live="expense" data-text="{amount}" data-text-format="money"></span></ul>'))
      .toEqual({ format: "money", expr: "amount", table: "expense" })
  })

  it("reports a binding under no region with no table", () => {
    expect(one('<p data-text="{msg.total}" data-text-format="money"></p>'))
      .toEqual({ format: "money", expr: "msg.total", table: undefined })
  })

  it("scans no markup a comment or a script holds", () => {
    expect(formatBindings('<!-- <p data-text="{x}" data-text-format="money"></p> -->')).toEqual([])
  })
})

describe("formatLint", () => {
  it("accepts portable numeric carriers for number formatting", () => {
    for (const type of ["int32", "int64", "double", "decimal"]) {
      const entity = { ...ledger, fields: [{ name: "value", type }] }
      expect(formatLint({ format: "number", expr: "value", table: "expense" }, entity)).toBe(null)
    }
  })

  it("is silent on a money column that declares one", () => {
    expect(formatLint({ format: "money", expr: "amount", table: "expense" }, ledger)).toBe(null)
  })

  it("refuses money on a column declaring none", () => {
    expect(formatLint({ format: "money", expr: "seats", table: "expense" }, ledger))
      .toBe('data-text-format="money" reads {seats}, which declares no money: on "expense"')
  })

  it("refuses money on an expression that is not a column of the region's table", () => {
    // A route param, a message and an embedded join all resolve somewhere the
    // column declaration is not, and the formatter cannot guess a currency.
    for (const expr of ["param.id", "msg.total", "category.budget"]) {
      expect(formatLint({ format: "money", expr, table: "expense" }, ledger))
        .toContain(`reads {${expr}}, which is not a column of "expense"`)
    }
    expect(formatLint({ format: "money", expr: "ghost", table: "expense" }, ledger))
      .toContain('reads {ghost}, which is not a column of "expense"')
  })

  it("refuses money outside every region", () => {
    expect(formatLint({ format: "money", expr: "total", table: undefined }, undefined))
      .toContain("outside every data-live region")
  })

  it("holds number to a declared column's type and to nothing else", () => {
    expect(formatLint({ format: "number", expr: "seats", table: "expense" }, ledger)).toBe(null)
    expect(formatLint({ format: "number", expr: "note", table: "expense" }, ledger))
      .toBe('data-text-format="number" reads {note}, which is text on "expense"')
    // A derived column — data-project's index, count and lanes — is a number
    // the schema never mentions, and a rule refusing it would be a rule about
    // the wrong layer.
    expect(formatLint({ format: "number", expr: "place", table: "expense" }, ledger)).toBe(null)
    expect(formatLint({ format: "number", expr: "param.page", table: undefined }, undefined)).toBe(null)
  })

  it("holds no other format to a declaration", () => {
    // datetime formats any text, plain formats none, and a renderer is the
    // app's own module.
    for (const format of ["plain", "datetime", "markdown"]) {
      expect(formatLint({ format, expr: "note", table: "expense" }, ledger)).toBe(null)
    }
  })
})
