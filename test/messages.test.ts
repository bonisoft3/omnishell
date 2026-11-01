// The build-time compiler: what a catalogue string becomes before the SES evaluator sees it.
import { describe, expect, it } from "@test/harness"
import { parseMessage } from "../src/messages.ts"

describe("parseMessage", () => {
  it("keeps a literal as text, unescaped by the same rule as an argument message", () => {
    expect(parseMessage("Hello world!")).toBe("Hello world!")
    expect(parseMessage("Don''t")).toBe("Don't")
  })

  // A plain argument once stayed a raw string and rendered "Ficha {position} de {size}".
  it("compiles a plain argument to an AST the evaluator binds", () => {
    const ast = parseMessage("Hello {name}!")
    expect(Array.isArray(ast)).toBe(true)
    expect((ast as Array<{ type: number; value?: string }>)[1]).toEqual({ type: 1, value: "name" })
  })

  it("compiles plurals and selects", () => {
    const plural = parseMessage("{count, plural, one {# item} other {# items}}") as Array<{ type: number }>
    expect(plural[0].type).toBe(6)
    const select = parseMessage("{g, select, f {ela} other {elu}}") as Array<{ type: number }>
    expect(select[0].type).toBe(5)
  })

  it("refuses what the evaluator cannot render", () => {
    expect(() => parseMessage("Hello {unclosed")).toThrow()
    expect(() => parseMessage("Today is {d, date}")).toThrow()
  })

  // "Torn d'{name}" is ICU quoting, which prints the braces instead of the name.
  it("refuses an apostrophe before a brace", () => {
    expect(() => parseMessage("Torn d'{name}")).toThrow(/U\+2019/)
    expect(() => parseMessage("d'''{name}")).toThrow(/U\+2019/)
  })

  it("admits an escaped apostrophe before a brace", () => {
    const ast = parseMessage("d''{name}") as Array<{ type: number; value?: string }>
    expect(ast[0]).toEqual({ type: 0, value: "d'" })
    expect(ast[1]).toEqual({ type: 1, value: "name" })
  })

  // Every string is parsed now, so tag-like catalogue text must not be read as markup.
  it("keeps tag-like text literal", () => {
    expect(parseMessage("Press <kbd>Enter</kbd>")).toBe("Press <kbd>Enter</kbd>")
    expect(parseMessage("a<b")).toBe("a<b")
    expect(parseMessage("</p>")).toBe("</p>")
  })
})
