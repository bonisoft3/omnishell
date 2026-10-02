// A region's select is PostgREST's to read, so the parser behind its wake set
// admits PostgREST's grammar: refusing a select PostgREST serves threw from
// store.subscribe and took down a region that read fine.
import { describe, expect, it } from "@test/harness"
import { embedDeps, parseEmbeds } from "../interpreter/fragment.js"

describe("a select's wake set", () => {
  it("reads selects PostgREST accepts", () => {
    expect(embedDeps("*,label:name", "note", {})).toEqual([])
    expect(embedDeps("id, name", "note", {})).toEqual([])
    expect(embedDeps("*,amount::text", "invoice", {})).toEqual([])
    expect(embedDeps("*,data->>score::int,data->0->tags,total:amount.sum(),count()", "game", {})).toEqual([])
    expect(embedDeps("id, author:app_user!inner( handle , who:handle::text )", "article", {})).toEqual(["app_user"])
    expect(embedDeps("*,...app_user!author_id(handle)", "article", {})).toEqual(["app_user"])
  })

  it("keeps an embed apart from a renamed or cast column", () => {
    expect(parseEmbeds("*, label:name, amount::text, author:app_user(handle)")).toEqual({
      cols: ["*", "label:name", "amount::text"],
      embeds: [{ alias: "author", rel: "app_user", hints: [], spread: false, cols: ["handle"], embeds: [] }],
    })
  })

  it("refuses a select PostgREST would refuse", () => {
    for (const bad of ["*,(", "id,,name", "*,label:", "na me", "*,amount::", "id,", "*,a(b", "a->", "a.sum("]) {
      expect(() => embedDeps(bad, "t", {}), bad).toThrow("select outside the grammar")
    }
  })
})
