import { describe, expect, it } from "@test/harness"
import { slotRegions, undeclaredSlot, unwitnessedSlot, type Entity, type Slot } from "../interpreter/lint.ts"

// The slot lints share one scan — finding the slots the way the interpreter
// does (a data-live region with no template[data-item] its querySelector would
// see) — and judge two things about each: the read's cardinality witness (the
// pk, a unique field, or a declared unique the filter's eq pins cover), and
// whether a nested one says what it renders with no row.
describe("slotRegions", () => {
  it("a region with no item template is a slot", () => {
    expect(slotRegions('<div data-live="me"></div>')).toEqual([{ table: "me", filter: undefined, nested: false, declares: false }])
  })

  it("a region with an item template is a list, not a slot", () => {
    expect(
      slotRegions('<span data-live="me" data-filter="id=eq.{author_id}"><template data-item><i></i></template></span>'),
    ).toEqual([])
  })

  it("carries the filter its cardinality depends on", () => {
    expect(slotRegions('<div data-live="article" data-filter="slug=eq.{param.slug}"></div>'))
      .toEqual([{ table: "article", filter: "slug=eq.{param.slug}", nested: false, declares: false }])
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
    ).toEqual([{ table: "article_stats", filter: "article_id=eq.{id}", nested: true, declares: false }])
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
    ).toEqual([{ table: "me", filter: undefined, nested: false, declares: false }])
  })

  it("decodes entities in the filter and reads single-quoted attributes", () => {
    expect(
      slotRegions(`<div data-live="held" data-filter='current=eq.yes&amp;seat=eq.you'></div>`),
    ).toEqual([{ table: "held", filter: "current=eq.yes&seat=eq.you", nested: false, declares: false }])
  })

  it("a machine slot on a button is found through unclosed void siblings", () => {
    expect(
      slotRegions(
        '<section><input type="hidden"><br>' +
          `<button data-live="tint" data-filter="id=eq.the" data-machine='{"field":"hue"}'>go</button></section>`,
      ),
    ).toEqual([{ table: "tint", filter: "id=eq.the", nested: false, declares: true }])
  })
})

describe("slotRegions on a nested slot's declaration", () => {
  const nest = (attrs: string) =>
    slotRegions(
      `<ul data-live="step"><template data-item><li>` +
        `<span data-live="note" data-filter="step_id=eq.{id}"${attrs}></span>` +
        `</li></template></ul>`,
    )

  it("copy is a declaration", () => {
    expect(nest(` data-empty="No note yet."`)[0].declares).toBe(true)
  })

  it("empty copy is a declaration — the region shows nothing, and says so", () => {
    expect(nest(` data-empty=""`)[0].declares).toBe(true)
  })

  it("a valueless data-empty is the empty string the DOM hands the interpreter", () => {
    expect(nest(" data-empty")[0].declares).toBe(true)
  })

  it("a row to bind instead is a declaration", () => {
    expect(nest(` data-empty-row='{"body":""}'`)[0].declares).toBe(true)
    // A machine slot binds the row it synthesizes from its own initial, so it
    // never reaches the rowless branch either.
    expect(nest(` data-machine='{"field":"seen"}'`)[0].declares).toBe(true)
  })

  it("only a template[data-item] nests: a slot beside one is top-level", () => {
    expect(
      slotRegions(
        `<ul data-live="step"><template data-item><li></li></template></ul>` +
          `<div data-live="note" data-filter="id=eq.the"></div>`,
      ),
    ).toEqual([{ table: "note", filter: "id=eq.the", nested: false, declares: false }])
  })

  it("a named template nests what it holds — its region is hydrated from an item", () => {
    expect(
      slotRegions(
        `<template data-item data-name="line"><p><span data-live="note" data-filter="id=eq.{id}"></span></p></template>` +
          `<ol data-live="step" data-template="line"></ol>`,
      ),
    ).toEqual([{ table: "note", filter: "id=eq.{id}", nested: true, declares: false }])
  })
})

describe("undeclaredSlot", () => {
  const slot = (extra: Partial<Slot> = {}): Slot => ({
    table: "note",
    filter: "step_id=eq.{id}",
    nested: true,
    declares: false,
    ...extra,
  })

  it("a nested slot that declares nothing is refused", () => {
    expect(undeclaredSlot(slot())).toContain("declares no empty treatment")
  })

  it("a nested slot that declares one is fine", () => {
    expect(undeclaredSlot(slot({ declares: true }))).toBe(null)
  })

  it("a top-level slot owes nothing: the screen's own state is the frame", () => {
    // Requiring it there would refuse every screen that already answers this
    // the way its route says — with `gone` or `empty`.
    expect(undeclaredSlot(slot({ nested: false }))).toBe(null)
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
