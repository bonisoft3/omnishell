import { describe, expect, it } from "@test/harness"
import { isMaintainable, parseFilter, parseFilterSpec } from "../interpreter/data-crud.js"

// A filter has two readers — the snapshot predicate and the maintained view —
// and they must agree. A spec the parser admits but the view compiles wrong is
// silent: the region renders, with the wrong rows.
describe("neq", () => {
  it("parses alongside eq and keeps its value", () => {
    expect(parseFilterSpec("current=eq.yes&seat=neq.you")).toEqual([
      { col: "current", op: "eq", value: "yes" },
      { col: "seat", op: "neq", value: "you" },
    ])
  })

  it("excludes only the value it names", () => {
    const [, notYou] = parseFilter("current=eq.yes&seat=neq.you")!
    expect(notYou({ seat: "eles1" })).toBe(true)
    expect(notYou({ seat: "you" })).toBe(false)
  })

  it("is maintainable, so the view is the one that answers", () => {
    expect(isMaintainable(parseFilterSpec("seat=neq.you"), [], undefined)).toBe(true)
  })
})
