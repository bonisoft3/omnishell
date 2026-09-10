import { describe, expect, it } from "@test/harness"
import { deleteSpec } from "../interpreter/fragment.js"
import { createStore } from "../interpreter/data-crud.js"

// The parser reads limit as a cap and drops it from the spec, so a delete
// that honored the remaining predicates would remove every matching row —
// scope silently widened where the author capped it. The subset must refuse
// rather than narrow.
describe("deleteSpec", () => {
  it("refuses a limit beside real predicates", () => {
    expect(() => deleteSpec("kind=eq.card&limit=1")).toThrow(/carries a limit/)
  })

  it("refuses a limit-only filter", () => {
    expect(() => deleteSpec("limit=1")).toThrow(/carries a limit/)
  })

  it("translates the eq/is subset", () => {
    expect(deleteSpec("kind=eq.card&done=is.true&note=is.null")).toEqual([
      { col: "kind", op: "eq", value: "card" },
      { col: "done", op: "true" },
      { col: "note", op: "null" },
    ])
  })

  it("refuses ops beyond the subset", () => {
    expect(() => deleteSpec("seat=neq.you")).toThrow(/unsupported delete filter op/)
    expect(() => deleteSpec("done=not.is.null")).toThrow(/unsupported delete filter op/)
  })

  it("refuses an empty or untranslatable filter", () => {
    expect(() => deleteSpec("")).toThrow(/untranslatable/)
    expect(() => deleteSpec("q=plfts.card")).toThrow(/untranslatable/)
  })
})

// The synced tier refuses the same cap, before it touches any collection.
describe("data-crud dropWhere", () => {
  it("refuses a limit before reconciling", async () => {
    const store = await createStore()
    let err: Error | undefined
    await store.dropWhere("note", "kind=eq.card&limit=1").catch((e: Error) => (err = e))
    expect(String(err)).toMatch(/carries a limit/)
  })
})
