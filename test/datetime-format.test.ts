import { describe, expect, it } from "@test/harness"
import { formatDatetime } from "../interpreter/screen.js"

// CLDR's date-time connector is ", " on V8 and " at " on JSC, so ONE formatter
// carrying both a date and a time field renders differently on Safari than
// everywhere else. formatDatetime composes the two apart for that reason, and
// these cases pin the composed shape — but every runner here is V8, so what
// they hold is the composition, not the engine difference. A JSC run is a
// manual check until there is a runner for one.

// A screen's context, as interpretScreen would hand it over.
const at = (locale: string, timeZone?: string) => ({ locale, timeZone })
const utc = (locale: string) => at(locale, "UTC")

describe("formatDatetime", () => {
  it("renders one shape for every spelling the cluster emits", () => {
    const cases: Array<[string, string]> = [
      ["2026-08-02T09:00:00Z", "Aug 2, 09:00"],
      ["2026-08-02T09:00:00+00:00", "Aug 2, 09:00"],
      // Postgres' timestamptz spelling: space separator, bare hour offset.
      ["2026-08-02 09:00:00+00", "Aug 2, 09:00"],
      ["2026-08-02 09:00:00.123456+00", "Aug 2, 09:00"],
      // Midnight is "00:00": the adjacent h24 cycle renders it "24:00", and
      // omitting hourCycle gives en-US "12:00 AM".
      ["2026-08-02T00:00:00Z", "Aug 2, 00:00"],
      // Day is not zero-padded; hour and minute are.
      ["2026-03-07T05:07:00Z", "Mar 7, 05:07"],
      ["2026-12-25T13:05:00Z", "Dec 25, 13:05"],
      // An offset is resolved against the zone asked for, not carried through.
      ["2026-08-02T09:00:00-03:00", "Aug 2, 12:00"],
    ]
    for (const [input, want] of cases) expect(formatDatetime(input, utc("en-US"))).toBe(want)
  })

  it("renders the language the screen is in", () => {
    // The entry document used to pin en-US, so every app formatted dates in
    // American English whatever it declared. The month name and the field
    // order are the reader's now.
    const when = "2026-08-02T09:00:00Z"
    expect(formatDatetime(when, utc("en-US"))).toBe("Aug 2, 09:00")
    expect(formatDatetime(when, utc("pt-BR"))).toBe("2 de ago., 09:00")
    expect(formatDatetime(when, utc("es"))).toBe("2 ago, 09:00")
  })

  it("renders the zone the screen is in, and UTC only where one is asked for", () => {
    // 09:00Z is 06:00 in São Paulo. Pinning UTC is what the storybook does
    // so a frame does not differ by the machine that rendered it; a reader is
    // shown their own clock.
    const when = "2026-08-02T09:00:00Z"
    expect(formatDatetime(when, at("en-US", "UTC"))).toBe("Aug 2, 09:00")
    expect(formatDatetime(when, at("en-US", "America/Sao_Paulo"))).toBe("Aug 2, 06:00")
    expect(formatDatetime(when, at("en-US", "Asia/Tokyo"))).toBe("Aug 2, 18:00")
  })

  it("keeps midnight at 00:00 in every language", () => {
    // h23 is carried per locale, not inherited: pt-BR's default cycle would
    // render this "24:00" and en-US's "12:00 AM".
    for (const locale of ["en-US", "pt-BR", "es"]) {
      expect(formatDatetime("2026-08-02T00:00:00Z", utc(locale))).toContain("00:00")
    }
  })

  it("renders blank rather than 'Invalid Date' for an absent value", () => {
    for (const blank of [null, undefined, ""]) expect(formatDatetime(blank)).toBe("")
  })

  it("passes an unparsable value through so fixture rows stay legible", () => {
    expect(formatDatetime("fixture-row")).toBe("fixture-row")
    // The offset normalizer bites the "-02" tail of a date-only value, landing
    // it here instead of rendering it as midnight.
    expect(formatDatetime("2026-08-02")).toBe("2026-08-02")
  })
})
