import { describe, expect, it } from "@test/harness"
import { formatDatetime } from "../interpreter/screen.js"

// This suite must keep running under bun. CLDR's date-time connector is ", "
// on V8 and " at " on JSC, so a formatter carrying both a date and a time
// field renders differently on Safari than everywhere else. The deno smokes
// cannot catch that — they are V8 — and this is the only automated runner on
// JSC the interpreter has.
describe("formatDatetime", () => {
  it("renders one fixed UTC shape for every spelling the cluster emits", () => {
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
      // A non-UTC offset renders in UTC, never in the viewer's zone.
      ["2026-08-02T09:00:00-03:00", "Aug 2, 12:00"],
    ]
    for (const [input, want] of cases) expect(formatDatetime(input)).toBe(want)
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
