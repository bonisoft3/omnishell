// What a chart reads its row from: the store answering a region's read at
// once from what the tab holds, its own writes included from the moment a
// write stands in the collection, which the write says through `onApplied`.
// The answer selects as the read does: by its filter, whatever the table's
// key. Run over tables the browser owns, which need no cluster.
import { expect } from "@test/harness"
import { createStore } from "../interpreter/data-sync.js"
import { FIXTURE_CARRIERS } from "../interpreter/fixture-types.js"

type Row = Record<string, unknown>
type Store = {
  query(table: string, order: string | null, opts: Row): Promise<Row[]>
  answer(table: string, order: string | null, opts: Row): Row[] | undefined
  answers(table: string, opts: Row): boolean
  add(table: string, rows: Row[]): Promise<void>
  write(table: string, edits: { key: string; row: Row }[], onRefused?: (e: unknown) => void, onApplied?: () => void): Promise<void>
  drop(table: string, keys: string[]): Promise<void>
  close(): Promise<void>
}

Deno.test({ name: "a read answered at once shows a write by the time the write says it is applied, and selects as the read does", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const store = await createStore("", { carriers: FIXTURE_CARRIERS, local: { note: "tab", seat: "tab" }, keys: { note: "id", seat: "subject" }, schema: { remote: { durability: "server", fields: [{ name: "id", type: "string", pk: true }] } } }) as Store
  try {
    // A table read only from the server is never the tab's to answer.
    expect(store.answers("note", { filter: "id=eq.a" })).toBe(true)
    expect(store.answers("remote", { filter: "id=eq.a" })).toBe(false)
    const one = { filter: "id=eq.a" }
    await store.query("note", null, one)
    expect(store.answer("note", null, one)).toEqual([])
    const seen: (Row[] | undefined)[] = []
    let applied = 0
    await store.write("note", [{ key: "a", row: { title: "x", scope: "open" } }], undefined, () => {
      applied += 1
      seen.push(store.answer("note", null, one))
    })
    expect(applied).toBe(1)
    expect(seen[0]?.[0]?.title).toBe("x")
    expect(store.answer("note", null, one)).toEqual(await store.query("note", null, one))
    // A row the read's filter does not admit is not the read's.
    const open = { filter: "id=eq.a&scope=eq.open" }
    await store.write("note", [{ key: "a", row: { scope: "closed" } }])
    expect(store.answer("note", null, open)).toEqual([])
    expect(await store.query("note", null, open)).toEqual([])
    // A refused write is never applied and leaves the rows as they stood.
    const refused = await store.add("note", [{ id: "a", title: "z" }]).then(() => false, () => true)
    expect(refused).toBe(true)
    expect(store.answer("note", null, one)?.[0]?.title).toBe("x")
    // Keyed by another column: the read selects by what its filter names.
    await store.write("seat", [{ key: "A", row: { id: "B", status: "a" } }, { key: "B", row: { id: "C", status: "b" } }])
    expect(store.answer("seat", null, { filter: "subject=eq.A" })?.map((r) => r.status)).toEqual(["a"])
    await store.drop("note", ["a"])
    expect(store.answer("note", null, one)).toEqual([])
  } finally {
    await store.close()
  }
} })
