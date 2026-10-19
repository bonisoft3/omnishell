import { expect } from "@test/harness"
import { createStore } from "../interpreter/data-sync.js"
import { FIXTURE_CARRIERS } from "../interpreter/fixture-types.js"

// A form that upserts the row it names by its own key (a singleton such as
// `id = "you"`) wrote its first row under a minted key instead, so the screen
// reading `id=eq.you` never found what the reader had just saved.
// The store's offline executor runs until page exit.
Deno.test({ name: "an upsert keyed by its own primary key creates that row and then updates it", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const store = await createStore("", { carriers: FIXTURE_CARRIERS, local: { player: "tab" } })
  await store.upsertBy("player", { id: "you", handle: "Davi" })
  await store.upsertBy("player", { id: "you", handle: "Bia" })
  const rows = (await store.query("player", null, {})).map((r: Record<string, unknown>) => ({ id: r.id, handle: r.handle }))
  expect(rows).toEqual([{ id: "you", handle: "Bia" }])
} })

// The same, keyed by a unique that is not the primary key: the row the form
// names kept a minted key, so the next read by its own id found nothing.
Deno.test({ name: "an upsert by another unique keeps the key the form gave it", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const store = await createStore("", { carriers: FIXTURE_CARRIERS, local: { player: "tab" }, uniques: { player: [["handle"]] } })
  await store.upsertBy("player", { id: "you", handle: "Davi" })
  const rows = (await store.query("player", null, {})).map((r: Record<string, unknown>) => ({ id: r.id, handle: r.handle }))
  expect(rows).toEqual([{ id: "you", handle: "Davi" }])
} })
