import { describe, expect, it } from "@test/harness"
import { formatNumber } from "../interpreter/screen.js"

// A number's grouping and its decimal mark are the reader's, not the column's:
// "1.234,5" and "1,234.5" are the same amount and each is unreadable to the
// other reader. What the cluster answers is ASCII, which is nobody's.
//
// Where pt-BR places a currency apart from its amount it does so with NBSP
// (U+00A0). Every case here escapes it, because a literal space in this file
// and the byte the terminal renders look identical in a diff and only one of
// them passes.

// A screen's context, as interpretScreen would hand it over.
const at = (locale: string) => ({ locale })
const BRL = { currency: "BRL", minorUnits: 0 }
const CENTS = { currency: "BRL", minorUnits: 2 }

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

  it("carries the currency and the scale the column declares", () => {
    // minorUnits 0 is a ledger in whole reais; CLDR's own idea of BRL is two
    // places, and deferring to it would grow a ",00" the column does not hold.
    expect(formatNumber(1204, at("pt-BR"), BRL)).toBe("R$\u00a01.204")
    // The code is the column's, the placement and the grouping the reader's.
    expect(formatNumber(1204, at("en-US"), BRL)).toBe("R$1,204")
  })

  it("places the minor units by moving the point, never by dividing", () => {
    // 123456789012345678 cents is exact as text; as a double it rounds, and
    // dividing by 100 answers R$ 1.234.567.890.123.456.568,00 for this row.
    expect(formatNumber("123456789012345678", at("pt-BR"), CENTS))
      .toBe("R$\u00a01.234.567.890.123.456,78")
    // Fewer digits than the scale is left-padded, and the sign stays outside.
    expect(formatNumber(5, at("pt-BR"), CENTS)).toBe("R$\u00a00,05")
    expect(formatNumber(-5, at("pt-BR"), CENTS)).toBe("-R$\u00a00,05")
  })

  it("renders blank rather than 'NaN' for an absent value", () => {
    for (const blank of [null, undefined, ""]) expect(formatNumber(blank, at("pt-BR"))).toBe("")
  })

  it("passes an unparsable value through so fixture rows stay legible", () => {
    // Intl.NumberFormat answers the string "NaN" for anything it cannot read,
    // and the storybook synthesizes "Sample <column> 1" for every column it
    // cannot name — so without this every money frame of every fixture would
    // read NaN. formatDatetime passes an unparsable value through for exactly
    // the same reason.
    expect(formatNumber("Sample amount 1", at("pt-BR"))).toBe("Sample amount 1")
    expect(formatNumber("Sample amount 1", at("pt-BR"), CENTS)).toBe("Sample amount 1")
    // A count of minor units is an integer, so a fractional one is not one of
    // them either.
    expect(formatNumber("12.5", at("pt-BR"), CENTS)).toBe("12.5")
  })

  it("falls back to en-US only where the screen names no language", () => {
    // Most apps declare no i18n, and this is every one of their screens — the
    // shape every app rendered before a declared locale reached a binding at
    // all, not an error path.
    expect(formatNumber(1234.5, undefined)).toBe("1,234.5")
    expect(formatNumber(1234.5, { i18n: { default: "pt-BR" } })).toBe("1.234,5")
  })
})
