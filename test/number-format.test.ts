import { describe, expect, it } from "@test/harness"
import { formatNumber } from "../interpreter/screen.js"

// A number's grouping and its decimal mark are the reader's, not the column's:
// "1.234,5" and "1,234.5" are the same amount and each is unreadable to the
// other reader. What the cluster answers is ASCII, which is nobody's.

// A screen's context, as interpretScreen would hand it over.
const at = (locale: string) => ({ locale })

describe("formatNumber", () => {
  it("renders the language the screen is in", () => {
    expect(formatNumber(1234.5, at("en-US"))).toBe("1,234.5")
    expect(formatNumber(1234.5, at("pt-BR"))).toBe("1.234,5")
    // NOT "1.234,5": CLDR gives es a minimumGroupingDigits of 2, so a
    // four-digit number is not grouped there at all. A case asserting the
    // grouped spelling would be asserting a bug.
    expect(formatNumber(1234.5, at("es"))).toBe("1234,5")
  })

  it("takes a numeric string as the number it spells", () => {
    // PostgREST answers an int column as a JSON number, but an optimistic row
    // carries what the form submitted, and every form value is a trimmed
    // string.
    expect(formatNumber("1234.5", at("pt-BR"))).toBe("1.234,5")
    // Wider than a double, and exact: the string reaches Intl as it stands
    // rather than through Number().
    expect(formatNumber("12345678901234567.89", at("pt-BR"))).toBe("12.345.678.901.234.567,89")
  })

  it("renders blank rather than 'NaN' for an absent value", () => {
    for (const blank of [null, undefined, ""]) expect(formatNumber(blank, at("pt-BR"))).toBe("")
  })

  it("passes an unparsable value through so fixture rows stay legible", () => {
    // Intl.NumberFormat answers the string "NaN" for anything it cannot read,
    // and the storybook synthesizes "Sample <column> 1" for every column it
    // cannot name — so without this fixture rows would read NaN.
    // formatDatetime passes an unparsable value through for exactly
    // the same reason.
    expect(formatNumber("Sample amount 1", at("pt-BR"))).toBe("Sample amount 1")
  })

  it("falls back to en-US only where the screen names no language", () => {
    // Most apps declare no i18n, and this is every one of their screens — the
    // shape every app rendered before a declared locale reached a binding at
    // all, not an error path.
    expect(formatNumber(1234.5, undefined)).toBe("1,234.5")
    expect(formatNumber(1234.5, { i18n: { default: "pt-BR" } })).toBe("1.234,5")
  })
})
