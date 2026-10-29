import { describe, expect, it } from "@test/harness"
import { formatLanguage } from "../interpreter/screen.js"
describe("language labels", () => {
  it("uses the reader's language without exposing storage codes or regional suffixes", () => {
    expect(formatLanguage("en-US", { locale: "en" })).toBe("English")
    expect(formatLanguage("pt-BR", { locale: "en" })).toBe("Portuguese")
    expect(formatLanguage("pt", { locale: "en" })).toBe("Portuguese")
    expect(formatLanguage("en-US", { locale: "pt" })).toBe("inglês")
    expect(formatLanguage("en-US", { params: { locale: "es" }, locale: "en" })).toBe("inglés")
  })
  it("retains custom language names and empty values", () => {
    expect(formatLanguage("Klingon", { locale: "en" })).toBe("Klingon")
    expect(formatLanguage(null, { locale: "en" })).toBe("")
  })
})
