// data-order as a closed map: every order the region can be read in stated in
// the file, and a column choosing among them.
//
// The refusal this preserves is the reason the order never interpolated: a
// column naming a COLUMN is reflection, and the set of reads a screen has would
// stop being enumerable. A column naming a KEY of a map the file carries keeps
// the inventory finite — the same trade `data-when` arms and a machine's state
// set already make.
import { describe, expect, it } from "@test/harness"
import { parseOrder } from "../interpreter/screen.js"

describe("the order parser, read directly", () => {
  it("reads a literal order as the order", () => {
    expect(parseOrder("pos.asc", "t")).toEqual({ literal: "pos.asc" })
  })

  it("reads a closed map", () => {
    expect(parseOrder('{"by":"{sort}","of":{"a":"amount.desc","n":"number.asc"}}', "t")).toEqual({
      by: "{sort}",
      of: { a: "amount.desc", n: "number.asc" },
    })
  })

  it("refuses a value that opens a map and is not one", () => {
    // Structural rather than a probe: "{not json" must not become the literal
    // order "{not json", which the store would answer for with no rows.
    expect(() => parseOrder("{not json", "t")).toThrow(/opens a map and is not JSON/)
  })

  it("refuses a map that is not by-and-of", () => {
    for (
      const bad of [
        '{"by":"{s}"}',
        '{"of":{"a":"x.asc"}}',
        '{"by":"{s}","of":{}}',
        '{"by":"{s}","of":{"a":3}}',
        '{"by":"{s}","of":{"a":"x.asc"},"and":1}',
        '{"by":3,"of":{"a":"x.asc"}}',
        '{"by":"{s}","of":["x.asc"]}',
      ]
    ) {
      expect(() => parseOrder(bad, "t")).toThrow(/a closed order map is/)
    }
  })
})
