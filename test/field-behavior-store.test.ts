// A client's write is held to its fields' behaviour (pronto's
// #Field.outputOnly and #Field.immutable, Google AIP-203's words) before its
// optimistic row stands: an output-only value is dropped, as the server clears
// it, and a change of an immutable one is refused, as the server refuses it.
import { expect } from "@test/harness"
import { createStore } from "../interpreter/data-sync.js"
import { FIXTURE_CARRIERS } from "../interpreter/fixture-types.js"

const fields = [
  { name: "id", type: "string", pk: true, required: true },
  { name: "title", type: "string", required: true },
  { name: "code", type: "string", required: true, immutable: true },
  { name: "approved_by", type: "string", required: false, outputOnly: true },
]

/** A store over the server table `quote`, its requests answered here: the
 * standing row `q1`, and every write recorded. */
function serverStore() {
  const sent: { method: string; body: any }[] = []
  const request = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url, "https://quote.test")
    const method = init.method ?? "GET"
    if (method === "GET") {
      return Response.json(u.searchParams.get("id") === "eq.q1" ? [{ id: "q1", title: "old", code: "A", approved_by: "ana" }] : [])
    }
    const body = JSON.parse(String(init.body))
    sent.push({ method, body })
    return Response.json(Array.isArray(body) ? body : method === "POST" ? [body] : [{ ...body, id: u.searchParams.get("id")!.slice(3) }])
  }
  const store = createStore("https://quote.test", { carriers: FIXTURE_CARRIERS, schema: { quote: { durability: "server", fields } }, tables: [] }, { request })
  return { store, sent }
}

Deno.test({ name: "a client's write to a server table carries no output-only value", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const { store, sent } = serverStore()
  try {
    await store.add("quote", [{ id: "q2", title: "new", code: "B", approved_by: "me" }])
    await store.patch("quote", [{ key: "q1", changes: { title: "renamed", approved_by: "me" } }])
    await store.write("quote", [{ key: "q1", row: { title: "again", approved_by: "me" } }])
    expect(sent.map((s) => s.method)).toEqual(["POST", "PATCH", "PATCH"])
    expect(sent[0].body).toEqual([{ id: "q2", title: "new", code: "B" }])
    expect(sent[1].body).toEqual({ title: "renamed" })
    expect(sent[2].body).toEqual({ title: "again" })
  } finally { await store.close() }
} })

Deno.test({ name: "a write that changes an immutable field of a standing row is refused before it leaves", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const { store, sent } = serverStore()
  try {
    // The value the row holds passes; a new row sets it freely.
    await store.write("quote", [{ key: "q1", row: { code: "A", title: "same code" } }])
    await store.write("quote", [{ key: "q3", row: { code: "C", title: "new row" } }])
    let refused: Error | undefined
    try {
      await store.write("quote", [{ key: "q1", row: { code: "Z" } }])
    } catch (err) {
      refused = err as Error
    }
    expect(refused?.name).toBe("NonRetriableError")
    expect(refused?.message).toBe("quote.code is immutable: it is set when its row is created and never changed")
    expect(sent.map((s) => [s.method, s.body.code ?? s.body[0]?.code])).toEqual([["PATCH", "A"], ["POST", "C"]])
  } finally { await store.close() }
} })

// A tab table has no server to clear or refuse anything: the store's own
// judgement is the whole of it.
Deno.test({ name: "a tab table's rows keep its fields' behaviour by the store alone", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const store = await createStore("", { carriers: FIXTURE_CARRIERS, local: { quote: "tab" }, schema: { quote: { durability: "tab", fields } } })
  await store.add("quote", [{ id: "q1", title: "first", code: "A", approved_by: "me" }])
  await store.patch("quote", [{ key: "q1", changes: { title: "second", code: "A", approved_by: "me" } }])
  let refused: Error | undefined
  try {
    await store.patch("quote", [{ key: "q1", changes: { code: "B" } }])
  } catch (err) {
    refused = err as Error
  }
  expect(refused?.name).toBe("NonRetriableError")
  const rows = (await store.query("quote", null, {})).map((r: Record<string, unknown>) => ({ id: r.id, title: r.title, code: r.code, approved_by: r.approved_by }))
  expect(rows).toEqual([{ id: "q1", title: "second", code: "A", approved_by: undefined }])
} })

// A json value is the value it states, as the server's jsonb compares it.
Deno.test({ name: "an immutable json value restated with its keys in another order is the same value", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const terms = [{ name: "id", type: "string", pk: true, required: true }, { name: "terms", type: "json", required: true, immutable: true }]
  // The fixture table with json as types.cue states it.
  const carriers = { ...FIXTURE_CARRIERS, types: { ...FIXTURE_CARRIERS.types, json: { pg: "json", column: "checked", subset: false, base: ["json", "jsonb"], json: "value", order: "none", beyond: [] } } }
  const store = await createStore("", { carriers, local: { quote: "tab" }, schema: { quote: { durability: "tab", fields: terms } } })
  await store.add("quote", [{ id: "q1", terms: { a: 1, b: { c: [1, 2], d: null } } }])
  await store.patch("quote", [{ key: "q1", changes: { terms: { b: { d: null, c: [1, 2] }, a: 1 } } }])
  await store.patch("quote", [{ key: "q1", changes: { terms: '{"b":{"c":[1,2],"d":null},"a":1}' } }])
  let refused: Error | undefined
  try {
    await store.patch("quote", [{ key: "q1", changes: { terms: { a: 1, b: { c: [2, 1], d: null } } } }])
  } catch (err) {
    refused = err as Error
  }
  expect(refused?.name).toBe("NonRetriableError")
  expect(refused?.message).toBe("quote.terms is immutable: it is set when its row is created and never changed")
} })
