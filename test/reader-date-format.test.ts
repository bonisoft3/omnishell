import { describe, expect, it } from "@test/harness"
import { formatDate, formatTime, localDate, parseProjection } from "../interpreter/screen.js"
const at = (timeZone: string, locale = "en-US") => ({ timeZone, locale })
describe("reader date and time", () => {
  it("renders numeric civil dates and h23 time in the reader zone", () => {
    const value = "2026-10-16T02:05:00Z"
    for (const [zone, day, date, time] of [
      ["UTC", "2026-10-16", "10/16/2026", "02:05"],
      ["America/Los_Angeles", "2026-10-15", "10/15/2026", "19:05"],
      ["Asia/Tokyo", "2026-10-16", "10/16/2026", "11:05"],
    ]) {
      expect(localDate(value, at(zone))).toBe(day)
      expect(formatDate(value, at(zone))).toBe(date)
      expect(formatTime(value, at(zone))).toBe(time)
    }
    expect(formatDate(value, at("UTC", "pt-BR"))).toBe("16/10/2026")
    expect(formatTime("2026-10-16 00:00:00+00", at("UTC"))).toBe("00:00")
  })
  it("uses the selected regional date order independently of the reader timezone", () => {
    for (const [locale, date] of [
      ["en-US", "10/16/2026"], ["en-GB", "16/10/2026"], ["pt-BR", "16/10/2026"],
      ["es-AR", "16/10/2026"], ["it-IT", "16/10/2026"], ["de-DE", "16.10.2026"], ["fr-FR", "16/10/2026"],
    ]) {
      expect(formatDate("2026-10-16", at("America/Los_Angeles", locale))).toBe(date)
      expect(formatDate("2026-10-16T19:00:00Z", at("America/Los_Angeles", locale))).toBe(date)
    }
  })
  it("crosses March and November DST transitions by the instant", () => {
    for (const [value, time] of [
      ["2026-03-08T09:30:00Z", "01:30"], ["2026-03-08T10:30:00Z", "03:30"],
      ["2026-11-01T08:30:00Z", "01:30"], ["2026-11-01T09:30:00Z", "01:30"],
    ]) expect(formatTime(value, at("America/Los_Angeles"))).toBe(time)
  })
  it("preserves date-only values and blanks in every zone", () => {
    for (const zone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
      expect(localDate("2026-03-08", at(zone))).toBe("2026-03-08")
      expect(formatTime("2026-03-08", at(zone))).toBe("")
      expect(formatDate("2026-03-08", at(zone))).toBe("03/08/2026")
      for (const blank of [null, undefined, ""]) for (const format of [localDate, formatDate, formatTime]) expect(format(blank, at(zone))).toBe("")
    }
    for (const bad of ["2026-02-30", "2026-02-30T00:00:00Z", "2026-10-16T02:00:00", "123", "fixture"]) expect(() => localDate(bad, at("UTC"))).toThrow(/invalid date/)
    expect(localDate("fixture", { inert: true })).toBe("fixture")
    expect(localDate("0001-01-01T00:00:00Z", at("UTC"))).toBe("0001-01-01")
  })
  it("requires a nonempty list of source columns", () => {
    for (const date of [[], "kickoff", [""], [" "], [1], null]) expect(() => parseProjection(JSON.stringify({ reader_day: { date } }), "game")).toThrow(/date clause/)
    expect(() => parseProjection('{"reader_day":{"date":["kickoff"],"changed":["day"]}}', "game")).toThrow(/date clause/)
  })
})
