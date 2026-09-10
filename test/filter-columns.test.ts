import { describe, expect, it } from "@test/harness"
import { scanScreen, unknownColumns } from "../interpreter/lint.ts"

// R2 guards the seam between two statements of one fact: the markup's filter
// fragments and the program's entity fields. It reads the interpreter's own
// parser (fragment.js), so the grammar's non-columns — a cap, an embed path,
// an fts expression — can never come back as findings.
describe("unknownColumns (R2)", () => {
  const fields = ["id", "round_id", "vaza", "kind", "created_at"]

  it("catches a seeded violation", () => {
    expect(unknownColumns("round_id=eq.{id}&vasa=eq.1", fields)).toEqual(["vasa"])
  })

  it("passes columns the entity has", () => {
    expect(unknownColumns("round_id=eq.{id}&vaza=eq.1&kind=eq.card", fields)).toEqual([])
  })

  it("a cap is not a column", () => {
    expect(unknownColumns("created_at=lt.{param.when}&limit=20", fields)).toEqual([])
    expect(unknownColumns("limit=20", fields)).toEqual([])
  })

  it("a server-computed fragment names no column this rule may judge", () => {
    expect(unknownColumns("article_tag.tag=eq.{param.name}&limit=20", fields)).toEqual([])
    expect(unknownColumns("search=plfts(simple).{param.q}", fields)).toEqual([])
  })

  it("reports each unknown column once", () => {
    expect(unknownColumns("ghost=eq.a&ghost=neq.b", fields)).toEqual(["ghost"])
  })
})

describe("scanScreen filter anchors", () => {
  it("anchors a region's filter to its data-live table", () => {
    const { filters } = scanScreen('<div data-live="play" data-filter="round_id=eq.{id}"></div>')
    expect(filters).toEqual([{ table: "play", filter: "round_id=eq.{id}" }])
  })

  it("anchors a delete form's filter to its data-entity", () => {
    const { filters } = scanScreen(
      '<form data-form="unsave" data-entity="bookmark" data-action="delete" data-filter="article_id=eq.{id}"></form>',
    )
    expect(filters).toEqual([{ table: "bookmark", filter: "article_id=eq.{id}" }])
  })

  it("decodes entities before the parse sees the fragment", () => {
    const { filters } = scanScreen('<ul data-live="play" data-filter="vaza=eq.1&amp;kind=eq.card"></ul>')
    expect(filters).toEqual([{ table: "play", filter: "vaza=eq.1&kind=eq.card" }])
  })

  it("a filter with no anchor is a precondition error", () => {
    expect(() => scanScreen('<div data-filter="id=eq.x"></div>')).toThrow()
  })

  // One attribute grammar for every checker: a single-quoted attribute is the
  // norm on machine regions, and it must reach R2 and the reads set exactly
  // as a double-quoted one does.
  it("single-quoted attributes are the same grammar", () => {
    const { tables, filters } = scanScreen(
      "<ul data-live='play' data-filter='round_id=eq.{id}' data-read-log='play?vaza=eq.1'></ul>",
    )
    expect(tables).toEqual(["play"])
    expect(filters).toEqual([
      { table: "play", filter: "vaza=eq.1" },
      { table: "play", filter: "round_id=eq.{id}" },
    ])
  })

  it("a quoted > does not end the tag for the scanner", () => {
    const { tables } = scanScreen('<ul data-live="play" data-note="a > b" data-reads="round"></ul>')
    expect(tables).toEqual(["play", "round"])
  })
})

// Named reads are the same grammar read by the same parser: the table joins
// the screen's set, and the fragment's filter part is anchored to it for R2.
describe("scanScreen named reads", () => {
  it("adds the read's table and anchors its filter part", () => {
    const { tables, filters } = scanScreen(
      '<ul data-live="play" data-read-standing="round?current=eq.yes&amp;order=created_at.desc"></ul>',
    )
    expect(tables).toEqual(["play", "round"])
    expect(filters).toEqual([{ table: "round", filter: "current=eq.yes" }])
  })

  it("a whole-table named read contributes no filter", () => {
    const { tables, filters } = scanScreen('<ul data-live="play" data-read-all="round"></ul>')
    expect(tables).toEqual(["play", "round"])
    expect(filters).toEqual([])
  })

  it("bare data-reads stays whole-table sugar beside a named read", () => {
    const { tables, filters } = scanScreen(
      '<ul data-live="play" data-reads="round" data-read-log="play?round_id=eq.{id}&amp;order=seq.asc"></ul>',
    )
    expect(tables).toEqual(["play", "round"])
    expect(filters).toEqual([{ table: "play", filter: "round_id=eq.{id}" }])
  })
})
