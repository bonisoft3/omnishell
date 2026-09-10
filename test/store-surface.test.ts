// The store is one surface with two things behind it, and they have to stay the
// same shape.
//
// data-crud is the store. batched-store is the adapter that decomposes the same
// calls for the test doubles, so a smoke exercises the interpreter's real write
// path against a double that only knows one row at a time. Nothing else makes
// them agree, and a method renamed on one side is invisible until an app breaks:
// the store this pair replaced drifted exactly that way — a `write` still taking
// rows after the surface moved to {key, row} edits, an `upsertBy` resolving
// another key — and no suite noticed, because nothing ran it.
//
// This pins the names only. What each one MEANS is every other test in this
// directory; what this catches is a method renamed, added, or dropped on one
// side of the pair.
import { describe, expect, it } from "@test/harness"
import { batched } from "../interpreter/batched-store.js"

/** Every call the interpreter makes on a store. */
const SURFACE = ["query", "add", "write", "patch", "drop", "dropWhere", "upsertBy", "subscribe"]

/** The singular writes a test double states for itself, which the adapter
 * decomposes a batch into. */
const SINGULAR = ["create", "put", "update", "remove"]

describe("the store surface", () => {
  it("is what data-crud offers", async () => {
    // The store reads localStorage at construction for its device identity.
    const had = Object.prototype.hasOwnProperty.call(globalThis, "localStorage")
    if (!had) {
      const kv = new Map<string, string>()
      ;(globalThis as Record<string, unknown>).localStorage = {
        getItem: (k: string) => kv.get(k) ?? null,
        setItem: (k: string, v: string) => void kv.set(k, v),
        removeItem: (k: string) => void kv.delete(k),
      }
    }
    try {
      const { createStore } = await import("../interpreter/data-crud.js")
      const store = await createStore("", { app: "surface", entities: {}, migrations: [], pipelines: [] })
      expect(Object.keys(store).sort()).toEqual([...SURFACE].sort())
    } finally {
      if (!had) delete (globalThis as Record<string, unknown>).localStorage
    }
  })

  it("is what the adapter answers, over a double that knows none of it", () => {
    // The double states only the singular writes; everything the interpreter
    // calls has to come out of the adapter or be passed straight through.
    const double = Object.fromEntries(
      [...SINGULAR, "query", "subscribe", "dropWhere", "upsertBy"].map((m) => [m, () => {}]),
    )
    const store = batched(double) as Record<string, unknown>
    for (const call of SURFACE) {
      expect(typeof store[call]).toBe("function")
    }
  })
})
