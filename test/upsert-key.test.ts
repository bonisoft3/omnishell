import { describe, expect, it } from "@test/harness"
import { upsertKey } from "../interpreter/data-crud.js"

describe("upsertKey", () => {
  it("resolves against a declared natural key that the values cover", () => {
    expect(upsertKey([["user_id", "article_id"]], "id", undefined, { article_id: "a1", user_id: "u1" }))
      .toEqual(["user_id", "article_id"])
  })

  it("counts the owner column as covered — it materialises from the session", () => {
    expect(upsertKey([["user_id", "article_id"]], "id", "user_id", { article_id: "a1" }))
      .toEqual(["user_id", "article_id"])
  })

  it("falls back to the pk when the table declares no uniques", () => {
    expect(upsertKey(undefined, "id", undefined, { id: "the", hue: "cool" })).toEqual(["id"])
  })

  it("pk fallback still requires the values to carry the pk", () => {
    expect(upsertKey(undefined, "id", undefined, { hue: "cool" })).toBeNull()
  })

  it("declared uniques are the vocabulary — no pk fallback beside them", () => {
    // The regression this guards: a table WITH declared uniques whose form
    // omits every key column must refuse, not quietly key on the pk the form
    // also never carries.
    expect(upsertKey([["user_id", "article_id"]], "id", undefined, { id: "x", note: "n" })).toBeNull()
  })
})
