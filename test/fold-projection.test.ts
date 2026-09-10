// The fold projection's arithmetic: `shown = others + intent`.
//
// A fold sink lags its source by the whole CDC loop, so the terminal resumes
// the fold over rows the sink has not counted. These pin the three branches
// othersFor chooses between, and that the column it answers about is the one
// the pipeline DECLARED — the interpreter is generic, and a literal column
// name here is right for one app and silently undefined for the next.
import { describe, expect, it } from "@test/harness"
import { othersFor } from "../interpreter/data-crud.js"

// realworld's favorite-recount, as emit.cue hands it to the client.
const FOLD = {
  from: "favorite",
  to: "article_stats",
  key: "article_id",
  projects: "favorite_count",
  watermark: "counted_txid",
  retracted: "deleted_at",
  pair: {
    table: "favorite_count",
    counted: "mine_counted",
    total: "total_at_read",
    asOf: "as_of_txid",
  },
}

const sink = (favorite_count: number, counted_txid: number | null) =>
  ({ article_id: "a1", favorite_count, counted_txid }) as Record<string, unknown>

describe("the fold projection", () => {
  it("trusts the watermark when the sink's read is at or after the reader's version", () => {
    // Two server txids about versions that exist: the total already counts the
    // reader, so subtracting their state is exact and no pair is needed.
    const mine = { article_id: "a1", txid: 40, deleted_at: null, $synced: true }
    expect(othersFor(FOLD, sink(7, 42), mine, undefined)).toBe(6)
  })

  it("keeps a first favourite from spiking", () => {
    // The regression this branch exists for: the total starts including the
    // reader before their pair arrives, and without the watermark check the
    // reader is added twice and the count reads one too high.
    const mine = { article_id: "a1", txid: 42, deleted_at: null, $synced: true }
    const shown = othersFor(FOLD, sink(1, 42), mine, undefined) + 1
    expect(shown).toBe(1)
  })

  it("falls back to the pair when the sink's read predates the reader's change", () => {
    // Older, never wrong: the pair's own read is internally consistent whatever
    // has happened since.
    const mine = { article_id: "a1", txid: 99, deleted_at: null, $synced: true }
    const pair = { article_id: "a1", mine_counted: 1, total_at_read: 5, as_of_txid: 50 }
    expect(othersFor(FOLD, sink(9, 50), mine, pair)).toBe(4)
  })

  it("counts the whole total when no read has ever counted the reader", () => {
    expect(othersFor(FOLD, sink(3, 10), undefined, undefined)).toBe(3)
  })

  it("does not trust the watermark for a write the server has not acknowledged", () => {
    // An unsynced row has no server txid to compare, so the watermark branch
    // must not fire — offline, the pair (or the bare total) is the only honest
    // answer.
    const mine = { article_id: "a1", txid: null, deleted_at: null, $synced: false }
    expect(othersFor(FOLD, sink(4, 99), mine, undefined)).toBe(4)
  })

  it("reads the column the fold declares, not a column named favorite_count", () => {
    // The interpreter is generic: a fold whose column is not favorite_count
    // must project that column, not undefined.
    const other = { ...FOLD, projects: "done_count", pair: { ...FOLD.pair, table: "note_tally" } }
    const row = { article_id: "a1", done_count: 5, favorite_count: 999, counted_txid: 70 }
    const mine = { article_id: "a1", txid: 60, deleted_at: null, $synced: true }
    expect(othersFor(other, row, mine, undefined)).toBe(4)
  })

  it("treats a retracted row as no contribution", () => {
    const mine = { article_id: "a1", txid: 40, deleted_at: "2026-09-07T00:00:00Z", $synced: true }
    expect(othersFor(FOLD, sink(7, 42), mine, undefined)).toBe(7)
  })
})
