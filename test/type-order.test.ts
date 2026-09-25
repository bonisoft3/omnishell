// A type's canonical string buys equality, not order: `"10" < "9"`. Every
// comparison the terminal makes on its own — a range filter, a snapshot sort,
// the fold's watermark — goes through the column's type, and an Electric
// row's txid (int8) arrives as its int64 string.
import { describe, expect, it } from "@test/harness"
import { columnOrder, compareBy, othersFor, parseFilter } from "../interpreter/data-sync.js"
import { carriers } from "../interpreter/vendor/mecha-client.js"
import { FIXTURE_TYPES } from "../interpreter/fixture-types.js"

const { compareType, compareCarrier } = carriers(FIXTURE_TYPES)
const compare = compareType ?? compareCarrier
const compareTxid = (a: unknown, b: unknown) => compare({ name: "txid", type: "int64" }, a, b)
const order = columnOrder(compare, [
  { name: "counted_txid", type: "int64" },
  { name: "worked", type: "duration" },
  { name: "rate", type: "decimal", precision: 18, scale: 2 },
  { name: "rank", type: "int32" },
  { name: "created_at", type: "timestamp" },
  { name: "day", type: "date" },
])

describe("type order", () => {
  it("range-filters an int64 by value", () => {
    const [atLeast] = parseFilter("counted_txid=gte.9", order)!
    expect(atLeast({ counted_txid: "10" })).toBe(true)
    expect(atLeast({ counted_txid: "8" })).toBe(false)
    expect(atLeast({ counted_txid: null })).toBe(false)
  })

  it("range-filters a duration and a decimal by value", () => {
    const [longer] = parseFilter("worked=gt.PT90S", order)!
    expect(longer({ worked: "PT100S" })).toBe(true)
    const [cheaper] = parseFilter("rate=lt.10", order)!
    expect(cheaper({ rate: "9.5" })).toBe(true)
  })

  it("keeps a numeric string bound on an untyped column", () => {
    const [atLeast] = parseFilter("score=gte.3", order)!
    expect(atLeast({ score: 3 })).toBe(true)
    expect(atLeast({ score: 2 })).toBe(false)
  })

  it("orders the types whose canonical string already sorts", () => {
    const [newer] = parseFilter("created_at=gt.2026-01-15T09:00:00.000000Z", order)!
    expect(newer({ created_at: "2026-02-01T00:00:00.000000Z" })).toBe(true)
    expect(newer({ created_at: "2025-12-31T23:59:59.999999Z" })).toBe(false)
    const [after] = parseFilter("day=gte.2026-02-28", order)!
    expect(after({ day: "2026-03-01" })).toBe(true)
    // A bound that is not the column's type is the program's error, and it
    // is refused where the filter is read rather than per row mid-render.
    expect(() => parseFilter("created_at=gte.2026-01-01", order)).toThrow(/filter created_at/)
    expect(() => parseFilter("rank=gte.1.5", order)).toThrow(/filter rank/)
  })

  it("orders int64 across zero, and decimals by magnitude", () => {
    expect(compareCarrier({ name: "counted_txid", type: "int64" }, "-10", "-9")).toBe(-1)
    expect(compareCarrier({ name: "rate", type: "decimal", precision: 18, scale: 2 }, "1e50", "9e39")).toBe(1)
    expect(compareCarrier({ name: "rank", type: "int32" }, 9, 10)).toBe(-1)
  })

  it("sorts txids and durations by value", () => {
    const rows = [{ txid: "10", worked: "PT100S" }, { txid: "9", worked: "PT90S" }]
    expect([...rows].sort(compareBy("txid.asc", order)).map((r) => r.txid)).toEqual(["9", "10"])
    expect([...rows].sort(compareBy("worked.desc", order)).map((r) => r.worked)).toEqual(["PT100S", "PT90S"])
  })

  it("puts nulls where Postgres puts them, either direction", () => {
    const rows = [{ txid: "10" }, { txid: null }, { txid: "9" }]
    expect([...rows].sort(compareBy("txid.asc", order)).map((r) => r.txid)).toEqual(["9", "10", null])
    expect([...rows].sort(compareBy("txid.desc", order)).map((r) => r.txid)).toEqual([null, "10", "9"])
  })

  it("trusts a watermark that is ahead of the reader only by value", () => {
    const fold = {
      from: "favorite", to: "article_stats", key: "article_id", projects: "favorite_count",
      watermark: "counted_txid", retracted: "deleted_at",
      pair: { table: "favorite_count", counted: "mine_counted", total: "total_at_read", asOf: "as_of_txid" },
    }
    const mine = { article_id: "a1", txid: "9", deleted_at: null, $synced: true }
    // As strings "10" >= "9" is false, and the reader would be counted twice.
    expect(othersFor(fold, { article_id: "a1", favorite_count: 7, counted_txid: "10" }, mine, undefined, compareTxid)).toBe(6)
  })
})
