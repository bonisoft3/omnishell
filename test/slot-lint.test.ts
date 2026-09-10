import { describe, expect, it } from "@test/harness"
import { slotRegions, unwitnessedSlot, type Entity } from "../interpreter/lint.ts"

// The slot cardinality lint has two halves: finding the slots the way the
// interpreter does (a data-live region with no template[data-item] its
// querySelector would see), and judging each read's witness — the pk, a
// unique field, or a declared unique the filter's eq pins cover.
describe("slotRegions", () => {
  it("a region with no item template is a slot", () => {
    expect(slotRegions('<div data-live="me"></div>')).toEqual([{ table: "me", filter: undefined }])
  })

  it("a region with an item template is a list, not a slot", () => {
    expect(
      slotRegions('<span data-live="me" data-filter="id=eq.{author_id}"><template data-item><i></i></template></span>'),
    ).toEqual([])
  })

  it("carries the filter its cardinality depends on", () => {
    expect(slotRegions('<div data-live="article" data-filter="slug=eq.{param.slug}"></div>'))
      .toEqual([{ table: "article", filter: "slug=eq.{param.slug}" }])
  })

  it("an item template marks every region up to its nearest enclosing template", () => {
    // The outer list's template hides the nested region AND the nested
    // region's own template from the outer querySelector; the nested slot
    // inside the item is judged on its own subtree, where no template lives.
    expect(
      slotRegions(
        '<ul data-live="article"><template data-item><li>' +
          '<span data-live="article_stats" data-filter="article_id=eq.{id}"></span>' +
          "</li></template></ul>",
      ),
    ).toEqual([{ table: "article_stats", filter: "article_id=eq.{id}" }])
  })

  it("a nested list inside an item stays a list", () => {
    expect(
      slotRegions(
        '<ul data-live="article"><template data-item><li>' +
          '<ol data-live="comment" data-filter="article_id=eq.{id}"><template data-item><li></li></template></ol>' +
          "</li></template></ul>",
      ),
    ).toEqual([])
  })

  it("markup inside comments and style blocks is not scanned", () => {
    expect(
      slotRegions('<!-- <div data-live="ghost"></div> --><style>.x{}</style><div data-live="me"></div>'),
    ).toEqual([{ table: "me", filter: undefined }])
  })

  it("decodes entities in the filter and reads single-quoted attributes", () => {
    expect(
      slotRegions(`<div data-live="held" data-filter='current=eq.yes&amp;seat=eq.you'></div>`),
    ).toEqual([{ table: "held", filter: "current=eq.yes&seat=eq.you" }])
  })

  it("a machine slot on a button is found through unclosed void siblings", () => {
    expect(
      slotRegions(
        '<section><input type="hidden"><br>' +
          `<button data-live="tint" data-filter="id=eq.the" data-machine='{"field":"hue"}'>go</button></section>`,
      ),
    ).toEqual([{ table: "tint", filter: "id=eq.the" }])
  })
})

describe("unwitnessedSlot", () => {
  const entity = (extra: Partial<Entity> = {}): Entity => ({
    table: "round",
    durability: "tab",
    fields: [
      { name: "id", type: "text", pk: true },
      { name: "current", type: "text", pk: false },
      { name: "created_at", type: "timestamptz", pk: false },
    ],
    uniques: [],
    ...extra,
  })

  it("an eq on the pk is a witness", () => {
    expect(unwitnessedSlot("id=eq.{param.id}", entity())).toBe(null)
  })

  it("an eq on a unique field is a witness", () => {
    const e = entity({ fields: [{ name: "id", type: "text", pk: true }, { name: "slug", type: "text", unique: true }] })
    expect(unwitnessedSlot("slug=eq.{param.slug}", e)).toBe(null)
  })

  it("a flag pin with no declaration is refused, naming what it pins", () => {
    expect(unwitnessedSlot("current=eq.yes", entity())).toContain("pins current")
  })

  it("a filterless slot with no witness is refused", () => {
    expect(unwitnessedSlot(undefined, entity())).toContain("pins nothing")
  })

  it("a partial unique witnesses exactly the filter that states its predicate", () => {
    const e = entity({ uniques: [{ name: "uq_round_current", cols: ["current"], where: "current=eq.yes" }] })
    expect(unwitnessedSlot("current=eq.yes", e)).toBe(null)
    // A different value reads outside the domain the uniqueness holds over.
    expect(unwitnessedSlot("current=eq.no", e)).toContain("pins current")
  })

  it("a total composite unique needs every column pinned", () => {
    const e = entity({
      fields: [{ name: "id", type: "text", pk: true }, { name: "user_id", type: "uuid" }, { name: "article_id", type: "uuid" }],
      uniques: [{ name: "uq_pair", cols: ["user_id", "article_id"] }],
    })
    expect(unwitnessedSlot("user_id=eq.{me}&article_id=eq.{id}", e)).toBe(null)
    expect(unwitnessedSlot("article_id=eq.{id}", e)).toContain("pins article_id")
  })

  it("an untranslatable filter pins nothing", () => {
    expect(unwitnessedSlot("article_tag.tag=eq.{param.name}", entity())).toContain("pins nothing")
  })

  it("extra predicates narrow without unpinning", () => {
    expect(unwitnessedSlot("id=eq.{id}&cover_url=not.is.null", entity())).toBe(null)
  })
})
