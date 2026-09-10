import { describe, expect, it } from "@test/harness"
import { isMaintainable, parseFilter, parseFilterSpec } from "../interpreter/data-crud.js"

// The same two-reader hazard filter-neq.test.ts guards, for the operator a
// browser-tier search depends on: with no server to compute an fts read, a
// pattern the parser admits but no reader honours would render every note as
// a hit.
describe("ilike", () => {
  it("parses with its pattern intact", () => {
    expect(parseFilterSpec("title=ilike.*boat*")).toEqual([
      { col: "title", op: "ilike", value: "*boat*" },
    ])
  })

  it("matches case-insensitively, anchored at both ends", () => {
    const [hit] = parseFilter("title=ilike.*boat*")!
    expect(hit({ title: "Boat, Saturday" })).toBe(true)
    expect(hit({ title: "the boathouse" })).toBe(true)
    expect(hit({ title: "Market" })).toBe(false)
    const [exact] = parseFilter("title=ilike.boat")!
    expect(exact({ title: "boat" })).toBe(true)
    expect(exact({ title: "boats" })).toBe(false)
  })

  it("takes the pattern literally where it is not a wildcard", () => {
    const [dot] = parseFilter("title=ilike.a.c")!
    expect(dot({ title: "a.c" })).toBe(true)
    expect(dot({ title: "abc" })).toBe(false)
    const [one] = parseFilter("title=ilike.a_c")!
    expect(one({ title: "abc" })).toBe(true)
    expect(one({ title: "ac" })).toBe(false)
  })

  it("crosses newlines, so a match in a note's second line counts", () => {
    const [body] = parseFilter("body=ilike.*tide*")!
    expect(body({ body: "Rita says\nthe tide turns at four." })).toBe(true)
  })

  it("misses a row that has no such column rather than throwing", () => {
    const [hit] = parseFilter("title=ilike.*boat*")!
    expect(hit({})).toBe(false)
  })

  it("is not maintainable: the view's clause vocabulary cannot state it", () => {
    expect(isMaintainable(parseFilterSpec("title=ilike.*boat*"), [], undefined)).toBe(false)
    expect(isMaintainable(parseFilterSpec("title=like.*boat*"), [], undefined)).toBe(false)
  })
})
