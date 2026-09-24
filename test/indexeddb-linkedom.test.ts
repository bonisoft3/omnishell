import { describe, expect, it } from "@test/harness"

describe("IndexedDB in LinkeDOM test environment", () => {
  it("provides globalThis.indexedDB via fake-indexeddb", () => {
    const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB
    expect(idb).toBeDefined()
    expect(typeof idb.open).toBe("function")
  })
})
