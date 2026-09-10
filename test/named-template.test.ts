import { describe, expect, it } from "@test/harness"
import { scanScreen, slotRegions } from "../interpreter/lint.ts"

// Named templates: a region may reference a screen-scoped
// <template data-item data-name="X"> via data-template="X" instead of
// containing its own template — the shape the recursive comment thread is
// authored as. The derive pass must classify such a region as a list (the
// slot cardinality lint does not apply) and still extract every table and
// filter its markup names, template content included.
const THREAD =
  '<ul data-live="comment" data-filter="parent_id=eq.root">' +
  '<template data-item data-name="comment"><li>' +
  '<span data-text="{body}"></span>' +
  '<ul data-live="comment" data-filter="parent_id=eq.{id}" data-template="comment"></ul>' +
  "</li></template></ul>"

describe("slotRegions with named templates", () => {
  it("a region referencing a named template is a list, not a slot", () => {
    expect(slotRegions('<div data-live="comment" data-template="comment"></div>')).toEqual([])
  })

  it("the recursive thread shape yields no slots at either level", () => {
    expect(slotRegions(THREAD)).toEqual([])
  })

  it("a template-less region beside a named template is still a slot", () => {
    expect(
      slotRegions(THREAD + '<div data-live="profile" data-filter="id=eq.{param.id}"></div>'),
    ).toEqual([{ table: "profile", filter: "id=eq.{param.id}" }])
  })
})

describe("scanScreen with named templates", () => {
  it("tables and filters inside a named template's content are extracted", () => {
    const { tables, filters } = scanScreen(THREAD)
    expect(tables).toEqual(["comment"])
    expect(filters).toEqual([
      { table: "comment", filter: "parent_id=eq.root" },
      { table: "comment", filter: "parent_id=eq.{id}" },
    ])
  })
})
